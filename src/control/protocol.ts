import { containsBinaryPayload, type InteractionResponse } from "../core/extension-ui-broker.js";
import {
  validateBuiltInToolPresentation,
  type BuiltInToolPresentation,
} from "../core/tool-result-presentation.js";
import {
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_ITEMS,
  MAX_PENDING_QUEUE_TEXT_CHARS,
} from "../core/managed-instance.js";
import type {
  CommandReceipt,
  ContentBlockDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  HistoryEntryDto,
  ImagePathDto,
  InstanceSnapshot,
  JsonObject,
  JsonValue,
  PendingMessageDto,
  QueueDequeueReceipt,
  SessionDto,
  TreeNodeDto,
} from "../core/managed-instance.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingKey, SettingUpdate, ToolDto } from "../core/config-projection.js";
import {
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  compareCommandDtos,
  compareDiagnosticDtos,
  compareResourceDtos,
  compareToolDtos,
} from "../core/config-projection.js";
import type { RuntimeModelInfo, RuntimeThinkingLevel } from "../core/runtime-session.js";
import type { ProjectTrustChoice } from "./project-trust.js";
import { CATALOG_SCHEMA_VERSION, DOCK_VERSION, PI_SDK_VERSION } from "../version.js";

export const CONTROL_PROTOCOL_VERSION = 2 as const;
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
export const MAX_CONTROL_REQUEST_ID_CHARS = 128;
export const MAX_INSTANCE_ID_CHARS = 128;
export const MAX_INSTANCE_KEY_CHARS = 128;
export const MAX_INSTANCE_NAME_CHARS = 256;
export const MAX_CONTROL_CWD_CHARS = 16_384;
export const MAX_PROMPT_CHARS = 256_000;
export const MAX_MODEL_PROVIDER_CHARS = 256;
export const MAX_MODEL_ID_CHARS = 512;
export const MAX_CAPABILITIES = 128;
export const MAX_CAPABILITY_CHARS = 128;
export const MAX_REPLAY_EVENTS = 1_000;
export const MAX_HISTORY_ITEMS = 200;
export const MAX_INSTANCE_LIST_ITEMS = 100;
// Leave ample room for the response envelope under MAX_CONTROL_LINE_BYTES.
export const MAX_INSTANCE_LIST_RESULT_BYTES = 768 * 1_024;
export const MAX_CATALOG_PRUNE_ITEMS = 1_000;
const MAX_TEXT = 8_000;
const MAX_TOOL_RESULT_TEXT = 256_000;
const MAX_MESSAGE = 2_048;
const MAX_COLLECTION = 2_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 100;
const MAX_JSON_ARRAY = 200;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const TOOLS_EXPANDED_CAPABILITY = "extension_ui.tools-expanded.v1" as const;
export const EXTENSION_WIDGET_CAPABILITY = "extension_ui.widgets.v1" as const;
export const CONTROLLER_DIRECTIVES_CAPABILITY = "extension_ui.controller-directives.v1" as const;
export const GIT_BRANCH_CAPABILITY = "git.branch-footer.v1" as const;
export const TOOL_RESULT_PRESENTATION_CAPABILITY = "tool-result-presentation.v1" as const;
export const IMAGE_INPUT_CAPABILITY = "command.images.path.v1" as const;
export const INSTANCE_KEYS_CAPABILITY = "instance.keys.v1" as const;

export const IMPLEMENTED_CAPABILITIES = [
  "catalog.maintenance.v1",
  "catalog.v1",
  "core.v2",
  IMAGE_INPUT_CAPABILITY,
  "events.follow",
  "events.replay-purpose.v1",
  TOOLS_EXPANDED_CAPABILITY,
  EXTENSION_WIDGET_CAPABILITY,
  CONTROLLER_DIRECTIVES_CAPABILITY,
  GIT_BRANCH_CAPABILITY,
  TOOL_RESULT_PRESENTATION_CAPABILITY,
  "extension_ui.v1",
  "host.info",
  "instance.catalog",
  INSTANCE_KEYS_CAPABILITY,
  "models.v1",
  "projection.completeness.v1",
  "queue.control.v1",
  "resources.v1",
  "run.abort.v1",
  "service.managed.v1",
  "session.adopt.v1",
  "session.commands.v1",
  "session.core",
  "session.inventory.v1",
  "session.inventory-diagnostics.v1",
  "session.reopen",
  "session.tree.v1",
  "settings.v1",
  "tools.v1",
  "tui.projection.v1",
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
  limits: { maxLineBytes: number; maxPromptChars: number; maxReplayEvents: number; maxHistoryItems: number; maxInstanceListItems: number; maxInstanceListBytes: number };
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
  | Request<"instance.create", { operationId: string; cwd: string; name?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"instance.ensure", { operationId: string; key: string; cwd: string; name?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"instance.adopt", { operationId: string; sessionFile: string; name?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"instance.list", { selector: "actionable" | "all"; cursor?: InstanceListCursor; limit: number }>
  | Request<"instance.get_by_key", { key: string }>
  | Request<"instance.get", { instanceId: string }>
  | Request<"instance.attach", { instanceId: string; since?: EventCursor; follow: boolean; controller: "claim" | "observe"; replay?: "event_log" | "conversation_bootstrap" }>
  | Request<"instance.stop", { operationId: string; instanceId: string }>
  | Request<"instance.forget", { operationId: string; instanceId: string }>
  | Request<"catalog.prune", { operationId: string; selector: "stopped" }>
  | Request<"instance.reopen", { operationId: string; instanceId: string; sessionFile?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"interaction.respond", { operationId: string; instanceId: string; leaseToken: string; interactionId: string; response: InteractionResponse }>
  | Request<"extension.tools_expanded.set", { operationId: string; instanceId: string; expectedRuntimeGeneration: number; expanded: boolean }>
  | Request<"extension.widget_viewport.set", { instanceId: string; leaseToken: string; expectedRuntimeGeneration: number; width: number; height: number }>
  | Request<"command.submit", { operationId: string; instanceId: string; message: string; images?: ImagePathDto[]; delivery: DeliveryMode }>
  | Request<"command.abort", { operationId: string; instanceId: string }>
  | Request<"queue.dequeue", { operationId: string; instanceId: string }>
  | Request<"model.list", { instanceId: string }>
  | Request<"model.set", { operationId: string; instanceId: string; provider: string; modelId: string }>
  | Request<"thinking.set", { operationId: string; instanceId: string; level: RuntimeThinkingLevel }>
  | Request<"tool.list", { instanceId: string }>
  | Request<"tool.set_active", { operationId: string; instanceId: string; names: string[] }>
  | Request<"settings.get", { instanceId: string }>
  | Request<"settings.update", { operationId: string; instanceId: string; update: SettingUpdate }>
  | Request<"resource.get", { instanceId: string }>
  | Request<"command.catalog", { instanceId: string; prefix?: string }>
  | Request<"session.history", { instanceId: string; beforeEntryId?: string; limit: number }>
  | Request<"session.inventory", { cwd: string; scope: "cwd" | "all" }>
  | Request<"session.list", { instanceId: string; scope: "cwd" | "all" }>
  | Request<"session.switch", { operationId: string; instanceId: string; sessionFile: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"session.new", { operationId: string; instanceId: string; parentSession?: string }>
  | Request<"session.name", { operationId: string; instanceId: string; name: string }>
  | Request<"session.compact", { operationId: string; instanceId: string; customInstructions?: string }>
  | Request<"session.reload", { operationId: string; instanceId: string }>
  | Request<"session.tree", { instanceId: string; treeRevision?: string; afterEntryId?: string; limit: number }>
  | Request<"session.navigate", { operationId: string; instanceId: string; targetId: string; summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }>
  | Request<"session.fork", { operationId: string; instanceId: string; entryId: string }>
  | Request<"session.clone", { operationId: string; instanceId: string; entryId: string }>;

export interface ControlError { code: string; message: string; retryable: boolean; details?: JsonObject }
export type ControlResponse =
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: true; result: unknown }
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: false; error: ControlError };
export interface ControlEventEnvelope { kind: "event"; version: 2; requestId: string; hostEpoch: string; event: DockEvent }

export interface HostInfoResult {
  state: "ready" | "mutation_faulted" | "draining";
  host: HostIdentity;
  catalog: { schemaVersion: number; revision: number; lastReconciledAt: string };
  paths: { socket: string; state: string };
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; source?: string }>;
}
export interface PingResult { pid: number; protocolVersion: 2; hostEpoch: string; capabilities: string[] }
export interface CreateResult { instance: InstanceSnapshot }
export interface EnsureResult { created: boolean; instance: InstanceSnapshot }
export interface KeyLookupResult { instance: InstanceSnapshot | null }
export type AdoptResult = CreateResult;
export interface InstanceListCursor { revision: number; offset: number; selector: "actionable" | "all" }
export interface ListResult {
  instances: InstanceSnapshot[];
  page: { revision: number; total: number; hiddenStopped: number; nextCursor?: InstanceListCursor };
}
export interface StatusResult { instance: InstanceSnapshot }
export interface AttachInitialDto {
  instance: InstanceSnapshot;
  page: EventPage & { epochChanged: boolean; generationChanged: boolean };
  recentHistory: HistoryEntryDto[];
  historyTruncated: boolean;
  pendingMessages: PendingMessageDto[];
  controller: { status: "acquired"; leaseToken: string; controllerId: string } | { status: "observing" | "unavailable" };
  following: boolean;
}
export type EventsResult = AttachInitialDto;
export interface InteractionRespondResult { interactionId: string; state: "resolved" | "already_resolved" }
export interface WidgetViewportResult { accepted: true }
export interface ToolsExpandedResult { instance: InstanceSnapshot }
export interface PromptResult { receipt: CommandReceipt; instance: InstanceSnapshot }
export interface AbortResult { instance: InstanceSnapshot }
export interface QueueDequeueResult { receipt: QueueDequeueReceipt; instance: InstanceSnapshot }
export interface StopResult { receipt: { operationId: string; alreadyStopped: boolean; cleanupErrors?: string[] }; instance: InstanceSnapshot }
export interface ForgetResult { receipt: { operationId: string; forgottenId: string; previousLifecycle: "stopped" | "host_lost" | "runtime_error"; piSessionFilesDeleted: 0 } }
export interface PruneResult { receipt: { operationId: string; selector: "stopped"; forgottenIds: string[]; forgottenCount: number; hasMore: boolean; piSessionFilesDeleted: 0 } }
export interface ReopenResult { operationId: string; previousLifecycle: "host_lost" | "runtime_error"; instance: InstanceSnapshot }
export interface ModelsResult { models: RuntimeModelInfo[]; availableThinkingLevels: RuntimeThinkingLevel[]; instance: InstanceSnapshot; total: number; truncated: boolean }
export interface ModelConfigurationResult { instance: InstanceSnapshot; settingsWrite: { persisted: true } }
export interface ThinkingConfigurationResult { actualLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[]; instance: InstanceSnapshot; settingsWrite: { persisted: true } }
export interface SessionsResult { sessions: SessionDto[]; total: number; truncated: boolean }
export interface SessionInventoryResult {
  sessions: SessionDto[];
  query: { cwd: string; scope: "cwd" | "all" };
  total: number;
  truncated: boolean;
  incomplete: boolean;
  diagnostics: Array<{ message: string; path?: string }>;
  diagnosticsTruncated: boolean;
}
export interface HistoryResult { entries: HistoryEntryDto[]; hasEarlier: boolean; nextBeforeEntryId?: string; instance: InstanceSnapshot }
export interface SessionReplacementResult { cancelled: boolean; instance: InstanceSnapshot }
export interface SessionNameResult { instance: InstanceSnapshot }
export interface SessionCompactionResult { result: { summary: string; firstKeptEntryId: string; tokensBefore: number }; instance: InstanceSnapshot }
export interface SessionReloadResult extends ResourcesResult { instance: InstanceSnapshot }
export interface SessionTreeResult { treeRevision: string; nodes: TreeNodeDto[]; leafId?: string; total: number; truncated: boolean; nextAfterEntryId?: string }
export interface SessionNavigateResult { cancelled: boolean; aborted?: boolean; editorText?: string; instance: InstanceSnapshot }
export interface SessionForkResult { cancelled: boolean; selectedText?: string; instance: InstanceSnapshot }
export interface SessionCloneResult { cancelled: boolean; instance: InstanceSnapshot }
export interface ToolsResult { tools: ToolDto[]; instance: InstanceSnapshot; total: number; truncated: boolean }
export interface SettingsResult { settings: SettingDto[] }
export interface SettingUpdateResult { setting: SettingDto; instance: InstanceSnapshot; reloadRequired: boolean; hostRestartRequired: boolean }
export interface ResourcesResult {
  resources: ResourceDto[];
  diagnostics: DiagnosticDto[];
  resourceTotal: number;
  resourcesTruncated: boolean;
  diagnosticTotal: number;
  diagnosticsTruncated: boolean;
}
export interface CommandsResult { commands: CommandDto[]; total: number; truncated: boolean }
export type ConfigurationResult = ModelConfigurationResult | ThinkingConfigurationResult | SettingUpdateResult;

export function implementedCapabilities(): string[] { return [...IMPLEMENTED_CAPABILITIES].sort(); }
export function capabilityForRequest(type: ControlRequest["type"]): Capability {
  if (type === "host.info") return "host.info";
  if (type === "instance.forget" || type === "catalog.prune") return "catalog.maintenance.v1";
  if (type === "extension.tools_expanded.set") return TOOLS_EXPANDED_CAPABILITY;
  if (type === "extension.widget_viewport.set") return EXTENSION_WIDGET_CAPABILITY;
  if (type === "interaction.respond") return "extension_ui.v1";
  if (type === "instance.reopen") return "session.reopen";
  if (type === "instance.adopt") return "session.adopt.v1";
  if (type === "instance.ensure" || type === "instance.get_by_key") return INSTANCE_KEYS_CAPABILITY;
  if (type.startsWith("instance.")) return type === "instance.attach" ? "events.follow" : "instance.catalog";
  if (type === "command.abort") return "run.abort.v1";
  if (type === "queue.dequeue") return "queue.control.v1";
  if (type === "session.history") return "tui.projection.v1";
  if (type === "session.inventory") return "session.inventory.v1";
  if (type === "session.tree" || type === "session.navigate" || type === "session.fork" || type === "session.clone") return "session.tree.v1";
  if (type === "command.submit" || type === "session.list") return "session.core";
  if (type.startsWith("session.")) return "session.commands.v1";
  if (type.startsWith("tool.")) return "tools.v1";
  if (type.startsWith("settings.")) return "settings.v1";
  if (type === "resource.get" || type === "command.catalog") return "resources.v1";
  return "models.v1";
}
export function requiredCapabilities(capability: Capability): string[] {
  return [...new Set<Capability>([
    "core.v2",
    ...(capability === "events.replay-purpose.v1" ? ["events.follow" as const] : []),
    ...(capabilityProjectsInstanceSnapshot(capability) ? [TOOLS_EXPANDED_CAPABILITY, GIT_BRANCH_CAPABILITY, INSTANCE_KEYS_CAPABILITY] : []),
    ...(capabilityProjectsToolResults(capability) ? [TOOL_RESULT_PRESENTATION_CAPABILITY] : []),
    capability,
  ])];
}

function capabilityProjectsToolResults(capability: Capability): boolean {
  return capability === "events.follow"
    || capability === "events.replay-purpose.v1"
    || capability === "tui.projection.v1"
    || capability === TOOL_RESULT_PRESENTATION_CAPABILITY;
}

function capabilityProjectsInstanceSnapshot(capability: Capability): boolean {
  return capability === TOOLS_EXPANDED_CAPABILITY
    || capability === GIT_BRANCH_CAPABILITY
    || capability === INSTANCE_KEYS_CAPABILITY
    || capability === "events.follow"
    || capability === "events.replay-purpose.v1"
    || capability === "instance.catalog"
    || capability === "models.v1"
    || capability === "queue.control.v1"
    || capability === "run.abort.v1"
    || capability === "session.adopt.v1"
    || capability === "session.commands.v1"
    || capability === "session.core"
    || capability === "session.reopen"
    || capability === "session.tree.v1"
    || capability === "settings.v1"
    || capability === "tools.v1"
    || capability === "tui.projection.v1";
}
export function createHelloAck(requestId: string, host: HostIdentity): HelloAck {
  return {
    kind: "hello_ack",
    requestId,
    version: 2,
    host,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    capabilities: implementedCapabilities(),
    limits: { maxLineBytes: MAX_CONTROL_LINE_BYTES, maxPromptChars: MAX_PROMPT_CHARS, maxReplayEvents: MAX_REPLAY_EVENTS, maxHistoryItems: MAX_HISTORY_ITEMS, maxInstanceListItems: MAX_INSTANCE_LIST_ITEMS, maxInstanceListBytes: MAX_INSTANCE_LIST_RESULT_BYTES },
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
  exact(limits, ["maxLineBytes", "maxPromptChars", "maxReplayEvents", "maxHistoryItems", "maxInstanceListItems", "maxInstanceListBytes"]);
  const capabilities = strings(value.capabilities, "hello_ack.capabilities", MAX_CAPABILITIES, MAX_CAPABILITY_CHARS);
  if (new Set(capabilities).size !== capabilities.length) throw validation("invalid_response", "hello_ack.capabilities must be unique");
  const catalogSchemaVersion = unsigned(value.catalogSchemaVersion, "hello_ack.catalogSchemaVersion");
  if (catalogSchemaVersion !== CATALOG_SCHEMA_VERSION) throw validation("protocol_incompatible", "Peer catalog schema is incompatible");
  return {
    kind: "hello_ack", requestId, version: 2,
    host: parseHost(value.host, "hello_ack.host"),
    catalogSchemaVersion,
    capabilities,
    limits: {
      maxLineBytes: positive(valueOr(limits.maxLineBytes), "limits.maxLineBytes"),
      maxPromptChars: positive(valueOr(limits.maxPromptChars), "limits.maxPromptChars"),
      maxReplayEvents: positive(valueOr(limits.maxReplayEvents), "limits.maxReplayEvents"),
      maxHistoryItems: positive(valueOr(limits.maxHistoryItems), "limits.maxHistoryItems"),
      maxInstanceListItems: positive(valueOr(limits.maxInstanceListItems), "limits.maxInstanceListItems"),
      maxInstanceListBytes: positive(valueOr(limits.maxInstanceListBytes), "limits.maxInstanceListBytes"),
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
    case "instance.create": {
      exact(params, ["operationId", "cwd", "name", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      return { ...base, type, params: { operationId: operationId(), cwd: string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request"), name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request"), trustChallengeId, projectTrustDecision } };
    }
    case "instance.ensure": {
      exact(params, ["operationId", "key", "cwd", "name", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const key = string(params.key, "params.key", MAX_INSTANCE_KEY_CHARS, "invalid_request");
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(key)) throw validation("invalid_request", "params.key must not contain control characters");
      return { ...base, type, params: {
        operationId: operationId(),
        key,
        cwd: string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request"),
        name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request"),
        trustChallengeId,
        projectTrustDecision,
      } };
    }
    case "instance.adopt": {
      exact(params, ["operationId", "sessionFile", "name", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const sessionFile = string(params.sessionFile, "params.sessionFile", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (!sessionFile.startsWith("/")) throw validation("invalid_request", "params.sessionFile must be absolute");
      return { ...base, type, params: { operationId: operationId(), sessionFile, name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request"), trustChallengeId, projectTrustDecision } };
    }
    case "instance.list": {
      exact(params, ["selector", "cursor", "limit"], "invalid_request");
      const selector = enumeration(params.selector, "params.selector", ["actionable", "all"], "invalid_request");
      const limit = positive(params.limit, "params.limit", "invalid_request");
      if (limit > MAX_INSTANCE_LIST_ITEMS) throw validation("invalid_request", `params.limit must not exceed ${MAX_INSTANCE_LIST_ITEMS}`);
      const cursor = params.cursor === undefined ? undefined : parseInstanceListCursor(params.cursor, "params.cursor", "invalid_request");
      if (cursor && cursor.selector !== selector) throw validation("invalid_request", "params.cursor selector does not match params.selector");
      return { ...base, type, params: { selector, cursor, limit } };
    };
    case "instance.get_by_key": {
      exact(params, ["key"], "invalid_request");
      const key = string(params.key, "params.key", MAX_INSTANCE_KEY_CHARS, "invalid_request");
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(key)) throw validation("invalid_request", "params.key must not contain control characters");
      return { ...base, type, params: { key } };
    }
    case "instance.get": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "instance.attach": {
      exact(params, ["instanceId", "since", "follow", "controller", "replay"], "invalid_request");
      const follow = boolean(params.follow, "params.follow", "invalid_request");
      const controller = enumeration(params.controller, "params.controller", ["claim", "observe"], "invalid_request");
      const replay = params.replay === undefined ? undefined : enumeration(params.replay, "params.replay", ["event_log", "conversation_bootstrap"], "invalid_request");
      const since = params.since === undefined ? undefined : parseCursor(params.since, "params.since", "invalid_request");
      if (controller === "claim" && !follow) throw validation("invalid_request", "controller claim requires a follow attach stream");
      if (replay === "conversation_bootstrap" && (since !== undefined || !follow)) throw validation("invalid_request", "conversation bootstrap requires a fresh follow stream without a cursor");
      return { ...base, type, params: { instanceId: instanceId(), since, follow, controller, ...(replay === undefined ? {} : { replay }) } };
    }
    case "instance.stop": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "instance.forget": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "catalog.prune": exact(params, ["operationId", "selector"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), selector: enumeration(params.selector, "params.selector", ["stopped"], "invalid_request") } };
    case "instance.reopen": {
      exact(params, ["operationId", "instanceId", "sessionFile", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const sessionFile = optionalString(params.sessionFile, "params.sessionFile", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (sessionFile !== undefined && !sessionFile.startsWith("/")) throw validation("invalid_request", "params.sessionFile must be absolute");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), sessionFile, trustChallengeId, projectTrustDecision } };
    }
    case "interaction.respond": {
      exact(params, ["operationId", "instanceId", "leaseToken", "interactionId", "response"], "invalid_request");
      return { ...base, type, params: {
        operationId: operationId(),
        instanceId: instanceId(),
        leaseToken: string(params.leaseToken, "params.leaseToken", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request"),
        interactionId: string(params.interactionId, "params.interactionId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request"),
        response: parseInteractionResponse(params.response, "params.response", "invalid_request"),
      } };
    }
    case "extension.tools_expanded.set":
      exact(params, ["operationId", "instanceId", "expectedRuntimeGeneration", "expanded"], "invalid_request");
      return { ...base, type, params: {
        operationId: operationId(),
        instanceId: instanceId(),
        expectedRuntimeGeneration: positive(params.expectedRuntimeGeneration, "params.expectedRuntimeGeneration", "invalid_request"),
        expanded: boolean(params.expanded, "params.expanded", "invalid_request"),
      } };
    case "extension.widget_viewport.set": {
      exact(params, ["instanceId", "leaseToken", "expectedRuntimeGeneration", "width", "height"], "invalid_request");
      const width = positive(params.width, "params.width", "invalid_request");
      const height = positive(params.height, "params.height", "invalid_request");
      if (width > 10_000 || height > 10_000) throw validation("invalid_request", "Extension widget viewport exceeds 10000 cells");
      return { ...base, type, params: {
        instanceId: instanceId(),
        leaseToken: string(params.leaseToken, "params.leaseToken", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request"),
        expectedRuntimeGeneration: positive(params.expectedRuntimeGeneration, "params.expectedRuntimeGeneration", "invalid_request"),
        width,
        height,
      } };
    }
    case "command.submit": {
      exact(params, ["operationId", "instanceId", "message", "images", "delivery"], "invalid_request");
      const message = boundedString(params.message, "params.message", MAX_PROMPT_CHARS, "invalid_request");
      const images = params.images === undefined ? undefined : parseImagePaths(params.images, "params.images", "invalid_request");
      if (message.trim().length === 0 && (images === undefined || images.length === 0)) throw validation("invalid_request", "command.submit requires message text or at least one image");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), message, ...(images === undefined ? {} : { images }), delivery: enumeration(params.delivery, "params.delivery", ["auto", "prompt", "steer", "followUp"], "invalid_request") } };
    }
    case "command.abort": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "queue.dequeue": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "model.list": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "model.set": exact(params, ["operationId", "instanceId", "provider", "modelId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), provider: string(params.provider, "params.provider", MAX_MODEL_PROVIDER_CHARS, "invalid_request"), modelId: string(params.modelId, "params.modelId", MAX_MODEL_ID_CHARS, "invalid_request") } };
    case "thinking.set": exact(params, ["operationId", "instanceId", "level"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), level: enumeration(params.level, "params.level", THINKING_LEVELS, "invalid_request") } };
    case "tool.list": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "tool.set_active": { exact(params, ["operationId", "instanceId", "names"], "invalid_request"); const names = strings(params.names, "params.names", MAX_COLLECTION, 256, "invalid_request"); if (new Set(names).size !== names.length) throw validation("invalid_request", "params.names must be unique"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), names } }; }
    case "settings.get": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "settings.update": exact(params, ["operationId", "instanceId", "update"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), update: parseSettingUpdate(params.update, "params.update", "invalid_request") } };
    case "resource.get": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "command.catalog": exact(params, ["instanceId", "prefix"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId(), prefix: optionalString(params.prefix, "params.prefix", 256, "invalid_request") } };
    case "session.history": {
      exact(params, ["instanceId", "beforeEntryId", "limit"], "invalid_request");
      if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > MAX_HISTORY_ITEMS) throw validation("invalid_request", `params.limit must be between 1 and ${MAX_HISTORY_ITEMS}`);
      return { ...base, type, params: { instanceId: instanceId(), beforeEntryId: optionalString(params.beforeEntryId, "params.beforeEntryId", 128, "invalid_request"), limit: params.limit as number } };
    }
    case "session.inventory": {
      exact(params, ["cwd", "scope"], "invalid_request");
      const cwd = string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (!cwd.startsWith("/")) throw validation("invalid_request", "params.cwd must be absolute");
      return { ...base, type, params: { cwd, scope: enumeration(params.scope, "params.scope", ["cwd", "all"], "invalid_request") } };
    }
    case "session.list": exact(params, ["instanceId", "scope"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId(), scope: enumeration(params.scope, "params.scope", ["cwd", "all"], "invalid_request") } };
    case "session.switch": {
      exact(params, ["operationId", "instanceId", "sessionFile", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), sessionFile: string(params.sessionFile, "params.sessionFile", MAX_CONTROL_CWD_CHARS, "invalid_request"), trustChallengeId, projectTrustDecision } };
    }
    case "session.new": exact(params, ["operationId", "instanceId", "parentSession"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), parentSession: optionalString(params.parentSession, "params.parentSession", MAX_CONTROL_CWD_CHARS, "invalid_request") } };
    case "session.name": exact(params, ["operationId", "instanceId", "name"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), name: boundedString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request") } };
    case "session.compact": exact(params, ["operationId", "instanceId", "customInstructions"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), customInstructions: optionalString(params.customInstructions, "params.customInstructions", MAX_PROMPT_CHARS, "invalid_request") } };
    case "session.reload": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "session.tree": {
      exact(params, ["instanceId", "treeRevision", "afterEntryId", "limit"], "invalid_request");
      if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > MAX_HISTORY_ITEMS) throw validation("invalid_request", `params.limit must be between 1 and ${MAX_HISTORY_ITEMS}`);
      const treeRevision = optionalString(params.treeRevision, "params.treeRevision", 128, "invalid_request");
      const afterEntryId = optionalString(params.afterEntryId, "params.afterEntryId", 128, "invalid_request");
      if ((treeRevision === undefined) !== (afterEntryId === undefined)) throw validation("invalid_request", "Tree continuation requires both treeRevision and afterEntryId");
      return { ...base, type, params: { instanceId: instanceId(), treeRevision, afterEntryId, limit: params.limit as number } };
    }
    case "session.navigate": {
      exact(params, ["operationId", "instanceId", "targetId", "summarize", "customInstructions", "replaceInstructions", "label"], "invalid_request");
      const summarize = optionalBoolean(params.summarize, "params.summarize", "invalid_request");
      const customInstructions = optionalString(params.customInstructions, "params.customInstructions", MAX_PROMPT_CHARS, "invalid_request");
      const replaceInstructions = optionalBoolean(params.replaceInstructions, "params.replaceInstructions", "invalid_request");
      const label = optionalString(params.label, "params.label", MAX_INSTANCE_NAME_CHARS, "invalid_request");
      if (summarize !== true && (customInstructions !== undefined || replaceInstructions !== undefined || label !== undefined)) throw validation("invalid_request", "Navigation summary options require summarize=true");
      if (replaceInstructions === true && customInstructions === undefined) throw validation("invalid_request", "replaceInstructions=true requires customInstructions");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), targetId: id(params.targetId, "params.targetId", "invalid_request"), summarize, customInstructions, replaceInstructions, label } };
    }
    case "session.fork": {
      exact(params, ["operationId", "instanceId", "entryId"], "invalid_request");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), entryId: id(params.entryId, "params.entryId", "invalid_request") } };
    }
    case "session.clone": {
      exact(params, ["operationId", "instanceId", "entryId"], "invalid_request");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), entryId: id(params.entryId, "params.entryId", "invalid_request") } };
    }
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
  if (code === "stale_runtime_generation" && error.details === undefined) throw validation("invalid_response", "stale_runtime_generation requires error details");
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
  if(code==="effect_unknown"||code==="operation_receipt_expired") { exact(details,["operationId","queryHint"]); return {operationId:id(details.operationId,"error.details.operationId"),queryHint:string(details.queryHint,"error.details.queryHint",256)}; }
  if(code==="instance_busy") { exact(details,["lifecycle","execution"]); return {lifecycle:enumeration(details.lifecycle,"error.details.lifecycle",["active","stopping","stopped","host_lost","runtime_error"]),execution:enumeration(details.execution,"error.details.execution",["idle","running","failed","unavailable"])}; }
  if(code==="stale_runtime_generation") { exact(details,["expectedRuntimeGeneration","actualRuntimeGeneration"]); return {expectedRuntimeGeneration:positive(details.expectedRuntimeGeneration,"error.details.expectedRuntimeGeneration"),actualRuntimeGeneration:positive(details.actualRuntimeGeneration,"error.details.actualRuntimeGeneration")}; }
  if(code==="project_trust_required") {
    exact(details,["challengeId","operationId","cwd","choices","expiresAt"]);
    const expected=["trust_once","trust_and_remember","deny_once","deny_and_remember"] as const;
    const choices=strings(details.choices,"error.details.choices",4,64).map((choice)=>enumeration(choice,"error.details.choice",expected));
    if(choices.length!==expected.length||new Set(choices).size!==expected.length||expected.some((choice)=>!choices.includes(choice)))throw validation("invalid_response","Project trust choices are incomplete or duplicated");
    return {challengeId:id(details.challengeId,"error.details.challengeId"),operationId:id(details.operationId,"error.details.operationId"),cwd:string(details.cwd,"error.details.cwd",MAX_CONTROL_CWD_CHARS),choices,expiresAt:timestamp(details.expiresAt,"error.details.expiresAt")};
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
  const schemaVersion = unsigned(catalog.schemaVersion, "catalog.schemaVersion");
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) throw validation("invalid_response", "Host info catalog schema is incompatible");
  return { state: enumeration(value.state, "state", ["ready", "mutation_faulted", "draining"]), host: parseHost(value.host, "host"), catalog: { schemaVersion, revision: unsigned(catalog.revision, "catalog.revision"), lastReconciledAt: timestamp(catalog.lastReconciledAt, "catalog.lastReconciledAt") }, paths: { socket: string(paths.socket, "paths.socket", MAX_CONTROL_CWD_CHARS), state: string(paths.state, "paths.state", MAX_CONTROL_CWD_CHARS) }, diagnostics };
}
export function parseCreateResult(input: unknown): CreateResult { const value = object(input, "create result"); exact(value, ["instance"]); return { instance: parseInstance(value.instance, "instance") }; }
export function parseEnsureResult(input: unknown): EnsureResult {
  const value = object(input, "ensure result"); exact(value, ["created", "instance"]);
  return { created: boolean(value.created, "created"), instance: parseInstance(value.instance, "instance") };
}
export function parseKeyLookupResult(input: unknown): KeyLookupResult {
  const value = object(input, "instance key lookup result"); exact(value, ["instance"]);
  return { instance: value.instance === null ? null : parseInstance(value.instance, "instance") };
}
export function parseListResult(input: unknown): ListResult {
  const value = object(input, "list result"); exact(value, ["instances", "page"]);
  const instances = array(value.instances, "instances", MAX_INSTANCE_LIST_ITEMS).map((item, index) => parseInstance(item, `instances[${index}]`));
  const page = object(value.page, "page"); exact(page, ["revision", "total", "hiddenStopped", "nextCursor"]);
  const revision = unsigned(page.revision, "page.revision");
  const total = unsigned(page.total, "page.total");
  const hiddenStopped = unsigned(page.hiddenStopped, "page.hiddenStopped");
  const nextCursor = page.nextCursor === undefined ? undefined : parseInstanceListCursor(page.nextCursor, "page.nextCursor");
  if (instances.length > total) throw validation("invalid_response", "List page cannot contain more instances than total");
  if (nextCursor && (instances.length === 0 || nextCursor.revision !== revision || nextCursor.offset < instances.length || nextCursor.offset > total)) {
    throw validation("invalid_response", "List next cursor is inconsistent with its page");
  }
  return { instances, page: { revision, total, hiddenStopped, nextCursor } };
}
export function parseStatusResult(input: unknown): StatusResult { const value = object(input, "get result"); exact(value, ["instance"]); return { instance: parseInstance(value.instance, "instance") }; }
export function parseEventsResult(input: unknown): EventsResult {
  const value = object(input, "attach result"); exact(value, ["instance", "page", "recentHistory", "historyTruncated", "pendingMessages", "controller", "following"]);
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
  const history = array(value.recentHistory, "recentHistory", MAX_HISTORY_ITEMS).map((item, index) => parseHistoryEntry(item, `recentHistory[${index}]`));
  if (new Set(history.map((entry) => entry.entryId)).size !== history.length) throw validation("invalid_response", "recentHistory entry IDs must be unique");
  const pendingMessages = array(value.pendingMessages, "pendingMessages", MAX_PENDING_QUEUE_ITEMS).map((item, index) => parsePendingMessage(item, `pendingMessages[${index}]`));
  if (new Set(pendingMessages.map((item) => item.queueItemId)).size !== pendingMessages.length) throw validation("invalid_response", "pendingMessages queue item IDs must be unique");
  if (pendingMessages.reduce((total, item) => total + item.text.length, 0) > MAX_PENDING_QUEUE_TEXT_CHARS) throw validation("invalid_response", "pendingMessages text exceeds the aggregate queue limit");
  if (pendingMessages.reduce((total, item) => total + imagePathCharacters(item.images), 0) > MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS) throw validation("invalid_response", "pendingMessages image descriptors exceed the aggregate queue limit");
  const firstFollowUp = pendingMessages.findIndex((item) => item.delivery === "followUp");
  if (firstFollowUp >= 0 && pendingMessages.slice(firstFollowUp).some((item) => item.delivery === "steer")) throw validation("invalid_response", "pendingMessages are not in consumption order");
  const controller = object(value.controller, "controller");
  const controllerStatus = enumeration(controller.status, "controller.status", ["acquired", "observing", "unavailable"]);
  if (controllerStatus === "acquired") {
    exact(controller, ["status", "leaseToken", "controllerId"]);
    return { instance, page: { events, earliest, latest, truncated: boolean(page.truncated, "page.truncated"), epochChanged: boolean(page.epochChanged, "page.epochChanged"), generationChanged: boolean(page.generationChanged, "page.generationChanged") }, recentHistory: history, historyTruncated: boolean(value.historyTruncated, "historyTruncated"), pendingMessages, controller: { status: controllerStatus, leaseToken: id(controller.leaseToken, "controller.leaseToken"), controllerId: id(controller.controllerId, "controller.controllerId") }, following: boolean(value.following, "following") };
  }
  exact(controller, ["status"]);
  return { instance, page: { events, earliest, latest, truncated: boolean(page.truncated, "page.truncated"), epochChanged: boolean(page.epochChanged, "page.epochChanged"), generationChanged: boolean(page.generationChanged, "page.generationChanged") }, recentHistory: history, historyTruncated: boolean(value.historyTruncated, "historyTruncated"), pendingMessages, controller: { status: controllerStatus }, following: boolean(value.following, "following") };
}
export function parseInteractionRespondResult(input: unknown): InteractionRespondResult {
  const value = object(input, "interaction response result");
  exact(value, ["interactionId", "state"]);
  return { interactionId: id(value.interactionId, "interactionId"), state: enumeration(value.state, "state", ["resolved", "already_resolved"]) };
}
export function parseWidgetViewportResult(input: unknown): WidgetViewportResult {
  const value = object(input, "extension widget viewport result");
  exact(value, ["accepted"]);
  if (boolean(value.accepted, "accepted") !== true) throw validation("invalid_response", "Extension widget viewport was not accepted");
  return { accepted: true };
}
export function parsePromptResult(input: unknown): PromptResult {
  const value = object(input, "prompt result"); exact(value, ["receipt", "instance"]);
  const instance = parseInstance(value.instance, "instance"); const receipt = parseReceipt(value.receipt);
  const promptOperationMismatch = receipt.kind === "prompt"
    && instance.activeCommandId !== undefined
    && !receipt.queued
    && instance.activeCommandId !== receipt.operationId;
  if (receipt.instanceId !== instance.id || promptOperationMismatch) throw validation("invalid_response", "Command receipt does not match instance state");
  return { receipt, instance };
}
export function parseReopenResult(input: unknown): ReopenResult {
  const value = object(input, "reopen result");
  exact(value, ["operationId", "previousLifecycle", "instance"]);
  const instance = parseInstance(value.instance, "instance");
  const previousLifecycle = enumeration(value.previousLifecycle, "previousLifecycle", ["host_lost", "runtime_error"]);
  const operationId = id(value.operationId, "operationId");
  if (instance.lifecycle !== "active" || instance.execution !== "idle" || instance.lastRun !== "never" || instance.runtimeGeneration < 2) {
    throw validation("invalid_response", "Reopen result must expose a fresh active generation");
  }
  return { operationId, previousLifecycle, instance };
}
export function parseAbortResult(input: unknown): AbortResult {
  const value = object(input, "abort result"); exact(value, ["instance"]);
  const instance = parseInstance(value.instance, "instance");
  if (instance.execution === "running") throw validation("invalid_response", "Abort result instance must not still be running");
  return { instance };
}
export function parseQueueDequeueResult(input: unknown): QueueDequeueResult {
  const value = object(input, "queue dequeue result"); exact(value, ["receipt", "instance"]);
  const receipt = object(value.receipt, "receipt"); exact(receipt, ["operationId", "instanceId", "restored", "inFlight"]);
  const instance = parseInstance(value.instance, "instance");
  const operationId = id(receipt.operationId, "receipt.operationId");
  const instanceId = id(receipt.instanceId, "receipt.instanceId");
  if (instanceId !== instance.id) throw validation("invalid_response", "Queue dequeue receipt does not match instance");
  if (instance.pending.total !== 0) throw validation("invalid_response", "Queue dequeue result must expose an empty queue");
  const restored = array(receipt.restored, "receipt.restored", MAX_PENDING_QUEUE_ITEMS).map((item, index) => parsePendingMessage(item, `receipt.restored[${index}]`));
  const inFlight = array(receipt.inFlight, "receipt.inFlight", MAX_PENDING_QUEUE_ITEMS).map((item, index) => parsePendingMessage(item, `receipt.inFlight[${index}]`));
  const all = [...restored, ...inFlight];
  if (all.length > MAX_PENDING_QUEUE_ITEMS || new Set(all.map((item) => item.queueItemId)).size !== all.length) throw validation("invalid_response", "Queue dequeue item IDs must be unique and bounded");
  if (all.reduce((total, item) => total + item.text.length, 0) > MAX_PENDING_QUEUE_TEXT_CHARS) throw validation("invalid_response", "Queue dequeue text exceeds the aggregate queue limit");
  if (all.reduce((total, item) => total + imagePathCharacters(item.images), 0) > MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS) throw validation("invalid_response", "Queue dequeue image descriptors exceed the aggregate queue limit");
  for (const [field, items] of [["restored", restored], ["inFlight", inFlight]] as const) {
    const firstFollowUp = items.findIndex((item) => item.delivery === "followUp");
    if (firstFollowUp >= 0 && items.slice(firstFollowUp).some((item) => item.delivery === "steer")) throw validation("invalid_response", `Queue dequeue ${field} items are not in consumption order`);
  }
  return { receipt: { operationId, instanceId, restored, inFlight }, instance };
}
export function parseStopResult(input: unknown): StopResult {
  const value = object(input, "stop result"); exact(value, ["receipt", "instance"]);
  const receipt = object(value.receipt, "receipt"); exact(receipt, ["operationId", "alreadyStopped", "cleanupErrors"]);
  const instance = parseInstance(value.instance, "instance");
  if (instance.lifecycle !== "stopped") throw validation("invalid_response", "Stop result instance must be stopped");
  return { receipt: { operationId: id(receipt.operationId, "receipt.operationId"), alreadyStopped: boolean(receipt.alreadyStopped, "receipt.alreadyStopped"), cleanupErrors: receipt.cleanupErrors === undefined ? undefined : strings(receipt.cleanupErrors, "receipt.cleanupErrors", 100, MAX_MESSAGE) }, instance };
}
export function parseForgetResult(input: unknown): ForgetResult {
  const value = object(input, "forget result"); exact(value, ["receipt"]);
  const receipt = object(value.receipt, "receipt");
  exact(receipt, ["operationId", "forgottenId", "previousLifecycle", "piSessionFilesDeleted"]);
  const piSessionFilesDeleted = unsigned(receipt.piSessionFilesDeleted, "receipt.piSessionFilesDeleted");
  if (piSessionFilesDeleted !== 0) throw validation("invalid_response", "Forget must not delete Pi session files");
  return { receipt: {
    operationId: id(receipt.operationId, "receipt.operationId"),
    forgottenId: id(receipt.forgottenId, "receipt.forgottenId"),
    previousLifecycle: enumeration(receipt.previousLifecycle, "receipt.previousLifecycle", ["stopped", "host_lost", "runtime_error"]),
    piSessionFilesDeleted: 0,
  } };
}
export function parsePruneResult(input: unknown): PruneResult {
  const value = object(input, "prune result"); exact(value, ["receipt"]);
  const receipt = object(value.receipt, "receipt");
  exact(receipt, ["operationId", "selector", "forgottenIds", "forgottenCount", "hasMore", "piSessionFilesDeleted"]);
  const forgottenIds = strings(receipt.forgottenIds, "receipt.forgottenIds", MAX_CATALOG_PRUNE_ITEMS, MAX_INSTANCE_ID_CHARS);
  if (new Set(forgottenIds).size !== forgottenIds.length) throw validation("invalid_response", "Prune forgotten IDs must be unique");
  const forgottenCount = unsigned(receipt.forgottenCount, "receipt.forgottenCount");
  if (forgottenCount !== forgottenIds.length) throw validation("invalid_response", "Prune forgottenCount must match forgottenIds");
  const piSessionFilesDeleted = unsigned(receipt.piSessionFilesDeleted, "receipt.piSessionFilesDeleted");
  if (piSessionFilesDeleted !== 0) throw validation("invalid_response", "Prune must not delete Pi session files");
  return { receipt: {
    operationId: id(receipt.operationId, "receipt.operationId"),
    selector: enumeration(receipt.selector, "receipt.selector", ["stopped"]),
    forgottenIds,
    forgottenCount,
    hasMore: boolean(receipt.hasMore, "receipt.hasMore"),
    piSessionFilesDeleted: 0,
  } };
}
export function parseModelsResult(input: unknown): ModelsResult {
  const value = object(input, "models result"); exact(value, ["models", "availableThinkingLevels", "instance", "total", "truncated"]);
  const models = array(value.models, "models", MAX_COLLECTION).map((item, index) => { const model = object(item, `models[${index}]`); exact(model, ["provider", "id", "name", "reasoning", "contextWindow"]); return { provider: string(model.provider, "provider", MAX_MODEL_PROVIDER_CHARS), id: string(model.id, "id", MAX_MODEL_ID_CHARS), name: string(model.name, "name", 256), reasoning: boolean(model.reasoning, "reasoning"), contextWindow: model.contextWindow === undefined ? undefined : positive(model.contextWindow, "contextWindow") }; });
  const completeness = parseCollectionCompleteness(value, models.length);
  return { models, availableThinkingLevels: thinkingLevels(value.availableThinkingLevels), instance: parseInstance(value.instance, "instance"), ...completeness };
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
  const value = object(input, "sessions result"); exact(value, ["sessions", "total", "truncated"]);
  const sessions = parseSessionDtos(value.sessions);
  return { sessions, ...parseCollectionCompleteness(value, sessions.length) };
}

export function parseSessionInventoryResult(input: unknown): SessionInventoryResult {
  const value = object(input, "session inventory result");
  exact(value, ["sessions", "query", "total", "truncated", "incomplete", "diagnostics", "diagnosticsTruncated"]);
  const query = object(value.query, "query"); exact(query, ["cwd", "scope"]);
  const sessions = parseSessionDtos(value.sessions);
  const total = unsigned(value.total, "total");
  const truncated = boolean(value.truncated, "truncated");
  const diagnostics = value.diagnostics === undefined ? [] : array(value.diagnostics, "diagnostics", 100).map((item, index) => {
    const diagnostic = object(item, `diagnostics[${index}]`); exact(diagnostic, ["message", "path"]);
    return {
      message: string(diagnostic.message, `diagnostics[${index}].message`, MAX_MESSAGE),
      ...(diagnostic.path === undefined ? {} : { path: string(diagnostic.path, `diagnostics[${index}].path`, MAX_CONTROL_CWD_CHARS) }),
    };
  });
  const incomplete = value.incomplete === undefined ? false : boolean(value.incomplete, "incomplete");
  const diagnosticsTruncated = value.diagnosticsTruncated === undefined ? false : boolean(value.diagnosticsTruncated, "diagnosticsTruncated");
  if (total < sessions.length || truncated !== (sessions.length < total)) throw validation("invalid_response", "Session inventory truncation metadata is inconsistent");
  if (!incomplete && (diagnostics.length > 0 || diagnosticsTruncated)) throw validation("invalid_response", "Complete session inventory cannot carry scan diagnostics");
  return {
    sessions,
    query: {
      cwd: string(query.cwd, "query.cwd", MAX_CONTROL_CWD_CHARS),
      scope: enumeration(query.scope, "query.scope", ["cwd", "all"]),
    },
    total,
    truncated,
    incomplete,
    diagnostics,
    diagnosticsTruncated,
  };
}

function parseSessionDtos(input: unknown): SessionDto[] {
  const sessions = array(input, "sessions", MAX_COLLECTION).map((item, index) => {
    const session = object(item, `sessions[${index}]`); exact(session, ["sessionId", "sessionFile", "name", "cwd", "updatedAt"]);
    return {
      sessionId: id(session.sessionId, `sessions[${index}].sessionId`),
      sessionFile: string(session.sessionFile, `sessions[${index}].sessionFile`, MAX_CONTROL_CWD_CHARS),
      name: optionalString(session.name, `sessions[${index}].name`, MAX_INSTANCE_NAME_CHARS),
      cwd: string(session.cwd, `sessions[${index}].cwd`, MAX_CONTROL_CWD_CHARS),
      updatedAt: session.updatedAt === undefined ? undefined : timestamp(session.updatedAt, `sessions[${index}].updatedAt`),
    };
  });
  if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) throw validation("invalid_response", "Session IDs must be unique");
  if (new Set(sessions.map((session) => session.sessionFile)).size !== sessions.length) throw validation("invalid_response", "Session files must be unique");
  return sessions;
}

export function parseHistoryResult(input: unknown): HistoryResult {
  const value = object(input, "history result"); exact(value, ["entries", "hasEarlier", "nextBeforeEntryId", "instance"]);
  const entries = array(value.entries, "entries", MAX_HISTORY_ITEMS).map((item, index) => parseHistoryEntry(item, `entries[${index}]`));
  const ids = entries.map((entry) => entry.entryId);
  if (new Set(ids).size !== ids.length) throw validation("invalid_response", "history entry IDs must be unique");
  const hasEarlier = boolean(value.hasEarlier, "hasEarlier");
  const nextBeforeEntryId = optionalString(value.nextBeforeEntryId, "nextBeforeEntryId", 128);
  if (hasEarlier !== (nextBeforeEntryId !== undefined)) throw validation("invalid_response", "history pagination cursor is inconsistent");
  if (nextBeforeEntryId !== undefined && entries[0]?.entryId !== nextBeforeEntryId) throw validation("invalid_response", "history cursor must identify the first returned entry");
  return { entries, hasEarlier, nextBeforeEntryId, instance: parseInstance(value.instance, "instance") };
}

export function parseSessionReplacementResult(input: unknown): SessionReplacementResult {
  const value = object(input, "session replacement result"); exact(value, ["cancelled", "instance"]);
  const instance = parseInstance(value.instance, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", "Session replacement success requires an active instance");
  return { cancelled: boolean(value.cancelled, "cancelled"), instance };
}
export function parseSessionNameResult(input: unknown): SessionNameResult {
  const value = object(input, "session name result"); exact(value, ["instance"]);
  const instance = parseInstance(value.instance, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", "Session name success requires an active instance");
  return { instance };
}
export function parseSessionCompactionResult(input: unknown): SessionCompactionResult {
  const value = object(input, "session compaction result"); exact(value, ["result", "instance"]);
  const result = object(value.result, "result"); exact(result, ["summary", "firstKeptEntryId", "tokensBefore"]);
  return {
    result: {
      summary: boundedString(result.summary, "result.summary", MAX_TEXT),
      firstKeptEntryId: id(result.firstKeptEntryId, "result.firstKeptEntryId"),
      tokensBefore: unsigned(result.tokensBefore, "result.tokensBefore"),
    },
    instance: parseActiveSessionInstance(value.instance, "Session compaction"),
  };
}
export function parseSessionReloadResult(input: unknown): SessionReloadResult {
  const value = object(input, "session reload result");
  exact(value, ["instance", "resources", "diagnostics", "resourceTotal", "resourcesTruncated", "diagnosticTotal", "diagnosticsTruncated"]);
  const projected = parseResourcesResult({
    resources: value.resources,
    diagnostics: value.diagnostics,
    resourceTotal: value.resourceTotal,
    resourcesTruncated: value.resourcesTruncated,
    diagnosticTotal: value.diagnosticTotal,
    diagnosticsTruncated: value.diagnosticsTruncated,
  });
  return { instance: parseActiveSessionInstance(value.instance, "Session reload"), ...projected };
}

export function parseSessionTreeResult(input: unknown): SessionTreeResult {
  const value = object(input, "session tree result");
  exact(value, ["treeRevision", "nodes", "leafId", "total", "truncated", "nextAfterEntryId"]);
  const treeRevision = id(value.treeRevision, "treeRevision");
  const nodes = array(value.nodes, "nodes", MAX_HISTORY_ITEMS).map((item, index) => parseTreeNode(item, `nodes[${index}]`));
  if (new Set(nodes.map((node) => node.entryId)).size !== nodes.length) throw validation("invalid_response", "Tree page entry IDs must be unique");
  const leafId = optionalString(value.leafId, "leafId", 128);
  const total = unsigned(value.total, "total");
  if (total > 100_000) throw validation("invalid_response", "Tree total exceeds 100000 entries");
  if (total < nodes.length) throw validation("invalid_response", "Tree total cannot be smaller than the returned page");
  const truncated = boolean(value.truncated, "truncated");
  const nextAfterEntryId = optionalString(value.nextAfterEntryId, "nextAfterEntryId", 128);
  if (truncated !== (nextAfterEntryId !== undefined)) throw validation("invalid_response", "Tree pagination cursor is inconsistent");
  if (nextAfterEntryId !== undefined && nodes.at(-1)?.entryId !== nextAfterEntryId) throw validation("invalid_response", "Tree cursor must identify the last returned entry");
  if (truncated && nodes.length === 0) throw validation("invalid_response", "A truncated tree page cannot be empty");
  return { treeRevision, nodes, ...(leafId === undefined ? {} : { leafId }), total, truncated, ...(nextAfterEntryId === undefined ? {} : { nextAfterEntryId }) };
}

export function parseSessionNavigateResult(input: unknown): SessionNavigateResult {
  const value = object(input, "session navigate result");
  exact(value, ["cancelled", "aborted", "editorText", "instance"]);
  const cancelled = boolean(value.cancelled, "cancelled");
  const aborted = value.aborted === undefined ? undefined : boolean(value.aborted, "aborted");
  const editorText = value.editorText === undefined ? undefined : payloadFreeBoundedString(value.editorText, "editorText", MAX_PROMPT_CHARS);
  if (aborted === true && !cancelled) throw validation("invalid_response", "Aborted navigation must be cancelled");
  if (cancelled && editorText !== undefined) throw validation("invalid_response", "Cancelled navigation cannot return editor text");
  return { cancelled, ...(aborted === undefined ? {} : { aborted }), ...(editorText === undefined ? {} : { editorText }), instance: parseActiveSessionInstance(value.instance, "Session navigation") };
}

export function parseSessionForkResult(input: unknown): SessionForkResult {
  const value = object(input, "session fork result");
  exact(value, ["cancelled", "selectedText", "instance"]);
  const cancelled = boolean(value.cancelled, "cancelled");
  const selectedText = value.selectedText === undefined ? undefined : payloadFreeBoundedString(value.selectedText, "selectedText", MAX_PROMPT_CHARS);
  if (cancelled && selectedText !== undefined) throw validation("invalid_response", "Cancelled fork cannot return selected text");
  if (!cancelled && selectedText === undefined) throw validation("invalid_response", "Completed fork must return selected text");
  return { cancelled, ...(selectedText === undefined ? {} : { selectedText }), instance: parseActiveSessionInstance(value.instance, "Session fork") };
}

export function parseSessionCloneResult(input: unknown): SessionCloneResult {
  const value = object(input, "session clone result");
  exact(value, ["cancelled", "instance"]);
  return { cancelled: boolean(value.cancelled, "cancelled"), instance: parseActiveSessionInstance(value.instance, "Session clone") };
}

function parseTreeNode(input: unknown, field: string): TreeNodeDto {
  const node = object(input, field);
  exact(node, ["entryId", "parentId", "depth", "kind", "role", "displayClass", "state", "label", "timestamp", "summary", "hasChildren"]);
  const kind = enumeration(node.kind, `${field}.kind`, ["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  const role = node.role === undefined ? undefined : enumeration(node.role, `${field}.role`, ["user", "assistant", "tool", "system"]);
  const displayClass = enumeration(node.displayClass, `${field}.displayClass`, ["content", "tool", "metadata", "structural"]);
  const state = node.state === undefined ? undefined : enumeration(node.state, `${field}.state`, ["error", "aborted"]);
  if ((kind === "message") !== (role !== undefined)) throw validation("invalid_response", `${field} message role invariant failed`);
  if (role === "tool" && displayClass !== "tool") throw validation("invalid_response", `${field} tool display class invariant failed`);
  if (state !== undefined && role !== "assistant" && role !== "tool") throw validation("invalid_response", `${field} state invariant failed`);
  const depth = unsigned(node.depth, `${field}.depth`);
  if (depth > 100_000) throw validation("invalid_response", `${field}.depth exceeds 100000`);
  return {
    entryId: id(node.entryId, `${field}.entryId`),
    ...(node.parentId === undefined ? {} : { parentId: id(node.parentId, `${field}.parentId`) }),
    depth,
    kind,
    ...(role === undefined ? {} : { role }),
    displayClass,
    ...(state === undefined ? {} : { state }),
    ...(node.label === undefined ? {} : { label: payloadFreeString(node.label, `${field}.label`, MAX_INSTANCE_NAME_CHARS) }),
    ...(node.timestamp === undefined ? {} : { timestamp: timestamp(node.timestamp, `${field}.timestamp`) }),
    summary: payloadFreeString(node.summary, `${field}.summary`, MAX_MESSAGE),
    hasChildren: boolean(node.hasChildren, `${field}.hasChildren`),
  };
}

function parseActiveSessionInstance(input: unknown, operation: string): InstanceSnapshot {
  const instance = parseInstance(input, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", `${operation} success requires an active instance`);
  return instance;
}

export function parseToolsResult(input: unknown): ToolsResult {
  const value = object(input, "tools result"); exact(value, ["tools", "instance", "total", "truncated"]);
  const tools = array(value.tools, "tools", MAX_COLLECTION).map((item, index) => parseTool(item, `tools[${index}]`));
  assertSorted(tools, "tools", compareToolDtos);
  return { tools, instance: parseInstance(value.instance, "instance"), ...parseCollectionCompleteness(value, tools.length) };
}
export function parseSettingsResult(input: unknown): SettingsResult {
  const value = object(input, "settings result"); exact(value, ["settings"]);
  const settings = array(value.settings, "settings", SETTING_KEYS.length).map((item, index) => parseSettingDto(item, `settings[${index}]`));
  if (settings.length !== SETTING_KEYS.length || settings.some((setting, index) => setting.key !== SETTING_KEYS[index])) throw validation("invalid_response", `settings must contain all ${SETTING_KEYS.length} keys in canonical order`);
  return { settings };
}
export function parseSettingUpdateResult(input: unknown): SettingUpdateResult {
  const value = object(input, "setting update result"); exact(value, ["setting", "instance", "reloadRequired", "hostRestartRequired"]);
  const setting = parseSettingDto(value.setting, "setting");
  const reloadRequired = boolean(value.reloadRequired, "reloadRequired");
  const hostRestartRequired = boolean(value.hostRestartRequired, "hostRestartRequired");
  if (reloadRequired !== setting.reloadRequired || hostRestartRequired !== setting.hostRestartRequired) throw validation("invalid_response", "setting update metadata is inconsistent");
  return { setting, instance: parseInstance(value.instance, "instance"), reloadRequired, hostRestartRequired };
}
export function parseResourcesResult(input: unknown): ResourcesResult {
  const value = object(input, "resources result");
  exact(value, ["resources", "diagnostics", "resourceTotal", "resourcesTruncated", "diagnosticTotal", "diagnosticsTruncated"]);
  const resources = array(value.resources, "resources", MAX_COLLECTION).map((item, index) => parseResource(item, `resources[${index}]`));
  const diagnostics = array(value.diagnostics, "diagnostics", MAX_COLLECTION).map((item, index) => parseDiagnostic(item, `diagnostics[${index}]`));
  assertSorted(resources, "resources", compareResourceDtos);
  assertSorted(diagnostics, "diagnostics", compareDiagnosticDtos);
  const resourceCompleteness = parseCollectionCompleteness(value, resources.length, "resourceTotal", "resourcesTruncated");
  const diagnosticCompleteness = parseCollectionCompleteness(value, diagnostics.length, "diagnosticTotal", "diagnosticsTruncated");
  return {
    resources,
    diagnostics,
    resourceTotal: resourceCompleteness.total,
    resourcesTruncated: resourceCompleteness.truncated,
    diagnosticTotal: diagnosticCompleteness.total,
    diagnosticsTruncated: diagnosticCompleteness.truncated,
  };
}
export function parseCommandsResult(input: unknown): CommandsResult {
  const value = object(input, "commands result"); exact(value, ["commands", "total", "truncated"]);
  const commands = array(value.commands, "commands", MAX_COLLECTION).map((item, index) => parseCommand(item, `commands[${index}]`));
  assertSorted(commands, "commands", compareCommandDtos);
  return { commands, ...parseCollectionCompleteness(value, commands.length) };
}

function parseCollectionCompleteness(
  value: Record<string, unknown>,
  returned: number,
  totalField = "total",
  truncatedField = "truncated",
): { total: number; truncated: boolean } {
  const total = value[totalField] === undefined ? returned : unsigned(value[totalField], totalField);
  const truncated = value[truncatedField] === undefined ? false : boolean(value[truncatedField], truncatedField);
  if (total < returned || truncated !== (returned < total)) {
    throw validation("invalid_response", `${totalField}/${truncatedField} collection metadata is inconsistent`);
  }
  return { total, truncated };
}

function parseReceipt(input: unknown): CommandReceipt {
  const receipt = object(input, "receipt"); exact(receipt, ["operationId", "instanceId", "accepted", "kind", "delivery", "queued", "acceptedAt"]);
  if (receipt.accepted !== true) throw validation("invalid_response", "receipt.accepted must be true");
  const parsed: CommandReceipt = { accepted: true, operationId: id(receipt.operationId, "receipt.operationId"), instanceId: id(receipt.instanceId, "receipt.instanceId"), kind: enumeration(receipt.kind, "receipt.kind", ["prompt", "extension_command"]), delivery: enumeration(receipt.delivery, "receipt.delivery", ["prompt", "steer", "followUp"]), queued: boolean(receipt.queued, "receipt.queued"), acceptedAt: timestamp(receipt.acceptedAt, "receipt.acceptedAt") };
  if (parsed.kind === "extension_command" && (parsed.delivery !== "prompt" || parsed.queued)) throw validation("invalid_response", "Extension command receipts must be immediate prompt delivery");
  return parsed;
}
function parseHost(input: unknown, field: string): HostIdentity {
  const host = object(input, field); exact(host, ["pid", "dockVersion", "piSdkVersion", "hostEpoch", "startedAt"]);
  return { pid: positive(host.pid, `${field}.pid`), dockVersion: string(host.dockVersion, `${field}.dockVersion`, 128), piSdkVersion: string(host.piSdkVersion, `${field}.piSdkVersion`, 128), hostEpoch: id(host.hostEpoch, `${field}.hostEpoch`), startedAt: timestamp(host.startedAt, `${field}.startedAt`) };
}
function parseCursor(input: unknown, field: string, code = "invalid_response"): EventCursor {
  const cursor = object(input, field, code); exact(cursor, ["hostEpoch", "instanceId", "runtimeGeneration", "sequence"], code);
  return { hostEpoch: id(cursor.hostEpoch, `${field}.hostEpoch`, code), instanceId: id(cursor.instanceId, `${field}.instanceId`, code), runtimeGeneration: positive(cursor.runtimeGeneration, `${field}.runtimeGeneration`, code), sequence: unsigned(cursor.sequence, `${field}.sequence`, code) };
}
function parseInstanceListCursor(input: unknown, field: string, code = "invalid_response"): InstanceListCursor {
  const cursor = object(input, field, code); exact(cursor, ["revision", "offset", "selector"], code);
  return {
    revision: unsigned(cursor.revision, `${field}.revision`, code),
    offset: unsigned(cursor.offset, `${field}.offset`, code),
    selector: enumeration(cursor.selector, `${field}.selector`, ["actionable", "all"], code),
  };
}
function parseExecutor(input: unknown, field: string): ExecutorIdentity {
  const executor = object(input, field); exact(executor, ["kind", "version", "piSessionId", "sessionFile", "model", "thinkingLevel"]);
  let model: ExecutorIdentity["model"];
  if (executor.model !== undefined) { const value = object(executor.model, `${field}.model`); exact(value, ["provider", "id", "name"]); const name=optionalString(value.name, `${field}.model.name`, 256); model = { provider: string(value.provider, `${field}.model.provider`, MAX_MODEL_PROVIDER_CHARS), id: string(value.id, `${field}.model.id`, MAX_MODEL_ID_CHARS), ...(name === undefined ? {} : { name }) }; }
  return { kind: string(executor.kind, `${field}.kind`, 128), version: optionalString(executor.version, `${field}.version`, 128), piSessionId: id(executor.piSessionId, `${field}.piSessionId`), sessionFile: optionalString(executor.sessionFile, `${field}.sessionFile`, MAX_CONTROL_CWD_CHARS), model, thinkingLevel: executor.thinkingLevel === undefined ? undefined : enumeration(executor.thinkingLevel, `${field}.thinkingLevel`, THINKING_LEVELS) };
}
function parseImagePaths(input: unknown, field: string, code = "invalid_response"): ImagePathDto[] {
  const images = array(input, field, MAX_INPUT_IMAGES, code).map((item, index) => {
    const image = object(item, `${field}[${index}]`, code);
    exact(image, ["path", "mimeType"], code);
    const path = string(image.path, `${field}[${index}].path`, MAX_IMAGE_PATH_CHARS, code);
    if (!path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw validation(code, `${field}[${index}].path must be an absolute local path without control characters`);
    const mimeType = string(image.mimeType, `${field}[${index}].mimeType`, MAX_IMAGE_MIME_TYPE_CHARS, code);
    if (!/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mimeType)) throw validation(code, `${field}[${index}].mimeType must be a bounded image/* value`);
    return { path, mimeType };
  });
  if (new Set(images.map((image) => `${image.path}\u0000${image.mimeType}`)).size !== images.length) throw validation(code, `${field} must not contain duplicate descriptors`);
  return images;
}

function parsePendingMessage(input: unknown, field: string): PendingMessageDto {
  const item = object(input, field); exact(item, ["queueItemId", "operationId", "delivery", "text", "images", "acceptedAt"]);
  const text = boundedString(item.text, `${field}.text`, MAX_PROMPT_CHARS);
  const images = item.images === undefined ? undefined : parseImagePaths(item.images, `${field}.images`);
  if (text.length === 0 && (images === undefined || images.length === 0)) throw validation("invalid_response", `${field} requires text or at least one image`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) throw validation("invalid_response", `${field}.text contains terminal control characters`);
  return {
    queueItemId: id(item.queueItemId, `${field}.queueItemId`),
    operationId: id(item.operationId, `${field}.operationId`),
    delivery: enumeration(item.delivery, `${field}.delivery`, ["steer", "followUp"]),
    text,
    ...(images === undefined ? {} : { images }),
    acceptedAt: timestamp(item.acceptedAt, `${field}.acceptedAt`),
  };
}
function imagePathCharacters(images: readonly ImagePathDto[] | undefined): number {
  return (images ?? []).reduce((total, image) => total + image.path.length + image.mimeType.length, 0);
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
  const cost = finiteNumber(metrics.cost, `${field}.cost`);
  if (cost < 0) throw validation("invalid_response", `${field}.cost must be non-negative`);
  const result: NonNullable<InstanceSnapshot["metrics"]> = { messages: { user: unsigned(messages.user, "messages.user"), assistant: unsigned(messages.assistant, "messages.assistant"), toolCalls: unsigned(messages.toolCalls, "messages.toolCalls"), toolResults: unsigned(messages.toolResults, "messages.toolResults"), total: unsigned(messages.total, "messages.total") }, tokens: { input: unsigned(tokens.input, "tokens.input"), output: unsigned(tokens.output, "tokens.output"), cacheRead: unsigned(tokens.cacheRead, "tokens.cacheRead"), cacheWrite: unsigned(tokens.cacheWrite, "tokens.cacheWrite"), total: unsigned(tokens.total, "tokens.total") }, cost };
  if (metrics.context !== undefined) {
    const context = object(metrics.context, `${field}.context`); exact(context, ["tokens", "contextWindow", "percent"]);
    const percent = nullableNumber(context.percent, "context.percent");
    if (percent !== null && (percent < 0 || percent > 100)) throw validation("invalid_response", "context.percent must be between 0 and 100");
    result.context = { tokens: nullableUnsigned(context.tokens, "context.tokens"), contextWindow: positive(context.contextWindow, "context.contextWindow"), percent };
  }
  return result;
}
function parseInstance(input: unknown, field: string): InstanceSnapshot {
  const value = object(input, field); exact(value, ["id", "creationOperationId", "key", "name", "cwd", "gitBranch", "lifecycle", "execution", "compacting", "lastRun", "reopenable", "runtimeGeneration", "ownerHostEpoch", "interruption", "pending", "executor", "metrics", "extensionStatus", "toolsExpanded", "activeInteraction", "activeCommandId", "lastError", "createdAt", "updatedAt", "eventCursor"]);
  const snapshot: InstanceSnapshot = {
    id: id(value.id, `${field}.id`), creationOperationId: id(value.creationOperationId, `${field}.creationOperationId`), key: optionalString(value.key, `${field}.key`, MAX_INSTANCE_KEY_CHARS), name: optionalString(value.name, `${field}.name`, MAX_INSTANCE_NAME_CHARS), cwd: string(value.cwd, `${field}.cwd`, MAX_CONTROL_CWD_CHARS), gitBranch: value.gitBranch === undefined ? undefined : gitBranch(value.gitBranch, `${field}.gitBranch`),
    lifecycle: enumeration(value.lifecycle, `${field}.lifecycle`, ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(value.execution, `${field}.execution`, ["idle", "running", "failed", "unavailable"]), compacting: boolean(value.compacting, `${field}.compacting`), lastRun: enumeration(value.lastRun, `${field}.lastRun`, ["never", "succeeded", "failed", "aborted", "interrupted"]), reopenable: boolean(value.reopenable, `${field}.reopenable`), runtimeGeneration: positive(value.runtimeGeneration, `${field}.runtimeGeneration`), ownerHostEpoch: optionalString(value.ownerHostEpoch, `${field}.ownerHostEpoch`, 128), pending: parsePending(value.pending, `${field}.pending`), executor: parseExecutor(value.executor, `${field}.executor`), metrics: value.metrics === undefined ? undefined : parseMetrics(value.metrics, `${field}.metrics`), extensionStatus: {}, toolsExpanded: boolean(value.toolsExpanded, `${field}.toolsExpanded`), activeCommandId: optionalString(value.activeCommandId, `${field}.activeCommandId`, 128), lastError: optionalString(value.lastError, `${field}.lastError`, MAX_MESSAGE), createdAt: timestamp(value.createdAt, `${field}.createdAt`), updatedAt: timestamp(value.updatedAt, `${field}.updatedAt`), eventCursor: parseCursor(value.eventCursor, `${field}.eventCursor`),
  };
  if (value.interruption !== undefined) { const interruption = object(value.interruption, `${field}.interruption`); exact(interruption, ["reason", "at"]); snapshot.interruption = { reason: enumeration(interruption.reason, "interruption.reason", ["host_crash", "host_shutdown", "replacement_failed"]), at: timestamp(interruption.at, "interruption.at") }; }
  const status = object(value.extensionStatus, `${field}.extensionStatus`); if (Object.keys(status).length > 64) throw validation("invalid_response", "extensionStatus has too many keys"); for (const [key, item] of Object.entries(status)) snapshot.extensionStatus[extensionKey(key, "extensionStatus key")] = payloadFreeString(item, `extensionStatus.${key}`, MAX_MESSAGE);
  if (value.activeInteraction !== undefined) { const interaction = object(value.activeInteraction, `${field}.activeInteraction`); exact(interaction, ["id", "method", "expiresAt"]); snapshot.activeInteraction = { id: id(interaction.id, "activeInteraction.id"), method: enumeration(interaction.method, "activeInteraction.method", ["select", "confirm", "input", "editor"]), expiresAt: timestamp(interaction.expiresAt, "activeInteraction.expiresAt") }; }
  assertCursorDomain(snapshot.eventCursor, snapshot, `${field}.eventCursor`);
  const terminal = snapshot.lifecycle === "stopped" || snapshot.lifecycle === "host_lost" || snapshot.lifecycle === "runtime_error";
  if (terminal !== (snapshot.execution === "unavailable")) throw validation("invalid_response", "Lifecycle/execution combination is invalid");
  if ((snapshot.lifecycle === "active" || snapshot.lifecycle === "stopping") !== (snapshot.ownerHostEpoch !== undefined)) throw validation("invalid_response", "ownerHostEpoch does not match lifecycle");
  if (terminal && (snapshot.pending.total !== 0 || snapshot.activeCommandId !== undefined || snapshot.activeInteraction !== undefined)) throw validation("invalid_response", "Unavailable instance retains active state");
  if (snapshot.lifecycle === "stopped" && snapshot.reopenable) throw validation("invalid_response", "Stopped instance cannot be reopenable");
  if (snapshot.reopenable && snapshot.lifecycle !== "host_lost" && snapshot.lifecycle !== "runtime_error") throw validation("invalid_response", "Only unavailable failed instances can be reopenable");
  if (snapshot.activeCommandId !== undefined && snapshot.execution !== "running") throw validation("invalid_response", "activeCommandId requires running execution");
  if (snapshot.compacting && snapshot.execution !== "running") throw validation("invalid_response", "compacting requires running execution");
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
    case "instance.state_changed": exact(data, ["reason", "lifecycle", "execution", "compacting", "lastRun", "pending", "activeCommandId", "lastError"]); { const result = { reason: text("reason", MAX_MESSAGE), lifecycle: enumeration(data.lifecycle, "lifecycle", ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(data.execution, "execution", ["idle", "running", "failed", "unavailable"]), compacting: boolean(data.compacting, "compacting"), lastRun: enumeration(data.lastRun, "lastRun", ["never", "succeeded", "failed", "aborted", "interrupted"]), pending: parsePending(data.pending, `${field}.pending`), activeCommandId: optionalText("activeCommandId", 128), lastError: optionalText("lastError", MAX_MESSAGE) }; if (result.activeCommandId && result.execution !== "running") throw validation("invalid_response", "state event activeCommandId requires running"); if (result.compacting && result.execution !== "running") throw validation("invalid_response", "state event compacting requires running"); return result; }
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
    case "message.queued": return parsePendingMessage(data, field);
    case "message.submitted": {
      exact(data, ["operationId", "messageId", "role", "text", "images", "delivery", "queueItemId"]);
      const delivery = enumeration(data.delivery, "delivery", ["prompt", "steer", "followUp"]);
      const queueItemId = optionalText("queueItemId", 128);
      if ((delivery === "prompt") === (queueItemId !== undefined)) throw validation("invalid_response", "message.submitted queueItemId does not match delivery");
      return { operationId: text("operationId", 128), messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user"]), text: boundedString(data.text, `${field}.text`, MAX_PROMPT_CHARS), ...(data.images === undefined ? {} : { images: parseImagePaths(data.images, `${field}.images`) }), delivery, queueItemId };
    }
    case "message.delta": exact(data, ["messageId", "block", "delta"]); return { messageId: text("messageId", 128), block: enumeration(data.block, "block", ["text", "thinking"]), delta: boundedString(data.delta, `${field}.delta`, MAX_TEXT) };
    case "message.completed": exact(data, ["messageId", "role", "content", "stopReason", "error"]); return { messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user", "assistant", "tool", "system"]), content: parseContent(data.content, `${field}.content`), stopReason: optionalText("stopReason", 128), error: optionalText("error", MAX_MESSAGE) };
    case "tool.started": exact(data, ["toolCallId", "toolName", "args", "omittedFields"]); return toolArgs(data, field, true);
    case "tool.args_updated": exact(data, ["toolCallId", "args", "omittedFields"]); return toolArgs(data, field, false);
    case "tool.output_updated": {
      exact(data, ["toolCallId", "text", "presentation"]);
      const resultText = boundedString(data.text, `${field}.text`, MAX_TOOL_RESULT_TEXT);
      const presentation = data.presentation === undefined ? undefined : parseToolPresentation(data.presentation, `${field}.presentation`, undefined, false);
      return { toolCallId: text("toolCallId", 128), text: resultText, ...(presentation === undefined ? {} : { presentation }) };
    }
    case "tool.completed": {
      exact(data, ["toolCallId", "toolName", "text", "isError", "presentation", "omittedFields"]);
      const toolName = text("toolName", 256);
      const isError = boolean(data.isError, "isError");
      const resultText = boundedString(data.text, `${field}.text`, MAX_TOOL_RESULT_TEXT);
      const presentation = data.presentation === undefined ? undefined : parseToolPresentation(data.presentation, `${field}.presentation`, toolName, isError);
      return { toolCallId: text("toolCallId", 128), toolName, text: resultText, isError, ...(presentation === undefined ? {} : { presentation }), omittedFields: omitted(data.omittedFields, "omittedFields") };
    }
    case "queue.changed": exact(data, ["steering", "followUp", "total"]); return parsePending(data, field);
    case "queue.cleared": exact(data, ["steering", "followUp", "total", "queueItemIds", "reason"]); return { ...parsePending({ steering: data.steering, followUp: data.followUp, total: data.total }, field), queueItemIds: strings(data.queueItemIds, `${field}.queueItemIds`, MAX_PENDING_QUEUE_ITEMS, 128), reason: enumeration(data.reason, `${field}.reason`, ["dequeued", "abort", "stop", "replacement", "host_draining"]) };
    case "compaction.started": exact(data, ["reason", "operationId"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]), operationId: optionalText("operationId", 128) };
    case "compaction.completed": exact(data, ["reason", "operationId", "aborted", "willRetry", "error"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]), operationId: optionalText("operationId", 128), aborted: boolean(data.aborted, "aborted"), willRetry: boolean(data.willRetry, "willRetry"), error: optionalText("error", MAX_MESSAGE) };
    case "session.replaced": exact(data, ["reason", "previousSessionFile", "sessionFile", "runtimeGeneration", "cwd", "piSessionId", "name", "gitBranch"]); return { reason: enumeration(data.reason, "reason", ["new", "resume", "fork", "reload"]), previousSessionFile: optionalText("previousSessionFile", MAX_CONTROL_CWD_CHARS), sessionFile: optionalText("sessionFile", MAX_CONTROL_CWD_CHARS), runtimeGeneration: positive(data.runtimeGeneration, "runtimeGeneration"), cwd: text("cwd", MAX_CONTROL_CWD_CHARS), piSessionId: text("piSessionId", 128), name: optionalText("name", MAX_INSTANCE_NAME_CHARS), gitBranch: data.gitBranch === undefined ? undefined : gitBranch(data.gitBranch, `${field}.gitBranch`) };
    case "session.navigated": exact(data, ["targetId", "leafId", "treeRevision", "summaryCreated"]); return { targetId: text("targetId", 128), leafId: optionalText("leafId", 128), treeRevision: text("treeRevision", 128), summaryCreated: boolean(data.summaryCreated, "summaryCreated") };
    case "session.info_changed": exact(data, ["name"]); return { name: optionalText("name", MAX_INSTANCE_NAME_CHARS) };
    case "session.metrics_changed": exact(data, ["metrics"]); return { metrics: parseMetrics(data.metrics, `${field}.metrics`) };
    case "git.branch_changed": exact(data, ["branch"]); return data.branch === undefined ? {} : { branch: gitBranch(data.branch, `${field}.branch`) };
    case "model.changed": exact(data, ["provider", "id", "thinkingLevel", "availableThinkingLevels"]); return { provider: text("provider", MAX_MODEL_PROVIDER_CHARS), id: text("id", MAX_MODEL_ID_CHARS), thinkingLevel: enumeration(data.thinkingLevel, "thinkingLevel", THINKING_LEVELS), availableThinkingLevels: levels("availableThinkingLevels") };
    case "thinking.changed": exact(data, ["requested", "thinkingLevel", "availableThinkingLevels"]); return { requested: enumeration(data.requested, "requested", THINKING_LEVELS), thinkingLevel: enumeration(data.thinkingLevel, "thinkingLevel", THINKING_LEVELS), availableThinkingLevels: levels("availableThinkingLevels") };
    case "resources.reloaded": exact(data, ["resources", "diagnostics"]); return { resources: array(data.resources, "resources", MAX_COLLECTION).map((item, index) => parseResource(item, `resources[${index}]`)), diagnostics: array(data.diagnostics, "diagnostics", MAX_COLLECTION).map((item, index) => parseDiagnostic(item, `diagnostics[${index}]`)) };
    case "settings.changed": { exact(data, ["key", "value", "reloadRequired", "hostRestartRequired"]); const key=settingKey(data.key); return { key, value: parseSettingValue(key, data.value), reloadRequired: boolean(data.reloadRequired, "reloadRequired"), hostRestartRequired: boolean(data.hostRestartRequired, "hostRestartRequired") }; }
    case "settings.write_failed": exact(data, ["key", "error"]); return { key: settingsWriteKey(data.key), error: text("error", MAX_MESSAGE) };
    case "interaction.requested": return parseDialogRequest(data, field);
    case "interaction.resolved": exact(data, ["interactionId", "method"]); return { interactionId: text("interactionId", 128), method: enumeration(data.method, "method", ["select", "confirm", "input", "editor"]) };
    case "interaction.cancelled": exact(data, ["interactionId", "method", "reason"]); return { interactionId: text("interactionId", 128), method: enumeration(data.method, "method", ["select", "confirm", "input", "editor"]), reason: enumeration(data.reason, "reason", ["user", "timeout", "signal", "detach", "replacement", "host_draining", "overflow"]) };
    case "extension.notification": exact(data, ["message", "level"]); return { message: payloadFreeString(data.message, `${field}.message`, MAX_TEXT), level: enumeration(data.level, "level", ["info", "warning", "error"]) };
    case "extension.title_set": {
      exact(data, ["controllerId", "title"]);
      const title = payloadFreeBoundedString(data.title, `${field}.title`, 2_048);
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(title)) throw validation("invalid_response", `${field}.title contains terminal control characters`);
      return { controllerId: id(data.controllerId, `${field}.controllerId`), title };
    }
    case "extension.editor_text_set": {
      exact(data, ["controllerId", "text"]);
      const editorText = payloadFreeBoundedString(data.text, `${field}.text`, 256_000);
      if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(editorText)) throw validation("invalid_response", `${field}.text contains terminal control characters`);
      return { controllerId: id(data.controllerId, `${field}.controllerId`), text: editorText };
    }
    case "extension.status_changed": exact(data, ["key", "text"]); return { key: extensionKey(data.key, `${field}.key`), text: data.text === undefined ? undefined : payloadFreeString(data.text, `${field}.text`, MAX_MESSAGE) };
    case "extension.tools_expanded_changed": exact(data, ["expanded"]); return { expanded: boolean(data.expanded, `${field}.expanded`) };
    case "extension.widget_changed": exact(data, ["key", "lines", "placement"]); return { key: extensionKey(data.key, `${field}.key`), lines: data.lines === undefined ? undefined : payloadFreeStrings(data.lines, `${field}.lines`, MAX_JSON_ARRAY, MAX_TEXT), placement: data.placement === undefined ? undefined : enumeration(data.placement, "placement", ["aboveEditor", "belowEditor"]) };
    case "extension.error": exact(data, ["source", "event", "error"]); return { source: data.source === undefined ? undefined : payloadFreeString(data.source, `${field}.source`, 256), event: data.event === undefined ? undefined : payloadFreeString(data.event, `${field}.event`, 128), error: payloadFreeString(data.error, `${field}.error`, MAX_MESSAGE) };
    default: throw validation("invalid_response", `Unsupported event type: ${type}`);
  }
}
function toolArgs(data: Record<string, unknown>, field: string, withName: boolean): EventDataMap["tool.started"] | EventDataMap["tool.args_updated"] {
  const result = { toolCallId: id(data.toolCallId, `${field}.toolCallId`), args: parseJsonObject(data.args, `${field}.args`), omittedFields: omitted(data.omittedFields, `${field}.omittedFields`) };
  return withName ? { ...result, toolName: string(data.toolName, `${field}.toolName`, 256) } : result;
}
function parseToolPresentation(
  input: unknown,
  field: string,
  toolName: string | undefined,
  isError: boolean,
): BuiltInToolPresentation {
  const value = object(input, field);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const projected = validateBuiltInToolPresentation(toolName ?? kind, value, isError);
  if (projected === undefined) throw validation("invalid_response", `${field} is not a valid built-in tool presentation`);
  return projected;
}

function parseContent(input: unknown, field: string): ContentBlockDto[] {
  return array(input, field, MAX_JSON_ARRAY).map((item, index) => {
    const block = object(item, `${field}[${index}]`); const type = enumeration(block.type, `${field}[${index}].type`, ["text", "thinking", "image", "tool_call", "tool_result", "omitted"]);
    if (type === "text" || type === "thinking") { exact(block, ["type", "text"]); return { type, text: boundedString(block.text, `${field}[${index}].text`, MAX_TEXT) }; }
    if (type === "image") { exact(block, ["type", "mimeType"]); const mimeType = string(block.mimeType, `${field}[${index}].mimeType`, MAX_IMAGE_MIME_TYPE_CHARS); if (!/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mimeType)) throw validation("invalid_response", `${field}[${index}].mimeType must be image/*`); return { type, mimeType }; }
    if (type === "tool_call") { exact(block, ["type", "toolCallId", "toolName", "args", "omittedFields"]); return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName: string(block.toolName, "toolName", 256), args: parseJsonObject(block.args, "args"), omittedFields: omitted(block.omittedFields, "omittedFields") }; }
    if (type === "tool_result") {
      exact(block, ["type", "toolCallId", "toolName", "text", "isError", "presentation", "omittedFields"]);
      const toolName = string(block.toolName, "toolName", 256);
      const isError = boolean(block.isError, "isError");
      const resultText = boundedString(block.text, "text", MAX_TOOL_RESULT_TEXT);
      const presentation = block.presentation === undefined ? undefined : parseToolPresentation(block.presentation, `${field}[${index}].presentation`, toolName, isError);
      return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName, text: resultText, isError, ...(presentation === undefined ? {} : { presentation }), omittedFields: omitted(block.omittedFields, "omittedFields") };
    }
    exact(block, ["type", "kind", "description"]); return { type, kind: enumeration(block.kind, "kind", ["image", "binary"]), description: string(block.description, "description", MAX_MESSAGE) };
  });
}
function parseHistoryEntry(input: unknown, field: string): HistoryEntryDto {
  const entry = object(input, field); exact(entry, ["entryId", "parentId", "role", "summaryKind", "timestamp", "content", "stopReason", "error"]);
  return {
    entryId: id(entry.entryId, `${field}.entryId`),
    parentId: optionalString(entry.parentId, `${field}.parentId`, 128),
    role: enumeration(entry.role, `${field}.role`, ["user", "assistant", "tool", "system"]),
    summaryKind: entry.summaryKind === undefined ? undefined : enumeration(entry.summaryKind, `${field}.summaryKind`, ["compaction", "branch"] as const),
    timestamp: entry.timestamp === undefined ? undefined : timestamp(entry.timestamp, `${field}.timestamp`),
    content: parseContent(entry.content, `${field}.content`),
    stopReason: optionalString(entry.stopReason, `${field}.stopReason`, 128),
    error: optionalString(entry.error, `${field}.error`, MAX_MESSAGE),
  };
}

function parseInteractionResponse(input: unknown, field: string, code = "invalid_response"): InteractionResponse {
  const value = object(input, field, code);
  const method = enumeration(value.method, `${field}.method`, ["select", "confirm", "input", "editor"], code);
  if (value.cancelled !== undefined) {
    exact(value, ["method", "cancelled"], code);
    if (boolean(value.cancelled, `${field}.cancelled`, code) !== true) throw validation(code, `${field}.cancelled must be true`);
    return { method, cancelled: true };
  }
  if (method === "confirm") {
    exact(value, ["method", "confirmed"], code);
    return { method, confirmed: boolean(value.confirmed, `${field}.confirmed`, code) };
  }
  exact(value, ["method", "value"], code);
  const responseValue = string(value.value, `${field}.value`, method === "select" ? MAX_TEXT : MAX_PROMPT_CHARS, code);
  if (containsBinaryPayload(responseValue)) throw validation(code, `${field}.value cannot contain binary, image, data URI, or raw base64 payloads`);
  return { method, value: responseValue };
}

function parseDialogRequest(data: Record<string, unknown>, field: string): EventDataMap["interaction.requested"] {
  const method = enumeration(data.method, `${field}.method`, ["select", "confirm", "input", "editor"]);
  const interactionId = id(data.interactionId, `${field}.interactionId`);
  const title = payloadFreeString(data.title, `${field}.title`, MAX_MESSAGE);
  const issuedAt = timestamp(data.issuedAt, `${field}.issuedAt`);
  const expiresAt = timestamp(data.expiresAt, `${field}.expiresAt`);
  if (method === "select") { exact(data, ["interactionId", "method", "title", "options", "issuedAt", "expiresAt"]); return { interactionId, method, title, options: payloadFreeStrings(data.options, `${field}.options`, 200, MAX_TEXT), issuedAt, expiresAt }; }
  if (method === "confirm") { exact(data, ["interactionId", "method", "title", "message", "issuedAt", "expiresAt"]); return { interactionId, method, title, message: payloadFreeString(data.message, `${field}.message`, MAX_TEXT), issuedAt, expiresAt }; }
  if (method === "input") { exact(data, ["interactionId", "method", "title", "placeholder", "issuedAt", "expiresAt"]); return { interactionId, method, title, ...(data.placeholder === undefined ? {} : { placeholder: payloadFreeString(data.placeholder, `${field}.placeholder`, MAX_TEXT) }), issuedAt, expiresAt }; }
  exact(data, ["interactionId", "method", "title", "prefill", "issuedAt", "expiresAt"]); return { interactionId, method, title, ...(data.prefill === undefined ? {} : { prefill: payloadFreeString(data.prefill, `${field}.prefill`, MAX_PROMPT_CHARS) }), issuedAt, expiresAt };
}

function payloadFreeString(input: unknown, field: string, max: number, code = "invalid_response"): string {
  const value = string(input, field, max, code);
  if (containsBinaryPayload(value)) throw validation(code, `${field} cannot contain binary, image, data URI, or raw base64 payloads`);
  return value;
}

function payloadFreeBoundedString(input: unknown, field: string, max: number, code = "invalid_response"): string {
  const value = boundedString(input, field, max, code);
  if (containsBinaryPayload(value)) throw validation(code, `${field} cannot contain binary, image, data URI, or raw base64 payloads`);
  return value;
}

function payloadFreeStrings(input: unknown, field: string, maxItems: number, maxChars: number, code = "invalid_response"): string[] {
  const values = strings(input, field, maxItems, maxChars, code);
  for (const [index, value] of values.entries()) {
    if (containsBinaryPayload(value)) throw validation(code, `${field}[${index}] cannot contain binary, image, data URI, or raw base64 payloads`);
  }
  return values;
}

function extensionKey(input: unknown, field: string): string {
  const key = payloadFreeString(input, field, 128);
  if (key === "__proto__" || key === "prototype" || key === "constructor") throw validation("invalid_response", `${field} is unsafe`);
  return key;
}

function gitBranch(input: unknown, field: string): string {
  const branch = string(input, field, 256);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(branch)) throw validation("invalid_response", `${field} must be terminal-safe`);
  return branch;
}
function parseSettingUpdate(input: unknown, field: string, code = "invalid_response"): SettingUpdate {
  const update = object(input, field, code); exact(update, ["key", "value"], code);
  const key = settingKey(update.key, code);
  if (!SETTING_DEFINITIONS[key].writable) throw validation(code, `Pi setting ${key} is read-only`);
  return { key, value: parseSettingValue(key, update.value, code) } as SettingUpdate;
}
function settingKey(input: unknown, code = "invalid_response"): SettingKey {
  const key=string(input,"setting key",128,code);
  if(!SETTING_KEYS.includes(key as SettingKey))throw validation(code,`Unsupported setting key: ${key}`);
  return key as SettingKey;
}
function settingsWriteKey(input: unknown): string {
  const key = string(input, "settings write key", 128);
  return key === "model" || key === "thinking" ? key : settingKey(key);
}
function parseSettingValue(key: SettingKey, input: unknown, code = "invalid_response"): JsonValue {
  const definition = SETTING_DEFINITIONS[key];
  if (definition.valueType === "boolean") return boolean(input, `settings.${key}`, code);
  if (definition.valueType === "enum") return enumeration(input, `settings.${key}`, definition.allowedValues as readonly string[], code);
  if (definition.valueType === "integer") {
    const value=unsigned(input, `settings.${key}`, code);
    if(value<(definition.min as number)||value>(definition.max as number))throw validation(code,`settings.${key} is out of range`);
    return value;
  }
  const value=object(input, "settings.warnings", code);
  exact(value, ["anthropicExtraUsage"], code);
  const result:JsonObject={};
  if(value.anthropicExtraUsage!==undefined)result.anthropicExtraUsage=boolean(value.anthropicExtraUsage,"settings.warnings.anthropicExtraUsage",code);
  return result;
}

function parseTool(input: unknown, field: string): ToolDto { const value = object(input, field); exact(value, ["name", "description", "active", "source", "parameterSchema"]); return { name: string(value.name, `${field}.name`, 256), description: boundedString(value.description, `${field}.description`, MAX_MESSAGE), active: boolean(value.active, `${field}.active`), ...(value.source === undefined ? {} : { source: parseSource(value.source, `${field}.source`) }), ...(value.parameterSchema === undefined ? {} : { parameterSchema: parseJsonObject(value.parameterSchema, `${field}.parameterSchema`) }) }; }
function parseResource(input: unknown, field: string): ResourceDto { const value = object(input, field); exact(value, ["kind", "name", "path", "source"]); return { kind: enumeration(value.kind, `${field}.kind`, ["extension", "skill", "prompt", "context"]), name: string(value.name, `${field}.name`, 256), ...(value.path === undefined ? {} : { path: string(value.path, `${field}.path`, MAX_CONTROL_CWD_CHARS) }), ...(value.source === undefined ? {} : { source: parseSource(value.source, `${field}.source`) }) }; }
function parseSource(input: unknown, field: string): import("../core/config-projection.js").SourceDto { const value = object(input, field); exact(value, ["kind", "path", "package"]); const kind=enumeration(value.kind, `${field}.kind`, ["built-in", "extension", "skill", "prompt"]); if(kind==="built-in"&&(value.path!==undefined||value.package!==undefined))throw validation("invalid_response",`${field} built-in source cannot carry path or package`); return { kind, ...(value.path === undefined ? {} : { path: string(value.path, `${field}.path`, MAX_CONTROL_CWD_CHARS) }), ...(value.package === undefined ? {} : { package: string(value.package, `${field}.package`, 256) }) }; }
function parseDiagnostic(input: unknown, field: string): DiagnosticDto { const value = object(input, field); exact(value, ["severity", "message", "source"]); return { severity: enumeration(value.severity, `${field}.severity`, ["info", "warning", "error"]), message: string(value.message, `${field}.message`, MAX_MESSAGE), ...(value.source === undefined ? {} : { source: string(value.source, `${field}.source`, 256) }) }; }
function parseCommand(input: unknown, field: string): CommandDto { const value = object(input, field); exact(value, ["name", "description", "source", "argumentCompletions"]); return { name: string(value.name, `${field}.name`, 256), ...(value.description === undefined ? {} : { description: boundedString(value.description, `${field}.description`, MAX_MESSAGE) }), source: parseSource(value.source, `${field}.source`), argumentCompletions: boolean(value.argumentCompletions, `${field}.argumentCompletions`) }; }
function parseSettingDto(input: unknown, field: string): SettingDto {
  const value = object(input, field); exact(value, ["key", "value", "source", "writable", "valueType", "allowedValues", "min", "max", "reloadRequired", "hostRestartRequired"]);
  const key = settingKey(value.key); const definition = SETTING_DEFINITIONS[key];
  const source = enumeration(value.source, `${field}.source`, ["global", "project", "effective"]);
  if (value.writable !== definition.writable) throw validation("invalid_response", `${field}.writable does not match the frozen setting table`);
  if (value.valueType !== definition.valueType || value.reloadRequired !== definition.reloadRequired || value.hostRestartRequired !== definition.hostRestartRequired) throw validation("invalid_response", `${field} metadata does not match the frozen setting table`);
  const allowedValues = value.allowedValues === undefined ? undefined : array(value.allowedValues, `${field}.allowedValues`, 20).map((item, index) => { if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw validation("invalid_response", `${field}.allowedValues[${index}] is invalid`); return item; });
  if (JSON.stringify(allowedValues) !== JSON.stringify(definition.allowedValues) || value.min !== definition.min || value.max !== definition.max) throw validation("invalid_response", `${field} bounds or allowed values do not match the frozen setting table`);
  return { key, value: parseSettingValue(key, value.value) as never, source, writable: definition.writable, valueType: definition.valueType, ...(allowedValues ? { allowedValues } : {}), ...(definition.min === undefined ? {} : { min: definition.min }), ...(definition.max === undefined ? {} : { max: definition.max }), reloadRequired: definition.reloadRequired, hostRestartRequired: definition.hostRestartRequired } as SettingDto;
}
function assertSorted<T>(values: T[], field: string, compare: (left: T, right: T) => number): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) > 0) throw validation("invalid_response", `${field} is not deterministically sorted`);
  }
}
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
function parseJsonValue(input: unknown, field: string, depth: number): JsonValue { if (depth > MAX_JSON_DEPTH) throw validation("invalid_response", `${field} exceeds JSON depth`); if (input === null || typeof input === "boolean") return input; if (typeof input === "string") return boundedString(input, field, MAX_TEXT); if (typeof input === "number" && Number.isFinite(input)) return input; if (Array.isArray(input)) return array(input, field, MAX_JSON_ARRAY).map((item, index) => parseJsonValue(item, `${field}[${index}]`, depth + 1)); const value = object(input, field); if (Object.keys(value).length > MAX_JSON_KEYS) throw validation("invalid_response", `${field} has too many keys`); return Object.fromEntries(Object.entries(value).map(([key, item]) => [string(key, `${field} key`, 256), parseJsonValue(item, `${field}.${key}`, depth + 1)])); }
function valueOr(input: unknown): unknown { return input; }
