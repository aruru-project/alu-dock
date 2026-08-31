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
    cwd: join(tmpdir(), id),
    lifecycle: "active",
    execution: "idle",
    lastRun: "never",
    runtimeGeneration: 1,
    ownerHostEpoch: "old-host",
    piSessionId: `pi-${id}`,
    sessionFile: join(tmpdir(), `${id}.jsonl`),
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

test("legacy observation grants reset to Dock tools off and normalize execution timing", async () => {
  const { path } = await temporaryCatalog();
  const store = new FileCatalogStore(path);
  await store.commit(projection(1, [record("legacy")]), { kind: "legacy-fixture", effect: "pre_effect" });
  const legacyProjection = JSON.parse(await readFile(path, "utf8")) as { instances: Array<Record<string, unknown>> };
  legacyProjection.instances[0]!.observationGrant = true;
  await writeFile(path, JSON.stringify(legacyProjection), { mode: 0o600 });
  const loaded = await store.load();
  const legacy = loaded?.instances[0];
  assert.equal(legacy?.dockToolsEnabled, false);
  assert.equal(legacy?.executionChangedAt, "2026-07-15T00:00:00.000Z");
  assert.equal(legacy?.runStartedAt, undefined);
});

test("durable catalog rejects duplicate and unsafe instance keys", async () => {
  const { path } = await temporaryCatalog();
  const store = new FileCatalogStore(path);
  await assert.rejects(
    store.commit(projection(1, [record("one", { key: "alu" }), record("two", { key: "alu" })]), { kind: "test", effect: "pre_effect" }),
    /Duplicate catalog instance key/u,
  );
  await assert.rejects(
    store.commit(projection(1, [record("one", { key: "bad\nkey" })]), { kind: "test", effect: "pre_effect" }),
    /instance key/u,
  );
});

test("durable catalog preserves a Work's multiline Agent error", async () => {
  const { path } = await temporaryCatalog();
  const store = new FileCatalogStore(path);
  const error = "provider request failed\nretry next cycle";
  await store.commit(projection(1, [record("failed", {
    execution: "failed",
    lastRun: "failed",
    lastError: error,
  })]), { kind: "run.settled", effect: "post_effect", operationId: "failed-run" });

  assert.equal((await store.load())?.instances[0]?.lastError, error);
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
