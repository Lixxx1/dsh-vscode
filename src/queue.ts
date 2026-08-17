import { withoutIdeContext } from './ide-context.js'

export interface QueueItemState {
  id: string
  placement: 'queued' | 'steering'
  preview: string
  text: string | null
}

export interface QueueSnapshot {
  items: QueueItemState[]
  rawText: Map<string, string>
}

interface UnknownRecord {
  [key: string]: unknown
}

const PREVIEW_CHARS = 200

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const characters = Array.from(flat)
  return characters.length > PREVIEW_CHARS ? `${characters.slice(0, PREVIEW_CHARS).join('')}…` : flat
}

/** Projects the official session/queue frame without exposing extension-owned IDE context. */
export function queueSnapshotOf(value: unknown): QueueSnapshot {
  const rawText = new Map<string, string>()
  if (!Array.isArray(value)) return { items: [], rawText }
  const items = value.flatMap((candidate): QueueItemState[] => {
    const item = record(candidate)
    const message = record(item?.message)
    if (
      typeof item?.id !== 'string'
      || (item.placement !== 'queued' && item.placement !== 'steering')
      || !Array.isArray(message?.content)
    ) return []

    const content = message.content.map(record)
    const allText = content.every(part => typeof part?.text === 'string' && part.type === 'text')
    const joined = allText ? content.map(part => String(part?.text ?? '')).join('') : undefined
    if (joined !== undefined) rawText.set(item.id, joined)
    const visible = joined === undefined
      ? content.map(part => part?.type === 'text' && typeof part.text === 'string'
        ? withoutIdeContext(part.text)
        : `[${typeof part?.type === 'string' ? part.type : 'attachment'}]`).join(' ')
      : withoutIdeContext(joined)
    return [{
      id: item.id,
      placement: item.placement,
      preview: preview(visible),
      text: joined === undefined ? null : visible,
    }]
  })
  return { items, rawText }
}
