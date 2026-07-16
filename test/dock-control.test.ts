import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";
import { ProjectTrustCoordinator } from "../src/control/project-trust.js";
import { ExtensionUiBroker } from "../src/core/extension-ui-broker.js";
import { ManagedInstance, type DockEvent } from "../src/core/managed-instance.js";
import { SETTING_KEYS } from "../src/core/config-projection.js";
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

  const capabilityError = await exchangeOne(socketPath, { ...base, requestId: "hello-2", versions: [2], requiredCapabilities: ["not-implemented.v1"] });
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
  assert.deepEqual(ack.capabilities, ["catalog.v1", "core.v2", "events.follow", "extension_ui.v1", "host.info", "instance.catalog", "models.v1", "queue.control.v1", "resources.v1", "run.abort.v1", "service.managed.v1", "session.commands.v1", "session.core", "session.reopen", "session.tree.v1", "settings.v1", "tools.v1", "tui.projection.v1"]);
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

test("session switch resolves target project trust before replacement effects", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-switch-trust-"));
  const targetCwd = join(directory, "target");
  await mkdir(targetCwd);
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedRuntimeSession | undefined;
  const trust = new ProjectTrustCoordinator({
    requiresTrust: (cwd) => cwd === targetCwd,
    savedDecision: () => null,
    defaultDecision: () => "ask",
    remember: () => assert.fail("trust_once must not write the trust store"),
  }, { createId: () => "switch-challenge", now: () => 1_000 });
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    runtime.sessionCatalog = [{ sessionId: "target-session", sessionFile: "/tmp/target-session.jsonl", cwd: targetCwd }];
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "switch-trust-instance", { trustPreflight: trust });
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, undefined, "create-op");

  let challenge: ControlClientError | undefined;
  try { await client.switchSession(created.id, "/tmp/target-session.jsonl", "switch-trust-op"); }
  catch (error) { assert.ok(error instanceof ControlClientError); challenge = error; }
  assert.equal(challenge?.code, "project_trust_required");
  assert.equal(challenge?.details?.challengeId, "switch-challenge");
  assert.equal(runtime?.sessionMutationCalls.switch, 0);
  assert.equal(registry.get(created.id).snapshot().runtimeGeneration, 1);

  const switched = await client.switchSession(created.id, "/tmp/target-session.jsonl", "switch-trust-op", { challengeId: "switch-challenge", decision: "trust_once" });
  assert.equal(switched.instance.cwd, targetCwd);
  assert.equal(switched.instance.runtimeGeneration, 2);
  assert.equal(runtime?.sessionMutationCalls.switch, 1);
});

test("extension UI lease round-trips dialogs and detach cancels fail closed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-ui-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-ui-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-ui");
  const liveEvents: DockEvent[] = [];
  let resolveRequested!: (event: Extract<DockEvent, { type: "interaction.requested" }>) => void;
  let requestedPromise = new Promise<Extract<DockEvent, { type: "interaction.requested" }>>((resolve) => { resolveRequested = resolve; });
  const controller = await client.streamEvents(instance.id, {
    claimController: true,
    requireTuiProjection: true,
    onEvent: (event) => {
      liveEvents.push(event);
      if (event.type === "interaction.requested") resolveRequested(event);
    },
  });
  assert.equal(controller.initial.controller.status, "acquired");
  if (controller.initial.controller.status !== "acquired") return;
  const leaseToken = controller.initial.controller.leaseToken;
  await assert.rejects(
    client.respondInteraction(instance.id, leaseToken, "not-sent", { method: "input", value: "A0+/".repeat(32) }, "binary-response"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_request",
  );
  await assert.rejects(
    client.respondInteraction(instance.id, leaseToken, "not-sent", { method: "editor", value: "x".repeat(256_001) }, "oversized-response"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_request",
  );

  const observer = await new DockClient({ socketPath }).streamEvents(instance.id, {
    claimController: true,
    onEvent: () => {},
  });
  assert.equal(observer.initial.controller.status, "unavailable");
  observer.close();
  await observer.done;

  const confirmed = broker.confirm("Delete?", "This cannot be undone");
  const requested = await requestedPromise;
  assert.equal(requested.data.method, "confirm");
  await assert.rejects(
    client.respondInteraction(instance.id, "wrong-lease", requested.data.interactionId, { method: "confirm", confirmed: true }),
    (error: unknown) => error instanceof ControlClientError && error.code === "interaction_wrong_lease",
  );
  assert.deepEqual(
    await client.respondInteraction(instance.id, leaseToken, requested.data.interactionId, { method: "confirm", confirmed: true }, "respond-1"),
    { interactionId: requested.data.interactionId, state: "resolved" },
  );
  assert.equal(await confirmed, true);
  assert.deepEqual(
    await client.respondInteraction(instance.id, leaseToken, requested.data.interactionId, { method: "confirm", confirmed: true }, "respond-2"),
    { interactionId: requested.data.interactionId, state: "already_resolved" },
  );

  requestedPromise = new Promise((resolve) => { resolveRequested = resolve; });
  const input = broker.input("Name", "optional");
  const inputRequest = await requestedPromise;
  assert.equal(inputRequest.data.method, "input");
  controller.close();
  await controller.done;
  assert.equal(await input, undefined);
  const replay = await client.events(instance.id);
  assert.equal(replay.page.events.some((event) => event.type === "interaction.cancelled" && event.data.interactionId === inputRequest.data.interactionId && event.data.reason === "detach"), true);
  assert.equal(await broker.confirm("No controller", "fail closed"), false);
  assert.ok(liveEvents.some((event) => event.type === "interaction.resolved"));
});

test("SSH TUI controller completes select confirm input and editor extension dialogs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-pty-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "dialog.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-pty-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-pty");
  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-dialogs", readyFile);
  await waitForPath(readyFile);

  assert.equal(await broker.select("Pick fixture", ["Alpha", "Beta"]), "Beta");
  assert.equal(await broker.confirm("Confirm fixture", "Proceed?"), true);
  assert.equal(await broker.input("Input fixture", "value"), "typed value");
  assert.equal(await broker.editor("Edit fixture", "prefilled editor value"), "prefilled editor value");

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["Pick fixture", "Confirm fixture", "Input fixture", "Edit fixture"]) assert.match(output, new RegExp(marker));
  assert.match(output, /connected\/acquired/);
});

test("SSH TUI reacquires its controller after runtime replacement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-extension-replacement-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const readyFile = join(directory, "replacement.ready");
  const broker = new ExtensionUiBroker();
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session, extensionUiBroker: broker });
  }, () => "extension-replacement-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const instance = await client.create(directory, "extension-replacement");
  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", instance.id,
  ], "extension-replacement", readyFile);
  await waitForPath(readyFile);

  const replacement = await client.newSession(instance.id);
  assert.equal(replacement.instance.runtimeGeneration, 2);
  let confirmed = false;
  const confirmationDeadline = Date.now() + 3_000;
  while (!confirmed && Date.now() < confirmationDeadline) {
    const attempt = broker.confirm("Post replacement confirm", "Controller lease was reacquired.");
    const outcome = await Promise.race([
      attempt.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolveDelay) => setTimeout(() => resolveDelay({ settled: false }), 30)),
    ]);
    if (!outcome.settled) confirmed = await attempt;
    else confirmed = outcome.value;
    if (!confirmed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.equal(confirmed, true);

  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  assert.match(output, /Post replacement confirm/);
  assert.match(output, /connected\/acquired/);
  assert.doesNotMatch(output, /Host event stream closed|connection lost/);
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

test("SSH TUI replays, resizes, handles input, and detaches without stopping", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-demo");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ]);
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.ok(pty.resizedBytes > 0, "SIGWINCH must produce a resized TUI frame");
  assert.match(output, /Alu Dock/);
  assert.match(output, /deterministic delayed task/);
  assert.match(output, /waiting for model/);
  const resizedFrame = lastFullRedrawFrame(output);
  assert.equal(resizedFrame.length, 18, `expected one fixed 18-row screen:\n${resizedFrame.join("\n")}`);
  assert.match(resizedFrame.at(-3) ?? "", /^─+$/u, "the editor bottom border must remain immediately above the two-row status dock");
  assert.match(resizedFrame.at(-2) ?? "", /waiting for model|running/u);
  assert.match(resizedFrame.at(-1) ?? "", /pty-demo/u);
  assert.match(output, /Detached from pty-demo/);
  assert.doesNotMatch(output, /data:image|;base64,/i);

  const afterDetach = await client.status(created.id);
  assert.equal(afterDetach.lifecycle, "active");
  assert.equal(afterDetach.execution, "running");
  assert.equal(runtime.abortCalls, 0);
  assert.equal(runtime.disposeCalls, 0);
});

test("SSH TUI editor preserves multiline paste and submitted history", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-editor");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "editor");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.deepEqual(runtime.promptMessages, [
    "deterministic delayed task",
    "first line\nsecond line",
    "first line\nsecond line",
  ]);
  assert.equal(runtime.disposeCalls, 0);
});

test("SSH TUI Alt+Up restores all pending text while Escape restores then aborts", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-queue");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  await client.prompt(created.id, "later follow-up", "followUp", "pty-follow-1");
  await client.prompt(created.id, "urgent steer", "steer", "pty-steer-1");
  const restoredPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "queue-restore");
  const restoredOutput = Buffer.from(restoredPty.output, "base64").toString("utf8");
  assert.equal(restoredPty.timedOut, false, restoredOutput.slice(-4_000));
  assert.equal(restoredPty.status, 0, restoredOutput.slice(-4_000));
  assert.match(restoredOutput, /1\. steer next · urgent steer/);
  assert.match(restoredOutput, /2\. follow-up · later follow-up/);
  assert.match(restoredOutput, /restored 2 queued messages/);
  assert.equal(runtime.abortCalls, 0);
  assert.equal(runtime.clearQueueCalls, 1);
  assert.equal((await client.status(created.id)).execution, "running");

  await client.prompt(created.id, "second follow-up", "followUp", "pty-follow-2");
  await client.prompt(created.id, "second steer", "steer", "pty-steer-2");
  const abortedPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "queue-abort");
  const abortedOutput = Buffer.from(abortedPty.output, "base64").toString("utf8");
  assert.equal(abortedPty.timedOut, false, abortedOutput.slice(-4_000));
  assert.equal(abortedPty.status, 0, abortedOutput.slice(-4_000));
  assert.match(abortedOutput, /Run aborted/);
  assert.equal(runtime.abortCalls, 1);
  assert.equal(runtime.clearQueueCalls, 2);
  const final = await client.status(created.id);
  assert.equal(final.execution, "idle");
  assert.equal(final.lastRun, "aborted");
  assert.equal(final.pending.total, 0);
});

test("SSH TUI model picker filters typed input and history viewport scroll-locks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-ux-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    runtime.history = Array.from({ length: 450 }, (_, index) => ({
      entryId: `history-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: [{ type: "text" as const, text: `historical line ${index}` }],
    }));
    runtime.history.push(
      {
        entryId: "history-tool-call",
        role: "assistant",
        content: [{ type: "toolCall", id: "history-tool", name: "read", arguments: { path: "/tmp/demo" } }],
      },
      {
        entryId: "history-tool-result",
        role: "tool",
        toolCallId: "history-tool",
        toolName: "read",
        isError: false,
        content: "expanded tool detail\nsecond detail line",
      },
    );
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-ux-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-ux");

  const modelPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "model-search");
  const modelOutput = Buffer.from(modelPty.output, "base64").toString("utf8");
  assert.equal(modelPty.timedOut, false, modelOutput.slice(-4_000));
  assert.equal(modelPty.status, 0, modelOutput.slice(-4_000));
  assert.match(modelOutput, /Search:/);
  assert.equal(runtime?.modelMutationCalls, 1);
  assert.deepEqual(runtime?.getModelState().model, { provider: "fixture", id: "local" });

  const scrollReady = join(directory, "scroll.ready");
  const scrollRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "scroll", scrollReady);
  await waitForPath(`${scrollReady}.locked`);
  await client.prompt(created.id, "new output while history is locked");
  const scrollPty = await scrollRun;
  const scrollOutput = Buffer.from(scrollPty.output, "base64").toString("utf8");
  assert.equal(scrollPty.timedOut, false, scrollOutput.slice(-4_000));
  assert.equal(scrollPty.status, 0, scrollOutput.slice(-4_000));
  assert.match(scrollOutput, /history paused/);
  assert.match(scrollOutput, /new output/);
  await client.abort(created.id);

  const historyPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "history-page");
  const historyOutput = Buffer.from(historyPty.output, "base64").toString("utf8");
  assert.equal(historyPty.timedOut, false, historyOutput.slice(-4_000));
  assert.equal(historyPty.status, 0, historyOutput.slice(-4_000));
  assert.match(historyOutput, /historical line 0/, "reverse pagination must reach beyond the recent 200-entry tail");
  assert.ok(historyOutput.includes("\u001b[?1000h\u001b[?1006h"), "TUI must enable paired mouse tracking");
  assert.ok(historyOutput.includes("\u001b[?1006l\u001b[?1000l"), "TUI must restore terminal mouse tracking on detach");

  const toolPty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "tool-fold");
  const toolOutput = Buffer.from(toolPty.output, "base64").toString("utf8");
  assert.equal(toolPty.timedOut, false, toolOutput.slice(-4_000));
  assert.equal(toolPty.status, 0, toolOutput.slice(-4_000));
  assert.match(toolOutput, /Alt\+O detail/);
  assert.match(toolOutput, /expanded tool detail/);
  assert.equal(runtime?.disposeCalls, 0);
});

test("SSH TUI Stage 3 commands mutate Host-owned settings tools and sessions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-stage3-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    runtime.sessionCatalog = [{ sessionId: "pty-resume", sessionFile: "/tmp/pty-resume.jsonl", name: "PTY resumed", cwd: directory }];
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-stage3-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-stage3");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "stage3");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["autoRetry = false", "Active tools: read, write", "Session name: PTY Stage 3", "Compacted 123 tokens", "Resources reloaded", "Session new", "Session resume"]) assert.match(output, new RegExp(marker));
  assert.equal(runtime?.settingMutationCalls, 1);
  assert.equal(runtime?.toolMutationCalls, 1);
  assert.deepEqual(runtime?.sessionMutationCalls, { new: 1, switch: 1, name: 1, compact: 1, reload: 1, navigate: 0, fork: 0, clone: 0 });
  const final = await client.status(created.id);
  assert.equal(final.runtimeGeneration, 4);
  assert.equal(final.name, "PTY resumed");
  assert.equal(runtime?.disposeCalls, 0);
});

test("SSH TUI Stage 6 navigates, returns fork text to the editor, and clones the current leaf", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-pty-stage6-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let runtime: DelayedRuntimeSession | undefined;
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => {
    runtime = new DelayedRuntimeSession(`pi-${id}`);
    runtime.treeNodes = [
      { entryId: "tree-u1", depth: 0, kind: "message", role: "user", summary: "first prompt", hasChildren: true },
      { entryId: "tree-a1", parentId: "tree-u1", depth: 1, kind: "message", role: "assistant", summary: "first answer", hasChildren: true },
      { entryId: "tree-u2", parentId: "tree-a1", depth: 2, kind: "message", role: "user", summary: "second prompt", hasChildren: true },
      { entryId: "tree-a2", parentId: "tree-u2", depth: 3, kind: "message", role: "assistant", summary: "second answer", hasChildren: false },
    ];
    runtime.treeLeafId = "tree-a2";
    return new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime });
  }, () => "pty-stage6-instance");
  const host = new DockHost({ socketPath, registry });
  context.after(async () => { await host.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(directory, "pty-stage6");

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", socketPath,
    "attach", created.id,
  ], "stage6");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-4_000));
  assert.equal(pty.status, 0, output.slice(-4_000));
  for (const marker of ["Session branch selected", "generation 2", "generation 3"]) assert.match(output, new RegExp(marker));
  assert.equal(runtime?.sessionMutationCalls.navigate, 1);
  assert.equal(runtime?.sessionMutationCalls.fork, 1);
  assert.equal(runtime?.sessionMutationCalls.clone, 1);
  const final = await client.status(created.id);
  assert.equal(final.runtimeGeneration, 3);
  assert.equal(final.lastRun, "never");
  assert.equal(runtime?.promptCalls, 0);
  assert.equal(runtime?.disposeCalls, 0);
});

test("SSH TUI Ctrl+C aborts a run while preserving the reusable instance", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-abort");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  const pty = await runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "abort");
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.match(output, /Run aborted/);

  const afterDetach = await client.status(created.id);
  assert.equal(afterDetach.lifecycle, "active");
  assert.equal(afterDetach.execution, "idle");
  assert.equal(afterDetach.lastRun, "aborted");
  assert.equal(runtime.abortCalls, 1);
  assert.equal(runtime.disposeCalls, 0);
});

test("SSH TUI reports transport loss read-only and never replays the running command", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "pty-host-loss");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const readyFile = join(harness.directory, "pty.ready");

  const ptyRun = runPtyTui([
    process.execPath,
    join(process.cwd(), "dist/src/cli.js"),
    "--socket", harness.socketPath,
    "attach", created.id,
  ], "transport-close", readyFile);
  await waitForPath(readyFile);
  await harness.host.stop();
  const pty = await ptyRun;
  const output = Buffer.from(pty.output, "base64").toString("utf8");
  assert.equal(pty.timedOut, false, output.slice(-2_000));
  assert.equal(pty.status, 0, output.slice(-2_000));
  assert.match(output, /Host connection lost/);
  assert.match(output, /replayed; this TUI is now read-only/);
  assert.match(output, /Detached from pty-host-loss/);

  const conservative = harness.registry.get(created.id).snapshot();
  assert.equal(conservative.lifecycle, "active");
  assert.equal(conservative.execution, "running");
  assert.equal(runtime.promptCalls, 1);
  assert.equal(runtime.disposeCalls, 1);
});

test("a second client can steer, queue follow-up, and stop idempotently", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const creator = new DockClient({ socketPath: harness.socketPath });
  const created = await creator.create(harness.directory);
  const controller = new DockClient({ socketPath: harness.socketPath });

  const steer = await controller.prompt(created.id, "change direction", "auto", "steer-op");
  assert.equal(steer.receipt.delivery, "steer");
  assert.equal(steer.receipt.queued, true);
  assert.equal(steer.instance.pending.steering, 1);

  const followUp = await controller.prompt(created.id, "then summarize", "followUp", "follow-op");
  assert.equal(followUp.receipt.delivery, "followUp");
  assert.equal(followUp.receipt.queued, true);
  assert.equal(followUp.instance.pending.followUp, 1);

  await assert.rejects(
    controller.prompt(created.id, "parallel", "prompt"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_delivery",
  );

  const pendingAttach = await controller.streamEvents(created.id, { onEvent: () => {} });
  assert.deepEqual(pendingAttach.initial.pendingMessages.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "steer-op", delivery: "steer", text: "change direction" },
    { operationId: "follow-op", delivery: "followUp", text: "then summarize" },
  ]);
  pendingAttach.close();
  await pendingAttach.done;

  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  assert.equal(runtime.consumeNextQueued(), "change direction");
  const afterConsume = await controller.streamEvents(created.id, { onEvent: () => {} });
  assert.deepEqual(afterConsume.initial.pendingMessages.map((item) => item.operationId), ["follow-op"]);
  assert.ok(afterConsume.initial.page.events.some((event) => event.type === "message.submitted" && event.data.operationId === "steer-op"));
  afterConsume.close();
  await afterConsume.done;

  const dequeued = await controller.dequeue(created.id, "dequeue-op");
  const duplicateDequeue = await controller.dequeue(created.id, "dequeue-op");
  assert.deepEqual(duplicateDequeue, dequeued);
  assert.deepEqual(dequeued.receipt.restored.map((item) => ({ operationId: item.operationId, delivery: item.delivery, text: item.text })), [
    { operationId: "follow-op", delivery: "followUp", text: "then summarize" },
  ]);
  assert.equal(dequeued.instance.execution, "running");
  assert.equal(runtime.abortCalls, 0);

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

test("manual compaction aborts a running model command without stealing its run operation ID", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "compact-running");
  const originalCommandId = created.activeCommandId;
  assert.ok(originalCommandId);

  const compacted = await client.compactSession(created.id, undefined, "manual-compact-op");
  assert.equal(compacted.instance.execution, "idle");
  assert.equal(compacted.instance.lastRun, "aborted");
  const events = (await client.events(created.id)).page.events;
  const settled = events.find((event) => event.type === "run.settled");
  assert.equal(settled?.type === "run.settled" ? settled.data.operationId : undefined, originalCommandId);
  assert.ok(events.some((event) => event.type === "compaction.completed"));
});

test("abort is operation-deduplicated and keeps the instance reusable", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "abortable");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;

  const aborted = await client.abort(created.id, "abort-once");
  const duplicate = await client.abort(created.id, "abort-once");
  assert.deepEqual(duplicate, aborted);
  assert.equal(runtime.abortCalls, 1);
  assert.equal(runtime.disposeCalls, 0);
  assert.equal(aborted.instance.lifecycle, "active");
  assert.equal(aborted.instance.execution, "idle");
  assert.equal(aborted.instance.lastRun, "aborted");

  const restarted = await client.prompt(created.id, "new work", "prompt", "after-abort");
  assert.equal(restarted.instance.execution, "running");
});

test("abort runtime ambiguity stays operation-scoped without faulting the catalog", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "abort-error");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  runtime.abortError = new Error("AUTH_TOKEN_very_secret");

  await assert.rejects(
    client.abort(created.id, "abort-runtime-unknown"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "abort-runtime-unknown"
      && !error.message.includes("AUTH_TOKEN"),
  );
  assert.equal((await client.hostInfo()).state, "ready");
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

  await firstClient.prompt(firstInstance.id, "queued once", "steer", "queued-command");
  const [firstDequeue, duplicateDequeue] = await Promise.all([
    firstClient.dequeue(firstInstance.id, "shared-dequeue"),
    secondClient.dequeue(firstInstance.id, "shared-dequeue"),
  ]);
  assert.deepEqual(duplicateDequeue, firstDequeue);
  assert.equal(firstDequeue.receipt.restored[0]?.text, "queued once");
  assert.equal(session.clearQueueCalls, 1);

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

test("tui projection exposes stable paged history and attach history without binary payloads", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "history");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  runtime.history = [
    { entryId: "h1", timestamp: "2020-01-01T00:00:00.000Z", role: "user", content: "older question" },
    { entryId: "h2", parentId: "h1", timestamp: "2020-01-01T00:00:01.000Z", role: "assistant", content: [{ type: "thinking", text: "plan" }, { type: "text", text: "older answer" }], stopReason: "stop" },
    { entryId: "h3", parentId: "h2", timestamp: "2020-01-01T00:00:02.000Z", role: "toolResult", toolCallId: "tool-h3", toolName: "show_image", isError: false, content: [{ type: "text", text: "data:image/png;base64,AAAA" }] },
  ];
  runtime.emit({ type: "entry_appended", entry: { id: "h3" } });
  const immediate = await harness.registry.get(created.id).getHistoryPage(undefined, 2);
  assert.deepEqual(immediate.entries.map((entry) => entry.entryId), ["h2", "h3"]);

  const latest = await client.history(created.id, undefined, 2);
  assert.deepEqual(latest.entries.map((entry) => entry.entryId), ["h2", "h3"]);
  assert.equal(latest.hasEarlier, true);
  assert.equal(latest.nextBeforeEntryId, "h2");
  assert.equal(JSON.stringify(latest).includes("data:image"), false);
  const earlier = await client.history(created.id, latest.nextBeforeEntryId, 2);
  assert.deepEqual(earlier.entries.map((entry) => entry.entryId), ["h1"]);
  assert.equal(earlier.hasEarlier, false);
  await assert.rejects(
    client.history(created.id, "not-on-branch", 2),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );

  const attached = await client.events(created.id);
  assert.deepEqual(attached.page.events.length > 0, true);
  const attachResult = await client.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true });
  assert.deepEqual(attachResult.initial.recentHistory.map((entry) => entry.entryId), ["h1", "h2", "h3"]);
  attachResult.close();
  await attachResult.done;

  runtime.history = Array.from({ length: 200 }, (_, index) => ({
    entryId: `large-${index}`,
    timestamp: `2020-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    role: "user",
    content: "x".repeat(8_000),
  }));
  runtime.emit({ type: "entry_appended", entry: { id: "large-199" } });
  const bounded = await client.streamEvents(created.id, { onEvent: () => {}, requireTuiProjection: true });
  assert.equal(bounded.initial.historyTruncated, true);
  assert.ok(bounded.initial.recentHistory.length > 0 && bounded.initial.recentHistory.length < 200);
  assert.ok(bounded.initial.page.events.length > 0, "paged history must be trimmed before recent events");
  bounded.close();
  await bounded.done;
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

test("session.tree.v1 paginates revisions, navigates in-file, and replaces on fork/clone", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "tree-create");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  runtime.treeNodes = [
    { entryId: "tree-u1", depth: 0, kind: "message", role: "user", timestamp: "2026-07-14T00:00:00.000Z", summary: "first prompt", hasChildren: true },
    { entryId: "tree-a1", parentId: "tree-u1", depth: 1, kind: "message", role: "assistant", timestamp: "2026-07-14T00:00:01.000Z", summary: "first answer", hasChildren: true },
    { entryId: "tree-u2", parentId: "tree-a1", depth: 2, kind: "message", role: "user", timestamp: "2026-07-14T00:00:02.000Z", summary: "second prompt", hasChildren: true },
    { entryId: "tree-a2", parentId: "tree-u2", depth: 3, kind: "message", role: "assistant", timestamp: "2026-07-14T00:00:03.000Z", summary: "second answer", hasChildren: false },
  ];
  runtime.treeLeafId = "tree-a2";

  const first = await client.tree(created.id, undefined, undefined, 2);
  assert.deepEqual(first.nodes.map((node) => node.entryId), ["tree-u1", "tree-a1"]);
  assert.equal(first.total, 4);
  assert.equal(first.truncated, true);
  assert.equal(first.nextAfterEntryId, "tree-a1");
  const second = await client.tree(created.id, first.treeRevision, first.nextAfterEntryId, 2);
  assert.deepEqual(second.nodes.map((node) => node.entryId), ["tree-u2", "tree-a2"]);
  assert.equal(second.truncated, false);

  const commitsBeforeInvalidTargets = port.calls.length;
  await assert.rejects(
    client.navigateSession(created.id, "missing-entry", {}, "navigate-missing"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );
  await assert.rejects(
    client.forkSession(created.id, "tree-a1", "fork-assistant"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );
  assert.equal(runtime.sessionMutationCalls.navigate, 0);
  assert.equal(runtime.sessionMutationCalls.fork, 0);
  assert.equal(port.calls.length, commitsBeforeInvalidTargets);

  const blockedNavigation = runtime.blockNextNavigation();
  const pendingNavigation = client.navigateSession(created.id, "tree-a2", { summarize: true }, "navigate-aborted");
  await blockedNavigation.entered;
  await assert.rejects(
    client.navigateSession(created.id, "tree-u1", {}, "navigate-concurrent"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_busy",
  );
  const abortNavigation = client.abort(created.id, "abort-navigation");
  const [abortedNavigation, abortReceipt] = await Promise.all([pendingNavigation, abortNavigation]);
  assert.equal(abortedNavigation.cancelled, true);
  assert.equal(abortedNavigation.aborted, true);
  assert.equal(abortReceipt.instance.execution, "idle");
  assert.equal(runtime.treeLeafId, "tree-a2");
  assert.equal(port.calls.length, commitsBeforeInvalidTargets);
  assert.equal((await client.events(created.id)).page.events.some((event) => event.type === "session.navigated"), false);

  const beforeFile = created.executor.sessionFile;
  const navigated = await client.navigateSession(created.id, "tree-u2", {}, "navigate-tree");
  assert.equal(navigated.cancelled, false);
  assert.equal(navigated.editorText, "second prompt");
  assert.equal(navigated.instance.runtimeGeneration, 1);
  assert.equal(navigated.instance.executor.sessionFile, beforeFile);
  assert.equal(runtime.treeLeafId, "tree-a1");
  await assert.rejects(
    client.tree(created.id, first.treeRevision, first.nextAfterEntryId, 2),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );
  assert.equal((await client.events(created.id)).page.events.some((event) => event.type === "session.navigated" && event.data.targetId === "tree-u2"), true);

  const forked = await client.forkSession(created.id, "tree-u2", "fork-tree");
  assert.equal(forked.cancelled, false);
  assert.equal(forked.selectedText, "second prompt");
  assert.equal(forked.instance.runtimeGeneration, 2);
  assert.notEqual(forked.instance.executor.sessionFile, beforeFile);
  assert.equal(runtime.sessionMutationCalls.fork, 1);
  assert.equal(port.calls.some((call) => call.context.kind === "session.fork.intent" && call.candidate.instances[0]?.replacement?.requestedEntryId === "tree-u2"), true);

  const cloned = await client.cloneSession(created.id, "tree-a1", "clone-tree");
  assert.equal(cloned.cancelled, false);
  assert.equal(cloned.instance.runtimeGeneration, 3);
  assert.equal(runtime.sessionMutationCalls.clone, 1);
  assert.equal(port.calls.some((call) => call.context.kind === "session.clone.intent" && call.candidate.instances[0]?.replacement?.requestedEntryId === "tree-a1"), true);
  await assert.rejects(
    client.cloneSession(created.id, "tree-u1", "clone-wrong-leaf"),
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_cursor",
  );

  const duplicate = await client.cloneSession(created.id, "tree-a1", "clone-tree");
  assert.equal(duplicate.instance.runtimeGeneration, 3);
  assert.equal(runtime.sessionMutationCalls.clone, 1);
});

test("session.commands.v1 names, compacts, replaces, reloads, and deduplicates mutations", async (context) => {
  const harness = await createTransactionHarness(new ScriptedCatalogCommitPort());
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "session-create");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  runtime.sessionCatalog = [{ sessionId: "resume-target", sessionFile: "/tmp/resume-target.jsonl", name: "Resumed", cwd: harness.directory }];
  await client.prompt(created.id, "finish old session", "prompt", "old-session-run");
  runtime.settle("finished");
  await harness.registry.get(created.id).waitForIdle();
  assert.equal((await client.status(created.id)).lastRun, "succeeded");

  const named = await client.nameSession(created.id, "Daily work", "name-op");
  assert.equal(named.instance.name, "Daily work");
  const duplicateName = await client.nameSession(created.id, "Daily work", "name-op");
  assert.equal(duplicateName.instance.name, "Daily work");
  assert.equal(runtime.sessionMutationCalls.name, 1);

  const compacted = await client.compactSession(created.id, "keep decisions", "compact-op");
  assert.deepEqual(compacted.result, { summary: "fixture summary", firstKeptEntryId: "kept-1", tokensBefore: 123 });
  assert.equal(compacted.instance.execution, "idle");

  const fresh = await client.newSession(created.id, undefined, "new-op");
  assert.equal(fresh.cancelled, false);
  assert.equal(fresh.instance.runtimeGeneration, 2);
  assert.equal(fresh.instance.name, undefined);
  assert.equal(fresh.instance.lastRun, "never");

  const resumed = await client.switchSession(created.id, "/tmp/resume-target.jsonl", "switch-op");
  assert.equal(resumed.cancelled, false);
  assert.equal(resumed.instance.runtimeGeneration, 3);
  assert.equal(resumed.instance.cwd, harness.directory);
  assert.equal(resumed.instance.name, "Resumed");

  const reloaded = await client.reloadSession(created.id, "reload-op");
  assert.equal(reloaded.instance.runtimeGeneration, 4);
  assert.equal(reloaded.resources[0]?.name, "AGENTS.md");
  assert.equal(reloaded.diagnostics[0]?.message, "fixture diagnostic");
  assert.deepEqual(runtime.sessionMutationCalls, { new: 1, switch: 1, name: 1, compact: 1, reload: 1, navigate: 0, fork: 0, clone: 0 });

  await assert.rejects(
    client.reloadSession(created.id, "name-op"),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
  );
});

test("session command runtime ambiguity is operation-scoped and queryable", async (context) => {
  const harness = await createTransactionHarness(new ScriptedCatalogCommitPort());
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "ambiguous-session-create");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  runtime.sessionMutationError = new Error("SECRET_compaction_failure");

  await assert.rejects(
    client.compactSession(created.id, undefined, "ambiguous-compact"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "ambiguous-compact"
      && !error.message.includes("SECRET"),
  );
  assert.equal((await client.status(created.id)).execution, "idle");
  assert.equal((await client.hostInfo()).state, "ready");
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

test("real Host streams reset sequence ordering at a replacement generation", async (context) => {
  const harness = await createHarness();
  context.after(() => cleanupHarness(harness));
  await harness.host.start();
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, "rollover");
  const runtime = harness.sessions.get(created.id) as DelayedRuntimeSession;
  const seen: DockEvent[] = [];
  let resolveSeen!: () => void;
  const twoEvents = new Promise<void>((resolve) => { resolveSeen = resolve; });
  const subscription = await client.streamEvents(created.id, {
    since: created.eventCursor,
    onEvent: (liveEvent) => {
      seen.push(liveEvent);
      if (seen.length === 2) resolveSeen();
    },
  });

  runtime.emit({ type: "dock_session_replaced", reason: "reload", previousSessionFile: runtime.sessionFile, sessionFile: runtime.sessionFile, cwd: harness.directory });
  runtime.emit({ type: "dock_extension_error", error: "after replacement" });
  await twoEvents;

  assert.deepEqual(seen.map((liveEvent) => [liveEvent.type, liveEvent.runtimeGeneration, liveEvent.sequence]), [
    ["session.replaced", 2, 1],
    ["extension.error", 2, 2],
  ]);
  subscription.close();
  await subscription.done;
});

test("stream callbacks follow initial response order and accept one-step replacement generations", async (context) => {
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
        const live = { scope: "instance", sequence: 2, instanceId: "instance-1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:01.000Z", type: "extension.error", data: { error: "live" } };
        const replaced = { scope: "instance", sequence: 1, instanceId: "instance-1", runtimeGeneration: 2, occurredAt: "2026-07-14T00:00:02.000Z", type: "session.replaced", data: { reason: "reload", runtimeGeneration: 2, sessionFile: "/tmp/pi-2.jsonl", cwd: "/tmp/reloaded", piSessionId: "pi-2" } };
        const afterReplacement = { scope: "instance", sequence: 2, instanceId: "instance-1", runtimeGeneration: 2, occurredAt: "2026-07-14T00:00:03.000Z", type: "extension.error", data: { error: "after replacement" } };
        socket.write(encodeJsonLine({
          kind: "response", version: 2, requestId: "fixed", hostEpoch: "epoch-1", ok: true,
          result: { instance: snapshot, page: { events: [], earliest: cursor, latest: cursor, truncated: false, epochChanged: false, generationChanged: false }, recentHistory: [], historyTruncated: true, pendingMessages: [], controller: { status: "observing" }, following: true },
        })
          + encodeJsonLine({ kind: "event", version: 2, requestId: "fixed", hostEpoch: "epoch-1", event: live })
          + encodeJsonLine({ kind: "event", version: 2, requestId: "fixed", hostEpoch: "epoch-1", event: replaced })
          + encodeJsonLine({ kind: "event", version: 2, requestId: "fixed", hostEpoch: "epoch-1", event: afterReplacement }));
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
    onEvent: (liveEvent) => order.push(liveEvent.type),
  });
  order.push("initial");
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(order, ["initial", "extension.error", "session.replaced", "extension.error"]);
  subscription.close();
  await subscription.done;
});

test("TUI projection capability is required before the attach request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-tui-capability-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  let businessRequests = 0;
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.kind !== "hello") { businessRequests += 1; continue; }
        socket.write(encodeJsonLine({
          kind: "hello_ack", requestId: "fixed", version: 2,
          host: { pid: 1, dockVersion: "0.1.0", piSdkVersion: "0.80.6", hostEpoch: "epoch-1", startedAt: "2026-07-14T00:00:00.000Z" },
          catalogSchemaVersion: 1,
          capabilities: ["core.v2", "events.follow", "run.abort.v1"],
          limits: { maxLineBytes: 1048576, maxPromptChars: 256000, maxReplayEvents: 1000, maxHistoryItems: 200 },
        }));
      }
    });
  });
  await listen(server, socketPath);
  context.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });

  const client = new DockClient({ socketPath, requestId: () => "fixed" });
  await assert.rejects(
    client.streamEvents("instance-1", { onEvent: () => {}, requireTuiProjection: true }),
    (error: unknown) => error instanceof ControlClientError && error.code === "protocol_incompatible",
  );
  assert.equal(businessRequests, 0);
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
  assert.equal(settings.settings.length, SETTING_KEYS.length);
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
  assert.deepEqual((await client.commands(instance.id, "chain")).commands.map((command) => command.name), ["chain", "chain-prompts"]);
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

test("abort settled commit failure is operation-scoped and keeps conservative running state", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-abort-fault");
  await client.prompt(created.id, "running", "prompt", "run-before-abort-fault");
  port.failAt(5);

  await assert.rejects(
    client.abort(created.id, "abort-catalog-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "abort-catalog-failed",
  );
  const conservative = harness.registry.get(created.id).snapshot();
  assert.equal(conservative.execution, "running");
  assert.equal(conservative.activeCommandId, "run-before-abort-fault");
  await harness.host.waitForFatalCompletion();
});

test("queue and settled commit faults retain the last conservative committed state", async (context) => {
  const dequeuePort = new ScriptedCatalogCommitPort();
  const dequeueHarness = await createTransactionHarness(dequeuePort);
  context.after(() => cleanupHarness(dequeueHarness));
  const dequeueClient = new DockClient({ socketPath: dequeueHarness.socketPath });
  const dequeueInstance = await dequeueClient.create(dequeueHarness.directory, undefined, "create-dequeue-fault");
  await dequeueClient.prompt(dequeueInstance.id, "running", "prompt", "run-before-dequeue-fault");
  await dequeueClient.prompt(dequeueInstance.id, "queued", "steer", "queue-before-dequeue-fault");
  dequeuePort.failAt(8);
  await assert.rejects(
    dequeueClient.dequeue(dequeueInstance.id, "dequeue-failed"),
    (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown" && error.operationId === "dequeue-failed",
  );
  const dequeueSnapshot = dequeueHarness.registry.get(dequeueInstance.id).snapshot();
  assert.equal(dequeueSnapshot.execution, "running");
  assert.equal(dequeueSnapshot.pending.total, 1);
  assert.equal(dequeueHarness.registry.get(dequeueInstance.id).eventsSince().events.some((event) => event.type === "queue.cleared" && event.data.reason === "dequeued"), false);
  await dequeueHarness.host.waitForFatalCompletion();

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

test("attach and history expose committed active facts during a gated stop intent", async (context) => {
  const port = new ScriptedCatalogCommitPort();
  const stopIntentGate = port.gateAt(2);
  const harness = await createTransactionHarness(port);
  context.after(() => cleanupHarness(harness));
  const client = new DockClient({ socketPath: harness.socketPath });
  const created = await client.create(harness.directory, undefined, "create-stop-read-gate");
  const stopping = client.stop(created.id, "stop-read-gated");
  await stopIntentGate.entered;

  const managed = harness.registry.get(created.id);
  assert.equal(managed.snapshot().lifecycle, "active");
  assert.equal((await managed.getAttachProjection(undefined)).instance.lifecycle, "active");
  assert.equal((await managed.getHistoryPage(undefined, 20)).instance.lifecycle, "active");

  stopIntentGate.release();
  assert.equal((await stopping).instance.lifecycle, "stopped");
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

interface PtyTuiResult {
  status: number;
  timedOut: boolean;
  resizedBytes: number;
  output: string;
}

async function runPtyTui(
  command: string[],
  action: "detach" | "editor" | "abort" | "queue-restore" | "queue-abort" | "transport-close" | "stage3" | "stage6" | "model-search" | "scroll" | "history-page" | "tool-fold" | "extension-dialogs" | "extension-replacement" = "detach",
  readyFile?: string,
): Promise<PtyTuiResult> {
  return new Promise((resolveRun, rejectRun) => {
    const driver = join(process.cwd(), "test/fixtures/pty-tui-driver.py");
    const child = spawn("python3", [driver, ...command], {
      cwd: process.cwd(),
      env: { ...process.env, ALU_DOCK_PTY_ACTION: action, ...(readyFile ? { ALU_DOCK_PTY_READY_FILE: readyFile } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectRun(new Error(`PTY driver failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<PtyTuiResult>;
        assert.equal(typeof parsed.status, "number");
        assert.equal(typeof parsed.timedOut, "boolean");
        assert.equal(typeof parsed.resizedBytes, "number");
        assert.equal(typeof parsed.output, "string");
        resolveRun(parsed as PtyTuiResult);
      } catch (error) {
        rejectRun(new Error(`Invalid PTY driver result: ${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`, { cause: error }));
      }
    });
  });
}

function lastFullRedrawFrame(output: string): string[] {
  const marker = "\u001b[2J\u001b[H\u001b[3J";
  const start = output.lastIndexOf(marker);
  assert.ok(start >= 0, "expected a full redraw after PTY resize");
  const bodyStart = start + marker.length;
  const syncEnd = output.indexOf("\u001b[?2026l", bodyStart);
  assert.ok(syncEnd >= 0, "expected synchronized redraw terminator");
  const plain = output.slice(bodyStart, syncEnd)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
  const lines = plain.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await lstat(path); return; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

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
