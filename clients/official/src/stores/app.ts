import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { bootstrap, connectLocalDock, getHostCatalog, removeSavedHost, setActiveHost, setLocalEndpoint, workCatalog } from '../lib/bridge'
import {
  emptyLocalUiState,
  migrateLocalUiState,
  persistLocalUiState,
  readAndMigrateLocalUiState,
  rememberRecentWorkspace,
} from '../lib/localState'
import type { AttachmentDto, BootstrapPayload, HostCatalog, HostConnectionProfile, ConnectionContext, MachinePlatform, Work } from '../lib/types'
import { userErrorMessage as humanError } from '../lib/userError'
import { draftAfterSubmit } from '../lib/uiBoundaries'
import { attachmentsAfterSubmit } from '../lib/attachmentDraft'

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
  let localStateInitialized = false
  let loadEpoch = 0
  let workCatalogRefreshEpoch = 0
  let editorRevision = 0
  const draftRevisions = new Map<string, number>()
  const attachmentRevisions = new Map<string, number>()
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

  async function loadActive(epoch = ++loadEpoch) {
    ++workCatalogRefreshEpoch
    const context = connectionContext.value
    if (!context) return
    const captured = { ...context }
    error.value = null
    hostUnreachable.value = false
    try {
      const next = await bootstrap(captured)
      if (epoch !== loadEpoch || !contextMatches(captured)) return
      if (next.connectionId !== captured.connectionId || next.selectionGeneration !== captured.selectionGeneration) return
      applyBootstrapProjection(next, captured)
    } catch (cause) {
      if (epoch !== loadEpoch || !contextMatches(captured)) return
      payload.value = null
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      hostUnreachable.value = code === 'host_unreachable' || code === 'connection_failed'
      error.value = humanError(cause)
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
    if ((connection.drafts[workId] ?? '') !== value) draftRevisions.set(editorKey(connectionId!, workId), ++editorRevision)
    if (value) connection.drafts[workId] = value
    else delete connection.drafts[workId]
    saveLocalState()
  }

  function setCurrentAttachments(value: AttachmentDto[]) {
    const connectionId = localUiState.value.activeConnectionId
    const workId = selectedWork.value?.id
    const connection = connectionId ? localUiState.value.connections[connectionId] : undefined
    if (!connection || !workId) return
    const previous = connection.attachments[workId] ?? []
    for (const fileId of new Set([...previous, ...value].map((item) => item.fileId))) {
      if (JSON.stringify(previous.find((item) => item.fileId === fileId)) !== JSON.stringify(value.find((item) => item.fileId === fileId))) {
        attachmentRevisions.set(editorKey(connectionId!, workId, fileId), ++editorRevision)
      }
    }
    // Preserve the complete Queue restore; submit sends these in batches of 32.
    if (value.length) connection.attachments[workId] = value.map((item) => ({ ...item }))
    else delete connection.attachments[workId]
    saveLocalState()
  }

  function invalidateSubmitDraft(connectionId: string, workId: string) {
    draftRevisions.set(editorKey(connectionId, workId), ++editorRevision)
    for (const item of localUiState.value.connections[connectionId]?.attachments[workId] ?? []) {
      attachmentRevisions.set(editorKey(connectionId, workId, item.fileId), ++editorRevision)
    }
  }

  /** Capture editor ownership, including edits away and back to identical content. */
  function captureSubmitDraft(connectionId: string, workId: string, attachments: AttachmentDto[]) {
    const key = editorKey(connectionId, workId)
    return {
      connectionId, workId,
      text: localUiState.value.connections[connectionId]?.drafts[workId] ?? '',
      textRevision: draftRevisions.get(key) ?? 0,
      attachments: attachments.map((attachment) => ({
        attachment: { ...attachment },
        revision: attachmentRevisions.get(editorKey(connectionId, workId, attachment.fileId)) ?? 0,
      })),
    }
  }

  /** A receipt consumes only the original editor items, never the selected editor. */
  function completeSubmitDraft(captured: ReturnType<typeof captureSubmitDraft>) {
    const { connectionId, workId } = captured
    const connection = localUiState.value.connections[connectionId]
    if (!connection) return []
    if ((draftRevisions.get(editorKey(connectionId, workId)) ?? 0) === captured.textRevision) {
      const text = draftAfterSubmit(connection.drafts[workId] ?? '', captured.text, true)
      if (text) connection.drafts[workId] = text
      else delete connection.drafts[workId]
    }
    const currentAttachments = connection.attachments[workId] ?? []
    const consumed = currentAttachments.filter((item) => {
      const original = captured.attachments.find(({ attachment }) => attachment.fileId === item.fileId)
      return original && (attachmentRevisions.get(editorKey(connectionId, workId, item.fileId)) ?? 0) === original.revision
    })
    const retained = attachmentsAfterSubmit(currentAttachments, consumed.map((item) => item.fileId), true)
    if (retained.length) connection.attachments[workId] = retained
    else delete connection.attachments[workId]
    saveLocalState()
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

  function saveLocalState() { persistLocalUiState(storage, localUiState.value) }

  return {
    catalog, localSelected, activeConnectionId, activeHost, connectionContext, payload, works, selectedWork, selectedWorkId,
    currentDraft, currentAttachments, detailMode, loading, error, hostUnreachable, needsPairing, workDrawerOpen,
    load, loadActive, refreshWorksQuietly, switchHost, connectLocal, saveLocalEndpoint, removeHost, contextMatches, applyHostProfile, applyWorkSnapshot, removeWorkSnapshot, selectWork,
    setCurrentDraft, setCurrentAttachments, captureSubmitDraft, completeSubmitDraft, invalidateSubmitDraft, setDetailMode, recentWorkspaces, rememberCreatedWorkspace,
  }
})

function browserStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
