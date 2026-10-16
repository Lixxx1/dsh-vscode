import { wireRecord } from './dsh-streams.js'
import { ConversationProjector } from './conversation.js'
import type { HistoryEntry } from './dsh-client.js'

export interface SubagentAddress {
  kind: 'subagent'
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable' | 'unknown'
}
export interface SubagentTask {
  address: SubagentAddress
  label: string
  depth: number
  status: 'running' | 'completed' | 'interrupted' | 'inactive' | 'unavailable'
  elapsedMs: number
  error?: string
}
export interface TaskInspection {
  sessionId: string
  tasks: SubagentTask[]
  truncated: boolean
  detail?: {
    childSessionId: string
    messages: { id: string; role: string; text: string; detail: string; failed: boolean }[]
    truncated: boolean
  }
}

/** Only parent-owned catalog entries establish a child relationship. */
export function subagentCatalog(value: unknown): { id: string; label: string; mode: SubagentAddress['mode'] }[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(entry => {
    if (!wireRecord(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || !['one-shot', 'continuable', 'unknown'].includes(String(entry.mode))) return []
    seen.add(entry.id)
    return [{ id: entry.id, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.slice(0, 200) : `Agent ${entry.id.slice(0, 8)}`,
      mode: entry.mode as SubagentAddress['mode'] }]
  })
}

export function subagentProgress(values: Record<string, unknown>, running?: boolean): Pick<SubagentTask, 'status' | 'elapsedMs'> {
  const timing = wireRecord(values.subagentTiming) ? values.subagentTiming : {}
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const active = wireRecord(timing.active) ? timing.active : undefined
  // Durable event timestamps, not wall-clock time: an old open turn is not proof
  // that an Agent is still running, and inactivity is not proof of success.
  const elapsedMs = finite(timing.settledMs) + (active ? Math.max(0, finite(active.through) - finite(active.since)) : 0)
  return { elapsedMs, status: running === true ? 'running' : timing.lastTurnCompleted === true ? 'completed'
    : timing.lastTurnCompleted === false ? 'interrupted' : 'inactive' }
}

export async function readSubagentTasks(root: string, read: (id: string) => Promise<Record<string, unknown> | null>,
  running: (id: string) => boolean | undefined, signal: AbortSignal): Promise<TaskInspection> {
  const rootValues = await read(root)
  signal.throwIfAborted()
  if (rootValues === null) throw new Error('This conversation is no longer available.')
  const result: TaskInspection = { sessionId: root, tasks: [], truncated: false }
  const seen = new Set([root])
  // Bounded discovery never resumes a child and never scans unrelated sessions.
  const visit = async (parent: string, values: Record<string, unknown>, depth: number): Promise<void> => {
    for (const child of subagentCatalog(values.subagentCatalog)) {
      signal.throwIfAborted()
      if (seen.has(child.id)) continue
      if (result.tasks.length >= 40 || depth > 4) { result.truncated = true; continue }
      seen.add(child.id)
      const task: SubagentTask = { address: { kind: 'subagent', parentSessionId: parent, childSessionId: child.id, mode: child.mode },
        label: child.label, depth, status: 'unavailable', elapsedMs: 0 }
      result.tasks.push(task)
      let childValues: Record<string, unknown> | null
      try { childValues = await read(child.id) } catch {
        signal.throwIfAborted()
        task.error = 'Could not read this agent. Refresh to retry.'
        continue
      }
      signal.throwIfAborted()
      if (childValues === null) { task.error = 'Agent history is unavailable.'; continue }
      Object.assign(task, subagentProgress(childValues, running(child.id)))
      await visit(child.id, childValues, depth + 1)
    }
  }
  await visit(root, rootValues, 0)
  return result
}

export function subagentDetail(childSessionId: string, entries: HistoryEntry[], hasMore: boolean): NonNullable<TaskInspection['detail']> {
  const projector = new ConversationProjector()
  projector.reset(entries)
  const messages = projector.messages()
  let budget = 60_000
  let truncated = hasMore || messages.length > 60
  // Keep the newest output, then restore chronological order. Do not ship raw
  // tool views, image data or executable markdown into the read-only panel.
  const excerpts = messages.slice(-60).reverse().map(message => {
    const take = (text: string) => {
      const size = Math.min(8_000, budget)
      const excerpt = text.slice(0, size)
      if (text.length > excerpt.length) truncated = true
      budget -= excerpt.length
      return excerpt
    }
    return { id: message.id, role: message.role, text: take(message.text), detail: take(message.detail ?? ''), failed: message.failed === true }
  }).filter(message => message.text || message.detail).reverse()
  return { childSessionId, messages: excerpts, truncated }
}
