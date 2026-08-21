import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConversationProjector, type ConversationImage, type ConversationMessage, type DshEvent } from './conversation.js'
import {
  agentPresetStateOf,
  lockAgentPresetState,
  selectAgentPresetState,
  unavailableAgentPresetState,
  type AgentPresetState,
} from './agent-presets.js'
import {
  permissionPresetsOf,
  planModeCommand,
  planModeStateOf,
  planModeWithCommandAvailability,
  requiresFullAccessConfirmation,
  type PermissionPresetItem,
  type PlanModeState,
} from './collaboration-state.js'
import { DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey } from './credentials.js'
import { DiffReviewManager, type ChangedFileGroup } from './diff-review.js'
import { DirtyFileGuard } from './dirty-file-guard.js'
import { EditorContextBridge } from './editor-context-bridge.js'
import {
  DshClient,
  type CommandDescriptor,
  type DshFrame,
  type HistoryEntry,
  type ImageMediaType,
  type ModelSelection,
  type PromptMode,
  type PromptImage,
  type QueueAction,
  type SessionModels,
  type SessionSummary,
  type SkillDescriptor,
} from './dsh-client.js'
import { replaceTextPreservingIdeContext, withIdeContext, type IdeContextReference, type IdeContextSnapshot } from './ide-context.js'
import { jobsSnapshotOf, type JobItem } from './jobs.js'
import { queueSnapshotOf, type QueueItemState } from './queue.js'
import { DshRuntime, type RuntimeOwnership, type RuntimeState } from './runtime.js'
import { toolWriteIntents } from './tool-write-guard.js'
import { pageConversationMessage } from './tool-output-page.js'
import { chatHtml } from './webview.js'
import { DshPluginManager } from './plugin-manager.js'
import type { PluginInventorySnapshot } from './plugin-profile.js'
import type { SettingsDescription, SettingsMutation, SettingsNamespace } from './runtime-settings.js'
import { earliestHistorySequence, mergeHistoryEntries, unseenHistoryEntries } from './history.js'
import { routeSlashInput, type SlashRoute } from './slash-routing.js'
import { unavailableUsageMeterState, usageMeterStateOf, type UsageMeterState } from './usage-meter.js'
import {
  diffConversationMessages,
  messageForWebview,
  messagesPatchForWebview,
  type ConversationMessagesPatch,
} from './chat-state-patch.js'

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
  skills: SkillDescriptor[]
  agentPreset: AgentPresetState
  usage: UsageMeterState
  permissions: PermissionPresetItem[]
  plan: PlanModeState
  changedFiles: ChangedFileGroup[]
  queue: QueueItemState[]
  jobs: JobItem[]
  hasMoreHistory: boolean
  loadingHistory: boolean
}

interface ChatViewStateUpdate {
  patch: Partial<Omit<ChatViewState, 'messages'>>
  messages?: ConversationMessagesPatch
}

function stateUpdate(previous: ChatViewState, next: ChatViewState): ChatViewStateUpdate | undefined {
  const patch: Partial<Omit<ChatViewState, 'messages'>> = {}
  const previousRecord = previous as unknown as Record<string, unknown>
  const nextRecord = next as unknown as Record<string, unknown>
  const patchRecord = patch as Record<string, unknown>
  for (const key of Object.keys(nextRecord)) {
    if (key !== 'messages' && previousRecord[key] !== nextRecord[key]) patchRecord[key] = nextRecord[key]
  }
  const messages = diffConversationMessages(previous.messages, next.messages)
  return Object.keys(patchRecord).length === 0 && messages === undefined
    ? undefined
    : { patch, ...(messages === undefined ? {} : { messages }) }
}

function stateForWebview(state: ChatViewState): ChatViewState {
  return { ...state, messages: state.messages.map(messageForWebview) }
}

function stateUpdateForWebview(update: ChatViewStateUpdate): ChatViewStateUpdate {
  return {
    patch: update.patch,
    ...(update.messages === undefined ? {} : { messages: messagesPatchForWebview(update.messages) }),
  }
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
    skills: [],
    agentPreset: unavailableAgentPresetState(),
    usage: unavailableUsageMeterState(),
    permissions: [],
    plan: planModeStateOf(undefined),
    changedFiles: [],
    queue: [],
    jobs: [],
    hasMoreHistory: false,
    loadingHistory: false,
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
  private readonly guardedDirtyCalls = new Set<string>()
  private queueRawText = new Map<string, string>()
  private readonly attachmentResults = new Map<string, Pick<ConversationImage, 'data' | 'error'>>()
  private readonly attachmentLoads = new Map<string, Promise<void>>()
  private readonly jobsBySession = new Map<string, JobItem[]>()
  private historyEntries: HistoryEntry[] = []

  readonly onDidChangeState = this.changes.event

  constructor(
    private readonly runtime: DshRuntime,
    private readonly output: vscode.OutputChannel,
    private readonly dirtyFiles: DirtyFileGuard,
    private readonly diffReviews: DiffReviewManager,
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

  get runtimeOwnership(): RuntimeOwnership | undefined {
    const state = this.runtime.state
    return state.kind === 'ready' ? state.ownership : undefined
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
    this.diffReviews.clear()
    this.guardedDirtyCalls.clear()
    this.queueRawText.clear()
    this.attachmentResults.clear()
    this.attachmentLoads.clear()
    this.jobsBySession.clear()
    this.historyEntries = []
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
      skills: [],
      agentPreset: unavailableAgentPresetState(),
      usage: unavailableUsageMeterState(),
      permissions: [],
      plan: planModeStateOf(undefined),
      changedFiles: [],
      queue: [],
      jobs: [],
      hasMoreHistory: false,
      loadingHistory: false,
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
    this.historyEntries = []
    this.guardedDirtyCalls.clear()
    this.publish({
      ...initialState(cwd),
      statusText: 'Switching DeepSeek Harness to this project…',
    })
    await this.restart()
  }

  async newSession(): Promise<void> {
    const client = this.requireClient()
    const created = await client.createSession(this.cwd)
    await this.loadSessions(created.sessionId)
  }

  async selectSession(sessionId: string): Promise<void> {
    if (!this.summaries.some(summary => summary.sessionId === sessionId && summary.cwd === this.cwd)) return
    await this.loadSession(sessionId)
  }

  async loadOlderHistory(): Promise<void> {
    if (this._state.sessionId === '' || !this._state.hasMoreHistory || this._state.loadingHistory) return
    const sessionId = this._state.sessionId
    const client = this.requireClient()
    const beforeSeq = earliestHistorySequence(this.historyEntries)
    if (beforeSeq === undefined) {
      this.publish({ hasMoreHistory: false })
      return
    }
    this.publish({ loadingHistory: true })
    try {
      const page = await client.history(sessionId, beforeSeq)
      if (this.client !== client || this._state.sessionId !== sessionId) return
      const unseenEntries = unseenHistoryEntries(this.historyEntries, page.events)
      this.historyEntries = mergeHistoryEntries(this.historyEntries, unseenEntries)
      this.projector.reset(this.historyEntries)
      this.publish({
        messages: this.projectedMessages(),
        changedFiles: this.diffReviews.prependHistory(sessionId, this.cwd, unseenEntries),
        hasMoreHistory: page.hasMore,
        loadingHistory: false,
      })
      this.hydrateImages(client, sessionId)
    } finally {
      if (this.client === client && this._state.sessionId === sessionId && this._state.loadingHistory) {
        this.publish({ loadingHistory: false })
      }
    }
  }

  async send(
    text: string,
    images: readonly PromptImage[] = [],
    ideContext?: IdeContextSnapshot,
    mode: PromptMode = 'queue',
  ): Promise<void> {
    const normalized = text.trim()
    if ((normalized === '' && images.length === 0) || this._state.sessionId === '') return
    const slash = this.slashRoute(normalized)
    if (slash.kind === 'command') {
      const command = this._state.commands.find(item => item.name === slash.name)
      if (images.length > 0 && command?.input?.images !== true) {
        throw new Error(`${slash.token} does not accept image attachments; remove them first.`)
      }
      const usesRc8Envelope = this._state.commands.some(item => item.input?.images === true)
      const execution = await this.requireClient().executeCommand(
        this._state.sessionId,
        normalized,
        usesRc8Envelope ? images : undefined,
      )
      if (execution === undefined) throw new Error(`DeepSeek did not recognize ${slash.token}.`)
      if (images.length > 0 && execution.result.kind === 'error') {
        throw new Error(execution.result.text ?? `${slash.token} could not use the attached images.`)
      }
      return
    }
    if (slash.kind === 'unknown') throw new Error(`Unknown DeepSeek command or skill: ${slash.token}`)
    await this.requireClient().prompt(
      this._state.sessionId,
      slash.kind === 'skill' || ideContext === undefined ? normalized : withIdeContext(normalized, ideContext),
      images,
      mode,
    )
    const summary = this.summaries.find(item => item.sessionId === this._state.sessionId)
    if (summary !== undefined) summary.blank = false
    this.publish({ agentPreset: lockAgentPresetState(this._state.agentPreset) })
  }

  slashRoute(text: string): SlashRoute {
    return routeSlashInput(text, this._state.commands, this._state.skills)
  }

  async selectAgentPreset(id: string): Promise<void> {
    const current = this._state.agentPreset
    if (!current.available || current.locked || current.busy || id === current.current) return
    if (!current.options.some(option => option.id === id)) throw new Error(`Unknown DeepSeek agent preset: ${id}`)
    const client = this.requireClient()
    const sessionId = this._state.sessionId
    if (sessionId === '') return
    this.publish({ agentPreset: selectAgentPresetState(current, id, true) })
    try {
      const selected = await client.selectAgentPreset(sessionId, id)
      if (this.client !== client || this._state.sessionId !== sessionId) return
      const summary = this.summaries.find(item => item.sessionId === sessionId)
      if (summary !== undefined) summary.agentPreset = selected.agentPreset
      this.publish({
        agentPreset: selectAgentPresetState(this._state.agentPreset, selected.agentPreset, false),
        commands: [],
        skills: [],
      })
      await Promise.all([
        this.loadCommands(client, sessionId),
        this.loadSkills(client, sessionId),
        this.loadModels(sessionId),
      ])
    } catch (error) {
      if (this.client === client && this._state.sessionId === sessionId) {
        this.publish({ agentPreset: { ...current, busy: false } })
      }
      throw error
    }
  }

  async cancel(): Promise<void> {
    if (this._state.sessionId === '') return
    await this.requireClient().cancel(this._state.sessionId)
  }

  async updateQueue(itemId: string, action: 'edit' | 'remove' | 'steer', text?: string): Promise<void> {
    if (this._state.sessionId === '') return
    let request: QueueAction
    if (action === 'edit') {
      const replacement = text?.trim()
      if (replacement === undefined || replacement === '') throw new Error('Queued messages cannot be empty.')
      const original = this.queueRawText.get(itemId)
      request = {
        kind: 'edit',
        content: [{
          type: 'text',
          text: original === undefined ? replacement : replaceTextPreservingIdeContext(original, replacement),
        }],
      }
    } else {
      request = { kind: action }
    }
    await this.requireClient().updateQueue(this._state.sessionId, itemId, request)
  }

  async selectModel(selection: ModelSelection): Promise<void> {
    if (this._state.sessionId === '') return
    await this.requireClient().selectModel(this._state.sessionId, selection)
    await this.loadModels(this._state.sessionId)
  }

  pluginInventory(): Promise<PluginInventorySnapshot> {
    return this.requireClient().pluginInventory()
  }

  settings(): Promise<SettingsDescription> {
    return this.requireClient().settings()
  }

  mutateSettings(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<SettingsNamespace> {
    return this.requireClient().mutateSettings(ns, ops, expectedRevision)
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
    this.publish({ messages: this.projectedMessages() })
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
    this.historyEntries = []
    this.publish({
      phase: 'loading',
      statusText: 'Loading project conversation…',
      sessionId,
      hasMoreHistory: false,
      loadingHistory: false,
    })
    const [{ events, hasMore }, models] = await Promise.all([
      client.history(sessionId),
      client.models(sessionId),
    ])
    if (this.client !== client || this._state.sessionId !== sessionId) return
    this.projector.reset(events)
    this.historyEntries = events
    this.guardedDirtyCalls.clear()
    this.queueRawText.clear()
    const summary = this.summaries.find(item => item.sessionId === sessionId)
    this.publish({
      phase: 'ready',
      statusText: '',
      sessionId,
      messages: this.projectedMessages(),
      running: summary?.running ?? false,
      approval: null,
      question: null,
      commands: [],
      skills: [],
      agentPreset: unavailableAgentPresetState(),
      usage: usageMeterStateOf(summary?.projections?.values),
      permissions: permissionPresetsOf(summary?.projections?.values?.permissions),
      plan: planModeStateOf(summary?.projections?.values?.plan),
      changedFiles: this.diffReviews.rebuild(sessionId, this.cwd, events),
      queue: [],
      jobs: this.jobsBySession.get(sessionId) ?? [],
      hasMoreHistory: hasMore,
      loadingHistory: false,
      ...this.modelPatch(models),
    })
    this.hydrateImages(client, sessionId)
    void this.loadCommands(client, sessionId)
    void this.loadSkills(client, sessionId)
    void this.loadAgentPresets(client, sessionId)
  }

  private async loadCommands(client: DshClient, sessionId: string): Promise<void> {
    try {
      const commands = await client.listCommands(sessionId)
      if (this.client === client && this._state.sessionId === sessionId) {
        const visibleCommands = commands.filter(command => command.name !== 'export')
        this.publish({
          commands: visibleCommands,
          plan: planModeWithCommandAvailability(
            this._state.plan,
            visibleCommands.some(command => command.name === 'plan'),
          ),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[commands] Discovery unavailable: ${message}`)
    }
  }

  private async loadSkills(client: DshClient, sessionId: string): Promise<void> {
    try {
      const skills = await client.listSkills(sessionId)
      if (this.client === client && this._state.sessionId === sessionId) this.publish({ skills })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[skills] Discovery unavailable: ${message}`)
    }
  }

  private async loadAgentPresets(client: DshClient, sessionId: string): Promise<void> {
    try {
      const roster = await client.listAgentPresets()
      if (this.client !== client || this._state.sessionId !== sessionId) return
      const summary = this.summaries.find(item => item.sessionId === sessionId)
      this.publish({ agentPreset: agentPresetStateOf(roster.presets, summary?.agentPreset, summary?.blank ?? false) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[agent-preset] Discovery unavailable: ${message}`)
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
        const dshEvent = event as DshEvent
        if (dshEvent.type === 'user/message') {
          const summary = this.summaries.find(item => item.sessionId === sessionId)
          if (summary !== undefined) summary.blank = false
          this.publish({ agentPreset: lockAgentPresetState(this._state.agentPreset) })
        }
        if (dshEvent.type === 'agent-preset/selected') {
          const data = typeof dshEvent.data === 'object' && dshEvent.data !== null
            ? dshEvent.data as Record<string, unknown>
            : undefined
          const agentPreset = typeof data?.agentPreset === 'string' ? data.agentPreset : undefined
          if (agentPreset !== undefined) {
            const summary = this.summaries.find(item => item.sessionId === sessionId)
            if (summary !== undefined) summary.agentPreset = agentPreset
            this.publish({
              agentPreset: selectAgentPresetState(this._state.agentPreset, agentPreset, false),
              commands: [],
              skills: [],
            })
            const client = this.client
            if (client !== undefined) {
              void this.loadCommands(client, sessionId)
              void this.loadSkills(client, sessionId)
            }
          }
        }
        this.historyEntries = mergeHistoryEntries(this.historyEntries, [{ event: dshEvent, view: payload.view }])
        const conflict = this.dirtyConflict(dshEvent, payload.view)
        if (conflict !== undefined) void this.cancelForDirtyConflict(conflict)
        this.projector.apply(dshEvent, payload.view)
        const changed = this.diffReviews.accept(sessionId, this.cwd, dshEvent, payload.view)
        if (conflict !== undefined) {
          const label = conflict.paths.length === 1
            ? `\`${conflict.paths[0] ?? 'file'}\``
            : `${String(conflict.paths.length)} files`
          this.projector.notice(
            `dirty-file:${conflict.callId}`,
            `DeepSeek stopped because ${label} has unsaved VS Code changes. Save or discard them, then retry.`,
            true,
          )
        }
        this.publish({
          messages: this.projectedMessages(),
          ...(changed ? { changedFiles: this.diffReviews.changedFiles(sessionId) } : {}),
        })
        this.hydrateImages(this.requireClient(), sessionId)
      }
      return
    }

    if (frame.channel === 'mux' && type === 'session/subscribed' && sessionId === this._state.sessionId) {
      this.queueRawText.clear()
      this.jobsBySession.set(sessionId, [])
      this.publish({ queue: [], jobs: [] })
      return
    }

    if (frame.channel === 'mux' && type === 'session/subscribed') {
      this.jobsBySession.set(sessionId, [])
      return
    }

    if (frame.channel === 'mux' && type === 'session/jobs') {
      const jobs = jobsSnapshotOf(payload.jobs)
      this.jobsBySession.set(sessionId, jobs)
      if (sessionId === this._state.sessionId) this.publish({ jobs })
      return
    }

    if (frame.channel === 'mux' && type === 'session/queue' && sessionId === this._state.sessionId) {
      const snapshot = queueSnapshotOf(payload.items)
      this.queueRawText = snapshot.rawText
      this.publish({ queue: snapshot.items })
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
      if (payload.key === 'plan' && sessionId === this._state.sessionId) {
        this.publish({ plan: planModeStateOf(payload.value) })
      }
      if ((payload.key === 'tokenUsage'
        || payload.key === 'sessionStats'
        || payload.key === 'contextPressure'
        || payload.key === 'contextBreakdown')
        && sessionId === this._state.sessionId) {
        this.publish({ usage: usageMeterStateOf(summary?.projections?.values) })
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
      this.publish({ messages: this.projectedMessages(), running: false })
      return
    }

    if (frame.channel === 'host' && type === 'host/session-added' && payload.cwd === this.cwd) {
      void this.loadSessions(sessionId).catch(error => { this.report(error) })
    }
  }

  private projectedMessages(): ConversationMessage[] {
    const sessionId = this._state.sessionId
    return this.projector.messages().map(message => message.images === undefined
      ? message
      : {
          ...message,
          images: message.images.map(image => ({
            ...image,
            ...this.attachmentResults.get(`${sessionId}\u0000${image.attachmentId}`),
          })),
        })
  }

  private hydrateImages(client: DshClient, sessionId: string): void {
    const images = this.projector.messages().flatMap(message => message.images ?? [])
    for (const image of images) {
      const key = `${sessionId}\u0000${image.attachmentId}`
      if (this.attachmentResults.has(key) || this.attachmentLoads.has(key)) continue
      const load = client.attachment(sessionId, image.attachmentId)
        .then((result) => {
          if (result.attachment.attachmentId !== image.attachmentId || result.attachment.mediaType !== image.mediaType) {
            throw new Error('DeepSeek Harness returned mismatched image metadata.')
          }
          this.attachmentResults.set(key, { data: result.data })
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          this.output.appendLine(`[attachment] ${image.attachmentId}: ${detail}`)
          this.attachmentResults.set(key, { error: 'Image unavailable.' })
        })
        .finally(() => {
          this.attachmentLoads.delete(key)
          if (this.client === client && this._state.sessionId === sessionId) {
            this.publish({ messages: this.projectedMessages() })
          }
        })
      this.attachmentLoads.set(key, load)
    }
  }

  private dirtyConflict(event: DshEvent, view?: unknown): { callId: string; paths: string[] } | undefined {
    const callIds: string[] = []
    const documents = new Map<string, vscode.TextDocument>()
    for (const intent of toolWriteIntents(event, view)) {
      if (this.guardedDirtyCalls.has(intent.callId)) continue
      const conflicts = this.dirtyFiles.conflicts(this.cwd, intent.paths)
      if (conflicts.length === 0) continue
      this.guardedDirtyCalls.add(intent.callId)
      callIds.push(intent.callId)
      for (const document of conflicts) documents.set(document.uri.fsPath, document)
    }
    if (callIds.length === 0) return undefined
    const paths = [...documents.values()]
      .map(document => path.relative(this.cwd, document.uri.fsPath) || path.basename(document.uri.fsPath))
    return { callId: callIds[0] ?? String(event.seq), paths }
  }

  private async cancelForDirtyConflict(conflict: { paths: string[] }): Promise<void> {
    try {
      await this.cancel()
    } catch (error) {
      this.output.appendLine(`[dirty-files] Could not cancel cleanly: ${error instanceof Error ? error.message : String(error)}`)
    }
    const label = conflict.paths.length === 1
      ? conflict.paths[0] ?? 'A file'
      : `${String(conflict.paths.length)} files`
    await vscode.window.showWarningMessage(
      `DeepSeek stopped: ${label} has unsaved changes.`,
      {
        modal: true,
        detail: `${conflict.paths.join('\n')}\n\nSave or discard the changes in VS Code, then retry the task.`,
      },
    )
  }

  async openFile(filePath: string, line?: number): Promise<void> {
    await this.diffReviews.openFile(this.cwd, filePath, line)
  }

  async reviewFile(filePath: string, turn?: number): Promise<void> {
    if (this._state.sessionId === '') return
    await this.diffReviews.reviewFile(this._state.sessionId, this.cwd, filePath, turn)
  }

  async reviewAll(): Promise<void> {
    if (this._state.sessionId === '') return
    await this.diffReviews.reviewAll(this._state.sessionId)
  }

  keepFile(filePath: string, turn: number): void {
    if (this._state.sessionId === '') return
    this.publish({ changedFiles: this.diffReviews.keepFile(this._state.sessionId, this.cwd, filePath, turn) })
  }

  keepAll(): void {
    if (this._state.sessionId === '') return
    this.publish({ changedFiles: this.diffReviews.keepAll(this._state.sessionId) })
  }

  async revertFile(filePath: string, turn: number): Promise<void> {
    if (this._state.sessionId === '') return
    const confirmed = await vscode.window.showWarningMessage(
      `Revert DeepSeek changes to ${filePath}?`,
      { modal: true, detail: 'This restores the file to its content before this turn. The revert is blocked if the file has changed since.' },
      'Revert',
    )
    if (confirmed !== 'Revert') return
    try {
      this.publish({ changedFiles: this.diffReviews.revertFile(this._state.sessionId, this.cwd, filePath, turn) })
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer')
      await vscode.window.showInformationMessage(`Reverted ${filePath}.`)
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async revertAll(): Promise<void> {
    if (this._state.sessionId === '') return
    const count = this._state.changedFiles.reduce((total, group) => total + group.files.length, 0)
    if (count === 0) return
    const confirmed = await vscode.window.showWarningMessage(
      `Revert all ${String(count)} reviewed file changes?`,
      { modal: true, detail: 'Every file is checked first. If any file has changed since DeepSeek edited it, nothing is reverted.' },
      'Revert All',
    )
    if (confirmed !== 'Revert All') return
    try {
      this.publish({ changedFiles: this.diffReviews.revertAll(this._state.sessionId) })
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer')
      await vscode.window.showInformationMessage(`Reverted changes in ${String(count)} files.`)
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }
}

class DshSurface implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[]
  private readonly draftImages: Array<PromptImage & { id: string }> = []
  private ready = false
  private pendingPrompt: string | undefined
  private pendingState: ChatViewState | undefined
  private postedState: ChatViewState | undefined
  private stateTimer: NodeJS.Timeout | undefined
  private statePosts: Promise<void> = Promise.resolve()

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
      controller.onDidChangeState(state => { this.queueState(state) }),
      editorContext.onDidChange(state => { void webview.postMessage({ type: 'ide-context', state }) }),
      webview.onDidReceiveMessage(message => { this.acceptMessage(message) }),
    ]
  }

  focusPrompt(): void {
    void this.webview.postMessage({ type: 'focus-prompt' })
  }

  setPrompt(text: string): void {
    if (!this.ready) {
      this.pendingPrompt = text
      return
    }
    void this.webview.postMessage({ type: 'set-prompt', text })
  }

  dispose(): void {
    if (this.stateTimer !== undefined) clearTimeout(this.stateTimer)
    for (const disposable of this.disposables) disposable.dispose()
  }

  private queueState(state: ChatViewState): void {
    this.pendingState = state
    if (!this.ready || this.stateTimer !== undefined) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined
      const pending = this.pendingState
      this.pendingState = undefined
      if (pending === undefined) return
      this.statePosts = this.statePosts
        .then(() => this.postStateUpdate(pending))
        .catch(error => {
          this.output.appendLine(`[webview] Could not publish state: ${error instanceof Error ? error.message : String(error)}`)
        })
    }, 16)
  }

  private async postFullState(state: ChatViewState): Promise<void> {
    await this.webview.postMessage({ type: 'state', state: stateForWebview(state) })
    this.postedState = state
  }

  private async postStateUpdate(state: ChatViewState): Promise<void> {
    const previous = this.postedState
    if (previous === undefined || previous.sessionId !== state.sessionId) {
      await this.postFullState(state)
      return
    }
    const update = stateUpdate(previous, state)
    if (update !== undefined) await this.webview.postMessage({ type: 'state-update', update: stateUpdateForWebview(update) })
    this.postedState = state
  }

  private async resyncState(): Promise<void> {
    const snapshot = this.controller.state
    this.pendingState = undefined
    if (this.stateTimer !== undefined) {
      clearTimeout(this.stateTimer)
      this.stateTimer = undefined
    }
    this.statePosts = this.statePosts.then(() => this.postFullState(snapshot))
    await this.statePosts
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
        case 'webview-error':
          this.output.appendLine(`[webview] ${typeof value.message === 'string' ? value.message : 'Unknown error'}`)
          return
        case 'ready':
          this.ready = true
          await this.resyncState()
          await this.webview.postMessage({ type: 'ide-context', state: this.editorContext.viewState() })
          if (this.pendingPrompt !== undefined) {
            await this.webview.postMessage({ type: 'set-prompt', text: this.pendingPrompt })
            this.pendingPrompt = undefined
          }
          return
        case 'restart': await this.controller.restart(); return
        case 'output': this.output.show(true); return
        case 'new-session': await this.controller.newSession(); return
        case 'select-session':
          if (typeof value.sessionId === 'string') await this.controller.selectSession(value.sessionId)
          return
        case 'load-history': await this.controller.loadOlderHistory(); return
        case 'load-tool-output':
          if (typeof value.messageId === 'string' && typeof value.requestId === 'number') {
            const sessionId = this.controller.state.sessionId
            const requestedSessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
            const message = requestedSessionId === sessionId
              ? this.controller.state.messages.find(candidate => candidate.id === value.messageId)
              : undefined
            await this.webview.postMessage({
              type: 'tool-output',
              sessionId,
              messageId: value.messageId,
              requestId: value.requestId,
              ...(message === undefined
                ? { error: requestedSessionId === sessionId ? 'Tool output is no longer available.' : 'The conversation changed before this output loaded.' }
                : { page: pageConversationMessage(message, typeof value.cursor === 'string' ? value.cursor : undefined) }),
            })
          }
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
            const slash = this.controller.slashRoute(value.text)
            const carriesIdeContext = slash.kind === 'prompt'
            const ideContext = carriesIdeContext ? await this.editorContext.snapshotForPrompt(value.text) : undefined
            const mode: PromptMode = value.mode === 'steer' ? 'steer' : 'queue'
            await this.controller.send(value.text, this.draftImages, ideContext, mode)
            this.draftImages.length = 0
            if (carriesIdeContext) this.editorContext.clearPinned()
            await this.publishDraftImages()
          }
          return
        case 'select-permission':
          if (typeof value.permission === 'string'
            && this.controller.state.permissions.some(permission => permission.value === value.permission)) {
            if (requiresFullAccessConfirmation(value.permission)) {
              const confirmed = await vscode.window.showWarningMessage(
                'Enable Full access?',
                {
                  modal: true,
                  detail: 'Full access disables workspace confinement and approval prompts. Only use it when you trust the current task.',
                },
                'Enable Full Access',
              )
              if (confirmed !== 'Enable Full Access') {
                await this.resyncState()
                return
              }
            }
            await this.controller.send(`/permission ${value.permission}`)
          }
          return
        case 'select-mode':
          if ((value.mode === 'normal' || value.mode === 'plan') && this.controller.state.plan.available) {
            await this.controller.send(planModeCommand(value.mode))
          }
          return
        case 'select-agent-preset':
          if (typeof value.agentPreset === 'string') await this.controller.selectAgentPreset(value.agentPreset)
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
        case 'queue-action':
          if (
            typeof value.itemId === 'string'
            && (value.action === 'edit' || value.action === 'remove' || value.action === 'steer')
          ) {
            await this.controller.updateQueue(
              value.itemId,
              value.action,
              typeof value.text === 'string' ? value.text : undefined,
            )
          }
          return
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
        case 'open-file':
          if (typeof value.path === 'string') {
            await this.controller.openFile(
              value.path,
              typeof value.line === 'number' && Number.isInteger(value.line) ? value.line : undefined,
            )
          }
          return
        case 'review-file':
          if (typeof value.path === 'string') {
            await this.controller.reviewFile(
              value.path,
              typeof value.turn === 'number' && Number.isSafeInteger(value.turn) ? value.turn : undefined,
            )
          }
          return
        case 'review-all': await this.controller.reviewAll(); return
        case 'keep-file':
          if (typeof value.path === 'string' && typeof value.turn === 'number' && Number.isSafeInteger(value.turn)) {
            this.controller.keepFile(value.path, value.turn)
          }
          return
        case 'keep-all': this.controller.keepAll(); return
        case 'revert-file':
          if (typeof value.path === 'string' && typeof value.turn === 'number' && Number.isSafeInteger(value.turn)) {
            await this.controller.revertFile(value.path, value.turn)
          }
          return
        case 'revert-all': await this.controller.revertAll(); return
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
  private pendingPrompt: string | undefined

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
    if (this.pendingPrompt !== undefined) {
      surface.setPrompt(this.pendingPrompt)
      this.pendingPrompt = undefined
    }
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

  setPrompt(text: string): void {
    if (this.surface === undefined) {
      this.pendingPrompt = text
      return
    }
    this.surface.setPrompt(text)
  }
}

function problemPrompt(problem: IdeContextReference): string {
  return `Fix @{${problem.path}:${String(problem.startLine ?? 1)}:${String(problem.startCharacter ?? 1)}}`
}

function problemLocationFromArguments(args: readonly unknown[]): { filePath?: string; line?: number; message?: string } {
  let filePath: string | undefined
  let line: number | undefined
  let message: string | undefined
  const inspect = (value: unknown): void => {
    if (value instanceof vscode.Uri) {
      if (value.scheme === 'file') filePath ??= value.fsPath
      return
    }
    if (typeof value !== 'object' || value === null) return
    const item = value as Record<string, unknown>
    if (typeof item.message === 'string') message ??= item.message
    if (typeof item.startLineNumber === 'number') line ??= item.startLineNumber
    if (item.uri instanceof vscode.Uri) inspect(item.uri)
    if (item.resource instanceof vscode.Uri) inspect(item.resource)
    if (typeof item.range === 'object' && item.range !== null) {
      const range = item.range as Record<string, unknown>
      if (typeof range.start === 'object' && range.start !== null) {
        const start = range.start as Record<string, unknown>
        if (typeof start.line === 'number') line ??= start.line + 1
      }
    }
  }
  for (const arg of args) inspect(arg)
  return {
    ...(filePath === undefined ? {} : { filePath }),
    ...(line === undefined ? {} : { line }),
    ...(message === undefined ? {} : { message }),
  }
}

async function chooseProblem(editorContext: EditorContextBridge, args: readonly unknown[] = []): Promise<IdeContextReference | undefined> {
  const location = problemLocationFromArguments(args)
  const direct = location.filePath === undefined
    ? editorContext.problemAtActiveEditor()
    : editorContext.problemForLocation(location.filePath, location.line, location.message)
  if (direct !== undefined) return direct
  const problems = editorContext.problems()
  const items: Array<vscode.QuickPickItem & { problem: IdeContextReference }> = problems.map(problem => ({
    label: `$(error) ${problem.path}:${String(problem.startLine ?? 1)}`,
    description: problem.severity === 'warning' ? 'Warning' : 'Error',
    detail: problem.message ?? '',
    problem,
  }))
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Send a Problem to DeepSeek',
    placeHolder: problems.length === 0 ? 'No workspace errors or warnings' : 'Choose a diagnostic',
  })
  return picked?.problem
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
  const diffReviews = new DiffReviewManager()
  const controller = new DshChatController(runtime, output, new DirtyFileGuard(), diffReviews, cwd)
  const pluginManager = new DshPluginManager(context, controller, output)
  const editorContext = new EditorContextBridge(() => controller.cwd)
  const provider = new DshViewProvider(controller, output, editorContext, context.extensionUri)
  const panels = new Set<{ panel: vscode.WebviewPanel; surface: DshSurface }>()

  context.subscriptions.push(output, runtime, controller, diffReviews, editorContext, provider)
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('dsh-diff', diffReviews))
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
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.managePlugins', async () => {
    await pluginManager.show().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[plugins] ${message}`)
      void vscode.window.showErrorMessage(message, 'Show Output').then(choice => {
        if (choice === 'Show Output') output.show(true)
      })
    })
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.addSelection', async () => {
    if (!editorContext.pinSelection()) {
      void vscode.window.showInformationMessage('Select code in the current DeepSeek project first.')
      return
    }
    await vscode.commands.executeCommand('workbench.view.extension.deepseekHarness')
    provider.focusPrompt()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.fixWithDeepSeek', async () => {
    const problem = editorContext.problemAtActiveEditor()
    let prompt: string
    if (problem !== undefined) {
      prompt = problemPrompt(problem)
    } else if (editorContext.pinSelection()) {
      prompt = 'Fix the selected code.'
    } else {
      const activeFile = editorContext.viewState().activeFile
      if (activeFile === undefined) {
        void vscode.window.showInformationMessage('Open a file in the current DeepSeek project first.')
        return
      }
      const mention = activeFile.path.includes(' ') ? `@{${activeFile.path}}` : `@${activeFile.path}`
      prompt = `Fix the issue in ${mention}.`
    }
    await vscode.commands.executeCommand('workbench.view.extension.deepseekHarness')
    provider.setPrompt(prompt)
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.sendProblem', async (...args: unknown[]) => {
    const problem = await chooseProblem(editorContext, args)
    if (problem === undefined) return
    await vscode.commands.executeCommand('workbench.view.extension.deepseekHarness')
    provider.setPrompt(problemPrompt(problem))
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
    if (controller.runtimeOwnership === undefined) await controller.start()
    if (controller.runtimeOwnership === 'external') {
      void vscode.window.showInformationMessage(
        'This sidebar is using an external DeepSeek Harness runtime. Configure its API key where that process is started.',
      )
      return
    }
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
    if (controller.runtimeOwnership === 'external') {
      void vscode.window.showInformationMessage(
        'Stored DeepSeek API key removed. The reused external DSH keeps its own credentials.',
      )
      return
    }
    await controller.restart()
    void vscode.window.showInformationMessage('Stored DeepSeek API key removed. DeepSeek Harness restarted.')
  }))
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = undefined
  await runtime?.stop()
}
