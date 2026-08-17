import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConversationProjector, type ConversationMessage, type DshEvent } from './conversation.js'
import { DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey } from './credentials.js'
import { EditorContextBridge } from './editor-context-bridge.js'
import {
  DshClient,
  type CommandDescriptor,
  type DshFrame,
  type ImageMediaType,
  type ModelSelection,
  type PromptImage,
  type SessionModels,
  type SessionSummary,
} from './dsh-client.js'
import { withIdeContext, type IdeContextSnapshot } from './ide-context.js'
import { DshRuntime, type RuntimeState } from './runtime.js'
import { chatHtml } from './webview.js'

let activeRuntime: DshRuntime | undefined

interface SessionItem {
  id: string
  title: string
}

interface ReasoningEffortItem {
  id: string
  label: string
  selected: boolean
}

interface ModelItem {
  provider: string
  model: string
  label: string
  selected: boolean
  reasoningEfforts: ReasoningEffortItem[]
  defaultReasoningEffort?: string
}

interface ApprovalItem {
  rpcId: string
  approvalId: string
  toolName: string
  reason?: string
}

interface QuestionOption {
  label: string
  description?: string
}

interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

interface QuestionRequest {
  rpcId: string
  questions: QuestionItem[]
}

interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

interface WorkspacePick extends vscode.QuickPickItem {
  action?: 'switch' | 'open'
  uri?: vscode.Uri
}

interface PermissionPresetItem {
  value: string
  label: string
  description?: string
  selected: boolean
}

interface ChatViewState {
  phase: 'loading' | 'ready' | 'error'
  statusText: string
  workspaceName: string
  cwd: string
  sessions: SessionItem[]
  sessionId: string
  messages: ConversationMessage[]
  running: boolean
  routable: boolean
  models: ModelItem[]
  approval: ApprovalItem | null
  question: QuestionRequest | null
  commands: CommandDescriptor[]
  permissions: PermissionPresetItem[]
}

function initialState(cwd: string): ChatViewState {
  return {
    phase: 'loading',
    statusText: 'Starting the official DeepSeek Harness runtime…',
    workspaceName: path.basename(cwd),
    cwd,
    sessions: [],
    sessionId: '',
    messages: [],
    running: false,
    routable: true,
    models: [],
    approval: null,
    question: null,
    commands: [],
    permissions: [],
  }
}

function titleOf(summary: SessionSummary): string {
  const value = summary.projections?.values?.title
  return typeof value === 'string' && value.trim() !== '' ? value : 'New conversation'
}

function permissionPresetsOf(value: unknown): PermissionPresetItem[] {
  if (typeof value !== 'object' || value === null) return []
  const select = value as Record<string, unknown>
  const current = typeof select.currentValue === 'string' ? select.currentValue : ''
  if (!Array.isArray(select.options)) return []
  return select.options.flatMap((value): PermissionPresetItem[] => {
    if (typeof value !== 'object' || value === null) return []
    const option = value as Record<string, unknown>
    if (typeof option.value !== 'string' || option.value === 'custom') return []
    return [{
      value: option.value,
      label: typeof option.name === 'string' ? option.name : option.value,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
      selected: option.value === current,
    }]
  })
}

class DshChatController implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ChatViewState>()
  private readonly projector = new ConversationProjector()
  private client: DshClient | undefined
  private clientDisposables: Array<() => void> = []
  private summaries: SessionSummary[] = []
  private _state: ChatViewState
  private generation = 0

  readonly onDidChangeState = this.changes.event

  constructor(
    private readonly runtime: DshRuntime,
    private readonly output: vscode.OutputChannel,
    private _cwd: string,
  ) {
    this._state = initialState(_cwd)
  }

  get cwd(): string {
    return this._cwd
  }

  get state(): ChatViewState {
    return this._state
  }

  publish(patch: Partial<ChatViewState>): void {
    this._state = { ...this._state, ...patch }
    this.changes.fire(this._state)
  }

  observeRuntime(state: RuntimeState): void {
    if (state.kind === 'starting') this.publish({ phase: 'loading', statusText: state.detail })
    if (state.kind === 'failed') this.publish({ phase: 'error', statusText: state.message })
    if (state.kind === 'stopped' && this._state.phase === 'ready') {
      this.publish({ phase: 'error', statusText: 'DeepSeek Harness stopped.' })
    }
  }

  async start(): Promise<void> {
    const generation = ++this.generation
    this.disconnectClient()
    this.projector.reset([])
    this.publish({
      phase: 'loading',
      statusText: 'Starting the official DeepSeek Harness runtime…',
      messages: [],
      sessions: [],
      sessionId: '',
      running: false,
      models: [],
      approval: null,
      question: null,
      commands: [],
      permissions: [],
    })
    try {
      const uri = await this.runtime.start(this.cwd === '' ? undefined : vscode.Uri.file(this.cwd))
      if (generation !== this.generation) return
      const client = new DshClient(new URL(uri.toString(true)))
      this.client = client
      this.clientDisposables.push(
        client.onFrame(frame => {
          const type = frame.payload.type
          if (typeof type === 'string' && (type.startsWith('approval/') || type.startsWith('question/'))) {
            this.output.appendLine(`[protocol] ${type} for ${String(frame.payload.sessionId ?? 'unknown session')}`)
          }
          this.acceptFrame(frame)
        }),
        client.onError(error => {
          this.output.appendLine(`[protocol] ${error.message}`)
          this.publish({ phase: 'error', statusText: `Lost the DSH event stream: ${error.message}` })
        }),
      )
      await this.loadSessions()
      if (generation !== this.generation || this.client !== client) return
      client.startStreams()
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[chat] ${message}`)
      this.publish({ phase: 'error', statusText: message })
    }
  }

  async restart(): Promise<void> {
    ++this.generation
    this.disconnectClient()
    await this.runtime.stop()
    await this.start()
  }

  async switchWorkspace(cwd: string): Promise<void> {
    if (cwd === '' || cwd === this.cwd) return
    if (this._state.running) throw new Error('Wait for the current DeepSeek task to finish before switching projects.')
    this._cwd = cwd
    this.summaries = []
    this.projector.reset([])
    this.publish({
      ...initialState(cwd),
      statusText: 'Switching DeepSeek Harness to this project…',
    })
    await this.restart()
  }

  async newSession(): Promise<void> {
    const client = this.requireClient()
    const reusable = this.summaries.find(summary => summary.blank && summary.cwd === this.cwd)
    const sessionId = reusable?.sessionId ?? (await client.createSession(this.cwd)).sessionId
    await this.loadSessions(sessionId)
  }

  async selectSession(sessionId: string): Promise<void> {
    if (!this.summaries.some(summary => summary.sessionId === sessionId && summary.cwd === this.cwd)) return
    await this.loadSession(sessionId)
  }

  async send(text: string, images: readonly PromptImage[] = [], ideContext?: IdeContextSnapshot): Promise<void> {
    const normalized = text.trim()
    if ((normalized === '' && images.length === 0) || this._state.sessionId === '') return
    if (normalized.startsWith('/')) {
      const token = normalized.split(/\s/, 1)[0] ?? normalized
      const name = /^\/([a-z0-9-]+)$/.exec(token)?.[1]
      if (name === undefined || !this._state.commands.some(command => command.name === name)) {
        throw new Error(`Unknown DeepSeek command: ${token}`)
      }
      if (images.length > 0) throw new Error('DeepSeek commands cannot include image attachments.')
      const execution = await this.requireClient().executeCommand(this._state.sessionId, normalized)
      if (execution === undefined) throw new Error(`DeepSeek did not recognize ${token}.`)
      return
    }
    await this.requireClient().prompt(
      this._state.sessionId,
      ideContext === undefined ? normalized : withIdeContext(normalized, ideContext),
      images,
    )
  }

  async cancel(): Promise<void> {
    if (this._state.sessionId === '') return
    await this.requireClient().cancel(this._state.sessionId)
  }

  async selectModel(selection: ModelSelection): Promise<void> {
    if (this._state.sessionId === '') return
    await this.requireClient().selectModel(this._state.sessionId, selection)
    await this.loadModels(this._state.sessionId)
  }

  async answerApproval(rpcId: string, approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (this._state.sessionId === '') return
    await this.requireClient().respond(rpcId, {
      sessionId: this._state.sessionId,
      approvalId,
      outcome,
    })
    if (this._state.approval?.rpcId === rpcId) this.publish({ approval: null })
  }

  async answerQuestions(rpcId: string, answers: readonly QuestionAnswer[]): Promise<void> {
    if (this._state.sessionId === '') return
    const pending = this._state.question
    if (pending?.rpcId !== rpcId) throw new Error('This question is no longer pending.')
    const expected = new Set(pending.questions.map(question => question.id))
    if (answers.length !== expected.size || answers.some(answer => !expected.has(answer.id))) {
      throw new Error('Every DeepSeek question needs an answer.')
    }
    await this.requireClient().respond(rpcId, {
      sessionId: this._state.sessionId,
      answer: { answers },
    })
    if (this._state.question?.rpcId === rpcId) this.publish({ question: null })
  }

  report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.output.appendLine(`[chat] ${message}`)
    this.projector.notice(`error:${String(Date.now())}`, message, true)
    this.publish({ messages: this.projector.messages() })
  }

  dispose(): void {
    ++this.generation
    this.disconnectClient()
    this.changes.dispose()
  }

  private requireClient(): DshClient {
    if (this.client === undefined) throw new Error('DeepSeek Harness is not connected.')
    return this.client
  }

  private disconnectClient(): void {
    for (const dispose of this.clientDisposables.splice(0)) dispose()
    this.client?.dispose()
    this.client = undefined
  }

  private async loadSessions(preferredId?: string): Promise<void> {
    const client = this.requireClient()
    const { items } = await client.listSessions()
    this.summaries = items.filter(summary => summary.cwd === this.cwd && summary.origin !== 'subagent')
    const currentStillExists = this.summaries.some(summary => summary.sessionId === this._state.sessionId)
    const visible = this.summaries.filter(summary => !summary.blank || summary.sessionId === preferredId)
    const selectedId = preferredId
      ?? (currentStillExists ? this._state.sessionId : undefined)
      ?? visible[0]?.sessionId
      ?? this.summaries[0]?.sessionId

    this.publish({
      sessions: visible.map(summary => ({ id: summary.sessionId, title: titleOf(summary) })),
    })
    if (selectedId === undefined) {
      const created = await client.createSession(this.cwd)
      await this.loadSessions(created.sessionId)
      return
    }
    await this.loadSession(selectedId)
  }

  private async loadSession(sessionId: string): Promise<void> {
    const client = this.requireClient()
    this.publish({ phase: 'loading', statusText: 'Loading project conversation…', sessionId })
    const [{ events }, models] = await Promise.all([
      client.history(sessionId),
      client.models(sessionId),
    ])
    if (this.client !== client || this._state.sessionId !== sessionId) return
    this.projector.reset(events)
    const summary = this.summaries.find(item => item.sessionId === sessionId)
    this.publish({
      phase: 'ready',
      statusText: '',
      sessionId,
      messages: this.projector.messages(),
      running: summary?.running ?? false,
      approval: null,
      question: null,
      commands: [],
      permissions: permissionPresetsOf(summary?.projections?.values?.permissions),
      ...this.modelPatch(models),
    })
    void this.loadCommands(client, sessionId)
  }

  private async loadCommands(client: DshClient, sessionId: string): Promise<void> {
    try {
      const commands = await client.listCommands(sessionId)
      if (this.client === client && this._state.sessionId === sessionId) {
        this.publish({ commands: commands.filter(command => command.name !== 'export') })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[commands] Discovery unavailable: ${message}`)
    }
  }

  private async loadModels(sessionId: string): Promise<void> {
    const client = this.requireClient()
    const models = await client.models(sessionId)
    if (this.client === client && this._state.sessionId === sessionId) this.publish(this.modelPatch(models))
  }

  private modelPatch(models: SessionModels): Pick<ChatViewState, 'models' | 'routable'> {
    const options: ModelItem[] = []
    for (const group of models.groups) {
      for (const model of group.models) {
        const selected = group.id === models.current.provider && model.id === models.current.model
        options.push({
          provider: group.id,
          model: model.id,
          label: model.name,
          selected,
          reasoningEfforts: (model.reasoning?.efforts ?? []).map(effort => ({
            id: effort.id,
            label: effort.name,
            selected: selected && effort.id === models.current.reasoningEffort,
          })),
          ...(model.reasoning?.defaultEffort === undefined
            ? {}
            : { defaultReasoningEffort: model.reasoning.defaultEffort }),
        })
      }
    }
    return {
      models: options,
      routable: models.routable,
    }
  }

  private acceptFrame(frame: DshFrame): void {
    const payload = frame.payload
    const type = typeof payload.type === 'string' ? payload.type : ''
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''

    if (frame.channel === 'mux' && type === 'session/event' && sessionId === this._state.sessionId) {
      const event = payload.event
      if (typeof event === 'object' && event !== null) {
        this.projector.apply(event as DshEvent, payload.view)
        this.publish({ messages: this.projector.messages() })
      }
      return
    }

    if (frame.channel === 'mux' && type === 'approval/requested' && sessionId === this._state.sessionId) {
      if (typeof payload.approvalId !== 'string' || typeof payload.toolName !== 'string') return
      this.publish({
        approval: {
          rpcId: frame.rpcId,
          approvalId: payload.approvalId,
          toolName: payload.toolName,
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
        },
      })
      return
    }

    if (frame.channel === 'mux' && type === 'approval/resolved' && sessionId === this._state.sessionId) {
      if (this._state.approval?.approvalId === payload.approvalId) this.publish({ approval: null })
      return
    }

    if (frame.channel === 'mux' && type === 'question/requested' && sessionId === this._state.sessionId) {
      if (!Array.isArray(payload.questions)) return
      const questions = payload.questions.flatMap((value): QuestionItem[] => {
        if (typeof value !== 'object' || value === null) return []
        const item = value as Record<string, unknown>
        if (typeof item.id !== 'string' || typeof item.question !== 'string') return []
        const options = Array.isArray(item.options)
          ? item.options.flatMap((option): QuestionOption[] => {
            if (typeof option !== 'object' || option === null) return []
            const candidate = option as Record<string, unknown>
            if (typeof candidate.label !== 'string') return []
            return [{
              label: candidate.label,
              ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
            }]
          })
          : []
        return [{
          id: item.id,
          question: item.question,
          ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
          ...(typeof item.header === 'string' ? { header: item.header } : {}),
          options,
          multiSelect: item.multiSelect === true,
        }]
      })
      if (questions.length > 0) this.publish({ question: { rpcId: frame.rpcId, questions } })
      return
    }

    if (frame.channel === 'mux' && type === 'question/resolved' && sessionId === this._state.sessionId) {
      if (this._state.question?.rpcId === payload.questionRpcId) this.publish({ question: null })
      return
    }

    if (frame.channel === 'mux' && type === 'session/projection') {
      const summary = this.summaries.find(item => item.sessionId === sessionId)
      if (summary !== undefined && typeof payload.key === 'string') {
        summary.projections = { values: { ...summary.projections?.values, [payload.key]: payload.value } }
      }
      if (typeof payload.value === 'string' && payload.key === 'title') {
        this.publish({
          sessions: this._state.sessions.map(item => item.id === sessionId ? { ...item, title: payload.value as string } : item),
        })
      }
      if (payload.key === 'permissions' && sessionId === this._state.sessionId) {
        this.publish({ permissions: permissionPresetsOf(payload.value) })
      }
      return
    }

    if (frame.channel === 'host' && type === 'host/session-status') {
      const running = payload.running === true
      const summary = this.summaries.find(item => item.sessionId === sessionId)
      if (summary !== undefined) summary.running = running
      if (sessionId === this._state.sessionId) this.publish({ running })
      return
    }

    if (frame.channel === 'host' && type === 'host/agent-error' && sessionId === this._state.sessionId) {
      const message = typeof payload.message === 'string' ? payload.message : 'DeepSeek Harness reported an agent error.'
      this.projector.notice(`agent-error:${frame.rpcId}`, message, true)
      this.publish({ messages: this.projector.messages(), running: false })
      return
    }

    if (frame.channel === 'host' && type === 'host/session-added' && payload.cwd === this.cwd) {
      void this.loadSessions(sessionId).catch(error => { this.report(error) })
    }
  }
}

class DshSurface implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[]
  private readonly draftImages: Array<PromptImage & { id: string }> = []

  constructor(
    private readonly webview: vscode.Webview,
    private readonly controller: DshChatController,
    private readonly output: vscode.OutputChannel,
    private readonly editorContext: EditorContextBridge,
    extensionUri: vscode.Uri,
  ) {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] }
    webview.html = chatHtml(webview, webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'deepseek.svg')))
    this.disposables = [
      controller.onDidChangeState(state => { void webview.postMessage({ type: 'state', state }) }),
      editorContext.onDidChange(state => { void webview.postMessage({ type: 'ide-context', state }) }),
      webview.onDidReceiveMessage(message => { this.acceptMessage(message) }),
    ]
  }

  focusPrompt(): void {
    void this.webview.postMessage({ type: 'focus-prompt' })
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
  }

  private async chooseImages(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: 'Attach images to the DeepSeek prompt',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    })
    if (selected === undefined) return
    for (const uri of selected) {
      const mediaType = imageMediaType(uri.fsPath)
      if (mediaType === undefined) continue
      const bytes = await vscode.workspace.fs.readFile(uri)
      this.draftImages.push({
        id: randomUUID(),
        type: 'image',
        mediaType,
        data: Buffer.from(bytes).toString('base64'),
        name: path.basename(uri.fsPath),
      })
    }
    await this.publishDraftImages()
  }

  private async chooseWorkspace(): Promise<void> {
    const current = this.controller.state.cwd
    const folders = vscode.workspace.workspaceFolders ?? []
    const items: WorkspacePick[] = [
      ...folders.map(folder => ({
        label: `$(folder) ${folder.name}`,
        ...(folder.uri.fsPath === current ? { description: 'Current project' } : {}),
        detail: folder.uri.fsPath,
        uri: folder.uri,
        action: 'switch' as const,
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(folder-opened) Open another project…',
        detail: 'Open a different folder in this VS Code window',
        action: 'open' as const,
      },
    ]
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Choose DeepSeek project',
      placeHolder: 'DeepSeek reads, writes, and runs commands in this project',
    })
    if (selected === undefined) return
    if (selected.action === 'switch' && selected.uri !== undefined) {
      await this.controller.switchWorkspace(selected.uri.fsPath)
      return
    }
    if (selected.action === 'open') {
      const opened = await vscode.window.showOpenDialog({
        title: 'Open a project for DeepSeek Harness',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      })
      if (opened?.[0] !== undefined) await vscode.commands.executeCommand('vscode.openFolder', opened[0], false)
    }
  }

  private async publishDraftImages(): Promise<void> {
    await this.webview.postMessage({
      type: 'draft-images',
      images: this.draftImages.map(image => ({ id: image.id, name: image.name, mediaType: image.mediaType })),
    })
  }

  private acceptMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    const value = message as Record<string, unknown>
    const run = async (): Promise<void> => {
      switch (value.type) {
        case 'ready':
          await this.webview.postMessage({ type: 'state', state: this.controller.state })
          await this.webview.postMessage({ type: 'ide-context', state: this.editorContext.viewState() })
          return
        case 'restart': await this.controller.restart(); return
        case 'output': this.output.show(true); return
        case 'new-session': await this.controller.newSession(); return
        case 'select-session':
          if (typeof value.sessionId === 'string') await this.controller.selectSession(value.sessionId)
          return
        case 'send':
          if (typeof value.text === 'string') {
            if (value.text.trim() === '/permission danger-full-access') {
              const confirmed = await vscode.window.showWarningMessage(
                'Enable Full access?',
                {
                  modal: true,
                  detail: 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
                },
                'Enable Full Access',
              )
              if (confirmed !== 'Enable Full Access') return
            }
            const isCommand = value.text.trim().startsWith('/')
            const ideContext = isCommand ? undefined : await this.editorContext.snapshotForPrompt(value.text)
            await this.controller.send(value.text, this.draftImages, ideContext)
            this.draftImages.length = 0
            if (!isCommand) this.editorContext.clearPinned()
            await this.publishDraftImages()
          }
          return
        case 'attach': await this.chooseImages(); return
        case 'choose-workspace': await this.chooseWorkspace(); return
        case 'request-mentions':
          if (typeof value.requestId === 'number' && typeof value.query === 'string') {
            const candidates = await this.editorContext.search(value.query)
            await this.webview.postMessage({
              type: 'mention-suggestions',
              requestId: value.requestId,
              query: value.query,
              candidates,
            })
          }
          return
        case 'remove-context':
          if (typeof value.id === 'string') this.editorContext.removePinned(value.id)
          return
        case 'remove-attachment':
          if (typeof value.id === 'string') {
            const index = this.draftImages.findIndex(image => image.id === value.id)
            if (index >= 0) this.draftImages.splice(index, 1)
            await this.publishDraftImages()
          }
          return
        case 'cancel': await this.controller.cancel(); return
        case 'approval':
          if (
            typeof value.rpcId === 'string'
            && typeof value.approvalId === 'string'
            && (value.outcome === 'allowed-once' || value.outcome === 'rejected')
          ) await this.controller.answerApproval(value.rpcId, value.approvalId, value.outcome)
          return
        case 'question':
          if (typeof value.rpcId === 'string' && Array.isArray(value.answers)) {
            const answers = value.answers.flatMap((answer): QuestionAnswer[] => {
              if (typeof answer !== 'object' || answer === null) return []
              const item = answer as Record<string, unknown>
              if (typeof item.id !== 'string' || !Array.isArray(item.selected) || !item.selected.every(label => typeof label === 'string')) return []
              return [{
                id: item.id,
                selected: item.selected as string[],
                ...(typeof item.custom === 'string' && item.custom.trim() !== '' ? { custom: item.custom.trim() } : {}),
              }]
            })
            await this.controller.answerQuestions(value.rpcId, answers)
          }
          return
        case 'open-link':
          if (typeof value.href === 'string') {
            const uri = vscode.Uri.parse(value.href)
            if (uri.scheme === 'http' || uri.scheme === 'https') await vscode.env.openExternal(uri)
          }
          return
        case 'select-model':
          if (typeof value.selection === 'object' && value.selection !== null) {
            const selection = value.selection as Record<string, unknown>
            if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
              await this.controller.selectModel({
                provider: selection.provider,
                model: selection.model,
                ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
              })
            }
          }
      }
    }
    void run().catch(error => { this.controller.report(error) })
  }
}

function imageMediaType(filePath: string): ImageMediaType | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

class DshViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private surface: DshSurface | undefined

  constructor(
    private readonly controller: DshChatController,
    private readonly output: vscode.OutputChannel,
    private readonly editorContext: EditorContextBridge,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.surface?.dispose()
    const surface = new DshSurface(view.webview, this.controller, this.output, this.editorContext, this.extensionUri)
    this.surface = surface
    view.onDidDispose(() => {
      surface.dispose()
      if (this.surface === surface) this.surface = undefined
    })
    const autoStart = vscode.workspace.getConfiguration('deepseekHarness').get<boolean>('autoStart', true)
    if (autoStart) void this.controller.start()
  }

  dispose(): void {
    this.surface?.dispose()
  }

  focusPrompt(): void {
    this.surface?.focusPrompt()
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const workspace = vscode.workspace.workspaceFolders?.[0]
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const runtime = new DshRuntime(context, output)
  activeRuntime = runtime

  if (workspace === undefined) {
    output.appendLine('[chat] Open a folder or workspace before using DeepSeek Harness.')
  }
  const cwd = workspace?.uri.fsPath ?? ''
  const controller = new DshChatController(runtime, output, cwd)
  const editorContext = new EditorContextBridge(() => controller.cwd)
  const provider = new DshViewProvider(controller, output, editorContext, context.extensionUri)
  const panels = new Set<{ panel: vscode.WebviewPanel; surface: DshSurface }>()

  context.subscriptions.push(output, runtime, controller, editorContext, provider)
  context.subscriptions.push(runtime.onDidChangeState(state => { controller.observeRuntime(state) }))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'deepseekHarness.chat',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  ))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openInEditor', async () => {
    const panel = vscode.window.createWebviewPanel(
      'deepseekHarness.editor',
      'DeepSeek Harness',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    const entry = { panel, surface: new DshSurface(panel.webview, controller, output, editorContext, context.extensionUri) }
    panels.add(entry)
    panel.onDidDispose(() => {
      entry.surface.dispose()
      panels.delete(entry)
    })
    await controller.start()
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.restart', async () => {
    await controller.restart().catch(error => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)) })
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.addSelection', async () => {
    if (!editorContext.pinSelection()) {
      void vscode.window.showInformationMessage('Select code in the current DeepSeek project first.')
      return
    }
    await vscode.commands.executeCommand('workbench.view.extension.deepseekHarness')
    provider.focusPrompt()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.showOutput', () => { output.show(true) }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openInBrowser', async () => {
    try {
      const uri = await runtime.start()
      await vscode.env.openExternal(await vscode.env.asExternalUri(uri))
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.configureApiKey', async () => {
    const value = await vscode.window.showInputBox({
      title: 'Configure DeepSeek API Key',
      prompt: 'Paste the key here. It is stored in VS Code SecretStorage and passed only to the official DSH child process.',
      placeHolder: 'sk-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (candidate) => {
        try {
          normalizeDeepSeekApiKey(candidate)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    })
    if (value === undefined) return

    const apiKey = normalizeDeepSeekApiKey(value)
    await context.secrets.store(DEEPSEEK_API_KEY_SECRET, apiKey)
    output.appendLine('[credentials] DeepSeek API key stored in VS Code SecretStorage.')
    await controller.restart()
    void vscode.window.showInformationMessage('DeepSeek API key configured. DeepSeek Harness restarted.')
  }))

  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.clearApiKey', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Remove the DeepSeek API key stored by this extension?',
      { modal: true },
      'Remove',
    )
    if (choice !== 'Remove') return

    await context.secrets.delete(DEEPSEEK_API_KEY_SECRET)
    output.appendLine('[credentials] DeepSeek API key removed from VS Code SecretStorage.')
    await controller.restart()
    void vscode.window.showInformationMessage('Stored DeepSeek API key removed. DeepSeek Harness restarted.')
  }))
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = undefined
  await runtime?.stop()
}
