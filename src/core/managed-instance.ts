import { randomUUID } from "node:crypto";

import { RuntimeSettingsWriteError } from "./runtime-session.js";
import type {
  RuntimeEvent,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeSession,
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
export interface SessionMetricsDto {
  messages: { user: number; assistant: number; toolCalls: number; toolResults: number; total: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}
export interface SourceDto { kind: "built-in" | "extension" | "skill" | "prompt"; path?: string; package?: string }
export interface ResourceDto { kind: "extension" | "skill" | "prompt" | "context"; name: string; path?: string; source?: SourceDto }
export interface DiagnosticDto { severity: "info" | "warning" | "error"; message: string; source?: string }
export interface SessionDto { sessionId: string; sessionFile: string; name?: string; cwd: string; updatedAt?: string }
export interface SettingValueMap {
  autoCompaction: boolean; autoRetry: boolean; enableSkillCommands: boolean; hideThinking: boolean; showCacheMissNotices: boolean;
  showHardwareCursor: boolean; clearOnShrink: boolean; showTerminalProgress: boolean; quietStartup: boolean;
  steeringMode: "all" | "one-at-a-time"; followUpMode: "all" | "one-at-a-time";
  transport: "auto" | "sse" | "websocket" | "websocket-cached"; doubleEscapeAction: "fork" | "tree" | "none";
  treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; defaultProjectTrust: "ask" | "always" | "never";
  httpIdleTimeoutMs: number; editorPaddingX: number; outputPad: 0 | 1; autocompleteMaxVisible: number;
  warnings: { anthropicExtraUsage?: boolean };
}
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
  "session.replaced": { reason: "new" | "resume" | "fork" | "reload"; previousSessionFile?: string; sessionFile?: string; runtimeGeneration: number };
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

export class ManagedInstance {
  readonly id: string;
  readonly creationOperationId: string;
  readonly hostEpoch: string;
  readonly runtimeGeneration = 1;
  readonly name: string | undefined;
  readonly cwd: string;
  readonly createdAt: string;

  private readonly session: RuntimeSession;
  private readonly executorIdentity: ExecutorIdentity;
  private readonly eventCapacity: number;
  private readonly now: () => Date;
  private readonly createCommandId: () => string;
  private readonly eventLog: DockEvent[] = [];
  private readonly subscribers = new Set<(event: DockEvent) => void>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly unsubscribeRuntime: () => void;

  private state: MutableState;
  private nextEventSequence = 1;
  private agentStartCount = 0;
  private agentSettledCount = 0;
  private lastAssistantOutcome: AssistantOutcome | undefined;
  private pendingAdmission: PendingAdmission | undefined;
  private stopRequestedWhileRunning = false;
  private configurationPending = false;
  private stopPromise: Promise<StopReceipt> | undefined;

  constructor(options: ManagedInstanceOptions) {
    this.id = options.id ?? randomUUID();
    this.creationOperationId = options.creationOperationId ?? randomUUID();
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.name = options.name;
    this.cwd = options.cwd;
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

    this.unsubscribeRuntime = this.session.subscribe((event) => {
      try {
        this.handleRuntimeEvent(event);
      } catch (error) {
        this.appendEvent("instance.error", { source: "event_projection",
          error: safeWireText(errorMessage(error), 2_048, "Sensitive projection error omitted"),
          runtimeEventType: truncate(event.type, 128),
        });
      }
    });

    this.appendEvent("instance.created", {
      cwd: this.cwd,
      name: this.name,
      executor: this.executorIdentity,
    });
  }

  snapshot(): InstanceSnapshot {
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
      extensionStatus: {},
      activeCommandId: this.state.activeCommandId,
      lastError: this.state.lastError,
      createdAt: this.createdAt,
      updatedAt: this.state.updatedAt,
      eventCursor: this.cursor(this.nextEventSequence - 1),
    };
  }

  eventsSince(since: EventCursor | number = 0): EventPage {
    const sequence = typeof since === "number" ? since : since.sequence;
    const earliestSequence = this.eventLog[0]?.sequence ?? this.nextEventSequence;
    const latestSequence = this.nextEventSequence - 1;
    return {
      events: this.eventLog
        .filter((event) => event.sequence > sequence)
        .map((event) => cloneDockEvent(event)),
      earliest: this.cursor(earliestSequence),
      latest: this.cursor(latestSequence),
      truncated: sequence < earliestSequence - 1,
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
    this.assertActive();
    const models = (await this.session.listModels()).slice(0, 2_000).map((model) => ({
      ...model,
      provider: truncate(model.provider, 256) ?? "unknown",
      id: truncate(model.id, 512) ?? "unknown",
      name: truncate(model.name, 256) ?? "unknown",
    }));
    return { models, state: this.session.getModelState() };
  }

  async listSessions(scope: "cwd" | "all"): Promise<SessionDto[]> {
    this.assertActive();
    const sessions = await this.session.listSessions(scope);
    return sessions.slice(0, 2_000).map((session) => ({
      sessionId: truncate(session.sessionId, 128) ?? "unknown",
      sessionFile: truncate(session.sessionFile, 16_384) ?? "",
      ...(session.name === undefined ? {} : { name: truncate(session.name, 256) ?? "" }),
      cwd: truncate(session.cwd, 16_384) ?? "",
      ...(isIsoTimestamp(session.updatedAt) ? { updatedAt: session.updatedAt } : {}),
    }));
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    this.beginConfiguration("switching model");
    try {
      const state = await this.session.selectModel(provider, modelId);
      this.applyModelState(state);
      this.touch();
      this.appendModelChanged(state);
      return state;
    } catch (error) {
      if (error instanceof RuntimeSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.session.getModelState();
          this.applyModelState(state);
          this.touch();
          this.appendModelChanged(state);
        }
        this.appendSettingsWriteFailed(error);
      }
      throw error;
    } finally {
      this.configurationPending = false;
    }
  }

  async setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> {
    this.beginConfiguration("changing thinking level");
    try {
      const state = await this.session.setThinkingLevel(level);
      this.applyModelState(state);
      this.touch();
      this.appendThinkingChanged(level, state);
      return state;
    } catch (error) {
      if (error instanceof RuntimeSettingsWriteError) {
        if (error.mutationApplied) {
          const state = this.session.getModelState();
          this.applyModelState(state);
          this.touch();
          this.appendThinkingChanged(level, state);
        }
        this.appendSettingsWriteFailed(error);
      }
      throw error;
    } finally {
      this.configurationPending = false;
    }
  }

  async submit(message: string, delivery: DeliveryMode = "auto", operationId = this.createCommandId()): Promise<CommandReceipt> {
    this.assertActive();
    if (this.pendingAdmission) throw new InstanceAdmissionPendingError(this.id);
    if (this.configurationPending) throw new InstanceBusyError(this.id, "submitting a prompt");
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

    const rejectBeforeRun = (error: unknown, reason: string): void => {
      if (preflightStatus === "accepted" || (preflightStatus === "rejected" && receiptSettled)) return;
      preflightStatus = "rejected";
      const messageText = safeWireText(errorMessage(error), 2_048, "Sensitive command error omitted");
      this.state.lastError = messageText;
      this.touch();
      this.appendEvent("command.rejected", { operationId: commandId, reason, error: messageText });
      this.appendStateEvent("command_rejected");
      if (!receiptSettled) {
        receiptSettled = true;
        rejectReceipt(error);
      }
    };

    const onPreflight = (success: boolean): void => {
      if (preflightStatus !== "pending" || this.pendingAdmission?.token !== admissionToken) return;
      if (!success) {
        preflightStatus = "rejected";
        return;
      }
      if (this.state.lifecycle !== "active") {
        const error = new InstanceNotActiveError(this.id, this.state.lifecycle);
        rejectBeforeRun(error, "instance_not_active_after_preflight");
        release();
        return;
      }

      preflightStatus = "accepted";
      // Pi re-checks isStreaming only after asynchronous extension input hooks.
      // A requested steer/followUp can therefore become a fresh prompt if the
      // original run settles during preflight. At the callback boundary, a
      // queued delivery still has an active session; a fresh prompt has not yet
      // entered _runAgentPrompt and is idle.
      if (streamingBehavior !== undefined && !this.session.isStreaming) {
        actualDelivery = "prompt";
        actuallyQueued = false;
      }

      const acceptedAt = this.timestamp();
      this.state.lastError = undefined;
      if (!actuallyQueued) {
        this.state.execution = "running";
        this.state.activeCommandId = commandId;
      }
      this.touch(acceptedAt);
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
    };

    let runtimePromise: Promise<void>;
    try {
      runtimePromise = this.session.prompt(message, {
        streamingBehavior,
        source: "rpc",
        preflightResult: onPreflight,
      });
    } catch (error) {
      rejectBeforeRun(error, "prompt_threw_before_preflight");
      release();
      return receiptPromise;
    }

    const observedPromise = runtimePromise.then(() => {
      // Defensive fallback for adapters that resolve without invoking the typed
      // preflight callback. The official Pi adapter always invokes it.
      if (preflightStatus === "pending") onPreflight(true);
      if (
        preflightStatus === "accepted"
        && !actuallyQueued
        && this.state.lifecycle === "active"
        && this.state.execution === "running"
        && this.agentStartCount === agentStartsBeforeCommand
        && !this.session.isStreaming
      ) {
        this.state.execution = "idle";
        this.state.activeCommandId = undefined;
        this.touch();
        this.appendEvent("command.handled", { operationId: commandId, kind: "no_run" });
        this.appendStateEvent("command_handled_without_run");
      }
    }).catch((error: unknown) => {
      release();
      const messageText = safeWireText(errorMessage(error), 2_048, "Sensitive command error omitted");
      if (preflightStatus !== "accepted") {
        rejectBeforeRun(error, "preflight_failed");
        return;
      }

      this.appendEvent("instance.error", { operationId: commandId, source: "command_background", error: messageText });
      // Pi 0.80.6 emits agent_settled from _runAgentPrompt.finally before the
      // prompt Promise rejects. Only project a fallback failure if that public
      // lifecycle guarantee was not observed at all.
      if (
        this.state.lifecycle === "active"
        && this.agentStartCount > agentStartsBeforeCommand
        && this.agentSettledCount === agentSettlesBeforeCommand
      ) {
        this.state.execution = "failed";
        this.state.lastRun = "failed";
        this.state.activeCommandId = undefined;
        this.state.lastError = messageText;
        this.touch();
        this.appendEvent("run.settled", { operationId: commandId, result: "failed", error: messageText });
        this.appendStateEvent("prompt_rejected_without_agent_settled");
      }
    });

    let trackedPromise!: Promise<void>;
    trackedPromise = observedPromise.finally(() => {
      release();
      this.backgroundTasks.delete(trackedPromise);
    });
    this.backgroundTasks.add(trackedPromise);

    return receiptPromise;
  }

  async waitForIdle(): Promise<void> {
    await this.session.waitForIdle();
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  async stop(operationId = this.createCommandId()): Promise<StopReceipt> {
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

    this.stopRequestedWhileRunning = this.state.execution === "running" || this.session.isStreaming;
    const admissionBoundary = this.pendingAdmission?.boundary;
    this.state.lifecycle = "stopping";
    this.touch();
    this.appendStateEvent("stop_requested");

    this.stopPromise = this.performStop(operationId, admissionBoundary);
    return this.stopPromise;
  }

  recordExtensionError(error: unknown): void {
    this.appendEvent("extension.error", { error: safeWireText(errorMessage(error), 2_048, "Sensitive error payload omitted") });
  }

  private async performStop(operationId: string, admissionBoundary?: Promise<void>): Promise<StopReceipt> {
    const cleanupErrors: string[] = [];
    const captureCleanupError = (stage: string, error: unknown): void => {
      const message = safeWireText(`${stage}: ${errorMessage(error)}`, 2_048, `${stage}: sensitive cleanup error omitted`);
      cleanupErrors.push(message);
    };

    try {
      if (admissionBoundary) {
        try {
          await admissionBoundary;
        } catch (error) {
          captureCleanupError("preflight", error);
        }
      }

      try {
        const cleared = this.session.clearQueue();
        this.state.pendingSteering = 0;
        this.state.pendingFollowUp = 0;
        if (cleared.steering.length > 0 || cleared.followUp.length > 0) {
          this.appendEvent("queue.cleared", {
            steering: cleared.steering.length,
            followUp: cleared.followUp.length,
            total: cleared.steering.length + cleared.followUp.length,
          });
        }
      } catch (error) {
        captureCleanupError("clearQueue", error);
      }

      let abortSucceeded = false;
      try {
        await this.session.abort();
        abortSucceeded = true;
      } catch (error) {
        captureCleanupError("abort", error);
      }

      if (abortSucceeded && this.backgroundTasks.size > 0) {
        await Promise.allSettled([...this.backgroundTasks]);
      }

      try {
        this.session.dispose();
      } catch (error) {
        captureCleanupError("dispose", error);
      }

      try {
        this.unsubscribeRuntime();
      } catch (error) {
        captureCleanupError("unsubscribe", error);
      }
    } finally {
      this.state.lifecycle = "stopped";
      this.state.execution = "unavailable";
      this.state.activeCommandId = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      if (cleanupErrors.length > 0) this.state.lastError = cleanupErrors.join("; ");
      this.touch();
      this.appendEvent("instance.stopped", { cleanupErrors });
      this.appendStateEvent("stopped");
    }

    const receipt: StopReceipt = {
      operationId,
      instanceId: this.id,
      stopped: true,
      alreadyStopped: false,
    };
    if (cleanupErrors.length > 0) receipt.cleanupErrors = [...cleanupErrors];
    return receipt;
  }

  private assertActive(): void {
    if (this.state.lifecycle !== "active") {
      throw new InstanceNotActiveError(this.id, this.state.lifecycle);
    }
  }

  private beginConfiguration(action: string): void {
    this.assertActive();
    if (
      this.configurationPending
      || this.pendingAdmission !== undefined
      || this.state.execution === "running"
      || this.session.isStreaming
    ) {
      throw new InstanceBusyError(this.id, action);
    }
    this.configurationPending = true;
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

  private appendSettingsWriteFailed(error: RuntimeSettingsWriteError): void {
    this.appendEvent("settings.write_failed", {
      key: error.setting,
      error: safeWireText(error.message, 2_048, "Sensitive settings write error omitted"),
    });
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (this.state.lifecycle === "stopped") return;
    switch (event.type) {
      case "agent_start":
        this.agentStartCount += 1;
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
        const projected = projectJsonObject(event.args);
        this.appendEvent("tool.started", {
          toolCallId: boundedRuntimeString(event.toolCallId, 128, "unknown"),
          toolName: boundedRuntimeString(event.toolName, 256, "unknown"),
          args: projected.value,
          ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
        });
        break;
      }

      case "tool_execution_update":
        this.appendEvent("tool.output_updated", {
          toolCallId: boundedRuntimeString(event.toolCallId, 128, "unknown"),
          text: projectToolText(recordValue(event.partialResult)?.content),
        });
        break;

      case "tool_execution_end": {
        const projected = projectJsonObject(event.result);
        this.appendEvent("tool.completed", {
          toolCallId: boundedRuntimeString(event.toolCallId, 128, "unknown"),
          toolName: boundedRuntimeString(event.toolName, 256, "unknown"),
          isError: event.isError === true,
          text: projectToolText(recordValue(event.result)?.content),
          ...(projected.omittedFields.length > 0 ? { omittedFields: projected.omittedFields } : {}),
        });
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
        this.state.execution = "running";
        this.touch();
        this.appendEvent("compaction.started", { reason: compactionReason(event.reason) });
        break;

      case "compaction_end":
        this.appendEvent("compaction.completed", {
          reason: compactionReason(event.reason),
          aborted: event.aborted === true,
          willRetry: event.willRetry === true,
          error: optionalRuntimeString(event.errorMessage, 2_048),
        });
        break;

      default:
        break;
    }
  }

  private handleAgentSettled(): void {
    this.agentSettledCount += 1;
    const outcome = this.lastAssistantOutcome;
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
      result,
      stopReason: outcome?.stopReason,
      error: outcome?.errorMessage,
    });
    this.appendStateEvent("agent_settled");
  }

  private handleMessageUpdate(event: RuntimeEvent): void {
    const update = recordValue(event.assistantMessageEvent);
    if (!update) return;
    const updateType = stringValue(update.type);
    if (updateType === "text_delta" || updateType === "thinking_delta") {
      this.appendEvent("message.delta", {
        messageId: boundedRuntimeString(update.messageId, 128, "assistant-current"),
        block: updateType === "text_delta" ? "text" : "thinking",
        delta: boundedRuntimeString(update.delta, 8_000, ""),
      });
    }
  }

  private handleMessageEnd(event: RuntimeEvent): void {
    const message = recordValue(event.message);
    if (!message) return;
    const role = stringValue(message.role);
    if (role === "assistant") {
      this.lastAssistantOutcome = {
        stopReason: optionalRuntimeString(message.stopReason, 128),
        errorMessage: optionalRuntimeString(message.errorMessage, 2_048),
      };
    }
    this.appendEvent("message.completed", {
      messageId: boundedRuntimeString(message.id, 128, `${role || "message"}-current`),
      role: messageRole(role),
      content: projectContentBlocks(message.content),
      stopReason: optionalRuntimeString(message.stopReason, 128),
      error: optionalRuntimeString(message.errorMessage, 2_048),
    });
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
      runtimeGeneration: this.runtimeGeneration,
      occurredAt,
      type,
      data,
    } as DockEvent;
    this.eventLog.push(event);
    if (this.eventLog.length > this.eventCapacity) this.eventLog.shift();

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
    return { hostEpoch: this.hostEpoch, instanceId: this.id, runtimeGeneration: this.runtimeGeneration, sequence };
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

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compactionReason(value: unknown): "manual" | "threshold" | "overflow" {
  return value === "threshold" || value === "overflow" ? value : "manual";
}

function messageRole(value: unknown): "user" | "assistant" | "tool" | "system" {
  return value === "user" || value === "tool" || value === "system" ? value : "assistant";
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
  return JSON.parse(JSON.stringify(event)) as DockEvent;
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
