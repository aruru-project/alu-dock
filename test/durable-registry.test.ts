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
  DockRegistry,
  InstanceNotReopenableError,
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
    observationGrant: input.observationGrant,
  });
}

async function seedStoppedCatalog(catalogPath: string, cwd: string, ids: readonly string[]): Promise<CatalogInstanceRecord[]> {
  const timestamp = "2026-07-15T00:00:00.000Z";
  const records = ids.map((id): CatalogInstanceRecord => ({
    id,
    creationOperationId: `create-${id}`,
    name: id,
    cwd,
    lifecycle: "stopped",
    execution: "unavailable",
    lastRun: "aborted",
    observationGrant: false,
    executionChangedAt: timestamp,
    runtimeGeneration: 1,
    piSessionId: `pi-${id}`,
    sessionFile: join(cwd, `${id}.jsonl`),
    admissionPending: false,
    pendingCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  await new FileCatalogStore(catalogPath).commit({
    schemaVersion: 1,
    revision: 1,
    lastHostEpoch: "legacy-host",
    instances: records,
  }, { kind: "test.seed_stopped", effect: "pre_effect" });
  return records;
}

test("observation grant persists across Host restart and explicit reopen", async () => {
  const { cwd, catalogPath } = await fixturePath();
  const firstRuntimes: DelayedAgentWorkerConnection[] = [];
  const first = new DockRegistry(
    async (input) => createFixtureInstance(input, firstRuntimes),
    () => "dock-observer",
    { hostEpoch: "observer-host-one", startedAt: "2026-07-15T01:00:00.000Z", catalogStore: new FileCatalogStore(catalogPath) },
  );
  await first.initializeCatalog();
  const source = await first.create({ operationId: "create-observer", cwd });
  await first.configureObservation(source.id, true, "grant-observation");
  assert.equal(first.observationGrant(source.id), true);

  let reopenInput: InstanceFactoryInput | undefined;
  const reopenedRuntimes: DelayedAgentWorkerConnection[] = [];
  const second = new DockRegistry(
    async (input) => { reopenInput = input; return createFixtureInstance(input, reopenedRuntimes); },
    () => "unused",
    {
      hostEpoch: "observer-host-two",
      startedAt: "2026-07-15T02:00:00.000Z",
      catalogStore: new FileCatalogStore(catalogPath),
      reopenTargetResolver: { resolve: async () => ({ cwd }) },
    },
  );
  await second.initializeCatalog();
  assert.equal(second.observationGrant(source.id), true);
  await second.reopen({ operationId: "reopen-observer", instanceId: source.id });
  assert.equal(reopenInput?.observationGrant, true);
  assert.equal(second.get(source.id).observationGrant(), true);
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







test("durable catalog removal ambiguity returns effect_unknown and preserves query evidence", async (context) => {
  const { cwd, catalogPath } = await fixturePath();
  const [legacy] = await seedStoppedCatalog(catalogPath, cwd, ["ambiguous-maintenance"]);
  let failDirectorySync = false;
  const store = new FileCatalogStore(catalogPath, {
    fault: (phase) => {
      if (failDirectorySync && phase === "directory_sync") throw new Error("maintenance directory sync fault");
    },
  });
  const registry = new DockRegistry(
    async () => assert.fail("legacy stopped maintenance must not construct a runtime"),
    () => "unused",
    { hostEpoch: "ambiguous-maintenance-host", catalogStore: store },
  );
  const socketPath = join(cwd, "ambiguous-maintenance.sock");
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });

  failDirectorySync = true;
  await assert.rejects(
    client.forget(legacy!.id, "forget-ambiguous-maintenance"),
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
  const [first, second] = await seedStoppedCatalog(catalogPath, cwd, ["maintenance-stopped-one", "maintenance-stopped-two"]);
  const sessionEvidence = first!.sessionFile!;
  await writeFile(sessionEvidence, "Pi session evidence\n");
  const socketPath = join(cwd, "maintenance.sock");
  const registry = new DockRegistry(
    async (input) => createFixtureInstance(input, []),
    () => "maintenance-active",
    { hostEpoch: "maintenance-host", catalogStore: new FileCatalogStore(catalogPath) },
  );
  const host = new DockHost({ socketPath, statePath: catalogPath, registry, initialize: () => registry.initializeCatalog() });
  context.after(async () => host.stop().catch(() => {}));
  await host.start();
  const client = new DockClient({ socketPath });
  assert.ok((await client.ping()).capabilities.includes("catalog.maintenance.v1"));

  const active = await client.create(cwd, "active", "create-maintenance-active");
  await assert.rejects(
    client.forget(active.id, "forget-live"),
    (error: unknown) => error instanceof ControlClientError && error.code === "instance_not_terminal",
  );

  const forgotten = await client.forget(first!.id, "forget-maintenance-one");
  assert.deepEqual(forgotten.receipt, {
    operationId: "forget-maintenance-one",
    forgottenId: first!.id,
    previousLifecycle: "stopped",
    piSessionFilesDeleted: 0,
  });
  assert.equal(await readFile(sessionEvidence, "utf8"), "Pi session evidence\n");
  assert.deepEqual(await client.forget(first!.id, "forget-maintenance-one"), forgotten, "same-Host ledger must replay the committed receipt");
  await assert.rejects(client.status(first!.id), (error: unknown) => error instanceof ControlClientError && error.code === "not_found");

  const pruned = await client.pruneStopped("prune-maintenance-one");
  assert.deepEqual(pruned.receipt.forgottenIds, [second!.id]);
  assert.equal(pruned.receipt.forgottenCount, 1);
  assert.equal(pruned.receipt.hasMore, false);
  assert.equal(pruned.receipt.piSessionFilesDeleted, 0);
  assert.deepEqual((await client.list()).map((instance) => instance.id), [active.id]);
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
