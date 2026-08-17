import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { DshEvent } from './conversation.js'
import type { HistoryEntry } from './dsh-client.js'

export interface ChangedFileItem {
  path: string
}

interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

interface PendingFile {
  absolutePath: string
  displayPath: string
  before?: string
  diffs: FileDiff[]
}

interface ReviewSnapshot {
  before: string
  after: string
  fullFile: boolean
}

interface ReviewFile {
  absolutePath: string
  displayPath: string
  snapshots: ReviewSnapshot[]
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

function readText(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function groupedDiffs(cwd: string, diffs: readonly FileDiff[]): Map<string, PendingFile> {
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
      })
    } else {
      existing.diffs.push(diff)
    }
  }
  return grouped
}

function fragmentSnapshot(diffs: readonly FileDiff[]): ReviewSnapshot | undefined {
  const changed = diffs.filter(diff => (diff.oldText ?? '') !== diff.newText)
  if (changed.length === 0) return undefined
  const separator = '\n\n⋯ unchanged lines ⋯\n\n'
  return {
    before: changed.map(diff => diff.oldText ?? '').join(separator),
    after: changed.map(diff => diff.newText).join(separator),
    fullFile: false,
  }
}

/** Tracks official DSH diff events and opens their changes in VS Code's native editors. */
export class DiffReviewManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  private readonly content = new Map<string, string>()
  private readonly pending = new Map<string, Map<string, PendingFile>>()
  private readonly reviews = new Map<string, Map<string, ReviewFile>>()

  readonly onDidChange = this.changed.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? ''
  }

  dispose(): void {
    this.changed.dispose()
    this.content.clear()
    this.pending.clear()
    this.reviews.clear()
  }

  clear(): void {
    this.content.clear()
    this.pending.clear()
    this.reviews.clear()
  }

  rebuild(sessionId: string, cwd: string, entries: readonly HistoryEntry[]): ChangedFileItem[] {
    this.clearSession(sessionId)
    for (const entry of entries) this.accept(sessionId, cwd, entry.event, entry.view, true)
    return this.changedFiles(sessionId)
  }

  accept(sessionId: string, cwd: string, event: DshEvent, view?: unknown, replay = false): boolean {
    const callId = callIdOf(event)
    if (callId === undefined) return false
    const key = `${sessionId}:${callId}`

    if (event.type === 'tool/call') {
      const files = groupedDiffs(cwd, diffsOf(view, 'call'))
      if (!replay) {
        for (const file of files.values()) {
          const before = readText(file.absolutePath)
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

    const results = groupedDiffs(cwd, diffsOf(view, 'result'))
    const absolutePaths = new Set([...(pending?.keys() ?? []), ...results.keys()])
    let updated = false
    for (const absolutePath of absolutePaths) {
      const callFile = pending?.get(absolutePath)
      const resultFile = results.get(absolutePath)
      const displayPath = resultFile?.displayPath ?? callFile?.displayPath ?? path.relative(cwd, absolutePath)
      const after = replay ? undefined : readText(absolutePath)
      const snapshot = callFile?.before !== undefined && after !== undefined && callFile.before !== after
        ? { before: callFile.before, after, fullFile: true }
        : fragmentSnapshot(resultFile?.diffs ?? callFile?.diffs ?? [])
      if (snapshot === undefined) continue
      this.record(sessionId, { absolutePath, displayPath, snapshots: [snapshot] })
      updated = true
    }
    return updated
  }

  changedFiles(sessionId: string): ChangedFileItem[] {
    return [...(this.reviews.get(sessionId)?.values() ?? [])].map(file => ({ path: file.displayPath }))
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

  async reviewFile(sessionId: string, cwd: string, value: string): Promise<void> {
    const absolutePath = projectPath(cwd, value)
    const review = absolutePath === undefined ? undefined : this.reviews.get(sessionId)?.get(absolutePath)
    if (review === undefined) throw new Error(`No completed DeepSeek change is available for ${value}.`)
    await this.openReview(review, true)
  }

  async reviewAll(sessionId: string): Promise<void> {
    const reviews = [...(this.reviews.get(sessionId)?.values() ?? [])]
    if (reviews.length === 0) throw new Error('No completed DeepSeek changes are available to review.')
    for (const review of reviews.slice(0, 20)) await this.openReview(review, false)
    if (reviews.length > 20) void vscode.window.showInformationMessage('Opened the first 20 changed files.')
  }

  private clearSession(sessionId: string): void {
    this.reviews.delete(sessionId)
    for (const key of this.pending.keys()) if (key.startsWith(`${sessionId}:`)) this.pending.delete(key)
  }

  private record(sessionId: string, incoming: ReviewFile): void {
    let session = this.reviews.get(sessionId)
    if (session === undefined) this.reviews.set(sessionId, session = new Map())
    const existing = session.get(incoming.absolutePath)
    if (existing === undefined) session.set(incoming.absolutePath, incoming)
    else existing.snapshots.push(...incoming.snapshots)
  }

  private reviewContent(review: ReviewFile): { before: string; after: string } {
    const first = review.snapshots[0]
    if (first?.fullFile === true) {
      const latest = review.snapshots.findLast(snapshot => snapshot.fullFile)?.after ?? first.after
      return { before: first.before, after: latest }
    }
    const separator = '\n\n================ next DeepSeek change ================\n\n'
    return {
      before: review.snapshots.map(snapshot => snapshot.before).join(separator),
      after: review.snapshots.map(snapshot => snapshot.after).join(separator),
    }
  }

  private async openReview(review: ReviewFile, preview: boolean): Promise<void> {
    const id = randomUUID()
    const name = path.basename(review.absolutePath)
    const beforeUri = vscode.Uri.from({ scheme: 'dsh-diff', authority: 'before', path: `/${id}/${name}` })
    const afterUri = vscode.Uri.from({ scheme: 'dsh-diff', authority: 'after', path: `/${id}/${name}` })
    const content = this.reviewContent(review)
    this.content.set(beforeUri.toString(), content.before)
    this.content.set(afterUri.toString(), content.after)
    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `${review.displayPath} — DeepSeek changes`,
      { preview },
    )
  }
}
