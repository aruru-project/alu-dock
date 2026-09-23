import type { ReadonlyRefs } from './ownerView'
import { computed, onScopeDispose, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  cancelPairing, discardPairing, getSystemDeviceName, isTauri, renameHostProfile, reorderHostEndpoints,
  reselectHostRoute, resumePairing, startPairing, deleteHostEndpoint, saveUnverifiedHostEndpoint, setConnectionPolicy,
  setHostEndpointEnabled, testHostEndpoint, verifyHostEndpoint
} from './bridge'
import {
  DEVICE_NAME_FALLBACK, browserDeviceNameStorage, normalizeDeviceName, persistDeviceNamePreference,
  readDeviceNamePreference, resolveDeviceName
} from './deviceName'
import { currentConnectionCall, requireConnectionContext } from './hostResult'
import { userErrorMessage as errorMessage } from './userError'
import type { ConnectionKind, HostConnectionProfile, HostEndpoint } from './types'
import type { usePageSurfaces } from './pageSurfaces'
import { useAppStore } from '../stores/app'
import { useExtensionUiStore } from '../stores/extension-ui'
/** Host settings and pairing UI only; native security and service policies are unchanged. */
export function useHostConnection(page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'askConfirm' | 'closeModal' | 'openHostSettings'>>, options: { busy(): boolean; hasRestoredImages(): boolean }) {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const pairHost = ref('')
  const pairPort = ref<number | null>(null)
  const deviceNameStorage = browserDeviceNameStorage()
  const pairDeviceName = ref(readDeviceNamePreference(deviceNameStorage) ?? DEVICE_NAME_FALLBACK)
  const pairDeviceNameTouched = ref(false)
  const pairingTransactionId = ref('')
  const pairingStage = ref('idle')
  const pairingPin = ref('')
  const pairingMessage = ref('')
  const pairingError = ref('')
  const endpointHost = ref('')
  const endpointPort = ref<number | null>(null)
  const endpointLabel = ref('外网域名')
  const endpointKind = ref<ConnectionKind>('remote')
  const endpointSaving = ref(false)
  const endpointFormOpen = ref(false)
  const endpointError = ref('')
  const endpointCanSaveDraft = ref(false)
  const endpointMutatingId = ref('')
  const hostDisplayName = ref('')
  const hostNameSaving = ref(false)
  const hostNameError = ref('')
  const hostNameSaved = ref(false)

  async function confirmRestoredImagesBeforeHostTransition() {
    return !options.hasRestoredImages() || await page.askConfirm('切换 Host？', '切换会移除尚未发送的已取回附件。')
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

  async function beginPairing(replacementHostId?: string) {
    if (!isTauri || options.busy() || !pairHost.value.trim() || !pairPort.value || pairPort.value < 1 || pairingStage.value === 'connecting') return
    const deviceName = normalizeDeviceName(pairDeviceName.value)
    if (!deviceName) {
      pairingError.value = '请填写这台设备在 AluDock 中显示的名称。'
      return
    }
    pairDeviceName.value = deviceName
    if (!replacementHostId && !await confirmRestoredImagesBeforeHostTransition()) return
    pairingTransactionId.value = ''
    pairingStage.value = 'connecting'
    pairingPin.value = ''
    pairingMessage.value = '正在连接这台电脑…'
    pairingError.value = ''
    try {
      pairingTransactionId.value = await startPairing(
        pairHost.value.trim(),
        pairPort.value,
        deviceName,
        replacementHostId,
      )
    } catch (cause) {
      pairingStage.value = 'failed'
      pairingMessage.value = ''
      pairingError.value = errorMessage(cause)
    }
  }

  async function resumeRecoveredPairing(transactionId: string) {
    if (!isTauri || options.busy() || !await confirmRestoredImagesBeforeHostTransition()) return
    pairingTransactionId.value = transactionId
    pairingStage.value = 'connecting'
    pairingPin.value = ''
    pairingError.value = ''
    pairingMessage.value = '正在恢复已保存的配对…'
    try {
      await resumePairing(transactionId)
    } catch (cause) {
      pairingStage.value = 'failed'
      pairingMessage.value = ''
      pairingError.value = errorMessage(cause)
    }
  }

  async function discardRecoveredPairing(transactionId: string) {
    if (!isTauri || options.busy()) return
    try {
      await discardPairing(transactionId)
      if (pairingTransactionId.value === transactionId) pairingTransactionId.value = ''
      await app.load()
    } catch (cause) {
      pairingError.value = errorMessage(cause)
    }
  }

  async function stopPairing() {
    if (!pairingTransactionId.value) return
    const cancelled = await cancelPairing(pairingTransactionId.value)
    if (cancelled) {
      pairingStage.value = 'cancelled'
      pairingPin.value = ''
      pairingMessage.value = '已取消等待；可以从恢复列表继续或丢弃。'
    }
    await app.load()
  }

  function openHostSettings() {
    page.openHostSettings()
    addingHost.value = false
    endpointFormOpen.value = false
    endpointError.value = ''
    endpointCanSaveDraft.value = false
    hostNameError.value = ''
    hostNameSaved.value = false
    hostDisplayName.value = app.payload?.host.profile?.displayName ?? app.activeHost?.displayName ?? ''
  }

  function showHostPairingForm() {
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
    if (!isTauri || hostId === app.activeConnectionId || options.busy() || !await confirmRestoredImagesBeforeHostTransition()) return
    await extensionUi.clear()
    page.closeModal()
    await app.switchHost(hostId)
  }

  async function connectLocal() {
    if (!isTauri || app.loading || options.busy() || !await confirmRestoredImagesBeforeHostTransition()) return
    await extensionUi.clear()
    await app.connectLocal()
    if (!app.error) {
      addingHost.value = false
      endpointFormOpen.value = false
      hostDisplayName.value = app.activeHost?.displayName ?? ''
    }
  }

  async function updateLocalEndpoint(endpoint?: string) {
    if (!isTauri || options.busy()) return
    await app.saveLocalEndpoint(endpoint)
  }

  async function removeSavedHost(hostId: string, displayName: string) {
    if (!isTauri || options.busy()) return
    const imageWarning = options.hasRestoredImages() && hostId === app.activeConnectionId ? '\n\n已取回但尚未发送的附件也会从本机草稿中移除。' : ''
    const body = `这台 Host 会从此设备的列表中移除。电脑端仍会保留此设备的访问权限；如需一并撤销，请在电脑上的 AluDock 管理界面完成。以后从此设备连接需要重新配对。${imageWarning}`
    if (!await page.askConfirm(`从此设备删除“${displayName}”？`, body)) return
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
        endpointKind.value,
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
        endpointKind.value,
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

  async function chooseConnectionPolicy(mode: 'automatic' | 'fixed', endpointId?: string) {
    endpointError.value = ''
    try {
      const context = requireConnectionContext(app)
      const revision = activeProfile().revision
      applyProfile(await currentConnectionCall(app, (current) => setConnectionPolicy(mode, revision, current, endpointId)))
      if (app.contextMatches(context)) await reselectHostRoute(context)
    } catch (cause) {
      endpointError.value = errorMessage(cause)
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

  async function moveEndpoint(endpointId: string, offset: -1 | 1) {
    if (endpointMutatingId.value) return
    const profile = activeProfile()
    const ids = profile.endpoints.map((endpoint) => endpoint.id)
    const index = ids.indexOf(endpointId)
    const target = index + offset
    if (index < 0 || target < 0 || target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    endpointMutatingId.value = endpointId
    endpointError.value = ''
    try {
      applyProfile(await currentConnectionCall(app, (context) => reorderHostEndpoints(ids, profile.revision, context)))
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
    return kind === 'local' ? '局域网' : kind === 'remote' ? '广域网' : kind === 'vpn' ? 'VPN' : '手动地址'
  }

  function endpointStateLabel(endpoint: HostEndpoint) {
    if (endpoint.state === 'draft_unverified') return '待验证草稿'
    if (endpoint.state === 'disabled') return '已停用'
    return endpoint.id === app.payload?.host.activeEndpointId ? '启动时通过此地址连接' : '身份已验证'
  }

  function testStatusLabel(endpoint: HostEndpoint) {
    const test = endpoint.lastManualTest
    if (!test) return ''
    const timestamp = new Date(test.testedAt).toLocaleString()
    return `上次手动测试 ${timestamp} · ${test.reason}`
  }

  const addingHost = ref(false)

  const pairingInProgress = computed(() => !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage.value))
  const recoverablePairings = computed(() => app.catalog?.pairingTransactions ?? [])
  let unlisten: UnlistenFn | undefined
  let disposed = false
  async function listenNative() {
    const release = await listen<{ transactionId: string; stage: string; pin?: string; message?: string; error?: { message: string }; hostId?: string; registryRevision?: number; selectionGeneration?: number }>('aludock://pairing-status', ({ payload }) => {
      if (pairingTransactionId.value && payload.transactionId !== pairingTransactionId.value) return
      if (!pairingTransactionId.value) pairingTransactionId.value = payload.transactionId
      pairingStage.value = payload.stage
      if (payload.pin) pairingPin.value = payload.pin
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
  onScopeDispose(() => { disposed = true; unlisten?.() })
  return { pairHost, pairPort, pairDeviceName, pairingTransactionId, pairingStage, pairingPin, pairingMessage, pairingError, endpointHost, endpointPort, endpointLabel, endpointKind, endpointSaving, endpointFormOpen, endpointError, endpointCanSaveDraft, endpointMutatingId, hostDisplayName, hostNameSaving, hostNameError, hostNameSaved, addingHost, pairingInProgress, recoverablePairings, initializePairDeviceName, rememberPairDeviceName, beginPairing, resumeRecoveredPairing, discardRecoveredPairing, stopPairing, openHostSettings, showHostPairingForm, toggleEndpointForm, switchSavedHost, connectLocal, updateLocalEndpoint, removeSavedHost, saveHostDisplayName, addHostEndpoint, saveEndpointDraft, chooseConnectionPolicy, testEndpoint, toggleEndpoint, moveEndpoint, removeEndpoint, endpointKindLabel, endpointStateLabel, testStatusLabel, listenNative }
}
