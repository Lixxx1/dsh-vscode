import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/dsh-client.js'
import { filterSessionItems, sessionItems, sessionTitle } from '../src/session-center.js'

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    updatedAt: 0,
    running: false,
    blank: false,
    ...overrides,
  }
}

describe('session center state', () => {
  it('uses the official title projection with a friendly blank fallback', () => {
    expect(sessionTitle(summary({ sessionId: 'one', projections: { values: { title: '  Fix login  ' } } }))).toBe('Fix login')
    expect(sessionTitle(summary({ sessionId: 'two', projections: { values: { title: '   ' } } }))).toBe('New conversation')
  })

  it('hides archived and unrelated blank sessions while preserving status metadata', () => {
    const items = sessionItems([
      summary({ sessionId: 'older', updatedAt: 10, running: true }),
      summary({ sessionId: 'newer', updatedAt: 30, projections: { values: { title: 'Latest work' } } }),
      summary({ sessionId: 'blank-selected', updatedAt: 20, blank: true }),
      summary({ sessionId: 'blank-hidden', updatedAt: 40, blank: true }),
      summary({ sessionId: 'archived', updatedAt: 50 }),
    ], new Set(['archived']), 'blank-selected', new Set(['newer']))

    expect(items).toEqual([
      expect.objectContaining({ id: 'newer', title: 'Latest work', unread: true }),
      expect.objectContaining({ id: 'blank-selected', blank: true }),
      expect.objectContaining({ id: 'older', running: true }),
    ])
  })

  it('searches titles case-insensitively without changing recency order', () => {
    const items = sessionItems([
      summary({ sessionId: 'one', updatedAt: 20, projections: { values: { title: 'Fix Windows paths' } } }),
      summary({ sessionId: 'two', updatedAt: 10, projections: { values: { title: 'Review PATH handling' } } }),
      summary({ sessionId: 'three', updatedAt: 30, projections: { values: { title: 'Write docs' } } }),
    ], new Set(), undefined, new Set())

    expect(filterSessionItems(items, 'path').map(item => item.id)).toEqual(['one', 'two'])
  })
})
