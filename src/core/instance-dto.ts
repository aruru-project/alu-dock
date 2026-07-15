import type { DiagnosticDto, ResourceDto, SettingValueMap } from "./config-projection.js";
import type { RuntimeSessionMetrics, RuntimeThinkingLevel } from "./runtime-session.js";

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
  thinkingLevel?: RuntimeThinkingLevel;
}

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ContentBlockDto =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] }
  | { type: "omitted"; kind: "image" | "binary"; description: string };

export interface PendingDto { steering: number; followUp: number; total: number }
export interface HistoryEntryDto {
  entryId: string;
  parentId?: string;
  role: "user" | "assistant" | "tool" | "system";
  timestamp?: string;
  content: ContentBlockDto[];
  stopReason?: string;
  error?: string;
}
export interface HistoryPageDto {
  entries: HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
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
export interface TreeNodeDto {
  entryId: string;
  parentId?: string;
  depth: number;
  kind: TreeNodeKind;
  role?: "user" | "assistant" | "tool" | "system";
  label?: string;
  timestamp?: string;
  summary: string;
  hasChildren: boolean;
}
export interface TreePageDto {
  treeRevision: string;
  nodes: TreeNodeDto[];
  leafId?: string;
  total: number;
  truncated: boolean;
  nextAfterEntryId?: string;
}
export type SessionMetricsDto = RuntimeSessionMetrics;
export interface SessionDto { sessionId: string; sessionFile: string; name?: string; cwd: string; updatedAt?: string }
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
  "instance.created": { cwd: string; name?: string; executor: ExecutorIdentity };
  "instance.state_changed": { reason: string; lifecycle: InstanceLifecycle; execution: InstanceExecution; lastRun: LastRunResult; pending: PendingDto; activeCommandId?: string; lastError?: string };
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
  "message.submitted": { operationId: string; messageId: string; role: "user"; text: string };
  "message.delta": { messageId: string; block: "text" | "thinking"; delta: string };
  "message.completed": { messageId: string; role: "user" | "assistant" | "tool" | "system"; content: ContentBlockDto[]; stopReason?: string; error?: string };
  "tool.started": { toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] };
  "tool.args_updated": { toolCallId: string; args: JsonObject; omittedFields?: string[] };
  "tool.output_updated": { toolCallId: string; text: string };
  "tool.completed": { toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] };
  "queue.changed": PendingDto;
  "queue.cleared": PendingDto;
  "compaction.started": { reason: "manual" | "threshold" | "overflow" };
  "compaction.completed": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; error?: string };
  "session.replaced": { reason: "new" | "resume" | "fork" | "reload"; previousSessionFile?: string; sessionFile?: string; runtimeGeneration: number; cwd: string; piSessionId: string; name?: string };
  "session.navigated": { targetId: string; leafId?: string; treeRevision: string; summaryCreated: boolean };
  "session.info_changed": { name?: string };
  "session.metrics_changed": { metrics: SessionMetricsDto };
  "model.changed": { provider: string; id: string; thinkingLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[] };
  "thinking.changed": { requested: RuntimeThinkingLevel; thinkingLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[] };
  "resources.reloaded": { resources: ResourceDto[]; diagnostics: DiagnosticDto[] };
  "settings.changed": SettingsChangedData;
  "settings.write_failed": { key: keyof SettingValueMap | "model" | "thinking"; error: string };
  "interaction.requested":
    | { interactionId: string; method: "select"; title: string; options: string[]; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "confirm"; title: string; message: string; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "input"; title: string; placeholder?: string; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "editor"; title: string; prefill?: string; issuedAt: string; expiresAt: string };
  "interaction.resolved": { interactionId: string; method: "select" | "confirm" | "input" | "editor" };
  "interaction.cancelled": { interactionId: string; method: "select" | "confirm" | "input" | "editor"; reason: "user" | "timeout" | "signal" | "detach" | "replacement" | "host_draining" | "overflow" };
  "extension.notification": { message: string; level: "info" | "warning" | "error" };
  "extension.status_changed": { key: string; text?: string };
  "extension.widget_changed": { key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
  "extension.error": { source?: string; event?: string; error: string };
}

export interface EventCursor {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  sequence: number;
}

export interface InstanceSnapshot {
  id: string;
  creationOperationId: string;
  name?: string;
  cwd: string;
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  lastRun: LastRunResult;
  reopenable: boolean;
  runtimeGeneration: number;
  ownerHostEpoch?: string;
  interruption?: { reason: "host_crash" | "host_shutdown" | "replacement_failed"; at: string };
  pending: PendingDto;
  executor: ExecutorIdentity;
  metrics?: SessionMetricsDto;
  extensionStatus: Record<string, string>;
  activeInteraction?: { id: string; method: "select" | "confirm" | "input" | "editor"; expiresAt: string };
  activeCommandId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
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
  historyTruncated: boolean;
  replaySince: number;
  epochChanged: boolean;
  generationChanged: boolean;
}

export interface CommandReceipt {
  accepted: true;
  instanceId: string;
  operationId: string;
  delivery: Exclude<DeliveryMode, "auto">;
  queued: boolean;
  acceptedAt: string;
}

export interface StopReceipt {
  operationId: string;
  instanceId: string;
  stopped: true;
  alreadyStopped: boolean;
  cleanupErrors?: string[];
}
