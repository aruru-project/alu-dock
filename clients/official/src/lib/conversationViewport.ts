import { nextTick, onUnmounted, ref, watch, type Ref } from 'vue'

interface ConversationTextAnchor {
  node: Text
  offset: number
  quote: string
  quoteOffset: number
  quoteOccurrence: number
  viewportOffset: number
}

export interface ConversationReadingAnchor {
  surface: HTMLElement
  id?: string
  offset?: number
  text?: ConversationTextAnchor
  scrollTop: number
  scrollHeight: number
}

const ACTUAL_BOTTOM_TOLERANCE = 2
const FOLLOW_RESUME_DISTANCE = 160

export function conversationBottomGap(surface: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): number {
  return Math.max(0, surface.scrollHeight - surface.scrollTop - surface.clientHeight)
}

export function conversationIsAtBottom(surface: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return conversationBottomGap(surface) <= ACTUAL_BOTTOM_TOLERANCE
}

export function conversationFollowAfterScroll(
  following: boolean,
  previousScrollTop: number | null,
  nextScrollTop: number,
  bottomGap: number,
): boolean {
  if (bottomGap <= ACTUAL_BOTTOM_TOLERANCE) return true
  if (previousScrollTop !== null && nextScrollTop < previousScrollTop) return false
  const movingDown = previousScrollTop !== null && nextScrollTop > previousScrollTop
  return movingDown && bottomGap < FOLLOW_RESUME_DISTANCE ? true : following
}

/** Owns reading intent, actual-bottom geometry, anchors, observers, and every
 * application-authored scroll write for the conversation viewport. */
export function useConversationViewport(surfaceRef: Ref<HTMLElement | null>) {
  const awayFromBottom = ref(false)
  let following = true
  let lastScrollTop: number | null = null
  let frame = 0
  let forceBottom = false
  let resizeObserver: ResizeObserver | null = null
  let observedContent: Element | null = null

  function syncGeometry(surface: HTMLElement) {
    const atBottom = conversationIsAtBottom(surface)
    if (atBottom) following = true
    awayFromBottom.value = !atBottom
    lastScrollTop = surface.scrollTop
  }

  function observeContent(surface: HTMLElement) {
    if (!resizeObserver) return
    const content = surface.querySelector('[data-conversation-flow]')
    if (content === observedContent) return
    if (observedContent) resizeObserver.unobserve(observedContent)
    observedContent = content
    if (content) resizeObserver.observe(content)
  }

  function runLayoutFrame() {
    frame = 0
    const forced = forceBottom
    forceBottom = false
    const surface = surfaceRef.value
    if (!surface) return
    observeContent(surface)
    if (forced || following) surface.scrollTop = surface.scrollHeight
    syncGeometry(surface)
  }

  function scheduleLayout(force = false) {
    if (force) forceBottom = true
    if (!force && !following) {
      const surface = surfaceRef.value
      if (surface) syncGeometry(surface)
      return
    }
    if (!frame) frame = window.requestAnimationFrame(runLayoutFrame)
  }

  function layoutChanged() {
    void nextTick().then(() => scheduleLayout())
  }

  function scrollToBottom() {
    following = true
    awayFromBottom.value = false
    void nextTick().then(() => scheduleLayout(true))
  }

  function handleScroll() {
    const surface = surfaceRef.value
    if (!surface) return
    const nextTop = surface.scrollTop
    const gap = conversationBottomGap(surface)
    const atBottom = gap <= ACTUAL_BOTTOM_TOLERANCE
    const movedUp = lastScrollTop !== null && nextTop < lastScrollTop
    following = conversationFollowAfterScroll(following, lastScrollTop, nextTop, gap)
    if (movedUp && !atBottom && frame && !forceBottom) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    awayFromBottom.value = !atBottom
    lastScrollTop = nextTop
  }

  function reset() {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    forceBottom = false
    following = true
    lastScrollTop = null
    awayFromBottom.value = false
  }

  function textPointTop(node: Text, offset: number): number | null {
    if (!node.data.length) return null
    const range = node.ownerDocument.createRange()
    const start = Math.min(offset, node.data.length - 1)
    range.setStart(node, start)
    range.setEnd(node, start + 1)
    const rect = range.getBoundingClientRect()
    return rect.height || rect.width ? rect.top : null
  }

  function captureTextAnchor(surface: HTMLElement, surfaceTop: number): { id: string; anchor: ConversationTextAnchor } | null {
    const document = surface.ownerDocument as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const rect = surface.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = Math.min(rect.bottom - 1, surfaceTop + 1)
    const caret = document.caretPositionFromPoint?.(x, y)
    const fallbackRange = caret ? null : document.caretRangeFromPoint?.(x, y)
    const node = caret?.offsetNode ?? fallbackRange?.startContainer
    const offset = caret?.offset ?? fallbackRange?.startOffset
    if (!(node instanceof Text) || offset == null || !surface.contains(node)) return null
    const root = node.parentElement?.closest<HTMLElement>('[data-conversation-id]')
    const top = textPointTop(node, offset)
    const id = root?.dataset.conversationId
    if (!root || !id || top == null) return null

    const lineStart = node.data.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
    const nextBreak = node.data.indexOf('\n', offset)
    const lineEnd = nextBreak < 0 ? node.data.length : nextBreak
    const quoteStart = Math.max(lineStart, offset - 24)
    const quoteEnd = Math.min(lineEnd, Math.max(offset + 40, quoteStart + 40))
    const quote = node.data.slice(quoteStart, quoteEnd)
    if (!quote) return null
    // Repeated sentences must resolve to the same occurrence, not the first
    // matching paragraph. This scans only the current part at presentation change.
    const prefixRange = document.createRange()
    prefixRange.selectNodeContents(root)
    prefixRange.setEnd(node, quoteStart)
    const prefix = prefixRange.toString()
    let quoteOccurrence = 0
    for (let index = prefix.indexOf(quote); index >= 0; index = prefix.indexOf(quote, index + 1)) quoteOccurrence++
    return {
      id,
      anchor: { node, offset, quote, quoteOffset: offset - quoteStart, quoteOccurrence, viewportOffset: top - surfaceTop },
    }
  }

  function resolveTextAnchor(root: HTMLElement, anchor: ConversationTextAnchor): { node: Text; offset: number } | null {
    if (anchor.node.isConnected && root.contains(anchor.node)) return { node: anchor.node, offset: anchor.offset }
    const text = root.textContent ?? ''
    let quoteStart = text.indexOf(anchor.quote)
    for (let occurrence = 0; occurrence < anchor.quoteOccurrence && quoteStart >= 0; occurrence++) {
      quoteStart = text.indexOf(anchor.quote, quoteStart + 1)
    }
    if (quoteStart < 0) return null
    let remaining = quoteStart + anchor.quoteOffset
    const walker = root.ownerDocument.createTreeWalker(root, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node as Text).data
      if (remaining <= value.length) return { node: node as Text, offset: remaining }
      remaining -= value.length
    }
    return null
  }

  function captureAnchor(preserveText = false): ConversationReadingAnchor | null {
    const surface = surfaceRef.value
    if (!surface) return null
    const surfaceTop = surface.getBoundingClientRect().top
    const text = preserveText ? captureTextAnchor(surface, surfaceTop) : null
    const element = text
      ? [...surface.querySelectorAll<HTMLElement>('[data-conversation-id]')]
        .find((candidate) => candidate.dataset.conversationId === text.id)
      : [...surface.querySelectorAll<HTMLElement>('[data-conversation-id]')]
        .find((candidate) => candidate.getBoundingClientRect().bottom >= surfaceTop)
    return {
      surface,
      id: element?.dataset.conversationId,
      offset: element ? element.getBoundingClientRect().top - surfaceTop : undefined,
      text: text?.anchor,
      scrollTop: surface.scrollTop,
      scrollHeight: surface.scrollHeight,
    }
  }

  async function restoreAnchor(anchor: ConversationReadingAnchor | null, stickToBottom: boolean) {
    await nextTick()
    if (!anchor || surfaceRef.value !== anchor.surface) return
    if (stickToBottom) {
      // Automatic layout work must remain cancellable by a later user scroll.
      scheduleLayout()
      return
    }
    const next = anchor.id
      ? [...anchor.surface.querySelectorAll<HTMLElement>('[data-conversation-id]')]
        .find((element) => element.dataset.conversationId === anchor.id)
      : undefined
    const text = next && anchor.text ? resolveTextAnchor(next, anchor.text) : null
    const textTop = text ? textPointTop(text.node, text.offset) : null
    if (textTop != null && anchor.text) {
      anchor.surface.scrollTop += (textTop - anchor.surface.getBoundingClientRect().top) - anchor.text.viewportOffset
    } else if (next && anchor.offset != null) {
      anchor.surface.scrollTop += (next.getBoundingClientRect().top - anchor.surface.getBoundingClientRect().top) - anchor.offset
    } else {
      anchor.surface.scrollTop = anchor.scrollTop + (anchor.surface.scrollHeight - anchor.scrollHeight)
    }
    following = false
    syncGeometry(anchor.surface)
  }

  function mediaLoaded(event: Event) {
    if (event.target instanceof HTMLImageElement && event.target.closest('[data-conversation-id]')) layoutChanged()
  }

  function attach(surface: HTMLElement | null) {
    resizeObserver?.disconnect()
    resizeObserver = null
    observedContent = null
    if (!surface || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => layoutChanged())
    resizeObserver.observe(surface)
    observeContent(surface)
    syncGeometry(surface)
  }

  watch(surfaceRef, attach, { flush: 'post' })
  onUnmounted(() => {
    if (frame) window.cancelAnimationFrame(frame)
    resizeObserver?.disconnect()
  })

  return {
    awayFromBottom,
    handleScroll,
    mediaLoaded,
    layoutChanged,
    scrollToBottom,
    reset,
    captureAnchor,
    restoreAnchor,
    isFollowing: () => following,
  }
}
