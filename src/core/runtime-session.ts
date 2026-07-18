import type {
  CommandDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  ToolDto,
} from "./config-projection.js";

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface RuntimePromptOptions {
  streamingBehavior?: "steer" | "followUp";
  source?: "interactive" | "rpc" | "extension";
  preflightResult?: (success: boolean) => void;
}

export type RuntimeInputKind = "extension_command" | "prompt";

export type RuntimeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface RuntimeModelState {
  model: { provider: string; id: string } | undefined;
  thinkingLevel: RuntimeThinkingLevel;
  availableThinkingLevels: RuntimeThinkingLevel[];
}

export interface RuntimeSessionMetrics {
  messages: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface RuntimeHistoryEntry {
  entryId: string;
  parentId?: string;
  timestamp?: string;
  role: string;
  summaryKind?: "compaction" | "branch";
  content: unknown;
  stopReason?: string;
  error?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface RuntimeSessionInfo {
  sessionId: string;
  sessionFile: string;
  name?: string;
  cwd: string;
  updatedAt?: string;
}

export interface RuntimeProjectTrust {
  canonicalCwd: string;
  projectTrusted: boolean;
}

export interface RuntimeReplacementResult {
  cancelled: boolean;
}

export interface RuntimeForkResult extends RuntimeReplacementResult {
  selectedText?: string;
}

export type RuntimeTreeNodeKind =
  | "message"
  | "thinking_level_change"
  | "model_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export interface RuntimeTreeNode {
  entryId: string;
  parentId?: string;
  depth: number;
  kind: RuntimeTreeNodeKind;
  role?: "user" | "assistant" | "tool" | "system";
  displayClass?: "content" | "tool" | "metadata" | "structural";
  state?: "error" | "aborted";
  label?: string;
  /** Included only in Host-side revision material; never projected to clients. */
  labelTimestamp?: string;
  timestamp?: string;
  summary: string;
  hasChildren: boolean;
}

export interface RuntimeTreeSnapshot {
  nodes: RuntimeTreeNode[];
  leafId?: string;
}

export interface RuntimeNavigateOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeNavigateResult {
  cancelled: boolean;
  aborted?: boolean;
  editorText?: string;
  summaryCreated: boolean;
}

export interface RuntimeSessionTarget {
  canonicalCwd: string;
}

export interface RuntimeCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type RuntimeCompactionFailureReason = "nothing_to_compact" | "already_compacted" | "cancelled" | "failed";

/** Definitive runtime evidence that a failed compaction appended no session entry. */
export class RuntimeCompactionKnownFailureError extends Error {
  constructor(
    readonly reason: RuntimeCompactionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeCompactionKnownFailureError";
  }
}

export interface ClearedRuntimeQueue {
  steering: string[];
  followUp: string[];
}

export class RuntimeUnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "RuntimeUnknownToolError";
  }
}

export class RuntimeModelNotFoundError extends Error {
  constructor(provider: string, modelId: string) {
    super(`Pi model not found or unavailable: ${provider}/${modelId}`);
    this.name = "RuntimeModelNotFoundError";
  }
}

export class RuntimeInvalidSettingValueError extends Error {
  constructor(readonly setting: SettingKey) {
    super(`Pi setting ${setting} has an invalid effective value`);
    this.name = "RuntimeInvalidSettingValueError";
  }
}

/** JSON-safe projection of SettingsManager's buffered write failures. */
export class RuntimeSettingsWriteError extends Error {
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
    this.name = "RuntimeSettingsWriteError";
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
 * Small public-contract surface that ManagedInstance needs from Pi's
 * AgentSession. Keeping it structural makes lifecycle tests deterministic and
 * prevents the host state machine from depending on Pi internals.
 */
export interface RuntimeSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;

  /** Current session path only when it has actually been materialized durably. */
  getDurableSessionFile?(): string | undefined;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  /** Exact current-generation registered extension command routing; all other input remains a prompt. */
  classifyInput(text: string): RuntimeInputKind;
  prompt(text: string, options?: RuntimePromptOptions): Promise<void>;
  listModels(): Promise<RuntimeModelInfo[]>;
  listSessions(scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]>;
  getHistory(): RuntimeHistoryEntry[];
  getTree?(): RuntimeTreeSnapshot;
  navigateTree?(targetId: string, options?: RuntimeNavigateOptions): Promise<RuntimeNavigateResult>;
  listTools(): Promise<ToolDto[]>;
  setActiveTools(names: string[]): Promise<ToolDto[]>;
  getSettings(): Promise<SettingDto[]>;
  updateSetting(update: SettingUpdate): Promise<SettingDto>;
  getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[] }>;
  getCommands(): Promise<CommandDto[]>;
  resolveSessionTarget?(sessionFile: string): Promise<RuntimeSessionTarget>;
  newSession?(operationId: string, parentSession?: string): Promise<RuntimeReplacementResult>;
  switchSession?(operationId: string, sessionFile: string, trust: RuntimeProjectTrust): Promise<RuntimeReplacementResult>;
  fork?(operationId: string, entryId: string, position: "before" | "at", kind: "fork" | "clone"): Promise<RuntimeForkResult>;
  setSessionName?(name: string): string | undefined;
  compact?(customInstructions?: string): Promise<RuntimeCompactionResult>;
  reload?(operationId: string): Promise<RuntimeReplacementResult>;
  selectModel(provider: string, modelId: string): Promise<RuntimeModelState>;
  setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState>;
  getModelState(): RuntimeModelState;
  getMetrics(): RuntimeSessionMetrics;
  clearQueue(): ClearedRuntimeQueue;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}
