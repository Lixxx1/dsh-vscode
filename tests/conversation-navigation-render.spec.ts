import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { chatHtml } from '../src/webview.js'
import { createConversationScroller } from '../src/conversation-scroll.mjs'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.clearAllTimers(); vi.useRealTimers() })

function harness() {
  vi.useFakeTimers()
  const uri = { toString: () => 'https://assets.invalid/test' } as any
  const html = chatHtml({ cspSource: 'https://assets.invalid' } as any, uri, { script: uri, style: uri, scroll: uri })
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window as any
  const sent: any[] = []
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  w.requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  w.cancelAnimationFrame = (id: number) => frames.delete(id)
  w.setTimeout = setTimeout
  w.clearTimeout = clearTimeout
  w.ResizeObserver = class { observe() {} disconnect() {} }
  // jsdom has no dialog lifecycle/layout. Exercise real production event
  // handlers; geometry and native dialog behavior remain browser-test coverage.
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true }
  w.HTMLDialogElement.prototype.close = function() {
    this.open = false
    setTimeout(() => this.dispatchEvent(new w.Event('close')), 0)
  }
  w.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(message) })
  w.dshConversationScroll = { createConversationScroller }
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]
  const view = w.eval(`(() => { ${script}; return {
    node: id => renderedMessages.get(id)?.node,
    pending: () => ({frame: renderFrame, state: pendingRenderState}),
    following: () => conversationScroller.following,
    dispose: () => conversationScroller.dispose(),
  }; })()`)
  cleanup.push(() => { view.dispose(); w.close() })
  const get = (id: string) => w.document.getElementById(id)
  const receive = (data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data }))
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }
  const baseline = { phase: 'ready', sessionId: 'a', workspaceName: 'demo', sessions: [], models: [], permissions: [],
    commands: [], skills: [], queue: [], changedFiles: [], messages: [{ id: 'first', role: 'user', text: 'hi' }] }
  const show = (extra = {}) => receive({ type: 'state', state: { ...baseline, ...extra } })
  show(); flushFrames()
  const open = (id = 'first') => {
    get('navigationTrigger').click()
    const search = sent.findLast(message => message.type === 'search-conversation')
    receive({ type: 'conversation-search', sessionId: 'a', requestId: search.requestId,
      result: { sessionId: 'a', query: '', total: 1, indexedMessages: 1, hasMore: false, limited: false,
        matches: [{ id, role: 'user', label: 'You', snippet: 'hi' }] } })
    get('navigationResults').querySelector('button').click()
    return sent.findLast(message => message.type === 'reveal-conversation-message')
  }
  const ack = (request: any) => receive({ ...request, type: 'conversation-revealed' })
  return { w, get, sent, view, frames, flushFrames, show, open, ack, receive }
}

describe('navigation with suspended animation frames', () => {
  it('flushes the latest full state and jumps without a paint or a leftover render', () => {
    const h = harness()
    h.get('prompt').value = 'Keep my draft'
    const request = h.open()
    const original = h.view.node('first')
    h.show({ messages: [{ id: 'first', role: 'user', text: 'updated hi' }] })
    expect(h.view.node('first')).toBe(original) // The paint has not run.
    h.ack(request)
    const target = h.view.node('first')
    expect(h.get('navigationPanel').open).toBe(false)
    expect(target.textContent).toContain('updated hi')
    expect(target.classList.contains('navigation-target')).toBe(true)
    expect(h.w.document.activeElement).toBe(target)
    expect(h.view.pending()).toEqual({ frame: undefined, state: undefined })
    expect(h.frames.size).toBe(0)
    expect(h.view.following()).toBe(false)
    h.flushFrames(); vi.advanceTimersByTime(30_000)
    expect(h.view.node('first')).toBe(target)
    expect(h.w.document.activeElement).toBe(target)
    expect(h.get('prompt').value).toBe('Keep my draft')
    expect(h.sent.filter(message => message.type === 'webview-error')).toEqual([])
  })

  it('jumps to an existing node on acknowledgement without any pending state', () => {
    const h = harness()
    const target = h.view.node('first')
    h.ack(h.open())
    expect(h.get('navigationPanel').open).toBe(false)
    expect(h.w.document.activeElement).toBe(target)
    expect(h.frames.size).toBe(0)
    expect(h.view.following()).toBe(false)
  })

  it.each(['state', 'state-update'])('waits for content after ACK, then handles %s without a paint', type => {
    const h = harness()
    h.ack(h.open('older'))
    expect(h.get('navigationPanel').open).toBe(true)
    expect(h.get('navigationStatus').textContent).toBe('Waiting for message content…')
    const message = { id: 'older', role: 'user', text: 'earlier question' }
    if (type === 'state') h.show({ messages: [message] })
    else h.receive({ type, update: { patch: {}, messages: { upserts: [message] } } })
    expect(h.get('navigationPanel').open).toBe(false)
    expect(h.w.document.activeElement).toBe(h.view.node('older'))
    expect(h.view.following()).toBe(false)
  })

  it.each([false, true])('reports the correct timeout stage (acknowledged: %s) and permits retry', acknowledged => {
    const h = harness()
    const request = h.open('missing')
    if (acknowledged) h.ack(request)
    vi.advanceTimersByTime(30_000)
    expect(h.get('navigationStatus').textContent).toBe(acknowledged
      ? 'The message was confirmed, but its content did not arrive. Try Refresh.'
      : 'Opening the message timed out. Try again.')
    expect(h.get('navigationQuery').disabled).toBe(false)
    expect(h.get('navigationRefresh').disabled).toBe(false)
    expect(h.get('navigationResults').querySelector('button').disabled).toBe(false)
    h.ack(request) // A late acknowledgement must not revive the failed jump.
    h.show({ messages: [{ id: 'missing', role: 'user', text: 'late' }] }); h.flushFrames()
    expect(h.get('navigationPanel').open).toBe(true)
    expect(h.view.node('missing').classList.contains('navigation-target')).toBe(false)
    h.get('navigationRefresh').click()
    expect(h.sent.at(-1)).toMatchObject({ type: 'search-conversation', refresh: true })
  })

  it.each([{ sessionId: 'b' }, { phase: 'connecting' }])('closes immediately on %j and ignores a late ACK', update => {
    const h = harness()
    const request = h.open('older')
    h.show(update) // No frame can render the new session/state yet.
    expect(h.get('navigationPanel').open).toBe(false)
    h.ack(request); vi.advanceTimersByTime(0); h.flushFrames()
    expect(h.w.document.querySelector('.navigation-target')).toBeNull()
    expect(h.get('navigationQuery').disabled).toBe(false)
    expect(h.sent.filter(message => message.type === 'webview-error')).toEqual([])
  })

  it('does not focus a message after the user closes the panel', () => {
    const h = harness()
    const request = h.open()
    h.get('navigationClose').click()
    h.ack(request) // close event has not fired yet.
    vi.advanceTimersByTime(0); h.flushFrames()
    expect(h.w.document.querySelector('.navigation-target')).toBeNull()
    expect(h.w.document.activeElement).toBe(h.get('navigationTrigger'))
  })
})
