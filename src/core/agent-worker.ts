import type {
  SettingDto,
  SettingKey,
  SettingUpdate,
} from "./config-projection.js";
import type { ConversationImageBody, ConversationRecordDto, ImagePathDto, SessionDto } from "./instance-dto.js";
import type { AttachmentDto } from "./instance-attachments.js";
import type {
  CommandCompletionsResult,
  CommandContentResult,
  CommandsResult,
  ControlRequest,
  ModelsResult,
  ResourcesResult,
  SessionsResult,
  ToolsResult,
} from "../control/protocol.js";
import type { ObservationNotification } from "./instance-observation.js";
import type { PublishedFileDto } from "./published-file.js";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentPromptOptions {
  streamingBehavior?: "steer" | "followUp";
  images?: ImagePathDto[];
  source?: "interactive" | "rpc" | "extension";
  preflightResult?: (success: boolean) => void;
}

export type AgentInputKind = "extension_command" | "prompt";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface AgentModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface AgentModelState {
  model: { provider: string; id: string } | undefined;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

export type AgentSessionInfo = SessionDto;

export interface AgentSessionMetrics {
  messages: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export type AgentHistoryEntry = ConversationRecordDto;

export class AgentConversationCursorError extends Error {
  constructor(message = "Conversation continuation is stale") {
    super(message);
    this.name = "AgentConversationCursorError";
  }
}

export class AgentInvalidTreeTargetError extends Error {
  constructor(message = "Session tree target is no longer available") {
    super(message);
    this.name = "AgentInvalidTreeTargetError";
  }
}

export type AgentConversationContentChunk =
  | { blockIndex: number; type: "text" | "thinking"; text: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "image"; mimeType: string; data: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "tool_call"; toolCallId: string; toolName: string; argumentsJson: string; offset: number; blockComplete: boolean }
  | { blockIndex: number; type: "tool_result"; toolCallId: string; toolName: string; text: string; offset: number; blockComplete: boolean; isError: boolean; publishedFile?: PublishedFileDto; omittedFields?: string[] }
  | { blockIndex: number; type: "omitted"; kind: "image" | "binary"; description: string };

export interface AgentConversationHistoryEntry {
  entry: AgentHistoryEntry;
  contentRef: string;
  contentComplete: boolean;
  totalBlocks: number;
}

export interface AgentConversationHistoryPage {
  revision: string;
  entries: AgentConversationHistoryEntry[];
  hasEarlier: boolean;
  nextCursor?: string;
}

export interface AgentConversationContentPage {
  revision: string;
  contentRef: string;
  chunks: AgentConversationContentChunk[];
  complete: boolean;
  nextCursor?: string;
}

export type AgentConversationImageBody = ConversationImageBody;

export interface AgentProjectTrust {
  canonicalCwd: string;
  projectTrusted: boolean;
}

export interface AgentReplacementResult {
  cancelled: boolean;
}

export interface AgentForkResult extends AgentReplacementResult {
  selectedText?: string;
}

export interface AgentNavigateOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface AgentNavigateResult {
  cancelled: boolean;
  aborted?: boolean;
  editorText?: string;
  leafId?: string;
  summaryCreated: boolean;
}

export interface AgentSessionTarget {
  canonicalCwd: string;
}

export interface AgentCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type AgentCompactionFailureReason = "nothing_to_compact" | "already_compacted" | "cancelled" | "failed";

/** Definitive runtime evidence that a failed compaction appended no session entry. */
export class AgentCompactionKnownFailureError extends Error {
  constructor(
    readonly reason: AgentCompactionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "AgentCompactionKnownFailureError";
  }
}

export interface ClearedAgentQueue {
  steering: string[];
  followUp: string[];
}

/** Agent rejected a delivery mode before gaining input custody. */
export class AgentInvalidDeliveryModeError extends Error {
  constructor(readonly mode: "prompt" | "steer" | "followUp", readonly running: boolean) {
    super(`Delivery mode ${mode} is invalid while the Agent is ${running ? "running" : "idle"}`);
    this.name = "AgentInvalidDeliveryModeError";
  }
}

/** Public queue validation failed before Pi gained custody of the text. */
export class AgentQueueRejectedBeforeEffectError extends Error {
  constructor(cause?: unknown) {
    super("Runtime rejected queued text before applying it");
    this.name = "AgentQueueRejectedBeforeEffectError";
    this.cause = cause;
  }
}

/** Pi queue custody was observed before the queue call failed. */
export class AgentQueueEffectUnknownError extends Error {
  constructor(cause?: unknown) {
    super("Runtime queue mutation may have taken effect");
    this.name = "AgentQueueEffectUnknownError";
    this.cause = cause;
  }
}

/** Worker transport failed before the child acknowledged effectful custody. */
export class AgentUnavailableBeforeEffectError extends Error {
  constructor(message: string) { super(message); this.name = "AgentUnavailableBeforeEffectError"; }
}

/** Worker acknowledged an effectful call before transport/runtime loss. */
export class AgentMutationEffectUnknownError extends Error {
  constructor(message: string, cause?: unknown) { super(message); this.name = "AgentMutationEffectUnknownError"; this.cause = cause; }
}

export class AgentUnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "AgentUnknownToolError";
  }
}

export class AgentModelNotFoundError extends Error {
  constructor(readonly provider: string, readonly modelId: string) {
    super(`Pi model not found or unavailable: ${provider}/${modelId}`);
    this.name = "AgentModelNotFoundError";
  }
}

export class AgentInvalidSettingValueError extends Error {
  constructor(readonly setting: SettingKey) {
    super(`Pi setting ${setting} has an invalid effective value`);
    this.name = "AgentInvalidSettingValueError";
  }
}

/** JSON-safe projection of SettingsManager's buffered write failures. */
export class AgentSettingsWriteError extends Error {
  constructor(
    readonly setting: SettingKey | "model" | "thinking",
    readonly phase: "baseline" | "write",
    readonly mutationApplied: boolean,
    readonly errors: ReadonlyArray<{ scope: "global" | "project" | "unknown"; message: string }>,
  ) {
    const action = phase === "baseline"
      ? `Pre-existing settings errors blocked ${setting} update`
      : `Failed to persist ${setting} setting`;
    super(`${action}: ${errors.map((error) => `${error.scope}: ${error.message}`).join("; ") || "unknown settings error"}`);
    this.name = "AgentSettingsWriteError";
  }

  toJSON(): {
    name: string;
    setting: SettingKey | "model" | "thinking";
    phase: "baseline" | "write";
    mutationApplied: boolean;
    message: string;
    errors: ReadonlyArray<{ scope: "global" | "project" | "unknown"; message: string }>;
  } {
    return {
      name: this.name,
      setting: this.setting,
      phase: this.phase,
      mutationApplied: this.mutationApplied,
      message: this.message,
      errors: this.errors,
    };
  }
}

/**
 * Worker-produced Protocol V2 result bodies. The Worker adapter is the single
 * projection point; the Host only adds its own facts (instance snapshot,
 * instanceId, runtimeGeneration) and never rebuilds these DTOs.
 */
export type AgentToolProjection = Omit<ToolsResult, "instance">;
export type AgentModelListBody = Omit<ModelsResult, "instance">;
export type AgentSessionListBody = SessionsResult;
export type AgentCommandCatalogBody = CommandsResult;
export type AgentCommandContentBody = CommandContentResult;
export type AgentCommandCompletionsBody = CommandCompletionsResult;
export type AgentResourceProjectionBody = ResourcesResult;

export type AgentRequestType =
  | "command.submit" | "command.abort" | "queue.dequeue"
  | "model.list" | "model.set" | "thinking.set"
  | "tool.list" | "tool.set_active" | "settings.get" | "settings.update"
  | "resource.get" | "command.catalog" | "command.content" | "command.complete" | "session.history"
  | "conversation.history" | "conversation.content" | "conversation.image" | "file.read" | "session.list"
  | "session.switch" | "session.new" | "session.name" | "session.compact"
  | "session.reload" | "session.tree" | "session.navigate" | "session.fork" | "session.clone";

/** The business request is the canonical Protocol V2 request, not a Worker RPC mirror. */
export type AgentRequest = Extract<ControlRequest, { type: AgentRequestType }>;

/** Process-only controls which have no external business meaning. */
export type AgentWorkerControl =
  | { type: "activate" }
  | { type: "resolve_session_target"; sessionFile: string }
  | { type: "wait_for_idle" }
  | { type: "observation_delivery"; notification: ObservationNotification }
  | { type: "dispose" };

/** Minimal current-generation metadata needed by Host authority and snapshots. */
export interface AgentWorkerState {
  sessionId: string;
  sessionFile?: string;
  durableSessionFile?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  gitBranch?: string;
  modelState: AgentModelState;
  metrics: AgentSessionMetrics;
  extensionCommands: string[];
}

/** Host-resolved facts carried only on the private invoke envelope. */
export type AgentInvokeContext =
  | { type: "session_switch"; canonicalCwd: string; projectTrusted: boolean }
  | { type: "command"; attachments?: AttachmentDto[]; queueAvailable: boolean }
  | { type: "defer_to_host"; attachments?: AttachmentDto[]; queueAvailable: boolean }
  | { type: "force_queue"; attachments?: AttachmentDto[] }
  | { type: "host_queue"; attachments?: AttachmentDto[] };

export type AgentCommandPreflightResult =
  | { success: false }
  | { success: true; inputKind: "prompt"; delivery: "prompt" | "steer" | "followUp"; custody: "runtime" }
  | { success: true; inputKind: "extension_command"; delivery: "prompt"; custody: "runtime" }
  | { success: true; inputKind: "prompt"; delivery: "steer" | "followUp"; custody: "host" };

export interface AgentInvokeOptions {
  preflightResult?: (result: AgentCommandPreflightResult) => void;
  context?: AgentInvokeContext;
}

/** One generic Host-to-Worker connection; Agent methods and objects remain in the Worker. */
export interface AgentWorkerConnection {
  state(): AgentWorkerState;
  invoke(request: AgentRequest, options?: AgentInvokeOptions): Promise<unknown>;
  control(request: AgentWorkerControl): Promise<unknown>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /**
   * Adapter-owned graceful cleanup with supervisor hard-stop fallback. Resolving
   * also settles or rejects outstanding invokes so terminal admission cannot
   * remain hostage to an Agent input hook.
   */
  dispose(): Promise<void>;
}
