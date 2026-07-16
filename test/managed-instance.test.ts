import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionUiBroker } from "../src/core/extension-ui-broker.js";
import {
  InstanceAdmissionPendingError,
  InstanceBusyError,
  InstanceNotActiveError,
  InvalidDeliveryModeError,
  ManagedInstance,
  MAX_PENDING_QUEUE_ITEMS,
  QueueCapacityError,
  RuntimeEffectUnknownError,
} from "../src/core/managed-instance.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingUpdate, ToolDto } from "../src/core/config-projection.js";
import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeSessionMetrics,
  RuntimeThinkingLevel,
} from "../src/core/runtime-session.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeRuntimeSession implements RuntimeSession {
  readonly sessionId = "pi-session-1";
  readonly sessionFile = "/tmp/pi-session-1.jsonl";
  isStreaming = false;
  isCompacting = false;
  promptDeferred = new Deferred<void>();
  preflightEntered = new Deferred<void>();
  promptCalls: Array<{ text: string; options?: RuntimePromptOptions }> = [];
  abortCalls = 0;
  disposeCalls = 0;
  clearQueueResult: ClearedRuntimeQueue | undefined;
  rejectPreflightWith: Error | undefined;
  delayPreflight = false;
  queueProjection: (text: string) => string = (text) => text;
  readonly extensionCommands = new Set<string>();
  extensionCommandBlock: Deferred<void> | undefined;
  disposeError: Error | undefined;
  abortError: Error | undefined;
  abortBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  compactionAbortBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  history: RuntimeHistoryEntry[] = [];
  metrics: RuntimeSessionMetrics = {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };

  private pendingPreflight: ((success: boolean) => void) | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private modelState: RuntimeModelState = {
    model: { provider: "fixture", id: "model-a" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "low", "high"],
  };

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  classifyInput(text: string): "extension_command" | "prompt" {
    if (!text.startsWith("/")) return "prompt";
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return this.extensionCommands.has(commandName) ? "extension_command" : "prompt";
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    this.promptCalls.push({ text, options });
    if (this.rejectPreflightWith) {
      options?.preflightResult?.(false);
      return Promise.reject(this.rejectPreflightWith);
    }
    if (this.classifyInput(text) === "extension_command") {
      const execution = this.extensionCommandBlock?.promise ?? Promise.resolve();
      return execution.then(() => { options?.preflightResult?.(true); });
    }
    if (this.delayPreflight) {
      this.pendingPreflight = options?.preflightResult;
      this.preflightEntered.resolve();
      return this.promptDeferred.promise;
    }
    if (this.isStreaming && options?.streamingBehavior) {
      if (options.streamingBehavior === "steer") this.steeringQueue.push(this.queueProjection(text));
      else this.followUpQueue.push(this.queueProjection(text));
      this.emitQueue();
      options.preflightResult?.(true);
      return Promise.resolve();
    }
    options?.preflightResult?.(true);
    return this.promptDeferred.promise;
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return [
      { provider: "fixture", id: "model-a", name: "Model A", reasoning: true },
      { provider: "fixture", id: "model-b", name: "Model B", reasoning: false },
    ];
  }

  async listSessions(_scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]> {
    return [];
  }

  getHistory(): RuntimeHistoryEntry[] { return structuredClone(this.history); }

  async listTools(): Promise<ToolDto[]> { return []; }
  async setActiveTools(_names: string[]): Promise<ToolDto[]> { return []; }
  async getSettings(): Promise<SettingDto[]> { return []; }
  async updateSetting(_update: SettingUpdate): Promise<SettingDto> { throw new Error("not configured"); }
  async getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[] }> { return { resources: [], diagnostics: [] }; }
  async getCommands(): Promise<CommandDto[]> { return []; }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    this.modelState = {
      model: { provider, id: modelId },
      thinkingLevel: modelId === "model-b" ? "off" : this.modelState.thinkingLevel,
      availableThinkingLevels: modelId === "model-b" ? ["off"] : ["off", "low", "high"],
    };
    return this.getModelState();
  }

  async setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> {
    const effective = this.modelState.availableThinkingLevels.includes(level) ? level : "off";
    this.modelState = { ...this.modelState, thinkingLevel: effective };
    return this.getModelState();
  }

  getModelState(): RuntimeModelState {
    return {
      ...this.modelState,
      model: this.modelState.model ? { ...this.modelState.model } : undefined,
      availableThinkingLevels: [...this.modelState.availableThinkingLevels],
    };
  }

  getMetrics(): RuntimeSessionMetrics { return structuredClone(this.metrics); }

  clearQueue(): ClearedRuntimeQueue {
    const cleared = this.clearQueueResult ?? {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    };
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.emitQueue();
    return cleared;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortBlock) {
      this.abortBlock.entered.resolve();
      await this.abortBlock.release.promise;
    }
    if (this.abortError) throw this.abortError;
    if (this.isCompacting) {
      if (this.compactionAbortBlock) {
        this.compactionAbortBlock.entered.resolve();
        await this.compactionAbortBlock.release.promise;
      }
      this.isCompacting = false;
      this.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
      return;
    }
    if (this.isStreaming) {
      this.emitAssistantEnd("aborted");
      this.isStreaming = false;
      this.emit({ type: "agent_end", messages: [] });
      this.emit({ type: "agent_settled" });
      this.promptDeferred.resolve();
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.isStreaming) await this.promptDeferred.promise;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeError) throw this.disposeError;
  }

  blockAbort(): { entered: Promise<void>; release: () => void } {
    const entered = new Deferred<void>();
    const release = new Deferred<void>();
    this.abortBlock = { entered, release };
    return { entered: entered.promise, release: () => release.resolve() };
  }

  blockCompactionAbort(): { entered: Promise<void>; release: () => void } {
    const entered = new Deferred<void>();
    const release = new Deferred<void>();
    this.compactionAbortBlock = { entered, release };
    return { entered: entered.promise, release: () => release.resolve() };
  }

  triggerPreflight(success: boolean): void {
    const callback = this.pendingPreflight;
    this.pendingPreflight = undefined;
    callback?.(success);
    if (success) this.startRun();
    else this.promptDeferred.reject(new Error("preflight rejected"));
  }

  startRun(): void {
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    const text = this.promptCalls.at(-1)?.text;
    if (text !== undefined) this.emitUserMessage(text);
  }

  beginConsumeNextQueued(): string | undefined {
    const text = this.steeringQueue.shift() ?? this.followUpQueue.shift();
    if (text !== undefined) this.emitQueue();
    return text;
  }

  finishConsumeQueued(text: string): void { this.emitUserMessage(text); }

  consumeNextQueued(): string | undefined {
    const text = this.beginConsumeNextQueued();
    if (text !== undefined) this.finishConsumeQueued(text);
    return text;
  }

  emitAssistantEnd(stopReason: string, errorMessage?: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason,
        errorMessage,
      },
    });
  }

  settle(stopReason = "stop", errorMessage?: string): void {
    this.emitAssistantEnd(stopReason, errorMessage);
    this.isStreaming = false;
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled" });
    this.promptDeferred.resolve();
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitQueue(): void {
    this.emit({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] });
  }

  private emitUserMessage(text: string): void {
    const message = { role: "user", content: [{ type: "text", text }] };
    this.emit({ type: "message_start", message });
    this.emit({ type: "message_end", message });
  }
}

function dataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function createClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++));
}

function createInstance(session = new FakeRuntimeSession(), eventCapacity = 50): ManagedInstance {
  let commandSequence = 0;
  return new ManagedInstance({
    id: "dock-instance-1",
    cwd: "/tmp/project",
    session,
    eventCapacity,
    now: createClock(),
    commandId: () => `command-${++commandSequence}`,
  });
}

async function flushBackground(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("suspended replacement UI cannot leak candidate status into the committed generation", async () => {
  const broker = new ExtensionUiBroker();
  const instance = new ManagedInstance({
    id: "dock-instance-ui-generation",
    cwd: "/tmp/project",
    session: new FakeRuntimeSession(),
    extensionUiBroker: broker,
  });
  instance.markCatalogCommitted();
  broker.setStatus("fixture", "old generation");
  assert.deepEqual(instance.snapshot().extensionStatus, { fixture: "old generation" });

  broker.beginGenerationChange();
  broker.setStatus("fixture", "candidate generation");
  assert.deepEqual(instance.snapshot().extensionStatus, { fixture: "old generation" });
  await broker.failGenerationChange();
});

test("submit returns after preflight while the runtime promise remains host-owned", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  const receipt = await instance.submit("do a long task");

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.operationId, "command-1");
  assert.equal(receipt.queued, false);
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().id, "dock-instance-1");
  assert.equal(instance.snapshot().executor.piSessionId, "pi-session-1");
  assert.notEqual(instance.snapshot().id, instance.snapshot().executor.piSessionId);
  assert.equal(session.promptCalls.length, 1);
  assert.equal(instance.eventsSince().events.some((event) => event.type === "message.submitted"), false);

  session.startRun();
  const submitted = instance.eventsSince().events.find((event) => event.type === "message.submitted");
  assert.equal(submitted?.type, "message.submitted");
  if (submitted?.type !== "message.submitted") assert.fail("user message was not consumed");
  assert.equal(submitted.data.role, "user");
  assert.equal(submitted.data.text, "do a long task");
  assert.equal(submitted.data.operationId, "command-1");
  session.emitAssistantEnd("stop");
  session.emit({ type: "agent_end", messages: [] });

  // agent_end is not a stable boundary: retry/compaction/queued work may follow.
  assert.equal(instance.snapshot().execution, "running");

  session.isStreaming = false;
  session.emit({ type: "agent_settled" });
  session.promptDeferred.resolve();
  await instance.waitForIdle();

  const snapshot = instance.snapshot();
  assert.equal(snapshot.lifecycle, "active");
  assert.equal(snapshot.execution, "idle");
  assert.equal(snapshot.lastRun, "succeeded");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "run.settled"));
});

test("runtime metrics are present initially and refresh through a closed event", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  assert.equal(instance.snapshot().metrics?.tokens.total, 0);

  session.metrics = {
    messages: { user: 2, assistant: 1, toolCalls: 3, toolResults: 3, total: 9 },
    tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
    cost: 0.0123,
    context: { tokens: 900, contextWindow: 2_000, percent: 45 },
  };
  session.emit({ type: "entry_appended", entry: { id: "metrics-entry" } });

  assert.deepEqual(instance.snapshot().metrics, session.metrics);
  const event = instance.eventsSince().events.find((candidate) => candidate.type === "session.metrics_changed");
  assert.equal(event?.data.metrics.context?.percent, 45);
});

test("abort ends the run without disposing the reusable instance", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("keep running");
  session.startRun();

  await instance.abort("abort-operation");

  assert.equal(session.abortCalls, 1);
  assert.equal(session.disposeCalls, 0);
  assert.equal(instance.snapshot().lifecycle, "active");
  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().lastRun, "aborted");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "run.settled" && event.data.result === "aborted"));
});

test("abort cancels compaction without fabricating an aborted model run", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  session.isCompacting = true;
  session.emit({ type: "compaction_start", reason: "manual" });
  assert.equal(instance.snapshot().execution, "running");
  const block = session.blockCompactionAbort();
  const aborting = instance.abort("abort-compaction");
  await block.entered;
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().lastRun, "never");
  assert.equal(instance.eventsSince().events.some((event) => event.type === "run.settled"), false);

  block.release();
  await aborting;

  assert.equal(session.abortCalls, 1);
  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().lastRun, "never");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "compaction.completed" && event.data.aborted));
  assert.equal(instance.eventsSince().events.some((event) => event.type === "run.settled"), false);
});

test("abort serializes competing mutations and projection reads until its committed boundary", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("keep running");
  session.startRun();
  const block = session.blockAbort();
  const aborting = instance.abort("abort-serialized");
  await block.entered;

  await assert.rejects(instance.abort("abort-competing"), InstanceBusyError);
  await assert.rejects(instance.selectModel("fixture", "model-b", "model-during-abort"), InstanceBusyError);
  let readFinished = false;
  const read = instance.listModels().then((models) => { readFinished = true; return models; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(readFinished, false);

  block.release();
  await aborting;
  assert.equal((await read).models.length, 2);
  assert.equal(instance.snapshot().lastRun, "aborted");
});

test("an abort runtime error reports operation-scoped ambiguity without leaking its cause", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("keep running");
  session.startRun();
  session.abortError = new Error("AUTH_TOKEN_very_secret");

  await assert.rejects(
    instance.abort("abort-ambiguous"),
    (error: unknown) => error instanceof RuntimeEffectUnknownError
      && error.operationId === "abort-ambiguous"
      && !error.message.includes("AUTH_TOKEN"),
  );
});

test("failed and aborted runs project to distinct structured state", async () => {
  const failedSession = new FakeRuntimeSession();
  const failed = createInstance(failedSession);
  await failed.submit("fail");
  failedSession.startRun();
  failedSession.settle("error", "provider exploded");
  await failed.waitForIdle();

  assert.equal(failed.snapshot().execution, "failed");
  assert.equal(failed.snapshot().lastRun, "failed");
  assert.equal(failed.snapshot().lastError, "provider exploded");

  const abortedSession = new FakeRuntimeSession();
  const aborted = createInstance(abortedSession);
  await aborted.submit("keep running");
  abortedSession.startRun();
  const firstStop = await aborted.stop();
  const secondStop = await aborted.stop();

  assert.deepEqual(firstStop, {
    operationId: "command-2",
    instanceId: "dock-instance-1",
    stopped: true,
    alreadyStopped: false,
  });
  assert.equal(secondStop.operationId, "command-3");
  assert.equal(secondStop.alreadyStopped, true);
  assert.equal(aborted.snapshot().lifecycle, "stopped");
  assert.equal(aborted.snapshot().lastRun, "aborted");
  assert.equal(abortedSession.abortCalls, 1);
  assert.equal(abortedSession.disposeCalls, 1);
});

test("preflight rejection is reported as a rejected command, not a settled run", async () => {
  const session = new FakeRuntimeSession();
  session.rejectPreflightWith = new Error("no configured model");
  const instance = createInstance(session);

  await assert.rejects(instance.submit("hello"), /no configured model/);

  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().lastRun, "never");
  assert.equal(instance.snapshot().lastError, "no configured model");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "command.rejected"));
});

test("delivery modes make queue acceptance explicit", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  await assert.rejects(instance.submit("too early", "steer"), InvalidDeliveryModeError);

  await instance.submit("first");
  session.startRun();
  const queued = await instance.submit("change direction", "auto");

  assert.equal(queued.delivery, "steer");
  assert.equal(queued.queued, true);
  assert.equal(session.promptCalls.at(-1)?.options?.streamingBehavior, "steer");

  const followUp = await instance.submit("afterward", "followUp");
  assert.equal(followUp.delivery, "followUp");
  assert.equal(followUp.queued, true);
  assert.equal(session.promptCalls.at(-1)?.options?.streamingBehavior, "followUp");
  await assert.rejects(instance.selectModel("fixture", "model-b", "model-while-queued"), InstanceBusyError);

  await assert.rejects(
    instance.submit("parallel prompt", "prompt"),
    InvalidDeliveryModeError,
  );

  session.settle();
});

test("registered extension commands bypass running Queue admission without corrupting the parent operation", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("rm-confirm");
  const instance = createInstance(session);
  await instance.submit("parent run", "prompt", "parent-op");
  session.startRun();
  assert.equal(instance.snapshot().activeCommandId, "parent-op");

  const commandBlock = new Deferred<void>();
  session.extensionCommandBlock = commandBlock;
  const receipt = await instance.submit("/rm-confirm off", "followUp", "extension-op");
  assert.deepEqual({ delivery: receipt.delivery, queued: receipt.queued }, { delivery: "prompt", queued: false });
  assert.equal(session.promptCalls.at(-1)?.options?.streamingBehavior, undefined);
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().activeCommandId, "parent-op");
  assert.deepEqual(instance.snapshot().pending, { steering: 0, followUp: 0, total: 0 });
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);

  commandBlock.resolve();
  await flushBackground();
  const handled = instance.eventsSince().events.find((event) => event.type === "command.handled" && event.data.operationId === "extension-op");
  assert.equal(handled?.type, "command.handled");
  if (handled?.type !== "command.handled") assert.fail("extension command was not projected as handled");
  assert.equal(handled.data.kind, "extension_command");
  assert.equal(instance.eventsSince().events.some((event) => event.type === "message.queued" && event.data.operationId === "extension-op"), false);
  assert.equal(instance.eventsSince().events.some((event) => event.type === "message.submitted" && event.data.operationId === "extension-op"), false);
  assert.deepEqual(await instance.dequeue("restore-after-extension"), {
    operationId: "restore-after-extension", instanceId: "dock-instance-1", restored: [], inFlight: [],
  });

  const unknown = await instance.submit("/unknown value", "auto", "unknown-op");
  const skill = await instance.submit("/skill:fixture value", "auto", "skill-op");
  const template = await instance.submit("/template-fixture value", "auto", "template-op");
  assert.deepEqual([unknown.queued, skill.queued, template.queued], [true, true, true]);
  assert.deepEqual((await instance.dequeue("restore-native-slash")).restored.map((item) => item.operationId), [
    "unknown-op", "skill-op", "template-op",
  ]);

  session.settle();
  await instance.waitForIdle();
});

test("extension command catalog admission commits conservative intent before its immediate effect", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("catalog-command");
  const instance = createInstance(session);
  const commits: Array<{ kind: string; effect: string; admissionPending: boolean; admissionOperationId?: string }> = [];
  instance.bindCatalogPort({
    assertWritable: () => {},
    commit: async (record, context) => {
      commits.push({
        kind: context.kind,
        effect: context.effect,
        admissionPending: record.admissionPending,
        ...(record.admissionOperationId === undefined ? {} : { admissionOperationId: record.admissionOperationId }),
      });
    },
  });
  instance.markCatalogCommitted();

  const receipt = await instance.submit("/catalog-command", "auto", "catalog-extension-op");
  assert.equal(receipt.queued, false);
  await flushBackground();
  assert.deepEqual(commits.filter((commit) => commit.kind.startsWith("command.")), [
    { kind: "command.admission", effect: "pre_effect", admissionPending: true, admissionOperationId: "catalog-extension-op" },
    { kind: "command.accepted", effect: "pre_effect", admissionPending: false },
    { kind: "command.handled", effect: "post_effect", admissionPending: false },
  ]);
  assert.equal(instance.snapshot().execution, "idle");
  await instance.stop("stop-catalog-extension");
});

test("parent settlement buffered by extension admission retains the parent catalog operation", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("admission-command");
  const instance = createInstance(session);
  const admissionEntered = new Deferred<void>();
  const releaseAdmissionCommit = new Deferred<void>();
  instance.bindCatalogPort({
    assertWritable: () => {},
    commit: async (_record, context) => {
      if (context.kind === "command.admission" && context.operationId === "extension-admission-op") {
        admissionEntered.resolve();
        await releaseAdmissionCommit.promise;
      }
    },
  });
  instance.markCatalogCommitted();
  await instance.submit("parent run", "prompt", "parent-op");
  session.startRun();
  await flushBackground();
  assert.equal(instance.snapshot().activeCommandId, "parent-op");

  const submitting = instance.submit("/admission-command", "auto", "extension-admission-op");
  await admissionEntered.promise;
  session.settle();
  releaseAdmissionCommit.resolve();
  const receipt = await submitting;
  assert.equal(receipt.queued, false);
  await flushBackground();

  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().lastRun, "succeeded");
  assert.equal(instance.eventsSince().events.find((event) => event.type === "run.settled")?.data.operationId, "parent-op");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "extension-admission-op"));
  await instance.waitForIdle();
});

test("an async extension command cannot revive or clear a parent that settles during its handler", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("slow-command");
  const instance = createInstance(session);
  await instance.submit("parent run", "prompt", "parent-op");
  session.startRun();

  const commandBlock = new Deferred<void>();
  session.extensionCommandBlock = commandBlock;
  await instance.submit("/slow-command", "auto", "slow-extension-op");
  session.settle();
  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().activeCommandId, undefined);
  assert.equal(instance.snapshot().lastRun, "succeeded");

  commandBlock.resolve();
  await flushBackground();
  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().activeCommandId, undefined);
  const settled = instance.eventsSince().events.find((event) => event.type === "run.settled");
  assert.equal(settled?.data.operationId, "parent-op");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "slow-extension-op"));
  await instance.waitForIdle();
});

test("an idle extension command that starts a run transfers only the new run to its operation", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("start-turn");
  const instance = createInstance(session);
  const commandBlock = new Deferred<void>();
  session.extensionCommandBlock = commandBlock;

  const receipt = await instance.submit("/start-turn", "auto", "extension-turn-op");
  assert.equal(receipt.queued, false);
  assert.equal(instance.snapshot().execution, "idle");
  session.isStreaming = true;
  session.emit({ type: "agent_start" });
  assert.equal(instance.snapshot().activeCommandId, "extension-turn-op");
  assert.equal(instance.eventsSince().events.find((event) => event.type === "run.started")?.data.operationId, "extension-turn-op");

  commandBlock.resolve();
  await flushBackground();
  assert.equal(instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "extension-turn-op"), false);
  session.settle();
  await instance.waitForIdle();
});

test("extension command failures preserve parent state and old-generation completions are fenced", async () => {
  const session = new FakeRuntimeSession();
  session.extensionCommands.add("fail-command");
  const instance = createInstance(session);
  await instance.submit("parent run", "prompt", "parent-op");
  session.startRun();

  const failedBlock = new Deferred<void>();
  session.extensionCommandBlock = failedBlock;
  await instance.submit("/fail-command", "auto", "failed-extension-op");
  failedBlock.reject(new Error("extension handler failed"));
  await flushBackground();
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().activeCommandId, "parent-op");
  assert.ok(instance.eventsSince().events.some((event) => event.type === "instance.error" && event.data.operationId === "failed-extension-op"));
  assert.equal(instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "failed-extension-op"), false);
  session.settle();
  await instance.waitForIdle();

  const oldGenerationBlock = new Deferred<void>();
  session.extensionCommandBlock = oldGenerationBlock;
  await instance.submit("/fail-command", "auto", "old-generation-op");
  session.emit({
    type: "dock_session_replaced", operationId: "runtime-reload", reason: "reload",
    previousSessionFile: "/tmp/pi-session-1.jsonl", sessionFile: "/tmp/pi-session-2.jsonl", cwd: "/tmp/project",
  });
  oldGenerationBlock.resolve();
  await flushBackground();
  assert.equal(instance.runtimeGeneration, 2);
  assert.equal(instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "old-generation-op"), false);
  assert.equal(instance.eventsSince().events[0]?.type, "session.replaced");
  await instance.waitForIdle();
});

test("queued text stays pending until user message_start and template expansion keeps its operation identity", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  session.queueProjection = (text) => `expanded:${text}`;

  const queued = await instance.submit("change direction", "steer", "queue-op");
  assert.equal(queued.queued, true);
  assert.equal(instance.eventsSince().events.some((event) => event.type === "message.submitted" && event.data.operationId === "queue-op"), false);
  const acceptedEvents = instance.eventsSince().events;
  const acceptedIndex = acceptedEvents.findIndex((event) => event.type === "command.accepted" && event.data.operationId === "queue-op");
  const queuedIndex = acceptedEvents.findIndex((event) => event.type === "message.queued" && event.data.operationId === "queue-op");
  const queueChangedIndex = acceptedEvents.findIndex((event) => event.type === "queue.changed" && event.data.total === 1);
  assert.ok(acceptedIndex >= 0 && acceptedIndex < queuedIndex && queuedIndex < queueChangedIndex);
  const attach = await instance.getAttachProjection(undefined);
  assert.deepEqual(attach.pendingMessages.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "queue-op", delivery: "steer", text: "change direction" },
  ]);

  assert.equal(session.consumeNextQueued(), "expanded:change direction");
  const consumed = instance.eventsSince().events.find((event) => event.type === "message.submitted" && event.data.operationId === "queue-op");
  assert.equal(consumed?.type, "message.submitted");
  if (consumed?.type !== "message.submitted") assert.fail("queued message was not consumed");
  assert.equal(consumed.data.text, "expanded:change direction");
  assert.equal(consumed.data.delivery, "steer");
  assert.ok(consumed.data.queueItemId);
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
  session.settle();
});

test("duplicate expanded queue messages consume against their accepted FIFO identities", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  session.queueProjection = () => "same expanded text";
  await instance.submit("template one", "steer", "duplicate-one");
  await instance.submit("template two", "steer", "duplicate-two");

  session.consumeNextQueued();
  session.consumeNextQueued();
  const consumed = instance.eventsSince().events
    .filter((event) => event.type === "message.submitted" && event.data.queueItemId !== undefined)
    .map((event) => event.type === "message.submitted" ? event.data.operationId : "");
  assert.deepEqual(consumed, ["duplicate-one", "duplicate-two"]);
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
  session.settle();
});

test("runtime-driven replacement explicitly clears any surviving ephemeral queue projection", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  await instance.submit("queued before replacement", "steer", "replace-queue-op");

  session.emit({
    type: "dock_session_replaced",
    operationId: "runtime-replace",
    reason: "new",
    previousSessionFile: "/tmp/pi-session-1.jsonl",
    sessionFile: "/tmp/pi-session-2.jsonl",
    cwd: "/tmp/project",
  });
  const replacementEvents = instance.eventsSince().events;
  assert.equal(replacementEvents[0]?.type, "session.replaced");
  const cleared = replacementEvents[1];
  assert.equal(cleared?.type, "queue.cleared");
  if (cleared?.type !== "queue.cleared") assert.fail("replacement did not publish queue removal");
  assert.equal(cleared.data.reason, "replacement");
  assert.equal(cleared.data.total, 1);
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
  await instance.stop("stop-after-runtime-replacement");
});

test("dequeue never restores a message Pi already removed for an in-flight message_start", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  await instance.submit("about to consume", "steer", "in-flight-op");

  const inFlightText = session.beginConsumeNextQueued();
  assert.equal(inFlightText, "about to consume");
  const receipt = await instance.dequeue("dequeue-in-flight");
  assert.deepEqual(receipt.restored, []);
  assert.deepEqual(receipt.inFlight.map((item) => item.operationId), ["in-flight-op"]);
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages.map((item) => item.operationId), ["in-flight-op"]);

  session.finishConsumeQueued(inFlightText!);
  const consumed = instance.eventsSince().events.find((event) => event.type === "message.submitted" && event.data.operationId === "in-flight-op");
  assert.equal(consumed?.type, "message.submitted");
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
  session.settle();
});

test("dequeue separates a Pi-drained item from the remaining restorable batch without loss", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  await instance.submit("steer one", "steer", "mixed-steer-one");
  await instance.submit("follow later", "followUp", "mixed-follow");
  await instance.submit("steer two", "steer", "mixed-steer-two");

  const consuming = session.beginConsumeNextQueued();
  assert.equal(consuming, "steer one");
  const receipt = await instance.dequeue("dequeue-mixed");
  assert.deepEqual(receipt.inFlight.map((item) => item.operationId), ["mixed-steer-one"]);
  assert.deepEqual(receipt.restored.map((item) => item.operationId), ["mixed-steer-two", "mixed-follow"]);
  assert.deepEqual(
    [...receipt.restored, ...receipt.inFlight].map((item) => item.operationId).sort(),
    ["mixed-follow", "mixed-steer-one", "mixed-steer-two"].sort(),
  );
  session.finishConsumeQueued(consuming!);
  session.settle();
});

test("dequeue restores every pending message in steering-first order without aborting the run", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  await instance.submit("later follow-up", "followUp", "follow-op");
  await instance.submit("urgent steer", "steer", "steer-op");

  const receipt = await instance.dequeue("dequeue-op");
  assert.equal(session.abortCalls, 0);
  assert.deepEqual(receipt.inFlight, []);
  assert.deepEqual(receipt.restored.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "steer-op", delivery: "steer", text: "urgent steer" },
    { operationId: "follow-op", delivery: "followUp", text: "later follow-up" },
  ]);
  assert.equal(instance.snapshot().execution, "running");
  assert.deepEqual(instance.snapshot().pending, { steering: 0, followUp: 0, total: 0 });
  assert.deepEqual((await instance.getAttachProjection(undefined)).pendingMessages, []);
  const cleared = instance.eventsSince().events.find((event) => event.type === "queue.cleared" && event.data.reason === "dequeued");
  assert.equal(cleared?.type, "queue.cleared");
  if (cleared?.type !== "queue.cleared") assert.fail("queue clear event was not published");
  assert.equal(cleared.data.total, 2);
  session.settle();
});

test("pending queue admission is bounded before another Pi effect", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  await instance.submit("original");
  session.startRun();
  for (let index = 0; index < MAX_PENDING_QUEUE_ITEMS; index += 1) {
    await instance.submit(`queued-${index}`, "steer", `queue-${index}`);
  }
  assert.equal(instance.snapshot().pending.total, MAX_PENDING_QUEUE_ITEMS);
  const promptCallsAtCapacity = session.promptCalls.length;
  await assert.rejects(instance.submit("one too many", "steer", "queue-overflow"), QueueCapacityError);
  assert.equal(session.promptCalls.length, promptCallsAtCapacity);
  await instance.dequeue("clear-capacity-test");
  session.settle();
});

test("a queued request becomes a tracked prompt when the original run settles during preflight", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  instance.bindCatalogPort({ assertWritable: () => {}, commit: async () => {} });
  instance.markCatalogCommitted();

  const originalDeferred = session.promptDeferred;
  await instance.submit("original");
  session.startRun();

  session.delayPreflight = true;
  session.promptDeferred = new Deferred<void>();
  const nextSubmit = instance.submit("next", "auto");
  await session.preflightEntered.promise;

  // Finish the original run while the second command is inside an async input
  // hook. Pi will re-check isStreaming and execute the second command as a new
  // prompt rather than queueing it as steer.
  session.emitAssistantEnd("stop");
  session.isStreaming = false;
  session.emit({ type: "agent_end", messages: [] });
  session.emit({ type: "agent_settled" });
  originalDeferred.resolve();

  session.triggerPreflight(true);
  const receipt = await nextSubmit;
  assert.equal(receipt.delivery, "prompt");
  assert.equal(receipt.queued, false);
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().activeCommandId, "command-2");

  const accepted = instance.eventsSince().events
    .filter((event) => event.type === "command.accepted")
    .at(-1);
  assert.equal(accepted?.data.delivery, "prompt");
  assert.equal(accepted?.data.delivery, "prompt");

  session.settle();
  await instance.waitForIdle();
});

test("an unresolved preflight reserves admission and rejects a concurrent normal prompt", async () => {
  const session = new FakeRuntimeSession();
  session.delayPreflight = true;
  const instance = createInstance(session);

  const firstSubmit = instance.submit("first");
  await assert.rejects(
    instance.submit("second"),
    InstanceAdmissionPendingError,
  );
  assert.equal(session.promptCalls.length, 1);

  session.triggerPreflight(true);
  const receipt = await firstSubmit;
  assert.equal(receipt.operationId, "command-1");
  assert.equal(instance.snapshot().activeCommandId, "command-1");

  session.settle();
  await instance.waitForIdle();
});

test("stop waits for a pending preflight and a late acceptance cannot revive the instance", async () => {
  const session = new FakeRuntimeSession();
  session.delayPreflight = true;
  const instance = createInstance(session);

  const pendingSubmit = instance.submit("slow preflight");
  const submitRejection = assert.rejects(pendingSubmit, InstanceNotActiveError);
  const stopPromise = instance.stop();
  assert.equal(instance.snapshot().lifecycle, "stopping");
  await assert.rejects(instance.submit("too late"), InstanceNotActiveError);

  let stopFinished = false;
  void stopPromise.then(() => { stopFinished = true; });
  await Promise.resolve();
  assert.equal(stopFinished, false);

  session.triggerPreflight(true);
  await submitRejection;
  const stopReceipt = await stopPromise;

  assert.equal(stopReceipt.stopped, true);
  assert.equal(instance.snapshot().lifecycle, "stopped");
  assert.equal(instance.snapshot().execution, "unavailable");
  assert.equal(instance.snapshot().activeCommandId, undefined);
  assert.equal(instance.snapshot().lastRun, "aborted");
  assert.equal(
    instance.eventsSince().events.some((event) => event.type === "command.accepted"),
    false,
  );
});

test("a Promise rejection after agent_settled cannot overwrite the settled outcome", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  await instance.submit("run");
  session.startRun();
  session.emitAssistantEnd("stop");
  session.isStreaming = false;
  session.emit({ type: "agent_end", messages: [] });
  session.emit({ type: "agent_settled" });
  session.promptDeferred.reject(new Error("late Promise rejection"));
  await instance.waitForIdle();

  assert.equal(instance.snapshot().execution, "idle");
  assert.equal(instance.snapshot().lastRun, "succeeded");
  assert.equal(instance.snapshot().lastError, undefined);
  assert.ok(instance.eventsSince().events.some((event) => event.type === "instance.error"));
  assert.equal(
    instance.eventsSince().events.some((event) => event.type === "run.settled" && event.data.operationId === "command-1" && event.data.error === "late Promise rejection"),
    false,
  );
});

test("agent_settled without an assistant outcome fails closed", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  await instance.submit("run");
  session.startRun();
  session.isStreaming = false;
  session.emit({ type: "agent_end", messages: [] });
  session.emit({ type: "agent_settled" });
  session.promptDeferred.resolve();
  await instance.waitForIdle();

  assert.equal(instance.snapshot().execution, "failed");
  assert.equal(instance.snapshot().lastRun, "failed");
  assert.match(instance.snapshot().lastError ?? "", /without an assistant outcome/);
});

test("concurrent stop is idempotent and cleanup errors still reach stopped", async () => {
  const session = new FakeRuntimeSession();
  session.clearQueueResult = { steering: ["s1"], followUp: ["f1", "f2"] };
  session.abortError = new Error("abort exploded");
  session.disposeError = new Error("dispose exploded");
  const instance = createInstance(session);

  const [first, second] = await Promise.all([instance.stop("stop-a"), instance.stop("stop-b")]);

  assert.equal(first.stopped, true);
  assert.equal(first.operationId, "stop-a");
  assert.equal(first.alreadyStopped, false);
  assert.equal(second.operationId, "stop-b");
  assert.equal(second.alreadyStopped, true);
  assert.deepEqual(first.cleanupErrors, [
    "abort: abort exploded",
    "dispose: dispose exploded",
  ]);
  assert.equal(instance.snapshot().lifecycle, "stopped");
  assert.equal(session.abortCalls, 1);
  assert.equal(session.disposeCalls, 1);
  const cleared = instance.eventsSince().events.find((event) => event.type === "queue.cleared");
  assert.equal(cleared?.data.steering, 1);
  assert.equal(cleared?.data.followUp, 2);
});

test("observer exceptions and mutations cannot escape into the runtime listener chain", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  const seen: string[] = [];

  instance.subscribe((event) => {
    const mutable = event as unknown as { type: string; data: Record<string, unknown> };
    mutable.type = "corrupted";
    mutable.data.steering = 999;
    throw new Error("broken client socket");
  });
  instance.subscribe((event) => seen.push(`${event.type}:${String(dataRecord(event.data).steering)}`));

  assert.doesNotThrow(() => session.emit({
    type: "queue_update",
    steering: ["one"],
    followUp: [],
  }));
  assert.deepEqual(seen, ["queue.changed:1"]);
  assert.equal(instance.snapshot().pending.steering, 1);
  assert.equal(instance.eventsSince().events.at(-1)?.type, "queue.changed");
  assert.equal(dataRecord(instance.eventsSince().events.at(-1)?.data).steering, 1);
});

test("runtime event data is sanitized into JSON-serializable values", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  const rawBase64 = Buffer.from("secret".repeat(100)).toString("base64");

  session.emit({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "test",
    args: {
      count: 1n,
      callback: () => undefined,
      marker: Symbol("marker"),
      bytes: Buffer.from("secret"),
      imageData: "data:image/png;base64,c2VjcmV0",
      payload: rawBase64,
      ordinary: "abcdefghijklmnopabcdefghijklmnop",
    },
  });

  const page = instance.eventsSince();
  assert.doesNotThrow(() => JSON.stringify(page));
  const event = page.events.find((item) => item.type === "tool.started");
  const eventData = dataRecord(event?.data);
  const args = eventData.args as Record<string, unknown>;
  assert.deepEqual(args, { ordinary: "abcdefghijklmnopabcdefghijklmnop" });
  assert.deepEqual(eventData.omittedFields, ["/count", "/callback", "/marker", "/bytes", "/imageData", "/payload"]);
  assert.doesNotMatch(JSON.stringify(page), /data:image|secret/);
  assert.ok(!JSON.stringify(page).includes(rawBase64));
});

test("assistant and tool-call streaming use stable distinct IDs with argument updates", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  session.startRun();
  session.emit({ type: "message_update", assistantMessageEvent: { type: "start", partial: { role: "assistant", content: [] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: { role: "assistant", content: [] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer", partial: { role: "assistant", content: [] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: { role: "assistant", content: [{}, {}, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "b", partial: { role: "assistant", content: [{}, {}, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "ab" } }] } } });
  session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "abc" } });
  session.emitAssistantEnd("toolUse");

  session.emit({ type: "message_update", assistantMessageEvent: { type: "start", partial: { role: "assistant", content: [] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second", partial: { role: "assistant", content: [] } } });
  session.emitAssistantEnd("stop");

  const events = instance.eventsSince().events;
  const deltas = events.filter((candidate) => candidate.type === "message.delta");
  const completed = events.filter((candidate) => candidate.type === "message.completed" && candidate.data.role === "assistant");
  assert.equal(dataRecord(deltas[0]?.data).messageId, dataRecord(deltas[1]?.data).messageId);
  assert.equal(dataRecord(completed[0]?.data).messageId, dataRecord(deltas[0]?.data).messageId);
  assert.notEqual(dataRecord(completed[1]?.data).messageId, dataRecord(completed[0]?.data).messageId);
  assert.equal(events.filter((candidate) => candidate.type === "tool.started" && candidate.data.toolCallId === "call-1").length, 1);
  const updates = events.filter((candidate) => candidate.type === "tool.args_updated" && candidate.data.toolCallId === "call-1");
  assert.deepEqual(updates.map((candidate) => dataRecord(candidate.data).args), [{ path: "ab" }, { path: "abc" }]);
});

test("completed message content omits data URIs and raw base64", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);
  const rawBase64 = Buffer.from("binary-message".repeat(100)).toString("base64");

  session.emit({
    type: "message_end",
    message: {
      id: "assistant-binary",
      role: "assistant",
      content: [
        { type: "text", text: rawBase64 },
        { type: "thinking", thinking: `data:image/png;base64,${rawBase64}` },
        { type: "text", text: "ordinary answer" },
      ],
      stopReason: "stop",
    },
  });

  const completed = instance.eventsSince().events.find((event) => event.type === "message.completed");
  assert.ok(completed?.type === "message.completed");
  assert.deepEqual(completed.data.content, [
    { type: "omitted", kind: "binary", description: "Binary data omitted" },
    { type: "omitted", kind: "binary", description: "Binary data omitted" },
    { type: "text", text: "ordinary answer" },
  ]);
  assert.ok(!JSON.stringify(completed).includes(rawBase64));
});

test("attach history coverage removes replay frames for the same stable assistant message", async () => {
  const session = new FakeRuntimeSession();
  session.history = [{ entryId: "history-assistant", role: "assistant", content: [{ type: "text", text: "final" }] }];
  const instance = createInstance(session);
  session.emit({ type: "message_update", assistantMessageEvent: { type: "start", partial: { role: "assistant", content: [] } } });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "final", partial: { role: "assistant", content: [] } } });
  session.emitAssistantEnd("stop");

  const projection = await instance.getAttachProjection(undefined);
  assert.deepEqual(projection.recentHistory.map((entry) => entry.entryId), ["history-assistant"]);
  assert.equal(projection.page.events.some((event) => event.type === "message.delta" || event.type === "message.completed" && event.data.role === "assistant"), false);
});

test("truncated attach history removes older covered replay instead of reversing chronology", async () => {
  const session = new FakeRuntimeSession();
  session.history = Array.from({ length: 201 }, (_, index) => ({
    entryId: `h${index}`,
    role: "assistant",
    content: [{ type: "text", text: `m${index}` }],
  }));
  const instance = createInstance(session, 500);
  for (let index = 0; index < 201; index += 1) {
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `m${index}` }], stopReason: "stop" },
    });
  }

  const projection = await instance.getAttachProjection(undefined, 200);
  assert.equal(projection.historyTruncated, true);
  assert.equal(projection.recentHistory[0]?.entryId, "h1");
  assert.equal(projection.recentHistory.at(-1)?.entryId, "h200");
  assert.equal(projection.page.events.some((event) => event.type === "message.completed" || event.type === "message.delta"), false);
});

test("bounded events expose a monotonic cursor and truncation signal", () => {
  const instance = createInstance(new FakeRuntimeSession(), 3);

  instance.recordExtensionError("one");
  instance.recordExtensionError("two");
  instance.recordExtensionError("three");

  const page = instance.eventsSince(0);
  assert.equal(page.events.length, 3);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.events.map((event) => event.sequence), [2, 3, 4]);
  assert.equal(page.latest.sequence, 4);
});

test("non-finite event capacity falls back to a bounded default", () => {
  for (const capacity of [Number.POSITIVE_INFINITY, Number.NaN]) {
    const instance = createInstance(new FakeRuntimeSession(), capacity);
    for (let index = 0; index < 510; index += 1) {
      instance.recordExtensionError(`error-${index}`);
    }

    const page = instance.eventsSince(0);
    assert.equal(page.events.length, 500);
    assert.equal(page.truncated, true);
    assert.equal(page.latest.sequence, 511);
  }
});
