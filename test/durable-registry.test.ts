import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import {
  CatalogOperationRecordedError,
  DockRegistry,
  InstanceUnavailableError,
  type InstanceFactoryInput,
} from "../src/control/dock-registry.js";
import { CatalogWriteError } from "../src/core/catalog.js";
import { InstanceBusyError, ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedRuntimeSession } from "./support/delayed-runtime-session.js";

async function fixturePath(): Promise<{ cwd: string; catalogPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-registry-"));
  return { cwd, catalogPath: join(cwd, "state", "catalog.json") };
}

function createFixtureInstance(
  input: InstanceFactoryInput,
  runtimes: DelayedRuntimeSession[],
): ManagedInstance {
  const runtime = new DelayedRuntimeSession(`pi-${runtimes.length + 1}`);
  if (input.sessionFile) runtime.sessionFile = input.sessionFile;
  runtimes.push(runtime);
  return new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    session: runtime,
    initialRuntimeGeneration: input.initialRuntimeGeneration,
    createdAt: input.createdAt,
    reopenedFrom: input.reopenedFrom,
  });
}

test("startup exposes catalog-only host_lost records and explicit reopen starts no old command", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const firstRuntimes: DelayedRuntimeSession[] = [];
  const first = new DockRegistry(
    async (input) => createFixtureInstance(input, firstRuntimes),
    () => "dock-one",
    { hostEpoch: "host-one", startedAt: "2026-07-15T01:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await first.initializeCatalog();
  const created = await first.create({ operationId: "create-one", cwd });
  await created.submit("old command must never replay", "prompt", "run-one");
  assert.equal(firstRuntimes[0]?.promptCalls, 1);
  assert.equal(created.snapshot().execution, "running");

  const reopenedRuntimes: DelayedRuntimeSession[] = [];
  let factoryCalls = 0;
  const second = new DockRegistry(
    async (input) => { factoryCalls += 1; return createFixtureInstance(input, reopenedRuntimes); },
    () => "unused-id",
    {
      hostEpoch: "host-two",
      startedAt: "2026-07-15T02:00:00.000Z",
      catalogStore: new FileCatalogStore(catalogPath),
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  await second.initializeCatalog();
  assert.equal(factoryCalls, 0);
  assert.equal(second.startupNormalizedCount(), 1);
  const lost = second.getSnapshot("dock-one");
  assert.equal(lost.lifecycle, "host_lost");
  assert.equal(lost.execution, "unavailable");
  assert.equal(lost.lastRun, "interrupted");
  assert.equal(lost.reopenable, true);
  assert.equal(lost.runtimeGeneration, 1);
  assert.throws(() => second.get("dock-one"), InstanceUnavailableError);
  await assert.rejects(
    second.create({ operationId: "create-one", cwd }),
    CatalogOperationRecordedError,
  );

  const reopened = await second.reopen({ operationId: "reopen-one", instanceId: "dock-one" });
  assert.equal(reopened.previousLifecycle, "host_lost");
  assert.equal(factoryCalls, 1);
  assert.equal(reopenedRuntimes[0]?.promptCalls, 0);
  assert.equal(reopened.instance.id, "dock-one");
  assert.equal(reopened.instance.creationOperationId, "create-one");
  assert.equal(reopened.instance.snapshot().runtimeGeneration, 2);
  assert.equal(reopened.instance.snapshot().lastRun, "never");
  assert.equal(reopened.instance.snapshot().execution, "idle");
  assert.equal(reopened.instance.eventsSince().events[0]?.type, "instance.reopened");
  assert.equal(reopened.instance.eventsSince().events[0]?.sequence, 1);
});

test("concurrent reopen operations admit only one runtime candidate", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const seed = new DockRegistry(
    async (input) => createFixtureInstance(input, []),
    () => "dock-concurrent",
    { hostEpoch: "concurrent-seed", startedAt: "2026-07-15T01:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await seed.initializeCatalog();
  await seed.create({ operationId: "create-concurrent", cwd });

  let releaseFactory!: () => void;
  let signalStarted!: () => void;
  const factoryGate = new Promise<void>((resolveGate) => { releaseFactory = resolveGate; });
  const factoryStarted = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
  const runtimes: DelayedRuntimeSession[] = [];
  let factoryCalls = 0;
  const registry = new DockRegistry(
    async (input) => {
      factoryCalls += 1;
      signalStarted();
      await factoryGate;
      return createFixtureInstance(input, runtimes);
    },
    () => "unused-id",
    {
      hostEpoch: "concurrent-host",
      startedAt: "2026-07-15T02:00:00.000Z",
      catalogStore: new FileCatalogStore(catalogPath),
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  await registry.initializeCatalog();
  const first = registry.reopen({ operationId: "reopen-first", instanceId: "dock-concurrent" });
  await factoryStarted;
  await assert.rejects(
    registry.reopen({ operationId: "reopen-second", instanceId: "dock-concurrent" }),
    InstanceBusyError,
  );
  assert.equal(factoryCalls, 1);
  releaseFactory();
  assert.equal((await first).instance.snapshot().runtimeGeneration, 2);
});

test("reopen catalog failure disposes its candidate and preserves unavailable facts", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const seedRuntimes: DelayedRuntimeSession[] = [];
  const seed = new DockRegistry(
    async (input) => createFixtureInstance(input, seedRuntimes),
    () => "dock-failed",
    { hostEpoch: "seed-host", startedAt: "2026-07-15T01:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await seed.initializeCatalog();
  await seed.create({ operationId: "create-failed", cwd });

  let failWrites = false;
  const faultedStore = new FileCatalogStore(catalogPath, {
    fault: (phase) => { if (failWrites && phase === "rename") throw new Error("reopen rename fault"); },
  });
  const candidates: DelayedRuntimeSession[] = [];
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, candidates),
    () => "unused-id",
    {
      hostEpoch: "reopen-host",
      startedAt: "2026-07-15T02:00:00.000Z",
      catalogStore: faultedStore,
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  await registry.initializeCatalog();
  const before = registry.getSnapshot("dock-failed");
  failWrites = true;
  await assert.rejects(
    registry.reopen({ operationId: "reopen-failed", instanceId: "dock-failed" }),
    CatalogWriteError,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.disposeCalls, 1);
  assert.deepEqual(registry.getSnapshot("dock-failed"), before);
  assert.equal(registry.catalogHealth(), "healthy");
});

test("graceful durable Host drain records host_lost rather than explicit stop", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const runtimes: DelayedRuntimeSession[] = [];
  const store = new FileCatalogStore(catalogPath);
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, runtimes),
    () => "dock-shutdown",
    { hostEpoch: "shutdown-host", startedAt: "2026-07-15T03:00:00.000Z", catalogStore: store },
  );
  await registry.initializeCatalog();
  const instance = await registry.create({ operationId: "create-shutdown", cwd });
  await instance.submit("running during shutdown", "prompt", "run-shutdown");
  await registry.shutdownAllForHostDrain();

  const snapshot = registry.getSnapshot("dock-shutdown");
  assert.equal(snapshot.lifecycle, "host_lost");
  assert.equal(snapshot.execution, "unavailable");
  assert.equal(snapshot.lastRun, "interrupted");
  assert.equal(snapshot.reopenable, true);
  assert.equal(snapshot.interruption?.reason, "host_shutdown");
  assert.equal(runtimes[0]?.abortCalls, 1);
  assert.equal(runtimes[0]?.disposeCalls, 1);
  const persisted = await store.load();
  const record = persisted?.instances[0];
  assert.equal(record?.lifecycle, "host_lost");
  assert.equal(record?.shutdownRequestedAt, undefined);
  assert.equal(record?.lastKnown?.activeCommandId, "run-shutdown");
});

test("socket-first Host startup serves catalog-only snapshots and reopen over Protocol V2", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const seedRuntimes: DelayedRuntimeSession[] = [];
  const seed = new DockRegistry(
    async (input) => createFixtureInstance(input, seedRuntimes),
    () => "dock-protocol",
    { hostEpoch: "protocol-seed", startedAt: "2026-07-15T04:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await seed.initializeCatalog();
  await seed.create({ operationId: "create-protocol", cwd });
  await seed.shutdownAllForHostDrain();

  const socketPath = join(cwd, "dock.sock");
  const runtimes: DelayedRuntimeSession[] = [];
  let factoryCalls = 0;
  const registry = new DockRegistry(
    async (input) => { factoryCalls += 1; return createFixtureInstance(input, runtimes); },
    () => "unused-id",
    {
      hostEpoch: "protocol-host",
      startedAt: "2026-07-15T05:00:00.000Z",
      catalogStore: new FileCatalogStore(catalogPath),
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  const host = new DockHost({
    socketPath,
    statePath: catalogPath,
    registry,
    initialize: async () => {
      assert.equal((await lstat(socketPath)).isSocket(), true);
      await registry.initializeCatalog();
    },
  });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath, requestId: (() => { let id = 0; return () => `protocol-${++id}`; })() });

  const info = await client.hostInfo();
  assert.equal(info.paths.state, catalogPath);
  assert.match(info.diagnostics[0]?.message ?? "", /Durable catalog ready/);
  assert.equal(factoryCalls, 0);
  const before = await client.status("dock-protocol");
  assert.equal(before.lifecycle, "host_lost");
  assert.equal(before.reopenable, true);

  const reopened = await client.reopen("dock-protocol", "reopen-protocol");
  assert.equal(reopened.operationId, "reopen-protocol");
  assert.equal(reopened.previousLifecycle, "host_lost");
  assert.equal(reopened.instance.lifecycle, "active");
  assert.equal(reopened.instance.runtimeGeneration, 2);
  assert.equal(runtimes[0]?.promptCalls, 0);
  assert.ok(reopened.instance.eventCursor.sequence >= 1);
});

test("same-Host runtime_error reopen closes stale attach streams after commit", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const socketPath = join(cwd, "reopen-stream.sock");
  const runtimes: DelayedRuntimeSession[] = [];
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, runtimes),
    () => "dock-reopen-stream",
    {
      hostEpoch: "reopen-stream-host",
      startedAt: "2026-07-15T05:30:00.000Z",
      catalogStore: new FileCatalogStore(catalogPath),
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath, timeoutMs: 2_000 });
  await client.create(cwd, undefined, "create-reopen-stream");
  const seen: string[] = [];
  const subscription = await client.streamEvents("dock-reopen-stream", { onEvent: (event) => seen.push(event.type) });

  runtimes[0]?.emit({
    type: "dock_runtime_error",
    operationId: "failed-switch",
    kind: "switch",
    error: "fixture replacement failed",
    recoverySessionFile: runtimes[0].sessionFile,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await client.status("dock-reopen-stream")).lifecycle === "runtime_error") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  assert.equal((await client.status("dock-reopen-stream")).lifecycle, "runtime_error");
  const streamClosed = assert.rejects(
    subscription.done,
    (error: unknown) => error instanceof ControlClientError && error.code === "connection_closed",
  );
  const reopened = await client.reopen("dock-reopen-stream", "reopen-stream");
  assert.equal(reopened.instance.runtimeGeneration, 2);
  await streamClosed;
  assert.ok(seen.includes("instance.runtime_error"));
});

test("catalog startup failure preserves evidence and removes only the Host-owned socket", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const state = join(cwd, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(state, { mode: 0o700 }));
  await chmod(state, 0o700);
  const evidence = "{broken-catalog\n";
  await writeFile(catalogPath, evidence, { mode: 0o600 });
  const socketPath = join(cwd, "broken.sock");
  const registry = new DockRegistry(
    async () => assert.fail("corrupt startup must not construct a runtime"),
    undefined,
    { hostEpoch: "broken-host", catalogStore: new FileCatalogStore(catalogPath) },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  await assert.rejects(host.start(), /Catalog validation failed/);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(await readFile(catalogPath, "utf8"), evidence);
});
