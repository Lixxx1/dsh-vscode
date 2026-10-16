import type { DshConnection } from './dsh-connection.js'
import { DshStreams, wireRecord } from './dsh-streams.js'
import { decodeHistory } from './dsh-history.js'
import { readSubagentTasks, subagentDetail, type TaskInspection, type SubagentAddress } from './subagents.js'

/** Independent, read-only observation: never replaces the main chat follow. */
export async function inspectSubagents(connection: DshConnection, sessionId: string, childId: string | undefined,
  running: (id: string) => boolean | undefined, signal: AbortSignal): Promise<TaskInspection> {
  const inspection = await readSubagentTasks(sessionId, async id => {
    const value = await connection.call<unknown>('session/projections', { request: { sessionId: id } }, 10_000, signal)
    if (value === null) return null
    if (!wireRecord(value) || !wireRecord(value.values)) throw new Error('Invalid DSH task projections.')
    return value.values
  }, running, signal)
  signal.throwIfAborted()
  if (childId !== undefined) {
    const child = inspection.tasks.find(task => task.address.childSessionId === childId)
    if (child === undefined) throw new Error('This agent is not in the current conversation’s task catalog.')
    inspection.detail = await readChildSnapshot(connection, child.address, signal)
  }
  return inspection
}

export function readChildSnapshot(connection: DshConnection, address: SubagentAddress, signal: AbortSignal): Promise<NonNullable<TaskInspection['detail']>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const streams = new DshStreams(connection, error => finish(error))
    const finish = (error?: Error, detail?: NonNullable<TaskInspection['detail']>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      streams.dispose()
      if (error) reject(error)
      else resolve(detail!)
    }
    const aborted = () => finish(new Error('Task inspection cancelled.'))
    const timer = setTimeout(() => finish(new Error('Agent history timed out. Refresh to retry.')), 10_000)
    signal.addEventListener('abort', aborted, { once: true })
    // The subagent address is essential: ordinary session/follow can activate
    // an Agent. DSH validates the direct parent/child relation on this route.
    streams.open('session/follow', { request: { address, maxMessages: 60 } }, raw => {
      if (!wireRecord(raw) || raw.type !== 'snapshot' || !wireRecord(raw.header)
        || raw.header.id !== address.childSessionId || !Number.isSafeInteger(raw.cursor)
        || typeof raw.hasMore !== 'boolean') throw new Error('Invalid child snapshot.')
      const entries = decodeHistory(raw.records)
      if (entries.some(entry => entry.event.seq > (raw.cursor as number))) throw new Error('History exceeds child snapshot.')
      finish(undefined, subagentDetail(address.childSessionId, entries, raw.hasMore))
    }, error => finish(error), false)
  })
}
