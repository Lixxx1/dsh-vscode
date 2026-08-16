import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConversationProjector, type ConversationMessage, type DshEvent } from './conversation.js'
import { DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey } from './credentials.js'
import { DshClient, type DshFrame, type ModelSelection, type SessionModels, type SessionSummary } from './dsh-client.js'
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
  }
}

function titleOf(summary: SessionSummary): string {
  const value = summary.projections?.values?.title
  return typeof value === 'string' && value.trim() !== '' ? value : 'New conversation'
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
    readonly cwd: string,
  ) {
    this._state = initialState(cwd)
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
    })
    try {
      const uri = await this.runtime.start()
      if (generation !== this.generation) return
      const client = new DshClient(new URL(uri.toString(true)))
      this.client = client
      this.clientDisposables.push(
        client.onFrame(frame => { this.acceptFrame(frame) }),
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

  async send(text: string): Promise<void> {
    const normalized = text.trim()
    if (normalized === '' || this._state.sessionId === '') return
    await this.requireClient().prompt(this._state.sessionId, normalized)
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
    this.projector.reset(events.map(entry => entry.event))
    const summary = this.summaries.find(item => item.sessionId === sessionId)
    this.publish({
      phase: 'ready',
      statusText: '',
      sessionId,
      messages: this.projector.messages(),
      running: summary?.running ?? false,
      ...this.modelPatch(models),
    })
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
        this.projector.apply(event as DshEvent)
        this.publish({ messages: this.projector.messages() })
      }
      return
    }

    if (frame.channel === 'mux' && type === 'session/projection' && typeof payload.value === 'string') {
      const summary = this.summaries.find(item => item.sessionId === sessionId)
      if (summary !== undefined && payload.key === 'title') {
        summary.projections = { values: { ...summary.projections?.values, title: payload.value } }
        this.publish({
          sessions: this._state.sessions.map(item => item.id === sessionId ? { ...item, title: payload.value as string } : item),
        })
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

  constructor(
    private readonly webview: vscode.Webview,
    private readonly controller: DshChatController,
    private readonly output: vscode.OutputChannel,
    extensionUri: vscode.Uri,
  ) {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] }
    webview.html = chatHtml(webview, webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'deepseek.svg')))
    this.disposables = [
      controller.onDidChangeState(state => { void webview.postMessage({ type: 'state', state }) }),
      webview.onDidReceiveMessage(message => { this.acceptMessage(message) }),
    ]
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
  }

  private acceptMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    const value = message as Record<string, unknown>
    const run = async (): Promise<void> => {
      switch (value.type) {
        case 'ready':
          await this.webview.postMessage({ type: 'state', state: this.controller.state })
          return
        case 'restart': await this.controller.restart(); return
        case 'output': this.output.show(true); return
        case 'new-session': await this.controller.newSession(); return
        case 'select-session':
          if (typeof value.sessionId === 'string') await this.controller.selectSession(value.sessionId)
          return
        case 'send':
          if (typeof value.text === 'string') await this.controller.send(value.text)
          return
        case 'cancel': await this.controller.cancel(); return
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

class DshViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private surface: DshSurface | undefined

  constructor(
    private readonly controller: DshChatController,
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.surface?.dispose()
    const surface = new DshSurface(view.webview, this.controller, this.output, this.extensionUri)
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
  const provider = new DshViewProvider(controller, output, context.extensionUri)
  const panels = new Set<{ panel: vscode.WebviewPanel; surface: DshSurface }>()

  context.subscriptions.push(output, runtime, controller, provider)
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
    const entry = { panel, surface: new DshSurface(panel.webview, controller, output, context.extensionUri) }
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
