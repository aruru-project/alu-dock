import {
  RuntimeCompactionKnownFailureError,
  RuntimeInvalidSettingValueError,
  RuntimeModelNotFoundError,
  RuntimeQueueEffectUnknownError,
  RuntimeQueueRejectedBeforeEffectError,
  RuntimeSettingsWriteError,
  RuntimeUnknownToolError,
} from "../core/runtime-session.js";
import { containsBinaryPayload } from "../core/extension-ui-broker.js";
import {
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
} from "../core/instance-dto.js";
import {
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingKey,
} from "../core/config-projection.js";

export const PI_WORKER_PROTOCOL = "alu-dock-pi-worker";
export const PI_WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_CHUNK_CHARS = 96_000;
export const MAX_WORKER_TRANSFER_BYTES = 256 * 1024 * 1024;
export const MAX_WORKER_TRANSFER_CHUNKS = 4_096;

export interface WorkerIdentity {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  workerIncarnation: string;
}

export type RuntimeCapability =
  | "runtime.activate" | "runtime.prompt" | "runtime.queueMessage"
  | "runtime.listModels" | "runtime.listSessions" | "runtime.navigateTree"
  | "runtime.listTools" | "runtime.setActiveTools" | "runtime.getSettings"
  | "runtime.updateSetting" | "runtime.getResources" | "runtime.getCommands"
  | "runtime.resolveSessionTarget" | "runtime.newSession" | "runtime.switchSession"
  | "runtime.fork" | "runtime.setSessionName" | "runtime.compact" | "runtime.reload"
  | "runtime.selectModel" | "runtime.setThinkingLevel" | "runtime.clearQueue"
  | "runtime.abort" | "runtime.waitForIdle" | "runtime.dispose";

export type UiCapability =
  | "ui.select" | "ui.confirm" | "ui.input" | "ui.editor"
  | "ui.notify" | "ui.setTitle" | "ui.setEditorText" | "ui.setStatus" | "ui.setWidget" | "ui.widgetError"
  | "ui.unsupported" | "ui.setToolsExpanded" | "ui.cancel" | "ui.viewport" | "ui.reset" | "ui.generationBegin";

export type DockCapability = "dock.identity";
export type ReverseWorkerCapability = DockCapability | Exclude<UiCapability, "ui.viewport" | "ui.reset">;

/** Host-enforced capabilities available to an ordinary managed Pi Worker. */
export const ORDINARY_REVERSE_WORKER_CAPABILITIES: readonly ReverseWorkerCapability[] = [
  "dock.identity",
  "ui.select", "ui.confirm", "ui.input", "ui.editor", "ui.notify", "ui.setTitle", "ui.setEditorText", "ui.setStatus",
  "ui.setWidget", "ui.widgetError", "ui.unsupported", "ui.setToolsExpanded", "ui.cancel",
  "ui.generationBegin",
];

export type WorkerCapability = RuntimeCapability | UiCapability | DockCapability;

export interface WorkerFrame {
  protocol: typeof PI_WORKER_PROTOCOL;
  version: typeof PI_WORKER_PROTOCOL_VERSION;
  identity: WorkerIdentity;
  sequence: number;
  transferId: string;
  index: number;
  count: number;
  payload: string;
}

export interface WorkerErrorDto {
  code:
    | "compaction_known_failure" | "queue_rejected" | "queue_effect_unknown"
    | "unknown_tool" | "model_not_found" | "invalid_setting" | "settings_write"
    | "runtime_error";
  name: string;
  message: string;
  details?: Record<string, unknown>;
}

export type WorkerEnvelope =
  | { kind: "ready"; cache: WorkerCache; diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }
  | { kind: "call"; callId: string; capability: WorkerCapability; args: unknown }
  | { kind: "accepted"; callId: string }
  | { kind: "response"; callId: string; ok: true; result: unknown; cache?: WorkerCache }
  | { kind: "response"; callId: string; ok: false; error: WorkerErrorDto; cache?: WorkerCache }
  | { kind: "event"; event: Record<string, unknown>; cache: WorkerCache }
  | { kind: "preflight"; callId: string; success: boolean }
  | { kind: "fatal"; error: WorkerErrorDto };

export interface WorkerCache {
  sessionId: string;
  sessionFile?: string;
  durableSessionFile?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  gitBranch?: string;
  modelState: unknown;
  metrics: unknown;
  history?: unknown[];
  tree?: unknown;
  extensionCommands?: string[];
}

export type IpcSend = (message: WorkerFrame, callback: (error: Error | null) => void) => boolean;

/** One callback-ordered sender prevents chunk or envelope interleaving. */
export class OrderedWorkerSender {
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private transferSequence = 0;
  private closed = false;

  constructor(
    private identity: WorkerIdentity,
    private readonly send: IpcSend,
  ) {}

  updateRuntimeGeneration(runtimeGeneration: number): void {
    this.identity = { ...this.identity, runtimeGeneration };
  }

  close(): void { this.closed = true; }

  sendEnvelope(envelope: WorkerEnvelope): Promise<void> {
    const json = JSON.stringify(envelope);
    if (json === undefined) return Promise.reject(new Error("Worker envelope is not JSON serializable"));
    validateJsonValue(JSON.parse(json));
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > MAX_WORKER_TRANSFER_BYTES) return Promise.reject(new Error("Worker envelope exceeds aggregate transfer bound"));
    const chunks: string[] = [];
    for (let index = 0; index < json.length; index += MAX_WORKER_CHUNK_CHARS) chunks.push(json.slice(index, index + MAX_WORKER_CHUNK_CHARS));
    if (chunks.length < 1) chunks.push("");
    if (chunks.length > MAX_WORKER_TRANSFER_CHUNKS) return Promise.reject(new Error("Worker envelope exceeds chunk count bound"));
    const identity = { ...this.identity };
    const transferId = `${process.pid}-${++this.transferSequence}`;
    const task = this.tail.then(async () => {
      if (this.closed) throw new Error("Worker IPC sender is closed");
      for (let index = 0; index < chunks.length; index += 1) {
        const frame: WorkerFrame = {
          protocol: PI_WORKER_PROTOCOL,
          version: PI_WORKER_PROTOCOL_VERSION,
          identity,
          sequence: ++this.sequence,
          transferId,
          index,
          count: chunks.length,
          payload: chunks[index]!,
        };
        await new Promise<void>((resolve, reject) => {
          try {
            this.send(frame, (error) => error ? reject(error) : resolve());
          } catch (error) { reject(error); }
        });
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

export class WorkerFrameReceiver {
  private nextSequence = 1;
  lastIdentity: WorkerIdentity | undefined;
  private active: { transferId: string; count: number; chunks: string[]; bytes: number } | undefined;

  constructor(private readonly acceptIdentity: (identity: WorkerIdentity) => boolean) {}

  accept(raw: unknown): WorkerEnvelope | undefined {
    const frame = parseWorkerFrame(raw);
    this.lastIdentity = frame.identity;
    if (!this.acceptIdentity(frame.identity)) throw new Error("Worker IPC identity or generation fence rejected a frame");
    if (frame.sequence !== this.nextSequence) throw new Error(`Worker IPC sequence gap: expected ${this.nextSequence}, received ${frame.sequence}`);
    this.nextSequence += 1;
    if (!this.active) {
      if (frame.index !== 0) throw new Error("Worker IPC transfer did not begin with chunk zero");
      this.active = { transferId: frame.transferId, count: frame.count, chunks: [], bytes: 0 };
    }
    const active = this.active;
    if (active.transferId !== frame.transferId || active.count !== frame.count || frame.index !== active.chunks.length) {
      throw new Error("Worker IPC chunks interleaved or arrived out of order");
    }
    active.bytes += Buffer.byteLength(frame.payload, "utf8");
    if (active.bytes > MAX_WORKER_TRANSFER_BYTES) throw new Error("Worker IPC aggregate transfer bound exceeded");
    active.chunks.push(frame.payload);
    if (active.chunks.length !== active.count) return undefined;
    this.active = undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(active.chunks.join("")); }
    catch { throw new Error("Worker IPC payload is not valid JSON"); }
    validateJsonValue(parsed);
    return parseWorkerEnvelope(parsed);
  }
}

export function parseWorkerFrame(raw: unknown): WorkerFrame {
  const value = record(raw, "Worker IPC frame");
  exactKeys(value, ["protocol", "version", "identity", "sequence", "transferId", "index", "count", "payload"], "Worker IPC frame");
  if (value.protocol !== PI_WORKER_PROTOCOL || value.version !== PI_WORKER_PROTOCOL_VERSION) throw new Error("Worker IPC protocol version mismatch");
  const identity = parseWorkerIdentity(value.identity);
  const sequence = positiveInteger(value.sequence, "Worker frame sequence");
  const transferId = boundedString(value.transferId, 128, "Worker transfer ID");
  const index = nonNegativeInteger(value.index, "Worker chunk index");
  const count = positiveInteger(value.count, "Worker chunk count");
  if (count > MAX_WORKER_TRANSFER_CHUNKS || index >= count) throw new Error("Worker chunk index/count is outside bounds");
  const payload = typeof value.payload === "string" && value.payload.length <= MAX_WORKER_CHUNK_CHARS ? value.payload : fail("Worker chunk payload is invalid");
  return { protocol: PI_WORKER_PROTOCOL, version: PI_WORKER_PROTOCOL_VERSION, identity, sequence, transferId, index, count, payload };
}

export function parseWorkerIdentity(raw: unknown): WorkerIdentity {
  const value = record(raw, "Worker identity");
  exactKeys(value, ["hostEpoch", "instanceId", "runtimeGeneration", "workerIncarnation"], "Worker identity");
  return {
    hostEpoch: boundedString(value.hostEpoch, 128, "Worker Host epoch"),
    instanceId: boundedString(value.instanceId, 128, "Worker instance ID"),
    runtimeGeneration: positiveInteger(value.runtimeGeneration, "Worker runtime generation"),
    workerIncarnation: boundedString(value.workerIncarnation, 128, "Worker incarnation"),
  };
}

export function parseWorkerEnvelope(raw: unknown): WorkerEnvelope {
  const value = record(raw, "Worker envelope");
  const kind = boundedString(value.kind, 32, "Worker envelope kind");
  switch (kind) {
    case "ready": {
      exactKeys(value, ["kind", "cache", "diagnostics", "modelFallbackMessage", "persistedName", "pid"], "Worker ready envelope");
      const diagnostics = stringArray(value.diagnostics, 2_000, 2_048, "Worker diagnostics");
      return { kind, cache: parseWorkerCache(value.cache), diagnostics, ...(optionalString(value.modelFallbackMessage, 2_048) === undefined ? {} : { modelFallbackMessage: optionalString(value.modelFallbackMessage, 2_048) }), ...(optionalString(value.persistedName, 256) === undefined ? {} : { persistedName: optionalString(value.persistedName, 256) }), pid: positiveInteger(value.pid, "Worker pid") };
    }
    case "call": {
      exactKeys(value, ["kind", "callId", "capability", "args"], "Worker call envelope");
      const capability = parseCapability(value.capability);
      validateCapabilityArgs(capability, value.args);
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID"), capability, args: value.args };
    }
    case "accepted":
      exactKeys(value, ["kind", "callId"], "Worker accepted envelope");
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID") };
    case "response": {
      const callId = boundedString(value.callId, 128, "Worker call ID");
      const cache = value.cache === undefined ? undefined : parseWorkerCache(value.cache);
      if (value.ok === true) {
        exactKeys(value, ["kind", "callId", "ok", "result", "cache"], "Worker success response envelope");
        return { kind, callId, ok: true, result: value.result, ...(cache ? { cache } : {}) };
      }
      if (value.ok === false) {
        exactKeys(value, ["kind", "callId", "ok", "error", "cache"], "Worker error response envelope");
        return { kind, callId, ok: false, error: parseWorkerError(value.error), ...(cache ? { cache } : {}) };
      }
      throw new Error("Worker response status is invalid");
    }
    case "event": {
      exactKeys(value, ["kind", "event", "cache"], "Worker event envelope");
      const event = record(value.event, "Worker runtime event");
      validateWorkerRuntimeEvent(event);
      return { kind, event, cache: parseWorkerCache(value.cache) };
    }
    case "preflight":
      exactKeys(value, ["kind", "callId", "success"], "Worker preflight envelope");
      if (typeof value.success !== "boolean") throw new Error("Worker preflight status is invalid");
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID"), success: value.success };
    case "fatal":
      exactKeys(value, ["kind", "error"], "Worker fatal envelope");
      return { kind, error: parseWorkerError(value.error) };
    default: throw new Error(`Unknown Worker envelope kind: ${kind}`);
  }
}

function validateWorkerRuntimeEvent(event: Record<string, unknown>): void {
  const type = oneOf(event.type, [
    "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "queue_update", "compaction_start", "compaction_end", "entry_appended",
    "session_info_changed", "thinking_level_changed", "auto_retry_start", "auto_retry_end",
    "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
    "dock_session_replaced", "dock_runtime_error", "dock_runtime_lost",
    "dock_extension_error", "dock_git_branch_changed",
  ] as const, "Worker runtime event type");
  switch (type) {
    case "agent_start": case "agent_settled": case "turn_start": case "summarization_retry_finished":
      exactKeys(event, ["type"], `Worker ${type} event`); return;
    case "agent_end":
      exactKeys(event, ["type", "willRetry"], "Worker agent-end event");
      if (typeof event.willRetry !== "boolean") throw new Error("Worker agent-end event is invalid"); return;
    case "turn_end":
      exactKeys(event, ["type"], "Worker turn-end event"); return;
    case "message_start": case "message_end":
      exactKeys(event, ["type", "message"], `Worker ${type} event`); validatePrivateMessage(event.message); return;
    case "message_update":
      exactKeys(event, ["type", "assistantMessageEvent"], "Worker message-update event");
      validateAssistantUpdate(event.assistantMessageEvent); return;
    case "tool_execution_start":
      exactKeys(event, ["type", "toolCallId", "toolName", "args"], "Worker tool-start event");
      boundedString(event.toolCallId, 128, "Tool call id"); boundedString(event.toolName, 256, "Tool name"); record(event.args, "Tool arguments"); return;
    case "tool_execution_update":
      exactKeys(event, ["type", "toolCallId", "toolName", "partialResult"], "Worker tool-update event");
      boundedString(event.toolCallId, 128, "Tool call id"); boundedString(event.toolName, 256, "Tool name"); validatePrivateToolResult(event.partialResult); return;
    case "tool_execution_end":
      exactKeys(event, ["type", "toolCallId", "toolName", "result", "isError"], "Worker tool-end event");
      boundedString(event.toolCallId, 128, "Tool call id"); boundedString(event.toolName, 256, "Tool name"); validatePrivateToolResult(event.result);
      if (typeof event.isError !== "boolean") throw new Error("Tool error flag is invalid"); return;
    case "compaction_start":
      exactKeys(event, ["type", "reason"], "Worker compaction-start event"); oneOf(event.reason, ["manual", "threshold", "overflow"], "Compaction reason"); return;
    case "compaction_end":
      exactKeys(event, ["type", "reason", "aborted", "willRetry", "errorMessage"], "Worker compaction-end event");
      oneOf(event.reason, ["manual", "threshold", "overflow"], "Compaction reason");
      if (typeof event.aborted !== "boolean" || typeof event.willRetry !== "boolean") throw new Error("Compaction event flags are invalid");
      optionalString(event.errorMessage, 2_048); return;
    case "entry_appended":
      exactKeys(event, ["type"], "Worker entry-appended event"); return;
    case "thinking_level_changed":
      exactKeys(event, ["type", "level"], "Worker thinking event"); oneOf(event.level, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "Thinking level"); return;
    case "auto_retry_start": case "summarization_retry_scheduled":
      exactKeys(event, ["type", "attempt", "maxAttempts", "delayMs", "errorMessage"], `Worker ${type} event`);
      nonNegativeInteger(event.attempt, "Retry attempt"); nonNegativeInteger(event.maxAttempts, "Retry maximum"); nonNegativeInteger(event.delayMs, "Retry delay"); boundedString(event.errorMessage, 2_048, "Retry error", true); return;
    case "auto_retry_end":
      exactKeys(event, ["type", "success", "attempt", "finalError"], "Worker retry-end event");
      if (typeof event.success !== "boolean") throw new Error("Retry success flag is invalid"); nonNegativeInteger(event.attempt, "Retry attempt"); optionalString(event.finalError, 2_048); return;
    case "summarization_retry_attempt_start":
      exactKeys(event, ["type", "source", "reason"], "Worker summarization-attempt event");
      oneOf(event.source, ["branchSummary", "compaction"], "Summarization source");
      if (event.reason !== undefined) oneOf(event.reason, ["manual", "threshold", "overflow"], "Summarization reason"); return;
    case "dock_session_replaced":
      exactKeys(event, ["type", "reason", "previousSessionFile", "sessionFile", "cwd", "name", "gitBranch"], "Worker replacement event");
      oneOf(event.reason, ["new", "resume", "fork", "clone", "reload"], "Worker replacement reason");
      optionalString(event.previousSessionFile, 16_384); optionalString(event.sessionFile, 16_384);
      optionalString(event.cwd, 16_384); optionalString(event.name, 256); optionalString(event.gitBranch, 256);
      return;
    case "dock_runtime_error":
      exactKeys(event, ["type", "operationId", "kind", "error", "recoverySessionFile"], "Worker runtime-error event");
      boundedString(event.operationId, 128, "Runtime operation ID");
      oneOf(event.kind, ["new", "switch", "fork", "clone", "reload"], "Runtime replacement kind");
      boundedString(event.error, 2_048, "Runtime error", true); optionalString(event.recoverySessionFile, 16_384);
      return;
    case "dock_runtime_lost":
      exactKeys(event, ["type", "operationId", "kind", "error", "recoverySessionFile"], "Worker runtime-loss event");
      boundedString(event.operationId, 128, "Runtime operation ID"); oneOf(event.kind, ["create"], "Runtime loss kind");
      boundedString(event.error, 2_048, "Runtime loss error", true); optionalString(event.recoverySessionFile, 16_384);
      return;
    case "dock_extension_error":
      exactKeys(event, ["type", "error"], "Worker extension-error event"); boundedString(event.error, 2_048, "Extension error", true); return;
    case "dock_git_branch_changed":
      exactKeys(event, ["type", "branch"], "Worker Git event"); optionalString(event.branch, 256); return;
    case "session_info_changed":
      exactKeys(event, ["type", "name"], "Worker session-info event"); optionalString(event.name, 256); return;
    case "queue_update":
      exactKeys(event, ["type", "steering", "followUp"], "Worker queue event");
      stringArray(event.steering, 1_000, 256_000, "Worker steering queue");
      stringArray(event.followUp, 1_000, 256_000, "Worker follow-up queue");
      return;
    default:
      return;
  }
}

function validatePrivateMessage(raw: unknown): void {
  const message = record(raw, "Worker message");
  exactKeys(message, ["role", "content", "stopReason", "errorMessage", "toolCallId"], "Worker message");
  const role = oneOf(message.role, ["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary", "system"], "Worker message role");
  if (role === "toolResult") validatePrivateToolContent(message.content); else validatePrivateContent(message.content);
  optionalString(message.stopReason, 128); optionalString(message.errorMessage, 2_048); optionalString(message.toolCallId, 128);
}

function validatePrivateContent(raw: unknown): void {
  if (typeof raw === "string") { boundedString(raw, 256_000, "Worker message content", true); return; }
  if (!Array.isArray(raw) || raw.length > 201) throw new Error("Worker message content is invalid");
  for (const item of raw) {
    const block = record(item, "Worker content block");
    const type = oneOf(block.type, ["text", "thinking", "image", "toolCall"], "Worker content block type");
    if (type === "text") {
      exactKeys(block, ["type", "text"], "Worker text block"); boundedString(block.text, 8_000, "Worker text", true);
    } else if (type === "thinking") {
      exactKeys(block, ["type", "thinking"], "Worker thinking block"); boundedString(block.thinking, 8_000, "Worker thinking", true);
    } else if (type === "image") {
      exactKeys(block, ["type", "mimeType"], "Worker image block"); validateImageMimeType(block.mimeType, "Worker image MIME type");
    } else {
      validatePrivateToolCall(block);
    }
  }
}

function validatePrivateToolContent(raw: unknown): void {
  if (typeof raw === "string") { boundedString(raw, 256_000, "Worker tool content", true); return; }
  if (!Array.isArray(raw) || raw.length > 200) throw new Error("Worker tool content is invalid");
  for (const item of raw) {
    const block = record(item, "Worker tool content block");
    const type = oneOf(block.type, ["text", "image"], "Worker tool content block type");
    if (type === "text") { exactKeys(block, ["type", "text"], "Worker tool text block"); boundedString(block.text, 256_000, "Worker tool text", true); }
    else { exactKeys(block, ["type", "mimeType"], "Worker tool image block"); validateImageMimeType(block.mimeType, "Worker tool image MIME type"); }
  }
}

function validatePrivateToolCall(raw: unknown): void {
  const call = record(raw, "Worker tool call");
  exactKeys(call, ["type", "id", "name", "arguments"], "Worker tool call");
  if (call.type !== "toolCall") throw new Error("Worker tool call type is invalid");
  boundedString(call.id, 128, "Worker tool-call id"); boundedString(call.name, 256, "Worker tool-call name");
  record(call.arguments, "Worker tool-call arguments");
}

function validateAssistantUpdate(raw: unknown): void {
  const update = record(raw, "Worker assistant update");
  exactKeys(update, ["type", "contentIndex", "delta", "partial", "toolCall"], "Worker assistant update");
  oneOf(update.type, ["start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error"], "Worker assistant update type");
  if (update.contentIndex !== undefined) nonNegativeInteger(update.contentIndex, "Worker assistant content index");
  optionalString(update.delta, 8_000);
  if (update.partial !== undefined) {
    const partial = record(update.partial, "Worker assistant partial");
    exactKeys(partial, ["content"], "Worker assistant partial"); validatePrivateContent(partial.content);
  }
  if (update.toolCall !== undefined) validatePrivateToolCall(update.toolCall);
}

function validatePrivateToolResult(raw: unknown): void {
  const result = record(raw, "Worker tool result");
  exactKeys(result, ["content", "presentation"], "Worker tool result");
  validatePrivateToolContent(result.content);
  if (result.presentation !== undefined) validateToolPresentation(result.presentation);
}

function validateToolPresentation(raw: unknown): void {
  const presentation = record(raw, "Worker tool presentation");
  exactKeys(presentation, ["kind", "preview", "notices", "displayDiff"], "Worker tool presentation");
  oneOf(presentation.kind, ["bash", "read", "edit", "write", "grep", "find", "ls"], "Worker tool kind");
  oneOf(presentation.preview, ["head", "tail", "head-tail"], "Worker tool preview");
  if (!Array.isArray(presentation.notices) || presentation.notices.length > 8) throw new Error("Worker tool notices are invalid");
  for (const item of presentation.notices) validateToolNotice(item);
  optionalString(presentation.displayDiff, 256_000);
}

function validateToolNotice(raw: unknown): void {
  const notice = record(raw, "Worker tool notice");
  const code = oneOf(notice.code, ["output_truncated", "limit_reached", "lines_truncated", "continue_with_offset", "full_output_saved", "host_projection_truncated"], "Worker tool notice code");
  if (code === "output_truncated") {
    exactKeys(notice, ["code", "by", "shown", "total", "limit", "firstLineExceedsLimit"], "Worker truncation notice");
    oneOf(notice.by, ["lines", "bytes"], "Worker truncation unit"); optionalNonNegativeInteger(notice.shown, "Worker shown count"); optionalNonNegativeInteger(notice.total, "Worker total count"); positiveInteger(notice.limit, "Worker truncation limit");
    if (notice.firstLineExceedsLimit !== undefined && notice.firstLineExceedsLimit !== true) throw new Error("Worker truncation first-line flag is invalid");
  } else if (code === "limit_reached") {
    exactKeys(notice, ["code", "unit", "limit"], "Worker limit notice"); oneOf(notice.unit, ["matches", "results", "entries"], "Worker limit unit"); positiveInteger(notice.limit, "Worker result limit");
  } else if (code === "lines_truncated") {
    exactKeys(notice, ["code", "maxChars"], "Worker line notice"); positiveInteger(notice.maxChars, "Worker line limit");
  } else if (code === "continue_with_offset") {
    exactKeys(notice, ["code", "offset"], "Worker offset notice"); nonNegativeInteger(notice.offset, "Worker continuation offset");
  } else if (code === "full_output_saved") {
    exactKeys(notice, ["code", "path"], "Worker output-path notice"); boundedString(notice.path, 4_096, "Worker output path");
  } else exactKeys(notice, ["code"], "Worker host-projection notice");
}

export function validateCapabilityArgs(capability: WorkerCapability, raw: unknown): void {
  const args = record(raw, `${capability} arguments`);
  const keys = (...allowed: string[]): void => exactKeys(args, allowed, `${capability} arguments`);
  switch (capability) {
    case "dock.identity": keys(); return;
    case "runtime.activate": case "runtime.listModels": case "runtime.listTools": case "runtime.getSettings":
    case "runtime.getResources": case "runtime.getCommands": case "runtime.clearQueue": case "runtime.abort":
    case "runtime.waitForIdle": case "runtime.dispose": keys(); return;
    case "runtime.prompt": keys("text", "options"); boundedString(args.text, 256_000, "Prompt text", true); if (args.options !== undefined) validatePromptOptions(args.options); return;
    case "runtime.queueMessage": keys("text", "delivery", "images"); boundedString(args.text, 256_000, "Queue text", true); oneOf(args.delivery, ["steer", "followUp"], "Queue delivery"); if (args.images !== undefined) validateImagePaths(args.images); return;
    case "runtime.listSessions": keys("scope"); oneOf(args.scope, ["cwd", "all"], "Session scope"); return;
    case "runtime.navigateTree": {
      keys("targetId", "options"); boundedString(args.targetId, 128, "Tree target");
      if (args.options !== undefined) {
        const options = record(args.options, "Tree options");
        exactKeys(options, ["summarize", "customInstructions", "replaceInstructions", "label"], "Tree options");
        optionalBoolean(options.summarize, "Tree summarize flag"); optionalString(options.customInstructions, 256_000);
        optionalBoolean(options.replaceInstructions, "Tree replacement flag"); optionalString(options.label, 256);
      }
      return;
    }
    case "runtime.setActiveTools": keys("names"); stringArray(args.names, 2_000, 256, "Tool names"); return;
    case "runtime.updateSetting": keys("update"); validateSettingUpdate(args.update); return;
    case "runtime.resolveSessionTarget": keys("sessionFile"); boundedString(args.sessionFile, 16_384, "Session file"); return;
    case "runtime.newSession": keys("operationId", "parentSession"); boundedString(args.operationId, 128, "Operation ID"); optionalString(args.parentSession, 16_384); return;
    case "runtime.switchSession": {
      keys("operationId", "sessionFile", "trust"); boundedString(args.operationId, 128, "Operation ID"); boundedString(args.sessionFile, 16_384, "Session file");
      const trust = record(args.trust, "Project trust"); exactKeys(trust, ["canonicalCwd", "projectTrusted"], "Project trust");
      boundedString(trust.canonicalCwd, 16_384, "Trusted project cwd"); if (typeof trust.projectTrusted !== "boolean") throw new Error("Project trust flag is invalid");
      return;
    }
    case "runtime.fork": keys("operationId", "entryId", "position", "forkKind"); boundedString(args.operationId, 128, "Operation ID"); boundedString(args.entryId, 128, "Entry ID"); oneOf(args.position, ["before", "at"], "Fork position"); oneOf(args.forkKind, ["fork", "clone"], "Fork kind"); return;
    case "runtime.setSessionName": keys("name"); boundedString(args.name, 256, "Session name"); return;
    case "runtime.compact": keys("customInstructions"); optionalString(args.customInstructions, 256_000); return;
    case "runtime.reload": keys("operationId"); boundedString(args.operationId, 128, "Operation ID"); return;
    case "runtime.selectModel": keys("provider", "modelId"); boundedString(args.provider, 256, "Model provider"); boundedString(args.modelId, 256, "Model ID"); return;
    case "runtime.setThinkingLevel": keys("level"); oneOf(args.level, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "Thinking level"); return;
    case "ui.select": keys("title", "options", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); stringArray(args.options, 256, 16_000, "Dialog options"); validateDialogOptions(args.optionsMeta); return;
    case "ui.confirm": keys("title", "message", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); boundedString(args.message, 16_000, "Dialog message", true); validateDialogOptions(args.optionsMeta); return;
    case "ui.input": keys("title", "placeholder", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); optionalString(args.placeholder, 4_096); validateDialogOptions(args.optionsMeta); return;
    case "ui.editor": keys("title", "prefill"); boundedString(args.title, 4_096, "Dialog title", true); optionalString(args.prefill, 300_000); return;
    case "ui.notify": keys("message", "level"); boundedString(args.message, 16_000, "Notification", true); oneOf(args.level, ["info", "warning", "error"], "Notification level"); return;
    case "ui.setTitle": keys("title"); directiveString(args.title, 2_048, "Terminal title", false); return;
    case "ui.setEditorText": keys("text"); directiveString(args.text, 256_000, "Editor text", true); return;
    case "ui.setStatus": keys("key", "text"); boundedString(args.key, 512, "Status key"); optionalString(args.text, 16_000); return;
    case "ui.setWidget": keys("key", "lines", "placement"); boundedString(args.key, 512, "Widget key"); if (args.lines !== undefined) stringArray(args.lines, 512, 16_000, "Widget lines"); oneOf(args.placement, ["aboveEditor", "belowEditor"], "Widget placement"); return;
    case "ui.widgetError": keys("key", "error"); boundedString(args.key, 128, "Widget key"); boundedString(args.error, 2_048, "Widget error", true); return;
    case "ui.unsupported": keys("feature"); boundedString(args.feature, 1_024, "Unsupported feature"); return;
    case "ui.setToolsExpanded": keys("expanded"); if (typeof args.expanded !== "boolean") throw new Error("Tool expansion is invalid"); return;
    case "ui.cancel": keys("callId"); boundedString(args.callId, 128, "UI call ID"); return;
    case "ui.viewport": keys("width", "height"); positiveInteger(args.width, "Widget width"); positiveInteger(args.height, "Widget height"); return;
    case "ui.reset": case "ui.generationBegin": keys(); return;
  }
}

export function validateCapabilityResult(capability: RuntimeCapability | UiCapability, result: unknown): void {
  if (capability.startsWith("ui.")) {
    if (capability === "ui.select" || capability === "ui.input" || capability === "ui.editor") {
      if (result !== undefined && result !== null) boundedString(result, capability === "ui.editor" ? 300_000 : 16_000, `${capability} result`, true);
      return;
    }
    if (capability === "ui.confirm") {
      if (typeof result !== "boolean") throw new Error("ui.confirm result must be boolean");
      return;
    }
    if (result !== undefined && result !== null) throw new Error(`${capability} result must be empty`);
    return;
  }
  const array = (label: string): unknown[] => {
    if (!Array.isArray(result) || result.length > 100_000) throw new Error(`${label} result is invalid`);
    return result;
  };
  switch (capability) {
    case "runtime.activate": case "runtime.prompt": case "runtime.queueMessage": case "runtime.abort":
    case "runtime.waitForIdle": case "runtime.dispose":
      if (result !== null && result !== undefined) throw new Error(`${capability} result must be empty`); return;
    case "runtime.listModels":
      for (const item of array("Model list")) {
        const value = record(item, "Model result"); exactKeys(value, ["provider", "id", "name", "reasoning"], "Model result");
        boundedString(value.provider, 256, "Model provider"); boundedString(value.id, 512, "Model id"); boundedString(value.name, 512, "Model name"); if (typeof value.reasoning !== "boolean") throw new Error("Model reasoning flag is invalid");
      }
      return;
    case "runtime.listSessions":
      for (const item of array("Session list")) {
        const value = record(item, "Session result"); exactKeys(value, ["sessionId", "sessionFile", "name", "cwd", "updatedAt"], "Session result");
        boundedString(value.sessionId, 128, "Session id"); boundedString(value.sessionFile, 16_384, "Session file"); boundedString(value.cwd, 16_384, "Session cwd"); optionalString(value.name, 256); optionalString(value.updatedAt, 128);
      }
      return;
    case "runtime.listTools": case "runtime.setActiveTools":
      if (Array.isArray(result)) { for (const item of result) validateTool(item); return; }
      {
        const value = record(result, "Tool projection"); exactKeys(value, ["tools", "total", "truncated"], "Tool projection");
        if (!Array.isArray(value.tools) || value.tools.length > 2_000) throw new Error("Tool projection items are invalid");
        for (const item of value.tools) validateTool(item);
        nonNegativeInteger(value.total, "Tool total"); if (typeof value.truncated !== "boolean") throw new Error("Tool truncation is invalid"); return;
      }
    case "runtime.getSettings":
      for (const item of array(capability)) validateSetting(item); return;
    case "runtime.getCommands":
      for (const item of array(capability)) validateCommand(item); return;
    case "runtime.getResources": {
      const value = record(result, "Resource result");
      exactKeys(value, ["resources", "diagnostics", "resourceTotal", "resourcesTruncated", "diagnosticTotal", "diagnosticsTruncated"], "Resource result");
      if (!Array.isArray(value.resources) || value.resources.length > 2_000 || !Array.isArray(value.diagnostics) || value.diagnostics.length > 2_000) throw new Error("Resource result arrays are invalid");
      for (const resource of value.resources) validateResource(resource);
      for (const diagnostic of value.diagnostics) validateDiagnostic(diagnostic);
      optionalNonNegativeInteger(value.resourceTotal, "Resource total"); optionalBoolean(value.resourcesTruncated, "Resource truncation");
      optionalNonNegativeInteger(value.diagnosticTotal, "Diagnostic total"); optionalBoolean(value.diagnosticsTruncated, "Diagnostic truncation");
      return;
    }
    case "runtime.resolveSessionTarget": {
      const target = record(result, "Session target"); exactKeys(target, ["canonicalCwd"], "Session target"); boundedString(target.canonicalCwd, 16_384, "Canonical cwd"); return;
    }
    case "runtime.newSession": case "runtime.switchSession": case "runtime.reload": {
      const value = record(result, "Replacement result"); exactKeys(value, ["cancelled"], "Replacement result");
      if (typeof value.cancelled !== "boolean") throw new Error("Replacement cancellation is invalid"); return;
    }
    case "runtime.fork": {
      const value = record(result, "Fork result"); exactKeys(value, ["cancelled", "selectedText"], "Fork result"); if (typeof value.cancelled !== "boolean") throw new Error("Fork cancellation is invalid"); optionalString(value.selectedText, 256_000); return;
    }
    case "runtime.navigateTree": {
      const value = record(result, "Navigation result"); exactKeys(value, ["cancelled", "aborted", "editorText", "summaryCreated"], "Navigation result");
      if (typeof value.cancelled !== "boolean" || typeof value.summaryCreated !== "boolean") throw new Error("Navigation result flags are invalid");
      if (value.aborted !== undefined && typeof value.aborted !== "boolean") throw new Error("Navigation abort flag is invalid");
      optionalString(value.editorText, 256_000); return;
    }
    case "runtime.updateSetting": validateSetting(result); return;
    case "runtime.compact": {
      const value = record(result, "Compaction result"); exactKeys(value, ["summary", "firstKeptEntryId", "tokensBefore"], "Compaction result"); boundedString(value.summary, 2_000_000, "Compaction summary", true);
      boundedString(value.firstKeptEntryId, 128, "First kept entry"); nonNegativeInteger(value.tokensBefore, "Compaction token count"); return;
    }
    case "runtime.selectModel": case "runtime.setThinkingLevel": validateModelState(result, `${capability} result`); return;
    case "runtime.clearQueue": {
      const value = record(result, "Cleared queue result"); exactKeys(value, ["steering", "followUp"], "Cleared queue result");
      stringArray(value.steering, 1_000, 256_000, "Cleared steering queue"); stringArray(value.followUp, 1_000, 256_000, "Cleared follow-up queue"); return;
    }
    case "runtime.setSessionName": if (result !== undefined && result !== null) boundedString(result, 256, "Session name", true); return;
  }
}

export function encodeWorkerError(error: unknown): WorkerErrorDto {
  const base = { name: error instanceof Error ? error.name : "Error", message: boundedErrorMessage(error) };
  if (error instanceof RuntimeCompactionKnownFailureError) return { ...base, code: "compaction_known_failure", details: { reason: error.reason } };
  if (error instanceof RuntimeQueueRejectedBeforeEffectError) return { ...base, code: "queue_rejected" };
  if (error instanceof RuntimeQueueEffectUnknownError) return { ...base, code: "queue_effect_unknown" };
  if (error instanceof RuntimeUnknownToolError) return { ...base, code: "unknown_tool", details: { toolName: error.toolName } };
  if (error instanceof RuntimeModelNotFoundError) return { ...base, code: "model_not_found", details: { provider: error.provider, modelId: error.modelId } };
  if (error instanceof RuntimeInvalidSettingValueError) return { ...base, code: "invalid_setting", details: { setting: error.setting } };
  if (error instanceof RuntimeSettingsWriteError) return { ...base, code: "settings_write", details: { setting: error.setting, phase: error.phase, mutationApplied: error.mutationApplied, errors: error.errors } };
  return { ...base, code: "runtime_error" };
}

export function decodeWorkerError(error: WorkerErrorDto): Error {
  switch (error.code) {
    case "compaction_known_failure": return new RuntimeCompactionKnownFailureError(oneOfValue(error.details?.reason, ["nothing_to_compact", "already_compacted", "cancelled", "failed"], "failed"), error.message);
    case "queue_rejected": return new RuntimeQueueRejectedBeforeEffectError(new Error(error.message));
    case "queue_effect_unknown": return new RuntimeQueueEffectUnknownError(new Error(error.message));
    case "unknown_tool": return new RuntimeUnknownToolError(typeof error.details?.toolName === "string" ? error.details.toolName : "unknown");
    case "model_not_found": return new RuntimeModelNotFoundError(
      typeof error.details?.provider === "string" ? error.details.provider : "unknown",
      typeof error.details?.modelId === "string" ? error.details.modelId : "unknown",
    );
    case "invalid_setting": return new RuntimeInvalidSettingValueError((typeof error.details?.setting === "string" ? error.details.setting : "autoCompaction") as SettingKey);
    case "settings_write": return new RuntimeSettingsWriteError(
      (typeof error.details?.setting === "string" ? error.details.setting : "model") as SettingKey | "model" | "thinking",
      error.details?.phase === "baseline" ? "baseline" : "write",
      error.details?.mutationApplied === true,
      Array.isArray(error.details?.errors) ? error.details.errors.filter(isSettingsFailure) : [],
    );
    default: { const decoded = new Error(error.message); decoded.name = error.name; return decoded; }
  }
}

function validateTool(raw: unknown): void {
  const tool = record(raw, "Worker tool");
  exactKeys(tool, ["name", "description", "active", "source", "parameterSchema"], "Worker tool");
  boundedString(tool.name, 256, "Tool name"); boundedString(tool.description, 16_000, "Tool description", true);
  if (typeof tool.active !== "boolean") throw new Error("Tool active flag is invalid");
  if (tool.source !== undefined) validateSource(tool.source);
  if (tool.parameterSchema !== undefined) record(tool.parameterSchema, "Tool parameter schema");
}

function validateSource(raw: unknown): void {
  const source = record(raw, "Worker source");
  exactKeys(source, ["kind", "path", "package"], "Worker source");
  oneOf(source.kind, ["built-in", "extension", "skill", "prompt"], "Worker source kind");
  optionalString(source.path, 16_384); optionalString(source.package, 512);
}

function validateCommand(raw: unknown): void {
  const command = record(raw, "Worker command");
  exactKeys(command, ["name", "description", "source", "argumentCompletions"], "Worker command");
  boundedString(command.name, 256, "Command name"); optionalString(command.description, 16_000); validateSource(command.source);
  if (typeof command.argumentCompletions !== "boolean") throw new Error("Command completion flag is invalid");
}

function validateResource(raw: unknown): void {
  const resource = record(raw, "Worker resource");
  exactKeys(resource, ["kind", "name", "path", "source"], "Worker resource");
  oneOf(resource.kind, ["extension", "skill", "prompt", "context"], "Worker resource kind");
  boundedString(resource.name, 512, "Resource name"); optionalString(resource.path, 16_384); if (resource.source !== undefined) validateSource(resource.source);
}

function validateDiagnostic(raw: unknown): void {
  const diagnostic = record(raw, "Worker diagnostic");
  exactKeys(diagnostic, ["severity", "message", "source"], "Worker diagnostic");
  oneOf(diagnostic.severity, ["info", "warning", "error"], "Diagnostic severity"); boundedString(diagnostic.message, 2_048, "Diagnostic message", true); optionalString(diagnostic.source, 16_384);
}

function validateSetting(raw: unknown): void {
  const setting = record(raw, "Worker setting");
  exactKeys(setting, ["key", "value", "source", "writable", "valueType", "allowedValues", "min", "max", "reloadRequired", "hostRestartRequired"], "Worker setting");
  const key = oneOf(setting.key, SETTING_KEYS, "Setting key") as SettingKey;
  validateSettingValue(key, setting.value);
  if (typeof setting.writable !== "boolean" || typeof setting.reloadRequired !== "boolean" || typeof setting.hostRestartRequired !== "boolean") {
    throw new Error("Worker setting flags are invalid");
  }
  oneOf(setting.source, ["effective", "global", "project"], "Setting source");
  oneOf(setting.valueType, ["boolean", "enum", "integer", "object"], "Setting value type");
  if (setting.allowedValues !== undefined) {
    if (!Array.isArray(setting.allowedValues) || setting.allowedValues.length > 64) throw new Error("Setting allowed values are invalid");
    for (const value of setting.allowedValues) if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("Setting allowed value is invalid");
  }
  optionalFiniteNumber(setting.min, "Setting minimum"); optionalFiniteNumber(setting.max, "Setting maximum");
}

function validateSettingUpdate(raw: unknown): void {
  const update = record(raw, "Setting update");
  exactKeys(update, ["key", "value"], "Setting update");
  const key = oneOf(update.key, SETTING_KEYS, "Setting update key") as SettingKey;
  if (!SETTING_DEFINITIONS[key].writable) throw new Error("Setting is read-only");
  validateSettingValue(key, update.value);
}

function validateSettingValue(key: SettingKey, value: unknown): void {
  const definition = SETTING_DEFINITIONS[key];
  if (definition.valueType === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Setting ${key} value is invalid`);
    return;
  }
  if (definition.valueType === "integer") {
    if (!Number.isSafeInteger(value) || (value as number) < (definition.min ?? 0) || (value as number) > (definition.max ?? Number.MAX_SAFE_INTEGER)) throw new Error(`Setting ${key} value is invalid`);
    return;
  }
  if (definition.valueType === "enum") {
    if (typeof value !== "string" || !definition.allowedValues?.includes(value)) throw new Error(`Setting ${key} value is invalid`);
    return;
  }
  const objectValue = record(value, `Setting ${key} value`);
  exactKeys(objectValue, ["anthropicExtraUsage"], `Setting ${key} value`);
  optionalBoolean(objectValue.anthropicExtraUsage, `Setting ${key} warning flag`);
}

function validateModelState(raw: unknown, label: string): void {
  const state = record(raw, label);
  exactKeys(state, ["model", "thinkingLevel", "availableThinkingLevels"], label);
  oneOf(state.thinkingLevel, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], `${label} thinking level`);
  if (!Array.isArray(state.availableThinkingLevels) || state.availableThinkingLevels.length > 7) throw new Error(`${label} thinking levels are invalid`);
  for (const level of state.availableThinkingLevels) oneOf(level, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], `${label} thinking level`);
  if (state.model !== undefined) {
    const model = record(state.model, `${label} model`); exactKeys(model, ["provider", "id"], `${label} model`);
    boundedString(model.provider, 256, "Model provider"); boundedString(model.id, 512, "Model id");
  }
}

function validateMetrics(raw: unknown): void {
  const metrics = record(raw, "Worker metrics"); exactKeys(metrics, ["messages", "tokens", "cost", "context"], "Worker metrics");
  const messages = record(metrics.messages, "Worker message metrics"); exactKeys(messages, ["user", "assistant", "toolCalls", "toolResults", "total"], "Worker message metrics");
  for (const key of ["user", "assistant", "toolCalls", "toolResults", "total"]) nonNegativeInteger(messages[key], `Message metric ${key}`);
  const tokens = record(metrics.tokens, "Worker token metrics"); exactKeys(tokens, ["input", "output", "cacheRead", "cacheWrite", "total"], "Worker token metrics");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) nonNegativeInteger(tokens[key], `Token metric ${key}`);
  if (typeof metrics.cost !== "number" || !Number.isFinite(metrics.cost) || metrics.cost < 0) throw new Error("Worker cost metric is invalid");
  if (metrics.context !== undefined) {
    const context = record(metrics.context, "Worker context metrics"); exactKeys(context, ["tokens", "contextWindow", "percent"], "Worker context metrics");
    if (context.tokens !== null) nonNegativeInteger(context.tokens, "Context tokens");
    positiveInteger(context.contextWindow, "Context window");
    if (context.percent !== null && (typeof context.percent !== "number" || !Number.isFinite(context.percent) || context.percent < 0)) throw new Error("Context percent is invalid");
  }
}

function validateTree(raw: unknown): void {
  const tree = record(raw, "Worker tree"); exactKeys(tree, ["nodes", "leafId"], "Worker tree");
  if (!Array.isArray(tree.nodes) || tree.nodes.length > 100_000) throw new Error("Worker tree nodes are invalid");
  optionalString(tree.leafId, 128);
  for (const item of tree.nodes) {
    const node = record(item, "Worker tree node");
    exactKeys(node, ["entryId", "parentId", "depth", "kind", "role", "displayClass", "state", "label", "labelTimestamp", "timestamp", "summary", "hasChildren"], "Worker tree node");
    boundedString(node.entryId, 128, "Tree entry id"); optionalString(node.parentId, 128);
    nonNegativeInteger(node.depth, "Tree depth");
    oneOf(node.kind, ["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"], "Tree node kind");
    if (node.role !== undefined) oneOf(node.role, ["user", "assistant", "tool", "system"], "Tree node role");
    if (node.displayClass !== undefined) oneOf(node.displayClass, ["content", "tool", "metadata", "structural"], "Tree display class");
    if (node.state !== undefined) oneOf(node.state, ["error", "aborted"], "Tree state");
    boundedString(node.summary, 8_000, "Tree node summary", true);
    if (typeof node.hasChildren !== "boolean") throw new Error("Tree child flag is invalid");
    optionalString(node.timestamp, 128); optionalString(node.label, 256); optionalString(node.labelTimestamp, 128);
  }
}

function parseWorkerCache(raw: unknown): WorkerCache {
  const value = record(raw, "Worker cache");
  exactKeys(value, ["sessionId", "sessionFile", "durableSessionFile", "isStreaming", "isCompacting", "gitBranch", "modelState", "metrics", "history", "tree", "extensionCommands"], "Worker cache");
  if (typeof value.isStreaming !== "boolean" || typeof value.isCompacting !== "boolean") throw new Error("Worker streaming cache is invalid");
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 1_000_000) throw new Error("Worker history cache is invalid");
    for (const item of value.history) {
      const entry = record(item, "Worker history entry");
      exactKeys(entry, ["entryId", "parentId", "timestamp", "role", "summaryKind", "content", "stopReason", "error", "toolCallId", "toolName", "toolPresentation", "isError"], "Worker history entry");
      boundedString(entry.entryId, 128, "History entry id");
      oneOf(entry.role, ["user", "assistant", "tool", "toolResult", "system", "bashExecution", "custom", "branchSummary", "compactionSummary"], "History role");
      if (entry.summaryKind !== undefined) oneOf(entry.summaryKind, ["compaction", "branch"], "History summary kind");
      if (entry.role === "tool" || entry.role === "toolResult") validatePrivateToolContent(entry.content); else validatePrivateContent(entry.content);
      optionalString(entry.parentId, 128); optionalString(entry.timestamp, 128); optionalString(entry.stopReason, 128);
      optionalString(entry.error, 2_048); optionalString(entry.toolCallId, 128); optionalString(entry.toolName, 256);
      if (entry.toolPresentation !== undefined) validateToolPresentation(entry.toolPresentation);
      if (entry.isError !== undefined && typeof entry.isError !== "boolean") throw new Error("History error flag is invalid");
    }
  }
  validateModelState(value.modelState, "Worker model state");
  validateMetrics(value.metrics);
  if (value.tree !== undefined) validateTree(value.tree);
  return {
    sessionId: boundedString(value.sessionId, 128, "Worker session ID"),
    ...(optionalString(value.sessionFile, 16_384) === undefined ? {} : { sessionFile: optionalString(value.sessionFile, 16_384) }),
    ...(optionalString(value.durableSessionFile, 16_384) === undefined ? {} : { durableSessionFile: optionalString(value.durableSessionFile, 16_384) }),
    isStreaming: value.isStreaming,
    isCompacting: value.isCompacting,
    ...(optionalString(value.gitBranch, 256) === undefined ? {} : { gitBranch: optionalString(value.gitBranch, 256) }),
    modelState: value.modelState,
    metrics: value.metrics,
    ...(value.history === undefined ? {} : { history: value.history }),
    ...(value.tree === undefined ? {} : { tree: value.tree }),
    ...(value.extensionCommands === undefined ? {} : { extensionCommands: stringArray(value.extensionCommands, 2_000, 256, "Extension commands") }),
  };
}

function parseWorkerError(raw: unknown): WorkerErrorDto {
  const value = record(raw, "Worker error");
  exactKeys(value, ["code", "name", "message", "details"], "Worker error");
  const code = oneOf(value.code, ["compaction_known_failure", "queue_rejected", "queue_effect_unknown", "unknown_tool", "model_not_found", "invalid_setting", "settings_write", "runtime_error"] as const, "Worker error code");
  const details = value.details === undefined ? undefined : record(value.details, "Worker error details");
  validateWorkerErrorDetails(code, details);
  return { code, name: boundedString(value.name, 128, "Worker error name"), message: boundedString(value.message, 2_048, "Worker error message", true), ...(details === undefined ? {} : { details }) };
}

function validateWorkerErrorDetails(code: WorkerErrorDto["code"], details: Record<string, unknown> | undefined): void {
  if (code === "runtime_error" || code === "queue_rejected" || code === "queue_effect_unknown") {
    if (details !== undefined && Object.keys(details).length > 0) throw new Error(`${code} details are invalid`);
    return;
  }
  if (!details) throw new Error(`${code} details are required`);
  switch (code) {
    case "compaction_known_failure": exactKeys(details, ["reason"], "Compaction error details"); oneOf(details.reason, ["nothing_to_compact", "already_compacted", "cancelled", "failed"], "Compaction failure reason"); return;
    case "unknown_tool": exactKeys(details, ["toolName"], "Unknown-tool details"); boundedString(details.toolName, 256, "Tool name"); return;
    case "model_not_found": exactKeys(details, ["provider", "modelId"], "Model error details"); boundedString(details.provider, 256, "Model provider"); boundedString(details.modelId, 512, "Model id"); return;
    case "invalid_setting": exactKeys(details, ["setting"], "Setting error details"); boundedString(details.setting, 128, "Setting key"); return;
    case "settings_write":
      exactKeys(details, ["setting", "phase", "mutationApplied", "errors"], "Settings-write details");
      boundedString(details.setting, 128, "Setting key"); oneOf(details.phase, ["baseline", "write"], "Settings-write phase");
      if (typeof details.mutationApplied !== "boolean" || !Array.isArray(details.errors) || details.errors.length > 2_000) throw new Error("Settings-write details are invalid");
      for (const item of details.errors) {
        const error = record(item, "Settings failure"); exactKeys(error, ["scope", "message"], "Settings failure");
        oneOf(error.scope, ["global", "project", "unknown"], "Settings failure scope"); boundedString(error.message, 2_048, "Settings failure message", true);
      }
      return;
    default: return;
  }
}

function parseCapability(raw: unknown): WorkerCapability {
  return oneOf(raw, [
    "runtime.activate", "runtime.prompt", "runtime.queueMessage", "runtime.listModels", "runtime.listSessions", "runtime.navigateTree", "runtime.listTools", "runtime.setActiveTools", "runtime.getSettings", "runtime.updateSetting", "runtime.getResources", "runtime.getCommands", "runtime.resolveSessionTarget", "runtime.newSession", "runtime.switchSession", "runtime.fork", "runtime.setSessionName", "runtime.compact", "runtime.reload", "runtime.selectModel", "runtime.setThinkingLevel", "runtime.clearQueue", "runtime.abort", "runtime.waitForIdle", "runtime.dispose",
    "ui.select", "ui.confirm", "ui.input", "ui.editor", "ui.notify", "ui.setTitle", "ui.setEditorText", "ui.setStatus", "ui.setWidget", "ui.widgetError", "ui.unsupported", "ui.setToolsExpanded", "ui.cancel", "ui.viewport", "ui.reset", "ui.generationBegin",
    "dock.identity",
  ] as const, "Worker capability");
}

function validatePromptOptions(raw: unknown): void {
  const value = record(raw, "Prompt options");
  exactKeys(value, ["streamingBehavior", "images", "source"], "Prompt options");
  if (value.streamingBehavior !== undefined) oneOf(value.streamingBehavior, ["steer", "followUp"], "Prompt streaming behavior");
  if (value.images !== undefined) validateImagePaths(value.images);
  if (value.source !== undefined) oneOf(value.source, ["interactive", "rpc", "extension"], "Prompt source");
}

function validateImageMimeType(raw: unknown, field: string): string {
  const mimeType = boundedString(raw, MAX_IMAGE_MIME_TYPE_CHARS, field);
  if (!/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mimeType)) throw new Error(`${field} must be image/*`);
  return mimeType;
}

function validateImagePaths(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > MAX_INPUT_IMAGES) throw new Error("Worker image paths must be a bounded array");
  const seen = new Set<string>();
  for (const item of raw) {
    const image = record(item, "Worker image path"); exactKeys(image, ["path", "mimeType"], "Worker image path");
    const path = boundedString(image.path, MAX_IMAGE_PATH_CHARS, "Worker image path");
    if (!path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw new Error("Worker image path must be absolute and control-free");
    const mimeType = validateImageMimeType(image.mimeType, "Worker image MIME type");
    const key = `${path}\u0000${mimeType}`; if (seen.has(key)) throw new Error("Worker image paths must be unique"); seen.add(key);
  }
}

function validateDialogOptions(raw: unknown): void {
  if (raw === undefined) return;
  const value = record(raw, "Dialog options");
  exactKeys(value, ["timeout", "signalAborted"], "Dialog options");
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || Math.abs(value.timeout) > 86_400_000)) throw new Error("Dialog timeout is invalid");
  if (value.signalAborted !== undefined && typeof value.signalAborted !== "boolean") throw new Error("Dialog signal state is invalid");
}

function validateJsonValue(root: unknown): void {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > 2_000_000 || depth > 32) throw new Error("Worker IPC JSON structure exceeds bounds");
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Worker IPC JSON contains a non-finite number");
      continue;
    }
    if (typeof value === "string") {
      if (value.length > 2_000_000) throw new Error("Worker IPC JSON string exceeds bounds");
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 100_000) throw new Error("Worker IPC JSON array exceeds bounds");
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value !== "object" || value === undefined) throw new Error("Worker IPC contains a non-JSON value");
    const entries = Object.entries(value);
    if (entries.length > 10_000) throw new Error("Worker IPC JSON object exceeds bounds");
    for (const [key, child] of entries) {
      if (key.length > 256 || child === undefined) throw new Error("Worker IPC JSON member is invalid");
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}
function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return raw as Record<string, unknown>;
}
function boundedString(raw: unknown, limit: number, label: string, empty = false): string {
  if (typeof raw !== "string" || (!empty && raw.length < 1) || raw.length > limit) throw new Error(`${label} must be a bounded string`);
  return raw;
}
function optionalString(raw: unknown, limit: number): string | undefined {
  if (raw === undefined) return undefined;
  return boundedString(raw, limit, "Optional value", true);
}
function directiveString(raw: unknown, limit: number, label: string, multiline: boolean): string {
  const value = boundedString(raw, limit, label, true);
  const controls = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u;
  if (controls.test(value) || containsBinaryPayload(value)) throw new Error(`${label} must be control-safe and payload-free`);
  return value;
}
function positiveInteger(raw: unknown, label: string): number { if (!Number.isSafeInteger(raw) || (raw as number) < 1) throw new Error(`${label} must be a positive integer`); return raw as number; }
function nonNegativeInteger(raw: unknown, label: string): number { if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new Error(`${label} must be a non-negative integer`); return raw as number; }
function optionalNonNegativeInteger(raw: unknown, label: string): number | undefined { return raw === undefined ? undefined : nonNegativeInteger(raw, label); }
function optionalBoolean(raw: unknown, label: string): boolean | undefined { if (raw === undefined) return undefined; if (typeof raw !== "boolean") throw new Error(`${label} must be boolean`); return raw; }
function optionalFiniteNumber(raw: unknown, label: string): number | undefined { if (raw === undefined) return undefined; if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${label} must be finite`); return raw; }
function stringArray(raw: unknown, maxItems: number, maxChars: number, label: string): string[] {
  if (!Array.isArray(raw) || raw.length > maxItems) throw new Error(`${label} must be a bounded array`);
  return raw.map((item) => boundedString(item, maxChars, label, true));
}
function oneOf<const T extends readonly string[]>(raw: unknown, values: T, label: string): T[number] {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) throw new Error(`${label} is invalid`);
  return raw as T[number];
}
function oneOfValue<const T extends readonly string[]>(raw: unknown, values: T, fallback: T[number]): T[number] { return typeof raw === "string" && (values as readonly string[]).includes(raw) ? raw as T[number] : fallback; }
function fail(message: string): never { throw new Error(message); }
function boundedErrorMessage(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.length <= 2_048 ? text : `${text.slice(0, 2_032)}…[truncated]`; }
function isSettingsFailure(value: unknown): value is { scope: "global" | "project" | "unknown"; message: string } { if (!value || typeof value !== "object") return false; const item = value as Record<string, unknown>; return (item.scope === "global" || item.scope === "project" || item.scope === "unknown") && typeof item.message === "string"; }
