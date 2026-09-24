import { computed, reactive, ref, type Ref } from 'vue'
import { conversationEventChanged } from './liveReducer'
import {
  createLiveConversationProjector,
  foldLiveDelta,
  foldableToolEvent,
  mergeLiveEvents,
  liveDeltaKey,
  projectRecordGroups,
} from './conversation'
import type { ConversationBootstrap, ConversationRecord, ConversationItem, ProjectedEvent } from './types'

type LayoutSnapshot = unknown

interface ConversationContentOptions {
  compact: Ref<boolean>
  beforeLayoutChange: (preserveText?: boolean, changedIds?: Set<string>) => LayoutSnapshot
  afterLayoutChange: (snapshot: LayoutSnapshot, stickToBottom: boolean) => Promise<void>
  isFollowing: () => boolean
  layoutChanged: () => void
  projected: (items: ConversationItem[]) => void
}

export type ConversationContentChange =
  | { kind: 'record_chunk'; entryId: string; text: string; first: boolean; complete: boolean; beforeEntryId?: string }
  | { kind: 'checkpoint_begin'; bootstrap: ConversationBootstrap; replay?: boolean }
  | { kind: 'checkpoint_end' }
  | { kind: 'entry_state'; entryId: string; loading: boolean; error?: string }
  | { kind: 'state'; canLoadEarlier: boolean; loading: boolean; error?: string }

const EMPTY_STREAMING: Set<string> = new Set()

/** Owns the projected conversation plus historical completion and live-fold
 * lifecycle. It only reports layout changes; it never reads or writes the DOM. */
export function useConversationContent(options: ConversationContentOptions) {
  const state = ref<ConversationBootstrap | null>(null)
  const items = ref<ConversationItem[]>([])
  const historyTruncated = ref(false)
  const hydrationActiveEntries = ref<Set<string>>(new Set())
  const hydrationErrors = ref<Record<string, string>>({})
  const historyHydrating = computed(() => hydrationActiveEntries.value.size > 0)
  const seeding = ref(false)
  const historyLoading = ref(false)
  const readError = ref<string | null>(null)
  const historyError = computed({
    get: () => readError.value ?? (Object.keys(hydrationErrors.value).length ? '部分对话内容暂时没有载入，请重试。' : null),
    set: (value: string | null) => { readError.value = value },
  })
  let recordText = ''
  let foldCut = 0
  let freshRead = false
  let replaying = false
  let checkpointOrder: Map<string, number> | null = null
  let recordOrder = new Map<string, number>()
  let checkpoint: Pick<ConversationBootstrap, 'historyRevision'> | null = null
  let preserveHandoff = false
  const preparingView = ref(false)
  let historyDirty = false
  let prepending = false

  let projectionFrame = 0
  let live: ReturnType<typeof createLiveConversationProjector> | null = null
  let liveState: ConversationBootstrap | null = null
  let historyItems: ConversationItem[] = []
  let publishedStructure = ''
  const pendingEvents: ProjectedEvent[] = []
  const streamCaches = new WeakMap<ConversationBootstrap, { fold: Map<string, ProjectedEvent>; streaming: Set<string>; tools: Map<string, number> }>()
  const streamingPartIds = computed<Set<string>>(() => state.value ? streamCache(state.value).streaming : EMPTY_STREAMING)

  function streamCache(current: ConversationBootstrap) {
    let cache = streamCaches.get(current)
    if (!cache) {
      cache = { fold: new Map(), streaming: reactive(new Set<string>()), tools: new Map() }
      streamCaches.set(current, cache)
    }
    return cache
  }

  function initializeLive(current: ConversationBootstrap) {
    live = createLiveConversationProjector(current, { compact: options.compact.value }, reactive as <T extends object>(value: T) => T)
    liveState = current
    const cache = streamCache(current)
    cache.fold.clear(); cache.tools.clear(); cache.streaming.clear()
    current.activeEvents.forEach((event, index) => {
      live!.apply(event)
      updateStreaming(current, event)
      const key = liveDeltaKey(event.data)
      if (event.sequence > foldCut && event.eventType === 'message.delta' && key) cache.fold.set(key, event)
      if (event.sequence > foldCut && foldableToolEvent(event)) cache.tools.set(`${event.eventType}:${event.data.toolCallId}`, index)
      resetFoldBoundary(current, event)
    })
    pendingEvents.length = 0
  }

  function publishLive() {
    const structure = live?.structureKey() ?? ''
    if (publishedStructure === structure) return
    publishedStructure = structure
    const next = [...historyItems, ...(live?.snapshot() ?? [])]
    // Text, tool completion and args/output mutate indexed parts in place. Only
    // structural changes replace the list; stable historical objects survive.
    if (next.length !== items.value.length || next.some((item, index) => item !== items.value[index])) items.value = next
  }

  function projectHistory(current: ConversationBootstrap) {
    return reactive(projectRecordGroups(current.records))
  }

  function rememberRecord(entryId: string, beforeEntryId?: string) {
    if (checkpointOrder) { if (!checkpointOrder.has(entryId)) checkpointOrder.set(entryId, checkpointOrder.size); return }
    if (recordOrder.has(entryId)) return
    const ids = [...recordOrder.keys()]
    const before = beforeEntryId ? ids.indexOf(beforeEntryId) : -1
    ids.splice(before >= 0 ? before : ids.length, 0, entryId)
    recordOrder = new Map(ids.map((id, index) => [id, index]))
  }
  function acceptReadCut(sequence: number, latest?: ConversationBootstrap) {
    freshRead = false
    foldCut = Math.max(foldCut, sequence)
    const current = state.value
    if (current) {
      const cache = streamCache(current); cache.fold.clear(); cache.tools.clear()
      if (latest) {
        current.instance = latest.instance
        if (live && liveState === current) {
          drainEvents(current)
          live.reconcileActivity(latest.instance)
          // Also remove a local send placeholder, which is outside live's key.
          if (latest.instance.execution !== 'running') publishedStructure = ''
          publishLive()
          options.layoutChanged()
        }
      }
    }
  }

  function rebuildProjection(current: ConversationBootstrap) {
    if (liveState !== current) initializeLive(current)
    else drainEvents(current)
    historyItems = projectHistory(current)
    historyDirty = false
    publishedStructure = ''
    publishLive()
    options.projected(items.value)
    options.layoutChanged()
  }

  function reproject(current: ConversationBootstrap) {
    if (checkpoint && preserveHandoff) return
    const snapshot = options.beforeLayoutChange()
    const stick = !prepending && options.isFollowing()
    prepending = false
    initializeLive(current)
    rebuildProjection(current)
    void options.afterLayoutChange(snapshot, stick)
  }

  function resetProjectionSchedule() {
    if (projectionFrame) window.cancelAnimationFrame(projectionFrame)
    projectionFrame = 0
    historyDirty = false
    prepending = false
    pendingEvents.length = 0
    live = null; liveState = null; historyItems = []; publishedStructure = ''
  }

  function updateStreaming(current: ConversationBootstrap, event: ProjectedEvent) {
    const streaming = streamCache(current).streaming
    if (event.eventType === 'message.delta') {
      const id = typeof event.data.messageId === 'string' ? event.data.messageId : `message-${event.sequence}`
      streaming.add(`live-${id}${event.data.block === 'thinking' ? '-thinking' : ''}`)
    } else if (event.eventType === 'message.completed') {
      streaming.delete(`live-${event.data.messageId}`)
      streaming.delete(`live-${event.data.messageId}-thinking`)
    } else if (event.eventType === 'run.settled') streaming.clear()
  }

  function drainEvents(current: ConversationBootstrap) {
    for (const event of pendingEvents) {
      live!.apply(event)
      updateStreaming(current, event)
    }
    pendingEvents.length = 0
  }

  function requestProjectionFrame() {
    if (projectionFrame) return
    projectionFrame = window.requestAnimationFrame(() => {
      projectionFrame = 0
      const current = state.value
      if (!current || (!pendingEvents.length && !historyDirty)) return
      const preserveText = pendingEvents.some((event) => event.eventType === 'message.completed' || event.eventType === 'run.settled')
      const changedIds = new Set<string>()
      for (const event of pendingEvents) {
        for (const id of live!.affectedIds(event)) changedIds.add(id)
        if (event.eventType === 'run.settled') for (const id of streamCache(current).streaming) changedIds.add(id)
      }
      const stick = !prepending && options.isFollowing()
      const snapshot = stick ? null : options.beforeLayoutChange(preserveText, historyDirty ? undefined : changedIds)
      prepending = false
      drainEvents(current)
      const historyChanged = historyDirty
      if (historyDirty) {
        historyDirty = false
        historyItems = projectHistory(current)
        publishedStructure = ''
      }
      publishLive()
      if (historyChanged) options.projected(items.value)
      options.layoutChanged()
      void options.afterLayoutChange(snapshot, stick)
    })
  }

  function resetFoldBoundary(current: ConversationBootstrap, event: ProjectedEvent) {
    const cache = streamCache(current)
    const tool = (id: unknown) => {
      if (typeof id !== 'string') return
      cache.tools.delete(`tool.args_updated:${id}`)
      cache.tools.delete(`tool.output_updated:${id}`)
    }
    if (event.eventType === 'run.settled') { cache.tools.clear(); cache.fold.clear() }
    if (event.eventType === 'tool.completed' || (event.eventType.startsWith('tool.') && !foldableToolEvent(event))) tool(event.data.toolCallId)
    if (event.eventType === 'message.completed') {
      cache.fold.delete(`${event.data.messageId}:text`)
      cache.fold.delete(`${event.data.messageId}:thinking`)
      if (Array.isArray(event.data.content)) for (const block of event.data.content) {
        if (block && typeof block === 'object' && 'toolCallId' in block) tool(block.toolCallId)
      }
    }
  }

  function applyConversationEvent(current: ConversationBootstrap, event: ProjectedEvent, conversationChanged: boolean) {
    if (!conversationChanged && event.eventType !== 'run.started') return
    if (liveState !== current) initializeLive(current)
    freshRead = false
    // A retained handoff builds the new canonical tail in the existing log,
    // while the one live projector keeps the previous rendered surface.
    if (!checkpoint || !preserveHandoff) {
      const previous = pendingEvents.at(-1)
      const merged = previous ? mergeLiveEvents(previous, event) : null
      if (merged) pendingEvents[pendingEvents.length - 1] = merged
      else pendingEvents.push({ ...event, data: { ...event.data } })
    }
    const cache = streamCache(current)
    if (event.eventType === 'message.delta' && liveDeltaKey(event.data)) foldLiveDelta(current.activeEvents, cache.fold, { ...event, data: { ...event.data } })
    else if (foldableToolEvent(event)) {
      const key = `${event.eventType}:${event.data.toolCallId}`
      const index = cache.tools.get(key)
      if (index !== undefined) {
        current.activeEvents[index] = mergeLiveEvents(current.activeEvents[index]!, event)!
      }
      else { cache.tools.set(key, current.activeEvents.length); current.activeEvents.push(event) }
    } else {
      // Images and completion are ordered facts, not replaceable text updates.
      resetFoldBoundary(current, event)
      current.activeEvents.push(event)
    }
    if (!checkpoint || !preserveHandoff) requestProjectionFrame()
  }
  function applyReplayEvent(event: ProjectedEvent) {
    if (!replaying || !state.value) return false
    applyConversationEvent(state.value, event, conversationEventChanged(event))
    return true
  }

  function showActivity(workId: string) {
    if (items.value.some((item) => item.kind === 'activity')) return
    items.value = [...items.value, { id: `local-activity-${workId}`, kind: 'activity' }]
    options.layoutChanged()
  }

  function applyContent(change: ConversationContentChange) {
    const current = state.value
    if (change.kind === 'entry_state') {
      const active = new Set(hydrationActiveEntries.value)
      if (change.loading) active.add(change.entryId)
      else active.delete(change.entryId)
      hydrationActiveEntries.value = active
      const errors = { ...hydrationErrors.value }
      if (change.error) errors[change.entryId] = change.error
      else delete errors[change.entryId]
      hydrationErrors.value = errors
      return
    }
    if (change.kind === 'state') {
      historyLoading.value = change.loading
      historyTruncated.value = change.canLoadEarlier
      if (current) current.historyTruncated = change.canLoadEarlier
      historyError.value = change.error ?? null
      options.layoutChanged()
      return
    }
    if (!current) return
    if (change.kind === 'checkpoint_begin') {
      const wasFresh = freshRead
      if (projectionFrame) window.cancelAnimationFrame(projectionFrame)
      projectionFrame = 0; pendingEvents.length = 0; historyDirty = false
      checkpoint = { historyRevision: change.bootstrap.historyRevision }
      replaying = change.replay === true
      preserveHandoff = preparingView.value || (!wasFresh && items.value.length > 0)
      seeding.value = true
      checkpointOrder = new Map()
      const tail = replaying ? [] : current.activeEvents.filter(event => event.sequence > change.bootstrap.cursor.sequence)
      current.activeEvents = [...change.bootstrap.activeEvents, ...tail]
      foldCut = change.bootstrap.cursor.sequence
      const cache = streamCache(current)
      cache.fold.clear(); cache.tools.clear()
      for (const [index, event] of current.activeEvents.entries()) {
        if (event.sequence <= foldCut) continue
        const key = liveDeltaKey(event.data)
        if (event.eventType === 'message.delta' && key) cache.fold.set(key, event)
        if (foldableToolEvent(event)) cache.tools.set(`${event.eventType}:${event.data.toolCallId}`, index)
        resetFoldBoundary(current, event)
      }
      recordText = ''; freshRead = false
      return
    }
    if (change.kind === 'checkpoint_end') {
      preparingView.value = false
      seeding.value = false
      if (!checkpoint || !checkpointOrder) return
      for (let index = current.records.length - 1; index >= 0; index--) {
        if (!checkpointOrder.has(current.records[index]!.entryId)) current.records.splice(index, 1)
      }
      current.records.sort((a, b) => checkpointOrder!.get(a.entryId)! - checkpointOrder!.get(b.entryId)!)
      recordOrder = checkpointOrder
      current.historyRevision = checkpoint.historyRevision
      checkpoint = null; checkpointOrder = null; replaying = false
      recordText = ''
      const anchor = options.beforeLayoutChange()
      const following = !prepending && options.isFollowing()
      prepending = false
      initializeLive(current)
      rebuildProjection(current)
      void options.afterLayoutChange(anchor, following)
      return
    }
    if (change.first) { recordText = ''; rememberRecord(change.entryId, change.beforeEntryId) }
    recordText += change.text
    if (!change.complete) return
    const record = JSON.parse(recordText) as ConversationRecord
    if (change.beforeEntryId) prepending = true
    recordText = ''
    const index = current.records.findIndex(old => old.entryId === change.entryId)
    if (index >= 0) current.records[index] = record
    else {
      const order = checkpointOrder ?? recordOrder
      const position = order.get(change.entryId)
      const explicit = change.beforeEntryId ? current.records.findIndex(old => old.entryId === change.beforeEntryId) : -1
      const successor = position === undefined ? -1 : current.records.findIndex(old => (order.get(old.entryId) ?? -1) > position)
      const before = explicit >= 0 ? explicit : successor
      current.records.splice(before >= 0 ? before : current.records.length, 0, record)
    }
    if (!checkpoint || !preserveHandoff) {
      historyDirty = true
      requestProjectionFrame()
    }
  }

  function publish(bootstrap: ConversationBootstrap, prepareView = false) {
    preparingView.value = prepareView
    resetProjectionSchedule()
    checkpoint = null
    seeding.value = prepareView
    recordText = ''
    hydrationActiveEntries.value = new Set()
    hydrationErrors.value = {}
    foldCut = bootstrap.cursor.sequence
    freshRead = true; replaying = false; checkpointOrder = null
    recordOrder = new Map(bootstrap.records.map((record, index) => [record.entryId, index]))
    state.value = bootstrap
    if (!prepareView) rebuildProjection(state.value!)
    historyTruncated.value = bootstrap.historyTruncated
    historyError.value = null
  }

  function clear() {
    preparingView.value = false
    resetProjectionSchedule()
    checkpoint = null
    recordText = ''
    state.value = null
    checkpointOrder = null; replaying = false; freshRead = false; recordOrder.clear()
    seeding.value = false
    hydrationActiveEntries.value = new Set()
    hydrationErrors.value = {}
    readError.value = null
    historyLoading.value = false
    historyTruncated.value = false
    items.value = []
    options.projected([])
    options.layoutChanged()
  }

  function bindingFailed() {
    if (preparingView.value && state.value) rebuildProjection(state.value)
    preparingView.value = false
    seeding.value = false
    recordText = ''
  }

  function dispose() {
    resetProjectionSchedule()
    checkpoint = null
    recordText = ''
  }

  return {
    state, items, streamingPartIds, seeding, preparingView, historyTruncated, historyLoading, historyError,
    hydrationActiveEntries, hydrationErrors, historyHydrating,
    reproject, applyConversationEvent, applyReplayEvent, acceptReadCut, showActivity,
    publish, clear, applyContent, bindingFailed, dispose,
  }
}
