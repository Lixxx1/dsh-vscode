import type { ConversationImage, ConversationMessage } from './conversation.js'

export interface ConversationMessagesPatch {
  reset?: ConversationMessage[]
  upserts?: ConversationMessage[]
  appends?: ConversationMessageAppend[]
}

export interface ConversationMessageAppend {
  id: string
  text: string
  streaming: boolean
}

function compactToolView(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const compact: Record<string, unknown> = {}
  if (typeof source.card === 'string') compact.card = source.card
  if (typeof source.title === 'string') compact.title = source.title
  return Object.keys(compact).length === 0 ? undefined : compact
}

/** Keeps completed tool cards lightweight until their body is expanded. */
export function messageForWebview(message: ConversationMessage): ConversationMessage {
  if (message.role !== 'tool' || message.streaming === true || message.deferredBody === true) return message
  const hasBody = message.callView !== undefined
    || message.resultView !== undefined
    || message.rawInput !== undefined
    || message.rawResult !== undefined
    || (message.images?.length ?? 0) > 0
  if (!hasBody) return message
  const callView = compactToolView(message.callView)
  const resultView = compactToolView(message.resultView)
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.detail === undefined ? {} : { detail: message.detail }),
    ...(message.failed === undefined ? {} : { failed: message.failed }),
    ...(callView === undefined ? {} : { callView }),
    ...(resultView === undefined ? {} : { resultView }),
    deferredBody: true,
  }
}

export function messagesPatchForWebview(patch: ConversationMessagesPatch): ConversationMessagesPatch {
  return {
    ...(patch.reset === undefined ? {} : { reset: patch.reset.map(messageForWebview) }),
    ...(patch.upserts === undefined ? {} : { upserts: patch.upserts.map(messageForWebview) }),
    ...(patch.appends === undefined ? {} : { appends: patch.appends }),
  }
}

function sameImage(left: ConversationImage, right: ConversationImage): boolean {
  return left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
    && left.data === right.data
    && left.error === right.error
}

function sameImages(left: readonly ConversationImage[] | undefined, right: readonly ConversationImage[] | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((image, index) => {
    const candidate = right[index]
    return candidate !== undefined && sameImage(image, candidate)
  })
}

function sameMessage(left: ConversationMessage, right: ConversationMessage): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.text === right.text
    && left.detail === right.detail
    && left.streaming === right.streaming
    && left.failed === right.failed
    && left.callView === right.callView
    && left.resultView === right.resultView
    && left.rawInput === right.rawInput
    && left.rawResult === right.rawResult
    && left.deferredBody === right.deferredBody
    && sameImages(left.images, right.images)
}

function canAppendAssistantText(left: ConversationMessage, right: ConversationMessage): boolean {
  return left.id === right.id
    && left.role === 'assistant'
    && right.role === 'assistant'
    && left.streaming === true
    && right.text.startsWith(left.text)
    && left.detail === right.detail
    && left.failed === right.failed
    && left.callView === right.callView
    && left.resultView === right.resultView
    && left.rawInput === right.rawInput
    && left.rawResult === right.rawResult
    && left.deferredBody === right.deferredBody
    && sameImages(left.images, right.images)
}

/**
 * Produces an append/update patch for the common streaming path. History
 * insertion, removal, and reordering intentionally fall back to a reset.
 */
export function diffConversationMessages(
  previous: readonly ConversationMessage[],
  next: readonly ConversationMessage[],
): ConversationMessagesPatch | undefined {
  const sharedLength = Math.min(previous.length, next.length)
  for (let index = 0; index < sharedLength; index += 1) {
    if (previous[index]?.id !== next[index]?.id) return { reset: [...next] }
  }
  if (next.length < previous.length) return { reset: [...next] }

  const upserts: ConversationMessage[] = []
  const appends: ConversationMessageAppend[] = []
  for (let index = 0; index < next.length; index += 1) {
    const message = next[index]
    if (message === undefined) continue
    const current = previous[index]
    if (current === undefined) {
      upserts.push(message)
      continue
    }
    if (sameMessage(current, message)) continue
    if (canAppendAssistantText(current, message)) {
      appends.push({
        id: message.id,
        text: message.text.slice(current.text.length),
        streaming: message.streaming === true,
      })
    } else {
      upserts.push(message)
    }
  }
  return upserts.length === 0 && appends.length === 0
    ? undefined
    : {
        ...(upserts.length === 0 ? {} : { upserts }),
        ...(appends.length === 0 ? {} : { appends }),
      }
}
