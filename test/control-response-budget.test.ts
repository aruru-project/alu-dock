import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

// 2026-09-18: alu's valid history fitted with 3 bytes to spare, then Main added
// 48 bytes of hostId and rejected the whole response. Exercise the actual socket
// entrypoints; only the Agent is a static fixture, with no Pi/model/user files.
test("Main opens and pages near-limit conversation history without losing records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-response-budget-"));
  const runtime = new DelayedAgentWorkerConnection("budget-session");
  const registry = new DockRegistry(async ({ id, creationOperationId, hostEpoch, cwd }) => (
    new ManagedInstance({ id, creationOperationId, hostEpoch, cwd, session: runtime })
  ));
  const controller = new MainMachineController({
    state: new MainMachineState(join(directory, "main")),
    mainHostEpoch: registry.hostEpoch,
    localSnapshots: () => registry.list(),
  });
  const host = new DockHost({ socketPath: join(directory, "dock.sock"), registry, remoteInstances: controller });
  const requestId = "r".repeat(36);
  const client = new DockClient({ socketPath: host.socketPath, requestId: () => requestId });
  context.after(async () => {
    client.closeActiveConnections();
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await host.start();
  const work = await client.create(directory);
  const instance = registry.get(work.id);
  const wireBytes = (result: unknown) => Buffer.byteLength(JSON.stringify({
    kind: "response", version: 2, requestId, hostEpoch: registry.hostEpoch, ok: true, result,
  }) + "\n");

  for (const mode of ["bootstrap", "history"] as const) {
    await context.test(mode, async () => {
      runtime.history = Array.from({ length: 100 }, (_, index) => ({
        recordId: `record-${index}`, entryId: `record-${index}`, kind: "custom", source: "extension",
        visibility: "metadata", content: [], metadata: { note: Array.from({ length: 20 }, () => "x".repeat(500)) },
      }));
      runtime.emit({ type: "conversation_checkpoint" });
      const unprojected = async () => {
        if (mode === "history") return instance.getHistoryPage(undefined, 200);
        const projection = await instance.getAttachProjection(undefined, 200, "conversation_bootstrap");
        return {
          instance: projection.instance,
          page: { ...projection.page, epochChanged: false, generationChanged: false },
          recentHistory: projection.recentHistory,
          historyRevision: projection.historyRevision,
          historyTruncated: projection.historyTruncated,
          pendingMessages: projection.pendingMessages,
        };
      };
      // Size the fixture, not the expected output: the published 1 MiB wire
      // contract and incident's 3-byte headroom are independent literals.
      const padding = 1_048_573 - wireBytes(await unprojected());
      assert.ok(padding > 0);
      const notes = (runtime.history[99]!.metadata as { note: string[] }).note;
      let remaining = padding;
      for (let index = 0; index < notes.length && remaining > 0; index += 1) {
        const added = Math.min(remaining, 7_000);
        notes[index] += "x".repeat(added);
        remaining -= added;
      }
      assert.equal(remaining, 0);
      runtime.emit({ type: "conversation_checkpoint" });
      assert.equal(wireBytes(await unprojected()), 1_048_573);

      const expected = structuredClone(runtime.history);
      const records = [];
      let beforeEntryId: string | undefined;
      if (mode === "bootstrap") {
        const result = await client.read(work.id, undefined, "conversation_bootstrap");
        assert.equal(result.instance.hostId, controller.mainHostId());
        assert.equal(result.historyTruncated, true);
        assert.ok(result.recentHistory.length > 0 && result.recentHistory.length < 100);
        records.push(...result.recentHistory);
        beforeEntryId = result.recentHistory[0]!.entryId;
      } else {
        const result = await client.history(work.id, undefined, 200);
        assert.equal(result.instance.hostId, controller.mainHostId());
        assert.equal(result.hasEarlier, true);
        assert.ok(result.entries.length > 0 && result.entries.length < 100);
        records.push(...result.entries);
        beforeEntryId = result.nextBeforeEntryId;
      }
      while (beforeEntryId) {
        const earlier = await client.history(work.id, beforeEntryId, 200);
        records.unshift(...earlier.entries);
        beforeEntryId = earlier.nextBeforeEntryId;
      }
      assert.deepEqual(JSON.parse(JSON.stringify(records)), expected, "every original record remains available across pages");
    });
  }
});
