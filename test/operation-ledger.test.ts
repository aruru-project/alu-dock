import assert from "node:assert/strict";
import test from "node:test";

import { OperationConflictError, OperationLedger } from "../src/control/operation-ledger.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>((resolve) => { this.resolve = resolve; }); }
}

test("operation ledger shares concurrent and completed receipts without repeating effects", async () => {
  const ledger = new OperationLedger();
  const deferred = new Deferred<{ receipt: string }>();
  let effects = 0;
  const execute = (): Promise<{ receipt: string }> => { effects += 1; return deferred.promise; };

  // Both calls are admitted in one synchronous turn, before the executor's
  // microtask starts, matching duplicate frames decoded from one I/O turn.
  const first = ledger.run("op-1", "command.submit", { message: "hello", delivery: "prompt" }, execute);
  const concurrent = ledger.run("op-1", "command.submit", { delivery: "prompt", message: "hello" }, execute);
  deferred.resolve({ receipt: "accepted" });
  const result = await first;
  assert.deepEqual(await concurrent, result);
  assert.equal(effects, 1);

  const completed = await ledger.run("op-1", "command.submit", { message: "hello", delivery: "prompt" }, execute);
  assert.deepEqual(completed, result);
  assert.equal(effects, 1);
});

test("operation ledger returns a stable error and rejects conflicting reuse", async () => {
  const ledger = new OperationLedger();
  const failure = new Error("stable failure");
  let effects = 0;
  const first = ledger.run("op-error", "model.set", { modelId: "a" }, () => { effects += 1; throw failure; });
  const duplicate = ledger.run("op-error", "model.set", { modelId: "a" }, () => { effects += 1; return undefined; });
  await assert.rejects(first, (error: unknown) => error === failure);
  await assert.rejects(duplicate, (error: unknown) => error === failure);
  await assert.rejects(ledger.run("op-error", "model.set", { modelId: "a" }, () => undefined), (error: unknown) => error === failure);
  await assert.rejects(
    ledger.run("op-error", "thinking.set", { level: "high" }, () => undefined),
    (error: unknown) => error instanceof OperationConflictError && error.code === "operation_conflict",
  );
  assert.equal(effects, 1);
});
