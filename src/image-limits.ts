import type { ImageMediaType } from './dsh-client.js'

/** Deployment-resolved upload bounds published by the `imageLimits` session projection. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  mediaTypes: readonly string[]
}

/** One already-attached or about-to-be-attached image, measured in decoded bytes. */
export interface ImageCandidate {
  mediaType: ImageMediaType
  bytes: number
  name?: string
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Read the limits published by DSH. Every field must be usable: a partial
 * payload leaves intake unguarded rather than enforcing a bound the runtime
 * never stated.
 */
export function imageLimitsOf(value: unknown): ImageAttachmentLimits | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const maxImageBytes = countOf(record.maxImageBytes)
  const maxImagesPerMessage = countOf(record.maxImagesPerMessage)
  const maxMessageImageBytes = countOf(record.maxMessageImageBytes)
  const mediaTypes = Array.isArray(record.mediaTypes)
    ? record.mediaTypes.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  if (maxImageBytes === undefined
    || maxImagesPerMessage === undefined
    || maxMessageImageBytes === undefined
    || mediaTypes === undefined
    || mediaTypes.length === 0) {
    return undefined
  }
  return { maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, mediaTypes }
}

/** Render a byte bound for a message the user reads, never rounding a real bound to `0`. */
export function imageSizeText(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  if (mib < 1) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
  const rounded = mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10
  return `${String(rounded)} MB`
}

/**
 * Pre-flight one intake against the runtime's own bounds, mirroring the order the
 * official DSH composer applies. Returns the message to show, or `undefined` when
 * the batch may be attached.
 *
 * An unsupported media type is deliberately not rejected here: DSH answers that
 * case with its own reason, and duplicating the list would let the two drift.
 */
export function rejectImageAttachments(
  attached: readonly ImageCandidate[],
  incoming: readonly ImageCandidate[],
  limits: ImageAttachmentLimits | undefined,
): string | undefined {
  if (limits === undefined || incoming.length === 0) return undefined

  if (incoming.some(image => !limits.mediaTypes.includes(image.mediaType))) return undefined

  if (attached.length + incoming.length > limits.maxImagesPerMessage) {
    return `DeepSeek Harness accepts at most ${String(limits.maxImagesPerMessage)} images per message.`
  }

  const oversized = incoming.find(image => image.bytes > limits.maxImageBytes)
  if (oversized !== undefined) {
    const label = oversized.name === undefined ? 'That image' : `\`${oversized.name}\``
    return `${label} is larger than the ${imageSizeText(limits.maxImageBytes)} limit for a single image.`
  }

  const total = [...attached, ...incoming].reduce((sum, image) => sum + image.bytes, 0)
  if (total > limits.maxMessageImageBytes) {
    return `Those images exceed the ${imageSizeText(limits.maxMessageImageBytes)} limit for one message.`
  }

  return undefined
}
