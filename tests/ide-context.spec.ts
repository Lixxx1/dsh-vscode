import { describe, expect, it } from 'vitest'
import {
  mentionedPaths,
  mentionQueryAt,
  replaceTextPreservingIdeContext,
  resolveMentionReferences,
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

  it('edits queued prompt text without dropping its captured context', () => {
    const enriched = withIdeContext('Original request', snapshot)
    const edited = replaceTextPreservingIdeContext(enriched, 'Updated request')

    expect(edited).toContain('"path": "src/extension.ts"')
    expect(withoutIdeContext(edited)).toBe('Updated request')
    expect(replaceTextPreservingIdeContext('Original request', 'Updated request')).toBe('Updated request')
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

  it('offers Problems before file mentions and searches diagnostic messages', () => {
    const candidates = [
      { kind: 'problems' as const, path: 'problems' },
      {
        kind: 'problem' as const,
        path: 'src/app.ts',
        startLine: 18,
        startCharacter: 7,
        severity: 'error' as const,
        message: 'Cannot find name userId',
        source: 'typescript',
      },
      { kind: 'file' as const, path: 'src/app.ts' },
    ]

    expect(searchMentionCandidates(candidates, '')[0]).toEqual({ kind: 'problems', path: 'problems' })
    expect(searchMentionCandidates(candidates, 'userId')).toEqual([candidates[1]])
  })

  it('resolves aggregate and individual diagnostic mentions as IDE context', () => {
    const problem = {
      kind: 'problem' as const,
      path: 'src/app.ts',
      startLine: 18,
      startCharacter: 7,
      endLine: 18,
      endCharacter: 13,
      severity: 'error' as const,
      message: 'Cannot find name userId',
      source: 'typescript',
    }
    const candidates = [{ kind: 'file' as const, path: 'src/app.ts' }]

    expect(resolveMentionReferences(['src/app.ts:18:7'], candidates, [problem])).toEqual([problem])
    expect(resolveMentionReferences(['problems'], candidates, [problem])).toEqual([{
      kind: 'problems',
      path: '.',
      text: JSON.stringify([problem], null, 2),
    }])
  })
})
