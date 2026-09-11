export type Lifecycle = 'active' | 'stopping' | 'stopped' | 'host_lost' | 'runtime_error'
export type Execution = 'idle' | 'running' | 'failed' | 'unavailable'
export type WindowsAwayDelay = 'immediate' | 'one_minute' | 'five_minutes' | 'thirty_minutes' | 'one_hour' | 'never'

export interface ClientPreferences {
  revision: number
  windowsAwayDelay: WindowsAwayDelay
  windowsAwaySupported: boolean
}

export interface DesktopShellStatus {
  hostPhase?: 'starting' | 'ready' | 'stopping' | 'stopped' | 'unknown'
  supported: boolean
  hostReady: boolean
  role?: 'main' | 'subhost'
  startupError?: string
  logsPath?: string
  loginStartEnabled: boolean
  autoStartLocalHost: boolean
}

export interface ModelIdentity {
  provider: string
  id: string
  name?: string
}

export type InteractionMethod = 'select' | 'confirm' | 'input' | 'editor'
export interface ActiveInteraction { id: string; method: InteractionMethod; expiresAt?: string }

export interface Work {
  id: string
  hostId?: string
  key?: string
  name?: string
  displayName: string
  cwd: string
  gitBranch?: string
  lifecycle: Lifecycle
  execution: Execution
  compacting: boolean
  lastRun: string
  reopenable: boolean
  runtimeGeneration: number
  ownerHostEpoch?: string
  pending: { steering: number; followUp: number; total: number }
  executor: {
    kind: string
    version?: string
    piSessionId: string
    model?: ModelIdentity
    thinkingLevel?: string
  }
  metrics?: {
    messages?: { user?: number; assistant?: number; toolCalls?: number; total?: number }
    tokens?: { input?: number; output?: number; total?: number }
    cost?: number
    context?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }
  extensionStatus: Record<string, string>
  toolsExpanded: boolean
  activeInteraction?: ActiveInteraction
  lastError?: string
  createdAt: string
  updatedAt: string
}

export type ConnectionKind = 'local' | 'remote' | 'vpn' | 'manual'
export type EndpointState = 'draft_unverified' | 'verified' | 'disabled'

export interface EndpointTestStatus {
  testedAt: string
  succeeded: boolean
  reason: string
}

export interface HostEndpoint {
  id: string
  label: string
  kind: ConnectionKind
  endpoint: { host: string; port: number }
  state: EndpointState
  verifiedAt?: string
  lastSuccessAt?: string
  disabledFrom?: Exclude<EndpointState, 'disabled'>
  lastManualTest?: EndpointTestStatus
}

export interface EndpointTestResult {
  profile: HostConnectionProfile
  endpointId: string
  succeeded: boolean
  reason: string
}

export interface HostConnectionProfile {
  schemaVersion: number
  revision: number
  hostId: string
  displayName: string
  endpoints: HostEndpoint[]
  policy: { mode: 'automatic' } | { mode: 'fixed'; endpointId: string }
  lastSuccessfulEndpointId?: string
}

export interface ConnectionContext {
  connectionId: string
  selectionGeneration: number
}

export type ConnectionTarget =
  | { kind: 'local' }
  | { kind: 'host'; hostId: string }

export interface HostCatalogEntry {
  hostId: string
  displayName: string
  deviceName: string
  endpointSummary: string
  addedAt: string
  profile: HostConnectionProfile
}

export interface RecoverablePairing {
  transactionId: string
  host?: string
  port?: number
  deviceName?: string
  recoverable: boolean
}

export interface HostCatalog {
  schemaVersion: number
  revision: number
  activeTarget?: ConnectionTarget
  localEndpointOverride?: string
  localEndpointEffective?: string
  selectionGeneration: number
  localConnectionSupported: boolean
  hosts: HostCatalogEntry[]
  pairingTransactionIds: string[]
  pairingTransactions: RecoverablePairing[]
}

export interface HostSummary {
  state: string
  hostEpoch: string
  dockVersion: string
  piSdkVersion: string
  startedAt: string
  profile?: HostConnectionProfile
  activeEndpointId: string
}

export interface BootstrapPayload {
  connectionId: string
  selectionGeneration: number
  maxAttachmentsPerMessage: number
  host: HostSummary
  works: Work[]
  total: number
  hiddenStopped: number
}

export type MachinePlatform = 'linux' | 'windows'

export interface MachineDto {
  hostId: string
  name: string
  kind: 'main' | 'subhost'
  available: boolean
  platform?: MachinePlatform
  homePath?: string
  workspaceRoots?: string[]
}

export interface WorkCatalog {
  connectionId: string
  selectionGeneration: number
  hostEpoch: string
  instances: Work[]
  total: number
  hiddenStopped: number
}

export interface WorkspaceEntry {
  name: string
  kind: 'directory' | 'symlink'
  hidden: boolean
}

export interface WorkspaceCursor {
  revision: string
  offset: number
}

export interface WorkspacePage {
  path: string
  parent?: string
  revision: string
  entries: WorkspaceEntry[]
  total: number
  truncated: boolean
  nextCursor?: WorkspaceCursor
}

export type WorkspaceFileKind = 'file' | 'directory' | 'symlink'
export type WorkspaceTargetKind = 'file' | 'directory' | 'unavailable'

export interface WorkspaceFileEntry {
  path: string
  name: string
  kind: WorkspaceFileKind
  hidden: boolean
  targetKind?: WorkspaceTargetKind
  sizeBytes?: number
}

export interface WorkspaceFileCursor {
  revision: string
  offset: number
}

export interface WorkspaceFilePage {
  instanceId: string
  path: string
  revision: string
  entries: WorkspaceFileEntry[]
  total: number
  truncated: boolean
  nextCursor?: WorkspaceFileCursor
  hostEpoch: string
}

export interface WorkspaceFileEntryResult {
  entry: WorkspaceFileEntry
  hostEpoch: string
  largeFileConfirmBytes: number
}

export interface WorkspaceFileCacheResult {
  cacheId: string
  entry: WorkspaceFileEntry
  sizeBytes: number
  sha256: string
  hostEpoch: string
}

export interface WorkspaceFileReadProgress {
  connectionId: string
  selectionGeneration: number
  instanceId: string
  readId: string
  path: string
  bytesReceived: number
  observedSizeBytes: number
}

export type WorkspaceFileSaveResult =
  | { status: 'cancelled' }
  | { status: 'saved'; label: string }

export interface PublishedFileDto {
  presentation: 'image'
  fileRef: string
  name: string
  sizeBytes: number
  mediaType?: string
}

export interface DeliverableDto {
  deliveryRef: string
  name: string
  sizeBytes: number
}

export interface SavedDeliverableLocation {
  kind: 'path' | 'uri'
  value: string
  label: string
}

export type DeliverableSaveResult =
  | { status: 'cancelled' }
  | { status: 'saved'; deliverable: DeliverableDto; location: SavedDeliverableLocation; sha256: string }

export interface DeliverableDownloadProgress extends ConnectionContext {
  instanceId: string
  deliveryRef: string
  bytesReceived: number
  totalBytes: number
}

export type ContentBlock =
  | { type: 'text' | 'thinking'; text: string }
  | { type: 'image'; mimeType: string; contentRef?: string; data?: string; fileId?: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: unknown; omittedFields?: string[] }
  | { type: 'tool_result'; toolCallId: string; toolName: string; text: string; isError: boolean; publishedFile?: PublishedFileDto; omittedFields?: string[] }
  | { type: 'omitted'; kind: string; description: string }

export interface LocalAttachmentUpload {
  connectionId: string
  selectionGeneration: number
  instanceId: string
  machineHostId: string
  ownerHostEpoch: string
  runtimeGeneration: number
  /** Process-local source handle. It is deliberately removed when state is restored from storage. */
  sourceToken?: string
}

export interface AttachmentDto {
  fileId: string
  name: string
  sizeBytes: number
  mediaType?: string
  sha256: string
  storedAt: string
  /** Client-only provenance for uploads selected on this device. Never sent as protocol data. */
  localUpload?: LocalAttachmentUpload
}

export interface ConversationRecord {
  recordId: string
  entryId: string
  kind: string
  source: string
  visibility: string
  timestamp?: string
  content: ContentBlock[]
  attachments?: AttachmentDto[]
  error?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  command?: string
  exitCode?: number
  cancelled?: boolean
  label?: string
  stopReason?: string
}

export interface QueueItem {
  queueItemId: string
  delivery: string
  text: string
  attachments: AttachmentDto[]
  imageCount: number
  acceptedAt: string
}

export interface SelectedAttachment {
  token: string
  name: string
  sizeBytes: number
  mediaType?: string
}
export type AttachmentUploadPhase = 'hashing' | 'uploading' | 'finalizing'
export interface AttachmentUploadProgress extends ConnectionContext {
  workId: string
  machineHostId: string
  ownerHostEpoch: string
  runtimeGeneration: number
  token: string
  phase: AttachmentUploadPhase
  bytesProcessed: number
  totalBytes: number
}
export interface AttachmentUploadResult {
  attachment: AttachmentDto
  status: 'stored' | 'reused'
}
export interface QueueDequeueResult {
  receipt: { instanceId: string; restored: QueueItem[]; inFlight: QueueItem[] }
  instance: Work
}
export interface ProjectedEvent { sequence: number; runtimeGeneration: number; occurredAt: string; eventType: string; data: Record<string, unknown> }
export interface ExtensionBootstrap {
  status: Record<string, string>
  toolsExpanded: boolean
  activeInteraction?: ActiveInteraction
  events: ProjectedEvent[]
}

export interface ConversationBootstrap {
  instance: Work
  records: ConversationRecord[]
  activeEvents: ProjectedEvent[]
  extensionUi: ExtensionBootstrap
  queue: QueueItem[]
  cursor: { hostEpoch: string; instanceId: string; runtimeGeneration: number; sequence: number }
  historyRevision: number
  historyTruncated: boolean
  historyBeforeEntryId?: string
}

export interface ConversationHistoryPage {
  records: ConversationRecord[]
  incompleteEntryIds: string[]
  revision: string
  hasEarlier: boolean
  nextCursor?: string
  instance: Work
  hostEpoch: string
}

export interface CompletedConversationEntry {
  record: ConversationRecord
  revision: string
  instance: Work
  hostEpoch: string
}

export type InteractionRequest =
  | { method: 'select'; interactionId: string; title: string; options: string[]; issuedAt: string; expiresAt?: string }
  | { method: 'confirm'; interactionId: string; title: string; message: string; issuedAt: string; expiresAt?: string }
  | { method: 'input'; interactionId: string; title: string; placeholder?: string; issuedAt: string; expiresAt?: string }
  | { method: 'editor'; interactionId: string; title: string; prefill?: string; issuedAt: string; expiresAt?: string }

export interface ExtensionControllerBinding extends ConnectionContext { handle: string; hostEpoch: string; instanceId: string; runtimeGeneration: number }
export interface ExtensionControllerEmission extends ExtensionControllerBinding { event: ProjectedEvent }
export interface ExtensionControllerStatus extends ExtensionControllerBinding { state: string; message?: string }
export type InteractionResponse =
  | { method: 'select' | 'input' | 'editor'; value: string }
  | { method: 'confirm'; confirmed: boolean }

export interface SessionInfo {
  token: string
  name?: string
  cwd: string
  updatedAt?: string
  identity: string
  current: boolean
}
export interface SessionListResult extends ConnectionContext {
  sessions: SessionInfo[]
  total: number
  truncated: boolean
  hostEpoch: string
  runtimeGeneration: number
}
export interface SessionInventoryInfo {
  token: string
  name?: string
  firstUserMessage?: string
  cwd: string
  updatedAt?: string
}
export interface SessionInventoryResult extends ConnectionContext {
  sessions: SessionInventoryInfo[]
  total: number
  truncated: boolean
  incomplete: boolean
  machineHostId: string
  hostEpoch: string
}
export interface SessionReplacementResult { cancelled: boolean; instance: Work }
export interface StopResult {
  receipt: { operationId: string; alreadyStopped: boolean; cleanupErrors?: string[] }
  instance: Work
}
export interface SessionNameResult { instance: Work }
export interface SessionCompactionResult {
  result: { summary: string; firstKeptEntryId: string; tokensBefore: number }
  instance: Work
}
export interface SessionReloadResult extends ResourcesResult { instance: Work }

export type TreeNodeKind = 'message' | 'thinking_level_change' | 'model_change' | 'compaction' | 'branch_summary' | 'custom' | 'custom_message' | 'label' | 'session_info'
export interface TreeNode {
  entryId: string
  parentId?: string | null
  depth: number
  kind: TreeNodeKind
  role?: 'user' | 'assistant' | 'tool' | 'system' | null
  displayClass: 'content' | 'tool' | 'metadata' | 'structural'
  state?: 'error' | 'aborted' | null
  label?: string | null
  timestamp?: string | null
  summary: string
  hasChildren: boolean
}
export interface SessionTree {
  nodes: TreeNode[]
  leafId?: string | null
}
export interface SessionNavigateResult { cancelled: boolean; aborted?: boolean; editorText?: string; instance: Work }
export interface SessionForkResult { cancelled: boolean; selectedText?: string; instance: Work }

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelInfo {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow?: number
}

export interface ModelsResult {
  models: ModelInfo[]
  availableThinkingLevels: ThinkingLevel[]
  instance: Work
  total: number
  truncated: boolean
}

export type SourceKind = 'built-in' | 'extension' | 'skill' | 'prompt'
export interface SafeSource { kind: SourceKind; package?: string }
export interface CommandInfo {
  referenceId: string
  name: string
  description?: string
  source: SafeSource
  argumentHint?: string
  argumentCompletions: boolean
  contentAvailable: boolean
}
export interface CommandsResult { commands: CommandInfo[]; total: number; truncated: boolean }
export type CommandContentResult =
  | { referenceId: string; available: false }
  | { referenceId: string; available: true; format: 'markdown'; revision: string; text: string; complete: boolean; nextCursor?: string }
export interface CommandArgumentCompletion { value: string; label: string; description?: string }
export interface CommandCompletionsResult {
  referenceId: string
  items: CommandArgumentCompletion[] | null
  total: number
  truncated: boolean
}
export interface ToolInfo { name: string; description: string; active: boolean; source?: SafeSource }
export interface ToolsResult { tools: ToolInfo[]; instance: Work; total: number; truncated: boolean }

export type SettingKey =
  | 'autoCompaction' | 'compactionReserveTokens' | 'compactionKeepRecentTokens' | 'autoRetry'
  | 'enableSkillCommands' | 'hideThinking' | 'showCacheMissNotices' | 'showHardwareCursor'
  | 'clearOnShrink' | 'showTerminalProgress' | 'quietStartup' | 'collapseChangelog'
  | 'enableInstallTelemetry' | 'steeringMode' | 'followUpMode' | 'transport'
  | 'doubleEscapeAction' | 'treeFilterMode' | 'defaultProjectTrust' | 'httpIdleTimeoutMs'
  | 'editorPaddingX' | 'outputPad' | 'autocompleteMaxVisible' | 'warnings'
export type SettingValue = boolean | number | string | { anthropicExtraUsage?: boolean }
export interface SettingInfo {
  key: SettingKey
  value: SettingValue
  source: 'global' | 'project' | 'effective'
  writable: boolean
  valueType: 'boolean' | 'enum' | 'integer' | 'object'
  allowedValues?: Array<string | number | boolean>
  min?: number
  max?: number
  reloadRequired: boolean
  hostRestartRequired: boolean
}
export interface SettingsResult { settings: SettingInfo[] }
export interface SettingUpdateResult {
  setting: SettingInfo
  instance: Work
  reloadRequired: boolean
  hostRestartRequired: boolean
}
export interface ResourceInfo { kind: 'extension' | 'skill' | 'prompt' | 'context'; name: string; source?: SafeSource; contentRef?: string }
export interface ResourceContentResult { text: string; revision: string; nextOffset?: number }
export interface ResourcesResult {
  resources: ResourceInfo[]
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; message: string }>
  resourceTotal: number
  resourcesTruncated: boolean
  diagnosticTotal: number
  diagnosticsTruncated: boolean
}

export type ConversationImageSource =
  | { type: 'conversation'; contentRef: string; mimeType: string }
  | { type: 'inline'; data: string; mimeType: string }
  | { type: 'published'; file: PublishedFileDto }

export interface ConversationImageResource {
  state: 'idle' | 'loading' | 'ready' | 'error'
  url?: string
  message?: string
}

export interface ToolCallPreview {
  title?: string
  body?: string
  variant: 'command' | 'path' | 'content' | 'diff'
  truncated: boolean
}

export type ConversationProcessItem =
  | { id: string; kind: 'assistant'; groupId: string; text: string; time: string; groupTime?: string }
  | { id: string; kind: 'thinking'; groupId: string; title: string; text: string; open?: boolean; groupTime?: string }
  | { id: string; kind: 'tool'; groupId: string; toolCallId?: string; name: string; summary: string; status: 'running' | 'done' | 'error'; detail?: string; preview?: ToolCallPreview; detailArgs?: unknown; detailOutputText?: string; detailOmittedFields?: string[]; groupTime?: string }
  | { id: string; kind: 'image'; groupId: string; imageKey: string; mimeType: string; fileId?: string; name?: string; sizeBytes?: number; source?: ConversationImageSource; historyEntryId?: string; groupTime?: string }
  | { id: string; kind: 'notice'; groupId?: string; tone: 'info' | 'warning' | 'error'; text: string; groupTime?: string }

export type ConversationItem =
  | { id: string; kind: 'user'; text: string; time: string; attachments?: AttachmentDto[]; images?: Array<Extract<ConversationProcessItem, { kind: 'image' }>> }
  | { id: string; kind: 'activity' }
  | ConversationProcessItem
  | { id: string; kind: 'record'; title: string; panelClass: string; folded: boolean; parts: ConversationProcessItem[] }
