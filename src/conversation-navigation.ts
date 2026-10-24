import { ConversationProjector, type ConversationMessage } from './conversation.js'
import type { HistoryEntry } from './dsh-client.js'
import { earliestHistorySequence, mergeHistoryEntries } from './history.js'

export interface ConversationMatch {
  id: string
  role: string
  label: string
  snippet: string
  matchStart?: number
  matchLength?: number
}
export interface ConversationSearch {
  sessionId: string
  query: string
  matches: ConversationMatch[]
  total: number
  indexedMessages: number
  hasMore: boolean
  limited: boolean
}
const MAX_CHARACTERS = 8_000_000
const MAX_EVENTS = 25_000
const MAX_RESULTS = 100

function excerpt(text: string, match?: RegExpExecArray | null): Pick<ConversationMatch, 'snippet' | 'matchStart' | 'matchLength'> {
  const start = Math.max(0, (match?.index ?? 0) - 70)
  const length = Math.max(220, (match?.[0].length ?? 0) + 100)
  const prefix = start > 0 ? '…' : ''
  const snippet = prefix + text.slice(start, start + length) + (text.length > start + length ? '…' : '')
  return { snippet, ...(match ? { matchStart: prefix.length + match.index - start, matchLength: match[0].length } : {}) }
}

/** A literal search over the same projected messages the chat can reveal. */
export function findConversationMessages(messages: readonly ConversationMessage[], query: string): { matches: ConversationMatch[]; total: number } {
  const literal = query.trim().slice(0, 200)
  const pattern = literal ? new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : undefined
  const matches: ConversationMatch[] = []
  let total = 0
  for (const message of [...messages].reverse()) {
    if (!pattern && message.role !== 'user') continue
    const fields = [message.text, message.rawInput, message.rawResult, message.detail].filter((value): value is string => typeof value === 'string')
    let content = message.text || (message.images?.length ? 'Image attachment' : '')
    let match: RegExpExecArray | null | undefined
    if (pattern) {
      for (const field of fields) {
        match = pattern.exec(field)
        if (match) { content = field; break }
      }
      if (!match) continue
    }
    total++
    if (matches.length >= MAX_RESULTS) continue
    const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'DeepSeek'
      : message.role === 'tool' ? `Tool · ${message.text.slice(0, 100)}` : message.role === 'command' ? 'Command' : 'Notice'
    matches.push({ id: message.id, role: message.role, label, ...excerpt(content, match) })
  }
  return { matches, total }
}

/** Per-panel snapshot. Paging/search never changes the visible conversation. */
export class ConversationNavigation {
  private history: HistoryEntry[] = []
  private messages: ConversationMessage[] = []
  private more: boolean
  private limited = false
  private characters = 0
  private revision = 0

  constructor(readonly sessionId: string, initial: readonly HistoryEntry[], hasMore: boolean,
    private readonly page: (before: number, signal: AbortSignal) => Promise<{ events: HistoryEntry[]; hasMore: boolean }>,
    readonly isCurrent: () => boolean) {
    this.more = hasMore
    this.appendOlder(mergeHistoryEntries([], initial))
  }

  private assertCurrent(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (!this.isCurrent()) throw new Error('The conversation changed. Reopen Find in conversation.')
  }

  private appendOlder(entries: readonly HistoryEntry[]): void {
    const seen = new Set(this.history.map(entry => entry.event.seq))
    const accepted: HistoryEntry[] = []
    for (const entry of [...entries].reverse()) {
      if (seen.has(entry.event.seq)) continue
      const size = JSON.stringify(entry.event).length
      if (this.history.length + accepted.length >= MAX_EVENTS || this.characters + size > MAX_CHARACTERS) {
        this.more = this.limited = true
        break
      }
      this.characters += size
      seen.add(entry.event.seq)
      accepted.push(entry)
    }
    this.history = mergeHistoryEntries(this.history, accepted)
    const projector = new ConversationProjector()
    projector.reset(this.history)
    this.messages = projector.messages()
  }

  search(query: string): ConversationSearch {
    this.assertCurrent()
    const normalized = query.trim().slice(0, 200)
    return { sessionId: this.sessionId, query: normalized, ...findConversationMessages(this.messages, normalized),
      indexedMessages: this.messages.length, hasMore: this.more, limited: this.limited }
  }

  async loadEarlier(signal: AbortSignal): Promise<void> {
    const revision = ++this.revision
    // Three message-aligned pages per explicit request; no unbounded backfill.
    for (let pages = 0; pages < 3 && this.more && !this.limited; pages++) {
      this.assertCurrent(signal)
      const before = earliestHistorySequence(this.history)
      if (before === undefined || before === 0) { this.limited = true; break }
      const result = await this.page(before, signal)
      this.assertCurrent(signal)
      if (revision !== this.revision) throw new Error('A newer history request replaced this search.')
      const older = result.events.filter(entry => entry.event.seq < before)
      if (!older.length) {
        if (result.hasMore) throw new Error('Earlier history did not advance. Try again.')
        this.more = false
        break
      }
      this.more = result.hasMore
      this.appendOlder(older)
    }
  }

  reveal(messageId: string): { entries: readonly HistoryEntry[]; hasMore: boolean } {
    this.assertCurrent()
    if (!this.messages.some(message => message.id === messageId)) throw new Error('This message is not in the search snapshot. Refresh and try again.')
    return { entries: this.history, hasMore: this.more }
  }
}
