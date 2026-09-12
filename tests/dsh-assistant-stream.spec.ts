import { describe, expect, it } from 'vitest'
import { DshAssistantStream, type AssistantStreamUpdate } from '../src/dsh-assistant-stream.js'
import { ConversationProjector, assistantStreamAppend } from '../src/conversation.js'
import type { HistoryEntry } from '../src/dsh-client.js'

const start = (attemptId = 'a', revision = 1) => ({ type: 'start', attemptId, revision, turn: 1, step: 1, startedAfterSeq: 5 })
const chunk = (text: string, index = 0, attemptId = 'a', revision = index + 2) => ({
  type: 'chunk', attemptId, revision, index, time: 100 + index, chunk: { type: 'text-delta', index: 0, text },
})
const message = (text: string, seq = 6, type = 'assistant/message'): HistoryEntry => ({
  event: { type, seq, time: 200, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, stream: [] } },
})
const end = (index = 1, kind = 'committed', eventType = 'assistant/message') => ({
  type: 'end', attemptId: 'a', revision: index + 2, index,
  outcome: kind === 'committed' ? { kind, eventType, seq: 6 } : { kind },
})
function harness() {
  const live: AssistantStreamUpdate[] = []
  const durable: HistoryEntry[] = []
  const projector = new ConversationProjector()
  const stream = new DshAssistantStream(
    update => { live.push(update); projector.applyStream(update) },
    entry => { durable.push(entry); projector.apply(entry.event) },
  )
  return { stream, live, durable, projector }
}

describe('DSH 0.1.5 assistant presentation stream', () => {
  it('shows text before settlement, without fabricating durable history or duplicating the final message', () => {
    const h = harness()
    h.stream.open({ revision: 0 }, 5)
    h.stream.frame(start(), 5)
    h.stream.frame(chunk('Hello '), 5)
    const first = h.projector.messages()[0]!
    expect(first).toMatchObject({ role: 'assistant', text: 'Hello ', streaming: true })
    h.stream.frame(chunk('world', 1), 5)
    expect(assistantStreamAppend(first, h.projector.messages()[0]!)).toBe('world')
    expect(h.durable).toEqual([])
    h.stream.durable(message('Hello world'))
    expect(h.durable).toEqual([])
    h.stream.frame(end(2), 6)
    expect(h.durable).toEqual([message('Hello world')])
    expect(h.projector.messages()).toEqual([{ id: 'assistant:1:1', role: 'assistant', text: 'Hello world' }])
  })

  it('restores a compact live prefix and continues from the exact revision and chunk index', () => {
    const h = harness()
    h.stream.open({ revision: 4, activeAttempt: { ...start(), nextIndex: 3, stream: [
      { type: 'text-chunks', time0: 20, index: 0, texts: ['Hello ', 'world'], dt: [5] },
      { type: 'chunk', time: 26, chunk: { type: 'usage', usage: {} } },
    ] } }, 5)
    expect(h.projector.messages()[0]?.text).toBe('Hello world')
    h.stream.frame(chunk('!', 3, 'a', 5), 5)
    expect(h.projector.messages()[0]?.text).toBe('Hello world!')
    expect(h.durable).toEqual([])
  })

  it('preserves a live prefix while loading older history, but clears it when switching sessions', () => {
    const h = harness()
    h.stream.frame(start(), 5); h.stream.frame(chunk('Current'), 5)
    const before = h.projector.messages()[0]!
    h.projector.reset([message('Older', 2)], true)
    expect(h.projector.messages().map(m => m.text)).toEqual(['Older', 'Current'])
    h.stream.frame(chunk(' response', 1), 5)
    expect(assistantStreamAppend(before, h.projector.messages()[1]!)).toBe(' response')
    h.projector.reset([])
    expect(h.projector.messages()).toEqual([])
  })

  it('does not duplicate a settlement already present in the opening snapshot', () => {
    const h = harness()
    const settled = message('Complete')
    h.projector.reset([settled])
    h.stream.open({ revision: 2, activeAttempt: { ...start(), nextIndex: 1,
      stream: [{ type: 'text-chunks', time0: 10, index: 0, texts: ['Complete'], dt: [] }],
    } }, 6, [settled])
    expect(h.live).toEqual([])
    h.stream.frame(end(), 6)
    expect(h.durable).toEqual([])
    expect(h.projector.messages()).toEqual([{ id: 'assistant:1:1', role: 'assistant', text: 'Complete' }])
  })

  it.each(['abandoned', 'failed'])('discards an %s attempt before retrying the same step', outcome => {
    const h = harness()
    h.stream.frame(start(), 5); h.stream.frame(chunk('Wrong prefix'), 5)
    if (outcome === 'failed') h.stream.durable(message('', 6, 'assistant/attempt'))
    h.stream.frame(end(1, outcome === 'failed' ? 'committed' : 'abandoned', 'assistant/attempt'), 6)
    expect(h.projector.messages()).toEqual([])
    h.stream.frame(start('retry', 4), 6)
    h.stream.frame(chunk('Correct', 0, 'retry', 5), 6)
    expect(h.projector.messages().map(m => m.text)).toEqual(['Correct'])
    expect(h.durable).toHaveLength(outcome === 'failed' ? 1 : 0)
  })

  it('replaces a cancelled prefix with the actual interrupted durable content', () => {
    const h = harness()
    h.stream.frame(start(), 5); h.stream.frame(chunk('Unfinished output'), 5)
    const settled = message('Delivered prefix')
    h.stream.durable({ event: { ...settled.event, data: { ...(settled.event.data as object), interrupted: true } } })
    h.stream.frame(end(), 6)
    expect(h.projector.messages()).toEqual([{ id: 'assistant:1:1', role: 'assistant', text: 'Delivered prefix' }])
  })

  it('does not hide unrelated durable messages behind an active attempt', () => {
    const h = harness()
    h.stream.frame(start(), 5)
    const other = message('Other', 6)
    other.event.data = { ...(other.event.data as object), step: 0 }
    h.stream.durable(other)
    const replacement = message('Replacement', 7)
    replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
    h.stream.durable(replacement)
    expect(h.durable).toEqual([other, replacement])
  })

  it('keeps the old durable-chunk path and ignores an orphan transient suffix', () => {
    const h = harness()
    h.stream.open(undefined, 5)
    const legacy = { event: { type: 'assistant/chunk', seq: 6, time: 10, data: { turn: 1, step: 1, chunk: chunk('Old runtime').chunk } } }
    h.stream.durable(legacy)
    expect(h.projector.messages()[0]?.text).toBe('Old runtime')
    const late = harness()
    late.stream.open({ revision: 8 }, 5)
    late.stream.frame(chunk('Incomplete suffix', 3, 'a', 9), 5)
    late.stream.durable(message('Full message'))
    late.stream.frame({ ...end(4), revision: 10 }, 6)
    expect(late.projector.messages().map(m => m.text)).toEqual(['Full message'])
  })

  it('restores mixed reasoning, tool, text and image prefix records without showing tool arguments as prose', () => {
    const h = harness()
    h.stream.open({ revision: 5, activeAttempt: { ...start(), nextIndex: 4, stream: [
      { type: 'reasoning-chunks', time0: 10, index: 0, texts: ['Private reasoning'], dt: [] },
      { type: 'tool-call-chunks', time0: 11, index: 1, id: 'call', name: 'Read', args: ['{"path":"file"}'], dt: [] },
      { type: 'text-chunks', time0: 12, index: 2, texts: ['Visible'], dt: [] },
      { type: 'chunk', time: 13, chunk: { type: 'block-end', index: 3, block: { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', width: 1, height: 1 } } } },
    ] } }, 5)
    expect(h.projector.messages()).toMatchObject([{ text: 'Visible', images: [{ attachmentId: 'img' }] }])
    h.stream.frame(chunk(' text', 4, 'a', 6), 5)
    expect(h.projector.messages()).toMatchObject([{ text: 'Visible text', images: [{ attachmentId: 'img' }] }])
  })

  it.each([
    { ...chunk('gap'), revision: 3 },
    { ...chunk('wrong index'), index: 1 },
    { ...chunk('wrong attempt'), attemptId: 'other' },
    { ...chunk('invalid'), chunk: [] },
    { ...start('overlap', 2) },
  ])('fails closed on invalid or discontinuous live frames: %j', frame => {
    const h = harness(); h.stream.frame(start(), 5)
    expect(() => h.stream.frame(frame, 5)).toThrow('assistant stream')
    expect(h.durable).toEqual([])
  })

  it('rejects an end marker that does not identify the staged settlement', () => {
    const h = harness(); h.stream.frame(start(), 5); h.stream.frame(chunk('Hello'), 5)
    h.stream.durable(message('Hello'))
    expect(() => h.stream.frame({ ...end(), outcome: { kind: 'committed', seq: 7, eventType: 'assistant/message' } }, 6)).toThrow()
    expect(h.durable).toEqual([])
  })

  it.each([
    { revision: -1 },
    { revision: 2, activeAttempt: { ...start(), nextIndex: 1, stream: [] } },
    { revision: 2, activeAttempt: { ...start(), nextIndex: 1, stream: [{ type: 'text-chunks', time0: 1, index: 0, texts: ['a'], dt: [1] }] } },
    { revision: 2, activeAttempt: { ...start(), nextIndex: 2, stream: [{ type: 'text-chunks', time0: Number.MAX_SAFE_INTEGER, index: 0, texts: ['a', 'b'], dt: [1] }] } },
    { revision: 1, activeAttempt: { ...start(), startedAfterSeq: 7, nextIndex: 0, stream: [] } },
  ])('rejects corrupt reconnect prefixes: %j', baseline => {
    expect(() => harness().stream.open(baseline, 5)).toThrow('assistant stream')
  })
})
