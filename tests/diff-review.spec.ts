import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn() }))

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
    window: { showInformationMessage: vi.fn() },
  }
})

import type { DshEvent } from '../src/conversation.js'
import { DiffReviewManager } from '../src/diff-review.js'

function event(type: string, seq: number, data: unknown): DshEvent {
  return { type, seq, time: seq, data }
}

describe('DiffReviewManager', () => {
  beforeEach(() => { mocks.executeCommand.mockReset() })

  it('rebuilds changed files from official DSH diff views and opens a native diff', async () => {
    const manager = new DiffReviewManager()
    const changed = manager.rebuild('session-1', '/workspace', [
      {
        event: event('tool/call', 1, { callId: 'call-1', name: 'edit', arguments: '{}' }),
        view: {
          for: 'call',
          view: { card: 'diff', diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }] },
        },
      },
      {
        event: event('tool/result', 2, {
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

    expect(changed).toEqual([{ path: 'src/app.ts' }])
    await manager.reviewFile('session-1', '/workspace', 'src/app.ts')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'before' }),
      expect.objectContaining({ scheme: 'dsh-diff', authority: 'after' }),
      'src/app.ts — DeepSeek changes',
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
})
