import { describe, expect, it } from 'vitest'
import { earliestHistorySequence, mergeHistoryEntries, unseenHistoryEntries } from '../src/history.js'
import type { HistoryEntry } from '../src/dsh-client.js'

function entry(seq: number, label: string): HistoryEntry {
  return { event: { type: 'user/message', seq, time: seq, data: { label } }, view: { label } }
}

describe('history pagination', () => {
  it('prepends older events in sequence order without duplicating an overlapping event', () => {
    const current = [entry(10, 'current'), entry(11, 'live')]
    const incoming = [entry(2, 'older'), entry(10, 'overlap'), entry(2, 'duplicate in page')]
    const unseen = unseenHistoryEntries(current, incoming)
    const merged = mergeHistoryEntries(current, unseen)

    expect(unseen.map(item => item.event.seq)).toEqual([2])
    expect(merged.map(item => item.event.seq)).toEqual([2, 10, 11])
    expect((merged[1]?.view as { label: string }).label).toBe('current')
    expect(earliestHistorySequence(merged)).toBe(2)
  })
})
