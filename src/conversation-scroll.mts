/** Conversation scrolling: following is user intent, not a distance measurement. */
export function createConversationScroller(scroll: HTMLElement, content: HTMLElement, jump: HTMLButtonElement) {
  const view = scroll.ownerDocument.defaultView!
  const lifetime = new view.AbortController()
  const options = { signal: lifetime.signal, passive: true }
  let following = true
  let frame: number | undefined
  let expectedTop: number | undefined
  let lastTop = scroll.scrollTop
  let dragging = false
  let touchY: number | undefined
  let history: ReturnType<typeof anchor> | undefined
  let historyGeneration = 0
  let intentVersion = 0
  let disposed = false

  function maximum() { return Math.max(0, scroll.scrollHeight - scroll.clientHeight) }
  function atBottom() { return maximum() - scroll.scrollTop <= 2 }
  function updateButton() {
    jump.hidden = disposed || scroll.clientHeight === 0 || atBottom()
  }
  function cancelFrame() {
    if (frame !== undefined) view.cancelAnimationFrame(frame)
    frame = undefined
  }
  function writeTop(top: number) {
    const before = scroll.scrollTop
    scroll.scrollTop = top
    // Read back the clamped value, including fractional positions. A browser
    // scroll event may arrive after another streamed chunk has already rendered.
    lastTop = scroll.scrollTop
    if (lastTop !== before) expectedTop = lastTop
    updateButton()
  }
  function changed() {
    if (disposed) return
    updateButton()
    if (!following || history || dragging || frame !== undefined || scroll.clientHeight === 0) return
    frame = view.requestAnimationFrame(() => {
      frame = undefined
      if (!disposed && following && !history && !dragging) writeTop(maximum())
    })
  }
  function pause() {
    intentVersion++
    following = false
    cancelFrame()
    updateButton()
  }
  function resume() {
    if (disposed) return
    intentVersion++
    historyGeneration++
    history = undefined
    following = true
    changed()
  }
  function anchor() {
    const top = scroll.getBoundingClientRect().top
    const item = [...content.querySelectorAll<HTMLElement>('[data-scroll-id]')]
      .find(element => element.getBoundingClientRect().bottom > top)
    return {
      id: item?.dataset.scrollId,
      offset: item ? item.getBoundingClientRect().top - top : 0,
      top: scroll.scrollTop,
      height: scroll.scrollHeight,
    }
  }
  function onScroll() {
    const top = scroll.scrollTop
    const previous = expectedTop ?? lastTop
    const ours = expectedTop !== undefined && Math.abs(top - expectedTop) < 1
    expectedTop = undefined
    lastTop = top
    updateButton()
    if (history) {
      // Allow the reader to move while an earlier-history request is in flight.
      history = anchor()
      return
    }
    if (ours) return
    // Content shrink / viewport growth can clamp scrollTop without user input.
    // Content growth alone must never turn following off (issue #30).
    if (top < Math.min(previous, maximum()) - 1) pause()
    else if (!dragging && top > previous && maximum() - top <= 24) resume()
  }

  /** Only react if this gesture can reach the conversation, not a nested scroller. */
  function reachesConversation(target: EventTarget | null, direction: number) {
    let element = target instanceof view.Element ? target : undefined
    if (!element || !scroll.contains(element)) return false
    while (element && element !== scroll) {
      const style = view.getComputedStyle(element)
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
        if (direction < 0 && element.scrollTop > 0) return false
        if (direction > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return false
        if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return false
      }
      element = element.parentElement ?? undefined
    }
    return true
  }
  function upwardGesture(target: EventTarget | null, direction: number) {
    if (direction < 0 && maximum() > 0 && reachesConversation(target, direction)) pause()
  }

  scroll.addEventListener('scroll', onScroll, options)
  scroll.addEventListener('wheel', event => {
    if (!event.ctrlKey) upwardGesture(event.target, event.deltaY)
  }, options)
  scroll.addEventListener('keydown', event => {
    const target = event.target
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !(target instanceof view.Element)
      || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
    const up = ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
      || (event.key === ' ' && event.shiftKey && !target.closest('button, summary, a'))
    if (up) upwardGesture(target, -1)
  }, options)
  scroll.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY }, options)
  scroll.addEventListener('touchmove', event => {
    const next = event.touches[0]?.clientY
    if (next !== undefined && touchY !== undefined) upwardGesture(event.target, touchY - next)
    touchY = next
  }, options)
  scroll.addEventListener('touchend', () => { touchY = undefined }, options)
  scroll.addEventListener('touchcancel', () => { touchY = undefined }, options)
  scroll.addEventListener('pointerdown', event => {
    const right = scroll.getBoundingClientRect().right
    const scrollbarWidth = Math.max(16, scroll.offsetWidth - scroll.clientWidth)
    if (event.target === scroll && event.clientX >= right - scrollbarWidth) {
      dragging = true
      pause()
    }
  }, options)
  const finishDrag = () => {
    if (!dragging) return
    dragging = false
    if (!history && atBottom()) resume()
  }
  view.addEventListener('pointerup', finishDrag, options)
  view.addEventListener('pointercancel', finishDrag, options)
  jump.addEventListener('click', () => {
    // Move keyboard focus off the button before it disappears.
    scroll.focus({ preventScroll: true })
    resume()
  }, { signal: lifetime.signal })
  const observer = new view.ResizeObserver(changed)
  observer.observe(content)
  observer.observe(scroll)
  changed()

  return {
    changed, pause, resume,
    get following() { return following },
    get intentVersion() { return intentVersion },
    reset() {
      intentVersion++
      historyGeneration++
      cancelFrame()
      history = undefined
      dragging = false
      touchY = undefined
      expectedTop = undefined
      lastTop = scroll.scrollTop
      following = true
      changed()
    },
    preserveHistory() {
      pause()
      history = anchor()
      const generation = ++historyGeneration
      return () => {
        if (disposed || !history) return
        // reset/resume cancels the old request; a newer history request also wins.
        if (generation !== historyGeneration) return
        const current = history
        history = undefined
        const item = current.id === undefined ? undefined
          : [...content.querySelectorAll<HTMLElement>('[data-scroll-id]')].find(element => element.dataset.scrollId === current.id)
        writeTop(item
          ? scroll.scrollTop + item.getBoundingClientRect().top - scroll.getBoundingClientRect().top - current.offset
          : current.top + scroll.scrollHeight - current.height)
      }
    },
    dispose() {
      disposed = true
      cancelFrame()
      observer.disconnect()
      lifetime.abort()
      updateButton()
    },
  }
}
