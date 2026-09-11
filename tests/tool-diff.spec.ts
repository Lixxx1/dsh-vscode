import { describe, expect, it } from 'vitest'
import { appliedHunks, diffLineStats, verifiedMutation } from '../src/tool-diff.js'
import type { FileMutation } from '../src/tool-presentation.js'

describe('applied tool diffs', () => {
  const mutation: FileMutation = { kind: 'edit', path: 'app.ts', oldText: 'old', newText: 'new', replaceAll: false }
  const diffs = [{ path: 'app.ts', oldText: 'context\nold\ncontext', newText: 'context\nnew\ncontext' }]

  it('matches the official three-line-context metadata and only counts changed lines', () => {
    expect(appliedHunks('context\nold\ncontext\n', 'context\nnew\ncontext\n')).toEqual(diffs.map(({ path: _, ...diff }) => diff))
    expect(diffLineStats(diffs)).toEqual({ additions: 1, deletions: 1 })
    expect(diffLineStats([{ path: 'new', oldText: null, newText: 'one\ntwo\n' }])).toEqual({ additions: 2, deletions: 0 })
    expect(diffLineStats([{ path: 'empty', oldText: null, newText: '' }])).toEqual({ additions: 0, deletions: 0 })
    expect(diffLineStats([{ path: 'blank-line', oldText: 'context', newText: 'context\n' }], true)).toEqual({ additions: 1, deletions: 0 })
  })

  it('checks both exact captured bytes and applied hunks before enabling undo', () => {
    const before = 'context\nold\ncontext\n'
    const after = 'context\nnew\ncontext\n'
    expect(verifiedMutation(before, after, mutation, diffs, false)).toBe(true)
    expect(verifiedMutation(after, after, mutation, diffs, false)).toBe(false)
    expect(verifiedMutation(before, after + 'user edit\n', mutation, diffs, false)).toBe(false)
    expect(verifiedMutation('other\nold\ncontext\n', 'other\nnew\ncontext\n', mutation, diffs, false)).toBe(false)
    expect(verifiedMutation(before, after, mutation, undefined, false)).toBe(false)
    expect(verifiedMutation(before, after, mutation, [], false)).toBe(false)
  })

  it('verifies replace_all across distinct hunks and CRLF files without losing original bytes', () => {
    const before = ['old', ...Array.from({ length: 12 }, (_, i) => `context ${i}`), 'old', ''].join('\r\n')
    const after = before.replaceAll('old', 'new')
    const diffs = appliedHunks(before, after)!.map(diff => ({ path: 'app.ts', ...diff }))
    expect(diffs).toHaveLength(2)
    expect(diffLineStats(diffs)).toEqual({ additions: 2, deletions: 2 })
    expect(verifiedMutation(before, after, { ...mutation, replaceAll: true }, diffs, false)).toBe(true)
    expect(verifiedMutation(before, after, mutation, diffs, false)).toBe(false)
    expect(verifiedMutation(before, after.replaceAll('\r\n', '\n'), { ...mutation, replaceAll: true }, diffs, false)).toBe(false)
  })

  it('distinguishes new files, overwritten files, unknown bases and no-op writes', () => {
    const write: FileMutation = { kind: 'write', path: 'app.ts', content: 'new\n' }
    expect(verifiedMutation(null, 'new\n', write, [], true)).toBe(true)
    expect(verifiedMutation(null, 'new\n', write, [], false)).toBe(false)
    expect(verifiedMutation(null, 'different', write, [], true)).toBe(false)
    expect(verifiedMutation(null, '', { ...write, content: '' }, [], true)).toBe(true)
    expect(verifiedMutation('old\n', 'new\n', write, [{ path: 'app.ts', oldText: 'old', newText: 'new' }], false)).toBe(true)
    expect(verifiedMutation('old\n', 'new\n', write, [], false)).toBe(false)
    expect(verifiedMutation('new\n', 'new\n', write, [], false)).toBe(false)
    expect(verifiedMutation('\uFEFFold\n', 'new\n', write, [], false)).toBe(false)
  })
})
