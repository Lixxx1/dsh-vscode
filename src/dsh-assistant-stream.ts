import type { HistoryEntry } from './dsh-client.js'
import { wireRecord } from './dsh-streams.js'

export interface AssistantAttempt {
  attemptId: string
  turn: number
  step: number
}

/** Presentation only: never assign a durable sequence to a live model chunk. */
export type AssistantStreamUpdate =
  | ({ kind: 'start' } & AssistantAttempt)
  | { kind: 'chunk'; attemptId: string; chunk: Record<string, unknown> }
  | { kind: 'end'; attemptId: string }

interface ActiveAttempt extends AssistantAttempt { startedAfterSeq: number; nextIndex: number }

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function invalid(): never { throw new Error('Invalid DSH assistant stream. Reconnect the runtime.') }

/** Expand only the compact reconnect prefix; durable V3 history stays untouched. */
function expandPrefix(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return invalid()
  return value.flatMap((run): Record<string, unknown>[] => {
    if (!wireRecord(run)) return invalid()
    if (run.type === 'chunk') {
      if (!integer(run.time, Number.MIN_SAFE_INTEGER) || !wireRecord(run.chunk) || typeof run.chunk.type !== 'string') return invalid()
      return [run.chunk]
    }
    const kind = run.type === 'text-chunks' ? 'text-delta' : run.type === 'reasoning-chunks' ? 'reasoning-delta'
      : run.type === 'tool-call-chunks' ? 'tool-call-delta' : undefined
    const members = kind === 'tool-call-delta' ? run.args : run.texts
    if (kind === undefined || !integer(run.index) || !integer(run.time0, Number.MIN_SAFE_INTEGER)
      || !Array.isArray(members) || members.length === 0 || !members.every(item => typeof item === 'string')
      || !Array.isArray(run.dt) || run.dt.length !== members.length - 1 || !run.dt.every(Number.isSafeInteger)
      || (kind === 'tool-call-delta' && (typeof run.id !== 'string' || (run.name !== undefined && typeof run.name !== 'string')))) return invalid()
    const gaps = run.dt
    let time = run.time0
    return members.map((text: string, index) => {
      if (index > 0) time += gaps[index - 1] as number
      if (!Number.isSafeInteger(time)) return invalid()
      return kind === 'tool-call-delta'
        ? { type: kind, index: run.index, id: run.id, argumentsDelta: text, ...(run.name === undefined ? {} : { name: run.name }) }
        : { type: kind, index: run.index, text }
    })
  })
}

/** Joins 0.1.5 transient attempts to their ordered, durable settlement. */
export class DshAssistantStream {
  private revision = 0
  private active: ActiveAttempt | undefined
  private pending: HistoryEntry | undefined
  private openingSettlement: HistoryEntry | undefined

  constructor(
    private readonly live: (update: AssistantStreamUpdate) => void,
    private readonly publish: (entry: HistoryEntry) => void,
  ) {}

  open(baseline: unknown, cursor: number, entries: readonly HistoryEntry[] = []): void {
    // 0.1.2 ignores the opt-in and continues to send durable assistant/chunk events.
    if (baseline === undefined) return
    if (!wireRecord(baseline) || !integer(baseline.revision)) return invalid()
    this.revision = baseline.revision
    if (baseline.activeAttempt === undefined) return
    const opening = baseline.activeAttempt
    if (!wireRecord(opening) || !integer(opening.nextIndex)) return invalid()
    const chunks = expandPrefix(opening.stream)
    if (chunks.length !== opening.nextIndex) return invalid()
    // An opening cut can already contain the settlement while its process-local
    // end marker is still in flight. Do not render or later publish it twice.
    this.openingSettlement = entries.find(({ event }) => this.matchesSettlement(event, opening))
    this.start(opening, cursor, this.openingSettlement === undefined)
    const active = this.active!
    if (this.openingSettlement === undefined) {
      for (const chunk of chunks) this.live({ kind: 'chunk', attemptId: active.attemptId, chunk })
    }
    active.nextIndex = opening.nextIndex
  }

  durable(entry: HistoryEntry): void {
    const event = entry.event
    const active = this.active
    if (active !== undefined && this.matchesSettlement(event, active)) {
      if (this.pending !== undefined || this.openingSettlement !== undefined) return invalid()
      this.pending = entry
    } else this.publish(entry)
  }

  frame(value: unknown, cursor: number): void {
    if (!wireRecord(value) || !integer(value.revision) || value.revision !== this.revision + 1
      || typeof value.attemptId !== 'string' || value.attemptId === '') return invalid()
    this.revision = value.revision
    if (value.type === 'start') {
      if (this.active !== undefined || this.pending !== undefined) return invalid()
      this.start(value, cursor)
      return
    }
    if (value.type !== 'chunk' && value.type !== 'end') return invalid()
    if (!integer(value.index)) return invalid()
    if (value.type === 'chunk' && (!integer(value.time, Number.MIN_SAFE_INTEGER)
      || !wireRecord(value.chunk) || typeof value.chunk.type !== 'string')) return invalid()
    const active = this.active
    // A controller attached after the attempt began can have no reconstructible prefix.
    // Its eventual durable settlement is still authoritative; do not show a partial suffix.
    if (active === undefined) return
    if (value.attemptId !== active.attemptId || value.index !== active.nextIndex) return invalid()
    if (value.type === 'chunk') {
      if (this.pending !== undefined || this.openingSettlement !== undefined) return invalid()
      active.nextIndex++
      this.live({ kind: 'chunk', attemptId: active.attemptId, chunk: value.chunk as Record<string, unknown> })
      return
    }
    const outcome = value.outcome
    if (!wireRecord(outcome)) return invalid()
    if (outcome.kind === 'committed') {
      const entry = this.pending ?? this.openingSettlement
      if (entry === undefined || entry.event.seq !== outcome.seq || entry.event.type !== outcome.eventType) return invalid()
      // The final message replaces the live prefix in a single UI publication.
      if (this.openingSettlement === undefined) this.publish(entry)
    } else if (outcome.kind === 'abandoned' && this.pending === undefined && this.openingSettlement === undefined) {
      this.live({ kind: 'end', attemptId: active.attemptId })
    } else return invalid()
    this.pending = undefined
    this.openingSettlement = undefined
    this.active = undefined
  }

  private matchesSettlement(event: HistoryEntry['event'], attempt: { turn?: unknown; step?: unknown; startedAfterSeq?: unknown }): boolean {
    return wireRecord(event.data) && integer(attempt.startedAfterSeq, -1)
      && (event.type === 'assistant/attempt' || (event.type === 'assistant/message' && event.surfaceOp === 'append'))
      && event.seq > attempt.startedAfterSeq && event.data.turn === attempt.turn && event.data.step === attempt.step
  }

  private start(value: Record<string, unknown>, cursor: number, publish = true): void {
    if (typeof value.attemptId !== 'string' || value.attemptId === '' || !integer(value.turn) || !integer(value.step)
      || !integer(value.startedAfterSeq, -1) || value.startedAfterSeq > cursor) return invalid()
    this.active = { attemptId: value.attemptId, turn: value.turn, step: value.step, startedAfterSeq: value.startedAfterSeq, nextIndex: 0 }
    if (publish) this.live({ kind: 'start', attemptId: value.attemptId, turn: value.turn, step: value.step })
  }
}
