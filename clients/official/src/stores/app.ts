import { operationDomain, type OperationContext, type OperationTarget, type HostOperationContext, type EditorCapture, type NativeOperation } from '../lib/operationBinding'
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

export function mutationScopeKey(connectionId: string, instanceId: string, domain: string) {
  return JSON.stringify([connectionId, instanceId, domain])
}

export const useAppStore = defineStore('app', () => {
  const catalog = ref<HostCatalog | null>(null)
  const payload = ref<BootstrapPayload | null>(null)
  const selectedWorkId = ref<string | null>(null)
  const localUiState = ref(emptyLocalUiState())
  const loading = ref(false)
  const error = ref<string | null>(null)
  const unresolvedMutations = computed(() => new Map([...nativeOperations.value.values()]
    .filter(operation => operation.state === 'unknown' && operation.kind !== 'submit_message'
      && (operation.connectionId !== activeConnectionId.value || !operation.hostEpoch || operation.hostEpoch === payload.value?.host.hostEpoch))
    .map(operation => [mutationScopeKey(operation.connectionId, operation.instanceId, operationDomain(operation.kind)), operation.operationId])))
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
  const detailMode = computed(() => {
    const connectionId = localUiState.value.activeConnectionId
    return connectionId ? localUiState.value.connections[connectionId]?.detailMode ?? true : true
  })

  async function load() {
    const epoch = ++loadEpoch
    ++workCatalogRefreshEpoch
    loading.value = true
    error.value = null
    hostUnreachable.value = false
    try {
      const nextCatalog = await getHostCatalog()
      if (epoch !== loadEpoch) return
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

  function snapshotIsNewer(candidate: Work, baseline: Work) {
    if (candidate.ownerHostEpoch !== baseline.ownerHostEpoch) return false
    const candidateGeneration = candidate.runtimeGeneration ?? 0
    const baselineGeneration = baseline.runtimeGeneration ?? 0
    return candidateGeneration > baselineGeneration
      || (candidateGeneration === baselineGeneration && Date.parse(candidate.updatedAt) > Date.parse(baseline.updatedAt))
  }

  function applyHostProfile(profile: HostConnectionProfile, context = connectionContext.value) {
    if (!context || !contextMatches(context) || profile.hostId !== context.connectionId) return
    const entry = catalog.value?.hosts.find((host) => host.hostId === profile.hostId)
    if (entry) {
      entry.profile = profile
      entry.displayName = profile.displayName
      const endpoint = profile.endpoints.find((candidate) =>
        candidate.state === 'verified' && candidate.id === profile.lastSuccessfulEndpointId,
      ) ?? profile.endpoints.find((candidate) => candidate.state === 'verified')
      entry.endpointSummary = endpoint
        ? `${endpoint.endpoint.host}:${endpoint.endpoint.port}`
        : '没有已保存地址'
    }
    if (payload.value?.connectionId === profile.hostId) payload.value.host.profile = profile
  }

  function applyWorkSnapshot(snapshot: Work, context = connectionContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.connectionId !== context.connectionId) return
    if (snapshot.ownerHostEpoch && snapshot.ownerHostEpoch !== payload.value.host.hostEpoch) return
    const index = payload.value.works.findIndex((work) => work.id === snapshot.id)
    if (index < 0) {
      payload.value.works.push(snapshot)
      payload.value.total += 1
      return
    }
    const current = payload.value.works[index]!
    if (snapshotIsNewer(current, snapshot)) return
    payload.value.works[index] = snapshot
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

  function setDetailMode(value: boolean) {
    const connectionId = localUiState.value.activeConnectionId
    const connection = connectionId ? localUiState.value.connections[connectionId] : undefined
    if (!connection) return
    connection.detailMode = value
    saveLocalState()
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
    currentDraft, currentAttachments, currentPendingAttachments, setPendingAttachments, completeAttachmentSelection, operationResultsReady, detailMode, loading, error, hostUnreachable, needsPairing, workDrawerOpen,
    load, loadActive, refreshWorksQuietly, switchHost, connectLocal, saveLocalEndpoint, removeHost, contextMatches, applyHostProfile, applyWorkSnapshot, removeWorkSnapshot, selectWork,
    operationWasApplied, retainAppliedOperations, confirmAppliedOperation, captureOperation, captureOperationTarget, captureHostOperation, nativeOperations, bindNativeOperation, forgetNativeOperation, applyReturnedDraft, restoreOperationQueue, appendOperationText, unresolvedMutations, flushLocalState, setCurrentDraft, setCurrentAttachments, captureSubmitDraft, completeSubmitDraft, invalidateSubmitDraft, setDetailMode, recentWorkspaces, rememberCreatedWorkspace,
  }
})

function browserStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
