export type ConversationRole = 'user' | 'assistant' | 'tool' | 'notice'

export interface ConversationMessage {
  id: string
  role: ConversationRole
  text: string
  detail?: string
  streaming?: boolean
  failed?: boolean
}

export interface DshEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

interface EventData {
  [key: string]: unknown
}

function record(value: unknown): EventData | undefined {
  return typeof value === 'object' && value !== null ? value as EventData : undefined
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    const item = record(part)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

/** Projects the official append-only DSH event log into the small chat surface. */
export class ConversationProjector {
  private readonly orderedIds: string[] = []
  private readonly byId = new Map<string, ConversationMessage>()

  reset(events: readonly DshEvent[]): void {
    this.orderedIds.length = 0
    this.byId.clear()
    for (const event of events) this.apply(event)
  }

  apply(event: DshEvent): void {
    const data = record(event.data)
    if (data === undefined) return

    if (event.type === 'user/message') {
      const source = record(data.source)
      if (source?.kind !== 'user') return
      const id = typeof data.id === 'string' ? data.id : `user:${String(event.seq)}`
      const text = textContent(data.content)
      if (text !== '') this.set(id, { id, role: 'user', text })
      return
    }

    if (event.type === 'assistant/chunk') {
      const chunk = record(data.chunk)
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const id = `assistant:${String(data.turn)}:${String(data.step)}`
      const current = this.byId.get(id)
      this.set(id, {
        id,
        role: 'assistant',
        text: `${current?.text ?? ''}${chunk.text}`,
        streaming: true,
      })
      return
    }

    if (event.type === 'assistant/message') {
      const message = record(data.message)
      const id = `assistant:${String(data.turn)}:${String(data.step)}`
      const text = textContent(message?.content)
      if (text !== '') this.set(id, { id, role: 'assistant', text })
      return
    }

    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : String(event.seq)
      const name = typeof data.name === 'string' ? data.name : 'Tool'
      this.set(`tool:${callId}`, {
        id: `tool:${callId}`,
        role: 'tool',
        text: name,
        detail: 'Running…',
        streaming: true,
      })
      return
    }

    if (event.type === 'tool/result') {
      const message = record(data.message)
      const source = record(message?.source)
      const firstBlock = Array.isArray(message?.content) ? record(message.content[0]) : undefined
      const callId = typeof source?.callId === 'string'
        ? source.callId
        : typeof firstBlock?.toolCallId === 'string'
          ? firstBlock.toolCallId
          : String(event.seq)
      const id = `tool:${callId}`
      const current = this.byId.get(id)
      const failed = data.error !== undefined || firstBlock?.isError === true
      this.set(id, {
        id,
        role: 'tool',
        text: current?.text ?? 'Tool',
        detail: failed ? 'Failed' : 'Completed',
        failed,
      })
    }
  }

  notice(id: string, text: string, failed = false): void {
    this.set(id, { id, role: 'notice', text, failed })
  }

  messages(): ConversationMessage[] {
    return this.orderedIds.flatMap(id => {
      const value = this.byId.get(id)
      return value === undefined ? [] : [{ ...value }]
    })
  }

  private set(id: string, message: ConversationMessage): void {
    if (!this.byId.has(id)) this.orderedIds.push(id)
    this.byId.set(id, message)
  }
}
