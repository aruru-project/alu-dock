<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  Globe2,
  Link,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Trash2,
  Waypoints,
  WifiOff,
  X,
} from '@lucide/vue'
import {
  abortRun,
  cancelAttachmentUpload,
  clearRestoredImages,
  cancelPairing,
  createWork,
  dequeueMessages,
  forgetWork,
  isTauri,
  getSettings,
  getSystemDeviceName,
  listModels,
  listTools,
  listWorkspace,
  loadConversation,
  loadAttachmentPreviewBytes,
  loadConversationHistory,
  loadConversationImageBytes,
  loadPublishedImageBytes,
  pickAttachments,
  renameHostProfile,
  removeAttachment,
  reorderHostEndpoints,
  reopenWork,
  resumePairing,
  discardPairing,
  stageClipboardImage,
  startConversationFollow,
  startPairing,
  stopWork,
  submitMessage,
  uploadAttachment,
  deleteHostEndpoint,
  saveUnverifiedHostEndpoint,
  setConnectionPolicy,
  setExtensionToolsExpanded,
  setHostEndpointEnabled,
  testHostEndpoint,
  verifyHostEndpoint,
} from './lib/bridge'
import type { CreateWorkContinuation } from './lib/bridge'
import { projectConversation } from './lib/conversation'
import { appendRestoredQueue, attachmentsAfterSubmit } from './lib/attachmentDraft'
import {
  DEVICE_NAME_FALLBACK,
  browserDeviceNameStorage,
  normalizeDeviceName,
  persistDeviceNamePreference,
  readDeviceNamePreference,
  resolveDeviceName,
} from './lib/deviceName'
import { userErrorMessage as errorMessage } from './lib/userError'
import { captureHostResult, hostResultMatches } from './lib/hostResult'
import { reduceLiveEvent } from './lib/liveReducer'
import {
  conversationBoundaryKey,
  conversationSwapIsCorrelated,
  draftAfterSubmit,
  formatContextUsage,
  formatTokenCount,
  FollowActivationCoordinator,
  outputIsNearBottom,
  type FollowConnectionState,
  type FollowConnectionStatus,
  stopCanStart,
  stoppedResultIsCorrelated,
} from './lib/uiBoundaries'
import type { AttachmentDto, AttachmentUploadProgress, ConnectionKind, ConversationBootstrap, ConversationImageResource, ConversationItem, ConversationProcessItem, HostConnectionProfile, HostContext, HostEndpoint, ProjectedEvent, QueueItem, SelectedAttachment, Work, WorkspacePage } from './lib/types'
import AttachmentCard from './components/AttachmentCard.vue'
import ControlCenter, { type ControlMutationDomain, type ControlSection } from './components/ControlCenter.vue'
import ConversationProcessParts from './components/ConversationProcessParts.vue'
import ExtensionUiSurface from './components/ExtensionUiSurface.vue'
import { useAppStore } from './stores/app'
import { useExtensionUiStore } from './stores/extension-ui'

marked.use({ breaks: true, gfm: true })

const commandShortcutLabel = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'

const MARKDOWN_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed', 'img', 'picture', 'source',
    'audio', 'video', 'track', 'svg', 'math', 'form', 'input', 'textarea',
    'select', 'option', 'link', 'meta',
  ],
  FORBID_ATTR: ['style', 'srcset', 'ping'],
}

const app = useAppStore()
const extensionUi = useExtensionUiStore()
const draft = computed({ get: () => app.currentDraft, set: (value: string) => app.setCurrentDraft(value) })
const draftAttachments = computed({ get: () => app.currentAttachments, set: (value: AttachmentDto[]) => app.setCurrentAttachments(value) })
const detailMode = computed({ get: () => app.detailMode, set: (value: boolean) => app.setDetailMode(value) })
const directoryOpen = ref(false)
const commandOpen = ref(false)
const controlSection = ref<ControlSection>('commands')
const controlTitleOverride = ref('')
const controlBodyOverride = ref('')
const controlSizeOverride = ref<'default' | 'wide' | 'tree' | ''>('')
const confirmDialog = ref<{ title: string; body: string; resolve: (confirmed: boolean) => void } | null>(null)
const hostSettingsOpen = ref(false)
const addingHost = ref(false)
const output = ref<HTMLElement | null>(null)
const outputAwayFromBottom = ref(false)
const composerTextarea = ref<HTMLTextAreaElement | null>(null)
const composerExpanded = ref(false)
const workspace = ref<WorkspacePage | null>(null)
const workspacePath = ref('')
const workspaceSearch = ref('')
const workspaceLoading = ref(false)
const workspaceError = ref<string | null>(null)
const creatingWork = ref(false)
const trustContinuation = ref<CreateWorkContinuation | null>(null)
const reopenTrustContinuation = ref<CreateWorkContinuation | null>(null)
const realConversation = ref<ConversationItem[]>([])
type ConversationImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
type ImagePreview =
  | { kind: 'conversation'; imageKey: string; url: string; name: string }
  | { kind: 'attachment'; attachmentKey: string; url: string; name: string }
type AttachmentPreviewResource = { url: string; mediaType: string }
const imageResources = ref<Record<string, ConversationImageResource>>({})
const attachmentPreviews = ref<Record<string, AttachmentPreviewResource>>({})
const imagePreview = ref<ImagePreview | null>(null)
let imageDomainKey = ''
let imageLoadEpoch = 0
const conversationLoading = ref(false)
const conversationError = ref<string | null>(null)
const historyTruncated = ref(false)
const historyBeforeEntryId = ref<string | null>(null)
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
const submitting = ref(false)
const aborting = ref(false)
const queueOpen = ref(false)
const queueRestoring = ref(false)
const queueNotice = ref('')
const restoredImageCounts = ref<Record<string, number>>({})
const clearingRestoredImages = ref(false)
const attachmentPicking = ref(false)
type UploadDraft = SelectedAttachment & { state: 'hashing' | 'uploading' | 'finalizing' | 'error'; progress: number; error?: string }
const uploadDrafts = ref<UploadDraft[]>([])
const toolsExpandedMutating = ref(false)
const toolExpansionOverrides = ref<Record<string, boolean>>({})
const workMutating = ref(false)
const submissionError = ref<string | null>(null)
type MutationDomain = ControlMutationDomain | 'work'
type ControlCenterHandle = {
  reconcileDomain: (domain: ControlMutationDomain) => Promise<boolean>
  applyLiveEvent: (event: ProjectedEvent) => void
}
const unresolvedMutations = ref<Map<string, string>>(new Map())
const controlCenterRef = ref<ControlCenterHandle | null>(null)
const modalSurface = ref<HTMLElement | null>(null)
let modalTrigger: HTMLElement | null = null
const conversationState = ref<ConversationBootstrap | null>(null)
const followConnected = ref(false)
const activeFollowSubscription = ref('')
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
const rePairing = ref(false)
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
const unlisteners: UnlistenFn[] = []
let projectionFrame = 0
let outputScrollFrame = 0
let autoFollowOutput = true
let reconnectTimer = 0
let conversationLoadEpoch = 0
let historyLoadEpoch = 0
const followActivation = new FollowActivationCoordinator()
const followConnectionTimers = new Map<string, number>()
const pendingFollowEvents = new Map<string, ProjectedEvent[]>()

const previewConversation: ConversationItem[] = [
  { id: 'u1', kind: 'user', text: '请结合这份发布检查清单确认 Linux 客户端。', time: '19:38', attachments: [{ fileId: '45c6f7e8-9462-4fde-8ab9-1829dff71234', name: 'Linux 发布检查清单.pdf', sizeBytes: 248320, mediaType: 'application/pdf', sha256: 'a'.repeat(64), storedAt: '2026-08-17T08:00:00.000Z' }] },
  {
    id: 'a1',
    kind: 'assistant',
    groupId: 'preview-assistant-1',
    text: '已连接真实 Dock，并完成凭据事务化迁移。当前 Work 列表直接来自 Protocol V2；界面不会把浏览器预览数据冒充 Dock 数据。',
    time: '19:41',
  },
  { id: 't1', kind: 'thinking', groupId: 'preview-assistant-tools', title: '实现判断', text: '保持 Rust core 与 Tauri 解耦；WebView 只消费经过类型校验的状态。', open: true, groupTime: '19:41' },
  { id: 'tool1', kind: 'tool', groupId: 'preview-assistant-tools', name: 'instance.list', summary: '读取 Work catalog', status: 'done', detail: 'selector=all · revision-bound pagination' },
  {
    id: 'a2',
    kind: 'assistant',
    groupId: 'preview-assistant-2',
    text: '下一步把 conversation bootstrap/read/follow 接入同一个状态面。断线时会保留当前消息和草稿，只在 continuity 丢失时原子重建。',
    time: '19:42',
  },
]

const previewQueue: QueueItem[] = [{
  queueItemId: 'preview-queue-1',
  delivery: 'followUp',
  text: '请在确认桌面布局后，再检查窄屏 Queue 与附件操作。',
  attachments: [{ fileId: 'd729a77f-69f0-4f12-ac4c-2badf5750220', name: '窄屏验收清单.txt', sizeBytes: 1864, mediaType: 'text/plain', sha256: 'b'.repeat(64), storedAt: '2026-08-17T08:02:00.000Z' }],
  imageCount: 1,
  acceptedAt: '2026-08-17T08:02:00.000Z',
}]
const conversation = computed(() => (isTauri ? realConversation.value : previewConversation))
type GroupedProcessItem = ConversationProcessItem & { groupId: string }
type StandaloneRow = Extract<ConversationItem, { kind: 'user' | 'activity' | 'record' }> | Extract<ConversationProcessItem, { kind: 'notice' }>
type AssistantGroupRow = { id: string; kind: 'assistant-group'; parts: GroupedProcessItem[]; time: string }
type ConversationRow = StandaloneRow | AssistantGroupRow
function isGroupedProcessItem(item: ConversationItem): item is GroupedProcessItem {
  return item.kind !== 'user' && item.kind !== 'activity' && item.kind !== 'record' && Boolean(item.groupId)
}
const conversationRows = computed<ConversationRow[]>(() => {
  const rows: ConversationRow[] = []
  const groups = new Map<string, AssistantGroupRow>()
  for (const item of conversation.value) {
    if (isGroupedProcessItem(item)) {
      let group = groups.get(item.groupId)
      if (!group) {
        group = { id: item.groupId, kind: 'assistant-group', parts: [], time: '' }
        groups.set(item.groupId, group)
        rows.push(group)
      }
      group.parts.push(item)
      group.time ||= item.groupTime || (item.kind === 'assistant' ? item.time : '')
    } else {
      rows.push(item as StandaloneRow)
    }
  }
  return rows
})
const queueItems = computed(() => isTauri ? conversationState.value?.queue ?? [] : previewQueue)
const selected = computed(() => app.selectedWork)
function restoredImageKey(context: HostContext, workId: string) {
  return JSON.stringify([context.hostId, workId])
}
const restoredImageCount = computed({
  get: () => {
    const context = app.hostContext
    const workId = selected.value?.id
    return context && workId ? restoredImageCounts.value[restoredImageKey(context, workId)] ?? 0 : 0
  },
  set: (value: number) => {
    const context = app.hostContext
    const workId = selected.value?.id
    if (!context || !workId) return
    const key = restoredImageKey(context, workId)
    const next = { ...restoredImageCounts.value }
    if (value > 0) next[key] = value
    else delete next[key]
    restoredImageCounts.value = next
  },
})
const pairingInProgress = computed(() => !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage.value))
const hasRestoredImageDrafts = computed(() => Object.values(restoredImageCounts.value).some((count) => count > 0))
const contextTransitionBusy = computed(() => pairingInProgress.value
  || attachmentPicking.value
  || clearingRestoredImages.value
  || queueRestoring.value
  || submitting.value
  || aborting.value
  || uploadDrafts.value.some((item) => item.state !== 'error'))
const mutationOutcomeUnknown = computed(() => unresolvedDomain.value !== null)
const unresolvedDomain = computed<MutationDomain | null>(() => {
  const workId = selected.value?.id ?? 'global'
  for (const key of unresolvedMutations.value.keys()) {
    const [keyWorkId, domain] = JSON.parse(key) as [string, MutationDomain]
    if (keyWorkId === workId || keyWorkId === 'global') return domain
  }
  return null
})
const unresolvedControlDomain = computed<ControlMutationDomain | undefined>(() => {
  const domain = unresolvedDomain.value
  return domain && domain !== 'work' ? domain : undefined
})
const modalOpen = computed(() => directoryOpen.value || commandOpen.value || hostSettingsOpen.value || composerExpanded.value || !!confirmDialog.value || !!imagePreview.value)
const modelLabel = computed(() => {
  const model = selected.value?.executor.model
  return model ? `${model.provider}/${model.id}` : '—'
})
const contextPercent = computed(() => selected.value?.metrics?.context?.percent)
const recoverablePairings = computed(() => app.catalog?.pairingTransactions ?? [])
function hostContext() {
  const context = app.hostContext
  if (!context) throw new Error('当前没有选择 Host。')
  return { ...context }
}
async function currentHostCall<T>(operation: (context: HostContext) => Promise<T>): Promise<T> {
  const context = hostContext()
  const correlated = captureHostResult(context, await operation(context))
  if (!hostResultMatches(correlated, app.hostContext)) throw new Error('Host 选择已改变；旧结果已丢弃。')
  return correlated.result
}

const connectionLabel = computed(() => {
  if (!isTauri) return '浏览器预览'
  if (app.error) return '连接异常'
  if (app.loading) return '正在连接'
  if (app.payload && selected.value?.lifecycle === 'active') return followConnected.value ? '已连接' : '正在连接'
  return app.payload ? 'Dock 已连接' : '等待连接'
})

watch(draft, () => void nextTick(resizeComposer))
watch(composerExpanded, () => void nextTick(resizeComposer))
watch(detailMode, () => {
  if (conversationState.value) applyConversationProjection(conversationState.value)
})
watch(() => extensionUi.toolsResetRevision, () => { toolExpansionOverrides.value = {} })
watch(() => extensionUi.controller?.handle, (handle) => {
  if (!handle) restoreDocumentTitle()
})
watch(() => selected.value?.displayName, () => {
  if (!extensionUi.controller) restoreDocumentTitle()
})
watch(() => Boolean(app.payload && !app.needsPairing && !selected.value), (showList) => {
  if (showList) app.workDrawerOpen = true
})
watch(confirmDialog, async (dialog) => {
  if (!dialog) return
  await nextTick()
  modalSurface.value?.querySelector<HTMLElement>('[data-modal-initial]')?.focus()
})
watch(controlSection, async () => {
  if (!commandOpen.value) return
  await nextTick()
  const surface = modalSurface.value
  const initial = surface?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')
  if (initial) initial.focus()
  else surface?.focus()
})
watch(modalOpen, async (open, wasOpen) => {
  if (open && !wasOpen) {
    await nextTick()
    const surface = modalSurface.value
    const initial = surface?.querySelector<HTMLElement>('[data-modal-initial], [autofocus], input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')
    if (initial) initial.focus()
    else surface?.focus()
  } else if (!open && wasOpen) {
    await nextTick()
    modalTrigger?.focus()
    modalTrigger = null
  }
})
let transientContext: (HostContext & { workId: string }) | null = null
let transientHostBoundary: HostContext | null = null
watch(
  () => conversationBoundaryKey(app.activeHostId, app.hostContext?.selectionGeneration, selected.value?.id),
  () => {
    const hostId = app.activeHostId
    const generation = app.hostContext?.selectionGeneration
    const id = selected.value?.id
    const previous = transientContext
    const hostIdentityChanged = transientHostBoundary && transientHostBoundary.hostId !== hostId
    const contextChanged = previous && (previous.hostId !== hostId || previous.selectionGeneration !== generation || previous.workId !== id)
    if (contextChanged) {
      for (const item of uploadDrafts.value) void removeAttachment(previous.workId, item.token, previous).catch(() => undefined)
      uploadDrafts.value = []
      queueNotice.value = ''
      queueOpen.value = false
      resetConversationImages()
      resetAttachmentPreviews()
    }
    if (hostIdentityChanged) restoredImageCounts.value = {}
    transientHostBoundary = hostId && generation != null ? { hostId, selectionGeneration: generation } : null
    transientContext = hostId && generation != null && id ? { hostId, selectionGeneration: generation, workId: id } : null
    ++conversationLoadEpoch
    ++historyLoadEpoch
    if (isTauri && id) void loadSelectedConversation(id)
    else if (!id) void extensionUi.clear()
    void nextTick(resizeComposer)
  },
)

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalModalKeydown, true)
  window.addEventListener('keydown', handleDesktopShortcut)
  if (isTauri) {
    unlisteners.push(
      await listen<{ hostId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; event: ProjectedEvent }>('aludock://conversation-event', async ({ payload }) => {
        if (!app.contextMatches(payload) || payload.instanceId !== selected.value?.id) return
        const pending = pendingFollowEvents.get(payload.subscriptionId)
        if (pending) {
          pending.push(payload.event)
          return
        }
        if (payload.subscriptionId !== activeFollowSubscription.value) return
        await applyFollowEvent(payload)
      }),
      await listen<{ hostId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; state: FollowConnectionState; message?: string }>('aludock://follow-status', ({ payload }) => {
        if (!app.contextMatches(payload) || payload.instanceId !== selected.value?.id) return
        if (followActivation.handleStatus(payload.subscriptionId, payload)) {
          clearFollowConnectionTimer(payload.subscriptionId)
          return
        }
        handleActiveFollowStatus(payload)
      }),
      await listen<AttachmentUploadProgress>('aludock://attachment-progress', ({ payload }) => {
        if (!app.contextMatches(payload) || payload.workId !== selected.value?.id) return
        const item = uploadDrafts.value.find((candidate) => candidate.token === payload.token)
        if (!item) return
        item.state = payload.phase
        item.progress = payload.totalBytes > 0 ? payload.bytesProcessed / payload.totalBytes : payload.phase === 'finalizing' ? 1 : 0
      }),
      await listen<{ transactionId: string; stage: string; pin?: string; message?: string; error?: { message: string }; hostId?: string; registryRevision?: number; selectionGeneration?: number }>('aludock://pairing-status', ({ payload }) => {
        if (pairingTransactionId.value && payload.transactionId !== pairingTransactionId.value) return
        if (!pairingTransactionId.value) pairingTransactionId.value = payload.transactionId
        pairingStage.value = payload.stage
        if (payload.pin) pairingPin.value = payload.pin
        pairingMessage.value = payload.message ?? ''
        pairingError.value = payload.error?.message ?? ''
        if (payload.stage === 'completed' && payload.hostId && payload.registryRevision && payload.selectionGeneration) {
          hostSettingsOpen.value = false
          void extensionUi.clear()
          void app.load()
        }
      }),
    )
  }
  await app.load()
  await initializePairDeviceName()
  if (!app.needsPairing) app.workDrawerOpen = !app.selectedWork
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalModalKeydown, true)
  window.removeEventListener('keydown', handleDesktopShortcut)
  unlisteners.forEach((unlisten) => unlisten())
  window.clearTimeout(reconnectTimer)
  for (const timer of followConnectionTimers.values()) window.clearTimeout(timer)
  followConnectionTimers.clear()
  followActivation.cancelAll(new Error('界面已关闭。'))
  pendingFollowEvents.clear()
  if (projectionFrame) window.cancelAnimationFrame(projectionFrame)
  if (outputScrollFrame) window.cancelAnimationFrame(outputScrollFrame)
  resetConversationImages()
  resetAttachmentPreviews()
  void extensionUi.clear()
})

function inactiveState(work: Work) {
  if (work.lifecycle === 'host_lost') return { label: '连接已中断', message: '这个 Work 的运行进程已经离线。继续后会恢复同一个 Work。', action: '继续这个 Work' }
  if (work.lifecycle === 'runtime_error') return { label: '工作出现故障', message: '这个 Work 已停止运行，可以重新启动后继续。', action: '重新启动这个 Work' }
  if (work.lifecycle === 'stopping') return { label: '正在停止', message: 'Dock 正在结束这个 Work，请稍后刷新状态。', action: '' }
  if (work.lifecycle === 'stopped') return { label: 'Work 已停止', message: '这是一个已经结束的历史 Work。', action: '' }
  return { label: 'Work 当前不可用', message: '当前无法连接这个 Work。', action: '' }
}

function workState(work: Work) {
  if (work.lifecycle === 'host_lost') return '可继续'
  if (work.lifecycle === 'runtime_error') return '运行故障'
  if (work.lifecycle === 'stopped') return '已停止'
  if (work.execution === 'running') return '工作中'
  return '空闲'
}

function sidebarState(work: Work) {
  return ({ active: '运行中', stopping: '正在停止', stopped: '已停止', host_lost: '连接已中断', runtime_error: '工作出现故障' } as const)[work.lifecycle] ?? '状态已更新'
}

function workGroup(work: Work) {
  if (work.lifecycle === 'active' || work.lifecycle === 'stopping') return 'current'
  if (work.reopenable) return 'continue'
  return 'history'
}

const filteredWorkspaceEntries = computed(() => {
  const query = workspaceSearch.value.trim().toLowerCase()
  return (workspace.value?.entries ?? []).filter((entry) => !query || `${entry.name} ${entry.kind} ${entry.hidden ? '隐藏' : ''}`.toLowerCase().includes(query))
})

const groupedWorks = computed(() => ({
  current: app.works.filter((work) => workGroup(work) === 'current'),
  continue: app.works.filter((work) => workGroup(work) === 'continue'),
  history: app.works.filter((work) => workGroup(work) === 'history'),
}))

function selectWork(workId: string) {
  if (workId === selected.value?.id) {
    app.workDrawerOpen = false
    return
  }
  if (!contextTransitionBusy.value) app.selectWork(workId)
}

async function reopenFromList(work: Work) {
  if (contextTransitionBusy.value) return
  app.selectWork(work.id)
  await reopenSelectedWork()
}

async function forgetFromList(work: Work) {
  if (contextTransitionBusy.value) return
  app.selectWork(work.id)
  await forgetSelectedWork()
}

function askConfirm(title: string, body = ''): Promise<boolean> {
  return new Promise((resolve) => { confirmDialog.value = { title, body, resolve } })
}

function settleConfirm(confirmed: boolean) {
  const dialog = confirmDialog.value
  if (!dialog) return
  confirmDialog.value = null
  dialog.resolve(confirmed)
}

async function confirmRestoredImagesBeforeHostTransition() {
  return !hasRestoredImageDrafts.value || await askConfirm('切换 Host？', '切换会移除尚未发送的已取回附件。')
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
  if (!isTauri || contextTransitionBusy.value || !pairHost.value.trim() || !pairPort.value || pairPort.value < 1 || pairingStage.value === 'connecting') return
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
  if (!isTauri || contextTransitionBusy.value || !await confirmRestoredImagesBeforeHostTransition()) return
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
  if (!isTauri || contextTransitionBusy.value) return
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

function rememberModalTrigger() {
  if (!modalOpen.value && document.activeElement instanceof HTMLElement) modalTrigger = document.activeElement
}

function closeModal() {
  directoryOpen.value = false
  commandOpen.value = false
  hostSettingsOpen.value = false
  composerExpanded.value = false
  imagePreview.value = null
}

function handleGlobalModalKeydown(event: KeyboardEvent) {
  if (!modalOpen.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (confirmDialog.value) settleConfirm(false)
  else closeModal()
}

function handleDesktopShortcut(event: KeyboardEvent) {
  if (!isTauri || event.defaultPrevented || event.isComposing || event.repeat || modalOpen.value) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'k') {
    if (!selected.value) return
    event.preventDefault()
    openControlCenter('commands')
    return
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowUp') {
    if (!selected.value || selected.value.lifecycle !== 'active') return
    event.preventDefault()
    void restoreQueue()
  }
}

function handleModalWheel(event: WheelEvent) {
  const surface = modalSurface.value
  if (!surface || event.ctrlKey) return
  event.preventDefault()
  event.stopPropagation()
  const isScrollable = (element: HTMLElement) => {
    const overflow = window.getComputedStyle(element).overflowY
    return ['auto', 'scroll', 'overlay'].includes(overflow) && element.scrollHeight > element.clientHeight + 1
  }
  let scroller = event.target instanceof HTMLElement ? event.target : null
  while (scroller && scroller !== surface && !isScrollable(scroller)) scroller = scroller.parentElement
  if (!scroller || !surface.contains(scroller) || !isScrollable(scroller)) {
    scroller = [...surface.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.offsetParent !== null && isScrollable(element))
      .sort((left, right) => right.clientHeight - left.clientHeight)[0] ?? null
  }
  if (!scroller) return
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? scroller.clientHeight
      : 1
  scroller.scrollTop += event.deltaY * scale
}

function handleModalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModal()
    return
  }
  if (event.key !== 'Tab' || !modalSurface.value) return
  const focusable = [...modalSurface.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null)
  if (!focusable.length) {
    event.preventDefault()
    modalSurface.value.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function controlDialogTitle(section: ControlSection) {
  return ({
    commands: '命令中心', sessions: '恢复 Session', tree: 'Session Tree', 'new-session': 'New Session',
    'rename-session': '会话名称', 'compact-session': 'Compact Context', 'reload-session': 'Reload Session？',
    models: '选择 Model', thinking: 'Thinking Level', tools: 'Active Tools', resources: 'Project Status', settings: 'Settings',
  } as Record<ControlSection, string>)[section]
}

function controlDialogBody(section: ControlSection) {
  if (section === 'models') return `当前：${modelLabel.value}`
  if (section === 'resources') return '当前 Work、Session、Git 与已加载能力'
  if (section === 'tree') {
    return '浏览、切换或分叉当前会话树'
  }
  if (section === 'sessions') return '从当前目录保存的 Session 继续'
  return ''
}

function setControlDialogTitle(title: string, body = '') {
  controlTitleOverride.value = title
  controlBodyOverride.value = body
}

function controlDialogClasses(section: ControlSection) {
  const size = controlSizeOverride.value || (section === 'tree' ? 'tree' : ['sessions', 'models', 'tools', 'resources', 'settings'].includes(section) ? 'wide' : 'default')
  return ['ui-dialog-box', size === 'tree' ? 'ui-dialog-size-tree' : size === 'wide' ? 'ui-dialog-size-wide' : '']
}

function openControlCenter(section: ControlSection) {
  if (!selected.value) return
  rememberModalTrigger()
  controlTitleOverride.value = ''
  controlBodyOverride.value = ''
  controlSizeOverride.value = ''
  controlSection.value = section
  commandOpen.value = true
  directoryOpen.value = false
  hostSettingsOpen.value = false
  app.workDrawerOpen = false
}

function applyControlSnapshot(snapshot: Work) {
  app.applyWorkSnapshot(snapshot)
  extensionUi.applyAuthoritativeSnapshot(snapshot)
}

function openHostSettings() {
  rememberModalTrigger()
  hostSettingsOpen.value = true
  addingHost.value = false
  endpointFormOpen.value = false
  directoryOpen.value = false
  commandOpen.value = false
  app.workDrawerOpen = false
  endpointError.value = ''
  endpointCanSaveDraft.value = false
  hostNameError.value = ''
  hostNameSaved.value = false
  hostDisplayName.value = app.payload?.host.profile.displayName ?? app.activeHost?.displayName ?? ''
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

async function rePairActiveHost() {
  const host = app.activeHost
  if (!host || app.loading || rePairing.value || contextTransitionBusy.value) return
  const endpoint = host.profile.endpoints.find((candidate) =>
    candidate.state === 'verified' && candidate.id === host.profile.lastSuccessfulEndpointId,
  ) ?? host.profile.endpoints.find((candidate) => candidate.state === 'verified')
  if (!endpoint) {
    pairingError.value = '没有可用于重新配对的已保存地址。请打开 Host 设置检查连接地址。'
    return
  }

  rePairing.value = true
  try {
    pairDeviceName.value = resolveDeviceName(
      readDeviceNamePreference(deviceNameStorage),
      host.deviceName,
      pairDeviceName.value,
    )
    pairHost.value = endpoint.endpoint.host
    pairPort.value = endpoint.endpoint.port
    pairingStage.value = 'idle'
    pairingPin.value = ''
    pairingMessage.value = ''
    pairingError.value = ''
    await extensionUi.clear()
    await beginPairing(host.hostId)
  } finally {
    rePairing.value = false
  }
}

async function switchSavedHost(hostId: string) {
  if (!isTauri || hostId === app.activeHostId || contextTransitionBusy.value || !await confirmRestoredImagesBeforeHostTransition()) return
  await extensionUi.clear()
  closeModal()
  await app.switchHost(hostId)
}

async function removeSavedHost(hostId: string, displayName: string) {
  if (!isTauri || contextTransitionBusy.value) return
  const imageWarning = hasRestoredImageDrafts.value && hostId === app.activeHostId ? '\n\n已取回但尚未发送的附件也会从本机草稿中移除。' : ''
  const body = `这会删除此设备保存的配对凭据和连接地址。它不会在 Host 上撤销此设备的访问权限；如需撤销，请在电脑上的 AluDock 管理界面完成。以后从此设备连接需要重新配对。${imageWarning}`
  if (!await askConfirm(`从此设备删除“${displayName}”？`, body)) return
  await extensionUi.clear()
  await app.removeHost(hostId)
  if (!app.catalog?.hosts.length) closeModal()
}

async function saveHostDisplayName() {
  const displayName = hostDisplayName.value.trim()
  hostNameError.value = ''
  hostNameSaved.value = false
  if (!displayName) {
    hostNameError.value = 'Host 名称不能为空。'
    return
  }
  if (hostNameSaving.value || displayName === app.payload?.host.profile.displayName) return
  hostNameSaving.value = true
  try {
    const revision = activeProfile().revision
    const profile = await currentHostCall((context) => renameHostProfile(displayName, revision, context))
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
  app.applyHostProfile(profile, hostContext())
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
    const profile = await currentHostCall((context) => verifyHostEndpoint(
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
    const profile = await currentHostCall((context) => saveUnverifiedHostEndpoint(
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
    const revision = activeProfile().revision
    applyProfile(await currentHostCall((context) => setConnectionPolicy(mode, revision, context, endpointId)))
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
    const result = await currentHostCall((context) => testHostEndpoint(endpoint.id, revision, context))
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
    applyProfile(await currentHostCall((context) => setHostEndpointEnabled(endpoint.id, endpoint.state === 'disabled', revision, context)))
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
    applyProfile(await currentHostCall((context) => reorderHostEndpoints(ids, profile.revision, context)))
  } catch (cause) {
    endpointError.value = errorMessage(cause)
  } finally {
    endpointMutatingId.value = ''
  }
}

async function removeEndpoint(endpointId: string, label: string) {
  if (!await askConfirm(`删除连接地址“${label}”？`, '操作后仍须保留至少一个已启用、已验证的地址。')) return
  endpointError.value = ''
  try {
    const revision = activeProfile().revision
    applyProfile(await currentHostCall((context) => deleteHostEndpoint(endpointId, revision, context)))
  } catch (cause) {
    endpointError.value = errorMessage(cause)
  }
}

function endpointKindLabel(kind: ConnectionKind) {
  return kind === 'local' ? '局域网' : kind === 'remote' ? '广域网' : kind === 'vpn' ? 'VPN' : '手动地址'
}

function endpointStateLabel(endpoint: HostEndpoint) {
  if (endpoint.state === 'draft_unverified') return '待验证草稿 · 不会自动连接'
  if (endpoint.state === 'disabled') return '已停用 · 不会自动连接'
  return endpoint.id === app.payload?.host.activeEndpointId ? '启动时通过此地址连接' : '身份已验证'
}

function testStatusLabel(endpoint: HostEndpoint) {
  const test = endpoint.lastManualTest
  if (!test) return ''
  const timestamp = new Date(test.testedAt).toLocaleString()
  return `上次手动测试 ${timestamp} · ${test.reason}`
}

function setAttachmentPreview(key: string, resource: AttachmentPreviewResource) {
  const previous = attachmentPreviews.value[key]
  if (previous?.url && previous.url !== resource.url) URL.revokeObjectURL(previous.url)
  attachmentPreviews.value = { ...attachmentPreviews.value, [key]: resource }
}

function removeAttachmentPreview(key: string) {
  const resource = attachmentPreviews.value[key]
  if (!resource) return
  URL.revokeObjectURL(resource.url)
  const next = { ...attachmentPreviews.value }
  delete next[key]
  attachmentPreviews.value = next
  if (imagePreview.value?.kind === 'attachment' && imagePreview.value.attachmentKey === key) imagePreview.value = null
}

function moveAttachmentPreview(from: string, to: string) {
  const resource = attachmentPreviews.value[from]
  if (!resource || from === to) return
  const next = { ...attachmentPreviews.value }
  delete next[from]
  const replaced = next[to]
  if (replaced?.url !== resource.url) URL.revokeObjectURL(replaced.url)
  next[to] = resource
  attachmentPreviews.value = next
  if (imagePreview.value?.kind === 'attachment' && imagePreview.value.attachmentKey === from) {
    imagePreview.value = { ...imagePreview.value, attachmentKey: to }
  }
}

function resetAttachmentPreviews() {
  for (const resource of Object.values(attachmentPreviews.value)) URL.revokeObjectURL(resource.url)
  attachmentPreviews.value = {}
  if (imagePreview.value?.kind === 'attachment') imagePreview.value = null
}

function openAttachmentPreview(key: string, name: string) {
  const resource = attachmentPreviews.value[key]
  if (!resource) return
  rememberModalTrigger()
  imagePreview.value = {
    kind: 'attachment',
    attachmentKey: key,
    url: resource.url,
    name: name.replace(/[\\/]/g, '_'),
  }
}

function attachmentCanPreview(mediaType?: string) {
  return !!mediaType && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)
}

async function prepareAttachmentPreview(item: UploadDraft, workId: string, context: HostContext) {
  if (!attachmentCanPreview(item.mediaType) || attachmentPreviews.value[item.token]) return
  try {
    const bytes = await loadAttachmentPreviewBytes(workId, item.token, context)
    if (!app.contextMatches(context) || selected.value?.id !== workId || !uploadDrafts.value.some((candidate) => candidate.token === item.token)) return
    const detectedMediaType = detectedRasterMimeType(bytes)
    if (!detectedMediaType || detectedMediaType !== item.mediaType) return
    const blobBytes = new Uint8Array(bytes.byteLength)
    blobBytes.set(bytes)
    setAttachmentPreview(item.token, {
      mediaType: detectedMediaType,
      url: URL.createObjectURL(new Blob([blobBytes.buffer], { type: detectedMediaType })),
    })
  } catch {
    // A source may still be uploaded as an ordinary file when local raster preview is unavailable.
  }
}

async function startAttachmentUploadWithPreview(item: UploadDraft, workId: string, context: HostContext) {
  await prepareAttachmentPreview(item, workId, context)
  if (!app.contextMatches(context) || selected.value?.id !== workId || !uploadDrafts.value.some((candidate) => candidate.token === item.token)) return
  await startAttachmentUpload(item)
}

async function handleComposerPaste(event: ClipboardEvent) {
  if (!isTauri) return
  const images = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (!images.length) return
  event.preventDefault()
  const work = selected.value
  if (!work || work.lifecycle !== 'active' || pairingInProgress.value || attachmentPicking.value) {
    submissionError.value = '当前暂时不能添加剪贴板图片，请稍后重试。'
    return
  }
  const available = 32 - draftAttachments.value.length - uploadDrafts.value.length
  if (images.length > available) {
    submissionError.value = available > 0 ? `本条消息还可以添加 ${available} 个附件。` : '一条消息最多可附加 32 个文件。'
    return
  }
  const context = hostContext()
  const staged: UploadDraft[] = []
  attachmentPicking.value = true
  submissionError.value = null
  try {
    for (const [index, file] of images.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const mediaType = detectedRasterMimeType(bytes)
      if (!mediaType) throw new Error('剪贴板图片不是可用的 PNG、JPEG、GIF 或 WebP 格式。')
      const selectedAttachment = await stageClipboardImage(work.id, bytes, index + 1, context)
      const draftItem: UploadDraft = { ...selectedAttachment, state: 'hashing', progress: 0 }
      staged.push(draftItem)
      if (!app.contextMatches(context) || selected.value?.id !== work.id) throw new Error('stale_attachment_context')
      if (selectedAttachment.mediaType !== mediaType) throw new Error('剪贴板图片格式校验失败，请重新复制。')
      const blobBytes = new Uint8Array(bytes.byteLength)
      blobBytes.set(bytes)
      setAttachmentPreview(draftItem.token, {
        mediaType,
        url: URL.createObjectURL(new Blob([blobBytes.buffer], { type: mediaType })),
      })
    }
    uploadDrafts.value.push(...staged)
    for (const item of staged) void startAttachmentUpload(item)
  } catch (cause) {
    for (const item of staged) {
      removeAttachmentPreview(item.token)
      void removeAttachment(work.id, item.token, context).catch(() => undefined)
    }
    if (app.contextMatches(context) && selected.value?.id === work.id) submissionError.value = errorMessage(cause)
  } finally {
    attachmentPicking.value = false
  }
}

async function chooseAttachments() {
  const work = selected.value
  if (!work || !isTauri || work.lifecycle !== 'active' || pairingInProgress.value || attachmentPicking.value) return
  const available = 32 - draftAttachments.value.length - uploadDrafts.value.length
  if (available <= 0) {
    submissionError.value = draftAttachments.value.length > 32
      ? 'Queue 取回的附件需要分批发送，发完一批后才能继续添加。'
      : '一条消息最多可附加 32 个文件。'
    return
  }
  submissionError.value = null
  attachmentPicking.value = true
  try {
    const context = hostContext()
    const picked = await pickAttachments(work.id, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id) {
      for (const item of picked) void removeAttachment(work.id, item.token, context).catch(() => undefined)
      return
    }
    if (picked.length > available) {
      for (const item of picked) void removeAttachment(work.id, item.token, context).catch(() => undefined)
      submissionError.value = '所选文件超过本条消息可用的附件数量。'
      return
    }
    const drafts = picked.map<UploadDraft>((item) => ({ ...item, state: 'hashing', progress: 0 }))
    uploadDrafts.value.push(...drafts)
    for (const item of drafts) void startAttachmentUploadWithPreview(item, work.id, context)
  } catch (cause) {
    submissionError.value = errorMessage(cause)
  } finally {
    attachmentPicking.value = false
  }
}

async function startAttachmentUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  const context = hostContext()
  item.state = 'hashing'
  item.progress = 0
  item.error = undefined
  try {
    const result = await uploadAttachment(work.id, item.token, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id) return
    moveAttachmentPreview(item.token, result.attachment.fileId)
    uploadDrafts.value = uploadDrafts.value.filter((candidate) => candidate.token !== item.token)
    if (!draftAttachments.value.some((candidate) => candidate.fileId === result.attachment.fileId)) {
      draftAttachments.value = [...draftAttachments.value, result.attachment]
    }
  } catch (cause) {
    if (!app.contextMatches(context) || selected.value?.id !== work.id) return
    item.state = 'error'
    item.error = errorMessage(cause)
  }
}

async function cancelUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  try { await cancelAttachmentUpload(work.id, item.token, hostContext()) } catch { /* completion will report its final state */ }
}

async function removeUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  uploadDrafts.value = uploadDrafts.value.filter((candidate) => candidate.token !== item.token)
  removeAttachmentPreview(item.token)
  try { await removeAttachment(work.id, item.token, hostContext()) } catch { /* already cleared by a context change */ }
}

function removeUploaded(fileId: string) {
  draftAttachments.value = draftAttachments.value.filter((item) => item.fileId !== fileId)
  removeAttachmentPreview(fileId)
}

async function clearQueueImages() {
  const work = selected.value
  if (!work || pairingInProgress.value || clearingRestoredImages.value || submitting.value || queueRestoring.value) return
  const context = hostContext()
  clearingRestoredImages.value = true
  try {
    await clearRestoredImages(work.id, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id) return
    restoredImageCount.value = 0
  } catch (cause) {
    if (app.contextMatches(context) && selected.value?.id === work.id) submissionError.value = errorMessage(cause)
  } finally {
    clearingRestoredImages.value = false
  }
}

async function restoreQueue(): Promise<boolean> {
  const work = selected.value
  if (!work || pairingInProgress.value || attachmentPicking.value || clearingRestoredImages.value || queueRestoring.value || submitting.value) return false
  queueRestoring.value = true
  submissionError.value = null
  queueNotice.value = ''
  try {
    const context = hostContext()
    const result = await dequeueMessages(work.id, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id || result.receipt.instanceId !== work.id || result.instance.id !== work.id) return false
    const restored = appendRestoredQueue(draft.value, draftAttachments.value, result.receipt.restored, result.receipt.inFlight)
    draft.value = restored.text
    draftAttachments.value = restored.attachments
    restoredImageCount.value += restored.restoredImageCount
    app.applyWorkSnapshot(result.instance, context)
    if (conversationState.value?.instance.id === work.id) {
      conversationState.value.instance = result.instance
      conversationState.value.queue = []
    }
    queueOpen.value = false
    if (restored.inFlightCount) {
      queueNotice.value = `${restored.inFlightCount} 条消息可能已经开始执行，没有放回编辑器。请先查看对话，避免重复发送。`
      return false
    }
    const batches = Math.ceil(draftAttachments.value.length / 32)
    queueNotice.value = result.receipt.restored.length
      ? `已取回 ${result.receipt.restored.length} 条消息。${batches > 1 ? ` 附件将分 ${batches} 批发送。` : ''}`
      : 'Queue 中没有可取回的消息。'
    return true
  } catch (cause) {
    markUnknownOutcome(cause, 'conversation', work.id)
    submissionError.value = errorMessage(cause)
    return false
  } finally {
    queueRestoring.value = false
  }
}

async function submit(): Promise<boolean> {
  const work = selected.value
  const captured = draft.value
  const capturedAttachments = draftAttachments.value.slice(0, 32).map((item) => ({ ...item }))
  if (!work || (!captured.trim() && !capturedAttachments.length && !restoredImageCount.value) || !isTauri || pairingInProgress.value || clearingRestoredImages.value || submitting.value || queueRestoring.value || attachmentPicking.value || uploadDrafts.value.length > 0) return false
  submitting.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    const result = await submitMessage(work.id, captured, capturedAttachments.map((item) => item.fileId), capturedHost)
    if (!app.contextMatches(capturedHost)) return false
    app.applyWorkSnapshot(result.instance, capturedHost)
    draft.value = draftAfterSubmit(draft.value, captured, true)
    draftAttachments.value = attachmentsAfterSubmit(draftAttachments.value, capturedAttachments.map((item) => item.fileId), true)
    restoredImageCount.value = 0
    if (!result.receipt.queued) showAgentActivity(work.id)
    if (draftAttachments.value.length) queueNotice.value = `已发送一批附件；还有 ${draftAttachments.value.length} 个保留在编辑器中。`
    if (!followConnected.value) void loadSelectedConversation(work.id, true)
    await nextTick()
    scrollOutputToBottom(true)
    return true
  } catch (cause) {
    markUnknownOutcome(cause, 'conversation', work.id)
    submissionError.value = '消息没有发送，内容已保留。请检查连接后重试。'
    return false
  } finally {
    submitting.value = false
  }
}

async function submitExpanded() {
  if (await submit()) composerExpanded.value = false
}

async function abortCurrentRun() {
  const work = selected.value
  if (!work || work.execution !== 'running' || aborting.value) return
  if (work.pending.total > 0 && !await restoreQueue()) return
  aborting.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    const snapshot = await abortRun(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    app.applyWorkSnapshot(snapshot, capturedHost)
    await app.load()
    await loadSelectedConversation(work.id)
  } catch (cause) {
    markUnknownOutcome(cause, 'conversation', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    aborting.value = false
  }
}

async function stopSelectedWork() {
  const work = selected.value
  if (!isTauri || contextTransitionBusy.value || !stopCanStart(work, workMutating.value, mutationOutcomeUnknown.value) || !work) return
  if (!await askConfirm('停止当前工作？')) return
  workMutating.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    const result = await stopWork(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    if (!stoppedResultIsCorrelated(result, work.id)) throw { outcomeUnknown: true, message: '停止结果没有证明对应 Work 已停止。' }
    app.applyWorkSnapshot(result.instance, capturedHost)
    if (conversationState.value?.instance.id === work.id) {
      conversationState.value.instance = result.instance
      conversationState.value.queue = []
    }
    followConnected.value = false
    activeFollowSubscription.value = ''
    await extensionUi.clear()
    const cleanupErrors = result.receipt.cleanupErrors ?? []
    submissionError.value = cleanupErrors.length
      ? 'Work 已停止，但部分清理工作没有完成。刷新后可以确认当前状态。'
      : null
  } catch (cause) {
    markUnknownOutcome(cause, 'work', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    workMutating.value = false
  }
}

async function reopenSelectedWork(continuation?: CreateWorkContinuation) {
  const work = selected.value
  if (!isTauri || contextTransitionBusy.value || !work || !work.reopenable || workMutating.value) return
  workMutating.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    const snapshot = await reopenWork(work.id, capturedHost, continuation)
    if (!app.contextMatches(capturedHost)) return
    app.applyWorkSnapshot(snapshot, capturedHost)
    reopenTrustContinuation.value = null
    await app.load()
    await loadSelectedConversation(work.id)
  } catch (cause) {
    const failure = cause as { code?: string; message?: string; details?: Record<string, unknown>; operationId?: string }
    if (failure?.code === 'project_trust_required') {
      const operationId = String(failure.details?.operationId || failure.operationId || '')
      const trustChallengeId = String(failure.details?.challengeId || '')
      if (operationId && trustChallengeId) {
        reopenTrustContinuation.value = { operationId, trustChallengeId, projectTrustDecision: 'trust_once' }
      } else submissionError.value = 'Dock 请求确认项目信任，但没有返回完整的确认信息。'
    } else {
      markUnknownOutcome(cause, 'work', work.id)
      submissionError.value = errorMessage(cause)
    }
  } finally {
    workMutating.value = false
  }
}

async function forgetSelectedWork() {
  const work = selected.value
  if (!isTauri || contextTransitionBusy.value || !work || !['stopped', 'host_lost', 'runtime_error'].includes(work.lifecycle) || workMutating.value) return
  if (!await askConfirm('从列表移除这条历史记录？')) return
  workMutating.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    await forgetWork(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    await app.load()
  } catch (cause) {
    markUnknownOutcome(cause, 'work', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    workMutating.value = false
  }
}

function showAgentActivity(workId: string) {
  if (realConversation.value.some((item) => item.kind === 'activity')) return
  realConversation.value = [...realConversation.value, { id: `local-activity-${workId}`, kind: 'activity' }]
  scrollOutputToBottom(true)
}

function handleOutputScroll() {
  const surface = output.value
  if (!surface) return
  autoFollowOutput = outputIsNearBottom(surface.scrollHeight, surface.scrollTop, surface.clientHeight)
  outputAwayFromBottom.value = !autoFollowOutput
}

function handleOutputMediaLoad(event: Event) {
  if (event.target instanceof HTMLImageElement) scrollOutputToBottom()
}

const idleImageResource: ConversationImageResource = { state: 'idle' }

function imageResource(part: ConversationImagePart): ConversationImageResource {
  return imageResources.value[part.imageKey] ?? idleImageResource
}

function setImageResource(imageKey: string, resource: ConversationImageResource) {
  const previous = imageResources.value[imageKey]
  if (previous?.url && previous.url !== resource.url) URL.revokeObjectURL(previous.url)
  imageResources.value = { ...imageResources.value, [imageKey]: resource }
}

function resetConversationImages() {
  imageLoadEpoch += 1
  for (const resource of Object.values(imageResources.value)) {
    if (resource.url) URL.revokeObjectURL(resource.url)
  }
  imageResources.value = {}
  if (imagePreview.value?.kind === 'conversation') imagePreview.value = null
  imageDomainKey = ''
}

function syncImageDomain(context: HostContext, workId: string, hostEpoch: string, runtimeGeneration: number) {
  const next = JSON.stringify([context.hostId, context.selectionGeneration, workId, hostEpoch, runtimeGeneration])
  if (imageDomainKey && imageDomainKey !== next) resetConversationImages()
  imageDomainKey = next
}

function pruneImageResources(items: ConversationItem[]) {
  const active = new Set<string>()
  for (const item of items) {
    if (item.kind === 'image') active.add(item.imageKey)
    else if (item.kind === 'record') {
      for (const part of item.parts) if (part.kind === 'image') active.add(part.imageKey)
    }
  }
  const next = { ...imageResources.value }
  let changed = false
  for (const [key, resource] of Object.entries(next)) {
    if (active.has(key)) continue
    if (resource.url) URL.revokeObjectURL(resource.url)
    delete next[key]
    changed = true
    if (imagePreview.value?.kind === 'conversation' && imagePreview.value.imageKey === key) imagePreview.value = null
  }
  if (changed) imageResources.value = next
}

function applyConversationProjection(state: ConversationBootstrap) {
  const projected = projectConversation(state, { compact: !detailMode.value })
  realConversation.value = projected
  pruneImageResources(projected)
}

function conversationHasImage(imageKey: string) {
  return realConversation.value.some((item) => item.kind === 'image'
    ? item.imageKey === imageKey
    : item.kind === 'record' && item.parts.some((part) => part.kind === 'image' && part.imageKey === imageKey))
}

async function requestConversationImage(part: ConversationImagePart) {
  const source = part.source
  const state = conversationState.value
  const work = selected.value
  if (!source || !state || !work || imageResource(part).state === 'loading' || imageResource(part).state === 'ready') return
  const capturedHost = hostContext()
  const expectedEpoch = state.cursor.hostEpoch
  const expectedGeneration = state.cursor.runtimeGeneration
  const loadEpoch = imageLoadEpoch
  setImageResource(part.imageKey, { state: 'loading' })
  try {
    let bytes: Uint8Array
    let mediaType = part.mimeType
    if (source.type === 'conversation') {
      bytes = await loadConversationImageBytes(work.id, expectedEpoch, expectedGeneration, source.contentRef, source.mimeType, capturedHost)
      mediaType = source.mimeType
    } else if (source.type === 'published') {
      bytes = await loadPublishedImageBytes(work.id, expectedEpoch, expectedGeneration, source.file, capturedHost)
      mediaType = source.file.mediaType || ''
    } else {
      bytes = decodeInlineImage(source.data, source.mimeType)
      mediaType = source.mimeType
    }
    if (loadEpoch !== imageLoadEpoch
      || !app.contextMatches(capturedHost)
      || selected.value?.id !== work.id
      || conversationState.value?.cursor.hostEpoch !== expectedEpoch
      || conversationState.value?.cursor.runtimeGeneration !== expectedGeneration
      || !conversationHasImage(part.imageKey)) return
    const detectedMediaType = detectedRasterMimeType(bytes)
    if (!detectedMediaType || (mediaType && mediaType !== detectedMediaType)) throw new Error('图片数据格式无效。')
    mediaType = detectedMediaType
    const blobBytes = new Uint8Array(bytes.byteLength)
    blobBytes.set(bytes)
    const url = URL.createObjectURL(new Blob([blobBytes.buffer], { type: mediaType }))
    setImageResource(part.imageKey, { state: 'ready', url })
  } catch (cause) {
    if (loadEpoch !== imageLoadEpoch || !app.contextMatches(capturedHost) || selected.value?.id !== work.id || !conversationHasImage(part.imageKey)) return
    setImageResource(part.imageKey, { state: 'error', message: imageLoadMessage(cause) })
  }
}

function decodeInlineImage(data: string, mimeType: string): Uint8Array {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)
    || data.length > Math.ceil((20 * 1024 * 1024) / 3) * 4
    || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('图片数据格式无效。')
  let decoded = ''
  try { decoded = window.atob(data) } catch { throw new Error('图片数据格式无效。') }
  if (window.btoa(decoded) !== data) throw new Error('图片数据格式无效。')
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  if (detectedRasterMimeType(bytes) !== mimeType) throw new Error('图片数据格式无效。')
  return bytes
}

function detectedRasterMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.length >= 6 ? String.fromCharCode(...bytes.subarray(0, 6)) : ''
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return ''
}

function markConversationImageFailed(part: ConversationImagePart) {
  if (imageResource(part).state !== 'ready') return
  setImageResource(part.imageKey, { state: 'error', message: '图片内容无法解码，请重新读取。' })
  if (imagePreview.value?.kind === 'conversation' && imagePreview.value.imageKey === part.imageKey) imagePreview.value = null
}

function markPreviewImageFailed() {
  const preview = imagePreview.value
  if (!preview) return
  if (preview.kind === 'conversation') {
    const resource = imageResources.value[preview.imageKey]
    if (resource?.state === 'ready') setImageResource(preview.imageKey, { state: 'error', message: '图片内容无法解码，请重新读取。' })
  } else {
    removeAttachmentPreview(preview.attachmentKey)
    submissionError.value = '这个图片附件无法预览，原附件仍保持不变。'
  }
  imagePreview.value = null
}

function imageLoadMessage(cause: unknown) {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
  if (code === 'file_unavailable') return '图片已经失效，请让阿露重新发布。'
  if (code === 'image_too_large') return '图片过大，当前设备无法安全预览。'
  if (code === 'unsupported_image') return '图片格式无法安全显示。'
  return errorMessage(cause, '图片暂时无法读取，请稍后重试。')
}

function openImagePreview(part: ConversationImagePart) {
  const resource = imageResource(part)
  if (resource.state !== 'ready' || !resource.url) return
  rememberModalTrigger()
  imagePreview.value = {
    kind: 'conversation',
    imageKey: part.imageKey,
    url: resource.url,
    name: (part.name || 'aludock-image').replace(/[\\/]/g, '_'),
  }
}

function scrollOutputToBottom(force = false) {
  if (!force && !autoFollowOutput) return
  if (outputScrollFrame) return
  outputScrollFrame = window.requestAnimationFrame(() => {
    outputScrollFrame = 0
    const surface = output.value
    if (!surface) return
    surface.scrollTop = surface.scrollHeight
    autoFollowOutput = true
    outputAwayFromBottom.value = false
  })
}

function scheduleConversationProjection() {
  if (projectionFrame) return
  projectionFrame = window.requestAnimationFrame(() => {
    projectionFrame = 0
    if (conversationState.value) {
      applyConversationProjection(conversationState.value)
      scrollOutputToBottom()
    }
  })
}

async function applyFollowEvent(payload: { hostId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; event: ProjectedEvent }) {
  const state = conversationState.value
  if (!state || payload.subscriptionId !== activeFollowSubscription.value) return
  const reduced = reduceLiveEvent({
    hostId: payload.hostId,
    selectionGeneration: payload.selectionGeneration,
    hostEpoch: state.cursor.hostEpoch,
    instance: state.instance,
    queue: state.queue,
    sequence: state.cursor.sequence,
  }, payload)
  if (reduced.kind === 'ignored') return
  if (reduced.kind === 'rebuild') {
    followConnected.value = false
    void loadSelectedConversation(payload.instanceId, true)
    return
  }
  state.instance = reduced.state.instance
  state.queue = reduced.state.queue
  state.cursor.sequence = reduced.state.sequence
  app.applyWorkSnapshot(state.instance, payload)
  if (reduced.configChanged) controlCenterRef.value?.applyLiveEvent(payload.event)
  if (!await extensionUi.applyLive(payload.instanceId, payload.subscriptionId, payload.event)) {
    followConnected.value = false
    void loadSelectedConversation(payload.instanceId, true)
    return
  }
  state.activeEvents.push(payload.event)
  if (reduced.conversationChanged || payload.event.eventType === 'run.started') scheduleConversationProjection()
}

function handleActiveFollowStatus(payload: {
  instanceId: string
  subscriptionId: string
  state: FollowConnectionState
  message?: string
}) {
  if (payload.subscriptionId !== activeFollowSubscription.value) return
  followConnected.value = payload.state === 'connected'
  if (payload.message) conversationError.value = payload.message
  if (payload.state === 'resync_required') {
    void loadSelectedConversation(payload.instanceId, true)
  } else if (payload.state === 'disconnected') {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      if (selected.value?.id === payload.instanceId && payload.subscriptionId === activeFollowSubscription.value) void loadSelectedConversation(payload.instanceId, true)
    }, 1500)
  }
}

function waitForFollowConnection(subscriptionId: string): Promise<void> {
  const connected = followActivation.prepare(subscriptionId)
  followConnectionTimers.set(subscriptionId, window.setTimeout(() => {
    followActivation.cancel(subscriptionId, new Error('连接确认超时。'))
  }, 10_000))
  void connected.then(
    () => clearFollowConnectionTimer(subscriptionId),
    () => clearFollowConnectionTimer(subscriptionId),
  )
  return connected
}

function clearFollowConnectionTimer(subscriptionId: string) {
  const timer = followConnectionTimers.get(subscriptionId)
  if (timer !== undefined) window.clearTimeout(timer)
  followConnectionTimers.delete(subscriptionId)
}

async function loadSelectedConversation(instanceId: string, preserveUntilSwap = false): Promise<boolean> {
  const epoch = ++conversationLoadEpoch
  ++historyLoadEpoch
  const work = app.works.find((item) => item.id === instanceId)
  if (!preserveUntilSwap) {
    realConversation.value = []
    conversationState.value = null
    if (!await extensionUi.clear()) return false
    if (epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
  }
  conversationError.value = null
  historyError.value = null
  if (preserveUntilSwap) followConnected.value = false
  if (!work || work.lifecycle !== 'active') return false
  conversationLoading.value = true
  let subscriptionId = ''
  try {
    const capturedHost = hostContext()
    const bootstrap = await loadConversation(instanceId, capturedHost)
    if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
    if (!conversationSwapIsCorrelated(capturedHost, instanceId, bootstrap, true)) throw new Error('对话状态已经变化，请重新载入。')
    if (app.payload?.host.hostEpoch !== bootstrap.cursor.hostEpoch) throw new Error('这项工作的状态已经变化，请重新载入。')

    subscriptionId = crypto.randomUUID()
    pendingFollowEvents.set(subscriptionId, [])
    const connected = waitForFollowConnection(subscriptionId)
    await startConversationFollow(instanceId, subscriptionId, bootstrap.cursor, capturedHost)
    await connected
    if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
    if (!await extensionUi.bootstrap(capturedHost, subscriptionId, bootstrap)) return false
    if (!conversationSwapIsCorrelated(capturedHost, instanceId, bootstrap, true)) return false

    const bufferedFollowStatus: FollowConnectionStatus | undefined = followActivation.activate(subscriptionId)
    app.applyWorkSnapshot(bootstrap.instance, capturedHost)
    syncImageDomain(capturedHost, instanceId, bootstrap.cursor.hostEpoch, bootstrap.cursor.runtimeGeneration)
    conversationState.value = bootstrap
    applyConversationProjection(bootstrap)
    scrollOutputToBottom(true)
    historyTruncated.value = bootstrap.historyTruncated
    historyBeforeEntryId.value = bootstrap.historyBeforeEntryId ?? null
    historyError.value = null
    activeFollowSubscription.value = subscriptionId
    followConnected.value = true
    conversationError.value = null
    if (bufferedFollowStatus) handleActiveFollowStatus({ instanceId, subscriptionId, ...bufferedFollowStatus })
    const buffered = pendingFollowEvents.get(subscriptionId) ?? []
    pendingFollowEvents.delete(subscriptionId)
    for (const event of buffered) {
      await applyFollowEvent({ ...capturedHost, instanceId, subscriptionId, event })
      if (activeFollowSubscription.value !== subscriptionId) break
    }
    return true
  } catch (cause) {
    if (epoch === conversationLoadEpoch && selected.value?.id === instanceId) conversationError.value = errorMessage(cause)
    return false
  } finally {
    if (subscriptionId) {
      clearFollowConnectionTimer(subscriptionId)
      followActivation.cancel(subscriptionId, new Error('连接载入已结束。'))
      pendingFollowEvents.delete(subscriptionId)
    }
    if (epoch === conversationLoadEpoch && selected.value?.id === instanceId) conversationLoading.value = false
  }
}

async function refreshCurrent() {
  const workId = selected.value?.id
  await app.load()
  if (workId && selected.value?.id === workId && selected.value.lifecycle === 'active') {
    await loadSelectedConversation(workId, true)
  }
}

async function reconcileExtensionInteraction(): Promise<boolean> {
  const work = selected.value
  if (!work) return false
  return loadSelectedConversation(work.id, true)
}

async function loadEarlierHistory() {
  const state = conversationState.value
  const beforeEntryId = historyBeforeEntryId.value
  const work = selected.value
  const surface = output.value
  if (!state || !beforeEntryId || !work || historyLoading.value) return
  const epoch = ++historyLoadEpoch
  const loadEpoch = conversationLoadEpoch
  const beforeHeight = surface?.scrollHeight ?? 0
  const beforeTop = surface?.scrollTop ?? 0
  const surfaceTop = surface?.getBoundingClientRect().top ?? 0
  const anchor = surface ? [...surface.querySelectorAll<HTMLElement>('[data-conversation-id]')].find((element) => element.getBoundingClientRect().bottom >= surfaceTop) : undefined
  const anchorId = anchor?.dataset.conversationId
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - surfaceTop : null
  historyLoading.value = true
  historyError.value = null
  try {
    const capturedHost = hostContext()
    const page = await loadConversationHistory(
      work.id,
      beforeEntryId,
      state.cursor.hostEpoch,
      state.cursor.runtimeGeneration,
      state.historyRevision,
      capturedHost,
    )
    if (!app.contextMatches(capturedHost)) return
    if (epoch !== historyLoadEpoch || loadEpoch !== conversationLoadEpoch || selected.value?.id !== work.id || conversationState.value !== state) return
    if (page.hostEpoch !== state.cursor.hostEpoch
      || page.instance.id !== state.instance.id
      || page.instance.runtimeGeneration !== state.cursor.runtimeGeneration
      || page.historyRevision !== state.historyRevision) {
      void loadSelectedConversation(work.id, true)
      return
    }
    const existing = new Set(state.records.map((record) => record.entryId))
    if (page.records.some((record) => existing.has(record.entryId))) {
      void loadSelectedConversation(work.id, true)
      return
    }
    state.records = [...page.records, ...state.records]
    historyBeforeEntryId.value = page.nextBeforeEntryId ?? null
    historyTruncated.value = page.hasEarlier
    applyConversationProjection(state)
    await nextTick()
    if (surface) {
      const nextAnchor = anchorId ? [...surface.querySelectorAll<HTMLElement>('[data-conversation-id]')].find((element) => element.dataset.conversationId === anchorId) : undefined
      if (nextAnchor && anchorOffset != null) surface.scrollTop += (nextAnchor.getBoundingClientRect().top - surface.getBoundingClientRect().top) - anchorOffset
      else surface.scrollTop = beforeTop + (surface.scrollHeight - beforeHeight)
    }
  } catch (cause) {
    if (epoch === historyLoadEpoch) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      if (code === 'protocol_error') void loadSelectedConversation(work.id, true)
      else historyError.value = '更早的记录暂时没有载入，请稍后重试。'
    }
  } finally {
    if (epoch === historyLoadEpoch) historyLoading.value = false
  }
}

async function resyncSession(snapshot: Work, returnedDraft?: string) {
  app.applyWorkSnapshot(snapshot)
  if (returnedDraft) draft.value = draft.value ? `${draft.value}\n${returnedDraft}` : returnedDraft
  const reconciled = await loadSelectedConversation(snapshot.id, true)
  if (reconciled) await app.load()
}

async function openDirectory() {
  if (contextTransitionBusy.value) return
  rememberModalTrigger()
  directoryOpen.value = true
  commandOpen.value = false
  trustContinuation.value = null
  const initial = selected.value?.cwd || '/'
  await browse(initial)
}

async function browse(path: string) {
  workspaceLoading.value = true
  workspaceSearch.value = ''
  workspaceError.value = null
  try {
    workspace.value = await currentHostCall((context) => listWorkspace(path, context))
    workspacePath.value = workspace.value.path
  } catch (cause) {
    workspaceError.value = errorMessage(cause)
  } finally {
    workspaceLoading.value = false
  }
}

async function createSelectedWork(continuation?: CreateWorkContinuation) {
  if (!isTauri || contextTransitionBusy.value || !workspace.value || creatingWork.value) return
  creatingWork.value = true
  workspaceError.value = null
  try {
    const capturedHost = hostContext()
    const work = await createWork(workspace.value.path, capturedHost, undefined, continuation)
    if (!app.contextMatches(capturedHost)) return
    await app.load()
    app.selectWork(work.id)
    directoryOpen.value = false
    trustContinuation.value = null
  } catch (cause) {
    const failure = cause as { code?: string; message?: string; details?: Record<string, unknown>; operationId?: string }
    if (failure?.code === 'project_trust_required') {
      const operationId = String(failure.details?.operationId || failure.operationId || '')
      const trustChallengeId = String(failure.details?.challengeId || '')
      if (operationId && trustChallengeId) {
        trustContinuation.value = {
          operationId,
          trustChallengeId,
          projectTrustDecision: 'trust_once',
        }
      } else {
        workspaceError.value = 'Dock 请求确认项目信任，但没有返回完整的确认信息。'
      }
    } else {
      markUnknownOutcome(cause, 'work', 'global')
      workspaceError.value = errorMessage(cause)
    }
  } finally {
    creatingWork.value = false
  }
}

function continueWithTrust(decision: CreateWorkContinuation['projectTrustDecision']) {
  if (!trustContinuation.value) return
  return createSelectedWork({ ...trustContinuation.value, projectTrustDecision: decision })
}

function mutationKey(workId: string, domain: MutationDomain) {
  return JSON.stringify([workId, domain])
}

function markUnknownOutcome(cause: unknown, domain: MutationDomain = 'work', workId = selected.value?.id ?? 'global') {
  if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) {
    const operationId = 'operationId' in cause ? String(cause.operationId ?? '') : ''
    unresolvedMutations.value = new Map(unresolvedMutations.value).set(mutationKey(workId, domain), operationId)
  }
}

function markControlUnknown(cause: unknown, domain: ControlMutationDomain) {
  markUnknownOutcome(cause, domain, selected.value?.id ?? 'global')
}

async function reconcileMutationOutcome(requestedDomain?: MutationDomain) {
  const workId = selected.value?.id ?? 'global'
  const domain = requestedDomain ?? unresolvedDomain.value
  if (!domain) return
  const selectedKey = mutationKey(workId, domain)
  const globalKey = mutationKey('global', domain)
  const key = unresolvedMutations.value.has(selectedKey) ? selectedKey : globalKey
  if (!unresolvedMutations.value.has(key)) return
  try {
    let reconciled = false
    if (domain === 'conversation' && workId !== 'global') {
      reconciled = await loadSelectedConversation(workId)
    } else if (domain === 'models' && workId !== 'global') {
      reconciled = await reconcileControlProjection('models', workId)
    } else if (domain === 'tools' && workId !== 'global') {
      reconciled = await reconcileControlProjection('tools', workId)
    } else if (domain === 'settings' && workId !== 'global') {
      reconciled = await reconcileControlProjection('settings', workId)
    } else if ((domain === 'sessions' || domain === 'tree') && workId !== 'global') {
      await app.load()
      if (app.error || selected.value?.id !== workId) throw new Error('无法取得修改后的权威 Work 状态。')
      await nextTick()
      const projection = await reconcileControlProjection(domain, workId)
      const conversation = await loadSelectedConversation(workId, true)
      reconciled = projection && conversation && !app.error
    } else if (domain === 'work') {
      await app.load()
      reconciled = !app.error
    }
    if (!reconciled) throw new Error('权威状态尚未成功刷新；结果未知的操作仍保持锁定。')
    const next = new Map(unresolvedMutations.value)
    next.delete(key)
    unresolvedMutations.value = next
    submissionError.value = null
  } catch (cause) {
    submissionError.value = errorMessage(cause)
  }
}

async function reconcileControlProjection(domain: ControlMutationDomain, workId: string): Promise<boolean> {
  if (controlCenterRef.value && domain !== 'conversation') return controlCenterRef.value.reconcileDomain(domain)
  if (domain === 'models') {
    const result = await currentHostCall((context) => listModels(workId, context))
    app.applyWorkSnapshot(result.instance)
    return true
  }
  if (domain === 'tools') {
    const result = await currentHostCall((context) => listTools(workId, context))
    app.applyWorkSnapshot(result.instance)
    return true
  }
  if (domain === 'settings') {
    await currentHostCall((context) => getSettings(workId, context))
    return true
  }
  return false
}

function applyExtensionEditorText(text: string) {
  draft.value = text
}

function resizeComposer() {
  const textarea = composerTextarea.value
  if (!textarea) return
  textarea.style.height = 'auto'
  const limit = composerExpanded.value ? Math.max(220, Math.floor(window.innerHeight * 0.45)) : 180
  textarea.style.height = `${Math.min(textarea.scrollHeight, limit)}px`
}

function handleComposerKeydown(event: KeyboardEvent, expanded = false) {
  if (event.isComposing) return
  const textarea = event.currentTarget as HTMLTextAreaElement
  if (isTauri && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === 'j' || event.code === 'KeyJ')) {
    event.preventDefault()
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? start
    textarea.setRangeText('\n', start, end, 'end')
    draft.value = textarea.value
    void nextTick(() => {
      textarea.focus()
      if (!expanded) resizeComposer()
    })
    return
  }
  if (!expanded && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    void submit()
  }
}

function applyExtensionTitle(title: string) {
  document.title = title
}

function restoreDocumentTitle() {
  document.title = selected.value ? `${selected.value.displayName} · AluDock` : 'AluDock Client'
}

function toolDetailOpen(id: string) {
  return toolExpansionOverrides.value[id] ?? extensionUi.toolsExpanded
}

function rememberToolDetail(id: string, event: Event) {
  toolExpansionOverrides.value = { ...toolExpansionOverrides.value, [id]: (event.currentTarget as HTMLDetailsElement).open }
}

async function toggleAllToolDetails() {
  const work = selected.value
  if (!work || !work.ownerHostEpoch || toolsExpandedMutating.value || mutationOutcomeUnknown.value) return
  toolsExpandedMutating.value = true
  submissionError.value = null
  try {
    const capturedHost = hostContext()
    const snapshot = await setExtensionToolsExpanded(work.id, work.ownerHostEpoch, work.runtimeGeneration, !extensionUi.toolsExpanded, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    app.applyWorkSnapshot(snapshot, capturedHost)
    extensionUi.applyAuthoritativeSnapshot(snapshot)
  } catch (cause) {
    markUnknownOutcome(cause, 'conversation', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    toolsExpandedMutating.value = false
  }
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function wrapCodeBlocks(html: string) {
  return html.replace(
    /<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_match, className: string | undefined, code: string) => {
      const language = className ? className.replace(/^language-/, '') : ''
      return `<div class="code-block-wrap"><div class="code-block-header"><span class="code-lang">${escapeHtml(language || 'code')}</span><button class="code-copy-btn" type="button">copy</button></div><pre class="code-block-pre"><code>${code}</code></pre></div>`
    },
  )
}

function renderMarkdown(text: string) {
  const raw = marked.parse(text || '', { async: false }) as string
  return wrapCodeBlocks(DOMPurify.sanitize(raw, MARKDOWN_SANITIZE_CONFIG))
}

function handleOutputClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('.code-copy-btn')
  if (!button) return
  const code = button.closest('.code-block-wrap')?.querySelector('code')?.textContent || ''
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = 'copied'
    window.setTimeout(() => { button.textContent = 'copy' }, 1200)
  }).catch(() => undefined)
}

</script>

<template>
  <div class="alu-client-shell" :class="{ 'alu-compact-mode': !detailMode }">
    <nav class="alu-navbar select-none">
      <div class="alu-navbar-left">
        <img src="./assets/console_icon_small.png" class="alu-navbar-avatar session-dot" alt="阿露" />
        <button type="button" class="alu-navbar-breadcrumb" title="查看 Project Status" aria-label="查看 Project Status" :disabled="!selected" @click="openControlCenter('resources')">
          <span class="alu-nav-workspace">{{ selected ? selected.cwd.split('/').filter(Boolean).slice(-2).join('/') : 'AluDock' }}</span>
          <span class="alu-nav-sep">/</span>
          <span class="alu-nav-session">{{ selected?.name || selected?.displayName || '选择 Work' }}</span>
          <span v-if="selected?.gitBranch" class="alu-nav-git-branch"> {{ selected.gitBranch }}</span>
          <span class="alu-navbar-breadcrumb-arrow" aria-hidden="true">▾</span>
        </button>
      </div>

      <div v-if="!app.needsPairing" class="alu-navbar-right">
        <button class="alu-nav-selector alu-nav-selector-model" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('models')">
          <span class="alu-nav-selector-icon">◉</span>
          <span class="alu-nav-selector-label">model:</span>
          <span class="alu-nav-selector-value" :data-provider="selected?.executor.model?.provider || '—'" :title="modelLabel">{{ modelLabel }}</span>
          <span class="alu-nav-selector-arrow">▾</span>
        </button>
        <button class="alu-nav-selector" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('thinking')">
          <span class="alu-nav-selector-icon">⌁</span>
          <span class="alu-nav-selector-label">thinking:</span>
          <span class="alu-nav-selector-value">{{ selected?.executor.thinkingLevel || '—' }}</span>
          <span class="alu-nav-selector-arrow">▾</span>
        </button>
        <div class="alu-nav-stats">
          <span class="alu-nav-stat-pill">↑<span>{{ formatTokenCount(selected?.metrics?.tokens?.input || 0) }}</span></span>
          <span class="alu-nav-stat-pill">↓<span>{{ formatTokenCount(selected?.metrics?.tokens?.output || 0) }}</span></span>
          <span class="alu-nav-stat-pill" :class="{ 'text-token-warn': contextPercent != null && contextPercent > 70 && contextPercent <= 90, 'text-token-danger': contextPercent != null && contextPercent > 90 }"><span>{{ formatContextUsage(selected?.metrics?.context) }}</span></span>
          <span class="alu-nav-stat-pill"><span>${{ Number(selected?.metrics?.cost || 0).toFixed(2) }}</span></span>
        </div>
        <button class="alu-nav-hamburger" aria-label="打开工作列表" @click="app.workDrawerOpen = true">☰</button>
      </div>
    </nav>

    <main ref="output" class="alu-output" aria-label="当前 Session 对话" @scroll.passive="handleOutputScroll" @load.capture="handleOutputMediaLoad" @click="handleOutputClick">
      <div v-if="!isTauri" class="alu-preview-notice">
        浏览器预览 · 操作不会提交
      </div>
      <div v-else-if="selected && conversationState && (!followConnected || conversationError)" class="alu-recovery-notice" role="status">
        <span>{{ conversationError ? `连接恢复失败：${conversationError}` : '连接已中断；当前对话已保留，正在重试…' }}</span>
        <button :disabled="conversationLoading" @click="loadSelectedConversation(selected.id, true)"><RefreshCw :size="13" />{{ conversationLoading ? '恢复中' : '重试' }}</button>
      </div>

      <div v-if="app.loading" class="center-state" aria-live="polite">
        <span class="alu-spinner" />
        <p>正在连接 AluDock…</p>
      </div>

      <div v-else-if="app.needsPairing" class="pairing-onboarding">
        <div class="pairing-intro">
          <img src="./assets/new_logo_small.png" alt="阿露" />
          <div><span class="eyebrow">WELCOME TO ALUDOCK</span><h1>连接你的 AluDock</h1><p>先在电脑上的 AluDock 中打开五分钟配对窗口，再在这里输入电脑地址和端口。</p></div>
        </div>
        <div class="pairing-layout">
          <form class="pairing-card" @submit.prevent="beginPairing()">
            <div class="pairing-card-title"><Link :size="18" /><div><strong>电脑连接信息</strong><small>地址只用于找到电脑，配对后会单独验证 Host 身份</small></div></div>
            <section v-if="recoverablePairings.length" class="pairing-recovery" aria-label="可恢复配对">
              <strong>可恢复的配对</strong><small>地址和设备名称已安全保存，不需要重新输入。</small>
              <article v-for="transaction in recoverablePairings" :key="transaction.transactionId">
                <span><b>{{ transaction.deviceName || DEVICE_NAME_FALLBACK }}</b><code>{{ transaction.host && transaction.port ? `${transaction.host}:${transaction.port}` : '旧版配对信息' }}</code></span>
                <div><button v-if="pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button><button v-else type="button" class="button secondary" :disabled="!transaction.recoverable" @click="resumeRecoveredPairing(transaction.transactionId)">恢复</button><button type="button" class="button secondary" :disabled="pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" @click="discardRecoveredPairing(transaction.transactionId)">丢弃</button></div>
              </article>
            </section>
            <label><span>IP 地址或域名</span><input v-model="pairHost" autocomplete="off" spellcheck="false" placeholder="例如 192.168.1.20 或 dock.example.com" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
            <label><span>端口</span><input v-model.number="pairPort" type="number" inputmode="numeric" min="1" max="65535" placeholder="从电脑端 AluDock 查看" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
            <label><span>这台设备的名称</span><input v-model="pairDeviceName" maxlength="128" required autocomplete="off" placeholder="例如 NUC14 或我的 MacBook" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" @input="rememberPairDeviceName" /><small class="pairing-field-hint">显示在电脑端；修改后会在重新配对时沿用。</small></label>
            <div v-if="pairingPin" class="pairing-pin"><small>请在电脑上的 AluDock 中输入</small><strong>{{ pairingPin }}</strong><span>不要把配对码发给其他人</span></div>
            <div v-if="pairingMessage" class="pairing-progress"><span class="alu-spinner" />{{ pairingMessage }}</div>
            <div v-if="pairingError" class="directory-error">{{ pairingError }}</div>
            <div class="pairing-actions">
              <button v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button>
              <button v-else type="submit" class="button primary" :disabled="!pairHost.trim() || !pairPort || !pairDeviceName.trim()">{{ pairingStage === 'failed' ? '重新尝试' : '开始配对' }}</button>
            </div>
          </form>
          <ol class="pairing-guide">
            <li><span>1</span><div><strong>在电脑上打开 AluDock</strong><p>进入 Remote Access / 配对，并打开五分钟配对窗口。</p></div></li>
            <li><span>2</span><div><strong>填写电脑地址与端口</strong><p>在家中通常填写局域网 IP；配对后还能为同一 Host 添加外网域名。</p></div></li>
            <li><span>3</span><div><strong>把四位码输入电脑端</strong><p>客户端会继续验证安全连接，确认完成后自动进入 Work 列表。</p></div></li>
          </ol>
        </div>
      </div>

      <div v-else-if="app.error" class="center-state error-state offline-host-state">
        <WifiOff :size="28" />
        <h1>无法连接“{{ app.activeHost?.displayName || 'Host' }}”</h1>
        <p>{{ app.error }}</p>
        <p v-if="app.hostUnreachable">已保存的配对仍保留，并且没有自动选择其他 Host。</p>
        <div v-if="app.activeHost && app.hostUnreachable" class="re-pair-prompt">
          <span class="re-pair-icon"><RotateCcw :size="19" /></span>
          <div>
            <strong>刚刚在 Dock 撤销了这台设备？</strong>
            <p>先在 Dock 打开配对窗口，然后从这里重新连接。新授权只会替换同一台 Host 的旧凭据。</p>
            <div v-if="pairingPin" class="re-pair-pin"><span>在 Dock 输入</span><b>{{ pairingPin }}</b></div>
            <span v-if="pairingMessage" class="re-pair-status">{{ pairingMessage }}</span>
          </div>
          <button v-if="pairingInProgress" type="button" class="button secondary" :disabled="!pairingTransactionId" @click="stopPairing">取消</button>
          <button v-else type="button" class="button primary" :disabled="rePairing || contextTransitionBusy" @click="rePairActiveHost">{{ rePairing ? '正在准备…' : pairingStage === 'failed' ? '重新尝试' : '重新配对' }}</button>
        </div>
        <div v-if="pairingError" class="re-pair-error" role="alert">{{ pairingError }}</div>
        <div class="pairing-actions">
          <button class="button secondary" @click="pairingError = ''; app.load()"><RefreshCw :size="16" />重新连接</button>
          <button class="button secondary" @click="openHostSettings"><Waypoints :size="16" />切换 Host</button>
          <button class="button secondary" @click="openHostSettings(); showHostPairingForm()"><Plus :size="16" />连接新的 AluDock</button>
          <button class="button secondary" @click="openHostSettings"><Settings :size="16" />Host 设置</button>
        </div>
      </div>

      <div v-else-if="!selected" class="alu-welcome">
        <img src="./assets/new_logo_small.png" alt="阿露" />
        <div class="alu-welcome-text">{{ app.works.length ? '请从工作列表选择一个 Work' : '没有可用的 Work' }}</div>
      </div>

      <div v-else-if="selected.lifecycle !== 'active'" class="alu-work-state" :data-lifecycle="selected.lifecycle">
        <section class="alu-work-state-card" aria-labelledby="alu-work-state-title">
          <div class="alu-work-state-status"><span class="alu-work-state-signal" aria-hidden="true" /><span>{{ inactiveState(selected).label }}</span></div>
          <h1 id="alu-work-state-title">{{ selected.displayName }}</h1>
          <p class="alu-work-state-message">{{ inactiveState(selected).message }}</p>
          <dl class="alu-work-state-meta"><div><dt>Workspace</dt><dd>{{ selected.cwd }}</dd></div></dl>
          <div v-if="selected.lastError" class="alu-work-state-error">{{ selected.lastError }}</div>
          <div class="alu-work-state-actions">
            <button v-if="selected.reopenable" class="alu-work-state-primary" :disabled="workMutating" @click="reopenSelectedWork()">{{ inactiveState(selected).action }}</button>
            <button class="alu-work-state-secondary" @click="app.workDrawerOpen = true">查看工作列表</button>
            <button class="alu-work-state-secondary" @click="app.load">刷新状态</button>
          </div>
        </section>
      </div>

      <div v-else-if="conversationLoading && !conversationState" class="alu-welcome" aria-live="polite">
        <img src="./assets/new_logo_small.png" alt="阿露" />
        <div class="alu-welcome-text">正在连接 {{ selected.displayName }}…</div>
      </div>

      <div v-else-if="conversationError && !conversationState" class="alu-welcome alu-welcome-error">
        <img src="./assets/new_logo_small.png" alt="阿露" />
        <div class="alu-welcome-text">对话暂时没有载入。你可以重新尝试，当前 Work 不会停止。</div>
        <button v-if="selected" class="ui-dialog-btn" @click="loadSelectedConversation(selected.id)">重新载入</button>
      </div>

      <template v-else-if="conversation.length">
        <div class="conversation-flow" role="log" aria-live="polite" aria-relevant="additions text">
          <div v-if="historyTruncated || historyError" class="history-loader">
            <button v-if="historyTruncated" :disabled="historyLoading || !historyBeforeEntryId" @click="loadEarlierHistory"><RefreshCw :size="14" :class="{ spinning: historyLoading }" />{{ historyLoading ? '加载中…' : historyError ? '重新加载更早记录' : '加载更早记录' }}</button>
            <span v-if="historyError">{{ historyError }}</span>
          </div>
          <template v-for="row in conversationRows" :key="row.id">
            <article v-if="row.kind === 'user'" class="msg-user" :data-conversation-id="row.id" :aria-label="`你的消息 ${row.time}`">
              <div class="msg-user-bubble">
                <div class="msg-user-top"><span class="msg-user-prefix">&gt;</span><span v-if="row.text" class="msg-user-text">{{ row.text }}</span></div>
                <div v-if="row.attachments?.length" class="message-attachments"><AttachmentCard v-for="attachment in row.attachments" :key="attachment.fileId" compact :name="attachment.name" :size-bytes="attachment.sizeBytes" :media-type="attachment.mediaType" :previewable="!!attachmentPreviews[attachment.fileId]" @preview="openAttachmentPreview(attachment.fileId, attachment.name)" /></div>
                <div class="msg-timestamp">{{ row.time }}</div>
              </div>
            </article>

            <article v-else-if="row.kind === 'assistant-group'" class="alu-msg-assistant-row" :data-conversation-id="row.id" :aria-label="`阿露回复 ${row.time}`">
              <img src="./assets/console_icon_small.png" alt="阿露" class="alu-msg-avatar" />
              <div class="alu-msg-assistant-content">
                <div class="alu-msg-assistant-body"><ConversationProcessParts :parts="row.parts" :render-markdown="renderMarkdown" :tool-open="toolDetailOpen" :image-resource="imageResource" @tool-toggle="rememberToolDetail" @image-request="requestConversationImage" @image-preview="openImagePreview" @image-failed="markConversationImageFailed" /></div>
                <div v-if="row.time" class="msg-assistant-timestamp">{{ row.time }}</div>
              </div>
            </article>

            <article v-else-if="row.kind === 'activity'" class="alu-msg-assistant-row is-agent-active" :data-conversation-id="row.id">
              <img src="./assets/console_icon_small.png" alt="阿露" class="alu-msg-avatar" />
              <div class="alu-msg-assistant-content"><div class="alu-msg-assistant-body"><div class="alu-agent-activity" role="status" aria-label="正在处理" title="正在处理"><span class="alu-agent-activity-spinner" aria-hidden="true" /></div></div></div>
            </article>

            <details v-else-if="row.kind === 'record' && row.folded" class="alu-record-panel alu-hideable" :class="row.panelClass" :data-conversation-id="row.id"><summary>{{ row.title }}</summary><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :render-markdown="renderMarkdown" :tool-open="toolDetailOpen" :image-resource="imageResource" @tool-toggle="rememberToolDetail" @image-request="requestConversationImage" @image-preview="openImagePreview" @image-failed="markConversationImageFailed" /></div></details>

            <section v-else-if="row.kind === 'record'" class="alu-record-panel" :class="row.panelClass" :data-conversation-id="row.id"><div class="alu-record-title alu-hideable">{{ row.title }}</div><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :render-markdown="renderMarkdown" :tool-open="toolDetailOpen" :image-resource="imageResource" @tool-toggle="rememberToolDetail" @image-request="requestConversationImage" @image-preview="openImagePreview" @image-failed="markConversationImageFailed" /></div></section>

            <div v-else class="alu-live-notice-row alu-hideable" :data-conversation-id="row.id"><div :class="row.tone === 'error' ? 'msg-error' : row.tone === 'warning' ? 'msg-warning' : 'msg-notice'">{{ row.text }}</div></div>
          </template>
        </div>
      </template>

      <div v-else class="alu-welcome">
        <img src="./assets/new_logo_small.png" alt="阿露" />
        <div class="alu-welcome-text">「{{ selected.name || 'New session' }}」准备好了。</div>
      </div>
    </main>

    <section v-if="selected && selected.lifecycle === 'active'" class="alu-input-section" aria-label="消息编辑器">
      <button v-if="outputAwayFromBottom" type="button" class="alu-scroll-bottom" aria-label="滚动到最新消息" @click="scrollOutputToBottom(true)"><span aria-hidden="true">↓</span>滚到底部</button>
      <ExtensionUiSurface :work="selected" :reconcile-interaction="reconcileExtensionInteraction" @editor-text="applyExtensionEditorText" @title="applyExtensionTitle">
        <div v-if="submissionError" class="alu-composer-error"><span>{{ submissionError }}</span><button v-if="mutationOutcomeUnknown" @click="reconcileMutationOutcome()">刷新并确认</button></div>
        <div v-if="queueNotice" class="alu-composer-notice" role="status">{{ queueNotice }}<button type="button" @click="queueNotice = ''">×</button></div>
        <div v-if="selected.pending.total" class="alu-queue-tray">
          <span class="alu-queue-title">Queue · {{ selected.pending.total }}</span>
          <span class="alu-queue-preview">{{ queueItems.map(item => item.text.trim() || (item.imageCount || item.attachments.length ? '[附件]' : '')).filter(Boolean).join(' · ') }}</span>
          <button type="button" class="alu-queue-restore" title="取回 Queue（Alt+↑）" aria-keyshortcuts="Alt+ArrowUp" :disabled="!isTauri || attachmentPicking || queueRestoring || submitting" @click="restoreQueue">{{ queueRestoring ? '取回中…' : '取回' }}</button>
        </div>
        <div v-if="uploadDrafts.length || draftAttachments.length || restoredImageCount" class="alu-native-attachments" aria-label="已选附件">
          <AttachmentCard v-for="item in uploadDrafts" :key="item.token" :name="item.name" :size-bytes="item.sizeBytes" :media-type="item.mediaType" :state="item.state" :progress="item.progress" :message="item.error" :retryable="item.state === 'error'" :cancellable="item.state !== 'error'" :removable="item.state === 'error'" :previewable="!!attachmentPreviews[item.token]" @preview="openAttachmentPreview(item.token, item.name)" @retry="startAttachmentUpload(item)" @cancel="cancelUpload(item)" @remove="removeUpload(item)" />
          <AttachmentCard v-for="attachment in draftAttachments" :key="attachment.fileId" :name="attachment.name" :size-bytes="attachment.sizeBytes" :media-type="attachment.mediaType" :previewable="!!attachmentPreviews[attachment.fileId]" removable @preview="openAttachmentPreview(attachment.fileId, attachment.name)" @remove="removeUploaded(attachment.fileId)" />
          <div v-if="restoredImageCount" class="alu-restored-images"><span>已取回 {{ restoredImageCount }} 个附件</span><button type="button" :disabled="clearingRestoredImages" @click="clearQueueImages">{{ clearingRestoredImages ? '移除中…' : '移除' }}</button></div>
        </div>
        <form class="alu-input-wrap" @submit.prevent="submit">
          <textarea ref="composerTextarea" v-model="draft" rows="1" :disabled="conversationLoading" placeholder="输入消息…" title="Enter 发送 · Shift+Enter / Ctrl+J 换行" aria-keyshortcuts="Control+J" @input="resizeComposer" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event)" />
          <button type="button" class="alu-composer-expand" title="展开编辑" aria-label="展开编辑" :disabled="conversationLoading" @click="rememberModalTrigger(); composerExpanded = true">↗</button>
          <button class="alu-send-btn" type="submit" :disabled="(!draft.trim() && !draftAttachments.length && !restoredImageCount) || !isTauri || conversationLoading || submitting || queueRestoring || attachmentPicking || mutationOutcomeUnknown || uploadDrafts.length > 0">{{ submitting ? '发送中…' : '发送' }}</button>
        </form>
      </ExtensionUiSurface>

      <div class="alu-bottom-bar">
        <div class="alu-bottom-bar-left">
          <button class="alu-bar-btn alu-bar-session-action" title="恢复 Session" aria-label="恢复 Session" @click="openControlCenter('sessions')">↪<span>恢复</span></button>
          <button class="alu-bar-btn alu-bar-session-action" title="打开 Session Tree" aria-label="打开 Session Tree" @click="openControlCenter('tree')">⑂<span>Tree</span></button>
          <button class="alu-bar-btn" title="添加附件" :disabled="!isTauri || attachmentPicking || draftAttachments.length + uploadDrafts.length >= 32" @click="chooseAttachments">📎<span class="sm-inline">附件</span></button>
        </div>
        <div class="alu-bottom-bar-right">
          <span class="alu-status-dot" :class="{ connecting: !followConnected && !conversationError, error: !!conversationError }" />
          <span class="alu-status-label sm-inline">{{ connectionLabel }}</span>
          <div class="alu-bar-sep" />
          <button class="alu-bar-btn" title="刷新" @click="refreshCurrent">↻<span class="sm-inline">刷新</span></button>
          <button class="alu-bar-btn" :class="{ 'alu-bar-btn-toggle-active': !detailMode }" title="切换显示模式" @click="detailMode = !detailMode"><span>▤</span><span>{{ detailMode ? '详细' : '简洁' }}</span></button>
          <button class="alu-bar-btn" :title="`打开命令中心（${commandShortcutLabel}）`" aria-keyshortcuts="Control+K Meta+K" @click="openControlCenter('commands')"><kbd>{{ commandShortcutLabel }}</kbd><span class="sm-inline">命令</span></button>
          <button class="alu-bar-btn alu-bar-btn-abort" :disabled="!isTauri || aborting || mutationOutcomeUnknown || selected.execution !== 'running'" @click="abortCurrentRun">⏹<span class="sm-inline">{{ aborting ? '中止中' : '中止' }}</span></button>
        </div>
      </div>
    </section>

    <button v-if="app.workDrawerOpen" class="alu-sidebar-overlay open" aria-label="关闭工作列表" @click="app.workDrawerOpen = false" />
    <aside class="alu-sidebar" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :inert="!app.workDrawerOpen || undefined" aria-label="工作列表">
      <div class="alu-sidebar-head">
        <img src="./assets/console_icon_small.png" class="alu-sidebar-avatar" alt="阿露" />
        <div class="alu-sidebar-title">Alu WebConsole</div>
        <button class="alu-sidebar-refresh" title="刷新" :disabled="contextTransitionBusy" @click="app.load">↻</button>
      </div>
      <div class="alu-sidebar-actions"><button class="alu-new-work-btn" :disabled="contextTransitionBusy" @click="openDirectory">＋ 新建工作</button></div>
      <div class="alu-instance-list">
        <section v-for="group in (['current', 'continue', 'history'] as const)" :key="group" v-show="groupedWorks[group].length" class="alu-instance-group">
          <div class="alu-instance-group-title">{{ group === 'current' ? '当前工作' : group === 'continue' ? '可以继续' : '历史工作' }}<span>{{ groupedWorks[group].length }}</span></div>
          <div v-for="work in groupedWorks[group]" :key="work.id" class="alu-instance-row" :class="{ 'is-selected': work.id === selected?.id }">
            <button class="alu-instance-link" :disabled="contextTransitionBusy && work.id !== selected?.id" @click="selectWork(work.id)">
              <span class="alu-instance-state" :class="`is-${work.lifecycle}`" />
              <span class="alu-instance-copy"><span class="alu-instance-name">{{ work.displayName }}</span><span class="alu-instance-cwd">{{ work.cwd.split('/').filter(Boolean).slice(-2).join('/') }}</span></span>
              <span class="alu-instance-meta">{{ sidebarState(work) }}</span>
            </button>
            <button v-if="work.reopenable && work.lifecycle !== 'active'" class="alu-instance-action" :disabled="!isTauri" @click="reopenFromList(work)">继续</button>
            <button v-else-if="group === 'history'" class="alu-instance-action is-muted" :disabled="!isTauri" @click="forgetFromList(work)">移除</button>
          </div>
        </section>
        <div v-if="!app.works.length" class="alu-sidebar-empty">暂无工作</div>
      </div>
      <button class="alu-host-settings-entry" aria-label="Host 与配对设置" @click="openHostSettings">
        <img src="./assets/aludock-icon.png" alt="" />
        <span><strong>{{ app.activeHost?.displayName || '连接 AluDock' }}</strong><small>{{ connectionLabel }}</small></span>
        <span aria-hidden="true">⚙</span>
      </button>
    </aside>

    <Transition name="fade">
      <div v-if="imagePreview" class="alu-image-preview-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="alu-image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1" @wheel="handleModalWheel">
          <button type="button" class="alu-image-preview-close" aria-label="关闭图片预览" data-modal-initial @click="closeModal">×</button>
          <img :src="imagePreview.url" :alt="imagePreview.name" @error="markPreviewImageFailed" />
          <footer><span>{{ imagePreview.name }}</span><a :href="imagePreview.url" :download="imagePreview.name">下载</a></footer>
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="composerExpanded" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="ui-dialog-box ui-dialog-box-composer ui-dialog-size-wide" role="dialog" aria-modal="true" aria-labelledby="expanded-composer-title" tabindex="-1" @wheel="handleModalWheel">
          <header class="ui-dialog-header"><div id="expanded-composer-title" class="ui-dialog-title">编辑消息</div></header>
          <button class="ui-dialog-close" aria-label="关闭" @click="composerExpanded = false">×</button>
          <textarea v-model="draft" class="ui-dialog-composer-editor" rows="12" placeholder="输入多行消息…" title="Ctrl+J 换行" aria-keyshortcuts="Control+J" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event, true)" />
          <footer class="ui-dialog-actions ui-dialog-composer-footer">
            <span class="ui-dialog-composer-attachments">{{ draftAttachments.length + restoredImageCount ? `已附加 ${draftAttachments.length + restoredImageCount} 个文件` : '未附加文件' }}</span>
            <span v-if="submissionError" class="ui-dialog-composer-status">未发送，内容已保留。</span>
            <button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="submitting || (!draft.trim() && !draftAttachments.length && !restoredImageCount)" @click="submitExpanded">{{ submitting ? '发送中…' : '发送' }}</button>
          </footer>
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="commandOpen && selected" :class="controlSection === 'commands' ? 'cmd-palette-overlay' : 'ui-dialog-overlay'" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" :class="controlSection === 'commands' ? 'cmd-palette-box' : controlDialogClasses(controlSection)" role="dialog" aria-modal="true" tabindex="-1" :aria-label="controlDialogTitle(controlSection)" @wheel="handleModalWheel">
          <template v-if="controlSection !== 'commands'"><header class="ui-dialog-header"><div class="ui-dialog-title">{{ controlTitleOverride || controlDialogTitle(controlSection) }}</div><div v-if="controlBodyOverride || (!controlTitleOverride && controlDialogBody(controlSection))" class="ui-dialog-body">{{ controlBodyOverride || controlDialogBody(controlSection) }}</div></header><button class="ui-dialog-close" aria-label="关闭" @click="closeModal">×</button></template>
          <ControlCenter
            ref="controlCenterRef"
            :work="selected"
            :section="controlSection"
            :preview="!isTauri"
            :outcome-unknown="mutationOutcomeUnknown"
            :unknown-domain="unresolvedControlDomain"
            :has-draft="!!draft.trim()"
            @section="controlSection = $event"
            @snapshot="applyControlSnapshot"
            @unknown="markControlUnknown"
            @reconcile="reconcileMutationOutcome"
            @resync="resyncSession"
            @close="closeModal"
            @stop="closeModal(); stopSelectedWork()"
            @restore-queue="closeModal(); restoreQueue()"
            @title="setControlDialogTitle"
            @size="controlSizeOverride = $event"
          />
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="directoryOpen || hostSettingsOpen" :class="directoryOpen ? 'ui-dialog-overlay' : 'modal-layer'" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" :class="directoryOpen ? ['ui-dialog-box', 'ui-dialog-size-wide'] : 'host-settings-surface'" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="directoryOpen ? 'directory-title' : 'host-settings-title'" @wheel="handleModalWheel">
          <template v-if="directoryOpen"><header class="ui-dialog-header"><div id="directory-title" class="ui-dialog-title">选择工作目录</div><div class="ui-dialog-body">{{ workspace?.path || workspacePath }}{{ workspace ? `\n${workspace.truncated ? `显示前 ${workspace.entries.length} / ${workspace.total} 个目录` : `${workspace.total} 个子目录`}` : '' }}</div></header><button class="ui-dialog-close" aria-label="关闭" @click="closeModal">×</button></template>
          <header v-else class="host-settings-header">
            <div class="host-settings-heading"><img src="./assets/aludock-icon.png" alt="" /><div><h2 id="host-settings-title">Host 设置</h2><p>{{ app.payload?.host.profile.displayName || '管理已配对的 AluDock' }}</p></div></div>
            <button class="host-settings-close" data-modal-initial aria-label="关闭" @click="closeModal"><X :size="18" /></button>
          </header>
          <div v-if="directoryOpen" class="alu-directory-select">
            <div class="ui-dialog-search-wrap"><input v-model="workspaceSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
            <div v-if="workspaceError" class="alu-dialog-error">{{ workspaceError }}</div>
            <div v-if="workspaceLoading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取目录…</div>
            <div v-else-if="workspace" class="ui-dialog-options" role="listbox">
              <button class="ui-dialog-option" :disabled="!isTauri || creatingWork || mutationOutcomeUnknown || !!trustContinuation" @click="createSelectedWork()"><span class="ui-dialog-option-marker">✓</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">使用这个目录</span><span class="ui-dialog-option-badge">SELECT</span></span><span class="ui-dialog-option-detail"><span>{{ workspace.path }}</span></span></span></button>
              <button v-if="workspace.parent" class="ui-dialog-option" @click="browse(workspace.parent)"><span class="ui-dialog-option-marker">↑</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">..</span><span class="ui-dialog-option-detail"><span>返回上级目录</span></span></span></button>
              <button v-for="entry in filteredWorkspaceEntries" :key="entry.name" class="ui-dialog-option" @click="browse(`${workspace.path.replace(/\/$/, '')}/${entry.name}`)"><span class="ui-dialog-option-marker">{{ entry.kind === 'symlink' ? '↗' : '▸' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ entry.name }}</span><span v-if="entry.kind === 'symlink'" class="ui-dialog-option-badge">LINK</span></span><span class="ui-dialog-option-detail"><span>{{ entry.kind === 'symlink' ? '目录链接' : '目录' }}{{ entry.hidden ? ' · 隐藏' : '' }}</span></span></span></button>
              <div v-if="!filteredWorkspaceEntries.length && !workspace.parent" class="ui-dialog-empty">没有匹配项</div>
            </div>
            <div v-if="trustContinuation" class="session-trust"><strong>这个项目尚未被信任</strong><p>确认后会继续在此目录创建 Work。</p><div><button @click="trustContinuation = null">取消</button><button @click="continueWithTrust('trust_once')">仅本次信任</button><button class="session-primary" @click="continueWithTrust('trust_and_remember')">信任并创建</button></div></div>
            <div v-if="creatingWork" class="cmd-palette-footer">正在创建 Work…</div>
          </div>
          <div v-else class="host-settings-panel">
            <aside class="host-catalog-section">
              <div class="host-catalog-title"><span>已保存的 Host</span><b>{{ app.catalog?.hosts.length ?? 0 }}</b></div>
              <div class="host-catalog-list">
                <article v-for="host in app.catalog?.hosts" :key="host.hostId" class="host-choice" :class="{ active: host.hostId === app.activeHostId }">
                  <button class="host-choice-main" :disabled="host.hostId === app.activeHostId || contextTransitionBusy" @click="switchSavedHost(host.hostId)">
                    <span class="host-choice-dot" aria-hidden="true" />
                    <span class="host-choice-copy"><strong>{{ host.displayName }}</strong><small>{{ host.endpointSummary }}</small></span>
                    <span v-if="host.hostId === app.activeHostId" class="host-choice-current">当前</span>
                  </button>
                  <button class="host-choice-delete" :aria-label="`从此设备删除 ${host.displayName}`" :disabled="contextTransitionBusy" @click="removeSavedHost(host.hostId, host.displayName)"><Trash2 :size="14" /></button>
                </article>
              </div>
              <button class="host-connect-new" :disabled="contextTransitionBusy" @click="showHostPairingForm"><Plus :size="15" />连接新的 AluDock</button>
            </aside>
            <div class="host-detail-column">
              <div class="host-detail-intro"><div><span>当前 Host</span><h3>{{ app.activeHost?.displayName || 'AluDock' }}</h3></div><p>{{ app.activeHost?.profile.endpoints.length ?? 0 }} 个连接地址 · {{ app.activeHost?.profile.policy.mode === 'automatic' ? '自动选择' : '固定地址' }}</p></div>
            <section v-if="recoverablePairings.length" class="pairing-card pairing-recovery" aria-label="可恢复配对">
              <div class="pairing-card-title"><RotateCcw :size="18" /><div><strong>可恢复的配对</strong><small>继续时直接使用已保存地址，不需要重新输入。</small></div></div>
              <article v-for="transaction in recoverablePairings" :key="transaction.transactionId">
                <span><b>{{ transaction.deviceName || DEVICE_NAME_FALLBACK }}</b><code>{{ transaction.host && transaction.port ? `${transaction.host}:${transaction.port}` : '旧版配对信息' }}</code></span>
                <div><button v-if="pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button><button v-else type="button" class="button secondary" :disabled="contextTransitionBusy || !transaction.recoverable" @click="resumeRecoveredPairing(transaction.transactionId)">恢复</button><button type="button" class="button secondary" :disabled="contextTransitionBusy || (pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage))" @click="discardRecoveredPairing(transaction.transactionId)">丢弃</button></div>
              </article>
            </section>
            <form v-if="addingHost" class="pairing-card host-pairing-card" @submit.prevent="beginPairing()">
              <div class="pairing-card-title"><Link :size="18" /><div><strong>连接新的 AluDock</strong><small>配对验证完成后才会加入列表并激活</small></div><button type="button" class="host-inline-close" aria-label="收起配对表单" @click="addingHost = false"><X :size="15" /></button></div>
              <label><span>IP 地址或域名</span><input v-model="pairHost" autocomplete="off" spellcheck="false" placeholder="192.168.1.20 或 dock.example.com" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
              <label><span>端口</span><input v-model.number="pairPort" type="number" min="1" max="65535" /></label>
              <label><span>这台设备的名称</span><input v-model="pairDeviceName" maxlength="128" required autocomplete="off" placeholder="例如 NUC14 或我的 MacBook" @input="rememberPairDeviceName" /><small class="pairing-field-hint">显示在电脑端；修改后会在重新配对时沿用。</small></label>
              <div v-if="pairingPin" class="pairing-pin"><small>请在电脑上的 AluDock 中输入</small><strong>{{ pairingPin }}</strong></div>
              <div v-if="pairingMessage" class="pairing-progress">{{ pairingMessage }}</div>
              <div v-if="pairingError" class="directory-error">{{ pairingError }}</div>
              <div class="pairing-actions"><button v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">停止等待</button><button v-else class="button primary" :disabled="contextTransitionBusy || !pairHost.trim() || !pairPort || !pairDeviceName.trim()">开始配对</button></div>
            </form>
            <form class="host-profile-form" @submit.prevent="saveHostDisplayName">
              <div><strong>Host 名称</strong><small>仅修改这台已配对 Host 在客户端中的显示名称，不会改变地址或配对身份。</small></div>
              <div class="host-name-field"><input v-model="hostDisplayName" maxlength="128" autocomplete="off" placeholder="例如 家里的工作站" :disabled="hostNameSaving" /><button class="button secondary" :disabled="hostNameSaving || hostDisplayName.trim() === app.activeHost?.displayName">{{ hostNameSaving ? '保存中…' : '保存名称' }}</button></div>
              <p v-if="hostNameError" class="host-name-error">{{ hostNameError }}</p>
              <p v-else-if="hostNameSaved" class="host-name-success">Host 名称已保存。</p>
            </form>
            <div class="connection-policy">
              <div><Globe2 :size="18" /><span><strong>自动选择连接地址</strong><small>在家优先局域网，不可达时自动尝试外网 / VPN 地址</small></span></div>
              <button :class="{ selected: app.activeHost?.profile.policy.mode === 'automatic' }" @click="chooseConnectionPolicy('automatic')">{{ app.activeHost?.profile.policy.mode === 'automatic' ? '已启用' : '启用' }}</button>
            </div>
            <section class="endpoint-section">
              <div class="host-section-heading"><div><h3>连接地址</h3><p class="endpoint-order-note">按局域网、VPN、广域网和手动地址的顺序自动尝试。</p></div><button class="host-add-endpoint" @click="toggleEndpointForm"><Plus :size="14" />{{ endpointFormOpen ? '收起' : '添加地址' }}</button></div>
              <div class="endpoint-list">
                <article v-for="(endpoint, index) in app.activeHost?.profile.endpoints" :key="endpoint.id" class="endpoint-row" :class="[`state-${endpoint.state}`]">
                  <span class="endpoint-icon"><ShieldCheck :size="17" /></span>
                  <div class="endpoint-detail">
                    <strong>{{ endpoint.label }}</strong>
                    <code>{{ endpoint.endpoint.host }}:{{ endpoint.endpoint.port }}</code>
                    <small>{{ endpointKindLabel(endpoint.kind) }} · {{ endpointStateLabel(endpoint) }}</small>
                    <small v-if="endpoint.lastManualTest" :class="endpoint.lastManualTest.succeeded ? 'test-success' : 'test-failure'">{{ testStatusLabel(endpoint) }}</small>
                  </div>
                  <div class="endpoint-actions">
                    <button :disabled="index === 0 || !!endpointMutatingId" :aria-label="`上移 ${endpoint.label}`" @click="moveEndpoint(endpoint.id, -1)">↑</button>
                    <button :disabled="index === (app.activeHost?.profile.endpoints.length ?? 0) - 1 || !!endpointMutatingId" :aria-label="`下移 ${endpoint.label}`" @click="moveEndpoint(endpoint.id, 1)">↓</button>
                    <button :disabled="!!endpointMutatingId" @click="testEndpoint(endpoint)">{{ endpointMutatingId === endpoint.id ? '测试中…' : endpoint.state === 'draft_unverified' ? '验证' : '重试' }}</button>
                    <button :disabled="!!endpointMutatingId" @click="toggleEndpoint(endpoint)">{{ endpoint.state === 'disabled' ? '重新启用' : '停用' }}</button>
                    <button v-if="endpoint.state === 'verified'" class="endpoint-use" :class="{ selected: app.activeHost?.profile.policy.mode === 'fixed' && app.activeHost!.profile.policy.endpointId === endpoint.id }" :disabled="!!endpointMutatingId" @click="chooseConnectionPolicy('fixed', endpoint.id)">固定</button>
                    <button class="endpoint-delete" :aria-label="`删除地址 ${endpoint.label}`" :disabled="!!endpointMutatingId" @click="removeEndpoint(endpoint.id, endpoint.label)"><Trash2 :size="15" /></button>
                  </div>
                </article>
              </div>
            </section>
            <form v-if="endpointFormOpen" class="endpoint-form" @submit.prevent="addHostEndpoint">
              <div><h3>添加连接地址</h3><p>例如外网 DDNS 域名。验证为同一台 AluDock 后才会保存并参与自动连接。</p></div>
              <div class="endpoint-fields">
                <label><span>备注</span><input v-model="endpointLabel" maxlength="128" placeholder="外网域名" /></label>
                <label><span>类型</span><select v-model="endpointKind"><option value="remote">广域网</option><option value="local">局域网</option><option value="vpn">VPN</option><option value="manual">其他</option></select></label>
                <label class="endpoint-host"><span>IP 地址或域名</span><input v-model="endpointHost" spellcheck="false" placeholder="dock.example.com" /></label>
                <label><span>端口</span><input v-model.number="endpointPort" type="number" inputmode="numeric" min="1" max="65535" placeholder="端口" /></label>
              </div>
              <div v-if="endpointError" class="directory-error">{{ endpointError }}</div>
              <div v-if="endpointCanSaveDraft" class="endpoint-draft-offer"><span>当前网络无法完成验证。可先保存为明确的待验证草稿；它不会被自动尝试。</span><button type="button" class="button secondary" :disabled="endpointSaving" @click="saveEndpointDraft">保存为待验证草稿</button></div>
              <footer><span><ShieldCheck :size="14" />不会覆盖原配对；身份不符不会提升为已验证</span><button class="button primary" :disabled="!endpointHost.trim() || !endpointPort || endpointSaving">{{ endpointSaving ? '正在验证…' : '验证并添加' }}</button></footer>
            </form>
            </div>
          </div>

        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="confirmDialog" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="ui-dialog-box ui-dialog-box-confirm" role="dialog" aria-modal="true" tabindex="-1" :aria-label="confirmDialog.title" @wheel="handleModalWheel">
          <header class="ui-dialog-header"><div class="ui-dialog-title">{{ confirmDialog.title }}</div><div v-if="confirmDialog.body" class="ui-dialog-body">{{ confirmDialog.body }}</div></header>
          <div class="ui-dialog-btn-row"><button class="ui-dialog-btn" @click="settleConfirm(false)">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" data-modal-initial @click="settleConfirm(true)">确认</button></div>
        </section>
      </div>
    </Transition>
  </div>
</template>
