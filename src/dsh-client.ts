import { randomUUID } from 'node:crypto'
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

interface RpcEnvelope<T> {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: { message?: string; code?: string } }
}

/**
 * DSH 0.1.2-rc.1 wire contract (verified against a live runtime):
 * - Every `/api` request must present the browser-session cookie minted by
 *   GET /?token=… (HTTP 401 otherwise).
 * - Unary RPC bodies keep the client-request envelope but the method lives in
 *   a slash-separated URL path (`/api/session/list`, not `/api/session.list`)
 *   and the call parameters ride under `payload.args`.
 * - Live state arrives over the `/api/remote.mux` WebSocket: the client opens
 *   logical streams (`$events`, `workspace/follow`, `session/control`,
 *   `session/follow`) and receives `{type:'item'|'end'|'error', streamId,
 *   value}` messages.
 * The legacy dotted `client-request` surface (`/api/session.list`,
 * `/api/events.mux`/`/api/events.host`, `/api/respond`) no longer exists.
 */
export class DshClient {
  private readonly streamAbort = new AbortController()
  private readonly frameListeners = new Set<(frame: DshFrame) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private socket: WebSocket | undefined
  private nextStreamId = 0
  private streamEndpoints = new Map<string, string>()
  private cookie: string | undefined
  private authReady: Promise<void> | undefined
  private sessionSummaries = new Map<string, SessionSummary>()
  private archivedSessionIds: string[] = []

  constructor(private readonly baseUrl: URL) {}

  onFrame(listener: (frame: DshFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => { this.frameListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  private emitFrame(channel: DshFrame['channel'], payload: Record<string, unknown>): void {
    for (const listener of this.frameListeners) listener({ channel, rpcId: randomUUID(), payload })
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authReady === undefined) {
      this.authReady = this.obtainCookie().catch(error => {
        this.authReady = undefined
        throw error
      })
    }
    await this.authReady
  }

  /**
   * Exchange the process launch token carried on the startup URL for the
   * browser-session cookie that every `/api` call and stream must present.
   * Runtimes without browser-session auth simply have no token.
   */
  private async obtainCookie(): Promise<void> {
    const token = this.baseUrl.searchParams.get('token')
    if (token === null || token === '') return
    const response = await fetch(this.baseUrl, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    })
    const raw = response.headers.get('set-cookie')
    if (raw === null || raw === '') return
    const value = raw.split(';', 1)[0]
    if (value !== '') this.cookie = value
  }

  private requestHeaders(): Record<string, string> {
    return this.cookie === undefined ? {} : { cookie: this.cookie }
  }

  private async rpc<T>(endpoint: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    await this.ensureAuthenticated()
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.requestHeaders() },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`DSH transport failed: HTTP ${String(response.status)}`)
    const envelope = await response.json() as RpcEnvelope<T>
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error(`Invalid DSH response for ${endpoint}.`)
    }
    if (!envelope.result.ok) {
      throw new Error(envelope.result.error.message ?? envelope.result.error.code ?? `${endpoint} failed`)
    }
    return envelope.result.value
  }

  private recordSummaries(items: SessionSummary[]): SessionSummary[] {
    for (const item of items) this.sessionSummaries.set(item.sessionId, item)
    return items
  }

  private sessionAgentPreset(summary: SessionSummary | undefined): string | undefined {
    if (summary === undefined) return undefined
    const values = summary.projections?.values
    const preset = typeof values === 'object' && values !== null && values.agentPreset
    return typeof preset === 'string' ? preset : undefined
  }

  /** One complete page (or job) of session summaries plus archive state. */
  startStreams(): void {
    void this.connectStreams()
  }

  /**
   * Open the rc.1 Remote mux and translate host-level streams into the frame
   * vocabulary the sidebar already consumes. Session-scoped conversation,
   * jobs, queue, approval and question frames still require the rc.1
   * session/follow + control + Remote-event answering port (phase 2), so this
   * layer only subscribes what it can faithfully translate today.
   */
  private async connectStreams(): Promise<void> {
    if (this.streamAbort.signal.aborted || this.socket !== undefined) return
    try {
      await this.ensureAuthenticated()
      const url = new URL('/api/remote.mux', this.baseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const WebSocketCtor = WebSocket as unknown as new (
        url: string | URL,
        options?: { headers?: Record<string, string> },
      ) => WebSocket
      const socket = new WebSocketCtor(url, { headers: this.requestHeaders() })
      this.socket = socket
      this.streamEndpoints.clear()
      const cleanup = (): void => {
        this.streamAbort.signal.removeEventListener('abort', abort)
        if (this.socket === socket) this.socket = undefined
      }
      const abort = (): void => {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      }
      this.streamAbort.signal.addEventListener('abort', abort, { once: true })

      socket.addEventListener('open', () => {
        // Logical streams opened once and kept open for the runtime lifetime.
        this.openStream(socket, '$events')
        this.openStream(socket, 'workspace/follow')
      }, { once: true })
      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string') throw new Error('DSH sent a binary WebSocket frame.')
          const message: unknown = JSON.parse(event.data)
          this.acceptStreamMessage(socket, message)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          for (const listener of this.errorListeners) listener(normalized)
        }
      })
      socket.addEventListener('error', () => {
        if (this.streamAbort.signal.aborted) return
        const error = new Error('DSH event stream failed.')
        for (const listener of this.errorListeners) listener(error)
      })
      socket.addEventListener('close', () => {
        cleanup()
        if (this.streamAbort.signal.aborted) return
        const error = new Error('DSH event stream closed.')
        for (const listener of this.errorListeners) listener(error)
      }, { once: true })
      if (this.streamAbort.signal.aborted) abort()
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      for (const listener of this.errorListeners) listener(normalized)
    }
  }

  private openStream(socket: WebSocket, endpoint: string): void {
    const streamId = `dsh-sidebar-${String(this.nextStreamId++)}`
    this.streamEndpoints.set(streamId, endpoint)
    socket.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint,
      payload: { args: {} },
    }))
  }

  private acceptStreamMessage(_socket: WebSocket, message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const record = message as Record<string, unknown>
    if (record.type !== 'item' || typeof record.streamId !== 'string') return
    const endpoint = this.streamEndpoints.get(record.streamId)
    if (endpoint === undefined) return
    const value = record.value
    if (typeof value !== 'object' || value === null) return
    const item = value as Record<string, unknown>
    if (endpoint === '$events') {
      this.acceptHostEventItem(item)
      return
    }
    if (endpoint === 'workspace/follow') {
      this.acceptWorkspaceItem(item)
    }
    // session/control and session/follow translation arrives with phase 2.
  }

  private acceptWorkspaceItem(item: Record<string, unknown>): void {
    if (item.type === 'baseline') {
      const value = item.value
      const archived = typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).archivedSessionIds
        : undefined
      this.applyArchived(Array.isArray(archived) ? archived.filter((id): id is string => typeof id === 'string') : [])
      return
    }
    if (item.type === 'archived') {
      const archived = Array.isArray(item.archivedSessionIds)
        ? item.archivedSessionIds.filter((id): id is string => typeof id === 'string')
        : []
      this.applyArchived(archived)
    }
  }

  private applyArchived(archivedSessionIds: string[]): void {
    this.archivedSessionIds = archivedSessionIds
    this.emitFrame('host', {
      type: 'host/archived-sessions-changed',
      archivedSessionIds,
    })
  }

  private acceptHostEventItem(item: Record<string, unknown>): void {
    if (item.type !== 'emit' || typeof item.event !== 'string' || !Array.isArray(item.args)) return
    const event = item.event
    const args = item.args
    if (event === 'api-session/added') {
      const summary = args[0]
      if (typeof summary === 'object' && summary !== null) {
        const record = summary as Record<string, unknown>
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
        if (sessionId !== '') {
          this.sessionSummaries.set(sessionId, record as unknown as SessionSummary)
          this.emitFrame('host', { ...record, type: 'host/session-added' })
        }
      }
      return
    }
    if (event === 'api-session/removed') {
      const sessionId = typeof args[0] === 'string' ? args[0] : ''
      if (sessionId !== '') this.sessionSummaries.delete(sessionId)
      return
    }
    if (event === 'api-session/status') {
      const sessionId = typeof args[0] === 'string' ? args[0] : ''
      const running = args[1] === true
      if (sessionId !== '') {
        const summary = this.sessionSummaries.get(sessionId)
        if (summary !== undefined) summary.running = running
        this.emitFrame('host', { type: 'host/session-status', sessionId, running })
      }
      return
    }
    if (event === 'api-session/error') {
      const sessionId = typeof args[0] === 'string' ? args[0] : ''
      const message = typeof args[1] === 'string' ? args[1] : undefined
      if (sessionId !== '') {
        this.emitFrame('host', {
          type: 'host/agent-error',
          sessionId,
          ...(message === undefined ? {} : { message }),
        })
      }
    }
  }

  async listSessions(): Promise<{ items: SessionSummary[] }> {
    const result = await this.rpc<{ items: SessionSummary[] }>('session/list', { _request: {} })
    const items: SessionSummary[] = result.items.map(item => {
      const agentPreset = this.sessionAgentPreset(item) ?? item.agentPreset
      return agentPreset === undefined
        ? { ...item }
        : { ...item, agentPreset }
    })
    return { items: this.recordSummaries(items) }
  }

  async listWorkspaces(): Promise<{ archivedSessionIds?: string[] }> {
    // rc.1 exposes archive state reactively through the workspace/follow
    // stream (baseline + archived frames); no unary workspace listing exists.
    return { archivedSessionIds: [...this.archivedSessionIds] }
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> {
    return this.rpc('session/rename', { request: { sessionId, title } })
  }

  async archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    const result = await this.rpc<{ archivedSessionIds: string[] }>('workspace/archiveSession', {
      request: { sessionId },
    })
    this.applyArchived(result.archivedSessionIds)
    return result
  }

  createSession(cwd: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.rpc('session/create', { request: { cwd } })
  }

  /**
   * Read one message-aligned history page. rc.1 pages backward from a
   * committed cursor (`throughSeq`), which the sidebar learns from the session
   * summary projection (`asOfSeq`); older pages narrow through `beforeSeq`.
   */
  async history(sessionId: string, beforeSeq?: number, maxMessages = 100): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    let cursor: number | undefined
    if (beforeSeq !== undefined) {
      cursor = beforeSeq - 1
    } else {
      const summary = this.sessionSummaries.get(sessionId) ?? (await this.listSessions()).items.find(item => item.sessionId === sessionId)
      const asOfSeq = summary?.projections?.asOfSeq
      if (typeof asOfSeq === 'number' && Number.isSafeInteger(asOfSeq) && asOfSeq > 0) cursor = asOfSeq - 1
    }
    const result = await this.rpc<{
      records: Array<{ type: string; event?: unknown }>
      hasMore: boolean
    }>('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        ...(cursor === undefined ? {} : { throughSeq: cursor }),
        maxMessages,
      },
    })
    const events: HistoryEntry[] = []
    for (const record of result.records) {
      const event = record.event
      if (typeof event === 'object' && event !== null) events.push({ event: event as DshEvent })
    }
    return { events, hasMore: result.hasMore }
  }

  async models(sessionId: string): Promise<SessionModels> {
    const catalog = await this.rpc<{
      default?: ModelSelection
      routableProviders?: string[]
      groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: unknown }> }>
      failures?: Array<{ id: string; name: string; message: string }>
    }>('session/modelCatalog', {})
    const summary = this.sessionSummaries.get(sessionId)
    const values = summary?.projections?.values
    const selection = typeof values === 'object' && values !== null ? values.modelSelection : undefined
    const next = typeof selection === 'object' && selection !== null
      ? (selection as Record<string, unknown>).next
      : undefined
    const current: ModelSelection = typeof next === 'object' && next !== null
      ? {
          provider: typeof (next as Record<string, unknown>).provider === 'string' ? String((next as Record<string, unknown>).provider) : catalog.default?.provider ?? '',
          model: typeof (next as Record<string, unknown>).model === 'string' ? String((next as Record<string, unknown>).model) : catalog.default?.model ?? '',
          ...(typeof (next as Record<string, unknown>).reasoningEffort === 'string'
            ? { reasoningEffort: String((next as Record<string, unknown>).reasoningEffort) }
            : {}),
        }
      : { provider: catalog.default?.provider ?? '', model: catalog.default?.model ?? '', ...(catalog.default?.reasoningEffort === undefined ? {} : { reasoningEffort: catalog.default.reasoningEffort }) }
    const groups: SessionModels['groups'] = (catalog.groups ?? []).map(group => ({
      ...group,
      models: group.models.map(model => {
        const reasoning = model.reasoning as SessionModels['groups'][number]['models'][number]['reasoning'] | undefined
        return reasoning === undefined
          ? { id: model.id, name: model.name }
          : { id: model.id, name: model.name, reasoning }
      }),
    }))
    return {
      current,
      routable: summary !== undefined,
      groups,
      failures: catalog.failures ?? [],
    }
  }

  async attachment(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; data: string }> {
    return this.rpc('session/attachment', { request: { sessionId, attachmentId } })
  }

  pluginInventory(): Promise<PluginInventorySnapshot> {
    return this.rpc('pluginInventory/list', {})
  }

  settings(): Promise<SettingsDescription> {
    return this.rpc('settings/describe', {})
  }

  mutateSettings(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<SettingsNamespace> {
    return this.rpc('settings/mutate', { ns, ops, expectedRevision })
  }

  async prompt(
    sessionId: string,
    text: string,
    images: readonly PromptImage[] = [],
    mode: PromptMode = 'queue',
  ): Promise<{ accepted: true }> {
    const content: Array<{ type: 'text'; text: string } | PromptImage> = images.map(image => ({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
    }))
    if (text !== '') content.push({ type: 'text', text })
    return this.rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  }

  respond(_rpcId: string, _value: unknown): Promise<RpcReceipt> {
    // rc.1 answers approvals and questions as Remote events (clientId +
    // eventId + outcome via the $events/result unary). The sidebar cannot
    // receive those requests until the session-scoped stream port lands, so
    // answering stays deliberately unavailable.
    return Promise.reject(new Error('DSH 0.1.2-rc.1 event answering is not wired yet.'))
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.rpc('session/cancel', { request: { sessionId } })
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.rpc('session/updateQueue', { request: { sessionId, itemId, action } })
  }

  selectModel(sessionId: string, selection: ModelSelection): Promise<{ selected: ModelSelection }> {
    return this.rpc('session/selectModel', {
      request: { sessionId, ...selection },
    })
  }

  listCommands(sessionId: string): Promise<CommandDescriptor[]> {
    return this.rpc('commands/list', { agentId: sessionId }, 10_000)
  }

  async listSkills(sessionId: string): Promise<SkillDescriptor[]> {
    const result = await this.rpc<{ skills: SkillDescriptor[] }>('skills/list', { request: { sessionId } }, 10_000)
    return result.skills
  }

  async listAgentPresets(): Promise<AgentPresetRoster> {
    const result = await this.rpc<{ presets: AgentPresetDescriptor[]; authorable: boolean; hasDocument?: boolean }>(
      'agentPresets/list',
      {},
      10_000,
    )
    return { ...result, hasDocument: result.hasDocument === true }
  }

  selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    return this.rpc('agentPresets/select', { agentId: sessionId, agentPreset }, 30_000)
  }

  executeCommand(
    sessionId: string,
    line: string,
    images?: readonly PromptImage[],
  ): Promise<CommandExecution | undefined> {
    return this.rpc('commands/execute', {
      agentId: sessionId,
      line,
      images: (images ?? []).map(image => ({
        mediaType: image.mediaType,
        data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      })),
    }, 300_000)
  }

  dispose(): void {
    this.streamAbort.abort()
    this.frameListeners.clear()
    this.errorListeners.clear()
  }
}
