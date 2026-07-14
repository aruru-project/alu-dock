import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedRuntimeSession } from "./support/delayed-runtime-session.js";

interface Harness {
  directory: string;
  socketPath: string;
  host: DockHost;
  registry: DockRegistry;
  sessions: Map<string, DelayedRuntimeSession>;
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-control-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedRuntimeSession>();
  let sequence = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, name }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, session);
    const instance = new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, name, session, eventCapacity: 500 });
    await instance.submit("deterministic delayed task");
    return instance;
  }, () => `instance-${++sequence}`);
  const host = new DockHost({ socketPath, registry });
  return { directory, socketPath, host, registry, sessions };
}

async function cleanupHarness(harness: Harness): Promise<void> {
  await harness.host.stop().catch(() => {});
  await rm(harness.directory, { recursive: true, force: true });
}

test("V2 hello rejects version and capability mismatch before side effects", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-hello-gate-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let factoryCalls = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryCalls += 1;
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) });
  }, () => "gated-instance", { hostEpoch: "host-epoch-gate", startedAt: "2026-07-14T00:00:00.000Z" });
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();

  const base = { kind: "hello", requestId: "hello-1", client: { name: "test", version: "0.1.0", clientId: "client-1" } };
  const versionError = await exchangeOne(socketPath, { ...base, versions: [1], requiredCapabilities: [] });
  assert.equal(versionError.kind, "hello_error");
  assert.equal(objectValue(versionError.error).code, "unsupported_protocol");
  assert.equal(factoryCalls, 0);

  const capabilityError = await exchangeOne(socketPath, { ...base, requestId: "hello-2", versions: [2], requiredCapabilities: ["catalog.v1"] });
  assert.equal(capabilityError.kind, "hello_error");
  assert.equal(objectValue(capabilityError.error).code, "capability_missing");
  assert.equal(factoryCalls, 0);

  const createFrame = { kind: "request", version: 2, requestId: "create-after-reject", type: "instance.create", params: { operationId: "op-after-reject", cwd: directory } };
  const pipelinedVersionError = await exchangePipelined(socketPath, [{ ...base, requestId: "pipeline-version", versions: [1], requiredCapabilities: [] }, createFrame]);
  assert.equal(pipelinedVersionError.kind, "hello_error");
  const pipelinedCapabilityError = await exchangePipelined(socketPath, [{ ...base, requestId: "pipeline-capability", versions: [2], requiredCapabilities: ["missing.v1"] }, createFrame]);
  assert.equal(pipelinedCapabilityError.kind, "hello_error");
  assert.equal(factoryCalls, 0);

  const ack = await exchangeOne(socketPath, { ...base, requestId: "hello-3", versions: [2], requiredCapabilities: ["core.v2"] });
  assert.equal(ack.kind, "hello_ack");
  assert.deepEqual(ack.capabilities, ["core.v2", "events.follow", "host.info", "instance.catalog", "models.v1", "session.core"]);
  assert.equal(objectValue(ack.host).hostEpoch, "host-epoch-gate");
  assert.equal(objectValue(ack.limits).maxLineBytes, 1024 * 1024);
  assert.equal(factoryCalls, 0);

  const malformedAfterHello = await exchangeMalformedAfterHello(socketPath);
  assert.equal(malformedAfterHello.kind, "response");
  assert.equal(objectValue(malformedAfterHello.error).code, "invalid_envelope");
  assert.equal(factoryCalls, 0);

  let id = 0;
  const client = new DockClient({ socketPath, requestId: () => `request-${++id}` });
  const created = await client.create(directory);
  assert.equal(factoryCalls, 1);
  assert.equal(created.creationOperationId, "request-1");
  assert.equal(created.ownerHostEpoch, "host-epoch-gate");
  assert.deepEqual((await client.hostInfo()).diagnostics[0], {
    severity: "info", message: "Development registry is in-memory and non-durable", source: "registry",
  });
});

test("two clients observe and replay one host-owned running instance", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));

  const firstStart = harness.host.start();
  const concurrentStart = harness.host.start();
  assert.equal(firstStart, concurrentStart);
  await Promise.all([firstStart, concurrentStart]);

  const mode = (await lstat(harness.socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const clientA = new DockClient({ socketPath: harness.socketPath });
  const created = await clientA.create(harness.directory, "delayed");
  assert.equal(created.id, "instance-1");
  assert.equal(created.execution, "running");
  assert.equal(created.executor.piSessionId, "pi-instance-1");

  // create() has already closed client A's socket. The host-owned run remains.
  assert.equal(harness.registry.get(created.id).snapshot().execution, "running");

  const clientB = new DockClient({ socketPath: harness.socketPath });
  const listed = await clientB.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal((await clientB.status(created.id)).execution, "running");

  const initial = await clientB.events(created.id);
  assert.ok(initial.page.events.some((event) => event.type === "command.accepted"));
  const cursor = initial.page.latest;

  const oldEpoch = await clientB.events(created.id, { ...initial.page.latest, hostEpoch: "previous-host" });
  assert.equal(oldEpoch.page.epochChanged, true);
  assert.equal(oldEpoch.page.generationChanged, false);
  assert.ok(oldEpoch.page.events.some((event) => event.type === "instance.created"));

  const oldGeneration = await clientB.events(created.id, { ...initial.page.latest, runtimeGeneration: 99 });
  assert.equal(oldGeneration.page.epochChanged, false);
  assert.equal(oldGeneration.page.generationChanged, true);
  await assert.rejects(
    clientB.events(created.id, { ...initial.page.latest, instanceId: "another-instance" }),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );

  harness.sessions.get(created.id)?.settle("fake done");
  await harness.registry.get(created.id).waitForIdle();
  const replay = await clientB.events(created.id, cursor);
  assert.ok(replay.page.events.some((event) => event.type === "run.settled"));
  assert.equal(replay.instance.lastRun, "succeeded");

  let resolveLiveEvent!: (type: string) => void;
  const liveEvent = new Promise<string>((resolveEvent) => { resolveLiveEvent = resolveEvent; });
  const live = await clientB.streamEvents(created.id, {
    since: replay.page.latest,
    onEvent: (event) => {
      if (event.type === "extension.error") resolveLiveEvent(event.type);
    },
  });
  harness.registry.get(created.id).recordExtensionError("live");
  let liveTimeout: NodeJS.Timeout | undefined;
  try {
    assert.equal(
      await Promise.race([
        liveEvent,
        new Promise<never>((_resolve, reject) => {
          liveTimeout = setTimeout(() => reject(new Error("timed out waiting for live event")), 2_000);
        }),
      ]),
      "extension.error",
    );
  } finally {
    if (liveTimeout) clearTimeout(liveTimeout);
  }
  live.close();
  await live.done;

  const futureEvents: string[] = [];
  const future = await clientB.streamEvents(created.id, {
    since: { ...replay.page.latest, sequence: 10_000 },
    onEvent: (event) => futureEvents.push(event.type),
  });
  harness.registry.get(created.id).recordExtensionError("below future cursor");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  future.close();
  await future.done;
  assert.deepEqual(futureEvents, []);

  for (let index = 0; index < 600; index += 1) {
    harness.registry.get(created.id).recordExtensionError("x".repeat(8_000));
  }
  const boundedReplay = await clientB.events(created.id);
  assert.equal(boundedReplay.page.truncated, true);
  assert.ok(boundedReplay.page.events.length <= 500);
  assert.equal(boundedReplay.page.latest.sequence, harness.registry.get(created.id).snapshot().eventCursor.sequence);

  await harness.host.stop();
  assert.equal(harness.registry.get(created.id).snapshot().lifecycle, "stopped");
  await assert.rejects(lstat(harness.socketPath), { code: "ENOENT" });
  await assert.rejects(harness.host.start(), /Cannot start a host that is stopped/);
});

test("attach applies the 1000-event replay cap before response byte trimming", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-replay-cap-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`), eventCapacity: 1_500 })
  ), () => "replay-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory);
  for (let index = 0; index < 1_100; index += 1) registry.get(created.id).recordExtensionError(`e${index}`);

  const replay = await client.events(created.id);
  assert.equal(replay.page.events.length, 1_000);
  assert.equal(replay.page.truncated, true);
  assert.equal(replay.page.earliest.sequence, replay.page.events[0]?.sequence);
  assert.equal(replay.page.latest.sequence - replay.page.earliest.sequence, 999);
});

test("shutdown waits for an admitted asynchronous create and then stops it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-create-race-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");

  let releaseFactory!: () => void;
  let factoryEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { factoryEntered = resolveEntered; });
  const release = new Promise<void>((resolveRelease) => { releaseFactory = resolveRelease; });
  let created: ManagedInstance | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryEntered();
    await release;
    created = new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) });
    return created;
  }, () => "slow-instance");
  const host = new DockHost({ socketPath, registry });
  await host.start();

  const client = new DockClient({ socketPath, timeoutMs: 2_000 });
  const createRequest = client.create(directory);
  void createRequest.catch(() => {});
  await entered;
  const stopping = host.stop();
  releaseFactory();
  await stopping;

  await assert.rejects(createRequest, ControlClientError);
  assert.equal(created?.snapshot().lifecycle, "stopped");
  assert.equal(registry.list()[0]?.lifecycle, "stopped");
});

test("a second client can steer, queue follow-up, and stop idempotently", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const creator = new DockClient({ socketPath: harness.socketPath });
  const created = await creator.create(harness.directory);
  const controller = new DockClient({ socketPath: harness.socketPath });

  const steer = await controller.prompt(created.id, "change direction");
  assert.equal(steer.receipt.delivery, "steer");
  assert.equal(steer.receipt.queued, true);
  assert.equal(steer.instance.pending.steering, 1);

  const followUp = await controller.prompt(created.id, "then summarize", "followUp");
  assert.equal(followUp.receipt.delivery, "followUp");
  assert.equal(followUp.receipt.queued, true);
  assert.equal(followUp.instance.pending.followUp, 1);

  await assert.rejects(
    controller.prompt(created.id, "parallel", "prompt"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_delivery",
  );

  const firstStop = await controller.stop(created.id);
  assert.equal(firstStop.receipt.alreadyStopped, false);
  assert.equal(firstStop.instance.lifecycle, "stopped");
  assert.equal(firstStop.instance.lastRun, "aborted");
  assert.equal(firstStop.instance.pending.total, 0);

  const secondStop = await controller.stop(created.id);
  assert.equal(secondStop.receipt.alreadyStopped, true);
  await assert.rejects(
    controller.prompt(created.id, "too late"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_not_active",
  );
});

test("a reconnected client can start a fresh prompt on an idle instance", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-idle-prompt-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedRuntimeSession>();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, session);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "idle-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();

  const created = await new DockClient({ socketPath }).create(directory);
  assert.equal(created.execution, "idle");
  const accepted = await new DockClient({ socketPath }).prompt(created.id, "start now");
  assert.equal(accepted.receipt.delivery, "prompt");
  assert.equal(accepted.receipt.queued, false);
  assert.equal(accepted.instance.execution, "running");
  assert.equal((await new DockClient({ socketPath }).status(created.id)).execution, "running");

  const cursor = accepted.instance.eventCursor;
  sessions.get(created.id)?.settle("finished");
  await registry.get(created.id).waitForIdle();
  const replay = await new DockClient({ socketPath }).events(created.id, cursor);
  assert.ok(replay.page.events.some((event) => event.type === "run.settled"));
  assert.equal(replay.instance.lastRun, "succeeded");
});

test("an idle instance lists and switches Pi models and thinking through the control plane", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-model-control-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) })
  ), () => "model-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();

  const client = new DockClient({ socketPath });
  const created = await client.create(directory);
  const catalog = await client.models(created.id);
  assert.deepEqual(catalog.models.map((model) => `${model.provider}/${model.id}`), [
    "fixture/default",
    "fixture/local",
  ]);
  assert.deepEqual(catalog.availableThinkingLevels, ["off", "low", "high"]);

  const thinking = await client.setThinking(created.id, "high");
  assert.equal(thinking.instance.executor.thinkingLevel, "high");
  const selected = await client.setModel(created.id, "fixture", "local");
  assert.deepEqual(selected.instance.executor.model, { provider: "fixture", id: "local" });
  assert.equal(selected.instance.executor.thinkingLevel, "high");

  const accepted = await client.prompt(created.id, "start");
  assert.equal(accepted.instance.execution, "running");
  await assert.rejects(
    client.setModel(created.id, "fixture", "default"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );

  const events = await client.events(created.id);
  assert.ok(events.page.events.some((event) => event.type === "model.changed"));
  assert.ok(events.page.events.some((event) => event.type === "thinking.changed"));
});

test("same-host operation receipts deduplicate every implemented mutation and reject conflicts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-ledger-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let factoryCalls = 0;
  let releaseFactory!: () => void;
  let markFactoryEntered!: () => void;
  const factoryGate = new Promise<void>((resolveGate) => { releaseFactory = resolveGate; });
  const factoryEntered = new Promise<void>((resolveEntered) => { markFactoryEntered = resolveEntered; });
  const sessions = new Map<string, DelayedRuntimeSession>();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryCalls += 1;
    markFactoryEntered();
    await factoryGate;
    const session = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, session);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "ledger-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const firstClient = new DockClient({ socketPath });
  const secondClient = new DockClient({ socketPath });

  const firstCreate = firstClient.create(directory, undefined, "shared-create");
  const duplicateCreate = secondClient.create(directory, undefined, "shared-create");
  await factoryEntered;
  assert.equal(factoryCalls, 1);
  releaseFactory();
  const [firstInstance, duplicateInstance] = await Promise.all([firstCreate, duplicateCreate]);
  assert.deepEqual(duplicateInstance, firstInstance);
  assert.deepEqual(await firstClient.create(directory, undefined, "shared-create"), firstInstance);
  await assert.rejects(
    firstClient.create(directory, "conflict", "shared-create"),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
  );
  assert.equal(factoryCalls, 1);

  const session = sessions.get(firstInstance.id) as DelayedRuntimeSession;
  const [firstModel, duplicateModel] = await Promise.all([
    firstClient.setModel(firstInstance.id, "fixture", "local", "shared-model"),
    secondClient.setModel(firstInstance.id, "fixture", "local", "shared-model"),
  ]);
  assert.deepEqual(duplicateModel, firstModel);
  assert.equal(firstModel.settingsWrite.persisted, true);
  assert.equal(session.modelMutationCalls, 1);
  await assert.rejects(
    firstClient.setModel(firstInstance.id, "fixture", "default", "shared-model"),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
  );

  const [firstThinking, duplicateThinking] = await Promise.all([
    firstClient.setThinking(firstInstance.id, "high", "shared-thinking"),
    secondClient.setThinking(firstInstance.id, "high", "shared-thinking"),
  ]);
  assert.deepEqual(duplicateThinking, firstThinking);
  assert.equal(firstThinking.actualLevel, "high");
  assert.equal(firstThinking.settingsWrite.persisted, true);
  assert.equal(session.thinkingMutationCalls, 1);

  const [firstCommand, duplicateCommand] = await Promise.all([
    firstClient.prompt(firstInstance.id, "run once", "prompt", "shared-command"),
    secondClient.prompt(firstInstance.id, "run once", "prompt", "shared-command"),
  ]);
  assert.deepEqual(duplicateCommand, firstCommand);
  assert.equal(session.promptCalls, 1);

  const [firstStop, duplicateStop] = await Promise.all([
    firstClient.stop(firstInstance.id, "shared-stop"),
    secondClient.stop(firstInstance.id, "shared-stop"),
  ]);
  assert.deepEqual(duplicateStop, firstStop);
  assert.equal(firstStop.receipt.operationId, "shared-stop");
  assert.equal(firstStop.receipt.alreadyStopped, false);
  assert.equal(session.abortCalls, 1);
});

test("models settings failures are typed, evented, and leave the in-memory state honest", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-settings-failure-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let session: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    session = new DelayedRuntimeSession(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "settings-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory);
  (session as DelayedRuntimeSession).settingsFailure = new Error("disk write failed");

  await assert.rejects(
    client.setModel(created.id, "fixture", "local", "failed-model-write"),
    (error: unknown) => error instanceof ControlClientError && error.code === "settings_write_failed" && /disk write failed/.test(error.message),
  );
  assert.deepEqual((await client.status(created.id)).executor.model, { provider: "fixture", id: "local" });
  const events = await client.events(created.id);
  assert.ok(events.page.events.some((event) => event.type === "settings.write_failed" && event.data.key === "model"));

  (session as DelayedRuntimeSession).settingsFailure = undefined;
  const low = await client.setThinking(created.id, "low", "thinking-low");
  const high = await client.setThinking(created.id, "high", "thinking-high");
  assert.equal(low.actualLevel, "low");
  assert.equal(high.actualLevel, "high");
  assert.equal(high.settingsWrite.persisted, true);
  assert.equal((session as DelayedRuntimeSession).thinkingMutationCalls, 2);
});

test("session.core lists bounded safe cwd and all-session metadata", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-session-list-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let session: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    session = new DelayedRuntimeSession(`pi-${id}`);
    session.sessionCatalog = [
      { sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z" },
      { sessionId: "other-session", sessionFile: "/sessions/other.jsonl", cwd: "/other", updatedAt: "not-a-date" },
    ];
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session });
  }, () => "session-list-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory);

  assert.deepEqual((await client.sessions(created.id, "cwd")).sessions, [{
    sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z",
  }]);
  assert.deepEqual((await client.sessions(created.id, "all")).sessions, [
    { sessionId: "cwd-session", sessionFile: "/sessions/cwd.jsonl", name: "Current", cwd: "/fixture/cwd", updatedAt: "2026-07-14T01:02:03.000Z" },
    { sessionId: "other-session", sessionFile: "/sessions/other.jsonl", name: undefined, cwd: "/other", updatedAt: undefined },
  ]);
});

test("unexpected host closure rejects a live follow subscription", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory);
  const subscription = await client.streamEvents(created.id, { onEvent: () => {} });

  await harness.host.stop();
  await assert.rejects(
    subscription.done,
    (error: unknown) => error instanceof ControlClientError && error.code === "connection_closed",
  );
});

test("oversized instance names are rejected before registry side effects", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });

  await assert.rejects(
    client.create(harness.directory, "x".repeat(257)),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_request",
  );
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(harness.registry.list(), []);
});

test("a second host cannot unlink a live host socket", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();

  const contender = new DockHost({ socketPath: harness.socketPath, registry: harness.registry });
  await assert.rejects(contender.start(), /already listening/);

  const ping = await new DockClient({ socketPath: harness.socketPath }).ping();
  assert.equal(ping.protocolVersion, 2);
  await contender.stop();
  assert.equal((await new DockClient({ socketPath: harness.socketPath }).ping()).protocolVersion, 2);
});

test("concurrent host objects do not unlink the winning listener", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-host-race-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");
  const createRegistry = (): DockRegistry => new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) })
  ));
  const first = new DockHost({ socketPath, registry: createRegistry() });
  const second = new DockHost({ socketPath, registry: createRegistry() });

  const starts = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(starts.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await new DockClient({ socketPath }).ping()).protocolVersion, 2);

  await Promise.all([first.stop(), second.stop()]);
});

test("host rejects a socket directory accessible by other users", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-insecure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) })
  ));
  const host = new DockHost({ socketPath: join(directory, "dock.sock"), registry });

  await assert.rejects(host.start(), /must not grant group\/other access/);
});

test("ping reports negotiated capabilities and normal hellos require core plus operation capability", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-negotiation-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const hellos: Record<string, unknown>[] = [];
  const capabilities = ["core.v2", "host.info", "custom.observed"];
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          hellos.push(frame);
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 7, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "negotiated-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities, limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200 } }));
        } else {
          socket.end(encodeJsonLine({ kind: "response", version: 2, requestId: frame.requestId, hostEpoch: "negotiated-epoch", ok: true, result: { state: "ready", host: { pid: 7, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "negotiated-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalog: { schemaVersion: 1, revision: 0, lastReconciledAt: "2026-07-14T00:00:00.000Z" }, paths: { socket: socketPath, state: "memory:test" }, diagnostics: [] } }));
        }
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });

  const ping = await new DockClient({ socketPath }).ping();
  assert.deepEqual(ping.capabilities, capabilities);
  assert.deepEqual(hellos[0]?.requiredCapabilities, ["core.v2", "host.info"]);
});

test("post-send mutation transport loss is effect_unknown with caller operation ID, while reads stay transport errors", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-effect-unknown-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 8, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "effect-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities: ["core.v2", "instance.catalog"], limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200 } }));
        } else socket.destroy();
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });
  const client = new DockClient({ socketPath });

  await assert.rejects(client.create(directory, undefined, "caller-operation-1"), (error: unknown) => (
    error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "caller-operation-1"
  ));
  await assert.rejects(client.list(), (error: unknown) => error instanceof ControlClientError && error.code !== "effect_unknown");
});

test("post-send mutation timeout is effect_unknown and is not retried", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-effect-timeout-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let requests = 0;
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = objectValue(JSON.parse(line) as unknown);
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({ kind: "hello_ack", requestId: frame.requestId, version: 2, host: { pid: 9, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "timeout-epoch", startedAt: "2026-07-14T00:00:00.000Z" }, catalogSchemaVersion: 1, capabilities: ["core.v2", "instance.catalog"], limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200 } }));
        } else requests += 1;
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });
  const client = new DockClient({ socketPath, timeoutMs: 25 });

  await assert.rejects(client.create(directory, undefined, "timeout-operation"), (error: unknown) => (
    error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "timeout-operation"
  ));
  assert.equal(requests, 1);
  await assert.rejects(client.list(), (error: unknown) => error instanceof ControlClientError && error.code === "timeout");
  assert.equal(requests, 2);
});

test("stream callbacks follow the initial result even when frames share one chunk", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-frame-order-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.kind === "hello") {
          socket.write(encodeJsonLine({
            kind: "hello_ack", requestId: "fixed", version: 2,
            host: { pid: 1, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "epoch-1", startedAt: "2026-07-14T00:00:00.000Z" },
            catalogSchemaVersion: 1,
            capabilities: ["core.v2", "events.follow"],
            limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200 },
          }));
          continue;
        }
        const cursor = { hostEpoch: "epoch-1", instanceId: "instance-1", runtimeGeneration: 1, sequence: 1 };
        const snapshot = {
          id: "instance-1", creationOperationId: "create-1", cwd: directory,
          lifecycle: "active", execution: "running", lastRun: "never", reopenable: false,
          runtimeGeneration: 1, ownerHostEpoch: "epoch-1", pending: { steering: 0, followUp: 0, total: 0 },
          executor: { kind: "fake", piSessionId: "pi-1" }, extensionStatus: {}, activeCommandId: "command-1",
          createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z", eventCursor: cursor,
        };
        const event = { scope: "instance", sequence: 2, instanceId: "instance-1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:01.000Z", type: "extension.error", data: { error: "live" } };
        socket.write(encodeJsonLine({
          kind: "response", version: 2, requestId: "fixed", hostEpoch: "epoch-1", ok: true,
          result: { instance: snapshot, page: { events: [], earliest: cursor, latest: cursor, truncated: false, epochChanged: false, generationChanged: false }, recentHistory: [], historyTruncated: true, controller: { status: "observing" }, following: true },
        }) + encodeJsonLine({ kind: "event", version: 2, requestId: "fixed", hostEpoch: "epoch-1", event }));
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  });

  const order: string[] = [];
  const client = new DockClient({ socketPath, requestId: () => "fixed" });
  const subscription = await client.streamEvents("instance-1", {
    onEvent: () => order.push("event"),
  });
  order.push("initial");
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(order, ["initial", "event"]);
  subscription.close();
  await subscription.done;
});

test("client rejects a V1 host response as protocol incompatible", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-malformed-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end('{"kind":"response","version":1,"requestId":"fixed","ok":false}\n');
    });
  });
  await listen(server, socketPath);
  context.after(async () => {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  });

  const client = new DockClient({ socketPath, requestId: () => "fixed" });
  await assert.rejects(
    client.ping(),
    (error: unknown) => error instanceof ControlClientError && error.code === "protocol_incompatible",
  );
});

function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function exchangeOne(socketPath: string, frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, rejectFrame) => {
    const socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    socket.once("connect", () => socket.write(encodeJsonLine(frame)));
    socket.on("data", (chunk: Buffer) => {
      try {
        const [line] = decoder.push(chunk);
        if (!line) return;
        const value = objectValue(JSON.parse(line) as unknown);
        socket.destroy();
        resolveFrame(value);
      } catch (error) {
        socket.destroy();
        rejectFrame(error);
      }
    });
    socket.once("error", rejectFrame);
  });
}

async function exchangePipelined(socketPath: string, frames: unknown[]): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, rejectFrame) => {
    const socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    let result: Record<string, unknown> | undefined;
    socket.once("connect", () => socket.write(frames.map((frame) => encodeJsonLine(frame)).join("")));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) result ??= objectValue(JSON.parse(line) as unknown);
      } catch (error) { socket.destroy(); rejectFrame(error); }
    });
    socket.once("close", () => result ? resolveFrame(result) : rejectFrame(new Error("connection closed without a frame")));
    socket.once("error", rejectFrame);
  });
}

async function exchangeMalformedAfterHello(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, rejectFrame) => {
    const socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    let helloComplete = false;
    socket.once("connect", () => socket.write(encodeJsonLine({ kind: "hello", requestId: "malformed-hello", versions: [2], client: { name: "test", version: "0.1.0", clientId: "malformed-client" }, requiredCapabilities: ["core.v2"] })));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) {
          const frame = objectValue(JSON.parse(line) as unknown);
          if (!helloComplete) { helloComplete = true; socket.write("{not-json}\n"); }
          else { socket.destroy(); resolveFrame(frame); }
        }
      } catch (error) { socket.destroy(); rejectFrame(error); }
    });
    socket.once("error", rejectFrame);
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
