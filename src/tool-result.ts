import type { DshEvent } from './conversation.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** One read-only interpretation shared by live rendering, replay and edit review.
 * V3 nests content/isError/toolCallId in a tool-result block; V4 puts them on
 * the tool message itself. Keep non-text blocks for image/attachment consumers.
 */
export function normalizeToolResult(event: DshEvent): {
  callId: string | undefined
  failed: boolean
  text: string
  content: unknown[]
} {
  const data = record(event.data)
  const message = record(data?.message)
  const source = record(message?.source)
  let callId = typeof source?.callId === 'string' ? source.callId
    : typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
  let failed = data?.error !== undefined || message?.isError === true
  const content: unknown[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (typeof value === 'string') { content.push({ type: 'text', text: value }); return }
    if (!Array.isArray(value)) return
    for (const part of value) {
      const block = record(part)
      if (block?.type === 'tool-result' && depth < 8) {
        if (callId === undefined && typeof block.toolCallId === 'string') callId = block.toolCallId
        failed ||= block.isError === true
        visit(block.content, depth + 1)
      } else content.push(part)
    }
  }
  visit(message?.content)
  const text = content.flatMap(value => {
    const block = record(value)
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
  return { callId, failed, text, content }
}
