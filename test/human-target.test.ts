import assert from "node:assert/strict";
import test from "node:test";

import type { InstanceSnapshot } from "../src/core/managed-instance.js";
import { resolveHumanTarget } from "../src/human-target.js";
import { buildDockHubEntries } from "../src/tui/dock-hub.js";

test("human TARGET resolves exact IDs, unique prefixes, and unique exact names", () => {
  const alpha = instance("019f7005-aaaa-4000-8000-000000000001", "review");
  const beta = instance("019f7005-bbbb-4000-8000-000000000002", "build");
  const instances = [alpha, beta];

  assert.equal(resolveHumanTarget(instances, alpha.id).kind, "resolved");
  assert.equal(resolvedId(resolveHumanTarget(instances, "019f7005-a")), alpha.id);
  assert.equal(resolvedId(resolveHumanTarget(instances, "review")), alpha.id);
  assert.equal(resolveHumanTarget(instances, "019f7005").kind, "ambiguous");
  assert.equal(resolveHumanTarget(instances, "missing").kind, "not_found");
  assert.equal(resolveHumanTarget([alpha], "   ").kind, "not_found");
});

test("human TARGET fails closed when an exact name conflicts with an ID prefix", () => {
  const byPrefix = instance("alpha-1111-4000-8000-000000000001", "first");
  const byName = instance("beta-2222-4000-8000-000000000002", "alpha");
  const duplicateName = instance("gamma-3333-4000-8000-000000000003", "same");
  const duplicateNameTwo = instance("delta-4444-4000-8000-000000000004", "same");

  const mixed = resolveHumanTarget([byPrefix, byName], "alpha");
  assert.equal(mixed.kind, "ambiguous");
  const duplicate = resolveHumanTarget([duplicateName, duplicateNameTwo], "same");
  assert.equal(duplicate.kind, "ambiguous");
});

test("Hub root exposes fixed actions with separate current and history counts", () => {
  const activeOther = instance("active00-0000-4000-8000-000000000001", "other", { cwd: "/other" });
  const recoverable = instance("recover0-0000-4000-8000-000000000002", "recover", {
    cwd: "/project", lifecycle: "host_lost", execution: "unavailable", reopenable: true, ownerHostEpoch: undefined,
  });
  const stopped = instance("stopped0-0000-4000-8000-000000000003", "old", {
    cwd: "/project", lifecycle: "stopped", execution: "unavailable", ownerHostEpoch: undefined,
  });
  const entries = buildDockHubEntries([activeOther, stopped, recoverable], [], "/project", undefined, 0, false, false);
  assert.deepEqual(entries.map((entry) => entry.label), ["New", "Continue · 2", "History · 1", "Pi Sessions", "Settings", "Devices", "Leave Hub"]);
});

function resolvedId(result: ReturnType<typeof resolveHumanTarget>): string {
  assert.equal(result.kind, "resolved");
  return result.instance.id;
}

function instance(id: string, name: string, overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id,
    creationOperationId: `create-${id}`,
    name,
    cwd: "/project",
    lifecycle: "active",
    execution: "idle",
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: "epoch",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: `pi-${id}`, sessionFile: `/sessions/${id}.jsonl` },
    extensionStatus: {},
    toolsExpanded: false,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch", instanceId: id, runtimeGeneration: 1, sequence: 0 },
    ...overrides,
    displayName: overrides.displayName ?? name,
    compacting: overrides.compacting ?? false,
    executionChangedAt: overrides.executionChangedAt ?? "2026-07-14T00:00:00.000Z",
  };
}
