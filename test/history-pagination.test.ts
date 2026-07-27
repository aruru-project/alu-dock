import assert from "node:assert/strict";
import test from "node:test";

import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../src/core/instance-dto.js";
import { drainFullHistory, HISTORY_PAGE_SIZE, reconcileFlowingEvents } from "../src/tui/history-pagination.js";

function entry(index: number): HistoryEntryDto {
  const entryId = `entry-${index}`;
  return {
    recordId: entryId,
    entryId,
    kind: "message",
    source: index % 2 === 0 ? "user" : "assistant",
    visibility: "conversation",
    content: [{ type: "text", text: `history ${index}` }],
  };
}

function snapshot(sequence = 1, overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id: "dock-1",
    creationOperationId: "create-1",
    cwd: "/tmp/project",
    lifecycle: "active",
    execution: "idle",
    compacting: false,
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: "pi-1" },
    extensionStatus: {},
    toolsExpanded: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence },
    ...overrides,
  };
}

test("eager history drain retains all 8,500 entries in oldest-to-newest order", async () => {
  const all = Array.from({ length: 8_500 }, (_, index) => entry(index));
  const seed = all.slice(-100);
  let loads = 0;
  const result = await drainFullHistory("dock-1", 1, 7, seed, true, async (beforeEntryId) => {
    loads += 1;
    assert.ok(beforeEntryId);
    const before = Number(beforeEntryId.slice("entry-".length));
    const start = Math.max(0, before - HISTORY_PAGE_SIZE);
    return {
      historyRevision: 7,
      entries: all.slice(start, before),
      hasEarlier: start > 0,
      ...(start > 0 ? { nextBeforeEntryId: `entry-${start}` } : {}),
      instance: snapshot(loads + 1),
    };
  });
  assert.equal(result.entries.length, 8_500);
  assert.equal(result.entries[0]?.entryId, "entry-0");
  assert.equal(result.entries.at(-1)?.entryId, "entry-8499");
  assert.equal(new Set(result.entries.map((item) => item.entryId)).size, 8_500);
});

test("eager history drain deduplicates page overlap without changing order", async () => {
  const seed = [entry(4), entry(5), entry(5)];
  const result = await drainFullHistory("dock-1", 1, 7, seed, true, async (beforeEntryId) => {
    assert.equal(beforeEntryId, "entry-4");
    return { historyRevision: 7, entries: [entry(0), entry(1), entry(2), entry(3), entry(4), entry(3)], hasEarlier: false, instance: snapshot(20) };
  });
  assert.deepEqual(result.entries.map((item) => item.entryId), ["entry-0", "entry-1", "entry-2", "entry-3", "entry-4", "entry-5"]);
});

test("history drain rejects an incomplete empty seed instead of mixing read boundaries", async () => {
  await assert.rejects(
    drainFullHistory("dock-1", 1, 7, [], true, async () => {
      throw new Error("must not load across a second live boundary");
    }),
    /incomplete without a continuation entry/u,
  );
});

test("nonempty seed earlier pages never advance the live reconciliation boundary", async () => {
  const result = await drainFullHistory("dock-1", 1, 7, [entry(2), entry(3)], true, async () => ({
    historyRevision: 7,
    entries: [entry(0), entry(1), entry(2)],
    hasEarlier: false,
    instance: snapshot(500),
  }));
  assert.deepEqual(result.entries.map((item) => item.entryId), ["entry-0", "entry-1", "entry-2", "entry-3"]);
});

test("eager history drain rejects stalled cursors", async () => {
  await assert.rejects(
    drainFullHistory("dock-1", 1, 7, [entry(4)], true, async () => ({
      historyRevision: 7, entries: [entry(2), entry(3)], hasEarlier: true, nextBeforeEntryId: "entry-4", instance: snapshot(),
    })),
    /cursor did not advance/u,
  );
});

test("eager history drain rejects instance or generation changes", async () => {
  await assert.rejects(
    drainFullHistory("dock-1", 1, 7, [entry(2)], true, async () => ({
      historyRevision: 7, entries: [entry(0), entry(1)], hasEarlier: false, instance: snapshot(2, { runtimeGeneration: 2 }),
    })),
    /Session changed while history was loading/u,
  );
  await assert.rejects(
    drainFullHistory("dock-1", 1, 7, [entry(2)], true, async () => ({
      historyRevision: 7, entries: [entry(0), entry(1)], hasEarlier: false, instance: snapshot(2, { id: "other" }),
    })),
    /Session changed while history was loading/u,
  );
});

test("history drain rejects a checkpoint revision change within one scan", async () => {
  await assert.rejects(
    drainFullHistory("dock-1", 1, 7, [entry(2)], true, async () => ({
      historyRevision: 8,
      entries: [entry(0), entry(1)],
      hasEarlier: false,
      instance: snapshot(2),
    })),
    /History changed while history was loading/u,
  );
});

test("flowing bootstrap deduplicates only overlapping event identity", () => {
  const makeEvent = (sequence: number, type: DockEvent["type"], data: Record<string, unknown>): DockEvent => ({
    scope: "instance",
    sequence,
    instanceId: "dock-1",
    runtimeGeneration: 1,
    occurredAt: "2026-07-19T00:00:00.000Z",
    type,
    data,
  }) as DockEvent;
  const submitted = makeEvent(2, "message.submitted", {
    operationId: "op-active", messageId: "message-active", role: "user", text: "active", delivery: "prompt",
  });
  const unresolved = makeEvent(3, "message.delta", {
    messageId: "message-live", role: "assistant", block: "text", delta: "still streaming",
  });
  const feedback = makeEvent(4, "resources.reloaded", { resources: [], diagnostics: [] });

  const reconciled = reconcileFlowingEvents([submitted, unresolved], [unresolved, feedback]);
  assert.deepEqual(reconciled.map((event) => event.sequence), [2, 3, 4]);
  assert.equal(reconciled.filter((event) => event.sequence === 3).length, 1);
});

test("flowing bootstrap never collapses distinct events with identical content", () => {
  const makeSubmitted = (sequence: number, messageId: string): DockEvent => ({
    scope: "instance",
    sequence,
    instanceId: "dock-1",
    runtimeGeneration: 1,
    occurredAt: "2026-07-19T00:00:00.000Z",
    type: "message.submitted",
    data: {
      operationId: `op-${sequence}`,
      messageId,
      role: "user",
      text: "same",
      images: [{ path: `/tmp/${sequence}.png`, mimeType: "image/png" }],
      delivery: "prompt",
    },
  });
  const first = makeSubmitted(8, "message-first");
  const second = makeSubmitted(9, "message-second");

  assert.deepEqual(reconcileFlowingEvents([first], [second]).map((event) => event.sequence), [8, 9]);
});
