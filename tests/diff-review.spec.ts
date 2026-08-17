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

  it('rebuilds changed files from official DSH diff views and opens a native diff', async () => {
    const manager = new DiffReviewManager()
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

    expect(changed).toEqual([{ turn: 1, files: [{ path: 'src/app.ts', additions: 1, deletions: 1, canRevert: false }] }])
    await manager.reviewFile('session-1', '/workspace', 'src/app.ts')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'before' }),
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'after' }),
      'src/app.ts — DeepSeek changes (Turn 1)',
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
      files: [{ path: 'src/app.ts', additions: 1, deletions: 1, canRevert: true }],
    }])

    expect(manager.revertFile('session-live', cwd, 'src/app.ts', 2)).toEqual([])
    expect(fs.readFileSync(filePath, 'utf8')).toBe('const value = 1\n')
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
