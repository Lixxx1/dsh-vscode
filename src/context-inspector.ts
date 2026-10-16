import type { DshEvent } from './conversation.js'
import type { HistoryEntry, SkillDescriptor } from './dsh-client.js'
import { earliestHistorySequence, mergeHistoryEntries } from './history.js'
import { normalizeToolResult } from './tool-result.js'
import type { UsageMeterState } from './usage-meter.js'

export interface ContextEntry {
  id: string
  label: string
  source: string
  content: string
  characters: number
  truncated: boolean
}

export interface ContextGroup {
  id: string
  label: string
  description: string
  entries: ContextEntry[]
  total: number
}

export interface ContextInspection {
  sessionId: string
  capturedAt: number
  throughSeq?: number | undefined
  headerSeq?: number | undefined
  usage: UsageMeterState
  groups: ContextGroup[]
  warnings: string[]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const blocksText = (value: unknown): string => Array.isArray(value)
  ? value.flatMap(part => { const block = record(part); return block?.type === 'text' ? [text(block.text)] : [] }).join('\n') : ''

/** Only fetched on demand; never backfills or changes the visible conversation. */
export async function readContextHistory(
  initial: readonly HistoryEntry[],
  hasMore: boolean,
  page: (beforeSeq: number) => Promise<{ events: HistoryEntry[]; hasMore: boolean }>,
  current: () => boolean,
): Promise<{ entries: HistoryEntry[]; complete: boolean }> {
  let entries = [...initial]
  const deadline = Date.now() + 10_000
  let bytes = entries.reduce((sum, entry) => sum + JSON.stringify(entry.event).length, 0)
  for (let pages = 0; hasMore && pages < 12 && entries.length < 25_000 && bytes < 8_000_000 && Date.now() < deadline; pages++) {
    if (!current()) throw new Error('The conversation changed. Reopen the context inspector.')
    const before = earliestHistorySequence(entries)
    if (before === undefined || before === 0) break
    const result = await page(before)
    if (!current()) throw new Error('The conversation changed. Reopen the context inspector.')
    // Refuse a non-progressing cursor; do not silently label a partial log complete.
    const earlier = result.events.filter(entry => entry.event.seq < before)
    if (earlier.length === 0) break
    bytes += earlier.reduce((sum, entry) => sum + JSON.stringify(entry.event).length, 0)
    entries = mergeHistoryEntries(entries, earlier)
    hasMore = result.hasMore
  }
  return { entries, complete: !hasMore }
}

/** Read recorded input, not files on disk or a hypothetical next model request. */
export function inspectContext(
  sessionId: string,
  history: readonly HistoryEntry[],
  complete: boolean,
  skills: readonly SkillDescriptor[] | undefined,
  usage: UsageMeterState,
): ContextInspection {
  const groups: ContextGroup[] = [
    { id: 'system', label: 'System prompt', description: 'Recorded system messages retained after replacements.', entries: [], total: 0 },
    { id: 'tools', label: 'Tools', description: 'Schemas in the latest recorded request header, including tools never called.', entries: [], total: 0 },
    { id: 'instructions', label: 'Project rules', description: 'Instruction messages recorded by DSH, not the current files on disk.', entries: [], total: 0 },
    { id: 'skills', label: 'Loaded skill content', description: 'Explicit skill injections and successful skill-tool results still retained in the recorded history.', entries: [], total: 0 },
    { id: 'context', label: 'Other injected context', description: 'Recorded catalogs, snapshots and other producer-supplied context.', entries: [], total: 0 },
    { id: 'available', label: 'Available skills', description: 'Discovered by DSH. Availability does not mean the skill body was loaded.', entries: [], total: 0 },
    { id: 'compaction', label: 'Recent compactions', description: 'Recorded compaction results and pruning events; no estimated token savings.', entries: [], total: 0 },
  ]
  const warnings = new Set<string>()
  if (!complete) warnings.add('Earlier history could not be fully loaded within the inspection limit. Some inputs may be missing.')
  const surface: DshEvent[] = []
  const calls = new Map<string, { name: string; skill: string }>()
  let header: Record<string, unknown> | undefined
  let headerSeq: number | undefined
  let remainingCharacters = 350_000
  const add = (groupId: string, id: string, label: string, source: string, content: string) => {
    const group = groups.find(group => group.id === groupId)!
    group.total++
    if (group.entries.length >= 150 || remainingCharacters <= 0) return
    const excerpt = content.slice(0, Math.min(24_000, remainingCharacters))
    remainingCharacters -= excerpt.length
    group.entries.push({ id, label: label.slice(0, 300), source: source.slice(0, 500), content: excerpt,
      characters: content.length, truncated: excerpt.length < content.length })
  }
  const events = mergeHistoryEntries([], history).map(entry => entry.event)
  const compactions = new Map<string, { seq: number; time: number; status: string; content: string }>()
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'request/header' && record(data?.header)) {
      header = record(data!.header)
      headerSeq = event.seq
    }
    if (event.type === 'tool/call' && typeof data?.callId === 'string') {
      let args = data.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
      calls.set(data.callId, { name: text(data.name), skill: text(record(args)?.name) })
    }
    if (event.type.startsWith('compaction/')) {
      const key = text(data?.compactionId) || String(event.seq)
      const previous = compactions.get(key)
      if (event.type === 'compaction/start') compactions.set(key, { seq: event.seq, time: event.time, status: 'Started (no end recorded)', content: '' })
      if (event.type === 'compaction/summary') compactions.set(key, { seq: event.seq, time: event.time, status: 'Summary recorded', content: blocksText(data?.summary) })
      if (event.type === 'compaction/end') compactions.set(key, { seq: event.seq, time: event.time,
        status: typeof data?.error === 'string' ? 'Failed' : 'Completed', content: text(data?.error) || previous?.content || '' })
      if (event.type === 'compaction/prune') compactions.set(key, { seq: event.seq, time: event.time, status: 'Pruned', content: 'DSH pruned recorded context.' })
    }
    if (!['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue
    if (event.surfaceOp === 'append') surface.push(event)
    else if (record(event.surfaceOp)?.op === 'replace') {
      const op = record(event.surfaceOp)!
      const start = surface.findIndex(node => node.seq === op.startSeq)
      const end = surface.findIndex(node => node.seq === op.endSeq)
      if (start < 0 || end < start) {
        // Position order differs from numeric seq order after replacements. A
        // partial prefix cannot establish that range: do not invent membership.
        warnings.add('A context replacement refers to unavailable history. Retained inputs cannot be reconstructed completely.')
        surface.length = 0
      } else surface.splice(start, end - start + 1, event)
    } else warnings.add('Some messages use a history format this inspector cannot reconstruct. Their content is not shown as retained context.')
  }
  for (const event of surface) {
    const data = record(event.data)
    const message = event.type === 'user/message' ? data : record(data?.message)
    const source = record(message?.source)
    const kind = text(source?.kind)
    const content = blocksText(message?.content)
    if (event.type === 'system/message' && content) add('system', String(event.seq), 'System prompt', `Event ${event.seq}`, content)
    if ((event.type === 'developer/message' || event.type === 'user/message' && kind && kind !== 'user') && content) {
      const group = kind === 'skill-invocation' ? 'skills' : kind === 'agent-instructions' || source?.form === 'instructions' ? 'instructions' : 'context'
      const changes = Array.isArray(source?.changes) ? source.changes : []
      const paths = changes.flatMap(change => { const path = text(record(change)?.path); return path ? [path] : [] })
      add(group, String(event.seq), text(source?.name) || paths.join(', ') || kind || 'Injected context', `${kind || 'Unknown producer'} · event ${event.seq}`, content)
    }
    if (event.type === 'tool/result') {
      const result = normalizeToolResult(event)
      const call = result.callId === undefined ? undefined : calls.get(result.callId)
      if (call?.name === 'skill' && !result.failed) add('skills', String(event.seq), call.skill || 'Skill tool result', `skill · event ${event.seq}`, result.text)
    }
  }
  if (header) {
    const tools = Array.isArray(header.tools) ? header.tools : []
    for (const value of tools) {
      const tool = record(value)
      if (typeof tool?.name !== 'string') { warnings.add('Some recorded tool schemas could not be read.'); continue }
      add('tools', tool.name, tool.name, `Request header · event ${headerSeq}`, JSON.stringify(tool, null, 2))
    }
  } else warnings.add('No request header is available yet. Send a message to record the model’s tools and prompt.')
  if (skills === undefined) warnings.add('The current skill catalog is unavailable. This does not mean no skills are installed.')
  for (const skill of skills ?? []) add('available', skill.name, skill.name, skill.modelInvocable ? 'Model-callable skill' : 'User-invocable skill', [skill.description, skill.whenToUse].filter(Boolean).join('\n\n'))
  for (const item of [...compactions.values()].slice(-10).reverse()) {
    const date = new Date(item.time)
    add('compaction', String(item.seq), item.status, `${Number.isFinite(date.getTime()) ? date.toISOString() : 'Unknown time'} · event ${item.seq}`, item.content)
  }
  if (groups.some(group => group.total > group.entries.length)) warnings.add('The display limit was reached. Counts include entries not shown below.')
  return { sessionId, capturedAt: Date.now(), throughSeq: events.at(-1)?.seq, headerSeq, usage, groups, warnings: [...warnings] }
}
