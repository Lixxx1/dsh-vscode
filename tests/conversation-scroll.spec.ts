// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationScroller } from '../src/conversation-scroll.mjs'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); document.body.replaceChildren() })

function harness() {
  document.body.innerHTML = '<main tabindex="0"><div></div></main><button>Jump to latest</button>'
  const scroll = document.querySelector('main')!
  const content = scroll.firstElementChild as HTMLElement
  const jump = document.querySelector('button')!
  let height = 900, viewport = 300, top = 0
  Object.defineProperties(scroll, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
    clientWidth: { value: 400 }, offsetWidth: { value: 415 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - viewport)) } },
  })
  vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: viewport, right: 415, left: 0, width: 415, height: viewport }) as DOMRect)
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0, resize = () => {}
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  cleanup.push(() => vi.unstubAllGlobals())
  const controller = createConversationScroller(scroll, content, jump)
  cleanup.push(() => controller.dispose())
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }
  const fireScroll = () => scroll.dispatchEvent(new Event('scroll'))
  const wheel = (deltaY: number, target: HTMLElement = scroll, extra: WheelEventInit = {}) => target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY, ...extra }))
  const setHeight = (value: number) => { height = value; scroll.scrollTop = top }
  const setViewport = (value: number) => { viewport = value; scroll.scrollTop = top }
  flush(); fireScroll()
  return { scroll, content, jump, controller, flush, fireScroll, wheel, setHeight, setViewport, resize: () => resize(), frames, disconnect }
}

describe('conversation scroll intent', () => {
  it('keeps following when output grows between a programmatic scroll and its event (#30)', () => {
    const h = harness()
    h.setHeight(1060); h.controller.changed(); h.flush()
    expect(h.scroll.scrollTop).toBe(760)
    h.setHeight(1220); h.controller.changed(); h.fireScroll()
    expect(h.controller.following).toBe(true)
    h.flush()
    expect(h.scroll.scrollTop).toBe(920)
    h.setHeight(1400); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(1100)
  })

  it('does not detach on a scroll event caused only by changing content dimensions', () => {
    const h = harness()
    h.setHeight(1500); h.fireScroll(); h.resize(); h.flush()
    expect(h.controller.following).toBe(true)
    expect(h.scroll.scrollTop).toBe(1200)
  })

  it('lets a small upward wheel gesture cancel a pending frame, even near the bottom', () => {
    const h = harness()
    h.controller.changed(); h.wheel(-10); h.scroll.scrollTop = 590; h.fireScroll(); h.flush()
    expect(h.controller.following).toBe(false)
    h.setHeight(1500); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(590)
    expect(h.jump.hidden).toBe(false)
  })

  it('detects user upward movement coalesced with a programmatic scroll event', () => {
    const h = harness()
    h.setHeight(1060); h.resize(); h.flush()
    h.scroll.scrollTop = 710; h.fireScroll()
    expect(h.controller.following).toBe(false)
  })

  it('does not mistake clamping after content shrink or viewport growth for upward intent', () => {
    const h = harness()
    h.setHeight(600); h.fireScroll(); h.resize(); h.flush()
    expect(h.controller.following).toBe(true)
    h.setViewport(500); h.fireScroll(); h.resize(); h.flush()
    expect(h.controller.following).toBe(true)
    h.setHeight(1200); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(700)
  })

  it('preserves a reader position on resize and resumes when they scroll down to the tail', () => {
    const h = harness()
    h.scroll.scrollTop = 200; h.fireScroll()
    h.setViewport(200); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(200)
    h.scroll.scrollTop = 690; h.fireScroll(); h.flush()
    expect(h.controller.following).toBe(true)
    expect(h.scroll.scrollTop).toBe(700)
  })

  it('jump to latest restores following, hides the button, and moves focus to the transcript', () => {
    const h = harness()
    h.scroll.scrollTop = 100; h.fireScroll()
    h.jump.focus(); h.jump.click(); h.flush()
    expect(h.scroll.scrollTop).toBe(600)
    expect(h.controller.following).toBe(true)
    expect(h.jump.hidden).toBe(true)
    expect(document.activeElement).toBe(h.scroll)
  })

  it.each(['ArrowUp', 'PageUp', 'Home'])('honors %s without requiring wheel input', key => {
    const h = harness()
    h.scroll.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    expect(h.controller.following).toBe(false)
  })

  it('does not treat text editing, horizontal scrolling or zooming as transcript navigation', () => {
    const h = harness()
    const input = document.createElement('textarea'); h.content.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    h.wheel(0, h.scroll, { deltaX: -100 })
    h.wheel(-100, h.scroll, { ctrlKey: true })
    expect(h.controller.following).toBe(true)
  })

  it('ignores nested vertical scrolling until it can reach the outer conversation', () => {
    const h = harness()
    const pre = document.createElement('pre'); pre.style.overflowY = 'auto'; h.content.append(pre)
    Object.defineProperties(pre, { scrollHeight: { value: 600 }, clientHeight: { value: 100 } })
    pre.scrollTop = 100; h.wheel(-10, pre)
    pre.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    expect(h.controller.following).toBe(true)
    pre.scrollTop = 0; h.wheel(-10, pre)
    expect(h.controller.following).toBe(false)
  })

  it('pauses during scrollbar dragging and resumes only when released at the bottom', () => {
    const h = harness()
    h.scroll.dispatchEvent(new MouseEvent('pointerdown', { clientX: 414 }))
    expect(h.controller.following).toBe(false)
    h.scroll.scrollTop = 200; h.fireScroll()
    h.setHeight(1200); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(200)
    h.scroll.scrollTop = 900; h.fireScroll()
    expect(h.controller.following).toBe(false)
    window.dispatchEvent(new Event('pointerup')); h.flush()
    expect(h.controller.following).toBe(true)
  })

  it('handles upward touch gestures', () => {
    const h = harness()
    const touch = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true }); Object.defineProperty(event, 'touches', { value: [{ clientY }] }); h.scroll.dispatchEvent(event)
    }
    touch('touchstart', 50); touch('touchmove', 80)
    expect(h.controller.following).toBe(false)
  })

  it('preserves the visible message when history is prepended while the tail also grows', () => {
    const h = harness()
    const row = document.createElement('article'); row.dataset.scrollId = 'message'; h.content.append(row)
    let rowTop = 590
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({ top: rowTop - h.scroll.scrollTop, bottom: rowTop + 100 - h.scroll.scrollTop }) as DOMRect)
    const restore = h.controller.preserveHistory()
    rowTop += 300; h.setHeight(1400) // 300px earlier history + 200px new output
    restore(); h.fireScroll(); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(900)
    expect(h.controller.following).toBe(false)
  })

  it('lets the user move while history is loading and does not override that new position', () => {
    const h = harness()
    const row = document.createElement('article'); row.dataset.scrollId = 'message'; h.content.append(row)
    let rowTop = 400
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({ top: rowTop - h.scroll.scrollTop, bottom: rowTop + 300 - h.scroll.scrollTop }) as DOMRect)
    const restore = h.controller.preserveHistory()
    h.scroll.scrollTop = 450; h.fireScroll()
    rowTop += 200; h.setHeight(1100); restore()
    expect(h.scroll.scrollTop).toBe(650)
  })

  it.each(['reset', 'resume'] as const)('cancels stale history restoration on %s', action => {
    const h = harness()
    const restore = h.controller.preserveHistory()
    h.controller[action](); h.setHeight(1600); h.flush()
    restore()
    expect(h.scroll.scrollTop).toBe(1300)
    expect(h.controller.following).toBe(true)
  })

  it('cancels pending work on disposal and removes event listeners', () => {
    const h = harness()
    h.setHeight(1200); h.resize(); h.controller.dispose(); h.flush()
    expect(h.scroll.scrollTop).toBe(600)
    h.wheel(-100)
    expect(h.controller.following).toBe(true)
    expect(h.frames.size).toBe(0)
    expect(h.disconnect).toHaveBeenCalled()
    expect(h.jump.hidden).toBe(true)
  })

  it('resumes layout following after a hidden panel becomes visible', () => {
    const h = harness()
    h.setViewport(0); h.setHeight(1400); h.resize(); h.flush()
    expect(h.jump.hidden).toBe(true)
    h.setViewport(300); h.resize(); h.flush()
    expect(h.scroll.scrollTop).toBe(1100)
    expect(h.controller.following).toBe(true)
  })

  it('restores history only once, even when an old callback is invoked again', () => {
    const h = harness()
    const older = h.controller.preserveHistory()
    const latest = h.controller.preserveHistory()
    h.setHeight(1100); older()
    expect(h.scroll.scrollTop).toBe(600)
    latest()
    expect(h.scroll.scrollTop).toBe(800)
    h.setHeight(1300); latest()
    expect(h.scroll.scrollTop).toBe(800)
  })
})
