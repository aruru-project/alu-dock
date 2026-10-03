import { onScopeDispose, ref, type Ref } from 'vue'

/**
 * Reorders a short vertical list by dragging a handle, with mouse, pen and touch alike: built on
 * Pointer Events, because native HTML5 drag never starts from touch in the Android WebView.
 * The handle's CSS sets `touch-action: none`, so a finger on it drags at once while a swipe
 * anywhere else still scrolls. The handle captures the pointer, so moves and the release reach
 * it wherever the finger goes. Near the scroller's top or bottom edge the list scrolls by itself.
 * Rows only move visually while dragging; the new order is committed once, on release.
 */
export function useDragReorder(options: {
  scroller: Ref<HTMLElement | null>
  ids: () => readonly string[]
  row: (id: string) => HTMLElement | undefined
  commit: (id: string, index: number) => void
}) {
  /** The row being dragged, and how far each row is shifted while it is. */
  const active = ref<string | null>(null)
  const shift = ref<Record<string, number>>({})
  let drag: {
    id: string; ids: string[]; pointerId: number; from: number; to: number
    tops: number[]; heights: number[]; pitch: number; startY: number; clientY: number; frame: number
  } | null = null

  /** Positions in the scroller's content, so scrolling during a drag keeps the arithmetic simple. */
  function contentY(clientY: number) {
    const scroller = options.scroller.value!
    return clientY - scroller.getBoundingClientRect().top + scroller.scrollTop
  }

  function start(event: PointerEvent, id: string) {
    if (drag || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
    const scroller = options.scroller.value
    const ids = [...options.ids()]
    const rows = ids.map((rowId) => options.row(rowId))
    const from = ids.indexOf(id)
    if (!scroller || from < 0 || rows.some((row) => !row)) return
    const rects = rows.map((row) => row!.getBoundingClientRect())
    const scrollerTop = scroller.getBoundingClientRect().top
    const tops = rects.map((rect) => rect.top - scrollerTop + scroller.scrollTop)
    const heights = rects.map((rect) => rect.height)
    const gap = ids.length > 1 ? tops[1]! - tops[0]! - heights[0]! : 0
    drag = { id, ids, pointerId: event.pointerId, from, to: from, tops, heights, pitch: heights[from]! + gap, startY: contentY(event.clientY), clientY: event.clientY, frame: 0 }
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId) } catch { /* the drag still follows this handle's events */ }
    event.preventDefault()
    active.value = id
  }

  /** The dragged row follows the pointer; the rows it passes slide one place towards where it came from. */
  function layout() {
    if (!drag) return
    // The row stays between the list's first and last places. Past them it would stretch the
    // scroll area, and edge scrolling would keep following it without end.
    const last = drag.ids.length - 1
    const lowest = drag.tops[0]! - drag.tops[drag.from]!
    const highest = drag.tops[last]! + drag.heights[last]! - drag.heights[drag.from]! - drag.tops[drag.from]!
    const offset = Math.min(highest, Math.max(lowest, contentY(drag.clientY) - drag.startY))
    const center = drag.tops[drag.from]! + drag.heights[drag.from]! / 2 + offset
    // A row counts as passed once the dragged centre reaches its middle (moving down) or goes
    // above it (moving up), so the clamped first and last places are reachable.
    let to = 0
    drag.ids.forEach((_, index) => {
      const middle = drag!.tops[index]! + drag!.heights[index]! / 2
      if (index > drag!.from ? center >= middle : index < drag!.from && center > middle) to++
    })
    drag.to = to
    const next: Record<string, number> = { [drag.id]: offset }
    drag.ids.forEach((rowId, index) => {
      if (drag!.from < to && index > drag!.from && index <= to) next[rowId] = -drag!.pitch
      else if (to < drag!.from && index >= to && index < drag!.from) next[rowId] = drag!.pitch
    })
    shift.value = next
  }

  function autoScroll() {
    if (!drag || drag.frame) return
    const scroller = options.scroller.value!
    const rect = scroller.getBoundingClientRect()
    const edge = Math.min(48, rect.height / 4)
    const depth = drag.clientY < rect.top + edge ? drag.clientY - rect.top - edge : drag.clientY > rect.bottom - edge ? drag.clientY - rect.bottom + edge : 0
    if (!depth) return
    drag.frame = window.requestAnimationFrame(() => {
      if (!drag) return
      drag.frame = 0
      const before = scroller.scrollTop
      scroller.scrollTop += Math.max(-1, Math.min(1, depth / edge)) * 14
      if (scroller.scrollTop === before) return
      layout()
      autoScroll()
    })
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.clientY = event.clientY
    layout()
    autoScroll()
  }

  function end(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const { id, from, to } = drag
    cancel()
    if (to !== from) options.commit(id, to)
  }

  function cancel() {
    if (drag?.frame) window.cancelAnimationFrame(drag.frame)
    drag = null
    active.value = null
    shift.value = {}
  }
  onScopeDispose(cancel)

  return { active, shift, start, move, end, cancel }
}
