import { type OperationContext, type OperationTarget, type HostOperationContext, type NativeOperation } from './operationBinding'
import { convertFileSrc, invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
import { previewNative } from '../preview/native'
import type {
  BootstrapPayload,
  CommandCompletionsResult,
  CommandContentResult,
  CommandsResult,
  ClientPreferences,
  HostRoute,
  DeliverableDto,
  DeliverableSaveResult,
  DesktopShellStatus,
  EndpointTestResult,
  ExtensionControllerBinding,
  HostCatalog,
  HostConnectionProfile,
  ConnectionContext,
  InteractionMethod,
  InteractionResponse,
  MachineDto,
  ModelRef,
  ModelsResult,
  ModelVisibilityResult,
  ModelVisibilitySetResult,
  NativeMedia,
  PublishedFileDto,
  QueueDequeueResult,
  SavedDeliverableLocation,
  ResourcesResult,
  ResourceContentResult,
  SystemCatalogCursor,
  SystemCatalogResult,
  SystemDefaultSetResult,
  SelectedAttachment,
  SessionCompactionResult,
  SessionForkResult,
  SavedSessionPage,
  SessionNameResult,
  SessionNavigateResult,
  SessionReloadResult,
  CompactionPromptTemplatesResult,
  SessionReplacementResult,
  SessionTree,
  ShellRunResult,
  SettingKey,
  SettingsResult,
  SettingUpdateResult,
  SettingValue,
  StopResult,
  ThinkingLevel,
  ToolsResult,
  Work,
  WorkCatalog,
  WindowsAwayDelay,
  WorkspaceCursor,
  WorkspaceFileCacheResult,
  WorkspaceFileCursor,
  WorkspaceFileEntry,
  WorkspaceFileEntryResult,
  WorkspaceFilePage,
  WorkspaceFileSaveResult,
  WorkspacePage,
} from './types'

export const isTauri = '__TAURI_INTERNALS__' in window

/** Every native call. Outside the App only the development preview answers,
 * with sample data; a production build has no preview data and shows
 * “请在 AluDock 客户端中打开” instead of mounting the App (see main.ts). */
function native<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (isTauri) return invoke<T>(command, args, options)
  if (import.meta.env.DEV) return previewNative<T>(command, args)
  return Promise.reject(new Error('请在 AluDock 客户端中打开。'))
}

export async function getSystemDeviceName(): Promise<string | null> {
  return native<string | null>('system_device_name')
}

export async function getClientPreferences(): Promise<ClientPreferences> {
  return native<ClientPreferences>('get_client_preferences')
}

export async function updateClientPreferences(
  expectedRevision: number,
  windowsAwayDelay: WindowsAwayDelay,
): Promise<ClientPreferences> {
  return native<ClientPreferences>('update_client_preferences', { expectedRevision, windowsAwayDelay })
}

export async function beginWindowsAway(runningInstanceIds: string[]): Promise<string | null> {
  return native<string | null>('begin_windows_away', { runningInstanceIds })
}

export async function cancelWindowsAway(awayId?: string | null): Promise<boolean> {
  return native<boolean>('cancel_windows_away', { awayId: awayId ?? null })
}

export async function getDesktopShellStatus(): Promise<DesktopShellStatus> {
  return native<DesktopShellStatus>('desktop_shell_status')
}

export async function startDesktopHost(): Promise<DesktopShellStatus> {
  return native<DesktopShellStatus>('start_desktop_host')
}

export async function openDesktopHostLog(): Promise<void> {
  await native('open_desktop_host_log')
}

export async function openDesktopTui(): Promise<void> {
  await native('open_desktop_tui')
}

export async function getHostCatalog(): Promise<HostCatalog> {
  return native<HostCatalog>('get_host_catalog')
}

export async function setActiveHost(hostId: string, expectedRevision: number): Promise<HostCatalog> {
  return native<HostCatalog>('set_active_host', { hostId, expectedRevision })
}

export async function connectLocalDock(expectedRevision: number): Promise<HostCatalog> {
  return native<HostCatalog>('connect_local_dock', { expectedRevision })
}

export async function setLocalEndpoint(expectedRevision: number, endpoint?: string): Promise<HostCatalog> {
  return native<HostCatalog>('set_local_endpoint', { expectedRevision, endpoint: endpoint?.trim() || null })
}

export async function removeSavedHost(hostId: string, expectedRevision: number): Promise<HostCatalog> {
  return native<HostCatalog>('remove_saved_host', { hostId, expectedRevision })
}

export async function startPairing(requestId: string, host: string, port: number, deviceName: string): Promise<void> {
  await native('start_pairing', { requestId, host, port, deviceName })
}

export async function cancelPairing(requestId: string): Promise<boolean> {
  return native<boolean>('cancel_pairing', { requestId })
}

export async function verifyHostEndpoint(
  host: string,
  port: number,
  label: string,
  expectedRevision: number,
  context: ConnectionContext): Promise<HostConnectionProfile> {
  return native<HostConnectionProfile>('verify_host_endpoint', { ...context, expectedRevision, host, port, label })
}

export async function saveUnverifiedHostEndpoint(
  host: string,
  port: number,
  label: string,
  expectedRevision: number,
  context: ConnectionContext): Promise<HostConnectionProfile> {
  return native<HostConnectionProfile>('save_unverified_host_endpoint', { ...context, expectedRevision, host, port, label })
}

export async function testHostEndpoint(endpointId: string, expectedRevision: number, context: ConnectionContext): Promise<EndpointTestResult> {
  return native<EndpointTestResult>('test_host_endpoint', { ...context, endpointId, expectedRevision })
}

export async function renameHostProfile(displayName: string, expectedRevision: number, context: ConnectionContext): Promise<HostConnectionProfile> {
  return native<HostConnectionProfile>('rename_host_profile', { ...context, displayName, expectedRevision })
}

export async function setHostEndpointEnabled(endpointId: string, enabled: boolean, expectedRevision: number, context: ConnectionContext): Promise<HostConnectionProfile> {
  return native<HostConnectionProfile>('set_host_endpoint_enabled', { ...context, endpointId, enabled, expectedRevision })
}

export async function deleteHostEndpoint(endpointId: string, expectedRevision: number, context: ConnectionContext): Promise<HostConnectionProfile> {
  return native<HostConnectionProfile>('delete_host_endpoint', { ...context, endpointId, expectedRevision })
}

export async function reselectHostRoute(context: ConnectionContext): Promise<boolean> {
  return native<boolean>('reselect_host_route', { ...context })
}

/** Answers at once without `seenRouteGeneration`; otherwise once the route changes, or unchanged after a while. */
export async function watchHostRoute(seenRouteGeneration: number | null, context: ConnectionContext): Promise<HostRoute> {
  return native<HostRoute>('watch_host_route', { ...context, seenRouteGeneration })
}

export async function bootstrap(context: ConnectionContext): Promise<BootstrapPayload> {
  return native<BootstrapPayload>('bootstrap', { ...context })
}

export async function workCatalog(context: ConnectionContext): Promise<WorkCatalog> {
  return native<WorkCatalog>('work_catalog', { ...context })
}

export async function startConversationFollow(
  instanceId: string,
  subscriptionId: string,
  context: ConnectionContext, hostEpoch: string, refresh = false): Promise<void> {
  await native('start_conversation_follow', { ...context, instanceId, subscriptionId, hostEpoch, refresh })
}

export async function stopConversationFollow(instanceId: string, subscriptionId: string, context: ConnectionContext): Promise<boolean> {
  return native('stop_conversation_follow', { ...context, instanceId, subscriptionId })
}

export async function acquireExtensionControl(instanceId: string, expectedHostEpoch: string, expectedRuntimeGeneration: number, context: ConnectionContext): Promise<ExtensionControllerBinding> {
  return native<ExtensionControllerBinding>('acquire_extension_control', { ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration })
}

export async function releaseExtensionControl(handle: string, context: ConnectionContext): Promise<void> {
  await native('release_extension_control', { ...context, handle })
}

export async function respondExtensionInteraction(handle: string, interactionId: string, response: InteractionResponse, cancelled = false, context: ConnectionContext): Promise<{ interactionId: string; state: 'resolved' | 'already_resolved' }> {
  const method: InteractionMethod = response.method
  return native('respond_extension_interaction', {
    ...context, handle, interactionId, method, cancelled,
    value: 'value' in response ? response.value : null,
    confirmed: 'confirmed' in response ? response.confirmed : null,
  })
}

export async function reportExtensionViewport(handle: string, width: number, height: number, context: ConnectionContext): Promise<void> {
  await native('set_extension_widget_viewport', { ...context, handle, width, height })
}

export async function pickAttachments(workId: string, context: ConnectionContext): Promise<SelectedAttachment[]> {
  return native('pick_attachments', { ...context, workId })
}

export async function stageClipboardImage(workId: string, bytes: Uint8Array, imageIndex: number, context: ConnectionContext): Promise<SelectedAttachment> {
  return native<SelectedAttachment>('stage_clipboard_image', bytes, {
    headers: {
      'x-aludock-connection-id': context.connectionId,
      'x-aludock-selection-generation': String(context.selectionGeneration),
      'x-aludock-work-id': workId,
      'x-aludock-image-index': String(imageIndex),
    },
  })
}

export async function loadAttachmentPreview(workId: string, token: string, context: ConnectionContext): Promise<NativeMedia> {
  return native('attachment_preview', { ...context, workId, token })
}

export type PreviewImageSaveResult = { status: 'cancelled' } | { status: 'saved'; label: string }

export async function savePreviewImage(name: string, handle: string): Promise<PreviewImageSaveResult> {
  return native<PreviewImageSaveResult>('save_preview_image', { name, handle })
}

export async function attachmentSnapshot(workId: string, context: ConnectionContext): Promise<{ revision: number; jobs: import('./types').AttachmentJobSnapshot[] }> {
  return native('attachment_snapshot', { ...context, workId })
}

export async function uploadAttachment(work: Work, token: string, context: ConnectionContext): Promise<void> {
  return native('upload_attachment', {
    ...context,
    workId: work.id,
    targetMachineHostId: work.hostId ?? context.connectionId,
    expectedHostEpoch: work.ownerHostEpoch ?? '',
    expectedRuntimeGeneration: work.runtimeGeneration,
    token,
  })
}

export async function cancelAttachmentUpload(workId: string, token: string, context: ConnectionContext): Promise<boolean> {
  return native('cancel_attachment_upload', { ...context, workId, token })
}

export async function removeAttachment(workId: string, token: string, context: ConnectionContext): Promise<boolean> {
  return native('remove_attachment', { ...context, workId, token })
}

export async function dequeueMessages(instanceId: string, context: OperationTarget): Promise<QueueDequeueResult> {
  return native('dequeue_messages', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId })
}

export async function clearRestoredImages(work: Work, context: ConnectionContext): Promise<{ imageCount: number }> {
  return native('clear_restored_images', { ...context, instanceId: work.id, expectedHostEpoch: work.ownerHostEpoch, expectedRuntimeGeneration: work.runtimeGeneration })
}

export async function submitMessage(instanceId: string, message: string, attachmentFileIds: string[], context: OperationContext): Promise<{ receipt: { queued: boolean; delivery: string }; instance: Work }> {
  return native('submit_message', { ...context, instanceId, message, attachmentFileIds, operationId: crypto.randomUUID() })
}

/** Stops the reply and takes the waiting Queue back in the same Host step. */
export async function abortRun(instanceId: string, context: OperationTarget): Promise<QueueDequeueResult> {
  return native<QueueDequeueResult>('abort_run', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId })
}

/** Pi's `!` (`excludeFromContext: false`) or `!!` (`true`) in the Work's directory; output arrives as bash.* events. */
export async function runShellCommand(instanceId: string, command: string, excludeFromContext: boolean, context: OperationTarget): Promise<ShellRunResult> {
  return native<ShellRunResult>('run_shell_command', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId, command, excludeFromContext })
}

/** Stops every shell command this Work is running; the Agent reply is untouched. */
export async function abortShellCommands(instanceId: string, context: OperationTarget): Promise<Work> {
  return native<Work>('abort_shell_commands', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId })
}

export async function stopWork(instanceId: string, context: OperationTarget): Promise<StopResult> {
  return native<StopResult>('stop_work', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId })
}

export async function commandCatalog(instanceId: string, context: ConnectionContext): Promise<CommandsResult> {
  return native<CommandsResult>('command_catalog', { ...context, instanceId })
}

export async function getCommandContent(instanceId: string, referenceId: string, cursor: string | undefined, context: ConnectionContext): Promise<CommandContentResult> {
  return native<CommandContentResult>('command_content', { ...context, instanceId, referenceId, cursor: cursor ?? null })
}

export async function getCommandCompletions(instanceId: string, referenceId: string, argumentPrefix: string, context: ConnectionContext): Promise<CommandCompletionsResult> {
  return native<CommandCompletionsResult>('command_completions', { ...context, instanceId, referenceId, argumentPrefix })
}

export async function runCatalogCommand(instanceId: string, name: string, argumentsText: string, operationId: string, context: OperationTarget): Promise<{ receipt: { operationId: string; kind: 'prompt' | 'extension_command'; queued: boolean; delivery: string }; instance: Work }> {
  return native('run_catalog_command', { ...context, operationEditor: null, instanceId, name, arguments: argumentsText, operationId })
}

export async function listModels(instanceId: string, context: ConnectionContext): Promise<ModelsResult> {
  return native<ModelsResult>('list_models', { ...context, instanceId })
}

export async function setModel(instanceId: string, provider: string, modelId: string, context: OperationTarget): Promise<Work> {
  return native<Work>('set_model', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId, provider, modelId })
}

export async function setThinking(instanceId: string, level: ThinkingLevel, context: OperationTarget): Promise<Work> {
  return native<Work>('set_thinking', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId, level })
}

export async function listTools(instanceId: string, context: ConnectionContext): Promise<ToolsResult> {
  return native<ToolsResult>('list_tools', { ...context, instanceId })
}

export async function setActiveTools(instanceId: string, names: string[], context: OperationTarget): Promise<ToolsResult> {
  return native<ToolsResult>('set_active_tools', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId, names })
}

export async function getSettings(instanceId: string, context: ConnectionContext): Promise<SettingsResult> {
  return native<SettingsResult>('get_settings', { ...context, instanceId })
}

export async function updateSetting(instanceId: string, key: SettingKey, value: SettingValue, context: OperationTarget): Promise<SettingUpdateResult> {
  return native<SettingUpdateResult>('update_setting', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId, update: { key, value } })
}

export async function getResourceContent(instanceId: string, contentRef: string, context: ConnectionContext, offset?: number, revision?: string): Promise<ResourceContentResult> {
  return native<ResourceContentResult>('resource_content', { ...context, instanceId, contentRef, offset: offset ?? null, revision: revision ?? null })
}

export async function getResources(instanceId: string, context: ConnectionContext): Promise<ResourcesResult> {
  return native<ResourcesResult>('get_resources', { ...context, instanceId })
}

export async function forgetWork(instanceId: string, context: OperationTarget): Promise<void> {
  return native('forget_work', { ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId })
}

export async function reopenWork(instanceId: string, context: OperationTarget, continuation?: CreateWorkContinuation): Promise<Work> {
  return native<Work>('reopen_work', {
    ...context, operationEditor: null, operationId: crypto.randomUUID(), instanceId,
    ...(continuation ? { operationId: continuation.operationId } : {}),
    trustChallengeId: continuation?.trustChallengeId ?? null,
    projectTrustDecision: continuation?.projectTrustDecision ?? null,
  })
}

export async function readConversationContent(context: ConnectionContext, instanceId: string, expectedHostEpoch: string, token: string, intent: 'earlier' | 'retry' | 'interest', entryIds: string[] = []): Promise<void> {
  await native('read_conversation_content', { ...context, instanceId, expectedHostEpoch, token, intent, entryIds })
}

export function nativeMediaUrl(media: { handle: string; sizeBytes: number }) {
  return { handle: media.handle, url: convertFileSrc(media.handle, 'aludock-media'), sizeBytes: media.sizeBytes }
}

export async function loadConversationImage(
  instanceId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  contentRef: string,
  mimeType: string,
  context: ConnectionContext,
  fileId?: string,
): Promise<{ handle: string; url: string; sizeBytes: number }> {
  const media = await native<NativeMedia>('conversation_image', {
    ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, contentRef, mimeType, fileId,
  })
  return nativeMediaUrl(media)
}

export async function registerInlineConversationImage(
  instanceId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  data: string,
  mimeType: string,
  context: ConnectionContext,
): Promise<{ handle: string; url: string; sizeBytes: number }> {
  const media = await native<NativeMedia>('inline_conversation_image', {
    ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, data, mimeType,
  })
  return nativeMediaUrl(media)
}

export async function loadPublishedImage(
  instanceId: string,
  expectedHostEpoch: string,
  expectedRuntimeGeneration: number,
  file: PublishedFileDto,
  context: ConnectionContext,
): Promise<{ handle: string; url: string; sizeBytes: number }> {
  const media = await native<NativeMedia>('published_image', {
    ...context, instanceId, expectedHostEpoch, expectedRuntimeGeneration, file,
  })
  return nativeMediaUrl(media)
}

export async function listDeliverables(instanceId: string, context: ConnectionContext): Promise<DeliverableDto[]> {
  return native<DeliverableDto[]>('list_deliverables', { ...context, instanceId })
}

export async function downloadDeliverable(
  instanceId: string,
  deliverable: DeliverableDto,
  context: ConnectionContext,
): Promise<DeliverableSaveResult> {
  return native<DeliverableSaveResult>('download_deliverable', { ...context, instanceId, deliverable })
}

export async function openSavedDeliverable(location: SavedDeliverableLocation): Promise<void> {
  return native<void>('open_saved_deliverable', { location })
}

function binaryBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(value)
  throw new Error('图片内容无法解码，请重新读取。')
}

export interface SessionContext extends ConnectionContext {
  instanceId: string
  expectedHostEpoch: string
  expectedRuntimeGeneration: number
}
/** The Session scope of one Work on the given connection selection. */
export function sessionContext(context: ConnectionContext, work: Pick<Work, 'id' | 'ownerHostEpoch' | 'runtimeGeneration'>): SessionContext {
  return {
    connectionId: context.connectionId, selectionGeneration: context.selectionGeneration,
    instanceId: work.id, expectedHostEpoch: work.ownerHostEpoch ?? '', expectedRuntimeGeneration: work.runtimeGeneration,
  }
}
export interface SessionTrustContinuation {
  operationId: string
  trustChallengeId?: string
  projectTrustDecision?: CreateWorkContinuation['projectTrustDecision']
}

/** Resume: saved Sessions in the Work's directory on the Work's machine. */
export async function listSessions(context: SessionContext, place: { machineHostId?: string; cwd: string }, cursor?: string): Promise<SavedSessionPage> {
  return native<SavedSessionPage>('list_sessions', { ...context, machineHostId: place.machineHostId ?? null, cwd: place.cwd, cursor: cursor ?? null })
}
/** New Work: every saved Session on the selected machine. */
export async function listSessionInventory(context: ConnectionContext, machineHostId: string, cwd: string, cursor?: string): Promise<SavedSessionPage> {
  return native<SavedSessionPage>('session_inventory', { ...context, machineHostId, cwd, cursor: cursor ?? null })
}
export async function newSession(context: OperationContext, operationId: string): Promise<SessionReplacementResult> {
  return native('new_session', { ...context, operationId })
}
export async function switchSession(context: OperationContext, sessionToken: string, continuation: SessionTrustContinuation): Promise<SessionReplacementResult> {
  return native('switch_session', { ...context, sessionToken, operationId: continuation.operationId, trustChallengeId: continuation.trustChallengeId || null, projectTrustDecision: continuation.projectTrustDecision || null })
}
export async function nameSession(context: OperationTarget, name: string, operationId: string): Promise<SessionNameResult> {
  return native('name_session', { ...context, operationEditor: null, name, operationId })
}
export async function compactionPrompts(context: SessionContext): Promise<CompactionPromptTemplatesResult> {
  return native('compaction_prompts', { ...context })
}
export async function compactSession(context: OperationTarget, customInstructions: string | undefined, operationId: string): Promise<SessionCompactionResult> {
  return native('compact_session', { ...context, operationEditor: null, customInstructions: customInstructions || null, operationId })
}
export async function reloadSession(context: OperationContext, operationId: string): Promise<SessionReloadResult> {
  return native('reload_session', { ...context, operationId })
}
export async function loadSessionTree(context: SessionContext): Promise<SessionTree> {
  return native('session_tree', { ...context })
}
export async function navigateSession(context: OperationContext, targetId: string, summarize: boolean, operationId: string): Promise<SessionNavigateResult> {
  return native('navigate_session', { ...context, targetId, summarize, customInstructions: null, operationId })
}
export async function forkSession(context: OperationContext, entryId: string, operationId: string): Promise<SessionForkResult> {
  return native('fork_session', { ...context, entryId, operationId })
}
export async function cloneSession(context: OperationContext, entryId: string, operationId: string): Promise<SessionReplacementResult> {
  return native('clone_session', { ...context, entryId, operationId })
}

export interface WorkspaceFileContext extends ConnectionContext {
  instanceId: string
  expectedHostEpoch: string
  expectedRuntimeGeneration: number
}

export async function listWorkspaceEntries(
  path: string,
  cursor: WorkspaceFileCursor | undefined,
  context: WorkspaceFileContext,
): Promise<WorkspaceFilePage> {
  return native<WorkspaceFilePage>('workspace_entries', { ...context, path, cursor: cursor ?? null })
}

export async function getWorkspaceEntryMetadata(
  path: string,
  context: WorkspaceFileContext,
): Promise<WorkspaceFileEntryResult> {
  return native<WorkspaceFileEntryResult>('workspace_entry_metadata', { ...context, path })
}

export async function readWorkspaceFile(
  readId: string,
  expectedEntry: WorkspaceFileEntry,
  largeFileConfirmed: boolean,
  context: WorkspaceFileContext,
): Promise<WorkspaceFileCacheResult> {
  return native<WorkspaceFileCacheResult>('read_workspace_file', {
    ...context, readId, expectedEntry, largeFileConfirmed,
  })
}

export async function cancelWorkspaceFileRead(readId: string, context: WorkspaceFileContext): Promise<boolean> {
  return native<boolean>('cancel_workspace_file_read', { ...context, readId })
}

export async function clearWorkspaceFileState(): Promise<void> {
  await native('clear_workspace_file_state')
}

export async function loadWorkspaceCachedText(cacheId: string, context: WorkspaceFileContext): Promise<string> {
  return native<string>('workspace_cached_text', { ...context, cacheId })
}

export async function loadWorkspaceCachedImage(cacheId: string, context: WorkspaceFileContext): Promise<Uint8Array> {
  const value = await native<ArrayBuffer | Uint8Array | number[]>('workspace_cached_image', { ...context, cacheId })
  return binaryBytes(value)
}

export async function saveWorkspaceCachedFile(cacheId: string, context: WorkspaceFileContext): Promise<WorkspaceFileSaveResult> {
  return native<WorkspaceFileSaveResult>('save_workspace_cached_file', { ...context, cacheId })
}

export async function listMachines(context: ConnectionContext): Promise<MachineDto[]> {
  return native<MachineDto[]>('list_machines', { ...context })
}

/** Omit targetHostId for the connected Host itself. */
export async function getModelVisibility(context: ConnectionContext, targetHostId?: string): Promise<ModelVisibilityResult> {
  return native<ModelVisibilityResult>('model_visibility', { ...context, targetHostId: targetHostId ?? null })
}

export async function setModelVisibility(hidden: ModelRef[], context: ConnectionContext, targetHostId?: string): Promise<ModelVisibilitySetResult> {
  return native<ModelVisibilitySetResult>('set_model_visibility', { ...context, targetHostId: targetHostId ?? null, hidden })
}

export async function listWorkspace(
  path: string,
  context: ConnectionContext,
  targetHostId?: string,
  cursor?: WorkspaceCursor,
): Promise<WorkspacePage> {
  return native<WorkspacePage>('list_workspace', {
    ...context, path, targetHostId: targetHostId ?? null, cursor: cursor ?? null,
  })
}

export async function systemCatalog(cwd: string, context: ConnectionContext, targetHostId: string, cursor?: SystemCatalogCursor): Promise<SystemCatalogResult> {
  return native<SystemCatalogResult>('system_catalog', { ...context, cwd, targetHostId, cursor: cursor ?? null })
}

export async function systemContent(cwd: string, id: string, context: ConnectionContext, targetHostId: string, offset?: number, revision?: string): Promise<ResourceContentResult> {
  return native<ResourceContentResult>('system_content', { ...context, cwd, id, targetHostId, offset: offset ?? null, revision: revision ?? null })
}

export async function setSystemDefault(cwd: string, id: string, context: HostOperationContext, targetHostId: string): Promise<SystemDefaultSetResult> {
  return native<SystemDefaultSetResult>('set_system_default', { ...context, cwd, id, targetHostId })
}

export interface CreateWorkContinuation {
  operationId: string
  trustChallengeId: string
  projectTrustDecision: 'trust_once' | 'trust_and_remember' | 'deny_once' | 'deny_and_remember'
}

export async function adoptSession(
  sessionToken: string,
  context: HostOperationContext,
  machineHostId: string,
  name?: string,
  continuation?: CreateWorkContinuation,
): Promise<Work> {
  return native<Work>('adopt_session', {
    ...context,
    machineHostId,
    sessionToken,
    name: name || null,
    operationId: continuation?.operationId ?? null,
    trustChallengeId: continuation?.trustChallengeId ?? null,
    projectTrustDecision: continuation?.projectTrustDecision ?? null,
  })
}

export async function createWork(
  cwd: string,
  context: HostOperationContext,
  name?: string,
  continuation?: CreateWorkContinuation,
  targetHostId?: string,
  workerConfig?: Record<string, unknown>,
): Promise<Work> {
  return native<Work>('create_work', {
    ...context, cwd,
    workerConfig: workerConfig ?? null,
    name: name || null,
    targetHostId: targetHostId ?? null,
    operationId: continuation?.operationId ?? null,
    trustChallengeId: continuation?.trustChallengeId ?? null,
    projectTrustDecision: continuation?.projectTrustDecision ?? null,
  })
}

export function pendingOperations(): Promise<NativeOperation[]> {
  return native('pending_operations')
}
export function consumeOperation(operationId: string): Promise<void> {
  return native('consume_operation', { operationId })
}

export function restoredImageCount(work: Work, context: ConnectionContext): Promise<number> {
  return native('restored_image_count', { ...context, instanceId: work.id, expectedHostEpoch: work.ownerHostEpoch, expectedRuntimeGeneration: work.runtimeGeneration })
}

export function acknowledgeConversationFollow(context: ConnectionContext, instanceId: string, subscriptionId: string, deliveryId: number): Promise<void> {
  return native('acknowledge_conversation_follow', { connectionId: context.connectionId, selectionGeneration: context.selectionGeneration, instanceId, subscriptionId, deliveryId })
}
