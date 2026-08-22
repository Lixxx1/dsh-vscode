import { describe, expect, it } from 'vitest'
import { diffConversationMessages, messageForWebview, messagesPatchForWebview } from '../src/chat-state-patch.js'
import { ConversationProjector, type ConversationMessage, type DshEvent } from '../src/conversation.js'

function message(id: string, text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, role: 'assistant', text, ...extra }
}

describe('diffConversationMessages', () => {
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
