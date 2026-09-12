import type { DshConnection } from './dsh-connection.js'
import { DshRemoteApi } from './dsh-remote-api.js'
import { DshSessionFeed, type SessionOpening } from './dsh-session-feed.js'
import { wireRecord } from './dsh-streams.js'
import type { DshEvent } from './conversation.js'
import type { PluginInventorySnapshot } from './plugin-profile.js'
import type { SettingsDescription, SettingsMutation, SettingsNamespace } from './runtime-settings.js'
import { RemoteRead } from './remote-read.js'
import { DshCommandTransport } from './dsh-command-transport.js'

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: 'subagent'
  agentPreset?: string
  projections?: { asOfSeq?: number; values?: Record<string, unknown> }
}

export interface HistoryEntry {
  event: DshEvent
  view?: unknown
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface CommandDescriptor {
  name: string
  description: string
  input?: { hint: string; images?: boolean; attachments?: boolean }
}

export interface CommandExecution {
  commandId: string
  result: {
    kind: 'success' | 'error'
    text?: string
    sourceEventSeq?: number
  }
}

export interface SkillDescriptor {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

export interface AgentPresetDescriptor {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface AgentPresetRoster {
  presets: AgentPresetDescriptor[]
  authorable: boolean
  hasDocument: boolean
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface PromptImage {
  type: 'image'
  mediaType: ImageMediaType
  data: string
  name?: string
}

export interface ImageAttachment {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

export type PromptMode = 'queue' | 'steer'

export type QueueAction =
  | { kind: 'edit'; content: Array<{ type: 'text'; text: string }> }
  | { kind: 'remove' }
  | { kind: 'steer' }

export interface RpcReceipt {
  accepted: boolean
  reason?: 'not-pending' | 'bad-response'
}

export interface ModelOption extends ModelSelection {
  label: string
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
    }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
}

export type DshFrame =
  | { channel: 'mux'; rpcId: string; payload: Record<string, unknown> }
  | { channel: 'host'; rpcId: string; payload: Record<string, unknown> }

interface ModelCatalog {
  default: ModelSelection
  routableProviders: string[]
  groups: SessionModels['groups']
  failures: SessionModels['failures']
}

/** The sidebar uses only authenticated 0.1.2 Remotes. */
export class DshClient {
  private readonly commandTransport = new DshCommandTransport((endpoint, args, timeoutMs) => this.call(endpoint, args, timeoutMs))
  private readonly api: DshRemoteApi
  private readonly feed: DshSessionFeed
  private readonly lifetime = new AbortController()
  private readonly frameListeners = new Set<(frame: DshFrame) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly catalog: RemoteRead<ModelCatalog>
  private readonly commands = new Map<string, RemoteRead<CommandDescriptor[]>>()
  private readonly skills = new Map<string, RemoteRead<SkillDescriptor[]>>()
  private readonly presets: RemoteRead<AgentPresetRoster>

  constructor(private readonly connection: DshConnection) {
    this.api = new DshRemoteApi(connection, this.lifetime.signal)
    this.catalog = new RemoteRead(() => this.call('session/modelCatalog', {}), this.lifetime.signal)
    this.presets = new RemoteRead(() => this.call('agentPresets/list', {}, 10_000), this.lifetime.signal)
    this.feed = new DshSessionFeed(connection,
      frame => {
        this.invalidateDiscovery(frame)
        for (const listener of this.frameListeners) listener(frame)
      },
      error => { for (const listener of this.errorListeners) listener(error) })
  }

  onFrame(listener: (frame: DshFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => { this.frameListeners.delete(listener) }
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }
  async startStreams(): Promise<void> {
    await this.feed.start()
    // Reads made before the event subscription may have missed a Host commit.
    this.catalog.invalidate()
    this.presets.invalidate()
    for (const read of [...this.commands.values(), ...this.skills.values()]) read.invalidate()
  }
  openSession(sessionId: string): Promise<SessionOpening> {
    this.presets.invalidate()
    this.invalidateSessionDiscovery(sessionId)
    return this.feed.open(sessionId)
  }
  async listSessions(): Promise<{ items: SessionSummary[] }> {
    const revision = this.feed.listRevision
    const result = await this.api.listSessions()
    return { items: this.feed.summaries(result.items, revision) }
  }
  listWorkspaces(): Promise<{ archivedSessionIds: string[] }> { return this.feed.listWorkspaces() }
  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> { return this.api.renameSession(sessionId, title) }
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call('workspace/archiveSession', { request: { sessionId } })
  }
  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> { return this.api.createSession(cwd) }
  history(sessionId: string, beforeSeq: number): Promise<{ events: HistoryEntry[]; hasMore: boolean }> { return this.feed.page(sessionId, beforeSeq) }

  async models(sessionId: string): Promise<SessionModels> {
    await this.catalog.read()
    return this.currentModels(sessionId) as SessionModels
  }
  currentModels(sessionId: string): SessionModels | undefined {
    const catalog = this.catalog.current
    if (catalog === undefined) return undefined
    const projection = this.feed.projectionValues(sessionId).modelSelection
    const candidate = wireRecord(projection) ? projection.next ?? projection.lastUsed : undefined
    const current: ModelSelection = wireRecord(candidate) && typeof candidate.provider === 'string' && typeof candidate.model === 'string'
      ? { provider: candidate.provider, model: candidate.model, ...(typeof candidate.reasoningEffort === 'string' ? { reasoningEffort: candidate.reasoningEffort } : {}) }
      : catalog.default
    return { current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures }
  }

  attachment(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; data: string }> {
    return this.call('session/attachment', { request: { sessionId, attachmentId } })
  }
  pluginInventory(): Promise<PluginInventorySnapshot> { return this.call('pluginInventory/list', {}) }
  settings(): Promise<SettingsDescription> { return this.call('settings/describe', {}) }
  mutateSettings(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<SettingsNamespace> {
    return this.call('settings/mutate', { ns, ops, expectedRevision })
  }
  prompt(sessionId: string, text: string, images: readonly PromptImage[] = [], mode: PromptMode = 'queue'): Promise<{ accepted: true }> {
    this.feed.handleRequestsFor(sessionId)
    return this.api.prompt(sessionId, text, images, mode)
  }
  respond(rpcId: string, value: unknown): Promise<RpcReceipt> { return this.feed.respond(rpcId, value) }
  cancel(sessionId: string): Promise<{ accepted: true }> { return this.api.cancel(sessionId) }
  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> { return this.api.updateQueue(sessionId, itemId, action) }
  selectModel(sessionId: string, selection: ModelSelection): Promise<{ selected: ModelSelection }> {
    return this.call('session/selectModel', { request: { sessionId, ...selection } })
  }
  listCommands(sessionId: string): Promise<CommandDescriptor[]> {
    let read = this.commands.get(sessionId)
    if (read === undefined) {
      read = new RemoteRead(() => this.call('commands/list', { agentId: sessionId }, 10_000), this.lifetime.signal)
      this.commands.set(sessionId, read)
    }
    return read.read()
  }
  listSkills(sessionId: string): Promise<SkillDescriptor[]> {
    let read = this.skills.get(sessionId)
    if (read === undefined) {
      read = new RemoteRead(async () => (await this.call<{ skills: SkillDescriptor[] }>(
        'skills/list', { request: { sessionId } }, 10_000)).skills, this.lifetime.signal)
      this.skills.set(sessionId, read)
    }
    return read.read()
  }
  listAgentPresets(): Promise<AgentPresetRoster> { return this.presets.read() }
  async selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    const selected = await this.call<string>('agentPresets/select', { agentId: sessionId, agentPreset })
    this.invalidateSessionDiscovery(sessionId)
    return { agentPreset: selected }
  }
  executeCommand(sessionId: string, line: string, images: readonly PromptImage[] = []): Promise<CommandExecution | undefined> {
    this.feed.handleRequestsFor(sessionId)
    return this.commandTransport.execute(sessionId, line, images)
  }
  dispose(): void {
    this.lifetime.abort()
    this.feed.dispose()
    this.frameListeners.clear()
    this.errorListeners.clear()
    this.commands.clear()
    this.skills.clear()
  }
  private invalidateSessionDiscovery(sessionId: string): void {
    this.commands.get(sessionId)?.invalidate()
    this.skills.get(sessionId)?.invalidate()
  }
  private invalidateDiscovery(frame: DshFrame): void {
    const payload = frame.payload
    if (payload.type === 'host/commands-changed') for (const read of this.commands.values()) read.invalidate()
    if (payload.type === 'host/models-changed' || payload.type === 'host/settings-changed' || payload.type === 'host/credentials-changed') this.catalog.invalidate()
    if (payload.type === 'host/settings-changed' && payload.ns === 'agent-presets') this.presets.invalidate()
    if ((payload.type === 'host/session-composition-changed'
      || (payload.type === 'session/projection' && payload.key === 'agentPreset')) && typeof payload.sessionId === 'string') {
      this.invalidateSessionDiscovery(payload.sessionId)
    }
  }
  private call<T>(endpoint: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    return this.connection.call(endpoint, args, timeoutMs, this.lifetime.signal)
  }
}
