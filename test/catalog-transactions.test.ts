import assert from "node:assert/strict";
import test from "node:test";

import { CatalogTransactionCoordinator } from "../src/control/catalog-transactions.js";
import {
  CatalogEffectUnknownError,
  type CatalogInstanceRecord,
  CatalogWriteError,
  MutationFaultedError,
  validateCatalogRecord,
} from "../src/core/catalog.js";
import { ScriptedCatalogCommitPort } from "./support/scripted-catalog-port.js";

function record(id: string, overrides: Partial<CatalogInstanceRecord> = {}): CatalogInstanceRecord {
  return {
    id,
    creationOperationId: `create-${id}`,
    cwd: `/tmp/${id}`,
    lifecycle: "active",
    execution: "idle",
    lastRun: "never",
    runtimeGeneration: 1,
    ownerHostEpoch: "host-epoch",
    piSessionId: `pi-${id}`,
    admissionPending: false,
    pendingCount: 0,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

test("catalog coordinator serializes complete immutable candidates", async () => {
  const port = new ScriptedCatalogCommitPort();
  const gate = port.gateAt(1);
  const catalog = new CatalogTransactionCoordinator(port);
  const first = catalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one" });
  await gate.entered;
  const second = catalog.create(record("two", { createdAt: "2026-07-14T00:00:01.000Z" }), { kind: "create", effect: "rollback_contained", operationId: "create-two" });

  assert.equal(catalog.revision, 0);
  assert.equal(port.calls.length, 1);
  assert.equal(Object.isFrozen(port.calls[0]?.candidate), true);
  assert.equal(Object.isFrozen(port.calls[0]?.candidate.instances[0]), true);
  gate.release();
  await Promise.all([first, second]);

  assert.equal(port.maxActiveCommits, 1);
  assert.equal(catalog.revision, 2);
  assert.deepEqual(port.calls[1]?.candidate.instances.map((item) => item.id), ["one", "two"]);
});

test("pre-effect failure leaves catalog healthy while post-effect failure faults monotonically", async () => {
  const prePort = new ScriptedCatalogCommitPort();
  prePort.failAt(1);
  const preCatalog = new CatalogTransactionCoordinator(prePort);
  await assert.rejects(
    preCatalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one" }),
    CatalogWriteError,
  );
  assert.equal(preCatalog.health, "healthy");
  assert.equal(preCatalog.revision, 0);
  await preCatalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one-2" });
  assert.equal(preCatalog.revision, 1);

  const postPort = new ScriptedCatalogCommitPort();
  const postCatalog = new CatalogTransactionCoordinator(postPort);
  await postCatalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one" });
  postPort.failAt(2);
  let faults = 0;
  postCatalog.onFault(() => { faults += 1; });
  await assert.rejects(
    postCatalog.forInstance("one").commit(record("one", { updatedAt: "2026-07-14T00:00:01.000Z" }), { kind: "model.set", effect: "post_effect", operationId: "model-op" }),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "model-op",
  );
  assert.equal(postCatalog.health, "mutation_faulted");
  assert.equal(postCatalog.revision, 1);
  assert.equal(faults, 1);
  await assert.rejects(
    postCatalog.forInstance("one").commit(record("one"), { kind: "tool.set_active", effect: "post_effect", operationId: "tool-op" }),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "tool-op",
  );
  assert.throws(() => postCatalog.assertWritable(), MutationFaultedError);
  assert.equal(postPort.calls.length, 2);
  assert.equal(faults, 1);
});

test("globally queued post-effect mutations retain their own effect_unknown operation IDs", async () => {
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port);
  await catalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one" });
  const gate = port.gateAt(2);
  port.failAt(2);
  const first = catalog.forInstance("one").commit(record("one", { updatedAt: "2026-07-14T00:00:01.000Z" }), { kind: "model.set", effect: "post_effect", operationId: "model-one" });
  await gate.entered;
  const second = catalog.forInstance("one").commit(record("one", { updatedAt: "2026-07-14T00:00:02.000Z" }), { kind: "settings.update", effect: "post_effect", operationId: "settings-two" });
  gate.release();
  await assert.rejects(first, (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "model-one");
  await assert.rejects(second, (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "settings-two");
  assert.equal(port.calls.length, 2);
});

test("post-effect invariant failure faults before an invalid candidate reaches the port", async () => {
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port);
  await catalog.create(record("one"), { kind: "create", effect: "rollback_contained", operationId: "create-one" });
  await assert.rejects(
    catalog.forInstance("one").commit(record("one", { activeCommandId: "bad" }), { kind: "run.started", effect: "post_effect", operationId: "run-one" }),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "run-one",
  );
  assert.equal(catalog.health, "mutation_faulted");
  assert.equal(catalog.revision, 1);
  assert.equal(port.calls.length, 1);
});

test("catalog and wire facts share lifecycle invariants including active failed quiescence", () => {
  assert.doesNotThrow(() => validateCatalogRecord(record("failed", { execution: "failed", lastRun: "failed" })));
  assert.throws(() => validateCatalogRecord(record("bad-owner", { ownerHostEpoch: undefined })), /owner Host epoch/);
  assert.throws(() => validateCatalogRecord(record("bad-command", { activeCommandId: "op" })), /Active command/);
  assert.throws(() => validateCatalogRecord(record("bad-admission", { admissionPending: true })), /Admission intent/);
  assert.throws(() => validateCatalogRecord(record("bad-terminal", { lifecycle: "stopped", execution: "unavailable", ownerHostEpoch: undefined, pendingCount: 1 })), /retains active/);
  assert.doesNotThrow(() => validateCatalogRecord(record("recoverable", { lifecycle: "runtime_error", execution: "unavailable", ownerHostEpoch: undefined, recoverySessionFile: "/tmp/recover.jsonl" })));
  assert.throws(() => validateCatalogRecord(record("bad-recovery", { recoverySessionFile: "/tmp/recover.jsonl" })), /Recovery session/);
});
