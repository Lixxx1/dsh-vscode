import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  mentionedPaths,
  searchMentionCandidates,
  type IdeContextReference,
  type IdeContextSnapshot,
  type IdeMentionCandidate,
} from './ide-context.js'

const MAX_SELECTION_CHARACTERS = 100_000
const SEARCH_EXCLUDE = '**/{.git,node_modules,dist,build,out,.next,coverage,.cache}/**'

export interface IdeContextViewReference extends Omit<IdeContextReference, 'text'> {
  id?: string
}

export interface IdeContextViewState {
  activeFile?: IdeContextViewReference
  selection?: IdeContextViewReference
  pinned: IdeContextViewReference[]
}

interface PinnedReference {
  id: string
  reference: IdeContextReference
}

function insideWorkspace(cwd: string, filePath: string): string | undefined {
  if (cwd === '') return undefined
  const relative = path.relative(cwd, filePath)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

function withoutText(reference: IdeContextReference, id?: string): IdeContextViewReference {
  return {
    kind: reference.kind,
    path: reference.path,
    ...(reference.languageId === undefined ? {} : { languageId: reference.languageId }),
    ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
    ...(reference.truncated === undefined ? {} : { truncated: reference.truncated }),
    ...(id === undefined ? {} : { id }),
  }
}

export class EditorContextBridge implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<IdeContextViewState>()
  private readonly pinned: PinnedReference[] = []
  private readonly disposables: vscode.Disposable[]
  private readonly candidateCache = new Map<string, Promise<IdeMentionCandidate[]>>()

  readonly onDidChange = this.changes.event

  constructor(private readonly cwd: () => string) {
    this.disposables = [
      vscode.window.onDidChangeActiveTextEditor(() => { this.publish() }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === vscode.window.activeTextEditor) this.publish()
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === vscode.window.activeTextEditor?.document) this.publish()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.invalidateCandidates() }),
      vscode.workspace.onDidCreateFiles(() => { this.invalidateCandidates() }),
      vscode.workspace.onDidDeleteFiles(() => { this.invalidateCandidates() }),
      vscode.workspace.onDidRenameFiles(() => { this.invalidateCandidates() }),
    ]
  }

  viewState(): IdeContextViewState {
    const current = this.currentReferences()
    return {
      ...(current.activeFile === undefined ? {} : { activeFile: withoutText(current.activeFile) }),
      ...(current.selection === undefined ? {} : { selection: withoutText(current.selection) }),
      pinned: this.pinned.map(item => withoutText(item.reference, item.id)),
    }
  }

  pinSelection(): boolean {
    const selection = this.currentReferences().selection
    if (selection === undefined) return false
    const duplicate = this.pinned.some(item => item.reference.path === selection.path
      && item.reference.startLine === selection.startLine
      && item.reference.endLine === selection.endLine
      && item.reference.text === selection.text)
    if (!duplicate) this.pinned.push({ id: randomUUID(), reference: selection })
    this.publish()
    return true
  }

  removePinned(id: string): void {
    const index = this.pinned.findIndex(item => item.id === id)
    if (index < 0) return
    this.pinned.splice(index, 1)
    this.publish()
  }

  clearPinned(): void {
    if (this.pinned.length === 0) return
    this.pinned.length = 0
    this.publish()
  }

  async snapshotForPrompt(text: string): Promise<IdeContextSnapshot> {
    const current = this.currentReferences()
    const candidates = await this.candidates()
    const byPath = new Map(candidates.map(candidate => [candidate.path, candidate]))
    const mentions = mentionedPaths(text).flatMap((mentioned): IdeContextReference[] => {
      const candidate = byPath.get(mentioned)
      return candidate === undefined ? [] : [{ kind: candidate.kind, path: candidate.path }]
    })
    const pinned = this.pinned
      .map(item => item.reference)
      .filter(reference => current.selection === undefined
        || reference.path !== current.selection.path
        || reference.startLine !== current.selection.startLine
        || reference.endLine !== current.selection.endLine
        || reference.text !== current.selection.text)
    return {
      ...current,
      pinned,
      mentions,
    }
  }

  async search(query: string): Promise<IdeMentionCandidate[]> {
    return searchMentionCandidates(await this.candidates(), query)
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
    this.changes.dispose()
  }

  private currentReferences(): Pick<IdeContextSnapshot, 'activeFile' | 'selection'> {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined || editor.document.uri.scheme !== 'file') return {}
    const relative = insideWorkspace(this.cwd(), editor.document.uri.fsPath)
    if (relative === undefined) return {}
    const activeFile: IdeContextReference = {
      kind: 'file',
      path: relative,
      languageId: editor.document.languageId,
    }
    if (editor.selection.isEmpty) return { activeFile }
    const fullText = editor.document.getText(editor.selection)
    const truncated = fullText.length > MAX_SELECTION_CHARACTERS
    const selection: IdeContextReference = {
      kind: 'selection',
      path: relative,
      languageId: editor.document.languageId,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
        ? editor.selection.end.line
        : editor.selection.end.line + 1,
      text: truncated ? fullText.slice(0, MAX_SELECTION_CHARACTERS) : fullText,
      ...(truncated ? { truncated: true } : {}),
    }
    return { activeFile, selection }
  }

  private publish(): void {
    this.changes.fire(this.viewState())
  }

  private invalidateCandidates(): void {
    this.candidateCache.clear()
    this.publish()
  }

  private candidates(): Promise<IdeMentionCandidate[]> {
    const cwd = this.cwd()
    if (cwd === '') return Promise.resolve([])
    const cached = this.candidateCache.get(cwd)
    if (cached !== undefined) return cached
    const loading = Promise.resolve(vscode.workspace.findFiles(
      new vscode.RelativePattern(cwd, '**/*'),
      SEARCH_EXCLUDE,
      5_000,
    )).then(uris => {
      const files = new Set<string>()
      const folders = new Set<string>()
      for (const uri of uris) {
        const relative = insideWorkspace(cwd, uri.fsPath)
        if (relative === undefined) continue
        files.add(relative)
        const parts = relative.split('/')
        for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'))
      }
      return [
        ...[...folders].map(folder => ({ kind: 'folder' as const, path: folder })),
        ...[...files].map(file => ({ kind: 'file' as const, path: file })),
      ]
    }).catch(error => {
      this.candidateCache.delete(cwd)
      throw error
    })
    this.candidateCache.set(cwd, loading)
    return loading
  }
}
