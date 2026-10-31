import { type OperationContext, type OperationTarget, type HostOperationContext, type EditorCapture, type NativeOperation } from '../lib/operationBinding'
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { bootstrap, connectLocalDock, getHostCatalog, removeSavedHost, setActiveHost, setLocalEndpoint, workCatalog } from '../lib/bridge'
import {
  emptyLocalUiState,
  cloneLocalUiState,
  migrateLocalUiState,
  persistLocalUiState,
  readAndMigrateLocalUiState,
  rememberRecentWorkspace,
} from '../lib/localState'
import type { AttachmentDto, PendingAttachmentSelection, BootstrapPayload, HostCatalog, HostConnectionProfile, ConnectionContext, MachinePlatform, Work } from '../lib/types'
import { userErrorMessage as humanError } from '../lib/userError'
import { draftAfterSubmit } from '../lib/uiBoundaries'
import { prependRestoredQueue, attachmentsAfterSubmit } from '../lib/attachmentDraft'

export const useAppStore = defineStore('app', () => {
  const catalog = ref<HostCatalog | null>(null)
  const payload = ref<BootstrapPayload | null>(null)
  const selectedWorkId = ref<string | null>(null)
  const localUiState = ref(emptyLocalUiState())
  const loading = ref(false)
  const error = ref<string | null>(null)
  const hostUnreachable = ref(false)
  const needsPairing = ref(false)
  const workDrawerOpen = ref(false)
  const storage = browserStorage()
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let localStateInitialized = false
  let loadEpoch = 0
  let workCatalogRefreshEpoch = 0
  const editorKey = (connectionId: string, workId: string, fileId?: string) => JSON.stringify([connectionId, workId, fileId])

  const localSelected = computed(() => catalog.value?.activeTarget?.kind === 'local')
  const activeHostId = computed(() => catalog.value?.activeTarget?.kind === 'host'
    ? catalog.value.activeTarget.hostId
    : null)
  const activeConnectionId = computed(() => localSelected.value ? 'local' : activeHostId.value)
  const activeHost = computed(() => catalog.value?.hosts.find((host) => host.hostId === activeHostId.value) ?? null)
  const connectionContext = computed<ConnectionContext | null>(() => activeConnectionId.value && catalog.value
    ? { connectionId: activeConnectionId.value, selectionGeneration: catalog.value.selectionGeneration }
    : null)
  const works = computed(() => payload.value?.works ?? [])
  const selectedWork = computed<Work | null>(() =>
    works.value.find((work) => work.id === selectedWorkId.value) ?? null,
  )
  const currentDraft = computed(() => {
    const connectionId = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    return connectionId && workId ? localUiState.value.connections[connectionId]?.drafts[workId] ?? '' : ''
  })
  const currentAttachments = computed(() => {
    const connectionId = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    return connectionId && workId ? localUiState.value.connections[connectionId]?.attachments[workId] ?? [] : []
  })
  const currentPendingAttachments = computed(() => {
    const id = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    return id && workId ? localUiState.value.connections[id]?.pendingAttachments[workId] ?? [] : []
  })
  // Native core holds images returned from the Queue; this is each Work's count for the editor.
  const restoredImageCounts = ref<Record<string, number>>({})
  const currentRestoredImageCount = computed(() => {
    const id = activeConnectionId.value
    const workId = selectedWork.value?.id
    return id && workId ? restoredImageCounts.value[editorKey(id, workId)] ?? 0 : 0
  })
  const hasRestoredImages = computed(() => Object.values(restoredImageCounts.value).some(count => count > 0))
  function setRestoredImageCount(connectionId: string, workId: string, count: number) {
    const next = { ...restoredImageCounts.value }
    if (count > 0) next[editorKey(connectionId, workId)] = count
    else delete next[editorKey(connectionId, workId)]
    restoredImageCounts.value = next
  }
  const operationResultsReady = ref(false)
  function commitEditor(change: (state: ReturnType<typeof emptyLocalUiState>) => void): boolean {
    const candidate = cloneLocalUiState(localUiState.value)
    change(candidate)
    if (!persistLocalUiState(storage, candidate)) return false
    localUiState.value = candidate
    return true
  }
  function setPendingAttachments(value: PendingAttachmentSelection[]): boolean {
    const id = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    if (!id || !workId) return false
    return commitEditor(state => { state.connections[id]!.pendingAttachments[workId] = value })
  }
  function completeAttachmentSelection(selection: PendingAttachmentSelection, attachment: AttachmentDto): boolean {
    const id = localUiState.value.activeConnectionId
    const work = selectedWork.value
    if (!id || !work || work.executor.piSessionId !== selection.sessionId
      || !currentPendingAttachments.value.some(item => item.jobId === selection.jobId && item.revision === selection.revision)) return false
    return commitEditor(state => {
      const connection = state.connections[id]!
      connection.pendingAttachments[work.id] = connection.pendingAttachments[work.id]!.filter(item => item.revision !== selection.revision)
      connection.attachments[work.id] = [...(connection.attachments[work.id] ?? []).filter(item => item.fileId !== attachment.fileId), attachment]
      connection.attachmentRevisions[editorKey(id, work.id, attachment.fileId)] = selection.revision
    })
  }

  async function load() {
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    error.value = null
    hostUnreachable.value = false
    try {
      const fetchedCatalog = await getHostCatalog()
      if (epoch !== loadEpoch) return
      // A deletion may have committed while this read was in flight. Keep its
      // newer catalog without cancelling reads of the still-current Work.
      const nextCatalog = catalog.value && catalog.value.revision > fetchedCatalog.revision ? catalog.value : fetchedCatalog
      catalog.value = nextCatalog
      needsPairing.value = nextCatalog.hosts.length === 0 && nextCatalog.activeTarget?.kind !== 'local'
      const connectionId = nextCatalog.activeTarget?.kind === 'local'
        ? 'local'
        : nextCatalog.activeTarget?.hostId
      if (!connectionId) {
        clearHostProjection()
        return
      }
      activateConnection(connectionId)
      await loadActive(epoch)
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function loadActive(epoch = ++loadEpoch): Promise<boolean> {
    ++workCatalogRefreshEpoch
    const context = connectionContext.value
    if (!context) return false
    const captured = { ...context }
    error.value = null
    hostUnreachable.value = false
    try {
      const next = await bootstrap(captured)
      if (epoch !== loadEpoch || !contextMatches(captured)) return false
      if (next.connectionId !== captured.connectionId || next.selectionGeneration !== captured.selectionGeneration) return false
      applyBootstrapProjection(next, captured)
      return true
    } catch (cause) {
      if (epoch !== loadEpoch || !contextMatches(captured)) return false
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      hostUnreachable.value = code === 'host_unreachable' || code === 'connection_failed'
      error.value = humanError(cause)
      return false
    }
  }

  function applyBootstrapProjection(next: BootstrapPayload, context: ConnectionContext) {
    if (payload.value?.connectionId === next.connectionId && payload.value.host.hostEpoch === next.host.hostEpoch) {
      next.works = next.works.map((incoming) => {
        const current = payload.value?.works.find((work) => work.id === incoming.id)
        return current && snapshotIsNewer(current, incoming) ? current : incoming
      })
    }
    payload.value = next
    // Bootstrap may record a newly successful endpoint and advance the
    // profile revision, so keep the catalog mutation source current too.
    if (next.host.profile) applyHostProfile(next.host.profile, context)
    if (selectedWorkId.value && !selectedWork.value) {
      selectedWorkId.value = null
      const connection = localUiState.value.connections[context.connectionId]
      if (connection) connection.selectedWorkId = null
      saveLocalState()
    }
  }

  async function switchHost(hostId: string) {
    if (!catalog.value || (catalog.value.activeTarget?.kind === 'host' && hostId === catalog.value.activeTarget.hostId)) return
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    error.value = null
    hostUnreachable.value = false
    clearHostProjection()
    try {
      const next = await setActiveHost(hostId, catalog.value.revision)
      if (epoch !== loadEpoch) return
      catalog.value = next
      activateConnection(hostId)
      await loadActive(epoch)
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function connectLocal() {
    if (!catalog.value || !catalog.value.localConnectionSupported) return
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    error.value = null
    hostUnreachable.value = false
    try {
      const next = await connectLocalDock(catalog.value.revision)
      if (epoch !== loadEpoch) return
      clearHostProjection()
      catalog.value = next
      needsPairing.value = false
      if (next.activeTarget?.kind === 'local') {
        activateConnection('local')
        await loadActive(epoch)
      }
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function saveLocalEndpoint(endpoint?: string) {
    if (!catalog.value || !catalog.value.localConnectionSupported) return
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    error.value = null
    try {
      const next = await setLocalEndpoint(catalog.value.revision, endpoint)
      if (epoch !== loadEpoch) return
      catalog.value = next
      if (next.activeTarget?.kind === 'local') {
        activateConnection('local')
        await loadActive(epoch)
      }
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  /** Removing another saved Host leaves the current page, its selection and
   * in-flight reads alone. Failures are thrown to the Host settings caller. */
  async function removeOtherHost(hostId: string) {
    const current = catalog.value
    if (!current || hostId === activeConnectionId.value) return
    const next = await removeSavedHost(hostId, current.revision)
    if (catalog.value && next.revision < catalog.value.revision) return
    // Native kept the selection for another Host; if it did not, show what it chose.
    if (next.selectionGeneration !== current.selectionGeneration) return load()
    catalog.value = next
  }

  async function removeHost(hostId: string) {
    if (!catalog.value) return
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    try {
      const next = await removeSavedHost(hostId, catalog.value.revision)
      if (epoch !== loadEpoch) return
      catalog.value = next
      needsPairing.value = next.hosts.length === 0 && next.activeTarget?.kind !== 'local'
      clearHostProjection()
      const connectionId = next.activeTarget?.kind === 'local' ? 'local' : next.activeTarget?.kind === 'host' ? next.activeTarget.hostId : undefined
      if (connectionId) {
        activateConnection(connectionId)
        await loadActive(epoch)
      }
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function refreshWorksQuietly() {
    const context = connectionContext.value
    const currentPayload = payload.value
    if (!context || !currentPayload || currentPayload.connectionId !== context.connectionId) return false
    const captured = { ...context }
    const hostEpoch = currentPayload.host.hostEpoch
    const refreshEpoch = ++workCatalogRefreshEpoch
    try {
      const next = await workCatalog(captured)
      if (refreshEpoch !== workCatalogRefreshEpoch || !contextMatches(captured)) return false
      const target = payload.value
      if (!target || target.connectionId !== captured.connectionId || target.host.hostEpoch !== hostEpoch) return false
      if (next.connectionId !== captured.connectionId || next.selectionGeneration !== captured.selectionGeneration) return false
      if (next.hostEpoch !== hostEpoch) {
        const replacement = await bootstrap(captured)
        if (refreshEpoch !== workCatalogRefreshEpoch || !contextMatches(captured)) return false
        if (replacement.connectionId !== captured.connectionId || replacement.selectionGeneration !== captured.selectionGeneration) return false
        applyBootstrapProjection(replacement, captured)
        return true
      }
      next.instances = next.instances.map((incoming) => {
        const current = target.works.find((work) => work.id === incoming.id)
        return current && snapshotIsNewer(current, incoming) ? current : incoming
      })
      target.works = next.instances
      target.total = next.total
      target.hiddenStopped = next.hiddenStopped
      if (selectedWorkId.value && !selectedWork.value) {
        selectedWorkId.value = null
        const connection = localUiState.value.connections[captured.connectionId]
        if (connection) connection.selectedWorkId = null
        saveLocalState()
      }
      return true
    } catch {
      return false
    }
  }

  function contextMatches(context: ConnectionContext) {
    return connectionContext.value?.connectionId === context.connectionId
      && connectionContext.value.selectionGeneration === context.selectionGeneration
  }

  function clearHostProjection() {
    payload.value = null
    selectedWorkId.value = null
    workDrawerOpen.value = false
  }

  function activateConnection(connectionId: string) {
    if (localStateInitialized && localUiState.value.activeConnectionId === connectionId) return
    clearHostProjection()
    localUiState.value = localStateInitialized
      ? migrateLocalUiState(localUiState.value, { selectedWorkId: null, draft: null }, connectionId)
      : readAndMigrateLocalUiState(storage, connectionId)
    localStateInitialized = true
    selectedWorkId.value = localUiState.value.connections[connectionId]?.selectedWorkId ?? null
    saveLocalState()
  }

  // List reads and the current Work's reads and live events arrive separately.
  // Order them by the Host journal position each state includes. Neither
  // updatedAt (several changes share a millisecond) nor ownerHostEpoch (empty
  // once a Work stops) can order two states.
  function snapshotIsNewer(candidate: Work, baseline: Work) {
    const next = candidate.eventCursor
    const known = baseline.eventCursor
    if (next.hostEpoch !== known.hostEpoch || next.instanceId !== known.instanceId) return false
    return next.runtimeGeneration > known.runtimeGeneration
      || (next.runtimeGeneration === known.runtimeGeneration && next.sequence > known.sequence)
  }

  function applyHostProfile(profile: HostConnectionProfile, context = connectionContext.value) {
    if (!context || !contextMatches(context) || profile.hostId !== context.connectionId) return
    const entry = catalog.value?.hosts.find((host) => host.hostId === profile.hostId)
    if (entry) {
      entry.profile = profile
      entry.displayName = profile.displayName
    }
    if (payload.value?.connectionId === profile.hostId) payload.value.host.profile = profile
  }

  function applyWorkSnapshot(snapshot: Work, context = connectionContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.connectionId !== context.connectionId) return
    if (snapshot.ownerHostEpoch && snapshot.ownerHostEpoch !== payload.value.host.hostEpoch) return
    // Which Works exist comes only from the Host's list. A state for a Work that
    // is not listed, such as a late one after it stopped, is dropped.
    const index = payload.value.works.findIndex((work) => work.id === snapshot.id)
    if (index < 0) return
    const current = payload.value.works[index]!
    if (snapshotIsNewer(current, snapshot)) return
    payload.value.works[index] = snapshot
  }

  /** Only the panel that created a Work adds it, from the Host's answer to that request. */
  function addCreatedWork(snapshot: Work, context = connectionContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.connectionId !== context.connectionId) return
    if (snapshot.ownerHostEpoch && snapshot.ownerHostEpoch !== payload.value.host.hostEpoch) return
    if (payload.value.works.some((work) => work.id === snapshot.id)) return
    payload.value.works.push(snapshot)
    payload.value.total += 1
  }

  /** A Work the Host has stopped leaves the list and its page; like any Work the list stops showing, its local draft is left alone. */
  function dropStoppedWork(instanceId: string, context = connectionContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.connectionId !== context.connectionId) return
    const index = payload.value.works.findIndex((work) => work.id === instanceId)
    if (index < 0) return
    payload.value.works.splice(index, 1)
    payload.value.total = Math.max(0, payload.value.total - 1)
    if (selectedWorkId.value !== instanceId) return
    selectedWorkId.value = null
    const connection = localUiState.value.connections[context.connectionId]
    if (connection?.selectedWorkId === instanceId) connection.selectedWorkId = null
    saveLocalState()
  }

  function removeWorkSnapshot(instanceId: string, context = connectionContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.connectionId !== context.connectionId) return false
    const index = payload.value.works.findIndex((work) => work.id === instanceId)
    if (index < 0) return false
    payload.value.works.splice(index, 1)
    payload.value.total = Math.max(0, payload.value.total - 1)
    const connection = localUiState.value.connections[context.connectionId]
    if (connection) {
      invalidateSubmitDraft(context.connectionId, instanceId)
      delete connection.drafts[instanceId]
      delete connection.attachments[instanceId]
      if (connection.selectedWorkId === instanceId) connection.selectedWorkId = null
    }
    if (selectedWorkId.value === instanceId) selectedWorkId.value = null
    saveLocalState()
    return true
  }

  function selectWork(id: string) {
    selectedWorkId.value = id
    const connectionId = localUiState.value.activeConnectionId
    const connection = connectionId ? localUiState.value.connections[connectionId] : undefined
    if (connection) connection.selectedWorkId = id
    saveLocalState()
    workDrawerOpen.value = false
  }

  function setCurrentDraft(value: string) {
    const connectionId = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    const connection = connectionId ? localUiState.value.connections[connectionId] : undefined
    if (!connection || !workId) return
    if ((connection.drafts[workId] ?? '') !== value) connection.editorRevisions[workId] = crypto.randomUUID()
    if (value) connection.drafts[workId] = value
    else delete connection.drafts[workId]
    if (saveTimer === undefined) saveTimer = setTimeout(flushLocalState, 250)
  }

  function setCurrentAttachments(value: AttachmentDto[]): boolean {
    const id = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    if (!id || !workId) return false
    return commitEditor(state => {
      const connection = state.connections[id]!
      const previous = connection.attachments[workId] ?? []
      for (const fileId of new Set([...previous, ...value].map(item => item.fileId))) {
        if (JSON.stringify(previous.find(item => item.fileId === fileId)) !== JSON.stringify(value.find(item => item.fileId === fileId))) {
          connection.attachmentRevisions[editorKey(id, workId, fileId)] = crypto.randomUUID()
        }
      }
      connection.attachments[workId] = value.map(item => ({ ...item }))
    })
  }

  function invalidateSubmitDraft(connectionId: string, workId: string) {
    const connection = localUiState.value.connections[connectionId]
    if (!connection) return
    connection.editorRevisions[workId] = crypto.randomUUID()
    for (const item of connection.attachments[workId] ?? []) {
      connection.attachmentRevisions[editorKey(connectionId, workId, item.fileId)] = crypto.randomUUID()
    }
    saveLocalState()
  }

  function captureSubmitDraft(connectionId: string, workId: string, attachments: AttachmentDto[]): EditorCapture {
    const connection = localUiState.value.connections[connectionId]
    if (connection) {
      connection.editorRevisions[workId] ??= crypto.randomUUID()
      for (const item of attachments) connection.attachmentRevisions[editorKey(connectionId, workId, item.fileId)] ??= crypto.randomUUID()
    }
    // Persist the revision before native accepts an operation. Missing revisions
    // after reconstruction can never prove ownership of an editor.
    if (!flushLocalState()) throw new Error('无法保存当前输入，请检查本机存储后重试；本次操作尚未开始。')
    return {
      connectionId, workId, sessionId: works.value.find(work => work.id === workId)?.executor.piSessionId ?? '',
      text: connection?.drafts[workId] ?? '',
      textRevision: connection?.editorRevisions[workId],
      attachments: attachments.map(attachment => ({ attachment: { ...attachment },
        revision: connection?.attachmentRevisions[editorKey(connectionId, workId, attachment.fileId)] })),
    }
  }
  function captureHostOperation(context: ConnectionContext): HostOperationContext {
    if (!contextMatches(context) || !payload.value) throw new Error('当前连接已变化，请重新选择。')
    return Object.freeze({ ...context, expectedHostEpoch: payload.value.host.hostEpoch })
  }
  function captureOperationTarget(context: ConnectionContext, workId: string): OperationTarget {
    const work = works.value.find(work => work.id === workId)
    if (!work || !contextMatches(context)) throw new Error('当前工作已变化，请重新选择。')
    return Object.freeze({ ...context, instanceId: workId, expectedHostEpoch: work.ownerHostEpoch ?? payload.value?.host.hostEpoch ?? '',
      expectedRuntimeGeneration: work.runtimeGeneration })
  }
  function captureOperation(context: ConnectionContext, workId: string, fileIds?: string[]): OperationContext {
    const target = captureOperationTarget(context, workId)
    const attachments = localUiState.value.connections[context.connectionId]?.attachments[workId] ?? []
    const editor = captureSubmitDraft(context.connectionId, workId, fileIds ? attachments.filter(item => fileIds.includes(item.fileId)) : attachments)
    return Object.freeze({ ...target, operationEditor: editor })
  }
  const operations = ref<Map<string, NativeOperation>>(new Map())
  const nativeOperations = computed(() => operations.value as ReadonlyMap<string, NativeOperation>)
  function bindNativeOperation(operation: NativeOperation) {
    operations.value.set(operation.operationId, operation)
  }
  function forgetNativeOperation(operationId: string, state: NativeOperation['state']) {
    if (operations.value.get(operationId)?.state === state) operations.value.delete(operationId)
  }
  // Failures the control that started them has put on screen. The operations store
  // releases their results instead of telling them again in a result entry.
  const shownFailures = ref(new Set<string>())
  /** Call when a control shows this failure now. A trust question is not a shown
   * failure: its continuation reuses the operation. */
  function failureShown(cause: unknown) {
    const operationId = cause && typeof cause === 'object' && 'operationId' in cause && typeof cause.operationId === 'string' ? cause.operationId : ''
    if (operationId) shownFailures.value.add(operationId)
  }
  function shownFailureReleased(operationId: string) { shownFailures.value.delete(operationId) }
  // Only receipts applied locally but not yet confirmed natively survive F5.
  function operationWasApplied(operationId: string) { return localUiState.value.appliedOperationIds.includes(operationId) }
  function retainAppliedOperations(operationIds: string[]) {
    const retained = localUiState.value.appliedOperationIds.filter(id => operationIds.includes(id))
    if (retained.length === localUiState.value.appliedOperationIds.length) return true
    return commitEditor(state => { state.appliedOperationIds = retained })
  }
  function confirmAppliedOperation(operationId: string) {
    return retainAppliedOperations(localUiState.value.appliedOperationIds.filter(id => id !== operationId))
  }
  function applyReturnedDraft(captured: EditorCapture, text: string | undefined, operationId?: string) {
    const connection = localUiState.value.connections[captured.connectionId]
    if (!connection || !captured.textRevision || connection.editorRevisions[captured.workId] !== captured.textRevision) return false
    return commitEditor(state => {
      const connection = state.connections[captured.connectionId]!
      if (text) connection.drafts[captured.workId] = text
      else delete connection.drafts[captured.workId]
      connection.editorRevisions[captured.workId] = crypto.randomUUID()
      const previous = connection.attachments[captured.workId] ?? []
      connection.attachments[captured.workId] = previous.filter(item => item.localUpload || !captured.attachments.some(original =>
        original.attachment.fileId === item.fileId && original.revision && original.revision === connection.attachmentRevisions[editorKey(captured.connectionId, captured.workId, item.fileId)]))
      if (operationId) state.appliedOperationIds.push(operationId)
    }) || null
  }

  function restoreOperationQueue(connectionId: string, workId: string, items: import('../lib/types').QueueItem[], operationId: string) {
    if (!localUiState.value.connections[connectionId]) return false
    return commitEditor(state => {
      const connection = state.connections[connectionId]!
      // Retrieval is one insertion into the editor as it exists at success.
      const restored = prependRestoredQueue(connection.drafts[workId] ?? '', connection.attachments[workId] ?? [], items)
      connection.drafts[workId] = restored.text
      connection.attachments[workId] = restored.attachments
      connection.editorRevisions[workId] = crypto.randomUUID()
      for (const item of restored.attachments) connection.attachmentRevisions[editorKey(connectionId, workId, item.fileId)] = crypto.randomUUID()
      state.appliedOperationIds.push(operationId)
    }) || null
  }
  function appendOperationText(captured: EditorCapture, text: string, operationId: string) {
    if (!localUiState.value.connections[captured.connectionId]) return false
    return commitEditor(state => {
      const connection = state.connections[captured.connectionId]!
      connection.drafts[captured.workId] = [connection.drafts[captured.workId] ?? '', text].filter(Boolean).join('\n\n')
      connection.editorRevisions[captured.workId] = crypto.randomUUID()
      state.appliedOperationIds.push(operationId)
    }) || null
  }

  /** A receipt consumes only the original editor items, never the selected editor. */
  function completeSubmitDraft(captured: ReturnType<typeof captureSubmitDraft>) {
    const { connectionId, workId } = captured
    const candidate = cloneLocalUiState(localUiState.value)
    const connection = candidate.connections[connectionId]
    if (!connection) return []
    if (captured.textRevision && connection.editorRevisions[workId] === captured.textRevision) {
      const text = draftAfterSubmit(connection.drafts[workId] ?? '', captured.text, true)
      if (text) connection.drafts[workId] = text
      else delete connection.drafts[workId]
    }
    const currentAttachments = connection.attachments[workId] ?? []
    const consumed = currentAttachments.filter((item) => {
      const original = captured.attachments.find(({ attachment }) => attachment.fileId === item.fileId)
      return original?.revision && connection.attachmentRevisions[editorKey(connectionId, workId, item.fileId)] === original.revision
    })
    const retained = attachmentsAfterSubmit(currentAttachments, consumed.map((item) => item.fileId), true)
    if (retained.length) connection.attachments[workId] = retained
    else delete connection.attachments[workId]
    if (!persistLocalUiState(storage, candidate)) return null
    localUiState.value = candidate
    return consumed
  }

  function recentWorkspaces(machineHostId: string) {
    const connectionId = localUiState.value.activeConnectionId
    return connectionId ? [...(localUiState.value.connections[connectionId]?.recentWorkspaces[machineHostId] ?? [])] : []
  }

  function rememberCreatedWorkspace(machineHostId: string, path: string, platform?: MachinePlatform) {
    const connectionId = localUiState.value.activeConnectionId
    if (connectionId && rememberRecentWorkspace(localUiState.value, connectionId, machineHostId, path, platform)) saveLocalState()
  }

  function flushLocalState() {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    return persistLocalUiState(storage, localUiState.value)
  }
  function saveLocalState() { return flushLocalState() }

  return {
    catalog, localSelected, activeConnectionId, activeHost, connectionContext, payload, works, selectedWork, selectedWorkId,
    currentDraft, currentAttachments, currentPendingAttachments, currentRestoredImageCount, hasRestoredImages, setRestoredImageCount, setPendingAttachments, completeAttachmentSelection, operationResultsReady, loading, error, hostUnreachable, needsPairing, workDrawerOpen,
    load, loadActive, refreshWorksQuietly, switchHost, connectLocal, saveLocalEndpoint, removeHost, removeOtherHost, contextMatches, applyHostProfile, applyWorkSnapshot, addCreatedWork, dropStoppedWork, removeWorkSnapshot, selectWork,
    operationWasApplied, retainAppliedOperations, confirmAppliedOperation, captureOperation, captureOperationTarget, captureHostOperation, nativeOperations, bindNativeOperation, forgetNativeOperation, shownFailures, failureShown, shownFailureReleased, applyReturnedDraft, restoreOperationQueue, appendOperationText, flushLocalState, setCurrentDraft, setCurrentAttachments, captureSubmitDraft, completeSubmitDraft, invalidateSubmitDraft, recentWorkspaces, rememberCreatedWorkspace,
  }
})

function browserStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
