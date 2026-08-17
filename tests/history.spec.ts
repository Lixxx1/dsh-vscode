import { describe, expect, it } from 'vitest'
import { earliestHistorySequence, mergeHistoryEntries } from '../src/history.js'
import type { HistoryEntry } from '../src/dsh-client.js'

function entry(seq: number, label: string): HistoryEntry {
  return { event: { type: 'user/message', seq, time: seq, data: { label } }, view: { label } }
}

describe('history pagination', () => {
  it('prepends older events in sequence order without duplicating an overlapping event', () => {
    const merged = mergeHistoryEntries(
      [entry(10, 'current'), entry(11, 'live')],
      [entry(2, 'older'), entry(10, 'duplicate')],
    )

    expect(merged.map(item => item.event.seq)).toEqual([2, 10, 11])
    expect((merged[1]?.view as { label: string }).label).toBe('current')
    expect(earliestHistorySequence(merged)).toBe(2)
  })
})
