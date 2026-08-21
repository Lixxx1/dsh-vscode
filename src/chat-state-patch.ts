import type { ConversationImage, ConversationMessage } from './conversation.js'

export interface ConversationMessagesPatch {
  reset?: ConversationMessage[]
  upserts?: ConversationMessage[]
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
  for (let index = 0; index < next.length; index += 1) {
    const message = next[index]
    if (message === undefined) continue
    const current = previous[index]
    if (current === undefined || !sameMessage(current, message)) upserts.push(message)
  }
  return upserts.length === 0 ? undefined : { upserts }
}
