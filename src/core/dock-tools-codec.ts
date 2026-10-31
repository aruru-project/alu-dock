import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS, parseControlRequest, parseModelsResult, parseModelRef, parseResourceContentResult, parseSystemCatalogResult } from "../control/protocol.js";
import {
  MAX_DOCK_TOOL_CWD_CHARS,
  MAX_DOCK_TOOL_MESSAGE_CHARS,
  MAX_DOCK_TOOL_NAME_CHARS,
  MAX_DOCK_TOOL_TARGET_CHARS,
  type DockToolsRequest,
} from "./dock-tools.js";
import { parseDeliverableDto } from "./instance-deliverables.js";
import {
  CROSS_INSTANCE_TRUST,
  MAX_OBSERVATION_CURSOR_CHARS,
  MAX_OBSERVATION_LIST_ITEMS,
  MAX_OBSERVATION_MESSAGE_LIMIT,
  OBSERVATION_DATA_NOTICE,
  type ObservationMessageType,
  type ObservationNotification,
  type ObservationRequest,
} from "./instance-observation.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "./source-file.js";
import { THINKING_LEVELS } from "./agent-worker.js";
import { isPortableAbsoluteLocalPath, isPortableLocalRootPath } from "./local-path.js";
import { MACHINE_PLATFORMS, type MachinePlatform } from "./machine-dto.js";

/** Canonical Agent-neutral validation for Dock-tools transport records. */
export function parseDockToolsRequest(raw: unknown): DockToolsRequest {
  const value = record(raw, "Dock tools request");
  if (["list", "inspect", "watch", "cancel"].includes(String(value.type))) return parseObservationRequest(value);
  if (value.type === "models") { exactKeys(value, ["type"], "Model catalog request"); return { type: "models" }; }
  if (value.type === "interrupt" || value.type === "stop") {
    exactKeys(value, ["type", "operationId", "target"], "Worker control request");
    return { type: value.type, operationId: boundedString(value.operationId, 128, "Operation ID"), target: boundedString(value.target, MAX_DOCK_TOOL_TARGET_CHARS, "Target") };
  }
  if (value.type === "spawn") {
    exactKeys(value, ["type", "operationId", "task", "name", "cwd", "model", "thinkingLevel", "allowedTools"], "Spawn request");
    const cwd = value.cwd === undefined ? undefined : boundedString(value.cwd, MAX_DOCK_TOOL_CWD_CHARS, "Working directory");
    if (cwd !== undefined && !isPortableAbsoluteLocalPath(cwd)) throw new Error("Working directory must be absolute");
    return {
      type: "spawn", operationId: boundedString(value.operationId, 128, "Operation ID"),
      task: boundedString(value.task, MAX_DOCK_TOOL_MESSAGE_CHARS, "Task"),
      name: boundedString(value.name, MAX_DOCK_TOOL_NAME_CHARS, "Worker name"),
      ...(cwd === undefined ? {} : { cwd }),
      ...(value.model === undefined ? {} : { model: parseModelRef(value.model, "Worker model", "invalid_request") }),
      ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: oneOf(value.thinkingLevel, THINKING_LEVELS, "Thinking level") }),
      ...(value.allowedTools === undefined ? {} : { allowedTools: stringArray(value.allowedTools, 1000, 256, "Allowed tools") }),
    };
  }
  if (value.type === "machines") { exactKeys(value, ["type"], "Dock Machines request"); return { type: "machines" }; }
  if (value.type === "deliver") {
    exactKeys(value, ["type", "path"], "Dock deliver request");
    const path = boundedString(value.path, MAX_SOURCE_FILE_PATH_CHARS, "Dock deliver path");
    if (!isPortableAbsoluteLocalPath(path)) throw new Error("Dock deliver path must be absolute");
    return { type: "deliver", path };
  }
  if (value.type === "system") {
    exactKeys(value, ["type", "cwd", "machine", "id", "cursor", "offset", "revision"], "Dock system request");
    const { type: _type, machine: _machine, ...params } = value;
    const parsed = parseControlRequest({ kind: "request", version: 2, type: value.id === undefined ? "system.catalog" : "system.content", requestId: "dock-system", params });
    if (parsed.type !== "system.catalog" && parsed.type !== "system.content") throw new Error("Invalid system request");
    const machine = value.machine === undefined ? undefined : boundedString(value.machine, MAX_DOCK_TOOL_TARGET_CHARS, "Dock system Machine");
    const { hostId: _hostId, ...input } = parsed.params;
    // limit is controlled by the canonical producer, not an Agent-editable tuning option.
    if ("limit" in input) delete (input as { limit?: number }).limit;
    return { type: "system", ...input, ...(machine === undefined ? {} : { machine }) };
  }
  if (value.type === "create") {
    exactKeys(value, ["type", "operationId", "cwd", "name", "machine", "systemId", "saveDefault", "model", "allowedTools"], "Dock create request");
    const cwd = boundedString(value.cwd, MAX_DOCK_TOOL_CWD_CHARS, "Dock create cwd");
    if (!isPortableAbsoluteLocalPath(cwd)) throw new Error("Dock create cwd must be absolute");
    const name = value.name === undefined ? undefined : boundedString(value.name, MAX_DOCK_TOOL_NAME_CHARS, "Dock create name");
    const machine = value.machine === undefined ? undefined : boundedString(value.machine, MAX_DOCK_TOOL_TARGET_CHARS, "Dock create Machine name");
    const systemId = value.systemId === undefined ? undefined : boundedString(value.systemId, 128, "Dock system selection");
    if (value.saveDefault !== undefined && typeof value.saveDefault !== "boolean") throw new Error("saveDefault must be boolean");
    if (value.saveDefault === true && systemId === undefined) throw new Error("Saving a directory default requires an explicit systemId");
    const model = value.model === undefined ? undefined : parseModelRef(value.model, "Dock create model", "invalid_request");
    return {
      type: "create",
      ...(value.allowedTools === undefined ? {} : { allowedTools: stringArray(value.allowedTools, 1000, 256, "Allowed tools") }),
      ...(systemId === undefined ? {} : { systemId }),
      ...(value.saveDefault === undefined ? {} : { saveDefault: value.saveDefault }),
      ...(model === undefined ? {} : { model }),
      operationId: boundedString(value.operationId, 128, "Dock create operation ID"),
      cwd,
      ...(name === undefined ? {} : { name }),
      ...(machine === undefined ? {} : { machine }),
    };
  }
  exactKeys(value, ["type", "operationId", "target", "message", "delivery"], "Dock send request");
  if (value.type !== "send") throw new Error("Dock tools request type is invalid");
  return {
    type: "send",
    operationId: boundedString(value.operationId, 128, "Dock send operation ID"),
    target: boundedString(value.target, MAX_DOCK_TOOL_TARGET_CHARS, "Dock send target"),
    message: boundedString(value.message, MAX_DOCK_TOOL_MESSAGE_CHARS, "Dock send message"),
    ...(value.delivery === undefined ? {} : { delivery: oneOf(value.delivery, ["followUp", "steer"] as const, "Message delivery") }),
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

export function parseDockToolsResult(raw: unknown): void {
  const value = record(raw, "Dock tools result");
  if (["list", "inspect", "watch", "cancel"].includes(String(value.type))) {
    parseObservationResult(value);
    return;
  }
  if (value.type === "models") { exactKeys(value, ["type", "result"], "Model catalog result"); parseModelsResult(value.result); return; }
  if (value.type === "spawn") {
    exactKeys(value, ["type", "instance", "taskStatus", "watchStatus", "error"], "Spawn result");
    validateObservedStatus(value.instance);
    oneOf(value.taskStatus, ["accepted", "failed"] as const, "Task status");
    if (value.watchStatus !== undefined) oneOf(value.watchStatus, ["watching", "completed", "failed"] as const, "Watch status");
    if (value.error !== undefined && typeof value.error !== "string") throw new Error("Spawn error must be text");
    return;
  }
  if (value.type === "interrupt" || value.type === "stop") { exactKeys(value, ["type", "instance"], "Worker control result"); validateObservedStatus(value.instance); return; }
  if (value.type === "system_catalog") {
    exactKeys(value, ["type", "result"], "Dock system catalog result");
    parseSystemCatalogResult(value.result); return;
  }
  if (value.type === "system_content") {
    exactKeys(value, ["type", "result"], "Dock system content result");
    parseResourceContentResult(value.result); return;
  }
  if (value.type === "machines") {
    exactKeys(value, ["type", "machines"], "Dock Machines result");
    if (!Array.isArray(value.machines) || value.machines.length < 1) throw new Error("Dock Machines result is invalid");
    for (const machine of value.machines) validateMachine(machine);
    return;
  }
  if (value.type === "deliver") {
    exactKeys(value, ["type", "deliverable"], "Dock deliver result");
    parseDeliverableDto(value.deliverable, "Dock deliverable");
    return;
  }
  if (value.type === "create") {
    exactKeys(value, ["type", "instance", "defaultSaved"], "Dock create result");
    if (value.defaultSaved !== undefined && typeof value.defaultSaved !== "boolean") throw new Error("Invalid defaultSaved");
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
  const total = nonNegativeInteger(value.total, "Observation instance total");
  if (typeof value.truncated !== "boolean" || value.truncated !== (value.instances.length < total)) throw new Error("Observation list truncation is invalid");
  if (typeof value.includesHistory !== "boolean") throw new Error("Observation history selection is invalid");
}

function validateObservation(raw: unknown): void {
  const value = record(raw, "Instance observation"); exactKeys(value, ["trust", "observedAt", "status", "conversation"], "Instance observation");
  if (value.trust !== CROSS_INSTANCE_TRUST) throw new Error("Observation trust marker is invalid"); timestampString(value.observedAt, "Observation timestamp"); validateObservedStatus(value.status);
  if (value.conversation !== undefined) {
    const conversation = record(value.conversation, "Observation conversation"); exactKeys(conversation, ["messages", "hasEarlier", "nextCursor"], "Observation conversation");
    if (!Array.isArray(conversation.messages) || conversation.messages.length > MAX_OBSERVATION_MESSAGE_LIMIT) throw new Error("Observation messages are invalid");
    for (const item of conversation.messages) {
      const message = record(item, "Observation message"); exactKeys(message, ["type", "text", "timestamp"], "Observation message");
      oneOf(message.type, ["user", "assistant", "other"] as const, "Observation message type");
      if (typeof message.text !== "string" || message.text.length < 1) throw new Error("Observation message text is invalid");
      if (message.timestamp !== undefined) timestampString(message.timestamp, "Observation message timestamp");
    }
    if (typeof conversation.hasEarlier !== "boolean") throw new Error("Observation pagination state is invalid");
    const nextCursor = optionalString(conversation.nextCursor, MAX_OBSERVATION_CURSOR_CHARS);
    if (conversation.hasEarlier !== (nextCursor !== undefined)) throw new Error("Observation pagination cursor is inconsistent");
  }
}

function validateMachine(raw: unknown): void {
  const value = record(raw, "Dock Machine");
  exactKeys(value, ["hostId", "name", "kind", "available", "platform", "homePath", "workspaceRoots"], "Dock Machine");
  boundedString(value.hostId, 128, "Dock Machine ID");
  boundedString(value.name, MAX_DOCK_TOOL_TARGET_CHARS, "Dock Machine name");
  oneOf(value.kind, ["main", "subhost"] as const, "Dock Machine kind");
  if (typeof value.available !== "boolean") throw new Error("Dock Machine availability is invalid");
  const platform = value.platform === undefined ? undefined : oneOf(value.platform, MACHINE_PLATFORMS, "Dock Machine platform");
  if (value.homePath !== undefined && !isPortableAbsoluteLocalPath(boundedString(value.homePath, MAX_DOCK_TOOL_CWD_CHARS, "Dock Machine Home"))) throw new Error("Dock Machine Home must be absolute");
  if (value.workspaceRoots !== undefined) {
    if (!platform || !Array.isArray(value.workspaceRoots) || value.workspaceRoots.length < 1) throw new Error("Dock Machine roots are invalid");
    const roots = value.workspaceRoots.map((root) => boundedString(root, MAX_DOCK_TOOL_CWD_CHARS, "Dock Machine root"));
    if (roots.some((root) => !isPortableLocalRootPath(root, platform as MachinePlatform))) throw new Error("Dock Machine roots are invalid");
  }
}

/**
 * A SubHost reads this status from Main, which may be a newer version. Fields it does not know are
 * ignored rather than rejected: a rejected Machine record drops the whole Main connection.
 */
function validateObservedStatus(raw: unknown): void {
  const value = record(raw, "Observed instance status");
  boundedString(value.id, 128, "Observed instance ID"); optionalString(value.parentId, 128); optionalString(value.key, 128); optionalString(value.name, 256); boundedString(value.cwd, 16_384, "Observed workspace");
  oneOf(value.lifecycle, ["active", "stopping", "stopped", "host_lost", "runtime_error"], "Observed lifecycle"); oneOf(value.execution, ["idle", "running", "failed", "unavailable"], "Observed execution");
  if (typeof value.compacting !== "boolean") throw new Error("Observed compacting state is invalid");
  timestampString(value.executionChangedAt, "Observed execution timestamp"); if (value.runStartedAt !== undefined) timestampString(value.runStartedAt, "Observed run timestamp"); positiveInteger(value.runtimeGeneration, "Observed generation"); optionalString(value.lastError, 2_000);
  if (value.model !== undefined) {
    const model = record(value.model, "Observed model");
    boundedString(model.provider, MAX_MODEL_PROVIDER_CHARS, "Observed model provider"); boundedString(model.id, MAX_MODEL_ID_CHARS, "Observed model ID");
  }
  if (value.thinkingLevel !== undefined) oneOf(value.thinkingLevel, THINKING_LEVELS, "Observed thinking level");
}

function validateWatchReceipt(raw: unknown): void {
  const value = record(raw, "Observation watch receipt"); exactKeys(value, ["watchId", "target", "registeredAt"], "Observation watch receipt");
  boundedString(value.watchId, 128, "Observation watch ID"); validateObservedStatus(value.target); timestampString(value.registeredAt, "Observation registration timestamp");
}

export function parseObservationNotification(raw: unknown): ObservationNotification {
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
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}
function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error(`${label} must be an object`);
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
function positiveInteger(raw: unknown, label: string): number { if (!Number.isSafeInteger(raw) || (raw as number) < 1) throw new Error(`${label} must be a positive integer`); return raw as number; }
function nonNegativeInteger(raw: unknown, label: string): number { if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new Error(`${label} must be a non-negative integer`); return raw as number; }
function stringArray(raw: unknown, maxItems: number, maxChars: number, label: string): string[] {
  if (!Array.isArray(raw) || raw.length > maxItems) throw new Error(`${label} must be a bounded array`);
  return raw.map((item) => boundedString(item, maxChars, label, true));
}
function oneOf<const T extends readonly string[]>(raw: unknown, values: T, label: string): T[number] {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) throw new Error(`${label} is invalid`);
  return raw as T[number];
}
