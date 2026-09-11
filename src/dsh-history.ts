import type { HistoryEntry } from './dsh-client.js'
import { wireRecord } from './dsh-streams.js'

/** Expand the official lossless chunk encoding before the existing projector. */
export function decodeHistory(records: unknown): HistoryEntry[] {
  if (!Array.isArray(records)) throw new Error('Invalid DSH history records.')
  return records.flatMap((record): HistoryEntry[] => {
    if (!wireRecord(record) || !wireRecord(record.event)) throw new Error('Invalid DSH history record.')
    const event = record.event
    if (typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.time)) {
      throw new Error('Invalid DSH history event.')
    }
    const seq = event.seq as number
    let time = event.time as number
    if (record.type === 'event') return [{ event: { ...event, type: event.type, seq, time, data: event.data } }]
    const data = event.data
    if (record.type !== 'chunks' || !wireRecord(data)) throw new Error('Invalid DSH chunk record.')
    const tool = event.type === 'chunkrow/tool-call-chunks'
    const kind = tool ? 'tool-call-delta' : event.type === 'chunkrow/text-chunks' ? 'text-delta'
      : event.type === 'chunkrow/reasoning-chunks' ? 'reasoning-delta' : undefined
    const parts = tool ? data.args : data.texts
    const gaps = data.dt
    if (kind === undefined || !Array.isArray(parts) || parts.length === 0 || !parts.every(p => typeof p === 'string')
      || !Array.isArray(gaps) || gaps.length !== parts.length - 1 || !gaps.every(Number.isSafeInteger)
      || typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number'
      || (tool && (typeof data.id !== 'string' || (data.name !== undefined && typeof data.name !== 'string')))) {
      throw new Error('Invalid DSH packed chunks.')
    }
    return parts.map((part: string, index) => {
      if (index > 0) time += gaps[index - 1] as number
      if (!Number.isSafeInteger(time) || !Number.isSafeInteger(seq + index)) throw new Error('Invalid DSH chunk cursor.')
      const chunk = tool
        ? { type: kind, index: data.index, id: data.id, argumentsDelta: part, ...(data.name === undefined ? {} : { name: data.name }) }
        : { type: kind, index: data.index, text: part }
      return { event: { type: 'assistant/chunk', seq: seq + index, time, data: { turn: data.turn, step: data.step, chunk } } }
    })
  })
}
