<script setup lang="ts">
import { computed, onUnmounted, reactive, watch, type Directive } from 'vue'
import { RefreshCw } from '@lucide/vue'
import ConversationRow from './ConversationRow.vue'
import ConversationTurnSummary from './ConversationTurnSummary.vue'
import { conversationRows, conversationSections, reconcileTurnOverrides, rowVisibleWhenCollapsed, turnHidingAnchor, type ConversationRow as RowItem, type ConversationSection, type ConversationTurnSection } from '../lib/conversationPresentation'
import type { ConversationImageResource, ConversationItem, ConversationProcessItem, ShellRunItem } from '../lib/types'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>

const props = defineProps<{
  items: readonly ConversationItem[]
  switching: boolean
  streamingParts: ReadonlySet<string>
  historyLoading: boolean
  historyHydrating: boolean
  historyTruncated: boolean
  historyError: string | null
  /** The reader has scrolled away from the latest output. */
  awayFromBottom: boolean
  attachmentPreviews: Record<string, { url: string; mediaType: string }>
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
  holdReadingPosition: (change: () => void) => void
  /** The saved reading entry the viewport is still waiting to find after a rebuild. */
  restoringAnchorId: () => string | undefined
  /** Whether a record read on open is still being read, or could not be read. */
  recordState: (entryId: string) => { loading: boolean; error?: string }
}>()

const emit = defineEmits<{
  readInterest: [entryIds: string[]]
  retryRecord: [entryId: string]
  loadEarlier: []
  retryHistory: []
  toolToggle: [id: string, event: Event]
  imageRequest: [part: ImagePart]
  imagePreview: [part: ImagePart]
  imageFailed: [part: ImagePart]
  attachmentPreview: [fileId: string, name: string]
  openText: [title: string, text: string, markdown?: boolean]
  shellQuote: [item: ShellRunItem]
}>()

const sources = new Map<Element, string[]>()
const visible = new Set<Element>()
let interestQueued = false
let lastInterest = ''
function publishInterest() {
  if (interestQueued) return
  interestQueued = true
  queueMicrotask(() => {
    interestQueued = false
    const ids = [...new Set([...visible].flatMap(element => sources.get(element) ?? []))]
    const key = JSON.stringify(ids)
    if (key !== lastInterest) { lastInterest = key; emit('readInterest', ids) }
  })
}
const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) visible.add(entry.target)
    else visible.delete(entry.target)
  }
  publishInterest()
}, { rootMargin: '200px' })
const vReadInterest: Directive<HTMLElement, string[] | undefined> = {
  mounted(element, binding) { sources.set(element, binding.value ?? []); observer?.observe(element) },
  updated(element, binding) { sources.set(element, binding.value ?? []); if (visible.has(element)) publishInterest() },
  unmounted(element) { observer?.unobserve(element); sources.delete(element); visible.delete(element); publishInterest() },
}
onUnmounted(() => observer?.disconnect())

// A record whose text is read on open (a whole system prompt, a model-context
// replacement) is wanted only once the reader opens its panel; folded, it is
// never read, however close to the viewport it sits.
const openedRecords = reactive(new Set<string>())
function recordToggled(id: string, open: boolean) {
  if (open) openedRecords.add(id)
  else openedRecords.delete(id)
}
function interestOf(row: RowItem): string[] | undefined {
  return row.kind === 'record' && row.readOnOpen && !openedRecords.has(row.id) ? [] : row.sourceEntryIds
}

const rows = computed((previous?: ReturnType<typeof conversationRows>) => {
  const prior = new Map(previous?.map((row) => [row.id, row]))
  return conversationRows(props.items).map((row) => {
    const old = prior.get(row.id)
    if (row.kind === 'assistant-group' && old?.kind === 'assistant-group' && row.time === old.time && row.turnId === old.turnId
      && row.parts.length === old.parts.length && row.parts.every((part, index) => part === old.parts[index])) return old
    return row
  })
})
const sections = computed(() => conversationSections(rows.value))

// A running turn shows its process; a settled one folds it away unless the
// reader chose otherwise. The choice lives with this view of the conversation.
const turnOverrides = reactive(new Map<string, boolean>())
const runningTurns = new Set<string>()
function turnOpen(section: ConversationTurnSection) {
  return turnOverrides.get(section.id) ?? section.status === 'running'
}
function toggleTurn(section: ConversationTurnSection) {
  props.holdReadingPosition(() => { turnOverrides.set(section.id, !turnOpen(section)) })
}
const turnIds = (list: readonly ConversationSection[]) => list.flatMap((section) => section.kind === 'turn' ? [section.id] : [])
watch(sections, (current, previous) => {
  const running = new Set<string>()
  for (const section of current) if (section.kind === 'turn' && section.status === 'running') running.add(section.id)
  const settled = [...runningTurns].filter((id) => !running.has(id))
  reconcileTurnOverrides(turnOverrides, turnIds(previous ?? []), turnIds(current), settled, props.awayFromBottom)
  runningTurns.clear()
  for (const id of running) runningTurns.add(id)
  // A saved reading position inside a turn's process (F5) needs that turn open
  // before the viewport looks for its entry; otherwise it falls back to the end.
  const hiding = turnHidingAnchor(current, props.restoringAnchorId())
  if (hiding && !turnOpen(hiding)) turnOverrides.set(hiding.id, true)
}, { immediate: true })
function bodyRows(section: ConversationTurnSection) {
  return turnOpen(section) ? section.body : section.body.filter((row) => rowVisibleWhenCollapsed(row, section.finalRowId))
}
</script>

<template>
  <div class="conversation-flow" data-conversation-flow :class="{ 'is-switching': switching }" role="log" aria-live="polite" aria-relevant="additions text">
    <div v-if="historyLoading || historyHydrating || historyTruncated || historyError" class="history-loader">
      <button v-if="historyTruncated" :disabled="historyLoading" @click="emit('loadEarlier')"><RefreshCw :size="14" :class="{ spinning: historyLoading }" />{{ historyLoading ? '加载中…' : '加载更早记录' }}</button>
      <button v-if="historyError" :disabled="historyLoading" @click="emit('retryHistory')"><RefreshCw :size="14" />重试读取</button>
      <span v-if="historyHydrating">正在载入图片与较长内容…</span>
      <span v-if="historyError">{{ historyError }}</span>
    </div>
    <template v-for="section in sections" :key="section.id">
      <template v-if="section.kind === 'turn'">
        <ConversationRow v-for="row in section.openers" :key="row.id" v-read-interest="interestOf(row)" :row="row" :streaming-parts="streamingParts" :attachment-previews="attachmentPreviews" :tool-open="toolOpen" :image-resource="imageResource" :record-state="recordState"
          @record-toggle="recordToggled" @retry-record="emit('retryRecord', $event)"
          @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)"
          @attachment-preview="(id, name) => emit('attachmentPreview', id, name)" @open-text="(title, text, markdown) => emit('openText', title, text, markdown)" @shell-quote="emit('shellQuote', $event)" />
        <ConversationTurnSummary :section="section" :open="turnOpen(section)" @toggle="toggleTurn(section)" />
        <ConversationRow v-for="row in bodyRows(section)" :key="row.id" v-read-interest="interestOf(row)" :row="row" :streaming-parts="streamingParts" :attachment-previews="attachmentPreviews" :tool-open="toolOpen" :image-resource="imageResource" :record-state="recordState"
          :collapsed="!turnOpen(section)" :final-row="row.id === section.finalRowId"
          @record-toggle="recordToggled" @retry-record="emit('retryRecord', $event)"
          @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)"
          @attachment-preview="(id, name) => emit('attachmentPreview', id, name)" @open-text="(title, text, markdown) => emit('openText', title, text, markdown)" @shell-quote="emit('shellQuote', $event)" />
      </template>
      <ConversationRow v-else v-read-interest="interestOf(section.row)" :row="section.row" :streaming-parts="streamingParts" :attachment-previews="attachmentPreviews" :tool-open="toolOpen" :image-resource="imageResource" :record-state="recordState"
        @record-toggle="recordToggled" @retry-record="emit('retryRecord', $event)"
        @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)"
        @attachment-preview="(id, name) => emit('attachmentPreview', id, name)" @open-text="(title, text, markdown) => emit('openText', title, text, markdown)" @shell-quote="emit('shellQuote', $event)" />
    </template>
  </div>
</template>

<style scoped>
.conversation-flow.is-switching { opacity: .42; pointer-events: none; user-select: none; }
.history-loader { display: grid; justify-items: center; gap: 6px; margin: 0 auto 12px; color: var(--alu-rose); font: 10px/1.4 var(--font-reading); }
.history-loader button { display: inline-flex; min-height: 42px; align-items: center; gap: 6px; padding: 5px 12px; color: var(--alu-text-muted); cursor: pointer; background: rgb(17 24 40 / .8); border: 1px solid var(--alu-border); border-radius: 999px; }
.history-loader button:hover { color: var(--alu-text); border-color: var(--alu-border-focus); }
.history-loader .spinning { animation: spin .9s linear infinite; }
.conversation-flow { width: 100%; }
@media (max-width: 1000px) {
  .conversation-flow {
    width: min(100%, 760px);
    margin-inline: auto;
  }
}
</style>
