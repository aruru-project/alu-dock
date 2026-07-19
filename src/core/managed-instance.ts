import { createHash, randomUUID } from "node:crypto";

import {
  CatalogEffectUnknownError,
  CatalogWriteError,
  MutationFaultedError,
  type CatalogInstanceRecord,
  type CatalogMutationContext,
  type InstanceCatalogMutationPort,
  validateInstanceStateInvariant,
} from "./catalog.js";
import {
  ExtensionUiBroker,
  type ControllerClaim,
  type ExtensionUiEventType,
  type InteractionResponse,
  type InteractionResult,
} from "./extension-ui-broker.js";
import { RuntimeCompactionKnownFailureError, RuntimeSettingsWriteError } from "./runtime-session.js";
import type {
  CommandDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  SettingValueMap,
  SourceDto,
  ToolDto,
} from "./config-projection.js";
export type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingKey, SettingUpdate, SettingValueMap, SourceDto, ToolDto } from "./config-projection.js";
import type {
  ClearedRuntimeQueue,
  RuntimeCompactionResult,
  RuntimeEvent,
  RuntimeForkResult,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeNavigateOptions,
  RuntimeNavigateResult,
  RuntimeProjectTrust,
  RuntimeReplacementResult,
  RuntimeSession,
  RuntimeSessionMetrics,
  RuntimeToolProjection,
  RuntimeSessionTarget,
  RuntimeThinkingLevel,
} from "./runtime-session.js";
import { MAX_PENDING_QUEUE_ITEMS, MAX_PENDING_QUEUE_TEXT_CHARS } from "./instance-dto.js";
import type {
  AttachProjection,
  CommandReceipt,
  ContentBlockDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  HistoryEntryDto,
  HistoryPageDto,
  InstanceExecution,
  InstanceLifecycle,
  InstanceSnapshot,
  JsonObject,
  JsonValue,
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
  TreePageDto,
} from "./instance-dto.js";
export type {
  AttachProjection,
  CommandReceipt,
  ContentBlockDto,
  DeliveryMode,
  DockEvent,
  EventCursor,
  EventDataMap,
  EventPage,
  ExecutorIdentity,
  HistoryEntryDto,
  HistoryPageDto,
  InstanceExecution,
  InstanceLifecycle,
  InstanceSnapshot,
  JsonObject,
  JsonScalar,
  JsonValue,
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
  TreePageDto,
} from "./instance-dto.js";
export { MAX_PENDING_QUEUE_ITEMS, MAX_PENDING_QUEUE_TEXT_CHARS } from "./instance-dto.js";
import { projectRuntimeNavigateResult, projectRuntimeTree, type ProjectedSessionTree } from "./session-tree.js";

export interface BoundedCollectionProjection<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface ManagedResourceProjection {
  resources: ResourceDto[];
  diagnostics: DiagnosticDto[];
  resourceTotal: number;
  resourcesTruncated: boolean;
  diagnosticTotal: number;
  diagnosticsTruncated: boolean;
}

export interface ManagedInstanceOptions {
  id?: string;
  name?: string;
  cwd: string;
  session: RuntimeSession;
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
}

interface AssistantOutcome {
  stopReason?: string;
  errorMessage?: string;
}

interface PendingAdmission {
  token: object;
  boundary: Promise<void>;
  release: () => void;
}

interface AcceptedPromptMessage {
  operationId: string;
  text: string;
}

interface PendingQueueMessage extends PendingMessageDto {
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
  name: string | undefined;
  cwd: string;
  executor: ExecutorIdentity;
  runtimeGeneration: number;
  agentStartCount: number;
  agentSettledCount: number;
  assistantMessageSequence: number;
  currentAssistantMessageId: string | undefined;
  announcedToolCalls: string[];
  lastAssistantOutcome: AssistantOutcome | undefined;
  stopRequestedWhileRunning: boolean;
  catalogAdmissionOperationId: string | undefined;
  extensionCommandInitiator: { operationId: string; runtimeGeneration: number; agentStartCount: number } | undefined;
  replacementIntent: CatalogInstanceRecord["replacement"];
  durableSessionFile: string | undefined;
  recoverySessionFile: string | undefined;
  lastKnown: CatalogInstanceRecord["lastKnown"];
  interruption: CatalogInstanceRecord["interruption"];
  stopRequestedAt: string | undefined;
  shutdownRequestedAt: string | undefined;
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
    super(`Runtime generation changed from expected ${expected} to ${actual}`);
    this.name = "StaleRuntimeGenerationError";
  }
}

export class InvalidHistoryCursorError extends Error {
  constructor(readonly beforeEntryId: string) {
    super(`History entry ${beforeEntryId} does not belong to the current session branch`);
    this.name = "InvalidHistoryCursorError";
  }
}

export class InvalidTreeCursorError extends Error {
  constructor(message = "Session tree changed; restart pagination from the first page") {
    super(message);
    this.name = "InvalidTreeCursorError";
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

  private readonly session: RuntimeSession;
  private readonly extensionUi: ExtensionUiBroker;
  private nameValue: string | undefined;
  private cwdValue: string;
  private gitBranchValue: string | undefined;
  private readonly executorIdentity: ExecutorIdentity;
  private historyValue: HistoryEntryDto[];
  private metricsValue: SessionMetricsDto;
  private readonly eventCapacity: number;
  private readonly now: () => Date;
  private readonly createCommandId: () => string;
  private readonly eventLog: DockEvent[] = [];
  private readonly subscribers = new Set<(event: DockEvent) => void>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private state: MutableState;
  private catalogPort: InstanceCatalogMutationPort | undefined;
  private committedSnapshotValue: InstanceSnapshot | undefined;
  private catalogAdmissionOperationId: string | undefined;
  private readonly admissionBufferedEvents: RuntimeEvent[] = [];
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
  private transitionTail: Promise<void> = Promise.resolve();
  private historyRefreshTail: Promise<void> = Promise.resolve();
  private treeProjectionCache: { projection: ProjectedSessionTree; indexByEntryId: Map<string, number> } | undefined;
  private hostDrainActive = false;
  private hostDrainPromise: Promise<void> | undefined;
  private runtimeQueueClearAttempted = false;
  private runtimeClearedQueue: ClearedRuntimeQueue = { steering: [], followUp: [] };
  private runtimeAbortPromise: Promise<void> | undefined;
  private runtimeDisposePromise: Promise<void> | undefined;
  private runtimeGenerationValue = 1;
  private publishedRuntimeGenerationValue = 1;
  private nextEventSequence = 1;
  private agentStartCount = 0;
  private agentSettledCount = 0;
  private assistantMessageSequence = 0;
  private currentAssistantMessageId: string | undefined;
  private currentUserMessageId: string | undefined;
  private readonly announcedToolCalls = new Set<string>();
  private readonly acceptedPromptMessages: AcceptedPromptMessage[] = [];
  private readonly pendingQueueMessages: PendingQueueMessage[] = [];
  private runtimeSteeringHashes: string[] = [];
  private runtimeFollowUpHashes: string[] = [];
  private lastAssistantOutcome: AssistantOutcome | undefined;
  private pendingAdmission: PendingAdmission | undefined;
  private extensionCommandInitiator: { operationId: string; runtimeGeneration: number; agentStartCount: number } | undefined;
  private stopRequestedWhileRunning = false;
  private compactionActive = false;
  private compactionRequestOperationId: string | undefined;
  private compactionOperationId: string | undefined;
  private compactionBoundary: Promise<void> | undefined;
  private resolveCompactionBoundary: (() => void) | undefined;
  private compactionStartedBoundary: Promise<boolean> | undefined;
  private resolveCompactionStarted: ((started: boolean) => void) | undefined;
  private configurationPending = false;
  private configurationKind: "general" | "navigation" | "compaction" | undefined;
  private configurationBoundary: Promise<void> | undefined;
  private resolveConfigurationBoundary: (() => void) | undefined;
  private navigationStartedBoundary: Promise<void> | undefined;
  private resolveNavigationStarted: (() => void) | undefined;
  private commandAbortPending = false;
  private commandAbortBoundary: Promise<void> | undefined;
  private resolveCommandAbortBoundary: (() => void) | undefined;
  private queueMutationPending = false;
  private queueMutationBoundary: Promise<void> | undefined;
  private resolveQueueMutationBoundary: (() => void) | undefined;
  private projectionGateTail: Promise<void> = Promise.resolve();
  private releaseConfigurationGate: (() => void) | undefined;
  private stopPromise: Promise<StopReceipt> | undefined;

  get runtimeGeneration(): number { return this.runtimeGenerationValue; }
  get name(): string | undefined { return this.nameValue; }
  get cwd(): string { return this.cwdValue; }

  constructor(options: ManagedInstanceOptions) {
    this.id = options.id ?? randomUUID();
    this.creationOperationId = options.creationOperationId ?? randomUUID();
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.nameValue = options.name;
    this.cwdValue = options.cwd;
    this.session = options.session;
    this.gitBranchValue = projectGitBranch(this.session.getGitBranch?.());
    const requestedCapacity = options.eventCapacity ?? 500;
    this.eventCapacity = Number.isFinite(requestedCapacity) && requestedCapacity >= 1
      ? Math.floor(requestedCapacity)
      : 500;
    this.now = options.now ?? (() => new Date());
    this.createCommandId = options.commandId ?? randomUUID;
    this.extensionUi = options.extensionUiBroker ?? new ExtensionUiBroker(this.now, this.createCommandId);

    const initializedAt = this.timestamp();
    this.createdAt = options.createdAt ?? initializedAt;
    const initialUpdatedAt = initializedAt < this.createdAt ? this.createdAt : initializedAt;
    const initialGeneration = options.initialRuntimeGeneration ?? 1;
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) throw new Error("Initial runtime generation must be positive");
    this.runtimeGenerationValue = initialGeneration;
    this.publishedRuntimeGenerationValue = initialGeneration;
    this.state = {
      lifecycle: "active",
      execution: "idle",
      compacting: false,
      lastRun: "never",
      pendingSteering: 0,
      pendingFollowUp: 0,
      updatedAt: initialUpdatedAt,
    };
    this.executorIdentity = {
      kind: truncate(options.executor?.kind ?? "pi-sdk", 128) ?? "pi-sdk",
      version: truncate(options.executor?.version, 128),
      model: options.executor?.model ? { provider: truncate(options.executor.model.provider, 256) ?? "unknown", id: truncate(options.executor.model.id, 512) ?? "unknown", name: truncate(options.executor.model.name, 256) } : undefined,
      thinkingLevel: options.executor?.thinkingLevel,
      piSessionId: truncate(this.session.sessionId, 128) ?? "unknown",
      sessionFile: truncate(this.session.sessionFile, 16_384),
    };
    this.durableSessionFileValue = this.runtimeDurableSessionFile();
    this.historyValue = this.session.getHistory().map(projectRuntimeHistoryEntry);
    this.metricsValue = projectRuntimeMetrics(this.session.getMetrics());

    this.session.subscribe((event) => this.dispatchRuntimeEvent(event));

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
        executor: this.executorIdentity,
      });
    }
    this.extensionUi.bind({
      generation: () => this.runtimeGenerationValue,
      emit: (type, data) => this.enqueueExtensionUiEvent(type, data),
      projectionChanged: () => this.syncExtensionUiProjection(),
    });
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
      ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
      cwd: snapshot.cwd,
      lifecycle: snapshot.lifecycle,
      execution: snapshot.execution,
      lastRun: snapshot.lastRun,
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
      } catch (error) {
        await this.drainRuntimeWithoutCatalog();
        throw error;
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
    await this.extensionUi.cancelForHostDrain();
    this.hostDrainActive = true;
    await this.transitionTail;
    const admission = this.pendingAdmission;
    this.pendingAdmission = undefined;
    admission?.release();
    try { this.clearRuntimeQueueOnce(); } catch { /* Best-effort non-catalog drain. */ }
    try { await this.abortRuntimeOnce(); } catch { /* Best-effort non-catalog drain. */ }
    try { await this.disposeRuntimeOnce(); } catch { /* Host reports the fatal catalog fault. */ }
  }

  private workingSnapshot(): InstanceSnapshot {
    return {
      id: this.id,
      creationOperationId: this.creationOperationId,
      name: this.name,
      cwd: this.cwd,
      gitBranch: this.gitBranchValue,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      compacting: this.state.compacting,
      lastRun: this.state.lastRun,
      reopenable: (this.state.lifecycle === "host_lost" || this.state.lifecycle === "runtime_error")
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
      eventCursor: this.cursor(this.nextEventSequence - 1),
    };
  }

  eventsSince(since: EventCursor | number = 0): EventPage {
    const domainChanged = typeof since !== "number" && (
      since.hostEpoch !== this.hostEpoch
      || since.instanceId !== this.id
      || since.runtimeGeneration !== this.publishedRuntimeGenerationValue
    );
    const sequence = domainChanged ? 0 : typeof since === "number" ? since : since.sequence;
    const earliestSequence = this.eventLog[0]?.sequence ?? this.nextEventSequence;
    const latestSequence = this.nextEventSequence - 1;
    return {
      events: this.eventLog
        .filter((event) => event.sequence > sequence)
        .map((event) => cloneDockEvent(event)),
      earliest: this.cursor(earliestSequence),
      latest: this.cursor(latestSequence),
      truncated: domainChanged || sequence < earliestSequence - 1,
    };
  }

  subscribe(listener: (event: DockEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  reportControlDegradation(message: string): Promise<DockEvent> {
    return this.enqueueTransition(async () => cloneDockEvent(this.appendEvent("extension.error", {
      error: safeWireText(message, 2_048, "Control stream degraded"),
    })));
  }

  claimInteractionController(): Promise<ControllerClaim> {
    this.assertActive();
    return this.extensionUi.claimController();
  }

  releaseInteractionController(leaseToken: string, reason: "detach" | "host_draining" = "detach"): Promise<void> {
    return this.extensionUi.releaseController(leaseToken, reason);
  }

  respondInteraction(leaseToken: string, interactionId: string, response: InteractionResponse): Promise<InteractionResult> {
    this.assertActive();
    return this.extensionUi.respond(leaseToken, interactionId, response);
  }

  setToolsExpanded(expanded: boolean, expectedRuntimeGeneration: number): InstanceSnapshot {
    this.assertActive();
    if (expectedRuntimeGeneration !== this.runtimeGenerationValue) {
      throw new StaleRuntimeGenerationError(expectedRuntimeGeneration, this.runtimeGenerationValue);
    }
    if (this.extensionUi.isSuspended()) throw new InstanceBusyError(this.id, "changing tool expansion during session replacement");
    this.extensionUi.setToolsExpanded(expanded);
    return this.snapshot();
  }

  cancelInteractionsForHostDrain(): Promise<void> {
    return this.extensionUi.cancelForHostDrain();
  }

  synchronizeModelState(): void {
    this.applyModelState(this.session.getModelState());
  }

  async listModels(): Promise<{ models: RuntimeModelInfo[]; state: RuntimeModelState; total: number; truncated: boolean }> {
    return this.withProjectionRead(async () => {
      const source = (await this.session.listModels()).map((model) => ({
        ...model,
        provider: truncate(model.provider, 256) ?? "unknown",
        id: truncate(model.id, 512) ?? "unknown",
        name: truncate(model.name, 256) ?? "unknown",
      }));
      const projected = boundedCollectionProjection(source);
      return { models: projected.items, state: this.session.getModelState(), total: projected.total, truncated: projected.truncated };
    });
  }

  async listSessions(scope: "cwd" | "all"): Promise<{ sessions: SessionDto[]; total: number; truncated: boolean }> {
    return this.withProjectionRead(async () => {
      const source = (await this.session.listSessions(scope)).map((session) => ({
        sessionId: truncate(session.sessionId, 128) ?? "unknown",
        sessionFile: truncate(session.sessionFile, 16_384) ?? "",
        ...(session.name === undefined ? {} : { name: truncate(session.name, 256) ?? "" }),
        cwd: truncate(session.cwd, 16_384) ?? "",
        ...(isIsoTimestamp(session.updatedAt) ? { updatedAt: session.updatedAt } : {}),
      }));
      const projected = boundedCollectionProjection(source);
      return { sessions: projected.items, total: projected.total, truncated: projected.truncated };
    });
  }

  async getHistoryPage(beforeEntryId: string | undefined, limit: number): Promise<HistoryPageDto & { instance: InstanceSnapshot }> {
    return this.withCommittedProjectionRead(() => ({ ...this.buildHistoryPage(beforeEntryId, limit), instance: this.snapshot() }));
  }

  async getTreePage(
    treeRevision: string | undefined,
    afterEntryId: string | undefined,
    limit: number,
  ): Promise<TreePageDto> {
    return this.withProjectionRead(async () => {
      if ((treeRevision === undefined) !== (afterEntryId === undefined)) {
        throw new InvalidTreeCursorError("Tree continuation requires both treeRevision and afterEntryId");
      }
      const tree = this.currentTreeProjection(treeRevision === undefined);
      if (treeRevision !== undefined && treeRevision !== tree.treeRevision) throw new InvalidTreeCursorError();
      let start = 0;
      if (afterEntryId !== undefined) {
        const index = this.treeProjectionCache?.indexByEntryId.get(afterEntryId);
        if (index === undefined) throw new InvalidTreeCursorError("Tree continuation entry does not belong to this revision");
        start = index + 1;
      }
      const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
      const nodes = cloneJson(tree.nodes.slice(start, start + boundedLimit));
      const truncated = start + nodes.length < tree.nodes.length;
      return {
        treeRevision: tree.treeRevision,
        nodes,
        ...(tree.leafId === undefined ? {} : { leafId: tree.leafId }),
        total: tree.nodes.length,
        truncated,
        ...(truncated && nodes.length > 0 ? { nextAfterEntryId: nodes[nodes.length - 1]?.entryId } : {}),
      };
    });
  }

  async navigateSession(
    operationId: string,
    targetId: string,
    options: RuntimeNavigateOptions = {},
  ): Promise<RuntimeNavigateResult> {
    let configurationStarted = false;
    let runtimeCalled = false;
    try {
      await this.beginConfiguration("navigating the session tree", { kind: "navigation" });
      configurationStarted = true;
      if (!this.session.navigateTree) throw new Error("Runtime does not support session tree navigation");
      if (!this.currentTreeProjection(true).nodes.some((node) => node.entryId === targetId)) {
        throw new InvalidTreeCursorError("Navigation target does not belong to the current session tree");
      }
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const pending = this.session.navigateTree(targetId, cloneJson(options));
      this.resolveNavigationStarted?.();
      const result = projectRuntimeNavigateResult(await pending);
      await this.closeRuntimeOperationBoundary(operationId);
      if (result.cancelled) return result;
      const tree = this.currentTreeProjection(true);
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "session.navigate", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
        () => {
          this.refreshHistory();
          this.refreshMetrics();
          this.appendEvent("session.navigated", {
            targetId,
            ...(tree.leafId === undefined ? {} : { leafId: tree.leafId }),
            treeRevision: tree.treeRevision,
            summaryCreated: result.summaryCreated,
          });
        },
      ));
      return result;
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (configurationStarted) this.endConfiguration();
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
      const history = this.buildHistoryPage(undefined, historyLimit);
      const page = replayPurpose === "conversation_bootstrap"
        ? { ...sourcePage, events: conversationBootstrapEvents(
          sourcePage.events,
          this.historyValue,
          instance,
          sourcePage.truncated,
          this.session.isStreaming,
        ) }
        : replayPurpose === "legacy_history_overlay"
          ? { ...sourcePage, events: eventsNotCoveredByHistory(sourcePage.events, this.historyValue) }
          : sourcePage;
      return {
        instance,
        page,
        recentHistory: history.entries,
        historyTruncated: history.hasEarlier,
        pendingMessages: this.pendingMessagesProjection(),
        replaySince,
        epochChanged,
        generationChanged,
      };
    });
  }

  async listTools(): Promise<{ tools: ToolDto[]; total: number; truncated: boolean }> {
    return this.withProjectionRead(async () => boundedRuntimeToolProjection(await this.session.listTools()));
  }

  async setActiveTools(names: string[], operationId = this.createCommandId()): Promise<{ tools: ToolDto[]; total: number; truncated: boolean }> {
    await this.beginConfiguration("changing active tools", { admission: "live" });
    try {
      const projected = boundedRuntimeToolProjection(await this.session.setActiveTools([...names]));
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "tool.set_active", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
      ));
      return projected;
    } finally {
      this.endConfiguration();
    }
  }

  async getSettings(): Promise<SettingDto[]> {
    return this.withProjectionRead(async () => cloneJson(await this.session.getSettings()));
  }

  async updateSetting(update: SettingUpdate, operationId = this.createCommandId()): Promise<SettingDto> {
    await this.beginConfiguration(`changing ${update.key}`, { admission: settingAdmission(update.key) });
    try {
      const setting = cloneJson(await this.session.updateSetting(cloneJson(update)));
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "settings.update", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
        () => this.appendSettingChanged(setting, false),
      ));
      return setting;
    } catch (error) {
      if (error instanceof RuntimeSettingsWriteError) {
        if (error.mutationApplied && error.setting !== "model" && error.setting !== "thinking") {
          const current = await this.session.getSettings().catch(() => undefined);
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
      this.endConfiguration();
    }
  }

  async getResources(): Promise<ManagedResourceProjection> {
    return this.withProjectionRead(async () => {
      const result = cloneJson(await this.session.getResources());
      const resources = boundedCollectionProjection(result.resources, 350_000);
      const diagnostics = boundedCollectionProjection(result.diagnostics, 200_000);
      const resourceTotal = result.resourceTotal ?? resources.total;
      const diagnosticTotal = result.diagnosticTotal ?? diagnostics.total;
      return {
        resources: resources.items,
        diagnostics: diagnostics.items,
        resourceTotal,
        resourcesTruncated: result.resourcesTruncated === true || resources.truncated || resources.items.length < resourceTotal,
        diagnosticTotal,
        diagnosticsTruncated: result.diagnosticsTruncated === true || diagnostics.truncated || diagnostics.items.length < diagnosticTotal,
      };
    });
  }

  async getCommands(prefix?: string): Promise<{ commands: CommandDto[]; total: number; truncated: boolean }> {
    return this.withProjectionRead(async () => {
      const commands = cloneJson(await this.session.getCommands())
        .filter((command) => prefix === undefined || command.name.startsWith(prefix));
      const projected = boundedCollectionProjection(commands);
      return { commands: projected.items, total: projected.total, truncated: projected.truncated };
    });
  }

  async resolveSessionTarget(sessionFile: string): Promise<RuntimeSessionTarget> {
    return this.withProjectionRead(async () => {
      if (!this.session.resolveSessionTarget) throw new Error("Runtime does not support session target resolution");
      return cloneJson(await this.session.resolveSessionTarget(sessionFile));
    });
  }

  async newSession(operationId: string, parentSession?: string): Promise<RuntimeReplacementResult> {
    return this.replaceRuntime("creating a new session", operationId, "new", {}, async () => {
      if (!this.session.newSession) throw new Error("Runtime does not support session replacement");
      return this.session.newSession(operationId, parentSession);
    });
  }

  async switchSession(
    operationId: string,
    sessionFile: string,
    trust: RuntimeProjectTrust,
  ): Promise<RuntimeReplacementResult> {
    return this.replaceRuntime("switching session", operationId, "switch", { requestedSessionFile: sessionFile }, async () => {
      if (!this.session.switchSession) throw new Error("Runtime does not support session replacement");
      return this.session.switchSession(operationId, sessionFile, trust);
    });
  }

  async forkSession(operationId: string, entryId: string): Promise<RuntimeForkResult> {
    if (!this.session.fork) throw new Error("Runtime does not support session forking");
    return this.replaceRuntime("forking session", operationId, "fork", { requestedEntryId: entryId }, async () => (
      this.session.fork!(operationId, entryId, "before", "fork")
    ), () => {
      const target = this.currentTreeProjection(true).nodes.find((node) => node.entryId === entryId);
      if (target?.kind !== "message" || target.role !== "user") {
        throw new InvalidTreeCursorError("Fork target must be a user message in the current session tree");
      }
    });
  }

  async cloneSession(operationId: string, entryId: string): Promise<RuntimeReplacementResult> {
    if (!this.session.fork) throw new Error("Runtime does not support session cloning");
    return this.replaceRuntime("cloning session", operationId, "clone", { requestedEntryId: entryId }, async () => {
      const result = await this.session.fork!(operationId, entryId, "at", "clone");
      return { cancelled: result.cancelled };
    }, () => {
      const tree = this.currentTreeProjection(true);
      if (tree.leafId !== entryId) throw new InvalidTreeCursorError("Clone entry must be the current session leaf");
    });
  }

  async setSessionName(operationId: string, name: string): Promise<void> {
    await this.beginConfiguration("naming the session", { admission: "live" });
    let runtimeCalled = false;
    try {
      if (!this.session.setSessionName) throw new Error("Runtime does not support session naming");
      this.sessionNameOperationId = operationId;
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const actualName = this.session.setSessionName(name);
      await this.closeRuntimeOperationBoundary(operationId);
      if (this.nameValue !== actualName) throw new Error("Runtime completed session naming without publishing session_info_changed");
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (this.sessionNameOperationId === operationId) this.sessionNameOperationId = undefined;
      this.endConfiguration();
    }
  }

  async compactSession(operationId: string, customInstructions?: string): Promise<SessionCompactionDto> {
    await this.beginConfiguration("compacting the session", { admission: "run_preempting", kind: "compaction" });
    let runtimeCalled = false;
    try {
      if (!this.session.compact) throw new Error("Runtime does not support compaction");
      this.compactionRequestOperationId = operationId;
      this.receiptBoundaryOperationId = operationId;
      runtimeCalled = true;
      const result = projectCompactionResult(await this.session.compact(customInstructions));
      await this.closeRuntimeOperationBoundary(operationId);
      return result;
    } catch (error) {
      await this.closeRuntimeOperationBoundary(operationId).catch(() => {});
      if (runtimeCalled && !isKnownMutationBoundaryError(error)) throw new RuntimeEffectUnknownError(operationId, error);
      throw error;
    } finally {
      if (this.compactionRequestOperationId === operationId) this.compactionRequestOperationId = undefined;
      this.endConfiguration();
    }
  }

  async reloadSession(operationId: string): Promise<RuntimeReplacementResult> {
    const result = await this.replaceRuntime("reloading resources", operationId, "reload", {}, async () => {
      if (!this.session.reload) throw new Error("Runtime does not support reload");
      return this.session.reload(operationId);
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

  async selectModel(provider: string, modelId: string, operationId = this.createCommandId()): Promise<RuntimeModelState> {
    await this.beginConfiguration("switching model", { admission: "live" });
    try {
      const state = await this.session.selectModel(provider, modelId);
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "model.set", effect: "post_effect", operationId, instanceId: this.id },
        () => { this.applyModelState(state); this.touch(); },
        () => this.appendModelChanged(state),
      ));
      return state;
    } catch (error) {
      if (error instanceof RuntimeSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.session.getModelState();
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
      this.endConfiguration();
    }
  }

  async setThinkingLevel(level: RuntimeThinkingLevel, operationId = this.createCommandId()): Promise<RuntimeModelState> {
    await this.beginConfiguration("changing thinking level", { admission: "live" });
    try {
      const state = await this.session.setThinkingLevel(level);
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "thinking.set", effect: "post_effect", operationId, instanceId: this.id },
        () => { this.applyModelState(state); this.touch(); },
        () => this.appendThinkingChanged(level, state),
      ));
      return state;
    } catch (error) {
      if (error instanceof RuntimeSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.session.getModelState();
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: "thinking.set", effect: "post_effect", operationId, instanceId: this.id },
            () => { this.applyModelState(state); this.touch(); },
            () => { this.appendThinkingChanged(level, state); this.appendSettingsWriteFailed(error); },
          ));
        } else {
          await this.enqueueTransition(async () => { this.appendSettingsWriteFailed(error); });
        }
      }
      throw error;
    } finally {
      this.endConfiguration();
    }
  }

  async submit(message: string, delivery: DeliveryMode = "auto", operationId = this.createCommandId()): Promise<CommandReceipt> {
    this.assertActive();
    if (this.pendingAdmission) throw new InstanceAdmissionPendingError(this.id);
    if (this.configurationPending || this.commandAbortPending || this.queueMutationPending) throw new InstanceBusyError(this.id, "submitting a prompt");
    if (message.trim().length === 0) {
      throw new Error("Prompt message must not be empty");
    }

    if (this.session.classifyInput(message) === "extension_command") {
      return this.submitExtensionCommand(message, operationId);
    }

    const running = this.state.execution === "running" || this.session.isStreaming;
    const resolvedDelivery = resolveDelivery(delivery, running);
    const streamingBehavior = resolvedDelivery === "steer" || resolvedDelivery === "followUp"
      ? resolvedDelivery
      : undefined;
    if (streamingBehavior !== undefined && !this.canQueueMessage(message)) throw new QueueCapacityError();
    let actualDelivery = resolvedDelivery;
    let actuallyQueued = streamingBehavior !== undefined;
    const commandId = operationId;
    const agentStartsBeforeCommand = this.agentStartCount;
    const agentSettlesBeforeCommand = this.agentSettledCount;
    const admissionToken = {};

    let releaseAdmission!: () => void;
    const admissionBoundary = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    this.pendingAdmission = {
      token: admissionToken,
      boundary: admissionBoundary,
      release: releaseAdmission,
    };
    this.catalogAdmissionOperationId = commandId;
    try {
      const admissionCommit = this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.admission", effect: "pre_effect", operationId: commandId, instanceId: this.id },
        () => {},
      ));
      if (this.catalogPort) await admissionCommit;
    } catch (error) {
      this.catalogAdmissionOperationId = undefined;
      this.pendingAdmission = undefined;
      releaseAdmission();
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

    const release = (): void => {
      if (this.pendingAdmission?.token !== admissionToken) return;
      const admission = this.pendingAdmission;
      this.pendingAdmission = undefined;
      admission.release();
    };

    let preflightTransition: Promise<void> | undefined;
    const rejectBeforeRun = async (error: unknown, reason: string): Promise<void> => {
      if (preflightStatus === "accepted" || (preflightStatus === "rejected" && receiptSettled)) return;
      preflightStatus = "rejected";
      const messageText = safeWireText(errorMessage(error), 2_048, "Sensitive command error omitted");
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
        const bufferedEvents = this.flushAdmissionRuntimeEvents();
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

    const onPreflight = (success: boolean): void => {
      if (preflightStatus !== "pending" || this.pendingAdmission?.token !== admissionToken) return;
      if (!success) {
        preflightStatus = "rejected";
        return;
      }
      if (this.state.lifecycle !== "active") {
        const error = new InstanceNotActiveError(this.id, this.state.lifecycle);
        preflightTransition = rejectBeforeRun(error, "instance_not_active_after_preflight");
        return;
      }

      preflightStatus = "accepted";
      // Pi re-checks isStreaming only after asynchronous extension input hooks.
      // Queue and fresh-prompt events are serialized behind this accepted commit.
      let precedingRuntimeEvents = Promise.resolve();
      if (streamingBehavior !== undefined && !this.session.isStreaming) {
        actualDelivery = "prompt";
        actuallyQueued = false;
        // Events buffered while asynchronous input hooks were running belong
        // to the run that just settled. Commit them before assigning the fresh
        // prompt's operation ID so the old settlement cannot clear the new run.
        this.catalogAdmissionOperationId = undefined;
        precedingRuntimeEvents = this.flushAdmissionRuntimeEvents();
      }

      const acceptedAt = this.timestamp();
      const pendingMessage: PendingQueueMessage | undefined = actuallyQueued
        ? {
          queueItemId: randomUUID(),
          operationId: commandId,
          delivery: actualDelivery === "followUp" ? "followUp" : "steer",
          text: safeWireText(message, MAX_PENDING_QUEUE_TEXT_CHARS, "Queued message omitted"),
          acceptedAt,
        }
        : undefined;
      if (pendingMessage) {
        this.pendingQueueMessages.push(pendingMessage);
        this.assignPendingRuntimeHashes(pendingMessage.delivery, pendingMessage.delivery === "steer" ? this.runtimeSteeringHashes : this.runtimeFollowUpHashes);
      } else this.acceptedPromptMessages.push({ operationId: commandId, text: message });
      const acceptedTransition = this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.accepted", effect: "post_effect", operationId: commandId, instanceId: this.id },
        () => {
          this.catalogAdmissionOperationId = undefined;
          this.state.lastError = undefined;
          if (!actuallyQueued) {
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
          this.appendStateEvent("command_accepted", acceptedAt);
        },
      ));
      preflightTransition = Promise.all([precedingRuntimeEvents, acceptedTransition]).then(() => {});
      this.catalogAdmissionOperationId = undefined;
      this.receiptBoundaryOperationId = commandId;
      const bufferedEvents = this.flushAdmissionRuntimeEvents();
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
            kind: "prompt",
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

    let runtimePromise: Promise<void>;
    try {
      runtimePromise = this.session.prompt(message, {
        streamingBehavior,
        source: "rpc",
        preflightResult: onPreflight,
      });
    } catch (error) {
      await rejectBeforeRun(error, "prompt_threw_before_preflight");
      return receiptPromise;
    }

    const observedPromise = runtimePromise.then(async () => {
      // Defensive fallback for adapters that resolve without invoking the typed
      // preflight callback. The official Pi adapter always invokes it.
      if (preflightStatus === "pending") onPreflight(true);
      await preflightTransition;
      if (
        preflightStatus === "accepted"
        && !actuallyQueued
        && this.state.lifecycle === "active"
        && this.state.execution === "running"
        && this.agentStartCount === agentStartsBeforeCommand
        && !this.session.isStreaming
      ) {
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.no_run", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => {
            this.state.execution = "idle";
            this.state.activeCommandId = undefined;
            this.touch();
          },
          () => {
            this.discardAcceptedPrompt(commandId);
            this.appendEvent("command.handled", { operationId: commandId, kind: "no_run" });
            this.appendStateEvent("command_handled_without_run");
          },
        ));
      }
    }).catch(async (error: unknown) => {
      const messageText = safeWireText(errorMessage(error), 2_048, "Sensitive command error omitted");
      if (preflightStatus !== "accepted") {
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
      // Pi 0.80.6 emits agent_settled from _runAgentPrompt.finally before the
      // prompt Promise rejects. Only project a fallback failure if that public
      // lifecycle guarantee was not observed at all.
      if (
        this.state.lifecycle === "active"
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

  private async submitExtensionCommand(message: string, operationId: string): Promise<CommandReceipt> {
    const commandId = operationId;
    const admissionToken = {};
    let releaseAdmission!: () => void;
    const admissionBoundary = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const release = (): void => {
      if (this.pendingAdmission?.token !== admissionToken) return;
      const admission = this.pendingAdmission;
      this.pendingAdmission = undefined;
      admission.release();
    };
    this.pendingAdmission = { token: admissionToken, boundary: admissionBoundary, release: releaseAdmission };
    this.catalogAdmissionOperationId = commandId;

    try {
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.admission", effect: "pre_effect", operationId: commandId, instanceId: this.id },
        () => {},
      ));
      this.catalogAdmissionOperationId = undefined;
      await this.flushAdmissionRuntimeEvents();
      if (this.session.classifyInput(message) !== "extension_command") {
        const error = new Error("Registered extension command changed during admission");
        const rejectedAt = this.timestamp();
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.rejected", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => {
            this.state.lastError = error.message;
            this.touch(rejectedAt);
          },
          () => {
            this.appendEvent("command.rejected", { operationId: commandId, reason: "command_catalog_changed", error: error.message }, rejectedAt);
            this.appendStateEvent("command_rejected", rejectedAt);
          },
        ));
        throw error;
      }

      const acceptedAt = this.timestamp();
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "command.accepted", effect: "pre_effect", operationId: commandId, instanceId: this.id },
        () => {
          this.state.lastError = undefined;
          this.touch(acceptedAt);
        },
        () => {
          this.appendEvent("command.accepted", {
            operationId: commandId,
            delivery: "prompt",
            queued: false,
            acceptedAt,
          }, acceptedAt);
          this.appendStateEvent("extension_command_accepted", acceptedAt);
        },
      ));

      const runtimeGeneration = this.runtimeGenerationValue;
      const agentStartsBeforeCommand = this.agentStartCount;
      const parentRunning = this.state.execution === "running" || this.session.isStreaming;
      if (!parentRunning) {
        this.extensionCommandInitiator = { operationId: commandId, runtimeGeneration, agentStartCount: agentStartsBeforeCommand };
      }

      let runtimePromise: Promise<void>;
      try {
        runtimePromise = this.session.prompt(message, { source: "rpc" });
      } catch (error) {
        runtimePromise = Promise.reject(error);
      }
      const observedPromise = runtimePromise.then(async () => {
        await Promise.resolve();
        await this.transitionTail;
        if (this.runtimeGenerationValue !== runtimeGeneration || this.state.lifecycle !== "active") return;
        const commandStartedRun = this.agentStartCount > agentStartsBeforeCommand
          || (!parentRunning && this.session.isStreaming);
        if (this.extensionCommandInitiator?.operationId === commandId) this.extensionCommandInitiator = undefined;
        if (commandStartedRun) return;
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "command.handled", effect: "post_effect", operationId: commandId, instanceId: this.id },
          () => { this.touch(); },
          () => {
            this.appendEvent("command.handled", { operationId: commandId, kind: "extension_command" });
            this.appendStateEvent("extension_command_handled");
          },
        ));
      }).catch(async (error: unknown) => {
        if (this.runtimeGenerationValue !== runtimeGeneration || this.state.lifecycle !== "active") return;
        if (this.extensionCommandInitiator?.operationId === commandId) this.extensionCommandInitiator = undefined;
        if (this.catalogPort) {
          try { this.catalogPort.assertWritable(); } catch { return; }
        }
        const messageText = safeWireText(errorMessage(error), 2_048, "Sensitive command error omitted");
        await this.enqueueTransition(async () => {
          this.appendEvent("instance.error", { operationId: commandId, source: "command_background", error: messageText });
        });
      });

      let trackedPromise!: Promise<void>;
      trackedPromise = observedPromise.finally(() => {
        release();
        this.backgroundTasks.delete(trackedPromise);
      });
      this.backgroundTasks.add(trackedPromise);
      return {
        accepted: true,
        instanceId: this.id,
        operationId: commandId,
        kind: "extension_command",
        delivery: "prompt",
        queued: false,
        acceptedAt,
      };
    } catch (error) {
      this.catalogAdmissionOperationId = undefined;
      void this.flushAdmissionRuntimeEvents().catch(() => {});
      release();
      throw error;
    }
  }

  async dequeue(operationId = this.createCommandId()): Promise<QueueDequeueReceipt> {
    this.catalogPort?.assertWritable();
    this.assertActive();
    if (this.queueMutationPending || this.commandAbortPending || this.configurationPending) {
      throw new InstanceBusyError(this.id, "restoring queued messages");
    }
    if (this.pendingAdmission) throw new InstanceAdmissionPendingError(this.id);
    this.queueMutationPending = true;
    this.queueMutationBoundary = new Promise<void>((resolve) => { this.resolveQueueMutationBoundary = resolve; });
    const reservation = this.reserveProjectionGate();
    try {
      await reservation.entered;
      await this.transitionTail;
      this.catalogPort?.assertWritable();
      this.assertActive();
      const pendingBefore = [...this.pendingQueueMessages];
      if (pendingBefore.length === 0 && this.state.pendingSteering === 0 && this.state.pendingFollowUp === 0) {
        return { operationId, instanceId: this.id, restored: [], inFlight: [] };
      }

      this.receiptBoundaryOperationId = operationId;
      try {
        const cleared = this.session.clearQueue();
        await this.closeRuntimeOperationBoundary(operationId);
        const selection = selectClearedQueueMessages(pendingBefore, cleared, this.timestamp());
        const restoredIds = new Set(selection.restoredQueueItemIds);
        const retainedIds = new Set(pendingBefore.filter((item) => !restoredIds.has(item.queueItemId)).map((item) => item.queueItemId));
        const restored = selection.restored;
        let inFlight: PendingMessageDto[] = [];
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: "queue.dequeue", effect: "post_effect", operationId, instanceId: this.id },
          () => {
            const retained = this.pendingQueueMessages.filter((item) => retainedIds.has(item.queueItemId));
            this.pendingQueueMessages.splice(0, this.pendingQueueMessages.length, ...retained);
            inFlight = pendingMessageProjection(retained);
            this.runtimeSteeringHashes = [];
            this.runtimeFollowUpHashes = [];
            this.state.pendingSteering = 0;
            this.state.pendingFollowUp = 0;
            this.touch();
          },
          () => this.appendEvent("queue.cleared", {
            steering: restored.filter((item) => item.delivery === "steer").length,
            followUp: restored.filter((item) => item.delivery === "followUp").length,
            total: restored.length,
            queueItemIds: selection.restoredQueueItemIds,
            reason: "dequeued",
          }),
        ));
        return { operationId, instanceId: this.id, restored, inFlight };
      } catch (error) {
        try { await this.closeRuntimeOperationBoundary(operationId); }
        catch (transitionError) { throw transitionError; }
        if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError) throw error;
        throw new RuntimeEffectUnknownError(operationId, error);
      } finally {
        if (this.receiptBoundaryOperationId === operationId) this.receiptBoundaryOperationId = undefined;
      }
    } finally {
      reservation.release();
      this.queueMutationPending = false;
      this.resolveQueueMutationBoundary?.();
      this.resolveQueueMutationBoundary = undefined;
      this.queueMutationBoundary = undefined;
    }
  }

  async abort(operationId = this.createCommandId()): Promise<void> {
    this.catalogPort?.assertWritable();
    this.assertActive();
    if (this.commandAbortPending || this.queueMutationPending) throw new InstanceBusyError(this.id, "aborting the current run");
    if (this.configurationKind === "navigation") return this.abortTreeNavigation(operationId);
    if (this.configurationKind === "compaction") return this.abortCompactionConfiguration(operationId);
    this.commandAbortPending = true;
    this.commandAbortBoundary = new Promise<void>((resolve) => { this.resolveCommandAbortBoundary = resolve; });
    const reservation = this.reserveProjectionGate();
    try {
      await reservation.entered;
      await this.transitionTail;
      this.catalogPort?.assertWritable();
      this.assertActive();
      if (this.pendingAdmission) throw new InstanceAdmissionPendingError(this.id);
      if (this.configurationPending) throw new InstanceBusyError(this.id, "aborting the current run");
      if (this.state.execution !== "running" && !this.session.isStreaming) return;

      this.receiptBoundaryOperationId = operationId;
      try {
        await this.session.abort();
        await this.session.waitForIdle();
        const compactionBoundary = this.compactionBoundary;
        if (compactionBoundary) await compactionBoundary;
        await this.closeRuntimeOperationBoundary(operationId);
        if (this.state.execution === "running" && !this.session.isStreaming) {
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
        if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError) throw error;
        throw new RuntimeEffectUnknownError(operationId, error);
      } finally {
        if (this.receiptBoundaryOperationId === operationId) this.receiptBoundaryOperationId = undefined;
      }
    } finally {
      reservation.release();
      this.commandAbortPending = false;
      this.resolveCommandAbortBoundary?.();
      this.resolveCommandAbortBoundary = undefined;
      this.commandAbortBoundary = undefined;
    }
  }

  private async abortCompactionConfiguration(operationId: string): Promise<void> {
    this.commandAbortPending = true;
    this.commandAbortBoundary = new Promise<void>((resolve) => { this.resolveCommandAbortBoundary = resolve; });
    const configurationBoundary = this.configurationBoundary;
    const compactionStartedBoundary = this.compactionStartedBoundary;
    try {
      const started = compactionStartedBoundary ? await compactionStartedBoundary : this.compactionActive;
      if (started && this.compactionActive) await this.session.abort();
      if (configurationBoundary) await configurationBoundary;
      await this.transitionTail;
    } catch (error) {
      if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError) throw error;
      throw new RuntimeEffectUnknownError(operationId, error);
    } finally {
      this.commandAbortPending = false;
      this.resolveCommandAbortBoundary?.();
      this.resolveCommandAbortBoundary = undefined;
      this.commandAbortBoundary = undefined;
    }
  }

  private async abortTreeNavigation(operationId: string): Promise<void> {
    this.commandAbortPending = true;
    this.commandAbortBoundary = new Promise<void>((resolve) => { this.resolveCommandAbortBoundary = resolve; });
    try {
      await this.navigationStartedBoundary;
      await this.session.abort();
      await this.configurationBoundary;
    } catch (error) {
      if (error instanceof CatalogEffectUnknownError || error instanceof CatalogWriteError || error instanceof MutationFaultedError) throw error;
      throw new RuntimeEffectUnknownError(operationId, error);
    } finally {
      this.commandAbortPending = false;
      this.resolveCommandAbortBoundary?.();
      this.resolveCommandAbortBoundary = undefined;
      this.commandAbortBoundary = undefined;
    }
  }

  async waitForIdle(): Promise<void> {
    await this.session.waitForIdle();
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
    if (this.stopPromise) {
      const first = await this.stopPromise;
      return {
        operationId,
        instanceId: this.id,
        stopped: true,
        alreadyStopped: true,
        ...(first.cleanupErrors === undefined ? {} : { cleanupErrors: [...first.cleanupErrors] }),
      };
    }

    const task = this.beginStop(operationId);
    this.stopPromise = task;
    return task;
  }

  private async beginStop(operationId: string): Promise<StopReceipt> {
    const configurationBoundary = this.configurationBoundary;
    const preemptingCompaction = configurationBoundary !== undefined && this.configurationKind === "compaction";
    const compactionStartedBoundary = preemptingCompaction ? this.compactionStartedBoundary : undefined;
    if (configurationBoundary && !preemptingCompaction) await configurationBoundary;
    const commandAbortBoundary = this.commandAbortBoundary;
    if (commandAbortBoundary) await commandAbortBoundary;
    const queueMutationBoundary = this.queueMutationBoundary;
    if (queueMutationBoundary) await queueMutationBoundary;
    const admissionBoundary = this.pendingAdmission?.boundary;
    const requestedAt = this.timestamp();
    try {
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "instance.stop.intent", effect: "pre_effect", operationId, instanceId: this.id },
        () => {
          this.stopRequestedWhileRunning = this.state.execution === "running" || this.session.isStreaming;
          this.stopRequestedAt = requestedAt;
          this.state.lifecycle = "stopping";
          this.touch(requestedAt);
        },
        () => this.appendStateEvent("stop_requested", requestedAt),
      ));
    } catch (error) {
      this.stopPromise = undefined;
      throw error;
    }
    return this.performStop(operationId, admissionBoundary, preemptingCompaction ? configurationBoundary : undefined, compactionStartedBoundary);
  }

  recordExtensionError(error: unknown): void {
    if (this.hostDrainActive) return;
    this.appendEvent("extension.error", { error: safeWireText(errorMessage(error), 2_048, "Sensitive error payload omitted") });
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

  private async performStop(operationId: string, admissionBoundary?: Promise<void>, configurationBoundary?: Promise<void>, compactionStartedBoundary?: Promise<boolean>): Promise<StopReceipt> {
    const cleanupErrors: string[] = [];
    const pendingQueueItemIds = this.pendingQueueMessages.map((item) => item.queueItemId);
    await this.extensionUi.cancelForHostDrain();
    let clearedCounts: { steering: number; followUp: number } | undefined;
    const captureCleanupError = (stage: string, error: unknown): void => {
      const message = safeWireText(`${stage}: ${errorMessage(error)}`, 2_048, `${stage}: sensitive cleanup error omitted`);
      cleanupErrors.push(message);
    };

    if (admissionBoundary) {
      try { await admissionBoundary; }
      catch (error) { captureCleanupError("preflight", error); }
    }

    try {
      const cleared = this.clearRuntimeQueueOnce();
      clearedCounts = { steering: cleared.steering.length, followUp: cleared.followUp.length };
    } catch (error) {
      captureCleanupError("clearQueue", error);
    }

    if (compactionStartedBoundary) {
      try { await compactionStartedBoundary; }
      catch (error) { captureCleanupError("compactionStart", error); }
    }

    let abortSucceeded = false;
    try {
      await this.abortRuntimeOnce();
      abortSucceeded = true;
    } catch (error) {
      captureCleanupError("abort", error);
    }

    if (configurationBoundary) {
      try { await configurationBoundary; }
      catch (error) { captureCleanupError("configuration", error); }
    }

    if (abortSucceeded && this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    await this.transitionTail;

    try { await this.disposeRuntimeOnce(); }
    catch (error) { captureCleanupError("dispose", error); }

    await this.enqueueTransition(() => this.commitCatalogTransition(
      { kind: "instance.stop.complete", effect: "post_effect", operationId, instanceId: this.id },
      () => {
        this.catalogAdmissionOperationId = undefined;
        this.state.lifecycle = "stopped";
        this.state.execution = "unavailable";
        this.state.compacting = false;
        this.state.activeCommandId = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        this.acceptedPromptMessages.length = 0;
        this.pendingQueueMessages.length = 0;
        this.runtimeSteeringHashes = [];
        this.runtimeFollowUpHashes = [];
        this.recoverySessionFile = undefined;
        this.lastKnownValue = undefined;
        this.interruptionValue = undefined;
        this.shutdownRequestedAt = undefined;
        if (cleanupErrors.length > 0) this.state.lastError = cleanupErrors.join("; ");
        this.touch();
      },
      () => {
        if (clearedCounts && (clearedCounts.steering > 0 || clearedCounts.followUp > 0)) {
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

  private clearRuntimeQueueOnce(): ClearedRuntimeQueue {
    if (this.runtimeQueueClearAttempted) return this.runtimeClearedQueue;
    this.runtimeQueueClearAttempted = true;
    this.runtimeClearedQueue = this.session.clearQueue();
    return this.runtimeClearedQueue;
  }

  private abortRuntimeOnce(): Promise<void> {
    if (!this.runtimeAbortPromise) {
      try { this.runtimeAbortPromise = Promise.resolve(this.session.abort()); }
      catch (error) { this.runtimeAbortPromise = Promise.reject(error); }
    }
    return this.runtimeAbortPromise;
  }

  private disposeRuntimeOnce(): Promise<void> {
    if (!this.runtimeDisposePromise) {
      try { this.runtimeDisposePromise = Promise.resolve(this.session.dispose()); }
      catch (error) { this.runtimeDisposePromise = Promise.reject(error); }
    }
    return this.runtimeDisposePromise;
  }

  private assertActive(): void {
    if (this.state.lifecycle !== "active" || this.stopPromise) {
      throw new InstanceNotActiveError(this.id, this.stopPromise ? "stopping" : this.state.lifecycle);
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
  ): Promise<void> {
    if (this.hostDrainActive) {
      this.catalogPort?.assertWritable();
      return;
    }
    const checkpoint = this.captureWorkingCheckpoint();
    try {
      this.catalogPort?.assertWritable();
      mutate();
      this.refreshDurableSessionFile();
      if (this.catalogPort) await this.catalogPort.commit(this.catalogRecord(), context);
    } catch (error) {
      if (context.effect !== "post_effect") this.restoreWorkingCheckpoint(checkpoint);
      throw error;
    }
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
    publish();
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
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
      name: this.nameValue,
      cwd: this.cwdValue,
      executor: cloneJson(this.executorIdentity),
      runtimeGeneration: this.runtimeGenerationValue,
      agentStartCount: this.agentStartCount,
      agentSettledCount: this.agentSettledCount,
      assistantMessageSequence: this.assistantMessageSequence,
      currentAssistantMessageId: this.currentAssistantMessageId,
      announcedToolCalls: [...this.announcedToolCalls],
      lastAssistantOutcome: this.lastAssistantOutcome ? { ...this.lastAssistantOutcome } : undefined,
      stopRequestedWhileRunning: this.stopRequestedWhileRunning,
      catalogAdmissionOperationId: this.catalogAdmissionOperationId,
      extensionCommandInitiator: this.extensionCommandInitiator ? { ...this.extensionCommandInitiator } : undefined,
      replacementIntent: this.replacementIntent ? cloneJson(this.replacementIntent) : undefined,
      durableSessionFile: this.durableSessionFileValue,
      recoverySessionFile: this.recoverySessionFile,
      lastKnown: this.lastKnownValue ? cloneJson(this.lastKnownValue) : undefined,
      interruption: this.interruptionValue ? cloneJson(this.interruptionValue) : undefined,
      stopRequestedAt: this.stopRequestedAt,
      shutdownRequestedAt: this.shutdownRequestedAt,
    };
  }

  private restoreWorkingCheckpoint(checkpoint: WorkingCheckpoint): void {
    this.state = checkpoint.state;
    this.nameValue = checkpoint.name;
    this.cwdValue = checkpoint.cwd;
    Object.assign(this.executorIdentity, checkpoint.executor);
    for (const key of Object.keys(this.executorIdentity) as Array<keyof ExecutorIdentity>) {
      if (!(key in checkpoint.executor)) delete this.executorIdentity[key];
    }
    this.runtimeGenerationValue = checkpoint.runtimeGeneration;
    this.agentStartCount = checkpoint.agentStartCount;
    this.agentSettledCount = checkpoint.agentSettledCount;
    this.assistantMessageSequence = checkpoint.assistantMessageSequence;
    this.currentAssistantMessageId = checkpoint.currentAssistantMessageId;
    this.announcedToolCalls.clear();
    for (const toolCallId of checkpoint.announcedToolCalls) this.announcedToolCalls.add(toolCallId);
    this.lastAssistantOutcome = checkpoint.lastAssistantOutcome;
    this.stopRequestedWhileRunning = checkpoint.stopRequestedWhileRunning;
    this.catalogAdmissionOperationId = checkpoint.catalogAdmissionOperationId;
    this.extensionCommandInitiator = checkpoint.extensionCommandInitiator;
    this.replacementIntent = checkpoint.replacementIntent;
    this.durableSessionFileValue = checkpoint.durableSessionFile;
    this.recoverySessionFile = checkpoint.recoverySessionFile;
    this.lastKnownValue = checkpoint.lastKnown;
    this.interruptionValue = checkpoint.interruption;
    this.stopRequestedAt = checkpoint.stopRequestedAt;
    this.shutdownRequestedAt = checkpoint.shutdownRequestedAt;
  }

  private runtimeDurableSessionFile(): string | undefined {
    const value = this.session.getDurableSessionFile ? this.session.getDurableSessionFile() : this.session.sessionFile;
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

  private currentTreeProjection(forceRefresh = false): ProjectedSessionTree {
    if (!forceRefresh && this.treeProjectionCache) return this.treeProjectionCache.projection;
    if (!this.session.getTree) throw new Error("Runtime does not support session tree projection");
    const projection = projectRuntimeTree(this.session.getTree(), this.runtimeGenerationValue);
    this.treeProjectionCache = {
      projection,
      indexByEntryId: new Map(projection.nodes.map((node, index) => [node.entryId, index])),
    };
    return projection;
  }

  private buildHistoryPage(beforeEntryId: string | undefined, limit: number, beforeTimestamp?: string): HistoryPageDto {
    let source = this.historyValue;
    if (beforeTimestamp !== undefined) {
      source = source.filter((entry) => entry.timestamp === undefined || entry.timestamp < beforeTimestamp);
    }
    let end = source.length;
    if (beforeEntryId !== undefined) {
      end = source.findIndex((entry) => entry.entryId === beforeEntryId);
      if (end < 0) throw new InvalidHistoryCursorError(beforeEntryId);
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const start = Math.max(0, end - boundedLimit);
    const entries = cloneJson(source.slice(start, end));
    return {
      entries,
      hasEarlier: start > 0,
      ...(start > 0 && entries[0] ? { nextBeforeEntryId: entries[0].entryId } : {}),
    };
  }

  private reserveProjectionGate(): { entered: Promise<void>; release: () => void } {
    const entered = this.projectionGateTail;
    let releaseGate!: () => void;
    const held = new Promise<void>((resolve) => { releaseGate = resolve; });
    this.projectionGateTail = entered.then(() => held, () => held);
    let released = false;
    return {
      entered,
      release: () => {
        if (released) return;
        released = true;
        releaseGate();
      },
    };
  }

  private async withCommittedProjectionRead<T>(read: () => T): Promise<T> {
    const historyBoundary = this.historyRefreshTail;
    const reservation = this.reserveProjectionGate();
    try {
      await reservation.entered;
      await historyBoundary;
      const lifecycle = this.snapshot().lifecycle;
      if (lifecycle !== "active") throw new InstanceNotActiveError(this.id, lifecycle);
      return read();
    } finally {
      reservation.release();
    }
  }

  private async withProjectionRead<T>(read: () => Promise<T>): Promise<T> {
    const reservation = this.reserveProjectionGate();
    try {
      await reservation.entered;
      await this.transitionTail;
      this.assertActive();
      return await read();
    } finally {
      reservation.release();
    }
  }

  private async beginConfiguration(
    action: string,
    options: {
      admission?: "idle" | "live" | "run_preempting";
      kind?: "general" | "navigation" | "compaction";
    } = {},
  ): Promise<void> {
    const admission = options.admission ?? "idle";
    const kind = options.kind ?? "general";
    this.catalogPort?.assertWritable();
    this.assertActive();
    const controlMutationPending = this.configurationPending
      || this.commandAbortPending
      || this.queueMutationPending
      || this.pendingAdmission !== undefined
      || this.compactionActive;
    const queuedWorkPending = this.pendingQueueMessages.length > 0
      || this.state.pendingSteering + this.state.pendingFollowUp > 0;
    const activeRun = this.state.execution === "running" || this.session.isStreaming;
    if (
      controlMutationPending
      || (admission !== "live" && queuedWorkPending)
      || (admission === "idle" && activeRun)
    ) {
      throw new InstanceBusyError(this.id, action);
    }
    this.configurationPending = true;
    this.configurationKind = kind;
    this.configurationBoundary = new Promise<void>((resolve) => { this.resolveConfigurationBoundary = resolve; });
    if (kind === "navigation") {
      this.navigationStartedBoundary = new Promise<void>((resolve) => { this.resolveNavigationStarted = resolve; });
    } else if (kind === "compaction") {
      this.compactionStartedBoundary = new Promise<boolean>((resolve) => { this.resolveCompactionStarted = resolve; });
    }
    const reservation = this.reserveProjectionGate();
    this.releaseConfigurationGate = reservation.release;
    try {
      await reservation.entered;
      this.catalogPort?.assertWritable();
      this.assertActive();
    } catch (error) {
      this.endConfiguration();
      throw error;
    }
  }

  private endConfiguration(): void {
    this.configurationPending = false;
    if (this.configurationKind === "navigation") {
      this.resolveNavigationStarted?.();
      this.resolveNavigationStarted = undefined;
      this.navigationStartedBoundary = undefined;
    } else if (this.configurationKind === "compaction") {
      this.resolveCompactionStarted?.(false);
      this.resolveCompactionStarted = undefined;
      this.compactionStartedBoundary = undefined;
    }
    this.configurationKind = undefined;
    this.releaseConfigurationGate?.();
    this.releaseConfigurationGate = undefined;
    this.resolveConfigurationBoundary?.();
    this.resolveConfigurationBoundary = undefined;
    this.configurationBoundary = undefined;
  }

  private async replaceRuntime<T extends RuntimeReplacementResult>(
    action: string,
    operationId: string,
    kind: "new" | "switch" | "fork" | "clone" | "reload",
    target: { requestedSessionFile?: string; requestedEntryId?: string },
    replace: () => Promise<T>,
    validateTarget?: () => void,
  ): Promise<T> {
    await this.beginConfiguration(action);
    try {
      validateTarget?.();
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
      this.endConfiguration();
    }
  }

  private async closeRuntimeOperationBoundary(operationId: string): Promise<void> {
    await Promise.resolve();
    if (this.receiptBoundaryOperationId !== operationId) return;
    const tasks = this.receiptBoundaryTasks.splice(0);
    this.receiptBoundaryOperationId = undefined;
    await Promise.all(tasks);
  }

  private applyModelState(state: RuntimeModelState): void {
    this.executorIdentity.model = state.model ? { provider: truncate(state.model.provider, 256) ?? "unknown", id: truncate(state.model.id, 512) ?? "unknown" } : undefined;
    this.executorIdentity.thinkingLevel = state.thinkingLevel;
  }

  private appendModelChanged(state: RuntimeModelState): void {
    this.appendEvent("model.changed", {
      provider: state.model?.provider ?? "unknown",
      id: state.model?.id ?? "unknown",
      thinkingLevel: state.thinkingLevel,
      availableThinkingLevels: state.availableThinkingLevels,
    });
  }

  private appendThinkingChanged(requested: RuntimeThinkingLevel, state: RuntimeModelState): void {
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

  private appendSettingsWriteFailed(error: RuntimeSettingsWriteError): void {
    this.appendEvent("settings.write_failed", {
      key: error.setting,
      error: safeWireText(error.message, 2_048, "Sensitive settings write error omitted"),
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

  private dispatchRuntimeEvent(event: RuntimeEvent): void {
    if (this.hostDrainActive) return;
    if (this.catalogAdmissionOperationId !== undefined) {
      if (this.admissionBufferedEvents.length >= 1_000) {
        this.admissionBufferedEvents.shift();
        this.admissionBufferOverflow = true;
      }
      this.admissionBufferedEvents.push(event);
      return;
    }
    if (!this.catalogPort) {
      try { this.handleRuntimeEvent(event); if (refreshesHistory(event)) this.refreshHistory(); if (refreshesMetrics(event)) this.refreshMetrics(); }
      catch (error) { this.appendProjectionError(event, error); }
      return;
    }
    const task = this.enqueueCatalogRuntimeEvent(event);
    if (refreshesHistory(event)) this.trackHistoryRefresh(task);
    void task.catch(() => {});
    if (this.receiptBoundaryOperationId !== undefined) this.receiptBoundaryTasks.push(task);
  }

  private enqueueCatalogRuntimeEvent(event: RuntimeEvent): Promise<void> {
    return this.enqueueTransition(async () => {
      try { await this.handleCatalogRuntimeEvent(event); if (refreshesHistory(event)) this.refreshHistory(); if (refreshesMetrics(event)) this.refreshMetrics(); }
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

  private flushAdmissionRuntimeEvents(): Promise<void> {
    const events = this.admissionBufferedEvents.splice(0);
    const overflow = this.admissionBufferOverflow;
    this.admissionBufferOverflow = false;
    const tasks = events.map((event) => {
      const task = this.enqueueCatalogRuntimeEvent(event);
      if (refreshesHistory(event)) this.trackHistoryRefresh(task);
      return task;
    });
    if (overflow) {
      tasks.push(this.enqueueCatalogRuntimeEvent({ type: "dock_extension_error", error: "Admission runtime event buffer exceeded 1000 events; the newest bounded tail and authoritative history/metrics were retained" }));
      const refresh = this.enqueueTransition(async () => { this.refreshHistory(); this.refreshMetrics(); });
      this.trackHistoryRefresh(refresh);
      tasks.push(refresh);
    }
    return Promise.all(tasks).then(() => {});
  }

  private trackHistoryRefresh(task: Promise<void>): void {
    this.historyRefreshTail = task.then(() => {}, () => {});
  }

  private refreshHistory(): void {
    this.treeProjectionCache = undefined;
    this.historyValue = this.session.getHistory().map(projectRuntimeHistoryEntry);
  }

  private refreshMetrics(): void {
    const metrics = projectRuntimeMetrics(this.session.getMetrics());
    if (JSON.stringify(metrics) === JSON.stringify(this.metricsValue)) return;
    this.metricsValue = metrics;
    if (this.catalogPort && this.committedSnapshotValue) {
      this.committedSnapshotValue = { ...this.committedSnapshotValue, metrics: cloneJson(metrics) };
    }
    this.appendEvent("session.metrics_changed", { metrics: cloneJson(metrics) });
  }

  private appendProjectionError(event: RuntimeEvent, error: unknown): void {
    this.appendEvent("instance.error", { source: "event_projection",
      error: safeWireText(errorMessage(error), 2_048, "Sensitive projection error omitted"),
      runtimeEventType: truncate(event.type, 128),
    });
  }

  private async handleCatalogRuntimeEvent(event: RuntimeEvent): Promise<void> {
    this.catalogPort?.assertWritable();
    if (event.type === "dock_git_branch_changed") {
      this.applyGitBranchChanged(event.branch);
      return;
    }
    const extensionInitiatorOperationId = event.type === "agent_start"
      && this.extensionCommandInitiator?.runtimeGeneration === this.runtimeGenerationValue
      && this.extensionCommandInitiator.agentStartCount === this.agentStartCount
      ? this.extensionCommandInitiator.operationId
      : undefined;
    const operationId = this.catalogAdmissionOperationId
      ?? (event.type === "agent_settled" ? this.state.activeCommandId : undefined)
      ?? extensionInitiatorOperationId
      ?? this.compactionOperationId
      ?? this.compactionRequestOperationId
      ?? (event.type === "session_info_changed" ? this.sessionNameOperationId : undefined)
      ?? (this.sessionNameOperationId === undefined ? this.receiptBoundaryOperationId : undefined)
      ?? this.replacementIntent?.operationId
      ?? this.state.activeCommandId
      ?? this.receiptBoundaryOperationId;
    const context = (kind: string): CatalogMutationContext => ({
      kind,
      effect: "post_effect",
      ...(operationId === undefined ? {} : { operationId }),
      instanceId: this.id,
    });
    if (event.type === "dock_session_replaced") {
      this.extensionUi.beginGenerationChange();
      const replacedQueue = removedQueueProjection(this.pendingQueueMessages, this.state);
      const previousSessionFile = optionalRuntimeString(event.previousSessionFile, 16_384);
      const sessionFile = optionalRuntimeString(event.sessionFile, 16_384);
      const cwd = optionalRuntimeString(event.cwd, 16_384);
      const name = optionalRuntimeString(event.name, 256);
      const reason = event.reason === "resume" || event.reason === "reload" || event.reason === "fork" ? event.reason : "new";
      const previousDurableSessionFile = this.replacementIntent?.previousSessionFile ?? previousSessionFile;
      await this.commitCatalogTransition(context("session.replaced"), () => {
        this.runtimeGenerationValue += 1;
        this.replacementIntent = undefined;
        this.recoverySessionFile = undefined;
        this.lastKnownValue = undefined;
        this.interruptionValue = undefined;
        this.shutdownRequestedAt = undefined;
        this.agentStartCount = 0;
        this.agentSettledCount = 0;
        this.assistantMessageSequence = 0;
        this.currentAssistantMessageId = undefined;
        this.currentUserMessageId = undefined;
        this.announcedToolCalls.clear();
        this.acceptedPromptMessages.length = 0;
        this.pendingQueueMessages.length = 0;
        this.runtimeSteeringHashes = [];
        this.runtimeFollowUpHashes = [];
        this.lastAssistantOutcome = undefined;
        this.extensionCommandInitiator = undefined;
        this.state.execution = "idle";
        this.state.compacting = false;
        this.state.lastRun = "never";
        this.state.activeCommandId = undefined;
        this.state.lastError = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        if (cwd !== undefined) this.cwdValue = cwd;
        this.nameValue = name;
        this.gitBranchValue = projectGitBranch(event.gitBranch ?? this.session.getGitBranch?.());
        this.executorIdentity.piSessionId = truncate(this.session.sessionId, 128) ?? "unknown";
        this.executorIdentity.sessionFile = truncate(this.session.sessionFile, 16_384);
        this.durableSessionFileValue = this.runtimeDurableSessionFile();
        this.recoverySessionFile = this.durableSessionFileValue === undefined ? previousDurableSessionFile : undefined;
        this.applyModelState(this.session.getModelState());
        this.touch();
      }, () => {
        this.publishedRuntimeGenerationValue = this.runtimeGenerationValue;
        this.nextEventSequence = 1;
        this.eventLog.length = 0;
        this.appendEvent("session.replaced", { reason, previousSessionFile, sessionFile, runtimeGeneration: this.runtimeGenerationValue, cwd: this.cwdValue, piSessionId: this.executorIdentity.piSessionId, name: this.nameValue, gitBranch: this.gitBranchValue });
        if (replacedQueue.total > 0) this.appendEvent("queue.cleared", { ...replacedQueue, reason: "replacement" });
      });
      void this.extensionUi.completeGenerationChange();
      return;
    }
    if (event.type === "session_info_changed") {
      const name = optionalRuntimeString(event.name, 256);
      await this.commitCatalogTransition(context("session.name"), () => {
        this.nameValue = name;
        this.touch();
      }, () => this.appendEvent("session.info_changed", { name }));
      return;
    }
    if (event.type === "dock_runtime_error") {
      void this.extensionUi.failGenerationChange();
      const error = boundedRuntimeString(event.error, 2_048, "Runtime replacement failed");
      const recoverySessionFile = optionalRuntimeString(event.recoverySessionFile, 16_384)
        ?? this.replacementIntent?.previousSessionFile;
      const lastKnown = this.currentLastKnownState();
      await this.commitCatalogTransition(context("session.runtime_error"), () => {
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
      }, () => {
        this.appendEvent("instance.runtime_error", {
          operationId: boundedRuntimeString(event.operationId, 128, "runtime-internal"),
          kind: event.kind === "reload" || event.kind === "switch" || event.kind === "fork" || event.kind === "clone" ? event.kind : "new",
          error,
          recoverySessionFile,
        });
        this.appendStateEvent("runtime_replacement_failed");
      });
      return;
    }
    switch (event.type) {
      case "agent_start":
        await this.commitCatalogTransition(context("run.started"), () => {
          if (extensionInitiatorOperationId !== undefined) {
            this.state.activeCommandId = extensionInitiatorOperationId;
            this.extensionCommandInitiator = undefined;
          }
          this.agentStartCount += 1;
          this.currentAssistantMessageId = undefined;
          this.announcedToolCalls.clear();
          this.lastAssistantOutcome = undefined;
          this.state.execution = "running";
          this.state.lastError = undefined;
          this.touch();
        }, () => {
          this.appendEvent("run.started", { operationId: this.state.activeCommandId ?? "runtime-initiated" });
          this.appendStateEvent("agent_start");
        });
        return;
      case "agent_settled":
        await this.commitAgentSettled(context("run.settled"));
        return;
      case "queue_update": {
        const steering = stringArray(event.steering);
        const followUp = stringArray(event.followUp);
        this.synchronizePendingRuntimeQueue(steering, followUp);
        await this.commitCatalogTransition(context("queue.changed"), () => {
          this.state.pendingSteering = steering.length;
          this.state.pendingFollowUp = followUp.length;
          this.touch();
        }, () => this.appendEvent("queue.changed", {
          steering: steering.length,
          followUp: followUp.length,
          total: steering.length + followUp.length,
        }));
        return;
      }
      case "auto_retry_start":
        await this.commitCatalogTransition(context("run.retry_started"), () => {
          this.state.execution = "running";
          this.touch();
        }, () => this.appendEvent("run.retry_started", {
          attempt: nonNegativeNumber(event.attempt),
          maxAttempts: nonNegativeNumber(event.maxAttempts),
          delayMs: nonNegativeNumber(event.delayMs),
          error: boundedRuntimeString(event.errorMessage, 2_048, "Unknown retry error"),
        }));
        return;
      case "compaction_start":
        await this.commitCatalogTransition(context("compaction.started"), () => {
          this.startCompactionBoundary(operationId);
          this.state.execution = "running";
          this.state.compacting = true;
          this.touch();
        }, () => this.appendEvent("compaction.started", {
          reason: compactionReason(event.reason),
          ...(operationId === undefined ? {} : { operationId }),
        }));
        return;
      case "compaction_end": {
        try {
          await this.commitCatalogTransition(context("compaction.completed"), () => {
            if (this.state.activeCommandId === undefined && event.willRetry !== true) this.state.execution = "idle";
            this.state.compacting = false;
            this.touch();
          }, () => {
            this.appendEvent("compaction.completed", {
              reason: compactionReason(event.reason),
              ...(operationId === undefined ? {} : { operationId }),
              aborted: event.aborted === true,
              willRetry: event.willRetry === true,
              error: optionalRuntimeString(event.errorMessage, 2_048),
            });
            this.appendStateEvent("compaction_completed");
          });
        } finally {
          this.finishCompactionBoundary();
        }
        return;
      }
      default:
        this.handleRuntimeEvent(event);
    }
  }

  private async commitAgentSettled(context: CatalogMutationContext): Promise<void> {
    const outcome = this.lastAssistantOutcome;
    let result: Exclude<LastRunResult, "never"> = "failed";
    await this.commitCatalogTransition(context, () => {
      this.agentSettledCount += 1;
      if (outcome?.stopReason === "error") {
        result = "failed";
        this.state.execution = "failed";
        this.state.lastError = outcome.errorMessage ?? "Pi run failed";
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
    }, () => {
      this.appendEvent("run.settled", {
        operationId: context.operationId,
        result,
        stopReason: outcome?.stopReason,
        error: outcome?.errorMessage,
      });
      this.appendStateEvent("agent_settled");
    });
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (this.state.lifecycle === "stopped") return;
    if (event.type === "dock_git_branch_changed") {
      this.applyGitBranchChanged(event.branch);
      return;
    }
    if (event.type === "dock_session_replaced") {
      this.extensionUi.beginGenerationChange();
      const replacedQueue = removedQueueProjection(this.pendingQueueMessages, this.state);
      const previousSessionFile = optionalRuntimeString(event.previousSessionFile, 16_384);
      const sessionFile = optionalRuntimeString(event.sessionFile, 16_384);
      const cwd = optionalRuntimeString(event.cwd, 16_384);
      const name = optionalRuntimeString(event.name, 256);
      const reason = event.reason === "resume" || event.reason === "reload" || event.reason === "fork" ? event.reason : "new";
      const previousDurableSessionFile = this.replacementIntent?.previousSessionFile ?? previousSessionFile;
      this.runtimeGenerationValue += 1;
      this.publishedRuntimeGenerationValue = this.runtimeGenerationValue;
      this.replacementIntent = undefined;
      this.recoverySessionFile = undefined;
      this.lastKnownValue = undefined;
      this.interruptionValue = undefined;
      this.shutdownRequestedAt = undefined;
      this.nextEventSequence = 1;
      this.eventLog.length = 0;
      this.agentStartCount = 0;
      this.agentSettledCount = 0;
      this.assistantMessageSequence = 0;
      this.currentAssistantMessageId = undefined;
      this.currentUserMessageId = undefined;
      this.announcedToolCalls.clear();
      this.acceptedPromptMessages.length = 0;
      this.pendingQueueMessages.length = 0;
      this.runtimeSteeringHashes = [];
      this.runtimeFollowUpHashes = [];
      this.lastAssistantOutcome = undefined;
      this.extensionCommandInitiator = undefined;
      this.state.execution = "idle";
      this.state.compacting = false;
      this.state.lastRun = "never";
      this.state.activeCommandId = undefined;
      this.state.lastError = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      if (cwd !== undefined) this.cwdValue = cwd;
      this.nameValue = name;
      this.gitBranchValue = projectGitBranch(event.gitBranch ?? this.session.getGitBranch?.());
      this.executorIdentity.piSessionId = truncate(this.session.sessionId, 128) ?? "unknown";
      this.executorIdentity.sessionFile = truncate(this.session.sessionFile, 16_384);
      this.durableSessionFileValue = this.runtimeDurableSessionFile();
      this.recoverySessionFile = this.durableSessionFileValue === undefined ? previousDurableSessionFile : undefined;
      this.applyModelState(this.session.getModelState());
      this.touch();
      this.appendEvent("session.replaced", { reason, previousSessionFile, sessionFile, runtimeGeneration: this.runtimeGenerationValue, cwd: this.cwdValue, piSessionId: this.executorIdentity.piSessionId, name: this.nameValue, gitBranch: this.gitBranchValue });
      if (replacedQueue.total > 0) this.appendEvent("queue.cleared", { ...replacedQueue, reason: "replacement" });
      void this.extensionUi.completeGenerationChange();
      return;
    }
    if (event.type === "session_info_changed") {
      const name = optionalRuntimeString(event.name, 256);
      this.nameValue = name;
      this.touch();
      this.appendEvent("session.info_changed", { name });
      return;
    }
    if (event.type === "dock_runtime_error") {
      void this.extensionUi.failGenerationChange();
      this.lastKnownValue = this.currentLastKnownState();
      this.interruptionValue = { reason: "replacement_failed", at: this.timestamp() };
      this.recoverySessionFile = optionalRuntimeString(event.recoverySessionFile, 16_384)
        ?? this.replacementIntent?.previousSessionFile;
      this.replacementIntent = undefined;
      this.state.lifecycle = "runtime_error";
      this.state.execution = "unavailable";
      this.state.compacting = false;
      this.state.activeCommandId = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      this.state.lastError = boundedRuntimeString(event.error, 2_048, "Runtime replacement failed");
      this.touch();
      this.appendEvent("instance.runtime_error", {
        operationId: boundedRuntimeString(event.operationId, 128, "runtime-internal"),
        kind: event.kind === "reload" || event.kind === "switch" || event.kind === "fork" || event.kind === "clone" ? event.kind : "new",
        error: this.state.lastError,
        recoverySessionFile: this.recoverySessionFile,
      });
      this.appendStateEvent("runtime_replacement_failed");
      return;
    }
    if (event.type === "dock_extension_error") {
      this.recordExtensionError(event.error);
      return;
    }
    switch (event.type) {
      case "agent_start": {
        const extensionInitiatorOperationId = this.extensionCommandInitiator?.runtimeGeneration === this.runtimeGenerationValue
          && this.extensionCommandInitiator.agentStartCount === this.agentStartCount
          ? this.extensionCommandInitiator.operationId
          : undefined;
        if (extensionInitiatorOperationId !== undefined) {
          this.state.activeCommandId = extensionInitiatorOperationId;
          this.extensionCommandInitiator = undefined;
        }
        this.agentStartCount += 1;
        this.currentAssistantMessageId = undefined;
        this.announcedToolCalls.clear();
        this.lastAssistantOutcome = undefined;
        this.state.execution = "running";
        this.state.lastError = undefined;
        this.touch();
        this.appendEvent("run.started", {
          operationId: this.state.activeCommandId ?? "runtime-initiated",
        });
        this.appendStateEvent("agent_start");
        break;
      }

      case "agent_settled":
        this.handleAgentSettled();
        break;

      case "queue_update": {
        const steering = stringArray(event.steering);
        const followUp = stringArray(event.followUp);
        this.synchronizePendingRuntimeQueue(steering, followUp);
        this.state.pendingSteering = steering.length;
        this.state.pendingFollowUp = followUp.length;
        this.touch();
        this.appendEvent("queue.changed", {
          steering: steering.length,
          followUp: followUp.length,
          total: steering.length + followUp.length,
        });
        break;
      }

      case "message_start":
        this.handleMessageStart(event);
        break;

      case "message_update":
        this.handleMessageUpdate(event);
        break;

      case "message_end":
        this.handleMessageEnd(event);
        break;

      case "tool_execution_start": {
        const toolCallId = boundedRuntimeString(event.toolCallId, 128, "unknown");
        const projected = projectJsonObject(event.args);
        if (this.announcedToolCalls.has(toolCallId)) {
          this.appendEvent("tool.args_updated", {
            toolCallId,
            args: projected.value,
            ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
          });
        } else {
          this.announcedToolCalls.add(toolCallId);
          this.appendEvent("tool.started", {
            toolCallId,
            toolName: boundedRuntimeString(event.toolName, 256, "unknown"),
            args: projected.value,
            ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
          });
        }
        break;
      }

      case "tool_execution_update": {
        const toolCallId = boundedRuntimeString(event.toolCallId, 128, "unknown");
        if (!this.announcedToolCalls.has(toolCallId)) {
          this.announcedToolCalls.add(toolCallId);
          this.appendEvent("tool.started", {
            toolCallId,
            toolName: boundedRuntimeString(event.toolName, 256, "unknown"),
            args: {},
          });
        }
        this.appendEvent("tool.output_updated", {
          toolCallId,
          text: projectToolText(recordValue(event.partialResult)?.content),
        });
        break;
      }

      case "tool_execution_end": {
        const toolCallId = boundedRuntimeString(event.toolCallId, 128, "unknown");
        const projected = projectJsonObject(event.result);
        this.appendEvent("tool.completed", {
          toolCallId,
          toolName: boundedRuntimeString(event.toolName, 256, "unknown"),
          isError: event.isError === true,
          text: projectToolText(recordValue(event.result)?.content),
          ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
        });
        this.announcedToolCalls.delete(toolCallId);
        break;
      }

      case "auto_retry_start":
        this.state.execution = "running";
        this.touch();
        this.appendEvent("run.retry_started", {
          attempt: nonNegativeNumber(event.attempt),
          maxAttempts: nonNegativeNumber(event.maxAttempts),
          delayMs: nonNegativeNumber(event.delayMs),
          error: boundedRuntimeString(event.errorMessage, 2_048, "Unknown retry error"),
        });
        break;

      case "auto_retry_end":
        this.appendEvent("run.retry_completed", {
          success: event.success === true,
          attempt: nonNegativeNumber(event.attempt),
          error: optionalRuntimeString(event.finalError, 2_048),
        });
        break;

      case "compaction_start":
        this.startCompactionBoundary(this.receiptBoundaryOperationId);
        this.state.execution = "running";
        this.state.compacting = true;
        this.touch();
        this.appendEvent("compaction.started", {
          reason: compactionReason(event.reason),
          ...(this.receiptBoundaryOperationId === undefined ? {} : { operationId: this.receiptBoundaryOperationId }),
        });
        break;

      case "compaction_end":
        if (this.state.activeCommandId === undefined && event.willRetry !== true) this.state.execution = "idle";
        this.state.compacting = false;
        this.touch();
        this.appendEvent("compaction.completed", {
          reason: compactionReason(event.reason),
          ...(this.receiptBoundaryOperationId === undefined ? {} : { operationId: this.receiptBoundaryOperationId }),
          aborted: event.aborted === true,
          willRetry: event.willRetry === true,
          error: optionalRuntimeString(event.errorMessage, 2_048),
        });
        this.appendStateEvent("compaction_completed");
        this.finishCompactionBoundary();
        break;

      default:
        break;
    }
  }

  private handleAgentSettled(): void {
    this.agentSettledCount += 1;
    const outcome = this.lastAssistantOutcome;
    const operationId = this.state.activeCommandId ?? this.receiptBoundaryOperationId;
    let result: Exclude<LastRunResult, "never">;

    if (outcome?.stopReason === "error") {
      result = "failed";
      this.state.execution = "failed";
      this.state.lastError = outcome.errorMessage ?? "Pi run failed";
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

    // Extension-triggered compaction_start may precede Pi's externally
    // published agent_settled event even though the extension hook is named
    // agent_settled. Preserve the active compaction boundary.
    if (this.compactionActive) this.state.execution = "running";
    this.state.lastRun = result;
    this.state.activeCommandId = undefined;
    this.touch();
    this.appendEvent("run.settled", {
      operationId,
      result,
      stopReason: outcome?.stopReason,
      error: outcome?.errorMessage,
    });
    this.appendStateEvent("agent_settled");
  }

  private startCompactionBoundary(operationId?: string): void {
    if (operationId !== undefined) this.compactionOperationId = operationId;
    this.resolveCompactionStarted?.(true);
    this.resolveCompactionStarted = undefined;
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

  private canQueueMessage(message: string): boolean {
    const projectedCount = Math.max(
      this.pendingQueueMessages.length,
      this.state.pendingSteering + this.state.pendingFollowUp,
    ) + 1;
    const projectedCharacters = this.pendingQueueMessages.reduce((total, item) => total + item.text.length, 0) + message.length;
    return projectedCount <= MAX_PENDING_QUEUE_ITEMS && projectedCharacters <= MAX_PENDING_QUEUE_TEXT_CHARS;
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

  private assignPendingRuntimeHashes(delivery: "steer" | "followUp", runtimeHashes: string[]): void {
    const available = [...runtimeHashes];
    for (const item of this.pendingQueueMessages) {
      if (item.delivery !== delivery || item.runtimeTextHash === undefined) continue;
      const index = available.indexOf(item.runtimeTextHash);
      if (index >= 0) available.splice(index, 1);
    }
    const unassigned = this.pendingQueueMessages.filter((item) => item.delivery === delivery && item.runtimeTextHash === undefined);
    for (let index = 0; index < Math.min(unassigned.length, available.length); index += 1) {
      unassigned[index]!.runtimeTextHash = available[index]!;
    }
  }

  private handleMessageStart(event: RuntimeEvent): void {
    const message = recordValue(event.message);
    if (!message || stringValue(message.role) !== "user") return;
    const consumedText = runtimeUserMessageText(message.content);
    const consumedHash = runtimeMessageHash(consumedText);
    const queueCandidates = [
      ...this.pendingQueueMessages.filter((item) => item.delivery === "steer"),
      ...this.pendingQueueMessages.filter((item) => item.delivery === "followUp"),
    ];
    const queued = queueCandidates.find((item) => item.runtimeTextHash === consumedHash)
      ?? queueCandidates.find((item) => item.text === consumedText);
    if (queued) {
      const index = this.pendingQueueMessages.indexOf(queued);
      if (index >= 0) this.pendingQueueMessages.splice(index, 1);
      this.currentUserMessageId = `user-${queued.operationId}`;
      this.appendEvent("message.submitted", {
        operationId: queued.operationId,
        messageId: this.currentUserMessageId,
        role: "user",
        text: safeWireText(consumedText || queued.text, MAX_PENDING_QUEUE_TEXT_CHARS, "User message omitted"),
        delivery: queued.delivery,
        queueItemId: queued.queueItemId,
      });
      return;
    }

    const activeOperationId = this.state.activeCommandId;
    const promptIndex = activeOperationId === undefined
      ? 0
      : this.acceptedPromptMessages.findIndex((candidate) => candidate.operationId === activeOperationId);
    const accepted = promptIndex >= 0 ? this.acceptedPromptMessages.splice(promptIndex, 1)[0] : undefined;
    const operationId = accepted?.operationId ?? activeOperationId ?? "runtime-initiated";
    this.currentUserMessageId = `user-${operationId}`;
    this.appendEvent("message.submitted", {
      operationId,
      messageId: this.currentUserMessageId,
      role: "user",
      text: safeWireText(consumedText || accepted?.text || "", MAX_PENDING_QUEUE_TEXT_CHARS, "User message omitted"),
      delivery: "prompt",
    });
  }

  private handleMessageUpdate(event: RuntimeEvent): void {
    const update = recordValue(event.assistantMessageEvent);
    if (!update) return;
    const updateType = stringValue(update.type);
    if (updateType === "start") {
      this.ensureAssistantMessageId();
      return;
    }
    if (updateType === "text_delta" || updateType === "thinking_delta") {
      this.appendEvent("message.delta", {
        messageId: this.ensureAssistantMessageId(),
        block: updateType === "text_delta" ? "text" : "thinking",
        delta: boundedRuntimeString(update.delta, 8_000, ""),
      });
      return;
    }
    if (updateType !== "toolcall_start" && updateType !== "toolcall_delta" && updateType !== "toolcall_end") return;
    this.ensureAssistantMessageId();
    const index = nonNegativeNumber(update.contentIndex);
    const partial = recordValue(update.partial);
    const content = Array.isArray(partial?.content) ? partial.content : [];
    const partialToolCall = recordValue(content[index]);
    const finalToolCall = recordValue(update.toolCall);
    const toolCall = finalToolCall ?? partialToolCall;
    const rawId = stringValue(toolCall?.id);
    if (!rawId) return;
    const toolCallId = boundedRuntimeString(rawId, 128, "unknown");
    const projected = projectJsonObject(toolCall?.arguments ?? {});
    if (!this.announcedToolCalls.has(toolCallId)) {
      this.announcedToolCalls.add(toolCallId);
      this.appendEvent("tool.started", {
        toolCallId,
        toolName: boundedRuntimeString(toolCall?.name, 256, "tool"),
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      });
    } else {
      this.appendEvent("tool.args_updated", {
        toolCallId,
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      });
    }
  }

  private handleMessageEnd(event: RuntimeEvent): void {
    const message = recordValue(event.message);
    if (!message) return;
    const role = stringValue(message.role);
    let messageId: string;
    if (role === "assistant") {
      messageId = this.ensureAssistantMessageId();
      this.lastAssistantOutcome = {
        stopReason: optionalRuntimeString(message.stopReason, 128),
        errorMessage: optionalRuntimeString(message.errorMessage, 2_048),
      };
    } else if (role === "user" && this.currentUserMessageId) {
      messageId = this.currentUserMessageId;
    } else if (role === "toolResult") {
      messageId = `tool-result-${boundedRuntimeString(message.toolCallId, 128, "unknown")}`;
    } else {
      messageId = `message-${this.runtimeGenerationValue}-${++this.assistantMessageSequence}`;
    }
    this.appendEvent("message.completed", {
      messageId,
      role: messageRole(role),
      content: projectContentBlocks(message.content),
      stopReason: optionalRuntimeString(message.stopReason, 128),
      error: optionalRuntimeString(message.errorMessage, 2_048),
    });
    if (role === "assistant") this.currentAssistantMessageId = undefined;
    if (role === "user") this.currentUserMessageId = undefined;
  }

  private ensureAssistantMessageId(): string {
    this.currentAssistantMessageId ??= `assistant-${this.runtimeGenerationValue}-${++this.assistantMessageSequence}`;
    return this.currentAssistantMessageId;
  }

  private appendStateEvent(reason: string, occurredAt?: string): void {
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
    const event = {
      scope: "instance" as const,
      sequence: this.nextEventSequence++,
      instanceId: this.id,
      runtimeGeneration: this.publishedRuntimeGenerationValue,
      occurredAt,
      type,
      data,
    } as DockEvent;
    this.eventLog.push(event);
    if (this.eventLog.length > this.eventCapacity) this.eventLog.shift();
    if (this.catalogPort && this.committedSnapshotValue) {
      this.committedSnapshotValue = { ...this.committedSnapshotValue, eventCursor: this.cursor(this.nextEventSequence - 1) };
    }

    // The event is durable in the in-memory ring before any client callback.
    // A broken observer must never break Pi's synchronous listener chain.
    for (const subscriber of this.subscribers) {
      try {
        subscriber(cloneDockEvent(event));
      } catch {
        // Deliberately isolate observer failures. Transport layers report their
        // own socket errors and unsubscribe separately.
      }
    }
    return event;
  }

  private touch(timestamp = this.timestamp()): void {
    if (timestamp >= this.state.updatedAt) this.state.updatedAt = timestamp;
  }

  private cursor(sequence: number): EventCursor {
    return { hostEpoch: this.hostEpoch, instanceId: this.id, runtimeGeneration: this.publishedRuntimeGenerationValue, sequence };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function resolveDelivery(mode: DeliveryMode, running: boolean): Exclude<DeliveryMode, "auto"> {
  if (mode === "auto") return running ? "steer" : "prompt";
  if (running && mode === "prompt") throw new InvalidDeliveryModeError(mode, running);
  if (!running && (mode === "steer" || mode === "followUp")) {
    throw new InvalidDeliveryModeError(mode, running);
  }
  return mode;
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
  return typeof value === "string" ? safeWireText(value, limit, fallback) : fallback;
}

function optionalRuntimeString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? safeWireText(value, limit, "Sensitive payload omitted") : undefined;
}

function projectGitBranch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("Runtime Git branch projection is not terminal-safe");
  }
  return safeWireText(value, 256, "Git branch omitted");
}

function runtimeMessageHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runtimeUserMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value = recordValue(block);
      return value?.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
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
  return cloneJson([...steering, ...followUp].map(({ runtimeTextHash: _runtimeTextHash, ...item }) => item));
}

function selectClearedQueueMessages(
  pending: readonly PendingQueueMessage[],
  cleared: ClearedRuntimeQueue,
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
          text: safeWireText(text, MAX_PENDING_QUEUE_TEXT_CHARS, "Queued message omitted"),
          acceptedAt,
        });
      }
    }
  };
  select("steer", cleared.steering);
  select("followUp", cleared.followUp);
  return { restored, restoredQueueItemIds: [...selected] };
}

function conversationBootstrapEvents(
  events: DockEvent[],
  history: HistoryEntryDto[],
  instance: InstanceSnapshot,
  truncated: boolean,
  runtimeAgentActive: boolean,
): DockEvent[] {
  if (instance.execution !== "running") return [];
  if (instance.activeCommandId === undefined && !runtimeAgentActive) return [];
  // Extension-triggered turns (for example a post-compaction continuation)
  // are Host-owned runs without a client command ID. Their closed run.started
  // identity is still stable and must recover the unresolved tail on attach.
  const activeOperationId = instance.activeCommandId ?? "runtime-initiated";
  let start = events.findLastIndex((event) => event.type === "run.started" && event.data.operationId === activeOperationId);
  if (start < 0) {
    start = events.findLastIndex((event) => event.type === "message.submitted" && event.data.operationId === activeOperationId);
  }
  // A truncated ring contains only events newer than its evicted prefix. If the
  // snapshot still identifies an active run, every retained frame is part of
  // that run's live era even when its start marker has fallen out.
  if (start < 0 && !truncated) return [];
  return eventsNotCoveredByHistory(start < 0 ? events : events.slice(start), history);
}

function eventsNotCoveredByHistory(events: DockEvent[], history: HistoryEntryDto[]): DockEvent[] {
  const counts = new Map<string, number>();
  for (const entry of history) {
    const fingerprint = historyFingerprint(entry.role, entry.content);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  const coveredMessages = new Set<string>();
  const coveredTools = new Set<string>();
  const consume = (fingerprint: string): boolean => {
    const count = counts.get(fingerprint) ?? 0;
    if (count < 1) return false;
    if (count === 1) counts.delete(fingerprint); else counts.set(fingerprint, count - 1);
    return true;
  };
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "message.completed") {
      if (event.data.role === "user" || coveredMessages.has(event.data.messageId)) continue;
      if (consume(historyFingerprint(event.data.role, event.data.content))) coveredMessages.add(event.data.messageId);
    } else if (event.type === "message.submitted") {
      if (coveredMessages.has(event.data.messageId)) continue;
      if (consume(historyFingerprint("user", [{ type: "text", text: event.data.text }]))) coveredMessages.add(event.data.messageId);
    } else if (event.type === "tool.completed") {
      const content: ContentBlockDto[] = [{
        type: "tool_result",
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        text: event.data.text,
        isError: event.data.isError,
      }];
      if (consume(historyFingerprint("tool", content))) coveredTools.add(event.data.toolCallId);
    }
  }
  return events.filter((event) => {
    if (event.type === "message.submitted" || event.type === "message.delta" || event.type === "message.completed") {
      return !coveredMessages.has(event.data.messageId);
    }
    if (event.type === "tool.started" || event.type === "tool.args_updated" || event.type === "tool.output_updated" || event.type === "tool.completed") {
      return !coveredTools.has(event.data.toolCallId);
    }
    return true;
  });
}

function historyFingerprint(role: HistoryEntryDto["role"], content: ContentBlockDto[]): string {
  const normalized = content.map((block) => {
    if (block.type === "tool_call") return { type: block.type, toolCallId: block.toolCallId, toolName: block.toolName, args: block.args };
    if (block.type === "tool_result") return { type: block.type, toolCallId: block.toolCallId, toolName: block.toolName, text: block.text, isError: block.isError };
    return block;
  });
  return JSON.stringify({ role, content: normalized });
}

function refreshesHistory(event: RuntimeEvent): boolean {
  return event.type === "entry_appended"
    || event.type === "message_end"
    || event.type === "session_info_changed"
    || event.type === "compaction_end"
    || event.type === "dock_session_replaced";
}

function refreshesMetrics(event: RuntimeEvent): boolean {
  return event.type === "entry_appended"
    || event.type === "message_end"
    || event.type === "tool_execution_end"
    || event.type === "agent_settled"
    || event.type === "compaction_end"
    || event.type === "dock_session_replaced";
}

function projectRuntimeHistoryEntry(entry: RuntimeHistoryEntry): HistoryEntryDto {
  const role = historyRole(entry.role);
  const summaryKind = entry.summaryKind
    ?? (entry.role === "compactionSummary" ? "compaction" : entry.role === "branchSummary" ? "branch" : undefined);
  const entryId = boundedRuntimeString(entry.entryId, 128, "unknown-entry");
  const content: ContentBlockDto[] = role === "tool"
    ? [{
      type: "tool_result",
      toolCallId: boundedRuntimeString(entry.toolCallId, 128, `tool-${entryId}`),
      toolName: boundedRuntimeString(entry.toolName, 256, "tool"),
      text: projectToolText(entry.content),
      isError: entry.isError === true,
    }]
    : projectContentBlocks(entry.content);
  return {
    entryId,
    ...(entry.parentId === undefined ? {} : { parentId: boundedRuntimeString(entry.parentId, 128, "unknown-parent") }),
    role,
    ...(summaryKind === undefined ? {} : { summaryKind }),
    ...(isIsoTimestamp(entry.timestamp) ? { timestamp: entry.timestamp } : {}),
    content,
    ...(entry.stopReason === undefined ? {} : { stopReason: boundedRuntimeString(entry.stopReason, 128, "unknown") }),
    ...(entry.error === undefined ? {} : { error: safeWireText(entry.error, 2_048, "History error omitted") }),
  };
}

function historyRole(value: string): HistoryEntryDto["role"] {
  if (value === "user") return "user";
  if (value === "tool" || value === "toolResult") return "tool";
  if (value === "system" || value === "bashExecution" || value === "custom" || value === "branchSummary" || value === "compactionSummary") return "system";
  return "assistant";
}

function projectRuntimeMetrics(value: RuntimeSessionMetrics): SessionMetricsDto {
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
]);

function settingAdmission(key: SettingKey): "idle" | "live" {
  // These settings can alter the active agent loop, queue draining, retry, or
  // transport semantics. Presentation, startup/reload, trust defaults, and
  // Host-restart settings only affect this/next client or a future boundary.
  return RUN_SENSITIVE_SETTING_KEYS.has(key) ? "idle" : "live";
}

function boundedRuntimeToolProjection(source: ToolDto[] | RuntimeToolProjection): { tools: ToolDto[]; total: number; truncated: boolean } {
  const runtime = Array.isArray(source)
    ? { tools: source, total: source.length, truncated: false }
    : source;
  if (!Number.isSafeInteger(runtime.total) || runtime.total < runtime.tools.length || runtime.truncated !== (runtime.tools.length < runtime.total)) {
    throw new Error("Runtime returned inconsistent tool completeness metadata");
  }
  const projected = boundedCollectionProjection(runtime.tools);
  return {
    tools: cloneJson(projected.items),
    total: runtime.total,
    truncated: runtime.truncated || projected.items.length < runtime.total,
  };
}

function boundedCollectionProjection<T>(source: readonly T[], maxBytes = 600_000): BoundedCollectionProjection<T> {
  const items: T[] = [];
  let bytes = 2;
  for (const item of source.slice(0, 2_000)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
    if (bytes + itemBytes > maxBytes) break;
    items.push(item);
    bytes += itemBytes;
  }
  return { items, total: source.length, truncated: items.length < source.length };
}

function projectCompactionResult(result: RuntimeCompactionResult): SessionCompactionDto {
  if (typeof result.summary !== "string" || typeof result.firstKeptEntryId !== "string" || result.firstKeptEntryId.length === 0 || result.firstKeptEntryId.length > 128 || !Number.isSafeInteger(result.tokensBefore) || result.tokensBefore < 0) {
    throw new Error("Pi returned an invalid compaction result");
  }
  return {
    summary: safeWireText(result.summary, 8_000, "Compaction summary omitted"),
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
  };
}

function isKnownMutationBoundaryError(error: unknown): boolean {
  return error instanceof CatalogEffectUnknownError
    || error instanceof CatalogWriteError
    || error instanceof MutationFaultedError
    || error instanceof RuntimeEffectUnknownError
    || error instanceof RuntimeCompactionKnownFailureError;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compactionReason(value: unknown): "manual" | "threshold" | "overflow" {
  return value === "threshold" || value === "overflow" ? value : "manual";
}

function messageRole(value: unknown): "user" | "assistant" | "tool" | "system" {
  if (value === "user" || value === "system") return value;
  if (value === "tool" || value === "toolResult") return "tool";
  if (value === "bashExecution" || value === "custom" || value === "branchSummary" || value === "compactionSummary") return "system";
  return "assistant";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => recordValue(block))
    .filter((block): block is Record<string, unknown> => block !== undefined)
    .filter((block) => block.type === "text")
    .map((block) => stringValue(block.text) ?? "")
    .join("");
  return text.length > 0 ? text : undefined;
}

function projectContentBlocks(content: unknown): ContentBlockDto[] {
  if (typeof content === "string") {
    return isBinaryText(content)
      ? [{ type: "omitted", kind: "binary", description: "Binary data omitted" }]
      : [{ type: "text", text: truncate(content, 8_000) ?? "" }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlockDto[] = [];
  const maxBytes = 512_000;
  let bytes = 2;
  const append = (candidate: ContentBlockDto, useOmissionReserve = false): boolean => {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (blocks.length > 0 ? 1 : 0);
    const limit = useOmissionReserve ? maxBytes : maxBytes - 256;
    if (bytes + candidateBytes > limit) return false;
    blocks.push(candidate);
    bytes += candidateBytes;
    return true;
  };
  let bounded = true;
  for (const item of content.slice(0, 200)) {
    const block = recordValue(item);
    if (!block) continue;
    let candidate: ContentBlockDto | undefined;
    if (block.type === "text" && typeof block.text === "string") {
      candidate = isBinaryText(block.text)
        ? { type: "omitted", kind: "binary", description: "Binary data omitted" }
        : { type: "text", text: truncate(block.text, 8_000) ?? "" };
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      candidate = isBinaryText(block.thinking)
        ? { type: "omitted", kind: "binary", description: "Binary data omitted" }
        : { type: "thinking", text: truncate(block.thinking, 8_000) ?? "" };
    } else if ((block.type === "toolCall" || block.type === "tool_call") && typeof block.name === "string") {
      const projected = projectJsonObject(block.arguments);
      candidate = {
        type: "tool_call",
        toolCallId: boundedRuntimeString(block.id, 128, "unknown"),
        toolName: boundedRuntimeString(block.name, 256, "unknown"),
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      };
    } else if (block.type === "toolResult" || block.type === "tool_result") {
      const projected = projectJsonObject(block);
      candidate = {
        type: "tool_result",
        toolCallId: boundedRuntimeString(block.toolCallId ?? block.id, 128, "unknown"),
        toolName: boundedRuntimeString(block.toolName ?? block.name, 256, "unknown"),
        text: projectToolText(block.content),
        isError: block.isError === true,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      };
    } else if (block.type === "image") {
      candidate = { type: "omitted", kind: "image", description: "Image bytes omitted; local path remains in tool text when provided" };
    }
    if (candidate && !append(candidate)) { bounded = false; break; }
  }
  if (!bounded || content.length > 200) {
    append({ type: "text", text: "[Additional message content omitted to fit the bounded control event]" }, true);
  }
  return blocks;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  if (limit < 1) return "";
  const end = unicodeSafeSliceEnd(value, limit - 1);
  return `${value.slice(0, end)}…`;
}

function unicodeSafeSliceEnd(value: string, requestedEnd: number): number {
  return requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
}

function safeWireText(value: string, limit: number, omission: string): string {
  return isBinaryText(value) ? omission : truncate(value, limit) ?? omission;
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

function cloneDockEvent(event: DockEvent): DockEvent {
  return cloneJson(event);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 100;
const MAX_JSON_ARRAY = 200;
const MAX_JSON_STRING = 8_000;
const MAX_JSON_PROJECTED_NODES = 2_000;
const MAX_JSON_PROJECTED_BYTES = 256_000;
const MAX_JSON_OMITTED_FIELDS = 200;
const SENSITIVE_KEY = /base64|binary|imageData/i;
const DATA_URI = /data:[^,]*;base64,/i;
const BASE64_PAYLOAD = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isBinaryText(value: string): boolean {
  if (DATA_URI.test(value) || BASE64_PAYLOAD.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => BASE64_PAYLOAD.test(part));
}

export function projectJsonObject(input: unknown): { value: JsonObject; omittedFields: string[] } {
  const omittedFields: string[] = [];
  const omittedSet = new Set<string>();
  const seen = new WeakSet<object>();
  let projectedNodes = 0;
  let projectedBytes = 0;
  let budgetExhausted = false;
  const omit = (path: string): void => {
    const safePath = (path || "/").slice(0, 512);
    if (omittedSet.has(safePath) || omittedFields.length >= MAX_JSON_OMITTED_FIELDS) return;
    omittedSet.add(safePath);
    omittedFields.push(safePath);
  };
  const reserve = (bytes: number, path: string): boolean => {
    if (budgetExhausted || projectedBytes + bytes > MAX_JSON_PROJECTED_BYTES) {
      budgetExhausted = true;
      omit(path);
      return false;
    }
    projectedBytes += bytes;
    return true;
  };
  const project = (value: unknown, path: string, depth: number): JsonValue | undefined => {
    if (budgetExhausted || projectedNodes >= MAX_JSON_PROJECTED_NODES) {
      budgetExhausted = true;
      omit(path);
      return undefined;
    }
    projectedNodes += 1;
    if (typeof value === "string") {
      if (isBinaryText(value)) { omit(path); return undefined; }
      const projected = truncate(value, MAX_JSON_STRING) ?? "";
      return reserve(Buffer.byteLength(JSON.stringify(projected), "utf8"), path) ? projected : undefined;
    }
    if (value === null || typeof value === "boolean") {
      return reserve(value === null ? 4 : value ? 4 : 5, path) ? value : undefined;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) { omit(path); return undefined; }
      return reserve(Buffer.byteLength(JSON.stringify(value), "utf8"), path) ? value : undefined;
    }
    if (typeof value !== "object" || value === null || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      omit(path);
      return undefined;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      omit(path);
      return undefined;
    }
    if (depth >= MAX_JSON_DEPTH || seen.has(value) || !reserve(2, path)) {
      omit(path);
      return undefined;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}/${index}`;
        if (index >= MAX_JSON_ARRAY || budgetExhausted || projectedNodes >= MAX_JSON_PROJECTED_NODES) { omit(itemPath); break; }
        if (result.length > 0 && !reserve(1, itemPath)) break;
        let sourceItem: unknown;
        try { sourceItem = value[index]; }
        catch { omit(itemPath); continue; }
        const item = project(sourceItem, itemPath, depth + 1);
        if (item !== undefined) result.push(item);
      }
      return result;
    }
    const result: JsonObject = {};
    let index = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const itemPath = `${path}/${escapeJsonPointer(key.slice(0, 256))}`;
      if (index >= MAX_JSON_KEYS || budgetExhausted || projectedNodes >= MAX_JSON_PROJECTED_NODES) { omit(itemPath); break; }
      index += 1;
      if (key.length < 1 || key.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(key) || SENSITIVE_KEY.test(key)) { omit(itemPath); continue; }
      const separatorBytes = Object.keys(result).length > 0 ? 1 : 0;
      if (!reserve(separatorBytes + Buffer.byteLength(JSON.stringify(key), "utf8") + 1, itemPath)) break;
      let sourceItem: unknown;
      try { sourceItem = (value as Record<string, unknown>)[key]; }
      catch { omit(itemPath); continue; }
      const projected = project(sourceItem, itemPath, depth + 1);
      if (projected !== undefined) result[key] = projected;
    }
    return result;
  };
  const value = project(input, "", 0);
  return { value: isJsonObject(value) ? value : {}, omittedFields };
}

function escapeJsonPointer(value: string): string { return value.replace(/~/g, "~0").replace(/\//g, "~1"); }
function isIsoTimestamp(value: string | undefined): value is string { return value !== undefined && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value); }
function projectToolText(content: unknown): string {
  const text = extractText(content);
  if (!text || isBinaryText(text)) return "";
  const limit = 8_000;
  if (text.length <= limit) return text;
  const notice = "\n[tool output truncated by Host projection]";
  const requestedEnd = Math.max(0, limit - notice.length);
  return `${text.slice(0, unicodeSafeSliceEnd(text, requestedEnd))}${notice}`;
}
