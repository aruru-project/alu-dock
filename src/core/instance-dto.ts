import type { DiagnosticDto, ResourceDto, SettingValueMap } from "./config-projection.js";
import type { JsonObject, JsonValue } from "./json-value.js";
import type { AttachmentDto } from "./instance-attachments.js";
export type { AttachmentDto } from "./instance-attachments.js";
import type { AgentSessionMetrics, ThinkingLevel } from "./agent-worker.js";
import type { BuiltInToolPresentation } from "./tool-result-presentation.js";
import type { PublishedFileDto } from "./published-file.js";
export type { PublishedFileDto } from "./published-file.js";

export type InstanceLifecycle = "active" | "stopping" | "stopped" | "host_lost" | "runtime_error";
export type InstanceExecution = "idle" | "running" | "failed" | "unavailable";
export type LastRunResult = "never" | "succeeded" | "failed" | "aborted" | "interrupted";
export type DeliveryMode = "auto" | "prompt" | "steer" | "followUp";

export interface ExecutorIdentity {
  kind: "pi-sdk" | string;
  version?: string;
  piSessionId: string;
  sessionFile?: string;
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: ThinkingLevel;
}

export interface ImagePathDto { path: string; mimeType: string }

export const MAX_CONVERSATION_CONTENT_BLOCKS = 200;

export type ContentBlockDto =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mimeType: string; contentRef?: string; fileId?: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; publishedFile?: PublishedFileDto; presentation?: BuiltInToolPresentation; omittedFields?: string[] }
  | { type: "omitted"; kind: "image" | "binary"; description: string };

export const MAX_SEMANTIC_HISTORY_PAGE_ITEMS = 100_000;
/** Per-chunk character bound for conversation.content pages (text, base64 image data, and argument JSON alike). */
export const MAX_CONVERSATION_CHUNK_CHARS = 32_000;
/** Decoded-byte bound for one conversation image stream chunk. */
export const MAX_CONVERSATION_IMAGE_CHUNK_BYTES = 512 * 1_024;
/** Leaves room for the Protocol V2 response envelope under its 1 MiB line cap. */
export const MAX_SEMANTIC_HISTORY_PAGE_BYTES = 512 * 1_024;
export const MAX_PENDING_QUEUE_ITEMS = 64;
export const MAX_PENDING_QUEUE_TEXT_CHARS = 256_000;
export const MAX_INPUT_IMAGES = 10;
export const MAX_IMAGE_PATH_CHARS = 16_384;
export const MAX_IMAGE_MIME_TYPE_CHARS = 256;
export const MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS = 512_000;
export const MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS = 512_000;
export const MAX_IMAGE_BYTES = 20 * 1_024 * 1_024;
export const MAX_IMAGE_AGGREGATE_BYTES = 80 * 1_024 * 1_024;

export interface PendingDto { steering: number; followUp: number; total: number }
export interface PendingMessageDto {
  queueItemId: string;
  operationId: string;
  delivery: "steer" | "followUp";
  text: string;
  images?: ImagePathDto[];
  attachments?: AttachmentDto[];
  acceptedAt: string;
}
export type ConversationRecordKind =
  | "message"
  | "custom_message"
  | "bash_execution"
  | "compaction_summary"
  | "branch_summary"
  | "custom"
  | "model_change"
  | "thinking_level_change"
  | "session_info"
  | "label";
export type ConversationRecordSource = "user" | "assistant" | "tool" | "system" | "extension" | "runtime";
export type ConversationRecordVisibility = "conversation" | "metadata" | "hidden";

/** One authoritative persisted conversation/session record produced by the Worker adapter. */
export interface ConversationRecordDto {
  recordId: string;
  /** Stable branch-position identity: native when available, otherwise synthesized by the Worker adapter. */
  entryId: string;
  parentId?: string;
  kind: ConversationRecordKind;
  source: ConversationRecordSource;
  visibility: ConversationRecordVisibility;
  timestamp?: string;
  content: ContentBlockDto[];
  attachments?: AttachmentDto[];
  stopReason?: string;
  error?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  display?: boolean;
  metadata?: JsonValue;
  metadataOmittedFields?: string[];
  command?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  fromEntryId?: string;
  targetEntryId?: string;
  label?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  name?: string;
}

/** Paginated session history and conversation history expose the same canonical record. */
export type HistoryEntryDto = ConversationRecordDto;
export interface HistoryPageDto {
  historyRevision: number;
  entries: HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
}

export type ConversationContentChunkDto =
  | { blockIndex: number; type: "text" | "thinking"; text: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "image_ref"; mimeType: string; contentRef?: string; fileId?: string }
  | { blockIndex: number; type: "image"; mimeType: string; data: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "tool_call"; toolCallId: string; toolName: string; argumentsJson: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "tool_result"; toolCallId: string; toolName: string; text: string; offset: number; blockComplete: boolean; isError: boolean; publishedFile?: PublishedFileDto; omittedFields?: string[] }
  | { blockIndex: number; type: "omitted"; kind: "image" | "binary"; description: string };

export interface ConversationHistoryEntryDto {
  entry: HistoryEntryDto;
  contentRef: string;
  contentComplete: boolean;
  totalBlocks: number;
}

export interface ConversationHistoryPageDto {
  instance: InstanceSnapshot;
  revision: string;
  entries: ConversationHistoryEntryDto[];
  hasEarlier: boolean;
  nextCursor?: string;
}

export interface ConversationContentPageDto {
  instanceId: string;
  runtimeGeneration: number;
  revision: string;
  contentRef: string;
  chunks: ConversationContentChunkDto[];
  complete: boolean;
  nextCursor?: string;
}

/** Worker-produced immutable image body. Public clients receive it as bounded stream frames. */
export interface ConversationImageBody {
  contentRef: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: string;
}

export type TreeNodeKind =
  | "message"
  | "thinking_level_change"
  | "model_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";
export type TreeNodeDisplayClass = "content" | "tool" | "metadata" | "structural";
export type TreeNodeState = "error" | "aborted";
export interface TreeNodeDto {
  entryId: string;
  parentId?: string;
  depth: number;
  kind: TreeNodeKind;
  role?: "user" | "assistant" | "tool" | "system";
  displayClass: TreeNodeDisplayClass;
  state?: TreeNodeState;
  label?: string;
  timestamp?: string;
  summary: string;
  hasChildren: boolean;
}
export type SessionMetricsDto = AgentSessionMetrics;
export const MAX_SESSION_FIRST_USER_MESSAGE_CHARS = 512;
export interface SessionDto {
  sessionId: string;
  sessionFile: string;
  name?: string;
  /** Optional immutable preview for human session pickers; clients may ignore it. */
  firstUserMessage?: string;
  cwd: string;
  updatedAt?: string;
  /**
   * Latest user/assistant message time, or the session start when it has no
   * messages. Unlike updatedAt it does not move when a file is only renamed or copied.
   */
  lastActivityAt?: string;
  /** Sum of every call cost recorded in the file; absent when none was recorded. A locating aid, not billing. */
  costTotal?: number;
}
export interface SessionCompactionDto { summary: string; firstKeptEntryId: string; tokensBefore: number }
export type SettingsChangedData = {
  [K in keyof SettingValueMap]: {
    key: K;
    value: SettingValueMap[K];
    reloadRequired: boolean;
    hostRestartRequired: boolean;
  }
}[keyof SettingValueMap];

export interface EventDataMap {
  "instance.created": { cwd: string; name?: string; displayName: string; executor: ExecutorIdentity };
  "instance.state_changed": { reason: string; lifecycle: InstanceLifecycle; execution: InstanceExecution; compacting: boolean; lastRun: LastRunResult; pending: PendingDto; activeCommandId?: string; lastError?: string };
  "instance.reopened": { previousLifecycle: "host_lost" | "runtime_error"; sessionFile: string; runtimeGeneration: number };
  "instance.stopped": { cleanupErrors: string[] };
  "instance.runtime_error": { operationId: string; kind: "create" | "new" | "switch" | "fork" | "clone" | "reload" | "reopen"; error: string; recoverySessionFile?: string };
  "instance.error": { operationId?: string; source: "event_projection" | "command_background"; error: string; runtimeEventType?: string };
  "command.accepted": { operationId: string; delivery: "prompt" | "steer" | "followUp"; queued: boolean; acceptedAt: string };
  "command.rejected": { operationId: string; reason: string; error: string };
  "command.handled": { operationId: string; kind: "extension_command" | "no_run" };
  "run.started": { operationId: string };
  "run.retry_started": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "run.retry_completed": { success: boolean; attempt: number; error?: string };
  "run.settled": { operationId?: string; result: LastRunResult; stopReason?: string; error?: string };
  "message.queued": PendingMessageDto;
  "message.submitted": { operationId: string; messageId: string; role: "user"; text: string; images?: ImagePathDto[]; attachments?: AttachmentDto[]; delivery: "prompt" | "steer" | "followUp"; queueItemId?: string };
  "message.delta": { messageId: string; block: "text" | "thinking"; delta: string };
  "message.completed": { messageId: string; role: "user" | "assistant" | "tool" | "system"; content: ContentBlockDto[]; attachments?: AttachmentDto[]; stopReason?: string; error?: string };
  "tool.started": { toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] };
  "tool.args_updated": { toolCallId: string; args: JsonObject; omittedFields?: string[] };
  "tool.output_updated": { toolCallId: string; text: string; content?: ContentBlockDto[]; publishedFile?: PublishedFileDto; presentation?: BuiltInToolPresentation };
  "tool.completed": { toolCallId: string; toolName: string; text: string; isError: boolean; content?: ContentBlockDto[]; publishedFile?: PublishedFileDto; presentation?: BuiltInToolPresentation; omittedFields?: string[] };
  "queue.changed": PendingDto;
  "queue.cleared": PendingDto & { queueItemIds: string[]; reason: "dequeued" | "abort" | "stop" | "replacement" | "host_draining" };
  "compaction.started": { reason: "manual" | "threshold" | "overflow"; operationId?: string };
  "compaction.completed": { reason: "manual" | "threshold" | "overflow"; operationId?: string; aborted: boolean; willRetry: boolean; error?: string };
  "session.replaced": { reason: "new" | "resume" | "fork" | "clone" | "reload"; previousSessionFile?: string; sessionFile?: string; runtimeGeneration: number; cwd: string; piSessionId: string; name?: string; displayName: string; gitBranch?: string };
  "session.navigated": { targetId: string; leafId?: string; summaryCreated: boolean };
  "session.info_changed": { name?: string; displayName: string };
  "session.metrics_changed": { metrics: SessionMetricsDto };
  "git.branch_changed": { branch?: string };
  "model.changed": { provider: string; id: string; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] };
  "thinking.changed": { requested: ThinkingLevel; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] };
  "resources.reloaded": { resources: ResourceDto[]; diagnostics: DiagnosticDto[] };
  "settings.changed": SettingsChangedData;
  "settings.write_failed": { key: keyof SettingValueMap | "model" | "thinking"; error: string };
  "interaction.requested":
    | { controllerId: string; interactionId: string; method: "select"; title: string; options: string[]; issuedAt: string; expiresAt?: string }
    | { controllerId: string; interactionId: string; method: "confirm"; title: string; message: string; issuedAt: string; expiresAt?: string }
    | { controllerId: string; interactionId: string; method: "input"; title: string; placeholder?: string; issuedAt: string; expiresAt?: string }
    | { controllerId: string; interactionId: string; method: "editor"; title: string; prefill?: string; issuedAt: string; expiresAt?: string };
  "interaction.resolved": { interactionId: string; method: "select" | "confirm" | "input" | "editor" };
  "interaction.cancelled": { interactionId: string; method: "select" | "confirm" | "input" | "editor"; reason: "user" | "timeout" | "signal" | "detach" | "replacement" | "host_draining" | "overflow" };
  "extension.notification": { message: string; level: "info" | "warning" | "error"; operationId?: string };
  "extension.title_set": { controllerId: string; title: string };
  "extension.editor_text_set": { controllerId: string; text: string };
  "extension.status_changed": { key: string; text?: string };
  "extension.tools_expanded_changed": { expanded: boolean };
  "extension.widget_changed": { key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
  "extension.error": { source?: string; event?: string; error: string };
}

export const CONVERSATION_FRAME_TYPES = [
  "message.submitted",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.args_updated",
  "tool.output_updated",
  "tool.completed",
] as const;
export type ConversationFrameType = typeof CONVERSATION_FRAME_TYPES[number];
export type ConversationFrame = {
  [K in ConversationFrameType]: { type: K; data: EventDataMap[K] }
}[ConversationFrameType];

export interface EventCursor {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  sequence: number;
}

export interface InstanceSnapshot {
  id: string;
  creationOperationId: string;
  /** Stable Machine identity from machine.list; supplied by the Main Host boundary. */
  hostId?: string;
  key?: string;
  /** Current Agent session name; it is not a stable Dock instance identity. */
  name?: string;
  /** Canonical safe label for human-facing Dock instance lists. */
  displayName: string;
  cwd: string;
  gitBranch?: string;
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  compacting: boolean;
  lastRun: LastRunResult;
  reopenable: boolean;
  runtimeGeneration: number;
  ownerHostEpoch?: string;
  interruption?: { reason: "host_crash" | "host_shutdown" | "replacement_failed"; at: string };
  pending: PendingDto;
  executor: ExecutorIdentity;
  metrics?: SessionMetricsDto;
  extensionStatus: Record<string, string>;
  toolsExpanded: boolean;
  activeInteraction?: { id: string; method: "select" | "confirm" | "input" | "editor"; expiresAt?: string };
  activeCommandId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** Authoritative start of the current execution state. */
  executionChangedAt: string;
  /** Authoritative start of the current continuous running interval. */
  runStartedAt?: string;
  eventCursor: EventCursor;
}

export type DockEvent = {
  [K in keyof EventDataMap]: {
    scope: "instance";
    sequence: number;
    instanceId: string;
    runtimeGeneration: number;
    occurredAt: string;
    type: K;
    data: EventDataMap[K];
  }
}[keyof EventDataMap];

export interface EventPage {
  events: DockEvent[];
  earliest: EventCursor;
  latest: EventCursor;
  truncated: boolean;
}

export interface AttachProjection {
  instance: InstanceSnapshot;
  page: EventPage;
  recentHistory: HistoryEntryDto[];
  historyRevision: number;
  historyTruncated: boolean;
  pendingMessages: PendingMessageDto[];
  replaySince: number;
  epochChanged: boolean;
  generationChanged: boolean;
}

export interface QueueDequeueReceipt {
  operationId: string;
  instanceId: string;
  restored: PendingMessageDto[];
  inFlight: PendingMessageDto[];
}

export interface CommandReceipt {
  accepted: true;
  instanceId: string;
  operationId: string;
  kind: "prompt" | "extension_command";
  delivery: Exclude<DeliveryMode, "auto">;
  queued: boolean;
  acceptedAt: string;
}

export const MAX_STOP_CLEANUP_ERRORS = 100;
export const MAX_STOP_CLEANUP_ERROR_CHARS = 2_048;

export interface StopReceipt {
  operationId: string;
  instanceId: string;
  stopped: true;
  alreadyStopped: boolean;
  cleanupErrors?: string[];
}
