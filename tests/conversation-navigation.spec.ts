import { describe, expect, it, vi } from 'vitest'
import { ConversationNavigation, findConversationMessages } from '../src/conversation-navigation.js'
import type { ConversationMessage } from '../src/conversation.js'
import type { HistoryEntry } from '../src/dsh-client.js'

const prompt = (seq: number, text = `Prompt ${seq}`): HistoryEntry => ({ event: {
  seq, time: seq, type: 'user/message', surfaceOp: 'append',
  data: { id: `user:${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
} })

describe('conversation search', () => {
  it('lists only human prompts newest first, including image-only messages', () => {
    const messages: ConversationMessage[] = [
      { id: 'a', role: 'user', text: 'First question' },
      { id: 'b', role: 'assistant', text: 'Answer' },
      { id: 'c', role: 'user', text: '', images: [{ attachmentId: 'image', mediaType: 'image/png', width: 10, height: 10 }] },
    ]
    expect(findConversationMessages(messages, '  ')).toEqual({ total: 2, matches: [
      { id: 'c', role: 'user', label: 'You', snippet: 'Image attachment' },
      { id: 'a', role: 'user', label: 'You', snippet: 'First question' },
    ] })
  })

  it('matches literal metacharacters and Unicode case-insensitively, once per message', () => {
    const messages: ConversationMessage[] = [
      { id: 'a', role: 'assistant', text: 'Try Array[0].* (A+B)? $ ^ {x} | \\ on 中文' },
      { id: 'b', role: 'tool', text: 'read', rawInput: 'array[0]', rawResult: 'ARRAY[0]' },
    ]
    expect(findConversationMessages(messages, ' array[0] ').matches.map(match => match.id)).toEqual(['b', 'a'])
    expect(findConversationMessages(messages, '[0].* (A+B)? $ ^ {x} | \\').total).toBe(1)
    expect(findConversationMessages(messages, '中文').total).toBe(1)
    expect(findConversationMessages(messages, '.+').total).toBe(0)
  })

  it('searches full tool output beyond its deferred preview and returns bounded highlighted excerpts', () => {
    const text = 'prefix '.repeat(10_000) + 'Needle <img src=x>' + ' suffix'.repeat(10_000)
    const result = findConversationMessages([{ id: 'tool:a', role: 'tool', text: 'Read large.log', rawResult: text }], 'needle')
    expect(result.total).toBe(1)
    const match = result.matches[0]
    expect(match.label).toBe('Tool · Read large.log')
    expect(match.snippet.length).toBeLessThanOrEqual(222)
    expect(match.snippet.slice(match.matchStart, match.matchStart! + match.matchLength!)).toBe('Needle')
    expect(match.snippet).toContain('<img src=x>') // UI must render this as text, not markup.
    expect(match.snippet.startsWith('…')).toBe(true)
  })

  it('caps displayed results without pretending to return every match', () => {
    const messages: ConversationMessage[] = Array.from({ length: 130 }, (_, index) => ({ id: String(index), role: 'user', text: 'same' }))
    const result = findConversationMessages(messages, 'same')
    expect(result.total).toBe(130)
    expect(result.matches).toHaveLength(100)
    expect(result.matches[0].id).toBe('129')
    expect(result.matches.at(-1)?.id).toBe('30')
  })
})

describe('conversation navigation snapshot', () => {
  it('isolates its history, excludes injected context, and pages only on request', async () => {
    const initial = [prompt(10)]
    const page = vi.fn(async () => ({ events: [prompt(1), prompt(10)], hasMore: false }))
    const navigation = new ConversationNavigation('a', initial, true, page, () => true)
    initial.push(prompt(11))
    expect(navigation.search('').matches.map(match => match.id)).toEqual(['user:10'])
    expect(page).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    await navigation.loadEarlier(signal)
    expect(page).toHaveBeenCalledExactlyOnceWith(10, signal)
    expect(navigation.search('')).toMatchObject({ sessionId: 'a', total: 2, hasMore: false, limited: false })
    expect(navigation.reveal('user:1').entries.map(entry => entry.event.seq)).toEqual([1, 10])
    expect(() => navigation.reveal('forged-id')).toThrow('not in the search snapshot')
    expect(initial).toHaveLength(2)
  })

  it('limits each earlier-history request to three pages and deduplicates overlapping records', async () => {
    const page = vi.fn(async (before: number) => ({ events: [prompt(before - 1), prompt(before - 1), prompt(before)], hasMore: true }))
    const navigation = new ConversationNavigation('a', [prompt(10)], true, page, () => true)
    await navigation.loadEarlier(new AbortController().signal)
    expect(page.mock.calls.map(call => call[0])).toEqual([10, 9, 8])
    expect(navigation.search('')).toMatchObject({ total: 4, hasMore: true, limited: false })
  })

  it('rejects a non-progressing page, allows retry, and accepts an empty terminal page', async () => {
    const page = vi.fn().mockResolvedValueOnce({ events: [prompt(10)], hasMore: true })
      .mockResolvedValueOnce({ events: [], hasMore: false })
    const navigation = new ConversationNavigation('a', [prompt(10)], true, page, () => true)
    await expect(navigation.loadEarlier(new AbortController().signal)).rejects.toThrow('did not advance')
    expect(navigation.search('').hasMore).toBe(true)
    await navigation.loadEarlier(new AbortController().signal)
    expect(navigation.search('').hasMore).toBe(false)
  })

  it.each(['cancel', 'session'])('rejects late pages after %s changes', async reason => {
    const pending = Promise.withResolvers<{ events: HistoryEntry[]; hasMore: boolean }>()
    let current = true
    const navigation = new ConversationNavigation('a', [prompt(10)], true, () => pending.promise, () => current)
    const abort = new AbortController()
    const loading = navigation.loadEarlier(abort.signal)
    const rejection = expect(loading).rejects.toThrow()
    if (reason === 'cancel') abort.abort(); else current = false
    pending.resolve({ events: [prompt(1)], hasMore: false })
    await rejection
    if (current) expect(navigation.search('').total).toBe(1)
    else expect(() => navigation.reveal('user:10')).toThrow('conversation changed')
  })

  it('ignores an older concurrent request that resolves last', async () => {
    const first = Promise.withResolvers<{ events: HistoryEntry[]; hasMore: boolean }>()
    const page = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ events: [prompt(2)], hasMore: false })
    const navigation = new ConversationNavigation('a', [prompt(10)], true, page, () => true)
    const loading = navigation.loadEarlier(new AbortController().signal)
    const rejection = expect(loading).rejects.toThrow('newer history request')
    await navigation.loadEarlier(new AbortController().signal)
    first.resolve({ events: [prompt(1)], hasMore: false }); await rejection
    expect(navigation.search('').matches.map(match => match.id)).toEqual(['user:10', 'user:2'])
  })

  it('reports a bounded snapshot instead of claiming all oversized history was searched', () => {
    const navigation = new ConversationNavigation('a', [prompt(1, 'x'.repeat(8_000_001)), prompt(2)], false, vi.fn(), () => true)
    expect(navigation.search('')).toMatchObject({ total: 1, indexedMessages: 1, limited: true, hasMore: true })
  })
})
