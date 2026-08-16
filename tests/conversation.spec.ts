import { describe, expect, it } from 'vitest'
import { ConversationProjector, type DshEvent } from '../src/conversation.js'

function event(type: string, seq: number, data: unknown): DshEvent {
  return { type, seq, time: seq, data }
}

describe('ConversationProjector', () => {
  it('keeps human prompts and final assistant text while excluding injected plugin context', () => {
    const projector = new ConversationProjector()
    projector.reset([
      event('user/message', 1, { id: 'plugin', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'hidden context' }] }),
      event('user/message', 2, { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
      event('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Hi' } }),
      event('assistant/message', 4, { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'Hi there' }] } }),
    ])

    expect(projector.messages()).toEqual([
      { id: 'human', role: 'user', text: 'hello' },
      { id: 'assistant:1:1', role: 'assistant', text: 'Hi there' },
    ])
  })

  it('updates one streaming assistant row instead of duplicating chunks', () => {
    const projector = new ConversationProjector()
    projector.apply(event('assistant/chunk', 1, { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'A' } }))
    projector.apply(event('assistant/chunk', 2, { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'B' } }))

    expect(projector.messages()).toEqual([
      { id: 'assistant:2:1', role: 'assistant', text: 'AB', streaming: true },
    ])
  })

  it('correlates official tool results through message.source.callId', () => {
    const projector = new ConversationProjector()
    projector.apply(event('tool/call', 1, { callId: 'call-1', name: 'bash' }))
    projector.apply(event('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false }],
      },
    }))

    expect(projector.messages()).toEqual([
      { id: 'tool:call-1', role: 'tool', text: 'bash', detail: 'Completed', failed: false },
    ])
  })

  it('keeps official call and result presentation views for rich tool cards', () => {
    const projector = new ConversationProjector()
    projector.apply(event('tool/call', 1, {
      callId: 'call-rich',
      name: 'bash',
      arguments: '{"command":"pnpm test"}',
    }), {
      for: 'call',
      view: { card: 'terminal', title: 'pnpm test', cwd: '/workspace' },
    })
    projector.apply(event('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-rich' },
        content: [{ type: 'tool-result', toolCallId: 'call-rich', content: [{ type: 'text', text: 'passed' }] }],
      },
    }), {
      for: 'result',
      view: { card: 'terminal', output: 'passed', exitCode: 0 },
    })

    expect(projector.messages()).toEqual([expect.objectContaining({
      id: 'tool:call-rich',
      callView: { card: 'terminal', title: 'pnpm test', cwd: '/workspace' },
      resultView: { card: 'terminal', output: 'passed', exitCode: 0 },
      rawInput: '{"command":"pnpm test"}',
      rawResult: 'passed',
    })])
  })
})
