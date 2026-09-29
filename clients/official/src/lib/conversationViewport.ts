import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ConversationReadingPosition } from './localState'

interface ConversationTextAnchor {
  node?: Text
  offset?: number
  quote: string
  quoteOffset: number
  quoteOccurrence: number
  viewportOffset: number
}

export interface ConversationReadingAnchor {
  intentRevision?: number
  element?: HTMLElement
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

export interface ReadingScope { connectionId: string; workId: string; hostEpoch: string; sessionId: string }
interface ReadingPersistence {
  read(scope: ReadingScope): ConversationReadingPosition | undefined
  write(scope: ReadingScope, position: ConversationReadingPosition): boolean
}

/** Owns reading intent, actual-bottom geometry, anchors, observers, and every
 * application-authored scroll write for the conversation viewport. */
export function useConversationViewport(surfaceRef: Ref<HTMLElement | null>, persistence?: ReadingPersistence) {
  const awayFromBottom = ref(false)
  let following = true
  let lastScrollTop: number | null = null
  let authoredScrollTop: number | null = null
  let frame = 0
  let forceBottom = false
  let resizeObserver: ResizeObserver | null = null
  let observedContent: Element | null = null
  const readingError = ref<string | null>(null)
  let scope: ReadingScope | null = null
  let initialBinding = true
  let pending: ConversationReadingPosition | null = null
  let heldAnchor: ConversationReadingAnchor | null = null
  let intentRevision = 0
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let seedComplete = false
  let attached: HTMLElement | null = null
  let disposed = false

  function snapshotPosition(): ConversationReadingPosition | null {
    if (!scope) return null
    if (pending) return pending
    // Keep a restored text point through an initially folded/preview-only
    // record. A real user gesture/scroll replaces heldAnchor immediately.
    const anchor = !following && heldAnchor?.text ? heldAnchor : captureAnchor(true)
    if (!following && anchor) heldAnchor = anchor
    if (!following && !anchor?.id) return null
    return { hostEpoch: scope.hostEpoch, sessionId: scope.sessionId,
      following, scrollTop: Math.max(0, surfaceRef.value?.scrollTop ?? 0),
      ...(anchor?.id ? { id: anchor.id, offset: anchor.offset } : {}),
      ...(anchor?.text ? { text: { quote: anchor.text.quote, quoteOffset: anchor.text.quoteOffset,
        quoteOccurrence: anchor.text.quoteOccurrence, viewportOffset: anchor.text.viewportOffset } } : {}),
    }
  }
  function savePosition() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    if (!scope || !persistence || pending) return
    const position = snapshotPosition()
    if (!position) return
    readingError.value = persistence.write(scope, position) ? null : '阅读位置未能保存，请检查本机存储后重试；仍可继续阅读。'
  }
  function scheduleSave() {
    if (!scope || !persistence) return
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(savePosition, 250)
  }
  function bindScope(next: ReadingScope | null, rebuilding = false) {
    const same = JSON.stringify(next) === JSON.stringify(scope)
    if (same && !rebuilding) return
    const retained = same ? snapshotPosition() : null
    savePosition()
    reset()
    scope = next ? { ...next } : null
    // Stored positions resume a rebuilt view only. Switching Work starts a new
    // visit at the latest output; only a same-Work rebind keeps this visit's anchor.
    const saved = retained ?? (initialBinding && scope ? persistence?.read(scope) : undefined)
    if (scope) initialBinding = false
    if (saved && saved.hostEpoch === scope!.hostEpoch && saved.sessionId === scope!.sessionId) {
      pending = saved
      following = saved.following
    }
    layoutChanged()
  }
  function seeded() { seedComplete = true; layoutChanged() }
  function userIntent(event?: Event) {
    if (event?.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes((event as KeyboardEvent).key)) return
    intentRevision++
    pending = null
    forceBottom = false
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    heldAnchor = null
    authoredScrollTop = null
    // A gesture wins over a delayed rebuild or layout callback, even before
    // the browser produces its scroll event. It never touches editor focus.
    following = false
    scheduleSave()
  }

  function hasReadingSelection() {
    const selection = surfaceRef.value?.ownerDocument?.getSelection?.()
    return !!selection && !selection.isCollapsed && !!selection.anchorNode && !!surfaceRef.value?.contains(selection.anchorNode)
  }
  function syncGeometry(surface: HTMLElement) {
    const atBottom = conversationIsAtBottom(surface)
    if (atBottom && !pending && !hasReadingSelection()) following = true
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

  function restoreGeometry(anchor: ConversationReadingAnchor, fallback: boolean) {
    const surface = anchor.surface
    const next = anchor.element?.isConnected && surface.contains(anchor.element) ? anchor.element : anchor.id ? elementById(surface, anchor.id) : undefined
    const point = next && anchor.text ? resolveTextAnchor(next, anchor.text) : null
    const top = point ? textPointTop(point.node, point.offset) : null
    const currentTop = surface.scrollTop
    let targetTop = currentTop
    if (top != null && anchor.text) targetTop += top - surface.getBoundingClientRect().top - anchor.text.viewportOffset
    else if (next && anchor.offset != null) {
      // Hidden/changed text must not apply an old deep pixel offset to a short
      // folded row. Stay at the confirmed entry until its text is renderable.
      const offset = anchor.text ? 0 : anchor.offset
      targetTop += next.getBoundingClientRect().top - surface.getBoundingClientRect().top - offset
    }
    else if (fallback) targetTop = anchor.scrollTop + (surface.scrollHeight - anchor.scrollHeight)
    // Even assigning the same position can interrupt native momentum scrolling.
    if (Math.abs(targetTop - currentTop) >= 0.5) surface.scrollTop = targetTop
    authoredScrollTop = surface.scrollTop
    heldAnchor = next ? { ...anchor, element: next, scrollTop: surface.scrollTop, scrollHeight: surface.scrollHeight } : null
  }
  function runLayoutFrame() {
    frame = 0
    const forced = forceBottom
    forceBottom = false
    const surface = surfaceRef.value
    if (!surface) return
    observeContent(surface)
    if (!forced && hasReadingSelection()) { pending = null; following = false }
    if (pending && !pending.following) {
      const element = pending.id ? elementById(surface, pending.id) : null
      if (element) {
        restoreGeometry({ surface, element, id: pending.id, offset: pending.offset, text: pending.text,
          scrollTop: pending.scrollTop, scrollHeight: surface.scrollHeight }, false)
        pending = null
        following = false
      } else if (seedComplete) {
        // An entry absent from the current branch/cache cannot be located by
        // guessing old pixels or scanning all history. Use this target's end.
        pending = null
        heldAnchor = null
        following = true
        surface.scrollTop = surface.scrollHeight
      } else return
    } else if (forced || following) {
      surface.scrollTop = surface.scrollHeight
      if (seedComplete) pending = null
    } else if (heldAnchor) restoreGeometry(heldAnchor, false)
    authoredScrollTop = surface.scrollTop
    syncGeometry(surface)
    scheduleSave()
  }
  function scheduleLayout(force = false) {
    if (force) forceBottom = true
    if (!frame) frame = window.requestAnimationFrame(runLayoutFrame)
  }

  function layoutChanged() {
    void nextTick().then(() => { if (!disposed) scheduleLayout() })
  }

  function scrollToBottom() {
    intentRevision++
    pending = null
    heldAnchor = null
    following = true
    awayFromBottom.value = false
    const revision = intentRevision
    void nextTick().then(() => { if (!disposed && revision === intentRevision) scheduleLayout(true) })
  }

  function handleScroll() {
    const surface = surfaceRef.value
    if (!surface) return
    if (authoredScrollTop !== null && Math.abs(surface.scrollTop - authoredScrollTop) < 0.5) {
      authoredScrollTop = null
      syncGeometry(surface)
      return
    }
    authoredScrollTop = null
    if (pending) return // Layout scrolls during progressive rebuild are not user gestures.
    const nextTop = surface.scrollTop
    const gap = conversationBottomGap(surface)
    const atBottom = gap <= ACTUAL_BOTTOM_TOLERANCE
    const movedUp = lastScrollTop !== null && nextTop < lastScrollTop
    following = !hasReadingSelection() && conversationFollowAfterScroll(following, lastScrollTop, nextTop, gap)
    if (movedUp && !atBottom && frame && !forceBottom) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    awayFromBottom.value = !atBottom
    lastScrollTop = nextTop
    heldAnchor = following ? null : captureAnchor()
    intentRevision++
    scheduleSave()
  }

  function reset() {
    readingError.value = null
    intentRevision++
    pending = null
    heldAnchor = null
    seedComplete = false
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    forceBottom = false
    following = true
    lastScrollTop = null
    authoredScrollTop = null
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
    if (typeof Text === 'undefined' || !(node instanceof Text) || offset == null || !surface.contains(node)) return null
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
    if (anchor.node?.isConnected && root.contains(anchor.node) && anchor.offset != null) return { node: anchor.node, offset: anchor.offset }
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

  function elementById(surface: HTMLElement, id: string) {
    const escaped = id.replace(/[\x00-\x1f\x7f"\\]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)
    return surface.querySelector<HTMLElement>(`[data-conversation-id="${escaped}"]`)
  }

  function captureAnchor(preserveText = false, changedIds?: Set<string>): ConversationReadingAnchor | null {
    const surface = surfaceRef.value
    if (!surface) return null
    const surfaceRect = surface.getBoundingClientRect()
    const surfaceTop = surfaceRect.top
    const byId = (id: string) => elementById(surface, id)
    if (changedIds && [...changedIds].every((id) => {
      const element = byId(id)
      return element && element.getBoundingClientRect().top > surfaceTop + 1
    })) return null
    const text = preserveText ? captureTextAnchor(surface, surfaceTop) : null
    const element = text
      ? byId(text.id)
      : surface.ownerDocument?.elementsFromPoint?.(surfaceRect.left + surfaceRect.width / 2, surfaceTop + 1)
        .find((candidate) => surface.contains(candidate) && candidate.hasAttribute('data-conversation-id')) as HTMLElement | undefined
        ?? [...surface.querySelectorAll<HTMLElement>('[data-conversation-id]')].find((candidate) => candidate.getBoundingClientRect().bottom >= surfaceTop)
    return {
      intentRevision,
      surface,
      element: element ?? undefined,
      id: element?.dataset.conversationId,
      offset: element ? element.getBoundingClientRect().top - surfaceTop : undefined,
      text: text?.anchor,
      scrollTop: surface.scrollTop,
      scrollHeight: surface.scrollHeight,
    }
  }

  async function restoreAnchor(anchor: ConversationReadingAnchor | null, stickToBottom: boolean) {
    const revision = intentRevision
    await nextTick()
    if (revision !== intentRevision || (anchor?.intentRevision != null && anchor.intentRevision !== intentRevision)) return
    if (pending) { scheduleLayout(); return }
    if (!anchor || surfaceRef.value !== anchor.surface) return
    if (stickToBottom) { scheduleLayout(); return }
    restoreGeometry(anchor, true)
    following = false
    syncGeometry(anchor.surface)
    scheduleSave()
  }

  function mediaLoaded(event: Event) {
    if (event.target instanceof HTMLImageElement && event.target.closest('[data-conversation-id]')) layoutChanged()
  }

  function attach(surface: HTMLElement | null) {
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) attached?.removeEventListener?.(name, userIntent)
    attached = surface
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) surface?.addEventListener?.(name, userIntent, { passive: true })
    resizeObserver?.disconnect()
    resizeObserver = null
    observedContent = null
    if (!surface || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => layoutChanged())
    resizeObserver.observe(surface)
    observeContent(surface)
    syncGeometry(surface)
  }

  watch(surfaceRef, attach, { flush: 'post', immediate: true })
  watch(readingError, layoutChanged)
  const leaving = () => savePosition()
  const hiding = () => { if (document.visibilityState === 'hidden') savePosition() }
  const selecting = () => { if (hasReadingSelection()) userIntent() }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', leaving)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', hiding)
    document.addEventListener('selectionchange', selecting)
  }
  onScopeDispose(() => {
    disposed = true
    savePosition()
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', leaving)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', hiding)
      document.removeEventListener('selectionchange', selecting)
    }
    attach(null)
    if (frame) window.cancelAnimationFrame(frame)
    resizeObserver?.disconnect()
  })

  return {
    readingError, bindScope, seeded, savePosition,
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
