import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../src/conversation.js'
import { pageConversationMessage, pageToolOutput, TOOL_OUTPUT_CHAR_LIMIT, TOOL_OUTPUT_ITEM_LIMIT } from '../src/tool-output-page.js'

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

  it('shows terminal completion metadata only on the final page', () => {
    const message = tool({ resultView: { card: 'terminal', output: 'x'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1), exitCode: 0 } })
    expect((pageToolOutput(message).message.resultView as { exitCode?: number }).exitCode).toBeUndefined()
    expect((pageToolOutput(message, pageToolOutput(message).nextCursor).message.resultView as { exitCode?: number }).exitCode).toBe(0)
  })

  it('pages a single large diff field without transferring the other fields', () => {
    const oldText = 'a'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1)
    const message = tool({ resultView: { card: 'diff', diffs: [{ path: 'large.ts', oldText, newText: 'next' }] } })
    const first = pageToolOutput(message)
    const firstDiff = (first.message.resultView as { diffs: Array<Record<string, string>> }).diffs[0]
    expect(firstDiff?.oldText).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)
    expect(firstDiff?.newText).toBeUndefined()

    const second = pageToolOutput(message, first.nextCursor)
    const secondDiff = (second.message.resultView as { diffs: Array<Record<string, string | boolean>> }).diffs[0]
    expect(secondDiff?.oldText).toBe('a')
    expect(secondDiff?.continuation).toBe(true)
    expect(firstDiff.oldText + secondDiff?.oldText).toBe(oldText)
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

  it('pages long assistant and command bodies without changing their roles', () => {
    const assistant: ConversationMessage = { id: 'assistant:1', role: 'assistant', text: 'a'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 3) }
    const assistantPage = pageConversationMessage(assistant)
    expect(assistantPage.message).toMatchObject({ role: 'assistant', resultView: { card: 'assistant-page', plainText: true } })
    expect(assistantPage.message.text).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)

    const command: ConversationMessage = { id: 'command:1', role: 'command', text: '/compact', rawResult: 'c'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 2) }
    const commandPage = pageConversationMessage(command)
    expect(commandPage.message.role).toBe('command')
    expect(((commandPage.message.resultView as { content: Array<{ text: string }> }).content[0]?.text)).toHaveLength(TOOL_OUTPUT_CHAR_LIMIT)
  })

  it('keeps generic locations in bounded pages after raw output', () => {
    const locations = Array.from({ length: TOOL_OUTPUT_ITEM_LIMIT + 2 }, (_, index) => ({ path: `src/${index}.ts`, line: index + 1 }))
    const message = tool({ rawResult: 'done', callView: { card: 'generic', locations } })
    const text = pageConversationMessage(message)
    const firstLocations = pageConversationMessage(message, text.nextCursor)
    expect(((firstLocations.message.callView as { locations: unknown[] }).locations)).toHaveLength(TOOL_OUTPUT_ITEM_LIMIT)
    expect(firstLocations.nextCursor).toBeDefined()
  })

  it('marks split web answers as plain text so Markdown is not parsed across arbitrary boundaries', () => {
    const page = pageConversationMessage(tool({ resultView: { card: 'web', answer: '```ts\n' + 'x'.repeat(TOOL_OUTPUT_CHAR_LIMIT) } }))
    expect(page.message.resultView).toMatchObject({ card: 'web', plainText: true })
  })

  it('returns an image directly when a tool has no textual body', () => {
    const page = pageConversationMessage(tool({ images: [{ attachmentId: 'only', mediaType: 'image/png', width: 1, height: 1, data: 'abc' }] }))
    expect(page.message.images?.[0]?.attachmentId).toBe('only')
  })
})
