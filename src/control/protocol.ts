import type {
  CommandReceipt,
  ContentBlockDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  InstanceSnapshot,
  JsonObject,
  JsonValue,
  SessionDto,
} from "../core/managed-instance.js";
import type { RuntimeModelInfo, RuntimeThinkingLevel } from "../core/runtime-session.js";
import { CATALOG_SCHEMA_VERSION, DOCK_VERSION, PI_SDK_VERSION } from "../version.js";

export const CONTROL_PROTOCOL_VERSION = 2 as const;
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
export const MAX_CONTROL_REQUEST_ID_CHARS = 128;
export const MAX_INSTANCE_ID_CHARS = 128;
export const MAX_INSTANCE_NAME_CHARS = 256;
export const MAX_CONTROL_CWD_CHARS = 16_384;
export const MAX_PROMPT_CHARS = 256_000;
export const MAX_MODEL_PROVIDER_CHARS = 256;
export const MAX_MODEL_ID_CHARS = 512;
export const MAX_CAPABILITIES = 128;
export const MAX_CAPABILITY_CHARS = 128;
export const MAX_REPLAY_EVENTS = 1_000;
export const MAX_HISTORY_ITEMS = 200;
const MAX_TEXT = 8_000;
const MAX_MESSAGE = 2_048;
const MAX_COLLECTION = 2_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 100;
const MAX_JSON_ARRAY = 200;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const IMPLEMENTED_CAPABILITIES = [
  "core.v2",
  "events.follow",
  "host.info",
  "instance.catalog",
  "models.v1",
  "session.core",
] as const;
export type Capability = typeof IMPLEMENTED_CAPABILITIES[number];

export interface ClientHello {
  kind: "hello";
  requestId: string;
  versions: number[];
  client: { name: string; version: string; clientId: string };
  requiredCapabilities: string[];
}
export interface HostIdentity {
  pid: number;
  dockVersion: string;
  piSdkVersion: string;
  hostEpoch: string;
  startedAt: string;
}
export interface HelloAck {
  kind: "hello_ack";
  requestId: string;
  version: 2;
  host: HostIdentity;
  catalogSchemaVersion: number;
  capabilities: string[];
  limits: { maxLineBytes: number; maxPromptChars: number; maxReplayEvents: number; maxHistoryItems: number };
}
export type HelloError = {
  kind: "hello_error";
  requestId: string;
  error: {
    code: "invalid_hello" | "unsupported_protocol" | "capability_missing" | "host_starting" | "host_draining";
    message: string;
    hostVersions?: number[];
    missing?: string[];
    retryAfterMs?: number;
  };
};

type Request<T extends string, P> = { kind: "request"; version: 2; requestId: string; type: T; params: P };
export type ControlRequest =
  | Request<"host.info", Record<string, never>>
  | Request<"instance.create", { operationId: string; cwd: string; name?: string }>
  | Request<"instance.list", { includeTerminal?: boolean }>
  | Request<"instance.get", { instanceId: string }>
  | Request<"instance.attach", { instanceId: string; since?: EventCursor; follow: boolean; controller: "claim" | "observe" }>
  | Request<"instance.stop", { operationId: string; instanceId: string }>
  | Request<"command.submit", { operationId: string; instanceId: string; message: string; delivery: DeliveryMode }>
  | Request<"model.list", { instanceId: string }>
  | Request<"model.set", { operationId: string; instanceId: string; provider: string; modelId: string }>
  | Request<"thinking.set", { operationId: string; instanceId: string; level: RuntimeThinkingLevel }>
  | Request<"session.list", { instanceId: string; scope: "cwd" | "all" }>;

export interface ControlError { code: string; message: string; retryable: boolean; details?: JsonObject }
export type ControlResponse =
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: true; result: unknown }
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: false; error: ControlError };
export interface ControlEventEnvelope { kind: "event"; version: 2; requestId: string; hostEpoch: string; event: DockEvent }

export interface HostInfoResult {
  state: "ready";
  host: HostIdentity;
  catalog: { schemaVersion: number; revision: number; lastReconciledAt: string };
  paths: { socket: string; state: string };
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; source?: string }>;
}
export interface PingResult { pid: number; protocolVersion: 2; hostEpoch: string; capabilities: string[] }
export interface CreateResult { instance: InstanceSnapshot }
export interface ListResult { instances: InstanceSnapshot[] }
export interface StatusResult { instance: InstanceSnapshot }
export interface AttachInitialDto {
  instance: InstanceSnapshot;
  page: EventPage & { epochChanged: boolean; generationChanged: boolean };
  recentHistory: [];
  historyTruncated: boolean;
  controller: { status: "observing" | "unavailable" };
  following: boolean;
}
export type EventsResult = AttachInitialDto;
export interface PromptResult { receipt: CommandReceipt; instance: InstanceSnapshot }
export interface StopResult { receipt: { operationId: string; alreadyStopped: boolean; cleanupErrors?: string[] }; instance: InstanceSnapshot }
export interface ModelsResult { models: RuntimeModelInfo[]; availableThinkingLevels: RuntimeThinkingLevel[]; instance: InstanceSnapshot }
export interface ModelConfigurationResult { instance: InstanceSnapshot; settingsWrite: { persisted: true } }
export interface ThinkingConfigurationResult { actualLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[]; instance: InstanceSnapshot; settingsWrite: { persisted: true } }
export interface SessionsResult { sessions: SessionDto[] }
export type ConfigurationResult = ModelConfigurationResult | ThinkingConfigurationResult;

export function implementedCapabilities(): string[] { return [...IMPLEMENTED_CAPABILITIES].sort(); }
export function capabilityForRequest(type: ControlRequest["type"]): Capability {
  if (type === "host.info") return "host.info";
  if (type.startsWith("instance.")) return type === "instance.attach" ? "events.follow" : "instance.catalog";
  if (type === "command.submit" || type === "session.list") return "session.core";
  return "models.v1";
}
export function requiredCapabilities(capability: Capability): string[] {
  return [...new Set<Capability>(["core.v2", capability])];
}
export function createHelloAck(requestId: string, host: HostIdentity): HelloAck {
  return {
    kind: "hello_ack",
    requestId,
    version: 2,
    host,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    capabilities: implementedCapabilities(),
    limits: { maxLineBytes: MAX_CONTROL_LINE_BYTES, maxPromptChars: MAX_PROMPT_CHARS, maxReplayEvents: MAX_REPLAY_EVENTS, maxHistoryItems: MAX_HISTORY_ITEMS },
  };
}
export function defaultHostIdentity(hostEpoch: string, startedAt: string): HostIdentity {
  return { pid: process.pid, dockVersion: DOCK_VERSION, piSdkVersion: PI_SDK_VERSION, hostEpoch, startedAt };
}

export function parseClientHello(input: unknown): ClientHello {
  const value = object(input, "hello", "invalid_hello");
  exact(value, ["kind", "requestId", "versions", "client", "requiredCapabilities"], "invalid_hello");
  if (value.kind !== "hello") throw validation("invalid_hello", "First record must be a hello");
  const client = object(value.client, "hello.client", "invalid_hello");
  exact(client, ["name", "version", "clientId"], "invalid_hello");
  if (!Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > MAX_CAPABILITIES || !value.versions.every((item) => Number.isSafeInteger(item) && (item as number) > 0)) {
    throw validation("invalid_hello", "hello.versions must be a bounded positive integer array");
  }
  const capabilities = strings(value.requiredCapabilities, "hello.requiredCapabilities", MAX_CAPABILITIES, MAX_CAPABILITY_CHARS, "invalid_hello");
  if (new Set(capabilities).size !== capabilities.length) throw validation("invalid_hello", "requiredCapabilities must be unique");
  return {
    kind: "hello",
    requestId: string(value.requestId, "hello.requestId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_hello"),
    versions: [...value.versions] as number[],
    client: {
      name: string(client.name, "hello.client.name", 128, "invalid_hello"),
      version: string(client.version, "hello.client.version", 128, "invalid_hello"),
      clientId: string(client.clientId, "hello.client.clientId", 128, "invalid_hello"),
    },
    requiredCapabilities: capabilities,
  };
}

export function parseHelloReply(input: unknown, requestId: string): HelloAck {
  const value = object(input, "hello reply");
  if (value.kind !== "hello_ack" && value.kind !== "hello_error") {
    throw validation("protocol_incompatible", "Peer did not complete the required Protocol V2 hello");
  }
  if (value.kind === "hello_error") {
    exact(value, ["kind", "requestId", "error"]);
    if (value.requestId !== requestId) throw validation("invalid_response", "Hello error requestId does not match");
    const error = object(value.error, "hello_error.error");
    exact(error, ["code", "message", "hostVersions", "missing", "retryAfterMs"]);
    const code = enumeration(error.code, "hello_error.error.code", ["invalid_hello", "unsupported_protocol", "capability_missing", "host_starting", "host_draining"]);
    string(error.message, "hello_error.error.message", MAX_MESSAGE);
    if (error.hostVersions !== undefined) unsignedArray(error.hostVersions, "hello_error.error.hostVersions", 16);
    if (error.missing !== undefined) strings(error.missing, "hello_error.error.missing", MAX_CAPABILITIES, MAX_CAPABILITY_CHARS);
    if (error.retryAfterMs !== undefined) unsigned(error.retryAfterMs, "hello_error.error.retryAfterMs");
    throw validation(code, error.message as string);
  }
  exact(value, ["kind", "requestId", "version", "host", "catalogSchemaVersion", "capabilities", "limits"]);
  if (value.requestId !== requestId || value.version !== 2) throw validation("protocol_incompatible", "Peer did not complete the required Protocol V2 hello");
  const limits = object(value.limits, "hello_ack.limits");
  exact(limits, ["maxLineBytes", "maxPromptChars", "maxReplayEvents", "maxHistoryItems"]);
  const capabilities = strings(value.capabilities, "hello_ack.capabilities", MAX_CAPABILITIES, MAX_CAPABILITY_CHARS);
  if (new Set(capabilities).size !== capabilities.length) throw validation("invalid_response", "hello_ack.capabilities must be unique");
  return {
    kind: "hello_ack", requestId, version: 2,
    host: parseHost(value.host, "hello_ack.host"),
    catalogSchemaVersion: unsigned(value.catalogSchemaVersion, "hello_ack.catalogSchemaVersion"),
    capabilities,
    limits: {
      maxLineBytes: positive(valueOr(limits.maxLineBytes), "limits.maxLineBytes"),
      maxPromptChars: positive(valueOr(limits.maxPromptChars), "limits.maxPromptChars"),
      maxReplayEvents: positive(valueOr(limits.maxReplayEvents), "limits.maxReplayEvents"),
      maxHistoryItems: positive(valueOr(limits.maxHistoryItems), "limits.maxHistoryItems"),
    },
  };
}

export function parseControlRequest(input: unknown): ControlRequest {
  const value = object(input, "request", "invalid_request");
  exact(value, ["kind", "version", "requestId", "type", "params"], "invalid_request");
  if (value.kind !== "request" || value.version !== 2) throw validation("unsupported_protocol", "Expected Protocol V2 request envelope");
  const requestId = string(value.requestId, "requestId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
  const type = string(value.type, "type", 64, "invalid_request") as ControlRequest["type"];
  const params = object(value.params, "params", "invalid_request");
  const base = { kind: "request" as const, version: 2 as const, requestId };
  const instanceId = (): string => string(params.instanceId, "params.instanceId", MAX_INSTANCE_ID_CHARS, "invalid_request");
  const operationId = (): string => string(params.operationId, "params.operationId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
  switch (type) {
    case "host.info": exact(params, [], "invalid_request"); return { ...base, type, params: {} };
    case "instance.create": exact(params, ["operationId", "cwd", "name"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), cwd: string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request"), name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request") } };
    case "instance.list": exact(params, ["includeTerminal"], "invalid_request"); return { ...base, type, params: { includeTerminal: optionalBoolean(params.includeTerminal, "params.includeTerminal", "invalid_request") } };
    case "instance.get": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "instance.attach": exact(params, ["instanceId", "since", "follow", "controller"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId(), since: params.since === undefined ? undefined : parseCursor(params.since, "params.since", "invalid_request"), follow: boolean(params.follow, "params.follow", "invalid_request"), controller: enumeration(params.controller, "params.controller", ["claim", "observe"], "invalid_request") } };
    case "instance.stop": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "command.submit": exact(params, ["operationId", "instanceId", "message", "delivery"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), message: string(params.message, "params.message", MAX_PROMPT_CHARS, "invalid_request"), delivery: enumeration(params.delivery, "params.delivery", ["auto", "prompt", "steer", "followUp"], "invalid_request") } };
    case "model.list": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "model.set": exact(params, ["operationId", "instanceId", "provider", "modelId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), provider: string(params.provider, "params.provider", MAX_MODEL_PROVIDER_CHARS, "invalid_request"), modelId: string(params.modelId, "params.modelId", MAX_MODEL_ID_CHARS, "invalid_request") } };
    case "thinking.set": exact(params, ["operationId", "instanceId", "level"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), level: enumeration(params.level, "params.level", THINKING_LEVELS, "invalid_request") } };
    case "session.list": exact(params, ["instanceId", "scope"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId(), scope: enumeration(params.scope, "params.scope", ["cwd", "all"], "invalid_request") } };
    default: throw validation("unknown_request", `Unknown request type: ${type}`);
  }
}

export function parseControlResponse(input: unknown, requestId: string, hostEpoch: string): ControlResponse {
  const value = object(input, "response");
  if (value.kind !== "response" || value.version !== 2 || value.requestId !== requestId || value.hostEpoch !== hostEpoch || typeof value.ok !== "boolean") throw validation("invalid_response", "Invalid Protocol V2 response envelope");
  if (value.ok) {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "ok", "result"]);
    return { kind: "response", version: 2, requestId, hostEpoch, ok: true, result: value.result };
  }
  exact(value, ["kind", "version", "requestId", "hostEpoch", "ok", "error"]);
  const error = object(value.error, "response.error");
  exact(error, ["code", "message", "retryable", "details"]);
  const code=string(error.code, "error.code", 128);
  return {
    kind: "response", version: 2, requestId, hostEpoch, ok: false,
    error: {
      code,
      message: string(error.message, "error.message", MAX_MESSAGE),
      retryable: boolean(error.retryable, "error.retryable"),
      details: error.details === undefined ? undefined : parseErrorDetails(code,error.details),
    },
  };
}

function parseErrorDetails(code:string,input:unknown):JsonObject {
  const details=object(input,"error.details");
  if(code==="effect_unknown") { exact(details,["operationId","queryHint"]); return {operationId:id(details.operationId,"error.details.operationId"),queryHint:string(details.queryHint,"error.details.queryHint",256)}; }
  if(code==="instance_busy") { exact(details,["lifecycle","execution"]); return {lifecycle:enumeration(details.lifecycle,"error.details.lifecycle",["active","stopping","stopped","host_lost","runtime_error"]),execution:enumeration(details.execution,"error.details.execution",["idle","running","failed","unavailable"])}; }
  if(code==="project_trust_required") {
    exact(details,["challengeId","operationId","cwd","choices","expiresAt"]);
    return {challengeId:id(details.challengeId,"error.details.challengeId"),operationId:id(details.operationId,"error.details.operationId"),cwd:string(details.cwd,"error.details.cwd",MAX_CONTROL_CWD_CHARS),choices:strings(details.choices,"error.details.choices",4,64).map((choice)=>enumeration(choice,"error.details.choice",["trust_once","trust_and_remember","deny_once","deny_and_remember"])),expiresAt:timestamp(details.expiresAt,"error.details.expiresAt")};
  }
  if(code==="unsupported_protocol"||code==="protocol_incompatible"||code==="capability_missing") {
    exact(details,["hostVersions","versions","missing","capabilities"]); const result:JsonObject={};
    if(details.hostVersions!==undefined)result.hostVersions=unsignedArray(details.hostVersions,"error.details.hostVersions",16);
    if(details.versions!==undefined)result.versions=unsignedArray(details.versions,"error.details.versions",16);
    if(details.missing!==undefined)result.missing=strings(details.missing,"error.details.missing",MAX_CAPABILITIES,MAX_CAPABILITY_CHARS);
    if(details.capabilities!==undefined)result.capabilities=strings(details.capabilities,"error.details.capabilities",MAX_CAPABILITIES,MAX_CAPABILITY_CHARS);
    return result;
  }
  if(code==="settings_write_failed"||code==="catalog_write_failed"||code==="catalog_corrupt") {
    exact(details,["scope","path"]); const result:JsonObject={}; if(details.scope!==undefined)result.scope=string(details.scope,"error.details.scope",256); if(details.path!==undefined)result.path=string(details.path,"error.details.path",MAX_CONTROL_CWD_CHARS); return result;
  }
  throw validation("invalid_response",`Error code ${code} does not allow details`);
}

export function parseControlEventEnvelope(input: unknown, requestId: string, hostEpoch: string): ControlEventEnvelope {
  const value = object(input, "event envelope");
  exact(value, ["kind", "version", "requestId", "hostEpoch", "event"]);
  if (value.kind !== "event" || value.version !== 2 || value.requestId !== requestId || value.hostEpoch !== hostEpoch) throw validation("invalid_response", "Invalid event envelope");
  const event = parseDockEvent(value.event, "event");
  return { kind: "event", version: 2, requestId, hostEpoch, event };
}

export function parseHostInfoResult(input: unknown): HostInfoResult {
  const value = object(input, "host info"); exact(value, ["state", "host", "catalog", "paths", "diagnostics"]);
  const catalog = object(value.catalog, "catalog"); exact(catalog, ["schemaVersion", "revision", "lastReconciledAt"]);
  const paths = object(value.paths, "paths"); exact(paths, ["socket", "state"]);
  const diagnostics = array(value.diagnostics, "diagnostics", MAX_COLLECTION).map((item, index) => {
    const diagnostic = object(item, `diagnostics[${index}]`); exact(diagnostic, ["severity", "message", "source"]);
    return { severity: enumeration(diagnostic.severity, "severity", ["info", "warning", "error"]), message: string(diagnostic.message, "message", MAX_MESSAGE), source: optionalString(diagnostic.source, "source", 256) };
  });
  return { state: enumeration(value.state, "state", ["ready"]), host: parseHost(value.host, "host"), catalog: { schemaVersion: unsigned(catalog.schemaVersion, "catalog.schemaVersion"), revision: unsigned(catalog.revision, "catalog.revision"), lastReconciledAt: timestamp(catalog.lastReconciledAt, "catalog.lastReconciledAt") }, paths: { socket: string(paths.socket, "paths.socket", MAX_CONTROL_CWD_CHARS), state: string(paths.state, "paths.state", MAX_CONTROL_CWD_CHARS) }, diagnostics };
}
export function parseCreateResult(input: unknown): CreateResult { const value = object(input, "create result"); exact(value, ["instance"]); return { instance: parseInstance(value.instance, "instance") }; }
export function parseListResult(input: unknown): ListResult { const value = object(input, "list result"); exact(value, ["instances"]); return { instances: array(value.instances, "instances", MAX_COLLECTION).map((item, index) => parseInstance(item, `instances[${index}]`)) }; }
export function parseStatusResult(input: unknown): StatusResult { const value = object(input, "get result"); exact(value, ["instance"]); return { instance: parseInstance(value.instance, "instance") }; }
export function parseEventsResult(input: unknown): EventsResult {
  const value = object(input, "attach result"); exact(value, ["instance", "page", "recentHistory", "historyTruncated", "controller", "following"]);
  const instance = parseInstance(value.instance, "instance");
  const page = object(value.page, "page"); exact(page, ["events", "earliest", "latest", "truncated", "epochChanged", "generationChanged"]);
  const earliest = parseCursor(page.earliest, "page.earliest");
  const latest = parseCursor(page.latest, "page.latest");
  assertCursorDomain(earliest, instance, "page.earliest"); assertCursorDomain(latest, instance, "page.latest");
  if (earliest.sequence > latest.sequence) throw validation("invalid_response", "page.earliest cannot follow page.latest");
  const events = array(page.events, "page.events", MAX_REPLAY_EVENTS).map((item, index) => parseDockEvent(item, `page.events[${index}]`));
  let previous = -1;
  for (const event of events) {
    if (event.instanceId !== instance.id || event.runtimeGeneration !== instance.runtimeGeneration || event.sequence <= previous || event.sequence > latest.sequence) throw validation("invalid_response", "Replay event cursor domain/order is invalid");
    previous = event.sequence;
  }
  const history = array(value.recentHistory, "recentHistory", MAX_HISTORY_ITEMS);
  if (history.length !== 0) throw validation("invalid_response", "recentHistory is not implemented in this capability stage");
  const controller = object(value.controller, "controller"); exact(controller, ["status"]);
  return { instance, page: { events, earliest, latest, truncated: boolean(page.truncated, "page.truncated"), epochChanged: boolean(page.epochChanged, "page.epochChanged"), generationChanged: boolean(page.generationChanged, "page.generationChanged") }, recentHistory: [], historyTruncated: boolean(value.historyTruncated, "historyTruncated"), controller: { status: enumeration(controller.status, "controller.status", ["observing", "unavailable"]) }, following: boolean(value.following, "following") };
}
export function parsePromptResult(input: unknown): PromptResult {
  const value = object(input, "prompt result"); exact(value, ["receipt", "instance"]);
  const instance = parseInstance(value.instance, "instance"); const receipt = parseReceipt(value.receipt);
  if (receipt.instanceId !== instance.id || instance.activeCommandId !== undefined && !receipt.queued && instance.activeCommandId !== receipt.operationId) throw validation("invalid_response", "Command receipt does not match instance state");
  return { receipt, instance };
}
export function parseStopResult(input: unknown): StopResult {
  const value = object(input, "stop result"); exact(value, ["receipt", "instance"]);
  const receipt = object(value.receipt, "receipt"); exact(receipt, ["operationId", "alreadyStopped", "cleanupErrors"]);
  const instance = parseInstance(value.instance, "instance");
  if (instance.lifecycle !== "stopped") throw validation("invalid_response", "Stop result instance must be stopped");
  return { receipt: { operationId: id(receipt.operationId, "receipt.operationId"), alreadyStopped: boolean(receipt.alreadyStopped, "receipt.alreadyStopped"), cleanupErrors: receipt.cleanupErrors === undefined ? undefined : strings(receipt.cleanupErrors, "receipt.cleanupErrors", 100, MAX_MESSAGE) }, instance };
}
export function parseModelsResult(input: unknown): ModelsResult {
  const value = object(input, "models result"); exact(value, ["models", "availableThinkingLevels", "instance"]);
  const models = array(value.models, "models", MAX_COLLECTION).map((item, index) => { const model = object(item, `models[${index}]`); exact(model, ["provider", "id", "name", "reasoning", "contextWindow"]); return { provider: string(model.provider, "provider", MAX_MODEL_PROVIDER_CHARS), id: string(model.id, "id", MAX_MODEL_ID_CHARS), name: string(model.name, "name", 256), reasoning: boolean(model.reasoning, "reasoning"), contextWindow: model.contextWindow === undefined ? undefined : positive(model.contextWindow, "contextWindow") }; });
  return { models, availableThinkingLevels: thinkingLevels(value.availableThinkingLevels), instance: parseInstance(value.instance, "instance") };
}
export function parseModelConfigurationResult(input: unknown): ModelConfigurationResult {
  const value = object(input, "model configuration result"); exact(value, ["instance", "settingsWrite"]);
  return { instance: parseInstance(value.instance, "instance"), settingsWrite: parseSettingsWrite(value.settingsWrite) };
}
export function parseThinkingConfigurationResult(input: unknown): ThinkingConfigurationResult {
  const value = object(input, "thinking configuration result"); exact(value, ["actualLevel", "availableThinkingLevels", "instance", "settingsWrite"]);
  return { actualLevel: enumeration(value.actualLevel, "actualLevel", THINKING_LEVELS), availableThinkingLevels: thinkingLevels(value.availableThinkingLevels), instance: parseInstance(value.instance, "instance"), settingsWrite: parseSettingsWrite(value.settingsWrite) };
}
function parseSettingsWrite(input: unknown): { persisted: true } { const write = object(input, "settingsWrite"); exact(write, ["persisted"]); if (write.persisted !== true) throw validation("invalid_response", "settingsWrite.persisted must be true"); return { persisted: true }; }
export function parseSessionsResult(input: unknown): SessionsResult {
  const value = object(input, "sessions result"); exact(value, ["sessions"]);
  return { sessions: array(value.sessions, "sessions", MAX_COLLECTION).map((item, index) => {
    const session = object(item, `sessions[${index}]`); exact(session, ["sessionId", "sessionFile", "name", "cwd", "updatedAt"]);
    return {
      sessionId: id(session.sessionId, `sessions[${index}].sessionId`),
      sessionFile: string(session.sessionFile, `sessions[${index}].sessionFile`, MAX_CONTROL_CWD_CHARS),
      name: optionalString(session.name, `sessions[${index}].name`, MAX_INSTANCE_NAME_CHARS),
      cwd: string(session.cwd, `sessions[${index}].cwd`, MAX_CONTROL_CWD_CHARS),
      updatedAt: session.updatedAt === undefined ? undefined : timestamp(session.updatedAt, `sessions[${index}].updatedAt`),
    };
  }) };
}

function parseReceipt(input: unknown): CommandReceipt {
  const receipt = object(input, "receipt"); exact(receipt, ["operationId", "instanceId", "accepted", "delivery", "queued", "acceptedAt"]);
  if (receipt.accepted !== true) throw validation("invalid_response", "receipt.accepted must be true");
  return { accepted: true, operationId: id(receipt.operationId, "receipt.operationId"), instanceId: id(receipt.instanceId, "receipt.instanceId"), delivery: enumeration(receipt.delivery, "receipt.delivery", ["prompt", "steer", "followUp"]), queued: boolean(receipt.queued, "receipt.queued"), acceptedAt: timestamp(receipt.acceptedAt, "receipt.acceptedAt") };
}
function parseHost(input: unknown, field: string): HostIdentity {
  const host = object(input, field); exact(host, ["pid", "dockVersion", "piSdkVersion", "hostEpoch", "startedAt"]);
  return { pid: positive(host.pid, `${field}.pid`), dockVersion: string(host.dockVersion, `${field}.dockVersion`, 128), piSdkVersion: string(host.piSdkVersion, `${field}.piSdkVersion`, 128), hostEpoch: id(host.hostEpoch, `${field}.hostEpoch`), startedAt: timestamp(host.startedAt, `${field}.startedAt`) };
}
function parseCursor(input: unknown, field: string, code = "invalid_response"): EventCursor {
  const cursor = object(input, field, code); exact(cursor, ["hostEpoch", "instanceId", "runtimeGeneration", "sequence"], code);
  return { hostEpoch: id(cursor.hostEpoch, `${field}.hostEpoch`, code), instanceId: id(cursor.instanceId, `${field}.instanceId`, code), runtimeGeneration: positive(cursor.runtimeGeneration, `${field}.runtimeGeneration`, code), sequence: unsigned(cursor.sequence, `${field}.sequence`, code) };
}
function parseExecutor(input: unknown, field: string): ExecutorIdentity {
  const executor = object(input, field); exact(executor, ["kind", "version", "piSessionId", "sessionFile", "model", "thinkingLevel"]);
  let model: ExecutorIdentity["model"];
  if (executor.model !== undefined) { const value = object(executor.model, `${field}.model`); exact(value, ["provider", "id", "name"]); const name=optionalString(value.name, `${field}.model.name`, 256); model = { provider: string(value.provider, `${field}.model.provider`, MAX_MODEL_PROVIDER_CHARS), id: string(value.id, `${field}.model.id`, MAX_MODEL_ID_CHARS), ...(name === undefined ? {} : { name }) }; }
  return { kind: string(executor.kind, `${field}.kind`, 128), version: optionalString(executor.version, `${field}.version`, 128), piSessionId: id(executor.piSessionId, `${field}.piSessionId`), sessionFile: optionalString(executor.sessionFile, `${field}.sessionFile`, MAX_CONTROL_CWD_CHARS), model, thinkingLevel: executor.thinkingLevel === undefined ? undefined : enumeration(executor.thinkingLevel, `${field}.thinkingLevel`, THINKING_LEVELS) };
}
function parsePending(input: unknown, field: string): InstanceSnapshot["pending"] {
  const pending = object(input, field); exact(pending, ["steering", "followUp", "total"]);
  const result = { steering: unsigned(pending.steering, `${field}.steering`), followUp: unsigned(pending.followUp, `${field}.followUp`), total: unsigned(pending.total, `${field}.total`) };
  if (result.total !== result.steering + result.followUp) throw validation("invalid_response", `${field}.total is inconsistent`);
  return result;
}
function parseMetrics(input: unknown, field: string): NonNullable<InstanceSnapshot["metrics"]> {
  const metrics = object(input, field); exact(metrics, ["messages", "tokens", "cost", "context"]);
  const messages = object(metrics.messages, `${field}.messages`); exact(messages, ["user", "assistant", "toolCalls", "toolResults", "total"]);
  const tokens = object(metrics.tokens, `${field}.tokens`); exact(tokens, ["input", "output", "cacheRead", "cacheWrite", "total"]);
  const result: NonNullable<InstanceSnapshot["metrics"]> = { messages: { user: unsigned(messages.user, "messages.user"), assistant: unsigned(messages.assistant, "messages.assistant"), toolCalls: unsigned(messages.toolCalls, "messages.toolCalls"), toolResults: unsigned(messages.toolResults, "messages.toolResults"), total: unsigned(messages.total, "messages.total") }, tokens: { input: unsigned(tokens.input, "tokens.input"), output: unsigned(tokens.output, "tokens.output"), cacheRead: unsigned(tokens.cacheRead, "tokens.cacheRead"), cacheWrite: unsigned(tokens.cacheWrite, "tokens.cacheWrite"), total: unsigned(tokens.total, "tokens.total") }, cost: finiteNumber(metrics.cost, `${field}.cost`) };
  if (metrics.context !== undefined) { const context = object(metrics.context, `${field}.context`); exact(context, ["tokens", "contextWindow", "percent"]); result.context = { tokens: nullableUnsigned(context.tokens, "context.tokens"), contextWindow: positive(context.contextWindow, "context.contextWindow"), percent: nullableNumber(context.percent, "context.percent") }; }
  return result;
}
function parseInstance(input: unknown, field: string): InstanceSnapshot {
  const value = object(input, field); exact(value, ["id", "creationOperationId", "name", "cwd", "lifecycle", "execution", "lastRun", "reopenable", "runtimeGeneration", "ownerHostEpoch", "interruption", "pending", "executor", "metrics", "extensionStatus", "activeInteraction", "activeCommandId", "lastError", "createdAt", "updatedAt", "eventCursor"]);
  const snapshot: InstanceSnapshot = {
    id: id(value.id, `${field}.id`), creationOperationId: id(value.creationOperationId, `${field}.creationOperationId`), name: optionalString(value.name, `${field}.name`, MAX_INSTANCE_NAME_CHARS), cwd: string(value.cwd, `${field}.cwd`, MAX_CONTROL_CWD_CHARS),
    lifecycle: enumeration(value.lifecycle, `${field}.lifecycle`, ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(value.execution, `${field}.execution`, ["idle", "running", "failed", "unavailable"]), lastRun: enumeration(value.lastRun, `${field}.lastRun`, ["never", "succeeded", "failed", "aborted", "interrupted"]), reopenable: boolean(value.reopenable, `${field}.reopenable`), runtimeGeneration: positive(value.runtimeGeneration, `${field}.runtimeGeneration`), ownerHostEpoch: optionalString(value.ownerHostEpoch, `${field}.ownerHostEpoch`, 128), pending: parsePending(value.pending, `${field}.pending`), executor: parseExecutor(value.executor, `${field}.executor`), metrics: value.metrics === undefined ? undefined : parseMetrics(value.metrics, `${field}.metrics`), extensionStatus: {}, activeCommandId: optionalString(value.activeCommandId, `${field}.activeCommandId`, 128), lastError: optionalString(value.lastError, `${field}.lastError`, MAX_MESSAGE), createdAt: timestamp(value.createdAt, `${field}.createdAt`), updatedAt: timestamp(value.updatedAt, `${field}.updatedAt`), eventCursor: parseCursor(value.eventCursor, `${field}.eventCursor`),
  };
  if (value.interruption !== undefined) { const interruption = object(value.interruption, `${field}.interruption`); exact(interruption, ["reason", "at"]); snapshot.interruption = { reason: enumeration(interruption.reason, "interruption.reason", ["host_crash", "host_shutdown", "replacement_failed"]), at: timestamp(interruption.at, "interruption.at") }; }
  const status = object(value.extensionStatus, `${field}.extensionStatus`); if (Object.keys(status).length > 64) throw validation("invalid_response", "extensionStatus has too many keys"); for (const [key, item] of Object.entries(status)) snapshot.extensionStatus[string(key, "extensionStatus key", 128)] = string(item, `extensionStatus.${key}`, MAX_TEXT);
  if (value.activeInteraction !== undefined) { const interaction = object(value.activeInteraction, `${field}.activeInteraction`); exact(interaction, ["id", "method", "expiresAt"]); snapshot.activeInteraction = { id: id(interaction.id, "activeInteraction.id"), method: enumeration(interaction.method, "activeInteraction.method", ["select", "confirm", "input", "editor"]), expiresAt: timestamp(interaction.expiresAt, "activeInteraction.expiresAt") }; }
  assertCursorDomain(snapshot.eventCursor, snapshot, `${field}.eventCursor`);
  const terminal = snapshot.lifecycle === "stopped" || snapshot.lifecycle === "host_lost" || snapshot.lifecycle === "runtime_error";
  if (terminal !== (snapshot.execution === "unavailable")) throw validation("invalid_response", "Lifecycle/execution combination is invalid");
  if ((snapshot.lifecycle === "active" || snapshot.lifecycle === "stopping") !== (snapshot.ownerHostEpoch !== undefined)) throw validation("invalid_response", "ownerHostEpoch does not match lifecycle");
  if (terminal && (snapshot.pending.total !== 0 || snapshot.activeCommandId !== undefined || snapshot.activeInteraction !== undefined)) throw validation("invalid_response", "Unavailable instance retains active state");
  if (snapshot.lifecycle === "stopped" && snapshot.reopenable) throw validation("invalid_response", "Stopped instance cannot be reopenable");
  if (snapshot.reopenable && snapshot.lifecycle !== "host_lost" && snapshot.lifecycle !== "runtime_error") throw validation("invalid_response", "Only unavailable failed instances can be reopenable");
  if (snapshot.activeCommandId !== undefined && snapshot.execution !== "running") throw validation("invalid_response", "activeCommandId requires running execution");
  if (snapshot.activeInteraction !== undefined && snapshot.lifecycle !== "active") throw validation("invalid_response", "activeInteraction requires active lifecycle");
  return snapshot;
}
function assertCursorDomain(cursor: EventCursor, snapshot: InstanceSnapshot, field: string): void {
  if (cursor.instanceId !== snapshot.id || cursor.runtimeGeneration !== snapshot.runtimeGeneration || (snapshot.ownerHostEpoch !== undefined && cursor.hostEpoch !== snapshot.ownerHostEpoch)) throw validation("invalid_response", `${field} does not match the instance cursor domain`);
}

function parseDockEvent(input: unknown, field: string): DockEvent {
  const value = object(input, field); exact(value, ["scope", "sequence", "instanceId", "runtimeGeneration", "occurredAt", "type", "data"]);
  const base = { scope: enumeration(value.scope, `${field}.scope`, ["instance"]), sequence: positive(value.sequence, `${field}.sequence`), instanceId: id(value.instanceId, `${field}.instanceId`), runtimeGeneration: positive(value.runtimeGeneration, `${field}.runtimeGeneration`), occurredAt: timestamp(value.occurredAt, `${field}.occurredAt`) };
  const type = string(value.type, `${field}.type`, 128) as keyof EventDataMap;
  const data = parseEventData(type, value.data, `${field}.data`);
  return { ...base, type, data } as DockEvent;
}
function parseEventData(type: keyof EventDataMap, input: unknown, field: string): unknown {
  const data = object(input, field);
  const text = (key: string, max = MAX_TEXT): string => string(data[key], `${field}.${key}`, max);
  const optionalText = (key: string, max = MAX_TEXT): string | undefined => optionalString(data[key], `${field}.${key}`, max);
  const levels = (key: string): RuntimeThinkingLevel[] => thinkingLevels(data[key]);
  switch (type) {
    case "instance.created": exact(data, ["cwd", "name", "executor"]); return { cwd: text("cwd", MAX_CONTROL_CWD_CHARS), name: optionalText("name", MAX_INSTANCE_NAME_CHARS), executor: parseExecutor(data.executor, `${field}.executor`) };
    case "instance.state_changed": exact(data, ["reason", "lifecycle", "execution", "lastRun", "pending", "activeCommandId", "lastError"]); { const result = { reason: text("reason", MAX_MESSAGE), lifecycle: enumeration(data.lifecycle, "lifecycle", ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(data.execution, "execution", ["idle", "running", "failed", "unavailable"]), lastRun: enumeration(data.lastRun, "lastRun", ["never", "succeeded", "failed", "aborted", "interrupted"]), pending: parsePending(data.pending, `${field}.pending`), activeCommandId: optionalText("activeCommandId", 128), lastError: optionalText("lastError", MAX_MESSAGE) }; if (result.activeCommandId && result.execution !== "running") throw validation("invalid_response", "state event activeCommandId requires running"); return result; }
    case "instance.reopened": exact(data, ["previousLifecycle", "sessionFile", "runtimeGeneration"]); return { previousLifecycle: enumeration(data.previousLifecycle, "previousLifecycle", ["host_lost", "runtime_error"]), sessionFile: text("sessionFile", MAX_CONTROL_CWD_CHARS), runtimeGeneration: positive(data.runtimeGeneration, "runtimeGeneration") };
    case "instance.stopped": exact(data, ["cleanupErrors"]); return { cleanupErrors: strings(data.cleanupErrors, "cleanupErrors", 100, MAX_MESSAGE) };
    case "instance.runtime_error": exact(data, ["operationId", "kind", "error", "recoverySessionFile"]); return { operationId: text("operationId", 128), kind: enumeration(data.kind, "kind", ["create", "new", "switch", "fork", "clone", "reload", "reopen"]), error: text("error", MAX_MESSAGE), recoverySessionFile: optionalText("recoverySessionFile", MAX_CONTROL_CWD_CHARS) };
    case "instance.error": exact(data, ["operationId", "source", "error", "runtimeEventType"]); return { operationId: optionalText("operationId", 128), source: enumeration(data.source, "source", ["event_projection", "command_background"]), error: text("error", MAX_MESSAGE), runtimeEventType: optionalText("runtimeEventType", 128) };
    case "command.accepted": exact(data, ["operationId", "delivery", "queued", "acceptedAt"]); return { operationId: text("operationId", 128), delivery: enumeration(data.delivery, "delivery", ["prompt", "steer", "followUp"]), queued: boolean(data.queued, "queued"), acceptedAt: timestamp(data.acceptedAt, "acceptedAt") };
    case "command.rejected": exact(data, ["operationId", "reason", "error"]); return { operationId: text("operationId", 128), reason: text("reason", MAX_MESSAGE), error: text("error", MAX_MESSAGE) };
    case "command.handled": exact(data, ["operationId", "kind"]); return { operationId: text("operationId", 128), kind: enumeration(data.kind, "kind", ["extension_command", "no_run"]) };
    case "run.started": exact(data, ["operationId"]); return { operationId: text("operationId", 128) };
    case "run.retry_started": exact(data, ["attempt", "maxAttempts", "delayMs", "error"]); return { attempt: unsigned(data.attempt, "attempt"), maxAttempts: unsigned(data.maxAttempts, "maxAttempts"), delayMs: unsigned(data.delayMs, "delayMs"), error: text("error", MAX_MESSAGE) };
    case "run.retry_completed": exact(data, ["success", "attempt", "error"]); return { success: boolean(data.success, "success"), attempt: unsigned(data.attempt, "attempt"), error: optionalText("error", MAX_MESSAGE) };
    case "run.settled": exact(data, ["operationId", "result", "stopReason", "error"]); return { operationId: optionalText("operationId", 128), result: enumeration(data.result, "result", ["never", "succeeded", "failed", "aborted", "interrupted"]), stopReason: optionalText("stopReason", 128), error: optionalText("error", MAX_MESSAGE) };
    case "message.submitted": exact(data, ["operationId", "messageId", "role", "text"]); return { operationId: text("operationId", 128), messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user"]), text: text("text", MAX_PROMPT_CHARS) };
    case "message.delta": exact(data, ["messageId", "block", "delta"]); return { messageId: text("messageId", 128), block: enumeration(data.block, "block", ["text", "thinking"]), delta: boundedString(data.delta, `${field}.delta`, MAX_TEXT) };
    case "message.completed": exact(data, ["messageId", "role", "content", "stopReason", "error"]); return { messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user", "assistant", "tool", "system"]), content: parseContent(data.content, `${field}.content`), stopReason: optionalText("stopReason", 128), error: optionalText("error", MAX_MESSAGE) };
    case "tool.started": exact(data, ["toolCallId", "toolName", "args", "omittedFields"]); return toolArgs(data, field, true);
    case "tool.args_updated": exact(data, ["toolCallId", "args", "omittedFields"]); return toolArgs(data, field, false);
    case "tool.output_updated": exact(data, ["toolCallId", "text"]); return { toolCallId: text("toolCallId", 128), text: boundedString(data.text, `${field}.text`, MAX_TEXT) };
    case "tool.completed": exact(data, ["toolCallId", "toolName", "text", "isError", "omittedFields"]); return { toolCallId: text("toolCallId", 128), toolName: text("toolName", 256), text: boundedString(data.text, `${field}.text`, MAX_TEXT), isError: boolean(data.isError, "isError"), omittedFields: omitted(data.omittedFields, "omittedFields") };
    case "queue.changed": case "queue.cleared": exact(data, ["steering", "followUp", "total"]); return parsePending(data, field);
    case "compaction.started": exact(data, ["reason"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]) };
    case "compaction.completed": exact(data, ["reason", "aborted", "willRetry", "error"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]), aborted: boolean(data.aborted, "aborted"), willRetry: boolean(data.willRetry, "willRetry"), error: optionalText("error", MAX_MESSAGE) };
    case "session.replaced": exact(data, ["reason", "previousSessionFile", "sessionFile", "runtimeGeneration"]); return { reason: enumeration(data.reason, "reason", ["new", "resume", "fork", "reload"]), previousSessionFile: optionalText("previousSessionFile", MAX_CONTROL_CWD_CHARS), sessionFile: optionalText("sessionFile", MAX_CONTROL_CWD_CHARS), runtimeGeneration: positive(data.runtimeGeneration, "runtimeGeneration") };
    case "session.info_changed": exact(data, ["name"]); return { name: optionalText("name", MAX_INSTANCE_NAME_CHARS) };
    case "session.metrics_changed": exact(data, ["metrics"]); return { metrics: parseMetrics(data.metrics, `${field}.metrics`) };
    case "model.changed": exact(data, ["provider", "id", "thinkingLevel", "availableThinkingLevels"]); return { provider: text("provider", MAX_MODEL_PROVIDER_CHARS), id: text("id", MAX_MODEL_ID_CHARS), thinkingLevel: enumeration(data.thinkingLevel, "thinkingLevel", THINKING_LEVELS), availableThinkingLevels: levels("availableThinkingLevels") };
    case "thinking.changed": exact(data, ["requested", "thinkingLevel", "availableThinkingLevels"]); return { requested: enumeration(data.requested, "requested", THINKING_LEVELS), thinkingLevel: enumeration(data.thinkingLevel, "thinkingLevel", THINKING_LEVELS), availableThinkingLevels: levels("availableThinkingLevels") };
    case "resources.reloaded": exact(data, ["resources", "diagnostics"]); return { resources: array(data.resources, "resources", MAX_COLLECTION).map((item, index) => parseResource(item, `resources[${index}]`)), diagnostics: array(data.diagnostics, "diagnostics", MAX_COLLECTION).map((item, index) => parseDiagnostic(item, `diagnostics[${index}]`)) };
    case "settings.changed": { exact(data, ["key", "value", "reloadRequired", "hostRestartRequired"]); const key=text("key", 128); return { key, value: parseSettingValue(key, data.value), reloadRequired: boolean(data.reloadRequired, "reloadRequired"), hostRestartRequired: boolean(data.hostRestartRequired, "hostRestartRequired") }; }
    case "settings.write_failed": exact(data, ["key", "error"]); return { key: settingsWriteKey(data.key), error: text("error", MAX_MESSAGE) };
    case "interaction.requested": return parseDialogRequest(data, field);
    case "interaction.resolved": exact(data, ["interactionId", "method"]); return { interactionId: text("interactionId", 128), method: enumeration(data.method, "method", ["select", "confirm", "input", "editor"]) };
    case "interaction.cancelled": exact(data, ["interactionId", "method", "reason"]); return { interactionId: text("interactionId", 128), method: enumeration(data.method, "method", ["select", "confirm", "input", "editor"]), reason: enumeration(data.reason, "reason", ["user", "timeout", "signal", "detach", "replacement", "host_draining", "overflow"]) };
    case "extension.notification": exact(data, ["message", "level"]); return { message: text("message"), level: enumeration(data.level, "level", ["info", "warning", "error"]) };
    case "extension.status_changed": exact(data, ["key", "text"]); return { key: text("key", 128), text: data.text === undefined ? undefined : boundedString(data.text, `${field}.text`, MAX_TEXT) };
    case "extension.widget_changed": exact(data, ["key", "lines", "placement"]); return { key: text("key", 128), lines: data.lines === undefined ? undefined : strings(data.lines, "lines", MAX_JSON_ARRAY, MAX_TEXT), placement: data.placement === undefined ? undefined : enumeration(data.placement, "placement", ["aboveEditor", "belowEditor"]) };
    case "extension.error": exact(data, ["source", "event", "error"]); return { source: optionalText("source", 256), event: optionalText("event", 128), error: text("error", MAX_MESSAGE) };
    default: throw validation("invalid_response", `Unsupported event type: ${type}`);
  }
}
function toolArgs(data: Record<string, unknown>, field: string, withName: boolean): EventDataMap["tool.started"] | EventDataMap["tool.args_updated"] {
  const result = { toolCallId: id(data.toolCallId, `${field}.toolCallId`), args: parseJsonObject(data.args, `${field}.args`), omittedFields: omitted(data.omittedFields, `${field}.omittedFields`) };
  return withName ? { ...result, toolName: string(data.toolName, `${field}.toolName`, 256) } : result;
}
function parseContent(input: unknown, field: string): ContentBlockDto[] {
  return array(input, field, MAX_JSON_ARRAY).map((item, index) => {
    const block = object(item, `${field}[${index}]`); const type = enumeration(block.type, `${field}[${index}].type`, ["text", "thinking", "tool_call", "tool_result", "omitted"]);
    if (type === "text" || type === "thinking") { exact(block, ["type", "text"]); return { type, text: boundedString(block.text, `${field}[${index}].text`, MAX_TEXT) }; }
    if (type === "tool_call") { exact(block, ["type", "toolCallId", "toolName", "args", "omittedFields"]); return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName: string(block.toolName, "toolName", 256), args: parseJsonObject(block.args, "args"), omittedFields: omitted(block.omittedFields, "omittedFields") }; }
    if (type === "tool_result") { exact(block, ["type", "toolCallId", "toolName", "text", "isError", "omittedFields"]); return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName: string(block.toolName, "toolName", 256), text: boundedString(block.text, "text", MAX_TEXT), isError: boolean(block.isError, "isError"), omittedFields: omitted(block.omittedFields, "omittedFields") }; }
    exact(block, ["type", "kind", "description"]); return { type, kind: enumeration(block.kind, "kind", ["image", "binary"]), description: string(block.description, "description", MAX_MESSAGE) };
  });
}
function parseDialogRequest(data: Record<string, unknown>, field: string): EventDataMap["interaction.requested"] {
  const method = enumeration(data.method, `${field}.method`, ["select", "confirm", "input", "editor"]);
  const interactionId = id(data.interactionId, `${field}.interactionId`);
  const title = string(data.title, `${field}.title`, MAX_MESSAGE);
  const issuedAt = timestamp(data.issuedAt, `${field}.issuedAt`);
  const expiresAt = timestamp(data.expiresAt, `${field}.expiresAt`);
  if (method === "select") { exact(data, ["interactionId", "method", "title", "options", "issuedAt", "expiresAt"]); return { interactionId, method, title, options: strings(data.options, "options", 200, MAX_TEXT), issuedAt, expiresAt }; }
  if (method === "confirm") { exact(data, ["interactionId", "method", "title", "message", "issuedAt", "expiresAt"]); return { interactionId, method, title, message: string(data.message, "message", MAX_TEXT), issuedAt, expiresAt }; }
  if (method === "input") { exact(data, ["interactionId", "method", "title", "placeholder", "issuedAt", "expiresAt"]); return { interactionId, method, title, ...(data.placeholder === undefined ? {} : { placeholder: string(data.placeholder, "placeholder", MAX_TEXT) }), issuedAt, expiresAt }; }
  exact(data, ["interactionId", "method", "title", "prefill", "issuedAt", "expiresAt"]); return { interactionId, method, title, ...(data.prefill === undefined ? {} : { prefill: string(data.prefill, "prefill", MAX_PROMPT_CHARS) }), issuedAt, expiresAt };
}
function settingKey(input: unknown): string {
  const key=string(input,"setting key",128);
  const keys=["autoCompaction","autoRetry","enableSkillCommands","hideThinking","showCacheMissNotices","showHardwareCursor","clearOnShrink","showTerminalProgress","quietStartup","steeringMode","followUpMode","transport","doubleEscapeAction","treeFilterMode","defaultProjectTrust","httpIdleTimeoutMs","editorPaddingX","outputPad","autocompleteMaxVisible","warnings"];
  if(!keys.includes(key))throw validation("invalid_response",`Unsupported setting key: ${key}`);
  return key;
}
function settingsWriteKey(input: unknown): string {
  const key = string(input, "settings write key", 128);
  return key === "model" || key === "thinking" ? key : settingKey(key);
}
function parseSettingValue(key: string, input: unknown): JsonValue {
  const booleanKeys = ["autoCompaction", "autoRetry", "enableSkillCommands", "hideThinking", "showCacheMissNotices", "showHardwareCursor", "clearOnShrink", "showTerminalProgress", "quietStartup"];
  if (booleanKeys.includes(key)) return boolean(input, `settings.${key}`);
  const enums: Record<string, readonly string[]> = {
    steeringMode: ["all", "one-at-a-time"], followUpMode: ["all", "one-at-a-time"],
    transport: ["auto", "sse", "websocket", "websocket-cached"], doubleEscapeAction: ["fork", "tree", "none"],
    treeFilterMode: ["default", "no-tools", "user-only", "labeled-only", "all"], defaultProjectTrust: ["ask", "always", "never"],
  };
  if (enums[key]) return enumeration(input, `settings.${key}`, enums[key]);
  const integerBounds: Record<string, readonly [number, number]> = { httpIdleTimeoutMs: [0, 2_147_483_647], editorPaddingX: [0, 3], outputPad: [0, 1], autocompleteMaxVisible: [3, 20] };
  const bounds=integerBounds[key];
  if (bounds) { const value=unsigned(input, `settings.${key}`); if(value<bounds[0]||value>bounds[1])throw validation("invalid_response",`settings.${key} is out of range`); return value; }
  if (key === "warnings") { const value=object(input, "settings.warnings"); exact(value, ["anthropicExtraUsage"]); const result:JsonObject={}; if(value.anthropicExtraUsage!==undefined)result.anthropicExtraUsage=boolean(value.anthropicExtraUsage,"settings.warnings.anthropicExtraUsage"); return result; }
  throw validation("invalid_response", `Unsupported setting key: ${key}`);
}

function parseResource(input: unknown, field: string): JsonObject { const value = object(input, field); exact(value, ["kind", "name", "path", "source"]); const result: JsonObject = { kind: enumeration(value.kind, "kind", ["extension", "skill", "prompt", "context"]), name: string(value.name, "name", 256) }; if (value.path !== undefined) result.path = string(value.path, "path", MAX_CONTROL_CWD_CHARS); if (value.source !== undefined) result.source = parseSource(value.source, "source"); return result; }
function parseSource(input: unknown, field: string): JsonObject { const value = object(input, field); exact(value, ["kind", "path", "package"]); const result: JsonObject = { kind: enumeration(value.kind, "kind", ["built-in", "extension", "skill", "prompt"]) }; if (value.path !== undefined) result.path = string(value.path, `${field}.path`, MAX_CONTROL_CWD_CHARS); if (value.package !== undefined) result.package = string(value.package, `${field}.package`, 256); return result; }
function parseDiagnostic(input: unknown, field: string): JsonObject { const value = object(input, field); exact(value, ["severity", "message", "source"]); const result: JsonObject = { severity: enumeration(value.severity, "severity", ["info", "warning", "error"]), message: string(value.message, "message", MAX_MESSAGE) }; if (value.source !== undefined) result.source = string(value.source, "source", 256); return result; }
function omitted(input: unknown, field: string): string[] | undefined { if (input === undefined) return undefined; const result = strings(input, field, MAX_JSON_ARRAY, MAX_CONTROL_CWD_CHARS); if (result.some((item) => !item.startsWith("/"))) throw validation("invalid_response", `${field} must contain relative JSON pointers`); return result; }
function thinkingLevels(input: unknown): RuntimeThinkingLevel[] { return array(input, "availableThinkingLevels", THINKING_LEVELS.length).map((item) => enumeration(item, "thinking level", THINKING_LEVELS)); }

export class ProtocolValidationError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ProtocolValidationError"; } }
function validation(code: string, message: string): ProtocolValidationError { return new ProtocolValidationError(code, message); }
function object(input: unknown, field: string, code = "invalid_response"): Record<string, unknown> { if (input === null || typeof input !== "object" || Array.isArray(input)) throw validation(code, `${field} must be a JSON object`); return input as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], code = "invalid_response"): void { const allowed = new Set(keys); const unexpected = Object.keys(value).find((key) => !allowed.has(key)); if (unexpected) throw validation(code, `Unexpected field: ${unexpected}`); }
function boundedString(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string { if (typeof input !== "string" || input.length > max) throw validation(code, `${field} must be a bounded string`); return input; }
function string(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string { const value=boundedString(input,field,max,code); if(value.length===0)throw validation(code,`${field} must be a bounded non-empty string`); return value; }
function id(input: unknown, field: string, code = "invalid_response"): string { return string(input, field, 128, code); }
function optionalString(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string | undefined { return input === undefined ? undefined : string(input, field, max, code); }
function boolean(input: unknown, field: string, code = "invalid_response"): boolean { if (typeof input !== "boolean") throw validation(code, `${field} must be boolean`); return input; }
function optionalBoolean(input: unknown, field: string, code: string): boolean | undefined { return input === undefined ? undefined : boolean(input, field, code); }
function unsigned(input: unknown, field: string, code = "invalid_response"): number { if (!Number.isSafeInteger(input) || (input as number) < 0) throw validation(code, `${field} must be a non-negative safe integer`); return input as number; }
function positive(input: unknown, field: string, code = "invalid_response"): number { const value = unsigned(input, field, code); if (value === 0) throw validation(code, `${field} must be positive`); return value; }
function finiteNumber(input: unknown, field: string): number { if (typeof input !== "number" || !Number.isFinite(input)) throw validation("invalid_response", `${field} must be finite`); return input; }
function nullableUnsigned(input: unknown, field: string): number | null { return input === null ? null : unsigned(input, field); }
function nullableNumber(input: unknown, field: string): number | null { return input === null ? null : finiteNumber(input, field); }
function enumeration<T extends string>(input: unknown, field: string, allowed: readonly T[], code = "invalid_response"): T { if (typeof input !== "string" || !allowed.includes(input as T)) throw validation(code, `${field} has an unsupported value`); return input as T; }
function array(input: unknown, field: string, max: number, code = "invalid_response"): unknown[] { if (!Array.isArray(input) || input.length > max) throw validation(code, `${field} must be a bounded array`); return input; }
function strings(input: unknown, field: string, maxItems: number, maxChars: number, code = "invalid_response"): string[] { return array(input, field, maxItems, code).map((item, index) => string(item, `${field}[${index}]`, maxChars, code)); }
function unsignedArray(input: unknown, field: string, max: number): number[] { return array(input, field, max).map((item, index) => unsigned(item, `${field}[${index}]`)); }
function timestamp(input: unknown, field: string): string { const value = string(input, field, 64); let normalized: string; try { normalized = new Date(value).toISOString(); } catch { throw validation("invalid_response", `${field} must be an ISO-8601 UTC timestamp`); } if (normalized !== value) throw validation("invalid_response", `${field} must be an ISO-8601 UTC timestamp`); return value; }
function parseJsonObject(input: unknown, field: string): JsonObject { const value = parseJsonValue(input, field, 0); if (value === null || typeof value !== "object" || Array.isArray(value)) throw validation("invalid_response", `${field} must be a JSON object`); return value; }
function parseJsonValue(input: unknown, field: string, depth: number): JsonValue { if (depth > MAX_JSON_DEPTH) throw validation("invalid_response", `${field} exceeds JSON depth`); if (input === null || typeof input === "boolean") return input; if (typeof input === "string") return boundedString(input, field, MAX_TEXT); if (typeof input === "number" && Number.isFinite(input)) return input; if (Array.isArray(input)) return array(input, field, MAX_JSON_ARRAY).map((item, index) => parseJsonValue(item, `${field}[${index}]`, depth + 1)); const value = object(input, field); if (Object.keys(value).length > MAX_JSON_KEYS) throw validation("invalid_response", `${field} has too many keys`); return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonValue(item, `${field}.${key}`, depth + 1)])); }
function valueOr(input: unknown): unknown { return input; }
