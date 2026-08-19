import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { bootstrap, getHostCatalog, removeLocalHost, setActiveHost, workCatalog } from '../lib/bridge'
import {
  emptyLocalUiState,
  migrateLocalUiState,
  persistLocalUiState,
  readAndMigrateLocalUiState,
} from '../lib/localState'
import type { AttachmentDto, BootstrapPayload, HostCatalog, HostConnectionProfile, HostContext, Work } from '../lib/types'
import { userErrorMessage as humanError } from '../lib/userError'

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

  const activeHostId = computed(() => catalog.value?.activeHostId ?? null)
  const activeHost = computed(() => catalog.value?.hosts.find((host) => host.hostId === activeHostId.value) ?? null)
  const hostContext = computed<HostContext | null>(() => activeHostId.value && catalog.value
    ? { hostId: activeHostId.value, selectionGeneration: catalog.value.selectionGeneration }
    : null)
  const works = computed(() => payload.value?.works ?? [])
  const selectedWork = computed<Work | null>(() =>
    works.value.find((work) => work.id === selectedWorkId.value) ?? null,
  )
  const currentDraft = computed(() => {
    const hostId = localUiState.value.activeHostId
    const workId = selectedWork.value?.id
    return hostId && workId ? localUiState.value.hosts[hostId]?.drafts[workId] ?? '' : ''
  })
  const currentAttachments = computed(() => {
    const hostId = localUiState.value.activeHostId
    const workId = selectedWork.value?.id
    return hostId && workId ? localUiState.value.hosts[hostId]?.attachments[workId] ?? [] : []
  })
  const detailMode = computed(() => {
    const hostId = localUiState.value.activeHostId
    return hostId ? localUiState.value.hosts[hostId]?.detailMode ?? true : true
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
      needsPairing.value = nextCatalog.hosts.length === 0
      if (!nextCatalog.activeHostId) {
        clearHostProjection()
        return
      }
      activateHost(nextCatalog.activeHostId)
      await loadActive(epoch)
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function loadActive(epoch = ++loadEpoch) {
    ++workCatalogRefreshEpoch
    const context = hostContext.value
    if (!context) return
    const captured = { ...context }
    error.value = null
    hostUnreachable.value = false
    try {
      const next = await bootstrap(captured)
      if (epoch !== loadEpoch || !contextMatches(captured)) return
      if (next.hostId !== captured.hostId || next.selectionGeneration !== captured.selectionGeneration) return
      if (payload.value?.hostId === next.hostId && payload.value.host.hostEpoch === next.host.hostEpoch) {
        next.works = next.works.map((incoming) => {
          const current = payload.value?.works.find((work) => work.id === incoming.id)
          return current && snapshotIsNewer(current, incoming) ? current : incoming
        })
      }
      payload.value = next
      // Bootstrap may record a newly successful endpoint and advance the
      // profile revision, so keep the catalog mutation source current too.
      applyHostProfile(next.host.profile, captured)
      if (selectedWorkId.value && !selectedWork.value) {
        selectedWorkId.value = null
        const host = localUiState.value.hosts[captured.hostId]
        if (host) host.selectedWorkId = null
        saveLocalState()
      }
    } catch (cause) {
      if (epoch !== loadEpoch || !contextMatches(captured)) return
      payload.value = null
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      hostUnreachable.value = code === 'host_unreachable' || code === 'connection_failed'
      error.value = humanError(cause)
    }
  }

  async function switchHost(hostId: string) {
    if (!catalog.value || hostId === catalog.value.activeHostId) return
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
      activateHost(hostId)
      await loadActive(epoch)
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
      const next = await removeLocalHost(hostId, catalog.value.revision)
      if (epoch !== loadEpoch) return
      catalog.value = next
      needsPairing.value = next.hosts.length === 0
      clearHostProjection()
      if (next.activeHostId) {
        activateHost(next.activeHostId)
        await loadActive(epoch)
      }
    } catch (cause) {
      if (epoch === loadEpoch) error.value = humanError(cause)
    } finally {
      if (epoch === loadEpoch) loading.value = false
    }
  }

  async function refreshWorksQuietly() {
    const context = hostContext.value
    const currentPayload = payload.value
    if (!context || !currentPayload || currentPayload.hostId !== context.hostId) return false
    const captured = { ...context }
    const hostEpoch = currentPayload.host.hostEpoch
    const refreshEpoch = ++workCatalogRefreshEpoch
    try {
      const next = await workCatalog(captured)
      if (refreshEpoch !== workCatalogRefreshEpoch || !contextMatches(captured)) return false
      const target = payload.value
      if (!target || target.hostId !== captured.hostId || target.host.hostEpoch !== hostEpoch) return false
      if (next.hostId !== captured.hostId || next.selectionGeneration !== captured.selectionGeneration || next.hostEpoch !== hostEpoch) return false
      next.instances = next.instances.map((incoming) => {
        const current = target.works.find((work) => work.id === incoming.id)
        return current && snapshotIsNewer(current, incoming) ? current : incoming
      })
      target.works = next.instances
      target.total = next.total
      target.hiddenStopped = next.hiddenStopped
      if (selectedWorkId.value && !selectedWork.value) {
        selectedWorkId.value = null
        const host = localUiState.value.hosts[captured.hostId]
        if (host) host.selectedWorkId = null
        saveLocalState()
      }
      return true
    } catch {
      return false
    }
  }

  function contextMatches(context: HostContext) {
    return hostContext.value?.hostId === context.hostId
      && hostContext.value.selectionGeneration === context.selectionGeneration
  }

  function clearHostProjection() {
    payload.value = null
    selectedWorkId.value = null
    workDrawerOpen.value = false
  }

  function activateHost(hostId: string) {
    clearHostProjection()
    localUiState.value = localStateInitialized
      ? migrateLocalUiState(localUiState.value, { selectedWorkId: null, draft: null }, hostId)
      : readAndMigrateLocalUiState(storage, hostId)
    localStateInitialized = true
    selectedWorkId.value = localUiState.value.hosts[hostId]?.selectedWorkId ?? null
    saveLocalState()
  }

  function snapshotIsNewer(candidate: Work, baseline: Work) {
    if (candidate.ownerHostEpoch !== baseline.ownerHostEpoch) return false
    const candidateGeneration = candidate.runtimeGeneration ?? 0
    const baselineGeneration = baseline.runtimeGeneration ?? 0
    return candidateGeneration > baselineGeneration
      || (candidateGeneration === baselineGeneration && Date.parse(candidate.updatedAt) > Date.parse(baseline.updatedAt))
  }

  function applyHostProfile(profile: HostConnectionProfile, context = hostContext.value) {
    if (!context || !contextMatches(context) || profile.hostId !== context.hostId) return
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
    if (payload.value?.hostId === profile.hostId) payload.value.host.profile = profile
  }

  function applyWorkSnapshot(snapshot: Work, context = hostContext.value) {
    if (!payload.value || !context || !contextMatches(context) || payload.value.hostId !== context.hostId) return
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

  function selectWork(id: string) {
    selectedWorkId.value = id
    const hostId = localUiState.value.activeHostId
    const host = hostId ? localUiState.value.hosts[hostId] : undefined
    if (host) host.selectedWorkId = id
    saveLocalState()
    workDrawerOpen.value = false
  }

  function setCurrentDraft(value: string) {
    const hostId = localUiState.value.activeHostId
    const workId = selectedWork.value?.id
    const host = hostId ? localUiState.value.hosts[hostId] : undefined
    if (!host || !workId) return
    if (value) host.drafts[workId] = value
    else delete host.drafts[workId]
    saveLocalState()
  }

  function setCurrentAttachments(value: AttachmentDto[]) {
    const hostId = localUiState.value.activeHostId
    const workId = selectedWork.value?.id
    const host = hostId ? localUiState.value.hosts[hostId] : undefined
    if (!host || !workId) return
    // Preserve the complete Queue restore; submit sends these in batches of 32.
    if (value.length) host.attachments[workId] = value.map((item) => ({ ...item }))
    else delete host.attachments[workId]
    saveLocalState()
  }

  function setDetailMode(value: boolean) {
    const hostId = localUiState.value.activeHostId
    const host = hostId ? localUiState.value.hosts[hostId] : undefined
    if (!host) return
    host.detailMode = value
    saveLocalState()
  }

  function saveLocalState() { persistLocalUiState(storage, localUiState.value) }

  return {
    catalog, activeHostId, activeHost, hostContext, payload, works, selectedWork, selectedWorkId,
    currentDraft, currentAttachments, detailMode, loading, error, hostUnreachable, needsPairing, workDrawerOpen,
    load, loadActive, refreshWorksQuietly, switchHost, removeHost, contextMatches, applyHostProfile, applyWorkSnapshot, selectWork,
    setCurrentDraft, setCurrentAttachments, setDetailMode,
  }
})

function browserStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
