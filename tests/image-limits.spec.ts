import { describe, expect, it } from 'vitest'
import {
  imageLimitsOf,
  imageSizeText,
  rejectImageAttachments,
  type ImageAttachmentLimits,
} from '../src/image-limits.ts'

// The exact payload the 0.1.1-rc.2 `imageLimits` projection publishes.
const published = {
  maxImageBytes: 20971520,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 209715200,
  maxImagePixels: 64000000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const limits: ImageAttachmentLimits = {
  maxImageBytes: 1000,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 2000,
  mediaTypes: ['image/png', 'image/jpeg'],
}

describe('DSH image attachment limits', () => {
  it('reads the limits the runtime publishes', () => {
    expect(imageLimitsOf(published)).toEqual({
      maxImageBytes: 20971520,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 209715200,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('leaves intake unguarded when the runtime states no usable bound', () => {
    expect(imageLimitsOf(undefined)).toBeUndefined()
    expect(imageLimitsOf(null)).toBeUndefined()
    expect(imageLimitsOf({})).toBeUndefined()
    expect(imageLimitsOf([published])).toBeUndefined()
    expect(imageLimitsOf({ ...published, mediaTypes: [] })).toBeUndefined()
    expect(imageLimitsOf({ ...published, maxImageBytes: 0 })).toBeUndefined()
    expect(imageLimitsOf({ ...published, maxImagesPerMessage: -1 })).toBeUndefined()
    expect(imageLimitsOf({ ...published, maxMessageImageBytes: 'lots' })).toBeUndefined()
  })

  it('accepts a batch that fits every bound', () => {
    expect(rejectImageAttachments(
      [{ mediaType: 'image/png', bytes: 500 }],
      [{ mediaType: 'image/png', bytes: 500 }],
      limits,
    )).toBeUndefined()
  })

  it('counts images already attached toward the per-message count', () => {
    const attached = [
      { mediaType: 'image/png' as const, bytes: 10 },
      { mediaType: 'image/png' as const, bytes: 10 },
    ]
    expect(rejectImageAttachments(attached, [{ mediaType: 'image/png', bytes: 10 }], limits))
      .toBeUndefined()
    expect(rejectImageAttachments(
      attached,
      [{ mediaType: 'image/png', bytes: 10 }, { mediaType: 'image/png', bytes: 10 }],
      limits,
    )).toBe('DeepSeek Harness accepts at most 3 images per message.')
  })

  it('names the offending file when one image is too large', () => {
    expect(rejectImageAttachments([], [{ mediaType: 'image/png', bytes: 1001, name: 'big.png' }], limits))
      .toBe('`big.png` is larger than the 1 KB limit for a single image.')
    expect(rejectImageAttachments([], [{ mediaType: 'image/png', bytes: 1001 }], limits))
      .toBe('That image is larger than the 1 KB limit for a single image.')
  })

  it('rejects a batch whose combined bytes exceed the message bound', () => {
    expect(rejectImageAttachments(
      [{ mediaType: 'image/png', bytes: 900 }],
      [{ mediaType: 'image/png', bytes: 900 }, { mediaType: 'image/png', bytes: 900 }],
      limits,
    )).toBe('Those images exceed the 2 KB limit for one message.')
  })

  it('defers an unsupported media type to the runtime instead of guessing', () => {
    expect(rejectImageAttachments(
      [],
      [{ mediaType: 'image/gif', bytes: 999999 }],
      limits,
    )).toBeUndefined()
  })

  it('attaches without complaint when the runtime published no limits', () => {
    expect(rejectImageAttachments([], [{ mediaType: 'image/png', bytes: 999999999 }], undefined))
      .toBeUndefined()
    expect(rejectImageAttachments([], [], limits)).toBeUndefined()
  })

  it('renders byte bounds the way the composer does', () => {
    expect(imageSizeText(20971520)).toBe('20 MB')
    expect(imageSizeText(209715200)).toBe('200 MB')
    expect(imageSizeText(1572864)).toBe('1.5 MB')
    expect(imageSizeText(500 * 1024)).toBe('500 KB')
    expect(imageSizeText(1)).toBe('1 KB')
  })
})
