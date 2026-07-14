import type {
  CommandReceipt,
  DeliveryMode,
  DockEvent,
  EventPage,
  ExecutorIdentity,
  InstanceSnapshot,
  StopReceipt,
} from "../core/managed-instance.js";

export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
export const MAX_CONTROL_REQUEST_ID_CHARS = 128;
export const MAX_INSTANCE_ID_CHARS = 128;
export const MAX_INSTANCE_NAME_CHARS = 256;
export const MAX_CONTROL_CWD_CHARS = 16_384;
export const MAX_PROMPT_CHARS = 256_000;

export type ControlRequest =
  | { version: 1; requestId: string; type: "ping" }
  | { version: 1; requestId: string; type: "create"; cwd: string; name?: string }
  | { version: 1; requestId: string; type: "list" }
  | { version: 1; requestId: string; type: "status"; instanceId: string }
  | {
      version: 1;
      requestId: string;
      type: "events";
      instanceId: string;
      since?: number;
      follow?: boolean;
    }
  | {
      version: 1;
      requestId: string;
      type: "prompt";
      instanceId: string;
      message: string;
      delivery?: DeliveryMode;
    }
  | { version: 1; requestId: string; type: "stop"; instanceId: string };

export interface ControlError {
  code: string;
  message: string;
}

export type ControlResponse =
  | {
      kind: "response";
      version: 1;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: "response";
      version: 1;
      requestId: string;
      ok: false;
      error: ControlError;
    };

export interface ControlEventEnvelope {
  kind: "event";
  version: 1;
  requestId: string;
  event: DockEvent;
}

export interface PingResult {
  pid: number;
  protocolVersion: number;
}

export interface CreateResult {
  instance: InstanceSnapshot;
}

export interface ListResult {
  instances: InstanceSnapshot[];
}

export interface StatusResult {
  instance: InstanceSnapshot;
}

export interface EventsResult {
  instance: InstanceSnapshot;
  page: EventPage;
  following: boolean;
}

export interface PromptResult {
  receipt: CommandReceipt;
  instance: InstanceSnapshot;
}

export interface StopResult {
  receipt: StopReceipt;
  instance: InstanceSnapshot;
}

export function parseControlRequest(input: unknown): ControlRequest {
  const value = objectValue(input, "request", "invalid_request");
  const version = value.version;
  if (version !== CONTROL_PROTOCOL_VERSION) {
    throw new ProtocolValidationError("unsupported_version", `Expected protocol version 1, got ${String(version)}`);
  }
  const requestId = requiredString(value.requestId, "requestId", MAX_CONTROL_REQUEST_ID_CHARS);
  const type = requiredString(value.type, "type", 32);

  switch (type) {
    case "ping":
      assertOnlyKeys(value, ["version", "requestId", "type"]);
      return { version: 1, requestId, type };
    case "create": {
      assertOnlyKeys(value, ["version", "requestId", "type", "cwd", "name"]);
      const name = optionalString(value.name, "name", MAX_INSTANCE_NAME_CHARS);
      return {
        version: 1,
        requestId,
        type,
        cwd: requiredString(value.cwd, "cwd", MAX_CONTROL_CWD_CHARS),
        name,
      };
    }
    case "list":
      assertOnlyKeys(value, ["version", "requestId", "type"]);
      return { version: 1, requestId, type };
    case "status":
      assertOnlyKeys(value, ["version", "requestId", "type", "instanceId"]);
      return {
        version: 1,
        requestId,
        type,
        instanceId: requiredString(value.instanceId, "instanceId", MAX_INSTANCE_ID_CHARS),
      };
    case "events": {
      assertOnlyKeys(value, ["version", "requestId", "type", "instanceId", "since", "follow"]);
      const since = optionalNonNegativeInteger(value.since, "since");
      const follow = optionalBoolean(value.follow, "follow");
      return {
        version: 1,
        requestId,
        type,
        instanceId: requiredString(value.instanceId, "instanceId", MAX_INSTANCE_ID_CHARS),
        since,
        follow,
      };
    }
    case "prompt": {
      assertOnlyKeys(value, ["version", "requestId", "type", "instanceId", "message", "delivery"]);
      const delivery = optionalEnumString(
        value.delivery,
        "delivery",
        ["auto", "prompt", "steer", "followUp"] as const,
      );
      return {
        version: 1,
        requestId,
        type,
        instanceId: requiredString(value.instanceId, "instanceId", MAX_INSTANCE_ID_CHARS),
        message: requiredString(value.message, "message", MAX_PROMPT_CHARS),
        delivery,
      };
    }
    case "stop":
      assertOnlyKeys(value, ["version", "requestId", "type", "instanceId"]);
      return {
        version: 1,
        requestId,
        type,
        instanceId: requiredString(value.instanceId, "instanceId", MAX_INSTANCE_ID_CHARS),
      };
    default:
      throw new ProtocolValidationError("unknown_request", `Unknown request type: ${type}`);
  }
}

export function parseControlResponse(input: unknown, expectedRequestId: string): ControlResponse {
  const value = objectValue(input, "response");
  requireEnvelopeHeader(value, "response", expectedRequestId);
  if (typeof value.ok !== "boolean") {
    throw new ProtocolValidationError("invalid_response", "response.ok must be a boolean");
  }
  if (value.ok) {
    if (!Object.hasOwn(value, "result")) {
      throw new ProtocolValidationError("invalid_response", "successful response must contain result");
    }
    return {
      kind: "response",
      version: 1,
      requestId: expectedRequestId,
      ok: true,
      result: value.result,
    };
  }

  const error = objectValue(value.error, "response.error");
  return {
    kind: "response",
    version: 1,
    requestId: expectedRequestId,
    ok: false,
    error: {
      code: requiredString(error.code, "response.error.code"),
      message: requiredString(error.message, "response.error.message"),
    },
  };
}

export function parseControlEventEnvelope(input: unknown, expectedRequestId: string): ControlEventEnvelope {
  const value = objectValue(input, "event envelope");
  requireEnvelopeHeader(value, "event", expectedRequestId);
  return {
    kind: "event",
    version: 1,
    requestId: expectedRequestId,
    event: parseDockEvent(value.event, "event"),
  };
}

export function parsePingResult(input: unknown): PingResult {
  const value = objectValue(input, "ping result");
  return {
    pid: requiredNonNegativeInteger(value.pid, "ping result.pid"),
    protocolVersion: requiredNonNegativeInteger(value.protocolVersion, "ping result.protocolVersion"),
  };
}

export function parseCreateResult(input: unknown): CreateResult {
  const value = objectValue(input, "create result");
  return { instance: parseInstanceSnapshot(value.instance, "create result.instance") };
}

export function parseListResult(input: unknown): ListResult {
  const value = objectValue(input, "list result");
  if (!Array.isArray(value.instances)) {
    throw new ProtocolValidationError("invalid_response", "list result.instances must be an array");
  }
  return {
    instances: value.instances.map((instance, index) => parseInstanceSnapshot(instance, `list result.instances[${index}]`)),
  };
}

export function parseStatusResult(input: unknown): StatusResult {
  const value = objectValue(input, "status result");
  return { instance: parseInstanceSnapshot(value.instance, "status result.instance") };
}

export function parseEventsResult(input: unknown): EventsResult {
  const value = objectValue(input, "events result");
  return {
    instance: parseInstanceSnapshot(value.instance, "events result.instance"),
    page: parseEventPage(value.page, "events result.page"),
    following: requiredBoolean(value.following, "events result.following"),
  };
}

export function parsePromptResult(input: unknown): PromptResult {
  const value = objectValue(input, "prompt result");
  const receipt = parseCommandReceipt(value.receipt, "prompt result.receipt");
  const instance = parseInstanceSnapshot(value.instance, "prompt result.instance");
  if (receipt.instanceId !== instance.id) {
    throw new ProtocolValidationError("invalid_response", "prompt receipt and snapshot instance IDs differ");
  }
  return { receipt, instance };
}

export function parseStopResult(input: unknown): StopResult {
  const value = objectValue(input, "stop result");
  const receipt = parseStopReceipt(value.receipt, "stop result.receipt");
  const instance = parseInstanceSnapshot(value.instance, "stop result.instance");
  if (receipt.instanceId !== instance.id) {
    throw new ProtocolValidationError("invalid_response", "stop receipt and snapshot instance IDs differ");
  }
  return { receipt, instance };
}

export class ProtocolValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

function requireEnvelopeHeader(
  value: Record<string, unknown>,
  kind: "response" | "event",
  expectedRequestId: string,
): void {
  if (value.kind !== kind) {
    throw new ProtocolValidationError("invalid_response", `Expected ${kind} envelope`);
  }
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new ProtocolValidationError("invalid_response", `Unsupported response version: ${String(value.version)}`);
  }
  const requestId = requiredString(value.requestId, `${kind}.requestId`);
  if (requestId !== expectedRequestId) {
    throw new ProtocolValidationError("invalid_response", `Unexpected response requestId: ${requestId}`);
  }
}

function parseCommandReceipt(input: unknown, field: string): CommandReceipt {
  const value = objectValue(input, field);
  if (value.accepted !== true) {
    throw new ProtocolValidationError("invalid_response", `${field}.accepted must be true`);
  }
  return {
    accepted: true,
    instanceId: requiredString(value.instanceId, `${field}.instanceId`),
    commandId: requiredString(value.commandId, `${field}.commandId`),
    delivery: enumString(value.delivery, `${field}.delivery`, ["prompt", "steer", "followUp"]),
    queued: requiredBoolean(value.queued, `${field}.queued`),
    acceptedAt: requiredString(value.acceptedAt, `${field}.acceptedAt`),
  };
}

function parseStopReceipt(input: unknown, field: string): StopReceipt {
  const value = objectValue(input, field);
  if (value.stopped !== true) {
    throw new ProtocolValidationError("invalid_response", `${field}.stopped must be true`);
  }
  const cleanupErrors = optionalStringArray(value.cleanupErrors, `${field}.cleanupErrors`);
  const receipt: StopReceipt = {
    instanceId: requiredString(value.instanceId, `${field}.instanceId`),
    stopped: true,
    alreadyStopped: requiredBoolean(value.alreadyStopped, `${field}.alreadyStopped`),
  };
  if (cleanupErrors) receipt.cleanupErrors = cleanupErrors;
  return receipt;
}

function parseInstanceSnapshot(input: unknown, field: string): InstanceSnapshot {
  const value = objectValue(input, field);
  const pending = objectValue(value.pending, `${field}.pending`);
  const executor = parseExecutor(value.executor, `${field}.executor`);
  const name = optionalString(value.name, `${field}.name`);
  const activeCommandId = optionalString(value.activeCommandId, `${field}.activeCommandId`);
  const lastError = optionalString(value.lastError, `${field}.lastError`);

  return {
    id: requiredString(value.id, `${field}.id`),
    name,
    cwd: requiredString(value.cwd, `${field}.cwd`),
    lifecycle: enumString(value.lifecycle, `${field}.lifecycle`, ["active", "stopping", "stopped"]),
    execution: enumString(value.execution, `${field}.execution`, ["idle", "running", "failed"]),
    lastRun: enumString(value.lastRun, `${field}.lastRun`, ["never", "succeeded", "failed", "aborted"]),
    pending: {
      steering: requiredNonNegativeInteger(pending.steering, `${field}.pending.steering`),
      followUp: requiredNonNegativeInteger(pending.followUp, `${field}.pending.followUp`),
      total: requiredNonNegativeInteger(pending.total, `${field}.pending.total`),
    },
    executor,
    activeCommandId,
    lastError,
    createdAt: requiredString(value.createdAt, `${field}.createdAt`),
    updatedAt: requiredString(value.updatedAt, `${field}.updatedAt`),
    latestEventSequence: requiredNonNegativeInteger(value.latestEventSequence, `${field}.latestEventSequence`),
  };
}

function parseExecutor(input: unknown, field: string): ExecutorIdentity {
  const value = objectValue(input, field);
  const version = optionalString(value.version, `${field}.version`);
  const sessionFile = optionalString(value.sessionFile, `${field}.sessionFile`);
  let model: ExecutorIdentity["model"];
  if (value.model !== undefined) {
    const modelValue = objectValue(value.model, `${field}.model`);
    model = {
      provider: requiredString(modelValue.provider, `${field}.model.provider`),
      id: requiredString(modelValue.id, `${field}.model.id`),
    };
  }
  return {
    kind: requiredString(value.kind, `${field}.kind`),
    version,
    piSessionId: requiredString(value.piSessionId, `${field}.piSessionId`),
    sessionFile,
    model,
  };
}

function parseEventPage(input: unknown, field: string): EventPage {
  const value = objectValue(input, field);
  if (!Array.isArray(value.events)) {
    throw new ProtocolValidationError("invalid_response", `${field}.events must be an array`);
  }
  return {
    events: value.events.map((event, index) => parseDockEvent(event, `${field}.events[${index}]`)),
    earliestSequence: requiredNonNegativeInteger(value.earliestSequence, `${field}.earliestSequence`),
    latestSequence: requiredNonNegativeInteger(value.latestSequence, `${field}.latestSequence`),
    truncated: requiredBoolean(value.truncated, `${field}.truncated`),
  };
}

function parseDockEvent(input: unknown, field: string): DockEvent {
  const value = objectValue(input, field);
  return {
    sequence: requiredNonNegativeInteger(value.sequence, `${field}.sequence`),
    instanceId: requiredString(value.instanceId, `${field}.instanceId`),
    occurredAt: requiredString(value.occurredAt, `${field}.occurredAt`),
    type: requiredString(value.type, `${field}.type`),
    data: objectValue(value.data, `${field}.data`),
  };
}

function objectValue(
  value: unknown,
  field: string,
  code = "invalid_response",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError(code, `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolValidationError("invalid_request", `${field} must be a non-empty string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ProtocolValidationError("invalid_request", `${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength?: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolValidationError("invalid_response", `${field} must be a boolean`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProtocolValidationError("invalid_request", `${field} must be a boolean`);
  }
  return value;
}

function optionalEnumString<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolValidationError("invalid_request", `${field} has an unsupported value`);
  }
  return value as T;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProtocolValidationError("invalid_response", `${field} must be an array of strings`);
  }
  return [...value];
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError("invalid_response", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError("invalid_request", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function enumString<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolValidationError("invalid_response", `${field} has an unsupported value`);
  }
  return value as T;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new ProtocolValidationError("invalid_request", `Unexpected request field: ${unexpected}`);
  }
}
