import { describe, expect, it } from 'vitest'
import { assistantStreamAppend, ConversationProjector, type DshEvent } from '../src/conversation.js'
import { withIdeContext } from '../src/ide-context.js'

function event(type: string, seq: number, data: unknown): DshEvent {
  return { type, seq, time: seq, data }
}

describe('ConversationProjector', () => {
  it('annotates all assistant steps and tool results after the full turn ends', () => {
    const projector = new ConversationProjector()
    const entries = [
      event('assistant/message', 1, { turn: 7, step: 0, message: { content: [{ type: 'reasoning', text: 'first' }] } }),
      event('tool/call', 2, { turn: 7, callId: 'call-1', name: 'Read' }),
      event('tool/result', 3, { message: { source: { kind: 'tool', callId: 'call-1' }, content: [] } }),
      event('assistant/message', 4, { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }),
      event('turn/end', 5, { turn: 7 }),
    ]
    for (const entry of entries.slice(0, -1)) projector.apply(entry)
    expect(projector.messages().map(message => [message.turn, message.turnEnded])).toEqual([[7, undefined], [7, undefined], [7, undefined]])
    projector.apply(entries[4]!)
    expect(projector.messages().map(message => [message.turn, message.turnEnded])).toEqual([[7, true], [7, true], [7, true]])
    const completed = projector.messages()
    projector.reset(entries)
    expect(projector.messages()).toEqual(completed)
    projector.reset(entries.slice(0, -1))
    expect(projector.messages().every(message => message.turnEnded === undefined)).toBe(true)
  })

  it('marks a turn as started only when its start event is loaded', () => {
    const projector = new ConversationProjector()
    const start = event('turn/start', 1, { turn: 7 })
    const answer = event('assistant/message', 2, { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } })
    projector.reset([answer])
    expect(projector.messages()[0]?.turnStarted).toBeUndefined()
    projector.reset([start, answer])
    expect(projector.messages()[0]).toMatchObject({ turn: 7, turnStarted: true })
    projector.reset([answer])
    expect(projector.messages()[0]?.turnStarted).toBeUndefined()
  })

  it('validates turn IDs and preserves the live stream during a history reset', () => {
    const projector = new ConversationProjector()
    projector.apply(event('assistant/message', 1, { turn: -1, step: 0, message: { content: [{ type: 'text', text: 'invalid' }] } }))
    projector.apply(event('tool/call', 2, { turn: 1.5, callId: 'invalid', name: 'Read' }))
    projector.apply(event('turn/end', 3, { turn: -1 }))
    projector.apply(event('turn/start', 3, { turn: -1 }))
    expect(projector.messages().every(message => message.turn === undefined && message.turnStarted === undefined && message.turnEnded === undefined)).toBe(true)
    projector.applyStream({ kind: 'start', attemptId: 'live', turn: 9, step: 0 })
    projector.applyStream({ kind: 'chunk', attemptId: 'live', chunk: { type: 'text-delta', text: 'a' }, time: 4 })
    const before = projector.messages().at(-1)!
    projector.reset([event('turn/start', 3, { turn: 9 }), event('turn/end', 4, { turn: 9 })], true)
    expect(projector.messages()[0]).toMatchObject({ turn: 9, turnStarted: true, turnEnded: true, text: 'a' })
    projector.applyStream({ kind: 'chunk', attemptId: 'live', chunk: { type: 'text-delta', text: 'b' }, time: 5 })
    expect(assistantStreamAppend(before, projector.messages()[0]!)).toBe('b')
    projector.reset([], true)
    expect(projector.messages()[0]?.turnStarted).toBeUndefined()
    expect(projector.messages()[0]?.turnEnded).toBeUndefined()
  })
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
      { id: 'assistant:1:1', role: 'assistant', text: 'Hi there', turn: 1, reasoning: { text: 'private', active: false, tokens: 2, estimated: true } },
    ])
  })

  it('updates one streaming assistant row instead of duplicating chunks', () => {
    const projector = new ConversationProjector()
    projector.apply(event('assistant/chunk', 1, { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'A' } }))
    projector.apply(event('assistant/chunk', 2, { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'B' } }))

    expect(projector.messages()).toEqual([
      { id: 'assistant:2:1', role: 'assistant', text: 'AB', streaming: true, turn: 2 },
    ])
  })

  it('hides extension-owned IDE context from the durable user bubble', () => {
    const projector = new ConversationProjector()
    const text = withIdeContext('Explain this', {
      activeFile: { kind: 'file', path: 'src/example.ts' },
      pinned: [],
      mentions: [],
    })
    projector.apply(event('user/message', 1, {
      id: 'contextual',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }))

    expect(projector.messages()).toEqual([{ id: 'contextual', role: 'user', text: 'Explain this' }])
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

  it('keeps durable assistant and nested tool-result images for client-side loading', () => {
    const projector = new ConversationProjector()
    projector.apply(event('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'assistant-image',
            mediaType: 'image/png',
            bytes: 100,
            width: 20,
            height: 10,
            name: 'chart.png',
          },
        }],
      },
    }))
    projector.apply(event('tool/call', 2, { callId: 'image-call', name: 'mcp_image' }))
    projector.apply(event('tool/result', 3, {
      message: {
        source: { kind: 'tool', callId: 'image-call' },
        content: [{
          type: 'tool-result',
          toolCallId: 'image-call',
          content: [{
            type: 'tool-result',
            toolCallId: 'nested',
            content: [{
              type: 'image',
              attachment: {
                attachmentId: 'tool-image',
                mediaType: 'image/webp',
                bytes: 200,
                width: 40,
                height: 30,
              },
            }],
          }],
        }],
      },
    }))

    expect(projector.messages()).toEqual([
      expect.objectContaining({
        id: 'assistant:1:1',
        text: '',
        images: [{
          attachmentId: 'assistant-image',
          mediaType: 'image/png',
          width: 20,
          height: 10,
          name: 'chart.png',
        }],
      }),
      expect.objectContaining({
        id: 'tool:image-call',
        images: [{
          attachmentId: 'tool-image',
          mediaType: 'image/webp',
          width: 40,
          height: 30,
        }],
      }),
    ])
  })

  it('folds official command lifecycle events into one card', () => {
    const projector = new ConversationProjector()
    projector.apply(event('command/run', 1, { commandId: 'command-1', name: 'compact' }))
    projector.apply(event('command/done', 2, { commandId: 'command-1', kind: 'success', text: 'Compacted.' }))

    expect(projector.messages()).toEqual([{
      id: 'command:command-1',
      role: 'command',
      text: '/compact',
      detail: 'Completed',
      failed: false,
      rawResult: 'Compacted.',
    }])
  })

  it('hides plan control transitions from the conversation', () => {
    const projector = new ConversationProjector()
    projector.reset([
      event('command/run', 1, { commandId: 'plan', name: 'plan' }),
      event('command/done', 2, { commandId: 'plan', kind: 'success', text: 'Plan mode on.' }),
      event('command/run', 3, { commandId: 'legacy-plan-on', name: 'plan', args: ' on' }),
      event('command/done', 4, { commandId: 'legacy-plan-on', kind: 'success', text: 'Plan mode on.' }),
      event('command/run', 5, { commandId: 'plan-off', name: 'plan', args: ' off' }),
      event('command/done', 6, { commandId: 'plan-off', kind: 'success', text: 'Plan mode off.' }),
    ])

    expect(projector.messages()).toEqual([])
  })
})
