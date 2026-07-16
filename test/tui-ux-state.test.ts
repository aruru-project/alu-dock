import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../src/core/managed-instance.js";
import {
  abortingActivity,
  activityFromReplay,
  activityFromSnapshot,
  reduceRunActivity,
  submittingActivity,
} from "../src/tui/run-activity.js";
import { DockConversation } from "../src/tui/conversation.js";
import { FixedDockScreen } from "../src/tui/pi-tui-screen.js";
import {
  HistoryViewport,
  composeFixedScreen,
  fitFixedScreenChrome,
} from "../src/tui/screen-layout.js";
import { filterSearchableItems } from "../src/tui/search-filter.js";
import { SearchablePicker } from "../src/tui/searchable-picker.js";

function event(sequence: number, type: DockEvent["type"], data: Record<string, unknown>): DockEvent {
  return {
    scope: "instance",
    sequence,
    instanceId: "dock-1",
    runtimeGeneration: 1,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type,
    data,
  } as DockEvent;
}

function snapshot(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id: "dock-1",
    creationOperationId: "create-1",
    cwd: "/tmp/demo",
    lifecycle: "active",
    execution: "running",
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "pi-sdk", piSessionId: "pi-1" },
    extensionStatus: {},
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 1 },
    ...overrides,
  };
}

test("fixed screen keeps the composer immediately above the compact footer", () => {
  const chrome = fitFixedScreenChrome({
    height: 12,
    header: ["header"],
    status: ["status 1", "status 2"],
    help: ["help"],
    editor: ["editor 1", "editor 2"],
  });
  assert.equal(chrome.historyRows, 6);

  const lines = composeFixedScreen({
    height: 12,
    header: chrome.header,
    history: ["history 1", "history 2"],
    status: chrome.status,
    help: chrome.help,
    editor: chrome.editor,
  });
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), "help");
  assert.ok(lines.indexOf("history 2") < lines.indexOf("editor 1"));
  assert.ok(lines.indexOf("editor 2") < lines.indexOf("status 1"));
  assert.ok(lines.indexOf("status 2") < lines.indexOf("help"));
});

test("history viewport auto-follows, locks on page-up, counts unseen output, and returns to bottom", () => {
  const viewport = new HistoryViewport();
  const initial = Array.from({ length: 10 }, (_, index) => `line ${index}`);
  assert.deepEqual(
    viewport.project(initial, 4, { width: 80, revision: 1, outputRevision: 1 }).lines,
    ["line 6", "line 7", "line 8", "line 9"],
  );

  viewport.pageUp();
  let locked = viewport.project(initial, 4, { width: 80, revision: 1, outputRevision: 1 });
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.lines, ["line 4", "line 5", "line 6"]);
  viewport.pageDown();
  assert.equal(viewport.project(initial, 4, { width: 80, revision: 1, outputRevision: 1 }).locked, false);

  viewport.pageUp();
  locked = viewport.project(initial, 4, { width: 80, revision: 1, outputRevision: 1 });
  const withOutput = [...initial, "line 10"];
  const anchored = viewport.project(withOutput, 4, { width: 80, revision: 2, outputRevision: 2 });
  assert.deepEqual(anchored.lines, locked.lines, "new output must not move the historical rows being read");
  assert.equal(anchored.unseenUpdates, 1);

  viewport.scrollToBottom();
  const followed = viewport.project(withOutput, 4, { width: 80, revision: 2, outputRevision: 2 });
  assert.equal(followed.locked, false);
  assert.equal(followed.unseenUpdates, 0);
  assert.deepEqual(followed.lines, ["line 7", "line 8", "line 9", "line 10"]);
});

test("fixed screen preserves an entry-and-row anchor across prepend eviction and resize", () => {
  const conversation = new DockConversation();
  const initial = Array.from({ length: 12 }, (_, index): HistoryEntryDto => ({
    entryId: `entry-${index + 20}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `anchor history ${index + 20} with enough words to wrap at narrow widths` }],
  }));
  conversation.replacePagedHistory({
    entries: initial,
    hasEarlier: true,
    hasNewer: false,
    nextBeforeEntryId: initial[0]!.entryId,
    loadState: "idle",
    generation: 1,
    revision: 1,
  });
  const empty: Component = { render: () => [], invalidate: () => {} };
  const terminal = { rows: 12 };
  const screen = new FixedDockScreen(terminal, {
    header: empty,
    history: conversation,
    status: empty,
    help: empty,
    editor: empty,
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });

  screen.render(42);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const atTop = screen.pageUp();
    screen.render(42);
    if (atTop) break;
  }
  const anchor = screen.captureHistoryAnchor();
  assert.ok(anchor);
  assert.match(anchor.row.entryKey, /^history:entry-/);
  const beforePrepend = screen.render(42);
  const anchoredText = "anchor history 20";
  const anchoredScreenRow = beforePrepend.findIndex((line) => line.includes(anchoredText));
  assert.ok(anchoredScreenRow >= 0);

  conversation.apply(event(90, "message.submitted", {
    operationId: "live-during-page",
    messageId: "live-during-page",
    role: "user",
    text: "live output while the earlier page is loading",
    delivery: "prompt",
  }));
  const older = Array.from({ length: 8 }, (_, index): HistoryEntryDto => ({
    entryId: `entry-${index + 12}`,
    role: "assistant",
    content: [{ type: "text", text: `older history ${index + 12}` }],
  }));
  conversation.replacePagedHistory({
    entries: [...older, ...initial.slice(0, 6), ...initial.slice(-2)],
    hasEarlier: true,
    hasNewer: true,
    nextBeforeEntryId: older[0]!.entryId,
    newerBoundaryEntryId: initial.at(-2)!.entryId,
    loadState: "idle",
    generation: 1,
    revision: 2,
  });
  screen.restoreHistoryAnchor(anchor);
  const afterPrependRows = screen.render(42);
  assert.equal(afterPrependRows.findIndex((line) => line.includes(anchoredText)), anchoredScreenRow);

  const resizeAnchor = screen.captureHistoryAnchor();
  assert.ok(resizeAnchor);
  screen.render(28);
  const afterResize = screen.captureHistoryAnchor();
  assert.equal(afterResize?.row.entryKey, resizeAnchor.row.entryKey);
  assert.equal(afterResize?.screenRow, resizeAnchor.screenRow);

  terminal.rows = 8;
  const heightAnchor = screen.captureHistoryAnchor();
  assert.ok(heightAnchor);
  screen.render(28);
  const afterHeightResize = screen.captureHistoryAnchor();
  assert.equal(afterHeightResize?.row.entryKey, heightAnchor.row.entryKey);
  assert.ok((afterHeightResize?.screenRow ?? 99) <= heightAnchor.screenRow);
});

test("layout-only tool expansion preserves an explicit reveal offset", () => {
  const viewport = new HistoryViewport();
  const collapsed = Array.from({ length: 12 }, (_, index) => `line ${index}`);
  viewport.project(collapsed, 5, { width: 43, revision: 1, outputRevision: 1 });
  viewport.scrollToOffsetFromBottom(4);
  viewport.project(collapsed, 5, { width: 43, revision: 1, outputRevision: 1 });

  const expanded = [...collapsed.slice(0, 6), "detail a", "detail b", "detail c", ...collapsed.slice(6)];
  const projection = viewport.project(expanded, 5, { width: 43, revision: 2, outputRevision: 1 });
  assert.equal(projection.offsetFromBottom, 4);
  assert.equal(projection.unseenUpdates, 0);
});

test("model search ranks name provider and id matches and supports fuzzy subsequences", () => {
  const models = [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", description: "reasoning" },
    { value: "openai-codex/gpt-5.6-sol", label: "GPT 5.6 Sol", description: "OpenAI Codex" },
    { value: "google/gemini-3-pro", label: "Gemini 3 Pro" },
  ];
  assert.equal(filterSearchableItems(models, "codex")[0]?.value, "openai-codex/gpt-5.6-sol");
  assert.equal(filterSearchableItems(models, "sonnet")[0]?.value, "anthropic/claude-sonnet-4");
  assert.equal(filterSearchableItems(models, "g56")[0]?.value, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(filterSearchableItems(models, "missing"), []);
});

test("searchable picker accepts typed filtering while preserving IME focus propagation", () => {
  const picker = new SearchablePicker([
    { value: "fixture/default", label: "Fixture Default" },
    { value: "fixture/local", label: "Fixture\u001b[2J Local", description: "Local\nmodel" },
  ], { title: "Models", requestRender: () => {} });
  picker.focused = true;
  picker.handleInput("local");
  assert.equal(picker.getQuery(), "local");
  assert.equal(picker.getSelectedItem()?.value, "fixture/local");
  assert.equal(picker.getFilteredItems().length, 1);
  const lines = picker.render(40);
  assert.doesNotMatch(lines.join("\n"), /\u001b\[2J|Local\nmodel/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);

  picker.handleInput("missing");
  assert.equal(picker.getFilteredItems().length, 0);
  assert.match(picker.render(40).join("\n"), /No matching items/);
  let cancelled = false;
  picker.onCancel = () => { cancelled = true; };
  picker.handleInput("\u001b");
  assert.equal(cancelled, true);
});

test("run activity recovers the current phase from replay only while the snapshot is running", () => {
  const events = [
    event(1, "run.started", { operationId: "op-1", delivery: "prompt" }),
    event(2, "tool.started", { toolCallId: "t-1", toolName: "read", args: {}, omittedFields: [] }),
  ];
  assert.equal(activityFromReplay(snapshot(), events).label, "tool read");
  assert.equal(activityFromReplay(snapshot({ execution: "idle", lastRun: "succeeded" }), events).phase, "idle");
});

test("run activity covers compaction queue interaction abort failure and host loss", () => {
  const running = snapshot();
  let activity = reduceRunActivity(activityFromSnapshot(running), event(1, "compaction.started", {
    operationId: "compact-1", automatic: true,
  }), running);
  assert.equal(activity.phase, "compaction");

  const idle = snapshot({ execution: "idle", lastRun: "succeeded" });
  activity = reduceRunActivity(activity, event(2, "compaction.completed", {
    operationId: "compact-1", automatic: true, willRetry: false,
  }), idle);
  assert.equal(activity.phase, "idle");

  const pending = snapshot({ execution: "idle", pending: { steering: 0, followUp: 2, total: 2 } });
  activity = reduceRunActivity(activity, event(3, "queue.changed", { steering: 0, followUp: 2, total: 2 }), pending);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "queued", label: "queued 2" });
  activity = reduceRunActivity(activity, event(4, "message.submitted", {
    operationId: "queued-op", messageId: "user-queued-op", role: "user", text: "consumed", delivery: "followUp", queueItemId: "queue-1",
  }), running);
  assert.equal(activity.phase, "waiting");

  activity = reduceRunActivity(activity, event(5, "interaction.requested", {
    interactionId: "interaction-1", method: "confirm", title: "Proceed?", timeoutAt: "2026-07-15T00:01:00.000Z",
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "interaction", label: "waiting for confirm" });
  assert.equal(abortingActivity().phase, "aborting");

  activity = reduceRunActivity(activity, event(6, "run.retry_completed", {
    attempt: 3, success: false, error: "offline",
  }), running);
  assert.equal(activity.phase, "error");
  activity = reduceRunActivity(activity, event(7, "run.settled", {
    operationId: "op-1", result: "failed", error: "offline",
  }), snapshot({ execution: "failed", lastRun: "failed" }));
  assert.equal(activity.phase, "idle");
  assert.deepEqual(
    activityFromSnapshot(snapshot({ lifecycle: "host_lost", execution: "unavailable" })),
    { phase: "disconnected", label: "host lost" },
  );
});

test("run activity distinguishes waiting thinking response tool retry and clears on settlement", () => {
  const running = snapshot();
  let activity = submittingActivity();
  activity = reduceRunActivity(activity, event(1, "command.accepted", {
    operationId: "op-1", delivery: "prompt", queued: false, acceptedAt: "2026-07-15T00:00:00.000Z",
  }), running);
  assert.equal(activity.phase, "waiting");

  activity = reduceRunActivity(activity, event(2, "message.delta", {
    messageId: "a-1", block: "thinking", delta: "plan",
  }), running);
  assert.equal(activity.phase, "thinking");

  activity = reduceRunActivity(activity, event(3, "message.delta", {
    messageId: "a-1", block: "text", delta: "answer",
  }), running);
  assert.equal(activity.phase, "responding");

  activity = reduceRunActivity(activity, event(4, "tool.started", {
    toolCallId: "t-1", toolName: "read", args: {}, omittedFields: [],
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "tool", label: "tool read" });
  activity = reduceRunActivity(activity, event(5, "message.completed", {
    messageId: "a-1", role: "assistant", content: [{ type: "tool_call", toolCallId: "t-1", toolName: "read", args: {} }],
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "tool", label: "tool read" });

  activity = reduceRunActivity(activity, event(6, "tool.completed", {
    toolCallId: "t-1", toolName: "read", text: "done", isError: false, omittedFields: [],
  }), running);
  assert.equal(activity.phase, "waiting");

  activity = reduceRunActivity(activity, event(7, "run.retry_started", {
    attempt: 2, maxAttempts: 3, delayMs: 100, error: "retry",
  }), running);
  assert.equal(activity.label, "retry 2/3");

  const idle = snapshot({ execution: "idle", lastRun: "succeeded" });
  activity = reduceRunActivity(activity, event(8, "run.settled", {
    operationId: "op-1", result: "succeeded",
  }), idle);
  assert.deepEqual(activity, activityFromSnapshot(idle));
  assert.equal(activity.phase, "idle");
});
