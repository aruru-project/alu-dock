import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { encodeJsonLine } from "../src/control/json-lines.js";
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
  const registry = new DockRegistry(async ({ id, cwd, name }) => {
    const session = new DelayedRuntimeSession(`pi-${id}`);
    sessions.set(id, session);
    const instance = new ManagedInstance({ id, cwd, name, session, eventCapacity: 500 });
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

  const initial = await clientB.events(created.id, 0);
  assert.ok(initial.page.events.some((event) => event.type === "command.accepted"));
  const cursor = initial.page.latestSequence;

  harness.sessions.get(created.id)?.settle("fake done");
  await harness.registry.get(created.id).waitForIdle();
  const replay = await clientB.events(created.id, cursor);
  assert.ok(replay.page.events.some((event) => event.type === "run.settled"));
  assert.equal(replay.instance.lastRun, "succeeded");

  let resolveLiveEvent!: (type: string) => void;
  const liveEvent = new Promise<string>((resolveEvent) => { resolveLiveEvent = resolveEvent; });
  const live = await clientB.streamEvents(created.id, {
    since: replay.page.latestSequence,
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
    since: 10_000,
    onEvent: (event) => futureEvents.push(event.type),
  });
  harness.registry.get(created.id).recordExtensionError("below future cursor");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  future.close();
  await future.done;
  assert.deepEqual(futureEvents, []);

  for (let index = 0; index < 200; index += 1) {
    harness.registry.get(created.id).recordExtensionError("x".repeat(8_000));
  }
  const boundedReplay = await clientB.events(created.id, 0);
  assert.equal(boundedReplay.page.truncated, true);
  assert.ok(boundedReplay.page.events.length < 200);
  assert.equal(boundedReplay.page.latestSequence, harness.registry.get(created.id).snapshot().latestEventSequence);

  await harness.host.stop();
  assert.equal(harness.registry.get(created.id).snapshot().lifecycle, "stopped");
  await assert.rejects(lstat(harness.socketPath), { code: "ENOENT" });
  await assert.rejects(harness.host.start(), /Cannot start a host that is stopped/);
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
  const registry = new DockRegistry(async ({ id, cwd }) => {
    factoryEntered();
    await release;
    created = new ManagedInstance({ id, cwd, session: new DelayedRuntimeSession(`pi-${id}`) });
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
  assert.equal(ping.protocolVersion, 1);
  await contender.stop();
  assert.equal((await new DockClient({ socketPath: harness.socketPath }).ping()).protocolVersion, 1);
});

test("concurrent host objects do not unlink the winning listener", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-host-race-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "dock.sock");
  const createRegistry = (): DockRegistry => new DockRegistry(async ({ id, cwd }) => (
    new ManagedInstance({ id, cwd, session: new DelayedRuntimeSession(`pi-${id}`) })
  ));
  const first = new DockHost({ socketPath, registry: createRegistry() });
  const second = new DockHost({ socketPath, registry: createRegistry() });

  const starts = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(starts.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await new DockClient({ socketPath }).ping()).protocolVersion, 1);

  await Promise.all([first.stop(), second.stop()]);
});

test("host rejects a socket directory accessible by other users", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-insecure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const registry = new DockRegistry(async ({ id, cwd }) => (
    new ManagedInstance({ id, cwd, session: new DelayedRuntimeSession(`pi-${id}`) })
  ));
  const host = new DockHost({ socketPath: join(directory, "dock.sock"), registry });

  await assert.rejects(host.start(), /must not grant group\/other access/);
});

test("stream callbacks follow the initial result even when frames share one chunk", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-frame-order-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "dock.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      const snapshot = {
        id: "instance-1",
        cwd: directory,
        lifecycle: "active",
        execution: "running",
        lastRun: "never",
        pending: { steering: 0, followUp: 0, total: 0 },
        executor: { kind: "fake", piSessionId: "pi-1" },
        activeCommandId: "command-1",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        latestEventSequence: 1,
      };
      const event = {
        sequence: 2,
        instanceId: "instance-1",
        occurredAt: "2026-07-14T00:00:01.000Z",
        type: "extension.error",
        data: { error: "live" },
      };
      socket.write(
        encodeJsonLine({
          kind: "response",
          version: 1,
          requestId: "fixed",
          ok: true,
          result: {
            instance: snapshot,
            page: { events: [], earliestSequence: 1, latestSequence: 1, truncated: false },
            following: true,
          },
        }) + encodeJsonLine({ kind: "event", version: 1, requestId: "fixed", event }),
      );
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

test("client converts malformed host responses into ControlClientError", async (context) => {
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
    (error: unknown) => error instanceof ControlClientError && error.code === "invalid_response",
  );
});

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
