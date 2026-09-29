import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'

/** Owns both editing surfaces. Output recovery is deliberately not an input.
 * The expanded/composition state may be shared with page surfaces. */
export function useComposer(options: {
  read: () => string; write: (text: string) => void; identity: () => string; flush: () => void; canFocus: () => boolean
  expanded?: Ref<boolean>; composing?: Ref<boolean>
}) {
  const draft = computed({ get: options.read, set: options.write })
  const compact = ref<HTMLTextAreaElement | null>(null)
  const expandedTextarea = ref<HTMLTextAreaElement | null>(null)
  const expanded = options.expanded ?? ref(false)
  const composing = options.composing ?? ref(false)
  const selection = ref({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none' })
  let frame = 0
  let transfer = 0
  const active = () => expanded.value ? expandedTextarea.value : compact.value
  function remember(event: Event) {
    const textarea = event.currentTarget as HTMLTextAreaElement
    selection.value = { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection }
  }
  function composition(event: CompositionEvent) {
    composing.value = event.type === 'compositionstart'
    remember(event)
    if (!composing.value) resize()
  }
  function resize() {
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      const textarea = active()
      if (!textarea) return
      textarea.style.height = 'auto'
      const limit = expanded.value ? Math.max(220, Math.floor(window.innerHeight * 0.45)) : 180
      textarea.style.height = `${Math.min(textarea.scrollHeight, limit)}px`
    })
  }
  watch(draft, () => { void nextTick(resize) })
  watch(expanded, async (open) => {
    const revision = ++transfer
    const from = open ? compact.value : expandedTextarea.value
    if (from) selection.value = { start: from.selectionStart, end: from.selectionEnd, direction: from.selectionDirection }
    await nextTick()
    if (revision !== transfer) return
    const textarea = active()
    // Only an explicit compact/expanded transition transfers focus, never Follow.
    if (options.canFocus()) textarea?.focus({ preventScroll: true })
    textarea?.setSelectionRange(selection.value.start, selection.value.end, selection.value.direction)
    resize()
  }, { flush: 'pre' })
  watch(options.identity, () => { transfer++; composing.value = false; selection.value = { start: 0, end: 0, direction: 'none' }; options.flush(); void nextTick(resize) })
  onScopeDispose(() => { transfer++; if (frame) window.cancelAnimationFrame(frame); options.flush() })
  return { draft, compact, expandedTextarea, expanded, composing, selection, remember, composition, resize, collapse: () => { expanded.value = false } }
}
