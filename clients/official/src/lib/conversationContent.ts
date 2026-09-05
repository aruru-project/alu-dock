import { computed, reactive, ref, type Ref } from 'vue'
import { loadConversationHistory, loadConversationHistoryEntry } from './bridge'
import {
  applyLiveToolUpdateToProjection,
  foldLiveDelta,
  foldLiveToolUpdate,
  liveDeltaKey,
  liveProjectionTargetKey,
  mergeHydratedConversationRecords,
  projectConversation,
} from './conversation'
import type { ConnectionContext, ConversationBootstrap, ConversationHistoryPage, ConversationItem, ConversationProcessItem, ProjectedEvent } from './types'

type ConversationToolPart = Extract<ConversationProcessItem, { kind: 'tool' }>
type LayoutSnapshot = unknown

interface ConversationContentOptions {
  compact: Ref<boolean>
  native: boolean
  getEpoch: () => number
  getContext: () => ConnectionContext
  isCurrent: (context: ConnectionContext, state: ConversationBootstrap, epoch: number) => boolean
  reload: (workId: string) => void
  beforeLayoutChange: (preserveText?: boolean) => LayoutSnapshot
  afterLayoutChange: (snapshot: LayoutSnapshot, stickToBottom: boolean) => Promise<void>
  isFollowing: () => boolean
  layoutChanged: () => void
  projected: (items: ConversationItem[]) => void
}

interface HydrationDomain { cancelled: boolean; active: number; queue: HydrationJob[] }
interface HydrationBatch { remaining: number; records: ConversationHistoryPage['records'] }
interface HydrationJob {
  domain: HydrationDomain
  batch: HydrationBatch
  context: ConnectionContext
  state: ConversationBootstrap
  conversationEpoch: number
  workId: string
  pageCursor?: string
  entryId: string
  revision: string
}

const HYDRATION_CONCURRENCY = 2
const EMPTY_STREAMING: Set<string> = new Set()

/** Owns the projected conversation plus historical completion and live-fold
 * lifecycle. It only reports layout changes; it never reads or writes the DOM. */
export function useConversationContent(options: ConversationContentOptions) {
  const state = ref<ConversationBootstrap | null>(null)
  const items = ref<ConversationItem[]>([])
  const historyTruncated = ref(false)
  const historyRevision = ref<string | null>(null)
  const historyCursor = ref<string | null>(null)
  const historyLoading = ref(false)
  const hydrationPending = ref<Set<string>>(new Set())
  const hydrationActiveEntries = ref<Set<string>>(new Set())
  const hydrationErrors = ref<Record<string, string>>({})
  const historyPageError = ref<string | null>(null)
  const historyHydrating = computed(() => hydrationPending.value.size > 0)
  const historyError = computed(() => historyPageError.value
    ?? (Object.keys(hydrationErrors.value).length ? '部分对话内容暂时没有载入，请重试。' : null))

  let projectionFrame = 0
  let fullProjectionState: ConversationBootstrap | null = null
  const pendingToolEvents = new Map<string, { state: ConversationBootstrap; event: ProjectedEvent }>()
  const streamCaches = new WeakMap<ConversationBootstrap, { fold: Map<string, ProjectedEvent>; streaming: Set<string> }>()
  let textTargets = new Map<string, ConversationItem>()
  let toolTargets = new Map<string, ConversationToolPart>()
  let hydrationDomain: HydrationDomain = { cancelled: false, active: 0, queue: [] }
  let failedHydrations = new Map<string, HydrationJob>()

  const streamingPartIds = computed<Set<string>>(() => state.value ? streamCache(state.value).streaming : EMPTY_STREAMING)

  function streamCache(current: ConversationBootstrap) {
    let cache = streamCaches.get(current)
    if (!cache) {
      cache = { fold: new Map(), streaming: reactive(new Set<string>()) }
      streamCaches.set(current, cache)
    }
    return cache
  }

  function rebuildProjection(current: ConversationBootstrap) {
    const projected = projectConversation(current, { compact: options.compact.value })
    items.value = projected
    textTargets = new Map()
    toolTargets = new Map()
    for (const item of items.value) {
      const key = liveProjectionTargetKey(item)
      if (key) textTargets.set(key, item)
      if (item.kind === 'tool' && item.toolCallId) toolTargets.set(item.toolCallId, item)
      if (item.kind === 'record') {
        for (const part of item.parts) {
          if (part.kind === 'tool' && part.toolCallId) toolTargets.set(part.toolCallId, part)
        }
      }
    }
    options.projected(projected)
    options.layoutChanged()
  }

  function reproject(current: ConversationBootstrap) {
    const snapshot = options.beforeLayoutChange()
    const stick = options.isFollowing()
    rebuildProjection(current)
    void options.afterLayoutChange(snapshot, stick)
  }

  function resetProjectionSchedule() {
    if (projectionFrame) window.cancelAnimationFrame(projectionFrame)
    projectionFrame = 0
    fullProjectionState = null
    pendingToolEvents.clear()
    textTargets.clear()
    toolTargets.clear()
  }

  function requestProjectionFrame() {
    if (projectionFrame) return
    projectionFrame = window.requestAnimationFrame(() => {
      projectionFrame = 0
      const current = state.value
      const requiresFullProjection = fullProjectionState === current
      const toolUpdates = [...pendingToolEvents.values()]
        .filter((pending) => pending.state === current)
        .map((pending) => pending.event)
      fullProjectionState = null
      pendingToolEvents.clear()
      if (!current || (!requiresFullProjection && !toolUpdates.length)) return
      const snapshot = options.beforeLayoutChange()
      const stick = options.isFollowing()
      if (requiresFullProjection || toolUpdates.some((event) => {
        const toolCallId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : ''
        const target = toolCallId ? toolTargets.get(toolCallId) : undefined
        return !target || !applyLiveToolUpdateToProjection(target, event)
      })) rebuildProjection(current)
      else options.layoutChanged()
      void options.afterLayoutChange(snapshot, stick)
    })
  }

  function scheduleProjection(current: ConversationBootstrap) {
    fullProjectionState = current
    requestProjectionFrame()
  }

  function scheduleToolProjection(current: ConversationBootstrap, event: ProjectedEvent) {
    const toolCallId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : ''
    if (!toolCallId) return scheduleProjection(current)
    pendingToolEvents.set(`${event.eventType}:${toolCallId}`, { state: current, event })
    requestProjectionFrame()
  }

  function applyMessageDelta(current: ConversationBootstrap, event: ProjectedEvent) {
    foldLiveDelta(current.activeEvents, streamCache(current).fold, event)
    const key = liveDeltaKey(event.data)
    const target = key ? textTargets.get(key) : undefined
    const delta = typeof event.data.delta === 'string' ? event.data.delta : ''
    if (!target || (target.kind !== 'assistant' && target.kind !== 'thinking')) {
      scheduleProjection(current)
      return
    }
    if (delta) {
      const snapshot = options.beforeLayoutChange()
      const stick = options.isFollowing()
      target.text += delta
      streamCache(current).streaming.add(target.id)
      options.layoutChanged()
      void options.afterLayoutChange(snapshot, stick)
    }
  }

  function applyConversationEvent(current: ConversationBootstrap, event: ProjectedEvent, conversationChanged: boolean) {
    if (event.eventType === 'message.delta') {
      applyMessageDelta(current, event)
      return
    }
    if (event.eventType === 'message.completed') {
      const messageId = typeof event.data.messageId === 'string' ? event.data.messageId : ''
      if (messageId) {
        const cache = streamCache(current)
        const textId = `live-${messageId}`
        const thinkingId = `live-${messageId}-thinking`
        const presentationChanged = cache.streaming.has(textId) || cache.streaming.has(thinkingId)
        const snapshot = presentationChanged ? options.beforeLayoutChange(true) : null
        const stick = presentationChanged && options.isFollowing()
        cache.streaming.delete(textId)
        cache.streaming.delete(thinkingId)
        if (presentationChanged) void options.afterLayoutChange(snapshot, stick)
      }
    } else if (event.eventType === 'run.settled') {
      streamCache(current).streaming.clear()
    }
    const foldedToolUpdate = foldLiveToolUpdate(current.activeEvents, event)
    if (!foldedToolUpdate) current.activeEvents.push(event)
    if (conversationChanged || event.eventType === 'run.started') {
      if (foldedToolUpdate) scheduleToolProjection(current, event)
      else scheduleProjection(current)
    }
  }

  function showActivity(workId: string) {
    if (items.value.some((item) => item.kind === 'activity')) return
    items.value = [...items.value, { id: `local-activity-${workId}`, kind: 'activity' }]
    options.layoutChanged()
  }

  async function appendHistoricalRecords(records: ConversationBootstrap['records'], revision?: number) {
    const current = state.value
    if (!current || !records.length) return
    const snapshot = options.beforeLayoutChange()
    const stick = options.isFollowing()
    current.records = [...current.records, ...records]
    if (revision && revision > current.historyRevision) current.historyRevision = revision
    rebuildProjection(current)
    await options.afterLayoutChange(snapshot, stick)
  }

  function publish(bootstrap: ConversationBootstrap) {
    resetProjectionSchedule()
    historyRevision.value = null
    historyCursor.value = null
    state.value = bootstrap
    rebuildProjection(bootstrap)
    historyTruncated.value = bootstrap.historyTruncated
    historyPageError.value = null
  }

  function clear() {
    resetProjectionSchedule()
    resetHistoryHydration()
    state.value = null
    items.value = []
    options.projected([])
    options.layoutChanged()
  }

  function resetHistoryHydration() {
    hydrationDomain.cancelled = true
    hydrationDomain.queue = []
    hydrationDomain = { cancelled: false, active: 0, queue: [] }
    failedHydrations = new Map()
    hydrationPending.value = new Set()
    hydrationActiveEntries.value = new Set()
    hydrationErrors.value = {}
    historyLoading.value = false
    historyPageError.value = null
  }

  function jobIsCurrent(job: HydrationJob) {
    return hydrationDomain === job.domain && !job.domain.cancelled
      && job.conversationEpoch === options.getEpoch()
      && state.value === job.state
      && options.isCurrent(job.context, job.state, job.conversationEpoch)
  }

  function setPending(entryId: string, pending: boolean) {
    const next = new Set(hydrationPending.value)
    if (pending) next.add(entryId)
    else next.delete(entryId)
    hydrationPending.value = next
  }

  function setActive(entryId: string, active: boolean) {
    const next = new Set(hydrationActiveEntries.value)
    if (active) next.add(entryId)
    else next.delete(entryId)
    hydrationActiveEntries.value = next
  }

  function setHydrationError(entryId: string, message?: string) {
    const next = { ...hydrationErrors.value }
    if (message) next[entryId] = message
    else delete next[entryId]
    hydrationErrors.value = next
  }

  function queueHydration(job: HydrationJob) {
    if (job.domain.cancelled || hydrationPending.value.has(job.entryId)) return
    failedHydrations.delete(job.entryId)
    setHydrationError(job.entryId)
    setPending(job.entryId, true)
    job.domain.queue.push(job)
    pumpHydration(job.domain)
  }

  function pumpHydration(domain: HydrationDomain) {
    while (!domain.cancelled && domain.active < HYDRATION_CONCURRENCY) {
      const job = domain.queue.shift()
      if (!job) return
      domain.active += 1
      void runHydration(job).finally(() => {
        domain.active -= 1
        pumpHydration(domain)
      })
    }
  }

  async function runHydration(job: HydrationJob) {
    if (!jobIsCurrent(job)) return
    setActive(job.entryId, true)
    try {
      const completed = await loadConversationHistoryEntry(job.workId, job.pageCursor, job.entryId, job.revision,
        job.state.cursor.hostEpoch, job.state.cursor.runtimeGeneration, job.context)
      if (!jobIsCurrent(job)) return
      if (completed.hostEpoch !== job.state.cursor.hostEpoch || completed.instance.id !== job.workId
        || completed.instance.runtimeGeneration !== job.state.cursor.runtimeGeneration
        || completed.revision !== job.revision || completed.record.entryId !== job.entryId) {
        options.reload(job.workId)
        return
      }
      job.batch.records.push(completed.record)
      failedHydrations.delete(job.entryId)
      setHydrationError(job.entryId)
    } catch (cause) {
      if (!jobIsCurrent(job)) return
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      if (code === 'protocol_error') options.reload(job.workId)
      else {
        failedHydrations.set(job.entryId, job)
        setHydrationError(job.entryId, '这部分内容暂时没有读取成功，请重试。')
      }
    } finally {
      job.batch.remaining -= 1
      if (jobIsCurrent(job)) {
        setActive(job.entryId, false)
        setPending(job.entryId, false)
        if (job.batch.remaining === 0 && job.batch.records.length) {
          const snapshot = options.beforeLayoutChange()
          const stick = options.isFollowing()
          job.state.records = mergeHydratedConversationRecords(job.state.records, job.batch.records)
          rebuildProjection(job.state)
          await options.afterLayoutChange(snapshot, stick)
        }
      }
    }
  }

  function scheduleHydration(context: ConnectionContext, current: ConversationBootstrap, epoch: number,
    pageCursor: string | undefined, page: ConversationHistoryPage) {
    const entryIds = page.incompleteEntryIds.filter((entryId) => current.records.some((record) => record.entryId === entryId)
      && !hydrationPending.value.has(entryId))
    const batch: HydrationBatch = { remaining: entryIds.length, records: [] }
    for (const entryId of entryIds) queueHydration({
      domain: hydrationDomain, batch, context, state: current, conversationEpoch: epoch,
      workId: current.instance.id, pageCursor, entryId, revision: page.revision,
    })
  }

  async function loadRecentHistory(context: ConnectionContext, current: ConversationBootstrap, epoch: number) {
    if (!options.native) return
    historyLoading.value = true
    historyPageError.value = null
    try {
      const page = await loadConversationHistory(current.instance.id, undefined, current.cursor.hostEpoch,
        current.cursor.runtimeGeneration, context)
      if (!options.isCurrent(context, current, epoch)) return
      if (page.hostEpoch !== current.cursor.hostEpoch || page.instance.id !== current.instance.id
        || page.instance.runtimeGeneration !== current.cursor.runtimeGeneration) return options.reload(current.instance.id)
      const snapshot = options.beforeLayoutChange()
      const stick = options.isFollowing()
      const existing = new Map(current.records.map((record) => [record.entryId, record]))
      const pageIds = new Set(page.records.map((record) => record.entryId))
      current.records = [...page.records.map((record) => existing.get(record.entryId) ?? record),
        ...current.records.filter((record) => !pageIds.has(record.entryId))]
      historyRevision.value = page.revision
      historyCursor.value = page.nextCursor ?? null
      historyTruncated.value = page.hasEarlier
      rebuildProjection(current)
      scheduleHydration(context, current, epoch, undefined, page)
      await options.afterLayoutChange(snapshot, stick)
    } catch {
      if (state.value === current && options.getEpoch() === epoch) historyPageError.value = '对话记录暂时没有读取成功，请重试。'
    } finally {
      if (state.value === current && options.getEpoch() === epoch) historyLoading.value = false
    }
  }

  async function loadEarlierHistory() {
    const current = state.value
    const cursor = historyCursor.value
    if (!current || !cursor || historyLoading.value) return
    const epoch = options.getEpoch()
    historyLoading.value = true
    historyPageError.value = null
    try {
      const context = options.getContext()
      const page = await loadConversationHistory(current.instance.id, cursor, current.cursor.hostEpoch,
        current.cursor.runtimeGeneration, context)
      if (!options.isCurrent(context, current, epoch)) return
      if (page.hostEpoch !== current.cursor.hostEpoch || page.instance.id !== current.instance.id
        || page.instance.runtimeGeneration !== current.cursor.runtimeGeneration || page.revision !== historyRevision.value) {
        options.reload(current.instance.id)
        return
      }
      const existing = new Set(current.records.map((record) => record.entryId))
      const snapshot = options.beforeLayoutChange()
      current.records = [...page.records.filter((record) => !existing.has(record.entryId)), ...current.records]
      historyCursor.value = page.nextCursor ?? null
      historyTruncated.value = page.hasEarlier
      rebuildProjection(current)
      scheduleHydration(context, current, epoch, cursor, page)
      await options.afterLayoutChange(snapshot, false)
    } catch (cause) {
      if (state.value === current && options.getEpoch() === epoch) {
        const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
        if (code === 'protocol_error') options.reload(current.instance.id)
        else historyPageError.value = '更早的记录暂时没有读取成功，请重试。'
      }
    } finally {
      if (state.value === current && options.getEpoch() === epoch) historyLoading.value = false
    }
  }

  function retryHistoryEntry(entryId: string) {
    const job = failedHydrations.get(entryId)
    if (job && jobIsCurrent(job)) queueHydration({ ...job, batch: { remaining: 1, records: [] } })
  }

  function retryHydration() {
    const current = state.value
    if (!current) return
    for (const entryId of [...failedHydrations.keys()]) retryHistoryEntry(entryId)
    if (!historyPageError.value) return
    try {
      const context = options.getContext()
      if (historyCursor.value) void loadEarlierHistory()
      else void loadRecentHistory(context, current, options.getEpoch())
    } catch {
      historyPageError.value = '对话记录暂时没有读取成功，请重试。'
    }
  }

  function dispose() {
    resetProjectionSchedule()
    resetHistoryHydration()
  }

  return {
    state, items, streamingPartIds,
    historyTruncated, historyRevision, historyCursor, historyLoading,
    hydrationActiveEntries, hydrationErrors, historyHydrating, historyError,
    reproject, resetProjectionSchedule, scheduleProjection, applyConversationEvent, showActivity, appendHistoricalRecords,
    publish, clear, resetHistoryHydration, loadRecentHistory, loadEarlierHistory,
    retryHistoryEntry, retryHydration, dispose,
  }
}
