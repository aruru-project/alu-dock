import { randomUUID } from "node:crypto";

import type { RuntimeEvent, RuntimeSession } from "./runtime-session.js";

export type InstanceLifecycle = "active" | "stopping" | "stopped";
export type InstanceExecution = "idle" | "running" | "failed";
export type LastRunResult = "never" | "succeeded" | "failed" | "aborted";
export type DeliveryMode = "auto" | "prompt" | "steer" | "followUp";

export interface ExecutorIdentity {
  kind: "pi-sdk" | string;
  version?: string;
  piSessionId: string;
  sessionFile?: string;
  model?: {
    provider: string;
    id: string;
  };
}

export interface InstanceSnapshot {
  id: string;
  name?: string;
  cwd: string;
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  lastRun: LastRunResult;
  pending: {
    steering: number;
    followUp: number;
    total: number;
  };
  executor: ExecutorIdentity;
  activeCommandId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  latestEventSequence: number;
}

export interface DockEvent {
  sequence: number;
  instanceId: string;
  occurredAt: string;
  type: string;
  data: Record<string, unknown>;
}

export interface EventPage {
  events: DockEvent[];
  earliestSequence: number;
  latestSequence: number;
  truncated: boolean;
}

export interface CommandReceipt {
  accepted: true;
  instanceId: string;
  commandId: string;
  delivery: Exclude<DeliveryMode, "auto">;
  queued: boolean;
  acceptedAt: string;
}

export interface StopReceipt {
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

export class ManagedInstance {
  readonly id: string;
  readonly name: string | undefined;
  readonly cwd: string;
  readonly executor: ExecutorIdentity;
  readonly createdAt: string;

  private readonly session: RuntimeSession;
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
  private stopPromise: Promise<StopReceipt> | undefined;

  constructor(options: ManagedInstanceOptions) {
    this.id = options.id ?? randomUUID();
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
    this.executor = {
      kind: options.executor?.kind ?? "pi-sdk",
      version: options.executor?.version,
      model: options.executor?.model ? { ...options.executor.model } : undefined,
      piSessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
    };

    this.unsubscribeRuntime = this.session.subscribe((event) => {
      try {
        this.handleRuntimeEvent(event);
      } catch (error) {
        this.appendEvent("host.event_mapping_failed", {
          error: errorMessage(error),
          runtimeEventType: event.type,
        });
      }
    });

    this.appendEvent("instance.created", {
      cwd: this.cwd,
      name: this.name,
      executor: this.executor,
    });
  }

  snapshot(): InstanceSnapshot {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      lastRun: this.state.lastRun,
      pending: {
        steering: this.state.pendingSteering,
        followUp: this.state.pendingFollowUp,
        total: this.state.pendingSteering + this.state.pendingFollowUp,
      },
      executor: {
        ...this.executor,
        model: this.executor.model ? { ...this.executor.model } : undefined,
      },
      activeCommandId: this.state.activeCommandId,
      lastError: this.state.lastError,
      createdAt: this.createdAt,
      updatedAt: this.state.updatedAt,
      latestEventSequence: this.nextEventSequence - 1,
    };
  }

  eventsSince(sequence = 0): EventPage {
    const earliestSequence = this.eventLog[0]?.sequence ?? this.nextEventSequence;
    const latestSequence = this.nextEventSequence - 1;
    return {
      events: this.eventLog
        .filter((event) => event.sequence > sequence)
        .map((event) => ({ ...event, data: sanitizeEventRecord(event.data) })),
      earliestSequence,
      latestSequence,
      truncated: sequence < earliestSequence - 1,
    };
  }

  subscribe(listener: (event: DockEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async submit(message: string, delivery: DeliveryMode = "auto"): Promise<CommandReceipt> {
    this.assertActive();
    if (this.pendingAdmission) throw new InstanceAdmissionPendingError(this.id);
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
    const commandId = this.createCommandId();
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
      const messageText = errorMessage(error);
      this.state.lastError = messageText;
      this.touch();
      this.appendEvent("command.rejected", { commandId, reason, error: messageText });
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
      this.appendEvent("command.accepted", {
        commandId,
        delivery: actualDelivery,
        queued: actuallyQueued,
        requestedDelivery: resolvedDelivery,
      }, acceptedAt);
      this.appendStateEvent("command_accepted", acceptedAt);
      if (!receiptSettled) {
        receiptSettled = true;
        resolveReceipt({
          accepted: true,
          instanceId: this.id,
          commandId,
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
        this.appendEvent("command.handled_without_run", { commandId });
        this.appendStateEvent("command_handled_without_run");
      }
    }).catch((error: unknown) => {
      release();
      const messageText = errorMessage(error);
      if (preflightStatus !== "accepted") {
        rejectBeforeRun(error, "preflight_failed");
        return;
      }

      this.appendEvent("command.background_failed", { commandId, error: messageText });
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
        this.appendEvent("run.settled_missing", { commandId, error: messageText });
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

  async stop(): Promise<StopReceipt> {
    if (this.state.lifecycle === "stopped") {
      return { instanceId: this.id, stopped: true, alreadyStopped: true };
    }
    if (this.stopPromise) return this.stopPromise;

    this.stopRequestedWhileRunning = this.state.execution === "running" || this.session.isStreaming;
    const admissionBoundary = this.pendingAdmission?.boundary;
    this.state.lifecycle = "stopping";
    this.touch();
    this.appendEvent("control.stop_requested", {
      wasRunning: this.stopRequestedWhileRunning,
      awaitingPreflight: admissionBoundary !== undefined,
    });
    this.appendStateEvent("stop_requested");

    this.stopPromise = this.performStop(admissionBoundary);
    return this.stopPromise;
  }

  recordExtensionError(error: unknown): void {
    this.appendEvent("extension.error", { error: errorMessage(error) });
  }

  private async performStop(admissionBoundary?: Promise<void>): Promise<StopReceipt> {
    const cleanupErrors: string[] = [];
    const captureCleanupError = (stage: string, error: unknown): void => {
      const message = `${stage}: ${errorMessage(error)}`;
      cleanupErrors.push(message);
      this.appendEvent("control.stop_cleanup_failed", { stage, error: errorMessage(error) });
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
      this.state.execution = "idle";
      this.state.activeCommandId = undefined;
      this.state.pendingSteering = 0;
      this.state.pendingFollowUp = 0;
      if (cleanupErrors.length > 0) this.state.lastError = cleanupErrors.join("; ");
      this.touch();
      this.appendEvent("instance.stopped", { cleanupErrors });
      this.appendStateEvent("stopped");
    }

    const receipt: StopReceipt = {
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
          commandId: this.state.activeCommandId,
        });
        this.appendStateEvent("agent_start");
        break;

      case "agent_end":
        this.appendEvent("run.agent_end", {
          willRetry: event.willRetry === true,
        });
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
        });
        break;
      }

      case "message_update":
        this.handleMessageUpdate(event);
        break;

      case "message_end":
        this.handleMessageEnd(event);
        break;

      case "tool_execution_start":
        this.appendEvent("tool.started", {
          toolCallId: stringValue(event.toolCallId),
          toolName: stringValue(event.toolName),
          args: event.args,
        });
        break;

      case "tool_execution_update":
        this.appendEvent("tool.updated", {
          toolCallId: stringValue(event.toolCallId),
          toolName: stringValue(event.toolName),
          output: truncate(extractText(recordValue(event.partialResult)?.content), 4_000),
        });
        break;

      case "tool_execution_end":
        this.appendEvent("tool.completed", {
          toolCallId: stringValue(event.toolCallId),
          toolName: stringValue(event.toolName),
          isError: event.isError === true,
          output: truncate(extractText(recordValue(event.result)?.content), 8_000),
        });
        break;

      case "auto_retry_start":
        this.state.execution = "running";
        this.touch();
        this.appendEvent("run.retry_started", {
          attempt: numberValue(event.attempt),
          maxAttempts: numberValue(event.maxAttempts),
          delayMs: numberValue(event.delayMs),
          error: stringValue(event.errorMessage),
        });
        break;

      case "auto_retry_end":
        this.appendEvent("run.retry_completed", {
          success: event.success === true,
          attempt: numberValue(event.attempt),
          error: stringValue(event.finalError),
        });
        break;

      case "compaction_start":
        this.state.execution = "running";
        this.touch();
        this.appendEvent("run.compaction_started", { reason: stringValue(event.reason) });
        break;

      case "compaction_end":
        this.appendEvent("run.compaction_completed", {
          reason: stringValue(event.reason),
          aborted: event.aborted === true,
          willRetry: event.willRetry === true,
          error: stringValue(event.errorMessage),
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
    if (updateType === "text_delta") {
      this.appendEvent("assistant.text_delta", { delta: truncate(stringValue(update.delta), 8_000) });
    } else if (updateType === "thinking_delta") {
      this.appendEvent("assistant.thinking_delta", { delta: truncate(stringValue(update.delta), 8_000) });
    }
  }

  private handleMessageEnd(event: RuntimeEvent): void {
    const message = recordValue(event.message);
    if (!message) return;
    const role = stringValue(message.role);
    if (role === "assistant") {
      this.lastAssistantOutcome = {
        stopReason: stringValue(message.stopReason),
        errorMessage: stringValue(message.errorMessage),
      };
    }
    this.appendEvent("message.completed", {
      role,
      stopReason: stringValue(message.stopReason),
      error: stringValue(message.errorMessage),
      text: truncate(extractText(message.content), 8_000),
    });
  }

  private appendStateEvent(reason: string, occurredAt?: string): void {
    this.appendEvent("instance.state_changed", {
      reason,
      lifecycle: this.state.lifecycle,
      execution: this.state.execution,
      lastRun: this.state.lastRun,
      pending: this.state.pendingSteering + this.state.pendingFollowUp,
      activeCommandId: this.state.activeCommandId,
      lastError: this.state.lastError,
    }, occurredAt);
  }

  private appendEvent(type: string, data: Record<string, unknown>, occurredAt = this.timestamp()): DockEvent {
    const event: DockEvent = {
      sequence: this.nextEventSequence++,
      instanceId: this.id,
      occurredAt,
      type,
      data: sanitizeEventRecord(data),
    };
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
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

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
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
  return {
    ...event,
    data: sanitizeEventRecord(event.data),
  };
}

function sanitizeEventRecord(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized = sanitizeEventValue(data, 0, seen);
  return recordValue(sanitized) ?? { value: sanitized };
}

function sanitizeEventValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncate(value, 8_000);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, 50).map((item) => sanitizeEventValue(item, depth + 1, seen));
    if (value.length > 50) result.push(`[${value.length - 50} more items]`);
    return result;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, 50);
  for (const [key, item] of entries) {
    if (key.toLowerCase().includes("base64") && typeof item === "string") {
      result[key] = "[base64 omitted]";
    } else {
      result[key] = sanitizeEventValue(item, depth + 1, seen);
    }
  }
  if (Object.keys(value).length > entries.length) {
    result.__truncatedKeys = Object.keys(value).length - entries.length;
  }
  return result;
}
