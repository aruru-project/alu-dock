import {
  AgentCompactionKnownFailureError,
  AgentConversationCursorError,
  AgentInvalidSettingValueError,
  AgentInvalidTreeTargetError,
  AgentModelNotFoundError,
  AgentQueueEffectUnknownError,
  AgentQueueRejectedBeforeEffectError,
  AgentSettingsWriteError,
  AgentUnknownToolError,
} from "../core/agent-worker.js";
import { PublishedFileUnavailableError } from "../core/published-file.js";
import type { AgentCommandPreflightResult, AgentInvokeContext, AgentRequest, AgentWorkerControl, AgentWorkerState } from "../core/agent-worker.js";
import {
  parseAttachmentDto,
  parseCommandsResult,
  parseControlRequest,
  parseConversationContentBody,
  parseConversationHistoryBody,
  parseFileReadBody,
  parseHistoryEntry,
  parseCompactionBody,
  parseModelListBody,
  parsePublishedFileDto,
  parseResourcesResult,
  parseSessionsResult,
  parseSettingDto,
  parseSettingDtos,
  parseSessionTreeResult,
  parseToolListBody,
} from "../control/protocol.js";
import {
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_SEMANTIC_HISTORY_PAGE_BYTES,
  MAX_SEMANTIC_HISTORY_PAGE_ITEMS,
} from "../core/instance-dto.js";
import {
  CROSS_INSTANCE_TRUST,
  MAX_OBSERVATION_CURSOR_CHARS,
  MAX_OBSERVATION_LIST_ITEMS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
  MAX_OBSERVATION_MESSAGE_TEXT_CHARS,
  OBSERVATION_DATA_NOTICE,
  type ObservationMessageType,
  type ObservationNotification,
  type ObservationRequest,
} from "../core/instance-observation.js";
import type { SettingKey } from "../core/config-projection.js";
import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  type DockToolsRequest,
} from "../core/dock-tools.js";
import { MAX_DOCK_TRANSFER_BYTES } from "../core/transport-bounds.js";

export const PI_WORKER_PROTOCOL = "alu-dock-pi-worker";
export const PI_WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_CHUNK_CHARS = 96_000;
export const MAX_WORKER_TRANSFER_BYTES = MAX_DOCK_TRANSFER_BYTES;
export const MAX_WORKER_TRANSFER_CHUNKS = 4_096;

export interface WorkerIdentity {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  workerIncarnation: string;
}

export type UiCapability =
  | "ui.select" | "ui.confirm" | "ui.input" | "ui.editor"
  | "ui.notify" | "ui.setTitle" | "ui.setEditorText" | "ui.setStatus" | "ui.setWidget" | "ui.widgetError"
  | "ui.unsupported" | "ui.setToolsExpanded" | "ui.cancel" | "ui.viewport" | "ui.reset" | "ui.generationBegin";

export type DockCapability = "dock.identity" | "dock.tools.configure" | "dock.tools" | "dock.attachments";
export type ReverseWorkerCapability = DockCapability | Exclude<UiCapability, "ui.viewport" | "ui.reset">;
export const ORDINARY_REVERSE_WORKER_CAPABILITIES: readonly ReverseWorkerCapability[] = [
  "dock.identity", "dock.tools.configure", "dock.tools", "dock.attachments",
  "ui.select", "ui.confirm", "ui.input", "ui.editor", "ui.notify", "ui.setTitle", "ui.setEditorText", "ui.setStatus",
  "ui.setWidget", "ui.widgetError", "ui.unsupported", "ui.setToolsExpanded", "ui.cancel", "ui.generationBegin",
];
export type WorkerCapability = UiCapability | DockCapability;

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
    | "conversation_cursor" | "file_unavailable" | "invalid_tree_target" | "runtime_error";
  name: string;
  message: string;
  details?: Record<string, unknown>;
}

export type WorkerEnvelope =
  | { kind: "ready"; state: AgentWorkerState; diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }
  | { kind: "agent_request"; callId: string; request: AgentRequest; context?: AgentInvokeContext }
  | { kind: "agent_control"; callId: string; control: AgentWorkerControl }
  | { kind: "call"; callId: string; capability: WorkerCapability; args: unknown }
  | { kind: "accepted"; callId: string }
  | { kind: "response"; callId: string; ok: true; result: unknown; state?: AgentWorkerState }
  | { kind: "response"; callId: string; ok: false; error: WorkerErrorDto; state?: AgentWorkerState }
  | { kind: "event"; event: Record<string, unknown>; state: AgentWorkerState }
  | ({ kind: "preflight"; callId: string } & AgentCommandPreflightResult)
  | { kind: "fatal"; error: WorkerErrorDto };

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
      exactKeys(value, ["kind", "state", "diagnostics", "modelFallbackMessage", "persistedName", "pid"], "Worker ready envelope");
      const diagnostics = stringArray(value.diagnostics, 2_000, 2_048, "Worker diagnostics");
      return { kind, state: parseAgentWorkerState(value.state), diagnostics, ...(optionalString(value.modelFallbackMessage, 2_048) === undefined ? {} : { modelFallbackMessage: optionalString(value.modelFallbackMessage, 2_048) }), ...(optionalString(value.persistedName, 256) === undefined ? {} : { persistedName: optionalString(value.persistedName, 256) }), pid: positiveInteger(value.pid, "Worker pid") };
    }
    case "agent_request": {
      exactKeys(value, ["kind", "callId", "request", "context"], "Worker Agent request envelope");
      const request = parseControlRequest(value.request);
      if (!isAgentRequest(request.type)) throw new Error("Worker received a non-Agent Protocol V2 request");
      const context = value.context === undefined ? undefined : parseAgentInvokeContext(value.context);
      if ((request.type === "session.switch") !== (context?.type === "session_switch")) {
        throw new Error("Worker session switch request requires resolved Host invoke context");
      }
      if ((context?.type === "force_queue" || context?.type === "host_queue")
        && (request.type !== "command.submit" || request.params.delivery === "prompt")) {
        throw new Error("Worker Host queue context requires a steer or followUp command submission");
      }
      if (context?.type === "command" && request.type !== "command.submit") throw new Error("Worker command context requires command.submit");
      if (request.type === "command.submit") {
        const requestedIds = request.params.attachments ?? [];
        const contextAttachments = context !== undefined && context.type !== "session_switch" ? context.attachments ?? [] : [];
        if (requestedIds.length !== contextAttachments.length || requestedIds.some((fileId, index) => contextAttachments[index]?.fileId !== fileId)) {
          throw new Error("Worker attachment context does not match command attachment IDs");
        }
      }
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID"), request: request as AgentRequest, ...(context === undefined ? {} : { context }) };
    }
    case "agent_control": {
      exactKeys(value, ["kind", "callId", "control"], "Worker Agent control envelope");
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID"), control: parseAgentWorkerControl(value.control) };
    }
    case "call": {
      exactKeys(value, ["kind", "callId", "capability", "args"], "Worker call envelope");
      const capability = parseCapability(value.capability);
      validateUiCapabilityArgs(capability, value.args);
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID"), capability, args: value.args };
    }
    case "accepted":
      exactKeys(value, ["kind", "callId"], "Worker accepted envelope");
      return { kind, callId: boundedString(value.callId, 128, "Worker call ID") };
    case "response": {
      const callId = boundedString(value.callId, 128, "Worker call ID");
      const state = value.state === undefined ? undefined : parseAgentWorkerState(value.state);
      if (value.ok === true) {
        exactKeys(value, ["kind", "callId", "ok", "result", "state"], "Worker success response envelope");
        return { kind, callId, ok: true, result: value.result, ...(state ? { state } : {}) };
      }
      if (value.ok === false) {
        exactKeys(value, ["kind", "callId", "ok", "error", "state"], "Worker error response envelope");
        return { kind, callId, ok: false, error: parseWorkerError(value.error), ...(state ? { state } : {}) };
      }
      throw new Error("Worker response status is invalid");
    }
    case "event": {
      exactKeys(value, ["kind", "event", "state"], "Worker event envelope");
      const event = record(value.event, "Worker runtime event");
      validateWorkerAgentEvent(event);
      return { kind, event, state: parseAgentWorkerState(value.state) };
    }
    case "preflight": {
      exactKeys(value, ["kind", "callId", "success", "delivery"], "Worker preflight envelope");
      if (typeof value.success !== "boolean") throw new Error("Worker preflight status is invalid");
      const callId = boundedString(value.callId, 128, "Worker call ID");
      if (!value.success) {
        if (value.delivery !== undefined) throw new Error("Rejected Worker preflight cannot declare delivery");
        return { kind, callId, success: false };
      }
      return {
        kind,
        callId,
        success: true,
        delivery: oneOf(value.delivery, ["prompt", "steer", "followUp"] as const, "Worker actual delivery"),
      };
    }
    case "fatal":
      exactKeys(value, ["kind", "error"], "Worker fatal envelope");
      return { kind, error: parseWorkerError(value.error) };
    default: throw new Error(`Unknown Worker envelope kind: ${kind}`);
  }
}

function validateWorkerAgentEvent(event: Record<string, unknown>): void {
  const type = oneOf(event.type, [
    "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
    "queue_update", "compaction_start", "compaction_end", "conversation_checkpoint",
    "session_info_changed", "thinking_level_changed", "auto_retry_start", "auto_retry_end",
    "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
    "dock_session_replaced", "dock_runtime_error", "dock_runtime_lost",
    "dock_extension_error", "dock_git_branch_changed", "dock_conversation_frame", "dock_queue_consumed",
  ] as const, "Worker runtime event type");
  switch (type) {
    case "agent_start":
      exactKeys(event, ["type", "operationId"], "Worker agent-start event"); optionalString(event.operationId, 128); return;
    case "turn_start": case "summarization_retry_finished":
      exactKeys(event, ["type"], `Worker ${type} event`); return;
    case "agent_settled":
      exactKeys(event, ["type", "stopReason", "error", "operationId"], "Worker agent-settled event");
      optionalString(event.stopReason, 128); optionalString(event.error, 2_048); optionalString(event.operationId, 128); return;
    case "conversation_checkpoint":
      exactKeys(event, ["type", "history"], "Worker conversation checkpoint");
      if (!Array.isArray(event.history) || event.history.length > 100_000) throw new Error("Worker checkpoint history is invalid");
      event.history.forEach((entry, index) => parseHistoryEntry(entry, `Worker checkpoint history[${index}]`));
      return;
    case "agent_end":
      exactKeys(event, ["type", "willRetry"], "Worker agent-end event");
      if (typeof event.willRetry !== "boolean") throw new Error("Worker agent-end event is invalid"); return;
    case "turn_end":
      exactKeys(event, ["type"], "Worker turn-end event"); return;
    case "compaction_start":
      exactKeys(event, ["type", "reason", "operationId"], "Worker compaction-start event"); oneOf(event.reason, ["manual", "threshold", "overflow"], "Compaction reason"); optionalString(event.operationId, 128); return;
    case "compaction_end":
      exactKeys(event, ["type", "reason", "aborted", "willRetry", "errorMessage", "operationId"], "Worker compaction-end event");
      oneOf(event.reason, ["manual", "threshold", "overflow"], "Compaction reason");
      if (typeof event.aborted !== "boolean" || typeof event.willRetry !== "boolean") throw new Error("Compaction event flags are invalid");
      optionalString(event.errorMessage, 2_048); optionalString(event.operationId, 128); return;
    case "dock_conversation_frame":
      exactKeys(event, ["type", "frame"], "Worker conversation-frame event"); validateConversationFrame(event.frame); return;
    case "dock_queue_consumed":
      exactKeys(event, ["type", "operationId"], "Worker queue-consumed event"); boundedString(event.operationId, 128, "Worker queue operation id"); return;
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
      exactKeys(event, ["type", "reason", "previousSessionFile", "sessionFile", "cwd", "name", "gitBranch", "operationId"], "Worker replacement event");
      oneOf(event.reason, ["new", "resume", "fork", "clone", "reload"], "Worker replacement reason");
      optionalString(event.previousSessionFile, 16_384); optionalString(event.sessionFile, 16_384);
      optionalString(event.cwd, 16_384); optionalString(event.name, 256); optionalString(event.gitBranch, 256); optionalString(event.operationId, 128);
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
      exactKeys(event, ["type", "name", "operationId"], "Worker session-info event"); optionalString(event.name, 256); optionalString(event.operationId, 128); return;
    case "queue_update":
      exactKeys(event, ["type", "steering", "followUp"], "Worker queue event");
      stringArray(event.steering, 1_000, 256_000, "Worker steering queue");
      stringArray(event.followUp, 1_000, 256_000, "Worker follow-up queue");
      return;
    default:
      return;
  }
}

function validateConversationFrame(raw: unknown): void {
  const frame = record(raw, "Worker conversation frame");
  exactKeys(frame, ["type", "data"], "Worker conversation frame");
  const type = oneOf(frame.type, [
    "message.submitted", "message.delta", "message.completed",
    "tool.started", "tool.args_updated", "tool.output_updated", "tool.completed",
  ], "Worker conversation frame type");
  const data = record(frame.data, `Worker ${type} data`);
  if (type === "message.submitted") {
    exactKeys(data, ["operationId", "messageId", "role", "text", "images", "attachments", "delivery", "queueItemId"], "Worker submitted-message data");
    boundedString(data.operationId, 128, "Message operation id"); boundedString(data.messageId, 128, "Message id");
    if (data.role !== "user") throw new Error("Submitted message role is invalid");
    boundedString(data.text, 256_000, "Submitted message text", true);
    if (data.images !== undefined) validateImagePaths(data.images);
    if (data.attachments !== undefined) validateAttachmentDtos(data.attachments, "Submitted attachments");
    oneOf(data.delivery, ["prompt", "steer", "followUp"], "Message delivery"); optionalString(data.queueItemId, 128);
    return;
  }
  if (type === "message.delta") {
    exactKeys(data, ["messageId", "block", "delta"], "Worker message-delta data");
    boundedString(data.messageId, 128, "Message id"); oneOf(data.block, ["text", "thinking"], "Message block"); boundedString(data.delta, 8_000, "Message delta", true); return;
  }
  if (type === "message.completed") {
    exactKeys(data, ["messageId", "role", "content", "attachments", "stopReason", "error"], "Worker completed-message data");
    boundedString(data.messageId, 128, "Message id"); oneOf(data.role, ["user", "assistant", "tool", "system"], "Completed message role");
    validateDockContent(data.content); if (data.attachments !== undefined) validateAttachmentDtos(data.attachments, "Completed-message attachments"); optionalString(data.stopReason, 128); optionalString(data.error, 2_048); return;
  }
  if (type === "tool.started" || type === "tool.args_updated") {
    exactKeys(data, type === "tool.started" ? ["toolCallId", "toolName", "args", "omittedFields"] : ["toolCallId", "args", "omittedFields"], `Worker ${type} data`);
    boundedString(data.toolCallId, 128, "Tool call id"); if (type === "tool.started") boundedString(data.toolName, 256, "Tool name");
    record(data.args, "Tool arguments"); validateJsonValue(data.args); if (data.omittedFields !== undefined) stringArray(data.omittedFields, 200, 2_048, "Tool omissions"); return;
  }
  if (type === "tool.output_updated") {
    exactKeys(data, ["toolCallId", "text", "content", "publishedFile", "presentation"], "Worker tool-output data");
    boundedString(data.toolCallId, 128, "Tool call id"); boundedString(data.text, 256_000, "Tool output", true);
    if (data.content !== undefined) validateDockContent(data.content);
    if (data.publishedFile !== undefined) parsePublishedFileDto(data.publishedFile, "Worker published file");
    if (data.presentation !== undefined) validateToolPresentation(data.presentation); return;
  }
  exactKeys(data, ["toolCallId", "toolName", "text", "isError", "content", "publishedFile", "presentation", "omittedFields"], "Worker completed-tool data");
  boundedString(data.toolCallId, 128, "Tool call id"); boundedString(data.toolName, 256, "Tool name"); boundedString(data.text, 256_000, "Tool output", true);
  if (typeof data.isError !== "boolean") throw new Error("Tool error flag is invalid");
  if (data.content !== undefined) validateDockContent(data.content);
  if (data.publishedFile !== undefined) parsePublishedFileDto(data.publishedFile, "Worker published file");
  if (data.presentation !== undefined) validateToolPresentation(data.presentation);
  if (data.omittedFields !== undefined) stringArray(data.omittedFields, 200, 2_048, "Tool omissions");
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

/**
 * Worker results for public capabilities are validated with the same Protocol V2 body
 * parsers the TypeScript client uses. Only transport byte bounds are private here;
 * result shapes have exactly one definition in control/protocol.ts.
 */
export function validateAgentWorkerResult(label: string, raw: unknown): void {
  switch (label) {
    case "session.history": {
      if (!Array.isArray(raw) || raw.length > 100_000) throw new Error("Worker session history is invalid");
      raw.forEach((entry, index) => parseHistoryEntry(entry, `Worker history[${index}]`));
      return;
    }
    case "conversation.history": {
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_SEMANTIC_HISTORY_PAGE_BYTES) throw new Error("Conversation history page exceeds its byte limit");
      parseConversationHistoryBody(raw);
      return;
    }
    case "conversation.content": {
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 512 * 1024) throw new Error("Conversation content page exceeds the Worker capability bound");
      parseConversationContentBody(raw);
      return;
    }
    case "file.read": parseFileReadBody(raw); return;
    case "model.list": parseModelListBody(raw); return;
    case "session.compact": parseCompactionBody(raw); return;
    case "tool.list": case "tool.set_active": parseToolListBody(raw); return;
    case "settings.get": parseSettingDtos(raw); return;
    case "settings.update": parseSettingDto(raw, "Worker setting"); return;
    case "resource.get": parseResourcesResult(raw); return;
    case "command.catalog": parseCommandsResult(raw); return;
    case "session.list": parseSessionsResult(raw); return;
    case "session.tree": parseSessionTreeResult(raw); return;
    default: return;
  }
}

function validateAttachmentDtos(raw: unknown, label: string): void {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) throw new Error(`${label} must be a nonempty bounded array`);
  const attachments = raw.map((item, index) => parseWorkerAttachmentDto(item, `${label}[${index}]`));
  if (new Set(attachments.map((attachment) => attachment.fileId)).size !== attachments.length) throw new Error(`${label} contains duplicate file IDs`);
}

function validateDockContent(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > 200) throw new Error("Worker conversation content is invalid");
  for (const item of raw) {
    const block = record(item, "Worker conversation content block");
    const type = oneOf(block.type, ["text", "thinking", "image", "tool_call", "tool_result", "omitted"], "Conversation content type");
    if (type === "text" || type === "thinking") {
      exactKeys(block, ["type", "text"], "Conversation text block");
      boundedString(block.text, 8_000, "Conversation text", true);
    } else if (type === "image") {
      exactKeys(block, ["type", "mimeType", "contentRef", "fileId"], "Conversation image block");
      validateImageMimeType(block.mimeType, "Conversation image MIME type");
      optionalString(block.contentRef, 128);
      optionalString(block.fileId, 128);
    } else if (type === "tool_call") {
      exactKeys(block, ["type", "toolCallId", "toolName", "args", "omittedFields"], "Conversation tool-call block");
      boundedString(block.toolCallId, 128, "Conversation tool-call id"); boundedString(block.toolName, 256, "Conversation tool-call name");
      validateJsonValue(block.args);
      if (block.omittedFields !== undefined) stringArray(block.omittedFields, 200, 2_048, "Conversation tool-call omissions");
    } else if (type === "tool_result") {
      exactKeys(block, ["type", "toolCallId", "toolName", "text", "isError", "publishedFile", "presentation", "omittedFields"], "Conversation tool-result block");
      boundedString(block.toolCallId, 128, "Conversation tool-result id"); boundedString(block.toolName, 256, "Conversation tool-result name");
      boundedString(block.text, 256_000, "Conversation tool-result text", true);
      if (typeof block.isError !== "boolean") throw new Error("Conversation tool-result error flag is invalid");
      if (block.publishedFile !== undefined) parsePublishedFileDto(block.publishedFile, "Worker conversation published file");
      if (block.presentation !== undefined) validateToolPresentation(block.presentation);
      if (block.omittedFields !== undefined) stringArray(block.omittedFields, 200, 2_048, "Conversation tool-result omissions");
    } else {
      exactKeys(block, ["type", "kind", "description"], "Conversation omitted block");
      oneOf(block.kind, ["image", "binary"], "Conversation omitted kind"); boundedString(block.description, 2_048, "Conversation omission description");
    }
  }
}

export function validateUiCapabilityArgs(capability: WorkerCapability, raw: unknown): void {
  const args = record(raw, `${capability} arguments`);
  const keys = (...allowed: string[]): void => exactKeys(args, allowed, `${capability} arguments`);
  switch (capability) {
    case "dock.identity": keys(); return;
    case "dock.tools.configure": keys("enabled", "operationId"); if (typeof args.enabled !== "boolean") throw new Error("Dock tools enabled flag is invalid"); boundedString(args.operationId, 128, "Dock tools operation ID"); return;
    case "dock.tools": keys("request"); parseDockToolsRequest(args.request); return;
    case "dock.attachments": keys("request"); parseAttachmentAccessRequest(args.request); return;
    case "ui.select": keys("title", "options", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); stringArray(args.options, 256, 16_000, "Dialog options"); validateDialogOptions(args.optionsMeta); return;
    case "ui.confirm": keys("title", "message", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); boundedString(args.message, 16_000, "Dialog message", true); validateDialogOptions(args.optionsMeta); return;
    case "ui.input": keys("title", "placeholder", "optionsMeta"); boundedString(args.title, 4_096, "Dialog title", true); optionalString(args.placeholder, 4_096); validateDialogOptions(args.optionsMeta); return;
    case "ui.editor": keys("title", "prefill"); boundedString(args.title, 4_096, "Dialog title", true); optionalString(args.prefill, 300_000); return;
    case "ui.notify": keys("message", "level", "operationId"); boundedString(args.message, 16_000, "Notification", true); oneOf(args.level, ["info", "warning", "error"], "Notification level"); optionalString(args.operationId, 128); return;
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

export function validateDockCapabilityResult(capability: DockCapability, result: unknown): void {
  if (capability === "dock.identity") return;
  if (capability === "dock.attachments") { parseAttachmentAccessResult(result); return; }
  if (capability === "dock.tools.configure") {
    const value = record(result, "Dock tools configure result");
    exactKeys(value, ["enabled"], "Dock tools configure result");
    if (typeof value.enabled !== "boolean") throw new Error("Dock tools configure result is invalid");
    return;
  }
  parseDockToolsResult(result);
}

export function validateUiCapabilityResult(capability: UiCapability, result: unknown): void {
  if (capability === "ui.select" || capability === "ui.input" || capability === "ui.editor") {
    if (result !== undefined && result !== null) boundedString(result, capability === "ui.editor" ? 300_000 : 16_000, `${capability} result`, true);
    return;
  }
  if (capability === "ui.confirm") { if (typeof result !== "boolean") throw new Error("ui.confirm result must be boolean"); return; }
  if (result !== undefined && result !== null) throw new Error(`${capability} result must be empty`);
}

export function encodeWorkerError(error: unknown): WorkerErrorDto {
  const base = { name: error instanceof Error ? error.name : "Error", message: boundedErrorMessage(error) };
  if (error instanceof AgentCompactionKnownFailureError) return { ...base, code: "compaction_known_failure", details: { reason: error.reason } };
  if (error instanceof AgentConversationCursorError) return { ...base, code: "conversation_cursor" };
  if (error instanceof PublishedFileUnavailableError) return { ...base, code: "file_unavailable" };
  if (error instanceof AgentInvalidTreeTargetError) return { ...base, code: "invalid_tree_target" };
  if (error instanceof AgentQueueRejectedBeforeEffectError) return { ...base, code: "queue_rejected" };
  if (error instanceof AgentQueueEffectUnknownError) return { ...base, code: "queue_effect_unknown" };
  if (error instanceof AgentUnknownToolError) return { ...base, code: "unknown_tool", details: { toolName: error.toolName } };
  if (error instanceof AgentModelNotFoundError) return { ...base, code: "model_not_found", details: { provider: error.provider, modelId: error.modelId } };
  if (error instanceof AgentInvalidSettingValueError) return { ...base, code: "invalid_setting", details: { setting: error.setting } };
  if (error instanceof AgentSettingsWriteError) return { ...base, code: "settings_write", details: { setting: error.setting, phase: error.phase, mutationApplied: error.mutationApplied, errors: error.errors } };
  return { ...base, code: "runtime_error" };
}

export function decodeWorkerError(error: WorkerErrorDto): Error {
  switch (error.code) {
    case "compaction_known_failure": return new AgentCompactionKnownFailureError(oneOfValue(error.details?.reason, ["nothing_to_compact", "already_compacted", "cancelled", "failed"], "failed"), error.message);
    case "conversation_cursor": return new AgentConversationCursorError(error.message);
    case "file_unavailable": return new PublishedFileUnavailableError(error.message);
    case "invalid_tree_target": return new AgentInvalidTreeTargetError(error.message);
    case "queue_rejected": return new AgentQueueRejectedBeforeEffectError(new Error(error.message));
    case "queue_effect_unknown": return new AgentQueueEffectUnknownError(new Error(error.message));
    case "unknown_tool": return new AgentUnknownToolError(typeof error.details?.toolName === "string" ? error.details.toolName : "unknown");
    case "model_not_found": return new AgentModelNotFoundError(
      typeof error.details?.provider === "string" ? error.details.provider : "unknown",
      typeof error.details?.modelId === "string" ? error.details.modelId : "unknown",
    );
    case "invalid_setting": return new AgentInvalidSettingValueError((typeof error.details?.setting === "string" ? error.details.setting : "autoCompaction") as SettingKey);
    case "settings_write": return new AgentSettingsWriteError(
      (typeof error.details?.setting === "string" ? error.details.setting : "model") as SettingKey | "model" | "thinking",
      error.details?.phase === "baseline" ? "baseline" : "write",
      error.details?.mutationApplied === true,
      Array.isArray(error.details?.errors) ? error.details.errors.filter(isSettingsFailure) : [],
    );
    default: { const decoded = new Error(error.message); decoded.name = error.name; return decoded; }
  }
}

function parseWorkerError(raw: unknown): WorkerErrorDto {
  const value = record(raw, "Worker error");
  exactKeys(value, ["code", "name", "message", "details"], "Worker error");
  const code = oneOf(value.code, ["compaction_known_failure", "queue_rejected", "queue_effect_unknown", "unknown_tool", "model_not_found", "invalid_setting", "settings_write", "conversation_cursor", "file_unavailable", "invalid_tree_target", "runtime_error"] as const, "Worker error code");
  const details = value.details === undefined ? undefined : record(value.details, "Worker error details");
  validateWorkerErrorDetails(code, details);
  return { code, name: boundedString(value.name, 128, "Worker error name"), message: boundedString(value.message, 2_048, "Worker error message", true), ...(details === undefined ? {} : { details }) };
}

function validateWorkerErrorDetails(code: WorkerErrorDto["code"], details: Record<string, unknown> | undefined): void {
  if (code === "runtime_error" || code === "conversation_cursor" || code === "file_unavailable" || code === "invalid_tree_target" || code === "queue_rejected" || code === "queue_effect_unknown") {
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

function parseAgentWorkerState(raw: unknown): AgentWorkerState {
  const value = record(raw, "Worker Agent state");
  exactKeys(value, ["sessionId", "sessionFile", "durableSessionFile", "isStreaming", "isCompacting", "gitBranch", "modelState", "metrics", "extensionCommands"], "Worker Agent state");
  boundedString(value.sessionId, 128, "Agent session ID"); optionalString(value.sessionFile, 16_384); optionalString(value.durableSessionFile, 16_384); optionalString(value.gitBranch, 256);
  if (typeof value.isStreaming !== "boolean" || typeof value.isCompacting !== "boolean") throw new Error("Worker Agent lifecycle state is invalid");
  if (!Array.isArray(value.extensionCommands)) throw new Error("Worker Agent projection state is invalid");
  validateJsonValue(value.modelState); validateJsonValue(value.metrics);
  stringArray(value.extensionCommands, 2_000, 256, "Worker extension commands");
  return value as unknown as AgentWorkerState;
}

function parseAgentInvokeContext(raw: unknown): AgentInvokeContext {
  const value = record(raw, "Worker Agent invoke context");
  if (value.type === "command" || value.type === "force_queue" || value.type === "host_queue") {
    exactKeys(value, ["type", "attachments"], "Worker Agent invoke context");
    if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 32)) throw new Error("Worker attachments must be a bounded array");
    const attachments = value.attachments === undefined
      ? undefined
      : (value.attachments as unknown[]).map((item, index) => parseWorkerAttachmentDto(item, `Worker attachments[${index}]`));
    if (attachments !== undefined && (attachments.length === 0 || new Set(attachments.map((attachment) => attachment.fileId)).size !== attachments.length)) throw new Error("Worker attachments must be nonempty and unique");
    if (value.type === "command") {
      if (attachments === undefined) throw new Error("Worker command context requires attachments");
      return { type: "command", attachments };
    }
    if (value.type === "force_queue") return { type: "force_queue", ...(attachments === undefined ? {} : { attachments }) };
    return { type: "host_queue", ...(attachments === undefined ? {} : { attachments }) };
  }
  exactKeys(value, ["type", "canonicalCwd", "projectTrusted"], "Worker Agent invoke context");
  if (value.type !== "session_switch" || typeof value.projectTrusted !== "boolean") throw new Error("Worker Agent invoke context is invalid");
  const canonicalCwd = boundedString(value.canonicalCwd, 16_384, "Canonical session cwd");
  if (!canonicalCwd.startsWith("/")) throw new Error("Canonical session cwd must be absolute");
  return { type: "session_switch", canonicalCwd, projectTrusted: value.projectTrusted };
}

function parseAgentWorkerControl(raw: unknown): AgentWorkerControl {
  const value = record(raw, "Worker Agent control");
  const type = oneOf(value.type, ["activate", "resolve_session_target", "wait_for_idle", "observation_delivery", "dispose"], "Worker Agent control type");
  if (type === "resolve_session_target") { exactKeys(value, ["type", "sessionFile"], "Worker Agent control"); return { type, sessionFile: boundedString(value.sessionFile, 16_384, "Session file") }; }
  if (type === "observation_delivery") { exactKeys(value, ["type", "notification"], "Worker Agent control"); return { type, notification: parseObservationNotification(value.notification) }; }
  exactKeys(value, ["type"], "Worker Agent control"); return { type };
}

function isAgentRequest(type: string): type is AgentRequest["type"] {
  return ["command.submit", "command.abort", "queue.dequeue", "model.list", "model.set", "thinking.set", "tool.list", "tool.set_active", "settings.get", "settings.update", "resource.get", "command.catalog", "session.history", "conversation.history", "conversation.content", "file.read", "session.list", "session.switch", "session.new", "session.name", "session.compact", "session.reload", "session.tree", "session.navigate", "session.fork", "session.clone"].includes(type);
}

function parseCapability(raw: unknown): WorkerCapability {
  return oneOf(raw, [
    "ui.select", "ui.confirm", "ui.input", "ui.editor", "ui.notify", "ui.setTitle", "ui.setEditorText", "ui.setStatus", "ui.setWidget", "ui.widgetError", "ui.unsupported", "ui.setToolsExpanded", "ui.cancel", "ui.viewport", "ui.reset", "ui.generationBegin",
    "dock.identity", "dock.tools.configure", "dock.tools", "dock.attachments",
  ] as const, "Worker capability");
}

function parseAttachmentAccessRequest(raw: unknown): { type: "list" } | { type: "resolve"; fileId: string } {
  const value = record(raw, "Attachment access request");
  if (value.type === "list") { exactKeys(value, ["type"], "Attachment access request"); return { type: "list" }; }
  exactKeys(value, ["type", "fileId"], "Attachment access request");
  if (value.type !== "resolve") throw new Error("Attachment access request type is invalid");
  return { type: "resolve", fileId: boundedString(value.fileId, 128, "Attachment file ID") };
}

function parseAttachmentAccessResult(raw: unknown): unknown {
  const value = record(raw, "Attachment access result");
  if (value.type === "list") {
    exactKeys(value, ["type", "attachments", "total", "truncated"], "Attachment list result");
    if (!Array.isArray(value.attachments) || value.attachments.length > 200) throw new Error("Attachment list result is too large");
    const attachments = value.attachments.map((item, index) => parseWorkerAttachmentDto(item, `Attachment list[${index}]`));
    if (new Set(attachments.map((attachment) => attachment.fileId)).size !== attachments.length) throw new Error("Attachment list contains duplicate file IDs");
    const total = nonNegativeInteger(value.total, "Attachment list total");
    if (total < attachments.length || (value.truncated !== (total > attachments.length))) throw new Error("Attachment list completeness is invalid");
    return { type: "list", attachments, total, truncated: value.truncated };
  }
  exactKeys(value, ["type", "attachment", "path"], "Attachment resolve result");
  if (value.type !== "resolve") throw new Error("Attachment access result type is invalid");
  const path = boundedString(value.path, 16_384, "Attachment resolved path");
  if (!path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw new Error("Attachment resolved path must be absolute and control-free");
  return { type: "resolve", attachment: parseWorkerAttachmentDto(value.attachment, "Resolved attachment"), path };
}

function parseWorkerAttachmentDto(raw: unknown, label: string): ReturnType<typeof parseAttachmentDto> {
  const value = record(raw, label);
  exactKeys(value, ["fileId", "name", "sizeBytes", "mediaType", "sha256", "storedAt"], label);
  return parseAttachmentDto(value, label);
}

function parseDockToolsRequest(raw: unknown): DockToolsRequest {
  const value = record(raw, "Dock tools request");
  if (["list", "inspect", "watch", "cancel"].includes(String(value.type))) return parseObservationRequest(value);
  if (value.type === "create") {
    exactKeys(value, ["type", "operationId", "cwd", "name"], "Dock create request");
    const cwd = boundedString(value.cwd, MAX_DOCK_TOOL_CWD_CHARS, "Dock create cwd");
    if (!cwd.startsWith("/")) throw new Error("Dock create cwd must be absolute");
    const name = value.name === undefined ? undefined : boundedString(value.name, MAX_DOCK_TOOL_NAME_CHARS, "Dock create name");
    return {
      type: "create",
      operationId: boundedString(value.operationId, 128, "Dock create operation ID"),
      cwd,
      ...(name === undefined ? {} : { name }),
    };
  }
  exactKeys(value, ["type", "operationId", "target", "message"], "Dock send request");
  if (value.type !== "send") throw new Error("Dock tools request type is invalid");
  return {
    type: "send",
    operationId: boundedString(value.operationId, 128, "Dock send operation ID"),
    target: boundedString(value.target, MAX_DOCK_TOOL_TARGET_CHARS, "Dock send target"),
    message: boundedString(value.message, MAX_DOCK_TOOL_MESSAGE_CHARS, "Dock send message"),
  };
}

function parseObservationRequest(raw: unknown): ObservationRequest {
  const value = record(raw, "Observation request");
  const type = oneOf(value.type, ["list", "inspect", "watch", "cancel"] as const, "Observation request type");
  if (type === "list") {
    exactKeys(value, ["type", "includeHistory"], "Observation request");
    if (value.includeHistory !== undefined && typeof value.includeHistory !== "boolean") throw new Error("Observation history selection must be boolean");
    return { type, ...(value.includeHistory === undefined ? {} : { includeHistory: value.includeHistory }) };
  }
  if (type === "cancel") {
    exactKeys(value, ["type", "watchId"], "Observation request");
    const watchId = optionalString(value.watchId, 128);
    return { type, ...(watchId === undefined ? {} : { watchId }) };
  }
  const target = boundedString(value.target, MAX_DOCK_TOOL_TARGET_CHARS, "Observation target");
  if (type === "watch") { exactKeys(value, ["type", "target"], "Observation request"); return { type, target }; }
  exactKeys(value, ["type", "target", "limit", "types", "cursor"], "Observation request");
  let limit: number | undefined;
  if (value.limit !== undefined) {
    limit = positiveInteger(value.limit, "Observation message limit");
    if (limit > MAX_OBSERVATION_MESSAGE_LIMIT) throw new Error("Observation message limit exceeds the supported bound");
  }
  let types: ObservationMessageType[] | undefined;
  if (value.types !== undefined) {
    if (!Array.isArray(value.types) || value.types.length < 1 || value.types.length > 3) throw new Error("Observation message types are invalid");
    types = value.types.map((item) => oneOf(item, ["user", "assistant", "other"] as const, "Observation message type"));
    if (new Set(types).size !== types.length) throw new Error("Observation message types must be unique");
  }
  const cursor = optionalString(value.cursor, MAX_OBSERVATION_CURSOR_CHARS);
  return { type, target, ...(limit === undefined ? {} : { limit }), ...(types === undefined ? {} : { types }), ...(cursor === undefined ? {} : { cursor }) };
}

function parseDockToolsResult(raw: unknown): void {
  const value = record(raw, "Dock tools result");
  if (["list", "inspect", "watch", "cancel"].includes(String(value.type))) {
    parseObservationResult(value);
    return;
  }
  if (value.type === "create") {
    exactKeys(value, ["type", "instance"], "Dock create result");
    validateObservedStatus(value.instance);
    return;
  }
  exactKeys(value, ["type", "target", "receipt"], "Dock send result");
  if (value.type !== "send") throw new Error("Dock tools result type is invalid");
  validateObservedStatus(value.target);
  const receipt = record(value.receipt, "Dock send receipt");
  exactKeys(receipt, ["delivery", "queued", "acceptedAt"], "Dock send receipt");
  oneOf(receipt.delivery, ["prompt", "steer", "followUp"], "Dock send delivery");
  if (typeof receipt.queued !== "boolean") throw new Error("Dock send queued flag is invalid");
  timestampString(receipt.acceptedAt, "Dock send acceptance time");
}

function parseObservationResult(raw: unknown): void {
  const value = record(raw, "Observation result");
  const type = oneOf(value.type, ["list", "inspect", "watch", "cancel"] as const, "Observation result type");
  if (type === "list") { exactKeys(value, ["type", "result"], "Observation result"); validateObservationList(value.result); return; }
  if (type === "inspect") { exactKeys(value, ["type", "result"], "Observation result"); validateObservation(value.result); return; }
  if (type === "cancel") {
    exactKeys(value, ["type", "cancelledWatchIds"], "Observation result");
    stringArray(value.cancelledWatchIds, 10_000, 128, "Cancelled observation watches"); return;
  }
  exactKeys(value, ["type", "status", "receipt", "completion"], "Observation result");
  const status = oneOf(value.status, ["watching", "completed"] as const, "Observation watch status");
  if (status === "watching") { if (value.completion !== undefined) throw new Error("Watching result cannot contain completion"); validateWatchReceipt(value.receipt); }
  else { if (value.receipt !== undefined) throw new Error("Completed result cannot contain receipt"); parseObservationNotification(value.completion); }
}

function validateObservationList(raw: unknown): void {
  const value = record(raw, "Observation list"); exactKeys(value, ["trust", "observedAt", "instances", "total", "truncated", "includesHistory"], "Observation list");
  if (value.trust !== CROSS_INSTANCE_TRUST) throw new Error("Observation trust marker is invalid"); timestampString(value.observedAt, "Observation timestamp");
  if (!Array.isArray(value.instances) || value.instances.length > MAX_OBSERVATION_LIST_ITEMS) throw new Error("Observation instances are invalid");
  for (const item of value.instances) validateObservedStatus(item);
  nonNegativeInteger(value.total, "Observation instance total");
  if (typeof value.truncated !== "boolean" || value.truncated !== (value.instances.length < (value.total as number))) throw new Error("Observation list truncation is invalid");
  if (typeof value.includesHistory !== "boolean") throw new Error("Observation history selection is invalid");
}

function validateObservation(raw: unknown): void {
  const value = record(raw, "Instance observation"); exactKeys(value, ["trust", "observedAt", "status", "conversation"], "Instance observation");
  if (value.trust !== CROSS_INSTANCE_TRUST) throw new Error("Observation trust marker is invalid"); timestampString(value.observedAt, "Observation timestamp"); validateObservedStatus(value.status);
  if (value.conversation !== undefined) {
    const conversation = record(value.conversation, "Observation conversation"); exactKeys(conversation, ["messages", "hasEarlier", "nextCursor", "truncated"], "Observation conversation");
    if (!Array.isArray(conversation.messages) || conversation.messages.length > MAX_OBSERVATION_MESSAGE_LIMIT) throw new Error("Observation messages are invalid");
    let anyTruncated = false;
    for (const item of conversation.messages) {
      const message = record(item, "Observation message"); exactKeys(message, ["type", "text", "timestamp", "truncated"], "Observation message");
      oneOf(message.type, ["user", "assistant", "other"] as const, "Observation message type");
      boundedString(message.text, MAX_OBSERVATION_MESSAGE_TEXT_CHARS + 32, "Observation message text");
      if (message.timestamp !== undefined) timestampString(message.timestamp, "Observation message timestamp");
      if (typeof message.truncated !== "boolean") throw new Error("Observation message truncation is invalid");
      anyTruncated ||= message.truncated;
    }
    if (typeof conversation.hasEarlier !== "boolean") throw new Error("Observation pagination state is invalid");
    const nextCursor = optionalString(conversation.nextCursor, MAX_OBSERVATION_CURSOR_CHARS);
    if (conversation.hasEarlier !== (nextCursor !== undefined)) throw new Error("Observation pagination cursor is inconsistent");
    if (typeof conversation.truncated !== "boolean" || conversation.truncated !== anyTruncated) throw new Error("Observation conversation truncation is inconsistent");
  }
}

function validateObservedStatus(raw: unknown): void {
  const value = record(raw, "Observed instance status"); exactKeys(value, ["id", "key", "name", "cwd", "lifecycle", "execution", "compacting", "executionChangedAt", "runStartedAt", "runtimeGeneration", "lastError"], "Observed instance status");
  boundedString(value.id, 128, "Observed instance ID"); optionalString(value.key, 128); optionalString(value.name, 256); boundedString(value.cwd, 16_384, "Observed workspace");
  oneOf(value.lifecycle, ["active", "stopping", "stopped", "host_lost", "runtime_error"], "Observed lifecycle"); oneOf(value.execution, ["idle", "running", "failed", "unavailable"], "Observed execution");
  if (typeof value.compacting !== "boolean") throw new Error("Observed compacting state is invalid");
  timestampString(value.executionChangedAt, "Observed execution timestamp"); if (value.runStartedAt !== undefined) timestampString(value.runStartedAt, "Observed run timestamp"); positiveInteger(value.runtimeGeneration, "Observed generation"); optionalString(value.lastError, 2_000);
}

function validateWatchReceipt(raw: unknown): void {
  const value = record(raw, "Observation watch receipt"); exactKeys(value, ["watchId", "target", "registeredAt"], "Observation watch receipt");
  boundedString(value.watchId, 128, "Observation watch ID"); validateObservedStatus(value.target); timestampString(value.registeredAt, "Observation registration timestamp");
}

function parseObservationNotification(raw: unknown): ObservationNotification {
  const value = record(raw, "Observation notification"); exactKeys(value, ["trust", "notice", "watchId", "firedAt", "reason", "target"], "Observation notification");
  if (value.trust !== CROSS_INSTANCE_TRUST || value.notice !== OBSERVATION_DATA_NOTICE) throw new Error("Observation notification trust marker is invalid");
  const watchId = boundedString(value.watchId, 128, "Observation watch ID"); const firedAt = timestampString(value.firedAt, "Observation fired timestamp");
  const reason = oneOf(value.reason, ["idle", "stopped", "host_lost", "runtime_error", "execution_failed", "execution_unavailable"] as const, "Observation terminal reason");
  validateObservedStatus(value.target);
  return { trust: CROSS_INSTANCE_TRUST, notice: OBSERVATION_DATA_NOTICE, watchId, firedAt, reason, target: value.target as ObservationNotification["target"] };
}

function timestampString(raw: unknown, label: string): string {
  const value = boundedString(raw, 128, label); if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`); return value;
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
  if (controls.test(value)) throw new Error(`${label} must be control-safe`);
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
