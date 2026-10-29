import { describe, expect, it, vi } from 'vitest'
import { inspectContext, readContextHistory } from '../src/context-inspector.js'
import type { DshEvent } from '../src/conversation.js'
import type { HistoryEntry, SkillDescriptor } from '../src/dsh-client.js'

const usage = { available: false, percent: 0, usedTokens: 0, contextWindow: 0 }
const entry = (seq: number, type: string, data: unknown, surfaceOp: unknown = 'append'): HistoryEntry => ({
  event: { seq, type, time: 1_000 + seq, data, surfaceOp } as DshEvent,
})
const message = (kind: string, content: string) => ({ source: { kind }, content: [{ type: 'text', text: content }] })
const system = (seq: number, content: string) => entry(seq, 'system/message', { message: message('system', content) })
const user = (seq: number, kind: string, content: string) => entry(seq, 'user/message', message(kind, content))
const inspect = (history: HistoryEntry[], skills: SkillDescriptor[] | undefined = []) => inspectContext('session', history, true, skills, usage)
const group = (snapshot: ReturnType<typeof inspect>, id: string) => snapshot.groups.find(group => group.id === id)!

describe('recorded context inspection', () => {
  it('uses the latest recorded tool header, not tool-call counts', () => {
    const snapshot = inspect([
      system(1, 'Be helpful'),
      entry(2, 'request/header', { header: { tools: [{ name: 'old' }] } }),
      entry(3, 'request/header', { header: { tools: [{ name: 'read', description: 'Read files', parameters: { type: 'object' } }] } }),
    ])
    expect(group(snapshot, 'system').entries[0]?.content).toBe('Be helpful')
    expect(group(snapshot, 'tools').entries.map(entry => entry.label)).toEqual(['read'])
    expect(group(snapshot, 'tools').entries[0]?.content).toContain('parameters')
    expect(snapshot.headerSeq).toBe(3)
    expect(snapshot.throughSeq).toBe(3)
    expect(snapshot.warnings).toEqual([])
  })

  it('distinguishes rules, actual skill injections, available skills, and ordinary chat', () => {
    const snapshot = inspect([
      entry(1, 'user/message', { ...message('agent-instructions', 'Use pnpm'), source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md', action: 'set' }] } }),
      entry(2, 'user/message', { ...message('skill-invocation', 'Loaded body'), source: { kind: 'skill-invocation', name: 'review' } }),
      user(3, 'skill-catalog', 'review: review code'),
      user(4, 'user', 'My ordinary prompt'),
      entry(5, 'user/message', { content: [{ type: 'text', text: 'Untagged user prompt' }] }),
      entry(6, 'developer/message', { message: message('workspace-context', 'Current workspace') }),
    ], [{ name: 'review', description: 'Review code', modelInvocable: true }])
    expect(group(snapshot, 'instructions').entries[0]).toMatchObject({ label: 'AGENTS.md', content: 'Use pnpm' })
    expect(group(snapshot, 'skills').entries.map(entry => entry.content)).toEqual(['Loaded body'])
    expect(group(snapshot, 'available').entries[0]).toMatchObject({ content: 'Review code', source: 'Model-callable skill' })
    expect(group(snapshot, 'context').entries.map(entry => entry.content)).toEqual(['review: review code', 'Current workspace'])
    expect(JSON.stringify(snapshot.groups)).not.toContain('ordinary prompt')
    expect(JSON.stringify(snapshot.groups)).not.toContain('Untagged user prompt')
  })

  it('counts only successful retained skill tool results as loaded', () => {
    const snapshot = inspect([
      entry(1, 'tool/call', { callId: 'one', name: 'skill', arguments: '{"name":"review"}' }),
      entry(2, 'tool/result', { message: { ...message('tool', 'Skill instructions'), source: { callId: 'one' } } }),
      entry(3, 'tool/call', { callId: 'two', name: 'skill', arguments: { name: 'missing' } }),
      entry(4, 'tool/result', { message: { ...message('tool', 'Skill not found'), source: { callId: 'two' }, isError: true } }),
    ])
    expect(group(snapshot, 'skills').entries.map(entry => [entry.label, entry.content])).toEqual([['review', 'Skill instructions']])
  })

  it('folds replacements in surface position order, not append-log sequence order', () => {
    const snapshot = inspect([
      system(1, 'Original'), user(2, 'agent-instructions', 'Old rules'), user(3, 'user', 'Chat'),
      entry(4, 'system/message', { message: message('system', 'Updated') }, { op: 'replace', startSeq: 1, endSeq: 1 }),
      // Surface is now [4, 2, 3], so the replacement spans 4 through 2.
      entry(5, 'system/message', { message: message('system', 'Combined') }, { op: 'replace', startSeq: 4, endSeq: 2 }),
    ])
    expect(group(snapshot, 'system').entries.map(entry => entry.content)).toEqual(['Combined'])
    expect(group(snapshot, 'instructions').entries).toEqual([])
  })

  it('does not pretend missing surface markers or replacement bounds are reconstructed', () => {
    const legacy = system(1, 'Unknown placement'); delete legacy.event.surfaceOp
    const snapshot = inspect([
      legacy, system(4, 'May be replaced'),
      entry(5, 'user/message', message('compaction', 'Summary'), { op: 'replace', startSeq: 2, endSeq: 4 }),
      user(6, 'agent-instructions', 'Known later injection'),
    ])
    expect(group(snapshot, 'system').entries).toEqual([])
    expect(group(snapshot, 'instructions').entries[0]?.content).toBe('Known later injection')
    expect(snapshot.warnings.join(' ')).toContain('unavailable history')
    expect(snapshot.warnings.join(' ')).toContain('history format')
  })

  it('records compaction outcome without inventing savings or treating every summary as retained', () => {
    const snapshot = inspect([
      entry(1, 'compaction/start', { compactionId: 'a' }),
      entry(2, 'compaction/summary', { compactionId: 'a', summary: [{ type: 'text', text: 'Summarized work' }] }),
      entry(3, 'compaction/end', { compactionId: 'a' }),
      entry(4, 'compaction/end', { compactionId: 'b', error: 'Provider failed' }),
    ])
    expect(group(snapshot, 'compaction').entries.map(entry => [entry.label, entry.content])).toEqual([
      ['Failed', 'Provider failed'], ['Completed', 'Summarized work'],
    ])
    expect(group(snapshot, 'context').entries).toEqual([])
  })

  it('bounds content and entries, and distinguishes unavailable catalogs from empty ones', () => {
    const snapshot = inspect(Array.from({ length: 160 }, (_, index) => system(index, 'x'.repeat(30_000))))
    const entries = group(snapshot, 'system').entries
    expect(group(snapshot, 'system').total).toBe(160)
    expect(entries[0]).toMatchObject({ characters: 30_000, truncated: true })
    expect(entries.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(350_000)
    expect(snapshot.warnings.join(' ')).toContain('display limit')
    expect(inspectContext('s', [], false, undefined, usage).warnings.join(' ')).toContain('catalog is unavailable')
    expect(inspectContext('s', [], false, [], usage).warnings.join(' ')).not.toContain('catalog is unavailable')
    expect(inspectContext('s', [], false, [], usage).warnings.join(' ')).toContain('Earlier history')
  })
})

describe('on-demand context history', () => {
  it('backfills a captured boundary without changing the visible chat or including later events', async () => {
    const initial = [system(3, 'Latest')]
    const page = vi.fn(async () => ({ events: [system(1, 'Earlier'), system(3, 'Duplicate'), system(5, 'Arrived later')], hasMore: false }))
    const result = await readContextHistory(initial, true, page, () => true)
    expect(result.entries.map(entry => entry.event.seq)).toEqual([1, 3])
    expect(initial).toHaveLength(1)
    expect(result.complete).toBe(true)
    expect(page).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('does not loop or claim completeness for non-progressing pages', async () => {
    const page = vi.fn(async () => ({ events: [system(3, 'Same')], hasMore: false }))
    expect((await readContextHistory([system(3, 'Same')], true, page, () => true)).complete).toBe(false)
    expect(page).toHaveBeenCalledTimes(1)
  })

  it('caps pagination and rejects an obsolete inspector before further reads', async () => {
    const page = vi.fn(async (before: number) => ({ events: [system(before - 1, 'Earlier')], hasMore: true }))
    const result = await readContextHistory([system(100, 'Latest')], true, page, () => true)
    expect(page).toHaveBeenCalledTimes(12)
    expect(result.complete).toBe(false)
    await expect(readContextHistory([system(100, 'Latest')], true, page, () => false)).rejects.toThrow('conversation changed')
    expect(page).toHaveBeenCalledTimes(12)
  })
})
