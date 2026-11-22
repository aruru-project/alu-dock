import assert from "node:assert/strict";
import test from "node:test";

import { AssistantChildrenElsewhere } from "../src/control/assistant-children-elsewhere.js";
import type { WorkMessage } from "../src/core/dock-tools.js";
import type { InstanceSnapshot } from "../src/core/managed-instance.js";
import type { MachineRouteRecord } from "../src/control/machine-state.js";

const work = (fields: Partial<InstanceSnapshot>): InstanceSnapshot => ({ lifecycle: "active", runtimeGeneration: 1, ...fields }) as InstanceSnapshot;
const route = (mainInstanceId: string, creationOperationId: string, fields: Partial<InstanceSnapshot> = {}): MachineRouteRecord => ({
  mainInstanceId, nativeInstanceId: `${mainInstanceId}-native`,
  snapshot: work({ id: mainInstanceId, creationOperationId, parentId: "alu", hostId: "sub", ...fields }),
});
const note = (nativeId: string): WorkMessage => ({ type: "message", from: { relation: "child", id: nativeId, name: "Lead" }, text: "hi" });

// Card #676 (user decision 2026-11-22): her child Works on other Machines belong to the run of her that started
// them. Another run, or Main after a restart, never hears from them; they stop, and an offline Machine's wait
// until it reconnects, since they cannot use models meanwhile.
test("Main keeps the assistant's child Works on other Machines to the run of her that started them", async () => {
  let her = work({ id: "alu", runtimeGeneration: 3 });
  let remote: InstanceSnapshot[] = [];
  let online = true;
  const delivered: Array<{ parentId: string; message: WorkMessage }> = [];
  const stopped: string[] = [];
  const speeds: string[] = [];
  const elsewhere = new AssistantChildrenElsewhere({
    local: (id) => id === "alu" ? her : id === "pi" ? work({ id: "pi" }) : undefined,
    snapshots: () => [her, ...remote],
    isResidentAssistant: (id) => id === "alu",
    machineAvailable: async () => online,
    deliver: async (parentId, message) => { delivered.push({ parentId, message }); },
    stop: async (id) => { stopped.push(id); },
    speedOf: () => "fast",
    sendSpeed: async (machineId, parentId, tier) => { speeds.push(`${machineId}:${parentId}:${tier}`); },
  });

  // Only a creation Main is making for her names her as a parent on that Machine, and her speed goes ahead of it.
  assert.equal(elsewhere.expected("sub", "spawn-1", "alu"), false);
  elsewhere.starting("sub", "spawn-1", her);
  assert.deepEqual(speeds, ["sub:alu:fast"]);
  assert.equal(elsewhere.expected("sub", "spawn-1", "alu"), true);
  assert.equal(elsewhere.expected("other", "spawn-1", "alu"), false);
  assert.equal(elsewhere.expected("sub", "spawn-1", "pi"), false);
  elsewhere.started("spawn-1", true);
  assert.equal(elsewhere.expected("sub", "spawn-1", "alu"), false, "it is created once");

  // What it tells her reaches her under Main's ID, and only from where it runs.
  const lead = route("lead", "spawn-1");
  await elsewhere.deliver("sub", lead, "alu", note("lead-native"));
  assert.deepEqual(delivered, [{ parentId: "alu", message: { ...note("lead-native"), from: { relation: "child", id: "lead", name: "Lead" } } }]);
  await assert.rejects(elsewhere.deliver("other", lead, "alu", note("lead-native")));

  // Its Machine reports it with one Main did not start for her: that one stops, hers stays, and hears her speed again.
  elsewhere.reconciled("sub", [lead, route("stray", "unknown"), route("helper", "helper-op", { parentId: "lead" })], true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, ["stray"]);
  assert.deepEqual(speeds, ["sub:alu:fast", "sub:alu:fast"]);

  // She restarted: the child Work of her earlier run no longer reaches her and stops.
  her = work({ id: "alu", runtimeGeneration: 4 });
  await assert.rejects(elsewhere.deliver("sub", lead, "alu", note("lead-native")), /no longer running/u);
  elsewhere.reconciled("sub", [lead], false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, ["stray", "lead"]);

  // She stops while its Machine is offline: it stays until the Machine reconnects, then stops.
  elsewhere.starting("sub", "spawn-2", her);
  elsewhere.started("spawn-2", true);
  const second = route("second", "spawn-2");
  remote = [second.snapshot];
  online = false;
  await elsewhere.retire("alu");
  assert.deepEqual(stopped, ["stray", "lead"]);
  await assert.rejects(elsewhere.deliver("sub", second, "alu", note("second-native")));
  elsewhere.reconciled("sub", [second], true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, ["stray", "lead", "second"]);

  // With its Machine connected, her stop reaches it at once.
  online = true;
  stopped.length = 0;
  await elsewhere.retire("alu");
  assert.deepEqual(stopped, ["second"]);

  // A report sent before it existed does not make Main forget it; one after it was reported does: it left.
  elsewhere.starting("sub", "spawn-3", her);
  elsewhere.started("spawn-3", true);
  const third = route("third", "spawn-3");
  elsewhere.reconciled("sub", [], false);
  await elsewhere.deliver("sub", third, "alu", note("third-native"));
  elsewhere.reconciled("sub", [third], false);
  elsewhere.reconciled("sub", [], false);
  await assert.rejects(elsewhere.deliver("sub", third, "alu", note("third-native")), /no longer running/u);
});
