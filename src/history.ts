import type { HistoryEntry } from './dsh-client.js'

/** Merge backwards history pages with live entries using the append-log sequence as identity. */
export function mergeHistoryEntries(
  current: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
): HistoryEntry[] {
  const bySequence = new Map<number, HistoryEntry>()
  for (const entry of current) bySequence.set(entry.event.seq, entry)
  for (const entry of incoming) if (!bySequence.has(entry.event.seq)) bySequence.set(entry.event.seq, entry)
  return [...bySequence.values()].sort((left, right) => left.event.seq - right.event.seq)
}

/** Keep only entries whose append-log sequence has not already been loaded. */
export function unseenHistoryEntries(
  current: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
): HistoryEntry[] {
  const seen = new Set(current.map(entry => entry.event.seq))
  return incoming.filter((entry) => {
    if (seen.has(entry.event.seq)) return false
    seen.add(entry.event.seq)
    return true
  })
}

export function earliestHistorySequence(entries: readonly HistoryEntry[]): number | undefined {
  let earliest: number | undefined
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.event.seq) || entry.event.seq < 0) continue
    if (earliest === undefined || entry.event.seq < earliest) earliest = entry.event.seq
  }
  return earliest
}
