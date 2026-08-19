import { invoke } from '@tauri-apps/api/core'
import type {
  AttachmentUploadResult,
  BootstrapPayload,
  CommandsResult,
  ConnectionKind,
  ConversationBootstrap,
  ConversationHistoryPage,
  EndpointTestResult,
  ExtensionControllerBinding,
  HostCatalog,
  HostConnectionProfile,
  HostContext,
  InteractionMethod,
  InteractionResponse,
  ModelsResult,
  PublishedFileDto,
  QueueDequeueResult,
  ResourcesResult,
  SelectedAttachment,
  SessionCompactionResult,
  SessionForkResult,
  SessionListResult,
  SessionNameResult,
  SessionNavigateResult,
  SessionReloadResult,
  SessionReplacementResult,
  SessionTree,
  SettingKey,
  SettingsResult,
  SettingUpdateResult,
  SettingValue,
  StopResult,
  ThinkingLevel,
  ToolsResult,
  Work,
  WorkCatalog,
  WorkspacePage,
} from './types'

export const isTauri = '__TAURI_INTERNALS__' in window

export async function getSystemDeviceName(): Promise<string | null> {
  if (isTauri) return invoke<string | null>('system_device_name')
  return null
}

export async function getHostCatalog(): Promise<HostCatalog> {
  if (isTauri) return invoke<HostCatalog>('get_host_catalog')
  return previewCatalog
}

export async function setActiveHost(hostId: string, expectedRevision: number): Promise<HostCatalog> {
  if (isTauri) return invoke<HostCatalog>('set_active_host', { hostId, expectedRevision })
  throw new Error('浏览器设计预览不会切换 Host')
}

export async function removeLocalHost(hostId: string, expectedRevision: number): Promise<HostCatalog> {
  if (isTauri) return invoke<HostCatalog>('remove_local_host', { hostId, expectedRevision })
  throw new Error('浏览器设计预览不会删除本地 Host')
}

export async function resumePairing(transactionId: string): Promise<void> {
  if (isTauri) await invoke('resume_pairing', { transactionId })
}

export async function startPairing(host: string, port: number, deviceName: string, replacementHostId?: string): Promise<string> {
  if (isTauri) return invoke<string>('start_pairing', { host, port, deviceName, replacementHostId: replacementHostId ?? null })
  throw new Error('浏览器设计预览不会发起配对')
}

export async function cancelPairing(transactionId: string): Promise<boolean> {
  if (isTauri) return invoke<boolean>('cancel_pairing', { transactionId })
  return false
}

export async function discardPairing(transactionId: string): Promise<void> {
  if (isTauri) await invoke('discard_pairing', { transactionId })
}

export async function getConnectionProfile(context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('get_connection_profile', { ...context })
  return previewBootstrap.host.profile
}

export async function verifyHostEndpoint(
  host: string,
  port: number,
  label: string,
  kind: ConnectionKind,
  expectedRevision: number,
  context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('verify_host_endpoint', { ...context, expectedRevision, host, port, label, kind })
  throw new Error('浏览器设计预览不会保存连接地址')
}

export async function saveUnverifiedHostEndpoint(
  host: string,
  port: number,
  label: string,
  kind: ConnectionKind,
  expectedRevision: number,
  context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('save_unverified_host_endpoint', { ...context, expectedRevision, host, port, label, kind })
  throw new Error('浏览器设计预览不会保存连接地址草稿')
}

export async function testHostEndpoint(endpointId: string, expectedRevision: number, context: HostContext): Promise<EndpointTestResult> {
  if (isTauri) return invoke<EndpointTestResult>('test_host_endpoint', { ...context, endpointId, expectedRevision })
  throw new Error('浏览器设计预览不会测试连接地址')
}

export async function renameHostProfile(displayName: string, expectedRevision: number, context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('rename_host_profile', { ...context, displayName, expectedRevision })
  throw new Error('浏览器设计预览不会修改 Host 名称')
}

export async function setConnectionPolicy(mode: 'automatic' | 'fixed', expectedRevision: number, context: HostContext, endpointId?: string): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('set_connection_policy', { ...context, mode, endpointId: endpointId ?? null, expectedRevision })
  throw new Error('浏览器设计预览不会修改连接策略')
}

export async function setHostEndpointEnabled(endpointId: string, enabled: boolean, expectedRevision: number, context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('set_host_endpoint_enabled', { ...context, endpointId, enabled, expectedRevision })
  throw new Error('浏览器设计预览不会修改连接地址状态')
}

export async function reorderHostEndpoints(endpointIds: string[], expectedRevision: number, context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('reorder_host_endpoints', { ...context, endpointIds, expectedRevision })
  throw new Error('浏览器设计预览不会调整连接地址顺序')
}

export async function deleteHostEndpoint(endpointId: string, expectedRevision: number, context: HostContext): Promise<HostConnectionProfile> {
  if (isTauri) return invoke<HostConnectionProfile>('delete_host_endpoint', { ...context, endpointId, expectedRevision })
  throw new Error('浏览器设计预览不会删除连接地址')
}

export async function bootstrap(context: HostContext): Promise<BootstrapPayload> {
  if (isTauri) return invoke<BootstrapPayload>('bootstrap', { ...context })
  await delay(280)
  const preview = new URLSearchParams(window.location.search).get('preview')
  if (preview === 'onboarding') throw { code: 'not_paired', message: '浏览器配对界面预览' }
  if (preview === 'offline') throw { code: 'host_unreachable', message: '无法连接“家里的工作站”；浏览器离线状态预览。' }
  return previewBootstrap
}

export async function workCatalog(context: HostContext): Promise<WorkCatalog> {
  if (isTauri) return invoke<WorkCatalog>('work_catalog', { ...context })
  return {
    hostId: previewBootstrap.hostId,
    selectionGeneration: previewBootstrap.selectionGeneration,
    hostEpoch: previewBootstrap.host.hostEpoch,
    instances: previewBootstrap.works,
    total: previewBootstrap.total,
    hiddenStopped: previewBootstrap.hiddenStopped,
  }
}

export async function startConversationFollow(
  instanceId: string,
  subscriptionId: string,
  cursor: ConversationBootstrap['cursor'],
  context: HostContext): Promise<void> {
  if (isTauri) await invoke('start_conversation_follow', { ...context, instanceId, subscriptionId, cursor })
}

export async function acquireExtensionControl(instanceId: string, expectedHostEpoch: string, expectedRuntimeGeneration: number, context: HostContext): Promise<ExtensionControllerBinding> {
  if (isTauri) return invoke<ExtensionControllerBinding>('acquire_extension_control', { ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration })
  throw new Error('浏览器设计预览不会取得 Extension UI 控制权')
}

export async function releaseExtensionControl(handle: string, context: HostContext): Promise<void> {
  if (isTauri) await invoke('release_extension_control', { ...context, handle })
}

export async function respondExtensionInteraction(handle: string, interactionId: string, response: InteractionResponse, cancelled = false, context: HostContext): Promise<{ interactionId: string; state: 'resolved' | 'already_resolved' }> {
  if (!isTauri) throw new Error('浏览器设计预览不会回答 Extension UI')
  const method: InteractionMethod = response.method
  return invoke('respond_extension_interaction', {
    ...context, handle, interactionId, method, cancelled,
    value: 'value' in response ? response.value : null,
    confirmed: 'confirmed' in response ? response.confirmed : null,
  })
}

export async function reportExtensionViewport(handle: string, width: number, height: number, context: HostContext): Promise<void> {
  if (isTauri) await invoke('set_extension_widget_viewport', { ...context, handle, width, height })
}

export async function setExtensionToolsExpanded(instanceId: string, expectedHostEpoch: string, expectedRuntimeGeneration: number, expanded: boolean, context: HostContext): Promise<Work> {
  if (isTauri) return invoke<Work>('set_extension_tools_expanded', { ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, expanded })
  throw new Error('浏览器设计预览不会修改 Extension UI')
}

export async function pickAttachments(workId: string, context: HostContext): Promise<SelectedAttachment[]> {
  if (isTauri) return invoke('pick_attachments', { ...context, workId })
  throw new Error('浏览器设计预览不会读取本机文件')
}

export async function stageClipboardImage(workId: string, bytes: Uint8Array, imageIndex: number, context: HostContext): Promise<SelectedAttachment> {
  if (!isTauri) throw new Error('浏览器设计预览不会读取剪贴板图片')
  return invoke<SelectedAttachment>('stage_clipboard_image', bytes, {
    headers: {
      'x-aludock-host-id': context.hostId,
      'x-aludock-selection-generation': String(context.selectionGeneration),
      'x-aludock-work-id': workId,
      'x-aludock-image-index': String(imageIndex),
    },
  })
}

export async function loadAttachmentPreviewBytes(workId: string, token: string, context: HostContext): Promise<Uint8Array> {
  if (!isTauri) throw new Error('浏览器设计预览不会读取本机附件')
  const value = await invoke<ArrayBuffer | Uint8Array | number[]>('attachment_preview', { ...context, workId, token })
  return binaryBytes(value)
}

export async function uploadAttachment(workId: string, token: string, context: HostContext): Promise<AttachmentUploadResult> {
  if (isTauri) return invoke('upload_attachment', { ...context, workId, token })
  throw new Error('浏览器设计预览不会上传附件')
}

export async function cancelAttachmentUpload(workId: string, token: string, context: HostContext): Promise<boolean> {
  if (isTauri) return invoke('cancel_attachment_upload', { ...context, workId, token })
  return false
}

export async function removeAttachment(workId: string, token: string, context: HostContext): Promise<boolean> {
  if (isTauri) return invoke('remove_attachment', { ...context, workId, token })
  return false
}

export async function dequeueMessages(instanceId: string, context: HostContext): Promise<QueueDequeueResult> {
  if (isTauri) return invoke('dequeue_messages', { ...context, instanceId })
  throw new Error('浏览器设计预览不会取回 Queue')
}

export async function clearRestoredImages(instanceId: string, context: HostContext): Promise<{ imageCount: number }> {
  if (isTauri) return invoke('clear_restored_images', { ...context, instanceId })
  return { imageCount: 0 }
}

export async function submitMessage(instanceId: string, message: string, attachmentFileIds: string[], context: HostContext): Promise<{ receipt: { queued: boolean; delivery: string }; instance: Work }> {
  if (isTauri) return invoke('submit_message', { ...context, instanceId, message, attachmentFileIds })
  await delay(180)
  throw new Error('浏览器设计预览不会发送消息')
}

export async function abortRun(instanceId: string, context: HostContext): Promise<Work> {
  if (isTauri) return invoke<Work>('abort_run', { ...context, instanceId })
  await delay(180)
  throw new Error('浏览器设计预览不会中止 Work')
}

export async function stopWork(instanceId: string, context: HostContext): Promise<StopResult> {
  if (isTauri) return invoke<StopResult>('stop_work', { ...context, instanceId })
  throw new Error('浏览器设计预览不会停止 Work')
}

export async function commandCatalog(instanceId: string, context: HostContext): Promise<CommandsResult> {
  if (isTauri) return invoke<CommandsResult>('command_catalog', { ...context, instanceId })
  await delay(100)
  return previewCommands
}

export async function runCatalogCommand(instanceId: string, name: string, argumentsText: string, operationId: string, context: HostContext): Promise<{ receipt: { operationId: string; kind: 'prompt' | 'extension_command'; queued: boolean; delivery: string }; instance: Work }> {
  if (isTauri) return invoke('run_catalog_command', { ...context, instanceId, name, arguments: argumentsText, operationId })
  throw new Error('浏览器设计预览不会运行命令')
}

export async function listModels(instanceId: string, context: HostContext): Promise<ModelsResult> {
  if (isTauri) return invoke<ModelsResult>('list_models', { ...context, instanceId })
  await delay(100)
  return { ...previewModels, instance: previewBootstrap.works.find((work) => work.id === instanceId) ?? previewBootstrap.works[0]! }
}

export async function setModel(instanceId: string, provider: string, modelId: string, context: HostContext): Promise<Work> {
  if (isTauri) return invoke<Work>('set_model', { ...context, instanceId, provider, modelId })
  throw new Error('浏览器设计预览不会切换模型')
}

export async function setThinking(instanceId: string, level: ThinkingLevel, context: HostContext): Promise<Work> {
  if (isTauri) return invoke<Work>('set_thinking', { ...context, instanceId, level })
  throw new Error('浏览器设计预览不会修改 Thinking')
}

export async function listTools(instanceId: string, context: HostContext): Promise<ToolsResult> {
  if (isTauri) return invoke<ToolsResult>('list_tools', { ...context, instanceId })
  await delay(100)
  return { ...previewTools, instance: previewBootstrap.works.find((work) => work.id === instanceId) ?? previewBootstrap.works[0]! }
}

export async function setActiveTools(instanceId: string, names: string[], context: HostContext): Promise<ToolsResult> {
  if (isTauri) return invoke<ToolsResult>('set_active_tools', { ...context, instanceId, names })
  throw new Error('浏览器设计预览不会修改工具状态')
}

export async function getSettings(instanceId: string, context: HostContext): Promise<SettingsResult> {
  if (isTauri) return invoke<SettingsResult>('get_settings', { ...context, instanceId })
  await delay(100)
  return previewSettings
}

export async function updateSetting(instanceId: string, key: SettingKey, value: SettingValue, context: HostContext): Promise<SettingUpdateResult> {
  if (isTauri) return invoke<SettingUpdateResult>('update_setting', { ...context, instanceId, update: { key, value } })
  throw new Error('浏览器设计预览不会修改设置')
}

export async function getResources(instanceId: string, context: HostContext): Promise<ResourcesResult> {
  if (isTauri) return invoke<ResourcesResult>('get_resources', { ...context, instanceId })
  await delay(100)
  return { resources: [], diagnostics: [], resourceTotal: 0, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false }
}

export async function forgetWork(instanceId: string, context: HostContext): Promise<void> {
  if (isTauri) return invoke('forget_work', { ...context, instanceId })
  throw new Error('浏览器设计预览不会移除 Work')
}

export async function reopenWork(instanceId: string, context: HostContext, continuation?: CreateWorkContinuation): Promise<Work> {
  if (isTauri) {
    return invoke<Work>('reopen_work', {
      ...context, instanceId,
      operationId: continuation?.operationId ?? null,
      trustChallengeId: continuation?.trustChallengeId ?? null,
      projectTrustDecision: continuation?.projectTrustDecision ?? null,
    })
  }
  throw new Error('浏览器设计预览不会继续 Work')
}

export async function loadConversation(instanceId: string, context: HostContext): Promise<ConversationBootstrap> {
  if (isTauri) return invoke<ConversationBootstrap>('conversation_bootstrap', { ...context, instanceId })
  await delay(120)
  const instance = previewBootstrap.works.find((work) => work.id === instanceId) ?? previewBootstrap.works[0]!
  return {
    instance,
    records: [],
    activeEvents: [],
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
    queue: instance.pending.total ? [{
      queueItemId: 'preview-queue-1',
      delivery: 'followUp',
      text: '请在确认桌面布局后，再检查窄屏 Queue 与附件操作。',
      attachments: [{
        fileId: 'd729a77f-69f0-4f12-ac4c-2badf5750220',
        name: '窄屏验收清单.txt',
        sizeBytes: 1864,
        mediaType: 'text/plain',
        sha256: 'b'.repeat(64),
        storedAt: now,
      }],
      imageCount: 1,
      acceptedAt: now,
    }] : [],
    cursor: { hostEpoch: 'preview', instanceId, runtimeGeneration: 1, sequence: 0 },
    historyRevision: 1,
    historyTruncated: false,
  }
}

export async function loadConversationHistory(
  instanceId: string,
  beforeEntryId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  expectedHistoryRevision: number,
  context: HostContext,
): Promise<ConversationHistoryPage> {
  if (isTauri) return invoke<ConversationHistoryPage>('conversation_history', {
    ...context, instanceId, beforeEntryId, expectedHostEpoch, expectedRuntimeGeneration, expectedHistoryRevision,
  })
  await delay(100)
  return { records: [], historyRevision: expectedHistoryRevision, hasEarlier: false, instance: previewBootstrap.works[0]!, hostEpoch: 'browser-preview' }
}

export async function loadConversationImageBytes(
  instanceId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  contentRef: string,
  mimeType: string,
  context: HostContext,
): Promise<Uint8Array> {
  if (!isTauri) throw new Error('浏览器设计预览不会读取远程图片')
  const value = await invoke<ArrayBuffer | Uint8Array | number[]>('conversation_image', {
    ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, contentRef, mimeType,
  })
  return binaryBytes(value)
}

export async function loadPublishedImageBytes(
  instanceId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  file: PublishedFileDto,
  context: HostContext,
): Promise<Uint8Array> {
  if (!isTauri) throw new Error('浏览器设计预览不会读取远程图片')
  const value = await invoke<ArrayBuffer | Uint8Array | number[]>('published_image', {
    ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, file,
  })
  return binaryBytes(value)
}

function binaryBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(value)
  throw new Error('图片数据格式无效。')
}

export interface SessionContext extends HostContext {
  instanceId: string
  expectedHostEpoch: string
  expectedRuntimeGeneration: number
}
export interface SessionTrustContinuation {
  operationId: string
  trustChallengeId?: string
  projectTrustDecision?: CreateWorkContinuation['projectTrustDecision']
}

export async function listSessions(context: SessionContext, scope: 'cwd' | 'all'): Promise<SessionListResult> {
  if (isTauri) return invoke<SessionListResult>('list_sessions', { ...context, scope })
  await delay(100)
  return previewSessions(context)
}
export async function newSession(context: SessionContext, operationId: string): Promise<SessionReplacementResult> {
  if (isTauri) return invoke('new_session', { ...context, operationId })
  throw new Error('浏览器设计预览不会新建 Session')
}
export async function switchSession(context: SessionContext, sessionToken: string, continuation: SessionTrustContinuation): Promise<SessionReplacementResult> {
  if (isTauri) return invoke('switch_session', { ...context, sessionToken, operationId: continuation.operationId, trustChallengeId: continuation.trustChallengeId || null, projectTrustDecision: continuation.projectTrustDecision || null })
  throw new Error('浏览器设计预览不会切换 Session')
}
export async function nameSession(context: SessionContext, name: string, operationId: string): Promise<SessionNameResult> {
  if (isTauri) return invoke('name_session', { ...context, name, operationId })
  throw new Error('浏览器设计预览不会重命名 Session')
}
export async function compactSession(context: SessionContext, customInstructions: string | undefined, operationId: string): Promise<SessionCompactionResult> {
  if (isTauri) return invoke('compact_session', { ...context, customInstructions: customInstructions || null, operationId })
  throw new Error('浏览器设计预览不会压缩 Session')
}
export async function reloadSession(context: SessionContext, operationId: string): Promise<SessionReloadResult> {
  if (isTauri) return invoke('reload_session', { ...context, operationId })
  throw new Error('浏览器设计预览不会 Reload Session')
}
export async function loadSessionTree(context: SessionContext): Promise<SessionTree> {
  if (isTauri) return invoke('session_tree', { ...context })
  await delay(100)
  return previewTree
}
export async function navigateSession(context: SessionContext, targetId: string, summarize: boolean, operationId: string): Promise<SessionNavigateResult> {
  if (isTauri) return invoke('navigate_session', { ...context, targetId, summarize, customInstructions: null, operationId })
  throw new Error('浏览器设计预览不会切换 Tree 节点')
}
export async function forkSession(context: SessionContext, entryId: string, operationId: string): Promise<SessionForkResult> {
  if (isTauri) return invoke('fork_session', { ...context, entryId, operationId })
  throw new Error('浏览器设计预览不会 Fork Session')
}
export async function cloneSession(context: SessionContext, entryId: string, operationId: string): Promise<SessionReplacementResult> {
  if (isTauri) return invoke('clone_session', { ...context, entryId, operationId })
  throw new Error('浏览器设计预览不会 Clone Session')
}

export async function listWorkspace(path: string, context: HostContext): Promise<WorkspacePage> {
  if (isTauri) return invoke<WorkspacePage>('list_workspace', { ...context, path })
  await delay(180)
  return {
    path,
    parent: path === '/workshop' ? '/' : '/workshop',
    revision: 'browser-preview',
    entries: [
      { name: 'alubot_admin', kind: 'directory', hidden: false },
      { name: 'alu_dock', kind: 'directory', hidden: false },
      { name: 'alu_workstation', kind: 'directory', hidden: false },
      { name: 'aludock-android-client', kind: 'directory', hidden: false },
      { name: '.experiments', kind: 'directory', hidden: true },
    ],
    total: 5,
    truncated: false,
  }
}

export interface CreateWorkContinuation {
  operationId: string
  trustChallengeId: string
  projectTrustDecision: 'trust_once' | 'trust_and_remember' | 'deny_once' | 'deny_and_remember'
}

export async function createWork(
  cwd: string,
  context: HostContext,
  name?: string,
  continuation?: CreateWorkContinuation,
): Promise<Work> {
  if (isTauri) {
    return invoke<Work>('create_work', {
      ...context, cwd,
      name: name || null,
      operationId: continuation?.operationId ?? null,
      trustChallengeId: continuation?.trustChallengeId ?? null,
      projectTrustDecision: continuation?.projectTrustDecision ?? null,
    })
  }
  await delay(400)
  throw new Error('浏览器设计预览不会向 Dock 提交创建操作')
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

const now = new Date().toISOString()
const previewCommands: CommandsResult = {
  commands: [
    { name: 'compact', description: '压缩当前 Session 的上下文', source: { kind: 'built-in' }, argumentCompletions: false },
    { name: 'review', description: '运行 Extension 提供的代码审查流程', source: { kind: 'extension', package: '@alu/review' }, argumentCompletions: true },
    { name: 'release-notes', description: '使用项目 Prompt 生成发布说明', source: { kind: 'prompt' }, argumentCompletions: false },
  ],
  total: 3,
  truncated: false,
}
const previewModels: Omit<ModelsResult, 'instance'> = {
  models: [
    { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200000 },
    { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, contextWindow: 200000 },
  ],
  availableThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
  total: 2,
  truncated: false,
}
const previewTools: Omit<ToolsResult, 'instance'> = {
  tools: [
    { name: 'bash', description: '在 Work 中运行命令', active: true, source: { kind: 'built-in' } },
    { name: 'read', description: '读取 Work 文件内容', active: true, source: { kind: 'built-in' } },
    { name: 'web_search', description: '搜索公开网页', active: false, source: { kind: 'extension', package: '@alu/web' } },
  ],
  total: 3,
  truncated: false,
}
const previewSettings: SettingsResult = {
  settings: [
    { key: 'autoCompaction', value: true, source: 'global', writable: true, valueType: 'boolean', reloadRequired: false, hostRestartRequired: false },
    { key: 'enableSkillCommands', value: true, source: 'project', writable: true, valueType: 'boolean', reloadRequired: true, hostRestartRequired: false },
    { key: 'transport', value: 'auto', source: 'global', writable: true, valueType: 'enum', allowedValues: ['auto', 'sse', 'websocket', 'websocket-cached'], reloadRequired: false, hostRestartRequired: false },
    { key: 'editorPaddingX', value: 1, source: 'global', writable: true, valueType: 'integer', min: 0, max: 3, reloadRequired: false, hostRestartRequired: false },
    { key: 'compactionReserveTokens', value: 16384, source: 'effective', writable: false, valueType: 'integer', min: 0, max: 2147483647, reloadRequired: false, hostRestartRequired: false },
    { key: 'warnings', value: { anthropicExtraUsage: true }, source: 'global', writable: true, valueType: 'object', reloadRequired: false, hostRestartRequired: false },
  ],
}
function previewSessions(context: SessionContext): SessionListResult {
  return {
    sessions: [
      { token: 'preview-current', name: 'Android Client', cwd: '/workshop/aludock-android-client', updatedAt: now, identity: '7c91a2', current: true },
      { token: 'preview-review', name: 'Protocol review', cwd: '/workshop/aludock-android-client', updatedAt: now, identity: '38bbd0', current: false },
      { token: 'preview-dock', name: 'Dock integration', cwd: '/workshop/alu_dock', updatedAt: now, identity: 'a910ef', current: false },
    ],
    total: 3,
    truncated: false,
    hostId: context.hostId,
    selectionGeneration: context.selectionGeneration,
    hostEpoch: context.expectedHostEpoch,
    runtimeGeneration: context.expectedRuntimeGeneration,
  }
}
const previewTree: SessionTree = {
  leafId: 'assistant-2',
  nodes: [
    { entryId: 'user-1', depth: 0, kind: 'message', role: 'user', displayClass: 'content', summary: '确认 Protocol V2 的会话边界', hasChildren: true, timestamp: now },
    { entryId: 'assistant-1', parentId: 'user-1', depth: 1, kind: 'message', role: 'assistant', displayClass: 'content', summary: '完成协议与关联校验', hasChildren: true, timestamp: now },
    { entryId: 'tool-1', parentId: 'assistant-1', depth: 2, kind: 'message', role: 'tool', displayClass: 'tool', summary: 'cargo test', hasChildren: false, timestamp: now },
    { entryId: 'user-2', parentId: 'assistant-1', depth: 2, kind: 'message', role: 'user', displayClass: 'content', label: 'UI slice', summary: '实现图形 Session Tree', hasChildren: true, timestamp: now },
    { entryId: 'assistant-2', parentId: 'user-2', depth: 3, kind: 'message', role: 'assistant', displayClass: 'content', summary: '正在完成触控界面', hasChildren: false, timestamp: now },
  ],
}
const previewBootstrap: BootstrapPayload = {
  hostId: 'browser-preview',
  selectionGeneration: 1,
  host: {
    state: 'preview',
    hostEpoch: 'browser-preview',
    dockVersion: '0.2.0',
    piSdkVersion: '0.84.2',
    startedAt: now,
    activeEndpointId: 'preview-local',
    profile: {
      schemaVersion: 1,
      revision: 1,
      hostId: 'browser-preview',
      displayName: '家里的工作站',
      endpoints: [
        { id: 'preview-local', label: '家中局域网', kind: 'local', endpoint: { host: '192.168.1.20', port: 33781 }, state: 'verified' },
        { id: 'preview-remote', label: '外网域名', kind: 'remote', endpoint: { host: 'dock.example.com', port: 443 }, state: 'verified' },
      ],
      policy: { mode: 'automatic' },
      lastSuccessfulEndpointId: 'preview-local',
    },
  },
  total: 5,
  hiddenStopped: 1,
  works: [
    previewWork('aludock-android-client', '/workshop/aludock-android-client', 'running', 'active', 'main'),
    previewWork('Alubot Admin', '/workshop/alubot_admin', 'idle', 'active', 'master'),
    previewWork('Alu Workstation', '/workshop/alu_workstation', 'unavailable', 'host_lost'),
    previewWork('alu_dock', '/workshop/alu_dock', 'idle', 'active', 'main'),
  ],
}

const previewCatalog: HostCatalog = {
  schemaVersion: 1,
  revision: 1,
  activeHostId: previewBootstrap.hostId,
  selectionGeneration: 1,
  pairingTransactionIds: [],
  pairingTransactions: [],
  hosts: [{
    hostId: previewBootstrap.hostId,
    displayName: previewBootstrap.host.profile.displayName,
    deviceName: '浏览器预览设备',
    endpointSummary: '192.168.1.20:33781',
    addedAt: now,
    profile: previewBootstrap.host.profile,
  }],
}

function previewWork(
  displayName: string,
  cwd: string,
  execution: Work['execution'],
  lifecycle: Work['lifecycle'],
  gitBranch?: string,
): Work {
  return {
    id: `preview-${displayName}`,
    displayName,
    cwd,
    gitBranch,
    lifecycle,
    execution,
    compacting: false,
    lastRun: execution === 'unavailable' ? 'interrupted' : 'succeeded',
    reopenable: lifecycle === 'host_lost',
    runtimeGeneration: 1,
    ownerHostEpoch: lifecycle === 'active' ? 'browser-preview' : undefined,
    pending: { steering: 0, followUp: execution === 'running' ? 1 : 0, total: execution === 'running' ? 1 : 0 },
    executor: {
      kind: 'pi',
      piSessionId: 'browser-preview',
      model: { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
      thinkingLevel: 'high',
    },
    metrics: {
      tokens: { input: 48210, output: 9312, total: 57522 },
      cost: 1.84,
      context: { tokens: 57522, contextWindow: 200000, percent: 28.8 },
    },
    extensionStatus: {},
    toolsExpanded: false,
    createdAt: now,
    updatedAt: now,
  }
}
