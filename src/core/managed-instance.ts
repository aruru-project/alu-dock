import { createHash, randomUUID } from "node:crypto";

import { truncateWithEllipsis as truncate } from "./bounded-text.js";
import { InstanceEventJournal } from "./instance-event-journal.js";
import { InstanceCommandScheduler, type InstanceCommandDecision, type InstanceCommandLease, type InstanceProjectionReadReservation } from "./instance-command-scheduler.js";
import { cloneJson, type JsonObject } from "./json-value.js";
import { cloneWorkerConfig } from "./worker-config.js";
import { isPortableAbsoluteLocalPath } from "./local-path.js";
import {
  CatalogEffectUnknownError,
  CatalogWriteError,
  MutationFaultedError,
  MAX_CATALOG_LAST_ERROR_CHARS,
  type CatalogInstanceRecord,
  type CatalogMutationContext,
  type InstanceCatalogMutationPort,
  validateInstanceKey,
  validateInstanceStateInvariant,
} from "./catalog.js";
import {
  ExtensionUiBroker,
  type ControllerClaim,
  type ExtensionUiEventType,
  type InteractionResponse,
  type InteractionResult,
} from "./extension-ui-broker.js";
import {
  AgentCompactionKnownFailureError,
  AgentInvalidDeliveryModeError,
  AgentInvalidTreeTargetError,
  AgentMutationEffectUnknownError,
  AgentQueueRejectedBeforeEffectError,
  AgentSettingsWriteError,
  AgentUnavailableBeforeEffectError,
} from "./agent-worker.js";
import type {
  CommandDto,
  CommandReferenceDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  SettingValueMap,
  SourceDto,
  ToolDto,
} from "./config-projection.js";
export type { CommandDto, CommandReferenceDto, DiagnosticDto, ResourceDto, SettingDto, SettingKey, SettingUpdate, SettingValueMap, SourceDto, ToolDto } from "./config-projection.js";
import type {
  ClearedAgentQueue,
  AgentCleanupResult,
  AgentCommandPreflightResult,
  AgentCompactionResult,
  AgentInvokeOptions,
  AgentRequest,
  AgentConversationContentChunk,
  AgentConversationContentPage,
  AgentConversationHistoryPage,
  AgentConversationImageBody,
  AgentEvent,
  AgentFileSource,
  AgentForkResult,
  AgentHistoryEntry,
  AgentInputKind,
  AgentModelInfo,
  AgentCommandCatalogBody,
  AgentCommandCompletionsBody,
  AgentCommandContentBody,
  AgentModelListBody,
  AgentModelState,
  AgentModelStateObservation,
  AgentResourceProjectionBody,
  AgentSessionListBody,
  AgentNavigateOptions,
  AgentNavigateResult,
  AgentProjectTrust,
  AgentReplacementResult,
  AgentWorkerConnection,
  AgentSessionInfo,
  AgentSessionMetrics,
  AgentToolProjection,
  AgentSessionTarget,
  ThinkingLevel,
} from "./agent-worker.js";
import { projectInstanceDisplayName } from "./instance-display-name.js";
import { PublishedFileUnavailableError, type PublishedFileReadPage } from "./published-file.js";
import { readPublishedFilePage } from "../control/published-file-reader.js";
import { readResourceContent, ResourceContentError } from "./resource-content.js";
import { InstanceDeliverables, type DeliverableDto } from "./instance-deliverables.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILE_ID_CHARS,
  MAX_ATTACHMENT_IDS_PER_COMMAND,
  MAX_ATTACHMENT_MEDIA_TYPE_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
} from "./instance-attachments.js";
import {
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_ITEMS,
  MAX_PENDING_QUEUE_TEXT_CHARS,
  MAX_STOP_CLEANUP_ERROR_CHARS,
} from "./instance-dto.js";
import { MAX_CONVERSATION_CONTENT_BLOCKS } from "./instance-dto.js";
import type {
  AttachProjection,
  AttachmentDto,
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
  HistoryPageDto,
  ImagePathDto,
  InstanceExecution,
  InstanceLifecycle,
  InstanceSnapshot,
  LastRunResult,
  PendingDto,
  PendingMessageDto,
  QueueDequeueReceipt,
  SessionCompactionDto,
  SessionDto,
  SessionMetricsDto,
  SettingsChangedData,
  StopReceipt,
  TreeNodeDto,
} from "./instance-dto.js";
export type {
  AttachProjection,
  CommandReceipt,
  ContentBlockDto,
  ConversationFrame,
  ConversationContentChunkDto,
  ConversationContentPageDto,
  ConversationHistoryEntryDto,
  ConversationHistoryPageDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  HistoryEntryDto,
  HistoryPageDto,
  ImagePathDto,
  InstanceExecution,
  InstanceLifecycle,
  InstanceSnapshot,
  LastRunResult,
  PendingDto,
  PendingMessageDto,
  QueueDequeueReceipt,
  SessionCompactionDto,
  SessionDto,
  SessionMetricsDto,
  SettingsChangedData,
  StopReceipt,
  TreeNodeDto,
} from "./instance-dto.js";
export {
  MAX_CONVERSATION_IMAGE_CHUNK_BYTES,
  MAX_IMAGE_AGGREGATE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
  MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS,
  MAX_PENDING_QUEUE_ITEMS,
  MAX_PENDING_QUEUE_TEXT_CHARS,
  MAX_SEMANTIC_HISTORY_PAGE_ITEMS,
} from "./instance-dto.js";
import { projectAgentNavigateResult } from "./session-tree.js";
import { classifyControlRequest, type ResourceContentResult, type SessionTreeResult } from "../control/protocol.js";
import type { ObservationNotification } from "./instance-observation.js";

interface AgentEventTransition {
  kind: string;
  durable: boolean;
  operationId?: string;
  before?: () => void;
  mutate: () => void;
  publish: () => void;
  cleanup?: () => void;
  settle?: () => void;
}

export interface ManagedInstanceOptions {
  id?: string;
  key?: string;
  name?: string;
  cwd: string;
  session: AgentWorkerConnection;
  executor?: Omit<ExecutorIdentity, "piSessionId" | "sessionFile">;
  eventCapacity?: number;
  now?: () => Date;
  commandId?: () => string;
  creationOperationId?: string;
  hostEpoch?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
  extensionUiBroker?: ExtensionUiBroker;
  initialHistory?: AgentHistoryEntry[];
  dockToolsEnabled?: boolean;
  /** Adapter-owned creation input; Dock persists it without interpreting fields. */
  workerConfig?: JsonObject;
}

interface AssistantOutcome {
  stopReason?: string;
  errorMessage?: string;
}

interface AcceptedPromptMessage {
  operationId: string;
  text: string;
  images?: ImagePathDto[];
  attachments?: AttachmentDto[];
}

interface QueuedUserMessageStart {
  queued: PendingQueueMessage;
}

type PendingQueuePhase = "runtime_queued" | "host_deferred" | "dispatching" | "fresh_in_flight" | "effect_unknown";

interface PendingQueueMessage extends PendingMessageDto {
  /** Internal same-Host custody; never crosses Protocol V2 or the durable catalog. */
  phase: PendingQueuePhase;
  /** Lossless runtime payload; `text` remains the bounded closed-wire projection. */
  originalText?: string;
  runtimeTextHash?: string;
}

interface MutableState {
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  compacting: boolean;
  lastRun: LastRunResult;
  pendingSteering: number;
  pendingFollowUp: number;
  activeCommandId?: string;
  lastError?: string;
  updatedAt: string;
}

interface WorkingCheckpoint {
  state: MutableState;
  key: string | undefined;
  name: string | undefined;
  cwd: string;
  executor: ExecutorIdentity;
  runtimeGeneration: number;
  agentStartCount: number;
  agentSettledCount: number;
  lastAssistantOutcome: AssistantOutcome | undefined;
  stopRequestedWhileRunning: boolean;
  catalogAdmissionOperationId: string | undefined;
  replacementIntent: CatalogInstanceRecord["replacement"];
  durableSessionFile: string | undefined;
  recoverySessionFile: string | undefined;
  lastKnown: CatalogInstanceRecord["lastKnown"];
  interruption: CatalogInstanceRecord["interruption"];
  stopRequestedAt: string | undefined;
  shutdownRequestedAt: string | undefined;
  ownerReleaseUnconfirmed: boolean;
  dockToolsEnabled: boolean;
  executionChangedAt: string;
  runStartedAt: string | undefined;
  timedExecution: InstanceExecution;
}

export class InstanceNotActiveError extends Error {
  constructor(instanceId: string, lifecycle: InstanceLifecycle) {
    super(`Instance ${instanceId} is ${lifecycle} and cannot accept commands`);
    this.name = "InstanceNotActiveError";
  }
}

export class InvalidDeliveryModeError extends Error {
  constructor(mode: DeliveryMode, isRunning: boolean) {
    const expectation = isRunning
      ? "use steer or followUp while the instance is running"
      : "use prompt while the instance is idle";
    super(`Delivery mode ${mode} is invalid: ${expectation}`);
    this.name = "InvalidDeliveryModeError";
  }
}

export class InstanceAdmissionPendingError extends Error {
  constructor(instanceId: string) {
    super(`Instance ${instanceId} is still deciding a previous command preflight`);
    this.name = "InstanceAdmissionPendingError";
  }
}

export class QueueCapacityError extends Error {
  constructor() {
    super(`Pending queue is limited to ${MAX_PENDING_QUEUE_ITEMS} items and ${MAX_PENDING_QUEUE_TEXT_CHARS} characters`);
    this.name = "QueueCapacityError";
  }
}

export class InstanceBusyError extends Error {
  constructor(instanceId: string, action: string) {
    super(`Instance ${instanceId} must be idle before ${action}`);
    this.name = "InstanceBusyError";
  }
}

export class StaleRuntimeGenerationError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super("This work changed while the request was being prepared; try again");
    this.name = "StaleRuntimeGenerationError";
  }
}

export class RuntimeEffectUnknownError extends Error {
  readonly queryHint = "Query the instance snapshot before any retry";

  constructor(readonly operationId: string, cause?: unknown) {
    super(`Runtime mutation may have taken effect for operation ${operationId}`);
    this.name = "RuntimeEffectUnknownError";
    this.cause = cause;
  }
}

export class ManagedInstance {
  readonly id: string;
  readonly creationOperationId: string;
  readonly hostEpoch: string;
  readonly createdAt: string;

  private readonly session: AgentWorkerConnection;
  private readonly extensionUi: ExtensionUiBroker;
  private keyValue: string | undefined;
  private nameValue: string | undefined;
  private cwdValue: string;
  private gitBranchValue: string | undefined;
  private readonly executorIdentity: ExecutorIdentity;
  private metricsValue: SessionMetricsDto;
  private readonly now: () => Date;
  private readonly createCommandId: () => string;
  private readonly journal: InstanceEventJournal;
  private readonly commandScheduler: InstanceCommandScheduler;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private state: MutableState;
  private catalogPort: InstanceCatalogMutationPort | undefined;
  private committedSnapshotValue: InstanceSnapshot | undefined;
  private catalogAdmissionOperationId: string | undefined;
  private readonly admissionBufferedEvents: AgentEvent[] = [];
  private modelConfigurationActive = false;
  private deferredModelObservation: AgentModelStateObservation | undefined;
  private admissionBufferOverflow = false;
  private receiptBoundaryOperationId: string | undefined;
  private sessionNameOperationId: string | undefined;
  private readonly receiptBoundaryTasks: Promise<void>[] = [];
  private replacementIntent: CatalogInstanceRecord["replacement"];
  private durableSessionFileValue: string | undefined;
  private recoverySessionFile: string | undefined;
  private lastKnownValue: CatalogInstanceRecord["lastKnown"];
  private interruptionValue: CatalogInstanceRecord["interruption"];
  private stopRequestedAt: string | undefined;
  private shutdownRequestedAt: string | undefined;
  private ownerReleaseUnconfirmed = false;
  private dockToolsEnabledValue = false;
  private readonly workerConfigValue: JsonObject | undefined;
  private readonly deliverables = new InstanceDeliverables();
  private executionChangedAtValue!: string;
  private runStartedAtValue: string | undefined;
  private timedExecutionValue: InstanceExecution = "idle";
  private transitionTail: Promise<void> = Promise.resolve();
  private historyRefreshTail: Promise<void> = Promise.resolve();
  private hostDrainActive = false;
  private hostDrainPromise: Promise<void> | undefined;
  private runtimeDisposePromise: Promise<AgentCleanupResult> | undefined;
  private runtimeGenerationValue = 1;
  private agentStartCount = 0;
  private agentSettledCount = 0;
  private readonly acceptedPromptMessages: AcceptedPromptMessage[] = [];
  private readonly consumedQueueItemIds = new Map<string, string>();
  /** User-visible, still-restorable Queue custody for this runtime generation. */
  private readonly pendingQueueMessages: PendingQueueMessage[] = [];
  /**
   * Items removed from the Queue by an explicit dequeue after Pi had already
   * begun consuming them. They are not pending/restorable, but their identity
   * remains until message_start so duplicate text cannot steal attribution.
   */
  private readonly inFlightQueueMessages: PendingQueueMessage[] = [];
  private runtimeSteeringHashes: string[] = [];
  private runtimeFollowUpHashes: string[] = [];
  private lastAssistantOutcome: AssistantOutcome | undefined;
  private stopRequestedWhileRunning = false;
  private compactionActive = false;
  /** Synchronous runtime-edge truth closes the gap before catalog projection catches up. */
  private runtimeCompactingObserved: boolean | undefined;
  private compactionQueueDrainTask: Promise<void> | undefined;
  private compactionQueueDrainGeneration: number | undefined;
  private nextAgentStartBoundary: { operationId: string; resolve: () => void } | undefined;
  private compactionRequestOperationId: string | undefined;
  private compactionOperationId: string | undefined;
  private compactionBoundary: Promise<void> | undefined;
  private resolveCompactionBoundary: (() => void) | undefined;
  private stopCompletion: Promise<StopReceipt> | undefined;

  get runtimeGeneration(): number { return this.runtimeGenerationValue; }
  get key(): string | undefined { return this.keyValue; }
  get name(): string | undefined { return this.nameValue; }
  get cwd(): string { return this.cwdValue; }

  constructor(options: ManagedInstanceOptions) {
    this.id = options.id ?? randomUUID();
    this.creationOperationId = options.creationOperationId ?? randomUUID();
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    if (options.key !== undefined) validateInstanceKey(options.key);
    this.keyValue = options.key;
    this.nameValue = options.name;
    this.cwdValue = options.cwd;
    this.session = options.session;
    this.gitBranchValue = projectGitBranch(this.agentState().gitBranch);
    this.now = options.now ?? (() => new Date());
    this.createCommandId = options.commandId ?? randomUUID;
    this.extensionUi = options.extensionUiBroker ?? new ExtensionUiBroker(this.now, this.createCommandId);
    this.dockToolsEnabledValue = options.dockToolsEnabled ?? false;
    this.workerConfigValue = options.workerConfig === undefined
      ? undefined
      : cloneWorkerConfig(options.workerConfig, "Worker configuration");

    const initializedAt = this.timestamp();
    this.createdAt = options.createdAt ?? initializedAt;
    const initialUpdatedAt = initializedAt < this.createdAt ? this.createdAt : initializedAt;
    const initialGeneration = options.initialRuntimeGeneration ?? 1;
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) throw new Error("Initial runtime generation must be positive");
    this.runtimeGenerationValue = initialGeneration;
    this.executionChangedAtValue = initialUpdatedAt;
    this.timedExecutionValue = "idle";
    this.state = {
      lifecycle: "active",
      execution: "idle",
      compacting: false,
      lastRun: "never",
      pendingSteering: 0,
      pendingFollowUp: 0,
      updatedAt: initialUpdatedAt,
    };
    this.commandScheduler = new InstanceCommandScheduler(() => ({
      acceptingCommands: this.state.lifecycle === "active",
      lifecycle: this.state.lifecycle,
      runtimeGeneration: this.runtimeGenerationValue,
      executionRunning: this.state.execution === "running",
      runtimeStreaming: this.agentState().isStreaming,
      compactionActive: this.compactionActive,
      pendingQueueMessages: this.pendingQueueMessages.length,
      inFlightQueueMessages: this.inFlightQueueMessages.length,
      pendingSteering: this.state.pendingSteering,
      pendingFollowUp: this.state.pendingFollowUp,
    }));
    this.executorIdentity = {
      kind: truncate(options.executor?.kind ?? "pi-sdk", 128) ?? "pi-sdk",
      version: truncate(options.executor?.version, 128),
      model: options.executor?.model ? { provider: truncate(options.executor.model.provider, 256) ?? "unknown", id: truncate(options.executor.model.id, 512) ?? "unknown", name: truncate(options.executor.model.name, 256) } : undefined,
      thinkingLevel: options.executor?.thinkingLevel,
      piSessionId: truncate(this.agentState().sessionId, 128) ?? "unknown",
      sessionFile: truncate(this.agentState().sessionFile, 16_384),
    };
    this.durableSessionFileValue = this.runtimeDurableSessionFile();
    this.metricsValue = projectRuntimeMetrics(this.agentState().metrics);
    this.journal = new InstanceEventJournal({
      hostEpoch: this.hostEpoch,
      instanceId: this.id,
      initialRuntimeGeneration: initialGeneration,
      eventCapacity: options.eventCapacity,
      initialHistory: (options.initialHistory ?? []).map(projectAgentHistoryEntry),
      onCursorAdvanced: (eventCursor) => {
        if (this.catalogPort && this.committedSnapshotValue) {
          this.committedSnapshotValue = { ...this.committedSnapshotValue, eventCursor };
        }
      },
    });

    this.session.subscribe((event) => this.dispatchAgentEvent(event));

    if (options.reopenedFrom) {
      const sessionFile = this.executorIdentity.sessionFile;
      if (!sessionFile) throw new Error("A reopened instance requires a persisted Pi session file");
      this.appendEvent("instance.reopened", {
        previousLifecycle: options.reopenedFrom,
        sessionFile,
        runtimeGeneration: this.runtimeGenerationValue,
      });
    } else {
      this.appendEvent("instance.created", {
        cwd: this.cwd,
        name: this.name,
        displayName: this.projectedDisplayName(),
        executor: this.executorIdentity,
      });
    }
    this.extensionUi.bind({
      generation: () => this.runtimeGenerationValue,
      emit: (type, data) => this.enqueueExtensionUiEvent(type, data),
      projectionChanged: () => this.syncExtensionUiProjection(),
    });
  }

  /** Route a canonical Agent query under the same read/lifecycle boundary as other Worker reads. */
  async readAgent(request: AgentRequest): Promise<unknown> {
    if (request.params.instanceId !== this.id || classifyControlRequest(request).effect !== "query") {
      throw new Error("Agent read requires a query for this instance");
    }
    return this.withProjectionRead(() => this.session.invoke(request));
  }

  private agentState() { return this.session.state(); }

  private invokeAgent<T>(type: AgentRequest["type"], params: Record<string, unknown>, options?: AgentInvokeOptions): Promise<T> {
    const requestId = typeof params.operationId === "string" ? params.operationId : randomUUID();
    const request = { kind: "request", version: 2, requestId, type, params: { instanceId: this.id, ...params } } as AgentRequest;
    return this.session.invoke(request, options) as Promise<T>;
  }

  snapshot(): InstanceSnapshot {
    const snapshot = this.committedSnapshotValue ?? this.workingSnapshot();
    validateInstanceStateInvariant({
      lifecycle: snapshot.lifecycle,
      execution: snapshot.execution,
      compacting: snapshot.compacting,
      ownerHostEpoch: snapshot.ownerHostEpoch,
      pendingCount: snapshot.pending.total,
      activeCommandId: snapshot.activeCommandId,
    });
    return cloneJson(snapshot);
  }

  catalogRecord(): CatalogInstanceRecord {
    const snapshot = this.workingSnapshot();
    const record: CatalogInstanceRecord = {
      id: snapshot.id,
      creationOperationId: snapshot.creationOperationId,
      ...(snapshot.key === undefined ? {} : { key: snapshot.key }),
      ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
      cwd: snapshot.cwd,
      lifecycle: snapshot.lifecycle,
      execution: snapshot.execution,
      lastRun: snapshot.lastRun,
      dockToolsEnabled: this.dockToolsEnabledValue,
      ...(this.workerConfigValue === undefined ? {} : { workerConfig: cloneJson(this.workerConfigValue) }),
      executionChangedAt: snapshot.executionChangedAt,
      ...(snapshot.runStartedAt === undefined ? {} : { runStartedAt: snapshot.runStartedAt }),
      runtimeGeneration: snapshot.runtimeGeneration,
      ...(snapshot.ownerHostEpoch === undefined ? {} : { ownerHostEpoch: snapshot.ownerHostEpoch }),
      piSessionId: snapshot.executor.piSessionId,
      ...(this.durableSessionFileValue === undefined ? {} : { sessionFile: this.durableSessionFileValue }),
      ...(snapshot.executor.model === undefined ? {} : { model: { provider: snapshot.executor.model.provider, id: snapshot.executor.model.id } }),
      ...(snapshot.executor.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.executor.thinkingLevel }),
      ...(snapshot.activeCommandId === undefined ? {} : { activeCommandId: snapshot.activeCommandId }),
      admissionPending: this.catalogAdmissionOperationId !== undefined,
      ...(this.catalogAdmissionOperationId === undefined ? {} : { admissionOperationId: this.catalogAdmissionOperationId }),
      pendingCount: snapshot.pending.total,
      ...(this.replacementIntent === undefined ? {} : { replacement: cloneJson(this.replacementIntent) }),
      ...(this.recoverySessionFile === undefined ? {} : { recoverySessionFile: this.recoverySessionFile }),
      ...(this.lastKnownValue === undefined ? {} : { lastKnown: cloneJson(this.lastKnownValue) }),
      ...(this.interruptionValue === undefined ? {} : { interruption: cloneJson(this.interruptionValue) }),
      ...(this.stopRequestedAt === undefined ? {} : { stopRequestedAt: this.stopRequestedAt }),
      ...(this.shutdownRequestedAt === undefined ? {} : { shutdownRequestedAt: this.shutdownRequestedAt }),
      ...(this.ownerReleaseUnconfirmed ? { ownerReleaseUnconfirmed: true as const } : {}),
      ...(snapshot.lastError === undefined ? {} : { lastError: snapshot.lastError }),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    validateInstanceStateInvariant(record);
    return record;
  }

  bindCatalogPort(port: InstanceCatalogMutationPort): void {
    if (this.catalogPort) throw new Error("Instance catalog port is already bound");
    this.catalogPort = port;
  }

  markCatalogCommitted(): void {
    this.committedSnapshotValue = this.workingSnapshot();
  }

  dockToolsEnabled(): boolean { return this.dockToolsEnabledValue; }

  registerDeliverable(path: string): Promise<DeliverableDto> {
    return this.enqueueTransition(async () => {
      this.assertActive();
      return this.deliverables.register(path);
    });
  }
  listDeliverables(): DeliverableDto[] { return this.deliverables.list(); }
  openDeliverable(deliveryRef: string): ReturnType<InstanceDeliverables["open"]> { return this.deliverables.open(deliveryRef); }

  async setDockToolsEnabled(enabled: boolean, operationId: string): Promise<void> {
    const lease = this.requireCommandStart(
      this.commandScheduler.admit({ class: "control", kind: "immediate" }),
      "changing Dock tools",
    );
    try {
      if (typeof enabled !== "boolean") throw new Error("Dock tools switch must be boolean");
      if (enabled === this.dockToolsEnabledValue) return;
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "instance.dock_tools_configure", effect: "pre_effect", operationId, instanceId: this.id },
        () => { this.assertCommandCurrent(lease); this.dockToolsEnabledValue = enabled; this.touch(); },
      ));
    } finally {
      lease.release();
    }
  }

  deliverObservation(notification: ObservationNotification): Promise<void> {
    return this.session.control({ type: "observation_delivery", notification }).then(() => undefined);
  }

  async disposeUnpublished(): Promise<void> {
    this.hostDrainActive = true;
    await this.transitionTail;
    await this.disposeRuntimeOnce();
  }

  shutdownForHostDrain(): Promise<void> {
    if (this.hostDrainPromise) return this.hostDrainPromise;
    this.hostDrainPromise = (async () => {
      if (!this.catalogPort) {
        await this.drainRuntimeWithoutCatalog();
        return;
      }
      const shutdownRequestedAt = this.timestamp();
      try {
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "host.shutdown.intent", effect: "pre_effect", instanceId: this.id },
          () => {
            this.shutdownRequestedAt = shutdownRequestedAt;
            this.touch(shutdownRequestedAt);
          },
        ));
      } catch (intentError) {
        const lastKnown = this.currentLastKnownState();
        const recoverySessionFile = this.replacementIntent?.previousSessionFile
          ?? this.recoverySessionFile
          ?? this.durableSessionFileValue;
        try {
          await this.drainRuntimeWithoutCatalog();
        } catch (disposalError) {
          // The shutdown intent did not become authoritative and owner release
          // also could not be proven. Commit a distinct post-effect quarantine
          // so a later Host can never mistake this record for an ordinary,
          // reopenable crash recovery.
          const timestamp = this.timestamp();
          this.catalogAdmissionOperationId = undefined;
          this.replacementIntent = undefined;
          this.recoverySessionFile = recoverySessionFile;
          this.lastKnownValue = lastKnown;
          this.interruptionValue = { reason: "replacement_failed", at: timestamp };
          this.stopRequestedAt = undefined;
          this.shutdownRequestedAt = undefined;
          this.ownerReleaseUnconfirmed = true;
          this.state.lifecycle = "runtime_error";
          this.state.execution = "unavailable";
          this.state.compacting = false;
          this.runtimeCompactingObserved = false;
          this.clearDeferredStartAttribution();
          if (lastKnown.lifecycle === "stopping" || lastKnown.execution === "running" || lastKnown.pendingCount > 0 || lastKnown.activeCommandId !== undefined) this.state.lastRun = "interrupted";
          this.state.activeCommandId = undefined;
          this.state.pendingSteering = 0;
          this.state.pendingFollowUp = 0;
          this.state.lastError = "Previous runtime owner release was not confirmed; this instance cannot be reopened";
          this.touch(timestamp);
          try {
            await this.catalogPort.commit(this.catalogRecord(), {
              kind: "host.shutdown.owner_unconfirmed",
              effect: "post_effect",
              instanceId: this.id,
            });
            this.committedSnapshotValue = this.workingSnapshot();
          } catch (quarantineError) {
            throw new AggregateError([intentError, disposalError, quarantineError], "Failed to persist unconfirmed Worker owner quarantine");
          }
          throw new AggregateError([intentError, disposalError], "Worker owner release was not confirmed and the instance was quarantined");
        }
        throw intentError;
      }

      this.hostDrainActive = true;
      await this.transitionTail;
      const lastKnown = this.currentLastKnownState();
      const busy = lastKnown.lifecycle === "stopping"
        || lastKnown.execution === "running"
        || lastKnown.activeCommandId !== undefined
        || this.catalogAdmissionOperationId !== undefined
        || lastKnown.pendingCount > 0
        || this.replacementIntent !== undefined;
      const recoverySessionFile = this.replacementIntent?.previousSessionFile
        ?? this.recoverySessionFile
        ?? this.durableSessionFileValue;
      await this.drainRuntimeWithoutCatalog();
      this.catalogAdmissionOperationId = undefined;
      this.replacementIntent = undefined;
      this.recoverySessionFile = recoverySessionFile;
      this.lastKnownValue = lastKnown;
      this.interruptionValue = { reason: "host_shutdown", at: this.timestamp() };
      this.stopRequestedAt = undefined;
      this.shutdownRequestedAt = undefined;
      this.state.lifecycle = "host_lost";
      this.state.execution = "unavailable";
      this.state.compacting = false;
      this.runtimeCompactingObserved = false;
      this.clearDeferredStartAttribution();
      if (busy) this.state.lastRun = "interrupted";
      this.state.activeCommandId = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      this.state.lastError = "Alu Dock Host shut down; explicitly reopen to continue this session context";
      this.touch();
      await this.catalogPort.commit(this.catalogRecord(), {
        kind: "host.shutdown.complete",
        effect: "post_effect",
        instanceId: this.id,
      });
      this.committedSnapshotValue = this.workingSnapshot();
    })();
    return this.hostDrainPromise;
  }

  disposeForHostDrain(): Promise<void> {
    if (this.hostDrainPromise) return this.hostDrainPromise;
    this.hostDrainPromise = this.drainRuntimeWithoutCatalog();
    return this.hostDrainPromise;
  }

  private async drainRuntimeWithoutCatalog(): Promise<void> {
    await this.extensionUi.suspendForHostDrain();
    this.hostDrainActive = true;
    await this.transitionTail;
    await this.extensionUi.cancelForHostDrain();
    // A failed reap must remain visible to the caller. Publishing host_lost or
    // stopped after this point could admit a second owner for the same session.
    await this.disposeRuntimeOnce();
  }

  private projectedDisplayName(): string {
    return projectInstanceDisplayName({
      name: this.name,
      key: this.key,
      cwd: this.cwd,
    });
  }

  private workingSnapshot(): InstanceSnapshot {
    return {
      id: this.id,
      creationOperationId: this.creationOperationId,
      key: this.key,
      name: this.name,
      displayName: this.projectedDisplayName(),
      cwd: this.cwd,
      gitBranch: this.gitBranchValue,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      compacting: this.state.compacting,
      lastRun: this.state.lastRun,
      reopenable: !this.ownerReleaseUnconfirmed
        && (this.state.lifecycle === "host_lost" || this.state.lifecycle === "runtime_error")
        && (this.recoverySessionFile !== undefined || this.durableSessionFileValue !== undefined),
      runtimeGeneration: this.runtimeGeneration,
      ownerHostEpoch: this.state.lifecycle === "active" || this.state.lifecycle === "stopping" ? this.hostEpoch : undefined,
      ...(this.interruptionValue === undefined ? {} : { interruption: cloneJson(this.interruptionValue) }),
      pending: {
        steering: this.state.pendingSteering,
        followUp: this.state.pendingFollowUp,
        total: this.state.pendingSteering + this.state.pendingFollowUp,
      },
      executor: {
        ...this.executorIdentity,
        model: this.executorIdentity.model ? { ...this.executorIdentity.model } : undefined,
      },
      metrics: cloneJson(this.metricsValue),
      ...this.extensionUi.projection(),
      activeCommandId: this.state.activeCommandId,
      lastError: this.state.lastError,
      createdAt: this.createdAt,
      updatedAt: this.state.updatedAt,
      executionChangedAt: this.executionChangedAtValue,
      ...(this.runStartedAtValue === undefined ? {} : { runStartedAt: this.runStartedAtValue }),
      eventCursor: this.journal.cursor(),
    };
  }

  eventsSince(since: EventCursor | number = 0): EventPage {
    return this.journal.eventsSince(since);
  }

  subscribe(listener: (event: DockEvent) => void): () => void {
    return this.journal.subscribe(listener);
  }

  reportControlDegradation(message: string): Promise<DockEvent> {
    return this.enqueueTransition(async () => cloneJson(this.appendEvent("extension.error", {
      error: safeWireText(message, 2_048),
    })));
  }

  claimInteractionController(): Promise<ControllerClaim> {
    this.assertActive();
    return this.extensionUi.claimController();
  }

  releaseInteractionController(leaseToken: string, reason: "detach" | "host_draining" = "detach"): Promise<void> {
    return this.extensionUi.releaseController(leaseToken, reason);
  }

  isInteractionControllerCurrent(leaseToken: string, runtimeGeneration: number): boolean {
    return this.extensionUi.isControllerLeaseCurrent(leaseToken, runtimeGeneration);
  }

  async respondInteraction(leaseToken: string, interactionId: string, response: InteractionResponse): Promise<InteractionResult> {
    const lease = this.requireCommandStart(
      this.commandScheduler.admit({ class: "control", kind: "immediate" }),
      "responding to an interaction",
    );
    try {
      return await this.extensionUi.respond(leaseToken, interactionId, response);
    } finally {
      lease.release();
    }
  }

  setToolsExpanded(expanded: boolean, expectedRuntimeGeneration: number): InstanceSnapshot {
    const lease = this.requireCommandStart(
      this.commandScheduler.admit({ class: "control", kind: "immediate" }),
      "changing tool expansion",
    );
    try {
      if (expectedRuntimeGeneration !== this.runtimeGenerationValue) {
        throw new StaleRuntimeGenerationError(expectedRuntimeGeneration, this.runtimeGenerationValue);
      }
      if (this.extensionUi.isSuspended()) throw new InstanceBusyError(this.id, "changing tool expansion during session replacement");
      this.extensionUi.setToolsExpanded(expanded);
      return this.snapshot();
    } finally {
      lease.release();
    }
  }

  setExtensionWidgetViewport(
    leaseToken: string,
    expectedRuntimeGeneration: number,
    viewport: { width: number; height: number },
  ): void {
    const lease = this.requireCommandStart(
      this.commandScheduler.admit({ class: "control", kind: "immediate" }),
      "rendering extension widgets",
    );
    try {
      if (expectedRuntimeGeneration !== this.runtimeGenerationValue) {
        throw new StaleRuntimeGenerationError(expectedRuntimeGeneration, this.runtimeGenerationValue);
      }
      if (this.extensionUi.isSuspended()) throw new InstanceBusyError(this.id, "rendering extension widgets during session replacement");
      this.extensionUi.setWidgetViewport(leaseToken, viewport);
    } finally {
      lease.release();
    }
  }

  async cancelInteractionsForHostDrain(): Promise<void> {
    await this.extensionUi.suspendForHostDrain();
    await this.extensionUi.cancelForHostDrain();
  }

  synchronizeModelState(): void {
    this.applyModelState(this.agentState().modelState);
  }

  async listModels(): Promise<AgentModelListBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentModelListBody>("model.list", {}));
  }

  async listSessions(scope: "cwd" | "all"): Promise<AgentSessionListBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentSessionListBody>("session.list", { scope }));
  }

  async getHistoryPage(beforeEntryId: string | undefined, limit: number): Promise<HistoryPageDto & { instance: InstanceSnapshot }> {
    return this.withCommittedProjectionRead(() => ({ ...this.journal.historyPage(beforeEntryId, limit), instance: this.snapshot() }));
  }

  async getConversationHistory(cursor?: string, limit = 50, view?: "references"): Promise<ConversationHistoryPageDto> {
    return this.withProjectionRead(async () => {
      this.assertActive();
      const generation = this.runtimeGenerationValue;
      const page = await this.invokeAgent<AgentConversationHistoryPage>("conversation.history", { ...(cursor === undefined ? {} : { cursor }), limit, ...(view === undefined ? {} : { view }) });
      if (generation !== this.runtimeGenerationValue) throw new StaleRuntimeGenerationError(generation, this.runtimeGenerationValue);
      return { instance: this.snapshot(), ...cloneJson(page) };
    });
  }

  async getConversationContent(contentRef: string, cursor?: string, view?: "references"): Promise<ConversationContentPageDto> {
    return this.withProjectionRead(async () => {
      this.assertActive();
      const generation = this.runtimeGenerationValue;
      const page = await this.invokeAgent<AgentConversationContentPage>("conversation.content", { contentRef, ...(cursor === undefined ? {} : { cursor }), ...(view === undefined ? {} : { view }) });
      if (generation !== this.runtimeGenerationValue) throw new StaleRuntimeGenerationError(generation, this.runtimeGenerationValue);
      return { instanceId: this.id, runtimeGeneration: generation, ...cloneJson(page) };
    });
  }

  async getConversationImage(contentRef: string): Promise<AgentConversationImageBody> {
    return this.withProjectionRead(async () => {
      this.assertActive();
      const generation = this.runtimeGenerationValue;
      const image = await this.invokeAgent<AgentConversationImageBody>("conversation.image", { contentRef });
      if (generation !== this.runtimeGenerationValue) throw new StaleRuntimeGenerationError(generation, this.runtimeGenerationValue);
      return cloneJson(image);
    });
  }

  /** Resolve under the short Worker query reservation; byte transfer is Host-owned. */
  async resolveRegisteredFile(kind: "published" | "resource", ref: string): Promise<{ source: AgentFileSource; runtimeGeneration: number }> {
    return this.withProjectionRead(async () => {
      this.assertActive();
      const runtimeGeneration = this.runtimeGenerationValue;
      const source = await this.session.control({ type: "resolve_file_source", kind, ref }) as AgentFileSource;
      if (runtimeGeneration !== this.runtimeGenerationValue) throw new StaleRuntimeGenerationError(runtimeGeneration, this.runtimeGenerationValue);
      if (source.kind !== kind) throw kind === "published" ? new PublishedFileUnavailableError() : new ResourceContentError();
      return { source, runtimeGeneration };
    });
  }

  async readPublishedFile(fileRef: string, offset?: number): Promise<PublishedFileReadPage & { instanceId: string; runtimeGeneration: number }> {
    return this.withProjectionRead(async () => {
      this.assertActive();
      const generation = this.runtimeGenerationValue;
      const source = await this.session.control({ type: "resolve_file_source", kind: "published", ref: fileRef }) as AgentFileSource;
      if (source.kind !== "published" || source.file.fileRef !== fileRef) throw new PublishedFileUnavailableError();
      const page = await readPublishedFilePage(source.file, source.source, offset);
      if (generation !== this.runtimeGenerationValue) throw new StaleRuntimeGenerationError(generation, this.runtimeGenerationValue);
      return { instanceId: this.id, runtimeGeneration: generation, ...cloneJson(page) };
    });
  }

  async readResourceContent(contentRef: string, offset?: number, revision?: string): Promise<ResourceContentResult> {
    return this.withProjectionRead(async () => {
      const source = await this.session.control({ type: "resolve_file_source", kind: "resource", ref: contentRef }) as AgentFileSource;
      if (source.kind !== "resource") throw new ResourceContentError();
      return readResourceContent(source.path, offset, revision);
    });
  }

  async getTree(): Promise<SessionTreeResult> {
    return this.withProjectionRead(async () => cloneJson(await this.invokeAgent<SessionTreeResult>("session.tree", {})));
  }

  async navigateSession(
    operationId: string,
    targetId: string,
    options: AgentNavigateOptions = {},
  ): Promise<AgentNavigateResult> {
    let configuration: InstanceCommandLease | undefined;
    let runtimeCalled = false;
    try {
      configuration = await this.beginConfiguration("navigating the session tree", { kind: "navigation" });
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const pending = this.invokeAgent<AgentNavigateResult>("session.navigate", { operationId, targetId, ...cloneJson(options) });
      configuration.markEffectStarted();
      const result = projectAgentNavigateResult(await pending);
      await this.closeRuntimeOperationBoundary(operationId);
      const { leafId, ...navigationResult } = result;
      if (!result.cancelled) await this.refreshHistory();
      if (result.cancelled) return navigationResult;
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "session.navigate", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
        () => {
          this.refreshMetrics();
          this.appendEvent("session.navigated", {
            targetId,
            ...(leafId === undefined ? {} : { leafId }),
            summaryCreated: result.summaryCreated,
          });
        },
      ));
      return navigationResult;
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (configuration) this.endConfiguration(configuration);
    }
  }

  async getAttachProjection(
    cursor: EventCursor | undefined,
    historyLimit = 200,
    replayPurpose: "legacy_history_overlay" | "event_log" | "conversation_bootstrap" = "legacy_history_overlay",
  ): Promise<AttachProjection> {
    return this.withCommittedProjectionRead(() => {
      const instance = this.snapshot();
      const epochChanged = cursor !== undefined && cursor.hostEpoch !== this.hostEpoch;
      const generationChanged = cursor !== undefined && cursor.runtimeGeneration !== instance.runtimeGeneration;
      const replaySince = epochChanged || generationChanged ? 0 : cursor?.sequence ?? 0;
      const sourcePage = this.eventsSince(replaySince);
      const history = this.journal.historyPage(undefined, historyLimit);
      const page = replayPurpose === "conversation_bootstrap"
        ? { ...sourcePage, events: this.journal.conversationBootstrapEvents(sourcePage.events, instance) }
        : sourcePage;
      return {
        instance,
        page,
        recentHistory: history.entries,
        historyRevision: history.historyRevision,
        historyTruncated: history.hasEarlier,
        pendingMessages: this.pendingMessagesProjection(),
        replaySince,
        epochChanged,
        generationChanged,
      };
    });
  }

  async listTools(): Promise<AgentToolProjection> {
    return this.withProjectionRead(() => this.invokeAgent<AgentToolProjection>("tool.list", {}));
  }

  async setActiveTools(names: string[], operationId = this.createCommandId()): Promise<AgentToolProjection> {
    const configuration = await this.beginConfiguration("changing active tools", { admission: "live" });
    try {
      const projected = await this.invokeAgent<AgentToolProjection>("tool.set_active", { operationId, names: [...names] });
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "tool.set_active", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
      ));
      return projected;
    } catch (error) {
      if (error instanceof AgentMutationEffectUnknownError) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      this.endConfiguration(configuration);
    }
  }

  async getSettings(): Promise<SettingDto[]> {
    return this.withProjectionRead(async () => cloneJson(await this.invokeAgent<SettingDto[]>("settings.get", {})));
  }

  async updateSetting(update: SettingUpdate, operationId = this.createCommandId()): Promise<SettingDto> {
    const configuration = await this.beginConfiguration(`changing ${update.key}`, { admission: settingAdmission(update.key) });
    try {
      const setting = cloneJson(await this.invokeAgent<SettingDto>("settings.update", { operationId, update: cloneJson(update) }));
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "settings.update", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
        () => this.appendSettingChanged(setting, false),
      ));
      return setting;
    } catch (error) {
      if (error instanceof AgentMutationEffectUnknownError) throw new RuntimeEffectUnknownError(operationId, error);
      if (error instanceof AgentSettingsWriteError) {
        if (error.mutationApplied && error.setting !== "model" && error.setting !== "thinking") {
          const current = await this.invokeAgent<SettingDto[]>("settings.get", {}).catch(() => undefined);
          const setting = current?.find((candidate) => candidate.key === error.setting);
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: "settings.update", effect: "post_effect", operationId, instanceId: this.id },
            () => this.touch(),
            () => {
              if (setting) this.appendSettingChanged(cloneJson(setting), false);
              this.appendSettingsWriteFailed(error);
            },
          ));
        } else {
          await this.enqueueTransition(async () => { this.appendSettingsWriteFailed(error); });
        }
      }
      throw error;
    } finally {
      this.endConfiguration(configuration);
    }
  }

  async getResources(): Promise<AgentResourceProjectionBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentResourceProjectionBody>("resource.get", {}));
  }

  async getCommands(prefix?: string): Promise<AgentCommandCatalogBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentCommandCatalogBody>("command.catalog", prefix === undefined ? {} : { prefix }));
  }

  async getCommandContent(command: CommandReferenceDto, cursor?: string): Promise<AgentCommandContentBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentCommandContentBody>("command.content", { command, ...(cursor === undefined ? {} : { cursor }) }));
  }

  async getCommandCompletions(command: CommandReferenceDto, argumentPrefix: string): Promise<AgentCommandCompletionsBody> {
    return this.withProjectionRead(() => this.invokeAgent<AgentCommandCompletionsBody>("command.complete", { command, argumentPrefix }));
  }

  async resolveSessionTarget(sessionFile: string): Promise<AgentSessionTarget> {
    return this.withProjectionRead(async () => {
      return cloneJson(await this.session.control({ type: "resolve_session_target", sessionFile }) as AgentSessionTarget);
    });
  }

  async newSession(operationId: string, parentSession?: string): Promise<AgentReplacementResult> {
    return this.replaceRuntime("creating a new session", operationId, "new", {}, async () => {
      return this.invokeAgent<AgentReplacementResult>("session.new", { operationId, ...(parentSession === undefined ? {} : { parentSession }) });
    });
  }

  async switchSession(
    operationId: string,
    sessionFile: string,
    trust: AgentProjectTrust,
  ): Promise<AgentReplacementResult> {
    return this.replaceRuntime("switching session", operationId, "switch", { requestedSessionFile: sessionFile }, async () => {
      return this.invokeAgent<AgentReplacementResult>("session.switch", { operationId, sessionFile }, {
        context: { type: "session_switch", canonicalCwd: trust.canonicalCwd, projectTrusted: trust.projectTrusted },
      });
    });
  }

  async forkSession(operationId: string, entryId: string): Promise<AgentForkResult> {
    return this.replaceRuntime("forking session", operationId, "fork", { requestedEntryId: entryId }, async () => (
      this.invokeAgent<AgentForkResult>("session.fork", { operationId, entryId })
    ));
  }

  async cloneSession(operationId: string, entryId: string): Promise<AgentReplacementResult> {
    return this.replaceRuntime("cloning session", operationId, "clone", { requestedEntryId: entryId }, async () => {
      const result = await this.invokeAgent<AgentForkResult>("session.clone", { operationId, entryId });
      return { cancelled: result.cancelled };
    });
  }

  async setSessionName(operationId: string, name: string): Promise<void> {
    const configuration = await this.beginConfiguration("naming the session", { admission: "live" });
    let runtimeCalled = false;
    try {
      this.sessionNameOperationId = operationId;
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const actualName = await this.invokeAgent<string | undefined>("session.name", { operationId, name });
      await this.closeRuntimeOperationBoundary(operationId);
      if (this.nameValue !== actualName) throw new Error("Runtime completed session naming without publishing session_info_changed");
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (this.sessionNameOperationId === operationId) this.sessionNameOperationId = undefined;
      this.endConfiguration(configuration);
    }
  }

  async compactSession(operationId: string, customInstructions?: string): Promise<SessionCompactionDto> {
    const configuration = await this.beginConfiguration("compacting the session", {
      admission: "run_preempting",
      kind: "compaction",
    });
    let runtimeCalled = false;
    try {
      this.compactionRequestOperationId = operationId;
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const response = this.invokeAgent<AgentCompactionResult>("session.compact", { operationId, ...(customInstructions === undefined ? {} : { customInstructions }) });
      // Compaction keeps the same runtime. After ordered startup, reads may
      // observe it while the exclusive effect lease still prevents replacement.
      configuration.releaseProjection();
      const result = await response;
      await this.closeRuntimeOperationBoundary(operationId);
      return result;
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (this.compactionRequestOperationId === operationId) this.compactionRequestOperationId = undefined;
      this.endConfiguration(configuration);
    }
  }

  async reloadSession(operationId: string): Promise<AgentReplacementResult> {
    const result = await this.replaceRuntime("reloading resources", operationId, "reload", {}, async () => {
      return this.invokeAgent<AgentReplacementResult>("session.reload", { operationId });
    });
    if (!result.cancelled) {
      const projected = await this.getResources();
      await this.enqueueTransition(async () => {
        this.appendEvent("resources.reloaded", { resources: projected.resources, diagnostics: projected.diagnostics });
        if (projected.resourcesTruncated || projected.diagnosticsTruncated) {
          this.appendEvent("extension.error", {
            error: `Resource projection is bounded: ${projected.resources.length}/${projected.resourceTotal} resources and ${projected.diagnostics.length}/${projected.diagnosticTotal} diagnostics`,
          });
        }
      });
    }
    return result;
  }

  async selectModel(provider: string, modelId: string, operationId = this.createCommandId()): Promise<AgentModelState> {
    const configuration = await this.beginConfiguration("switching model", { kind: "model-settings" });
    this.modelConfigurationActive = true;
    try {
      const state = await this.invokeAgent<AgentModelState>("model.set", { operationId, provider, modelId });
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "model.set", effect: "post_effect", operationId, instanceId: this.id },
        () => { this.applyModelState(state); this.touch(); },
        () => this.appendModelChanged(state),
      ));
      return state;
    } catch (error) {
      if (error instanceof AgentMutationEffectUnknownError) throw new RuntimeEffectUnknownError(operationId, error);
      if (error instanceof AgentSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.agentState().modelState;
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: "model.set", effect: "post_effect", operationId, instanceId: this.id },
            () => { this.applyModelState(state); this.touch(); },
            () => { this.appendModelChanged(state); this.appendSettingsWriteFailed(error); },
          ));
        } else {
          await this.enqueueTransition(async () => { this.appendSettingsWriteFailed(error); });
        }
      }
      throw error;
    } finally {
      this.finishModelConfiguration(configuration);
    }
  }

  async setThinkingLevel(level: ThinkingLevel, operationId = this.createCommandId()): Promise<AgentModelState> {
    const configuration = await this.beginConfiguration("changing thinking level", { kind: "model-settings" });
    this.modelConfigurationActive = true;
    try {
      const state = await this.invokeAgent<AgentModelState>("thinking.set", { operationId, level });
      let modelChanged = false;
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "thinking.set", effect: "post_effect", operationId, instanceId: this.id },
        () => { modelChanged = this.applyModelState(state); this.touch(); },
        () => { if (modelChanged) this.appendModelChanged(state); this.appendThinkingChanged(level, state); },
      ));
      return state;
    } catch (error) {
      if (error instanceof AgentMutationEffectUnknownError) throw new RuntimeEffectUnknownError(operationId, error);
      if (error instanceof AgentSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.agentState().modelState;
          let modelChanged = false;
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: "thinking.set", effect: "post_effect", operationId, instanceId: this.id },
            () => { modelChanged = this.applyModelState(state); this.touch(); },
            () => { if (modelChanged) this.appendModelChanged(state); this.appendThinkingChanged(level, state); this.appendSettingsWriteFailed(error); },
          ));
        } else {
          await this.enqueueTransition(async () => { this.appendSettingsWriteFailed(error); });
        }
      }
      throw error;
    } finally {
      this.finishModelConfiguration(configuration);
    }
  }

  async submit(
    message: string,
    delivery: DeliveryMode = "auto",
    operationId = this.createCommandId(),
    images?: readonly ImagePathDto[],
    attachments?: readonly AttachmentDto[],
  ): Promise<CommandReceipt> {
    const inputLease = this.requireCommandStart(
      this.commandScheduler.admit({ class: "input" }),
      "submitting input",
    );
    let inputImages: ImagePathDto[];
    let inputAttachments: AttachmentDto[];
    try {
      inputImages = cloneInputImages(images);
      inputAttachments = cloneInputAttachments(attachments);
      if (message.trim().length === 0 && inputImages.length === 0 && inputAttachments.length === 0) {
        throw new Error("Prompt message, image, or attachment must be provided");
      }
    } catch (error) {
      inputLease.release();
      throw error;
    }
    const inputGeneration = inputLease.generation;
    const deferToHost = this.runtimeCompactionInProgress()
      || this.manualCompactionAdmissionActive()
      || this.hostQueueCustodyActive();
    const queueAvailable = this.canQueueMessage(message, inputImages, inputAttachments);
    let actualDelivery: "prompt" | "steer" | "followUp" = "prompt";
    let actualInputKind: AgentInputKind = "prompt";
    let actualCustody: "host" | "runtime" = "runtime";
    let actuallyQueued = false;
    const commandId = operationId;
    const agentStartsBeforeCommand = this.agentStartCount;
    const agentSettlesBeforeCommand = this.agentSettledCount;
    const parentRunning = this.state.execution === "running" || this.agentState().isStreaming;

    this.catalogAdmissionOperationId = commandId;
    try {
      const admissionCommit = this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.admission", effect: "pre_effect", operationId: commandId, instanceId: this.id },
        () => {},
      ));
      if (this.catalogPort) await admissionCommit;
    } catch (error) {
      this.catalogAdmissionOperationId = undefined;
      inputLease.release();
      throw error;
    }

    let preflightStatus: "pending" | "accepted" | "rejected" = "pending";
    let receiptSettled = false;
    let resolveReceipt!: (receipt: CommandReceipt) => void;
    let rejectReceipt!: (error: unknown) => void;
    const receiptPromise = new Promise<CommandReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });

    const release = (): void => inputLease.release();

    let preflightTransition: Promise<void> | undefined;
    const rejectBeforeRun = async (error: unknown, reason: string): Promise<void> => {
      if (preflightStatus === "accepted" || (preflightStatus === "rejected" && receiptSettled)) return;
      preflightStatus = "rejected";
      const messageText = safeWireText(errorMessage(error), 2_048);
      try {
        const transition = this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.rejected", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => {
            this.catalogAdmissionOperationId = undefined;
            this.state.lastError = messageText;
            this.touch();
          },
          () => {
            this.appendEvent("command.rejected", { operationId: commandId, reason, error: messageText });
            this.appendStateEvent("command_rejected");
          },
        ));
        this.catalogAdmissionOperationId = undefined;
        const bufferedEvents = this.flushAdmissionAgentEvents();
        await Promise.all([transition, bufferedEvents]);
      } catch (commitError) {
        error = commitError;
      }
      if (!receiptSettled) {
        receiptSettled = true;
        rejectReceipt(error);
      }
      release();
    };

    const onPreflight = (result: AgentCommandPreflightResult): void => {
      if (preflightStatus !== "pending" || !inputLease.current(inputGeneration)) return;
      if (!result.success) {
        preflightStatus = "rejected";
        return;
      }
      if (!inputLease.effectAllowed(inputGeneration) || this.state.lifecycle !== "active") {
        const lifecycle = this.state.lifecycle === "active" ? "stopping" : this.state.lifecycle;
        preflightTransition = rejectBeforeRun(
          new InstanceNotActiveError(this.id, lifecycle),
          "instance_not_active_after_preflight",
        );
        return;
      }

      preflightStatus = "accepted";
      actualInputKind = result.inputKind;
      actualDelivery = result.delivery;
      actualCustody = result.custody;
      actuallyQueued = actualInputKind === "prompt" && actualDelivery !== "prompt";
      if (result.custody === "host") {
        preflightTransition = this.completeCompactionDeferredAdmission(
          message,
          result.delivery,
          commandId,
          inputImages,
          inputAttachments,
        ).then((receipt) => {
          if (!receiptSettled) {
            receiptSettled = true;
            resolveReceipt(receipt);
          }
        }, async (error: unknown) => {
          this.catalogAdmissionOperationId = undefined;
          await this.flushAdmissionAgentEvents().catch(() => {});
          if (!receiptSettled) {
            receiptSettled = true;
            rejectReceipt(error);
          }
        }).finally(release);
        return;
      }
      let precedingAgentEvents = Promise.resolve();
      if (!actuallyQueued) {
        // Events buffered while asynchronous input hooks were running belong
        // to the run that just settled. Commit them before assigning the fresh
        // prompt's operation ID so the old settlement cannot clear the new run.
        this.catalogAdmissionOperationId = undefined;
        precedingAgentEvents = this.flushAdmissionAgentEvents();
      }

      const acceptedAt = this.timestamp();
      const pendingMessage: PendingQueueMessage | undefined = actuallyQueued
        ? {
          queueItemId: randomUUID(),
          operationId: commandId,
          delivery: actualDelivery === "followUp" ? "followUp" : "steer",
          text: safeWireText(message, MAX_PENDING_QUEUE_TEXT_CHARS),
          ...(inputImages.length === 0 ? {} : { images: cloneInputImages(inputImages) }),
          ...(inputAttachments.length === 0 ? {} : { attachments: cloneInputAttachments(inputAttachments) }),
          acceptedAt,
          phase: "runtime_queued",
        }
        : undefined;
      if (pendingMessage) {
        this.pendingQueueMessages.push(pendingMessage);
        this.assignPendingRuntimeHashes(pendingMessage.delivery, pendingMessage.delivery === "steer" ? this.runtimeSteeringHashes : this.runtimeFollowUpHashes);
      } else if (actualInputKind === "prompt") this.acceptedPromptMessages.push({
        operationId: commandId,
        text: message,
        ...(inputImages.length === 0 ? {} : { images: cloneInputImages(inputImages) }),
        ...(inputAttachments.length === 0 ? {} : { attachments: cloneInputAttachments(inputAttachments) }),
      });
      const acceptedTransition = this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.accepted", effect: "post_effect", operationId: commandId, instanceId: this.id },
        () => {
          this.catalogAdmissionOperationId = undefined;
          this.state.lastError = undefined;
          if (actualInputKind === "prompt" && !actuallyQueued) {
            this.state.execution = "running";
            this.state.activeCommandId = commandId;
          }
          this.touch(acceptedAt);
        },
        () => {
          this.appendEvent("command.accepted", {
            operationId: commandId,
            delivery: actualDelivery,
            queued: actuallyQueued,
            acceptedAt,
          }, acceptedAt);
          if (pendingMessage) this.appendEvent("message.queued", pendingMessageProjection([pendingMessage])[0]!, acceptedAt);
          this.appendStateEvent(actualInputKind === "extension_command" ? "extension_command_accepted" : "command_accepted", acceptedAt);
        },
      ));
      preflightTransition = Promise.all([precedingAgentEvents, acceptedTransition]).then(() => {});
      this.catalogAdmissionOperationId = undefined;
      this.receiptBoundaryOperationId = commandId;
      const bufferedEvents = this.flushAdmissionAgentEvents();
      preflightTransition = Promise.all([preflightTransition, bufferedEvents]).then(async () => {
        // Pi may emit queue/agent_start synchronously immediately after the
        // callback returns. Include those ordered transitions in the receipt boundary.
        await Promise.resolve();
        const followupTasks = this.receiptBoundaryTasks.splice(0);
        this.receiptBoundaryOperationId = undefined;
        try { await Promise.all(followupTasks); }
        catch (error) {
          if (!receiptSettled) {
            receiptSettled = true;
            rejectReceipt(error);
          }
          release();
          return;
        }
        if (!receiptSettled) {
          receiptSettled = true;
          resolveReceipt({
            accepted: true,
            instanceId: this.id,
            operationId: commandId,
            kind: actualInputKind,
            delivery: actualDelivery,
            queued: actuallyQueued,
            acceptedAt,
          });
        }
        release();
      }, (error: unknown) => {
        this.receiptBoundaryOperationId = undefined;
        this.receiptBoundaryTasks.length = 0;
        if (!receiptSettled) {
          receiptSettled = true;
          rejectReceipt(error);
        }
        release();
      });
    };

    const shouldDeferToHost = deferToHost
      || this.runtimeCompactionInProgress()
      || this.hostQueueCustodyActive();
    let runtimePromise: Promise<void>;
    try {
      runtimePromise = this.invokeAgent<void>("command.submit", {
        operationId: commandId,
        message,
        ...(inputImages.length === 0 ? {} : { images: cloneInputImages(inputImages) }),
        ...(inputAttachments.length === 0 ? {} : { attachments: inputAttachments.map((attachment) => attachment.fileId) }),
        delivery,
      }, {
        context: {
          type: shouldDeferToHost ? "defer_to_host" : "command",
          queueAvailable,
          ...(inputAttachments.length === 0 ? {} : { attachments: cloneInputAttachments(inputAttachments) }),
        },
        preflightResult: onPreflight,
      });
    } catch (error) {
      await rejectBeforeRun(error, "prompt_threw_before_preflight");
      return receiptPromise;
    }

    const observedPromise = runtimePromise.then(async () => {
      if (preflightStatus === "pending") throw new Error("Worker resolved message submission without reporting actual delivery");
      await preflightTransition;
      if (actualCustody === "host") return;
      if (preflightStatus === "accepted" && actualInputKind === "extension_command") {
        await Promise.resolve();
        await this.transitionTail;
        if (this.runtimeGenerationValue !== inputGeneration || this.state.lifecycle !== "active") return;
        const commandStartedRun = this.agentStartCount > agentStartsBeforeCommand
          || (!parentRunning && this.agentState().isStreaming);
        if (commandStartedRun) return;
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.handled", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => { this.touch(); },
          () => {
            this.appendEvent("command.handled", { operationId: commandId, kind: "extension_command" });
            this.appendStateEvent("extension_command_handled");
          },
        ));
        return;
      }
      if (
        preflightStatus === "accepted"
        && !actuallyQueued
        && this.state.lifecycle === "active"
        && this.state.execution === "running"
        && this.agentStartCount === agentStartsBeforeCommand
        && !this.agentState().isStreaming
        && !this.runtimeCompactionInProgress()
        && !this.state.compacting
      ) {
        let handledWithoutRun = false;
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.no_run", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => {
            // Re-check inside the serialized transition: compaction_start may
            // have arrived after the Promise predicate above.
            if (this.runtimeCompactionInProgress() || this.state.compacting) return;
            handledWithoutRun = true;
            this.state.execution = "idle";
            this.state.activeCommandId = undefined;
            this.touch();
          },
          () => {
            if (!handledWithoutRun) return;
            this.discardAcceptedPrompt(commandId);
            this.appendEvent("command.handled", { operationId: commandId, kind: "no_run" });
            this.appendStateEvent("command_handled_without_run");
          },
        ));
      }
    }).catch(async (error: unknown) => {
      const messageText = safeWireText(errorMessage(error), 2_048);
      if (preflightStatus !== "accepted") {
        if (error instanceof AgentInvalidDeliveryModeError) {
          error = new InvalidDeliveryModeError(error.mode, error.running);
        } else if (error instanceof AgentQueueRejectedBeforeEffectError) {
          error = new QueueCapacityError();
        }
        if (error instanceof AgentMutationEffectUnknownError) {
          this.catalogAdmissionOperationId = undefined;
          await this.flushAdmissionAgentEvents().catch(() => {});
          if (!receiptSettled) { receiptSettled = true; rejectReceipt(new RuntimeEffectUnknownError(commandId, error)); }
          release();
          return;
        }
        await rejectBeforeRun(error, "preflight_failed");
        return;
      }
      await preflightTransition?.catch(() => {});
      if (this.catalogPort) {
        try { this.catalogPort.assertWritable(); } catch { return; }
      }
      await this.enqueueTransition(async () => {
        this.discardAcceptedPrompt(commandId);
        this.appendEvent("instance.error", { operationId: commandId, source: "command_background", error: messageText });
      });
      // Pi emits agent_settled from _runAgentPrompt.finally before the
      // prompt Promise rejects. Only project a fallback failure if that public
      // lifecycle guarantee was not observed at all.
      if (
        actualInputKind === "prompt"
        && this.state.lifecycle === "active"
        && this.agentStartCount > agentStartsBeforeCommand
        && this.agentSettledCount === agentSettlesBeforeCommand
      ) {
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.background_failure", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => {
            this.state.execution = "failed";
            this.state.lastRun = "failed";
            this.state.activeCommandId = undefined;
            this.state.lastError = messageText;
            this.touch();
          },
          () => {
            this.appendEvent("run.settled", { operationId: commandId, result: "failed", error: messageText });
            this.appendStateEvent("prompt_rejected_without_agent_settled");
          },
        ));
      }
      release();
    });

    let trackedPromise!: Promise<void>;
    trackedPromise = observedPromise.finally(() => {
      release();
      this.backgroundTasks.delete(trackedPromise);
    });
    this.backgroundTasks.add(trackedPromise);

    return receiptPromise;
  }

  private runtimeCompactionInProgress(): boolean {
    return this.runtimeCompactingObserved ?? this.agentState().isCompacting;
  }

  private manualCompactionAdmissionActive(): boolean {
    return this.commandScheduler.activeCommand("exclusive", "compaction") !== undefined;
  }

  private hostQueueCustodyActive(): boolean {
    return (this.compactionQueueDrainTask !== undefined && this.compactionQueueDrainGeneration === this.runtimeGenerationValue)
      || this.pendingQueueMessages.some((item) => (
      item.phase === "host_deferred"
      || item.phase === "dispatching"
      || item.phase === "fresh_in_flight"
      || item.phase === "effect_unknown"
    ));
  }

  private trackedQueueMessages(): PendingQueueMessage[] {
    return [...this.inFlightQueueMessages, ...this.pendingQueueMessages];
  }

  private clearDeferredStartAttribution(): void {
    const boundary = this.nextAgentStartBoundary;
    this.nextAgentStartBoundary = undefined;
    boundary?.resolve();
  }

  private async completeCompactionDeferredAdmission(
    message: string,
    resolvedDelivery: "steer" | "followUp",
    operationId: string,
    images: readonly ImagePathDto[],
    attachments: readonly AttachmentDto[],
  ): Promise<CommandReceipt> {
    const acceptedAt = this.timestamp();
    const pendingMessage: PendingQueueMessage = {
      queueItemId: randomUUID(),
      operationId,
      delivery: resolvedDelivery,
      text: safeWireText(message, MAX_PENDING_QUEUE_TEXT_CHARS),
      ...(images.length === 0 ? {} : { images: cloneInputImages(images) }),
      ...(attachments.length === 0 ? {} : { attachments: cloneInputAttachments(attachments) }),
      acceptedAt,
      phase: "host_deferred",
      originalText: message,
    };
    await this.enqueueTransition(() => this.commitCatalogTransition(
      { kind: "command.accepted", effect: "pre_effect", operationId, instanceId: this.id },
      () => {
        this.assertActive();
        this.catalogAdmissionOperationId = undefined;
        this.state.lastError = undefined;
        if (pendingMessage.delivery === "steer") this.state.pendingSteering += 1;
        else this.state.pendingFollowUp += 1;
        // The public start event can be queued behind this admission. Keep the
        // snapshot valid as soon as synchronous Pi truth says compacting.
        if (this.runtimeCompactionInProgress()) {
          this.startCompactionBoundary();
          this.state.execution = "running";
          this.state.compacting = true;
        }
        this.touch(acceptedAt);
      },
      () => {
        this.pendingQueueMessages.push(pendingMessage);
        this.appendEvent("command.accepted", {
          operationId,
          delivery: resolvedDelivery,
          queued: true,
          acceptedAt,
        }, acceptedAt);
        this.appendEvent("message.queued", pendingMessageProjection([pendingMessage])[0]!, acceptedAt);
        this.appendStateEvent("command_deferred_for_compaction", acceptedAt);
      },
    ));
    this.catalogAdmissionOperationId = undefined;
    await this.flushAdmissionAgentEvents();
    if (!this.runtimeCompactionInProgress() && !this.manualCompactionAdmissionActive()) {
      this.scheduleCompactionQueueDrain(false);
    }
    return {
      accepted: true,
      instanceId: this.id,
      operationId,
      kind: "prompt",
      delivery: resolvedDelivery,
      queued: true,
      acceptedAt,
    };
  }

  private scheduleCompactionQueueDrain(willRetry: boolean): void {
    if (
      (this.compactionQueueDrainTask && this.compactionQueueDrainGeneration === this.runtimeGenerationValue)
      || this.runtimeCompactionInProgress()
      || this.manualCompactionAdmissionActive()
      || this.commandScheduler.activeCommand("control", "queue") !== undefined
      || this.commandScheduler.activeCommand("terminal") !== undefined
    ) return;
    const firstCustodyItem = this.pendingQueueMessages.find((item) => (
      item.phase === "host_deferred"
      || item.phase === "dispatching"
      || item.phase === "fresh_in_flight"
      || item.phase === "effect_unknown"
    ));
    if (firstCustodyItem?.phase !== "host_deferred") return;
    const generation = this.runtimeGenerationValue;
    let rearmAfterDrain = false;
    let tracked!: Promise<void>;
    tracked = this.drainCompactionQueue(generation, willRetry)
      .then((mayRearm) => { rearmAfterDrain = mayRearm; })
      .catch(async (error: unknown) => {
        if (this.hostDrainActive || this.runtimeGenerationValue !== generation || this.state.lifecycle !== "active") return;
        const text = safeWireText(errorMessage(error), 2_048);
        await this.enqueueTransition(async () => {
          if (this.hostDrainActive || this.runtimeGenerationValue !== generation || this.state.lifecycle !== "active") return;
          this.appendEvent("instance.error", { source: "command_background", error: text });
        }).catch(() => {});
      })
      .finally(() => {
        if (this.compactionQueueDrainTask === tracked) {
          this.compactionQueueDrainTask = undefined;
          this.compactionQueueDrainGeneration = undefined;
        }
        this.backgroundTasks.delete(tracked);
        // An admission can land exactly as a successful drainer observes an
        // empty tail. Failures/ambiguity deliberately do not re-arm, and an
        // old generation can never schedule work for its replacement.
        if (
          rearmAfterDrain
          && this.runtimeGenerationValue === generation
          && !this.runtimeCompactionInProgress()
        ) this.scheduleCompactionQueueDrain(willRetry);
      });
    this.compactionQueueDrainTask = tracked;
    this.compactionQueueDrainGeneration = generation;
    this.backgroundTasks.add(tracked);
  }

  private async drainCompactionQueue(generation: number, willRetry: boolean): Promise<boolean> {
    while (
      !this.hostDrainActive
      && this.state.lifecycle === "active"
      && this.runtimeGenerationValue === generation
      && !this.runtimeCompactionInProgress()
      && this.commandScheduler.activeCommand("control", "queue") === undefined
      && this.commandScheduler.activeCommand("terminal") === undefined
    ) {
      const modelSettings = this.commandScheduler.activeCommand("model-settings");
      if (modelSettings) {
        await modelSettings.completion;
        continue;
      }
      const firstCustodyItem = this.pendingQueueMessages.find((candidate) => (
        candidate.phase === "host_deferred"
        || candidate.phase === "dispatching"
        || candidate.phase === "fresh_in_flight"
        || candidate.phase === "effect_unknown"
      ));
      if (!firstCustodyItem) return true;
      if (firstCustodyItem.phase !== "host_deferred") return false;
      const accepted = await this.dispatchCompactionQueueItem(firstCustodyItem, generation, willRetry);
      // Definite preflight failure leaves the original item restorable; an
      // accepted-but-ambiguous failure stays in flight. Neither may be retried
      // or allow later FIFO items to pass automatically.
      if (!accepted) return false;
    }
    return false;
  }

  private async dispatchCompactionQueueItem(
    item: PendingQueueMessage,
    generation: number,
    forceRuntimeQueue: boolean,
  ): Promise<boolean> {
    if (item.phase !== "host_deferred") return true;
    item.phase = "dispatching";
    if (forceRuntimeQueue) {
      try {
        await this.invokeAgent<void>("command.submit", {
          operationId: item.operationId,
          message: item.originalText ?? item.text,
          ...(item.images === undefined ? {} : { images: cloneInputImages(item.images) }),
          ...(item.attachments === undefined ? {} : { attachments: item.attachments.map((attachment) => attachment.fileId) }),
          delivery: item.delivery,
        }, { context: { type: "force_queue", ...(item.attachments === undefined ? {} : { attachments: cloneInputAttachments(item.attachments) }) } });
        item.phase = "runtime_queued";
        await this.transitionTail;
        return true;
      } catch (error) {
        if (error instanceof AgentQueueRejectedBeforeEffectError) {
          item.phase = "host_deferred";
        } else {
          // Generic adapter errors are conservative: absence of a projected
          // queue_update is never proof that Pi lacks custody.
          item.phase = "effect_unknown";
        }
        await this.transitionTail;
        await this.reportDeferredDispatchFailure(item, error, generation);
        return false;
      }
    }
    const agentStartsBefore = this.agentStartCount;
    let preflightStatus: "pending" | "accepted" | "rejected" = "pending";
    let freshDispatch = false;
    let dispatchMayContinue = true;
    let resolvePreflight!: (accepted: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => { resolvePreflight = resolve; });
    let resolveFreshStart!: () => void;
    const freshStart = new Promise<void>((resolve) => { resolveFreshStart = resolve; });

    const onPreflight = (result: AgentCommandPreflightResult): void => {
      if (preflightStatus !== "pending") return;
      if (!result.success || this.hostDrainActive || this.runtimeGenerationValue !== generation || this.state.lifecycle !== "active") {
        preflightStatus = "rejected";
        if (item.phase === "dispatching") item.phase = "host_deferred";
        resolvePreflight(false);
        return;
      }
      preflightStatus = "accepted";
      if (result.delivery !== "prompt") {
        item.delivery = result.delivery;
        item.phase = "runtime_queued";
      } else {
        // Pi starts this first post-compaction item as a fresh prompt.
        freshDispatch = true;
        item.phase = "fresh_in_flight";
        this.nextAgentStartBoundary = { operationId: item.operationId, resolve: resolveFreshStart };
      }
      resolvePreflight(true);
    };

    let runtimePromise: Promise<void>;
    try {
      runtimePromise = this.invokeAgent<void>("command.submit", {
        operationId: item.operationId,
        message: item.originalText ?? item.text,
        ...(item.images === undefined ? {} : { images: cloneInputImages(item.images) }),
        ...(item.attachments === undefined ? {} : { attachments: item.attachments.map((attachment) => attachment.fileId) }),
        delivery: item.delivery,
      }, {
        context: { type: "host_queue", ...(item.attachments === undefined ? {} : { attachments: cloneInputAttachments(item.attachments) }) },
        preflightResult: onPreflight,
      });
    } catch (error) {
      onPreflight({ success: false });
      await this.reportDeferredDispatchFailure(item, error, generation);
      return false;
    }

    const observed = runtimePromise.then(async () => {
      if (preflightStatus === "pending") throw new Error("Worker resolved deferred submission without reporting actual delivery");
      await this.transitionTail;
      if (
        item.phase === "fresh_in_flight"
        && this.runtimeGenerationValue === generation
        && this.agentStartCount === agentStartsBefore
        && !this.agentState().isStreaming
      ) {
        if (this.nextAgentStartBoundary?.operationId === item.operationId) {
          this.nextAgentStartBoundary = undefined;
          resolveFreshStart();
        }
        // An input hook handled the text without a run. It is no longer a
        // resendable queue item, but must leave the tray explicitly.
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.no_run", effect: "post_effect", operationId: item.operationId, instanceId: this.id },
          () => {
            const index = this.pendingQueueMessages.indexOf(item);
            if (index >= 0) this.pendingQueueMessages.splice(index, 1);
            if (item.delivery === "steer") this.state.pendingSteering = Math.max(0, this.state.pendingSteering - 1);
            else this.state.pendingFollowUp = Math.max(0, this.state.pendingFollowUp - 1);
            this.touch();
          },
          () => {
            this.appendEvent("queue.cleared", {
              steering: item.delivery === "steer" ? 1 : 0,
              followUp: item.delivery === "followUp" ? 1 : 0,
              total: 1,
              queueItemIds: [item.queueItemId],
              reason: "dequeued",
            });
            this.appendEvent("command.handled", { operationId: item.operationId, kind: "no_run" });
            this.appendStateEvent("deferred_command_handled_without_run");
          },
        ));
      }
    }).catch(async (error: unknown) => {
      if (preflightStatus === "pending") {
        onPreflight({ success: false });
        await this.reportDeferredDispatchFailure(item, error, generation);
        return;
      }
      // Once Pi accepted preflight, an effect may already exist. Keep identity
      // in-flight and never retry automatically or advance later FIFO items
      // past an ambiguous dispatch.
      dispatchMayContinue = false;
      if (this.nextAgentStartBoundary?.operationId === item.operationId) {
        this.nextAgentStartBoundary = undefined;
        resolveFreshStart();
      }
      await this.reportDeferredDispatchFailure(item, error, generation);
    });
    let tracked!: Promise<void>;
    tracked = observed.finally(() => this.backgroundTasks.delete(tracked));
    this.backgroundTasks.add(tracked);

    const accepted = await preflight;
    if (accepted && freshDispatch) await freshStart;
    else if (accepted) await runtimePromise.catch(() => {});
    // Let the observed rejection handler publish its conservative outcome
    // before deciding whether a later FIFO item may advance.
    await Promise.resolve();
    return accepted && dispatchMayContinue;
  }

  private async reportDeferredDispatchFailure(
    item: PendingQueueMessage,
    error: unknown,
    generation: number,
  ): Promise<void> {
    if (this.hostDrainActive || this.runtimeGenerationValue !== generation || this.state.lifecycle !== "active") return;
    const text = safeWireText(errorMessage(error), 2_048);
    await this.enqueueTransition(async () => {
      // Replacement can commit while an old Pi Promise is settling. The old
      // generation may resolve local waiters, but it cannot publish into the
      // new generation's event stream or operation attribution.
      if (this.hostDrainActive || this.runtimeGenerationValue !== generation || this.state.lifecycle !== "active") return;
      this.appendEvent("instance.error", {
        operationId: item.operationId,
        source: "command_background",
        error: text,
      });
    }).catch(() => {});
  }

  async dequeue(operationId = this.createCommandId()): Promise<QueueDequeueReceipt> {
    this.catalogPort?.assertWritable();
    const lease = this.requireCommandStart(this.commandScheduler.admit({
      class: "control",
      kind: "queue",
    }), "restoring queued messages");
    try {
      await this.transitionTail;
      this.assertCommandCurrent(lease);
      this.catalogPort?.assertWritable();
      this.assertActive();
      const pendingBefore = [...this.pendingQueueMessages];
      if (pendingBefore.length === 0 && this.state.pendingSteering === 0 && this.state.pendingFollowUp === 0) {
        return { operationId, instanceId: this.id, restored: [], inFlight: [] };
      }

      this.receiptBoundaryOperationId = operationId;
      try {
        const cleared = await this.invokeAgent<ClearedAgentQueue>("queue.dequeue", { operationId });
        await this.closeRuntimeOperationBoundary(operationId);
        const hostDeferred = pendingBefore.filter((item) => item.phase === "host_deferred");
        const selection = selectClearedQueueMessages(
          pendingBefore.filter((item) => item.phase !== "host_deferred"),
          cleared,
          this.timestamp(),
        );
        const restoredIds = new Set([
          ...hostDeferred.map((item) => item.queueItemId),
          ...selection.restoredQueueItemIds,
        ]);
        const retainedIds = new Set(pendingBefore.filter((item) => !restoredIds.has(item.queueItemId)).map((item) => item.queueItemId));
        const restored = orderPendingMessages([
          ...pendingMessageProjection(hostDeferred),
          ...selection.restored,
        ]);
        let inFlight: PendingMessageDto[] = [];
        let removedFromQueue: PendingMessageDto[] = [];
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "queue.dequeue", effect: "post_effect", operationId, instanceId: this.id },
          () => {
            const retained = this.pendingQueueMessages.filter((item) => retainedIds.has(item.queueItemId));
            const restoredStillPending = this.pendingQueueMessages.filter((item) => restoredIds.has(item.queueItemId));
            for (const item of retained) {
              if (!this.inFlightQueueMessages.some((candidate) => candidate.queueItemId === item.queueItemId)) {
                this.inFlightQueueMessages.push(item);
              }
            }
            inFlight = pendingMessageProjection(retained);
            removedFromQueue = orderPendingMessages([
              ...pendingMessageProjection(restoredStillPending),
              ...inFlight,
              ...restored.filter((item) => !restoredStillPending.some((candidate) => candidate.queueItemId === item.queueItemId)),
            ]);
            const removedIds = new Set(pendingBefore.map((item) => item.queueItemId));
            const remaining = this.pendingQueueMessages.filter((item) => !removedIds.has(item.queueItemId));
            this.pendingQueueMessages.splice(0, this.pendingQueueMessages.length, ...remaining);
            this.runtimeSteeringHashes = [];
            this.runtimeFollowUpHashes = [];
            this.state.pendingSteering = 0;
            this.state.pendingFollowUp = 0;
            this.touch();
          },
          () => this.appendEvent("queue.cleared", {
            steering: removedFromQueue.filter((item) => item.delivery === "steer").length,
            followUp: removedFromQueue.filter((item) => item.delivery === "followUp").length,
            total: removedFromQueue.length,
            queueItemIds: removedFromQueue.map((item) => item.queueItemId),
            reason: "dequeued",
          }),
        ));
        return { operationId, instanceId: this.id, restored, inFlight };
      } catch (error) {
        try { await this.closeRuntimeOperationBoundary(operationId); }
        catch (transitionError) { throw transitionError; }
        if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError || error instanceof AgentUnavailableBeforeEffectError) throw error;
        throw new RuntimeEffectUnknownError(operationId, error);
      } finally {
        if (this.receiptBoundaryOperationId === operationId) this.receiptBoundaryOperationId = undefined;
      }
    } finally {
      lease.release();
    }
  }

  async abort(operationId = this.createCommandId()): Promise<void> {
    this.catalogPort?.assertWritable();
    const decision = this.commandScheduler.admit({ class: "interrupt" });
    if (decision.kind === "reject") this.requireCommandStart(decision, "aborting the current run");
    if (decision.kind === "reject") return;
    if (decision.kind === "join") throw new InstanceNotActiveError(this.id, "stopping");
    const lease = decision.lease;
    try {
      if (decision.kind === "wait") await decision.forCompletion;
      await this.transitionTail;
      this.assertCommandCurrent(lease);
      this.catalogPort?.assertWritable();
      this.assertActive();

      if (decision.kind === "preempt") {
        try {
          const effectStarted = await decision.preempted.effectStarted;
          if (effectStarted) await this.invokeAgent<void>("command.abort", { operationId });
          await decision.preempted.completion;
          await this.transitionTail;
          return;
        } catch (error) {
          if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError || error instanceof AgentUnavailableBeforeEffectError) throw error;
          throw new RuntimeEffectUnknownError(operationId, error);
        }
      }

      if (this.state.execution !== "running" && !this.agentState().isStreaming) return;
      this.receiptBoundaryOperationId = operationId;
      try {
        await this.invokeAgent<void>("command.abort", { operationId });
        await this.session.control({ type: "wait_for_idle" });
        const compactionBoundary = this.compactionBoundary;
        if (compactionBoundary) await compactionBoundary;
        await this.closeRuntimeOperationBoundary(operationId);
        if (this.state.execution === "running" && !this.agentState().isStreaming) {
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: "command.abort.completed", effect: "post_effect", operationId, instanceId: this.id },
            () => {
              this.state.execution = "idle";
              this.state.lastRun = "aborted";
              this.state.activeCommandId = undefined;
              this.state.lastError = undefined;
              this.touch();
            },
            () => {
              this.appendEvent("run.settled", { operationId, result: "aborted", stopReason: "aborted" });
              this.appendStateEvent("abort_completed_without_agent_settled");
            },
          ));
        }
      } catch (error) {
        try { await this.closeRuntimeOperationBoundary(operationId); }
        catch (transitionError) { throw transitionError; }
        if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError || error instanceof AgentUnavailableBeforeEffectError) throw error;
        throw new RuntimeEffectUnknownError(operationId, error);
      } finally {
        if (this.receiptBoundaryOperationId === operationId) this.receiptBoundaryOperationId = undefined;
      }
    } finally {
      lease.release();
    }
  }

  async waitForIdle(): Promise<void> {
    await this.session.control({ type: "wait_for_idle" });
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    await this.transitionTail;
  }

  async stop(operationId = this.createCommandId()): Promise<StopReceipt> {
    this.catalogPort?.assertWritable();
    if (this.state.lifecycle === "stopped") {
      return { operationId, instanceId: this.id, stopped: true, alreadyStopped: true };
    }
    const decision = this.commandScheduler.admit({ class: "terminal" });
    if (decision.kind === "join") {
      const completion = this.stopCompletion;
      if (!completion) throw new Error("Terminal command has no Stop completion");
      const first = await completion;
      return {
        operationId,
        instanceId: this.id,
        stopped: true,
        alreadyStopped: true,
        ...(first.cleanupErrors === undefined ? {} : { cleanupErrors: [...first.cleanupErrors] }),
      };
    }
    const terminal = this.requireCommandStart(decision, "stopping this work");
    const task = this.beginStop(operationId).catch((error: unknown) => {
      if (this.state.lifecycle === "active") {
        terminal.release();
        this.stopCompletion = undefined;
      }
      throw error;
    });
    this.stopCompletion = task;
    return task;
  }

  private async beginStop(operationId: string): Promise<StopReceipt> {
    const requestedAt = this.timestamp();
    await this.enqueueTransition(() => this.commitCatalogTransition(
      { kind: "instance.stop.intent", effect: "pre_effect", operationId, instanceId: this.id },
      () => {
        this.stopRequestedWhileRunning = this.state.execution === "running" || this.agentState().isStreaming;
        this.stopRequestedAt = requestedAt;
        this.deliverables.clear();
        // A committed explicit stop retires this instance from its business
        // entry immediately. Cleanup continues by instance ID and must not
        // block a fresh keyed instance in a corrected or moved workspace.
        this.keyValue = undefined;
        this.state.lifecycle = "stopping";
        // Direct cleanup of an already unavailable runtime still traverses
        // the live `stopping` lifecycle; keep that intermediate projection
        // closed instead of pairing stopping with unavailable.
        if (this.state.execution === "unavailable") this.state.execution = "failed";
        this.touch(requestedAt);
      },
      () => this.appendStateEvent("stop_requested", requestedAt),
    ));
    const exclusive = this.commandScheduler.activeCommand("exclusive");
    const preemptibleEffect = exclusive?.kind === "navigation" || exclusive?.kind === "compaction"
      ? exclusive.effectStarted
      : undefined;
    const inputAdmission = this.commandScheduler.activeCommand("input")?.completion;
    return this.performStop(operationId, this.commandScheduler.nonTerminalCompletions(), preemptibleEffect, inputAdmission);
  }

  recordExtensionError(error: unknown): void {
    if (this.hostDrainActive) return;
    this.appendEvent("extension.error", { error: safeWireText(errorMessage(error), 2_048) });
  }

  private enqueueExtensionUiEvent<T extends ExtensionUiEventType>(type: T, data: EventDataMap[T]): Promise<void> {
    if (this.hostDrainActive) return Promise.resolve();
    return this.enqueueTransition(async () => {
      if (this.hostDrainActive) return;
      this.syncExtensionUiProjection();
      this.appendEvent(type, cloneJson(data));
    });
  }

  private syncExtensionUiProjection(): void {
    if (!this.committedSnapshotValue || this.extensionUi.isSuspended()) return;
    const projection = this.extensionUi.projection();
    this.committedSnapshotValue = {
      ...this.committedSnapshotValue,
      extensionStatus: cloneJson(projection.extensionStatus),
      toolsExpanded: projection.toolsExpanded,
      ...(projection.activeInteraction === undefined
        ? { activeInteraction: undefined }
        : { activeInteraction: cloneJson(projection.activeInteraction) }),
    };
  }

  private async performStop(
    operationId: string,
    activeCommands: readonly Promise<void>[],
    preemptibleEffect?: Promise<boolean>,
    inputAdmission?: Promise<void>,
  ): Promise<StopReceipt> {
    const cleanupErrors: string[] = [];
    const pendingQueue = this.trackedQueueMessages();
    const pendingQueueItemIds = pendingQueue.map((item) => item.queueItemId);
    const clearedCounts = {
      steering: pendingQueue.filter((item) => item.delivery === "steer").length,
      followUp: pendingQueue.filter((item) => item.delivery === "followUp").length,
    };
    await this.extensionUi.suspendForHostDrain();
    if (inputAdmission) await inputAdmission;
    await this.extensionUi.cancelForHostDrain();
    if (preemptibleEffect) await preemptibleEffect;

    try {
      const cleanup = await this.disposeRuntimeOnce();
      cleanupErrors.push(...cleanup.cleanupErrors);
    } catch (error) {
      // Keep lifecycle=stopping and the old owner claim. A stopped record would
      // be continuable even though the Worker process tree may still exist.
      throw new RuntimeEffectUnknownError(operationId, error);
    }

    await Promise.allSettled(activeCommands);
    if (this.backgroundTasks.size > 0) await Promise.allSettled([...this.backgroundTasks]);
    await this.transitionTail;

    await this.enqueueTransition(() => this.commitCatalogTransition(
      { kind: "instance.stop.complete", effect: "post_effect", operationId, instanceId: this.id },
      () => {
        this.catalogAdmissionOperationId = undefined;
        this.state.lifecycle = "stopped";
        this.state.execution = "unavailable";
        this.state.compacting = false;
        this.runtimeCompactingObserved = false;
        this.clearDeferredStartAttribution();
        this.state.activeCommandId = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        this.acceptedPromptMessages.length = 0;
        this.pendingQueueMessages.length = 0;
        this.inFlightQueueMessages.length = 0;
        this.runtimeSteeringHashes = [];
        this.runtimeFollowUpHashes = [];
        this.recoverySessionFile = undefined;
        this.lastKnownValue = undefined;
        this.interruptionValue = undefined;
        this.shutdownRequestedAt = undefined;
        if (cleanupErrors.length > 0) {
          this.state.lastError = safeWireText(cleanupErrors.join("; "), MAX_STOP_CLEANUP_ERROR_CHARS);
        }
        this.touch();
      },
      () => {
        if (clearedCounts.steering > 0 || clearedCounts.followUp > 0) {
          this.appendEvent("queue.cleared", {
            steering: clearedCounts.steering,
            followUp: clearedCounts.followUp,
            total: clearedCounts.steering + clearedCounts.followUp,
            queueItemIds: pendingQueueItemIds,
            reason: "stop",
          });
        }
        this.appendEvent("instance.stopped", { cleanupErrors });
        this.appendStateEvent("stopped");
      },
      { retire: true },
    ));

    const receipt: StopReceipt = {
      operationId,
      instanceId: this.id,
      stopped: true,
      alreadyStopped: false,
    };
    if (cleanupErrors.length > 0) receipt.cleanupErrors = [...cleanupErrors];
    return receipt;
  }

  private disposeRuntimeOnce(): Promise<AgentCleanupResult> {
    if (!this.runtimeDisposePromise) {
      try { this.runtimeDisposePromise = Promise.resolve(this.session.dispose()); }
      catch (error) { this.runtimeDisposePromise = Promise.reject(error); }
    }
    return this.runtimeDisposePromise;
  }

  private requireCommandStart(decision: InstanceCommandDecision, action: string): InstanceCommandLease {
    if (decision.kind === "start") return decision.lease;
    if (decision.kind === "reject" && decision.reason === "not_active") {
      throw new InstanceNotActiveError(this.id, decision.lifecycle ?? this.state.lifecycle);
    }
    if (decision.kind === "reject" && decision.reason === "input_admission") {
      throw new InstanceAdmissionPendingError(this.id);
    }
    throw new InstanceBusyError(this.id, action);
  }

  private assertCommandCurrent(lease: InstanceCommandLease): void {
    if (!lease.current(this.runtimeGenerationValue)) {
      throw new StaleRuntimeGenerationError(lease.generation, this.runtimeGenerationValue);
    }
  }

  private assertActive(): void {
    const stopping = this.commandScheduler.activeCommand("terminal") !== undefined;
    if (this.state.lifecycle !== "active" || stopping) {
      throw new InstanceNotActiveError(this.id, stopping ? "stopping" : this.state.lifecycle);
    }
  }

  private enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
    if (!this.catalogPort) return work();
    const task = this.transitionTail.then(work);
    this.transitionTail = task.then(() => {}, () => {});
    return task;
  }

  private async commitCatalogTransition(
    context: CatalogMutationContext,
    mutate: () => void,
    publish: () => void = () => {},
    options: { retire?: boolean } = {},
  ): Promise<void> {
    if (this.hostDrainActive) {
      this.catalogPort?.assertWritable();
      return;
    }
    const checkpoint = this.captureWorkingCheckpoint();
    try {
      this.catalogPort?.assertWritable();
      mutate();
      this.assertWorkingStateInvariant();
      this.refreshDurableSessionFile();
      if (this.catalogPort) {
        if (options.retire) await this.catalogPort.retire(context);
        else await this.catalogPort.commit(this.catalogRecord(), context);
      }
    } catch (error) {
      if (context.effect !== "post_effect") this.restoreWorkingCheckpoint(checkpoint);
      throw error;
    }
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
    publish();
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
  }

  private assertWorkingStateInvariant(): void {
    validateInstanceStateInvariant({
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      compacting: this.state.compacting,
      ownerHostEpoch: this.state.lifecycle === "active" || this.state.lifecycle === "stopping" ? this.hostEpoch : undefined,
      pendingCount: this.state.pendingSteering + this.state.pendingFollowUp,
      activeCommandId: this.state.activeCommandId,
    });
  }

  private currentLastKnownState(): NonNullable<CatalogInstanceRecord["lastKnown"]> {
    if ((this.state.lifecycle !== "active" && this.state.lifecycle !== "stopping") || this.state.execution === "unavailable") {
      throw new Error("Cannot capture last-known state without a live lifecycle");
    }
    return {
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      ...(this.state.activeCommandId === undefined ? {} : { activeCommandId: this.state.activeCommandId }),
      pendingCount: this.state.pendingSteering + this.state.pendingFollowUp,
    };
  }

  private captureWorkingCheckpoint(): WorkingCheckpoint {
    return {
      state: cloneJson(this.state),
      key: this.keyValue,
      name: this.nameValue,
      cwd: this.cwdValue,
      executor: cloneJson(this.executorIdentity),
      runtimeGeneration: this.runtimeGenerationValue,
      agentStartCount: this.agentStartCount,
      agentSettledCount: this.agentSettledCount,
      lastAssistantOutcome: this.lastAssistantOutcome ? { ...this.lastAssistantOutcome } : undefined,
      stopRequestedWhileRunning: this.stopRequestedWhileRunning,
      catalogAdmissionOperationId: this.catalogAdmissionOperationId,
      replacementIntent: this.replacementIntent ? cloneJson(this.replacementIntent) : undefined,
      durableSessionFile: this.durableSessionFileValue,
      recoverySessionFile: this.recoverySessionFile,
      lastKnown: this.lastKnownValue ? cloneJson(this.lastKnownValue) : undefined,
      interruption: this.interruptionValue ? cloneJson(this.interruptionValue) : undefined,
      stopRequestedAt: this.stopRequestedAt,
      shutdownRequestedAt: this.shutdownRequestedAt,
      ownerReleaseUnconfirmed: this.ownerReleaseUnconfirmed,
      dockToolsEnabled: this.dockToolsEnabledValue,
      executionChangedAt: this.executionChangedAtValue,
      runStartedAt: this.runStartedAtValue,
      timedExecution: this.timedExecutionValue,
    };
  }

  private restoreWorkingCheckpoint(checkpoint: WorkingCheckpoint): void {
    this.state = checkpoint.state;
    this.keyValue = checkpoint.key;
    this.nameValue = checkpoint.name;
    this.cwdValue = checkpoint.cwd;
    Object.assign(this.executorIdentity, checkpoint.executor);
    for (const key of Object.keys(this.executorIdentity) as Array<keyof ExecutorIdentity>) {
      if (!(key in checkpoint.executor)) delete this.executorIdentity[key];
    }
    this.runtimeGenerationValue = checkpoint.runtimeGeneration;
    this.agentStartCount = checkpoint.agentStartCount;
    this.agentSettledCount = checkpoint.agentSettledCount;
    this.lastAssistantOutcome = checkpoint.lastAssistantOutcome;
    this.stopRequestedWhileRunning = checkpoint.stopRequestedWhileRunning;
    this.catalogAdmissionOperationId = checkpoint.catalogAdmissionOperationId;
    this.replacementIntent = checkpoint.replacementIntent;
    this.durableSessionFileValue = checkpoint.durableSessionFile;
    this.recoverySessionFile = checkpoint.recoverySessionFile;
    this.lastKnownValue = checkpoint.lastKnown;
    this.interruptionValue = checkpoint.interruption;
    this.stopRequestedAt = checkpoint.stopRequestedAt;
    this.shutdownRequestedAt = checkpoint.shutdownRequestedAt;
    this.ownerReleaseUnconfirmed = checkpoint.ownerReleaseUnconfirmed;
    this.dockToolsEnabledValue = checkpoint.dockToolsEnabled;
    this.executionChangedAtValue = checkpoint.executionChangedAt;
    this.runStartedAtValue = checkpoint.runStartedAt;
    this.timedExecutionValue = checkpoint.timedExecution;
  }

  private runtimeDurableSessionFile(): string | undefined {
    const value = this.agentState().durableSessionFile;
    const projected = truncate(value, 16_384);
    return projected !== undefined && projected === this.executorIdentity.sessionFile ? projected : undefined;
  }

  private refreshDurableSessionFile(): void {
    if (this.state.lifecycle !== "active" && this.state.lifecycle !== "stopping") return;
    const durable = this.runtimeDurableSessionFile();
    if (durable === undefined) return;
    this.durableSessionFileValue = durable;
    if (this.replacementIntent === undefined) this.recoverySessionFile = undefined;
  }

  private async withCommittedProjectionRead<T>(read: () => T): Promise<T> {
    const historyBoundary = this.historyRefreshTail;
    for (;;) {
      const decision = this.commandScheduler.admitProjectionRead("committed");
      if (decision.kind === "reject") throw new InstanceNotActiveError(this.id, decision.lifecycle);
      if (decision.kind === "available") {
        await historyBoundary;
        const compaction = this.commandScheduler.activeCommand("exclusive", "compaction");
        if (compaction?.completion === decision.boundary) {
          this.assertActive();
          return read();
        }
        continue;
      }
      const projection = decision.reservation;
      try {
        await projection.entered;
        await historyBoundary;
        this.assertActive();
        return read();
      } finally {
        projection.release();
      }
    }
  }

  private async withProjectionRead<T>(read: () => Promise<T>): Promise<T> {
    const projection = await this.beginWorkerProjectionRead();
    try {
      const committedBoundary = this.transitionTail;
      await committedBoundary;
      this.assertActive();
      const generation = this.runtimeGenerationValue;
      const result = await read();
      if (this.runtimeGenerationValue !== generation) {
        throw new StaleRuntimeGenerationError(generation, this.runtimeGenerationValue);
      }
      this.assertActive();
      return result;
    } finally {
      projection.release();
    }
  }

  private async beginWorkerProjectionRead(): Promise<InstanceProjectionReadReservation> {
    const decision = this.commandScheduler.admitProjectionRead("worker");
    if (decision.kind === "reject") throw new InstanceNotActiveError(this.id, decision.lifecycle);
    const projection = decision.reservation;
    try {
      await projection.entered;
      this.assertActive();
      return projection;
    } catch (error) {
      projection.release();
      throw error;
    }
  }

  private async beginConfiguration(
    action: string,
    options: {
      admission?: "idle" | "live" | "run_preempting";
      kind?: "general" | "navigation" | "compaction" | "model-settings";
    } = {},
  ): Promise<InstanceCommandLease> {
    this.catalogPort?.assertWritable();
    const decision = this.commandScheduler.admit(options.kind === "model-settings" ? { class: "model-settings" } : {
      class: "exclusive",
      kind: options.kind ?? "general",
      admission: options.admission ?? "idle",
    });
    const lease = decision.kind === "start" || decision.kind === "wait"
      ? decision.lease
      : this.requireCommandStart(decision, action);
    try {
      if (decision.kind === "wait") await decision.forCompletion;
      await this.transitionTail;
      this.assertCommandCurrent(lease);
      this.catalogPort?.assertWritable();
      this.assertActive();
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private endConfiguration(lease: InstanceCommandLease): void {
    const endedManualCompaction = lease.kind === "compaction";
    lease.release();
    if (endedManualCompaction && !this.runtimeCompactionInProgress()) {
      this.scheduleCompactionQueueDrain(false);
    }
  }

  private async replaceRuntime<T extends AgentReplacementResult>(
    action: string,
    operationId: string,
    kind: "new" | "switch" | "fork" | "clone" | "reload",
    target: { requestedSessionFile?: string; requestedEntryId?: string },
    replace: () => Promise<T>,
    validateTarget?: () => void | Promise<void>,
  ): Promise<T> {
    const configuration = await this.beginConfiguration(action);
    try {
      await validateTarget?.();
      const startedAt = this.timestamp();
      const currentDurableSessionFile = this.runtimeDurableSessionFile();
      const previousRecoverySessionFile = currentDurableSessionFile
        ?? this.recoverySessionFile
        ?? this.durableSessionFileValue;
      const restoreCurrentSessionRecovery = (): void => {
        const durable = this.runtimeDurableSessionFile();
        this.durableSessionFileValue = durable;
        this.recoverySessionFile = durable === undefined ? previousRecoverySessionFile : undefined;
      };
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: `session.${kind}.intent`, effect: "pre_effect", operationId, instanceId: this.id },
        () => {
          if (currentDurableSessionFile !== undefined) this.durableSessionFileValue = currentDurableSessionFile;
          this.recoverySessionFile = undefined;
          this.replacementIntent = {
            operationId,
            kind,
            ...(previousRecoverySessionFile === undefined ? {} : { previousSessionFile: previousRecoverySessionFile }),
            ...(target.requestedSessionFile === undefined ? {} : { requestedSessionFile: target.requestedSessionFile }),
            ...(target.requestedEntryId === undefined ? {} : { requestedEntryId: target.requestedEntryId }),
            startedAt,
          };
          this.touch(startedAt);
        },
      ));
      let result: T;
      this.receiptBoundaryOperationId = operationId;
      try { result = await replace(); }
      catch (error) {
        await this.closeRuntimeOperationBoundary(operationId);
        if (error instanceof AgentMutationEffectUnknownError) {
          throw new RuntimeEffectUnknownError(operationId, error);
        }
        if (this.replacementIntent) {
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: `session.${kind}.failed`, effect: "post_effect", operationId, instanceId: this.id },
            () => { this.replacementIntent = undefined; restoreCurrentSessionRecovery(); this.touch(); },
          ));
        }
        throw error;
      }
      await this.closeRuntimeOperationBoundary(operationId);
      if (result.cancelled && this.replacementIntent) {
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: `session.${kind}.cancelled`, effect: "post_effect", operationId, instanceId: this.id },
          () => { this.replacementIntent = undefined; restoreCurrentSessionRecovery(); this.touch(); },
        ));
      }
      if (!result.cancelled && this.replacementIntent) {
        throw new Error(`Runtime completed ${kind} without publishing a replacement event`);
      }
      return result;
    } finally {
      this.endConfiguration(configuration);
    }
  }

  private async closeRuntimeOperationBoundary(operationId: string): Promise<void> {
    await Promise.resolve();
    if (this.receiptBoundaryOperationId !== operationId) return;
    const tasks = this.receiptBoundaryTasks.splice(0);
    this.receiptBoundaryOperationId = undefined;
    await Promise.all(tasks);
  }

  private finishModelConfiguration(configuration: InstanceCommandLease): void {
    this.modelConfigurationActive = false;
    const observation = this.deferredModelObservation;
    this.deferredModelObservation = undefined;
    // The explicit setter owns its completion and requested/clamped event. Apply
    // only a newer actual state after it, rather than racing its catalog commit.
    if (observation) this.dispatchAgentEvent(observation);
    this.endConfiguration(configuration);
  }

  private applyModelState(state: AgentModelState): boolean {
    const changed = this.executorIdentity.model?.provider !== state.model?.provider || this.executorIdentity.model?.id !== state.model?.id;
    this.executorIdentity.model = state.model ? { provider: truncate(state.model.provider, 256) ?? "unknown", id: truncate(state.model.id, 512) ?? "unknown" } : undefined;
    this.executorIdentity.thinkingLevel = state.thinkingLevel;
    return changed;
  }

  private appendModelChanged(state: AgentModelState): void {
    this.appendEvent("model.changed", {
      provider: state.model?.provider ?? "unknown",
      id: state.model?.id ?? "unknown",
      thinkingLevel: state.thinkingLevel,
      availableThinkingLevels: state.availableThinkingLevels,
    });
  }

  private appendThinkingChanged(requested: ThinkingLevel, state: AgentModelState): void {
    this.appendEvent("thinking.changed", {
      requested,
      thinkingLevel: state.thinkingLevel,
      availableThinkingLevels: state.availableThinkingLevels,
    });
  }

  private appendSettingChanged(setting: SettingDto, touch = true): void {
    if (touch) this.touch();
    this.appendEvent("settings.changed", {
      key: setting.key,
      value: setting.value,
      reloadRequired: setting.reloadRequired,
      hostRestartRequired: setting.hostRestartRequired,
    } as SettingsChangedData);
  }

  private appendSettingsWriteFailed(error: AgentSettingsWriteError): void {
    this.appendEvent("settings.write_failed", {
      key: error.setting,
      error: safeWireText(error.message, 2_048),
    });
  }

  private applyGitBranchChanged(value: unknown): void {
    const branch = projectGitBranch(value);
    if (branch === this.gitBranchValue) return;
    this.gitBranchValue = branch;
    if (this.catalogPort && this.committedSnapshotValue) {
      const snapshot = { ...this.committedSnapshotValue, gitBranch: branch };
      if (branch === undefined) delete snapshot.gitBranch;
      this.committedSnapshotValue = snapshot;
    }
    this.appendEvent("git.branch_changed", branch === undefined ? {} : { branch });
  }

  private dispatchAgentEvent(event: AgentEvent): void {
    if (this.hostDrainActive) return;
    if (event.type === "dock_model_state_observed" && this.modelConfigurationActive) {
      this.deferredModelObservation = event as AgentModelStateObservation;
      return;
    }
    // Replacement UI retirement must begin at event receipt, before the durable
    // transition queue yields to freshly initialized UI calls from the Worker.
    if (event.type === "dock_session_replaced") this.extensionUi.beginGenerationChange();
    // Lifecycle edges are authoritative once observed. Pi publishes
    // compaction_end before its finally block clears isCompacting, so the
    // completed edge must not be reversed by that stale state snapshot.
    if (event.type === "compaction_start") this.runtimeCompactingObserved = true;
    else if (event.type === "compaction_end") this.runtimeCompactingObserved = false;
    if (event.type === "agent_start") {
      const operationId = optionalRuntimeString(event.operationId, 128);
      if (operationId !== undefined && this.nextAgentStartBoundary?.operationId === operationId) {
        const boundary = this.nextAgentStartBoundary;
        this.nextAgentStartBoundary = undefined;
        boundary.resolve();
      }
    }
    if (this.catalogAdmissionOperationId !== undefined) {
      if (this.admissionBufferedEvents.length >= 1_000) {
        this.admissionBufferedEvents.shift();
        this.admissionBufferOverflow = true;
      }
      this.admissionBufferedEvents.push(event);
      return;
    }
    if (!this.catalogPort) {
      try {
        this.handleAgentEvent(event);
        if (event.type === "conversation_checkpoint") this.installConversationCheckpoint(event);
        if (refreshesMetrics(event)) this.refreshMetrics();
        if (refreshesHistory(event)) {
          const refresh = this.refreshHistory();
          this.trackHistoryRefresh(refresh);
          void refresh.catch((error) => this.appendProjectionError(event, error));
        }
      } catch (error) { this.appendProjectionError(event, error); }
      return;
    }
    const task = this.enqueueCatalogAgentEvent(event);
    if (event.type === "conversation_checkpoint" || refreshesHistory(event)) this.trackHistoryRefresh(task);
    void task.catch(() => {});
    if (this.receiptBoundaryOperationId !== undefined) this.receiptBoundaryTasks.push(task);
  }

  private enqueueCatalogAgentEvent(event: AgentEvent): Promise<void> {
    return this.enqueueTransition(async () => {
      try {
        await this.handleCatalogAgentEvent(event);
        if (event.type === "conversation_checkpoint") {
          this.installConversationCheckpoint(event);
        } else if (refreshesHistory(event)) {
          await this.refreshHistory();
        }
        if (refreshesMetrics(event)) this.refreshMetrics();
      }
      catch (error) {
        try {
          this.catalogPort?.assertWritable();
          this.appendProjectionError(event, error);
        } catch {
          throw error;
        }
      }
    });
  }

  private flushAdmissionAgentEvents(): Promise<void> {
    const events = this.admissionBufferedEvents.splice(0);
    const overflow = this.admissionBufferOverflow;
    this.admissionBufferOverflow = false;
    const tasks = events.map((event) => {
      const task = this.enqueueCatalogAgentEvent(event);
      if (refreshesHistory(event)) this.trackHistoryRefresh(task);
      return task;
    });
    if (overflow) {
      tasks.push(this.enqueueCatalogAgentEvent({ type: "dock_extension_error", error: "Admission runtime event buffer exceeded 1000 events; the newest bounded tail and authoritative history/metrics were retained" }));
      const refresh = this.enqueueTransition(async () => { await this.refreshHistory(); this.refreshMetrics(); });
      this.trackHistoryRefresh(refresh);
      tasks.push(refresh);
    }
    return Promise.all(tasks).then(() => {});
  }

  private trackHistoryRefresh(task: Promise<void>): void {
    this.historyRefreshTail = task.then(() => {}, () => {});
  }

  private async refreshHistory(): Promise<void> {
    const history = await this.invokeAgent<AgentHistoryEntry[]>("session.history", { limit: 200 });
    this.journal.replaceHistory(history.map(projectAgentHistoryEntry));
  }

  private refreshMetrics(): void {
    const metrics = projectRuntimeMetrics(this.agentState().metrics);
    if (JSON.stringify(metrics) === JSON.stringify(this.metricsValue)) return;
    this.metricsValue = metrics;
    if (this.catalogPort && this.committedSnapshotValue) {
      this.committedSnapshotValue = { ...this.committedSnapshotValue, metrics: cloneJson(metrics) };
    }
    this.appendEvent("session.metrics_changed", { metrics: cloneJson(metrics) });
  }

  private appendProjectionError(event: AgentEvent, error: unknown): void {
    this.appendEvent("instance.error", { source: "event_projection",
      error: safeWireText(errorMessage(error), 2_048),
      runtimeEventType: truncate(event.type, 128),
    });
  }

  private async handleCatalogAgentEvent(event: AgentEvent): Promise<void> {
    this.catalogPort?.assertWritable();
    if (event.type === "dock_git_branch_changed") {
      this.applyGitBranchChanged(event.branch);
      return;
    }
    if (event.type === "dock_queue_consumed") {
      const consumed = this.workerConsumedQueueMessage(event);
      const needsPendingCommit = consumed !== undefined
        && (consumed.queued.phase === "fresh_in_flight" || consumed.queued.phase === "effect_unknown");
      if (!needsPendingCommit || consumed === undefined) {
        this.handleAgentEvent(event);
        return;
      }
      await this.commitCatalogTransition(this.agentEventCatalogContext(event, "queue.consumed"), () => {
        const operationId = optionalRuntimeString(event.operationId, 128);
        const acceptedIndex = operationId === undefined ? -1 : this.acceptedPromptMessages.findIndex((candidate) => candidate.operationId === operationId);
        if (acceptedIndex >= 0) this.acceptedPromptMessages.splice(acceptedIndex, 1);
        this.removeWorkerConsumedMessage(consumed, true);
        this.touch();
      }, () => {
        const operationId = optionalRuntimeString(event.operationId, 128);
        if (operationId !== undefined) this.consumedQueueItemIds.set(operationId, consumed.queued.queueItemId);
        this.appendEvent("queue.changed", {
          steering: this.state.pendingSteering,
          followUp: this.state.pendingFollowUp,
          total: this.state.pendingSteering + this.state.pendingFollowUp,
        });
        this.appendStateEvent("deferred_message_submitted");
      });
      this.scheduleCompactionQueueDrain(false);
      return;
    }
    const transition = this.agentEventTransition(event);
    if (transition === undefined) {
      this.handleAgentEvent(event);
      return;
    }
    transition.before?.();
    if (!transition.durable) {
      transition.mutate();
      transition.publish();
      transition.cleanup?.();
      transition.settle?.();
      return;
    }
    try {
      await this.commitCatalogTransition(this.agentEventCatalogContext(event, transition.kind, transition.operationId), transition.mutate, transition.publish);
    } finally {
      transition.cleanup?.();
    }
    transition.settle?.();
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (this.state.lifecycle === "stopped") return;
    if (event.type === "dock_git_branch_changed") {
      this.applyGitBranchChanged(event.branch);
      return;
    }
    if (event.type === "dock_extension_error") {
      this.recordExtensionError(event.error);
      return;
    }
    if (event.type === "dock_conversation_frame") {
      this.appendWorkerConversationFrame(event);
      return;
    }
    if (event.type === "dock_queue_consumed") {
      this.handleWorkerQueueConsumed(event);
      return;
    }
    const transition = this.agentEventTransition(event);
    if (transition === undefined) return;
    transition.before?.();
    transition.mutate();
    transition.publish();
    transition.cleanup?.();
    transition.settle?.();
  }

  /**
   * Runtime lifecycle signals are joint facts: the Worker supplies the signal
   * and any carried causal operation; the Host applies fallback attribution,
   * queue merging and durable-commit ordering. Each signal has exactly one transition here; the catalog path
   * wraps it in a commit while the in-memory path runs it directly. Never
   * fork per-mode copies of this logic again.
   */
  private agentEventTransition(event: AgentEvent): AgentEventTransition | undefined {
    switch (event.type) {
      case "dock_model_state_observed": {
        const observation = event as AgentModelStateObservation;
        const model = observation.modelState;
        if (observation.runtimeGeneration !== this.runtimeGenerationValue || this.state.lifecycle !== "active") return;
        if (this.executorIdentity.model?.provider === model.model?.provider
          && this.executorIdentity.model?.id === model.model?.id
          && this.executorIdentity.thinkingLevel === model.thinkingLevel) return;
        return {
          kind: "model.observed",
          durable: true,
          mutate: () => { this.applyModelState(model); this.touch(); },
          // This is the full observed model configuration. Unlike a Dock
          // thinking.set request, an observation carries no requested level.
          publish: () => this.appendModelChanged(model),
        };
      }
      case "dock_session_replaced": {
        const replacedQueue = removedQueueProjection(this.trackedQueueMessages(), this.state);
        const previousSessionFile = optionalRuntimeString(event.previousSessionFile, 16_384);
        const sessionFile = optionalRuntimeString(event.sessionFile, 16_384);
        const cwd = optionalRuntimeString(event.cwd, 16_384);
        const name = optionalRuntimeString(event.name, 256);
        const reason = this.replacementIntent?.kind === "clone"
          ? "clone"
          : event.reason === "resume" || event.reason === "reload" || event.reason === "fork" ? event.reason : "new";
        const previousDurableSessionFile = this.replacementIntent?.previousSessionFile ?? previousSessionFile;
        const modelState = event.modelState as AgentModelState | undefined;
        return {
          kind: "session.replaced",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          mutate: () => {
            this.runtimeGenerationValue += 1;
            this.replacementIntent = undefined;
            this.recoverySessionFile = undefined;
            this.lastKnownValue = undefined;
            this.interruptionValue = undefined;
            this.shutdownRequestedAt = undefined;
            this.agentStartCount = 0;
            this.agentSettledCount = 0;
            this.acceptedPromptMessages.length = 0;
            this.consumedQueueItemIds.clear();
            this.pendingQueueMessages.length = 0;
            this.inFlightQueueMessages.length = 0;
            this.runtimeSteeringHashes = [];
            this.runtimeFollowUpHashes = [];
            this.lastAssistantOutcome = undefined;
            this.runtimeCompactingObserved = undefined;
            this.clearDeferredStartAttribution();
            this.finishCompactionBoundary();
            this.state.execution = "idle";
            this.state.compacting = false;
            this.state.lastRun = "never";
            this.state.activeCommandId = undefined;
            this.state.lastError = undefined;
            this.state.pendingSteering = 0;
            this.state.pendingFollowUp = 0;
            if (cwd !== undefined) this.cwdValue = cwd;
            this.nameValue = name;
            this.gitBranchValue = projectGitBranch(event.gitBranch ?? this.agentState().gitBranch);
            this.executorIdentity.piSessionId = truncate(this.agentState().sessionId, 128) ?? "unknown";
            this.executorIdentity.sessionFile = truncate(this.agentState().sessionFile, 16_384);
            this.durableSessionFileValue = this.runtimeDurableSessionFile();
            this.recoverySessionFile = this.durableSessionFileValue === undefined ? previousDurableSessionFile : undefined;
            this.applyModelState(modelState ?? this.agentState().modelState);
            this.touch();
          },
          publish: () => {
            this.journal.resetGeneration(this.runtimeGenerationValue);
            this.appendEvent("session.replaced", { reason, previousSessionFile, sessionFile, runtimeGeneration: this.runtimeGenerationValue, cwd: this.cwdValue, piSessionId: this.executorIdentity.piSessionId, name: this.nameValue, displayName: this.projectedDisplayName(), gitBranch: this.gitBranchValue });
            if (replacedQueue.total > 0) this.appendEvent("queue.cleared", { ...replacedQueue, reason: "replacement" });
          },
          settle: () => void this.extensionUi.completeGenerationChange(),
        };
      }
      case "session_info_changed": {
        const name = optionalRuntimeString(event.name, 256);
        return {
          kind: "session.name",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          mutate: () => {
            this.nameValue = name;
            this.touch();
          },
          publish: () => this.appendEvent("session.info_changed", { name, displayName: this.projectedDisplayName() }),
        };
      }
      case "dock_runtime_error":
      case "dock_runtime_lost": {
        const runtimeLost = event.type === "dock_runtime_lost";
        const error = boundedRuntimeString(event.error, 2_048, runtimeLost ? "Runtime worker was lost" : "Runtime replacement failed");
        const recoverySessionFile = optionalRuntimeString(event.recoverySessionFile, 16_384)
          ?? this.replacementIntent?.previousSessionFile
          ?? this.durableSessionFileValue;
        const lastKnown = this.currentLastKnownState();
        return {
          kind: "session.runtime_error",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          before: () => void this.extensionUi.failGenerationChange(),
          mutate: () => {
            this.replacementIntent = undefined;
            this.recoverySessionFile = recoverySessionFile;
            this.lastKnownValue = lastKnown;
            this.interruptionValue = { reason: "replacement_failed", at: this.timestamp() };
            this.state.lifecycle = "runtime_error";
            this.state.execution = "unavailable";
            this.state.compacting = false;
            this.state.activeCommandId = undefined;
            this.state.pendingSteering = 0;
            this.state.pendingFollowUp = 0;
            this.state.lastError = error;
            this.touch();
          },
          publish: () => {
            this.appendEvent("instance.runtime_error", {
              operationId: boundedRuntimeString(event.operationId, 128, "runtime-internal"),
              kind: runtimeLost ? "create" : event.kind === "reload" || event.kind === "switch" || event.kind === "fork" || event.kind === "clone" ? event.kind : "new",
              error,
              recoverySessionFile,
            });
            this.appendStateEvent(runtimeLost ? "runtime_worker_lost" : "runtime_replacement_failed");
          },
        };
      }
      case "agent_start": {
        const carriedOperationId = optionalRuntimeString(event.operationId, 128);
        return {
          kind: "run.started",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          mutate: () => {
            if (carriedOperationId !== undefined) this.state.activeCommandId = carriedOperationId;
            this.agentStartCount += 1;
            this.lastAssistantOutcome = undefined;
            this.state.execution = "running";
            this.state.lastError = undefined;
            this.touch();
          },
          publish: () => {
            this.appendEvent("run.started", { operationId: this.state.activeCommandId ?? "runtime-initiated" });
            this.appendStateEvent("agent_start");
          },
        };
      }
      case "agent_settled": {
        this.lastAssistantOutcome = {
          stopReason: optionalRuntimeString(event.stopReason, 128),
          errorMessage: event.error as string | undefined,
        };
        const outcome = this.lastAssistantOutcome;
        const operationId = this.resolveAgentEventOperationId(event);
        let result: Exclude<LastRunResult, "never"> = "failed";
        return {
          kind: "run.settled",
          durable: true,
          operationId,
          mutate: () => {
            this.agentSettledCount += 1;
            if (outcome?.stopReason === "error") {
              result = "failed";
              this.state.execution = "failed";
              // Catalog status is a preview; events and history retain the full Agent error.
              this.state.lastError = truncate(outcome.errorMessage || "Pi run failed", MAX_CATALOG_LAST_ERROR_CHARS);
            } else if (outcome?.stopReason === "aborted" || this.stopRequestedWhileRunning) {
              result = "aborted";
              this.state.execution = "idle";
              this.state.lastError = undefined;
            } else if (!outcome) {
              result = "failed";
              this.state.execution = "failed";
              this.state.lastError = "Pi run settled without an assistant outcome";
            } else {
              result = "succeeded";
              this.state.execution = "idle";
              this.state.lastError = undefined;
            }
            // Pi awaits extension agent_settled handlers before publishing its own
            // agent_settled event. An extension-triggered compact() can therefore
            // publish compaction_start first. Settling the completed agent run must
            // not make that still-active compaction look idle.
            if (this.compactionActive) this.state.execution = "running";
            this.state.lastRun = result;
            this.state.activeCommandId = undefined;
            this.touch();
          },
          publish: () => {
            this.appendEvent("run.settled", {
              operationId,
              result,
              stopReason: outcome?.stopReason,
              error: outcome?.errorMessage,
            });
            this.appendStateEvent("agent_settled");
          },
        };
      }
      case "queue_update": {
        const steering = stringArray(event.steering);
        const followUp = stringArray(event.followUp);
        this.synchronizePendingRuntimeQueue(steering, followUp);
        const pending = this.mergedRuntimePendingCounts(steering.length, followUp.length);
        return {
          kind: "queue.changed",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          mutate: () => {
            this.state.pendingSteering = pending.steering;
            this.state.pendingFollowUp = pending.followUp;
            this.touch();
          },
          publish: () => void this.appendEvent("queue.changed", pending),
        };
      }
      case "auto_retry_start":
        return {
          kind: "run.retry_started",
          durable: true,
          operationId: this.resolveAgentEventOperationId(event),
          mutate: () => {
            this.state.execution = "running";
            this.touch();
          },
          publish: () => void this.appendEvent("run.retry_started", {
            attempt: nonNegativeNumber(event.attempt),
            maxAttempts: nonNegativeNumber(event.maxAttempts),
            delayMs: nonNegativeNumber(event.delayMs),
            error: event.errorMessage as string,
          }),
        };
      case "auto_retry_end":
        return {
          kind: "run.retry_completed",
          durable: false,
          mutate: () => {},
          publish: () => void this.appendEvent("run.retry_completed", {
            success: event.success === true,
            attempt: nonNegativeNumber(event.attempt),
            error: event.finalError as string | undefined,
          }),
        };
      case "compaction_start": {
        const operationId = this.resolveAgentEventOperationId(event);
        return {
          kind: "compaction.started",
          durable: true,
          operationId,
          mutate: () => {
            this.startCompactionBoundary(operationId);
            this.state.execution = "running";
            this.state.compacting = true;
            this.touch();
          },
          publish: () => void this.appendEvent("compaction.started", {
            reason: compactionReason(event.reason),
            ...(operationId === undefined ? {} : { operationId }),
          }),
        };
      }
      case "compaction_end": {
        const operationId = this.resolveAgentEventOperationId(event);
        return {
          kind: "compaction.completed",
          durable: true,
          operationId,
          mutate: () => {
            if (this.state.activeCommandId === undefined && event.willRetry !== true) this.state.execution = "idle";
            this.state.compacting = false;
            this.touch();
          },
          publish: () => {
            this.appendEvent("compaction.completed", {
              reason: compactionReason(event.reason),
              ...(operationId === undefined ? {} : { operationId }),
              aborted: event.aborted === true,
              willRetry: event.willRetry === true,
              error: event.errorMessage as string | undefined,
            });
            this.appendStateEvent("compaction_completed");
          },
          cleanup: () => this.finishCompactionBoundary(),
          settle: () => this.scheduleCompactionQueueDrain(event.willRetry === true),
        };
      }
      default:
        return undefined;
    }
  }

  private agentEventCatalogContext(event: AgentEvent, kind: string, operationId = this.resolveAgentEventOperationId(event)): CatalogMutationContext {
    return {
      kind,
      effect: "post_effect",
      ...(operationId === undefined ? {} : { operationId }),
      instanceId: this.id,
    };
  }

  private resolveAgentEventOperationId(event: AgentEvent): string | undefined {
    const carriedOperationId = optionalRuntimeString(event.operationId, 128);
    return carriedOperationId
      ?? this.catalogAdmissionOperationId
      ?? (event.type === "agent_settled" ? this.state.activeCommandId : undefined)
      ?? this.compactionOperationId
      ?? this.compactionRequestOperationId
      ?? (event.type === "session_info_changed" ? this.sessionNameOperationId : undefined)
      ?? (this.sessionNameOperationId === undefined ? this.receiptBoundaryOperationId : undefined)
      ?? this.replacementIntent?.operationId
      ?? this.state.activeCommandId
      ?? this.receiptBoundaryOperationId;
  }

  private startCompactionBoundary(operationId?: string): void {
    if (operationId !== undefined) this.compactionOperationId = operationId;
    this.commandScheduler.markEffectStarted("exclusive", "compaction");
    if (this.compactionActive) return;
    this.compactionActive = true;
    this.compactionBoundary = new Promise<void>((resolve) => { this.resolveCompactionBoundary = resolve; });
  }

  private finishCompactionBoundary(): void {
    this.compactionActive = false;
    this.compactionOperationId = undefined;
    this.resolveCompactionBoundary?.();
    this.resolveCompactionBoundary = undefined;
    this.compactionBoundary = undefined;
  }

  private pendingMessagesProjection(): PendingMessageDto[] {
    return pendingMessageProjection(this.pendingQueueMessages);
  }

  private canQueueMessage(message: string, images: readonly ImagePathDto[] = [], attachments: readonly AttachmentDto[] = []): boolean {
    const tracked = this.trackedQueueMessages();
    const projectedCount = Math.max(
      tracked.length,
      this.state.pendingSteering + this.state.pendingFollowUp,
    ) + 1;
    const projectedCharacters = tracked.reduce(
      (total, item) => total + (item.originalText?.length ?? item.text.length),
      0,
    ) + message.length;
    const projectedImageCharacters = tracked.reduce(
      (total, item) => total + imageDescriptorCharacters(item.images),
      0,
    ) + imageDescriptorCharacters(images);
    const projectedAttachmentCharacters = tracked.reduce(
      (total, item) => total + attachmentDescriptorCharacters(item.attachments),
      0,
    ) + attachmentDescriptorCharacters(attachments);
    return projectedCount <= MAX_PENDING_QUEUE_ITEMS
      && projectedCharacters <= MAX_PENDING_QUEUE_TEXT_CHARS
      && projectedImageCharacters <= MAX_PENDING_QUEUE_IMAGE_DESCRIPTOR_CHARS
      && projectedAttachmentCharacters <= MAX_PENDING_QUEUE_ATTACHMENT_DESCRIPTOR_CHARS;
  }

  private discardAcceptedPrompt(operationId: string): void {
    const index = this.acceptedPromptMessages.findIndex((message) => message.operationId === operationId);
    if (index >= 0) this.acceptedPromptMessages.splice(index, 1);
  }

  private synchronizePendingRuntimeQueue(steering: string[], followUp: string[]): void {
    this.runtimeSteeringHashes = steering.slice(0, MAX_PENDING_QUEUE_ITEMS).map(runtimeMessageHash);
    this.runtimeFollowUpHashes = followUp.slice(0, MAX_PENDING_QUEUE_ITEMS).map(runtimeMessageHash);
    this.assignPendingRuntimeHashes("steer", this.runtimeSteeringHashes);
    this.assignPendingRuntimeHashes("followUp", this.runtimeFollowUpHashes);
  }

  private mergedRuntimePendingCounts(runtimeSteering: number, runtimeFollowUp: number): PendingDto {
    const hostPending = (delivery: "steer" | "followUp"): number => this.pendingQueueMessages.filter((item) => (
      item.delivery === delivery
      && (
        item.phase === "host_deferred"
        || ((item.phase === "dispatching" || item.phase === "effect_unknown") && item.runtimeTextHash === undefined)
      )
    )).length;
    const steering = runtimeSteering + hostPending("steer");
    const followUp = runtimeFollowUp + hostPending("followUp");
    return { steering, followUp, total: steering + followUp };
  }

  private assignPendingRuntimeHashes(delivery: "steer" | "followUp", runtimeHashes: string[]): void {
    const available = [...runtimeHashes];
    const runtimeCandidates = this.trackedQueueMessages().filter((item) => (
      item.delivery === delivery
      && (item.phase === "runtime_queued" || item.phase === "dispatching" || item.phase === "effect_unknown")
    ));
    for (const item of runtimeCandidates) {
      if (item.runtimeTextHash === undefined) continue;
      const index = available.indexOf(item.runtimeTextHash);
      if (index >= 0) available.splice(index, 1);
    }
    const unassigned = runtimeCandidates.filter((item) => item.runtimeTextHash === undefined);
    for (let index = 0; index < Math.min(unassigned.length, available.length); index += 1) {
      unassigned[index]!.runtimeTextHash = available[index]!;
    }
  }

  private workerConsumedQueueMessage(event: AgentEvent): QueuedUserMessageStart | undefined {
    const operationId = optionalRuntimeString(event.operationId, 128);
    if (operationId === undefined) return undefined;
    const queued = this.trackedQueueMessages().find((item) => item.operationId === operationId);
    return queued === undefined ? undefined : { queued };
  }

  private removeWorkerConsumedMessage(start: QueuedUserMessageStart, updatePendingCount: boolean): void {
    const pendingIndex = this.pendingQueueMessages.indexOf(start.queued);
    if (pendingIndex >= 0) this.pendingQueueMessages.splice(pendingIndex, 1);
    const inFlightIndex = this.inFlightQueueMessages.indexOf(start.queued);
    if (inFlightIndex >= 0) this.inFlightQueueMessages.splice(inFlightIndex, 1);
    if (updatePendingCount) {
      if (start.queued.delivery === "steer") this.state.pendingSteering = Math.max(0, this.state.pendingSteering - 1);
      else this.state.pendingFollowUp = Math.max(0, this.state.pendingFollowUp - 1);
    }
  }

  private handleWorkerQueueConsumed(event: AgentEvent): void {
    const operationId = optionalRuntimeString(event.operationId, 128);
    if (operationId === undefined) return;
    const acceptedIndex = this.acceptedPromptMessages.findIndex((candidate) => candidate.operationId === operationId);
    if (acceptedIndex >= 0) this.acceptedPromptMessages.splice(acceptedIndex, 1);
    const start = this.workerConsumedQueueMessage(event);
    if (!start) return;
    const updatePendingCount = this.pendingQueueMessages.includes(start.queued)
      && (start.queued.phase === "fresh_in_flight" || start.queued.phase === "effect_unknown");
    this.consumedQueueItemIds.set(operationId, start.queued.queueItemId);
    this.removeWorkerConsumedMessage(start, updatePendingCount);
    if (updatePendingCount) {
      this.appendEvent("queue.changed", {
        steering: this.state.pendingSteering,
        followUp: this.state.pendingFollowUp,
        total: this.state.pendingSteering + this.state.pendingFollowUp,
      });
      this.appendStateEvent("deferred_message_submitted");
    }
  }

  private appendWorkerConversationFrame(event: AgentEvent): void {
    const frame = event.frame as ConversationFrame | undefined;
    if (!frame || !isConversationFrameType(frame.type)) throw new Error("Worker returned an invalid conversation frame");
    if (frame.type === "message.submitted") {
      this.discardAcceptedPrompt(frame.data.operationId);
      const queueItemId = this.consumedQueueItemIds.get(frame.data.operationId);
      this.consumedQueueItemIds.delete(frame.data.operationId);
      this.appendEvent(frame.type, {
        ...cloneJson(frame.data),
        ...(queueItemId === undefined ? {} : { queueItemId }),
      });
      return;
    }
    this.appendEvent(frame.type, cloneJson(frame.data) as EventDataMap[typeof frame.type]);
  }

  private appendStateEvent(reason: string, occurredAt?: string): void {
    // Never publish a malformed projection that would force every strict
    // client to disconnect. The catalog transition validates the same shape
    // before commit; this is defense in depth for non-catalog test/runtime use.
    this.assertWorkingStateInvariant();
    this.appendEvent("instance.state_changed", {
      reason,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      compacting: this.state.compacting,
      lastRun: this.state.lastRun,
      pending: {
        steering: this.state.pendingSteering,
        followUp: this.state.pendingFollowUp,
        total: this.state.pendingSteering + this.state.pendingFollowUp,
      },
      activeCommandId: this.state.activeCommandId,
      lastError: this.state.lastError,
    }, occurredAt);
  }

  private appendEvent<K extends keyof EventDataMap>(type: K, data: EventDataMap[K], occurredAt = this.timestamp()): DockEvent {
    return this.journal.append(type, data, occurredAt);
  }

  private installConversationCheckpoint(event: AgentEvent): void {
    if (!Array.isArray(event.history)) throw new Error("Worker conversation checkpoint is missing its authoritative history");
    const history = event.history.map((entry) => projectAgentHistoryEntry(entry as AgentHistoryEntry));
    this.journal.installConversationCheckpoint(history);
  }

  private touch(timestamp = this.timestamp()): void {
    if (this.state.execution !== this.timedExecutionValue) {
      this.timedExecutionValue = this.state.execution;
      this.executionChangedAtValue = timestamp;
      this.runStartedAtValue = this.state.execution === "running" ? timestamp : undefined;
    }
    if (timestamp >= this.state.updatedAt) this.state.updatedAt = timestamp;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedRuntimeString(value: unknown, limit: number, fallback: string): string {
  return typeof value === "string" ? safeWireText(value, limit) : fallback;
}

function optionalRuntimeString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? safeWireText(value, limit) : undefined;
}

function projectGitBranch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("Runtime Git branch projection is not terminal-safe");
  }
  return safeWireText(value, 256);
}

function cloneInputImages(images: readonly ImagePathDto[] | undefined): ImagePathDto[] {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error(`Prompt images must contain at most ${MAX_INPUT_IMAGES} items`);
  const result = images.map((image) => {
    if (!image || typeof image.path !== "string" || image.path.length < 1 || image.path.length > MAX_IMAGE_PATH_CHARS || !isPortableAbsoluteLocalPath(image.path) || /[\u0000-\u001f\u007f-\u009f]/u.test(image.path)) {
      throw new Error("Prompt image path must be a bounded absolute local path");
    }
    if (typeof image.mimeType !== "string" || image.mimeType.length > MAX_IMAGE_MIME_TYPE_CHARS || !/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(image.mimeType)) {
      throw new Error("Prompt image MIME type must be a bounded image/* value");
    }
    return { path: image.path, mimeType: image.mimeType };
  });
  if (new Set(result.map((image) => `${image.path}\u0000${image.mimeType}`)).size !== result.length) throw new Error("Prompt images must be unique");
  return result;
}

function imageDescriptorCharacters(images: readonly ImagePathDto[] | undefined): number {
  return (images ?? []).reduce((total, image) => total + image.path.length + image.mimeType.length, 0);
}

function cloneInputAttachments(attachments: readonly AttachmentDto[] | undefined): AttachmentDto[] {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENT_IDS_PER_COMMAND) throw new Error(`Prompt attachments must contain at most ${MAX_ATTACHMENT_IDS_PER_COMMAND} items`);
  const result = attachments.map((attachment) => {
    if (!attachment || typeof attachment.fileId !== "string" || attachment.fileId.length > MAX_ATTACHMENT_FILE_ID_CHARS || !/^[0-9a-f-]+$/u.test(attachment.fileId)) throw new Error("Prompt attachment fileId is invalid");
    if (typeof attachment.name !== "string" || attachment.name.length < 1 || attachment.name.length > MAX_ATTACHMENT_NAME_CHARS || /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(attachment.name)) throw new Error("Prompt attachment name is invalid");
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > MAX_ATTACHMENT_BYTES) throw new Error("Prompt attachment size is invalid");
    if (attachment.mediaType !== undefined && (typeof attachment.mediaType !== "string" || attachment.mediaType.length < 1 || attachment.mediaType.length > MAX_ATTACHMENT_MEDIA_TYPE_CHARS || /[\u0000-\u001f\u007f-\u009f]/u.test(attachment.mediaType))) throw new Error("Prompt attachment media type is invalid");
    if (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attachment.sha256)) throw new Error("Prompt attachment SHA-256 is invalid");
    if (typeof attachment.storedAt !== "string" || !Number.isFinite(Date.parse(attachment.storedAt))) throw new Error("Prompt attachment timestamp is invalid");
    return {
      fileId: attachment.fileId,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      sha256: attachment.sha256,
      storedAt: attachment.storedAt,
    };
  });
  if (new Set(result.map((attachment) => attachment.fileId)).size !== result.length) throw new Error("Prompt attachments must be unique");
  return result;
}

function attachmentDescriptorCharacters(attachments: readonly AttachmentDto[] | undefined): number {
  return (attachments ?? []).reduce((total, attachment) => total
    + attachment.fileId.length + attachment.name.length + attachment.sha256.length
    + attachment.storedAt.length + (attachment.mediaType?.length ?? 0) + 32, 0);
}

function runtimeMessageHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function removedQueueProjection(
  pending: readonly PendingQueueMessage[],
  state: MutableState,
): PendingDto & { queueItemIds: string[] } {
  const steering = Math.max(state.pendingSteering, pending.filter((item) => item.delivery === "steer").length);
  const followUp = Math.max(state.pendingFollowUp, pending.filter((item) => item.delivery === "followUp").length);
  return { steering, followUp, total: steering + followUp, queueItemIds: pending.map((item) => item.queueItemId) };
}

function pendingMessageProjection(pending: readonly PendingQueueMessage[]): PendingMessageDto[] {
  const steering = pending.filter((item) => item.delivery === "steer");
  const followUp = pending.filter((item) => item.delivery === "followUp");
  return cloneJson([...steering, ...followUp].map((item) => ({
    queueItemId: item.queueItemId,
    operationId: item.operationId,
    delivery: item.delivery,
    text: item.text,
    ...(item.images === undefined ? {} : { images: cloneInputImages(item.images) }),
    ...(item.attachments === undefined ? {} : { attachments: cloneInputAttachments(item.attachments) }),
    acceptedAt: item.acceptedAt,
  })));
}

function orderPendingMessages(messages: readonly PendingMessageDto[]): PendingMessageDto[] {
  return cloneJson([
    ...messages.filter((item) => item.delivery === "steer"),
    ...messages.filter((item) => item.delivery === "followUp"),
  ]);
}

function selectClearedQueueMessages(
  pending: readonly PendingQueueMessage[],
  cleared: ClearedAgentQueue,
  acceptedAt: string,
): { restored: PendingMessageDto[]; restoredQueueItemIds: string[] } {
  const selected = new Set<string>();
  const restored: PendingMessageDto[] = [];
  const select = (delivery: "steer" | "followUp", runtimeMessages: string[]): void => {
    const candidates = pending.filter((item) => item.delivery === delivery);
    for (const text of runtimeMessages) {
      const hash = runtimeMessageHash(text);
      const matched = candidates.find((item) => !selected.has(item.queueItemId) && item.runtimeTextHash === hash)
        ?? candidates.find((item) => !selected.has(item.queueItemId) && item.text === text);
      if (matched) {
        selected.add(matched.queueItemId);
        restored.push(pendingMessageProjection([matched])[0]!);
      } else {
        const queueItemId = randomUUID();
        selected.add(queueItemId);
        restored.push({
          queueItemId,
          operationId: `runtime-queue-${randomUUID()}`,
          delivery,
          text: safeWireText(text, MAX_PENDING_QUEUE_TEXT_CHARS),
          acceptedAt,
        });
      }
    }
  };
  select("steer", cleared.steering);
  select("followUp", cleared.followUp);
  return { restored, restoredQueueItemIds: [...selected] };
}

function isConversationFrameType(type: string): type is ConversationFrame["type"] {
  return type === "message.submitted"
    || type === "message.delta"
    || type === "message.completed"
    || type === "tool.started"
    || type === "tool.args_updated"
    || type === "tool.output_updated"
    || type === "tool.completed";
}

function refreshesHistory(event: AgentEvent): boolean {
  return event.type === "session_info_changed"
    || event.type === "dock_session_replaced";
}

function refreshesMetrics(event: AgentEvent): boolean {
  return event.type === "conversation_checkpoint"
    || event.type === "agent_settled"
    || event.type === "compaction_end"
    || event.type === "dock_session_replaced";
}

function projectAgentHistoryEntry(entry: AgentHistoryEntry): HistoryEntryDto {
  if (entry.recordId.length < 1 || entry.recordId.length > 128 || entry.entryId.length < 1 || entry.entryId.length > 128) {
    throw new Error("Runtime returned an invalid conversation record identity");
  }
  if (entry.parentId !== undefined && (entry.parentId.length < 1 || entry.parentId.length > 128)) {
    throw new Error("Runtime returned an invalid conversation parent identity");
  }
  if (entry.content.length > MAX_CONVERSATION_CONTENT_BLOCKS) throw new Error("Runtime returned too many conversation content blocks");
  const projected = cloneJson(entry);
  if (entry.attachments !== undefined) projected.attachments = cloneInputAttachments(entry.attachments);
  return projected;
}

function projectRuntimeMetrics(value: AgentSessionMetrics): SessionMetricsDto {
  const context = value.context;
  return {
    messages: {
      user: nonNegativeNumber(value.messages.user),
      assistant: nonNegativeNumber(value.messages.assistant),
      toolCalls: nonNegativeNumber(value.messages.toolCalls),
      toolResults: nonNegativeNumber(value.messages.toolResults),
      total: nonNegativeNumber(value.messages.total),
    },
    tokens: {
      input: nonNegativeNumber(value.tokens.input),
      output: nonNegativeNumber(value.tokens.output),
      cacheRead: nonNegativeNumber(value.tokens.cacheRead),
      cacheWrite: nonNegativeNumber(value.tokens.cacheWrite),
      total: nonNegativeNumber(value.tokens.total),
    },
    cost: typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : 0,
    ...(context === undefined ? {} : {
      context: {
        tokens: context.tokens === null ? null : nonNegativeNumber(context.tokens),
        contextWindow: Math.max(1, nonNegativeNumber(context.contextWindow)),
        percent: context.percent === null
          ? null
          : typeof context.percent === "number" && Number.isFinite(context.percent)
            ? Math.max(0, Math.min(100, context.percent))
            : null,
      },
    }),
  };
}

const RUN_SENSITIVE_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  "autoCompaction",
  "autoRetry",
  "steeringMode",
  "followUpMode",
  "transport",
  "httpIdleTimeoutMs",
]);

function settingAdmission(key: SettingKey): "idle" | "live" {
  // These settings can alter the active agent loop, queue draining, retry,
  // transport, or the process-wide HTTP dispatcher. Presentation,
  // startup/reload, and trust defaults only affect this/next client or a future
  // boundary.
  return RUN_SENSITIVE_SETTING_KEYS.has(key) ? "idle" : "live";
}

function isKnownMutationBoundaryError(error: unknown): boolean {
  return error instanceof CatalogEffectUnknownError
    || error instanceof CatalogWriteError
    || error instanceof MutationFaultedError
    || error instanceof RuntimeEffectUnknownError
    || error instanceof AgentUnavailableBeforeEffectError
    || error instanceof AgentCompactionKnownFailureError
    || error instanceof AgentInvalidTreeTargetError;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compactionReason(value: unknown): "manual" | "threshold" | "overflow" {
  return value === "threshold" || value === "overflow" ? value : "manual";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeWireText(value: string, limit: number): string {
  return truncate(value, limit) ?? "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = recordValue(error);
  if (record) {
    const message = stringValue(record.message) ?? stringValue(record.error);
    if (message) return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
