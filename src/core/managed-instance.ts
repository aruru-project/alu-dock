import { randomUUID } from "node:crypto";

import {
  CatalogEffectUnknownError,
  CatalogWriteError,
  MutationFaultedError,
  type CatalogInstanceRecord,
  type CatalogMutationContext,
  type InstanceCatalogMutationPort,
  validateInstanceStateInvariant,
} from "./catalog.js";
import { RuntimeSettingsWriteError } from "./runtime-session.js";
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
  RuntimeEvent,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeProjectTrust,
  RuntimeReplacementResult,
  RuntimeSession,
  RuntimeSessionMetrics,
  RuntimeThinkingLevel,
} from "./runtime-session.js";

export type InstanceLifecycle = "active" | "stopping" | "stopped" | "host_lost" | "runtime_error";
export type InstanceExecution = "idle" | "running" | "failed" | "unavailable";
export type LastRunResult = "never" | "succeeded" | "failed" | "aborted" | "interrupted";
export type DeliveryMode = "auto" | "prompt" | "steer" | "followUp";

export interface ExecutorIdentity {
  kind: "pi-sdk" | string;
  version?: string;
  piSessionId: string;
  sessionFile?: string;
  model?: {
    provider: string;
    id: string;
    name?: string;
  };
  thinkingLevel?: RuntimeThinkingLevel;
}

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ContentBlockDto =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] }
  | { type: "omitted"; kind: "image" | "binary"; description: string };

export interface PendingDto { steering: number; followUp: number; total: number }
export interface HistoryEntryDto {
  entryId: string;
  parentId?: string;
  role: "user" | "assistant" | "tool" | "system";
  timestamp?: string;
  content: ContentBlockDto[];
  stopReason?: string;
  error?: string;
}
export interface HistoryPageDto {
  entries: HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
}
export type SessionMetricsDto = RuntimeSessionMetrics;
export interface SessionDto { sessionId: string; sessionFile: string; name?: string; cwd: string; updatedAt?: string }
export type SettingsChangedData = { [K in keyof SettingValueMap]: { key: K; value: SettingValueMap[K]; reloadRequired: boolean; hostRestartRequired: boolean } }[keyof SettingValueMap];
export interface EventDataMap {
  "instance.created": { cwd: string; name?: string; executor: ExecutorIdentity };
  "instance.state_changed": { reason: string; lifecycle: InstanceLifecycle; execution: InstanceExecution; lastRun: LastRunResult; pending: PendingDto; activeCommandId?: string; lastError?: string };
  "instance.reopened": { previousLifecycle: "host_lost" | "runtime_error"; sessionFile: string; runtimeGeneration: number };
  "instance.stopped": { cleanupErrors: string[] };
  "instance.runtime_error": { operationId: string; kind: "create" | "new" | "switch" | "fork" | "clone" | "reload" | "reopen"; error: string; recoverySessionFile?: string };
  "instance.error": { operationId?: string; source: "event_projection" | "command_background"; error: string; runtimeEventType?: string };
  "command.accepted": { operationId: string; delivery: "prompt" | "steer" | "followUp"; queued: boolean; acceptedAt: string };
  "command.rejected": { operationId: string; reason: string; error: string };
  "command.handled": { operationId: string; kind: "extension_command" | "no_run" };
  "run.started": { operationId: string };
  "run.retry_started": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "run.retry_completed": { success: boolean; attempt: number; error?: string };
  "run.settled": { operationId?: string; result: LastRunResult; stopReason?: string; error?: string };
  "message.submitted": { operationId: string; messageId: string; role: "user"; text: string };
  "message.delta": { messageId: string; block: "text" | "thinking"; delta: string };
  "message.completed": { messageId: string; role: "user" | "assistant" | "tool" | "system"; content: ContentBlockDto[]; stopReason?: string; error?: string };
  "tool.started": { toolCallId: string; toolName: string; args: JsonObject; omittedFields?: string[] };
  "tool.args_updated": { toolCallId: string; args: JsonObject; omittedFields?: string[] };
  "tool.output_updated": { toolCallId: string; text: string };
  "tool.completed": { toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] };
  "queue.changed": PendingDto;
  "queue.cleared": PendingDto;
  "compaction.started": { reason: "manual" | "threshold" | "overflow" };
  "compaction.completed": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; error?: string };
  "session.replaced": { reason: "new" | "resume" | "fork" | "reload"; previousSessionFile?: string; sessionFile?: string; runtimeGeneration: number; cwd: string; piSessionId: string };
  "session.info_changed": { name?: string };
  "session.metrics_changed": { metrics: SessionMetricsDto };
  "model.changed": { provider: string; id: string; thinkingLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[] };
  "thinking.changed": { requested: RuntimeThinkingLevel; thinkingLevel: RuntimeThinkingLevel; availableThinkingLevels: RuntimeThinkingLevel[] };
  "resources.reloaded": { resources: ResourceDto[]; diagnostics: DiagnosticDto[] };
  "settings.changed": SettingsChangedData;
  "settings.write_failed": { key: keyof SettingValueMap | "model" | "thinking"; error: string };
  "interaction.requested":
    | { interactionId: string; method: "select"; title: string; options: string[]; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "confirm"; title: string; message: string; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "input"; title: string; placeholder?: string; issuedAt: string; expiresAt: string }
    | { interactionId: string; method: "editor"; title: string; prefill?: string; issuedAt: string; expiresAt: string };
  "interaction.resolved": { interactionId: string; method: "select" | "confirm" | "input" | "editor" };
  "interaction.cancelled": { interactionId: string; method: "select" | "confirm" | "input" | "editor"; reason: "user" | "timeout" | "signal" | "detach" | "replacement" | "host_draining" | "overflow" };
  "extension.notification": { message: string; level: "info" | "warning" | "error" };
  "extension.status_changed": { key: string; text?: string };
  "extension.widget_changed": { key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
  "extension.error": { source?: string; event?: string; error: string };
}

export interface EventCursor {
  hostEpoch: string;
  instanceId: string;
  runtimeGeneration: number;
  sequence: number;
}

export interface InstanceSnapshot {
  id: string;
  creationOperationId: string;
  name?: string;
  cwd: string;
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  lastRun: LastRunResult;
  reopenable: boolean;
  runtimeGeneration: number;
  ownerHostEpoch?: string;
  interruption?: { reason: "host_crash" | "host_shutdown" | "replacement_failed"; at: string };
  pending: {
    steering: number;
    followUp: number;
    total: number;
  };
  executor: ExecutorIdentity;
  metrics?: SessionMetricsDto;
  extensionStatus: Record<string, string>;
  activeInteraction?: { id: string; method: "select" | "confirm" | "input" | "editor"; expiresAt: string };
  activeCommandId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  eventCursor: EventCursor;
}

export type DockEvent = {
  [K in keyof EventDataMap]: {
    scope: "instance";
    sequence: number;
    instanceId: string;
    runtimeGeneration: number;
    occurredAt: string;
    type: K;
    data: EventDataMap[K];
  }
}[keyof EventDataMap];

export interface EventPage {
  events: DockEvent[];
  earliest: EventCursor;
  latest: EventCursor;
  truncated: boolean;
}

export interface AttachProjection {
  instance: InstanceSnapshot;
  page: EventPage;
  recentHistory: HistoryEntryDto[];
  historyTruncated: boolean;
  replaySince: number;
  epochChanged: boolean;
  generationChanged: boolean;
}

export interface CommandReceipt {
  accepted: true;
  instanceId: string;
  operationId: string;
  delivery: Exclude<DeliveryMode, "auto">;
  queued: boolean;
  acceptedAt: string;
}

export interface StopReceipt {
  operationId: string;
  instanceId: string;
  stopped: true;
  alreadyStopped: boolean;
  cleanupErrors?: string[];
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

interface MutableState {
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  lastRun: LastRunResult;
  pendingSteering: number;
  pendingFollowUp: number;
  activeCommandId?: string;
  lastError?: string;
  updatedAt: string;
}

interface WorkingCheckpoint {
  state: MutableState;
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
  replacementIntent: CatalogInstanceRecord["replacement"];
  recoverySessionFile: string | undefined;
  stopRequestedAt: string | undefined;
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

export class InstanceBusyError extends Error {
  constructor(instanceId: string, action: string) {
    super(`Instance ${instanceId} must be idle before ${action}`);
    this.name = "InstanceBusyError";
  }
}

export class InvalidHistoryCursorError extends Error {
  constructor(readonly beforeEntryId: string) {
    super(`History entry ${beforeEntryId} does not belong to the current session branch`);
    this.name = "InvalidHistoryCursorError";
  }
}

export class RuntimeEffectUnknownError extends Error {
  readonly queryHint = "Query the instance snapshot before any retry";

  constructor(readonly operationId: string, cause?: unknown) {
    super(`Runtime abort may have taken effect for operation ${operationId}`);
    this.name = "RuntimeEffectUnknownError";
    this.cause = cause;
  }
}

export class ManagedInstance {
  readonly id: string;
  readonly creationOperationId: string;
  readonly hostEpoch: string;
  readonly name: string | undefined;
  readonly createdAt: string;

  private readonly session: RuntimeSession;
  private cwdValue: string;
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
  private readonly receiptBoundaryTasks: Promise<void>[] = [];
  private replacementIntent: CatalogInstanceRecord["replacement"];
  private recoverySessionFile: string | undefined;
  private stopRequestedAt: string | undefined;
  private transitionTail: Promise<void> = Promise.resolve();
  private historyRefreshTail: Promise<void> = Promise.resolve();
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
  private readonly announcedToolCalls = new Set<string>();
  private lastAssistantOutcome: AssistantOutcome | undefined;
  private pendingAdmission: PendingAdmission | undefined;
  private stopRequestedWhileRunning = false;
  private compactionActive = false;
  private compactionBoundary: Promise<void> | undefined;
  private resolveCompactionBoundary: (() => void) | undefined;
  private configurationPending = false;
  private configurationBoundary: Promise<void> | undefined;
  private resolveConfigurationBoundary: (() => void) | undefined;
  private commandAbortPending = false;
  private commandAbortBoundary: Promise<void> | undefined;
  private resolveCommandAbortBoundary: (() => void) | undefined;
  private projectionGateTail: Promise<void> = Promise.resolve();
  private releaseConfigurationGate: (() => void) | undefined;
  private stopPromise: Promise<StopReceipt> | undefined;

  get runtimeGeneration(): number { return this.runtimeGenerationValue; }
  get cwd(): string { return this.cwdValue; }

  constructor(options: ManagedInstanceOptions) {
    this.id = options.id ?? randomUUID();
    this.creationOperationId = options.creationOperationId ?? randomUUID();
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.name = options.name;
    this.cwdValue = options.cwd;
    this.session = options.session;
    const requestedCapacity = options.eventCapacity ?? 500;
    this.eventCapacity = Number.isFinite(requestedCapacity) && requestedCapacity >= 1
      ? Math.floor(requestedCapacity)
      : 500;
    this.now = options.now ?? (() => new Date());
    this.createCommandId = options.commandId ?? randomUUID;

    const createdAt = this.timestamp();
    this.createdAt = createdAt;
    this.state = {
      lifecycle: "active",
      execution: "idle",
      lastRun: "never",
      pendingSteering: 0,
      pendingFollowUp: 0,
      updatedAt: createdAt,
    };
    this.executorIdentity = {
      kind: truncate(options.executor?.kind ?? "pi-sdk", 128) ?? "pi-sdk",
      version: truncate(options.executor?.version, 128),
      model: options.executor?.model ? { provider: truncate(options.executor.model.provider, 256) ?? "unknown", id: truncate(options.executor.model.id, 512) ?? "unknown", name: truncate(options.executor.model.name, 256) } : undefined,
      thinkingLevel: options.executor?.thinkingLevel,
      piSessionId: truncate(this.session.sessionId, 128) ?? "unknown",
      sessionFile: truncate(this.session.sessionFile, 16_384),
    };
    this.historyValue = this.session.getHistory().map(projectRuntimeHistoryEntry);
    this.metricsValue = projectRuntimeMetrics(this.session.getMetrics());

    this.session.subscribe((event) => this.dispatchRuntimeEvent(event));

    this.appendEvent("instance.created", {
      cwd: this.cwd,
      name: this.name,
      executor: this.executorIdentity,
    });
  }

  snapshot(): InstanceSnapshot {
    const snapshot = this.committedSnapshotValue ?? this.workingSnapshot();
    validateInstanceStateInvariant({
      lifecycle: snapshot.lifecycle,
      execution: snapshot.execution,
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
      ...(snapshot.executor.sessionFile === undefined ? {} : { sessionFile: snapshot.executor.sessionFile }),
      ...(snapshot.executor.model === undefined ? {} : { model: { provider: snapshot.executor.model.provider, id: snapshot.executor.model.id } }),
      ...(snapshot.executor.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.executor.thinkingLevel }),
      ...(snapshot.activeCommandId === undefined ? {} : { activeCommandId: snapshot.activeCommandId }),
      admissionPending: this.catalogAdmissionOperationId !== undefined,
      ...(this.catalogAdmissionOperationId === undefined ? {} : { admissionOperationId: this.catalogAdmissionOperationId }),
      pendingCount: snapshot.pending.total,
      ...(this.replacementIntent === undefined ? {} : { replacement: cloneJson(this.replacementIntent) }),
      ...(this.recoverySessionFile === undefined ? {} : { recoverySessionFile: this.recoverySessionFile }),
      ...(this.stopRequestedAt === undefined ? {} : { stopRequestedAt: this.stopRequestedAt }),
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

  disposeForHostDrain(): Promise<void> {
    if (this.hostDrainPromise) return this.hostDrainPromise;
    this.hostDrainActive = true;
    this.hostDrainPromise = (async () => {
      await this.transitionTail;
      const admission = this.pendingAdmission;
      this.pendingAdmission = undefined;
      admission?.release();
      try { this.clearRuntimeQueueOnce(); } catch { /* Best-effort non-catalog drain. */ }
      try { await this.abortRuntimeOnce(); } catch { /* Best-effort non-catalog drain. */ }
      try { await this.disposeRuntimeOnce(); } catch { /* Host reports the fatal catalog fault. */ }
    })();
    return this.hostDrainPromise;
  }

  private workingSnapshot(): InstanceSnapshot {
    return {
      id: this.id,
      creationOperationId: this.creationOperationId,
      name: this.name,
      cwd: this.cwd,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      lastRun: this.state.lastRun,
      reopenable: false,
      runtimeGeneration: this.runtimeGeneration,
      ownerHostEpoch: this.state.lifecycle === "active" || this.state.lifecycle === "stopping" ? this.hostEpoch : undefined,
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
      extensionStatus: {},
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

  synchronizeModelState(): void {
    this.applyModelState(this.session.getModelState());
  }

  async listModels(): Promise<{ models: RuntimeModelInfo[]; state: RuntimeModelState }> {
    return this.withProjectionRead(async () => {
      const models = (await this.session.listModels()).slice(0, 2_000).map((model) => ({
        ...model,
        provider: truncate(model.provider, 256) ?? "unknown",
        id: truncate(model.id, 512) ?? "unknown",
        name: truncate(model.name, 256) ?? "unknown",
      }));
      return { models, state: this.session.getModelState() };
    });
  }

  async listSessions(scope: "cwd" | "all"): Promise<SessionDto[]> {
    return this.withProjectionRead(async () => {
      const sessions = await this.session.listSessions(scope);
      return sessions.slice(0, 2_000).map((session) => ({
        sessionId: truncate(session.sessionId, 128) ?? "unknown",
        sessionFile: truncate(session.sessionFile, 16_384) ?? "",
        ...(session.name === undefined ? {} : { name: truncate(session.name, 256) ?? "" }),
        cwd: truncate(session.cwd, 16_384) ?? "",
        ...(isIsoTimestamp(session.updatedAt) ? { updatedAt: session.updatedAt } : {}),
      }));
    });
  }

  async getHistoryPage(beforeEntryId: string | undefined, limit: number): Promise<HistoryPageDto & { instance: InstanceSnapshot }> {
    return this.withCommittedProjectionRead(() => ({ ...this.buildHistoryPage(beforeEntryId, limit), instance: this.snapshot() }));
  }

  async getAttachProjection(cursor: EventCursor | undefined, historyLimit = 200): Promise<AttachProjection> {
    return this.withCommittedProjectionRead(() => {
      const instance = this.snapshot();
      const epochChanged = cursor !== undefined && cursor.hostEpoch !== this.hostEpoch;
      const generationChanged = cursor !== undefined && cursor.runtimeGeneration !== instance.runtimeGeneration;
      const replaySince = epochChanged || generationChanged ? 0 : cursor?.sequence ?? 0;
      const sourcePage = this.eventsSince(replaySince);
      const history = this.buildHistoryPage(undefined, historyLimit);
      const page = { ...sourcePage, events: eventsNotCoveredByHistory(sourcePage.events, this.historyValue) };
      return {
        instance,
        page,
        recentHistory: history.entries,
        historyTruncated: history.hasEarlier,
        replaySince,
        epochChanged,
        generationChanged,
      };
    });
  }

  async listTools(): Promise<ToolDto[]> {
    return this.withProjectionRead(async () => cloneJson(await this.session.listTools()).slice(0, 2_000));
  }

  async setActiveTools(names: string[], operationId = this.createCommandId()): Promise<ToolDto[]> {
    await this.beginConfiguration("changing active tools");
    try {
      const tools = cloneJson(await this.session.setActiveTools([...names])).slice(0, 2_000);
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: "tool.set_active", effect: "post_effect", operationId, instanceId: this.id },
        () => this.touch(),
      ));
      return tools;
    } finally {
      this.endConfiguration();
    }
  }

  async getSettings(): Promise<SettingDto[]> {
    return this.withProjectionRead(async () => cloneJson(await this.session.getSettings()));
  }

  async updateSetting(update: SettingUpdate, operationId = this.createCommandId()): Promise<SettingDto> {
    await this.beginConfiguration("changing settings");
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

  async getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[] }> {
    return this.withProjectionRead(async () => {
      const result = cloneJson(await this.session.getResources());
      return { resources: result.resources.slice(0, 2_000), diagnostics: result.diagnostics.slice(0, 2_000) };
    });
  }

  async getCommands(prefix?: string): Promise<CommandDto[]> {
    return this.withProjectionRead(async () => {
      const commands = cloneJson(await this.session.getCommands());
      return commands.filter((command) => prefix === undefined || command.name.startsWith(prefix)).slice(0, 2_000);
    });
  }

  async newSession(operationId: string): Promise<RuntimeReplacementResult> {
    return this.replaceRuntime("creating a new session", operationId, "new", undefined, async () => {
      if (!this.session.newSession) throw new Error("Runtime does not support session replacement");
      return this.session.newSession(operationId);
    });
  }

  async switchSession(
    operationId: string,
    sessionFile: string,
    trust: RuntimeProjectTrust,
  ): Promise<RuntimeReplacementResult> {
    return this.replaceRuntime("switching session", operationId, "switch", sessionFile, async () => {
      if (!this.session.switchSession) throw new Error("Runtime does not support session replacement");
      return this.session.switchSession(operationId, sessionFile, trust);
    });
  }

  async reloadSession(operationId: string): Promise<RuntimeReplacementResult> {
    return this.replaceRuntime("reloading resources", operationId, "reload", undefined, async () => {
      if (!this.session.reload) throw new Error("Runtime does not support reload");
      return this.session.reload(operationId);
    });
  }

  async selectModel(provider: string, modelId: string, operationId = this.createCommandId()): Promise<RuntimeModelState> {
    await this.beginConfiguration("switching model");
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
    await this.beginConfiguration("changing thinking level");
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
    if (this.configurationPending || this.commandAbortPending) throw new InstanceBusyError(this.id, "submitting a prompt");
    if (message.trim().length === 0) {
      throw new Error("Prompt message must not be empty");
    }

    const running = this.state.execution === "running" || this.session.isStreaming;
    const resolvedDelivery = resolveDelivery(delivery, running);
    const streamingBehavior = resolvedDelivery === "steer" || resolvedDelivery === "followUp"
      ? resolvedDelivery
      : undefined;
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
      if (streamingBehavior !== undefined && !this.session.isStreaming) {
        actualDelivery = "prompt";
        actuallyQueued = false;
      }

      const acceptedAt = this.timestamp();
      preflightTransition = this.enqueueTransition(() => this.commitCatalogTransition(
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
          this.appendEvent("message.submitted", {
            operationId: commandId,
            messageId: `user-${commandId}`,
            role: "user",
            text: message,
          }, acceptedAt);
          this.appendEvent("command.accepted", {
            operationId: commandId,
            delivery: actualDelivery,
            queued: actuallyQueued,
            acceptedAt,
          }, acceptedAt);
          this.appendStateEvent("command_accepted", acceptedAt);
        },
      ));
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

  async abort(operationId = this.createCommandId()): Promise<void> {
    this.catalogPort?.assertWritable();
    this.assertActive();
    if (this.commandAbortPending) throw new InstanceBusyError(this.id, "aborting the current run");
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
    if (configurationBoundary) await configurationBoundary;
    const commandAbortBoundary = this.commandAbortBoundary;
    if (commandAbortBoundary) await commandAbortBoundary;
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
    return this.performStop(operationId, admissionBoundary);
  }

  recordExtensionError(error: unknown): void {
    if (this.hostDrainActive) return;
    this.appendEvent("extension.error", { error: safeWireText(errorMessage(error), 2_048, "Sensitive error payload omitted") });
  }

  private async performStop(operationId: string, admissionBoundary?: Promise<void>): Promise<StopReceipt> {
    const cleanupErrors: string[] = [];
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

    let abortSucceeded = false;
    try {
      await this.abortRuntimeOnce();
      abortSucceeded = true;
    } catch (error) {
      captureCleanupError("abort", error);
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
        this.state.activeCommandId = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        if (cleanupErrors.length > 0) this.state.lastError = cleanupErrors.join("; ");
        this.touch();
      },
      () => {
        if (clearedCounts && (clearedCounts.steering > 0 || clearedCounts.followUp > 0)) {
          this.appendEvent("queue.cleared", {
            steering: clearedCounts.steering,
            followUp: clearedCounts.followUp,
            total: clearedCounts.steering + clearedCounts.followUp,
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
      if (this.catalogPort) await this.catalogPort.commit(this.catalogRecord(), context);
    } catch (error) {
      if (context.effect !== "post_effect") this.restoreWorkingCheckpoint(checkpoint);
      throw error;
    }
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
    publish();
    if (this.catalogPort) this.committedSnapshotValue = this.workingSnapshot();
  }

  private captureWorkingCheckpoint(): WorkingCheckpoint {
    return {
      state: cloneJson(this.state),
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
      replacementIntent: this.replacementIntent ? cloneJson(this.replacementIntent) : undefined,
      recoverySessionFile: this.recoverySessionFile,
      stopRequestedAt: this.stopRequestedAt,
    };
  }

  private restoreWorkingCheckpoint(checkpoint: WorkingCheckpoint): void {
    this.state = checkpoint.state;
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
    this.replacementIntent = checkpoint.replacementIntent;
    this.recoverySessionFile = checkpoint.recoverySessionFile;
    this.stopRequestedAt = checkpoint.stopRequestedAt;
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

  private async beginConfiguration(action: string): Promise<void> {
    this.catalogPort?.assertWritable();
    this.assertActive();
    if (
      this.configurationPending
      || this.commandAbortPending
      || this.pendingAdmission !== undefined
      || this.state.execution === "running"
      || this.session.isStreaming
    ) {
      throw new InstanceBusyError(this.id, action);
    }
    this.configurationPending = true;
    this.configurationBoundary = new Promise<void>((resolve) => { this.resolveConfigurationBoundary = resolve; });
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
    this.releaseConfigurationGate?.();
    this.releaseConfigurationGate = undefined;
    this.resolveConfigurationBoundary?.();
    this.resolveConfigurationBoundary = undefined;
    this.configurationBoundary = undefined;
  }

  private async replaceRuntime(
    action: string,
    operationId: string,
    kind: "new" | "switch" | "reload",
    requestedSessionFile: string | undefined,
    replace: () => Promise<RuntimeReplacementResult>,
  ): Promise<RuntimeReplacementResult> {
    await this.beginConfiguration(action);
    try {
      const startedAt = this.timestamp();
      await this.enqueueTransition(() => this.commitCatalogTransition(
        { kind: `session.${kind}.intent`, effect: "pre_effect", operationId, instanceId: this.id },
        () => {
          this.replacementIntent = {
            operationId,
            kind,
            ...(this.executorIdentity.sessionFile === undefined ? {} : { previousSessionFile: this.executorIdentity.sessionFile }),
            ...(requestedSessionFile === undefined ? {} : { requestedSessionFile }),
            startedAt,
          };
          this.touch(startedAt);
        },
      ));
      let result: RuntimeReplacementResult;
      this.receiptBoundaryOperationId = operationId;
      try { result = await replace(); }
      catch (error) {
        await this.closeRuntimeOperationBoundary(operationId);
        if (this.replacementIntent) {
          await this.enqueueTransition(() => this.commitCatalogTransition(
            { kind: `session.${kind}.failed`, effect: "post_effect", operationId, instanceId: this.id },
            () => { this.replacementIntent = undefined; this.touch(); },
          ));
        }
        throw error;
      }
      await this.closeRuntimeOperationBoundary(operationId);
      if (result.cancelled && this.replacementIntent) {
        await this.enqueueTransition(() => this.commitCatalogTransition(
          { kind: `session.${kind}.cancelled`, effect: "post_effect", operationId, instanceId: this.id },
          () => { this.replacementIntent = undefined; this.touch(); },
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

  private dispatchRuntimeEvent(event: RuntimeEvent): void {
    if (this.hostDrainActive) return;
    if (!this.catalogPort) {
      try { this.handleRuntimeEvent(event); if (refreshesHistory(event)) this.refreshHistory(); if (refreshesMetrics(event)) this.refreshMetrics(); }
      catch (error) { this.appendProjectionError(event, error); }
      return;
    }
    if (this.catalogAdmissionOperationId !== undefined) {
      if (this.admissionBufferedEvents.length >= 1_000) this.admissionBufferOverflow = true;
      else this.admissionBufferedEvents.push(event);
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
      tasks.push(this.enqueueCatalogRuntimeEvent({ type: "dock_extension_error", error: "Admission runtime event buffer exceeded 1000 events" }));
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
    const operationId = this.catalogAdmissionOperationId
      ?? this.receiptBoundaryOperationId
      ?? this.replacementIntent?.operationId
      ?? this.state.activeCommandId;
    const context = (kind: string): CatalogMutationContext => ({
      kind,
      effect: "post_effect",
      ...(operationId === undefined ? {} : { operationId }),
      instanceId: this.id,
    });
    if (event.type === "dock_session_replaced") {
      const previousSessionFile = optionalRuntimeString(event.previousSessionFile, 16_384);
      const sessionFile = optionalRuntimeString(event.sessionFile, 16_384);
      const cwd = optionalRuntimeString(event.cwd, 16_384);
      const reason = event.reason === "resume" || event.reason === "reload" ? event.reason : "new";
      await this.commitCatalogTransition(context("session.replaced"), () => {
        this.runtimeGenerationValue += 1;
        this.replacementIntent = undefined;
        this.recoverySessionFile = undefined;
        this.agentStartCount = 0;
        this.agentSettledCount = 0;
        this.assistantMessageSequence = 0;
        this.currentAssistantMessageId = undefined;
        this.announcedToolCalls.clear();
        this.lastAssistantOutcome = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        if (cwd !== undefined) this.cwdValue = cwd;
        this.executorIdentity.piSessionId = truncate(this.session.sessionId, 128) ?? "unknown";
        this.executorIdentity.sessionFile = truncate(this.session.sessionFile, 16_384);
        this.applyModelState(this.session.getModelState());
        this.touch();
      }, () => {
        this.publishedRuntimeGenerationValue = this.runtimeGenerationValue;
        this.nextEventSequence = 1;
        this.eventLog.length = 0;
        this.appendEvent("session.replaced", { reason, previousSessionFile, sessionFile, runtimeGeneration: this.runtimeGenerationValue, cwd: this.cwdValue, piSessionId: this.executorIdentity.piSessionId });
      });
      return;
    }
    if (event.type === "dock_runtime_error") {
      const error = boundedRuntimeString(event.error, 2_048, "Runtime replacement failed");
      const recoverySessionFile = optionalRuntimeString(event.recoverySessionFile, 16_384)
        ?? this.replacementIntent?.previousSessionFile;
      await this.commitCatalogTransition(context("session.runtime_error"), () => {
        this.replacementIntent = undefined;
        this.recoverySessionFile = recoverySessionFile;
        this.state.lifecycle = "runtime_error";
        this.state.execution = "unavailable";
        this.state.activeCommandId = undefined;
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        this.state.lastError = error;
        this.touch();
      }, () => {
        this.appendEvent("instance.runtime_error", {
          operationId: boundedRuntimeString(event.operationId, 128, "runtime-internal"),
          kind: event.kind === "reload" || event.kind === "switch" ? event.kind : "new",
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
          this.startCompactionBoundary();
          this.state.execution = "running";
          this.touch();
        }, () => this.appendEvent("compaction.started", { reason: compactionReason(event.reason) }));
        return;
      case "compaction_end": {
        try {
          await this.commitCatalogTransition(context("compaction.completed"), () => {
            if (this.state.activeCommandId === undefined && event.willRetry !== true) this.state.execution = "idle";
            this.touch();
          }, () => {
            this.appendEvent("compaction.completed", {
              reason: compactionReason(event.reason),
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
    if (event.type === "dock_session_replaced") {
      const previousSessionFile = optionalRuntimeString(event.previousSessionFile, 16_384);
      const sessionFile = optionalRuntimeString(event.sessionFile, 16_384);
      const cwd = optionalRuntimeString(event.cwd, 16_384);
      const reason = event.reason === "resume" || event.reason === "reload" ? event.reason : "new";
      this.runtimeGenerationValue += 1;
      this.publishedRuntimeGenerationValue = this.runtimeGenerationValue;
      this.replacementIntent = undefined;
      this.recoverySessionFile = undefined;
      this.nextEventSequence = 1;
      this.eventLog.length = 0;
      this.agentStartCount = 0;
      this.agentSettledCount = 0;
      this.assistantMessageSequence = 0;
      this.currentAssistantMessageId = undefined;
      this.announcedToolCalls.clear();
      this.lastAssistantOutcome = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      if (cwd !== undefined) this.cwdValue = cwd;
      this.executorIdentity.piSessionId = truncate(this.session.sessionId, 128) ?? "unknown";
      this.executorIdentity.sessionFile = truncate(this.session.sessionFile, 16_384);
      this.applyModelState(this.session.getModelState());
      this.touch();
      this.appendEvent("session.replaced", { reason, previousSessionFile, sessionFile, runtimeGeneration: this.runtimeGenerationValue, cwd: this.cwdValue, piSessionId: this.executorIdentity.piSessionId });
      return;
    }
    if (event.type === "dock_runtime_error") {
      this.recoverySessionFile = optionalRuntimeString(event.recoverySessionFile, 16_384)
        ?? this.replacementIntent?.previousSessionFile;
      this.replacementIntent = undefined;
      this.state.lifecycle = "runtime_error";
      this.state.execution = "unavailable";
      this.state.activeCommandId = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      this.state.lastError = boundedRuntimeString(event.error, 2_048, "Runtime replacement failed");
      this.touch();
      this.appendEvent("instance.runtime_error", {
        operationId: boundedRuntimeString(event.operationId, 128, "runtime-internal"),
        kind: event.kind === "reload" || event.kind === "switch" ? event.kind : "new",
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
      case "agent_start":
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

      case "agent_settled":
        this.handleAgentSettled();
        break;

      case "queue_update": {
        const steering = stringArray(event.steering);
        const followUp = stringArray(event.followUp);
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
        this.startCompactionBoundary();
        this.state.execution = "running";
        this.touch();
        this.appendEvent("compaction.started", { reason: compactionReason(event.reason) });
        break;

      case "compaction_end":
        if (this.state.activeCommandId === undefined && event.willRetry !== true) this.state.execution = "idle";
        this.touch();
        this.appendEvent("compaction.completed", {
          reason: compactionReason(event.reason),
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
    const operationId = this.receiptBoundaryOperationId ?? this.state.activeCommandId;
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

  private startCompactionBoundary(): void {
    if (this.compactionActive) return;
    this.compactionActive = true;
    this.compactionBoundary = new Promise<void>((resolve) => { this.resolveCompactionBoundary = resolve; });
  }

  private finishCompactionBoundary(): void {
    this.compactionActive = false;
    this.resolveCompactionBoundary?.();
    this.resolveCompactionBoundary = undefined;
    this.compactionBoundary = undefined;
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
    } else if (role === "user" && this.state.activeCommandId) {
      messageId = `user-${this.state.activeCommandId}`;
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
    this.state.updatedAt = timestamp;
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
  return event.type === "entry_appended" || event.type === "message_end" || event.type === "dock_session_replaced";
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
  for (const item of content.slice(0, 200)) {
    const block = recordValue(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (isBinaryText(block.text)) {
        blocks.push({ type: "omitted", kind: "binary", description: "Binary data omitted" });
      } else {
        blocks.push({ type: "text", text: truncate(block.text, 8_000) ?? "" });
      }
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      if (isBinaryText(block.thinking)) {
        blocks.push({ type: "omitted", kind: "binary", description: "Binary data omitted" });
      } else {
        blocks.push({ type: "thinking", text: truncate(block.thinking, 8_000) ?? "" });
      }
    } else if ((block.type === "toolCall" || block.type === "tool_call") && typeof block.name === "string") {
      const projected = projectJsonObject(block.arguments);
      blocks.push({
        type: "tool_call",
        toolCallId: boundedRuntimeString(block.id, 128, "unknown"),
        toolName: boundedRuntimeString(block.name, 256, "unknown"),
        args: projected.value,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      });
    } else if (block.type === "toolResult" || block.type === "tool_result") {
      const projected = projectJsonObject(block);
      blocks.push({
        type: "tool_result",
        toolCallId: boundedRuntimeString(block.toolCallId ?? block.id, 128, "unknown"),
        toolName: boundedRuntimeString(block.toolName ?? block.name, 256, "unknown"),
        text: projectToolText(block.content),
        isError: block.isError === true,
        ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
      });
    } else if (block.type === "image") {
      blocks.push({ type: "omitted", kind: "image", description: "Image bytes omitted; local path remains in tool text when provided" });
    }
  }
  return blocks;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return limit < 1 ? "" : `${value.slice(0, limit - 1)}…`;
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
const SENSITIVE_KEY = /base64|binary|imageData/i;
const DATA_URI = /data:[^,]*;base64,/i;
const BASE64_PAYLOAD = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isBinaryText(value: string): boolean {
  return DATA_URI.test(value) || BASE64_PAYLOAD.test(value);
}

export function projectJsonObject(input: unknown): { value: JsonObject; omittedFields: string[] } {
  const omittedFields: string[] = [];
  const seen = new WeakSet<object>();
  const project = (value: unknown, path: string, depth: number): JsonValue | undefined => {
    if (typeof value === "string") {
      if (isBinaryText(value)) { omittedFields.push(path || "/"); return undefined; }
      return truncate(value, MAX_JSON_STRING) ?? "";
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      omittedFields.push(path || "/");
      return undefined;
    }
    if (typeof value !== "object" || value === null || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      omittedFields.push(path || "/");
      return undefined;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      omittedFields.push(path || "/");
      return undefined;
    }
    if (depth >= MAX_JSON_DEPTH || seen.has(value)) {
      omittedFields.push(path || "/");
      return undefined;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}/${index}`;
        if (index >= MAX_JSON_ARRAY) { omittedFields.push(itemPath); continue; }
        const item = project(value[index], itemPath, depth + 1);
        if (item !== undefined) result.push(item);
      }
      return result;
    }
    const result: JsonObject = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      const [key, item] = entries[index] as [string, unknown];
      const itemPath = `${path}/${escapeJsonPointer(key)}`;
      if (index >= MAX_JSON_KEYS || SENSITIVE_KEY.test(key)) { omittedFields.push(itemPath); continue; }
      const projected = project(item, itemPath, depth + 1);
      if (projected !== undefined) result[key] = projected;
    }
    return result;
  };
  const value = project(input, "", 0);
  return { value: isJsonObject(value) ? value : {}, omittedFields: [...new Set(omittedFields)] };
}

function escapeJsonPointer(value: string): string { return value.replace(/~/g, "~0").replace(/\//g, "~1"); }
function isIsoTimestamp(value: string | undefined): value is string { return value !== undefined && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value); }
function projectToolText(content: unknown): string {
  const text = extractText(content);
  if (!text || isBinaryText(text)) return "";
  return truncate(text, 8_000) ?? "";
}
