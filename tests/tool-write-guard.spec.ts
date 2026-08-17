import { describe, expect, it } from 'vitest'
import type { DshEvent } from '../src/conversation.js'
import { absoluteToolPaths, toolWriteIntents } from '../src/tool-write-guard.js'

function event(type: string, data: unknown): DshEvent {
  return { type, seq: 1, time: 1, data }
}

describe('toolWriteIntents', () => {
  it('detects a write in the completed assistant message before tool dispatch', () => {
    const value = event('assistant/message', {
      message: {
        content: [
          { type: 'text', text: 'I will update it.' },
          { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"file_path":"src/app.ts","content":"x"}' },
        ],
      },
    })

    expect(toolWriteIntents(value)).toEqual([{ callId: 'call-1', paths: ['src/app.ts'] }])
  })

  it('uses the official diff presentation for modifying tools', () => {
    const value = event('tool/call', { callId: 'call-2', name: 'custom_writer', arguments: '{}' })
    const view = {
      for: 'call',
      view: { card: 'diff', title: 'Change files', diffs: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    }

    expect(toolWriteIntents(value, view)).toEqual([{ callId: 'call-2', paths: ['a.ts', 'b.ts'] }])
  })

  it('ignores read-only calls and malformed write arguments', () => {
    expect(toolWriteIntents(event('tool/call', {
      callId: 'read-1', name: 'read', arguments: '{"file_path":"src/app.ts"}',
    }))).toEqual([])
    expect(toolWriteIntents(event('tool/call', {
      callId: 'write-1', name: 'write', arguments: '{broken',
    }))).toEqual([])
  })
})

describe('absoluteToolPaths', () => {
  it('resolves relative paths and preserves absolute paths', () => {
    expect(absoluteToolPaths('/workspace/project', ['src/app.ts', '/shared/config.ts'])).toEqual([
      '/workspace/project/src/app.ts',
      '/shared/config.ts',
    ])
  })
})
