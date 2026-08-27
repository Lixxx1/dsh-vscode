import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { DshEvent } from './conversation.js'
import type { HistoryEntry } from './dsh-client.js'
import { comparableFilePath } from './file-path.js'

export interface ChangedFileItem {
  path: string
  additions: number
  deletions: number
  canRevert: boolean
}

export interface ChangedFileGroup {
  turn: number
  files: ChangedFileItem[]
}

interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

interface PendingFile {
  absolutePath: string
  displayPath: string
  before?: FileImage
  diffs: FileDiff[]
  turn: number
}

interface ReviewSnapshot {
  before: string | null
  after: string | null
  fullFile: boolean
  additions: number
  deletions: number
}

interface ReviewFile {
  absolutePath: string
  displayPath: string
  turn: number
  snapshots: ReviewSnapshot[]
}

interface FileImage {
  text: string | null
}

interface UnknownRecord {
  [key: string]: unknown
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function callIdOf(event: DshEvent): string | undefined {
  const data = record(event.data)
  if (event.type === 'tool/call') return typeof data?.callId === 'string' ? data.callId : undefined
  if (event.type !== 'tool/result') return undefined
  const message = record(data?.message)
  const source = record(message?.source)
  if (typeof source?.callId === 'string') return source.callId
  const first = Array.isArray(message?.content) ? record(message.content[0]) : undefined
  return typeof first?.toolCallId === 'string' ? first.toolCallId : undefined
}

function failedResult(event: DshEvent): boolean {
  const data = record(event.data)
  if (data?.error !== undefined) return true
  const message = record(data?.message)
  return Array.isArray(message?.content) && message.content.some(value => record(value)?.isError === true)
}

function turnOf(event: DshEvent): number {
  const turn = record(event.data)?.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0 ? turn : 0
}

function diffsOf(value: unknown, expected: 'call' | 'result'): FileDiff[] {
  const wrapper = record(value)
  const view = wrapper?.for === expected ? record(wrapper.view) : undefined
  if (view?.card !== 'diff' || !Array.isArray(view.diffs)) return []
  return view.diffs.flatMap((value): FileDiff[] => {
    const diff = record(value)
    if (
      typeof diff?.path !== 'string'
      || (diff.oldText !== null && typeof diff.oldText !== 'string')
      || typeof diff.newText !== 'string'
    ) return []
    return [{ path: diff.path, oldText: diff.oldText, newText: diff.newText }]
  })
}

function inside(basePath: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(filePath))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function projectPath(cwd: string, value: string): string | undefined {
  const resolved = path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value))
  return inside(cwd, resolved) ? resolved : undefined
}

function readImage(filePath: string): FileImage | undefined {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined
    return { text: fs.readFileSync(filePath, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null }
    return undefined
  }
}

function groupedDiffs(cwd: string, diffs: readonly FileDiff[], turn: number): Map<string, PendingFile> {
  const grouped = new Map<string, PendingFile>()
  for (const diff of diffs) {
    const absolutePath = projectPath(cwd, diff.path)
    if (absolutePath === undefined) continue
    const existing = grouped.get(absolutePath)
    if (existing === undefined) {
      grouped.set(absolutePath, {
        absolutePath,
        displayPath: path.relative(cwd, absolutePath) || path.basename(absolutePath),
        diffs: [diff],
        turn,
      })
    } else {
      existing.diffs.push(diff)
    }
  }
  return grouped
}

function changedLineCount(value: string | null): number {
  if (value === null || value === '') return 0
  const lines = value.split(/\r?\n/)
  return lines.length - (lines.at(-1) === '' ? 1 : 0)
}

function lineStats(diffs: readonly FileDiff[]): { additions: number; deletions: number } {
  return diffs.reduce((total, diff) => ({
    additions: total.additions + changedLineCount(diff.newText),
    deletions: total.deletions + changedLineCount(diff.oldText),
  }), { additions: 0, deletions: 0 })
}

function fragmentSnapshot(diffs: readonly FileDiff[]): ReviewSnapshot | undefined {
  const changed = diffs.filter(diff => (diff.oldText ?? '') !== diff.newText)
  if (changed.length === 0) return undefined
  const separator = '\n\n⋯ unchanged lines ⋯\n\n'
  return {
    before: changed.map(diff => diff.oldText ?? '').join(separator),
    after: changed.map(diff => diff.newText).join(separator),
    fullFile: false,
    ...lineStats(changed),
  }
}

/** Tracks official DSH diff events and opens their changes in VS Code's native editors. */
export class DiffReviewManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  private readonly content = new Map<string, string>()
  private readonly pending = new Map<string, Map<string, PendingFile>>()
  private readonly reviews = new Map<string, Map<number, Map<string, ReviewFile>>>()
  private readonly dismissed = new Map<string, Set<string>>()

  readonly onDidChange = this.changed.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? ''
  }

  dispose(): void {
    this.changed.dispose()
    this.content.clear()
    this.pending.clear()
    this.reviews.clear()
    this.dismissed.clear()
  }

  clear(): void {
    this.content.clear()
    this.pending.clear()
    this.reviews.clear()
  }

  rebuild(sessionId: string, cwd: string, entries: readonly HistoryEntry[]): ChangedFileGroup[] {
    this.clearSession(sessionId)
    for (const entry of entries) this.accept(sessionId, cwd, entry.event, entry.view, true)
    return this.changedFiles(sessionId)
  }

  /** Replay an older, complete history page without discarding reversible live snapshots. */
  prependHistory(sessionId: string, cwd: string, entries: readonly HistoryEntry[]): ChangedFileGroup[] {
    for (const entry of entries) this.accept(sessionId, cwd, entry.event, entry.view, true)
    return this.changedFiles(sessionId)
  }

  accept(sessionId: string, cwd: string, event: DshEvent, view?: unknown, replay = false): boolean {
    const callId = callIdOf(event)
    if (callId === undefined) return false
    const key = `${sessionId}:${callId}`
    const turn = turnOf(event)

    if (event.type === 'tool/call') {
      const files = groupedDiffs(cwd, diffsOf(view, 'call'), turn)
      if (!replay) {
        for (const file of files.values()) {
          const before = readImage(file.absolutePath)
          if (before !== undefined) file.before = before
        }
      }
      if (files.size > 0) this.pending.set(key, files)
      return false
    }

    if (event.type !== 'tool/result') return false
    const pending = this.pending.get(key)
    this.pending.delete(key)
    if (failedResult(event)) return false

    const results = groupedDiffs(cwd, diffsOf(view, 'result'), turn)
    const absolutePaths = new Set([...(pending?.keys() ?? []), ...results.keys()])
    let updated = false
    for (const absolutePath of absolutePaths) {
      const callFile = pending?.get(absolutePath)
      const resultFile = results.get(absolutePath)
      const displayPath = resultFile?.displayPath ?? callFile?.displayPath ?? path.relative(cwd, absolutePath)
      const fileTurn = resultFile?.turn ?? callFile?.turn ?? turn
      const diffs = resultFile?.diffs ?? callFile?.diffs ?? []
      const after = replay ? undefined : readImage(absolutePath)
      const stats = lineStats(diffs)
      const snapshot = callFile?.before !== undefined && after !== undefined && callFile.before.text !== after.text
        ? { before: callFile.before.text, after: after.text, fullFile: true, ...stats }
        : fragmentSnapshot(diffs)
      if (snapshot === undefined) continue
      this.record(sessionId, { absolutePath, displayPath, turn: fileTurn, snapshots: [snapshot] })
      updated = true
    }
    return updated
  }

  changedFiles(sessionId: string): ChangedFileGroup[] {
    const turns = this.reviews.get(sessionId)
    if (turns === undefined) return []
    return [...turns.entries()]
      .sort(([left], [right]) => right - left)
      .map(([turn, files]) => ({
        turn,
        files: [...files.values()].map(file => {
          const stats = file.snapshots.reduce((total, snapshot) => ({
            additions: total.additions + snapshot.additions,
            deletions: total.deletions + snapshot.deletions,
          }), { additions: 0, deletions: 0 })
          return {
            path: file.displayPath,
            ...stats,
            canRevert: this.reviewContent(file).fullFile,
          }
        }),
      }))
      .filter(group => group.files.length > 0)
  }

  async openFile(cwd: string, value: string, line?: number): Promise<void> {
    const filePath = projectPath(cwd, value)
    if (filePath === undefined) throw new Error('This file is outside the current DeepSeek project.')
    const uri = vscode.Uri.file(filePath)
    const stat = await vscode.workspace.fs.stat(uri)
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
      return
    }
    const document = await vscode.workspace.openTextDocument(uri)
    const targetLine = line === undefined ? undefined : Math.max(0, Math.min(line - 1, document.lineCount - 1))
    const selection = targetLine === undefined ? undefined : new vscode.Range(targetLine, 0, targetLine, 0)
    await vscode.window.showTextDocument(document, {
      preview: true,
      ...(selection === undefined ? {} : { selection }),
    })
  }

  async reviewFile(sessionId: string, cwd: string, value: string, turn?: number): Promise<void> {
    const review = this.findReview(sessionId, cwd, value, turn)
    if (review === undefined) throw new Error(`No completed DeepSeek change is available for ${value}.`)
    await this.openReview(review, true)
  }

  async reviewAll(sessionId: string): Promise<void> {
    const reviews = this.allReviews(sessionId)
    if (reviews.length === 0) throw new Error('No completed DeepSeek changes are available to review.')
    for (const review of reviews.slice(0, 20)) await this.openReview(review, false)
    if (reviews.length > 20) void vscode.window.showInformationMessage('Opened the first 20 changed files.')
  }

  keepFile(sessionId: string, cwd: string, value: string, turn: number): ChangedFileGroup[] {
    const review = this.findReview(sessionId, cwd, value, turn)
    if (review === undefined) throw new Error(`No completed DeepSeek change is available for ${value}.`)
    this.dismiss(sessionId, review)
    return this.changedFiles(sessionId)
  }

  keepAll(sessionId: string): ChangedFileGroup[] {
    for (const review of this.allReviews(sessionId)) this.markDismissed(sessionId, review)
    this.reviews.delete(sessionId)
    return []
  }

  revertFile(sessionId: string, cwd: string, value: string, turn: number): ChangedFileGroup[] {
    const review = this.findReview(sessionId, cwd, value, turn)
    if (review === undefined) throw new Error(`No completed DeepSeek change is available for ${value}.`)
    const content = this.validateRevert(review)
    this.applyRevert(review, content.before)
    this.dismiss(sessionId, review)
    return this.changedFiles(sessionId)
  }

  revertAll(sessionId: string): ChangedFileGroup[] {
    const reviews = this.allReviews(sessionId)
    if (reviews.length === 0) throw new Error('No completed DeepSeek changes are available to revert.')
    const byFile = new Map<string, ReviewFile[]>()
    for (const review of reviews) {
      const existing = byFile.get(review.absolutePath)
      if (existing === undefined) byFile.set(review.absolutePath, [review])
      else existing.push(review)
    }
    const validated = [...byFile.values()].map(series => this.validateRevertSeries(series))
    for (const item of validated) this.applyRevert(item.review, item.before)
    for (const review of reviews) this.markDismissed(sessionId, review)
    this.reviews.delete(sessionId)
    return []
  }

  private clearSession(sessionId: string): void {
    this.reviews.delete(sessionId)
    for (const key of this.pending.keys()) if (key.startsWith(`${sessionId}:`)) this.pending.delete(key)
  }

  private record(sessionId: string, incoming: ReviewFile): void {
    if (this.dismissed.get(sessionId)?.has(this.reviewKey(incoming))) return
    let turns = this.reviews.get(sessionId)
    if (turns === undefined) this.reviews.set(sessionId, turns = new Map())
    let files = turns.get(incoming.turn)
    if (files === undefined) turns.set(incoming.turn, files = new Map())
    const existing = files.get(incoming.absolutePath)
    if (existing === undefined) files.set(incoming.absolutePath, incoming)
    else existing.snapshots.push(...incoming.snapshots)
  }

  private reviewContent(review: ReviewFile): { before: string | null; after: string | null; fullFile: boolean } {
    const first = review.snapshots[0]
    const continuous = review.snapshots.slice(1).every((snapshot, index) => review.snapshots[index]?.after === snapshot.before)
    if (first?.fullFile === true && review.snapshots.every(snapshot => snapshot.fullFile) && continuous) {
      const latest = review.snapshots.at(-1)?.after ?? first.after
      return { before: first.before, after: latest, fullFile: true }
    }
    const separator = '\n\n================ next DeepSeek change ================\n\n'
    return {
      before: review.snapshots.map(snapshot => snapshot.before ?? '').join(separator),
      after: review.snapshots.map(snapshot => snapshot.after ?? '').join(separator),
      fullFile: false,
    }
  }

  private findReview(sessionId: string, cwd: string, value: string, turn?: number): ReviewFile | undefined {
    const absolutePath = projectPath(cwd, value)
    if (absolutePath === undefined) return undefined
    const turns = this.reviews.get(sessionId)
    if (turn !== undefined) return turns?.get(turn)?.get(absolutePath)
    return [...(turns?.entries() ?? [])]
      .sort(([left], [right]) => right - left)
      .map(([, files]) => files.get(absolutePath))
      .find((review): review is ReviewFile => review !== undefined)
  }

  private allReviews(sessionId: string): ReviewFile[] {
    return [...(this.reviews.get(sessionId)?.values() ?? [])].flatMap(files => [...files.values()])
  }

  private reviewKey(review: ReviewFile): string {
    return `${String(review.turn)}:${review.absolutePath}`
  }

  private markDismissed(sessionId: string, review: ReviewFile): void {
    let dismissed = this.dismissed.get(sessionId)
    if (dismissed === undefined) this.dismissed.set(sessionId, dismissed = new Set())
    dismissed.add(this.reviewKey(review))
  }

  private dismiss(sessionId: string, review: ReviewFile): void {
    this.markDismissed(sessionId, review)
    const turns = this.reviews.get(sessionId)
    const files = turns?.get(review.turn)
    files?.delete(review.absolutePath)
    if (files?.size === 0) turns?.delete(review.turn)
    if (turns?.size === 0) this.reviews.delete(sessionId)
  }

  private validateRevert(review: ReviewFile): { before: string | null; after: string | null } {
    const content = this.reviewContent(review)
    if (!content.fullFile) {
      throw new Error(`Cannot safely revert ${review.displayPath}: its full snapshot is no longer available.`)
    }
    this.validateCurrentFile(review, content.after)
    return content
  }

  private validateRevertSeries(series: ReviewFile[]): { review: ReviewFile; before: string | null } {
    const ordered = [...series].sort((left, right) => left.turn - right.turn)
    const contents = ordered.map(review => ({ review, content: this.reviewContent(review) }))
    const unavailable = contents.find(item => !item.content.fullFile)
    if (unavailable !== undefined) {
      throw new Error(`Cannot safely revert ${unavailable.review.displayPath}: its full snapshot is no longer available.`)
    }
    for (let index = 1; index < contents.length; index += 1) {
      if (contents[index - 1]?.content.after !== contents[index]?.content.before) {
        throw new Error(`Cannot safely revert ${contents[index]?.review.displayPath}: it changed between DeepSeek turns.`)
      }
    }
    const latest = contents.at(-1)
    const earliest = contents[0]
    if (latest === undefined || earliest === undefined) throw new Error('No completed DeepSeek changes are available to revert.')
    this.validateCurrentFile(latest.review, latest.content.after)
    return { review: latest.review, before: earliest.content.before }
  }

  private validateCurrentFile(review: ReviewFile, expected: string | null): void {
    const reviewPath = comparableFilePath(review.absolutePath)
    const dirty = vscode.workspace.textDocuments.some(document =>
      document.isDirty
      && comparableFilePath(path.resolve(document.uri.fsPath)) === reviewPath,
    )
    if (dirty) throw new Error(`Cannot revert ${review.displayPath}: it has unsaved VS Code changes.`)
    const current = readImage(review.absolutePath)
    if (current === undefined) throw new Error(`Cannot safely read ${review.displayPath} before reverting.`)
    if (current.text !== expected) {
      throw new Error(`Cannot revert ${review.displayPath}: the file changed after DeepSeek edited it.`)
    }
  }

  private applyRevert(review: ReviewFile, before: string | null): void {
    if (before === null) {
      try {
        fs.unlinkSync(review.absolutePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }
    fs.mkdirSync(path.dirname(review.absolutePath), { recursive: true })
    fs.writeFileSync(review.absolutePath, before, 'utf8')
  }

  private async openReview(review: ReviewFile, preview: boolean): Promise<void> {
    const id = randomUUID()
    const name = path.basename(review.absolutePath)
    const beforeUri = vscode.Uri.from({ scheme: 'dsh-diff', authority: 'before', path: `/${id}/${name}` })
    const afterUri = vscode.Uri.from({ scheme: 'dsh-diff', authority: 'after', path: `/${id}/${name}` })
    const content = this.reviewContent(review)
    this.content.set(beforeUri.toString(), content.before ?? '')
    this.content.set(afterUri.toString(), content.after ?? '')
    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `${review.displayPath} — DeepSeek changes (Turn ${String(review.turn)})`,
      { preview },
    )
  }
}
