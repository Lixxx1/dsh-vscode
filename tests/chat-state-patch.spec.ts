import { describe, expect, it } from 'vitest'
import { diffConversationMessages } from '../src/chat-state-patch.js'
import type { ConversationMessage } from '../src/conversation.js'

function message(id: string, text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, role: 'assistant', text, ...extra }
}

describe('diffConversationMessages', () => {
  it('sends only the streaming message that changed', () => {
    const previous = [message('tool:1', 'Tool', { role: 'tool', rawResult: 'large output' }), message('assistant:1', 'Hel', { streaming: true })]
    const next = [message('tool:1', 'Tool', { role: 'tool', rawResult: 'large output' }), message('assistant:1', 'Hello', { streaming: true })]

    expect(diffConversationMessages(previous, next)).toEqual({ upserts: [next[1]] })
  })

  it('appends new messages without resetting existing output', () => {
    const previous = [message('assistant:1', 'Done')]
    const next = [...previous, message('assistant:2', 'Next', { streaming: true })]

    expect(diffConversationMessages(previous, next)).toEqual({ upserts: [next[1]] })
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
})
