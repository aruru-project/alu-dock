import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CatalogCorruptError,
  type CatalogInstanceRecord,
  type CatalogProjection,
} from "../src/core/catalog.js";
import {
  catalogSnapshotFromRecord,
  reconcileCatalogProjection,
} from "../src/control/catalog-reconcile.js";
import {
  FileCatalogStore,
  type CatalogWritePhase,
} from "../src/control/durable-catalog-store.js";

function record(id: string, overrides: Partial<CatalogInstanceRecord> = {}): CatalogInstanceRecord {
  return {
    id,
    creationOperationId: `create-${id}`,
    cwd: `/tmp/${id}`,
    lifecycle: "active",
    execution: "idle",
    lastRun: "never",
    runtimeGeneration: 1,
    ownerHostEpoch: "old-host",
    piSessionId: `pi-${id}`,
    sessionFile: `/tmp/${id}.jsonl`,
    admissionPending: false,
    pendingCount: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function projection(revision: number, instances: CatalogInstanceRecord[] = []): CatalogProjection {
  return { schemaVersion: 1, revision, lastHostEpoch: "old-host", instances };
}

async function temporaryCatalog(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-catalog-"));
  const path = join(root, "state", "catalog.json");
  return { root, path };
}

test("durable catalog round-trips closed records with private atomic files", async () => {
  const { root, path } = await temporaryCatalog();
  const store = new FileCatalogStore(path);
  assert.equal(await store.load(), undefined);
  const value = projection(1, [record("one")]);
  await store.commit(value, { kind: "test", effect: "pre_effect" });

  assert.deepEqual(await store.load(), value);
  assert.equal((await lstat(join(root, "state"))).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(root, "state"))).sort(), ["catalog.json"]);
});

test("catalog corruption, future schema, and symlinks preserve original evidence", async () => {
  const { root, path } = await temporaryCatalog();
  const state = join(root, "state");
  await new FileCatalogStore(path).commit(projection(0), { kind: "initialize", effect: "pre_effect" });

  const invalid = "{not-json\n";
  await writeFile(path, invalid, { mode: 0o600 });
  await assert.rejects(new FileCatalogStore(path).load(), CatalogCorruptError);
  assert.equal(await readFile(path, "utf8"), invalid);

  const future = `${JSON.stringify({ schemaVersion: 2, revision: 0, lastHostEpoch: "old-host", instances: [] })}\n`;
  await writeFile(path, future, { mode: 0o600 });
  await assert.rejects(new FileCatalogStore(path).load(), /schemaVersion/);
  assert.equal(await readFile(path, "utf8"), future);

  const target = join(root, "evidence.json");
  await writeFile(target, future, { mode: 0o600 });
  await writeFile(path, future, { mode: 0o600 });
  await import("node:fs/promises").then(({ rm }) => rm(path));
  await symlink(target, path);
  await assert.rejects(new FileCatalogStore(path).load(), /non-symlink/);
  assert.equal(await readFile(target, "utf8"), future);
  assert.equal((await lstat(state)).mode & 0o777, 0o700);
});

test("each atomic write fault rejects without leaving temporary catalog files", async () => {
  for (const phase of ["temp_write", "file_sync", "rename", "directory_sync"] as CatalogWritePhase[]) {
    const { root, path } = await temporaryCatalog();
    const initial = new FileCatalogStore(path);
    await initial.commit(projection(0), { kind: "initialize", effect: "pre_effect" });
    const faulted = new FileCatalogStore(path, {
      fault: (current) => { if (current === phase) throw new Error(`fault:${phase}`); },
    });
    await assert.rejects(
      faulted.commit(projection(1), { kind: "mutation", effect: "post_effect", operationId: phase }),
      new RegExp(`fault:${phase}`),
    );
    const loaded = await initial.load();
    assert.equal(loaded?.revision, phase === "directory_sync" ? 1 : 0);
    assert.deepEqual((await readdir(join(root, "state"))).sort(), ["catalog.json"]);
  }
});

test("startup reconcile conservatively normalizes old live facts without a runtime", () => {
  const loaded = projection(8, [
    record("running", {
      execution: "running",
      lastRun: "succeeded",
      activeCommandId: "run-op",
      admissionPending: true,
      admissionOperationId: "admission-op",
      pendingCount: 2,
      replacement: {
        operationId: "replace-op",
        kind: "switch",
        previousSessionFile: "/tmp/previous.jsonl",
        requestedSessionFile: "/tmp/requested.jsonl",
        startedAt: "2026-07-15T00:01:00.000Z",
      },
    }),
    record("shutdown", { shutdownRequestedAt: "2026-07-15T00:02:00.000Z", lastRun: "failed", execution: "failed" }),
    record("stop", { lifecycle: "stopping", stopRequestedAt: "2026-07-15T00:03:00.000Z" }),
    record("done", { lifecycle: "stopped", execution: "unavailable", ownerHostEpoch: undefined, sessionFile: undefined }),
  ]);
  const result = reconcileCatalogProjection(loaded, "new-host", new Date("2026-07-15T01:00:00.000Z"));
  assert.equal(result.normalizedCount, 3);
  assert.equal(result.projection.revision, 9);
  assert.equal(result.projection.lastHostEpoch, "new-host");

  const running = result.projection.instances.find((item) => item.id === "running");
  assert.equal(running?.lifecycle, "host_lost");
  assert.equal(running?.execution, "unavailable");
  assert.equal(running?.lastRun, "interrupted");
  assert.equal(running?.recoverySessionFile, "/tmp/previous.jsonl");
  assert.deepEqual(running?.lastKnown, { lifecycle: "active", execution: "running", activeCommandId: "run-op", pendingCount: 2 });
  assert.equal(running?.interruption?.reason, "host_crash");
  assert.equal(running?.activeCommandId, undefined);
  assert.equal(running?.admissionPending, false);
  assert.equal(running?.replacement, undefined);

  const shutdown = result.projection.instances.find((item) => item.id === "shutdown");
  assert.equal(shutdown?.lifecycle, "host_lost");
  assert.equal(shutdown?.lastRun, "failed");
  assert.equal(shutdown?.interruption?.reason, "host_shutdown");

  const stopped = result.projection.instances.find((item) => item.id === "stop");
  assert.equal(stopped?.lifecycle, "stopped");
  assert.equal(stopped?.execution, "unavailable");
  assert.equal(stopped?.recoverySessionFile, undefined);

  const snapshot = catalogSnapshotFromRecord(running as CatalogInstanceRecord, "new-host");
  assert.equal(snapshot.reopenable, true);
  assert.equal(snapshot.ownerHostEpoch, undefined);
  assert.equal(snapshot.eventCursor.hostEpoch, "new-host");
  assert.deepEqual(snapshot.pending, { steering: 0, followUp: 0, total: 0 });
});
