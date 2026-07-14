import assert from "node:assert/strict";
import test from "node:test";

import {
  InstanceAdmissionPendingError,
  InstanceNotActiveError,
  InvalidDeliveryModeError,
  ManagedInstance,
} from "../src/core/managed-instance.js";
import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimePromptOptions,
  RuntimeSession,
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
  promptDeferred = new Deferred<void>();
  promptCalls: Array<{ text: string; options?: RuntimePromptOptions }> = [];
  abortCalls = 0;
  disposeCalls = 0;
  clearQueueResult: ClearedRuntimeQueue = { steering: [], followUp: [] };
  rejectPreflightWith: Error | undefined;
  delayPreflight = false;
  disposeError: Error | undefined;
  abortError: Error | undefined;

  private pendingPreflight: ((success: boolean) => void) | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    this.promptCalls.push({ text, options });
    if (this.rejectPreflightWith) {
      options?.preflightResult?.(false);
      return Promise.reject(this.rejectPreflightWith);
    }
    if (this.delayPreflight) {
      this.pendingPreflight = options?.preflightResult;
      return this.promptDeferred.promise;
    }
    options?.preflightResult?.(true);
    if (this.isStreaming && options?.streamingBehavior) return Promise.resolve();
    return this.promptDeferred.promise;
  }

  clearQueue(): ClearedRuntimeQueue {
    this.emit({ type: "queue_update", steering: [], followUp: [] });
    return this.clearQueueResult;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortError) throw this.abortError;
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

  dispose(): void {
    this.disposeCalls += 1;
    if (this.disposeError) throw this.disposeError;
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

test("submit returns after preflight while the runtime promise remains host-owned", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  const receipt = await instance.submit("do a long task");

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.commandId, "command-1");
  assert.equal(receipt.queued, false);
  assert.equal(instance.snapshot().execution, "running");
  assert.equal(instance.snapshot().id, "dock-instance-1");
  assert.equal(instance.snapshot().executor.piSessionId, "pi-session-1");
  assert.notEqual(instance.snapshot().id, instance.snapshot().executor.piSessionId);
  assert.equal(session.promptCalls.length, 1);

  session.startRun();
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
    instanceId: "dock-instance-1",
    stopped: true,
    alreadyStopped: false,
  });
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

  await assert.rejects(
    instance.submit("parallel prompt", "prompt"),
    InvalidDeliveryModeError,
  );

  session.settle();
});

test("a queued request becomes a tracked prompt when the original run settles during preflight", async () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  const originalDeferred = session.promptDeferred;
  await instance.submit("original");
  session.startRun();

  session.delayPreflight = true;
  session.promptDeferred = new Deferred<void>();
  const nextSubmit = instance.submit("next", "auto");

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
  assert.equal(accepted?.data.requestedDelivery, "steer");
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
  assert.equal(receipt.commandId, "command-1");
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
  assert.equal(instance.snapshot().execution, "idle");
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
  assert.ok(instance.eventsSince().events.some((event) => event.type === "command.background_failed"));
  assert.equal(
    instance.eventsSince().events.some((event) => event.type === "run.settled_missing"),
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

  const [first, second] = await Promise.all([instance.stop(), instance.stop()]);

  assert.equal(first.stopped, true);
  assert.deepEqual(first, second);
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
    event.type = "corrupted";
    event.data.steering = 999;
    throw new Error("broken client socket");
  });
  instance.subscribe((event) => seen.push(`${event.type}:${String(event.data.steering)}`));

  assert.doesNotThrow(() => session.emit({
    type: "queue_update",
    steering: ["one"],
    followUp: [],
  }));
  assert.deepEqual(seen, ["queue.changed:1"]);
  assert.equal(instance.snapshot().pending.steering, 1);
  assert.equal(instance.eventsSince().events.at(-1)?.type, "queue.changed");
  assert.equal(instance.eventsSince().events.at(-1)?.data.steering, 1);
});

test("runtime event data is sanitized into JSON-serializable values", () => {
  const session = new FakeRuntimeSession();
  const instance = createInstance(session);

  session.emit({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "test",
    args: { count: 1n, callback: () => undefined, marker: Symbol("marker") },
  });

  const page = instance.eventsSince();
  assert.doesNotThrow(() => JSON.stringify(page));
  const event = page.events.find((item) => item.type === "tool.started");
  const args = event?.data.args as Record<string, unknown>;
  assert.equal(args.count, "1");
  assert.equal(typeof args.callback, "string");
  assert.equal(args.marker, "Symbol(marker)");
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
  assert.equal(page.latestSequence, 4);
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
    assert.equal(page.latestSequence, 511);
  }
});
