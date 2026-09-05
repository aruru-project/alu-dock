<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  FileDown,
  FileText,
  FolderTree,
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
  Wrench,
  X,
} from '@lucide/vue'
import {
  abortRun,
  beginWindowsAway,
  cancelAttachmentUpload,
  cancelWindowsAway,
  clearRestoredImages,
  cancelPairing,
  compactSession,
  dequeueMessages,
  downloadDeliverable,
  forgetWork,
  isTauri,
  getClientPreferences,
  getCommandCompletions,
  getDesktopShellStatus,
  getSettings,
  getSystemDeviceName,
  listDeliverables,
  listMachines,
  listModels,
  listSessions,
  listTools,
  loadSessionTree,
  loadConversation,
  loadAttachmentPreviewBytes,
  loadConversationImageBytes,
  loadPublishedImageBytes,
  openSavedDeliverable,
  openDesktopHostLog,
  openDesktopTui,
  pickAttachments,
  renameHostProfile,
  removeAttachment,
  reorderHostEndpoints,
  reopenWork,
  reselectHostRoute,
  resumePairing,
  discardPairing,
  stageClipboardImage,
  startConversationFollow,
  startDesktopHost,
  startPairing,
  stopConversationFollow,
  stopWork,
  submitMessage,
  updateClientPreferences,
  uploadAttachment,
  deleteHostEndpoint,
  savePreviewImage,
  saveUnverifiedHostEndpoint,
  setConnectionPolicy,
  setExtensionToolsExpanded,
  setHostEndpointEnabled,
  testHostEndpoint,
  verifyHostEndpoint,
} from './lib/bridge'
import type { CreateWorkContinuation, SessionContext } from './lib/bridge'
import { useConversationContent } from './lib/conversationContent'
import { useConversationViewport, type ConversationReadingAnchor } from './lib/conversationViewport'
import { dockToolsState } from './lib/dockTools'
import { appendRestoredQueue, attachmentUploadMatches, attachmentUploadTarget, attachmentsAfterSubmit, bindLocalAttachment, displayedConversationImageResource, moveAttachmentPreviewResource } from './lib/attachmentDraft'
import { subhostMachineName } from './lib/machines'
import {
  DEVICE_NAME_FALLBACK,
  browserDeviceNameStorage,
  normalizeDeviceName,
  persistDeviceNamePreference,
  readDeviceNamePreference,
  resolveDeviceName,
} from './lib/deviceName'
import { userErrorMessage as errorMessage } from './lib/userError'
import { captureConnectionResult, currentConnectionCall, hostResultMatches, requireConnectionContext } from './lib/hostResult'
import { reduceLiveEvent } from './lib/liveReducer'
import { isRasterImageMimeType, rasterImageMimeType } from './lib/rasterImage'
import { editorAfterSessionReplacement } from './lib/sessionEditor'
import {
  conversationBoundaryKey,
  conversationSwapIsCorrelated,
  draftAfterSubmit,
  formatContextUsage,
  formatTokenCount,
  FollowActivationCoordinator,
  initialWindowFocused,
  type FollowConnectionState,
  type FollowConnectionStatus,
  stopCanStart,
  stopConfirmationText,
  stoppedResultIsCorrelated,
  workPresence,
} from './lib/uiBoundaries'
import { applySlashArgumentCompletion, applySlashCompletion, catalogSourceLabel, filterCatalogCommands, prefixSlashCommand, slashArgumentContext, slashCommandQuery } from './lib/commandSuggest'
import { filterLocalControlCommands, localControlCommands, submittedLocalControl, type ControlSection, type LocalControlCommand } from './lib/localCommands'
import type { AttachmentDto, AttachmentUploadProgress, ClientPreferences, CommandArgumentCompletion, CommandInfo, ConnectionKind, ConversationBootstrap, ConversationImageResource, ConversationItem, ConversationProcessItem, DeliverableDownloadProgress, DeliverableDto, DesktopShellStatus, HostConnectionProfile, ConnectionContext, HostEndpoint, LocalAttachmentUpload, MachineDto, ProjectedEvent, QueueItem, SelectedAttachment, WindowsAwayDelay, Work } from './lib/types'
import {
  deliveryHistoryKey,
  downloadedDelivery,
  pastDownloadedDeliveries,
  persistDownloadHistory,
  readDownloadHistory,
  recordDownloadedDelivery,
  removeDownloadedDeliveries,
  type DownloadedDeliverable,
} from './lib/downloadHistory'
import AppSettings from './components/AppSettings.vue'
import AttachmentCard from './components/AttachmentCard.vue'
import DeliveryTray from './components/DeliveryTray.vue'
import ControlCenter, { type ControlMutationDomain } from './components/ControlCenter.vue'
import ConversationView from './components/ConversationView.vue'
import ExtensionUiSurface from './components/ExtensionUiSurface.vue'
import ImageZoomSurface from './components/ImageZoomSurface.vue'
import NewWorkDialog from './components/NewWorkDialog.vue'
import MessageTextDialog from './components/MessageTextDialog.vue'
import LocalConnectionCard from './components/LocalConnectionCard.vue'
import WorkspaceBrowser from './components/WorkspaceBrowser.vue'
import dockIconUrl from '../../../assets/icon.svg'
import { useAppStore } from './stores/app'
import { useCommandCatalogStore } from './stores/command-catalog'
import { useCommandConsoleStore } from './stores/command-console'
import { useExtensionUiStore } from './stores/extension-ui'

const commandShortcutLabel = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'
const isAndroidWebView = /Android/i.test(navigator.userAgent)
const appBuildIdentity = import.meta.env.VITE_ALUDOCK_BUILD_IDENTITY

const app = useAppStore()
const commandCatalogStore = useCommandCatalogStore()
const commandConsole = useCommandConsoleStore()
const extensionUi = useExtensionUiStore()
const draft = computed({ get: () => app.currentDraft, set: (value: string) => app.setCurrentDraft(value) })
const draftAttachments = computed({ get: () => app.currentAttachments, set: (value: AttachmentDto[]) => app.setCurrentAttachments(value) })
const detailMode = computed({ get: () => app.detailMode, set: (value: boolean) => app.setDetailMode(value) })
const selected = computed(() => app.selectedWork)
const directoryOpen = ref(false)
const commandOpen = ref(false)
const controlSection = ref<ControlSection>('commands')
const controlTitleOverride = ref('')
const controlBodyOverride = ref('')
const controlSizeOverride = ref<'default' | 'wide' | 'tree' | ''>('')
const confirmDialog = ref<{ title: string; body: string; resolve: (confirmed: boolean) => void } | null>(null)
const appSettingsOpen = ref(false)
const appSettings = ref<ClientPreferences | null>(null)
const appSettingsSaving = ref(false)
const appSettingsError = ref('')
const desktopShell = ref<DesktopShellStatus | null>(null)
const desktopShellBusy = ref(false)
const hostSettingsOpen = ref(false)
const addingHost = ref(false)
const output = ref<HTMLElement | null>(null)
const conversationViewport = useConversationViewport(output)
const outputAwayFromBottom = conversationViewport.awayFromBottom
const composerTextarea = ref<HTMLTextAreaElement | null>(null)
const composerExpanded = ref(false)
const hostMachines = ref<MachineDto[]>([])
const machineListError = ref('')
const newWorkMachinesLoading = ref(false)
const newWorkMutationBusy = ref(false)
const newWorkCompact = ref(true)
let machineLoadEpoch = 0
const reopenTrustContinuation = ref<CreateWorkContinuation | null>(null)
const reconcilingReopenWorkId = ref('')
type ConversationImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
type ImagePreview =
  | { kind: 'conversation'; imageKey: string; url: string; name: string }
  | { kind: 'attachment'; attachmentKey: string; url: string; name: string }
type AttachmentPreviewResource = { url: string; mediaType: string }
type CachedConversationImageResource = ConversationImageResource & { sizeBytes?: number; lastAccessed?: number }
// A unified 128 MiB cap leaves room for the rest of the UI on memory-constrained Android devices.
const CONVERSATION_IMAGE_CACHE_BUDGET_BYTES = 128 * 1024 * 1024
const imageResources = ref<Record<string, CachedConversationImageResource>>({})
const attachmentPreviews = ref<Record<string, AttachmentPreviewResource>>({})
const imagePreview = ref<ImagePreview | null>(null)
const messageTextView = ref<{ title: string; text: string; markdown: boolean } | null>(null)
const imageSaving = ref(false)
const imageSaveStatus = ref<{ tone: 'success' | 'error'; text: string } | null>(null)
let imageDomainKey = ''
let imageLoadEpoch = 0
let imageAccessSequence = 0
const conversationLoading = ref(false)
const conversationError = ref<string | null>(null)
let historyReloadRequiredWorkId: string | null = null
const submitting = ref(false)
const aborting = ref(false)
const compactionWorkIds = ref<Set<string>>(new Set())
const compactionErrors = ref<Record<string, string>>({})
const queueOpen = ref(false)
const queueRestoring = ref(false)
const queueNotice = ref('')
let queueNoticeTimer = 0
const deliveryOpen = ref(false)
const workspaceBrowserOpen = ref(false)
const deliverables = ref<DeliverableDto[]>([])
const deliveryLoading = ref(false)
const deliveryListLoaded = ref(false)
const deliveryError = ref('')
const downloadingDeliveries = ref<Set<string>>(new Set())
const deliveryProgress = ref<Record<string, number>>({})
const openingDeliveryKey = ref('')
const downloadHistoryStorage = (() => {
  try { return window.localStorage } catch { return null }
})()
const downloadHistory = ref(readDownloadHistory(downloadHistoryStorage))
let deliveryLoadEpoch = 0
const restoredImageCounts = ref<Record<string, number>>({})
const clearingRestoredImages = ref(false)
const attachmentPicking = ref(false)
type UploadDraft = SelectedAttachment & { state: 'hashing' | 'uploading' | 'finalizing' | 'error'; progress: number; error?: string; target?: LocalAttachmentUpload }
const uploadDrafts = ref<UploadDraft[]>([])
const attachmentUploadAttempts = new Map<string, Promise<void>>()
let composerResetEpoch = 0
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
const deliveryTrayRef = ref<{ focusClear: () => void; focusClose: () => void } | null>(null)
const dockToolsTrigger = ref<HTMLButtonElement | null>(null)
const dockToolsPopoverStyle = ref<Record<string, string>>({})
const modalSurface = ref<HTMLElement | null>(null)
let modalTrigger: HTMLElement | null = null
const windowFocused = ref(!isTauri)
let windowFocusEpoch = 0
let windowsAwayId: string | null = null
const elapsedWindowsAwayIds = new Set<string>()
const followConnected = ref(false)
type ActiveFollow = ConnectionContext & { instanceId: string; subscriptionId: string }
const activeFollow = ref<ActiveFollow | null>(null)
const activeFollowSubscription = computed(() => activeFollow.value?.subscriptionId ?? '')
const pairHost = ref('')
const pairPort = ref<number | null>(null)
const maxMessageAttachments = computed(() => app.payload?.maxAttachmentsPerMessage ?? 0)
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
let androidNetworkRecoveryPending = false
let androidNetworkRecoveryTask: Promise<void> | null = null
let androidRouteRefreshPending = false
let reconnectTimer = 0
let conversationLoadEpoch = 0
const followActivation = new FollowActivationCoordinator()
const followConnectionTimers = new Map<string, number>()
const pendingFollowEvents = new Map<string, ProjectedEvent[]>()

function clearQueueNotice() {
  window.clearTimeout(queueNoticeTimer)
  queueNoticeTimer = 0
  queueNotice.value = ''
}

function showQueueNotice(text: string) {
  clearQueueNotice()
  queueNotice.value = text
  queueNoticeTimer = window.setTimeout(() => {
    queueNotice.value = ''
    queueNoticeTimer = 0
  }, 3_500)
}

const previewConversation: ConversationItem[] = [
  { id: 'u1', kind: 'user', text: '请结合这份发布检查清单确认 Linux 客户端。', time: '19:38', attachments: [{ fileId: '45c6f7e8-9462-4fde-8ab9-1829dff71234', name: 'Linux 发布检查清单.pdf', sizeBytes: 248320, mediaType: 'application/pdf', sha256: 'a'.repeat(64), storedAt: '2026-08-17T08:00:00.000Z' }] },
  {
    id: 'a1',
    kind: 'assistant',
    groupId: 'preview-assistant-1',
    text: '已完成连接检查，Work 列表和当前对话已准备好。',
    time: '19:41',
  },
  { id: 't1', kind: 'thinking', groupId: 'preview-assistant-tools', title: '检查顺序', text: '先确认连接状态和 Work 列表，再检查窄屏布局。', open: true, groupTime: '19:41' },
  { id: 'tool1', kind: 'tool', groupId: 'preview-assistant-tools', name: '检查工作列表', summary: '已读取 Work 列表', status: 'done', detail: '已找到 5 个 Work' },
  {
    id: 'a2',
    kind: 'assistant',
    groupId: 'preview-assistant-2',
    text: '连接中断后，当前消息和草稿仍会保留；恢复连接后会继续显示最新内容。',
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
const conversationContent = useConversationContent({
  compact: computed(() => !detailMode.value),
  native: isTauri,
  getEpoch: () => conversationLoadEpoch,
  getContext: () => requireConnectionContext(app),
  isCurrent: (context, state, epoch) => app.contextMatches(context)
    && conversationLoadEpoch === epoch
    && conversationContent.state.value === state
    && selected.value?.id === state.instance.id,
  reload: reloadConversationForHistory,
  beforeLayoutChange: conversationViewport.captureAnchor,
  afterLayoutChange: (snapshot, stickToBottom) => conversationViewport.restoreAnchor(snapshot as ConversationReadingAnchor | null, stickToBottom),
  isFollowing: conversationViewport.isFollowing,
  layoutChanged: conversationViewport.layoutChanged,
  projected: pruneImageResources,
})
const conversationState = conversationContent.state
const realConversation = conversationContent.items
const streamingPartIds = conversationContent.streamingPartIds
const historyTruncated = conversationContent.historyTruncated
const historyCursor = conversationContent.historyCursor
const historyLoading = conversationContent.historyLoading
const historyHydrationActiveEntries = conversationContent.hydrationActiveEntries
const historyHydrationErrors = conversationContent.hydrationErrors
const historyHydrating = conversationContent.historyHydrating
const historyError = conversationContent.historyError
const conversation = computed(() => (isTauri ? realConversation.value : previewConversation))
const queueItems = computed(() => isTauri ? conversationState.value?.queue ?? [] : previewQueue)
const selectedDockTools = computed(() => selected.value ? dockToolsState(selected.value.extensionStatus) : 'off')
const selectedDockToolsLabel = computed(() => selectedDockTools.value === 'on' ? 'ON' : selectedDockTools.value === 'unavailable' ? 'N/A' : 'OFF')
const dockToolsOpen = computed(() => commandOpen.value && controlSection.value === 'dock-tools')
const conversationSwitching = computed(() => Boolean(
  selected.value && conversationState.value && selected.value.id !== conversationState.value.instance.id,
))
const currentDeliverableRows = computed(() => {
  const context = app.connectionContext
  const instanceId = selected.value?.id
  if (!context || !instanceId) return []
  return deliverables.value.map((deliverable) => {
    const key = deliveryHistoryKey(context.connectionId, instanceId, deliverable.deliveryRef)
    return {
      deliverable,
      downloaded: downloadedDelivery(downloadHistory.value, context.connectionId, instanceId, deliverable.deliveryRef),
      downloading: downloadingDeliveries.value.has(key),
      progress: deliveryProgress.value[key] ?? 0,
    }
  })
})
const olderDownloadHistory = computed(() => {
  const context = app.connectionContext
  const instanceId = selected.value?.id
  if (!context || !instanceId) return downloadHistory.value.items
  return pastDownloadedDeliveries(
    downloadHistory.value,
    context.connectionId,
    instanceId,
    deliverables.value,
    deliveryListLoaded.value,
  )
})
const pendingDeliverableCount = computed(() => currentDeliverableRows.value.filter((row) => !row.downloaded).length)
function restoredImageKey(context: ConnectionContext, workId: string) {
  return JSON.stringify([context.connectionId, workId])
}
const restoredImageCount = computed({
  get: () => {
    const context = app.connectionContext
    const workId = selected.value?.id
    return context && workId ? restoredImageCounts.value[restoredImageKey(context, workId)] ?? 0 : 0
  },
  set: (value: number) => {
    const context = app.connectionContext
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
  || workMutating.value
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
const modalOpen = computed(() => workspaceBrowserOpen.value || deliveryOpen.value || directoryOpen.value || commandOpen.value || appSettingsOpen.value || hostSettingsOpen.value || composerExpanded.value || !!confirmDialog.value || !!imagePreview.value || !!messageTextView.value)

/* Android 返回键走 WebView 浏览历史（wry：canGoBack→goBack，否则退出 app）。
   浮层/抽屉打开时压入一个占位历史条目，返回键触发 popstate 时关闭最上层；
   通过 ×/Esc/背景手动关闭时用 history.back() 同步消费占位，避免下一次返回键落空。 */
const backLayerOpen = computed(() => modalOpen.value || app.workDrawerOpen)
let backLayerArmed = false
let backLayerPopClosing = false
let backLayerConsumingManualClose = false
watch(backLayerOpen, (open, wasOpen) => {
  if (open && !wasOpen && !backLayerPopClosing) {
    window.history.pushState({ aluLayer: true }, '')
    backLayerArmed = true
  } else if (!open && wasOpen && backLayerArmed && !backLayerPopClosing) {
    backLayerArmed = false
    backLayerConsumingManualClose = true
    window.history.back()
  } else if (!open && wasOpen) {
    backLayerArmed = false
  }
})

function handlePopstate() {
  if (backLayerConsumingManualClose) {
    backLayerConsumingManualClose = false
    return
  }
  if (!backLayerOpen.value) return
  if (directoryOpen.value && newWorkMutationBusy.value) {
    window.history.pushState({ aluLayer: true }, '')
    backLayerArmed = true
    return
  }
  backLayerPopClosing = true
  backLayerArmed = false
  if (confirmDialog.value) settleConfirm(false)
  else {
    closeModal()
    app.workDrawerOpen = false
  }
  void nextTick(() => { backLayerPopClosing = false })
}
const modelLabel = computed(() => {
  const model = selected.value?.executor.model
  return model ? `${model.provider}/${model.id}` : '—'
})
const contextPercent = computed(() => selected.value?.metrics?.context?.percent)
const selectedCompactionPending = computed(() => !!selected.value && compactionWorkIds.value.has(selected.value.id))
const currentCompactionError = computed(() => {
  const connectionId = app.activeConnectionId
  const workId = selected.value?.id
  return connectionId && workId ? compactionErrors.value[compactionErrorKey(connectionId, workId)] ?? null : null
})
const visibleComposerError = computed(() => submissionError.value || currentCompactionError.value)
const recoverablePairings = computed(() => app.catalog?.pairingTransactions ?? [])

const windowsAwayLabel = computed(() => ({
  immediate: '立即暂离',
  one_minute: '1 分钟后暂离',
  five_minutes: '5 分钟后暂离',
  thirty_minutes: '30 分钟后暂离',
  one_hour: '1 小时后暂离',
  never: '切到其他窗口时不暂离',
} as Record<WindowsAwayDelay, string>)[appSettings.value?.windowsAwayDelay ?? 'one_minute'])

const connectionLabel = computed(() => {
  if (!isTauri) return '浏览器预览'
  if (app.error) return '连接异常'
  if (app.loading) return '正在连接'
  if (app.payload && selected.value?.lifecycle === 'active') return followConnected.value ? '已连接' : '正在连接'
  return app.payload ? 'Dock 已连接' : '等待连接'
})

watch(draft, () => void nextTick(resizeComposer))
watch(composerExpanded, () => void nextTick(resizeComposer))

/* ── 输入框斜杠命令建议 ────────────────────────────────
 * pi 只展开位于消息最开头的 /command，因此建议仅在整段草稿
 * 就是一个未完成命令 token 时出现；补全后尾部空格进入参数输入。
 */
type ComposerCommandSuggestion =
  | { kind: 'local'; name: string; description: string; sourceLabel: string }
  | { kind: 'catalog'; name: string; description?: string; argumentHint?: string; sourceLabel: string; command: CommandInfo }
  | { kind: 'argument'; name: string; description?: string; sourceLabel: string; value: string; commandName: string }

const suggestIndex = ref(0)
const suggestDismissedFor = ref('')
const slashQuery = computed(() => slashCommandQuery(draft.value))
const composerArgumentContext = computed(() => slashArgumentContext(draft.value))
const composerArgumentCommand = computed(() => {
  const context = composerArgumentContext.value
  if (!context || localControlCommands.some((command) => command.name === context.name)) return null
  const matching = commandCatalogStore.commands.filter((command) => command.name === context.name)
  return matching.length === 1 && matching[0]?.argumentCompletions ? matching[0] : null
})
const composerArgumentItems = ref<CommandArgumentCompletion[]>([])
const composerArgumentLoading = ref(false)
let composerCompletionTimer = 0
let composerCompletionEpoch = 0

const commandSuggestItems = computed<ComposerCommandSuggestion[]>(() => {
  const query = slashQuery.value
  if (query === null) return []
  const local = filterLocalControlCommands(query).map((command) => ({
    kind: 'local' as const,
    name: command.name,
    description: command.description,
    sourceLabel: '客户端操作',
  }))
  const localNames = new Set(localControlCommands.map((command) => command.name))
  const catalog = filterCatalogCommands(commandCatalogStore.commands.filter((command) => !localNames.has(command.name)), query).map((command) => ({
    kind: 'catalog' as const,
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    sourceLabel: catalogSourceLabel(command.source.kind),
    command,
  }))
  return [...local, ...catalog].slice(0, 8)
})
const argumentSuggestItems = computed<ComposerCommandSuggestion[]>(() => {
  const context = composerArgumentContext.value
  if (!context || !composerArgumentCommand.value) return []
  return composerArgumentItems.value.slice(0, 8).map((item) => ({
    kind: 'argument' as const,
    name: item.label,
    description: item.description,
    sourceLabel: '参数',
    value: item.value,
    commandName: context.name,
  }))
})
const suggestItems = computed(() => slashQuery.value !== null ? commandSuggestItems.value : argumentSuggestItems.value)
const suggestOpen = computed(() => !!selected.value
  && selected.value.lifecycle === 'active'
  && !conversationLoading.value
  && !composerExpanded.value
  && (slashQuery.value !== null || composerArgumentLoading.value || argumentSuggestItems.value.length > 0)
  && suggestDismissedFor.value !== draft.value)
watch(slashQuery, (query) => {
  suggestIndex.value = 0
  if (query !== null) ensureCommandCatalog()
})
watch(composerArgumentContext, (context) => {
  suggestIndex.value = 0
  if (context) ensureCommandCatalog()
})
watch([composerArgumentContext, composerArgumentCommand], () => scheduleComposerArgumentCompletions())
watch(suggestItems, (items) => {
  suggestIndex.value = Math.max(0, Math.min(suggestIndex.value, items.length - 1))
})
watch(suggestIndex, async () => {
  await nextTick()
  document.getElementById(`cmd-suggest-${suggestIndex.value}`)?.scrollIntoView({ block: 'nearest' })
})

function ensureCommandCatalog() {
  if (!selected.value) return
  try {
    void commandCatalogStore.ensure(selected.value, requireConnectionContext(app))
  } catch {
    // Host 上下文不可用时建议列表保持空，不打扰输入
  }
}

function completeSuggest(item?: ComposerCommandSuggestion) {
  const picked = item ?? suggestItems.value[suggestIndex.value]
  if (!picked) return
  draft.value = picked.kind === 'argument'
    ? applySlashArgumentCompletion(picked.commandName, picked.value)
    : applySlashCompletion(picked.name)
  if (picked.kind === 'argument') suggestDismissedFor.value = draft.value
  suggestIndex.value = 0
  void nextTick(() => {
    const textarea = composerTextarea.value
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  })
}

function scheduleComposerArgumentCompletions() {
  window.clearTimeout(composerCompletionTimer)
  const context = composerArgumentContext.value
  const command = composerArgumentCommand.value
  if (!context || !command) {
    composerCompletionEpoch += 1
    composerArgumentItems.value = []
    composerArgumentLoading.value = false
    return
  }
  const epoch = ++composerCompletionEpoch
  const prefix = context.prefix
  composerArgumentLoading.value = true
  composerCompletionTimer = window.setTimeout(async () => {
    const work = selected.value
    if (!work) return
    try {
      const result = await currentConnectionCall(app, (host) => getCommandCompletions(work.id, command.referenceId, prefix, host))
      const current = composerArgumentContext.value
      if (epoch !== composerCompletionEpoch || selected.value?.id !== work.id || composerArgumentCommand.value?.referenceId !== command.referenceId || current?.prefix !== prefix) return
      composerArgumentItems.value = result.referenceId === command.referenceId ? result.items ?? [] : []
    } catch {
      if (epoch === composerCompletionEpoch) composerArgumentItems.value = []
    } finally {
      if (epoch === composerCompletionEpoch) composerArgumentLoading.value = false
    }
  }, 160)
}

/** 命令面板里选中 prompt/skill 命令：它们本质是发一条消息，填回输入框交回对话。
 *  焦点走 modal 关闭时的 trigger 归位通道，避免和归位逻辑抢时序。 */
function prefillSlashCommand(name: string) {
  draft.value = prefixSlashCommand(name, draft.value)
  modalTrigger = composerTextarea.value
  commandOpen.value = false
  void nextTick(() => {
    const textarea = composerTextarea.value
    if (!textarea) return
    window.setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    }, 0)
  })
}
watch(detailMode, () => {
  if (conversationState.value) conversationContent.reproject(conversationState.value)
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
watch(() => app.workDrawerOpen, (open, wasOpen) => {
  if (open) {
    deliveryOpen.value = false
    workspaceBrowserOpen.value = false
  }
  if (open && !wasOpen) {
    void app.refreshWorksQuietly()
    void refreshHostMachinesQuietly()
  }
})
watch(
  () => [app.activeConnectionId, app.connectionContext?.selectionGeneration] as const,
  () => {
    ++machineLoadEpoch
    hostMachines.value = []
    directoryOpen.value = false
    machineListError.value = ''
    if (app.workDrawerOpen) void refreshHostMachinesQuietly()
  },
)
watch([
  () => app.activeConnectionId,
  () => app.connectionContext?.selectionGeneration,
  () => selected.value?.id,
  () => selected.value?.ownerHostEpoch,
  () => selected.value?.runtimeGeneration,
], () => {
  const context = app.connectionContext
  const work = selected.value
  if (context && work) commandConsole.bindContext(context.connectionId, context.selectionGeneration, work)
}, { immediate: true })
watch(
  () => [app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id, selected.value?.execution] as const,
  (current, previous) => {
    if (!previous) return
    const sameWork = current[0] === previous[0] && current[1] === previous[1] && current[2] === previous[2]
    if (sameWork && previous[3] === 'running' && current[3] !== 'running') void refreshDeliverables()
  },
)
watch(confirmDialog, async (dialog) => {
  if (!dialog) return
  await nextTick()
  modalSurface.value?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled)')?.focus()
})
watch(controlSection, async () => {
  if (!commandOpen.value) return
  await nextTick()
  const surface = modalSurface.value
  const initial = surface?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled), [autofocus]:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
    ?? surface?.querySelector<HTMLElement>('button:not(:disabled)')
  if (initial) initial.focus()
  else surface?.focus()
})
watch(modalOpen, async (open, wasOpen) => {
  if (open && !wasOpen) {
    await nextTick()
    const surface = modalSurface.value
    const initial = surface?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled), [autofocus]:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
      ?? surface?.querySelector<HTMLElement>('button:not(:disabled)')
    if (initial) initial.focus()
    else surface?.focus()
  } else if (!open && wasOpen) {
    const trigger = modalTrigger
    modalTrigger = null
    await nextTick()
    window.requestAnimationFrame(() => {
      if (!modalOpen.value && trigger?.isConnected) trigger.focus({ preventScroll: true })
    })
  }
})
let transientContext: (ConnectionContext & { workId: string }) | null = null
let transientHostBoundary: ConnectionContext | null = null
watch(
  () => conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id),
  () => {
    const connectionId = app.activeConnectionId
    const generation = app.connectionContext?.selectionGeneration
    const id = selected.value?.id
    const previous = transientContext
    const connectionChanged = transientHostBoundary && transientHostBoundary.connectionId !== connectionId
    const contextChanged = previous && (previous.connectionId !== connectionId || previous.selectionGeneration !== generation || previous.workId !== id)
    if (contextChanged) {
      for (const item of uploadDrafts.value) void removeAttachment(previous.workId, item.token, previous).catch(() => undefined)
      uploadDrafts.value = []
      clearQueueNotice()
      queueOpen.value = false
      submissionError.value = null
      resetConversationImages()
      resetAttachmentPreviews()
      conversationContent.resetProjectionSchedule()
      resetOutputFollow()
      messageTextView.value = null
      commandCatalogStore.invalidate()
    }
    if (connectionChanged) restoredImageCounts.value = {}
    transientHostBoundary = connectionId && generation != null ? { connectionId, selectionGeneration: generation } : null
    transientContext = connectionId && generation != null && id ? { connectionId, selectionGeneration: generation, workId: id } : null
    ++conversationLoadEpoch
    resetHistoryHydration()
    ++deliveryLoadEpoch
    deliverables.value = []
    deliveryListLoaded.value = false
    deliveryError.value = ''
    if (id) void refreshDeliverables()
    if (isTauri && windowFocused.value && id) void loadSelectedConversation(id)
    else if (!id) void extensionUi.clear()
    void nextTick(resizeComposer)
  },
)

watch(
  () => {
    const work = selected.value
    const context = app.connectionContext
    return work && context ? JSON.stringify(attachmentUploadTarget(work, context)) : ''
  },
  async (targetKey, previousTargetKey) => {
    if (!targetKey || targetKey === previousTargetKey) return
    const work = selected.value
    const context = app.connectionContext
    if (!work || !context) return
    const target = attachmentUploadTarget(work, context)
    const stalePending = uploadDrafts.value.filter((item) => item.target && !attachmentUploadMatches(item.target, target))
    const staleAttempts = stalePending.map((item) => attachmentUploadAttempts.get(item.token)).filter((attempt): attempt is Promise<void> => !!attempt)
    if (stalePending.length) {
      composerResetEpoch += 1
      await Promise.all(stalePending.map((item) => cancelAttachmentUpload(work.id, item.token, context).catch(() => false)))
      await Promise.allSettled(staleAttempts)
    }
    const currentWork = selected.value
    const currentHost = app.connectionContext
    if (!currentWork || !currentHost || JSON.stringify(attachmentUploadTarget(currentWork, currentHost)) !== targetKey) return

    const retained: AttachmentDto[] = []
    const retryByToken = new Map(uploadDrafts.value.map((item) => [item.token, item]))
    let sourceWasLost = false
    for (const attachment of draftAttachments.value) {
      if (!attachment.localUpload || attachmentUploadMatches(attachment.localUpload, target)) {
        retained.push(attachment)
        continue
      }
      const token = attachment.localUpload.sourceToken
      if (!token) {
        sourceWasLost = true
        removeAttachmentPreview(attachment.fileId)
        continue
      }
      moveAttachmentPreview(attachment.fileId, token)
      if (!retryByToken.has(token)) {
        retryByToken.set(token, {
          token,
          name: attachment.name,
          sizeBytes: attachment.sizeBytes,
          mediaType: attachment.mediaType,
          state: 'hashing',
          progress: 0,
        })
      }
    }
    draftAttachments.value = retained
    uploadDrafts.value = [...retryByToken.values()]
    if (sourceWasLost) submissionError.value = '工作上下文已更新；请重新选择之前上传的附件。'
    for (const item of uploadDrafts.value) {
      if (!item.target || !attachmentUploadMatches(item.target, target)) void launchAttachmentUpload(item)
    }
  },
  { immediate: true },
)

async function retryDesktopHost() {
  if (desktopShellBusy.value) return
  desktopShellBusy.value = true
  try {
    desktopShell.value = await startDesktopHost()
    if (desktopShell.value.hostReady && desktopShell.value.role === 'main') await app.load()
  } catch (cause) {
    desktopShell.value = {
      supported: true,
      hostReady: false,
      startupError: errorMessage(cause),
      loginStartEnabled: desktopShell.value?.loginStartEnabled ?? false,
    }
  } finally {
    desktopShellBusy.value = false
  }
}

async function runDesktopShellAction(action: () => Promise<void>) {
  try {
    await action()
  } catch (cause) {
    if (desktopShell.value) desktopShell.value = { ...desktopShell.value, startupError: errorMessage(cause) }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalModalKeydown, true)
  window.addEventListener('keydown', handleDesktopShortcut)
  window.addEventListener('popstate', handlePopstate)
  window.addEventListener('focus', handleWebViewFocus)
  window.addEventListener('resize', positionDockToolsPopover)
  if (isAndroidWebView) {
    window.addEventListener('aludock:network-changed', handleAndroidNetworkChanged)
    document.documentElement.dataset.aludockNetworkReady = 'true'
  }
  try {
    appSettings.value = await getClientPreferences()
  } catch (cause) {
    console.error('Failed to read App settings.', cause)
  }
  if (isTauri) {
    desktopShell.value = await getDesktopShellStatus()
    const appWindow = getCurrentWindow()
    unlisteners.push(
      await listen<DesktopShellStatus>('desktop-shell-changed', ({ payload }) => {
        desktopShell.value = payload
        if (payload.hostReady && payload.role === 'main') void app.load()
      }),
      await appWindow.onFocusChanged(({ payload }) => { void handleWindowFocusChanged(payload) }),
    )
    windowFocused.value = initialWindowFocused(
      await appWindow.isFocused(),
      document.hasFocus(),
      isAndroidWebView && document.visibilityState === 'visible',
    )
    unlisteners.push(
      await listen<{ awayId: string }>('aludock://windows-away-elapsed', ({ payload }) => {
        if (windowFocused.value) return
        if (payload.awayId === windowsAwayId) void detachConversationFollow()
        else elapsedWindowsAwayIds.add(payload.awayId)
      }),
      await listen<{ connectionId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; event: ProjectedEvent }>('aludock://conversation-event', async ({ payload }) => {
        if (!app.contextMatches(payload) || payload.instanceId !== selected.value?.id) return
        const pending = pendingFollowEvents.get(payload.subscriptionId)
        if (pending) {
          pending.push(payload.event)
          return
        }
        if (payload.subscriptionId !== activeFollowSubscription.value) return
        await applyFollowEvent(payload)
      }),
      await listen<{ connectionId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; state: FollowConnectionState; message?: string }>('aludock://follow-status', ({ payload }) => {
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
        const progressTarget: LocalAttachmentUpload = {
          connectionId: payload.connectionId,
          selectionGeneration: payload.selectionGeneration,
          instanceId: payload.workId,
          machineHostId: payload.machineHostId,
          ownerHostEpoch: payload.ownerHostEpoch,
          runtimeGeneration: payload.runtimeGeneration,
        }
        if (!item || !attachmentUploadMatches(item.target, progressTarget)) return
        item.state = payload.phase
        item.progress = payload.totalBytes > 0 ? payload.bytesProcessed / payload.totalBytes : payload.phase === 'finalizing' ? 1 : 0
      }),
      await listen<DeliverableDownloadProgress>('aludock://deliverable-progress', ({ payload }) => {
        const key = deliveryHistoryKey(payload.connectionId, payload.instanceId, payload.deliveryRef)
        if (!downloadingDeliveries.value.has(key)) return
        deliveryProgress.value = {
          ...deliveryProgress.value,
          [key]: payload.totalBytes > 0 ? Math.min(1, payload.bytesReceived / payload.totalBytes) : 0,
        }
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
    if (!windowFocused.value && appSettings.value?.windowsAwaySupported) {
      try {
        windowsAwayId = await beginWindowsAway(runningWorkIdsForAway())
        if (windowsAwayId && elapsedWindowsAwayIds.delete(windowsAwayId)) await detachConversationFollow()
      } catch (cause) {
        console.error('Failed to begin initial Windows away period.', cause)
      }
    }
  }
  await app.load()
  await nextTick()
  if (isTauri) {
    const focusedAfterLoad = initialWindowFocused(
      await getCurrentWindow().isFocused(),
      document.hasFocus(),
      isAndroidWebView && document.visibilityState === 'visible',
    )
    if (focusedAfterLoad) await handleWindowFocusChanged(true)
  }
  await initializePairDeviceName()
  if (!app.needsPairing) app.workDrawerOpen = !app.selectedWork
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalModalKeydown, true)
  window.removeEventListener('keydown', handleDesktopShortcut)
  window.removeEventListener('popstate', handlePopstate)
  window.removeEventListener('focus', handleWebViewFocus)
  window.removeEventListener('resize', positionDockToolsPopover)
  if (isAndroidWebView) {
    window.removeEventListener('aludock:network-changed', handleAndroidNetworkChanged)
    delete document.documentElement.dataset.aludockNetworkReady
  }
  unlisteners.forEach((unlisten) => unlisten())
  window.clearTimeout(reconnectTimer)
  window.clearTimeout(composerCompletionTimer)
  clearQueueNotice()
  for (const timer of followConnectionTimers.values()) window.clearTimeout(timer)
  followConnectionTimers.clear()
  followActivation.cancelAll(new Error('界面已关闭。'))
  pendingFollowEvents.clear()
  elapsedWindowsAwayIds.clear()
  if (appSettings.value?.windowsAwaySupported) void cancelWindowsAway(windowsAwayId)
  conversationContent.dispose()
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

function workGroup(work: Work) {
  if (work.lifecycle === 'active' || work.lifecycle === 'stopping') return 'current'
  if (work.reopenable) return 'continue'
  return 'history'
}

const groupedWorks = computed(() => ({
  current: app.works.filter((work) => workGroup(work) === 'current'),
  continue: app.works.filter((work) => workGroup(work) === 'continue'),
  history: app.works.filter((work) => workGroup(work) === 'history'),
}))

function workMachineTag(work: Work) {
  return subhostMachineName(hostMachines.value, work.hostId)
}

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

function openWorkspaceBrowser() {
  if (!selected.value || selected.value.lifecycle !== 'active') return
  rememberModalTrigger()
  deliveryOpen.value = false
  app.workDrawerOpen = false
  workspaceBrowserOpen.value = true
}

function openDeliveryTray() {
  rememberModalTrigger()
  app.workDrawerOpen = false
  deliveryOpen.value = true
  void refreshDeliverables()
}

async function refreshDeliverables() {
  const context = app.connectionContext
  const instanceId = selected.value?.id
  if (!context || !instanceId) {
    deliverables.value = []
    deliveryLoading.value = false
    deliveryListLoaded.value = false
    return
  }
  const epoch = ++deliveryLoadEpoch
  deliveryLoading.value = true
  deliveryError.value = ''
  try {
    const items = await listDeliverables(instanceId, context)
    if (epoch !== deliveryLoadEpoch || !app.contextMatches(context) || selected.value?.id !== instanceId) return
    deliverables.value = items
    deliveryListLoaded.value = true
  } catch (cause) {
    if (epoch !== deliveryLoadEpoch || !app.contextMatches(context) || selected.value?.id !== instanceId) return
    deliveryError.value = errorMessage(cause, '无法加载当前 Work 的文件。请检查连接后重试。')
  } finally {
    if (epoch === deliveryLoadEpoch) deliveryLoading.value = false
  }
}

async function saveDeliverable(deliverable: DeliverableDto, redownload = false) {
  const context = app.connectionContext
  const work = selected.value
  if (!context || !work) return
  const existing = downloadedDelivery(downloadHistory.value, context.connectionId, work.id, deliverable.deliveryRef)
  if (existing && !redownload) {
    await openDownloadedDeliverable(existing)
    return
  }
  const key = deliveryHistoryKey(context.connectionId, work.id, deliverable.deliveryRef)
  if (downloadingDeliveries.value.has(key)) return
  downloadingDeliveries.value = new Set(downloadingDeliveries.value).add(key)
  deliveryProgress.value = { ...deliveryProgress.value, [key]: 0 }
  deliveryError.value = ''
  try {
    const result = await downloadDeliverable(work.id, deliverable, context)
    if (result.status === 'cancelled') return
    const next = recordDownloadedDelivery(downloadHistory.value, {
      connectionId: context.connectionId,
      instanceId: work.id,
      deliveryRef: result.deliverable.deliveryRef,
      name: result.deliverable.name,
      sizeBytes: result.deliverable.sizeBytes,
      savedLocation: result.location,
      downloadedAt: new Date().toISOString(),
      sha256: result.sha256,
      workName: work.displayName,
    })
    const persisted = persistDownloadHistory(downloadHistoryStorage, next)
    downloadHistory.value = next
    if (!persisted) deliveryError.value = '文件已保存，但下载记录未能更新。下次打开客户端时可能仍显示“下载”。'
  } catch (cause) {
    deliveryError.value = errorMessage(cause, '文件没有下载完成，请重试。')
  } finally {
    const pending = new Set(downloadingDeliveries.value)
    pending.delete(key)
    downloadingDeliveries.value = pending
    const progress = { ...deliveryProgress.value }
    delete progress[key]
    deliveryProgress.value = progress
  }
}

async function openDownloadedDeliverable(item: DownloadedDeliverable) {
  const key = deliveryHistoryKey(item.connectionId, item.instanceId, item.deliveryRef)
  if (openingDeliveryKey.value) return
  openingDeliveryKey.value = key
  deliveryError.value = ''
  try {
    await openSavedDeliverable(item.savedLocation)
  } catch (cause) {
    const fallback = item.savedLocation.kind === 'path'
      ? '暂时无法打开保存位置。请稍后重试。'
      : '暂时无法打开这个文件。请稍后重试。'
    deliveryError.value = errorMessage(cause, fallback)
  } finally {
    if (openingDeliveryKey.value === key) openingDeliveryKey.value = ''
  }
}

async function clearLocalDownloadHistory() {
  if (!olderDownloadHistory.value.length) return
  const confirmed = await askConfirm('清空过去的下载记录？', '这些记录将从列表移除。已保存的文件保留在原位置。')
  await nextTick()
  if (!confirmed) {
    deliveryTrayRef.value?.focusClear()
    return
  }
  const next = removeDownloadedDeliveries(downloadHistory.value, olderDownloadHistory.value)
  if (!persistDownloadHistory(downloadHistoryStorage, next)) {
    deliveryError.value = '下载记录未能清空，请重试。'
    deliveryTrayRef.value?.focusClear()
    return
  }
  downloadHistory.value = next
  deliveryError.value = ''
  await nextTick()
  deliveryTrayRef.value?.focusClose()
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
  if (directoryOpen.value && newWorkMutationBusy.value) return
  workspaceBrowserOpen.value = false
  deliveryOpen.value = false
  directoryOpen.value = false
  commandOpen.value = false
  appSettingsOpen.value = false
  hostSettingsOpen.value = false
  composerExpanded.value = false
  const closedConversationPreview = imagePreview.value?.kind === 'conversation'
  imagePreview.value = null
  if (closedConversationPreview) enforceConversationImageCacheBudget()
  messageTextView.value = null
  imageSaving.value = false
  imageSaveStatus.value = null
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
  if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (selected.value?.execution !== 'running') return
    event.preventDefault()
    void abortCurrentRun()
    return
  }
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

/** 命令面板点背景不关闭（防止写一半的命令误点丢失），但给一个明确的"收到但不关"反馈。 */
function pulseCommandPalette() {
  if (controlSection.value !== 'commands') return
  const box = modalSurface.value
  if (!box) return
  box.classList.remove('cmd-palette-attention')
  void box.offsetWidth
  box.classList.add('cmd-palette-attention')
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
    commands: '命令中心', 'dock-tools': 'Dock Tools', sessions: '恢复 Session', tree: 'Session Tree', 'new-session': 'New Session',
    'rename-session': '会话名称', 'compact-session': 'Compact Context', 'reload-session': 'Reload Session',
    models: '选择 Model', thinking: 'Thinking Level', tools: 'Active Tools', resources: '项目状态', settings: '设置',
  } as Record<ControlSection, string>)[section]
}

function controlDialogBody(section: ControlSection) {
  if (section === 'models') return `当前：${modelLabel.value}`
  if (section === 'dock-tools') return '当前 Work 可以交给 Agent 使用的 Dock 能力'
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
  appSettingsOpen.value = false
  hostSettingsOpen.value = false
  app.workDrawerOpen = false
}

function positionDockToolsPopover() {
  if (!dockToolsOpen.value && controlSection.value !== 'dock-tools') return
  const trigger = dockToolsTrigger.value
  if (!trigger) return
  const bounds = trigger.getBoundingClientRect()
  dockToolsPopoverStyle.value = {
    '--dock-tools-popover-top': `${Math.round(bounds.bottom + 8)}px`,
    '--dock-tools-popover-right': `${Math.max(12, Math.round(window.innerWidth - bounds.right))}px`,
  }
}

function openDockTools() {
  if (dockToolsOpen.value) {
    closeModal()
    return
  }
  openControlCenter('dock-tools')
  positionDockToolsPopover()
}

function applyAuthoritativeWorkSnapshot(snapshot: Work): Work {
  app.applyWorkSnapshot(snapshot)
  const authoritative = app.works.find((work) => work.id === snapshot.id) ?? snapshot
  extensionUi.applyAuthoritativeSnapshot(authoritative)
  return authoritative
}

function applyControlSnapshot(snapshot: Work) {
  applyAuthoritativeWorkSnapshot(snapshot)
}

function openAppSettings() {
  if (!appSettings.value?.windowsAwaySupported) return
  rememberModalTrigger()
  appSettingsError.value = ''
  appSettingsOpen.value = true
  hostSettingsOpen.value = false
  directoryOpen.value = false
  commandOpen.value = false
  app.workDrawerOpen = false
}

async function chooseWindowsAwayDelay(delay: WindowsAwayDelay) {
  const current = appSettings.value
  if (!current || current.windowsAwayDelay === delay || appSettingsSaving.value) return
  appSettingsSaving.value = true
  appSettingsError.value = ''
  try {
    appSettings.value = await updateClientPreferences(current.revision, delay)
  } catch (cause) {
    appSettingsError.value = errorMessage(cause)
    try {
      appSettings.value = await getClientPreferences()
    } catch {
      // The visible save error remains the useful next action.
    }
  } finally {
    appSettingsSaving.value = false
  }
}

function openHostSettings() {
  rememberModalTrigger()
  hostSettingsOpen.value = true
  appSettingsOpen.value = false
  addingHost.value = false
  endpointFormOpen.value = false
  directoryOpen.value = false
  commandOpen.value = false
  app.workDrawerOpen = false
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
  if (!isTauri || hostId === app.activeConnectionId || contextTransitionBusy.value || !await confirmRestoredImagesBeforeHostTransition()) return
  await extensionUi.clear()
  closeModal()
  await app.switchHost(hostId)
}

async function connectLocal() {
  if (!isTauri || app.loading || contextTransitionBusy.value || !await confirmRestoredImagesBeforeHostTransition()) return
  await extensionUi.clear()
  await app.connectLocal()
  if (!app.error) {
    addingHost.value = false
    endpointFormOpen.value = false
    hostDisplayName.value = app.activeHost?.displayName ?? ''
  }
}

async function updateLocalEndpoint(endpoint?: string) {
  if (!isTauri || contextTransitionBusy.value) return
  await app.saveLocalEndpoint(endpoint)
}

async function removeSavedHost(hostId: string, displayName: string) {
  if (!isTauri || contextTransitionBusy.value) return
  const imageWarning = hasRestoredImageDrafts.value && hostId === app.activeConnectionId ? '\n\n已取回但尚未发送的附件也会从本机草稿中移除。' : ''
  const body = `这台 Host 会从此设备的列表中移除。电脑端仍会保留此设备的访问权限；如需一并撤销，请在电脑上的 AluDock 管理界面完成。以后从此设备连接需要重新配对。${imageWarning}`
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
    if (app.contextMatches(context)) await reconnectThroughPreferredRoute(context)
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
  if (!await askConfirm(`删除连接地址“${label}”？`, '操作后仍须保留至少一个已启用、已验证的地址。')) return
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
  const moved = moveAttachmentPreviewResource(attachmentPreviews.value, from, to)
  if (!moved.moved) return
  if (moved.replaced && moved.replaced.url !== moved.moved.url) URL.revokeObjectURL(moved.replaced.url)
  attachmentPreviews.value = moved.resources
  if (imagePreview.value?.kind === 'attachment' && imagePreview.value.attachmentKey === from) {
    imagePreview.value = { ...imagePreview.value, attachmentKey: to }
  }
}

function resetAttachmentPreviews() {
  for (const resource of Object.values(attachmentPreviews.value)) URL.revokeObjectURL(resource.url)
  attachmentPreviews.value = {}
  if (imagePreview.value?.kind === 'attachment') imagePreview.value = null
}

function openMessageText(title: string, text: string, markdown = false) {
  if (!text) return
  rememberModalTrigger()
  messageTextView.value = { title, text, markdown }
}

function showImagePreview(preview: ImagePreview) {
  rememberModalTrigger()
  imageSaving.value = false
  imageSaveStatus.value = null
  imagePreview.value = preview
}

function openAttachmentPreview(key: string, name: string) {
  const resource = attachmentPreviews.value[key]
  if (!resource) return
  showImagePreview({
    kind: 'attachment',
    attachmentKey: key,
    url: resource.url,
    name: name.replace(/[\\/]/g, '_'),
  })
}

function attachmentCanPreview(mediaType?: string) {
  return !!mediaType && isRasterImageMimeType(mediaType)
}

async function prepareAttachmentPreview(item: UploadDraft, workId: string, context: ConnectionContext) {
  if (!attachmentCanPreview(item.mediaType) || attachmentPreviews.value[item.token]) return
  try {
    const bytes = await loadAttachmentPreviewBytes(workId, item.token, context)
    if (!app.contextMatches(context) || selected.value?.id !== workId || !uploadDrafts.value.some((candidate) => candidate.token === item.token)) return
    const detectedMediaType = rasterImageMimeType(bytes)
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

async function startAttachmentUploadWithPreview(item: UploadDraft, workId: string, context: ConnectionContext) {
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
  const available = maxMessageAttachments.value - draftAttachments.value.length - uploadDrafts.value.length
  if (images.length > available) {
    submissionError.value = available > 0 ? `本条消息还可以添加 ${available} 个附件。` : `一条消息最多可附加 ${maxMessageAttachments.value} 个文件。`
    return
  }
  const context = requireConnectionContext(app)
  const resetEpoch = composerResetEpoch
  const staged: UploadDraft[] = []
  attachmentPicking.value = true
  submissionError.value = null
  try {
    for (const [index, file] of images.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const mediaType = rasterImageMimeType(bytes)
      if (!mediaType) throw new Error('剪贴板图片不是可用的 PNG、JPEG、GIF 或 WebP 格式。')
      const selectedAttachment = await stageClipboardImage(work.id, bytes, index + 1, context)
      const draftItem: UploadDraft = { ...selectedAttachment, state: 'hashing', progress: 0 }
      staged.push(draftItem)
      if (!app.contextMatches(context) || selected.value?.id !== work.id || resetEpoch !== composerResetEpoch) throw new Error('stale_attachment_context')
      if (selectedAttachment.mediaType !== mediaType) throw new Error('剪贴板图片格式校验失败，请重新复制。')
      const blobBytes = new Uint8Array(bytes.byteLength)
      blobBytes.set(bytes)
      setAttachmentPreview(draftItem.token, {
        mediaType,
        url: URL.createObjectURL(new Blob([blobBytes.buffer], { type: mediaType })),
      })
    }
    uploadDrafts.value.push(...staged)
    for (const item of staged) void launchAttachmentUpload(item)
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
  const available = maxMessageAttachments.value - draftAttachments.value.length - uploadDrafts.value.length
  if (available <= 0) {
    submissionError.value = draftAttachments.value.length > maxMessageAttachments.value
      ? 'Queue 取回的附件需要分批发送，发完一批后才能继续添加。'
      : `一条消息最多可附加 ${maxMessageAttachments.value} 个文件。`
    return
  }
  submissionError.value = null
  attachmentPicking.value = true
  try {
    const context = requireConnectionContext(app)
    const resetEpoch = composerResetEpoch
    const picked = await pickAttachments(work.id, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id || resetEpoch !== composerResetEpoch) {
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
    for (const item of drafts) void launchAttachmentUpload(item, true, work.id, context)
  } catch (cause) {
    submissionError.value = errorMessage(cause)
  } finally {
    attachmentPicking.value = false
  }
}

function launchAttachmentUpload(item: UploadDraft, withPreview = false, workId?: string, context?: ConnectionContext) {
  const active = attachmentUploadAttempts.get(item.token)
  if (active) return active
  const attempt = (withPreview && workId && context
    ? startAttachmentUploadWithPreview(item, workId, context)
    : startAttachmentUpload(item))
    .finally(() => {
      if (attachmentUploadAttempts.get(item.token) === attempt) attachmentUploadAttempts.delete(item.token)
    })
  attachmentUploadAttempts.set(item.token, attempt)
  return attempt
}

async function startAttachmentUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  const context = requireConnectionContext(app)
  const target = attachmentUploadTarget(work, context)
  const resetEpoch = composerResetEpoch
  item.target = target
  item.state = 'hashing'
  item.progress = 0
  item.error = undefined
  try {
    const result = await uploadAttachment(work, item.token, context)
    const currentWork = selected.value
    const currentHost = app.connectionContext
    const targetStillCurrent = !!currentWork && !!currentHost && attachmentUploadMatches(target, attachmentUploadTarget(currentWork, currentHost))
    if (!targetStillCurrent || resetEpoch !== composerResetEpoch || !uploadDrafts.value.some((candidate) => candidate.token === item.token)) return
    moveAttachmentPreview(item.token, result.attachment.fileId)
    uploadDrafts.value = uploadDrafts.value.filter((candidate) => candidate.token !== item.token)
    const bound = bindLocalAttachment(result.attachment, item.token, target)
    draftAttachments.value = [...draftAttachments.value.filter((candidate) => candidate.fileId !== bound.fileId), bound]
  } catch (cause) {
    const currentWork = selected.value
    const currentHost = app.connectionContext
    if (!currentWork
      || !currentHost
      || !app.contextMatches(context)
      || currentWork.id !== work.id
      || resetEpoch !== composerResetEpoch
      || !attachmentUploadMatches(target, attachmentUploadTarget(currentWork, currentHost))) return
    item.state = 'error'
    item.error = errorMessage(cause)
  }
}

async function cancelUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  try { await cancelAttachmentUpload(work.id, item.token, requireConnectionContext(app)) } catch { /* completion will report its final state */ }
}

async function removeUpload(item: UploadDraft) {
  const work = selected.value
  if (!work) return
  uploadDrafts.value = uploadDrafts.value.filter((candidate) => candidate.token !== item.token)
  removeAttachmentPreview(item.token)
  try { await removeAttachment(work.id, item.token, requireConnectionContext(app)) } catch { /* already cleared by a context change */ }
}

function removeUploaded(fileId: string) {
  const work = selected.value
  const attachment = draftAttachments.value.find((item) => item.fileId === fileId)
  draftAttachments.value = draftAttachments.value.filter((item) => item.fileId !== fileId)
  removeAttachmentPreview(fileId)
  const token = attachment?.localUpload?.sourceToken
  const context = app.connectionContext
  if (work && token && context) void removeAttachment(work.id, token, context).catch(() => undefined)
}

async function clearQueueImages() {
  const work = selected.value
  if (!work || pairingInProgress.value || clearingRestoredImages.value || submitting.value || queueRestoring.value) return
  const context = requireConnectionContext(app)
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
  clearQueueNotice()
  try {
    const context = requireConnectionContext(app)
    const result = await dequeueMessages(work.id, context)
    if (!app.contextMatches(context) || selected.value?.id !== work.id || result.receipt.instanceId !== work.id || result.instance.id !== work.id) return false
    const restored = appendRestoredQueue(draft.value, draftAttachments.value, result.receipt.restored)
    draft.value = restored.text
    draftAttachments.value = restored.attachments
    restoredImageCount.value += restored.restoredImageCount
    app.applyWorkSnapshot(result.instance, context)
    if (conversationState.value?.instance.id === work.id) {
      conversationState.value.instance = result.instance
      conversationState.value.queue = []
    }
    queueOpen.value = false
    showQueueNotice(result.receipt.restored.length
      ? `已取回 ${result.receipt.restored.length} 条消息。`
      : '没有可取回的消息。')
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
  const capturedAttachments = draftAttachments.value.slice(0, maxMessageAttachments.value).map((item) => ({ ...item }))
  const localCommand = submittedLocalControl(captured)
  if (localCommand) return executeLocalControl(localCommand, captured)
  if (!work || workMutating.value || (!captured.trim() && !capturedAttachments.length && !restoredImageCount.value) || !isTauri || pairingInProgress.value || clearingRestoredImages.value || submitting.value || queueRestoring.value || attachmentPicking.value || uploadDrafts.value.length > 0) return false
  const currentHost = app.connectionContext
  if (!currentHost) return false
  const attachmentTarget = attachmentUploadTarget(work, currentHost)
  if (capturedAttachments.some((item) => item.localUpload && !attachmentUploadMatches(item.localUpload, attachmentTarget))) {
    submissionError.value = '附件正在为当前工作重新上传，请稍后再发送。'
    return false
  }
  submitting.value = true
  submissionError.value = null
  try {
    const capturedHost = requireConnectionContext(app)
    const result = await submitMessage(work.id, captured, capturedAttachments.map((item) => item.fileId), capturedHost)
    if (!app.contextMatches(capturedHost)) return false
    app.applyWorkSnapshot(result.instance, capturedHost)
    draft.value = draftAfterSubmit(draft.value, captured, true)
    draftAttachments.value = attachmentsAfterSubmit(draftAttachments.value, capturedAttachments.map((item) => item.fileId), true)
    for (const attachment of capturedAttachments) {
      const token = attachment.localUpload?.sourceToken
      if (token) void removeAttachment(work.id, token, capturedHost).catch(() => undefined)
    }
    restoredImageCount.value = 0
    if (!result.receipt.queued) showAgentActivity(work.id)
    if (draftAttachments.value.length) showQueueNotice(`已发送一批附件；还有 ${draftAttachments.value.length} 个保留在编辑器中。`)
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

async function executeLocalControl(command: LocalControlCommand, captured: string): Promise<boolean> {
  if (!selected.value || selected.value.lifecycle !== 'active' || conversationLoading.value) return false
  if (command.section) {
    if (draft.value === captured) draft.value = ''
    openControlCenter(command.section)
    return true
  }
  if (command.action === 'restoreQueue') {
    if (draft.value === captured) draft.value = ''
    const restored = await restoreQueue()
    if (!restored && !draft.value) draft.value = captured
    return restored
  }
  if (command.action === 'stop') {
    const stopped = await stopSelectedWork()
    if (stopped && draft.value === captured) draft.value = ''
    return stopped
  }
  return false
}

async function abortCurrentRun() {
  const work = selected.value
  if (!work || work.execution !== 'running' || aborting.value || workMutating.value) return
  if (work.pending.total > 0 && !await restoreQueue()) return
  aborting.value = true
  submissionError.value = null
  try {
    const capturedHost = requireConnectionContext(app)
    const snapshot = await abortRun(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    app.applyWorkSnapshot(snapshot, capturedHost)
    const authoritative = app.works.find((item) => item.id === snapshot.id) ?? snapshot
    extensionUi.applyAuthoritativeSnapshot(authoritative)
    const state = conversationState.value
    if (state?.instance.id === work.id
      && state.cursor.hostEpoch === authoritative.ownerHostEpoch
      && state.cursor.runtimeGeneration === authoritative.runtimeGeneration) {
      state.instance = authoritative
      conversationContent.reproject(state)
    }
  } catch (cause) {
    markUnknownOutcome(cause, 'conversation', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    aborting.value = false
  }
}

async function stopSelectedWork(): Promise<boolean> {
  const work = selected.value
  const capturedHost = app.connectionContext
  if (!isTauri || contextTransitionBusy.value || !capturedHost || !stopCanStart(work, workMutating.value, mutationOutcomeUnknown.value) || !work) return false
  if (!await askConfirm('停止当前工作？', stopConfirmationText(work))) return false
  if (!app.contextMatches(capturedHost) || selected.value?.id !== work.id || selected.value.lifecycle !== 'active') return false
  workMutating.value = true
  submissionError.value = null
  try {
    const result = await stopWork(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return false
    if (!stoppedResultIsCorrelated(result, work.id)) throw { outcomeUnknown: true, message: '停止结果没有证明对应 Work 已停止。' }
    app.applyWorkSnapshot(result.instance, capturedHost)
    if (selected.value?.id === work.id) {
      if (conversationState.value?.instance.id === work.id) {
        conversationState.value.instance = result.instance
        conversationState.value.queue = []
      }
      window.clearTimeout(reconnectTimer)
      reconnectTimer = 0
      conversationError.value = null
      followConnected.value = false
      activeFollow.value = null
      await extensionUi.clear()
    }
    const cleanupErrors = result.receipt.cleanupErrors ?? []
    submissionError.value = cleanupErrors.length
      ? 'Work 已停止，但相关内容可能仍在更新。请刷新后确认当前状态。'
      : null
    return true
  } catch (cause) {
    markUnknownOutcome(cause, 'work', work.id)
    submissionError.value = errorMessage(cause)
    return false
  } finally {
    workMutating.value = false
  }
}

async function reopenSelectedWork(continuation?: CreateWorkContinuation) {
  const work = selected.value
  if (!isTauri || contextTransitionBusy.value || !work || !work.reopenable || workMutating.value || mutationOutcomeUnknown.value) return
  const capturedHost = requireConnectionContext(app)
  const previousGeneration = work.runtimeGeneration
  workMutating.value = true
  submissionError.value = null
  try {
    const snapshot = await reopenWork(work.id, capturedHost, continuation)
    if (!app.contextMatches(capturedHost)) return
    app.applyWorkSnapshot(snapshot, capturedHost)
    reopenTrustContinuation.value = null
    void loadSelectedConversation(work.id, true)
  } catch (cause) {
    const failure = cause as { code?: string; message?: string; details?: Record<string, unknown>; operationId?: string; outcomeUnknown?: boolean }
    if (failure?.code === 'project_trust_required') {
      const operationId = String(failure.details?.operationId || failure.operationId || '')
      const trustChallengeId = String(failure.details?.challengeId || '')
      if (operationId && trustChallengeId) {
        reopenTrustContinuation.value = { operationId, trustChallengeId, projectTrustDecision: 'trust_once' }
      } else submissionError.value = 'Dock 要求确认项目信任，但确认信息不完整。请重试；若反复出现，请检查客户端和 Dock 版本。'
    } else if (failure?.outcomeUnknown === true) {
      markUnknownOutcome(cause, 'work', work.id)
      reconcilingReopenWorkId.value = work.id
      submissionError.value = 'Dock 已收到继续请求，正在确认 Work 的实际状态…'
      void reconcileReopenOutcome(work.id, previousGeneration, capturedHost)
    } else {
      submissionError.value = errorMessage(cause)
    }
  } finally {
    workMutating.value = false
  }
}

async function reconcileReopenOutcome(workId: string, previousGeneration: number, context: ConnectionContext) {
  if (!await app.refreshWorksQuietly() || !app.contextMatches(context)) {
    submissionError.value = '暂时无法确认 Work 的实际状态；连接恢复后会继续以 Dock 状态为准。'
    return
  }
  const current = app.works.find((work) => work.id === workId)
  if (!current || current.lifecycle !== 'active' || current.runtimeGeneration <= previousGeneration) {
    submissionError.value = '还无法确认 Work 是否已继续。请刷新状态后确认，不要重复操作。'
    return
  }
  const key = mutationKey(workId, 'work')
  const next = new Map(unresolvedMutations.value)
  next.delete(key)
  unresolvedMutations.value = next
  submissionError.value = null
  reopenTrustContinuation.value = null
  reconcilingReopenWorkId.value = ''
  app.applyWorkSnapshot(current, context)
  void loadSelectedConversation(workId, true)
}

async function forgetSelectedWork() {
  const work = selected.value
  if (!isTauri || contextTransitionBusy.value || !work || !['stopped', 'host_lost', 'runtime_error'].includes(work.lifecycle) || workMutating.value) return
  if (!await askConfirm('从列表移除这条历史记录？')) return
  workMutating.value = true
  submissionError.value = null
  try {
    const capturedHost = requireConnectionContext(app)
    await forgetWork(work.id, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    app.removeWorkSnapshot(work.id, capturedHost)
    void app.refreshWorksQuietly()
  } catch (cause) {
    markUnknownOutcome(cause, 'work', work.id)
    submissionError.value = errorMessage(cause)
  } finally {
    workMutating.value = false
  }
}

function showAgentActivity(workId: string) {
  conversationContent.showActivity(workId)
  conversationViewport.scrollToBottom()
}

const resetOutputFollow = conversationViewport.reset
const handleOutputScroll = conversationViewport.handleScroll
const handleOutputMediaLoad = conversationViewport.mediaLoaded
const captureOutputAnchor = conversationViewport.captureAnchor
const restoreOutputAnchor = conversationViewport.restoreAnchor

function scrollOutputToBottom(force = false) {
  if (force) conversationViewport.scrollToBottom()
  else conversationViewport.layoutChanged()
}

const idleImageResource: ConversationImageResource = { state: 'idle' }
const loadingImageResource: ConversationImageResource = { state: 'loading' }

function imageResource(part: ConversationImagePart): ConversationImageResource {
  const localPreview = part.fileId ? attachmentPreviews.value[part.fileId] : undefined
  const available = displayedConversationImageResource(localPreview, imageResources.value[part.imageKey])
  if (available) return available
  const entryId = part.historyEntryId
  if (!part.source && entryId && historyHydrationActiveEntries.value.has(entryId)) return loadingImageResource
  const hydrationError = entryId ? historyHydrationErrors.value[entryId] : undefined
  if (!part.source && hydrationError) return { state: 'error', message: hydrationError }
  return idleImageResource
}

function setImageResource(imageKey: string, resource: CachedConversationImageResource) {
  const previous = imageResources.value[imageKey]
  if (previous?.url && previous.url !== resource.url) URL.revokeObjectURL(previous.url)
  imageResources.value = { ...imageResources.value, [imageKey]: resource }
}

function touchConversationImage(imageKey: string) {
  const resource = imageResources.value[imageKey]
  if (resource?.state === 'ready' && resource.url) resource.lastAccessed = ++imageAccessSequence
}

function enforceConversationImageCacheBudget() {
  let retainedBytes = 0
  const protectedImageKey = imagePreview.value?.kind === 'conversation' ? imagePreview.value.imageKey : ''
  const candidates: Array<{ imageKey: string; resource: CachedConversationImageResource; sizeBytes: number }> = []
  for (const [imageKey, resource] of Object.entries(imageResources.value)) {
    if (resource.state !== 'ready' || !resource.url || !resource.sizeBytes) continue
    retainedBytes += resource.sizeBytes
    if (imageKey !== protectedImageKey) candidates.push({ imageKey, resource, sizeBytes: resource.sizeBytes })
  }
  if (retainedBytes <= CONVERSATION_IMAGE_CACHE_BUDGET_BYTES) return
  candidates.sort((left, right) => (left.resource.lastAccessed ?? 0) - (right.resource.lastAccessed ?? 0))
  const next = { ...imageResources.value }
  let changed = false
  for (const { imageKey, resource, sizeBytes } of candidates) {
    if (retainedBytes <= CONVERSATION_IMAGE_CACHE_BUDGET_BYTES) break
    if (next[imageKey] !== resource) continue
    URL.revokeObjectURL(resource.url!)
    delete next[imageKey]
    retainedBytes -= sizeBytes
    changed = true
  }
  if (changed) imageResources.value = next
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

function syncImageDomain(context: ConnectionContext, workId: string, hostEpoch: string, runtimeGeneration: number) {
  const next = JSON.stringify([context.connectionId, context.selectionGeneration, workId, hostEpoch, runtimeGeneration])
  if (imageDomainKey && imageDomainKey !== next) resetConversationImages()
  imageDomainKey = next
}

function itemImages(item: ConversationItem): ConversationImagePart[] {
  if (item.kind === 'image') return [item]
  if (item.kind === 'user') return item.images ?? []
  if (item.kind === 'record') return item.parts.filter((part): part is ConversationImagePart => part.kind === 'image')
  return []
}

function pruneImageResources(items: ConversationItem[]) {
  const active = new Set<string>()
  for (const item of items) {
    for (const image of itemImages(item)) active.add(image.imageKey)
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

function conversationHasImage(imageKey: string) {
  return realConversation.value.some((item) => itemImages(item).some((image) => image.imageKey === imageKey))
}

async function requestConversationImage(part: ConversationImagePart) {
  const source = part.source
  if (!source) {
    if (part.historyEntryId && historyHydrationErrors.value[part.historyEntryId]) retryHistoryEntry(part.historyEntryId)
    return
  }
  const state = conversationState.value
  const work = selected.value
  const cachedResource = imageResources.value[part.imageKey]
  if (cachedResource?.state === 'ready' && cachedResource.url) {
    touchConversationImage(part.imageKey)
    return
  }
  const displayedResource = imageResource(part)
  if (!state || !work || displayedResource.state === 'loading' || displayedResource.state === 'ready') return
  const capturedHost = requireConnectionContext(app)
  const expectedEpoch = state.cursor.hostEpoch
  const expectedGeneration = state.cursor.runtimeGeneration
  const loadEpoch = imageLoadEpoch
  setImageResource(part.imageKey, { state: 'loading' })
  try {
    let bytes: Uint8Array
    let mediaType = part.mimeType
    if (source.type === 'conversation') {
      bytes = await loadConversationImageBytes(work.id, expectedEpoch, source.contentRef, source.mimeType, capturedHost)
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
    const detectedMediaType = rasterImageMimeType(bytes)
    if (!detectedMediaType || (mediaType && mediaType !== detectedMediaType)) throw new Error('图片内容无法解码，请重新读取。')
    mediaType = detectedMediaType
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType }))
    setImageResource(part.imageKey, {
      state: 'ready',
      url,
      sizeBytes: bytes.byteLength,
      lastAccessed: ++imageAccessSequence,
    })
    enforceConversationImageCacheBudget()
  } catch (cause) {
    if (loadEpoch !== imageLoadEpoch || !app.contextMatches(capturedHost) || selected.value?.id !== work.id || !conversationHasImage(part.imageKey)) return
    setImageResource(part.imageKey, { state: 'error', message: imageLoadMessage(cause) })
  }
}

function decodeInlineImage(data: string, mimeType: string): Uint8Array {
  if (!isRasterImageMimeType(mimeType)
    || data.length > Math.ceil((20 * 1024 * 1024) / 3) * 4
    || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('图片内容无法解码，请重新读取。')
  let decoded = ''
  try { decoded = window.atob(data) } catch { throw new Error('图片内容无法解码，请重新读取。') }
  if (window.btoa(decoded) !== data) throw new Error('图片内容无法解码，请重新读取。')
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  if (rasterImageMimeType(bytes) !== mimeType) throw new Error('图片内容无法解码，请重新读取。')
  return bytes
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
  if (code === 'file_unavailable') return '图片已经失效，请让 Agent 重新发布。'
  if (code === 'image_too_large') return '图片过大，当前设备无法安全预览。'
  if (code === 'unsupported_image') return '图片格式无法安全显示。'
  return errorMessage(cause, '图片暂时无法读取，请稍后重试。')
}

function openImagePreview(part: ConversationImagePart) {
  const resource = imageResource(part)
  if (resource.state !== 'ready' || !resource.url) return
  touchConversationImage(part.imageKey)
  showImagePreview({
    kind: 'conversation',
    imageKey: part.imageKey,
    url: resource.url,
    name: (part.name || 'aludock-image').replace(/[\\/]/g, '_'),
  })
}

async function saveOpenImage() {
  const preview = imagePreview.value
  if (!preview || imageSaving.value) return
  imageSaving.value = true
  imageSaveStatus.value = null
  try {
    if (!isTauri) {
      const link = document.createElement('a')
      link.href = preview.url
      link.download = preview.name
      link.click()
      return
    }
    const response = await fetch(preview.url)
    if (!response.ok) throw new Error('图片内容无法读取。')
    const result = await savePreviewImage(preview.name, new Uint8Array(await response.arrayBuffer()))
    if (imagePreview.value?.url !== preview.url || result.status === 'cancelled') return
    imageSaveStatus.value = { tone: 'success', text: '图片已保存到所选位置。' }
  } catch (cause) {
    if (imagePreview.value?.url === preview.url) {
      imageSaveStatus.value = { tone: 'error', text: errorMessage(cause, '图片没有保存完成，请重试。') }
    }
  } finally {
    if (imagePreview.value?.url === preview.url) imageSaving.value = false
  }
}

async function applyFollowEvent(payload: { connectionId: string; selectionGeneration: number; instanceId: string; subscriptionId: string; event: ProjectedEvent }) {
  const state = conversationState.value
  if (!state || payload.subscriptionId !== activeFollowSubscription.value) return
  const reduced = reduceLiveEvent({
    connectionId: payload.connectionId,
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
  if (reduced.state.instance !== state.instance) {
    state.instance = reduced.state.instance
    app.applyWorkSnapshot(state.instance, payload)
  }
  if (reduced.state.queue !== state.queue) state.queue = reduced.state.queue
  state.cursor.sequence = reduced.state.sequence
  if (payload.event.eventType === 'compaction.started' || payload.event.eventType === 'compaction.completed') {
    setCompactionError(payload.connectionId, payload.instanceId)
  }
  if (payload.event.eventType === 'compaction.completed') void mergeCompactionSummary(payload.instanceId)
  if (payload.event.eventType === 'resources.reloaded') commandCatalogStore.invalidate()
  if (reduced.configChanged) controlCenterRef.value?.applyLiveEvent(payload.event)
  if (!await extensionUi.applyLive(payload.instanceId, payload.subscriptionId, payload.event)) {
    followConnected.value = false
    void loadSelectedConversation(payload.instanceId, true)
    return
  }
  const commandRoute = commandConsole.handleDockEvent(payload.event)
  const commandOnlyNotification = payload.event.eventType === 'extension.notification' && commandRoute.matched
  if (commandOnlyNotification) return
  conversationContent.applyConversationEvent(state, payload.event, reduced.conversationChanged)
}

async function resumeConversationFollow(instanceId: string): Promise<boolean> {
  const state = conversationState.value
  const work = selected.value
  if (!state || !work || work.id !== instanceId || work.lifecycle !== 'active' || state.instance.id !== instanceId) return false
  const epoch = ++conversationLoadEpoch
  const capturedHost = requireConnectionContext(app)
  const cursor = { ...state.cursor }
  if (cursor.instanceId !== instanceId
    || cursor.hostEpoch !== app.payload?.host.hostEpoch
    || cursor.runtimeGeneration !== state.instance.runtimeGeneration) return false

  const subscriptionId = crypto.randomUUID()
  pendingFollowEvents.set(subscriptionId, [])
  const connected = waitForFollowConnection(subscriptionId)
  try {
    await startConversationFollow(instanceId, subscriptionId, cursor, capturedHost)
    await connected
    if (!windowFocused.value
      || !app.contextMatches(capturedHost)
      || epoch !== conversationLoadEpoch
      || selected.value?.id !== instanceId
      || conversationState.value !== state
      || state.cursor.sequence !== cursor.sequence) return false
    if (!extensionUi.resumeFollow(capturedHost, subscriptionId, cursor)) return false

    const bufferedFollowStatus = followActivation.activate(subscriptionId)
    activeFollow.value = { ...capturedHost, instanceId, subscriptionId }
    followConnected.value = true
    conversationError.value = null
    if (bufferedFollowStatus) handleActiveFollowStatus({ instanceId, subscriptionId, ...bufferedFollowStatus })
    const buffered = pendingFollowEvents.get(subscriptionId) ?? []
    pendingFollowEvents.delete(subscriptionId)
    for (const event of buffered) {
      await applyFollowEvent({ ...capturedHost, instanceId, subscriptionId, event })
      if (activeFollowSubscription.value !== subscriptionId) break
    }
    return activeFollowSubscription.value === subscriptionId
  } catch (cause) {
    if (epoch === conversationLoadEpoch && selected.value?.id === instanceId) conversationError.value = errorMessage(cause)
    return false
  } finally {
    clearFollowConnectionTimer(subscriptionId)
    followActivation.cancel(subscriptionId, new Error('连接恢复已结束。'))
    pendingFollowEvents.delete(subscriptionId)
    if (activeFollowSubscription.value !== subscriptionId) {
      try {
        await stopConversationFollow(instanceId, subscriptionId, capturedHost)
      } catch (cause) {
        console.error('Failed to stop an inactive resumed Follow subscription.', cause)
      }
    }
  }
}

async function reattachConversationFollow(instanceId: string) {
  if (!windowFocused.value || selected.value?.id !== instanceId) return
  if (activeFollow.value) await detachConversationFollow()
  if (!windowFocused.value || selected.value?.id !== instanceId) return
  if (historyReloadRequiredWorkId === instanceId) {
    await loadSelectedConversation(instanceId, true)
    return
  }
  if (!await resumeConversationFollow(instanceId)
    && windowFocused.value
    && selected.value?.id === instanceId) await loadSelectedConversation(instanceId, true)
}

function runningWorkIdsForAway() {
  return app.works.filter((work) => work.execution === 'running').map((work) => work.id)
}

function activeFollowCanContinue(instanceId: string) {
  const followed = activeFollow.value
  const state = conversationState.value
  const work = selected.value
  return !!followed
    && followed.instanceId === instanceId
    && followConnected.value
    && app.contextMatches(followed)
    && state?.instance.id === instanceId
    && state.instance.runtimeGeneration === work?.runtimeGeneration
    && state.cursor.hostEpoch === app.payload?.host.hostEpoch
}

function handleWebViewFocus() {
  void handleWindowFocusChanged(true)
}

function handleAndroidNetworkChanged() {
  androidNetworkRecoveryPending = true
  if (androidNetworkRecoveryTask) return
  androidNetworkRecoveryTask = drainAndroidNetworkChanges().finally(() => {
    androidNetworkRecoveryTask = null
    if (androidNetworkRecoveryPending) handleAndroidNetworkChanged()
  })
}

async function drainAndroidNetworkChanges() {
  while (androidNetworkRecoveryPending) {
    androidNetworkRecoveryPending = false
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context || app.localSelected) continue
    try {
      androidRouteRefreshPending = !await reconnectThroughPreferredRoute(context)
    } catch (cause) {
      if (app.contextMatches(context)) console.error('Failed to reconnect after the network changed.', cause)
    }
  }
}

async function reconnectThroughPreferredRoute(context: ConnectionContext) {
  await reselectHostRoute(context)
  if (!app.contextMatches(context)) return false
  await detachConversationFollow()
  if (!app.contextMatches(context) || !windowFocused.value) return false
  await app.loadActive()
  if (!app.contextMatches(context) || !windowFocused.value) return false
  const connected = app.payload?.connectionId === context.connectionId
  const work = selected.value
  if (connected && work?.lifecycle === 'active') await reattachConversationFollow(work.id)
  return connected
}

async function handleWindowFocusChanged(focused: boolean) {
  if (focused === windowFocused.value) {
    if (focused && isAndroidWebView && androidRouteRefreshPending) {
      const context = app.connectionContext ? { ...app.connectionContext } : null
      await app.loadActive()
      if (context && app.contextMatches(context)) {
        androidRouteRefreshPending = app.payload?.connectionId !== context.connectionId
      }
    }
    const work = selected.value
    if (focused && work?.lifecycle === 'active' && !conversationLoading.value && !activeFollowCanContinue(work.id)) {
      await reattachConversationFollow(work.id)
    }
    return
  }
  const epoch = ++windowFocusEpoch
  windowFocused.value = focused
  if (!focused) {
    if (!appSettings.value?.windowsAwaySupported) {
      await detachConversationFollow()
      return
    }
    try {
      const awayId = await beginWindowsAway(runningWorkIdsForAway())
      if (epoch !== windowFocusEpoch || windowFocused.value) {
        if (awayId) await cancelWindowsAway(awayId)
        return
      }
      windowsAwayId = awayId
      if (awayId && elapsedWindowsAwayIds.delete(awayId)) await detachConversationFollow()
    } catch (cause) {
      console.error('Failed to begin Windows away period.', cause)
      if (epoch === windowFocusEpoch && !windowFocused.value) await detachConversationFollow()
    }
    return
  }

  const awayId = windowsAwayId
  windowsAwayId = null
  elapsedWindowsAwayIds.clear()
  if (appSettings.value?.windowsAwaySupported) {
    try {
      await cancelWindowsAway(awayId)
    } catch (cause) {
      console.error('Failed to finish Windows away period.', cause)
    }
  }
  if (isAndroidWebView && androidRouteRefreshPending) {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    await app.loadActive()
    if (context && app.contextMatches(context)) {
      androidRouteRefreshPending = app.payload?.connectionId !== context.connectionId
    }
  } else {
    await app.refreshWorksQuietly()
  }
  if (epoch !== windowFocusEpoch || !windowFocused.value) return
  const work = selected.value
  if (work?.lifecycle === 'active' && !activeFollowCanContinue(work.id)) {
    await reattachConversationFollow(work.id)
  }
}

async function detachConversationFollow() {
  const followed = activeFollow.value
  const controllerHandle = extensionUi.controller?.handle
  const workId = selected.value?.id
  if (workId && (conversationLoading.value
    || historyLoading.value
    || historyHydrating.value
    || historyError.value)) historyReloadRequiredWorkId = workId
  activeFollow.value = null
  followConnected.value = false
  ++conversationLoadEpoch
  resetHistoryHydration()
  conversationLoading.value = false
  window.clearTimeout(reconnectTimer)
  reconnectTimer = 0
  for (const timer of followConnectionTimers.values()) window.clearTimeout(timer)
  followConnectionTimers.clear()
  followActivation.cancelAll(new Error('窗口已进入后台。'))
  pendingFollowEvents.clear()

  const releases: Promise<unknown>[] = []
  if (followed) releases.push(stopConversationFollow(followed.instanceId, followed.subscriptionId, followed))
  if (controllerHandle) {
    extensionUi.suspendController(controllerHandle)
    releases.push(extensionUi.releaseController(controllerHandle, 'detached').then((released) => {
      if (!released) extensionUi.controllerEnded(controllerHandle, 'disconnected')
    }))
  }
  await Promise.allSettled(releases)
}

function scheduleConversationReconnect(instanceId: string) {
  window.clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0
    if (windowFocused.value && selected.value?.id === instanceId && selected.value.lifecycle === 'active') {
      void reattachConversationFollow(instanceId)
    }
  }, 1500)
}

function handleActiveFollowStatus(payload: {
  instanceId: string
  subscriptionId: string
  state: FollowConnectionState
  message?: string
}) {
  if (payload.subscriptionId !== activeFollowSubscription.value) return
  if (selected.value?.id === payload.instanceId && selected.value.lifecycle !== 'active') {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = 0
    followConnected.value = false
    conversationError.value = null
    void detachConversationFollow()
    return
  }
  followConnected.value = payload.state === 'connected'
  if (payload.message) conversationError.value = payload.message
  if (payload.state === 'resync_required' || payload.state === 'disconnected') {
    void recoverAfterFollowBoundary(payload)
  }
}

async function recoverAfterFollowBoundary(payload: {
  instanceId: string
  subscriptionId: string
  state: FollowConnectionState
}) {
  await app.refreshWorksQuietly()
  if (payload.subscriptionId !== activeFollowSubscription.value || selected.value?.id !== payload.instanceId) return
  if (selected.value.lifecycle !== 'active') {
    conversationError.value = null
    await detachConversationFollow()
    return
  }
  if (payload.state === 'resync_required') await loadSelectedConversation(payload.instanceId, true)
  else scheduleConversationReconnect(payload.instanceId)
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

/** 压缩落盘后（Dock 在 compaction_end 同步写入 conversation checkpoint），把持久化的
 *  上下文摘要记录并入当前视图；不重载会话、不打断 follow、不移动滚动位置。 */
async function mergeCompactionSummary(instanceId: string) {
  const state = conversationState.value
  if (!state || selected.value?.id !== instanceId || state.instance.id !== instanceId) return
  const epoch = conversationLoadEpoch
  let capturedHost: ConnectionContext
  try {
    capturedHost = requireConnectionContext(app)
  } catch {
    return
  }
  try {
    const bootstrap = await loadConversation(instanceId, capturedHost)
    if (epoch !== conversationLoadEpoch || conversationState.value !== state || selected.value?.id !== instanceId) return
    if (bootstrap.cursor.instanceId !== instanceId
      || bootstrap.cursor.hostEpoch !== state.cursor.hostEpoch
      || bootstrap.cursor.runtimeGeneration !== state.cursor.runtimeGeneration) return
    const existing = new Set(state.records.map((record) => record.entryId))
    const fresh = bootstrap.records.filter((record) => !existing.has(record.entryId)
      && (record.kind === 'compaction_summary' || record.kind === 'branch_summary'))
    await conversationContent.appendHistoricalRecords(fresh, bootstrap.historyRevision)
  } catch {
    // 摘要取不到不打断当前会话；下次整页载入时会随历史一起出现。
  }
}

async function loadSelectedConversation(instanceId: string, preserveUntilSwap = false): Promise<boolean> {
  if (isTauri && !windowFocused.value) return false
  const epoch = ++conversationLoadEpoch
  resetHistoryHydration()
  const work = app.works.find((item) => item.id === instanceId)
  const preserveCurrent = preserveUntilSwap || Boolean(conversationState.value)
  if (!preserveCurrent) {
    conversationContent.clear()
    if (!await extensionUi.clear()) return false
    if (epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
  }
  conversationError.value = null
  if (preserveCurrent) followConnected.value = false
  if (!work || work.lifecycle !== 'active') return false
  conversationLoading.value = true
  let subscriptionId = ''
  let capturedHost: ConnectionContext | null = null
  try {
    capturedHost = requireConnectionContext(app)
    const bootstrap = await loadConversation(instanceId, capturedHost)
    if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
    if (!conversationSwapIsCorrelated(capturedHost, instanceId, bootstrap, true)) throw new Error('对话状态已经变化，请重新载入。')
    if (app.payload?.host.hostEpoch !== bootstrap.cursor.hostEpoch) {
      await app.refreshWorksQuietly()
      if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
      if (selected.value.lifecycle !== 'active') return false
      if (app.payload?.host.hostEpoch !== bootstrap.cursor.hostEpoch) throw new Error('这项工作的状态已经变化，请重新载入。')
    }

    subscriptionId = crypto.randomUUID()
    pendingFollowEvents.set(subscriptionId, [])
    const connected = waitForFollowConnection(subscriptionId)
    const replacedFollow = activeFollow.value
    await startConversationFollow(instanceId, subscriptionId, bootstrap.cursor, capturedHost)
    // Tauri owns one Follow task and aborts the previous task when this command is accepted.
    if (replacedFollow && activeFollow.value?.subscriptionId === replacedFollow.subscriptionId) {
      activeFollow.value = null
      followConnected.value = false
    }
    if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
    // Follow 已接受与 bootstrap 相同的 cursor，后续事件已缓冲；此时即可原子替换
    // 旧会话，不必让用户继续等实时连接握手与 Extension UI 恢复。
    if (preserveCurrent && !await extensionUi.clear()) return false
    const preservedAnchor = preserveCurrent ? captureOutputAnchor() : null
    const preservedAutoFollow = preserveCurrent ? conversationViewport.isFollowing() : true
    await publishConversationBootstrap(capturedHost, bootstrap, preservedAnchor, preservedAutoFollow)
    await connected
    if (!app.contextMatches(capturedHost) || epoch !== conversationLoadEpoch || selected.value?.id !== instanceId) return false
    if (!await extensionUi.bootstrap(capturedHost, subscriptionId, bootstrap)) return false
    if (!conversationSwapIsCorrelated(capturedHost, instanceId, bootstrap, true)) return false

    const bufferedFollowStatus: FollowConnectionStatus | undefined = followActivation.activate(subscriptionId)
    activeFollow.value = { ...capturedHost, instanceId, subscriptionId }
    followConnected.value = true
    conversationError.value = null
    if (bufferedFollowStatus) handleActiveFollowStatus({ instanceId, subscriptionId, ...bufferedFollowStatus })
    const buffered = pendingFollowEvents.get(subscriptionId) ?? []
    pendingFollowEvents.delete(subscriptionId)
    for (const event of buffered) {
      await applyFollowEvent({ ...capturedHost, instanceId, subscriptionId, event })
      if (activeFollowSubscription.value !== subscriptionId) break
    }
    if (!app.contextMatches(capturedHost)
      || epoch !== conversationLoadEpoch
      || selected.value?.id !== instanceId
      || activeFollowSubscription.value !== subscriptionId) return false
    if (historyReloadRequiredWorkId === instanceId) historyReloadRequiredWorkId = null
    return true
  } catch (cause) {
    if (epoch === conversationLoadEpoch && selected.value?.id === instanceId) {
      conversationError.value = errorMessage(cause)
      if (windowFocused.value) scheduleConversationReconnect(instanceId)
    }
    return false
  } finally {
    if (subscriptionId) {
      clearFollowConnectionTimer(subscriptionId)
      followActivation.cancel(subscriptionId, new Error('连接载入已结束。'))
      pendingFollowEvents.delete(subscriptionId)
      if (capturedHost && activeFollowSubscription.value !== subscriptionId) {
        try {
          await stopConversationFollow(instanceId, subscriptionId, capturedHost)
        } catch (cause) {
          console.error('Failed to stop an inactive Follow subscription.', cause)
        }
      }
    }
    if (epoch === conversationLoadEpoch && selected.value?.id === instanceId) conversationLoading.value = false
  }
}

const resetHistoryHydration = conversationContent.resetHistoryHydration
const retryHistoryEntry = conversationContent.retryHistoryEntry
const retryConversationHydration = conversationContent.retryHydration
const loadEarlierHistory = conversationContent.loadEarlierHistory

function reloadConversationForHistory(workId: string) {
  historyReloadRequiredWorkId = workId
  void loadSelectedConversation(workId, true)
}

async function publishConversationBootstrap(
  context: ConnectionContext,
  bootstrap: ConversationBootstrap,
  preservedAnchor: ConversationReadingAnchor | null,
  preservedAutoFollow: boolean,
) {
  app.applyWorkSnapshot(bootstrap.instance, context)
  syncImageDomain(context, bootstrap.instance.id, bootstrap.cursor.hostEpoch, bootstrap.cursor.runtimeGeneration)
  conversationContent.publish(bootstrap)
  if (preservedAnchor && !preservedAutoFollow) await restoreOutputAnchor(preservedAnchor, false)
  else conversationViewport.scrollToBottom()
  void conversationContent.loadRecentHistory(context, bootstrap, conversationLoadEpoch)
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

function compactionErrorKey(connectionId: string, workId: string) {
  return JSON.stringify([connectionId, workId])
}

function setCompactionError(connectionId: string, workId: string, message?: string) {
  const key = compactionErrorKey(connectionId, workId)
  const next = { ...compactionErrors.value }
  if (message) next[key] = message
  else delete next[key]
  compactionErrors.value = next
}

function setCompactionPending(workId: string, pending: boolean) {
  const next = new Set(compactionWorkIds.value)
  if (pending) next.add(workId)
  else next.delete(workId)
  compactionWorkIds.value = next
}

async function startCompaction(customInstructions?: string) {
  const work = selected.value
  if (!isTauri || !work || mutationOutcomeUnknown.value || compactionWorkIds.value.has(work.id) || work.compacting) return
  const capturedHost = requireConnectionContext(app)
  const scope: SessionContext = {
    ...capturedHost,
    instanceId: work.id,
    expectedHostEpoch: work.ownerHostEpoch ?? '',
    expectedRuntimeGeneration: work.runtimeGeneration,
  }
  closeModal()
  setCompactionPending(work.id, true)
  setCompactionError(capturedHost.connectionId, work.id)
  submissionError.value = null
  try {
    const correlated = captureConnectionResult(capturedHost, await compactSession(
      scope,
      customInstructions?.trim() || undefined,
      crypto.randomUUID(),
    ))
    if (!hostResultMatches(correlated, app.connectionContext)) return
    const result = correlated.result
    const authoritative = applyAuthoritativeWorkSnapshot(result.instance)
    if (selected.value?.id === work.id) await refreshSessionConversation(authoritative)
  } catch (cause) {
    markUnknownOutcome(cause, 'sessions', work.id)
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
    const matchingFollow = followConnected.value
      && activeFollow.value?.connectionId === capturedHost.connectionId
      && activeFollow.value.selectionGeneration === capturedHost.selectionGeneration
      && activeFollow.value.instanceId === work.id
    const reportedByConversation = matchingFollow
      && ['compaction_cancelled', 'compaction_not_needed', 'compaction_failed'].includes(code)
    if (!reportedByConversation) setCompactionError(capturedHost.connectionId, work.id, errorMessage(cause))
  } finally {
    setCompactionPending(work.id, false)
  }
}

async function refreshSessionConversation(snapshot: Work) {
  app.applyWorkSnapshot(snapshot)
  if (selected.value?.id === snapshot.id) await loadSelectedConversation(snapshot.id, true)
}

async function resyncSession(snapshot: Work, returnedDraft?: string) {
  const authoritative = applyAuthoritativeWorkSnapshot(snapshot)
  if (selected.value?.id !== authoritative.id) return
  composerResetEpoch += 1
  const editor = editorAfterSessionReplacement(returnedDraft)
  draft.value = editor.text
  // Queue-owned references belong to the replaced Session. Locally selected files
  // retain their source handle and are re-uploaded by the target-scope watcher.
  draftAttachments.value = draftAttachments.value.filter((item) => item.localUpload)
  restoredImageCount.value = editor.restoredImageCount
  await loadSelectedConversation(authoritative.id, true)
}

async function loadHostMachines() {
  const epoch = ++machineLoadEpoch
  const machines = await currentConnectionCall(app, (context) => listMachines(context))
  if (epoch === machineLoadEpoch) {
    hostMachines.value = machines
    machineListError.value = ''
  }
  return machines
}

async function refreshHostMachinesQuietly() {
  const context = app.connectionContext ? { ...app.connectionContext } : null
  try {
    await loadHostMachines()
  } catch {
    if (context && app.contextMatches(context)) machineListError.value = '机器信息暂时没有载入。刷新后重试。'
  }
}

async function refreshWorkDrawer() {
  await app.load()
  await refreshHostMachinesQuietly()
}

async function openDirectory() {
  if (contextTransitionBusy.value) return
  rememberModalTrigger()
  directoryOpen.value = true
  commandOpen.value = false
  newWorkMachinesLoading.value = true
  newWorkMutationBusy.value = false
  newWorkCompact.value = true
  machineListError.value = ''
  try {
    await loadHostMachines()
  } catch (cause) {
    if (directoryOpen.value) machineListError.value = errorMessage(cause, '无法读取可用机器，请检查连接后重试。')
  } finally {
    newWorkMachinesLoading.value = false
  }
}

function acceptCreatedWork(work: Work) {
  newWorkMutationBusy.value = false
  const machine = work.hostId ? hostMachines.value.find((candidate) => candidate.hostId === work.hostId) : undefined
  if (machine && work.hostId) app.rememberCreatedWorkspace(work.hostId, work.cwd, machine.platform)
  app.applyWorkSnapshot(work)
  app.selectWork(work.id)
  void app.refreshWorksQuietly()
  directoryOpen.value = false
}

function handleNewWorkUnknown(cause: unknown) {
  markUnknownOutcome(cause, 'work', 'global')
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
      if (app.error || selected.value?.id !== workId) throw new Error('暂时无法确认修改后的 Work 状态，请稍后重试。')
      if (domain === 'sessions' && selected.value?.compacting) throw new Error('上下文仍在压缩；完成后再刷新确认。')
      await nextTick()
      const projection = await reconcileControlProjection(domain, workId)
      const conversation = await loadSelectedConversation(workId, true)
      reconciled = projection && conversation && !app.error
    } else if (domain === 'work') {
      await app.load()
      reconciled = !app.error
    }
    if (!reconciled) throw new Error('还无法确认刚才的修改是否生效。请再次刷新确认，不要重复提交。')
    const next = new Map(unresolvedMutations.value)
    next.delete(key)
    unresolvedMutations.value = next
    submissionError.value = null
    if (domain === 'sessions' && workId !== 'global' && app.activeConnectionId) setCompactionError(app.activeConnectionId, workId)
  } catch (cause) {
    submissionError.value = errorMessage(cause)
  }
}

async function reconcileControlProjection(domain: ControlMutationDomain, workId: string): Promise<boolean> {
  if (controlCenterRef.value && domain !== 'conversation') return controlCenterRef.value.reconcileDomain(domain)
  if (domain === 'models') {
    const result = await currentConnectionCall(app, (context) => listModels(workId, context))
    app.applyWorkSnapshot(result.instance)
    return true
  }
  if (domain === 'tools') {
    const result = await currentConnectionCall(app, (context) => listTools(workId, context))
    app.applyWorkSnapshot(result.instance)
    return true
  }
  if (domain === 'settings') {
    await currentConnectionCall(app, (context) => getSettings(workId, context))
    return true
  }
  if (domain === 'sessions' || domain === 'tree') {
    const work = app.works.find((item) => item.id === workId)
    if (!work) return false
    const sessionContext = (context: ConnectionContext): SessionContext => ({
      ...context,
      instanceId: work.id,
      expectedHostEpoch: work.ownerHostEpoch ?? '',
      expectedRuntimeGeneration: work.runtimeGeneration,
    })
    if (domain === 'sessions') await currentConnectionCall(app, (context) => listSessions(sessionContext(context), 'cwd'))
    else await currentConnectionCall(app, (context) => loadSessionTree(sessionContext(context)))
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
  if (!expanded && suggestOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      suggestIndex.value = Math.min(suggestIndex.value + 1, suggestItems.value.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      suggestIndex.value = Math.max(suggestIndex.value - 1, 0)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (suggestItems.value.length) {
        event.preventDefault()
        completeSuggest()
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      suggestDismissedFor.value = draft.value
      return
    }
  }
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
    const capturedHost = requireConnectionContext(app)
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

</script>

<template>
  <div class="alu-client-shell" :class="{ 'alu-compact-mode': !detailMode }">
    <nav class="alu-navbar select-none">
      <div class="alu-navbar-left">
        <img :src="dockIconUrl" class="alu-navbar-avatar session-dot" alt="Alu Dock" />
        <button type="button" class="alu-navbar-breadcrumb" title="查看项目状态" aria-label="查看项目状态" :disabled="!selected" @click="openControlCenter('resources')">
          <span v-if="!app.needsPairing" class="alu-nav-workspace">{{ selected ? selected.cwd.split('/').filter(Boolean).slice(-2).join('/') : 'AluDock' }}</span>
          <span v-if="!app.needsPairing" class="alu-nav-sep">/</span>
          <span class="alu-nav-session">{{ app.needsPairing ? 'AluDock' : selected?.name || selected?.displayName || '选择 Work' }}</span>
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
        <button ref="dockToolsTrigger" class="alu-nav-dock-tools" :class="{ active: selectedDockTools === 'on', open: dockToolsOpen }" :disabled="!selected || selected.lifecycle !== 'active'" :aria-label="`Dock Tools ${selectedDockTools === 'on' ? '已开启' : selectedDockTools === 'unavailable' ? '当前不可用' : '已关闭'}`" aria-haspopup="dialog" :aria-expanded="dockToolsOpen" @click="openDockTools">
          <Wrench :size="13" />
          <span class="alu-nav-dock-tools-label">Dock Tools</span>
          <b>{{ selectedDockToolsLabel }}</b>
          <span class="alu-nav-dock-tools-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="alu-nav-stats">
          <span class="alu-nav-stat-pill">↑<span>{{ formatTokenCount(selected?.metrics?.tokens?.input || 0) }}</span></span>
          <span class="alu-nav-stat-pill">↓<span>{{ formatTokenCount(selected?.metrics?.tokens?.output || 0) }}</span></span>
          <span class="alu-nav-stat-pill" :class="{ 'text-token-warn': contextPercent != null && contextPercent > 70 && contextPercent <= 90, 'text-token-danger': contextPercent != null && contextPercent > 90 }"><span>{{ formatContextUsage(selected?.metrics?.context) }}</span></span>
          <span class="alu-nav-stat-pill"><span>${{ Number(selected?.metrics?.cost || 0).toFixed(2) }}</span></span>
        </div>
        <button type="button" class="alu-nav-files" aria-label="打开文件列表" :aria-expanded="deliveryOpen" @click="openDeliveryTray">
          <FileDown :size="17" />
          <span v-if="pendingDeliverableCount" class="alu-nav-files-badge">{{ pendingDeliverableCount > 99 ? '99+' : pendingDeliverableCount }}</span>
        </button>
        <button class="alu-nav-hamburger" aria-label="打开工作列表" @click="app.workDrawerOpen = true">☰</button>
      </div>
    </nav>

    <main ref="output" class="alu-output" aria-label="当前 Session 对话" @scroll.passive="handleOutputScroll" @load.capture="handleOutputMediaLoad">
      <div v-if="!isTauri" class="alu-preview-notice">
        浏览器预览 · 仅作演示
      </div>
      <div v-else-if="selected && selected.lifecycle === 'active' && conversationState && (conversationError || (!conversationLoading && !followConnected))" class="alu-recovery-notice" role="status">
        <span>{{ conversationError ? `连接恢复失败：${conversationError}` : '连接已中断；当前对话已保留，正在重试…' }}</span>
        <button :disabled="conversationLoading" @click="loadSelectedConversation(selected.id, true)"><RefreshCw :size="13" />{{ conversationLoading ? '恢复中' : '重试' }}</button>
      </div>
      <div v-if="conversationSwitching && selected" class="alu-conversation-switching" role="status">正在打开 {{ selected.displayName }}…</div>

      <div v-if="app.loading && !(desktopShell?.supported && !app.payload && (desktopShell.startupError || !desktopShell.hostReady))" class="center-state" aria-live="polite">
        <span class="alu-spinner" />
        <p>正在连接 AluDock…</p>
      </div>

      <div v-else-if="desktopShell?.supported && !app.payload && desktopShell.startupError" class="center-state error-state offline-host-state">
        <WifiOff :size="28" />
        <h1>Alu Dock 需要你的操作</h1>
        <p>{{ desktopShell.startupError }}</p>
        <div class="pairing-actions">
          <button class="button primary" :disabled="desktopShellBusy" @click="retryDesktopHost"><RefreshCw :size="16" />{{ desktopShellBusy ? '正在启动…' : '重新启动' }}</button>
          <button v-if="desktopShell.logsPath" class="button secondary" @click="runDesktopShellAction(openDesktopHostLog)"><FileText :size="16" />打开日志</button>
          <button class="button secondary" @click="runDesktopShellAction(openDesktopTui)"><Settings :size="16" />打开终端设置</button>
        </div>
      </div>

      <div v-else-if="desktopShell?.supported && !app.payload && desktopShell.role !== 'subhost' && !desktopShell.hostReady" class="center-state offline-host-state">
        <Monitor :size="28" />
        <h1>Alu Dock 已停止</h1>
        <p>启动后即可继续这台电脑上的 Work。</p>
        <div class="pairing-actions">
          <button class="button primary" :disabled="desktopShellBusy" @click="retryDesktopHost"><RefreshCw :size="16" />{{ desktopShellBusy ? '正在启动…' : '启动 Alu Dock' }}</button>
          <button v-if="desktopShell.logsPath" class="button secondary" @click="runDesktopShellAction(openDesktopHostLog)"><FileText :size="16" />打开日志</button>
        </div>
      </div>

      <div v-else-if="app.needsPairing" class="pairing-onboarding">
        <div class="pairing-intro">
          <img :src="dockIconUrl" alt="Alu Dock" />
          <div><span class="eyebrow">WELCOME TO ALUDOCK</span><h1>连接你的 AluDock</h1><p>连接这台设备上的 AluDock，或通过配对连接其他电脑。</p></div>
        </div>
        <div class="pairing-layout">
          <form class="pairing-card" @submit.prevent="beginPairing()">
            <LocalConnectionCard
              v-if="app.catalog?.localConnectionSupported"
              :connected="!!app.localSelected"
              :effective-endpoint="app.catalog.localEndpointEffective"
              :endpoint-override="app.catalog.localEndpointOverride"
              :busy="app.loading || contextTransitionBusy"
              :error="app.error"
              @connect="connectLocal"
              @save="updateLocalEndpoint"
            />
            <div v-if="app.catalog?.localConnectionSupported" class="pairing-method-divider"><span>或通过配对连接其他电脑</span></div>
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
            <div v-if="pairingError || app.error" class="directory-error">{{ pairingError || app.error }}</div>
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
        <h1>无法连接“{{ app.localSelected ? '本机 AluDock' : app.activeHost?.displayName || 'Host' }}”</h1>
        <p>{{ app.error }}</p>
        <p v-if="app.hostUnreachable">{{ app.localSelected ? '当前本机连接地址已保留。' : '已保存的配对仍保留。' }}</p>
        <div v-if="app.activeHost && app.hostUnreachable" class="re-pair-prompt">
          <span class="re-pair-icon"><RotateCcw :size="19" /></span>
          <div>
            <strong>刚刚在 Dock 撤销了这台设备？</strong>
            <p>先在 Dock 打开配对窗口，然后从这里重新连接。完成后，此设备将使用新的连接授权。</p>
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
        <img :src="dockIconUrl" alt="Alu Dock" />
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
            <button v-if="selected.reopenable" class="alu-work-state-primary" :disabled="workMutating || mutationOutcomeUnknown" @click="reopenSelectedWork()">{{ workMutating ? '正在继续…' : inactiveState(selected).action }}</button>
            <button class="alu-work-state-secondary" @click="app.workDrawerOpen = true">查看工作列表</button>
            <button class="alu-work-state-secondary" @click="app.load">刷新状态</button>
          </div>
        </section>
      </div>

      <div v-else-if="conversationLoading && !conversationState" class="alu-welcome" aria-live="polite">
        <img :src="dockIconUrl" alt="Alu Dock" />
        <div class="alu-welcome-text">正在连接 {{ selected.displayName }}…</div>
      </div>

      <div v-else-if="conversationError && !conversationState" class="alu-welcome alu-welcome-error">
        <img :src="dockIconUrl" alt="Alu Dock" />
        <div class="alu-welcome-text">对话暂时没有载入。当前 Work 继续运行。</div>
        <button v-if="selected" class="ui-dialog-btn" @click="loadSelectedConversation(selected.id)">重新载入</button>
      </div>

      <ConversationView
        v-else-if="conversation.length"
        :items="conversation"
        :switching="conversationSwitching"
        :streaming-parts="streamingPartIds"
        :history-loading="historyLoading"
        :history-hydrating="historyHydrating"
        :history-truncated="historyTruncated"
        :history-cursor="historyCursor"
        :history-error="historyError"
        :attachment-previews="attachmentPreviews"
        :tool-open="toolDetailOpen"
        :image-resource="imageResource"
        @load-earlier="loadEarlierHistory"
        @retry-history="retryConversationHydration"
        @tool-toggle="rememberToolDetail"
        @image-request="requestConversationImage"
        @image-preview="openImagePreview"
        @image-failed="markConversationImageFailed"
        @attachment-preview="openAttachmentPreview"
        @open-text="openMessageText"
      />

      <div v-else class="alu-welcome">
        <img :src="dockIconUrl" alt="Alu Dock" />
        <div class="alu-welcome-text">「{{ selected.name || 'New session' }}」准备好了。</div>
      </div>
    </main>

    <section v-if="selected && selected.lifecycle === 'active'" class="alu-input-section" aria-label="消息编辑器">
      <button v-if="outputAwayFromBottom" type="button" class="alu-scroll-bottom" aria-label="滚动到最新消息" @click="scrollOutputToBottom(true)"><span aria-hidden="true">↓</span>滚到底部</button>
      <ExtensionUiSurface :work="selected" :reconcile-interaction="reconcileExtensionInteraction" @editor-text="applyExtensionEditorText" @title="applyExtensionTitle">
        <div v-if="visibleComposerError" class="alu-composer-error"><span>{{ visibleComposerError }}</span><button v-if="mutationOutcomeUnknown && reconcilingReopenWorkId !== selected.id" @click="reconcileMutationOutcome()">刷新并确认</button></div>
        <div v-if="queueNotice" class="alu-composer-notice" role="status">{{ queueNotice }}</div>
        <div v-if="selected.pending.total" class="alu-queue-tray">
          <span class="alu-queue-title">Queue · {{ selected.pending.total }}</span>
          <span class="alu-queue-preview">{{ queueItems.map(item => item.text.trim() || (item.imageCount || item.attachments.length ? '[附件]' : '')).filter(Boolean).join(' · ') }}</span>
          <button type="button" class="alu-queue-restore" title="取回 Queue（Alt+↑）" aria-keyshortcuts="Alt+ArrowUp" :disabled="!isTauri || attachmentPicking || queueRestoring || submitting" @click="restoreQueue">{{ queueRestoring ? '取回中…' : '取回' }}</button>
        </div>
        <div v-if="uploadDrafts.length || draftAttachments.length || restoredImageCount" class="alu-native-attachments" aria-label="已选附件">
          <div class="alu-attachment-selection-summary">已选择 {{ uploadDrafts.length + draftAttachments.length + restoredImageCount }} 个附件<span>点图片可放大查看</span></div>
          <AttachmentCard v-for="item in uploadDrafts" :key="item.token" :name="item.name" :size-bytes="item.sizeBytes" :media-type="item.mediaType" :state="item.state" :progress="item.progress" :message="item.error" :retryable="item.state === 'error'" :cancellable="item.state !== 'error'" :removable="item.state === 'error'" :preview-url="attachmentPreviews[item.token]?.url" @preview="openAttachmentPreview(item.token, item.name)" @retry="launchAttachmentUpload(item)" @cancel="cancelUpload(item)" @remove="removeUpload(item)" />
          <AttachmentCard v-for="attachment in draftAttachments" :key="attachment.fileId" :name="attachment.name" :size-bytes="attachment.sizeBytes" :media-type="attachment.mediaType" :preview-url="attachmentPreviews[attachment.fileId]?.url" removable @preview="openAttachmentPreview(attachment.fileId, attachment.name)" @remove="removeUploaded(attachment.fileId)" />
          <div v-if="restoredImageCount" class="alu-restored-images"><span>已取回 {{ restoredImageCount }} 个附件</span><button type="button" :disabled="clearingRestoredImages" @click="clearQueueImages">{{ clearingRestoredImages ? '移除中…' : '移除' }}</button></div>
        </div>
        <form class="alu-input-wrap" @submit.prevent="submit">
          <div v-if="suggestOpen" class="cmd-suggest" role="listbox" aria-label="命令建议">
            <button v-for="(item, index) in suggestItems" :key="`${item.kind}:${item.name}:${index}`" :id="`cmd-suggest-${index}`" type="button" class="cmd-suggest-item" :class="{ selected: suggestIndex === index }" role="option" :aria-selected="suggestIndex === index" @mouseenter="suggestIndex = index" @mousedown.prevent @click="completeSuggest(item)">
              <span class="cmd-suggest-name">{{ item.kind === 'argument' ? item.name : `/${item.name}${item.kind === 'catalog' && item.argumentHint ? ` ${item.argumentHint}` : ''}` }}</span>
              <span class="cmd-suggest-desc">{{ item.description || 'Dock 未提供说明' }}</span>
              <span class="cmd-suggest-kind">{{ item.sourceLabel }}</span>
            </button>
            <div v-if="!suggestItems.length && composerArgumentLoading" class="cmd-suggest-hint">正在读取参数候选…</div>
            <div v-else-if="!suggestItems.length && commandCatalogStore.state === 'loading'" class="cmd-suggest-hint">正在读取命令…</div>
            <div v-else-if="!suggestItems.length && commandCatalogStore.state === 'failed'" class="cmd-suggest-hint">当前命令目录暂时不可用，请稍后重试。</div>
            <div v-else-if="!suggestItems.length && slashQuery" class="cmd-suggest-hint">无匹配命令</div>
          </div>
          <textarea ref="composerTextarea" v-model="draft" rows="1" :disabled="conversationLoading" placeholder="输入消息…" title="Enter 发送 · Shift+Enter / Ctrl+J 换行" aria-keyshortcuts="Control+J" @input="resizeComposer" @paste="handleComposerPaste" @keydown="handleComposerKeydown($event)" />
          <button type="button" class="alu-composer-expand" title="展开编辑" aria-label="展开编辑" :disabled="conversationLoading" @click="rememberModalTrigger(); composerExpanded = true">↗</button>
          <button class="alu-send-btn" type="submit" :disabled="(!draft.trim() && !draftAttachments.length && !restoredImageCount) || !isTauri || conversationLoading || submitting || queueRestoring || attachmentPicking || workMutating || mutationOutcomeUnknown || uploadDrafts.length > 0">{{ submitting ? '发送中…' : '发送' }}</button>
        </form>
      </ExtensionUiSurface>

      <div class="alu-bottom-bar">
        <div class="alu-bottom-bar-left">
          <button class="alu-bar-btn alu-bar-session-action" title="恢复 Session" aria-label="恢复 Session" @click="openControlCenter('sessions')">↪<span>恢复</span></button>
          <button class="alu-bar-btn alu-bar-session-action" title="打开 Session Tree" aria-label="打开 Session Tree" @click="openControlCenter('tree')">⑂<span>Tree</span></button>
          <button class="alu-bar-btn" title="浏览当前 Work 的工作区" aria-label="打开工作区" :aria-expanded="workspaceBrowserOpen" :disabled="!isTauri" @click="openWorkspaceBrowser"><FolderTree :size="15" /><span>工作区</span></button>
          <button class="alu-bar-btn" title="添加附件" :disabled="!isTauri || attachmentPicking || draftAttachments.length + uploadDrafts.length >= maxMessageAttachments" @click="chooseAttachments">📎<span class="sm-inline">附件</span></button>
        </div>
        <div class="alu-bottom-bar-right">
          <span class="alu-status-dot" :class="{ connecting: !followConnected && !conversationError, error: !!conversationError }" />
          <span class="alu-status-label sm-inline">{{ connectionLabel }}</span>
          <div class="alu-bar-sep" />
          <button class="alu-bar-btn" title="刷新" @click="refreshCurrent">↻<span class="sm-inline">刷新</span></button>
          <button class="alu-bar-btn" :class="{ 'alu-bar-btn-toggle-active': !detailMode }" title="切换显示模式" @click="detailMode = !detailMode"><span>▤</span><span>{{ detailMode ? '详细' : '简洁' }}</span></button>
          <button class="alu-bar-btn" :title="`打开命令中心（${commandShortcutLabel}）`" aria-keyshortcuts="Control+K Meta+K" @click="openControlCenter('commands')"><kbd>{{ commandShortcutLabel }}</kbd><span class="sm-inline">命令</span></button>
          <button class="alu-bar-btn alu-bar-btn-abort" :disabled="!isTauri || aborting || workMutating || mutationOutcomeUnknown || selected.execution !== 'running'" @click="abortCurrentRun">⏹<span class="sm-inline">{{ aborting ? '中止中' : '中止' }}</span></button>
        </div>
      </div>
    </section>

    <WorkspaceBrowser
      :open="workspaceBrowserOpen"
      :work="selected || null"
      :context="app.connectionContext || null"
      :host-epoch="app.payload?.host.hostEpoch || ''"
      @close="workspaceBrowserOpen = false"
    />

    <DeliveryTray
      ref="deliveryTrayRef"
      :open="deliveryOpen"
      :loading="deliveryLoading"
      :error="deliveryError"
      :current-work-name="selected?.displayName || ''"
      :current="currentDeliverableRows"
      :history="olderDownloadHistory"
      :opening-key="openingDeliveryKey"
      @close="deliveryOpen = false"
      @refresh="refreshDeliverables"
      @download="saveDeliverable"
      @redownload="(deliverable) => saveDeliverable(deliverable, true)"
      @open-saved="openDownloadedDeliverable"
      @clear="clearLocalDownloadHistory"
    />

    <button class="alu-sidebar-overlay" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :tabindex="app.workDrawerOpen ? 0 : -1" aria-label="关闭工作列表" @click="app.workDrawerOpen = false" />
    <aside class="alu-sidebar" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :inert="!app.workDrawerOpen || undefined" aria-label="工作列表">
      <div class="alu-sidebar-head">
        <img :src="dockIconUrl" class="alu-sidebar-avatar" alt="Alu Dock" />
        <div class="alu-sidebar-title">AluDock Client</div>
        <button class="alu-sidebar-refresh" title="刷新" :disabled="contextTransitionBusy" @click="refreshWorkDrawer">↻</button>
        <button class="alu-sidebar-close" aria-label="关闭工作列表" @click="app.workDrawerOpen = false"><X :size="18" /></button>
      </div>
      <div class="alu-sidebar-actions"><button class="alu-new-work-btn" :disabled="contextTransitionBusy" @click="openDirectory">＋ 新建工作</button></div>
      <div class="alu-instance-list">
        <div v-if="machineListError" class="alu-sidebar-error">{{ machineListError }}</div>
        <section v-for="group in (['current', 'continue', 'history'] as const)" :key="group" v-show="groupedWorks[group].length" class="alu-instance-group">
          <div class="alu-instance-group-title">{{ group === 'current' ? '当前工作' : group === 'continue' ? '可以继续' : '历史工作' }}<span>{{ groupedWorks[group].length }}</span></div>
          <div v-for="work in groupedWorks[group]" :key="work.id" class="alu-instance-row" :class="{ 'is-selected': work.id === selected?.id }">
            <button class="alu-instance-link" :disabled="contextTransitionBusy && work.id !== selected?.id" @click="selectWork(work.id)">
              <span class="alu-instance-state" :class="`is-${workPresence(work).tone}`" />
              <span class="alu-instance-copy"><span class="alu-instance-name">{{ work.displayName }}</span><span v-if="workMachineTag(work)" class="alu-instance-machine-tag">{{ workMachineTag(work) }}</span><span class="alu-instance-cwd">{{ work.cwd.split('/').filter(Boolean).slice(-2).join('/') }}</span></span>
              <span class="alu-instance-meta">{{ workPresence(work).label }}</span>
            </button>
            <button v-if="work.reopenable && work.lifecycle !== 'active'" class="alu-instance-action" :disabled="!isTauri || workMutating || mutationOutcomeUnknown" @click="reopenFromList(work)">{{ workMutating && selected?.id === work.id ? '正在继续…' : '继续' }}</button>
            <button v-else-if="group === 'history'" class="alu-instance-action is-muted" :disabled="!isTauri" @click="forgetFromList(work)">移除</button>
          </div>
        </section>
        <div v-if="!app.works.length" class="alu-sidebar-empty">暂无工作</div>
      </div>
      <button v-if="appSettings?.windowsAwaySupported" class="alu-sidebar-settings-entry" aria-label="App 设置" @click="openAppSettings">
        <span class="alu-sidebar-settings-icon"><Settings :size="17" /></span>
        <span><strong>App 设置</strong><small>{{ windowsAwayLabel }}</small></span>
        <span aria-hidden="true">›</span>
      </button>
      <button class="alu-sidebar-settings-entry" aria-label="Host 与配对设置" @click="openHostSettings">
        <img :src="dockIconUrl" alt="" />
        <span><strong>{{ app.localSelected ? '本机 AluDock' : app.activeHost?.displayName || '连接 AluDock' }}</strong><small>{{ connectionLabel }}</small></span>
        <span aria-hidden="true">⚙</span>
      </button>
    </aside>

    <Transition name="fade">
      <div v-if="imagePreview" class="alu-image-preview-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="alu-image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1" @wheel="handleModalWheel">
          <button type="button" class="alu-image-preview-save" :disabled="imageSaving" @click="saveOpenImage"><FileDown :size="17" />{{ imageSaving ? '保存中…' : '保存图片' }}</button>
          <button type="button" class="alu-image-preview-close" aria-label="关闭图片预览" data-modal-initial @click="closeModal">×</button>
          <ImageZoomSurface :url="imagePreview.url" :name="imagePreview.name" @failed="markPreviewImageFailed" />
          <footer>
            <span>{{ imagePreview.name }}</span>
            <strong v-if="imageSaveStatus" :class="`is-${imageSaveStatus.tone}`" role="status">{{ imageSaveStatus.text }}</strong>
          </footer>
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="messageTextView" class="ui-dialog-overlay message-text-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="ui-dialog-box ui-dialog-size-wide message-text-dialog" role="dialog" aria-modal="true" aria-label="消息原文" tabindex="-1" @wheel="handleModalWheel">
          <MessageTextDialog :title="messageTextView.title" :text="messageTextView.text" :markdown="messageTextView.markdown" @close="closeModal" />
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
      <div v-if="commandOpen && selected" :class="controlSection === 'commands' ? 'cmd-palette-overlay' : controlSection === 'dock-tools' ? 'dock-tools-popover-layer' : 'ui-dialog-overlay'" :style="controlSection === 'dock-tools' ? dockToolsPopoverStyle : undefined" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop @click.self="controlSection === 'dock-tools' ? closeModal() : pulseCommandPalette()">
        <section ref="modalSurface" :class="controlSection === 'commands' ? 'cmd-palette-box' : controlSection === 'dock-tools' ? 'dock-tools-popover-surface' : controlDialogClasses(controlSection)" role="dialog" aria-modal="true" tabindex="-1" :aria-label="controlDialogTitle(controlSection)" @wheel="handleModalWheel">
          <template v-if="controlSection !== 'commands' && controlSection !== 'dock-tools'"><header class="ui-dialog-header"><div class="ui-dialog-title">{{ controlTitleOverride || controlDialogTitle(controlSection) }}</div><div v-if="controlBodyOverride || (!controlTitleOverride && controlDialogBody(controlSection))" class="ui-dialog-body">{{ controlBodyOverride || controlDialogBody(controlSection) }}</div></header><button class="ui-dialog-close" aria-label="关闭" @click="closeModal">×</button></template>
          <ControlCenter
            ref="controlCenterRef"
            :work="selected"
            :section="controlSection"
            :preview="!isTauri"
            :outcome-unknown="mutationOutcomeUnknown"
            :unknown-domain="unresolvedControlDomain"
            :has-draft="!!draft.trim()"
            :compaction-pending="selectedCompactionPending"
            @section="controlSection = $event"
            @prefill="prefillSlashCommand"
            @snapshot="applyControlSnapshot"
            @unknown="markControlUnknown"
            @reconcile="reconcileMutationOutcome"
            @resync="resyncSession"
            @compact="startCompaction"
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
      <div v-if="appSettingsOpen && appSettings" class="modal-layer" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" class="app-settings-surface" role="dialog" aria-modal="true" aria-labelledby="app-settings-title" tabindex="-1" @wheel="handleModalWheel">
          <AppSettings
            :preferences="appSettings"
            :build-identity="appBuildIdentity"
            :saving="appSettingsSaving"
            :error="appSettingsError"
            @close="closeModal"
            @update="chooseWindowsAwayDelay"
          />
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="directoryOpen || hostSettingsOpen" :class="directoryOpen ? 'ui-dialog-overlay' : 'modal-layer'" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
        <section ref="modalSurface" :class="directoryOpen ? ['ui-dialog-box', 'ui-dialog-size-wide', { 'ui-dialog-size-auto': newWorkCompact }] : 'host-settings-surface'" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="directoryOpen ? 'directory-title' : 'host-settings-title'" @wheel="handleModalWheel">
          <NewWorkDialog
            v-if="directoryOpen"
            :machines="hostMachines"
            :machines-loading="newWorkMachinesLoading"
            :machine-error="machineListError"
            :preview="!isTauri"
            :outcome-unknown="mutationOutcomeUnknown"
            @close="closeModal"
            @created="acceptCreatedWork"
            @unknown="handleNewWorkUnknown"
            @busy="newWorkMutationBusy = $event"
            @view="newWorkCompact = $event === 'launcher'"
          />
          <header v-if="hostSettingsOpen" class="host-settings-header">
            <div class="host-settings-heading"><img :src="dockIconUrl" alt="" /><div><h2 id="host-settings-title">连接设置</h2><p>本机或 Host · 版本 {{ appBuildIdentity }}</p></div></div>
            <button class="host-settings-close" data-modal-initial aria-label="关闭" @click="closeModal"><X :size="18" /></button>
          </header>
          <div v-if="hostSettingsOpen" class="host-settings-panel">
            <aside class="host-catalog-section">
              <LocalConnectionCard
                v-if="app.catalog?.localConnectionSupported"
                :connected="!!app.localSelected"
                :effective-endpoint="app.catalog.localEndpointEffective"
                :endpoint-override="app.catalog.localEndpointOverride"
                :busy="app.loading || contextTransitionBusy"
                :error="app.error"
                @connect="connectLocal"
                @save="updateLocalEndpoint"
              />
              <div class="host-catalog-title"><span>Host</span><b>{{ app.catalog?.hosts.length ?? 0 }}</b></div>
              <div class="host-catalog-list">
                <article v-for="host in app.catalog?.hosts" :key="host.hostId" class="host-choice" :class="{ active: host.hostId === app.activeHost?.hostId && !app.localSelected }">
                  <button class="host-choice-main" :disabled="host.hostId === app.activeHost?.hostId && !app.localSelected || contextTransitionBusy" @click="switchSavedHost(host.hostId)">
                    <span class="host-choice-dot" aria-hidden="true" />
                    <span class="host-choice-copy"><strong>{{ host.displayName }}</strong><small>{{ host.endpointSummary }}</small></span>
                    <span v-if="host.hostId === app.activeHost?.hostId && !app.localSelected" class="host-choice-current">当前</span>
                  </button>
                  <button class="host-choice-delete" :aria-label="`从此设备删除 ${host.displayName}`" :disabled="contextTransitionBusy" @click="removeSavedHost(host.hostId, host.displayName)"><Trash2 :size="14" /></button>
                </article>
              </div>
              <button class="host-connect-new" :disabled="contextTransitionBusy" @click="showHostPairingForm"><Plus :size="15" />连接 Host</button>
            </aside>
            <div class="host-detail-column">
              <section v-if="app.localSelected && !addingHost" class="local-connection-summary">
                <span class="local-connection-summary-icon"><Monitor :size="21" /></span>
                <div><strong>当前连接：本机 AluDock</strong><p><code>{{ app.catalog?.localEndpointEffective }}</code></p></div>
              </section>
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
            <template v-if="app.activeHost && !app.localSelected && !addingHost">
            <div class="host-detail-intro"><div><span>当前 Host</span><h3>{{ app.activeHost.displayName }}</h3></div><p>{{ app.activeHost.profile.endpoints.length }} 个 TLS 地址 · {{ app.activeHost.profile.policy.mode === 'automatic' ? '自动选择' : '固定首选' }}</p></div>
            <form class="host-profile-form" @submit.prevent="saveHostDisplayName">
              <div><strong>Host 名称</strong><small>仅修改此设备上显示的名称；地址和配对关系保持原样。</small></div>
              <div class="host-name-field"><input v-model="hostDisplayName" maxlength="128" autocomplete="off" placeholder="例如 家里的工作站" :disabled="hostNameSaving" /><button class="button secondary" :disabled="hostNameSaving || hostDisplayName.trim() === app.activeHost?.displayName">{{ hostNameSaving ? '保存中…' : '保存名称' }}</button></div>
              <p v-if="hostNameError" class="host-name-error">{{ hostNameError }}</p>
              <p v-else-if="hostNameSaved" class="host-name-success">Host 名称已保存。</p>
            </form>
            <div class="connection-policy">
              <div><Globe2 :size="18" /><span><strong>自动选择 TLS 地址</strong><small>优先局域网，不可达时尝试外网 / VPN 地址</small></span></div>
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
                    <button :disabled="!!endpointMutatingId" @click="testEndpoint(endpoint)">{{ endpointMutatingId === endpoint.id ? '测试中…' : endpoint.state === 'draft_unverified' ? '验证' : '测试' }}</button>
                    <button :disabled="!!endpointMutatingId" @click="toggleEndpoint(endpoint)">{{ endpoint.state === 'disabled' ? '重新启用' : '停用' }}</button>
                    <button v-if="endpoint.state === 'verified'" class="endpoint-use" :class="{ selected: app.activeHost?.profile.policy.mode === 'fixed' && app.activeHost!.profile.policy.endpointId === endpoint.id }" :disabled="!!endpointMutatingId" @click="chooseConnectionPolicy('fixed', endpoint.id)">{{ app.activeHost?.profile.policy.mode === 'fixed' && app.activeHost.profile.policy.endpointId === endpoint.id ? '已设为首选' : '设为首选' }}</button>
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
              <div v-if="endpointCanSaveDraft" class="endpoint-draft-offer"><span>当前网络无法完成验证。可先保存为待验证草稿；验证通过后才会参与自动连接。</span><button type="button" class="button secondary" :disabled="endpointSaving" @click="saveEndpointDraft">保存为待验证草稿</button></div>
              <footer><span><ShieldCheck :size="14" />原配对保持不变</span><button class="button primary" :disabled="!endpointHost.trim() || !endpointPort || endpointSaving">{{ endpointSaving ? '正在验证…' : '验证并添加' }}</button></footer>
            </form>
            </template>
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
