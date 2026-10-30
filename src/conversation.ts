import { withoutIdeContext } from './ide-context.js'
import type { ImageMediaType } from './dsh-client.js'
import { presentToolCall, presentToolResult } from './tool-presentation.js'
import { normalizeToolResult } from './tool-result.js'
import { expandAssistantStream, type AssistantAttempt, type AssistantStreamUpdate } from './dsh-assistant-stream.js'

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'command' | 'notice'

export interface ConversationReasoning {
  text: string
  active: boolean
  durationMs?: number
  tokens: number
  estimated: boolean
}

export interface ConversationMessage {
  id: string
  role: ConversationRole
  text: string
  turn?: number
  turnStarted?: boolean
  turnEnded?: boolean
  reasoning?: ConversationReasoning
  detail?: string
  streaming?: boolean
  failed?: boolean
  callView?: unknown
  resultView?: unknown
  rawInput?: string
  rawResult?: string
  images?: ConversationImage[]
  deferredBody?: boolean
  deferredBodyRevision?: string
  bodyLength?: number
}

interface AssistantStreamNode {
  previous?: AssistantStreamNode
  text: string
}

const assistantStreams = new WeakMap<ConversationMessage, AssistantStreamNode>()
const reasoningStreams = new WeakMap<ConversationMessage, AssistantStreamNode>()

interface ReasoningState { units: number; start: number | undefined; last: number | undefined; duration: number; unknown: boolean; index?: unknown }
const reasoningStates = new WeakMap<ConversationMessage, ReasoningState>()

function inheritAssistantStream(source: ConversationMessage | undefined, target: ConversationMessage): void {
  const stream = source === undefined ? undefined : assistantStreams.get(source)
  if (stream !== undefined) assistantStreams.set(target, stream)
  const reasoningStream = source === undefined ? undefined : reasoningStreams.get(source)
  if (reasoningStream !== undefined) reasoningStreams.set(target, reasoningStream)
  const state = source === undefined ? undefined : reasoningStates.get(source)
  if (state !== undefined) reasoningStates.set(target, state)
}

function appendAssistantStream(source: ConversationMessage | undefined, target: ConversationMessage, text: string): void {
  const previous = source === undefined ? undefined : assistantStreams.get(source)
  assistantStreams.set(target, { ...(previous === undefined ? {} : { previous }), text })
}

/** Returns the exact append represented by two projector snapshots without rescanning their accumulated text. */
export function assistantStreamAppend(left: ConversationMessage, right: ConversationMessage): string | undefined {
  return streamAppend(assistantStreams, left, right, left.text, right.text)
}

export function reasoningStreamAppend(left: ConversationMessage, right: ConversationMessage): string | undefined {
  return streamAppend(reasoningStreams, left, right, left.reasoning?.text ?? '', right.reasoning?.text ?? '')
}

function streamAppend(streams: WeakMap<ConversationMessage, AssistantStreamNode>, left: ConversationMessage, right: ConversationMessage, leftText: string, rightText: string): string | undefined {
  const target = streams.get(left)
  let current = streams.get(right)
  if (current === undefined) return undefined
  if (current === target) return leftText.length === rightText.length ? '' : undefined
  const chunks: string[] = []
  while (current !== undefined && current !== target) {
    chunks.push(current.text)
    current = current.previous
  }
  if (current !== target) return undefined
  return chunks.reverse().join('')
}

// Approximation: each CJK character is one token, other non-ASCII characters
// are half a token, and ASCII characters are one quarter of a token.
function reasoningUnits(text: string): number {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    units += (code >= 0x3400 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af) || (code >= 0x20000 && code <= 0x3134f) ? 4 : code < 128 ? 1 : 2
  }
  return units
}

function projectChunk(current: ConversationMessage | undefined, id: string, chunk: EventData, time?: number, turn?: number): ConversationMessage | undefined {
  const kind = chunk.type
  const block = record(chunk.block)
  const blockType = chunk.blockType ?? block?.type
  const isReasoning = kind === 'reasoning-delta' || (kind === 'block-start' && blockType === 'reasoning')
  const prior = current?.reasoning
  const activeIndex = current === undefined ? undefined : reasoningStates.get(current)?.index
  const isEnd = prior?.active === true && ((kind === 'block-end' && (chunk.index === undefined || activeIndex === undefined || chunk.index === activeIndex || (block?.type !== undefined && block.type !== 'reasoning')))
    || kind === 'text-delta' || kind === 'tool-call-delta' || (kind === 'block-start' && blockType !== undefined && blockType !== 'reasoning'))
  const delta = kind === 'reasoning-delta' && typeof chunk.text === 'string' ? chunk.text : ''
  const text = kind === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : ''
  const images = kind === 'block-end' ? imageContent(chunk.block) : []
  if (!isReasoning && !isEnd && text === '' && images.length === 0) return undefined
  const next: ConversationMessage = {
    id, role: 'assistant', streaming: true, text: `${current?.text ?? ''}${text}`,
    ...(turn === undefined ? current?.turn === undefined ? {} : { turn: current.turn } : { turn }),
    ...(current?.images === undefined && images.length === 0 ? {} : { images: mergeImages(current?.images, images) }),
    ...(prior === undefined ? {} : { reasoning: prior }),
  }
  inheritAssistantStream(current, next)
  if (text !== '') appendAssistantStream(current, next, text)
  if (isReasoning || isEnd) {
    const old = current === undefined ? undefined : reasoningStates.get(current)
    const state: ReasoningState = old === undefined ? { units: 0, duration: 0, unknown: false, start: undefined, last: undefined } : { ...old }
    if (isReasoning && prior?.active !== true) {
      state.start = time
      state.last = time
      state.index = chunk.index
      if (time === undefined) state.unknown = true
    } else if (isReasoning && time !== undefined) state.last = time
    if (isEnd) {
      if (state.start === undefined || time === undefined || time < state.start) state.unknown = true
      else state.duration += time - state.start
      state.start = undefined
      state.last = undefined
    }
    state.units += reasoningUnits(delta)
    const duration = state.duration + (isReasoning && state.start !== undefined && state.last !== undefined ? Math.max(0, state.last - state.start) : 0)
    next.reasoning = { text: `${prior?.text ?? ''}${delta}`, active: isReasoning, tokens: Math.ceil(state.units / 4), estimated: true,
      ...(!state.unknown && (isEnd || state.start !== undefined) ? { durationMs: duration } : {}) }
    reasoningStates.set(next, state)
    if (delta !== '') {
      const previous = current === undefined ? undefined : reasoningStreams.get(current)
      reasoningStreams.set(next, { ...(previous === undefined ? {} : { previous }), text: delta })
    }
  }
  return next
}

export interface ConversationImage {
  attachmentId: string
  mediaType: ImageMediaType
  width: number
  height: number
  name?: string
  data?: string
  error?: string
}

export interface DshEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
}

interface EventData {
  [key: string]: unknown
}

function record(value: unknown): EventData | undefined {
  return typeof value === 'object' && value !== null ? value as EventData : undefined
}

function validTurn(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    const item = record(part)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

function reasoningContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((part) => {
    const item = record(part)
    return item?.type === 'reasoning' && typeof item.text === 'string' ? [item.text] : []
  })
  return parts.length === 0 ? undefined : parts.join('\n')
}

function settledReasoning(content: unknown, stream: unknown, fallback?: ConversationMessage): ConversationReasoning | undefined {
  const text = reasoningContent(content)
  if (text === undefined) return undefined
  let projected: ConversationMessage | undefined
  try {
    for (const { chunk, time } of expandAssistantStream(stream)) projected = projectChunk(projected, '', chunk, time) ?? projected
  } catch { /* Older history may have no compact stream. */ }
  const source = projected?.reasoning === undefined ? fallback : projected
  const state = source === undefined ? undefined : reasoningStates.get(source)
  let durationMs = source?.reasoning?.durationMs
  if (source?.reasoning?.active === true && state !== undefined) {
    durationMs = state.unknown || state.start === undefined || state.last === undefined
      ? undefined : state.duration + Math.max(0, state.last - state.start)
  }
  return { text, active: false, tokens: Math.ceil(reasoningUnits(text) / 4), estimated: true,
    ...(durationMs === undefined ? {} : { durationMs }) }
}

function imageMediaType(value: unknown): ImageMediaType | undefined {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
    ? value
    : undefined
}

/** Finds durable DSH image references, including images nested inside tool results. */
function imageContent(value: unknown): ConversationImage[] {
  const found = new Map<string, ConversationImage>()
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    const item = record(candidate)
    if (item === undefined) return
    if (item.type === 'image') {
      const attachment = record(item.attachment)
      const mediaType = imageMediaType(attachment?.mediaType)
      if (attachment !== undefined
        && typeof attachment.attachmentId === 'string'
        && mediaType !== undefined
        && typeof attachment.width === 'number'
        && typeof attachment.height === 'number') {
        found.set(attachment.attachmentId, {
          attachmentId: attachment.attachmentId,
          mediaType,
          width: attachment.width,
          height: attachment.height,
          ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
        })
      }
    }
    if (Array.isArray(item.content)) visit(item.content)
  }
  visit(value)
  return [...found.values()]
}

function toolView(value: unknown, expected: 'call' | 'result'): unknown {
  const wrapper = record(value)
  return wrapper?.for === expected ? wrapper.view : undefined
}

/** Projects the official append-only DSH event log into the small chat surface. */
export class ConversationProjector {
  private readonly orderedIds: string[] = []
  private readonly byId = new Map<string, ConversationMessage>()
  private readonly hiddenCommandIds = new Set<string>()
  private readonly startedTurns = new Set<number>()
  private readonly endedTurns = new Set<number>()
  private liveAttempt: (AssistantAttempt & { message?: ConversationMessage }) | undefined

  reset(entries: readonly (DshEvent | { event: DshEvent; view?: unknown })[], preserveLive = false): void {
    const live = preserveLive ? this.liveAttempt : undefined
    this.liveAttempt = undefined
    this.orderedIds.length = 0
    this.byId.clear()
    this.hiddenCommandIds.clear()
    this.startedTurns.clear()
    this.endedTurns.clear()
    for (const entry of entries) {
      if ('event' in entry) this.apply(entry.event, entry.view)
      else this.apply(entry)
    }
    this.liveAttempt = live
  }

  /** A process-local prefix is not history; retry/abandonment must be able to discard it. */
  applyStream(update: AssistantStreamUpdate): void {
    if (update.kind === 'start') { this.liveAttempt = { ...update }; return }
    const active = this.liveAttempt
    if (active?.attemptId !== update.attemptId) return
    if (update.kind === 'end') { this.liveAttempt = undefined; return }
    const current = active.message
    const next = projectChunk(current, `assistant-live:${active.attemptId}`, update.chunk, update.time, validTurn(active.turn))
    if (next !== undefined) active.message = next
  }

  apply(event: DshEvent, view?: unknown): void {
    const data = record(event.data)
    if (data === undefined) return
    const turn = validTurn(data.turn)
    if (event.type === 'turn/start') {
      if (turn !== undefined) this.startedTurns.add(turn)
      return
    }
    if (event.type === 'turn/end') {
      if (turn !== undefined) this.endedTurns.add(turn)
      return
    }
    const live = this.liveAttempt !== undefined && this.liveAttempt.turn === data.turn && this.liveAttempt.step === data.step ? this.liveAttempt.message : undefined
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && this.liveAttempt?.turn === data.turn && this.liveAttempt?.step === data.step
      && (event.type === 'assistant/attempt' || event.surfaceOp === 'append')) this.liveAttempt = undefined

    if (event.type === 'user/message') {
      const source = record(data.source)
      if (source?.kind !== 'user') return
      const id = typeof data.id === 'string' ? data.id : `user:${String(event.seq)}`
      const text = withoutIdeContext(textContent(data.content))
      const images = imageContent(data.content)
      if (text !== '' || images.length > 0) this.set(id, { id, role: 'user', text, ...(images.length > 0 ? { images } : {}) })
      return
    }

    if (event.type === 'assistant/chunk') {
      const chunk = record(data.chunk)
      const id = `assistant:${String(data.turn)}:${String(data.step)}`
      const current = this.byId.get(id)
      if (chunk === undefined) return
      const next = projectChunk(current, id, chunk, event.time, turn)
      if (next !== undefined) this.set(id, next)
      return
    }

    if (event.type === 'assistant/message') {
      const message = record(data.message)
      const id = `assistant:${String(data.turn)}:${String(data.step)}`
      const current = this.byId.get(id)
      const text = textContent(message?.content)
      const images = imageContent(message?.content)
      const reasoning = settledReasoning(message?.content, data.stream, live ?? current)
      if (text !== '' || images.length > 0 || reasoning !== undefined) {
        const next: ConversationMessage = { id, role: 'assistant', text, ...(turn === undefined ? {} : { turn }), ...(images.length > 0 ? { images } : {}), ...(reasoning === undefined ? {} : { reasoning }) }
        if (current !== undefined && text === current.text && reasoning?.text === current.reasoning?.text) inheritAssistantStream(current, next)
        this.set(id, next)
      }
      return
    }

    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : String(event.seq)
      const name = typeof data.name === 'string' ? data.name : 'Tool'
      this.set(`tool:${callId}`, {
        id: `tool:${callId}`,
        role: 'tool',
        ...(turn === undefined ? {} : { turn }),
        text: name,
        detail: 'Running…',
        streaming: true,
        callView: toolView(view, 'call') ?? presentToolCall(name, data.arguments),
        ...(typeof data.arguments === 'string' ? { rawInput: data.arguments } : {}),
      })
      return
    }

    if (event.type === 'tool/result') {
      const result = normalizeToolResult(event)
      const callId = result.callId ?? String(event.seq)
      const id = `tool:${callId}`
      const current = this.byId.get(id)
      const failed = result.failed
      const rawResult = result.text
      const images = imageContent(result.content)
      this.set(id, {
        id,
        role: 'tool',
        ...((turn ?? current?.turn) === undefined ? {} : { turn: (turn ?? current?.turn)! }),
        text: current?.text ?? 'Tool',
        detail: failed ? 'Failed' : 'Completed',
        failed,
        ...(current?.callView === undefined ? {} : { callView: current.callView }),
        ...(current?.rawInput === undefined ? {} : { rawInput: current.rawInput }),
        resultView: toolView(view, 'result') ?? presentToolResult(current?.text ?? '', current?.rawInput, event, failed),
        ...(rawResult === '' ? {} : { rawResult }),
        ...(images.length > 0 ? { images } : {}),
      })
      return
    }

    if (event.type === 'command/run') {
      if (typeof data.commandId !== 'string' || typeof data.name !== 'string') return
      // Plan entry/exit is a composer control transition as well as a slash
      // command. Keep its durable DSH events for the projection, but do not
      // turn a Shield click into a synthetic chat card.
      const planArgs = typeof data.args === 'string' ? data.args.trim() : ''
      if (data.name === 'plan'
        && (planArgs === '' || planArgs === 'on' || planArgs === 'off')) {
        this.hiddenCommandIds.add(data.commandId)
        return
      }
      const id = `command:${data.commandId}`
      this.set(id, {
        id,
        role: 'command',
        text: `/${data.name}${typeof data.args === 'string' ? data.args : ''}`,
        detail: 'Running…',
        streaming: true,
      })
      return
    }

    if (event.type === 'command/done') {
      if (typeof data.commandId !== 'string') return
      if (this.hiddenCommandIds.has(data.commandId)) return
      const id = `command:${data.commandId}`
      const current = this.byId.get(id)
      const failed = data.kind === 'error'
      this.set(id, {
        id,
        role: 'command',
        text: current?.text ?? 'DeepSeek command',
        detail: failed ? 'Failed' : 'Completed',
        failed,
        ...(typeof data.text === 'string' && data.text !== '' ? { rawResult: data.text } : {}),
      })
    }
  }

  notice(id: string, text: string, failed = false): void {
    this.set(id, { id, role: 'notice', text, failed })
  }

  messages(): ConversationMessage[] {
    const messages = this.orderedIds.flatMap(id => {
      const value = this.byId.get(id)
      if (value === undefined) return []
      const copy = { ...value, ...(value.turn !== undefined && this.startedTurns.has(value.turn) ? { turnStarted: true } : {}), ...(value.turn !== undefined && this.endedTurns.has(value.turn) ? { turnEnded: true } : {}) }
      inheritAssistantStream(value, copy)
      return [copy]
    })
    const live = this.liveAttempt?.message
    if (live !== undefined) {
      const copy = { ...live, ...(live.turn !== undefined && this.startedTurns.has(live.turn) ? { turnStarted: true } : {}), ...(live.turn !== undefined && this.endedTurns.has(live.turn) ? { turnEnded: true } : {}) }
      inheritAssistantStream(live, copy)
      messages.push(copy)
    }
    return messages
  }

  private set(id: string, message: ConversationMessage): void {
    if (!this.byId.has(id)) this.orderedIds.push(id)
    this.byId.set(id, message)
  }
}

function mergeImages(current: readonly ConversationImage[] | undefined, next: readonly ConversationImage[]): ConversationImage[] {
  const images = new Map((current ?? []).map(image => [image.attachmentId, image]))
  for (const image of next) images.set(image.attachmentId, image)
  return [...images.values()]
}
