import { describe, expect, it } from 'vitest'
import {
  mentionedPaths,
  mentionQueryAt,
  searchMentionCandidates,
  withIdeContext,
  withoutIdeContext,
  type IdeContextSnapshot,
} from '../src/ide-context.js'

const snapshot: IdeContextSnapshot = {
  activeFile: { kind: 'file', path: 'src/extension.ts', languageId: 'typescript' },
  selection: {
    kind: 'selection',
    path: 'src/extension.ts',
    languageId: 'typescript',
    startLine: 10,
    endLine: 12,
    text: 'const answer = 42',
  },
  pinned: [],
  mentions: [{ kind: 'folder', path: 'tests' }],
}

describe('IDE context', () => {
  it('adds machine-readable editor context without changing the visible request', () => {
    const enriched = withIdeContext('Explain this code', snapshot)

    expect(enriched).toContain('"path": "src/extension.ts"')
    expect(enriched).toContain('"startLine": 10')
    expect(enriched).toContain('const answer = 42')
    expect(withoutIdeContext(enriched)).toBe('Explain this code')
  })

  it('leaves ordinary prompts untouched', () => {
    expect(withoutIdeContext('hello')).toBe('hello')
  })

  it('recognizes inline and braced file mentions', () => {
    expect(mentionedPaths('Check @src/extension.ts and @{docs/design notes.md}.')).toEqual([
      'src/extension.ts',
      'docs/design notes.md',
    ])
    expect(mentionQueryAt('Look at @src/ext', 'Look at @src/ext'.length)).toEqual({
      start: 8,
      query: 'src/ext',
    })
  })

  it('prioritizes basename matches for mention completion', () => {
    expect(searchMentionCandidates([
      { kind: 'file', path: 'src/extension.ts' },
      { kind: 'file', path: 'tests/extension.spec.ts' },
      { kind: 'folder', path: 'src' },
    ], 'ext')).toEqual([
      { kind: 'file', path: 'src/extension.ts' },
      { kind: 'file', path: 'tests/extension.spec.ts' },
    ])
  })
})
