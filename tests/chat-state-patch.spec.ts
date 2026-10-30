import { describe, expect, it } from 'vitest'
import { diffConversationMessages, messageForWebview, messagesPatchForWebview } from '../src/chat-state-patch.js'
import { ConversationProjector, type ConversationMessage, type DshEvent } from '../src/conversation.js'

function message(id: string, text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, role: 'assistant', text, ...extra }
}

describe('diffConversationMessages', () => {
  it('upserts when turn metadata changes without changing the streaming body', () => {
    const projector = new ConversationProjector()
    projector.apply({ type: 'assistant/chunk', seq: 1, time: 1, data: { turn: 2, step: 0, chunk: { type: 'text-delta', text: 'answer' } } })
    const previous = projector.messages()
    projector.apply({ type: 'turn/end', seq: 2, time: 2, data: { turn: 2 } })
    const next = projector.messages()
    expect(next[0]).toMatchObject({ turn: 2, turnEnded: true })
    expect(diffConversationMessages(previous, next)).toEqual({ upserts: next })
    const changedTurn = [{ ...previous[0]!, turn: 3 }]
    expect(diffConversationMessages(previous, changedTurn)).toEqual({ upserts: changedTurn })
    projector.apply({ type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } })
    const started = projector.messages()
    expect(started[0]).toMatchObject({ turn: 2, turnStarted: true, turnEnded: true })
    expect(diffConversationMessages(next, started)).toEqual({ upserts: started })
  })

  it('retains turn metadata when assistant and tool bodies are deferred', () => {
    const metadata = { turn: 4, turnStarted: true, turnEnded: true }
    expect(messageForWebview(message('a', 'x'.repeat(50_000), metadata))).toMatchObject(metadata)
    expect(messageForWebview(message('t', 'Read', { role: 'tool', rawResult: 'result', ...metadata }))).toMatchObject(metadata)
  })
  it('sends reasoning deltas and metadata-only transitions without repeating prior text', () => {
    const projector = new ConversationProjector()
    projector.applyStream({ kind: 'start', attemptId: 'a', turn: 1, step: 1 })
    projector.applyStream({ kind: 'chunk', attemptId: 'a', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
    const previous = projector.messages()
    projector.applyStream({ kind: 'chunk', attemptId: 'a', time: 20, chunk: { type: 'reasoning-delta', index: 0, text: ' more' } })
    const next = projector.messages()
    expect(diffConversationMessages(previous, next)).toEqual({ appends: [{ id: 'assistant-live:a', text: '', streaming: true, reasoning: { text: ' more', active: true, durationMs: 10, tokens: 3, estimated: true } }] })
    projector.applyStream({ kind: 'chunk', attemptId: 'a', time: 30, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning' } } })
    expect(diffConversationMessages(next, projector.messages())).toEqual({ appends: [{ id: 'assistant-live:a', text: '', streaming: true, reasoning: { text: '', active: false, durationMs: 20, tokens: 3, estimated: true } }] })
  })

  it('upserts authoritative reasoning that replaces a same-length legacy stream', () => {
    const projector = new ConversationProjector()
    projector.apply({ type: 'assistant/chunk', seq: 1, time: 10, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'A' } } })
    projector.apply({ type: 'assistant/chunk', seq: 2, time: 20, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'answer' } } })
    const previous = projector.messages()
    projector.apply({ type: 'assistant/message', seq: 3, time: 30, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'B' }, { type: 'text', text: 'answer' }] } } })
    const next = projector.messages()
    expect(next[0]?.reasoning?.text).toBe('B')
    expect(diffConversationMessages(previous, next)).toEqual({ upserts: next })
  })

  it('retains reasoning when a long settled answer is deferred', () => {
    const reasoning = { text: 'the full reasoning', active: false, tokens: 5, estimated: true }
    expect(messageForWebview(message('assistant:1', 'x'.repeat(50_000), { reasoning }))).toMatchObject({ text: '', deferredBody: true, reasoning })
  })
  it('uses projector deltas across batched chunks', () => {
    const projector = new ConversationProjector()
    const chunk = (seq: number, text: string): DshEvent => ({
      type: 'assistant/chunk', seq, time: seq,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text } },
    })
    projector.apply(chunk(1, 'A'.repeat(50_000)))
    const previous = projector.messages()
    projector.apply(chunk(2, 'second'))
    projector.apply(chunk(3, ' third'))

    expect(diffConversationMessages(previous, projector.messages())).toEqual({
      appends: [{ id: 'assistant:1:1', text: 'second third', streaming: true }],
    })
  })

  it('sends only the streaming message that changed', () => {
    const previous = [message('tool:1', 'Tool', { role: 'tool', rawResult: 'large output' }), message('assistant:1', 'Hel', { streaming: true })]
    const next = [message('tool:1', 'Tool', { role: 'tool', rawResult: 'large output' }), message('assistant:1', 'Hello', { streaming: true })]

    expect(diffConversationMessages(previous, next)).toEqual({
      appends: [{ id: 'assistant:1', text: 'lo', streaming: true }],
    })
  })

  it('appends new messages without resetting existing output', () => {
    const previous = [message('assistant:1', 'Done')]
    const next = [...previous, message('assistant:2', 'Next', { streaming: true })]

    expect(diffConversationMessages(previous, next)).toEqual({ upserts: [next[1]] })
  })

  it('finishes a streaming message without resending its full text', () => {
    const previous = [message('assistant:1', 'Complete response', { streaming: true })]
    const next = [message('assistant:1', 'Complete response')]

    expect(diffConversationMessages(previous, next)).toEqual({
      appends: [{ id: 'assistant:1', text: '', streaming: false }],
    })
  })

  it('falls back to an upsert when streamed text is rewritten', () => {
    const previous = [message('assistant:1', 'Original', { streaming: true })]
    const next = [message('assistant:1', 'Replacement', { streaming: true })]

    expect(diffConversationMessages(previous, next)).toEqual({ upserts: next })
  })

  it('treats equivalent image projections as unchanged', () => {
    const images = [{ attachmentId: 'image-1', mediaType: 'image/png' as const, width: 20, height: 10, data: 'abc' }]
    const previous = [message('assistant:1', '', { images })]
    const next = [message('assistant:1', '', { images: images.map(image => ({ ...image })) })]

    expect(diffConversationMessages(previous, next)).toBeUndefined()
  })

  it('resets when history is inserted before existing messages', () => {
    const previous = [message('assistant:2', 'Current')]
    const next = [message('assistant:1', 'Earlier'), ...previous]

    expect(diffConversationMessages(previous, next)).toEqual({ reset: next })
  })

  it('defers completed tool bodies while preserving their summary', () => {
    const tool = message('tool:large', 'mcp_router_status', {
      role: 'tool',
      detail: 'Completed',
      rawInput: '{"verbose":true}',
      rawResult: 'x'.repeat(100_000),
      callView: { card: 'generic', title: 'Router status', rawInput: 'large input' },
      resultView: { card: 'generic', title: 'Router status', content: 'large output' },
    })

    expect(messageForWebview(tool)).toEqual({
      id: 'tool:large',
      role: 'tool',
      text: 'mcp_router_status',
      detail: 'Completed',
      callView: { card: 'generic', title: 'Router status' },
      resultView: { card: 'generic', title: 'Router status' },
      deferredBody: true,
      deferredBodyRevision: 'settled:17:16:100000:',
      bodyLength: 100_000,
    })
  })

  it('defers tool bodies inside resets and upserts', () => {
    const tool = message('tool:large', 'Tool', { role: 'tool', rawResult: 'large output' })
    const patch = messagesPatchForWebview({ reset: [tool], upserts: [tool] })

    expect(patch.reset?.[0]?.deferredBody).toBe(true)
    expect(patch.upserts?.[0]?.deferredBody).toBe(true)
  })

  it('defers streaming tools, large commands, and completed long responses', () => {
    expect(messageForWebview(message('tool:running', 'Write', {
      role: 'tool', streaming: true, rawInput: 'x'.repeat(50_000), callView: { card: 'diff', title: 'Write' },
    })).deferredBody).toBe(true)

    expect(messageForWebview(message('command:1', '/compact', {
      role: 'command', rawResult: 'x'.repeat(50_000),
    })).deferredBody).toBe(true)

    const assistant = messageForWebview(message('assistant:large', 'x'.repeat(50_000)))
    expect(assistant).toMatchObject({ role: 'assistant', text: '', deferredBody: true, bodyLength: 50_000 })
  })

  it('keeps the streaming flag on a deferred running tool', () => {
    const tool = messageForWebview(message('tool:running', 'Write', {
      role: 'tool', streaming: true, detail: 'Running…', callView: { card: 'diff', title: 'Write' },
    }))
    expect(tool.deferredBody).toBe(true)
    expect(tool.streaming).toBe(true)
  })

  it('keeps a short assistant answer with hydrated images inline', () => {
    const answer = message('assistant:1', 'Here it is.', {
      images: [{ attachmentId: 'image', mediaType: 'image/png', width: 10, height: 10, data: 'abc' }],
    })
    expect(messageForWebview(answer)).toBe(answer)
  })

  it('changes the deferred revision when an image finishes hydrating', () => {
    const base = message('tool:image', 'Image', {
      role: 'tool', images: [{ attachmentId: 'image', mediaType: 'image/png', width: 10, height: 10 }],
    })
    const hydrated = messageForWebview({ ...base, images: base.images?.map(image => ({ ...image, data: 'abc' })) })
    expect(hydrated.deferredBodyRevision).not.toBe(messageForWebview(base).deferredBodyRevision)
  })
})
