import { createHash } from "node:crypto";
import { MAX_RESOURCE_CONTENT_PAGE_BYTES } from "../core/resource-content.js";

import { MAX_EXTENSION_WIDGET_LINES, type InteractionResponse } from "../core/extension-ui-broker.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_FILE_ID_CHARS,
  MAX_ATTACHMENT_IDS_PER_COMMAND,
  MAX_ATTACHMENT_MEDIA_TYPE_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  type AttachmentDto,
  type AttachmentUploadResult,
} from "../core/instance-attachments.js";
import { MAX_CATALOG_LAST_ERROR_CHARS } from "../core/catalog.js";
import { MAX_INSTANCE_DISPLAY_NAME_CHARS } from "../core/instance-display-name.js";
import { MACHINE_PLATFORMS, type MachineDto, type MachinePlatform, type MachinesResult } from "../core/machine-dto.js";
import { isPortableAbsoluteLocalPath, isPortableLocalRootPath } from "../core/local-path.js";
import { MAX_JSON_ARRAY_ITEMS, MAX_JSON_OBJECT_KEYS, MAX_JSON_OMITTED_FIELDS, MAX_JSON_STRING_CHARS, MAX_JSON_VALUE_DEPTH, type JsonObject, type JsonValue } from "../core/json-value.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import {
  MAX_DELIVERY_REF_CHARS,
  MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE,
  parseDeliverableDto,
  type DeliverableDto,
} from "../core/instance-deliverables.js";
import {
  MAX_SOURCE_FILE_TRANSFER_BYTES,
  MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES,
} from "../core/source-file.js";
import {
  CONVERSATION_FRAME_TYPES,
  MAX_CONVERSATION_CHUNK_CHARS,
  MAX_CONVERSATION_CONTENT_BLOCKS,
  MAX_SESSION_FIRST_USER_MESSAGE_CHARS,
  MAX_STOP_CLEANUP_ERROR_CHARS,
  MAX_STOP_CLEANUP_ERRORS,
  type ConversationImageBody,
} from "../core/instance-dto.js";
import {
  MAX_DOCK_TRANSFER_BYTES,
  MAX_RESPONSE_TRANSFER_CHUNK_BYTES,
  MAX_RESPONSE_TRANSFER_CHUNKS,
} from "../core/transport-bounds.js";
import {
  MAX_PUBLISHED_FILE_BYTES,
  MAX_PUBLISHED_FILE_CHUNK_BYTES,
  MAX_PUBLISHED_FILE_REF_CHARS,
  validatedPublishedFileDto,
  type PublishedFileDto,
  type PublishedFileReadPage,
} from "../core/published-file.js";
import {
  validateBuiltInToolPresentation,
  type BuiltInToolPresentation,
} from "../core/tool-result-presentation.js";
import {
  MAX_CONVERSATION_IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_ITEMS,
  MAX_PENDING_QUEUE_TEXT_CHARS,
  MAX_SEMANTIC_HISTORY_PAGE_ITEMS,
} from "../core/managed-instance.js";
import type {
  CommandReceipt,
  ContentBlockDto,
  ConversationFrame,
  ConversationContentChunkDto,
  ConversationContentPageDto,
  ConversationHistoryPageDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  HistoryEntryDto,
  ImagePathDto,
  InstanceSnapshot,
  PendingMessageDto,
  QueueDequeueReceipt,
  SessionDto,
  TreeNodeDto,
} from "../core/managed-instance.js";
import type {
  CommandArgumentCompletionDto,
  CommandDto,
  CommandReferenceDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  ToolDto,
} from "../core/config-projection.js";
import {
  MAX_COMMAND_ARGUMENT_COMPLETIONS,
  MAX_COMMAND_ARGUMENT_HINT_CHARS,
  MAX_COMMAND_ARGUMENT_PREFIX_CHARS,
  MAX_COMMAND_COMPLETION_TEXT_CHARS,
  MAX_COMMAND_CONTENT_PAGE_CHARS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  compareCommandDtos,
  compareDiagnosticDtos,
  compareResourceDtos,
  compareToolDtos,
} from "../core/config-projection.js";
import { THINKING_LEVELS, type AgentModelInfo, type ThinkingLevel } from "../core/agent-worker.js";
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
export const MAX_CONVERSATION_HISTORY_ITEMS = 50;
export const MAX_INSTANCE_LIST_ITEMS = 100;
export const MAX_WORKSPACE_LIST_ITEMS = 200;
export const MAX_WORKSPACE_ENTRY_NAME_CHARS = 1_024;
// Leave ample room for the response envelope under MAX_CONTROL_LINE_BYTES.
export const MAX_INSTANCE_LIST_RESULT_BYTES = 768 * 1_024;
export const MAX_CATALOG_PRUNE_ITEMS = 1_000;
const MAX_TEXT = 8_000;
const MAX_TOOL_RESULT_TEXT = 256_000;
const MAX_MESSAGE = 2_048;
const MAX_COLLECTION = 2_000;

export const TOOLS_EXPANDED_CAPABILITY = "extension_ui.tools-expanded.v1" as const;
export const EXTENSION_WIDGET_CAPABILITY = "extension_ui.widgets.v1" as const;
export const CONTROLLER_DIRECTIVES_CAPABILITY = "extension_ui.controller-directives.v1" as const;
export const PERSISTENT_INTERACTIONS_CAPABILITY = "extension_ui.persistent-interactions.v1" as const;
export const INSTANCE_READ_CAPABILITY = "instance.read.v1" as const;
export const EVENTS_FOLLOW_CAPABILITY = "events.follow.v2" as const;
export const EXTENSION_UI_CONTROL_CAPABILITY = "extension_ui.control.v1" as const;
export const GIT_BRANCH_CAPABILITY = "git.branch-footer.v1" as const;
export const TOOL_RESULT_PRESENTATION_CAPABILITY = "tool-result-presentation.v1" as const;
export const IMAGE_INPUT_CAPABILITY = "command.images.path.v1" as const;
export const INSTANCE_KEYS_CAPABILITY = "instance.keys.v1" as const;
export const INSTANCE_DISPLAY_NAME_CAPABILITY = "instance.display-name.v1" as const;
export const CONVERSATION_CONTENT_CAPABILITY = "conversation.content.v1" as const;
export const CONVERSATION_IMAGES_CAPABILITY = "conversation.images.v1" as const;
export const WORKSPACE_LIST_CAPABILITY = "workspace.list.v1" as const;
export const WORKSPACE_FILES_CAPABILITY = "workspace.files.v1" as const;
export const ATTACHMENTS_CAPABILITY = "attachments.v1" as const;
export const PUBLISHED_FILES_CAPABILITY = "published-files.v1" as const;
export const INSTANCE_DELIVERABLES_CAPABILITY = "instance.deliverables.v1" as const;
export const COMMAND_DISCOVERY_CAPABILITY = "command.discovery.v1" as const;
export const RESOURCE_CONTENT_CAPABILITY = "resource.content.v1" as const;
export const MACHINES_CAPABILITY = "machines.v1" as const;
export const WORKER_CONFIG_CAPABILITY = "instance.worker-config.v1" as const;
export { MACHINE_PLATFORMS, type MachineDto, type MachinePlatform, type MachinesResult } from "../core/machine-dto.js";

export const IMPLEMENTED_CAPABILITIES = [
  MACHINES_CAPABILITY,
  COMMAND_DISCOVERY_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  INSTANCE_DELIVERABLES_CAPABILITY,
  PUBLISHED_FILES_CAPABILITY,
  "catalog.maintenance.v1",
  "catalog.v1",
  CONVERSATION_CONTENT_CAPABILITY,
  CONVERSATION_IMAGES_CAPABILITY,
  "core.v2",
  IMAGE_INPUT_CAPABILITY,
  EVENTS_FOLLOW_CAPABILITY,
  INSTANCE_READ_CAPABILITY,
  EXTENSION_UI_CONTROL_CAPABILITY,
  TOOLS_EXPANDED_CAPABILITY,
  EXTENSION_WIDGET_CAPABILITY,
  CONTROLLER_DIRECTIVES_CAPABILITY,
  PERSISTENT_INTERACTIONS_CAPABILITY,
  GIT_BRANCH_CAPABILITY,
  TOOL_RESULT_PRESENTATION_CAPABILITY,
  "extension_ui.v1",
  "host.info",
  "instance.catalog",
  WORKER_CONFIG_CAPABILITY,
  INSTANCE_KEYS_CAPABILITY,
  INSTANCE_DISPLAY_NAME_CAPABILITY,
  "models.v1",
  "projection.completeness.v1",
  "queue.control.v1",
  "resources.v1",
  RESOURCE_CONTENT_CAPABILITY,
  "run.abort.v1",
  "service.managed.v1",
  "session.adopt.v1",
  "session.commands.v1",
  "session.core",
  "session.inventory.v1",
  "session.inventory-diagnostics.v1",
  "session.reopen",
  "session.tree.v2",
  "settings.v1",
  "tools.v1",
  "tui.projection.v1",
  WORKSPACE_LIST_CAPABILITY,
  WORKSPACE_FILES_CAPABILITY,
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
  | Request<"machine.list", Record<string, never>>
  | Request<"machine.remove", { operationId: string; hostId: string }>
  | Request<"attachment.upload", { operationId: string; instanceId?: string; name: string; sizeBytes: number; mediaType?: string; sha256: string }>
  | Request<"instance.create", { operationId: string; cwd: string; name?: string; hostId?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice; workerConfig?: JsonObject }>
  | Request<"instance.ensure", { operationId: string; key: string; cwd: string; name?: string; hostId?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"instance.adopt", { operationId: string; sessionFile: string; name?: string; hostId?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"instance.list", { selector: "actionable" | "all"; cursor?: InstanceListCursor; limit: number }>
  | Request<"instance.get_by_key", { key: string }>
  | Request<"instance.get", { instanceId: string }>
  | Request<"deliverable.list", { instanceId: string }>
  | Request<"deliverable.download", { instanceId: string; deliveryRef: string }>
  | Request<"workspace.entry.list", { instanceId: string; path: string; cursor?: WorkspaceListCursor; limit: number }>
  | Request<"workspace.entry.get", { instanceId: string; path: string }>
  | Request<"workspace.file.read", { instanceId: string; path: string }>
  | Request<"instance.read", { instanceId: string; since?: EventCursor; replay: "event_log" | "conversation_bootstrap" }>
  | Request<"instance.follow", { instanceId: string; since: EventCursor }>
  | Request<"interaction.control", { instanceId: string }>
  | Request<"instance.stop", { operationId: string; instanceId: string }>
  | Request<"instance.forget", { operationId: string; instanceId: string }>
  | Request<"catalog.prune", { operationId: string; selector: "stopped" }>
  | Request<"instance.reopen", { operationId: string; instanceId: string; sessionFile?: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"interaction.respond", { operationId: string; instanceId: string; leaseToken: string; interactionId: string; response: InteractionResponse }>
  | Request<"extension.tools_expanded.set", { operationId: string; instanceId: string; expectedRuntimeGeneration: number; expanded: boolean }>
  | Request<"extension.widget_viewport.set", { instanceId: string; leaseToken: string; expectedRuntimeGeneration: number; width: number; height: number }>
  | Request<"command.submit", { operationId: string; instanceId: string; message: string; images?: ImagePathDto[]; attachments?: string[]; delivery: DeliveryMode }>
  | Request<"command.abort", { operationId: string; instanceId: string }>
  | Request<"queue.dequeue", { operationId: string; instanceId: string }>
  | Request<"model.list", { instanceId: string }>
  | Request<"model.set", { operationId: string; instanceId: string; provider: string; modelId: string }>
  | Request<"thinking.set", { operationId: string; instanceId: string; level: ThinkingLevel }>
  | Request<"tool.list", { instanceId: string }>
  | Request<"tool.set_active", { operationId: string; instanceId: string; names: string[] }>
  | Request<"settings.get", { instanceId: string }>
  | Request<"settings.update", { operationId: string; instanceId: string; update: SettingUpdate }>
  | Request<"resource.get", { instanceId: string }>
  | Request<"resource.content", { instanceId: string; contentRef: string; offset?: number; revision?: string }>
  | Request<"command.catalog", { instanceId: string; prefix?: string }>
  | Request<"command.content", { instanceId: string; command: CommandReferenceDto; cursor?: string }>
  | Request<"command.complete", { instanceId: string; command: CommandReferenceDto; argumentPrefix: string }>
  | Request<"session.history", { instanceId: string; beforeEntryId?: string; limit: number }>
  | Request<"conversation.history", { instanceId: string; cursor?: string; limit: number }>
  | Request<"conversation.content", { instanceId: string; contentRef: string; cursor?: string }>
  | Request<"conversation.image", { instanceId: string; contentRef: string }>
  | Request<"file.read", { instanceId: string; fileRef: string; offset?: number }>
  | Request<"session.inventory", { cwd: string; scope: "cwd" | "all"; hostId?: string }>
  | Request<"session.list", { instanceId: string; scope: "cwd" | "all" }>
  | Request<"session.switch", { operationId: string; instanceId: string; sessionFile: string; trustChallengeId?: string; projectTrustDecision?: ProjectTrustChoice }>
  | Request<"session.new", { operationId: string; instanceId: string; parentSession?: string }>
  | Request<"session.name", { operationId: string; instanceId: string; name: string }>
  | Request<"session.compact", { operationId: string; instanceId: string; customInstructions?: string }>
  | Request<"session.reload", { operationId: string; instanceId: string }>
  | Request<"session.tree", { instanceId: string }>
  | Request<"session.navigate", { operationId: string; instanceId: string; targetId: string; summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }>
  | Request<"session.fork", { operationId: string; instanceId: string; entryId: string }>
  | Request<"session.clone", { operationId: string; instanceId: string; entryId: string }>
  | Request<"workspace.list", { path: string; cursor?: WorkspaceListCursor; limit: number; hostId?: string }>;

export type ControlRequestTarget = "dock" | "directory" | "instance";
export type ControlRequestEffect = "query" | "command";
export type ControlRequestTransport = "unary" | "follow" | "request_stream" | "response_stream" | "response_transfer";
export interface ControlRequestClassification {
  target: ControlRequestTarget;
  effect: ControlRequestEffect;
  transport: ControlRequestTransport;
}

type ControlRequestDescriptor = Omit<ControlRequestClassification, "target"> & {
  target: ControlRequestTarget | "optional_instance";
  availableDuringMutationFault?: true;
};

const CONTROL_REQUEST_DESCRIPTORS = {
  "host.info": { target: "dock", effect: "query", transport: "unary" },
  "machine.list": { target: "dock", effect: "query", transport: "unary" },
  "machine.remove": { target: "dock", effect: "command", transport: "unary" },
  "attachment.upload": { target: "optional_instance", effect: "command", transport: "request_stream" },
  "instance.create": { target: "directory", effect: "command", transport: "unary" },
  "instance.ensure": { target: "directory", effect: "command", transport: "unary" },
  "instance.adopt": { target: "directory", effect: "command", transport: "unary" },
  "instance.list": { target: "directory", effect: "query", transport: "unary" },
  "instance.get_by_key": { target: "directory", effect: "query", transport: "unary" },
  "instance.get": { target: "instance", effect: "query", transport: "unary" },
  "deliverable.list": { target: "instance", effect: "query", transport: "unary" },
  "deliverable.download": { target: "instance", effect: "query", transport: "response_stream" },
  "workspace.entry.list": { target: "instance", effect: "query", transport: "unary" },
  "workspace.entry.get": { target: "instance", effect: "query", transport: "unary" },
  "workspace.file.read": { target: "instance", effect: "query", transport: "response_stream" },
  "instance.read": { target: "instance", effect: "query", transport: "unary" },
  "instance.follow": { target: "instance", effect: "query", transport: "follow" },
  "interaction.control": { target: "instance", effect: "query", transport: "follow" },
  "instance.stop": { target: "instance", effect: "command", transport: "unary" },
  "instance.forget": { target: "instance", effect: "command", transport: "unary" },
  "catalog.prune": { target: "directory", effect: "command", transport: "unary" },
  "instance.reopen": { target: "instance", effect: "command", transport: "unary" },
  "interaction.respond": { target: "instance", effect: "command", transport: "unary" },
  "extension.tools_expanded.set": { target: "instance", effect: "command", transport: "unary" },
  "extension.widget_viewport.set": { target: "instance", effect: "command", transport: "unary", availableDuringMutationFault: true },
  "command.submit": { target: "instance", effect: "command", transport: "unary" },
  "command.abort": { target: "instance", effect: "command", transport: "unary" },
  "queue.dequeue": { target: "instance", effect: "command", transport: "unary" },
  "model.list": { target: "instance", effect: "query", transport: "unary" },
  "model.set": { target: "instance", effect: "command", transport: "unary" },
  "thinking.set": { target: "instance", effect: "command", transport: "unary" },
  "tool.list": { target: "instance", effect: "query", transport: "unary" },
  "tool.set_active": { target: "instance", effect: "command", transport: "unary" },
  "settings.get": { target: "instance", effect: "query", transport: "unary" },
  "settings.update": { target: "instance", effect: "command", transport: "unary" },
  "resource.get": { target: "instance", effect: "query", transport: "unary" },
  "resource.content": { target: "instance", effect: "query", transport: "unary" },
  "command.catalog": { target: "instance", effect: "query", transport: "unary" },
  "command.content": { target: "instance", effect: "query", transport: "unary" },
  "command.complete": { target: "instance", effect: "query", transport: "unary" },
  "session.history": { target: "instance", effect: "query", transport: "unary" },
  "conversation.history": { target: "instance", effect: "query", transport: "unary" },
  "conversation.content": { target: "instance", effect: "query", transport: "unary" },
  "conversation.image": { target: "instance", effect: "query", transport: "response_stream" },
  "file.read": { target: "instance", effect: "query", transport: "unary" },
  "session.inventory": { target: "directory", effect: "query", transport: "unary" },
  "session.list": { target: "instance", effect: "query", transport: "unary" },
  "session.switch": { target: "instance", effect: "command", transport: "unary" },
  "session.new": { target: "instance", effect: "command", transport: "unary" },
  "session.name": { target: "instance", effect: "command", transport: "unary" },
  "session.compact": { target: "instance", effect: "command", transport: "unary" },
  "session.reload": { target: "instance", effect: "command", transport: "unary" },
  "session.tree": { target: "instance", effect: "query", transport: "response_transfer" },
  "session.navigate": { target: "instance", effect: "command", transport: "unary" },
  "session.fork": { target: "instance", effect: "command", transport: "unary" },
  "session.clone": { target: "instance", effect: "command", transport: "unary" },
  "workspace.list": { target: "directory", effect: "query", transport: "unary" },
} as const satisfies Record<ControlRequest["type"], ControlRequestDescriptor>;

export function controlRequestDescriptor(type: ControlRequest["type"]): ControlRequestDescriptor {
  return CONTROL_REQUEST_DESCRIPTORS[type];
}

export function classifyControlRequest(request: ControlRequest): ControlRequestClassification {
  const descriptor = controlRequestDescriptor(request.type);
  const target = descriptor.target === "optional_instance"
    ? ("instanceId" in request.params && request.params.instanceId !== undefined ? "instance" : "directory")
    : descriptor.target;
  return { target, effect: descriptor.effect, transport: descriptor.transport };
}

export function instanceTargetId(request: ControlRequest): string | undefined {
  if (classifyControlRequest(request).target !== "instance") return undefined;
  const instanceId = "instanceId" in request.params ? request.params.instanceId : undefined;
  if (typeof instanceId !== "string") throw new Error(`Instance request ${request.type} has no instance identity`);
  return instanceId;
}

export interface ControlError { code: string; message: string; retryable: boolean; details?: JsonObject }
export type ControlResponse =
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: true; result: unknown }
  | { kind: "response"; version: 2; requestId: string; hostEpoch: string; ok: false; error: ControlError };
export interface ResponseTransferFrame {
  kind: "response_transfer";
  version: 2;
  requestId: string;
  hostEpoch: string;
  index: number;
  count: number;
  data: string;
}
export interface ControlEventEnvelope { kind: "event"; version: 2; requestId: string; hostEpoch: string; event: DockEvent }

interface DeliverableDownloadIdentity { version: 2; requestId: string; hostEpoch: string; instanceId: string; deliveryRef: string }
export interface DeliverableDownloadReady extends DeliverableDownloadIdentity { kind: "deliverable_download_ready"; deliverable: DeliverableDto }
export interface DeliverableDownloadChunk extends DeliverableDownloadIdentity { kind: "deliverable_download_chunk"; index: number; data: string }
export interface DeliverableDownloadComplete extends DeliverableDownloadIdentity { kind: "deliverable_download_complete"; chunks: number; sizeBytes: number; sha256: string }
export interface DeliverableDownloadError extends DeliverableDownloadIdentity { kind: "deliverable_download_error"; error: { code: "file_unavailable"; message: string } }
export type DeliverableDownloadFrame = DeliverableDownloadReady | DeliverableDownloadChunk | DeliverableDownloadComplete | DeliverableDownloadError;

interface WorkspaceFileReadIdentity { version: 2; requestId: string; hostEpoch: string; instanceId: string; path: string }
export interface WorkspaceFileReadReady extends WorkspaceFileReadIdentity { kind: "workspace_file_read_ready"; entry: WorkspaceEntryDto }
export interface WorkspaceFileReadChunk extends WorkspaceFileReadIdentity { kind: "workspace_file_read_chunk"; index: number; data: string }
export interface WorkspaceFileReadComplete extends WorkspaceFileReadIdentity { kind: "workspace_file_read_complete"; chunks: number; sizeBytes: number; sha256: string }
export interface WorkspaceFileReadError extends WorkspaceFileReadIdentity { kind: "workspace_file_read_error"; error: { code: "workspace_entry_unavailable" | "workspace_file_too_large"; message: string } }
export type WorkspaceFileReadFrame = WorkspaceFileReadReady | WorkspaceFileReadChunk | WorkspaceFileReadComplete | WorkspaceFileReadError;

interface ConversationImageIdentity { version: 2; requestId: string; hostEpoch: string; instanceId: string; contentRef: string }
export interface ConversationImageReady extends ConversationImageIdentity { kind: "conversation_image_ready"; mimeType: string; sizeBytes: number; sha256: string }
export interface ConversationImageChunk extends ConversationImageIdentity { kind: "conversation_image_chunk"; index: number; data: string }
export interface ConversationImageComplete extends ConversationImageIdentity { kind: "conversation_image_complete"; chunks: number; sizeBytes: number; sha256: string }
export interface ConversationImageError extends ConversationImageIdentity { kind: "conversation_image_error"; error: { code: "image_unavailable"; message: string } }
export type ConversationImageFrame = ConversationImageReady | ConversationImageChunk | ConversationImageComplete | ConversationImageError;

export interface AttachmentUploadReady {
  kind: "attachment_upload_ready";
  version: 2;
  requestId: string;
  hostEpoch: string;
  maxChunkBytes: number;
}
export interface AttachmentUploadChunk {
  kind: "attachment_chunk";
  version: 2;
  requestId: string;
  index: number;
  data: string;
}
export interface AttachmentUploadComplete {
  kind: "attachment_complete";
  version: 2;
  requestId: string;
  chunks: number;
}
export type AttachmentUploadFrame = AttachmentUploadChunk | AttachmentUploadComplete;

export interface HostInfoResult {
  state: "ready" | "mutation_faulted" | "draining";
  host: HostIdentity;
  catalog: { schemaVersion: number; revision: number; lastReconciledAt: string };
  paths: { socket: string; state: string };
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; source?: string }>;
}
export interface PingResult { pid: number; protocolVersion: 2; hostEpoch: string; capabilities: string[] }
export interface MachineRemovalResult { hostId: string; removed: boolean }
export interface CreateResult { instance: InstanceSnapshot }
export interface EnsureResult { created: boolean; instance: InstanceSnapshot }
export interface KeyLookupResult { instance: InstanceSnapshot | null }
export type AdoptResult = CreateResult;
export interface InstanceListCursor { revision: number; offset: number; selector: "actionable" | "all" }
export interface ListResult {
  instances: InstanceSnapshot[];
  page: { revision: number; total: number; hiddenStopped: number; nextCursor?: InstanceListCursor };
}
export interface WorkspaceListCursor { revision: string; offset: number }
export interface WorkspaceDirectoryEntry {
  name: string;
  kind: "directory" | "symlink";
  hidden: boolean;
}
export interface WorkspaceListResult {
  path: string;
  parent?: string;
  revision: string;
  entries: WorkspaceDirectoryEntry[];
  total: number;
  truncated: boolean;
  nextCursor?: WorkspaceListCursor;
}
export interface WorkspaceEntryDto {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink";
  hidden: boolean;
  targetKind?: "file" | "directory" | "unavailable";
  sizeBytes?: number;
}
export interface WorkspaceEntryListResult {
  instanceId: string;
  path: string;
  revision: string;
  entries: WorkspaceEntryDto[];
  total: number;
  truncated: boolean;
  nextCursor?: WorkspaceListCursor;
}
export interface WorkspaceEntryGetResult { instanceId: string; entry: WorkspaceEntryDto }
export interface WorkspaceFileReadResult { entry: WorkspaceEntryDto; chunks: number; sizeBytes: number; sha256: string }
export interface StatusResult { instance: InstanceSnapshot }
export interface DeliverableListResult { instanceId: string; deliverables: DeliverableDto[] }
export interface InstanceReadResult {
  instance: InstanceSnapshot;
  page: EventPage & { epochChanged: boolean; generationChanged: boolean };
  recentHistory: HistoryEntryDto[];
  historyRevision: number;
  historyTruncated: boolean;
  pendingMessages: PendingMessageDto[];
}
export interface FollowResult { page: EventPage & { epochChanged: boolean; generationChanged: boolean } }
export interface ExtensionUiControlResult { instanceId: string; runtimeGeneration: number; leaseToken: string; controllerId: string }
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
export interface ModelsResult { models: AgentModelInfo[]; availableThinkingLevels: ThinkingLevel[]; instance: InstanceSnapshot; total: number; truncated: boolean }
export interface ModelConfigurationResult { instance: InstanceSnapshot; settingsWrite: { persisted: true } }
export interface ThinkingConfigurationResult { actualLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[]; instance: InstanceSnapshot; settingsWrite: { persisted: true } }
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
export interface HistoryResult { historyRevision: number; entries: HistoryEntryDto[]; hasEarlier: boolean; nextBeforeEntryId?: string; instance: InstanceSnapshot }
export type ConversationHistoryResult = ConversationHistoryPageDto;
export type ConversationContentResult = ConversationContentPageDto;
export type FileReadResult = PublishedFileReadPage & { instanceId: string; runtimeGeneration: number };
export interface SessionReplacementResult { cancelled: boolean; instance: InstanceSnapshot }
export interface SessionNameResult { instance: InstanceSnapshot }
export interface SessionCompactionResult { result: { summary: string; firstKeptEntryId: string; tokensBefore: number }; instance: InstanceSnapshot }
export interface SessionReloadResult extends ResourcesResult { instance: InstanceSnapshot }
export interface SessionTreeResult { nodes: TreeNodeDto[]; leafId?: string }
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
export interface ResourceContentResult { text: string; revision: string; nextOffset?: number }
export interface CommandsResult { commands: CommandDto[]; total: number; truncated: boolean }
export type CommandContentResult =
  | { command: CommandReferenceDto; available: false }
  | {
    command: CommandReferenceDto;
    available: true;
    format: "markdown";
    revision: string;
    text: string;
    complete: boolean;
    nextCursor?: string;
  };
export interface CommandCompletionsResult {
  command: CommandReferenceDto;
  items: CommandArgumentCompletionDto[] | null;
  total: number;
  truncated: boolean;
}
export type { AttachmentDto, AttachmentUploadResult, DeliverableDto };
export type ConfigurationResult = ModelConfigurationResult | ThinkingConfigurationResult | SettingUpdateResult;

export function implementedCapabilities(): string[] { return [...IMPLEMENTED_CAPABILITIES].sort(); }
export function capabilityForRequest(type: ControlRequest["type"]): Capability {
  if (type === "host.info") return "host.info";
  if (type === "machine.list" || type === "machine.remove") return MACHINES_CAPABILITY;
  if (type === "attachment.upload") return ATTACHMENTS_CAPABILITY;
  if (type === "deliverable.list" || type === "deliverable.download") return INSTANCE_DELIVERABLES_CAPABILITY;
  if (type === "workspace.entry.list" || type === "workspace.entry.get" || type === "workspace.file.read") return WORKSPACE_FILES_CAPABILITY;
  if (type === "instance.forget" || type === "catalog.prune") return "catalog.maintenance.v1";
  if (type === "extension.tools_expanded.set") return TOOLS_EXPANDED_CAPABILITY;
  if (type === "extension.widget_viewport.set") return EXTENSION_WIDGET_CAPABILITY;
  if (type === "interaction.respond") return "extension_ui.v1";
  if (type === "interaction.control") return EXTENSION_UI_CONTROL_CAPABILITY;
  if (type === "instance.reopen") return "session.reopen";
  if (type === "instance.adopt") return "session.adopt.v1";
  if (type === "instance.ensure" || type === "instance.get_by_key") return INSTANCE_KEYS_CAPABILITY;
  if (type === "instance.read") return INSTANCE_READ_CAPABILITY;
  if (type === "instance.follow") return EVENTS_FOLLOW_CAPABILITY;
  if (type.startsWith("instance.")) return "instance.catalog";
  if (type === "command.abort") return "run.abort.v1";
  if (type === "queue.dequeue") return "queue.control.v1";
  if (type === "session.history") return "tui.projection.v1";
  if (type === "conversation.history" || type === "conversation.content") return CONVERSATION_CONTENT_CAPABILITY;
  if (type === "conversation.image") return CONVERSATION_IMAGES_CAPABILITY;
  if (type === "file.read") return PUBLISHED_FILES_CAPABILITY;
  if (type === "workspace.list") return WORKSPACE_LIST_CAPABILITY;
  if (type === "session.inventory") return "session.inventory.v1";
  if (type === "session.tree" || type === "session.navigate" || type === "session.fork" || type === "session.clone") return "session.tree.v2";
  if (type === "command.submit" || type === "session.list") return "session.core";
  if (type.startsWith("session.")) return "session.commands.v1";
  if (type.startsWith("tool.")) return "tools.v1";
  if (type.startsWith("settings.")) return "settings.v1";
  if (type === "command.content" || type === "command.complete") return COMMAND_DISCOVERY_CAPABILITY;
  if (type === "resource.content") return RESOURCE_CONTENT_CAPABILITY;
  if (type === "resource.get" || type === "command.catalog") return "resources.v1";
  return "models.v1";
}
export function requiredCapabilities(capability: Capability): string[] {
  return [...new Set<Capability>([
    "core.v2",
    ...(capability === EVENTS_FOLLOW_CAPABILITY ? [INSTANCE_READ_CAPABILITY] : []),
    ...(capability === WORKER_CONFIG_CAPABILITY ? ["instance.catalog" as const] : []),
    ...(capabilityProjectsInstanceSnapshot(capability) ? [TOOLS_EXPANDED_CAPABILITY, GIT_BRANCH_CAPABILITY, INSTANCE_KEYS_CAPABILITY, INSTANCE_DISPLAY_NAME_CAPABILITY] : []),
    ...(capabilityProjectsToolResults(capability) ? [TOOL_RESULT_PRESENTATION_CAPABILITY] : []),
    capability,
  ])];
}

function capabilityProjectsToolResults(capability: Capability): boolean {
  return capability === EVENTS_FOLLOW_CAPABILITY
    || capability === INSTANCE_READ_CAPABILITY
    || capability === "tui.projection.v1"
    || capability === TOOL_RESULT_PRESENTATION_CAPABILITY;
}

function capabilityProjectsInstanceSnapshot(capability: Capability): boolean {
  return capability === TOOLS_EXPANDED_CAPABILITY
    || capability === GIT_BRANCH_CAPABILITY
    || capability === INSTANCE_KEYS_CAPABILITY
    || capability === INSTANCE_DISPLAY_NAME_CAPABILITY
    || capability === CONVERSATION_CONTENT_CAPABILITY
    || capability === EVENTS_FOLLOW_CAPABILITY
    || capability === INSTANCE_READ_CAPABILITY
    || capability === WORKER_CONFIG_CAPABILITY
    || capability === "instance.catalog"
    || capability === "models.v1"
    || capability === "queue.control.v1"
    || capability === "run.abort.v1"
    || capability === "session.adopt.v1"
    || capability === "session.commands.v1"
    || capability === "session.core"
    || capability === "session.reopen"
    || capability === "session.tree.v2"
    || capability === "settings.v1"
    || capability === "tools.v1"
    || capability === "tui.projection.v1";
}
export function createHelloAck(requestId: string, host: HostIdentity, capabilities = implementedCapabilities()): HelloAck {
  return {
    kind: "hello_ack",
    requestId,
    version: 2,
    host,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    capabilities: [...capabilities].sort(),
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
  const hostId = (): string | undefined => optionalString(params.hostId, "params.hostId", 128, "invalid_request");
  switch (type) {
    case "host.info": exact(params, [], "invalid_request"); return { ...base, type, params: {} };
    case "machine.list": exact(params, [], "invalid_request"); return { ...base, type, params: {} };
    case "machine.remove": {
      exact(params, ["operationId", "hostId"], "invalid_request");
      return { ...base, type, params: { operationId: operationId(), hostId: string(params.hostId, "params.hostId", 128, "invalid_request") } };
    }
    case "attachment.upload": {
      exact(params, ["operationId", "instanceId", "name", "sizeBytes", "mediaType", "sha256"], "invalid_request");
      const uploadInstanceId = params.instanceId === undefined ? undefined : instanceId();
      const name = boundedString(params.name, "params.name", MAX_ATTACHMENT_NAME_CHARS, "invalid_request");
      if (name.length === 0) throw validation("invalid_request", "params.name must not be empty");
      const sizeBytes = unsigned(params.sizeBytes, "params.sizeBytes", "invalid_request");
      if (sizeBytes > MAX_ATTACHMENT_BYTES) throw validation("invalid_request", `params.sizeBytes must not exceed ${MAX_ATTACHMENT_BYTES}`);
      const mediaType = optionalString(params.mediaType, "params.mediaType", MAX_ATTACHMENT_MEDIA_TYPE_CHARS, "invalid_request");
      if (mediaType !== undefined && (mediaType.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(mediaType))) throw validation("invalid_request", "params.mediaType must be nonempty and control-free");
      const sha256 = string(params.sha256, "params.sha256", 64, "invalid_request");
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw validation("invalid_request", "params.sha256 must be 64 lowercase hexadecimal characters");
      return { ...base, type, params: { operationId: operationId(), ...(uploadInstanceId === undefined ? {} : { instanceId: uploadInstanceId }), name, sizeBytes, ...(mediaType === undefined ? {} : { mediaType }), sha256 } };
    }
    case "instance.create": {
      exact(params, ["operationId", "cwd", "name", "hostId", "trustChallengeId", "projectTrustDecision", "workerConfig"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const selectedHost = hostId();
      let workerConfig: JsonObject | undefined;
      if (params.workerConfig !== undefined) {
        try { workerConfig = cloneWorkerConfig(params.workerConfig, "params.workerConfig"); }
        catch (error) { throw validation("invalid_request", error instanceof Error ? error.message : "params.workerConfig is invalid"); }
      }
      return { ...base, type, params: { operationId: operationId(), cwd: string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request"), name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request"), ...(selectedHost === undefined ? {} : { hostId: selectedHost }), trustChallengeId, projectTrustDecision, ...(workerConfig === undefined ? {} : { workerConfig }) } };
    }
    case "instance.ensure": {
      exact(params, ["operationId", "key", "cwd", "name", "hostId", "trustChallengeId", "projectTrustDecision"], "invalid_request");
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
        ...(params.hostId === undefined ? {} : { hostId: hostId() }),
        trustChallengeId,
        projectTrustDecision,
      } };
    }
    case "instance.adopt": {
      exact(params, ["operationId", "sessionFile", "name", "hostId", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const sessionFile = string(params.sessionFile, "params.sessionFile", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (!isPortableAbsoluteLocalPath(sessionFile)) throw validation("invalid_request", "params.sessionFile must be absolute");
      const selectedHost = hostId();
      return { ...base, type, params: { operationId: operationId(), sessionFile, name: optionalString(params.name, "params.name", MAX_INSTANCE_NAME_CHARS, "invalid_request"), ...(selectedHost === undefined ? {} : { hostId: selectedHost }), trustChallengeId, projectTrustDecision } };
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
    case "deliverable.list": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "deliverable.download": {
      exact(params, ["instanceId", "deliveryRef"], "invalid_request");
      return { ...base, type, params: { instanceId: instanceId(), deliveryRef: string(params.deliveryRef, "params.deliveryRef", MAX_DELIVERY_REF_CHARS, "invalid_request") } };
    }
    case "workspace.entry.list": {
      exact(params, ["instanceId", "path", "cursor", "limit"], "invalid_request");
      const limit = positive(params.limit, "params.limit", "invalid_request");
      if (limit > MAX_WORKSPACE_LIST_ITEMS) throw validation("invalid_request", `params.limit must not exceed ${MAX_WORKSPACE_LIST_ITEMS}`);
      return { ...base, type, params: { instanceId: instanceId(), path: normalizeWorkspaceRelativePath(string(params.path, "params.path", MAX_CONTROL_CWD_CHARS, "invalid_request")), cursor: params.cursor === undefined ? undefined : parseWorkspaceListCursor(params.cursor, "params.cursor", "invalid_request"), limit } };
    }
    case "workspace.entry.get":
    case "workspace.file.read":
      exact(params, ["instanceId", "path"], "invalid_request");
      return { ...base, type, params: { instanceId: instanceId(), path: normalizeWorkspaceRelativePath(string(params.path, "params.path", MAX_CONTROL_CWD_CHARS, "invalid_request")) } };
    case "instance.read": {
      exact(params, ["instanceId", "since", "replay"], "invalid_request");
      const replay = enumeration(params.replay, "params.replay", ["event_log", "conversation_bootstrap"], "invalid_request");
      const since = params.since === undefined ? undefined : parseCursor(params.since, "params.since", "invalid_request");
      if (replay === "conversation_bootstrap" && since !== undefined) throw validation("invalid_request", "conversation bootstrap requires a fresh read");
      return { ...base, type, params: { instanceId: instanceId(), since, replay } };
    }
    case "instance.follow": {
      exact(params, ["instanceId", "since"], "invalid_request");
      return { ...base, type, params: { instanceId: instanceId(), since: parseCursor(params.since, "params.since", "invalid_request") } };
    }
    case "interaction.control": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
    case "instance.stop": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "instance.forget": exact(params, ["operationId", "instanceId"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), instanceId: instanceId() } };
    case "catalog.prune": exact(params, ["operationId", "selector"], "invalid_request"); return { ...base, type, params: { operationId: operationId(), selector: enumeration(params.selector, "params.selector", ["stopped"], "invalid_request") } };
    case "instance.reopen": {
      exact(params, ["operationId", "instanceId", "sessionFile", "trustChallengeId", "projectTrustDecision"], "invalid_request");
      const trustChallengeId = optionalString(params.trustChallengeId, "params.trustChallengeId", MAX_CONTROL_REQUEST_ID_CHARS, "invalid_request");
      const projectTrustDecision = params.projectTrustDecision === undefined ? undefined : enumeration(params.projectTrustDecision, "params.projectTrustDecision", ["trust_once", "trust_and_remember", "deny_once", "deny_and_remember"], "invalid_request");
      if ((trustChallengeId === undefined) !== (projectTrustDecision === undefined)) throw validation("invalid_request", "trustChallengeId and projectTrustDecision must be supplied together");
      const sessionFile = optionalString(params.sessionFile, "params.sessionFile", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (sessionFile !== undefined && !isPortableAbsoluteLocalPath(sessionFile)) throw validation("invalid_request", "params.sessionFile must be absolute");
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
      exact(params, ["operationId", "instanceId", "message", "images", "attachments", "delivery"], "invalid_request");
      const message = boundedString(params.message, "params.message", MAX_PROMPT_CHARS, "invalid_request");
      const images = params.images === undefined ? undefined : parseImagePaths(params.images, "params.images", "invalid_request");
      const attachments = params.attachments === undefined
        ? undefined
        : strings(params.attachments, "params.attachments", MAX_ATTACHMENT_IDS_PER_COMMAND, MAX_ATTACHMENT_FILE_ID_CHARS, "invalid_request");
      if (attachments !== undefined && (attachments.length === 0 || new Set(attachments).size !== attachments.length)) throw validation("invalid_request", "params.attachments must be a nonempty unique fileId array");
      if (message.trim().length === 0 && (images === undefined || images.length === 0) && attachments === undefined) throw validation("invalid_request", "command.submit requires message text, an image, or an attachment");
      return { ...base, type, params: { operationId: operationId(), instanceId: instanceId(), message, ...(images === undefined ? {} : { images }), ...(attachments === undefined ? {} : { attachments }), delivery: enumeration(params.delivery, "params.delivery", ["auto", "prompt", "steer", "followUp"], "invalid_request") } };
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
    case "resource.content": {
      exact(params, ["instanceId", "contentRef", "offset", "revision"], "invalid_request");
      const offset = params.offset === undefined ? undefined : unsigned(params.offset, "params.offset", "invalid_request");
      const revision = optionalString(params.revision, "params.revision", 128, "invalid_request");
      if (offset !== undefined && offset > 0 && revision === undefined) throw validation("invalid_request", "Resource continuation requires revision");
      return { ...base, type, params: { instanceId: instanceId(), contentRef: string(params.contentRef, "params.contentRef", 128, "invalid_request"), offset, revision } };
    }
    case "command.catalog": exact(params, ["instanceId", "prefix"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId(), prefix: optionalString(params.prefix, "params.prefix", 256, "invalid_request") } };
    case "command.content": {
      exact(params, ["instanceId", "command", "cursor"], "invalid_request");
      return { ...base, type, params: {
        instanceId: instanceId(),
        command: parseCommandReference(params.command, "params.command", "invalid_request"),
        cursor: optionalString(params.cursor, "params.cursor", 128, "invalid_request"),
      } };
    }
    case "command.complete": {
      exact(params, ["instanceId", "command", "argumentPrefix"], "invalid_request");
      return { ...base, type, params: {
        instanceId: instanceId(),
        command: parseCommandReference(params.command, "params.command", "invalid_request"),
        argumentPrefix: boundedString(params.argumentPrefix, "params.argumentPrefix", MAX_COMMAND_ARGUMENT_PREFIX_CHARS, "invalid_request"),
      } };
    }
    case "session.history": {
      exact(params, ["instanceId", "beforeEntryId", "limit"], "invalid_request");
      if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > MAX_HISTORY_ITEMS) throw validation("invalid_request", `params.limit must be between 1 and ${MAX_HISTORY_ITEMS}`);
      return { ...base, type, params: { instanceId: instanceId(), beforeEntryId: optionalString(params.beforeEntryId, "params.beforeEntryId", 128, "invalid_request"), limit: params.limit as number } };
    }
    case "conversation.history": {
      exact(params, ["instanceId", "cursor", "limit"], "invalid_request");
      if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > MAX_CONVERSATION_HISTORY_ITEMS) throw validation("invalid_request", `params.limit must be between 1 and ${MAX_CONVERSATION_HISTORY_ITEMS}`);
      return { ...base, type, params: { instanceId: instanceId(), cursor: optionalString(params.cursor, "params.cursor", 128, "invalid_request"), limit: params.limit as number } };
    }
    case "conversation.content": {
      exact(params, ["instanceId", "contentRef", "cursor"], "invalid_request");
      return { ...base, type, params: {
        instanceId: instanceId(),
        contentRef: string(params.contentRef, "params.contentRef", 128, "invalid_request"),
        cursor: optionalString(params.cursor, "params.cursor", 128, "invalid_request"),
      } };
    }
    case "conversation.image": {
      exact(params, ["instanceId", "contentRef"], "invalid_request");
      return { ...base, type, params: {
        instanceId: instanceId(),
        contentRef: string(params.contentRef, "params.contentRef", 128, "invalid_request"),
      } };
    }
    case "file.read": {
      exact(params, ["instanceId", "fileRef", "offset"], "invalid_request");
      const offset = params.offset === undefined ? undefined : unsigned(params.offset, "params.offset", "invalid_request");
      if (offset !== undefined && offset > MAX_PUBLISHED_FILE_BYTES) throw validation("invalid_request", "params.offset exceeds the published-file bound");
      return { ...base, type, params: { instanceId: instanceId(), fileRef: string(params.fileRef, "params.fileRef", MAX_PUBLISHED_FILE_REF_CHARS, "invalid_request"), offset } };
    }
    case "session.inventory": {
      exact(params, ["cwd", "scope", "hostId"], "invalid_request");
      const cwd = string(params.cwd, "params.cwd", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (!isPortableAbsoluteLocalPath(cwd)) throw validation("invalid_request", "params.cwd must be absolute");
      const selectedHost = hostId();
      return { ...base, type, params: { cwd, scope: enumeration(params.scope, "params.scope", ["cwd", "all"], "invalid_request"), ...(selectedHost === undefined ? {} : { hostId: selectedHost }) } };
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
    case "session.tree": exact(params, ["instanceId"], "invalid_request"); return { ...base, type, params: { instanceId: instanceId() } };
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
    case "workspace.list": {
      exact(params, ["path", "cursor", "limit", "hostId"], "invalid_request");
      const path = string(params.path, "params.path", MAX_CONTROL_CWD_CHARS, "invalid_request");
      if (!isPortableAbsoluteLocalPath(path)) throw validation("invalid_request", "params.path must be absolute");
      const limit = positive(params.limit, "params.limit", "invalid_request");
      if (limit > MAX_WORKSPACE_LIST_ITEMS) throw validation("invalid_request", `params.limit must not exceed ${MAX_WORKSPACE_LIST_ITEMS}`);
      const cursor = params.cursor === undefined ? undefined : parseWorkspaceListCursor(params.cursor, "params.cursor", "invalid_request");
      const selectedHost = hostId();
      return { ...base, type, params: { path, cursor, limit, ...(selectedHost === undefined ? {} : { hostId: selectedHost }) } };
    }
    default: throw validation("unknown_request", `Unknown request type: ${type}`);
  }
}

export function parseWorkspaceEntryListResult(input: unknown): WorkspaceEntryListResult {
  const value = object(input, "workspace entry list result");
  exact(value, ["instanceId", "path", "revision", "entries", "total", "truncated", "nextCursor"]);
  const entries = array(value.entries, "entries", MAX_WORKSPACE_LIST_ITEMS).map((item, index) => parseWorkspaceEntryDto(item, `entries[${index}]`));
  const total = unsigned(value.total, "total");
  const truncated = boolean(value.truncated, "truncated");
  const nextCursor = value.nextCursor === undefined ? undefined : parseWorkspaceListCursor(value.nextCursor, "nextCursor", "invalid_response");
  if (entries.length > total || truncated !== (nextCursor !== undefined)) throw validation("invalid_response", "Workspace entry continuation metadata is inconsistent");
  return {
    instanceId: id(value.instanceId, "instanceId"),
    path: workspaceRelativePath(value.path, "path"),
    revision: string(value.revision, "revision", 128),
    entries,
    total,
    truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function parseWorkspaceEntryGetResult(input: unknown): WorkspaceEntryGetResult {
  const value = object(input, "workspace entry result");
  exact(value, ["instanceId", "entry"]);
  return { instanceId: id(value.instanceId, "instanceId"), entry: parseWorkspaceEntryDto(value.entry, "entry") };
}

export function parseWorkspaceFileReadFrame(input: unknown, expected: { requestId: string; hostEpoch: string; instanceId: string; path: string }): WorkspaceFileReadFrame {
  const value = object(input, "workspace file read frame");
  const identity = (): WorkspaceFileReadIdentity => {
    if (value.version !== 2 || value.requestId !== expected.requestId || value.hostEpoch !== expected.hostEpoch || value.instanceId !== expected.instanceId || value.path !== expected.path) {
      throw validation("invalid_response", "Workspace file frame identity does not match the request");
    }
    return { version: 2, ...expected };
  };
  if (value.kind === "workspace_file_read_ready") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "path", "entry"]);
    const entry = parseWorkspaceEntryDto(value.entry, "entry");
    if (entry.path !== expected.path || (entry.kind !== "file" && entry.targetKind !== "file") || entry.sizeBytes === undefined) throw validation("invalid_response", "Workspace file readiness metadata does not match the request");
    return { kind: "workspace_file_read_ready", ...identity(), entry };
  }
  if (value.kind === "workspace_file_read_chunk") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "path", "index", "data"]);
    const data = canonicalBase64(value.data, "workspace file chunk data", MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES);
    if (data.length === 0) throw validation("invalid_response", "Workspace file chunks cannot be empty");
    return { kind: "workspace_file_read_chunk", ...identity(), index: unsigned(value.index, "workspace file chunk index"), data };
  }
  if (value.kind === "workspace_file_read_complete") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "path", "chunks", "sizeBytes", "sha256"]);
    const sha256 = string(value.sha256, "workspace file SHA-256", 64);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw validation("invalid_response", "Workspace file SHA-256 must be lowercase hexadecimal");
    const sizeBytes = unsigned(value.sizeBytes, "workspace file byte count");
    if (sizeBytes > MAX_SOURCE_FILE_TRANSFER_BYTES) throw validation("invalid_response", "Workspace file byte count exceeds its bound");
    return { kind: "workspace_file_read_complete", ...identity(), chunks: unsigned(value.chunks, "workspace file chunk count"), sizeBytes, sha256 };
  }
  if (value.kind !== "workspace_file_read_error") throw validation("invalid_response", "Unknown workspace file read frame");
  exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "path", "error"]);
  const error = object(value.error, "workspace file read error");
  exact(error, ["code", "message"]);
  const code = enumeration(error.code, "workspace file read error code", ["workspace_entry_unavailable", "workspace_file_too_large"]);
  return { kind: "workspace_file_read_error", ...identity(), error: { code, message: string(error.message, "workspace file read error message", MAX_MESSAGE) } };
}

/** Worker-produced conversation image body. The Host validates it before public streaming. */
export function parseConversationImageBody(input: unknown): ConversationImageBody {
  const value = object(input, "conversation image body");
  exact(value, ["contentRef", "mimeType", "sizeBytes", "sha256", "data"]);
  const contentRef = string(value.contentRef, "conversation image content reference", 128);
  const mimeType = imageMimeType(value.mimeType, "conversation image MIME type");
  const sizeBytes = boundedImageSize(value.sizeBytes, "conversation image byte count");
  const sha256 = imageSha256(value.sha256, "conversation image SHA-256");
  const data = canonicalBase64(value.data, "conversation image data", MAX_IMAGE_BYTES);
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength !== sizeBytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw validation("invalid_response", "Conversation image metadata does not match its bytes");
  }
  return { contentRef, mimeType, sizeBytes, sha256, data };
}

export function parseConversationImageFrame(input: unknown, expected: { requestId: string; hostEpoch: string; instanceId: string; contentRef: string }): ConversationImageFrame {
  const value = object(input, "conversation image frame");
  const identity = (): ConversationImageIdentity => {
    if (value.version !== 2 || value.requestId !== expected.requestId || value.hostEpoch !== expected.hostEpoch
      || value.instanceId !== expected.instanceId || value.contentRef !== expected.contentRef) {
      throw validation("invalid_response", "Conversation image frame identity does not match the request");
    }
    return { version: 2, ...expected };
  };
  if (value.kind === "conversation_image_ready") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "contentRef", "mimeType", "sizeBytes", "sha256"]);
    const mimeType = imageMimeType(value.mimeType, "conversation image MIME type");
    const sizeBytes = boundedImageSize(value.sizeBytes, "conversation image byte count");
    return { kind: "conversation_image_ready", ...identity(), mimeType, sizeBytes, sha256: imageSha256(value.sha256, "conversation image SHA-256") };
  }
  if (value.kind === "conversation_image_chunk") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "contentRef", "index", "data"]);
    const data = canonicalBase64(value.data, "conversation image chunk data", MAX_CONVERSATION_IMAGE_CHUNK_BYTES);
    if (data.length === 0) throw validation("invalid_response", "Conversation image chunks cannot be empty");
    return { kind: "conversation_image_chunk", ...identity(), index: unsigned(value.index, "conversation image chunk index"), data };
  }
  if (value.kind === "conversation_image_complete") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "contentRef", "chunks", "sizeBytes", "sha256"]);
    return {
      kind: "conversation_image_complete", ...identity(), chunks: unsigned(value.chunks, "conversation image chunk count"),
      sizeBytes: boundedImageSize(value.sizeBytes, "conversation image byte count"), sha256: imageSha256(value.sha256, "conversation image SHA-256"),
    };
  }
  exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "contentRef", "error"]);
  if (value.kind !== "conversation_image_error") throw validation("invalid_response", "Unknown conversation image frame");
  const error = object(value.error, "conversation image error");
  exact(error, ["code", "message"]);
  if (error.code !== "image_unavailable") throw validation("invalid_response", "Conversation image terminal error code is invalid");
  return { kind: "conversation_image_error", ...identity(), error: { code: "image_unavailable", message: string(error.message, "conversation image error message", MAX_MESSAGE) } };
}

function imageSha256(input: unknown, field: string): string {
  const value = string(input, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw validation("invalid_response", `${field} must be lowercase hexadecimal`);
  return value;
}
function boundedImageSize(input: unknown, field: string): number {
  const value = unsigned(input, field);
  if (value > MAX_IMAGE_BYTES) throw validation("invalid_response", `${field} exceeds its bound`);
  return value;
}

export function parseDeliverableListResult(input: unknown): DeliverableListResult {
  const value = object(input, "deliverable list result");
  exact(value, ["instanceId", "deliverables"]);
  const items = array(value.deliverables, "deliverables", MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE).map((item, index) => {
    try { return parseDeliverableDto(item, `deliverables[${index}]`, { allowUnknownFields: true }); }
    catch (error) { throw validation("invalid_response", error instanceof Error ? error.message : "Invalid deliverable metadata"); }
  });
  if (new Set(items.map((item) => item.deliveryRef)).size !== items.length) throw validation("invalid_response", "Deliverable list contains duplicate references");
  return { instanceId: id(value.instanceId, "instanceId"), deliverables: items };
}

export function parseDeliverableDownloadFrame(input: unknown, expected: { requestId: string; hostEpoch: string; instanceId: string; deliveryRef: string }): DeliverableDownloadFrame {
  const value = object(input, "deliverable download frame");
  const identity = (): DeliverableDownloadIdentity => {
    if (value.version !== 2 || value.requestId !== expected.requestId || value.hostEpoch !== expected.hostEpoch
      || value.instanceId !== expected.instanceId || value.deliveryRef !== expected.deliveryRef) {
      throw validation("invalid_response", "Deliverable download frame identity does not match the request");
    }
    return { version: 2, ...expected };
  };
  if (value.kind === "deliverable_download_ready") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "deliveryRef", "deliverable"]);
    let deliverable: DeliverableDto;
    try { deliverable = parseDeliverableDto(value.deliverable, "deliverable", { allowUnknownFields: true }); }
    catch (error) { throw validation("invalid_response", error instanceof Error ? error.message : "Invalid deliverable metadata"); }
    if (deliverable.deliveryRef !== expected.deliveryRef) throw validation("invalid_response", "Deliverable readiness metadata does not match the request");
    return { kind: "deliverable_download_ready", ...identity(), deliverable };
  }
  if (value.kind === "deliverable_download_chunk") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "deliveryRef", "index", "data"]);
    const data = canonicalBase64(value.data, "deliverable chunk data", MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES);
    if (data.length === 0) throw validation("invalid_response", "Deliverable chunks cannot be empty");
    return { kind: "deliverable_download_chunk", ...identity(), index: unsigned(value.index, "deliverable chunk index"), data };
  }
  if (value.kind === "deliverable_download_complete") {
    exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "deliveryRef", "chunks", "sizeBytes", "sha256"]);
    const sha256 = string(value.sha256, "deliverable SHA-256", 64);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw validation("invalid_response", "Deliverable SHA-256 must be lowercase hexadecimal");
    return { kind: "deliverable_download_complete", ...identity(), chunks: unsigned(value.chunks, "deliverable chunk count"), sizeBytes: unsigned(value.sizeBytes, "deliverable byte count"), sha256 };
  }
  exact(value, ["kind", "version", "requestId", "hostEpoch", "instanceId", "deliveryRef", "error"]);
  if (value.kind !== "deliverable_download_error") throw validation("invalid_response", "Unknown deliverable download frame");
  const error = object(value.error, "deliverable download error");
  exact(error, ["code", "message"]);
  if (error.code !== "file_unavailable") throw validation("invalid_response", "Deliverable terminal error code is invalid");
  return { kind: "deliverable_download_error", ...identity(), error: { code: "file_unavailable", message: string(error.message, "deliverable download error message", MAX_MESSAGE) } };
}

export function parseAttachmentUploadReady(input: unknown, requestId: string, hostEpoch: string): AttachmentUploadReady {
  const value = object(input, "attachment upload readiness");
  exact(value, ["kind", "version", "requestId", "hostEpoch", "maxChunkBytes"]);
  if (value.kind !== "attachment_upload_ready" || value.version !== 2 || value.requestId !== requestId || value.hostEpoch !== hostEpoch) {
    throw validation("invalid_response", "Invalid attachment upload readiness envelope");
  }
  const maxChunkBytes = positive(value.maxChunkBytes, "maxChunkBytes");
  if (maxChunkBytes > MAX_ATTACHMENT_CHUNK_BYTES) throw validation("invalid_response", "Host attachment chunk limit is unsupported");
  return { kind: "attachment_upload_ready", version: 2, requestId, hostEpoch, maxChunkBytes };
}

export function parseAttachmentUploadFrame(input: unknown, requestId: string): AttachmentUploadFrame {
  const value = object(input, "attachment upload frame", "invalid_request");
  if (value.kind === "attachment_chunk") {
    exact(value, ["kind", "version", "requestId", "index", "data"], "invalid_request");
    if (value.version !== 2 || value.requestId !== requestId) throw validation("invalid_request", "Attachment chunk does not match its upload request");
    const index = unsigned(value.index, "attachment chunk index", "invalid_request");
    const data = string(value.data, "attachment chunk data", Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES / 3) * 4, "invalid_request");
    if (data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw validation("invalid_request", "Attachment chunk is not canonical base64");
    const decoded = Buffer.from(data, "base64");
    if (decoded.byteLength < 1 || decoded.byteLength > MAX_ATTACHMENT_CHUNK_BYTES || decoded.toString("base64") !== data) throw validation("invalid_request", "Attachment chunk exceeds the decoded-byte limit or is not canonical base64");
    return { kind: "attachment_chunk", version: 2, requestId, index, data };
  }
  exact(value, ["kind", "version", "requestId", "chunks"], "invalid_request");
  if (value.kind !== "attachment_complete" || value.version !== 2 || value.requestId !== requestId) throw validation("invalid_request", "Invalid attachment completion frame");
  return { kind: "attachment_complete", version: 2, requestId, chunks: unsigned(value.chunks, "attachment chunk count", "invalid_request") };
}

export function parseResponseTransferFrame(input: unknown, requestId: string, hostEpoch: string): ResponseTransferFrame {
  const value = object(input, "response transfer frame");
  exact(value, ["kind", "version", "requestId", "hostEpoch", "index", "count", "data"]);
  if (value.kind !== "response_transfer" || value.version !== 2 || value.requestId !== requestId || value.hostEpoch !== hostEpoch) {
    throw validation("invalid_response", "Response transfer identity does not match the request");
  }
  const index = unsigned(value.index, "response transfer index");
  const count = positive(value.count, "response transfer count");
  if (count > MAX_RESPONSE_TRANSFER_CHUNKS || index >= count) throw validation("invalid_response", "Response transfer index or count is outside its bound");
  const data = canonicalBase64(value.data, "response transfer data", MAX_RESPONSE_TRANSFER_CHUNK_BYTES);
  if (data.length === 0) throw validation("invalid_response", "Response transfer chunks cannot be empty");
  return { kind: "response_transfer", version: 2, requestId, hostEpoch, index, count, data };
}

export function decodeResponseTransfer(chunks: readonly string[]): unknown {
  const bytes = chunks.map((data) => Buffer.from(data, "base64"));
  const total = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total > MAX_DOCK_TRANSFER_BYTES) throw validation("invalid_response", "Response transfer exceeds its aggregate bound");
  try { return JSON.parse(Buffer.concat(bytes, total).toString("utf8")); }
  catch { throw validation("invalid_response", "Response transfer does not contain a valid response"); }
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
export function parseMachinesResult(input: unknown): MachinesResult {
  const value = object(input, "machines result");
  exact(value, ["machines"]);
  const machines = array(value.machines, "machines", MAX_COLLECTION).map((item, index) => {
    const machine = object(item, `machines[${index}]`);
    exact(machine, ["hostId", "name", "kind", "available", "platform", "homePath", "workspaceRoots"]);
    const platform = machine.platform === undefined ? undefined : enumeration(machine.platform, `machines[${index}].platform`, MACHINE_PLATFORMS);
    const homePath = optionalString(machine.homePath, `machines[${index}].homePath`, MAX_CONTROL_CWD_CHARS);
    if (homePath !== undefined && !isPortableAbsoluteLocalPath(homePath)) throw validation("invalid_response", `machines[${index}].homePath must be absolute`);
    const workspaceRoots = machine.workspaceRoots === undefined
      ? undefined
      : array(machine.workspaceRoots, `machines[${index}].workspaceRoots`, MAX_COLLECTION)
        .map((root, rootIndex) => string(root, `machines[${index}].workspaceRoots[${rootIndex}]`, MAX_CONTROL_CWD_CHARS));
    if (workspaceRoots !== undefined && (platform === undefined || workspaceRoots.length < 1 || workspaceRoots.some((root) => !isPortableLocalRootPath(root, platform)))) {
      throw validation("invalid_response", `machines[${index}].workspaceRoots must contain native filesystem roots`);
    }
    return {
      hostId: string(machine.hostId, `machines[${index}].hostId`, 128),
      name: string(machine.name, `machines[${index}].name`, 256),
      kind: enumeration(machine.kind, `machines[${index}].kind`, ["main", "subhost"]),
      available: boolean(machine.available, `machines[${index}].available`),
      ...(platform === undefined ? {} : { platform }),
      ...(homePath === undefined ? {} : { homePath }),
      ...(workspaceRoots === undefined ? {} : { workspaceRoots }),
    };
  });
  return { machines };
}

export function parseMachineRemovalResult(input: unknown): MachineRemovalResult {
  const value = object(input, "machine removal result");
  exact(value, ["hostId", "removed"]);
  return { hostId: string(value.hostId, "hostId", 128), removed: boolean(value.removed, "removed") };
}

export function parseAttachmentDto(input: unknown, field = "attachment"): AttachmentDto {
  const value = object(input, field);
  exact(value, ["fileId", "name", "sizeBytes", "mediaType", "sha256", "storedAt"]);
  const fileId = string(value.fileId, `${field}.fileId`, MAX_ATTACHMENT_FILE_ID_CHARS);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(fileId)) throw validation("invalid_response", `${field}.fileId must be an opaque UUID`);
  const name = string(value.name, `${field}.name`, MAX_ATTACHMENT_NAME_CHARS);
  if (name.length === 0 || /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(name)) throw validation("invalid_response", `${field}.name is not a safe display name`);
  const sizeBytes = unsigned(value.sizeBytes, `${field}.sizeBytes`);
  if (sizeBytes > MAX_ATTACHMENT_BYTES) throw validation("invalid_response", `${field}.sizeBytes exceeds the attachment limit`);
  const mediaType = optionalString(value.mediaType, `${field}.mediaType`, MAX_ATTACHMENT_MEDIA_TYPE_CHARS);
  if (mediaType !== undefined && (mediaType.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(mediaType))) throw validation("invalid_response", `${field}.mediaType is invalid`);
  const sha256 = string(value.sha256, `${field}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw validation("invalid_response", `${field}.sha256 is invalid`);
  return { fileId, name, sizeBytes, ...(mediaType === undefined ? {} : { mediaType }), sha256, storedAt: timestamp(value.storedAt, `${field}.storedAt`) };
}

export function parseAttachmentUploadResult(input: unknown): AttachmentUploadResult {
  const value = object(input, "attachment upload result");
  exact(value, ["attachment", "status"]);
  return {
    attachment: parseAttachmentDto(value.attachment),
    status: enumeration(value.status, "status", ["stored", "reused"]),
  };
}

export function parseCreateResult(input: unknown): CreateResult { const value = object(input, "create result"); exact(value, ["instance"]); return { instance: parseInstanceSnapshot(value.instance, "instance") }; }
export function parseEnsureResult(input: unknown): EnsureResult {
  const value = object(input, "ensure result"); exact(value, ["created", "instance"]);
  return { created: boolean(value.created, "created"), instance: parseInstanceSnapshot(value.instance, "instance") };
}
export function parseKeyLookupResult(input: unknown): KeyLookupResult {
  const value = object(input, "instance key lookup result"); exact(value, ["instance"]);
  return { instance: value.instance === null ? null : parseInstanceSnapshot(value.instance, "instance") };
}
export function parseListResult(input: unknown): ListResult {
  const value = object(input, "list result"); exact(value, ["instances", "page"]);
  const instances = array(value.instances, "instances", MAX_INSTANCE_LIST_ITEMS).map((item, index) => parseInstanceSnapshot(item, `instances[${index}]`));
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
export function parseWorkspaceListResult(input: unknown): WorkspaceListResult {
  const value = object(input, "workspace list result");
  exact(value, ["path", "parent", "revision", "entries", "total", "truncated", "nextCursor"]);
  const path = string(value.path, "path", MAX_CONTROL_CWD_CHARS);
  if (!isPortableAbsoluteLocalPath(path)) throw validation("invalid_response", "Workspace path must be absolute");
  const parent = optionalString(value.parent, "parent", MAX_CONTROL_CWD_CHARS);
  if (parent !== undefined && !isPortableAbsoluteLocalPath(parent)) throw validation("invalid_response", "Workspace parent must be absolute");
  const revision = string(value.revision, "revision", 128);
  const entries = array(value.entries, "entries", MAX_WORKSPACE_LIST_ITEMS).map((item, index) => {
    const entry = object(item, `entries[${index}]`);
    exact(entry, ["name", "kind", "hidden"]);
    return {
      name: string(entry.name, `entries[${index}].name`, MAX_WORKSPACE_ENTRY_NAME_CHARS),
      kind: enumeration(entry.kind, `entries[${index}].kind`, ["directory", "symlink"]),
      hidden: boolean(entry.hidden, `entries[${index}].hidden`),
    };
  });
  const total = unsigned(value.total, "total");
  const truncated = boolean(value.truncated, "truncated");
  const nextCursor = value.nextCursor === undefined ? undefined : parseWorkspaceListCursor(value.nextCursor, "nextCursor");
  if (truncated !== (nextCursor !== undefined)) throw validation("invalid_response", "Workspace continuation metadata is inconsistent");
  return { path, parent, revision, entries, total, truncated, nextCursor };
}
export function parseStatusResult(input: unknown): StatusResult { const value = object(input, "get result"); exact(value, ["instance"]); return { instance: parseInstanceSnapshot(value.instance, "instance") }; }
export function parseInstanceReadResult(input: unknown): InstanceReadResult {
  const value = object(input, "instance read result"); exact(value, ["instance", "page", "recentHistory", "historyRevision", "historyTruncated", "pendingMessages"]);
  const instance = parseInstanceSnapshot(value.instance, "instance");
  const page = parseEventPage(value.page, instance.id, instance.runtimeGeneration);
  assertCursorDomain(page.earliest, instance, "page.earliest"); assertCursorDomain(page.latest, instance, "page.latest");
  const history = array(value.recentHistory, "recentHistory", MAX_SEMANTIC_HISTORY_PAGE_ITEMS).map((item, index) => parseHistoryEntry(item, `recentHistory[${index}]`));
  if (new Set(history.map((entry) => entry.entryId)).size !== history.length) throw validation("invalid_response", "recentHistory entry IDs must be unique");
  const pendingMessages = array(value.pendingMessages, "pendingMessages", MAX_PENDING_QUEUE_ITEMS).map((item, index) => parsePendingMessage(item, `pendingMessages[${index}]`));
  if (new Set(pendingMessages.map((item) => item.queueItemId)).size !== pendingMessages.length) throw validation("invalid_response", "pendingMessages queue item IDs must be unique");
  if (pendingMessages.reduce((total, item) => total + item.text.length, 0) > MAX_PENDING_QUEUE_TEXT_CHARS) throw validation("invalid_response", "pendingMessages text exceeds the aggregate queue limit");
  if (pendingMessages.reduce((total, item) => total + imagePathCharacters(item.images), 0) > MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS) throw validation("invalid_response", "pendingMessages image descriptors exceed the aggregate queue limit");
  if (pendingMessages.reduce((total, item) => total + attachmentCharacters(item.attachments), 0) > MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS) throw validation("invalid_response", "pendingMessages attachment descriptors exceed the aggregate queue limit");
  const firstFollowUp = pendingMessages.findIndex((item) => item.delivery === "followUp");
  if (firstFollowUp >= 0 && pendingMessages.slice(firstFollowUp).some((item) => item.delivery === "steer")) throw validation("invalid_response", "pendingMessages are not in consumption order");
  return { instance, page, recentHistory: history, historyRevision: positive(value.historyRevision, "historyRevision"), historyTruncated: boolean(value.historyTruncated, "historyTruncated"), pendingMessages };
}
export function parseFollowResult(input: unknown): FollowResult {
  const value = object(input, "follow result"); exact(value, ["page"]);
  const rawPage = object(value.page, "page");
  const earliest = parseCursor(rawPage.earliest, "page.earliest");
  return { page: parseEventPage(value.page, earliest.instanceId, earliest.runtimeGeneration) };
}
export function parseExtensionUiControlResult(input: unknown): ExtensionUiControlResult {
  const value = object(input, "extension UI operation result"); exact(value, ["instanceId", "runtimeGeneration", "leaseToken", "controllerId"]);
  return {
    instanceId: id(value.instanceId, "instanceId"),
    runtimeGeneration: positive(value.runtimeGeneration, "runtimeGeneration"),
    leaseToken: id(value.leaseToken, "leaseToken"),
    controllerId: id(value.controllerId, "controllerId"),
  };
}
function parseEventPage(input: unknown, instanceId: string, runtimeGeneration: number): FollowResult["page"] {
  const page = object(input, "page"); exact(page, ["events", "earliest", "latest", "truncated", "epochChanged", "generationChanged"]);
  const earliest = parseCursor(page.earliest, "page.earliest");
  const latest = parseCursor(page.latest, "page.latest");
  if (earliest.instanceId !== instanceId || latest.instanceId !== instanceId || earliest.runtimeGeneration !== runtimeGeneration || latest.runtimeGeneration !== runtimeGeneration || earliest.hostEpoch !== latest.hostEpoch) throw validation("invalid_response", "Update page belongs to another work state");
  if (earliest.sequence > latest.sequence) throw validation("invalid_response", "page.earliest cannot follow page.latest");
  const events = array(page.events, "page.events", MAX_REPLAY_EVENTS).map((item, index) => parseDockEvent(item, `page.events[${index}]`));
  let previous = -1;
  for (const event of events) {
    if (event.instanceId !== instanceId || event.runtimeGeneration !== runtimeGeneration || event.sequence <= previous || event.sequence > latest.sequence) throw validation("invalid_response", "Saved updates are out of order or belong to another work state");
    previous = event.sequence;
  }
  return { events, earliest, latest, truncated: boolean(page.truncated, "page.truncated"), epochChanged: boolean(page.epochChanged, "page.epochChanged"), generationChanged: boolean(page.generationChanged, "page.generationChanged") };
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
  const instance = parseInstanceSnapshot(value.instance, "instance"); const receipt = parseReceipt(value.receipt);
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
  const instance = parseInstanceSnapshot(value.instance, "instance");
  const previousLifecycle = enumeration(value.previousLifecycle, "previousLifecycle", ["host_lost", "runtime_error"]);
  const operationId = id(value.operationId, "operationId");
  if (instance.lifecycle !== "active" || instance.execution !== "idle" || instance.lastRun !== "never" || instance.runtimeGeneration < 2) {
    throw validation("invalid_response", "Reopen result must expose a fresh active generation");
  }
  return { operationId, previousLifecycle, instance };
}
export function parseAbortResult(input: unknown): AbortResult {
  const value = object(input, "abort result"); exact(value, ["instance"]);
  const instance = parseInstanceSnapshot(value.instance, "instance");
  if (instance.execution === "running") throw validation("invalid_response", "Abort result instance must not still be running");
  return { instance };
}
export function parseQueueDequeueResult(input: unknown): QueueDequeueResult {
  const value = object(input, "queue dequeue result"); exact(value, ["receipt", "instance"]);
  const receipt = object(value.receipt, "receipt"); exact(receipt, ["operationId", "instanceId", "restored", "inFlight"]);
  const instance = parseInstanceSnapshot(value.instance, "instance");
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
  const instance = parseInstanceSnapshot(value.instance, "instance");
  if (instance.lifecycle !== "stopped") throw validation("invalid_response", "Stop result instance must be stopped");
  return { receipt: { operationId: id(receipt.operationId, "receipt.operationId"), alreadyStopped: boolean(receipt.alreadyStopped, "receipt.alreadyStopped"), cleanupErrors: receipt.cleanupErrors === undefined ? undefined : strings(receipt.cleanupErrors, "receipt.cleanupErrors", MAX_STOP_CLEANUP_ERRORS, MAX_STOP_CLEANUP_ERROR_CHARS) }, instance };
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
function modelListFields(value: Record<string, unknown>): Omit<ModelsResult, "instance"> {
  const models = array(value.models, "models", MAX_COLLECTION).map((item, index) => { const model = object(item, `models[${index}]`); exact(model, ["provider", "id", "name", "reasoning", "contextWindow"]); return { provider: string(model.provider, "provider", MAX_MODEL_PROVIDER_CHARS), id: string(model.id, "id", MAX_MODEL_ID_CHARS), name: string(model.name, "name", 256), reasoning: boolean(model.reasoning, "reasoning"), contextWindow: model.contextWindow === undefined ? undefined : positive(model.contextWindow, "contextWindow") }; });
  const completeness = parseCollectionCompleteness(value, models.length);
  return { models, availableThinkingLevels: thinkingLevels(value.availableThinkingLevels), ...completeness };
}
/** Worker-produced model.list body; the Host adds only its own instance snapshot. */
export function parseModelListBody(input: unknown): Omit<ModelsResult, "instance"> {
  const value = object(input, "models result"); exact(value, ["models", "availableThinkingLevels", "total", "truncated"]);
  return modelListFields(value);
}
export function parseModelsResult(input: unknown): ModelsResult {
  const value = object(input, "models result"); exact(value, ["models", "availableThinkingLevels", "instance", "total", "truncated"]);
  return { ...modelListFields(value), instance: parseInstanceSnapshot(value.instance, "instance") };
}
export function parseModelConfigurationResult(input: unknown): ModelConfigurationResult {
  const value = object(input, "model configuration result"); exact(value, ["instance", "settingsWrite"]);
  return { instance: parseInstanceSnapshot(value.instance, "instance"), settingsWrite: parseSettingsWrite(value.settingsWrite) };
}
export function parseThinkingConfigurationResult(input: unknown): ThinkingConfigurationResult {
  const value = object(input, "thinking configuration result"); exact(value, ["actualLevel", "availableThinkingLevels", "instance", "settingsWrite"]);
  return { actualLevel: enumeration(value.actualLevel, "actualLevel", THINKING_LEVELS), availableThinkingLevels: thinkingLevels(value.availableThinkingLevels), instance: parseInstanceSnapshot(value.instance, "instance"), settingsWrite: parseSettingsWrite(value.settingsWrite) };
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
    const session = object(item, `sessions[${index}]`); exact(session, ["sessionId", "sessionFile", "name", "firstUserMessage", "cwd", "updatedAt"]);
    return {
      sessionId: id(session.sessionId, `sessions[${index}].sessionId`),
      sessionFile: string(session.sessionFile, `sessions[${index}].sessionFile`, MAX_CONTROL_CWD_CHARS),
      name: optionalString(session.name, `sessions[${index}].name`, MAX_INSTANCE_NAME_CHARS),
      ...(session.firstUserMessage === undefined ? {} : {
        firstUserMessage: string(session.firstUserMessage, `sessions[${index}].firstUserMessage`, MAX_SESSION_FIRST_USER_MESSAGE_CHARS),
      }),
      cwd: string(session.cwd, `sessions[${index}].cwd`, MAX_CONTROL_CWD_CHARS),
      updatedAt: session.updatedAt === undefined ? undefined : timestamp(session.updatedAt, `sessions[${index}].updatedAt`),
    };
  });
  if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) throw validation("invalid_response", "Session IDs must be unique");
  if (new Set(sessions.map((session) => session.sessionFile)).size !== sessions.length) throw validation("invalid_response", "Session files must be unique");
  return sessions;
}

export function parseHistoryResult(input: unknown): HistoryResult {
  const value = object(input, "history result"); exact(value, ["historyRevision", "entries", "hasEarlier", "nextBeforeEntryId", "instance"]);
  const entries = array(value.entries, "entries", MAX_SEMANTIC_HISTORY_PAGE_ITEMS).map((item, index) => parseHistoryEntry(item, `entries[${index}]`));
  const ids = entries.map((entry) => entry.entryId);
  if (new Set(ids).size !== ids.length) throw validation("invalid_response", "history entry IDs must be unique");
  const hasEarlier = boolean(value.hasEarlier, "hasEarlier");
  const nextBeforeEntryId = optionalString(value.nextBeforeEntryId, "nextBeforeEntryId", 128);
  if (hasEarlier !== (nextBeforeEntryId !== undefined)) throw validation("invalid_response", "history pagination cursor is inconsistent");
  if (nextBeforeEntryId !== undefined && entries[0]?.entryId !== nextBeforeEntryId) throw validation("invalid_response", "history cursor must identify the first returned entry");
  return { historyRevision: positive(value.historyRevision, "historyRevision"), entries, hasEarlier, nextBeforeEntryId, instance: parseInstanceSnapshot(value.instance, "instance") };
}

/** Worker-produced conversation.history body; the Host adds only its own instance snapshot. */
export function parseConversationHistoryBody(input: unknown): Omit<ConversationHistoryResult, "instance"> {
  const value = object(input, "conversation history page");
  exact(value, ["revision", "entries", "hasEarlier", "nextCursor"]);
  return conversationHistoryFields(value);
}
export function parseConversationHistoryResult(input: unknown): ConversationHistoryResult {
  const value = object(input, "conversation history result");
  exact(value, ["instance", "revision", "entries", "hasEarlier", "nextCursor"]);
  return {
    instance: parseActiveSessionInstance(value.instance, "Conversation history"),
    ...conversationHistoryFields(value),
  };
}
function conversationHistoryFields(value: Record<string, unknown>): Omit<ConversationHistoryResult, "instance"> {
  const revision = string(value.revision, "revision", 128);
  const entries = array(value.entries, "entries", MAX_SEMANTIC_HISTORY_PAGE_ITEMS).map((item, index) => {
    const entry = object(item, `entries[${index}]`);
    exact(entry, ["entry", "contentRef", "contentComplete", "totalBlocks"]);
    const totalBlocks = unsigned(entry.totalBlocks, `entries[${index}].totalBlocks`);
    if (totalBlocks > 1_000_000) throw validation("invalid_response", `entries[${index}].totalBlocks exceeds the supported bound`);
    return {
      entry: parseHistoryEntry(entry.entry, `entries[${index}].entry`),
      contentRef: string(entry.contentRef, `entries[${index}].contentRef`, 128),
      contentComplete: boolean(entry.contentComplete, `entries[${index}].contentComplete`),
      totalBlocks,
    };
  });
  const ids = entries.map((item) => item.entry.entryId);
  if (new Set(ids).size !== ids.length) throw validation("invalid_response", "conversation history entry IDs must be unique");
  const refs = entries.map((item) => item.contentRef);
  if (new Set(refs).size !== refs.length) throw validation("invalid_response", "conversation content references must be unique");
  const hasEarlier = boolean(value.hasEarlier, "hasEarlier");
  const nextCursor = optionalString(value.nextCursor, "nextCursor", 128);
  if (hasEarlier !== (nextCursor !== undefined)) throw validation("invalid_response", "conversation history pagination cursor is inconsistent");
  if (hasEarlier && entries.length === 0) throw validation("invalid_response", "a continued conversation history page cannot be empty");
  return {
    revision,
    entries,
    hasEarlier,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Worker-produced conversation.content body; the Host adds only instanceId and runtimeGeneration. */
export function parseConversationContentBody(input: unknown): Omit<ConversationContentResult, "instanceId" | "runtimeGeneration"> {
  const value = object(input, "conversation content page");
  exact(value, ["revision", "contentRef", "chunks", "complete", "nextCursor"]);
  return conversationContentFields(value);
}
export function parseConversationContentResult(input: unknown): ConversationContentResult {
  const value = object(input, "conversation content result");
  exact(value, ["instanceId", "runtimeGeneration", "revision", "contentRef", "chunks", "complete", "nextCursor"]);
  return {
    instanceId: id(value.instanceId, "instanceId"),
    runtimeGeneration: positive(value.runtimeGeneration, "runtimeGeneration"),
    ...conversationContentFields(value),
  };
}

export function parseFileReadBody(input: unknown): PublishedFileReadPage {
  const value = object(input, "published file page");
  exact(value, ["file", "offset", "data", "complete", "nextOffset"]);
  const file = parsePublishedFileDto(value.file, "file");
  const offset = unsigned(value.offset, "offset");
  const data = canonicalBase64(value.data, "data", MAX_PUBLISHED_FILE_CHUNK_BYTES);
  const decodedBytes = Buffer.from(data, "base64").length;
  const complete = boolean(value.complete, "complete");
  const nextOffset = value.nextOffset === undefined ? undefined : unsigned(value.nextOffset, "nextOffset");
  const end = offset + decodedBytes;
  if (decodedBytes === 0 || offset >= file.sizeBytes || end > file.sizeBytes
    || (complete && (nextOffset !== undefined || end !== file.sizeBytes))
    || (!complete && (nextOffset !== end || end >= file.sizeBytes))) throw validation("invalid_response", "published file pagination is inconsistent");
  return { file, offset, data, complete, ...(nextOffset === undefined ? {} : { nextOffset }) };
}

export function parseFileReadResult(input: unknown, expectedOffset?: number): FileReadResult {
  const value = object(input, "published file result");
  exact(value, ["instanceId", "runtimeGeneration", "file", "offset", "data", "complete", "nextOffset"]);
  const result = { instanceId: id(value.instanceId, "instanceId"), runtimeGeneration: positive(value.runtimeGeneration, "runtimeGeneration"), ...parseFileReadBody({ file: value.file, offset: value.offset, data: value.data, complete: value.complete, nextOffset: value.nextOffset }) };
  if (expectedOffset !== undefined && result.offset !== expectedOffset) throw validation("invalid_response", "published file response offset does not match the request");
  return result;
}

export function parsePublishedFileDto(input: unknown, field = "publishedFile"): PublishedFileDto {
  const published = validatedPublishedFileDto(input);
  if (published === undefined) throw validation("invalid_response", `${field} is not valid published-file metadata`);
  return published;
}
function conversationContentFields(value: Record<string, unknown>): Omit<ConversationContentResult, "instanceId" | "runtimeGeneration"> {
  const chunks = array(value.chunks, "chunks", 64).map((item, index) => parseConversationContentChunk(item, `chunks[${index}]`));
  const complete = boolean(value.complete, "complete");
  const nextCursor = optionalString(value.nextCursor, "nextCursor", 128);
  if (complete === (nextCursor !== undefined)) throw validation("invalid_response", "conversation content pagination cursor is inconsistent");
  if (!complete && chunks.length === 0) throw validation("invalid_response", "an incomplete conversation content page cannot be empty");
  return {
    revision: string(value.revision, "revision", 128),
    contentRef: string(value.contentRef, "contentRef", 128),
    chunks,
    complete,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseConversationContentChunk(input: unknown, field: string): ConversationContentChunkDto {
  const chunk = object(input, field);
  const type = enumeration(chunk.type, `${field}.type`, ["text", "thinking", "image", "tool_call", "tool_result", "omitted"] as const);
  const blockIndex = unsigned(chunk.blockIndex, `${field}.blockIndex`);
  if (type === "text" || type === "thinking") {
    exact(chunk, ["blockIndex", "type", "text", "offset", "blockComplete"]);
    return {
      blockIndex,
      type,
      text: payloadFreeBoundedString(chunk.text, `${field}.text`, MAX_CONVERSATION_CHUNK_CHARS),
      offset: unsigned(chunk.offset, `${field}.offset`),
      blockComplete: boolean(chunk.blockComplete, `${field}.blockComplete`),
    };
  }
  if (type === "image") {
    exact(chunk, ["blockIndex", "type", "mimeType", "data", "offset", "blockComplete"]);
    return {
      blockIndex,
      type,
      mimeType: imageMimeType(chunk.mimeType, `${field}.mimeType`),
      data: boundedString(chunk.data, `${field}.data`, MAX_CONVERSATION_CHUNK_CHARS),
      offset: unsigned(chunk.offset, `${field}.offset`),
      blockComplete: boolean(chunk.blockComplete, `${field}.blockComplete`),
    };
  }
  if (type === "tool_call") {
    exact(chunk, ["blockIndex", "type", "toolCallId", "toolName", "argumentsJson", "offset", "blockComplete"]);
    return {
      blockIndex,
      type,
      toolCallId: id(chunk.toolCallId, `${field}.toolCallId`),
      toolName: string(chunk.toolName, `${field}.toolName`, 256),
      argumentsJson: payloadFreeBoundedString(chunk.argumentsJson, `${field}.argumentsJson`, MAX_CONVERSATION_CHUNK_CHARS),
      offset: unsigned(chunk.offset, `${field}.offset`),
      blockComplete: boolean(chunk.blockComplete, `${field}.blockComplete`),
    };
  }
  if (type === "tool_result") {
    exact(chunk, ["blockIndex", "type", "toolCallId", "toolName", "text", "offset", "blockComplete", "isError", "publishedFile", "omittedFields"]);
    const publishedFile = chunk.publishedFile === undefined ? undefined : parsePublishedFileDto(chunk.publishedFile, `${field}.publishedFile`);
    return {
      blockIndex,
      type,
      toolCallId: id(chunk.toolCallId, `${field}.toolCallId`),
      toolName: string(chunk.toolName, `${field}.toolName`, 256),
      text: payloadFreeBoundedString(chunk.text, `${field}.text`, MAX_CONVERSATION_CHUNK_CHARS),
      offset: unsigned(chunk.offset, `${field}.offset`),
      blockComplete: boolean(chunk.blockComplete, `${field}.blockComplete`),
      isError: boolean(chunk.isError, `${field}.isError`),
      ...(publishedFile === undefined ? {} : { publishedFile }),
      omittedFields: omitted(chunk.omittedFields, `${field}.omittedFields`),
    };
  }
  exact(chunk, ["blockIndex", "type", "kind", "description"]);
  return {
    blockIndex,
    type,
    kind: enumeration(chunk.kind, `${field}.kind`, ["image", "binary"] as const),
    description: string(chunk.description, `${field}.description`, MAX_MESSAGE),
  };
}

export function parseSessionReplacementResult(input: unknown): SessionReplacementResult {
  const value = object(input, "session replacement result"); exact(value, ["cancelled", "instance"]);
  const instance = parseInstanceSnapshot(value.instance, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", "Session replacement success requires an active instance");
  return { cancelled: boolean(value.cancelled, "cancelled"), instance };
}
export function parseSessionNameResult(input: unknown): SessionNameResult {
  const value = object(input, "session name result"); exact(value, ["instance"]);
  const instance = parseInstanceSnapshot(value.instance, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", "Session name success requires an active instance");
  return { instance };
}
export function parseCompactionBody(input: unknown): SessionCompactionResult["result"] {
  const result = object(input, "result"); exact(result, ["summary", "firstKeptEntryId", "tokensBefore"]);
  return {
    summary: boundedString(result.summary, "result.summary", MAX_TEXT),
    firstKeptEntryId: id(result.firstKeptEntryId, "result.firstKeptEntryId"),
    tokensBefore: unsigned(result.tokensBefore, "result.tokensBefore"),
  };
}
export function parseSessionCompactionResult(input: unknown): SessionCompactionResult {
  const value = object(input, "session compaction result"); exact(value, ["result", "instance"]);
  return {
    result: parseCompactionBody(value.result),
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
  exact(value, ["nodes", "leafId"]);
  if (!Array.isArray(value.nodes)) throw validation("invalid_response", "nodes must be an array");
  const nodes = value.nodes.map((item, index) => parseTreeNode(item, `nodes[${index}]`));
  const ids = new Set<string>();
  const ancestors: string[] = [];
  for (const node of nodes) {
    if (ids.has(node.entryId)) throw validation("invalid_response", "Tree entry IDs must be unique");
    if (node.parentId === undefined) {
      if (node.depth !== 0) throw validation("invalid_response", "Tree roots must have depth zero");
    } else if (node.depth < 1 || ancestors[node.depth - 1] !== node.parentId) {
      throw validation("invalid_response", "Tree nodes must use stable depth-first pre-order");
    }
    ancestors.length = node.depth;
    ancestors.push(node.entryId);
    ids.add(node.entryId);
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const next = nodes[index + 1];
    const expectedChildren = next !== undefined && next.depth === node.depth + 1 && next.parentId === node.entryId;
    if (node.hasChildren !== expectedChildren) throw validation("invalid_response", "Tree child topology is inconsistent");
  }
  const leafId = optionalString(value.leafId, "leafId", 128);
  if (leafId !== undefined && !ids.has(leafId)) throw validation("invalid_response", "Tree leaf does not belong to the snapshot");
  return { nodes, ...(leafId === undefined ? {} : { leafId }) };
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
  const instance = parseInstanceSnapshot(input, "instance");
  if (instance.lifecycle !== "active") throw validation("invalid_response", `${operation} success requires an active instance`);
  return instance;
}

function toolListFields(value: Record<string, unknown>): Omit<ToolsResult, "instance"> {
  const tools = array(value.tools, "tools", MAX_COLLECTION).map((item, index) => parseTool(item, `tools[${index}]`));
  assertSorted(tools, "tools", compareToolDtos);
  return { tools, ...parseCollectionCompleteness(value, tools.length) };
}
/** Worker-produced tool.list / tool.set_active body; the Host adds only its own instance snapshot. */
export function parseToolListBody(input: unknown): Omit<ToolsResult, "instance"> {
  const value = object(input, "tools result"); exact(value, ["tools", "total", "truncated"]);
  return toolListFields(value);
}
export function parseToolsResult(input: unknown): ToolsResult {
  const value = object(input, "tools result"); exact(value, ["tools", "instance", "total", "truncated"]);
  return { ...toolListFields(value), instance: parseInstanceSnapshot(value.instance, "instance") };
}
/** The canonical full setting list; Worker settings.get bodies and wire results share it. */
export function parseSettingDtos(input: unknown): SettingDto[] {
  const settings = array(input, "settings", SETTING_KEYS.length).map((item, index) => parseSettingDto(item, `settings[${index}]`));
  if (settings.length !== SETTING_KEYS.length || settings.some((setting, index) => setting.key !== SETTING_KEYS[index])) throw validation("invalid_response", `settings must contain all ${SETTING_KEYS.length} keys in canonical order`);
  return settings;
}
export function parseSettingsResult(input: unknown): SettingsResult {
  const value = object(input, "settings result"); exact(value, ["settings"]);
  return { settings: parseSettingDtos(value.settings) };
}
export function parseSettingUpdateResult(input: unknown): SettingUpdateResult {
  const value = object(input, "setting update result"); exact(value, ["setting", "instance", "reloadRequired", "hostRestartRequired"]);
  const setting = parseSettingDto(value.setting, "setting");
  const reloadRequired = boolean(value.reloadRequired, "reloadRequired");
  const hostRestartRequired = boolean(value.hostRestartRequired, "hostRestartRequired");
  if (reloadRequired !== setting.reloadRequired || hostRestartRequired !== setting.hostRestartRequired) throw validation("invalid_response", "setting update metadata is inconsistent");
  return { setting, instance: parseInstanceSnapshot(value.instance, "instance"), reloadRequired, hostRestartRequired };
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

export function parseResourceContentResult(input: unknown): ResourceContentResult {
  const value = object(input, "resource content result");
  exact(value, ["text", "revision", "nextOffset"]);
  const text = boundedString(value.text, "text", MAX_RESOURCE_CONTENT_PAGE_BYTES);
  if (Buffer.byteLength(text, "utf8") > MAX_RESOURCE_CONTENT_PAGE_BYTES) throw validation("invalid_response", "Resource page exceeds byte bound");
  const nextOffset = value.nextOffset === undefined ? undefined : unsigned(value.nextOffset, "nextOffset");
  if (nextOffset !== undefined && (nextOffset === 0 || text.length === 0)) throw validation("invalid_response", "Resource page did not advance");
  return { text, revision: string(value.revision, "revision", 128), ...(nextOffset === undefined ? {} : { nextOffset }) };
}

export function parseCommandContentResult(input: unknown): CommandContentResult {
  const value = object(input, "command content result");
  exact(value, ["command", "available", "format", "revision", "text", "complete", "nextCursor"]);
  const command = parseCommandReference(value.command, "command");
  const available = boolean(value.available, "available");
  if (!available) return { command, available: false };
  const complete = boolean(value.complete, "complete");
  const nextCursor = optionalString(value.nextCursor, "nextCursor", 128);
  if (complete === (nextCursor !== undefined)) throw validation("invalid_response", "command content continuation metadata is inconsistent");
  return {
    command,
    available: true,
    format: enumeration(value.format, "format", ["markdown"] as const),
    revision: string(value.revision, "revision", 128),
    text: boundedString(value.text, "text", MAX_COMMAND_CONTENT_PAGE_CHARS),
    complete,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function parseCommandCompletionsResult(input: unknown): CommandCompletionsResult {
  const value = object(input, "command completions result");
  exact(value, ["command", "items", "total", "truncated"]);
  const items = value.items === null
    ? null
    : array(value.items, "items", MAX_COMMAND_ARGUMENT_COMPLETIONS).map((item, index) => parseCommandArgumentCompletion(item, `items[${index}]`));
  const completeness = parseCollectionCompleteness(value, items?.length ?? 0);
  if (items === null && (completeness.total !== 0 || completeness.truncated)) throw validation("invalid_response", "absent command completions cannot be truncated");
  return { command: parseCommandReference(value.command, "command"), items, ...completeness };
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
function parseWorkspaceListCursor(input: unknown, field: string, code = "invalid_response"): WorkspaceListCursor {
  const cursor = object(input, field, code); exact(cursor, ["revision", "offset"], code);
  return {
    revision: string(cursor.revision, `${field}.revision`, 128, code),
    offset: unsigned(cursor.offset, `${field}.offset`, code),
  };
}
function parseExecutor(input: unknown, field: string): ExecutorIdentity {
  const executor = object(input, field); exact(executor, ["kind", "version", "piSessionId", "sessionFile", "model", "thinkingLevel"]);
  let model: ExecutorIdentity["model"];
  if (executor.model !== undefined) { const value = object(executor.model, `${field}.model`); exact(value, ["provider", "id", "name"]); const name=optionalString(value.name, `${field}.model.name`, 256); model = { provider: string(value.provider, `${field}.model.provider`, MAX_MODEL_PROVIDER_CHARS), id: string(value.id, `${field}.model.id`, MAX_MODEL_ID_CHARS), ...(name === undefined ? {} : { name }) }; }
  return { kind: string(executor.kind, `${field}.kind`, 128), version: optionalString(executor.version, `${field}.version`, 128), piSessionId: id(executor.piSessionId, `${field}.piSessionId`), sessionFile: optionalString(executor.sessionFile, `${field}.sessionFile`, MAX_CONTROL_CWD_CHARS), model, thinkingLevel: executor.thinkingLevel === undefined ? undefined : enumeration(executor.thinkingLevel, `${field}.thinkingLevel`, THINKING_LEVELS) };
}
function imageMimeType(input: unknown, field: string, code = "invalid_response"): string {
  const mimeType = string(input, field, MAX_IMAGE_MIME_TYPE_CHARS, code);
  if (!/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mimeType)) throw validation(code, `${field} must be a bounded image/* value`);
  return mimeType;
}

function parseImagePaths(input: unknown, field: string, code = "invalid_response"): ImagePathDto[] {
  const images = array(input, field, MAX_INPUT_IMAGES, code).map((item, index) => {
    const image = object(item, `${field}[${index}]`, code);
    exact(image, ["path", "mimeType"], code);
    const path = string(image.path, `${field}[${index}].path`, MAX_IMAGE_PATH_CHARS, code);
    if (!isPortableAbsoluteLocalPath(path) || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw validation(code, `${field}[${index}].path must be an absolute local path without control characters`);
    const mimeType = imageMimeType(image.mimeType, `${field}[${index}].mimeType`, code);
    return { path, mimeType };
  });
  if (new Set(images.map((image) => `${image.path}\u0000${image.mimeType}`)).size !== images.length) throw validation(code, `${field} must not contain duplicate descriptors`);
  return images;
}

function parseAttachmentDtos(input: unknown, field: string): AttachmentDto[] {
  const attachments = array(input, field, MAX_ATTACHMENT_IDS_PER_COMMAND).map((item, index) => parseAttachmentDto(item, `${field}[${index}]`));
  if (attachments.length === 0 || new Set(attachments.map((attachment) => attachment.fileId)).size !== attachments.length) throw validation("invalid_response", `${field} must be nonempty and contain unique file IDs`);
  return attachments;
}

function parsePendingMessage(input: unknown, field: string): PendingMessageDto {
  const item = object(input, field); exact(item, ["queueItemId", "operationId", "delivery", "text", "images", "attachments", "acceptedAt"]);
  const text = boundedString(item.text, `${field}.text`, MAX_PROMPT_CHARS);
  const images = item.images === undefined ? undefined : parseImagePaths(item.images, `${field}.images`);
  const attachments = item.attachments === undefined ? undefined : parseAttachmentDtos(item.attachments, `${field}.attachments`);
  if (text.length === 0 && (images === undefined || images.length === 0) && attachments === undefined) throw validation("invalid_response", `${field} requires text, an image, or an attachment`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) throw validation("invalid_response", `${field}.text contains terminal control characters`);
  return {
    queueItemId: id(item.queueItemId, `${field}.queueItemId`),
    operationId: id(item.operationId, `${field}.operationId`),
    delivery: enumeration(item.delivery, `${field}.delivery`, ["steer", "followUp"]),
    text,
    ...(images === undefined ? {} : { images }),
    ...(attachments === undefined ? {} : { attachments }),
    acceptedAt: timestamp(item.acceptedAt, `${field}.acceptedAt`),
  };
}
function imagePathCharacters(images: readonly ImagePathDto[] | undefined): number {
  return (images ?? []).reduce((total, image) => total + image.path.length + image.mimeType.length, 0);
}
function attachmentCharacters(attachments: readonly AttachmentDto[] | undefined): number {
  return (attachments ?? []).reduce((total, attachment) => total + attachment.fileId.length + attachment.name.length + attachment.sha256.length + attachment.storedAt.length + (attachment.mediaType?.length ?? 0) + 32, 0);
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
export function parseInstanceSnapshot(input: unknown, field = "instance"): InstanceSnapshot {
  const value = object(input, field); exact(value, ["id", "creationOperationId", "hostId", "key", "name", "displayName", "cwd", "gitBranch", "lifecycle", "execution", "compacting", "lastRun", "reopenable", "runtimeGeneration", "ownerHostEpoch", "interruption", "pending", "executor", "metrics", "extensionStatus", "toolsExpanded", "activeInteraction", "activeCommandId", "lastError", "createdAt", "updatedAt", "executionChangedAt", "runStartedAt", "eventCursor"]);
  const snapshot: InstanceSnapshot = {
    id: id(value.id, `${field}.id`), creationOperationId: id(value.creationOperationId, `${field}.creationOperationId`), hostId: optionalString(value.hostId, `${field}.hostId`, 128), key: optionalString(value.key, `${field}.key`, MAX_INSTANCE_KEY_CHARS), name: optionalString(value.name, `${field}.name`, MAX_INSTANCE_NAME_CHARS), displayName: instanceDisplayName(value.displayName, `${field}.displayName`), cwd: string(value.cwd, `${field}.cwd`, MAX_CONTROL_CWD_CHARS), gitBranch: value.gitBranch === undefined ? undefined : gitBranch(value.gitBranch, `${field}.gitBranch`),
    lifecycle: enumeration(value.lifecycle, `${field}.lifecycle`, ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(value.execution, `${field}.execution`, ["idle", "running", "failed", "unavailable"]), compacting: boolean(value.compacting, `${field}.compacting`), lastRun: enumeration(value.lastRun, `${field}.lastRun`, ["never", "succeeded", "failed", "aborted", "interrupted"]), reopenable: boolean(value.reopenable, `${field}.reopenable`), runtimeGeneration: positive(value.runtimeGeneration, `${field}.runtimeGeneration`), ownerHostEpoch: optionalString(value.ownerHostEpoch, `${field}.ownerHostEpoch`, 128), pending: parsePending(value.pending, `${field}.pending`), executor: parseExecutor(value.executor, `${field}.executor`), metrics: value.metrics === undefined ? undefined : parseMetrics(value.metrics, `${field}.metrics`), extensionStatus: {}, toolsExpanded: boolean(value.toolsExpanded, `${field}.toolsExpanded`), activeCommandId: optionalString(value.activeCommandId, `${field}.activeCommandId`, 128), lastError: optionalString(value.lastError, `${field}.lastError`, MAX_CATALOG_LAST_ERROR_CHARS), createdAt: timestamp(value.createdAt, `${field}.createdAt`), updatedAt: timestamp(value.updatedAt, `${field}.updatedAt`), executionChangedAt: timestamp(value.executionChangedAt, `${field}.executionChangedAt`), ...(value.runStartedAt === undefined ? {} : { runStartedAt: timestamp(value.runStartedAt, `${field}.runStartedAt`) }), eventCursor: parseCursor(value.eventCursor, `${field}.eventCursor`),
  };
  if (value.interruption !== undefined) { const interruption = object(value.interruption, `${field}.interruption`); exact(interruption, ["reason", "at"]); snapshot.interruption = { reason: enumeration(interruption.reason, "interruption.reason", ["host_crash", "host_shutdown", "replacement_failed"]), at: timestamp(interruption.at, "interruption.at") }; }
  const status = object(value.extensionStatus, `${field}.extensionStatus`); if (Object.keys(status).length > 64) throw validation("invalid_response", "extensionStatus has too many keys"); for (const [key, item] of Object.entries(status)) snapshot.extensionStatus[extensionKey(key, "extensionStatus key")] = payloadFreeString(item, `extensionStatus.${key}`, MAX_MESSAGE);
  if (value.activeInteraction !== undefined) { const interaction = object(value.activeInteraction, `${field}.activeInteraction`); exact(interaction, ["id", "method", "expiresAt"]); snapshot.activeInteraction = { id: id(interaction.id, "activeInteraction.id"), method: enumeration(interaction.method, "activeInteraction.method", ["select", "confirm", "input", "editor"]), ...(interaction.expiresAt === undefined ? {} : { expiresAt: timestamp(interaction.expiresAt, "activeInteraction.expiresAt") }) }; }
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

/** Agent diagnostics are content, not bounded control labels. Transport byte budgets
 * still apply to their envelopes; length, newlines and markup do not invalidate an error. */
export function parseAgentErrorText(input: unknown, field = "Agent error"): string {
  if (typeof input !== "string") throw validation("invalid_response", `${field} must be a string`);
  return input;
}

export function parseOptionalAgentErrorText(input: unknown, field = "Agent error"): string | undefined {
  return input === undefined ? undefined : parseAgentErrorText(input, field);
}

/** The Worker and public event envelope share this one conversation-frame parser. */
export function parseConversationFrame(input: unknown, field = "conversation frame"): ConversationFrame {
  const value = object(input, field);
  exact(value, ["type", "data"]);
  const type = enumeration(value.type, `${field}.type`, CONVERSATION_FRAME_TYPES);
  return { type, data: parseEventData(type, value.data, `${field}.data`) } as ConversationFrame;
}

function parseEventData(type: keyof EventDataMap, input: unknown, field: string): unknown {
  const data = object(input, field);
  const text = (key: string, max = MAX_TEXT): string => string(data[key], `${field}.${key}`, max);
  const optionalText = (key: string, max = MAX_TEXT): string | undefined => optionalString(data[key], `${field}.${key}`, max);
  const levels = (key: string): ThinkingLevel[] => thinkingLevels(data[key]);
  switch (type) {
    case "instance.created": exact(data, ["cwd", "name", "displayName", "executor"]); return { cwd: text("cwd", MAX_CONTROL_CWD_CHARS), name: optionalText("name", MAX_INSTANCE_NAME_CHARS), displayName: instanceDisplayName(data.displayName, `${field}.displayName`), executor: parseExecutor(data.executor, `${field}.executor`) };
    case "instance.state_changed": exact(data, ["reason", "lifecycle", "execution", "compacting", "lastRun", "pending", "activeCommandId", "lastError"]); { const result = { reason: text("reason", MAX_MESSAGE), lifecycle: enumeration(data.lifecycle, "lifecycle", ["active", "stopping", "stopped", "host_lost", "runtime_error"]), execution: enumeration(data.execution, "execution", ["idle", "running", "failed", "unavailable"]), compacting: boolean(data.compacting, "compacting"), lastRun: enumeration(data.lastRun, "lastRun", ["never", "succeeded", "failed", "aborted", "interrupted"]), pending: parsePending(data.pending, `${field}.pending`), activeCommandId: optionalText("activeCommandId", 128), lastError: optionalText("lastError", MAX_CATALOG_LAST_ERROR_CHARS) }; if (result.activeCommandId && result.execution !== "running") throw validation("invalid_response", "state event activeCommandId requires running"); if (result.compacting && result.execution !== "running") throw validation("invalid_response", "state event compacting requires running"); return result; }
    case "instance.reopened": exact(data, ["previousLifecycle", "sessionFile", "runtimeGeneration"]); return { previousLifecycle: enumeration(data.previousLifecycle, "previousLifecycle", ["host_lost", "runtime_error"]), sessionFile: text("sessionFile", MAX_CONTROL_CWD_CHARS), runtimeGeneration: positive(data.runtimeGeneration, "runtimeGeneration") };
    case "instance.stopped": exact(data, ["cleanupErrors"]); return { cleanupErrors: strings(data.cleanupErrors, "cleanupErrors", MAX_STOP_CLEANUP_ERRORS, MAX_STOP_CLEANUP_ERROR_CHARS) };
    case "instance.runtime_error": exact(data, ["operationId", "kind", "error", "recoverySessionFile"]); return { operationId: text("operationId", 128), kind: enumeration(data.kind, "kind", ["create", "new", "switch", "fork", "clone", "reload", "reopen"]), error: text("error", MAX_MESSAGE), recoverySessionFile: optionalText("recoverySessionFile", MAX_CONTROL_CWD_CHARS) };
    case "instance.error": exact(data, ["operationId", "source", "error", "runtimeEventType"]); return { operationId: optionalText("operationId", 128), source: enumeration(data.source, "source", ["event_projection", "command_background"]), error: text("error", MAX_MESSAGE), runtimeEventType: optionalText("runtimeEventType", 128) };
    case "command.accepted": exact(data, ["operationId", "delivery", "queued", "acceptedAt"]); return { operationId: text("operationId", 128), delivery: enumeration(data.delivery, "delivery", ["prompt", "steer", "followUp"]), queued: boolean(data.queued, "queued"), acceptedAt: timestamp(data.acceptedAt, "acceptedAt") };
    case "command.rejected": exact(data, ["operationId", "reason", "error"]); return { operationId: text("operationId", 128), reason: text("reason", MAX_MESSAGE), error: text("error", MAX_MESSAGE) };
    case "command.handled": exact(data, ["operationId", "kind"]); return { operationId: text("operationId", 128), kind: enumeration(data.kind, "kind", ["extension_command", "no_run"]) };
    case "run.started": exact(data, ["operationId"]); return { operationId: text("operationId", 128) };
    case "run.retry_started": exact(data, ["attempt", "maxAttempts", "delayMs", "error"]); return { attempt: unsigned(data.attempt, "attempt"), maxAttempts: unsigned(data.maxAttempts, "maxAttempts"), delayMs: unsigned(data.delayMs, "delayMs"), error: parseAgentErrorText(data.error, `${field}.error`) };
    case "run.retry_completed": exact(data, ["success", "attempt", "error"]); return { success: boolean(data.success, "success"), attempt: unsigned(data.attempt, "attempt"), error: parseOptionalAgentErrorText(data.error, `${field}.error`) };
    case "run.settled": exact(data, ["operationId", "result", "stopReason", "error"]); return { operationId: optionalText("operationId", 128), result: enumeration(data.result, "result", ["never", "succeeded", "failed", "aborted", "interrupted"]), stopReason: optionalText("stopReason", 128), error: parseOptionalAgentErrorText(data.error, `${field}.error`) };
    case "message.queued": return parsePendingMessage(data, field);
    case "message.submitted": {
      exact(data, ["operationId", "messageId", "role", "text", "images", "attachments", "delivery", "queueItemId"]);
      const delivery = enumeration(data.delivery, "delivery", ["prompt", "steer", "followUp"]);
      const queueItemId = optionalText("queueItemId", 128);
      return { operationId: text("operationId", 128), messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user"]), text: boundedString(data.text, `${field}.text`, MAX_PROMPT_CHARS), ...(data.images === undefined ? {} : { images: parseImagePaths(data.images, `${field}.images`) }), ...(data.attachments === undefined ? {} : { attachments: parseAttachmentDtos(data.attachments, `${field}.attachments`) }), delivery, queueItemId };
    }
    case "message.delta": exact(data, ["messageId", "block", "delta"]); return { messageId: text("messageId", 128), block: enumeration(data.block, "block", ["text", "thinking"]), delta: boundedString(data.delta, `${field}.delta`, MAX_TEXT) };
    case "message.completed": exact(data, ["messageId", "role", "content", "attachments", "stopReason", "error"]); return { messageId: text("messageId", 128), role: enumeration(data.role, "role", ["user", "assistant", "tool", "system"]), content: parseContent(data.content, `${field}.content`), ...(data.attachments === undefined ? {} : { attachments: parseAttachmentDtos(data.attachments, `${field}.attachments`) }), stopReason: optionalText("stopReason", 128), error: parseOptionalAgentErrorText(data.error, `${field}.error`) };
    case "tool.started": exact(data, ["toolCallId", "toolName", "args", "omittedFields"]); return toolArgs(data, field, true);
    case "tool.args_updated": exact(data, ["toolCallId", "args", "omittedFields"]); return toolArgs(data, field, false);
    case "tool.output_updated": {
      exact(data, ["toolCallId", "text", "content", "publishedFile", "presentation"]);
      const resultText = boundedString(data.text, `${field}.text`, MAX_TOOL_RESULT_TEXT);
      const content = data.content === undefined ? undefined : parseContent(data.content, `${field}.content`);
      const publishedFile = data.publishedFile === undefined ? undefined : parsePublishedFileDto(data.publishedFile, `${field}.publishedFile`);
      const presentation = data.presentation === undefined ? undefined : parseToolPresentation(data.presentation, `${field}.presentation`, undefined, false);
      return { toolCallId: text("toolCallId", 128), text: resultText, ...(content === undefined ? {} : { content }), ...(publishedFile === undefined ? {} : { publishedFile }), ...(presentation === undefined ? {} : { presentation }) };
    }
    case "tool.completed": {
      exact(data, ["toolCallId", "toolName", "text", "isError", "content", "publishedFile", "presentation", "omittedFields"]);
      const toolName = text("toolName", 256);
      const isError = boolean(data.isError, "isError");
      const resultText = boundedString(data.text, `${field}.text`, MAX_TOOL_RESULT_TEXT);
      const content = data.content === undefined ? undefined : parseContent(data.content, `${field}.content`);
      const publishedFile = data.publishedFile === undefined ? undefined : parsePublishedFileDto(data.publishedFile, `${field}.publishedFile`);
      const presentation = data.presentation === undefined ? undefined : parseToolPresentation(data.presentation, `${field}.presentation`, toolName, isError);
      return { toolCallId: text("toolCallId", 128), toolName, text: resultText, isError, ...(content === undefined ? {} : { content }), ...(publishedFile === undefined ? {} : { publishedFile }), ...(presentation === undefined ? {} : { presentation }), omittedFields: omitted(data.omittedFields, "omittedFields") };
    }
    case "queue.changed": exact(data, ["steering", "followUp", "total"]); return parsePending(data, field);
    case "queue.cleared": exact(data, ["steering", "followUp", "total", "queueItemIds", "reason"]); return { ...parsePending({ steering: data.steering, followUp: data.followUp, total: data.total }, field), queueItemIds: strings(data.queueItemIds, `${field}.queueItemIds`, MAX_PENDING_QUEUE_ITEMS, 128), reason: enumeration(data.reason, `${field}.reason`, ["dequeued", "abort", "stop", "replacement", "host_draining"]) };
    case "compaction.started": exact(data, ["reason", "operationId"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]), operationId: optionalText("operationId", 128) };
    case "compaction.completed": exact(data, ["reason", "operationId", "aborted", "willRetry", "error"]); return { reason: enumeration(data.reason, "reason", ["manual", "threshold", "overflow"]), operationId: optionalText("operationId", 128), aborted: boolean(data.aborted, "aborted"), willRetry: boolean(data.willRetry, "willRetry"), error: parseOptionalAgentErrorText(data.error, `${field}.error`) };
    case "session.replaced": exact(data, ["reason", "previousSessionFile", "sessionFile", "runtimeGeneration", "cwd", "piSessionId", "name", "displayName", "gitBranch"]); return { reason: enumeration(data.reason, "reason", ["new", "resume", "fork", "clone", "reload"]), previousSessionFile: optionalText("previousSessionFile", MAX_CONTROL_CWD_CHARS), sessionFile: optionalText("sessionFile", MAX_CONTROL_CWD_CHARS), runtimeGeneration: positive(data.runtimeGeneration, "runtimeGeneration"), cwd: text("cwd", MAX_CONTROL_CWD_CHARS), piSessionId: text("piSessionId", 128), name: optionalText("name", MAX_INSTANCE_NAME_CHARS), displayName: instanceDisplayName(data.displayName, `${field}.displayName`), gitBranch: data.gitBranch === undefined ? undefined : gitBranch(data.gitBranch, `${field}.gitBranch`) };
    case "session.navigated": exact(data, ["targetId", "leafId", "summaryCreated"]); return { targetId: text("targetId", 128), leafId: optionalText("leafId", 128), summaryCreated: boolean(data.summaryCreated, "summaryCreated") };
    case "session.info_changed": exact(data, ["name", "displayName"]); return { name: optionalText("name", MAX_INSTANCE_NAME_CHARS), displayName: instanceDisplayName(data.displayName, `${field}.displayName`) };
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
    case "extension.notification": {
      exact(data, ["message", "level", "operationId"]);
      const operationId = optionalText("operationId", 128);
      return {
        message: payloadFreeString(data.message, `${field}.message`, MAX_TEXT),
        level: enumeration(data.level, "level", ["info", "warning", "error"]),
        ...(operationId === undefined ? {} : { operationId }),
      };
    }
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
    case "extension.widget_changed": exact(data, ["key", "lines", "placement"]); return { key: extensionKey(data.key, `${field}.key`), lines: data.lines === undefined ? undefined : payloadFreeStrings(data.lines, `${field}.lines`, MAX_EXTENSION_WIDGET_LINES, MAX_TEXT), placement: data.placement === undefined ? undefined : enumeration(data.placement, "placement", ["aboveEditor", "belowEditor"]) };
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
  return array(input, field, MAX_CONVERSATION_CONTENT_BLOCKS).map((item, index) => {
    const block = object(item, `${field}[${index}]`); const type = enumeration(block.type, `${field}[${index}].type`, ["text", "thinking", "image", "tool_call", "tool_result", "omitted"]);
    if (type === "text" || type === "thinking") { exact(block, ["type", "text"]); return { type, text: boundedString(block.text, `${field}[${index}].text`, MAX_TEXT) }; }
    if (type === "image") {
      exact(block, ["type", "mimeType", "contentRef", "fileId"]);
      const mimeType = imageMimeType(block.mimeType, `${field}[${index}].mimeType`);
      return {
        type,
        mimeType,
        ...(block.contentRef === undefined ? {} : { contentRef: string(block.contentRef, `${field}[${index}].contentRef`, 128) }),
        ...(block.fileId === undefined ? {} : { fileId: id(block.fileId, `${field}[${index}].fileId`) }),
      };
    }
    if (type === "tool_call") { exact(block, ["type", "toolCallId", "toolName", "args", "omittedFields"]); return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName: string(block.toolName, "toolName", 256), args: parseJsonObject(block.args, "args"), omittedFields: omitted(block.omittedFields, "omittedFields") }; }
    if (type === "tool_result") {
      exact(block, ["type", "toolCallId", "toolName", "text", "isError", "publishedFile", "presentation", "omittedFields"]);
      const toolName = string(block.toolName, "toolName", 256);
      const isError = boolean(block.isError, "isError");
      const resultText = boundedString(block.text, "text", MAX_TOOL_RESULT_TEXT);
      const publishedFile = block.publishedFile === undefined ? undefined : parsePublishedFileDto(block.publishedFile, `${field}[${index}].publishedFile`);
      const presentation = block.presentation === undefined ? undefined : parseToolPresentation(block.presentation, `${field}[${index}].presentation`, toolName, isError);
      return { type, toolCallId: id(block.toolCallId, "toolCallId"), toolName, text: resultText, isError, ...(publishedFile === undefined ? {} : { publishedFile }), ...(presentation === undefined ? {} : { presentation }), omittedFields: omitted(block.omittedFields, "omittedFields") };
    }
    exact(block, ["type", "kind", "description"]); return { type, kind: enumeration(block.kind, "kind", ["image", "binary"]), description: string(block.description, "description", MAX_MESSAGE) };
  });
}
/** Canonical persisted conversation record; Worker checkpoint/history validation shares it. */
export function parseHistoryEntry(input: unknown, field: string): HistoryEntryDto {
  const entry = object(input, field);
  exact(entry, [
    "recordId", "entryId", "parentId", "kind", "source", "visibility", "timestamp", "content", "attachments",
    "stopReason", "error", "toolCallId", "toolName", "isError", "customType", "display", "metadata",
    "metadataOmittedFields", "command", "exitCode", "cancelled", "truncated", "fullOutputPath", "excludeFromContext",
    "firstKeptEntryId", "tokensBefore", "fromEntryId", "targetEntryId", "label", "provider", "modelId",
    "thinkingLevel", "name",
  ]);
  const exitCode = entry.exitCode === undefined
    ? undefined
    : typeof entry.exitCode === "number" && Number.isSafeInteger(entry.exitCode)
      ? entry.exitCode
      : (() => { throw validation("invalid_response", `${field}.exitCode must be a safe integer`); })();
  return {
    recordId: id(entry.recordId, `${field}.recordId`),
    entryId: id(entry.entryId, `${field}.entryId`),
    parentId: optionalString(entry.parentId, `${field}.parentId`, 128),
    kind: enumeration(entry.kind, `${field}.kind`, ["message", "custom_message", "bash_execution", "compaction_summary", "branch_summary", "custom", "model_change", "thinking_level_change", "session_info", "label"]),
    source: enumeration(entry.source, `${field}.source`, ["user", "assistant", "tool", "system", "extension", "runtime"]),
    visibility: enumeration(entry.visibility, `${field}.visibility`, ["conversation", "metadata", "hidden"]),
    timestamp: entry.timestamp === undefined ? undefined : timestamp(entry.timestamp, `${field}.timestamp`),
    content: parseContent(entry.content, `${field}.content`),
    attachments: entry.attachments === undefined ? undefined : parseAttachmentDtos(entry.attachments, `${field}.attachments`),
    stopReason: optionalString(entry.stopReason, `${field}.stopReason`, 128),
    error: parseOptionalAgentErrorText(entry.error, `${field}.error`),
    toolCallId: optionalString(entry.toolCallId, `${field}.toolCallId`, 128),
    toolName: optionalString(entry.toolName, `${field}.toolName`, 256),
    isError: optionalBoolean(entry.isError, `${field}.isError`, "invalid_response"),
    customType: optionalString(entry.customType, `${field}.customType`, 256),
    display: optionalBoolean(entry.display, `${field}.display`, "invalid_response"),
    metadata: entry.metadata === undefined ? undefined : parseJsonValue(entry.metadata, `${field}.metadata`, 0),
    metadataOmittedFields: omitted(entry.metadataOmittedFields, `${field}.metadataOmittedFields`),
    command: optionalString(entry.command, `${field}.command`, MAX_TEXT),
    exitCode,
    cancelled: optionalBoolean(entry.cancelled, `${field}.cancelled`, "invalid_response"),
    truncated: optionalBoolean(entry.truncated, `${field}.truncated`, "invalid_response"),
    fullOutputPath: optionalString(entry.fullOutputPath, `${field}.fullOutputPath`, MAX_CONTROL_CWD_CHARS),
    excludeFromContext: optionalBoolean(entry.excludeFromContext, `${field}.excludeFromContext`, "invalid_response"),
    firstKeptEntryId: optionalString(entry.firstKeptEntryId, `${field}.firstKeptEntryId`, 128),
    tokensBefore: entry.tokensBefore === undefined ? undefined : unsigned(entry.tokensBefore, `${field}.tokensBefore`),
    fromEntryId: optionalString(entry.fromEntryId, `${field}.fromEntryId`, 128),
    targetEntryId: optionalString(entry.targetEntryId, `${field}.targetEntryId`, 128),
    label: optionalString(entry.label, `${field}.label`, 256),
    provider: optionalString(entry.provider, `${field}.provider`, 256),
    modelId: optionalString(entry.modelId, `${field}.modelId`, 512),
    thinkingLevel: optionalString(entry.thinkingLevel, `${field}.thinkingLevel`, 64),
    name: optionalString(entry.name, `${field}.name`, 256),
  };
}

function parseWorkspaceEntryDto(input: unknown, field: string): WorkspaceEntryDto {
  const value = object(input, field);
  exact(value, ["path", "name", "kind", "hidden", "targetKind", "sizeBytes"]);
  const kind = enumeration(value.kind, `${field}.kind`, ["file", "directory", "symlink"]);
  const targetKind = value.targetKind === undefined ? undefined : enumeration(value.targetKind, `${field}.targetKind`, ["file", "directory", "unavailable"]);
  const sizeBytes = value.sizeBytes === undefined ? undefined : unsigned(value.sizeBytes, `${field}.sizeBytes`);
  if (sizeBytes !== undefined && sizeBytes > Number.MAX_SAFE_INTEGER) throw validation("invalid_response", `${field}.sizeBytes is invalid`);
  if (kind === "symlink" && targetKind === undefined) throw validation("invalid_response", `${field}.targetKind is required for symbolic links`);
  if (kind !== "symlink" && targetKind !== undefined) throw validation("invalid_response", `${field}.targetKind is only valid for symbolic links`);
  if ((kind === "file" || targetKind === "file") && sizeBytes === undefined) throw validation("invalid_response", `${field}.sizeBytes is required for files`);
  if ((kind === "directory" || targetKind === "directory" || targetKind === "unavailable") && sizeBytes !== undefined) throw validation("invalid_response", `${field}.sizeBytes is not valid for this entry`);
  return {
    path: workspaceRelativePath(value.path, `${field}.path`),
    name: string(value.name, `${field}.name`, MAX_WORKSPACE_ENTRY_NAME_CHARS),
    kind,
    hidden: boolean(value.hidden, `${field}.hidden`),
    ...(targetKind === undefined ? {} : { targetKind }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

export function normalizeWorkspaceRelativePath(path: string): string {
  return workspaceRelativePath(path, "workspace path", "workspace_path_invalid");
}

function workspaceRelativePath(input: unknown, field: string, code = "invalid_response"): string {
  const value = string(input, field, MAX_CONTROL_CWD_CHARS, code);
  if (value.includes("\0") || value.startsWith("/")) throw validation(code, "This path is outside the workspace. Choose a path inside the workspace.");
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw validation(code, "This path leaves the workspace. Choose a path inside the workspace.");
  return parts.length === 0 ? "." : parts.join("/");
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
  return { method, value: responseValue };
}

function parseDialogRequest(data: Record<string, unknown>, field: string): EventDataMap["interaction.requested"] {
  const method = enumeration(data.method, `${field}.method`, ["select", "confirm", "input", "editor"]);
  const controllerId = id(data.controllerId, `${field}.controllerId`);
  const interactionId = id(data.interactionId, `${field}.interactionId`);
  const title = payloadFreeString(data.title, `${field}.title`, MAX_MESSAGE);
  const issuedAt = timestamp(data.issuedAt, `${field}.issuedAt`);
  const expiresAt = data.expiresAt === undefined ? undefined : timestamp(data.expiresAt, `${field}.expiresAt`);
  const lifetime = expiresAt === undefined ? {} : { expiresAt };
  if (method === "select") { exact(data, ["controllerId", "interactionId", "method", "title", "options", "issuedAt", "expiresAt"]); return { controllerId, interactionId, method, title, options: payloadFreeStrings(data.options, `${field}.options`, 200, MAX_TEXT), issuedAt, ...lifetime }; }
  if (method === "confirm") { exact(data, ["controllerId", "interactionId", "method", "title", "message", "issuedAt", "expiresAt"]); return { controllerId, interactionId, method, title, message: payloadFreeString(data.message, `${field}.message`, MAX_TEXT), issuedAt, ...lifetime }; }
  if (method === "input") { exact(data, ["controllerId", "interactionId", "method", "title", "placeholder", "issuedAt", "expiresAt"]); return { controllerId, interactionId, method, title, ...(data.placeholder === undefined ? {} : { placeholder: payloadFreeString(data.placeholder, `${field}.placeholder`, MAX_TEXT) }), issuedAt, ...lifetime }; }
  exact(data, ["controllerId", "interactionId", "method", "title", "prefill", "issuedAt", "expiresAt"]); return { controllerId, interactionId, method, title, ...(data.prefill === undefined ? {} : { prefill: payloadFreeString(data.prefill, `${field}.prefill`, MAX_PROMPT_CHARS) }), issuedAt, ...lifetime };
}

function payloadFreeString(input: unknown, field: string, max: number, code = "invalid_response"): string {
  return string(input, field, max, code);
}

function payloadFreeBoundedString(input: unknown, field: string, max: number, code = "invalid_response"): string {
  return boundedString(input, field, max, code);
}

function payloadFreeStrings(input: unknown, field: string, maxItems: number, maxChars: number, code = "invalid_response"): string[] {
  return strings(input, field, maxItems, maxChars, code);
}

function extensionKey(input: unknown, field: string): string {
  const key = payloadFreeString(input, field, 128);
  if (key === "__proto__" || key === "prototype" || key === "constructor") throw validation("invalid_response", `${field} is unsafe`);
  return key;
}

function instanceDisplayName(input: unknown, field: string): string {
  const value = string(input, field, MAX_INSTANCE_DISPLAY_NAME_CHARS);
  if (!/^[\p{L}\p{M}\p{N}_-]+(?: [\p{L}\p{M}\p{N}_-]+)*$/u.test(value)) {
    throw validation("invalid_response", `${field} must be a canonical safe display name`);
  }
  return value;
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
function parseResource(input: unknown, field: string): ResourceDto { const value = object(input, field); exact(value, ["kind", "name", "path", "source", "contentRef"]); return { kind: enumeration(value.kind, `${field}.kind`, ["extension", "skill", "prompt", "context"]), name: string(value.name, `${field}.name`, 256), ...(value.path === undefined ? {} : { path: string(value.path, `${field}.path`, MAX_CONTROL_CWD_CHARS) }), ...(value.source === undefined ? {} : { source: parseSource(value.source, `${field}.source`) }), ...(value.contentRef === undefined ? {} : { contentRef: string(value.contentRef, `${field}.contentRef`, 128) }) }; }
function parseSource(input: unknown, field: string, code = "invalid_response"): import("../core/config-projection.js").SourceDto { const value = object(input, field, code); exact(value, ["kind", "path", "package"], code); const kind=enumeration(value.kind, `${field}.kind`, ["built-in", "extension", "skill", "prompt"], code); if(kind==="built-in"&&(value.path!==undefined||value.package!==undefined))throw validation(code,`${field} built-in source cannot carry path or package`); return { kind, ...(value.path === undefined ? {} : { path: string(value.path, `${field}.path`, MAX_CONTROL_CWD_CHARS, code) }), ...(value.package === undefined ? {} : { package: string(value.package, `${field}.package`, 256, code) }) }; }
function parseDiagnostic(input: unknown, field: string): DiagnosticDto { const value = object(input, field); exact(value, ["severity", "message", "source"]); return { severity: enumeration(value.severity, `${field}.severity`, ["info", "warning", "error"]), message: string(value.message, `${field}.message`, MAX_MESSAGE), ...(value.source === undefined ? {} : { source: string(value.source, `${field}.source`, 256) }) }; }
function parseCommandReference(input: unknown, field: string, code = "invalid_response"): CommandReferenceDto { const value = object(input, field, code); exact(value, ["name", "source"], code); return { name: string(value.name, `${field}.name`, 256, code), source: parseSource(value.source, `${field}.source`, code) }; }
function parseCommandArgumentCompletion(input: unknown, field: string): CommandArgumentCompletionDto { const value = object(input, field); exact(value, ["value", "label", "description"]); return { value: boundedString(value.value, `${field}.value`, MAX_COMMAND_ARGUMENT_PREFIX_CHARS), label: string(value.label, `${field}.label`, MAX_COMMAND_COMPLETION_TEXT_CHARS), ...(value.description === undefined ? {} : { description: boundedString(value.description, `${field}.description`, MAX_COMMAND_COMPLETION_TEXT_CHARS) }) }; }
function parseCommand(input: unknown, field: string): CommandDto { const value = object(input, field); exact(value, ["name", "description", "source", "argumentHint", "argumentCompletions", "contentAvailable"]); const contentAvailable=value.contentAvailable===undefined?undefined:boolean(value.contentAvailable,`${field}.contentAvailable`); if(contentAvailable===false)throw validation("invalid_response",`${field}.contentAvailable must be omitted unless true`); return { ...parseCommandReference(value, field), ...(value.description === undefined ? {} : { description: boundedString(value.description, `${field}.description`, MAX_MESSAGE) }), ...(value.argumentHint === undefined ? {} : { argumentHint: boundedString(value.argumentHint, `${field}.argumentHint`, MAX_COMMAND_ARGUMENT_HINT_CHARS) }), argumentCompletions: boolean(value.argumentCompletions, `${field}.argumentCompletions`), ...(contentAvailable===true?{contentAvailable:true as const}:{}) }; }
export function parseSettingDto(input: unknown, field: string): SettingDto {
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
function omitted(input: unknown, field: string): string[] | undefined { if (input === undefined) return undefined; const result = strings(input, field, MAX_JSON_OMITTED_FIELDS, MAX_CONTROL_CWD_CHARS); if (result.some((item) => !item.startsWith("/"))) throw validation("invalid_response", `${field} must contain relative JSON pointers`); return result; }
function thinkingLevels(input: unknown): ThinkingLevel[] { return array(input, "availableThinkingLevels", THINKING_LEVELS.length).map((item) => enumeration(item, "thinking level", THINKING_LEVELS)); }

export class ProtocolValidationError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ProtocolValidationError"; } }
function validation(code: string, message: string): ProtocolValidationError { return new ProtocolValidationError(code, message); }
function object(input: unknown, field: string, code = "invalid_response"): Record<string, unknown> { if (input === null || typeof input !== "object" || Array.isArray(input)) throw validation(code, `${field} must be a JSON object`); return input as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], code = "invalid_response"): void {
  // Client and hello input stays closed. Host responses/events are additive:
  // readers validate the fields they understand and ignore future optional ones.
  if (code === "invalid_response") return;
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw validation(code, `Unexpected field: ${unexpected}`);
}
function boundedString(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string { if (typeof input !== "string" || input.length > max) throw validation(code, `${field} must be a bounded string`); return input; }
function string(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string { const value=boundedString(input,field,max,code); if(value.length===0)throw validation(code,`${field} must be a bounded non-empty string`); return value; }
function id(input: unknown, field: string, code = "invalid_response"): string { return string(input, field, 128, code); }
function optionalString(input: unknown, field: string, max = MAX_CONTROL_CWD_CHARS, code = "invalid_response"): string | undefined { return input === undefined ? undefined : string(input, field, max, code); }
function boolean(input: unknown, field: string, code = "invalid_response"): boolean { if (typeof input !== "boolean") throw validation(code, `${field} must be boolean`); return input; }
function optionalBoolean(input: unknown, field: string, code: string): boolean | undefined { return input === undefined ? undefined : boolean(input, field, code); }
function unsigned(input: unknown, field: string, code = "invalid_response"): number { if (!Number.isSafeInteger(input) || (input as number) < 0) throw validation(code, `${field} must be a non-negative safe integer`); return input as number; }
function canonicalBase64(input: unknown, field: string, maxDecodedBytes: number): string { const value = string(input, field, Math.ceil(maxDecodedBytes / 3) * 4 + 4); const bytes = Buffer.from(value, "base64"); if (bytes.length > maxDecodedBytes || bytes.toString("base64") !== value) throw validation("invalid_response", `${field} must be canonical bounded base64`); return value; }
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
function parseJsonValue(input: unknown, field: string, depth: number): JsonValue { if (depth > MAX_JSON_VALUE_DEPTH) throw validation("invalid_response", `${field} exceeds JSON depth`); if (input === null || typeof input === "boolean") return input; if (typeof input === "string") return boundedString(input, field, MAX_JSON_STRING_CHARS); if (typeof input === "number" && Number.isFinite(input)) return input; if (Array.isArray(input)) return array(input, field, MAX_JSON_ARRAY_ITEMS).map((item, index) => parseJsonValue(item, `${field}[${index}]`, depth + 1)); const value = object(input, field); if (Object.keys(value).length > MAX_JSON_OBJECT_KEYS) throw validation("invalid_response", `${field} has too many keys`); return Object.fromEntries(Object.entries(value).map(([key, item]) => [string(key, `${field} key`, 256), parseJsonValue(item, `${field}.${key}`, depth + 1)])); }
function valueOr(input: unknown): unknown { return input; }
