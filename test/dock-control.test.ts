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
import { ProjectTrustCoordinator } from "../src/control/project-trust.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { RuntimeInvalidSettingValueError, RuntimeSettingsWriteError } from "../src/core/runtime-session.js";
import { DelayedRuntimeSession } from "./support/delayed-runtime-session.js";
import { ScriptedCatalogCommitPort } from "./support/scripted-catalog-port.js";

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

async function createTransactionHarness(port: ScriptedCatalogCommitPort, faultDrainTimeoutMs = 2_000): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-transaction-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const sessions = new Map<string, DelayedRuntimeSession>();
  let sequence = 0;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, name }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, session);
    const modelState = session.getModelState();
    return new ManagedInstance({
      id, creationOperationId, hostEpoch, cwd, name, session, eventCapacity: 500,
      executor: { kind: "fixture", model: modelState.model, thinkingLevel: modelState.thinkingLevel },
    });
  }, () => `transaction-${++sequence}`, { catalogCommitPort: port });
  const host = new DockHost({ socketPath, registry, faultDrainTimeoutMs });
  await host.start();
  return { directory, socketPath, host, registry, sessions };
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
  const versionError = await exchangeOne(socketPath, { ...base, versions: [999], requiredCapabilities: [] });
  assert.equal(versionError.kind, "hello_error");
  assert.equal(objectValue(versionError.error).code, "unsupported_protocol");
  assert.equal(factoryCalls, 0);

  const capabilityError = await exchangeOne(socketPath, { ...base, requestId: "hello-2", versions: [2], requiredCapabilities: ["catalog.v1"] });
  assert.equal(capabilityError.kind, "hello_error");
  assert.equal(objectValue(capabilityError.error).code, "capability_missing");
  assert.equal(factoryCalls, 0);

  const createFrame = { kind: "request", version: 2, requestId: "create-after-reject", type: "instance.create", params: { operationId: "op-after-reject", cwd: directory } };
  const pipelinedVersionError = await exchangePipelined(socketPath, [{ ...base, requestId: "pipeline-version", versions: [999], requiredCapabilities: [] }, createFrame]);
  assert.equal(pipelinedVersionError.kind, "hello_error");
  const pipelinedCapabilityError = await exchangePipelined(socketPath, [{ ...base, requestId: "pipeline-capability", versions: [2], requiredCapabilities: ["missing.v1"] }, createFrame]);
  assert.equal(pipelinedCapabilityError.kind, "hello_error");
  assert.equal(factoryCalls, 0);

  const ack = await exchangeOne(socketPath, { ...base, requestId: "hello-3", versions: [2], requiredCapabilities: ["core.v2"] });
  assert.equal(ack.kind, "hello_ack");
  assert.deepEqual(ack.capabilities, ["core.v2", "events.follow", "host.info", "instance.catalog", "models.v1", "resources.v1", "session.core", "settings.v1", "tools.v1"]);
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

test("project trust challenge precedes factory effects and denial continues untrusted", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-trust-host-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const trustedValues: boolean[] = [];
  let factoryCalls = 0;
  const trust = new ProjectTrustCoordinator({
    requiresTrust: () => true,
    savedDecision: () => null,
    defaultDecision: () => "ask",
    remember: () => assert.fail("deny_once must not write trust store"),
  }, { createId: () => "challenge-1", now: () => 1_000 });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd, projectTrusted }) => {
    factoryCalls += 1;
    trustedValues.push(projectTrusted);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: new DelayedRuntimeSession(`pi-${id}`) });
  }, () => "trusted-instance", { trustPreflight: trust });
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });

  let challenge: ControlClientError | undefined;
  try {
    await client.create(directory, "project", "trust-operation");
  } catch (error) {
    assert.ok(error instanceof ControlClientError);
    challenge = error;
  }
  assert.equal(challenge?.code, "project_trust_required");
  assert.equal(challenge?.operationId, "trust-operation");
  assert.equal(challenge?.details?.challengeId, "challenge-1");
  assert.equal(challenge?.details?.operationId, "trust-operation");
  assert.equal(factoryCalls, 0);
  assert.deepEqual(registry.list(), []);

  await assert.rejects(
    client.create(directory, "changed-target", "trust-operation", {
      challengeId: "challenge-1",
      decision: "deny_once",
    }),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_project_trust_challenge",
  );
  assert.equal(factoryCalls, 0);

  const created = await client.create(directory, "project", "trust-operation", {
    challengeId: "challenge-1",
    decision: "deny_once",
  });
  assert.equal(created.id, "trusted-instance");
  assert.deepEqual(trustedValues, [false]);
  assert.equal(factoryCalls, 1);

  const duplicate = await client.create(directory, "project", "trust-operation", {
    challengeId: "challenge-1",
    decision: "deny_once",
  });
  assert.equal(duplicate.id, created.id);
  assert.equal(factoryCalls, 1);
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

  const beforeHostDrain = harness.registry.get(created.id).snapshot();
  assert.equal(beforeHostDrain.execution, "idle");
  await harness.host.stop();
  assert.equal(harness.sessions.get(created.id)?.disposeCalls, 1);
  const afterHostDrain = harness.registry.get(created.id).snapshot();
  assert.equal(afterHostDrain.lifecycle, "active");
  assert.equal(afterHostDrain.execution, beforeHostDrain.execution);
  assert.equal(afterHostDrain.lastRun, beforeHostDrain.lastRun);
  assert.equal(afterHostDrain.activeCommandId, beforeHostDrain.activeCommandId);
  assert.deepEqual(afterHostDrain.eventCursor, beforeHostDrain.eventCursor);
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

test("shutdown waits for an admitted asynchronous create and drains its runtime without explicit stop semantics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-create-race-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");

  let releaseFactory!: () => void;
  let factoryEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { factoryEntered = resolveEntered; });
  const release = new Promise<void>((resolveRelease) => { releaseFactory = resolveRelease; });
  let created: ManagedInstance | undefined;
  let runtime: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryEntered();
    await release;
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    created = new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
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
  assert.equal(runtime?.disposeCalls, 1);
  assert.equal(created?.snapshot().lifecycle, "active");
  assert.equal(registry.list()[0]?.lifecycle, "active");
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

test("client rejects a non-handshake frame before operations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-malformed-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end('{"kind":"response","version":999,"requestId":"fixed","ok":false}\n');
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

test("tools, settings, resources, and commands integrate with capability gates and mutation dedup", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-projections-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "projection-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, undefined, "projection-create");

  assert.deepEqual((await client.tools(instance.id)).tools.filter((tool) => tool.active).map((tool) => tool.name), ["read"]);
  const first = await client.setActiveTools(instance.id, ["write"], "tools-op");
  const duplicate = await client.setActiveTools(instance.id, ["write"], "tools-op");
  assert.deepEqual(first, duplicate);
  assert.equal(runtime?.toolMutationCalls, 1);

  const settings = await client.settings(instance.id);
  assert.equal(settings.settings.length, 20);
  if (!runtime) throw new Error("fixture runtime was not created");
  runtime.settingsReadFailure = new RuntimeInvalidSettingValueError("editorPaddingX");
  await assert.rejects(
    client.settings(instance.id),
    (error: unknown) => error instanceof ControlClientError && error.code === "settings_invalid" && !error.message.includes("99"),
  );
  runtime.settingsReadFailure = undefined;
  const updated = await client.updateSetting(instance.id, { key: "enableSkillCommands", value: false }, "setting-op");
  const repeated = await client.updateSetting(instance.id, { key: "enableSkillCommands", value: false }, "setting-op");
  assert.equal(updated.setting.value, false);
  assert.equal(updated.reloadRequired, true);
  assert.deepEqual(updated, repeated);
  assert.equal(runtime?.settingMutationCalls, 1);

  assert.equal((await client.resources(instance.id)).resources[0]?.name, "AGENTS.md");
  assert.equal((await client.commands(instance.id, "fix")).commands[0]?.name, "fixture");
  assert.deepEqual((await client.commands(instance.id, "missing")).commands, []);
});

test("catalog create commit gates publication and rollback disposes an unpublished candidate", async (context) => {
  const gatedPort = new ScriptedCatalogCommitPort();
  const createGate = gatedPort.gateAt(1);
  const gated = await createTransactionHarness(gatedPort);
  context.after(() => cleanupHarness(gated));
  const gatedClient = new DockClient({ socketPath: gated.socketPath });
  const creating = gatedClient.create(gated.directory, undefined, "create-gated");
  await createGate.entered;
  assert.equal(gated.registry.catalogRevision(), 0);
  assert.deepEqual(gated.registry.list(), []);
  createGate.release();
  const created = await creating;
  assert.equal(gated.registry.catalogRevision(), 1);
  assert.equal(gated.registry.list()[0]?.id, created.id);

  const failedPort = new ScriptedCatalogCommitPort();
  failedPort.failAt(1, "AUTH_TOKEN_very_secret data:image/png;base64,AAAA");
  const failed = await createTransactionHarness(failedPort);
  context.after(() => cleanupHarness(failed));
  const failedClient = new DockClient({ socketPath: failed.socketPath });
  await assert.rejects(
    failedClient.create(failed.directory, undefined, "create-failed"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "catalog_write_failed"
      && error.message.includes("candidate was not published")
      && !error.message.includes("AUTH_TOKEN")
      && !error.message.includes("base64"),
  );
  assert.equal(failed.registry.catalogRevision(), 0);
  assert.deepEqual(failed.registry.list(), []);
  assert.equal(failed.sessions.get("transaction-1")?.disposeCalls, 1);
  const recovered = await failedClient.create(failed.directory, undefined, "create-recovered");
  assert.equal(recovered.id, "transaction-2");
  assert.equal(failed.registry.catalogRevision(), 1);
});

test("prompt pre-intent commit precedes Pi and accepted events follow their commits", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const admissionGate = port.gateAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-prompt-gate");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const prompting = client.prompt(created.id, "hello", "prompt", "prompt-gated");
  await admissionGate.entered;
  assert.equal(runtime.promptCalls, 0);
  assert.equal((await client.status(created.id)).execution, "idle");
  assert.equal((await client.events(created.id)).page.events.some((event) => event.type === "command.accepted"), false);
  admissionGate.release();
  const result = await prompting;
  assert.equal(result.instance.execution, "running");
  assert.deepEqual(port.calls.slice(1, 4).map((call) => call.context.kind), ["command.admission", "command.accepted", "run.started"]);
  const events = (await client.events(created.id)).page.events;
  assert.ok(events.findIndex((event) => event.type === "command.accepted") < events.findIndex((event) => event.type === "run.started"));
});

test("pre-effect catalog failure calls Pi zero times and leaves the Host writable", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-pre-failure");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  await assert.rejects(
    client.prompt(created.id, "blocked", "prompt", "prompt-pre-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "catalog_write_failed",
  );
  assert.equal(runtime.promptCalls, 0);
  assert.equal(harness.registry.catalogHealth(), "healthy");
  const recovered = await client.prompt(created.id, "allowed", "prompt", "prompt-after-pre-failure");
  assert.equal(recovered.receipt.accepted, true);
  assert.equal(runtime.promptCalls, 1);
});

test("post-effect catalog failure returns effect_unknown and drives one read-only fatal drain", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(3);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-post-failure");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const disposeBlock = runtime.blockDispose();

  await assert.rejects(
    client.prompt(created.id, "ambiguous", "prompt", "prompt-post-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "prompt-post-failed",
  );
  await disposeBlock.entered;
  assert.equal(runtime.promptCalls, 1);
  assert.equal(harness.registry.catalogHealth(), "draining");
  const info = await client.hostInfo();
  assert.equal(info.state, "draining");
  assert.equal((await client.status(created.id)).execution, "idle");
  await assert.rejects(
    client.setActiveTools(created.id, ["write"], "mutation-after-fault"),
    (error: unknown) => error instanceof ControlClientError && error.code === "mutation_faulted",
  );
  assert.equal(runtime.toolMutationCalls, 0);

  let fatalResolved = false;
  void harness.host.waitForFatalCompletion().then(() => { fatalResolved = true; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(fatalResolved, false);
  disposeBlock.release();
  const fatal = await harness.host.waitForFatalCompletion();
  assert.equal(fatal.exitCode, 1);
  assert.equal(fatal.drainTimedOut, false);
  assert.equal(runtime.disposeCalls, 1);
});

test("fatal drain lets already-admitted Pi mutations reach operation-scoped ambiguity before disposal", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(3);
  const harness = await createTransactionHarness(port, 500);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const first = await client.create(harness.directory, undefined, "create-concurrent-first");
  const second = await client.create(harness.directory, undefined, "create-concurrent-second");
  const firstRuntime = harness.sessions.get(first.id) as DelayedRuntimeSession;
  const secondRuntime = harness.sessions.get(second.id) as DelayedRuntimeSession;
  const modelBlock = firstRuntime.blockNextModelMutation();
  const firstMutation = client.setModel(first.id, "fixture", "local", "model-already-admitted");
  await modelBlock.entered;
  const faultingMutation = client.setModel(second.id, "fixture", "local", "model-causes-fault");

  await assert.rejects(
    faultingMutation,
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "model-causes-fault",
  );
  assert.equal(firstRuntime.disposeCalls, 0);
  assert.equal(secondRuntime.disposeCalls, 0);
  modelBlock.release();
  await assert.rejects(
    firstMutation,
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "model-already-admitted",
  );
  const fatal = await harness.host.waitForFatalCompletion();
  assert.equal(fatal.drainTimedOut, false);
  assert.equal(firstRuntime.disposeCalls, 1);
  assert.equal(secondRuntime.disposeCalls, 1);
});

test("mutation-fault drain has a bounded nonzero fatal deadline", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  port.failAt(3);
  const harness = await createTransactionHarness(port, 25);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-drain-timeout");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const disposeBlock = runtime.blockDispose();
  await assert.rejects(
    client.prompt(created.id, "ambiguous", "prompt", "prompt-drain-timeout"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown",
  );
  await disposeBlock.entered;
  const fatal = await harness.host.waitForFatalCompletion();
  assert.equal(fatal.exitCode, 1);
  assert.equal(fatal.drainTimedOut, true);
  assert.equal(runtime.disposeCalls, 1);
  disposeBlock.release();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
});

test("fatal deadline includes a hung admitted create and Host stop does not await it again", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-hung-create-fault-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const port = new ScriptedCatalogCommitPort();
  port.failAt(2);
  const sessions = new Map<string, DelayedRuntimeSession>();
  let factoryCalls = 0;
  let enteredSecond!: () => void;
  let releaseSecond!: () => void;
  let finishedSecond!: () => void;
  let secondDisposeEntered!: () => void;
  let releaseSecondDispose = (): void => {};
  const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve; });
  const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondFinished = new Promise<void>((resolve) => { finishedSecond = resolve; });
  const secondDisposing = new Promise<void>((resolve) => { secondDisposeEntered = resolve; });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    factoryCalls += 1;
    if (factoryCalls === 2) {
      enteredSecond();
      await secondRelease;
    }
    const runtime = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, runtime);
    if (factoryCalls === 2) {
      const disposeBlock = runtime.blockDispose();
      releaseSecondDispose = disposeBlock.release;
      void disposeBlock.entered.then(secondDisposeEntered);
      finishedSecond();
    }
    const modelState = runtime.getModelState();
    return new ManagedInstance({
      id, creationOperationId, hostEpoch, cwd, session: runtime,
      executor: { kind: "fixture", model: modelState.model, thinkingLevel: modelState.thinkingLevel },
    });
  }, (() => { let id = 0; return () => `hung-create-${++id}`; })(), { catalogCommitPort: port });
  const host = new DockHost({ socketPath, registry, faultDrainTimeoutMs: 25 });
  context.after(async () => { releaseSecond(); releaseSecondDispose(); await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const first = await client.create(directory, undefined, "create-before-hung");
  const hangingCreate = client.create(directory, undefined, "create-hung").catch((error: unknown) => error);
  await secondEntered;
  await assert.rejects(
    client.setModel(first.id, "fixture", "local", "model-fault-with-hung-create"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown",
  );
  const fatal = await host.waitForFatalCompletion();
  assert.equal(fatal.drainTimedOut, true);
  const stopOutcome = await Promise.race([
    host.stop().then(() => "stopped" as const),
    new Promise<"timed_out">((resolveTimeout) => setTimeout(() => resolveTimeout("timed_out"), 100)),
  ]);
  assert.equal(stopOutcome, "stopped");
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  releaseSecond();
  await secondFinished;
  await secondDisposing;
  assert.equal(sessions.get("hung-create-2")?.disposeCalls, 1);
  releaseSecondDispose();
  await hangingCreate;
  assert.equal(sessions.get(first.id)?.disposeCalls, 1);
});

test("queue and settled commit faults retain the last conservative committed state", async (context) => {
  const queuePort = new ScriptedCatalogCommitPort();
  const queuedHarness = await createTransactionHarness(queuePort);
  context.after(() => cleanupHarness(queuedHarness));
  const queueClient = new DockClient({ socketPath: queuedHarness.socketPath });
  const queuedInstance = await queueClient.create(queuedHarness.directory, undefined, "create-queue-fault");
  await queueClient.prompt(queuedInstance.id, "running", "prompt", "run-before-queue-fault");
  queuePort.failAt(7);
  await assert.rejects(
    queueClient.prompt(queuedInstance.id, "queued", "steer", "queue-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "queue-failed",
  );
  const queuedSnapshot = queuedHarness.registry.get(queuedInstance.id).snapshot();
  assert.equal(queuedSnapshot.execution, "running");
  assert.equal(queuedSnapshot.pending.total, 0);
  assert.equal(queuedHarness.registry.get(queuedInstance.id).eventsSince().events.some((event) => event.type === "queue.changed" && event.data.total === 1), false);
  await queuedHarness.host.waitForFatalCompletion();

  const settledPort = new ScriptedCatalogCommitPort();
  const settledHarness = await createTransactionHarness(settledPort);
  context.after(() => cleanupHarness(settledHarness));
  const settledClient = new DockClient({ socketPath: settledHarness.socketPath });
  const settledInstance = await settledClient.create(settledHarness.directory, undefined, "create-settle-fault");
  await settledClient.prompt(settledInstance.id, "running", "prompt", "run-before-settle-fault");
  settledPort.failAt(5);
  settledHarness.sessions.get(settledInstance.id)?.settle("done");
  await settledHarness.host.waitForFatalCompletion();
  const settledSnapshot = settledHarness.registry.get(settledInstance.id).snapshot();
  assert.equal(settledSnapshot.execution, "running");
  assert.equal(settledSnapshot.activeCommandId, "run-before-settle-fault");
  assert.equal(settledSnapshot.lastRun, "never");
  assert.equal(settledHarness.registry.get(settledInstance.id).eventsSince().events.some((event) => event.type === "run.settled"), false);
});

test("model success and changed events wait for the post-setter catalog commit", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const modelGate = port.gateAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-model-gate");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const changing = client.setModel(created.id, "fixture", "local", "model-gated");
  await modelGate.entered;
  assert.equal(runtime.modelMutationCalls, 1);
  assert.equal((await client.status(created.id)).executor.model?.id, "default");
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "model.changed"), false);
  modelGate.release();
  const changed = await changing;
  assert.equal(changed.instance.executor.model?.id, "local");
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "model.changed"), true);
});

test("a read-first projection reservation cannot observe a later uncommitted configuration", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const thinkingGate = port.gateAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-read-first-race");
  const instance = harness.registry.get(created.id);
  const reading = instance.listModels();
  const changing = instance.setThinkingLevel("high", "thinking-after-read");
  await thinkingGate.entered;
  assert.equal((await reading).state.thinkingLevel, "off");
  assert.equal(instance.snapshot().executor.thinkingLevel, "off");
  thinkingGate.release();
  assert.equal((await changing).thinkingLevel, "high");
});

test("tool thinking and settings projections wait for their catalog commits", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const toolGate = port.gateAt(2);
  const thinkingGate = port.gateAt(3);
  const settingGate = port.gateAt(4);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-config-gates");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  let toolSettled = false;
  const changingTools = client.setActiveTools(created.id, ["write"], "tools-gated").finally(() => { toolSettled = true; });
  await toolGate.entered;
  let toolReadSettled = false;
  const readingTools = client.tools(created.id).finally(() => { toolReadSettled = true; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(runtime.toolMutationCalls, 1);
  assert.equal(toolSettled, false);
  assert.equal(toolReadSettled, false);
  toolGate.release();
  await changingTools;
  assert.deepEqual((await readingTools).tools.filter((tool) => tool.active).map((tool) => tool.name), ["write"]);

  let thinkingSettled = false;
  const changingThinking = client.setThinking(created.id, "high", "thinking-gated").finally(() => { thinkingSettled = true; });
  await thinkingGate.entered;
  assert.equal(runtime.thinkingMutationCalls, 1);
  assert.equal((await client.status(created.id)).executor.thinkingLevel, "off");
  assert.equal(thinkingSettled, false);
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "thinking.changed"), false);
  thinkingGate.release();
  assert.equal((await changingThinking).instance.executor.thinkingLevel, "high");
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "thinking.changed"), true);

  let settingSettled = false;
  const changingSetting = client.updateSetting(created.id, { key: "autoCompaction", value: false }, "setting-gated").finally(() => { settingSettled = true; });
  await settingGate.entered;
  let settingReadSettled = false;
  const readingSettings = client.settings(created.id).finally(() => { settingReadSettled = true; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(runtime.settingMutationCalls, 1);
  assert.equal(settingSettled, false);
  assert.equal(settingReadSettled, false);
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "settings.changed"), false);
  settingGate.release();
  await changingSetting;
  assert.equal((await readingSettings).settings.find((setting) => setting.key === "autoCompaction")?.value, false);
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "settings.changed"), true);
});

test("post-effect config failures retain operation IDs and suppress uncommitted events", async () => {
  const scenarios = ["tool", "thinking", "setting"] as const;
  for (const scenario of scenarios) {
    const port = new ScriptedCatalogCommitPort();
    port.failAt(2);
    const harness = await createTransactionHarness(port);
    const client = new DockClient({ socketPath: harness.socketPath });
    const created = await client.create(harness.directory, undefined, `create-${scenario}-fault`);
    const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
    const operationId = `${scenario}-catalog-failed`;
    if (scenario === "setting") {
      runtime.settingsFailure = new RuntimeSettingsWriteError("autoCompaction", "write", true, [{ scope: "global", message: "disk failed" }]);
    }
    const mutation = scenario === "tool"
      ? client.setActiveTools(created.id, ["write"], operationId)
      : scenario === "thinking"
        ? client.setThinking(created.id, "high", operationId)
        : client.updateSetting(created.id, { key: "autoCompaction", value: false }, operationId);
    await assert.rejects(
      mutation,
      (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === operationId,
    );
    await harness.host.waitForFatalCompletion();
    const events = harness.registry.get(created.id).eventsSince().events;
    if (scenario === "thinking") assert.equal(events.some((event) => event.type === "thinking.changed"), false);
    if (scenario === "setting") {
      assert.equal(events.some((event) => event.type === "settings.changed" || event.type === "settings.write_failed"), false);
      assert.equal((await runtime.getSettings()).find((setting) => setting.key === "autoCompaction")?.value, false);
    }
    await cleanupHarness(harness);
  }
});

test("explicit stop commits intent before cleanup and stopped state before response", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const intentGate = port.gateAt(2);
  const finalGate = port.gateAt(4);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-stop-gate");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const stopping = client.stop(created.id, "stop-gated");
  await intentGate.entered;
  assert.equal(runtime.abortCalls, 0);
  assert.equal(runtime.disposeCalls, 0);
  assert.equal(harness.registry.get(created.id).snapshot().lifecycle, "active");
  intentGate.release();
  await finalGate.entered;
  assert.equal(runtime.abortCalls, 1);
  assert.equal(runtime.disposeCalls, 1);
  assert.equal(harness.registry.get(created.id).snapshot().lifecycle, "stopping");
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "instance.stopped"), false);
  finalGate.release();
  const stopped = await stopping;
  assert.equal(stopped.instance.lifecycle, "stopped");
  assert.equal(harness.registry.get(created.id).eventsSince().events.some((event) => event.type === "instance.stopped"), true);
});

test("stop commit failures distinguish pre-cleanup rollback from post-cleanup ambiguity", async (context) => {
  const prePort = new ScriptedCatalogCommitPort();
  prePort.failAt(2);
  const preHarness = await createTransactionHarness(prePort);
  context.after(() => cleanupHarness(preHarness));
  const preClient = new DockClient({ socketPath: preHarness.socketPath });
  const preCreated = await preClient.create(preHarness.directory, undefined, "create-stop-pre-fault");
  const preRuntime = preHarness.sessions.get(preCreated.id) as DelayedRuntimeSession;
  await assert.rejects(
    preClient.stop(preCreated.id, "stop-pre-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "catalog_write_failed",
  );
  assert.equal(preRuntime.abortCalls, 0);
  assert.equal(preRuntime.disposeCalls, 0);
  assert.equal(preHarness.registry.get(preCreated.id).snapshot().lifecycle, "active");
  assert.equal(preHarness.registry.catalogHealth(), "healthy");

  const postPort = new ScriptedCatalogCommitPort();
  postPort.failAt(4);
  const postHarness = await createTransactionHarness(postPort);
  context.after(() => cleanupHarness(postHarness));
  const postClient = new DockClient({ socketPath: postHarness.socketPath });
  const postCreated = await postClient.create(postHarness.directory, undefined, "create-stop-post-fault");
  const postRuntime = postHarness.sessions.get(postCreated.id) as DelayedRuntimeSession;
  await assert.rejects(
    postClient.stop(postCreated.id, "stop-post-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "stop-post-failed",
  );
  await postHarness.host.waitForFatalCompletion();
  assert.equal(postRuntime.abortCalls, 1);
  assert.equal(postRuntime.disposeCalls, 1);
  assert.equal(postHarness.registry.get(postCreated.id).snapshot().lifecycle, "stopping");
  assert.equal(postHarness.registry.get(postCreated.id).eventsSince().events.some((event) => event.type === "instance.stopped"), false);
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
