// The Rust core turns any Host enum value this build does not know into 'unrecognized'
// instead of failing the whole response; newer Hosts may add values at any time.
export type Unrecognized = 'unrecognized'
export type Lifecycle = 'active' | 'stopping' | 'stopped' | 'host_lost' | 'runtime_error' | Unrecognized
export type Execution = 'idle' | 'running' | 'failed' | 'unavailable' | Unrecognized
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

/** Host journal position; event numbers restart with each runtime generation. */
export interface EventCursor { hostEpoch: string; instanceId: string; runtimeGeneration: number; sequence: number }

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
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
    cost?: number
    context?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }
  extensionStatus: Record<string, string>
  toolsExpanded: boolean
  activeInteraction?: ActiveInteraction
  lastError?: string
  createdAt: string
  updatedAt: string
  /** Which Host event this state includes; replies and live events are ordered by it, not by time. */
  eventCursor: EventCursor
}

/** Judged by the client from the address itself; users never choose it. */
export type ConnectionKind = 'local' | 'remote' | 'vpn'
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
  /** Kept in the order a connection tries them. */
  endpoints: HostEndpoint[]
}

export interface ConnectionContext {
  connectionId: string
  selectionGeneration: number
}

/** Which saved address the selected Host's connection is using right now. */
export interface HostRoute extends ConnectionContext {
  routeGeneration: number
  activeEndpointId: string | null
}

export type ConnectionTarget =
  | { kind: 'local' }
  | { kind: 'host'; hostId: string }

export interface HostCatalogEntry {
  hostId: string
  displayName: string
  deviceName: string
  addedAt: string
  profile: HostConnectionProfile
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
}

export interface HostSummary {
  state: string
  hostEpoch: string
  dockVersion: string
  piSdkVersion: string
  startedAt: string
  profile?: HostConnectionProfile
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

export interface NativeMedia { handle: string; mimeType: string; sizeBytes: number; sha256: string }

export type ContentBlock =
  | { type: 'text' | 'thinking'; text: string }
  | { type: 'image'; mimeType: string; contentRef?: string; data?: string; fileId?: string; nativeMedia?: NativeMedia }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: unknown; omittedFields?: string[] }
  | { type: 'tool_result'; toolCallId: string; toolName: string; text: string; isError: boolean; publishedFile?: PublishedFileDto; nestedCalls?: unknown; omittedFields?: string[] }
  | { type: 'omitted'; kind: string; description: string }
  | { type: Unrecognized }

export interface LocalAttachmentUpload {
  connectionId: string
  selectionGeneration: number
  instanceId: string
  machineHostId: string
  ownerHostEpoch: string
  runtimeGeneration: number
  /** Editing association only; native scoped query must verify this run. */
  jobId?: string
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
  truncated?: boolean
  /** Pi's temporary full-output file on the Work's machine; shown for copying or for the Agent to read, never sent back. */
  fullOutputPath?: string
  excludeFromContext?: boolean
  label?: string
  stopReason?: string
  provider?: string | null
  modelId?: string | null
  /** System prompt record: the sections and tools it changes; its content holds the new texts. */
  systemPrompt?: SystemPromptChange
  /** Usage record: a request paid for outside the conversation, such as cache warming. */
  usage?: RecordUsage
  /** Context edit record: whether targetEntryId left or was replaced in what the model sees. */
  contextEdit?: 'omit' | 'replace'
  targetEntryId?: string
}

/** What one text block of a system prompt record is; `blocks[i]` names content block i. */
export type SystemPromptBlock = { kind: 'instructions' } | { kind: 'section' | 'tool'; name: string }

export interface SystemPromptChange {
  sections: string[]
  removedSections: string[]
  toolsAdded: string[]
  toolsRemoved: string[]
  blocks: SystemPromptBlock[]
}

export interface RecordUsage {
  kind: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  note?: string
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
export interface PendingAttachmentSelection {
  jobId: string
  revision: string
  sessionId: string
}
export interface AttachmentJobSnapshot extends SelectedAttachment {
  revision: number
  connectionId: string
  workId: string
  target?: { machineHostId: string; ownerHostEpoch: string; runtimeGeneration: number }
  state: 'selected' | AttachmentUploadPhase | 'succeeded' | 'failed' | 'unknown'
  progress?: { phase: AttachmentUploadPhase; bytesProcessed: number; totalBytes: number }
  result?: AttachmentUploadResult
  error?: { message: string; outcomeUnknown: boolean }
}
export interface AttachmentUploadResult {
  attachment: AttachmentDto
  status: 'stored' | 'reused'
}
export interface QueueDequeueResult {
  receipt: { instanceId: string; restored: QueueItem[]; inFlight: QueueItem[] }
  instance: Work
}
export interface ShellRunResult {
  receipt: { operationId: string; instanceId: string; startedAt: string }
  instance: Work
}
export interface ProjectedEvent { sequence: number; runtimeGeneration: number; occurredAt: string; eventType: string; data: Record<string, unknown> }
export interface ExtensionBootstrap {
  status: Record<string, string>
  toolsExpanded: boolean
  activeInteraction?: ActiveInteraction
  events: ProjectedEvent[]
  /** Questions arrive with this Work's updates and any window may answer them; older Hosts omit it. */
  sharedQuestions?: boolean
}

export interface ConversationBootstrap {
  instance: Work
  records: ConversationRecord[]
  activeEvents: ProjectedEvent[]
  extensionUi: ExtensionBootstrap
  queue: QueueItem[]
  cursor: EventCursor
  historyRevision: number
  historyTruncated: boolean
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

/** One saved Session in the list shared by Resume and "new Work from a saved Session"; native sends an absent value as `null`. */
export interface SavedSession {
  token: string
  name?: string | null
  firstUserMessage?: string | null
  cwd: string
  /** Latest conversation time (older Hosts: last file change). */
  lastActivityAt?: string | null
  /** Recorded call costs summed over the Session; absent when none were recorded. */
  costTotal?: number | null
  current: boolean
}
export interface SavedSessionPage extends ConnectionContext {
  sessions: SavedSession[]
  total: number
  incomplete: boolean
  /** Present while later Sessions remain; pass it back to read the next page. */
  nextCursor?: string
  machineHostId?: string
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

/** One exact model on one machine: provider plus model id. */
export interface ModelRef { provider: string; id: string }
/** A machine's selectable models and the ones its Host leaves out of every model list. */
export interface ModelVisibilityResult {
  models: ModelInfo[]
  total: number
  truncated: boolean
  hidden: ModelRef[]
  /** A hand-edited list could not be used; that machine hides nothing until it is saved. */
  fileProblem?: string
}
export interface ModelVisibilitySetResult { hidden: ModelRef[] }

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
  | 'doubleEscapeAction' | 'treeFilterMode' | 'defaultProjectTrust' | 'cacheWarming' | 'httpIdleTimeoutMs'
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
  | { type: 'native'; media: NativeMedia }
  | { type: 'conversation'; contentRef: string; mimeType: string }
  | { type: 'inline'; data: string; mimeType: string }
  | { type: 'published'; file: PublishedFileDto }

export interface ConversationImageResource {
  handle?: string
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

/** Calls a tool made to other tools while it ran (for example from a codemode script). */
export interface NestedToolCall {
  toolName: string
  /** The call's arguments as JSON text; absent when they were too large to keep. */
  argumentsJson?: string
  /** `running` only while watching live; `unfinished` was still running when the tool ended. */
  status: 'running' | 'ok' | 'error' | 'unfinished'
  durationMs?: number
  error?: string
}
export interface NestedToolCalls {
  calls: NestedToolCall[]
  /** False when some calls or arguments were too large to keep. */
  complete: boolean
}

export type ConversationProcessItem = (
  | { id: string; kind: 'assistant'; groupId: string; text: string; time: string; groupTime?: string }
  | { id: string; kind: 'thinking'; groupId: string; title: string; text: string; open?: boolean; groupTime?: string }
  | { id: string; kind: 'tool'; groupId: string; toolCallId?: string; name: string; summary: string; status: 'running' | 'done' | 'error'; detail?: string; preview?: ToolCallPreview; nestedCalls?: NestedToolCalls; detailArgs?: unknown; detailOutputText?: string; detailOmittedFields?: string[]; groupTime?: string }
  | { id: string; kind: 'image'; groupId: string; imageKey: string; mimeType: string; fileId?: string; name?: string; sizeBytes?: number; source?: ConversationImageSource; historyEntryId?: string; groupTime?: string }
  | { id: string; kind: 'notice'; groupId?: string; tone: 'info' | 'warning' | 'error'; text: string; groupTime?: string }
  /** Recorded text shown as written, such as a system prompt section or a tool definition, under what it is. */
  | { id: string; kind: 'plain'; groupId: string; text: string; label?: string; groupTime?: string }

) & { sourceEntryIds?: string[]; turnId?: string }

export type ConversationTurnStatus = 'running' | 'completed' | 'aborted' | 'failed' | 'interrupted'
/** One Agent run. Live turns are exact (`run.started` → `run.settled`); history turns
 * are inferred from record order, so their timestamps and status are approximate. */
export interface ConversationTurnItem {
  id: string
  kind: 'turn'
  turnId: string
  status: ConversationTurnStatus
  startedAt?: string
  endedAt?: string
  error?: string
  /** A running segment observed without its own `run.started` continues the turn before it. */
  continuation?: boolean
}

export type ShellRunStatus = 'running' | 'done' | 'failed' | 'stopped'
/** One user shell command (Pi `!` / `!!`), live from bash.* events or from its bash_execution record.
 * It stands on its own in the timeline: it is not part of the Agent turn running beside it. */
export interface ShellRunItem {
  id: string
  kind: 'shell'
  operationId: string
  command: string
  excludeFromContext: boolean
  status: ShellRunStatus
  /** Live output tail while running, or the recorded output afterwards. */
  output: string
  /** This client joined after the command started: output before that is not shown, the run record will have it. */
  outputMissing?: boolean
  exitCode?: number
  truncated: boolean
  fullOutputPath?: string
  error?: string
  time: string
}

export type ConversationItem = (
  | { id: string; kind: 'user'; text: string; time: string; attachments?: AttachmentDto[]; images?: Array<Extract<ConversationProcessItem, { kind: 'image' }>> }
  | ConversationTurnItem
  | ConversationProcessItem
  /** `readOnOpen`: the record's text is long and read only once the reader opens the panel; `entryId` names the record to read. */
  | { id: string; kind: 'record'; title: string; panelClass: string; folded: boolean; parts: ConversationProcessItem[]; readOnOpen?: boolean; entryId?: string }
  | ShellRunItem

) & { sourceEntryIds?: string[]; turnId?: string }

export interface SystemCandidate {
  id: string
  name: string
  kind: 'project-system' | 'global-system' | 'dock-template'
  path: string
  workerConfig: Record<string, unknown>
  warning?: string
}
export interface SystemCatalogCursor { revision: string; offset: number }
export interface SystemCatalogResult {
  cwd: string
  candidates: SystemCandidate[]
  total: number
  revision: string
  warnings: string[]
  defaultSelection?: SystemCandidate
  nextCursor?: SystemCatalogCursor
}
export interface SystemDefaultSetResult { selection: SystemCandidate }

/** Native default instructions; excludes this call's conversation and extension payload. */
export interface CompactionPromptTemplatesResult {
  system: string
  summarize: string
  update: string
  turnPrefix: string
}
