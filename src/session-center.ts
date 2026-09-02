import type { SessionSummary } from './dsh-client.js'

export interface SessionItem {
  id: string
  title: string
  updatedAt: number
  running: boolean
  blank: boolean
  unread: boolean
}

export function sessionTitle(summary: SessionSummary): string {
  const value = summary.projections?.values?.title
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'New conversation'
}

export function sessionItems(
  summaries: readonly SessionSummary[],
  archivedSessionIds: ReadonlySet<string>,
  selectedId: string | undefined,
  unreadSessionIds: ReadonlySet<string>,
): SessionItem[] {
  return summaries
    .filter(summary => !archivedSessionIds.has(summary.sessionId))
    .filter(summary => !summary.blank || summary.sessionId === selectedId)
    .map(summary => ({
      id: summary.sessionId,
      title: sessionTitle(summary),
      updatedAt: summary.updatedAt,
      running: summary.running,
      blank: summary.blank,
      unread: unreadSessionIds.has(summary.sessionId),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export function filterSessionItems(items: readonly SessionItem[], query: string): SessionItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized === '') return [...items]
  return items.filter(item => item.title.toLocaleLowerCase().includes(normalized))
}
