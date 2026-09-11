import type { DshConnection } from './dsh-connection.js'
import { DshRemoteApi } from './dsh-remote-api.js'
import { DshSessionFeed, type SessionOpening } from './dsh-session-feed.js'
import { wireRecord } from './dsh-streams.js'
import type { DshEvent } from './conversation.js'
import type { PluginInventorySnapshot } from './plugin-profile.js'
import type { SettingsDescription, SettingsMutation, SettingsNamespace } from './runtime-settings.js'

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
  input?: { hint: string; images?: boolean }
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
  private readonly api: DshRemoteApi
  private readonly feed: DshSessionFeed
  private readonly lifetime = new AbortController()
  private readonly frameListeners = new Set<(frame: DshFrame) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private catalog: ModelCatalog | undefined

  constructor(private readonly connection: DshConnection) {
    this.api = new DshRemoteApi(connection, this.lifetime.signal)
    this.feed = new DshSessionFeed(connection,
      frame => { for (const listener of this.frameListeners) listener(frame) },
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
  startStreams(): Promise<void> { return this.feed.start() }
  openSession(sessionId: string): Promise<SessionOpening> { return this.feed.open(sessionId) }
  async listSessions(): Promise<{ items: SessionSummary[] }> {
    const result = await this.api.listSessions()
    return { items: result.items.map(summary => this.feed.summary(summary)) }
  }
  listWorkspaces(): Promise<{ archivedSessionIds: string[] }> { return this.feed.listWorkspaces() }
  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> { return this.api.renameSession(sessionId, title) }
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call('workspace/archiveSession', { request: { sessionId } })
  }
  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> { return this.api.createSession(cwd) }
  history(sessionId: string, beforeSeq: number): Promise<{ events: HistoryEntry[]; hasMore: boolean }> { return this.feed.page(sessionId, beforeSeq) }

  async models(sessionId: string): Promise<SessionModels> {
    this.catalog = await this.call<ModelCatalog>('session/modelCatalog', {})
    return this.currentModels(sessionId) as SessionModels
  }
  currentModels(sessionId: string): SessionModels | undefined {
    const catalog = this.catalog
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
    return this.api.prompt(sessionId, text, images, mode)
  }
  respond(rpcId: string, value: unknown): Promise<RpcReceipt> { return this.feed.respond(rpcId, value) }
  cancel(sessionId: string): Promise<{ accepted: true }> { return this.api.cancel(sessionId) }
  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> { return this.api.updateQueue(sessionId, itemId, action) }
  selectModel(sessionId: string, selection: ModelSelection): Promise<{ selected: ModelSelection }> {
    return this.call('session/selectModel', { request: { sessionId, ...selection } })
  }
  listCommands(sessionId: string): Promise<CommandDescriptor[]> { return this.call('commands/list', { agentId: sessionId }, 10_000) }
  async listSkills(sessionId: string): Promise<SkillDescriptor[]> {
    return (await this.call<{ skills: SkillDescriptor[] }>('skills/list', { request: { sessionId } }, 10_000)).skills
  }
  listAgentPresets(): Promise<AgentPresetRoster> { return this.call('agentPresets/list', {}, 10_000) }
  async selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    return { agentPreset: await this.call<string>('agentPresets/select', { agentId: sessionId, agentPreset }) }
  }
  executeCommand(sessionId: string, line: string, images: readonly PromptImage[] = []): Promise<CommandExecution | undefined> {
    return this.call('commands/execute', {
      agentId: sessionId, line, images: images.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name === undefined ? {} : { name }) })),
    }, 300_000)
  }
  dispose(): void {
    this.lifetime.abort()
    this.feed.dispose()
    this.frameListeners.clear()
    this.errorListeners.clear()
  }
  private call<T>(endpoint: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    return this.connection.call(endpoint, args, timeoutMs, this.lifetime.signal)
  }
}
