import type { DshConnection } from './dsh-connection.js'
import type { DshFrame, HistoryEntry, RpcReceipt, SessionSummary } from './dsh-client.js'
import { decodeHistory } from './dsh-history.js'
import { DshStreams, wireRecord } from './dsh-streams.js'
import { DshAssistantStream } from './dsh-assistant-stream.js'

interface Projection { seq: number; value: unknown }
interface PendingQuestion { sessionId: string; event: string; request: Record<string, unknown> }
interface Follow {
  sessionId: string
  cursor: number
  lastSeq: number
  active: boolean
  pending: DshFrame[]
  committedMessages: Set<string>
  cancel: () => void
  reject: (error: Error) => void
}
export interface SessionOpening {
  events: HistoryEntry[]
  hasMore: boolean
  projections: Record<string, unknown>
  /** Install the snapshot in the UI before releasing events buffered behind it. */
  activate: () => void
  isCurrent: () => boolean
}

/** Adapts the 0.1.2 streams to the sidebar's internal (not wire) event vocabulary. */
export class DshSessionFeed {
  private readonly streams: DshStreams
  private startup: Promise<void> | undefined
  private clientId: string | undefined
  private follow: Follow | undefined
  private archived: string[] = []
  private readonly projections = new Map<string, Map<string, Projection>>()
  private readonly projectionFloors = new Map<string, number>()
  private readonly queues = new Map<string, unknown[]>()
  private readonly jobs = new Map<string, unknown[]>()
  private readonly running = new Map<string, boolean>()
  private readonly questions = new Map<string, PendingQuestion>()
  private readonly displayedQuestions = new Map<string, string>()
  private readonly requestSessions = new Set<string>()
  private readonly addedSessions = new Map<string, { revision: number; summary: SessionSummary }>()
  private addedRevision = 0
  private readonly activity = new Map<string, number>()
  private readonly nonBlankSessions = new Set<string>()

  constructor(private readonly connection: DshConnection, private readonly emit: (frame: DshFrame) => void,
    private readonly error: (error: Error) => void) {
    this.streams = new DshStreams(connection, failure => {
      this.closeFollow(failure)
      for (const id of this.questions.keys()) this.dismissQuestion(id)
      this.error(failure)
    })
  }

  start(): Promise<void> {
    this.startup ??= Promise.all([
      this.baseline('$events', frame => {
        if (frame.type === 'ready') {
          if (typeof frame.clientId !== 'string') throw new Error('Invalid event identity.')
          this.clientId = frame.clientId
          return true
        }
        this.remoteEvent(frame)
        return false
      }),
      this.baseline('session/control', frame => { this.control(frame); return frame.type === 'baseline' }),
      this.baseline('workspace/follow', frame => {
        const value = frame.type === 'baseline' ? frame.value : frame
        if ((frame.type === 'baseline' || frame.type === 'archived') && wireRecord(value)) {
          if (!Array.isArray(value.archivedSessionIds) || !value.archivedSessionIds.every(id => typeof id === 'string')) {
            throw new Error('Invalid workspace baseline.')
          }
          this.archived = value.archivedSessionIds
          if (frame.type !== 'baseline') this.host({ type: 'host/archived-sessions-changed', archivedSessionIds: this.archived })
        }
        return frame.type === 'baseline'
      }),
    ]).then(() => undefined)
    return this.startup
  }

  async listWorkspaces(): Promise<{ archivedSessionIds: string[] }> {
    await this.start()
    return { archivedSessionIds: [...this.archived] }
  }

  /** Register before dispatch: a task can ask for approval before its RPC returns. */
  handleRequestsFor(sessionId: string): void { this.requestSessions.add(sessionId) }

  get handledSessionIds(): string[] {
    return [...new Set([...this.requestSessions, ...(this.follow === undefined ? [] : [this.follow.sessionId])])]
  }

  get listRevision(): number { return this.addedRevision }

  summaries(items: SessionSummary[], sinceRevision: number): SessionSummary[] {
    const summaries = new Map(items.map(summary => [summary.sessionId, summary]))
    // Do not lose a new conversation when its notification races session/list.
    for (const [id, added] of this.addedSessions) {
      if (added.revision > sinceRevision && !summaries.has(id)) summaries.set(id, added.summary)
    }
    return [...summaries.values()].map(summary => this.summary(summary))
  }

  private summary(summary: SessionSummary): SessionSummary {
    const values = { ...summary.projections?.values }
    const watermark = summary.projections?.asOfSeq ?? -1
    for (const [key, projection] of this.projections.get(summary.sessionId) ?? []) {
      if (projection.seq >= watermark) values[key] = projection.value
    }
    const activity = this.activity.get(summary.sessionId)
    if (!summary.blank || summary.running) this.nonBlankSessions.add(summary.sessionId)
    return { ...summary, updatedAt: Math.max(summary.updatedAt, activity ?? 0),
      blank: !this.nonBlankSessions.has(summary.sessionId),
      running: this.running.get(summary.sessionId) ?? summary.running,
      projections: { values }, ...(typeof values.agentPreset === 'string' ? { agentPreset: values.agentPreset } : {}) }
  }

  projectionValues(sessionId: string): Record<string, unknown> {
    return Object.fromEntries([...this.projections.get(sessionId) ?? []].map(([key, projection]) => [key, projection.value]))
  }

  open(sessionId: string): Promise<SessionOpening> {
    this.closeFollow()
    return new Promise((resolve, reject) => {
      const state: Follow = { sessionId, cursor: -1, lastSeq: -1, active: false, pending: [], committedMessages: new Set(), cancel: () => {}, reject }
      this.follow = state
      const assistant = new DshAssistantStream(
        update => this.mux({ type: 'session/assistant-stream', sessionId, update }),
        entry => this.mux({ type: 'session/event', sessionId, event: entry.event }),
      )
      let opened = false
      const timer = setTimeout(() => {
        if (this.follow === state) this.closeFollow(new Error('DSH session snapshot timed out.'))
      }, 30_000)
      state.reject = error => { clearTimeout(timer); reject(error) }
      state.cancel = this.streams.open('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 100, assistantStream: true } }, raw => {
        if (this.follow !== state) return
        if (!wireRecord(raw)) throw new Error('Invalid session frame.')
        if (!opened) {
          if (raw.type !== 'snapshot' || !Number.isSafeInteger(raw.cursor) || !wireRecord(raw.header)
            || raw.header.id !== sessionId || !wireRecord(raw.projections) || !wireRecord(raw.projections.values)
            || raw.projections.asOfSeq !== raw.cursor || typeof raw.hasMore !== 'boolean') throw new Error('Invalid session snapshot.')
          state.cursor = state.lastSeq = raw.cursor as number
          const events = decodeHistory(raw.records)
          const latest = events.at(-1)?.event.seq
          if (latest !== undefined && latest > state.cursor) throw new Error('History exceeds snapshot cursor.')
          for (const entry of events) this.acceptQueuedMessage(state, entry)
          this.installProjections(sessionId, state.cursor, raw.projections.values)
          assistant.open(raw.assistantStream, state.cursor, events)
          opened = true
          clearTimeout(timer)
          resolve({ events, hasMore: raw.hasMore, projections: this.projectionValues(sessionId), isCurrent: () => this.follow === state, activate: () => {
            if (this.follow !== state || state.active) return
            state.active = true
            this.mux({ type: 'session/queue', sessionId, items: this.queueItems(sessionId) })
            this.mux({ type: 'session/jobs', sessionId, jobs: this.jobs.get(sessionId) ?? [] })
            for (const [key, projection] of this.projections.get(sessionId) ?? []) {
              this.mux({ type: 'session/projection', sessionId, key, value: projection.value })
            }
            for (const frame of state.pending.splice(0)) this.emit(frame)
            this.presentQuestions()
          } })
        } else {
          if (raw.type === 'assistant-stream') { assistant.frame(raw.frame, state.lastSeq); return }
          if (raw.type !== 'event') throw new Error('Unexpected session snapshot.')
          const entry = decodeHistory([raw])[0]
          if (entry === undefined || entry.event.seq !== state.lastSeq + 1) throw new Error('Non-contiguous DSH session events.')
          state.lastSeq = entry.event.seq
          this.acceptQueuedMessage(state, entry)
          assistant.durable(entry)
        }
      }, error => { state.reject(error) })
    })
  }

  async page(sessionId: string, beforeSeq: number): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    const state = this.follow
    if (state?.sessionId !== sessionId || state.cursor < 0) throw new Error('Open the session before loading older history.')
    const result = await this.connection.call<{ records: unknown; hasMore: boolean }>('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: state.cursor, beforeSeq, maxMessages: 100 },
    })
    if (this.follow !== state) throw new Error('The conversation changed while loading history.')
    if (typeof result.hasMore !== 'boolean') throw new Error('Invalid history page.')
    return { events: decodeHistory(result.records), hasMore: result.hasMore }
  }

  async respond(id: string, value: unknown): Promise<RpcReceipt> {
    const pending = this.questions.get(id)
    if (pending === undefined || !wireRecord(value) || value.sessionId !== pending.sessionId) {
      throw new Error('This request is no longer pending.')
    }
    const answer = pending.event === 'approval/request' ? value.outcome : value.answer
    if (pending.event === 'approval/request' && answer !== 'allowed-once' && answer !== 'rejected') throw new Error('Invalid approval outcome.')
    if (pending.event === 'user-questions/request' && (!wireRecord(answer) || !Array.isArray(answer.answers))) throw new Error('Invalid question answer.')
    await this.result(id, { kind: 'result', value: answer })
    this.dismissQuestion(id)
    return { accepted: true }
  }

  dispose(): void {
    this.closeFollow()
    this.questions.clear()
    this.requestSessions.clear()
    this.streams.dispose()
  }

  private closeFollow(error = new Error('The conversation subscription changed.')): void {
    const previous = this.follow
    this.follow = undefined
    this.displayedQuestions.clear()
    if (previous === undefined) return
    previous.cancel()
    previous.reject(error)
  }

  private baseline(endpoint: string, item: (value: Record<string, unknown>) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let cancel = (): void => {}
      const timer = setTimeout(() => { cancel(); reject(new Error(`DSH ${endpoint} baseline timed out.`)) }, 30_000)
      cancel = this.streams.open(endpoint, {}, raw => {
        if (!wireRecord(raw)) throw new Error('Invalid DSH baseline.')
        if (item(raw)) { clearTimeout(timer); resolve() }
      }, error => { clearTimeout(timer); reject(error) })
    })
  }

  private installProjections(sessionId: string, seq: number, values: Record<string, unknown>): void {
    const previous = this.projections.get(sessionId)
    const next = new Map<string, Projection>()
    for (const [key, value] of Object.entries(values)) next.set(key, { seq, value })
    // The control stream can already be ahead of the history snapshot.
    for (const [key, projection] of previous ?? []) if (projection.seq > seq) next.set(key, projection)
    this.projections.set(sessionId, next)
    this.projectionFloors.set(sessionId, Math.max(seq, this.projectionFloors.get(sessionId) ?? -1))
  }

  private control(frame: Record<string, unknown>): void {
    if (frame.type === 'baseline') {
      const value = frame.value
      if (!wireRecord(value) || !wireRecord(value.queues) || !wireRecord(value.jobs) || !wireRecord(value.projections)) throw new Error('Invalid control baseline.')
      for (const [id, items] of Object.entries(value.queues)) this.control({ type: 'queue', sessionId: id, items })
      for (const [id, jobs] of Object.entries(value.jobs)) this.control({ type: 'jobs', sessionId: id, jobs })
      for (const [id, projection] of Object.entries(value.projections)) {
        if (!wireRecord(projection) || !wireRecord(projection.values) || !Number.isSafeInteger(projection.asOfSeq)) throw new Error('Invalid projection baseline.')
        this.installProjections(id, projection.asOfSeq as number, projection.values)
      }
      return
    }
    const id = frame.sessionId
    if (typeof id !== 'string') throw new Error('Invalid control session.')
    if (frame.type === 'queue' && Array.isArray(frame.items)) {
      this.queues.set(id, frame.items)
      if (this.follow?.active) this.mux({ type: 'session/queue', sessionId: id, items: this.queueItems(id) })
    } else if (frame.type === 'jobs' && Array.isArray(frame.jobs)) {
      this.jobs.set(id, frame.jobs)
      if (this.follow?.active) this.mux({ type: 'session/jobs', sessionId: id, jobs: frame.jobs })
    } else if (frame.type === 'projection' && typeof frame.key === 'string' && Number.isSafeInteger(frame.seq)) {
      if ((frame.seq as number) < (this.projectionFloors.get(id) ?? -1)) return
      const map = this.projections.get(id) ?? new Map<string, Projection>()
      if ((map.get(frame.key)?.seq ?? -1) > (frame.seq as number)) return
      map.set(frame.key, { seq: frame.seq as number, value: frame.value })
      this.projections.set(id, map)
      // Replayed from the newest cached value on activation, never from stale buffered values.
      if (this.follow?.sessionId !== id || this.follow.active) this.mux({ type: 'session/projection', sessionId: id, key: frame.key, value: frame.value })
    } else throw new Error('Invalid control update.')
  }

  private queueItems(sessionId: string): unknown[] {
    const items = this.queues.get(sessionId) ?? []
    const state = this.follow
    if (state?.sessionId !== sessionId || state.committedMessages.size === 0) return items
    // Follow and control are independent streams. A late full queue snapshot
    // must not resurrect a steering row already committed to this conversation.
    return items.filter(item => !(wireRecord(item) && item.placement === 'steering'
      && wireRecord(item.message) && typeof item.message.id === 'string' && state.committedMessages.has(item.message.id)))
  }

  private acceptQueuedMessage(state: Follow, entry: HistoryEntry): void {
    const { type, data } = entry.event
    if (type !== 'user/message' || !wireRecord(data) || typeof data.id !== 'string') return
    const before = this.queueItems(state.sessionId)
    state.committedMessages.add(data.id)
    const items = this.queueItems(state.sessionId)
    if (state.active && before.length !== items.length) this.mux({ type: 'session/queue', sessionId: state.sessionId, items })
  }

  private remoteEvent(frame: Record<string, unknown>): void {
    if (frame.type === 'cancel' && typeof frame.eventId === 'string') { this.dismissQuestion(frame.eventId); return }
    if (frame.type === 'waterfall' && typeof frame.eventId === 'string' && typeof frame.agentId === 'string'
      && typeof frame.event === 'string' && wireRecord(frame.request)) {
      if ((frame.agentId !== this.follow?.sessionId && !this.requestSessions.has(frame.agentId))
        || (frame.event !== 'approval/request' && frame.event !== 'user-questions/request')) {
        void this.result(frame.eventId, { kind: 'next' }).catch(this.error)
        return
      }
      const question = { sessionId: frame.agentId, event: frame.event, request: frame.request }
      this.questions.set(frame.eventId, question)
      this.publishAttention(frame.agentId)
      this.presentQuestions()
      return
    }
    if (frame.type !== 'emit' || typeof frame.event !== 'string' || !Array.isArray(frame.args)) throw new Error('Invalid remote event.')
    const [id, value] = frame.args
    if (frame.event === 'commands/change' && frame.args.length === 0) {
      this.host({ type: 'host/commands-changed' })
    } else if (frame.event === 'llm/adapters-updated' && frame.args.length === 0) {
      this.host({ type: 'host/models-changed' })
    } else if (frame.event === 'credentials/reference-updated' && typeof id === 'string') {
      // A credential reference is only an invalidation hint; never expose it to the Webview.
      this.host({ type: 'host/credentials-changed' })
    } else if (frame.event === 'settings/document-updated' && typeof id === 'string'
      && Number.isSafeInteger(value) && (value as number) >= 0) {
      this.host({ type: 'host/settings-changed', ns: id, revision: value })
    } else if (frame.event === 'agent-preset/selected' && typeof id === 'string' && typeof value === 'string') {
      // Selection itself comes from the sequenced projection, not this unsequenced hint.
      this.host({ type: 'host/session-composition-changed', sessionId: id })
    }
    if (frame.event === 'api-session/added' && wireRecord(id) && typeof id.sessionId === 'string'
      && typeof id.updatedAt === 'number' && Number.isFinite(id.updatedAt)
      && typeof id.running === 'boolean' && typeof id.blank === 'boolean') {
      const summary = id as unknown as SessionSummary
      this.addedSessions.set(summary.sessionId, { revision: ++this.addedRevision, summary })
      this.running.set(summary.sessionId, summary.running)
      this.host({ ...this.summary(summary), type: 'host/session-added' })
    }
    else if (typeof id === 'string') {
      if (frame.event === 'api-session/status' && typeof value === 'boolean') {
        this.running.set(id, value)
        if (value) this.nonBlankSessions.add(id)
        this.host({ type: 'host/session-status', sessionId: id, running: value })
      } else if (frame.event === 'api-session/activity' && typeof value === 'number' && Number.isFinite(value)) {
        const updatedAt = Math.max(this.activity.get(id) ?? 0, value)
        this.activity.set(id, updatedAt)
        this.nonBlankSessions.add(id)
        this.host({ type: 'host/session-activity', sessionId: id, updatedAt })
      } else if (frame.event === 'api-session/removed') {
        // A disposed live instance is not a deletion of its persisted history.
        this.running.set(id, false)
        this.requestSessions.delete(id)
        this.queues.delete(id)
        this.jobs.delete(id)
        this.projections.delete(id)
        this.projectionFloors.delete(id)
        for (const [eventId, question] of this.questions) if (question.sessionId === id) this.dismissQuestion(eventId)
        this.mux({ type: 'session/queue', sessionId: id, items: [] })
        this.mux({ type: 'session/jobs', sessionId: id, jobs: [] })
        this.host({ type: 'host/session-removed', sessionId: id })
      } else if (frame.event === 'api-session/error') this.host({ type: 'host/agent-error', sessionId: id, message: value })
    }
  }

  private presentQuestion(id: string, pending: PendingQuestion): void {
    const approval = pending.event === 'approval/request'
    this.emit({ channel: 'mux', rpcId: id, payload: { ...pending.request, sessionId: pending.sessionId,
      type: approval ? 'approval/requested' : 'question/requested', ...(approval ? { approvalId: id } : {}) } })
  }

  private presentQuestions(): void {
    if (this.follow?.active !== true) return
    // The sidebar has one approval panel and one question panel. Keep parallel
    // tool approvals queued instead of overwriting an unanswered request.
    const shown = new Set<string>()
    for (const [id, pending] of this.questions) {
      if (pending.sessionId !== this.follow.sessionId || shown.has(pending.event)) continue
      shown.add(pending.event)
      if (this.displayedQuestions.get(pending.event) !== id) {
        this.displayedQuestions.set(pending.event, id)
        this.presentQuestion(id, pending)
      }
    }
  }

  private dismissQuestion(id: string): void {
    const pending = this.questions.get(id)
    if (pending === undefined) return
    this.questions.delete(id)
    this.publishAttention(pending.sessionId)
    if (this.displayedQuestions.get(pending.event) === id) this.displayedQuestions.delete(pending.event)
    this.mux({ type: pending.event === 'approval/request' ? 'approval/resolved' : 'question/resolved',
      sessionId: pending.sessionId, approvalId: id, questionRpcId: id })
    this.presentQuestions()
  }

  private publishAttention(sessionId: string): void {
    const pending = [...this.questions.values()].filter(question => question.sessionId === sessionId)
    this.host({ type: 'host/session-attention', sessionId,
      approvals: pending.filter(question => question.event === 'approval/request').length,
      questions: pending.filter(question => question.event === 'user-questions/request').length })
  }

  private result(eventId: string, outcome: unknown): Promise<void> {
    if (this.clientId === undefined) return Promise.reject(new Error('DSH event stream is not ready.'))
    return this.connection.call('$events/result', { clientId: this.clientId, eventId, outcome })
  }

  private mux(payload: Record<string, unknown>): void {
    const frame: DshFrame = { channel: 'mux', rpcId: '', payload }
    const state = this.follow
    if (state !== undefined && !state.active && payload.sessionId === state.sessionId) state.pending.push(frame)
    else this.emit(frame)
  }

  private host(payload: Record<string, unknown>): void { this.emit({ channel: 'host', rpcId: '', payload }) }
}
