import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  cancelPairing, getSystemDeviceName, isTauri, renameHostProfile, startPairing, deleteHostEndpoint,
  saveUnverifiedHostEndpoint, setHostEndpointEnabled, testHostEndpoint, verifyHostEndpoint, watchHostRoute
} from '../lib/bridge'
import {
  DEVICE_NAME_FALLBACK, browserDeviceNameStorage, normalizeDeviceName, persistDeviceNamePreference,
  readDeviceNamePreference, resolveDeviceName
} from '../lib/deviceName'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ConnectionKind, HostConnectionProfile, HostEndpoint } from '../lib/types'
import { useAppStore } from './app'
import { useExtensionUiStore } from './extension-ui'
import { useSurfacesStore } from './surfaces'
/** Host settings and pairing UI only; native security and service policies are unchanged. */
export const useHostStore = defineStore('host', () => {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const page = useSurfacesStore()
  const busy = () => pairingInProgress.value
  const pairHost = ref('')
  const pairPort = ref<number | null>(null)
  const deviceNameStorage = browserDeviceNameStorage()
  const pairDeviceName = ref(readDeviceNamePreference(deviceNameStorage) ?? DEVICE_NAME_FALLBACK)
  const pairDeviceNameTouched = ref(false)
  const pairingRequestId = ref('')
  const pairingStage = ref('idle')
  let startingPairing: Promise<void> | undefined
  const pairingPin = ref('')
  const pairingMessage = ref('')
  const pairingError = ref('')
  const endpointHost = ref('')
  const endpointPort = ref<number | null>(null)
  const endpointLabel = ref('')
  /** The saved address the current Host connection uses; null until one is chosen. */
  const currentEndpointId = ref<string | null>(null)
  const endpointSaving = ref(false)
  const endpointFormOpen = ref(false)
  const endpointError = ref('')
  const endpointCanSaveDraft = ref(false)
  const endpointMutatingId = ref('')
  const hostDisplayName = ref('')
  const hostNameSaving = ref(false)
  const hostNameError = ref('')
  const hostNameSaved = ref(false)
  const hostRemovalError = ref('')

  async function confirmRestoredImagesBeforeHostTransition() {
    return !app.hasRestoredImages || await page.askConfirm('切换 Host？', '切换会移除尚未发送的已取回附件。')
  }

  async function initializePairDeviceName() {
    const preferred = readDeviceNamePreference(deviceNameStorage)
    const paired = app.activeHost?.deviceName
    let system: string | null = null
    if (!preferred && !paired) {
      try { system = await getSystemDeviceName() } catch { /* the editable fallback remains available */ }
    }
    const resolved = resolveDeviceName(preferred, paired, system)
    if (pairDeviceNameTouched.value) return
    pairDeviceName.value = resolved
  }

  function rememberPairDeviceName() {
    pairDeviceNameTouched.value = true
    persistDeviceNamePreference(deviceNameStorage, pairDeviceName.value)
  }

  async function beginPairing() {
    if (!isTauri || busy() || !pairHost.value.trim() || !pairPort.value || pairPort.value < 1 || pairingInProgress.value) return
    const deviceName = normalizeDeviceName(pairDeviceName.value)
    if (!deviceName) {
      pairingError.value = '请填写这台设备在 AluDock 中显示的名称。'
      return
    }
    pairDeviceName.value = deviceName
    if (!await confirmRestoredImagesBeforeHostTransition()) return
    const requestId = crypto.randomUUID()
    pairingRequestId.value = requestId
    pairingStage.value = 'connecting'
    pairingPin.value = ''
    pairingMessage.value = '正在连接这台电脑…'
    pairingError.value = ''
    try {
      startingPairing = startPairing(
        requestId,
        pairHost.value.trim(),
        pairPort.value,
        deviceName,
      )
      await startingPairing
    } catch (cause) {
      if (pairingRequestId.value !== requestId) return
      pairingRequestId.value = ''
      pairingStage.value = 'failed'
      pairingMessage.value = ''
      pairingError.value = errorMessage(cause)
    }
  }

  async function stopPairing() {
    const requestId = pairingRequestId.value
    if (!requestId) return
    pairingMessage.value = '正在取消配对…'
    try {
      // The cancel uses this attempt's native handle even if its start reply is delayed.
      await startingPairing?.catch(() => {})
      if (pairingRequestId.value !== requestId) return
      const cancelled = await cancelPairing(requestId)
      if (pairingRequestId.value !== requestId) return
      if (cancelled) {
        pairingRequestId.value = ''
        pairingStage.value = 'cancelled'
        pairingPin.value = ''
        pairingMessage.value = '配对已取消；需要连接时请重新开始。电脑上已授予的权限可在设备管理中移除。'
      }
    } catch (cause) {
      if (pairingRequestId.value === requestId) pairingError.value = errorMessage(cause)
    }
  }

  function openHostSettings() {
    page.openHostSettings()
    addingHost.value = false
    endpointFormOpen.value = false
    endpointError.value = ''
    endpointCanSaveDraft.value = false
    hostNameError.value = ''
    hostNameSaved.value = false
    hostRemovalError.value = ''
    hostDisplayName.value = app.payload?.host.profile?.displayName ?? app.activeHost?.displayName ?? ''
  }

  function showHostPairingForm() {
    if (!pairingInProgress.value) {
      pairingStage.value = 'idle'
      pairingMessage.value = ''; pairingError.value = ''; pairingPin.value = ''
    }
    pairDeviceName.value = resolveDeviceName(
      readDeviceNamePreference(deviceNameStorage),
      app.activeHost?.deviceName,
      pairDeviceName.value,
    )
    addingHost.value = true
    endpointFormOpen.value = false
  }

  function toggleEndpointForm() {
    endpointFormOpen.value = !endpointFormOpen.value
    if (endpointFormOpen.value) addingHost.value = false
  }

  async function switchSavedHost(hostId: string) {
    if (!isTauri || hostId === app.activeConnectionId || busy() || !await confirmRestoredImagesBeforeHostTransition()) return
    await extensionUi.clear()
    page.closeModal()
    await app.switchHost(hostId)
  }

  async function connectLocal() {
    if (!isTauri || app.loading || busy() || !await confirmRestoredImagesBeforeHostTransition()) return
    await extensionUi.clear()
    await app.connectLocal()
    if (!app.error) {
      addingHost.value = false
      endpointFormOpen.value = false
      hostDisplayName.value = app.activeHost?.displayName ?? ''
    }
  }

  async function updateLocalEndpoint(endpoint?: string) {
    if (!isTauri || busy()) return
    await app.saveLocalEndpoint(endpoint)
  }

  async function removeSavedHost(hostId: string, displayName: string) {
    if (!isTauri || busy()) return
    const imageWarning = app.hasRestoredImages && hostId === app.activeConnectionId ? '\n\n已取回但尚未发送的附件也会从本机草稿中移除。' : ''
    const body = `这台 Host 会从此设备的列表中移除。电脑端仍会保留此设备的访问权限；如需一并撤销，请在电脑上的 AluDock 管理界面完成。以后从此设备连接需要重新配对。${imageWarning}`
    if (!await page.askConfirm(`从此设备删除“${displayName}”？`, body)) return
    hostRemovalError.value = ''
    if (hostId !== app.activeConnectionId) {
      try {
        await app.removeOtherHost(hostId)
      } catch (cause) {
        hostRemovalError.value = `“${displayName}”没有删除。${errorMessage(cause, '请重试。')}`
      }
      return
    }
    await extensionUi.clear()
    await app.removeHost(hostId)
    if (!app.catalog?.hosts.length) page.closeModal()
  }

  async function saveHostDisplayName() {
    const displayName = hostDisplayName.value.trim()
    hostNameError.value = ''
    hostNameSaved.value = false
    if (!displayName) {
      hostNameError.value = 'Host 名称不能为空。'
      return
    }
    if (hostNameSaving.value || displayName === app.payload?.host.profile?.displayName) return
    hostNameSaving.value = true
    try {
      const revision = activeProfile().revision
      const profile = await currentConnectionCall(app, (context) => renameHostProfile(displayName, revision, context))
      applyProfile(profile)
      hostDisplayName.value = profile.displayName
      hostNameSaved.value = true
    } catch (cause) {
      hostNameError.value = errorMessage(cause)
    } finally {
      hostNameSaving.value = false
    }
  }

  function activeProfile(): HostConnectionProfile {
    const profile = app.activeHost?.profile
    if (!profile) throw new Error('当前 Host 的连接档案不可用。')
    return profile
  }

  function applyProfile(profile: HostConnectionProfile) {
    app.applyHostProfile(profile, requireConnectionContext(app))
  }

  function clearEndpointForm() {
    endpointHost.value = ''
    endpointPort.value = null
    endpointCanSaveDraft.value = false
    endpointFormOpen.value = false
  }

  async function addHostEndpoint() {
    if (!endpointHost.value.trim() || !endpointPort.value || endpointSaving.value) return
    endpointSaving.value = true
    endpointError.value = ''
    endpointCanSaveDraft.value = false
    try {
      const revision = activeProfile().revision
      const profile = await currentConnectionCall(app, (context) => verifyHostEndpoint(
        endpointHost.value.trim(),
        endpointPort.value!,
        endpointLabel.value.trim() || '连接地址',
        revision,
        context,
      ))
      applyProfile(profile)
      clearEndpointForm()
    } catch (cause) {
      endpointError.value = errorMessage(cause)
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      endpointCanSaveDraft.value = code !== 'invalid_endpoint'
        && code !== 'profile_conflict'
        && code !== 'host_certificate_mismatch'
    } finally {
      endpointSaving.value = false
    }
  }

  async function saveEndpointDraft() {
    if (!endpointHost.value.trim() || !endpointPort.value || endpointSaving.value) return
    endpointSaving.value = true
    endpointError.value = ''
    try {
      const revision = activeProfile().revision
      const profile = await currentConnectionCall(app, (context) => saveUnverifiedHostEndpoint(
        endpointHost.value.trim(),
        endpointPort.value!,
        endpointLabel.value.trim() || '连接地址',
        revision,
        context,
      ))
      applyProfile(profile)
      clearEndpointForm()
    } catch (cause) {
      endpointError.value = errorMessage(cause)
    } finally {
      endpointSaving.value = false
    }
  }

  async function testEndpoint(endpoint: HostEndpoint) {
    if (endpointMutatingId.value) return
    endpointMutatingId.value = endpoint.id
    endpointError.value = ''
    try {
      const revision = activeProfile().revision
      const result = await currentConnectionCall(app, (context) => testHostEndpoint(endpoint.id, revision, context))
      applyProfile(result.profile)
    } catch (cause) {
      endpointError.value = errorMessage(cause)
    } finally {
      endpointMutatingId.value = ''
    }
  }

  async function toggleEndpoint(endpoint: HostEndpoint) {
    if (endpointMutatingId.value) return
    endpointMutatingId.value = endpoint.id
    endpointError.value = ''
    try {
      const revision = activeProfile().revision
      applyProfile(await currentConnectionCall(app, (context) => setHostEndpointEnabled(endpoint.id, endpoint.state === 'disabled', revision, context)))
    } catch (cause) {
      endpointError.value = errorMessage(cause)
    } finally {
      endpointMutatingId.value = ''
    }
  }

  async function removeEndpoint(endpointId: string, label: string) {
    if (!await page.askConfirm(`删除连接地址“${label}”？`, '操作后仍须保留至少一个已启用、已验证的地址。')) return
    endpointError.value = ''
    try {
      const revision = activeProfile().revision
      applyProfile(await currentConnectionCall(app, (context) => deleteHostEndpoint(endpointId, revision, context)))
    } catch (cause) {
      endpointError.value = errorMessage(cause)
    }
  }

  function endpointKindLabel(kind: ConnectionKind) {
    return kind === 'local' ? '局域网' : kind === 'vpn' ? 'VPN' : '广域网'
  }

  function endpointStateLabel(endpoint: HostEndpoint) {
    if (endpoint.state === 'draft_unverified') return '待验证草稿'
    if (endpoint.state === 'disabled') return '已停用'
    return endpoint.id === currentEndpointId.value ? '正在使用' : '身份已验证'
  }

  const currentEndpoint = computed(() => app.activeHost?.profile.endpoints.find((endpoint) => endpoint.id === currentEndpointId.value))

  let routeWatch = 0
  /** Follows which address the selected Host uses while Host settings is open. */
  async function watchRoute() {
    const watch = ++routeWatch
    const context = app.connectionContext ? { ...app.connectionContext } : null
    currentEndpointId.value = null
    if (!context || app.localSelected || !app.activeHost) return
    let seen: number | null = null
    while (watch === routeWatch) {
      let route
      try {
        route = await watchHostRoute(seen, context)
      } catch {
        return // The selection changed or its connection closed; settings shows the new one.
      }
      if (watch !== routeWatch || !app.contextMatches(context) || typeof route?.routeGeneration !== 'number') return
      currentEndpointId.value = route.activeEndpointId
      seen = route.routeGeneration
    }
  }

  function stopRouteWatch() {
    routeWatch++
  }

  function testStatusLabel(endpoint: HostEndpoint) {
    const test = endpoint.lastManualTest
    if (!test) return ''
    const timestamp = new Date(test.testedAt).toLocaleString()
    return `上次手动测试 ${timestamp} · ${test.reason}`
  }

  const addingHost = ref(false)

  const pairingInProgress = computed(() => !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage.value))
  let unlisten: UnlistenFn | undefined
  let disposed = false
  async function listenNative() {
    if (unlisten) return
    const release = await listen<{ requestId: string; stage: string; pin?: string; message?: string; error?: { message: string }; hostId?: string; registryRevision?: number; selectionGeneration?: number }>('aludock://pairing-status', ({ payload }) => {
      if (!pairingRequestId.value || payload.requestId !== pairingRequestId.value) return
      pairingStage.value = payload.stage
      if (payload.pin) pairingPin.value = payload.pin
      if (['failed', 'cancelled', 'completed'].includes(payload.stage)) { pairingRequestId.value = ''; pairingPin.value = '' }
      pairingMessage.value = payload.message ?? ''
      pairingError.value = payload.error?.message ?? ''
      if (payload.stage === 'completed' && payload.hostId && payload.registryRevision && payload.selectionGeneration) {
        page.closeModal()
        void extensionUi.clear()
        void app.load()
      }
    })
    if (disposed) release(); else unlisten = release
  }
  onScopeDispose(() => { disposed = true; unlisten?.(); const id = pairingRequestId.value; pairingRequestId.value = ''; if (id) void (startingPairing ?? Promise.resolve()).catch(() => {}).then(() => cancelPairing(id)).catch(() => {}) })
  return { pairHost, pairPort, pairDeviceName, pairingStage, pairingPin, pairingMessage, pairingError, endpointHost, endpointPort, endpointLabel, currentEndpointId, currentEndpoint, endpointSaving, endpointFormOpen, endpointError, endpointCanSaveDraft, endpointMutatingId, hostDisplayName, hostNameSaving, hostNameError, hostNameSaved, hostRemovalError, addingHost, pairingInProgress, initializePairDeviceName, rememberPairDeviceName, beginPairing, stopPairing, openHostSettings, showHostPairingForm, toggleEndpointForm, switchSavedHost, connectLocal, updateLocalEndpoint, removeSavedHost, saveHostDisplayName, addHostEndpoint, saveEndpointDraft, testEndpoint, toggleEndpoint, removeEndpoint, endpointKindLabel, endpointStateLabel, testStatusLabel, watchRoute, stopRouteWatch, listenNative }
})
