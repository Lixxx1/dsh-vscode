import { describe, expect, it } from 'vitest'
import { normalizeToolResult } from '../src/tool-result.js'
import { ConversationProjector, type DshEvent } from '../src/conversation.js'
import { presentToolResult } from '../src/tool-presentation.js'

describe.each(['V3', 'V4'])('%s tool results', version => {
  const image = { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', width: 1, height: 1 } }
  const result = (failed = false, text = 'first', tail = 'second'): DshEvent => {
    const content = [{ type: 'text', text }, image, { type: 'text', text: tail }]
    return { type: 'tool/result', seq: 2, time: 2, data: { message: version === 'V4'
      ? { role: 'tool', toolCallId: 'call', isError: failed, content }
      : { content: [{ type: 'tool-result', toolCallId: 'call', isError: failed, content }] } } }
  }

  it.each([true, false])('shares complete output, attachments and failure=%s between live and replay', failed => {
    const event = result(failed)
    expect(normalizeToolResult(event)).toMatchObject({ callId: 'call', failed, text: 'first\nsecond', content: [expect.anything(), image, expect.anything()] })
    const entries = [{ type: 'tool/call', seq: 1, time: 1, data: { callId: 'call', name: 'mcp__example__tool' } }, event]
    const live = new ConversationProjector(); entries.forEach(entry => live.apply(entry))
    const replay = new ConversationProjector(); replay.reset(entries)
    expect(replay.messages()).toEqual(live.messages())
    expect(live.messages()).toHaveLength(1)
    expect(live.messages()[0]).toMatchObject({ failed, detail: failed ? 'Failed' : 'Completed', rawResult: 'first\nsecond',
      images: [{ attachmentId: 'image' }], resultView: { card: 'generic', content: [{ type: 'text', text: 'first\nsecond' }] } })
  })

  it('preserves terminal markers from the complete result and does not give failed tools an exit code', () => {
    expect(presentToolResult('bash', { command: 'run' }, result(false, 'out', '[exit code: 2]'), false))
      .toMatchObject({ card: 'terminal', output: 'out', exitCode: 2 })
    expect(presentToolResult('bash', { command: 'run' }, result(true, 'spawn failed', 'details'), true))
      .not.toHaveProperty('exitCode')
  })
})
