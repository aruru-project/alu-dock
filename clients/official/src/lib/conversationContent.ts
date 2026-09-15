import { computed, reactive, ref, type Ref } from 'vue'
import { loadConversationHistory, loadConversationHistoryEntry } from './bridge'
import {
  createLiveConversationProjector,
  foldLiveDelta,
  liveDeltaKey,
  mergeHydratedConversationRecords,
  projectRecordGroups,
} from './conversation'
import type { ConnectionContext, ConversationBootstrap, ConversationHistoryPage, ConversationItem, ProjectedEvent } from './types'

type LayoutSnapshot = unknown

interface ConversationContentOptions {
  compact: Ref<boolean>
  native: boolean
  getEpoch: () => number
  getContext: () => ConnectionContext
  isCurrent: (context: ConnectionContext, state: ConversationBootstrap, epoch: number) => boolean
  reload: (workId: string) => void
  beforeLayoutChange: (preserveText?: boolean, changedIds?: Set<string>) => LayoutSnapshot
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
  let historyEndEntryId: string | undefined
  let live: ReturnType<typeof createLiveConversationProjector> | null = null
  let liveState: ConversationBootstrap | null = null
  let historyItems: ConversationItem[] = []
  let publishedStructure = ''
  const pendingEvents: ProjectedEvent[] = []
  const streamCaches = new WeakMap<ConversationBootstrap, { fold: Map<string, ProjectedEvent>; streaming: Set<string>; tools: Map<string, number> }>()
  let hydrationDomain: HydrationDomain = { cancelled: false, active: 0, queue: [] }
  let failedHydrations = new Map<string, HydrationJob>()

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
      if (event.eventType === 'message.delta' && key) cache.fold.set(key, event)
      if (foldableToolEvent(event)) cache.tools.set(`${event.eventType}:${event.data.toolCallId}`, index)
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

  function rebuildProjection(current: ConversationBootstrap) {
    if (liveState !== current) initializeLive(current)
    else drainEvents(current)
    historyItems = reactive(projectRecordGroups(current.records))
    publishedStructure = ''
    publishLive()
    options.projected(items.value)
    options.layoutChanged()
  }

  function reproject(current: ConversationBootstrap) {
    const snapshot = options.beforeLayoutChange()
    const stick = options.isFollowing()
    initializeLive(current)
    rebuildProjection(current)
    void options.afterLayoutChange(snapshot, stick)
  }

  function resetProjectionSchedule() {
    if (projectionFrame) window.cancelAnimationFrame(projectionFrame)
    projectionFrame = 0
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
      if (!current || !pendingEvents.length) return
      const preserveText = pendingEvents.some((event) => event.eventType === 'message.completed' || event.eventType === 'run.settled')
      const changedIds = new Set<string>()
      for (const event of pendingEvents) for (const id of live!.affectedIds(event)) changedIds.add(id)
      const stick = options.isFollowing()
      const snapshot = stick ? null : options.beforeLayoutChange(preserveText, changedIds)
      drainEvents(current)
      publishLive()
      options.layoutChanged()
      void options.afterLayoutChange(snapshot, stick)
    })
  }

  function foldableToolEvent(event: ProjectedEvent) {
    return (event.eventType === 'tool.args_updated' || event.eventType === 'tool.output_updated')
      && typeof event.data.toolCallId === 'string' && Boolean(event.data.toolCallId)
      && event.data.content === undefined && event.data.publishedFile === undefined
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
    // The replay log is folded separately from this frame's original events.
    pendingEvents.push({ ...event, data: { ...event.data } })
    const cache = streamCache(current)
    if (event.eventType === 'message.delta' && liveDeltaKey(event.data)) foldLiveDelta(current.activeEvents, cache.fold, { ...event, data: { ...event.data } })
    else if (foldableToolEvent(event)) {
      const key = `${event.eventType}:${event.data.toolCallId}`
      const index = cache.tools.get(key)
      if (index !== undefined) {
        const previous = current.activeEvents[index]!
        const omitted = [...(Array.isArray(previous.data.omittedFields) ? previous.data.omittedFields : []), ...(Array.isArray(event.data.omittedFields) ? event.data.omittedFields : [])]
        current.activeEvents[index] = { ...event, occurredAt: previous.occurredAt, data: { ...previous.data, ...event.data, ...(omitted.length ? { omittedFields: [...new Set(omitted)] } : {}) } }
      }
      else { cache.tools.set(key, current.activeEvents.length); current.activeEvents.push(event) }
    } else {
      // Images and completion are ordered facts, not replaceable text updates.
      resetFoldBoundary(current, event)
      current.activeEvents.push(event)
    }
    requestProjectionFrame()
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
    historyEndEntryId = bootstrap.records.at(-1)?.entryId
    state.value = bootstrap
    rebuildProjection(state.value!)
    historyTruncated.value = bootstrap.historyTruncated
    historyPageError.value = null
  }

  function clear() {
    resetProjectionSchedule()
    resetHistoryHydration()
    historyEndEntryId = undefined
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

  async function loadRecentHistory(context: ConnectionContext, epoch: number) {
    const current = state.value
    const endEntryId = historyEndEntryId
    if (!options.native || !current || !endEntryId || !options.isCurrent(context, current, epoch)) return
    historyLoading.value = true
    historyPageError.value = null
    try {
      let pageCursor: string | undefined
      let scanRevision: string | undefined
      const visitedCursors = new Set<string>()
      let page: ConversationHistoryPage
      // Worker history can already contain messages still represented by live
      // events in this bootstrap. Seek its fixed last history entry, then only
      // load that entry and its predecessors; newer output belongs to Follow.
      while (true) {
        page = await loadConversationHistory(current.instance.id, pageCursor, current.cursor.hostEpoch,
          current.cursor.runtimeGeneration, context)
        if (!options.isCurrent(context, current, epoch)) return
        if (page.hostEpoch !== current.cursor.hostEpoch || page.instance.id !== current.instance.id
          || page.instance.runtimeGeneration !== current.cursor.runtimeGeneration
          || (scanRevision !== undefined && page.revision !== scanRevision)) return options.reload(current.instance.id)
        const endIndex = page.records.findIndex((record) => record.entryId === endEntryId)
        if (endIndex >= 0) {
          page = { ...page, records: page.records.slice(0, endIndex + 1) }
          break
        }
        if (!page.hasEarlier || !page.nextCursor || visitedCursors.has(page.nextCursor)) return options.reload(current.instance.id)
        visitedCursors.add(page.nextCursor)
        scanRevision = page.revision
        pageCursor = page.nextCursor
      }
      const snapshot = options.beforeLayoutChange()
      const stick = options.isFollowing()
      // The bootstrap can cover more history than this page. Keep its order
      // and completed content; insert older records before their next known entry.
      const merged = [...current.records]
      let insertionIndex = merged.length
      for (let index = page.records.length - 1; index >= 0; index--) {
        const record = page.records[index]!
        const existingIndex = merged.findIndex((entry) => entry.entryId === record.entryId)
        if (existingIndex >= 0) insertionIndex = existingIndex
        else merged.splice(insertionIndex, 0, record)
      }
      current.records = merged
      historyRevision.value = page.revision
      historyCursor.value = page.nextCursor ?? null
      historyTruncated.value = page.hasEarlier
      rebuildProjection(current)
      scheduleHydration(context, current, epoch, pageCursor, page)
      await options.afterLayoutChange(snapshot, stick)
    } catch (cause) {
      if (state.value === current && options.getEpoch() === epoch) {
        const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
        if (code === 'protocol_error') options.reload(current.instance.id)
        else historyPageError.value = '对话记录暂时没有读取成功，请重试。'
      }
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
      else void loadRecentHistory(context, options.getEpoch())
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
    reproject, resetProjectionSchedule, applyConversationEvent, showActivity, appendHistoricalRecords,
    publish, clear, resetHistoryHydration, loadRecentHistory, loadEarlierHistory,
    retryHistoryEntry, retryHydration, dispose,
  }
}
