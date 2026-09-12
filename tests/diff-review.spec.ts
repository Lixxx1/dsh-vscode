import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(), textDocuments: [] as Array<{ isDirty: boolean; uri: { fsPath: string } }> }))

vi.mock('vscode', () => {
  class EventEmitter {
    event = (): { dispose(): void } => ({ dispose() {} })
    dispose(): void {}
  }
  return {
    EventEmitter,
    Uri: {
      from(value: { scheme: string; authority: string; path: string }) {
        return { ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }
      },
    },
    commands: { executeCommand: mocks.executeCommand },
    workspace: { textDocuments: mocks.textDocuments },
    window: { showInformationMessage: vi.fn() },
  }
})

import type { DshEvent } from '../src/conversation.js'
import { DiffReviewManager } from '../src/diff-review.js'
import { appliedHunks } from '../src/tool-diff.js'

function event(type: string, seq: number, data: unknown): DshEvent {
  return { type, seq, time: seq, data }
}

describe('DiffReviewManager', () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => { mocks.executeCommand.mockReset(); mocks.textDocuments.splice(0) })
  afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

  function temporaryWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-diff-'))
    temporaryDirectories.push(directory)
    return directory
  }

  function modernEvents(name: 'edit' | 'write', args: Record<string, unknown>, before: string | null, after: string, turn = 1) {
    const callId = `modern-${turn}`
    const call = event('tool/call', turn * 10, { turn, callId, name, arguments: JSON.stringify(args) })
    const text = name === 'write'
      ? `<path>${args.file_path}</path>\n<type>file</type>\n<content>\n${before === null ? 'Created' : 'Updated'} file\n</content>`
      : `The file ${args.file_path} has been updated successfully.`
    const result = event('tool/result', turn * 10 + 1, { turn,
      meta: { diffs: before === null ? [] : appliedHunks(before, after)?.map(diff => ({ path: args.file_path, ...diff })) },
      message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] },
    })
    return { call, result }
  }

  it('reviews and reverts rc.1 applied hunks, retaining complete snapshots across history rebuilds', async () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    const before = 'context\nold\ncontext\n', after = 'context\nnew\ncontext\n'
    const { call, result } = modernEvents('edit', { file_path: 'app.ts', old_string: 'old', new_string: 'new' }, before, after)
    const manager = new DiffReviewManager()
    fs.writeFileSync(file, before)
    manager.accept('modern', cwd, call)
    fs.writeFileSync(file, after)
    expect(manager.accept('modern', cwd, result)).toBe(true)
    const expected = [{ turn: 1, files: [{ path: 'app.ts', additions: 1, deletions: 1, canRevert: true }] }]
    expect(manager.changedFiles('modern')).toEqual(expected)
    const entries = [call, result].map(event => ({ event }))
    expect(manager.rebuild('modern', cwd, entries)).toEqual(expected)
    expect(manager.prependHistory('modern', cwd, entries)).toEqual(expected)
    await manager.reviewFile('modern', cwd, 'app.ts', 1)
    const [, beforeUri, afterUri] = mocks.executeCommand.mock.calls.at(-1)!
    expect(manager.provideTextDocumentContent(beforeUri)).toBe(before)
    expect(manager.provideTextDocumentContent(afterUri)).toBe(after)
    expect(manager.revertFile('modern', cwd, 'app.ts', 1)).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('captures the early assistant tool intent before the later tool/call notification', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    const args = { file_path: 'app.ts', old_string: 'old', new_string: 'new' }
    const { call, result } = modernEvents('edit', args, 'old\n', 'new\n')
    const manager = new DiffReviewManager()
    fs.writeFileSync(file, 'old\n')
    manager.accept('early', cwd, event('assistant/message', 9, { turn: 1, message: { content: [
      { type: 'tool-call', id: 'modern-1', name: 'edit', arguments: JSON.stringify(args) },
    ] } }))
    fs.writeFileSync(file, 'new\n')
    manager.accept('early', cwd, call)
    manager.accept('early', cwd, result)
    expect(manager.changedFiles('early')[0]?.files[0]?.canRevert).toBe(true)
  })

  it('does not invent a reversible full file from replayed hunks or a late snapshot', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    const { call, result } = modernEvents('edit', { file_path: 'app.ts', old_string: 'old', new_string: 'new' }, 'old\n', 'new\n')
    fs.writeFileSync(file, 'new\n')
    for (const replay of [true, false]) {
      const manager = new DiffReviewManager()
      manager.accept('late', cwd, call, undefined, replay)
      manager.accept('late', cwd, result, undefined, replay)
      expect(manager.changedFiles('late')).toEqual([{ turn: 1, files: [{ path: 'app.ts', additions: 1, deletions: 1, canRevert: false }] }])
      expect(() => manager.revertAll('late')).toThrow('full snapshot')
      expect(fs.readFileSync(file, 'utf8')).toBe('new\n')
    }
  })

  it.each(['', 'one\ntwo\n'])('safely reverts an explicitly created rc.1 file containing %j', content => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'new.ts')
    const { call, result } = modernEvents('write', { file_path: 'new.ts', content }, null, content)
    const manager = new DiffReviewManager()
    manager.accept('create', cwd, call)
    fs.writeFileSync(file, content)
    manager.accept('create', cwd, result)
    expect(manager.changedFiles('create')[0]?.files[0]?.canRevert).toBe(true)
    manager.revertAll('create')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('rejects dirty buffers and subsequent user edits, while Keep leaves bytes untouched', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    const { call, result } = modernEvents('write', { file_path: 'app.ts', content: 'new\n' }, 'old\n', 'new\n')
    const manager = new DiffReviewManager()
    fs.writeFileSync(file, 'old\n')
    manager.accept('dirty', cwd, call)
    fs.writeFileSync(file, 'new\n')
    manager.accept('dirty', cwd, result)
    mocks.textDocuments.push({ isDirty: true, uri: { fsPath: file } })
    expect(() => manager.revertAll('dirty')).toThrow('unsaved')
    mocks.textDocuments.splice(0)
    fs.writeFileSync(file, 'manual edit\n')
    expect(() => manager.revertAll('dirty')).toThrow('changed after DeepSeek')
    expect(manager.keepAll('dirty')).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('manual edit\n')
  })

  it('ignores failed results, empty overwrite metadata, malformed metadata and opaque plugin metadata', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    for (const variant of ['failure', 'empty', 'malformed', 'plugin', 'wrong-path']) {
      const { call, result } = modernEvents('write', { file_path: 'app.ts', content: 'new\n' }, 'old\n', 'new\n')
      if (variant === 'failure') (result.data as any).error = { message: 'denied' }
      if (variant === 'empty') (result.data as any).meta = { diffs: [] }
      if (variant === 'malformed') (result.data as any).meta = { diffs: [null] }
      if (variant === 'plugin') (call.data as any).name = 'mcp__plugin__write'
      if (variant === 'wrong-path') (result.data as any).meta.diffs[0].path = 'other.ts'
      const manager = new DiffReviewManager()
      fs.writeFileSync(file, 'old\n')
      manager.accept(variant, cwd, call)
      fs.writeFileSync(file, 'new\n')
      manager.accept(variant, cwd, result)
      expect(manager.changedFiles(variant)).toEqual([])
    }
  })

  it('validates a continuous rc.1 multi-turn edit chain before Revert All', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    const manager = new DiffReviewManager()
    let before = 'original\r\n'
    fs.writeFileSync(file, before)
    for (const turn of [1, 2]) {
      const after = `turn ${turn}\r\n`
      const { call, result } = modernEvents('write', { file_path: 'app.ts', content: after }, before, after, turn)
      manager.accept('series', cwd, call)
      fs.writeFileSync(file, after)
      manager.accept('series', cwd, result)
      before = after
    }
    expect(manager.changedFiles('series').map(group => group.files[0]?.canRevert)).toEqual([true, true])
    manager.revertAll('series')
    expect(fs.readFileSync(file, 'utf8')).toBe('original\r\n')
  })

  it('does not enable Revert for a binary or oversized captured file', () => {
    const cwd = temporaryWorkspace(), file = path.join(cwd, 'app.ts')
    for (const before of ['old\0bytes', 'x'.repeat(5 * 1024 * 1024 + 1)]) {
      const { call, result } = modernEvents('write', { file_path: 'app.ts', content: 'new\n' }, 'old\n', 'new\n')
      const manager = new DiffReviewManager()
      fs.writeFileSync(file, before)
      manager.accept('bounded', cwd, call)
      fs.writeFileSync(file, 'new\n')
      manager.accept('bounded', cwd, result)
      expect(manager.changedFiles('bounded')[0]?.files[0]?.canRevert).toBe(false)
      expect(() => manager.revertAll('bounded')).toThrow('full snapshot')
      expect(fs.readFileSync(file, 'utf8')).toBe('new\n')
    }
  })

  it.skipIf(process.platform === 'win32')('does not track symlink escapes or revert through a changed symlink target', () => {
    const cwd = temporaryWorkspace(), outside = temporaryWorkspace()
    fs.symlinkSync(outside, path.join(cwd, 'external'))
    const escaped = modernEvents('write', { file_path: 'external/new.ts', content: 'new\n' }, null, 'new\n')
    const manager = new DiffReviewManager()
    manager.accept('escape', cwd, escaped.call)
    fs.writeFileSync(path.join(outside, 'new.ts'), 'new\n')
    manager.accept('escape', cwd, escaped.result)
    expect(manager.changedFiles('escape')).toEqual([])

    const file = path.join(cwd, 'a.ts'), other = path.join(cwd, 'b.ts'), link = path.join(cwd, 'link.ts')
    fs.writeFileSync(file, 'old\n'); fs.writeFileSync(other, 'new\n'); fs.symlinkSync(file, link)
    const { call, result } = modernEvents('edit', { file_path: 'link.ts', old_string: 'old', new_string: 'new' }, 'old\n', 'new\n')
    manager.accept('link', cwd, call)
    fs.writeFileSync(file, 'new\n')
    manager.accept('link', cwd, result)
    fs.unlinkSync(link); fs.symlinkSync(other, link)
    expect(() => manager.revertAll('link')).toThrow('target changed')
    expect(fs.readFileSync(other, 'utf8')).toBe('new\n')
    expect(manager.rebuild('link', cwd, [call, result].map(event => ({ event })))[0]?.files[0]?.canRevert).toBe(false)
  })

  it('rebuilds changed files from official DSH diff views and opens a native diff', async () => {
    const manager = new DiffReviewManager()
    const displayPath = path.join('src', 'app.ts')
    const changed = manager.rebuild('session-1', '/workspace', [
      {
        event: event('tool/call', 1, { turn: 1, step: 1, callId: 'call-1', name: 'edit', arguments: '{}' }),
        view: {
          for: 'call',
          view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }] },
        },
      },
      {
        event: event('tool/result', 2, {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'call-1' },
            content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false }],
          },
        }),
        view: {
          for: 'result',
          view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }] },
        },
      },
    ])

    expect(changed).toEqual([{ turn: 1, files: [{ path: displayPath, additions: 1, deletions: 1, canRevert: false }] }])
    await manager.reviewFile('session-1', '/workspace', 'src/app.ts')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'before' }),
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'after' }),
      `${displayPath} — DeepSeek changes (Turn 1)`,
      { preview: true },
    )
  })

  it('does not list a failed file edit as an applied change', () => {
    const manager = new DiffReviewManager()
    const changed = manager.rebuild('session-2', '/workspace', [
      {
        event: event('tool/call', 1, { callId: 'call-2', name: 'write', arguments: '{}' }),
        view: {
          for: 'call',
          view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: null, newText: 'new' }] },
        },
      },
      {
        event: event('tool/result', 2, {
          error: { code: 'FAILED' },
          message: {
            source: { kind: 'tool', callId: 'call-2' },
            content: [{ type: 'tool-result', toolCallId: 'call-2', isError: true }],
          },
        }),
      },
    ])

    expect(changed).toEqual([])
  })

  it('groups live changes by turn and safely reverts an unchanged file', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'src', 'app.ts')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'const value = 1\n')
    const manager = new DiffReviewManager()
    const call = event('tool/call', 1, { turn: 2, step: 1, callId: 'call-live', name: 'edit', arguments: '{}' })
    const result = event('tool/result', 2, {
      turn: 2,
      step: 1,
      message: { source: { kind: 'tool', callId: 'call-live' }, content: [{ type: 'tool-result', toolCallId: 'call-live', isError: false }] },
    })
    const callView = { for: 'call', view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: 'const value = 1', newText: 'const value = 2' }] } }
    const resultView = { for: 'result', view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: 'const value = 1', newText: 'const value = 2' }] } }

    manager.accept('session-live', cwd, call, callView)
    fs.writeFileSync(filePath, 'const value = 2\n')
    expect(manager.accept('session-live', cwd, result, resultView)).toBe(true)
    expect(manager.changedFiles('session-live')).toEqual([{
      turn: 2,
      files: [{ path: path.join('src', 'app.ts'), additions: 1, deletions: 1, canRevert: true }],
    }])

    expect(manager.revertFile('session-live', cwd, 'src/app.ts', 2)).toEqual([])
    expect(fs.readFileSync(filePath, 'utf8')).toBe('const value = 1\n')
  })

  it('treats differently cased aliases as the same file on a case-insensitive filesystem', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'CaseFile.ts')
    fs.writeFileSync(filePath, 'before\n')
    if (!fs.existsSync(path.join(cwd, 'casefile.ts'))) return
    const manager = new DiffReviewManager()
    const callId = 'case-insensitive-path'
    const call = event('tool/call', 1, { turn: 1, callId, name: 'edit' })
    const result = event('tool/result', 2, {
      turn: 1,
      message: { source: { kind: 'tool', callId }, content: [] },
    })
    const view = (forValue: 'call' | 'result', fileName: string) => ({
      for: forValue,
      view: { card: 'diff', diffs: [{ path: fileName, oldText: 'before', newText: 'after' }] },
    })

    manager.accept('session-case', cwd, call, view('call', 'CaseFile.ts'))
    fs.writeFileSync(filePath, 'after\n')
    expect(manager.accept('session-case', cwd, result, view('result', 'casefile.ts'))).toBe(true)
    expect(manager.changedFiles('session-case')).toEqual([{
      turn: 1,
      files: [{ path: 'CaseFile.ts', additions: 1, deletions: 1, canRevert: true }],
    }])
    expect(manager.revertFile('session-case', cwd, 'casefile.ts', 1)).toEqual([])
    expect(fs.readFileSync(filePath, 'utf8')).toBe('before\n')
  })

  it('keeps differently cased files separate on a case-sensitive filesystem', () => {
    const cwd = temporaryWorkspace()
    const upperPath = path.join(cwd, 'App.ts')
    const lowerPath = path.join(cwd, 'app.ts')
    fs.writeFileSync(upperPath, 'upper-before\n')
    fs.writeFileSync(lowerPath, 'lower-before\n')
    if (fs.readFileSync(upperPath, 'utf8') !== 'upper-before\n') return

    const manager = new DiffReviewManager()
    const callId = 'case-sensitive-paths'
    const diffs = [
      { path: 'App.ts', oldText: 'upper-before', newText: 'upper-after' },
      { path: 'app.ts', oldText: 'lower-before', newText: 'lower-after' },
    ]
    manager.accept(
      'session-sensitive',
      cwd,
      event('tool/call', 1, { turn: 1, callId, name: 'edit' }),
      { for: 'call', view: { card: 'diff', diffs } },
    )
    fs.writeFileSync(upperPath, 'upper-after\n')
    fs.writeFileSync(lowerPath, 'lower-after\n')
    expect(manager.accept(
      'session-sensitive',
      cwd,
      event('tool/result', 2, { turn: 1, message: { source: { kind: 'tool', callId }, content: [] } }),
      { for: 'result', view: { card: 'diff', diffs } },
    )).toBe(true)

    expect(manager.changedFiles('session-sensitive')).toEqual([{
      turn: 1,
      files: [
        { path: 'App.ts', additions: 1, deletions: 1, canRevert: true },
        { path: 'app.ts', additions: 1, deletions: 1, canRevert: true },
      ],
    }])
    expect(manager.revertAll('session-sensitive')).toEqual([])
    expect(fs.readFileSync(upperPath, 'utf8')).toBe('upper-before\n')
    expect(fs.readFileSync(lowerPath, 'utf8')).toBe('lower-before\n')
  })

  it('prepends older review history without losing reversible live snapshots', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'current.ts')
    fs.writeFileSync(filePath, 'before\n')
    const manager = new DiffReviewManager()
    const liveCall = event('tool/call', 20, { turn: 2, callId: 'live', name: 'edit' })
    const liveResult = event('tool/result', 21, {
      turn: 2,
      message: { source: { kind: 'tool', callId: 'live' }, content: [{ type: 'tool-result', toolCallId: 'live' }] },
    })
    const liveCallView = { for: 'call', view: { card: 'diff', diffs: [{ path: 'current.ts', oldText: 'before', newText: 'after' }] } }
    const liveResultView = { for: 'result', view: { card: 'diff', diffs: [{ path: 'current.ts', oldText: 'before', newText: 'after' }] } }
    manager.accept('session-pages', cwd, liveCall, liveCallView)
    fs.writeFileSync(filePath, 'after\n')
    manager.accept('session-pages', cwd, liveResult, liveResultView)

    const changed = manager.prependHistory('session-pages', cwd, [
      {
        event: event('tool/call', 1, { turn: 1, callId: 'older', name: 'write' }),
        view: { for: 'call', view: { card: 'diff', diffs: [{ path: 'old.ts', oldText: null, newText: 'old' }] } },
      },
      {
        event: event('tool/result', 2, {
          turn: 1,
          message: { source: { kind: 'tool', callId: 'older' }, content: [{ type: 'tool-result', toolCallId: 'older' }] },
        }),
        view: { for: 'result', view: { card: 'diff', diffs: [{ path: 'old.ts', oldText: null, newText: 'old' }] } },
      },
    ])

    expect(changed.find(group => group.turn === 2)?.files[0]?.canRevert).toBe(true)
    expect(changed.find(group => group.turn === 1)?.files[0]?.canRevert).toBe(false)
  })

  it('refuses to overwrite a file changed after DeepSeek edited it', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'app.ts')
    fs.writeFileSync(filePath, 'before\n')
    const manager = new DiffReviewManager()
    const call = event('tool/call', 1, { turn: 3, step: 1, callId: 'call-conflict', name: 'edit', arguments: '{}' })
    const result = event('tool/result', 2, {
      turn: 3,
      step: 1,
      message: { source: { kind: 'tool', callId: 'call-conflict' }, content: [{ type: 'tool-result', toolCallId: 'call-conflict', isError: false }] },
    })
    const view = (forValue: 'call' | 'result') => ({ for: forValue, view: { card: 'diff', diffs: [{ path: 'app.ts', oldText: 'before', newText: 'after' }] } })
    manager.accept('session-conflict', cwd, call, view('call'))
    fs.writeFileSync(filePath, 'after\n')
    manager.accept('session-conflict', cwd, result, view('result'))
    mocks.textDocuments.push({ isDirty: true, uri: { fsPath: filePath } })
    expect(() => manager.revertFile('session-conflict', cwd, 'app.ts', 3)).toThrow('unsaved VS Code changes')
    mocks.textDocuments.splice(0)
    fs.writeFileSync(filePath, 'user edit\n')

    expect(() => manager.revertFile('session-conflict', cwd, 'app.ts', 3)).toThrow('the file changed after DeepSeek edited it')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('user edit\n')
    expect(manager.changedFiles('session-conflict')).toHaveLength(1)
  })

  it('reverts a continuous chain of changes across turns', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'app.ts')
    fs.writeFileSync(filePath, 'one')
    const manager = new DiffReviewManager()
    const apply = (turn: number, before: string, after: string) => {
      const callId = `call-${String(turn)}`
      const call = event('tool/call', turn * 2, { turn, step: 1, callId, name: 'edit', arguments: '{}' })
      const result = event('tool/result', turn * 2 + 1, { turn, step: 1, message: { source: { kind: 'tool', callId }, content: [] } })
      const view = (forValue: 'call' | 'result') => ({ for: forValue, view: { card: 'diff', diffs: [{ path: 'app.ts', oldText: before, newText: after }] } })
      manager.accept('session-chain', cwd, call, view('call'))
      fs.writeFileSync(filePath, after)
      manager.accept('session-chain', cwd, result, view('result'))
    }
    apply(1, 'one', 'two')
    apply(2, 'two', 'three')

    expect(manager.changedFiles('session-chain').map(group => group.turn)).toEqual([2, 1])
    expect(manager.revertAll('session-chain')).toEqual([])
    expect(fs.readFileSync(filePath, 'utf8')).toBe('one')
  })

  it('validates every file before reverting all changes', () => {
    const cwd = temporaryWorkspace()
    const firstPath = path.join(cwd, 'first.ts')
    const secondPath = path.join(cwd, 'second.ts')
    fs.writeFileSync(firstPath, 'first-before')
    fs.writeFileSync(secondPath, 'second-before')
    const manager = new DiffReviewManager()
    const diffs = [
      { path: 'first.ts', oldText: 'first-before', newText: 'first-after' },
      { path: 'second.ts', oldText: 'second-before', newText: 'second-after' },
    ]
    manager.accept('session-atomic', cwd, event('tool/call', 1, { turn: 1, step: 1, callId: 'call-atomic', name: 'edit', arguments: '{}' }), { for: 'call', view: { card: 'diff', diffs } })
    fs.writeFileSync(firstPath, 'first-after')
    fs.writeFileSync(secondPath, 'second-after')
    manager.accept('session-atomic', cwd, event('tool/result', 2, { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-atomic' }, content: [] } }), { for: 'result', view: { card: 'diff', diffs } })
    fs.writeFileSync(secondPath, 'user-edit')

    expect(() => manager.revertAll('session-atomic')).toThrow('the file changed after DeepSeek edited it')
    expect(fs.readFileSync(firstPath, 'utf8')).toBe('first-after')
    expect(fs.readFileSync(secondPath, 'utf8')).toBe('user-edit')
  })

  it('keeps a reviewed change without touching the file', () => {
    const cwd = temporaryWorkspace()
    const filePath = path.join(cwd, 'app.ts')
    fs.writeFileSync(filePath, 'before')
    const manager = new DiffReviewManager()
    const call = event('tool/call', 1, { turn: 4, step: 1, callId: 'call-keep', name: 'edit', arguments: '{}' })
    const result = event('tool/result', 2, { turn: 4, step: 1, message: { source: { kind: 'tool', callId: 'call-keep' }, content: [] } })
    const view = (forValue: 'call' | 'result') => ({ for: forValue, view: { card: 'diff', diffs: [{ path: 'app.ts', oldText: 'before', newText: 'after' }] } })
    manager.accept('session-keep', cwd, call, view('call'))
    fs.writeFileSync(filePath, 'after')
    manager.accept('session-keep', cwd, result, view('result'))

    expect(manager.keepFile('session-keep', cwd, 'app.ts', 4)).toEqual([])
    expect(fs.readFileSync(filePath, 'utf8')).toBe('after')
  })
})
