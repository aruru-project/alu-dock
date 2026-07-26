import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { MAX_INSTANCE_LIST_RESULT_BYTES } from "../src/control/protocol.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import {
  CatalogOperationRecordedError,
  DockRegistry,
  InstanceNotReopenableError,
  InstanceUnavailableError,
  type InstanceFactoryInput,
} from "../src/control/dock-registry.js";
import { type CatalogInstanceRecord, CatalogWriteError } from "../src/core/catalog.js";
import { InstanceBusyError, ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

async function fixturePath(): Promise<{ cwd: string; catalogPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-registry-"));
  return { cwd, catalogPath: join(cwd, "state", "catalog.json") };
}

function createFixtureInstance(
  input: InstanceFactoryInput,
  runtimes: DelayedAgentWorkerConnection[],
): ManagedInstance {
  const runtime = new DelayedAgentWorkerConnection(`pi-${runtimes.length + 1}`);
  if (input.sessionFile) runtime.sessionFile = input.sessionFile;
  runtimes.push(runtime);
  return new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    key: input.key,
    name: input.name,
    session: runtime,
    initialRuntimeGeneration: input.initialRuntimeGeneration,
    createdAt: input.createdAt,
    reopenedFrom: input.reopenedFrom,
  });
}

test("startup exposes catalog-only host_lost records and explicit reopen starts no old command", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const firstRuntimes: DelayedAgentWorkerConnection[] = [];
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

  const reopenedRuntimes: DelayedAgentWorkerConnection[] = [];
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

test("concurrent ensure calls for one business key return one durable instance", async () => {
  const { cwd, catalogPath } = await fixturePath();
  let factoryCalls = 0;
  let releaseFactory!: () => void;
  let signalStarted!: () => void;
  const factoryGate = new Promise<void>((resolveGate) => { releaseFactory = resolveGate; });
  const factoryStarted = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
  const registry = new DockRegistry(
    async (input) => {
      factoryCalls += 1;
      signalStarted();
      await factoryGate;
      return createFixtureInstance(input, []);
    },
    () => "dock-alu",
    { hostEpoch: "ensure-host", startedAt: "2026-07-15T01:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await registry.initializeCatalog();

  const first = registry.ensure({ operationId: "ensure-first", key: "alu", cwd });
  await factoryStarted;
  const second = registry.ensure({ operationId: "ensure-second", key: "alu", cwd });
  releaseFactory();

  const [created, existing] = await Promise.all([first, second]);
  assert.equal(created.created, true);
  assert.equal(existing.created, false);
  assert.equal(created.instance.id, "dock-alu");
  assert.equal(existing.instance.id, created.instance.id);
  assert.equal(existing.instance.key, "alu");
  assert.equal(factoryCalls, 1);

  const restarted = new DockRegistry(
    async (input) => createFixtureInstance(input, []),
    () => "must-not-create",
    { hostEpoch: "ensure-restart", startedAt: "2026-07-15T02:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await restarted.initializeCatalog();
  const recovered = await restarted.ensure({ operationId: "ensure-after-restart", key: "alu", cwd });
  assert.equal(recovered.created, false);
  assert.equal(recovered.instance.id, "dock-alu");
  assert.equal(recovered.instance.key, "alu");
  assert.equal(recovered.instance.lifecycle, "host_lost");
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
  const runtimes: DelayedAgentWorkerConnection[] = [];
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
  const seedRuntimes: DelayedAgentWorkerConnection[] = [];
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
  const candidates: DelayedAgentWorkerConnection[] = [];
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
  const runtimes: DelayedAgentWorkerConnection[] = [];
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

test("failed shutdown intent plus unconfirmed disposal is durably quarantined across restart", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const baseStore = new FileCatalogStore(catalogPath);
  let failShutdownIntent = true;
  const faultingStore = {
    path: baseStore.path,
    load: () => baseStore.load(),
    commit: async (...args: Parameters<FileCatalogStore["commit"]>) => {
      const [, context] = args;
      if (failShutdownIntent && context.kind === "host.shutdown.intent") {
        failShutdownIntent = false;
        throw new Error("injected shutdown intent failure");
      }
      await baseStore.commit(...args);
    },
  };
  const runtimes: DelayedAgentWorkerConnection[] = [];
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, runtimes),
    () => "dock-quarantine",
    { hostEpoch: "quarantine-host", startedAt: "2026-07-15T03:00:00.000Z", catalogStore: faultingStore },
  );
  await registry.initializeCatalog();
  await registry.create({ operationId: "create-quarantine", cwd });
  runtimes[0]!.disposeError = new Error("owner release not confirmed");

  await assert.rejects(registry.shutdownAllForHostDrain(), /failed durable Host shutdown/i);
  const quarantined = (await baseStore.load())?.instances[0];
  assert.equal(quarantined?.lifecycle, "runtime_error");
  assert.equal(quarantined?.ownerReleaseUnconfirmed, true);

  const restarted = new DockRegistry(
    async () => { throw new Error("quarantined record must not construct a runtime"); },
    () => "unused",
    { hostEpoch: "quarantine-restart", startedAt: "2026-07-15T04:00:00.000Z", catalogStore: baseStore },
  );
  await restarted.initializeCatalog();
  const snapshot = restarted.getSnapshot("dock-quarantine");
  assert.equal(snapshot.lifecycle, "runtime_error");
  assert.equal(snapshot.reopenable, false);
  await assert.rejects(
    restarted.reopen({ operationId: "unsafe-reopen", instanceId: "dock-quarantine" }),
    InstanceNotReopenableError,
  );
  await assert.rejects(
    restarted.reopen({ operationId: "unsafe-override", instanceId: "dock-quarantine", sessionFile: quarantined!.sessionFile! }),
    InstanceNotReopenableError,
  );
});

test("socket-first Host startup serves catalog-only snapshots and reopen over Protocol V2", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const seedRuntimes: DelayedAgentWorkerConnection[] = [];
  const seed = new DockRegistry(
    async (input) => createFixtureInstance(input, seedRuntimes),
    () => "dock-protocol",
    { hostEpoch: "protocol-seed", startedAt: "2026-07-15T04:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await seed.initializeCatalog();
  await seed.create({ operationId: "create-protocol", cwd });
  await seed.shutdownAllForHostDrain();

  const socketPath = join(cwd, "dock.sock");
  const runtimes: DelayedAgentWorkerConnection[] = [];
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
  const runtimes: DelayedAgentWorkerConnection[] = [];
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

test("one malformed live projection falls back to its catalog record without poisoning other instances", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const runtimes: DelayedAgentWorkerConnection[] = [];
  let id = 0;
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, runtimes),
    () => `dock-safe-list-${++id}`,
    { hostEpoch: "safe-list-host", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await registry.initializeCatalog();
  const malformed = await registry.create({ operationId: "create-malformed", cwd });
  const healthy = await registry.create({ operationId: "create-healthy", cwd });
  const originalSnapshot = malformed.snapshot.bind(malformed);
  Object.defineProperty(malformed, "snapshot", {
    configurable: true,
    value: () => { throw new Error("Active compaction requires running execution"); },
  });

  const page = registry.listPage({ selector: "actionable", limit: 100, maxBytes: MAX_INSTANCE_LIST_RESULT_BYTES });
  assert.equal(page.instances.length, 2);
  assert.equal(page.page.total, 2);
  assert.equal(page.instances.find((item) => item.id === healthy.id)?.execution, "idle");
  const fallback = page.instances.find((item) => item.id === malformed.id);
  assert.equal(fallback?.execution, "idle");
  assert.equal(fallback?.compacting, false);
  assert.equal(registry.getSnapshot(healthy.id).id, healthy.id);
  assert.equal(registry.getSnapshot(malformed.id).id, malformed.id);

  Object.defineProperty(malformed, "snapshot", { configurable: true, value: originalSnapshot });
  assert.equal(registry.getSnapshot(malformed.id).id, malformed.id);
});

test("revision-bound instance.list pages keep large stopped catalogs bounded", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const stoppedRecords: CatalogInstanceRecord[] = Array.from({ length: 10_000 }, (_, index) => {
    const id = `stopped-${String(index).padStart(5, "0")}`;
    return {
      id,
      creationOperationId: `create-${id}`,
      cwd,
      lifecycle: "stopped",
      execution: "unavailable",
      lastRun: "never",
      runtimeGeneration: 1,
      piSessionId: `pi-${id}`,
      admissionPending: false,
      pendingCount: 0,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
  });
  const store = new FileCatalogStore(catalogPath);
  await store.commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "large-seed", instances: stoppedRecords }, {
    kind: "test.seed",
    effect: "pre_effect",
  });
  const socketPath = join(cwd, "large-list.sock");
  const registry = new DockRegistry(
    async () => assert.fail("stopped catalog listing must not construct runtimes"),
    undefined,
    { hostEpoch: "large-list-host", catalogStore: store },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });

  const actionable = await client.listPage("actionable");
  assert.deepEqual(actionable.instances, []);
  assert.equal(actionable.page.total, 0);
  assert.equal(actionable.page.hiddenStopped, 10_000);
  const firstPage = await client.listPage("all");
  assert.equal(firstPage.instances.length, 100);
  assert.equal(firstPage.instances[0]?.id, "stopped-09999", "the human first page must contain the newest records");
  assert.equal(firstPage.page.total, 10_000);
  assert.equal(firstPage.page.nextCursor?.offset, 100);
  assert.equal((await client.list()).length, 10_000, "typed client must traverse every bounded page");
  const pruned = await client.pruneStopped("prune-large-page");
  assert.equal(pruned.receipt.forgottenCount, 1_000);
  assert.equal(pruned.receipt.hasMore, true);
  await assert.rejects(
    client.listPage("all", firstPage.page.nextCursor),
    (error: unknown) => error instanceof ControlClientError && error.code === "cursor_stale",
  );
  assert.equal((await client.listPage("all")).page.total, 9_000);
});

test("instance.list byte-bounds pages containing valid long catalog paths", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const longCwd = `/${"c".repeat(16_000)}`;
  const longSessionFile = `/${"s".repeat(16_000)}`;
  const records: CatalogInstanceRecord[] = Array.from({ length: 120 }, (_, index) => {
    const id = `heavy-${String(index).padStart(4, "0")}`;
    return {
      id,
      creationOperationId: `create-${id}`,
      cwd: longCwd,
      lifecycle: "stopped",
      execution: "unavailable",
      lastRun: "never",
      runtimeGeneration: 1,
      piSessionId: `pi-${id}`,
      sessionFile: longSessionFile,
      admissionPending: false,
      pendingCount: 0,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
  });
  const store = new FileCatalogStore(catalogPath);
  await store.commit({ schemaVersion: 1, revision: 1, lastHostEpoch: "heavy-seed", instances: records }, {
    kind: "test.seed",
    effect: "pre_effect",
  });
  const socketPath = join(cwd, "heavy-list.sock");
  const registry = new DockRegistry(
    async () => assert.fail("stopped catalog listing must not construct runtimes"),
    undefined,
    { hostEpoch: "heavy-list-host", catalogStore: store },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });

  const firstPage = await client.listPage("all");
  assert.ok(firstPage.instances.length > 0 && firstPage.instances.length < 100);
  assert.equal(firstPage.instances[0]?.id, "heavy-0119");
  assert.ok(Buffer.byteLength(JSON.stringify(firstPage), "utf8") <= MAX_INSTANCE_LIST_RESULT_BYTES);
  assert.equal(firstPage.page.nextCursor?.offset, firstPage.instances.length);
  assert.equal((await client.list()).length, 120);
});

test("durable catalog removal ambiguity returns effect_unknown and preserves query evidence", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  let failDirectorySync = false;
  const store = new FileCatalogStore(catalogPath, {
    fault: (phase) => {
      if (failDirectorySync && phase === "directory_sync") throw new Error("maintenance directory sync fault");
    },
  });
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, []),
    () => "ambiguous-maintenance",
    { hostEpoch: "ambiguous-maintenance-host", catalogStore: store },
  );
  const socketPath = join(cwd, "ambiguous-maintenance.sock");
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });
  const created = await client.create(cwd, undefined, "create-ambiguous-maintenance");
  await client.stop(created.id, "stop-ambiguous-maintenance");

  failDirectorySync = true;
  await assert.rejects(
    client.forget(created.id, "forget-ambiguous-maintenance"),
    (error: unknown) => error instanceof ControlClientError
      && error.code === "effect_unknown"
      && error.operationId === "forget-ambiguous-maintenance",
  );
  const persisted = await new FileCatalogStore(catalogPath).load();
  assert.deepEqual(persisted?.instances, [], "post-rename evidence must remain queryable rather than invite retry");
  assert.equal(registry.catalogHealth(), "draining");
});

test("Protocol V2 forget and prune remove only terminal Dock records after commit", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const socketPath = join(cwd, "maintenance.sock");
  const runtimes = new Map<string, DelayedAgentWorkerConnection>();
  let id = 0;
  const registry = new DockRegistry(
    async (input) => {
      const runtime = new DelayedAgentWorkerConnection(`pi-${input.id}`);
      runtime.sessionFile = join(cwd, `${input.id}.jsonl`);
      runtimes.set(input.id, runtime);
      return new ManagedInstance({
        id: input.id,
        creationOperationId: input.creationOperationId,
        hostEpoch: input.hostEpoch,
        cwd: input.cwd,
        session: runtime,
      });
    },
    () => `maintenance-${++id}`,
    { hostEpoch: "maintenance-host", catalogStore: new FileCatalogStore(catalogPath) },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });
  assert.ok((await client.ping()).capabilities.includes("catalog.maintenance.v1"));

  const first = await client.create(cwd, "first", "create-maintenance-one");
  const forgottenStream = await client.streamEvents(first.id, { onEvent: () => {} });
  await assert.rejects(
    client.forget(first.id, "forget-live"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_not_terminal",
  );
  await client.stop(first.id, "stop-maintenance-one");
  const sessionEvidence = runtimes.get(first.id)?.sessionFile as string;
  await writeFile(sessionEvidence, "Pi session evidence\n");
  const streamClosed = assert.rejects(
    forgottenStream.done,
    (error: unknown) => error instanceof ControlClientError && error.code === "connection_closed",
  );
  const forgotten = await client.forget(first.id, "forget-maintenance-one");
  await streamClosed;
  assert.deepEqual(forgotten.receipt, {
    operationId: "forget-maintenance-one",
    forgottenId: first.id,
    previousLifecycle: "stopped",
    piSessionFilesDeleted: 0,
  });
  assert.equal(await readFile(sessionEvidence, "utf8"), "Pi session evidence\n");
  assert.deepEqual(await client.forget(first.id, "forget-maintenance-one"), forgotten, "same-Host ledger must replay the committed receipt");
  await assert.rejects(client.status(first.id), (error: unknown) => error instanceof ControlClientError && error.code === "not_found");

  const second = await client.create(cwd, "second", "create-maintenance-two");
  const third = await client.create(cwd, "third", "create-maintenance-three");
  await client.stop(second.id, "stop-maintenance-two");
  const pruned = await client.pruneStopped("prune-maintenance-one");
  assert.deepEqual(pruned.receipt.forgottenIds, [second.id]);
  assert.equal(pruned.receipt.forgottenCount, 1);
  assert.equal(pruned.receipt.hasMore, false);
  assert.equal(pruned.receipt.piSessionFilesDeleted, 0);
  assert.deepEqual((await client.list()).map((instance) => instance.id), [third.id]);
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
