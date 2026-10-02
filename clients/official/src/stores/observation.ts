import { defineStore } from 'pinia'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { acknowledgeConversationFollow, beginWindowsAway, cancelWindowsAway, isTauri, reselectHostRoute, startConversationFollow, stopConversationFollow } from '../lib/bridge'
import type { ConversationContentChange } from '../lib/conversationContent'
import type { ConnectionContext, ConversationBootstrap, ProjectedEvent, Work } from '../lib/types'
import { reduceLiveEvent } from '../lib/liveReducer'
import { conversationBoundaryKey, conversationReadMatches, initialWindowFocused } from '../lib/uiBoundaries'
import { requireConnectionContext } from '../lib/hostResult'
import { createSignal } from '../lib/signal'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'
import { useExtensionUiStore } from './extension-ui'
import { useCommandConsoleStore } from './command-console'
import { useCommandCatalogStore } from './command-catalog'
import { usePlatformStore } from './platform'

export type ObservationUpdate = {
  kind: 'snapshot' | 'replacement_snapshot' | 'read' | 'event' | 'replaced' | 'status' | 'batch' | 'binding_error' | 'content' | 'facts'
  token?: string; change?: ConversationContentChange; contentToken?: string; replayToken?: string; canLoadEarlier?: boolean
  bootstrap?: ConversationBootstrap; events?: ProjectedEvent[]; event?: ProjectedEvent; target?: Work; state?: string; message?: string
  updates?: { revision: number; update: ObservationUpdate }[]
}
/** One followed event the selected Work accepted, with the Work's event position before it. */
export interface AppliedEvent { connectionId: string; hostEpoch: string; instance: Work; previousSequence: number; event: ProjectedEvent }
export type ObservationEmission = ConnectionContext & { instanceId: string; subscriptionId: string; revision: number; deliveryId?: number; update: ObservationUpdate }
/** The conversation display attached by the conversation store. Neither input nor control panels subscribe to the native stream. */
export interface ConversationSink {
  preparingView(): boolean
  matchesToken(token: string): boolean
  bind(token: string, earlier: boolean): boolean
  content(token: string, change: ConversationContentChange): void
  failed(): void
  replay(event: ProjectedEvent): boolean
  event(event: ProjectedEvent, instance: Work, changed: boolean): void
  readCut(sequence: number, latest?: ConversationBootstrap): void
  read(bootstrap: ConversationBootstrap, sameDomain: boolean, canLoadEarlier?: boolean): void
  replace(snapshot: Work): void
}

// Before a display attaches, facts still update and content is not bound.
const detachedDisplay: ConversationSink = {
  preparingView: () => false, matchesToken: () => false, bind: () => false, content() {}, failed() {},
  replay: () => false, event() {}, readCut() {}, read() {}, replace() {},
}

/** Follows the selected Work: control facts, Queue, status and frame ACK.
 * Window focus and the Windows away period decide when it observes. */
export const useObservationStore = defineStore('observation', () => {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const commandConsole = useCommandConsoleStore()
  const commandCatalog = useCommandCatalogStore()
  const platform = usePlatformStore()
  let display = detachedDisplay
  function attachDisplay(sink: ConversationSink) {
    display = sink
    return () => { if (display === sink) display = detachedDisplay }
  }
  const configChanged = createSignal<[event: ProjectedEvent]>()
  const compactionSettled = createSignal<[connectionId: string, instanceId: string]>()
  const replaced = createSignal<[]>()
  const eventApplied = createSignal<[applied: AppliedEvent]>()
  const facts = ref<Pick<ConversationBootstrap, 'instance' | 'cursor' | 'queue'> | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const status = ref('connecting')
  const connected = ref(false)
  const active = ref<(ConnectionContext & { instanceId: string; subscriptionId: string }) | null>(null)
  let revision = -1
  const unlisteners: UnlistenFn[] = []
  let disposed = false
  let refreshOnEntry = false
  function keep(release: UnlistenFn) { if (disposed) release(); else unlisteners.push(release) }
  async function listenNative() {
    keep(await listen<ObservationEmission>('aludock://observation', ({ payload }) => { void receive(payload) }))
  }

  function acceptWork(snapshot: Work, context = app.connectionContext, extensionSnapshot = true): Work {
    if (context) app.applyWorkSnapshot(snapshot, context)
    const authoritative = app.works.find(work => work.id === snapshot.id) ?? snapshot
    if (extensionSnapshot) extensionUi.applyAuthoritativeSnapshot(authoritative)
    return authoritative
  }
  function applyEvent(payload: ObservationEmission & { event: ProjectedEvent }, render = true) {
    const current = facts.value
    if (!current || !matches(payload)) return
    const reduced = reduceLiveEvent({
      ...payload, hostEpoch: current.cursor.hostEpoch,
      instance: current.instance, queue: current.queue, sequence: current.cursor.sequence
    }, payload)
    if (reduced.kind !== 'applied') return
    if (reduced.state.instance !== current.instance) acceptWork(reduced.state.instance, payload, false)
    const previousSequence = current.cursor.sequence
    current.instance = reduced.state.instance
    current.queue = reduced.state.queue
    current.cursor.sequence = reduced.state.sequence
    eventApplied.emit({ connectionId: payload.connectionId, hostEpoch: current.cursor.hostEpoch, instance: current.instance, previousSequence, event: payload.event })
    if (payload.event.eventType === 'compaction.started' || payload.event.eventType === 'compaction.completed') compactionSettled.emit(payload.connectionId, payload.instanceId)
    if (payload.event.eventType === 'resources.reloaded') commandCatalog.invalidate()
    if (reduced.configChanged) configChanged.emit(payload.event)
    extensionUi.applyLive(payload.instanceId, payload.subscriptionId, payload.event)
    const commandRoute = commandConsole.handleDockEvent(payload.event)
    if (payload.event.eventType === 'extension.notification' && commandRoute.matched) return
    if (render) display.event(payload.event, current.instance, reduced.conversationChanged)
  }
  function matches(payload: ConnectionContext & { instanceId: string; subscriptionId: string }) {
    return app.contextMatches(payload) && payload.instanceId === app.selectedWorkId && payload.subscriptionId === active.value?.subscriptionId
  }
  async function receive(payload: ObservationEmission) {
    accept(payload)
    if (payload.deliveryId === undefined) return
    // Preparing a cached view is data assembly, not a sequence of visible frames.
    if (!display.preparingView()) {
      await nextTick()
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    }
    if (matches(payload)) {
      // Native sends nothing more until this delivery is acknowledged, so a
      // failed acknowledgement stops updates: say so instead of waiting silently.
      try { await acknowledgeConversationFollow(payload, payload.instanceId, payload.subscriptionId, payload.deliveryId) }
      catch (cause) { if (matches(payload)) followFailed(cause) }
    }
  }
  function accept(payload: ObservationEmission) {
    if (!matches(payload)) return
    const update = payload.update
    if (update.kind === 'binding_error') {
      display.failed(); status.value = update.state ?? 'content_error'; error.value = update.message ?? null
      connected.value = false; loading.value = false
      return
    }
    if (update.kind === 'batch') {
      for (const commit of update.updates ?? []) accept({ ...payload, ...commit, deliveryId: undefined })
      return
    }
    const sameContent = update.contentToken !== undefined && display.matchesToken(update.contentToken)
    if (update.contentToken && display.bind(update.contentToken, update.canLoadEarlier ?? false)) {
      const target = update.target ?? update.bootstrap?.instance
      if (target) replace(target, true)
    }
    if (update.kind === 'content' && update.token && update.change) {
      if (payload.revision < revision) return
      revision = payload.revision; display.content(update.token, update.change)
      return
    }
    if (update.kind === 'event' && update.replayToken && update.event) {
      if (display.matchesToken(update.replayToken)) {
        const restored = display.replay(update.event)
        applyEvent({ ...payload, event: update.event }, !restored)
      }
      return
    }
    if (payload.revision <= revision) return
    revision = payload.revision
    if (update.kind === 'facts' && update.bootstrap) { readFacts(payload, update.bootstrap); refreshOnEntry = false; return }
    if ((update.kind === 'replaced' || update.kind === 'replacement_snapshot') && update.target) { replace(update.target, true); replaced.emit() }
    if ((update.kind === 'read' || update.kind === 'snapshot' || update.kind === 'replacement_snapshot') && update.bootstrap) {
      read({ ...payload, bootstrap: update.bootstrap }, sameContent, update.canLoadEarlier)
      if (update.kind === 'read') refreshOnEntry = false
      if (update.contentToken) display.content(update.contentToken, { kind: 'checkpoint_begin', bootstrap: update.bootstrap, replay: true })
    } else if (update.kind === 'snapshot' && update.target) replace(update.target)
    for (const event of update.events ?? (update.event ? [update.event] : [])) applyEvent({ ...payload, event })
    if (update.state !== undefined) {
      status.value = update.state; connected.value = update.state === 'connected'; error.value = update.message ?? null
      if (update.state !== 'connecting') loading.value = false
    }
  }
  function sameDomain(current: NonNullable<typeof facts.value>, next: ConversationBootstrap) {
    return current.instance.id === next.instance.id && current.instance.runtimeGeneration === next.instance.runtimeGeneration
      && current.instance.executor.piSessionId === next.instance.executor.piSessionId && current.cursor.hostEpoch === next.cursor.hostEpoch
  }
  function readFacts(payload: ConnectionContext & { subscriptionId: string }, next: ConversationBootstrap) {
    const current = facts.value
    if (!current || !sameDomain(current, next)) return
    const latest = current.cursor.sequence <= next.cursor.sequence
    display.readCut(next.cursor.sequence, latest ? next : undefined)
    if (latest) {
      facts.value = { instance: next.instance, cursor: { ...next.cursor }, queue: [...next.queue] }
      acceptWork(next.instance, payload, false)
      void extensionUi.bootstrap(payload, payload.subscriptionId, next)
    } else extensionUi.bindSubscription(payload, payload.subscriptionId, current.cursor)
  }
  function read(payload: ObservationEmission & { bootstrap: ConversationBootstrap }, sameContent: boolean, earlier?: boolean) {
    const next = payload.bootstrap
    const selected = app.selectedWork
    if (!selected || next.cursor.hostEpoch !== app.payload?.host.hostEpoch || next.cursor.runtimeGeneration < selected.runtimeGeneration
      || !conversationReadMatches(payload, payload.instanceId, next)) return
    const same = !!facts.value && sameDomain(facts.value, next)
    if (sameContent && same) { readFacts(payload, next); loading.value = false; return }
    facts.value = { instance: next.instance, cursor: { ...next.cursor }, queue: [...next.queue] }
    acceptWork(next.instance, payload, false)
    void extensionUi.bootstrap(payload, payload.subscriptionId, next)
    display.read(next, same, earlier)
    loading.value = false
  }
  function replace(snapshot: Work, replaced = false) {
    const previous = facts.value
    if (previous && (replaced || previous.cursor.hostEpoch !== snapshot.ownerHostEpoch || previous.instance.id !== snapshot.id
      || previous.instance.runtimeGeneration !== snapshot.runtimeGeneration || previous.instance.executor.piSessionId !== snapshot.executor.piSessionId)) {
      facts.value = null
      display.replace(snapshot)
    }
    acceptWork(snapshot, app.connectionContext, false)
  }
  /** Receipt removes only the IDs actually returned. A later queued message survives either event order. */
  function queueRetrieved(operation: { connectionId: string; instanceId: string; hostEpoch: string; runtimeGeneration: number; sessionId: string }, ids: string[]) {
    const current = facts.value
    if (!current || operation.connectionId !== app.activeConnectionId || current.instance.id !== operation.instanceId
      || current.cursor.hostEpoch !== operation.hostEpoch || current.instance.runtimeGeneration !== operation.runtimeGeneration
      || current.instance.executor.piSessionId !== operation.sessionId) return
    current.queue = current.queue.filter(item => !ids.includes(item.queueItemId))
  }
  async function load(instanceId: string, refresh = false): Promise<boolean> {
    if ((isTauri && !windowFocused.value) || app.selectedWork?.id !== instanceId || app.selectedWork.lifecycle !== 'active') return false
    const context = { ...requireConnectionContext(app) }
    const subscriptionId = crypto.randomUUID()
    status.value = 'connecting'; revision = -1
    active.value = { ...context, instanceId, subscriptionId }
    loading.value = !facts.value; connected.value = false
    try {
      await startConversationFollow(instanceId, subscriptionId, context, app.payload?.host.hostEpoch ?? '', refresh || refreshOnEntry)
      return active.value?.subscriptionId === subscriptionId && app.contextMatches(context)
    } catch (cause) {
      if (active.value?.subscriptionId === subscriptionId && app.contextMatches(context)) followFailed(cause)
      return false
    }
  }
  /** Updates for this Work stopped and nothing retries by itself; the user reconnects. */
  function followFailed(cause: unknown) {
    status.value = 'follow_failed'; connected.value = false; loading.value = false
    error.value = userErrorMessage(cause)
  }
  function canContinue(instanceId: string) {
    const current = facts.value
    const work = app.selectedWork
    return !!active.value && active.value.instanceId === instanceId && connected.value && app.contextMatches(active.value)
      && current?.instance.id === instanceId && current.instance.runtimeGeneration === work?.runtimeGeneration && current.cursor.hostEpoch === app.payload?.host.hostEpoch
  }
  async function detach() {
    const followed = active.value
    const handle = extensionUi.controller?.handle
    active.value = null; connected.value = false; status.value = 'paused'; loading.value = false
    const releases: Promise<unknown>[] = []
    if (followed) releases.push(stopConversationFollow(followed.instanceId, followed.subscriptionId, followed))
    if (handle) {
      extensionUi.suspendController(handle)
      releases.push(extensionUi.releaseController(handle, 'detached').then(released => { if (!released) extensionUi.controllerEnded(handle, 'disconnected') }))
    }
    await Promise.allSettled(releases)
  }
  let selection = ''
  watch(() => conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, app.selectedWork?.id), () => {
    const identity = JSON.stringify([app.activeConnectionId, app.selectedWork?.id])
    if (identity !== selection) {
      refreshOnEntry = Boolean(selection && JSON.parse(selection)[1] && app.selectedWork?.id)
      facts.value = null
    }
    selection = identity
    const work = app.selectedWork
    if (work?.lifecycle === 'active') {
      if (isTauri && windowFocused.value) void load(work.id)
      return
    }
    // Nothing on this page can be observed: let go of the Work we left.
    // Its Worker keeps running; only this client stops following it.
    stopFollowing()
    void extensionUi.clear()
  })
  function stopFollowing() {
    const followed = active.value
    if (!followed) return
    active.value = null; connected.value = false; loading.value = false
    void stopConversationFollow(followed.instanceId, followed.subscriptionId, followed).catch(() => undefined)
  }
  function reportRouteError(cause: unknown) { error.value = userErrorMessage(cause) }
  const connectionLabel = computed(() => {
    if (!isTauri) return '浏览器预览'
    if (app.payload && app.selectedWork?.lifecycle === 'active') return ({ connected: '已连接', connecting: '正在连接', disconnected: '连接已中断', paused: '已暂停观察', follow_failed: '没有收到更新', identity_error: '身份验证失败', content_error: '对话暂时无法显示', host_changed: 'Host 状态已变化', stopped: 'Work 已停止', unavailable: 'Work 当前不可用' } as Record<string, string>)[status.value] ?? '连接异常'
    if (app.error) return '连接异常'
    if (app.loading) return '正在连接'
    return app.payload ? 'Dock 已连接' : '等待连接'
  })

  const pendingRefreshes = ref(new Set<string>())
  const refreshTarget = computed(() => conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, app.selectedWork?.id))
  const refreshing = computed(() => pendingRefreshes.value.has(refreshTarget.value))
  async function refreshCurrent() {
    const target = refreshTarget.value
    if (pendingRefreshes.value.has(target)) return
    const workId = app.selectedWork?.id
    pendingRefreshes.value.add(target)
    try {
      await app.load()
      if (target === refreshTarget.value && workId && app.selectedWork?.lifecycle === 'active') {
        await load(workId, true)
      }
    } finally {
      pendingRefreshes.value.delete(target)
    }
  }

  // ── Window focus and the Windows away period ─────────────────────────
  // Leaving the window pauses observation (after the configured away delay on
  // Windows); coming back resumes it. The native policy is unchanged.
  const isAndroidWebView = /Android/i.test(navigator.userAgent)
  const windowFocused = ref(!isTauri)
  let windowFocusEpoch = 0
  let windowsAwayId: string | null = null
  const elapsedWindowsAwayIds = new Set<string>()
  const windowsAwaySupported = () => !!platform.appSettings?.windowsAwaySupported

  function runningWorkIdsForAway() {
    return app.works.filter((work) => work.execution === 'running').map((work) => work.id)
  }

  function handleWebViewFocus() {
    void handleWindowFocusChanged(true)
  }

  function handleAndroidNetworkChanged() {
    const context = app.connectionContext
    if (context && !app.localSelected) void reselectHostRoute({ ...context }).catch(cause => {
      if (app.contextMatches(context)) reportRouteError(cause)
    })
  }

  async function handleWindowFocusChanged(focused: boolean) {
    if (focused === windowFocused.value) {
      const work = app.selectedWork
      if (focused && work?.lifecycle === 'active' && !loading.value && !canContinue(work.id)) {
        await load(work.id)
      }
      return
    }
    const epoch = ++windowFocusEpoch
    windowFocused.value = focused
    if (!focused) {
      app.flushLocalState()
      if (!windowsAwaySupported()) {
        await detach()
        return
      }
      try {
        const awayId = await beginWindowsAway(runningWorkIdsForAway())
        if (epoch !== windowFocusEpoch || windowFocused.value) {
          if (awayId) await cancelWindowsAway(awayId)
          return
        }
        windowsAwayId = awayId
        if (awayId && elapsedWindowsAwayIds.delete(awayId)) await detach()
      } catch (cause) {
        console.error('Failed to begin Windows away period.', cause)
        if (epoch === windowFocusEpoch && !windowFocused.value) await detach()
      }
      return
    }

    const awayId = windowsAwayId
    windowsAwayId = null
    elapsedWindowsAwayIds.clear()
    if (windowsAwaySupported()) {
      try {
        await cancelWindowsAway(awayId)
      } catch (cause) {
        console.error('Failed to finish Windows away period.', cause)
      }
    }
    void app.refreshWorksQuietly()
    if (epoch !== windowFocusEpoch || !windowFocused.value) return
    const work = app.selectedWork
    if (work?.lifecycle === 'active' && !canContinue(work.id)) {
      await load(work.id)
    }
  }

  let focusListening = false
  /** Runs after the platform store has read App settings (away support). */
  async function listenFocus() {
    if (focusListening) return
    focusListening = true
    window.addEventListener('focus', handleWebViewFocus)
    if (isAndroidWebView) {
      window.addEventListener('aludock:network-changed', handleAndroidNetworkChanged)
      document.documentElement.dataset.aludockNetworkReady = 'true'
    }
    if (!isTauri) return
    const appWindow = getCurrentWindow()
    keep(await appWindow.onFocusChanged(({ payload }) => { void handleWindowFocusChanged(payload) }))
    windowFocused.value = initialWindowFocused(
      await appWindow.isFocused(),
      document.hasFocus(),
      isAndroidWebView && document.visibilityState === 'visible',
    )
    keep(await listen<{ awayId: string }>('aludock://windows-away-elapsed', ({ payload }) => {
      if (windowFocused.value) return
      if (payload.awayId === windowsAwayId) void detach()
      else elapsedWindowsAwayIds.add(payload.awayId)
    }))
    if (!windowFocused.value && windowsAwaySupported()) {
      try {
        windowsAwayId = await beginWindowsAway(runningWorkIdsForAway())
        if (windowsAwayId && elapsedWindowsAwayIds.delete(windowsAwayId)) await detach()
      } catch (cause) {
        console.error('Failed to begin initial Windows away period.', cause)
      }
    }
  }

  /** The first Host read has finished; start observing if the window has focus. */
  async function afterLoad() {
    await nextTick()
    if (!isTauri) return
    const focusedAfterLoad = initialWindowFocused(
      await getCurrentWindow().isFocused(),
      document.hasFocus(),
      isAndroidWebView && document.visibilityState === 'visible',
    )
    if (focusedAfterLoad) await handleWindowFocusChanged(true)
  }

  onScopeDispose(() => {
    disposed = true
    unlisteners.forEach(unlisten => unlisten())
    if (focusListening) {
      window.removeEventListener('focus', handleWebViewFocus)
      if (isAndroidWebView) {
        window.removeEventListener('aludock:network-changed', handleAndroidNetworkChanged)
        delete document.documentElement.dataset.aludockNetworkReady
      }
    }
    elapsedWindowsAwayIds.clear()
    if (windowsAwaySupported()) void cancelWindowsAway(windowsAwayId)
  })

  return {
    label: connectionLabel, refreshCurrent, refreshing, loading, error, status, connected, active, windowFocused,
    queue: computed(() => facts.value?.queue ?? []), listenNative, listenFocus, afterLoad, load, detach, canContinue, reportRouteError, acceptWork, queueRetrieved,
    attachDisplay, onConfigChanged: configChanged.on, onEventApplied: eventApplied.on, onCompactionSettled: compactionSettled.on, onReplaced: replaced.on,
  }
})
