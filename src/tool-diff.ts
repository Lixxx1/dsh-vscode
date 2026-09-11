import { diffLines, structuredPatch } from 'diff'
import type { FileDiff, FileMutation } from './tool-presentation.js'

export function normalizeDiffText(text: string): string { return text.replaceAll('\r\n', '\n') }

/** Match the official three-context-line metadata without treating context as changed lines. */
export function appliedHunks(before: string, after: string): Array<Omit<FileDiff, 'path'>> | undefined {
  const patch = structuredPatch('', '', normalizeDiffText(before), normalizeDiffText(after), undefined, undefined,
    { context: 3, timeout: 100 })
  return patch?.hunks.map(hunk => {
    const side = (excluded: string): string[] => hunk.lines
      .filter(line => !line.startsWith(excluded) && !line.startsWith('\\'))
      .map(line => line.slice(1))
    const old = side('+')
    return { oldText: old.length === 0 ? null : old.join('\n'), newText: side('-').join('\n') }
  })
}

export function diffLineStats(diffs: readonly FileDiff[], contextualHunks = false): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const diff of diffs) {
    const before = normalizeDiffText(diff.oldText ?? '')
    const after = normalizeDiffText(diff.newText)
    // In a hunk, a trailing LF separates an actual empty context line; it is not
    // the file's final newline. Preserve it when counting fragment-only history.
    const lines = (text: string): string => text === '' ? '' : (contextualHunks ? text : text.replace(/\n$/, '')) + '\n'
    const changes = diffLines(lines(before), lines(after), { timeout: 100 })
    if (changes === undefined) continue
    for (const change of changes) {
      if (change.added) additions += change.count
      if (change.removed) deletions += change.count
    }
  }
  return { additions, deletions }
}

/** Full-file undo is available only when the captured file and applied metadata agree. */
export function verifiedMutation(before: string | null, after: string | null, mutation: FileMutation,
  applied: readonly FileDiff[] | undefined, created: boolean): boolean {
  if (after === null || (before?.startsWith('\uFEFF') ?? false)) return false
  let expected: string
  if (mutation.kind === 'write') {
    expected = mutation.content
    if (before === null) return created && after === expected
    if (created) return false
  } else {
    if (before === null) return false
    const normalized = normalizeDiffText(before)
    const old = normalizeDiffText(mutation.oldText)
    const parts = normalized.split(old)
    if (old === '' || parts.length < 2 || (!mutation.replaceAll && parts.length !== 2)) return false
    expected = parts.join(normalizeDiffText(mutation.newText))
    const sample = before.slice(0, 4096)
    const crlf = sample.split('\r\n').length - 1
    const lf = sample.split('\n').length - 1 - crlf
    if (crlf > lf) expected = expected.replaceAll('\n', '\r\n')
  }
  if (after !== expected || before === after || applied === undefined) return false
  const computed = appliedHunks(before, after)
  return computed !== undefined && computed.length === applied.length && computed.every((diff, index) =>
    diff.oldText === applied[index]?.oldText && diff.newText === applied[index]?.newText)
}
