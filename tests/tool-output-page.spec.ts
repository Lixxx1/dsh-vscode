import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../src/conversation.js'
import { pageToolOutput, TOOL_OUTPUT_CHAR_LIMIT, TOOL_OUTPUT_ITEM_LIMIT } from '../src/tool-output-page.js'

function tool(extra: Partial<ConversationMessage>): ConversationMessage {
  return { id: 'tool:1', role: 'tool', text: 'Tool', detail: 'Completed', ...extra }
}

describe('tool output pages', () => {
  it('bounds terminal output and resumes from an opaque cursor', () => {
    const output = 'x'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 37)
    const first = pageToolOutput(tool({ resultView: { card: 'terminal', output } }))
    const firstView = first.message.resultView as { output: string }
    expect(firstView.output).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)
    expect(first.nextCursor).toBeDefined()

    const second = pageToolOutput(tool({ resultView: { card: 'terminal', output } }), first.nextCursor)
    expect((second.message.resultView as { output: string }).output).toBe('x'.repeat(37))
    expect(second.nextCursor).toBeUndefined()
  })

  it('pages a single large diff field without transferring the other fields', () => {
    const oldText = 'a'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1)
    const message = tool({ resultView: { card: 'diff', diffs: [{ path: 'large.ts', oldText, newText: 'next' }] } })
    const first = pageToolOutput(message)
    const firstDiff = (first.message.resultView as { diffs: Array<Record<string, string>> }).diffs[0]
    expect(firstDiff?.oldText).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)
    expect(firstDiff?.newText).toBeUndefined()

    const second = pageToolOutput(message, first.nextCursor)
    expect((second.message.resultView as { diffs: Array<Record<string, string>> }).diffs[0]?.oldText).toBe('a')
    expect(second.nextCursor).toBeDefined()
  })

  it('limits read and search result collections before serialization', () => {
    const lines = Array.from({ length: TOOL_OUTPUT_ITEM_LIMIT * 3 }, (_, index) => ({ number: index + 1, text: `line ${index + 1}` }))
    const read = pageToolOutput(tool({ resultView: { card: 'read', path: 'large.ts', lines } }))
    expect((read.message.resultView as { lines: unknown[] }).lines).toHaveLength(TOOL_OUTPUT_ITEM_LIMIT * 2)
    expect(read.nextCursor).toBeDefined()

    const paths = Array.from({ length: TOOL_OUTPUT_ITEM_LIMIT + 3 }, (_, index) => `file-${index}.ts`)
    const search = pageToolOutput(tool({ resultView: { card: 'search', shape: 'paths', paths } }))
    expect((search.message.resultView as { paths: unknown[] }).paths).toHaveLength(TOOL_OUTPUT_ITEM_LIMIT)
    expect(search.nextCursor).toBeDefined()
  })

  it('splits an individual oversized read line across pages', () => {
    const text = 'z'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 9)
    const message = tool({ resultView: { card: 'read', path: 'one-line.ts', lines: [{ number: 1, text }] } })
    const first = pageToolOutput(message)
    expect(((first.message.resultView as { lines: Array<{ text: string }> }).lines[0]?.text)).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)

    const second = pageToolOutput(message, first.nextCursor)
    expect((second.message.resultView as { lines: Array<{ text: string }> }).lines[0]?.text).toBe('z'.repeat(9))
    expect(second.nextCursor).toBeUndefined()
  })

  it('moves from a web answer to bounded source pages', () => {
    const sources = Array.from({ length: TOOL_OUTPUT_ITEM_LIMIT + 1 }, (_, index) => ({ title: `Source ${index}`, url: `https://example.com/${index}` }))
    const message = tool({ resultView: { card: 'web', answer: 'Answer', sources } })
    const answer = pageToolOutput(message)
    expect((answer.message.resultView as { answer: string }).answer).toBe('Answer')

    const sourcePage = pageToolOutput(message, answer.nextCursor)
    expect((sourcePage.message.resultView as { sources: unknown[] }).sources).toHaveLength(TOOL_OUTPUT_ITEM_LIMIT)
    expect(sourcePage.nextCursor).toBeDefined()
  })

  it('treats an invalid cursor as the first page', () => {
    const message = tool({ rawResult: 'result' })
    expect(pageToolOutput(message, 'not-json').message).toEqual(pageToolOutput(message).message)
  })

  it('loads tool-result images one at a time after text pages', () => {
    const message = tool({
      rawResult: 'done',
      images: [
        { attachmentId: 'one', mediaType: 'image/png', width: 10, height: 10, data: 'abc' },
        { attachmentId: 'two', mediaType: 'image/png', width: 10, height: 10, data: 'def' },
      ],
    })
    const text = pageToolOutput(message)
    const firstImage = pageToolOutput(message, text.nextCursor)
    expect(firstImage.message.images?.map(image => image.attachmentId)).toEqual(['one'])
    expect(firstImage.nextCursor).toBeDefined()
  })
})
