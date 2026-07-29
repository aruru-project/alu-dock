import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockRegistry, type InstanceFactoryInput } from "../src/control/dock-registry.js";
import { CROSS_INSTANCE_TRUST } from "../src/core/instance-observation.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

function fixtureInstance(input: InstanceFactoryInput, runtimes: DelayedAgentWorkerConnection[]): ManagedInstance {
  const runtime = new DelayedAgentWorkerConnection(`observation-${runtimes.length + 1}`);
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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("instance observation is source-authorized, excludes self, watches once, and cancels", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-observation-"));
  const ids = ["source-instance", "target-instance"];
  const runtimes: DelayedAgentWorkerConnection[] = [];
  const registry = new DockRegistry(
    async (input) => fixtureInstance(input, runtimes),
    () => ids.shift()!,
    { hostEpoch: "observation-host" },
  );
  const source = await registry.create({ operationId: "create-source", cwd, name: "Alu" });
  const ensured = await registry.ensure({ operationId: "create-target", cwd, key: "sol", name: "Sol" });
  const target = registry.get(ensured.instance.id);

  assert.equal(registry.observationGrant(source.id), false);
  await assert.rejects(registry.observe(source.id, { type: "list" }), /not granted/u);
  await registry.configureObservation(source.id, true, "grant-on");

  const listed = await registry.observe(source.id, { type: "list" });
  assert.equal(listed.type, "list");
  if (listed.type !== "list") assert.fail("expected list result");
  assert.equal(listed.result.trust, CROSS_INSTANCE_TRUST);
  assert.equal(listed.result.total, 1);
  assert.deepEqual(listed.result.instances.map((item) => item.id), [target.id]);
  await assert.rejects(registry.observe(source.id, { type: "inspect", target: source.id }), /cannot observe itself/u);

  const inspected = await registry.observe(source.id, { type: "inspect", target: "sol" });
  assert.equal(inspected.type, "inspect");
  if (inspected.type !== "inspect") assert.fail("expected inspect result");
  assert.equal(inspected.result.status.id, target.id);
  assert.equal(inspected.result.trust, CROSS_INSTANCE_TRUST);

  const immediate = await registry.observe(source.id, { type: "watch", target: "Sol" });
  assert.equal(immediate.type, "watch");
  if (immediate.type !== "watch") assert.fail("expected watch result");
  assert.equal(immediate.status, "completed");
  assert.equal(runtimes[0]!.observationNotifications.length, 0);

  const firstRun = target.submit("work", "prompt", "target-run-1");
  await waitFor(() => target.snapshot().execution === "running", "target did not enter running");
  const running = target.snapshot();
  assert.ok(running.runStartedAt);
  assert.equal(running.executionChangedAt, running.runStartedAt);

  const watching = await registry.observe(source.id, { type: "watch", target: target.id });
  assert.equal(watching.type, "watch");
  if (watching.type !== "watch" || watching.status !== "watching") assert.fail("expected active watch");
  runtimes[1]!.settle("finished");
  await firstRun;
  await waitFor(() => runtimes[0]!.observationNotifications.length === 1, "watch completion was not delivered");
  assert.equal(runtimes[0]!.observationNotifications[0]!.watchId, watching.receipt.watchId);
  assert.equal(runtimes[0]!.observationNotifications[0]!.reason, "idle");
  assert.equal(target.snapshot().execution, "idle");
  assert.equal(target.snapshot().runStartedAt, undefined);

  const secondRun = target.submit("more work", "prompt", "target-run-2");
  await waitFor(() => target.snapshot().execution === "running", "target did not enter its second run");
  const cancellable = await registry.observe(source.id, { type: "watch", target: "sol" });
  if (cancellable.type !== "watch" || cancellable.status !== "watching") assert.fail("expected cancellable watch");
  const cancelled = await registry.observe(source.id, { type: "cancel", watchId: cancellable.receipt.watchId });
  assert.deepEqual(cancelled, { type: "cancel", cancelledWatchIds: [cancellable.receipt.watchId] });
  runtimes[1]!.settle("cancelled watch target finished");
  await secondRun;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(runtimes[0]!.observationNotifications.length, 1);

  const thirdRun = target.submit("final work", "prompt", "target-run-3");
  await waitFor(() => target.snapshot().execution === "running", "target did not enter its third run");
  await registry.observe(source.id, { type: "watch", target: "sol" });
  await registry.configureObservation(source.id, false, "grant-off");
  runtimes[1]!.settle("disabled watch target finished");
  await thirdRun;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(runtimes[0]!.observationNotifications.length, 1);
  await assert.rejects(registry.observe(source.id, { type: "list" }), /not granted/u);
});
