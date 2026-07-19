import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import type { DockEvent, InstanceSnapshot } from "../src/core/managed-instance.js";
import {
  abortingActivity,
  activityFromReplay,
  activityFromSnapshot,
  reduceRunActivity,
  submittingActivity,
} from "../src/tui/run-activity.js";
import { ActivityPulseController } from "../src/tui/activity-pulse.js";
import { DockActivityLine } from "../src/tui/conversation.js";
import { filterSearchableItems } from "../src/tui/search-filter.js";
import { SearchablePicker } from "../src/tui/searchable-picker.js";
import { ExtensionTextDialog } from "../src/tui/extension-text-dialog.js";
import { pickerContentRowBudget, shouldApplyInitialHistory, snapshotIsNotOlder } from "../src/tui/dock-tui.js";
import { SessionTreeSurface } from "../src/tui/session-tree-surface.js";
import { FixedActionDialog, WorkModalFrame } from "../src/tui/work-modal.js";
import { projectSnapshot } from "../src/tui/snapshot-projection.js";
import type { TreeNodeDto } from "../src/core/instance-dto.js";

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
    toolsExpanded: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 1 },
    ...overrides,
    compacting: overrides.compacting ?? false,
  };
}

test("same-generation navigation permanently preempts a stale initial history drain", () => {
  assert.equal(shouldApplyInitialHistory(true, undefined, undefined, 1, 1), true);
  assert.equal(shouldApplyInitialHistory(false, undefined, undefined, 1, 1), false, "cleared navigation tokens must not revive initial history");
  assert.equal(shouldApplyInitialHistory(true, undefined, "1:7", 1, 1), false);
  assert.equal(shouldApplyInitialHistory(true, 2, undefined, 2, 1), false);
});

test("tool-expansion mutation receipts cannot overwrite newer stream truth", () => {
  const current = snapshot({
    toolsExpanded: false,
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 7 },
  });
  assert.equal(snapshotIsNotOlder(snapshot({
    toolsExpanded: true,
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 6 },
  }), current), false);
  assert.equal(snapshotIsNotOlder(snapshot({
    toolsExpanded: true,
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 7 },
  }), current), true);
  assert.equal(snapshotIsNotOlder(snapshot({
    eventCursor: { hostEpoch: "other-epoch", instanceId: "dock-1", runtimeGeneration: 1, sequence: 8 },
  }), current), false);
});

test("activity pulse schedules cached frame renders and has no idle timer", () => {
  const activity = new DockActivityLine();
  let renderRequests = 0;
  let scheduled: (() => void) | undefined;
  let schedules = 0;
  let cancels = 0;
  const controller = new ActivityPulseController(activity, {
    requestRender: () => { renderRequests += 1; },
  }, {
    setInterval: (callback) => {
      scheduled = callback;
      schedules += 1;
      return { unref() {} } as NodeJS.Timeout;
    },
    clearInterval: () => { cancels += 1; },
  });
  activity.setAnimationListener(() => controller.sync());
  controller.setEnabled(true);
  assert.equal(schedules, 0, "idle must not schedule animation");

  activity.setActivity({ phase: "waiting", label: "waiting for model" });
  assert.equal(schedules, 1);
  const firstFrame = activity.render(43)[0];
  scheduled?.();
  const secondFrame = activity.render(43)[0];
  scheduled?.();
  assert.equal(renderRequests, 2);
  assert.notEqual(firstFrame, secondFrame);

  activity.setActivity({ phase: "idle", label: "ready" });
  assert.equal(cancels, 1);
  assert.equal(controller.pulseNow(), false);
  assert.equal(renderRequests, 2);
  controller.stop();
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
  picker.setBody("Inventory loaded");
  picker.setEmptyText("No persisted sessions");
  picker.replaceItems([{ value: "late", label: "Missing session arrived" }]);
  assert.equal(picker.getQuery(), "localmissing");
  assert.equal(picker.getFilteredItems().length, 0);
  assert.match(picker.render(40).join("\n"), /Inventory loaded|No persisted sessions/);
  let cancelled = false;
  picker.onCancel = () => { cancelled = true; };
  picker.handleInput("\u001b");
  assert.equal(cancelled, true);
});

test("resized 80x24 searchable Work modals retain selection, position, and footer inside their row budget", () => {
  let terminalRows = 40;
  const picker = new SearchablePicker(
    Array.from({ length: 40 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}`, description: "bounded choice" })),
    {
      title: "Bounded picker",
      body: "A deliberately long status body that wraps while the modal remains fully operable on a standard SSH viewport.",
      maxVisible: 14,
      maxRows: () => pickerContentRowBudget(terminalRows),
      pageNavigation: true,
      requestRender: () => {},
    },
  );
  const frame = new WorkModalFrame(picker);
  assert.ok(frame.render(64).length <= pickerContentRowBudget(terminalRows) + 2);
  terminalRows = 24;
  frame.render(64);
  picker.handleInput("\u001b[6~");
  const rendered = frame.render(64);
  assert.ok(rendered.length <= 19, "80% of 24 rows leaves 19 complete overlay rows");
  assert.match(rendered.join("\n"), /Item 8/u);
  assert.match(rendered.join("\n"), /\(9\/40\)/u);
  assert.match(rendered.at(-2) ?? "", /Enter select/u);
  assert.match(rendered.at(-1) ?? "", /^╰─/u);
});

test("resized 80x24 extension editor modals keep clipped-content markers and footer visible", () => {
  const terminal = { rows: 40 };
  const tui = { terminal, requestRender: () => {} } as unknown as TUI;
  const dialog = new ExtensionTextDialog({
    mode: "editor",
    title: "Extension editor",
    placeholder: "A long placeholder that wraps across substantially more than two lines so its bounded presentation must disclose omitted guidance rather than silently clipping it.",
    prefill: Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")} ${"x".repeat(60)}`).join("\n"),
    requestRender: () => {},
    tui,
    maxRows: () => pickerContentRowBudget(terminal.rows),
  });
  dialog.focused = true;
  const frame = new WorkModalFrame(dialog);
  assert.ok(frame.render(40).length <= pickerContentRowBudget(40) + 2);
  terminal.rows = 24;
  for (let index = 0; index < 40; index += 1) dialog.handleInput("\u001b[A");
  const rendered = frame.render(40);
  assert.ok(rendered.length <= 19);
  assert.match(rendered.join("\n"), /…/u, "clipped placeholder is disclosed");
  assert.match(rendered.join("\n"), /↓/u, "content below the editor viewport is disclosed");
  assert.match(rendered.at(-2) ?? "", /Enter submit/u);
  assert.match(rendered.at(-1) ?? "", /^╰─/u);
});

test("dedicated tree surface handles filters, search clearing, branch keys, and responsive semantic rows", () => {
  const tree: TreeNodeDto[] = [
    { entryId: "root", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "start", hasChildren: true },
    { entryId: "branch-a", parentId: "root", depth: 1, kind: "message", role: "user", displayClass: "content", summary: "approach alpha", hasChildren: true },
    { entryId: "error-a", parentId: "branch-a", depth: 2, kind: "message", role: "assistant", displayClass: "content", state: "error", summary: "WebSocket error", hasChildren: false },
    { entryId: "wrapper-b", parentId: "root", depth: 1, kind: "message", role: "assistant", displayClass: "structural", summary: "Tool call: alu_kanban", hasChildren: true },
    { entryId: "tool-b", parentId: "wrapper-b", depth: 2, kind: "message", role: "tool", displayClass: "tool", summary: "[alu_kanban: get_card · card #185]", hasChildren: true },
    { entryId: "compact-b", parentId: "tool-b", depth: 3, kind: "compaction", displayClass: "content", summary: "[compaction: 42k tokens]", hasChildren: false },
  ];
  let renders = 0;
  let cancelled = 0;
  let selected: string | undefined;
  const surface = new SessionTreeSurface({ title: "Session Tree", initialFilter: "default", terminalRows: () => 24, requestRender: () => { renders += 1; } });
  surface.onCancel = () => { cancelled += 1; };
  surface.onSelect = (node) => { selected = node.entryId; };
  surface.replaceTree(tree, "compact-b");
  surface.focused = true;

  const initial = surface.render(80).join("\n");
  assert.match(initial, /\[alu_kanban: get_card · card #185\]/u);
  assert.match(initial, /WebSocket error/u);
  assert.match(initial, /\[compaction: 42k tokens\]/u);
  assert.doesNotMatch(initial, /Tool call: alu_kanban/u, "structural tool-call wrappers stay hidden");
  assert.ok(surface.render(43).every((line) => visibleWidth(line) <= 43));
  assert.ok(surface.render(120).every((line) => visibleWidth(line) <= 120));

  surface.handleInput("\x0f"); // Ctrl+O: no-tools
  assert.equal(surface.getFilterMode(), "no-tools");
  assert.doesNotMatch(surface.render(80).join("\n"), /alu_kanban/u);
  surface.handleInput("\x15"); // Ctrl+U: user-only
  assert.equal(surface.getFilterMode(), "user-only");
  surface.handleInput("alpha");
  assert.equal(surface.getQuery(), "alpha");
  surface.handleInput("\x1b");
  assert.equal(surface.getQuery(), "");
  assert.equal(cancelled, 0, "first Escape clears local search state");
  surface.handleInput("\x1b");
  assert.equal(cancelled, 1);

  surface.handleInput("\x04"); // Ctrl+D: default
  surface.handleInput("\r");
  assert.ok(selected);
  assert.ok(renders > 0);
});

test("fixed Work actions have a visible modal boundary, target context, and no search field", () => {
  let selected: string | undefined;
  let cancelled = 0;
  const dialog = new FixedActionDialog("Branch action", ["Target: user: verify Windows input", "user · d2b26f41"], [
    { value: "navigate", label: "Navigate directly", description: "Switch without summarization." },
    { value: "summary", label: "Navigate with summary", description: "Ask Pi to summarize first." },
    { value: "custom", label: "Summary with additional instructions" },
    { value: "replace", label: "Summary with replacement instructions" },
  ], "navigate");
  dialog.onSelect = (value) => { selected = value; };
  dialog.onCancel = () => { cancelled += 1; };
  const frame = new WorkModalFrame(dialog);
  frame.focused = true;
  const rendered = frame.render(80).join("\n");
  assert.match(rendered, /^╭─/u);
  assert.match(rendered, /Target: user: verify Windows input/u);
  assert.match(rendered, /Navigate directly/u);
  assert.doesNotMatch(rendered, /Search|type to filter/u);
  assert.ok(frame.render(43).every((line) => visibleWidth(line) <= 43));
  assert.ok(frame.render(43).length <= 15);
  frame.handleInput("\x1b[B");
  frame.handleInput("\r");
  assert.equal(selected, "summary");
  frame.handleInput("\x1b");
  assert.equal(cancelled, 1);
});

test("tree picker uses left/right and page keys for clamped page movement", () => {
  const picker = new SearchablePicker(
    Array.from({ length: 30 }, (_, index) => ({ value: `entry-${index}`, label: `Entry ${index}` })),
    { title: "Tree", maxVisible: 10, pageNavigation: true, requestRender: () => {} },
  );
  picker.handleInput("\u001b[D");
  assert.equal(picker.getSelectedItem()?.value, "entry-0");
  picker.handleInput("\u001b[C");
  assert.equal(picker.getSelectedItem()?.value, "entry-10");
  picker.handleInput("\u001b[6~");
  picker.handleInput("\u001b[6~");
  assert.equal(picker.getSelectedItem()?.value, "entry-29");
  picker.handleInput("\u001b[5~");
  assert.equal(picker.getSelectedItem()?.value, "entry-19");
});

test("run activity keeps tool telemetry orthogonal while recovering authoritative attach state", () => {
  const events = [
    event(1, "run.started", { operationId: "op-1", delivery: "prompt" }),
    event(2, "tool.started", { toolCallId: "t-1", toolName: "read", args: {}, omittedFields: [] }),
  ];
  assert.equal(activityFromReplay(snapshot(), events).label, "waiting for model");
  assert.equal(activityFromReplay(snapshot({ execution: "idle", lastRun: "succeeded" }), events).phase, "idle");
  assert.deepEqual(activityFromReplay(snapshot({ compacting: true }), []), {
    phase: "compaction",
    label: "compacting context",
  });
});

test("command handled clears client-local submission activity without inventing a model wait", () => {
  let activity = submittingActivity();
  activity = reduceRunActivity(activity, event(1, "command.accepted", {
    operationId: "no-run-1", delivery: "prompt", queued: false, acceptedAt: "2026-07-15T00:00:00.000Z",
  }), snapshot());
  assert.equal(activity.phase, "submitting");
  activity = reduceRunActivity(activity, event(2, "instance.state_changed", {
    reason: "command_accepted", lifecycle: "active", execution: "running", compacting: false, lastRun: "never",
    pending: { steering: 0, followUp: 0, total: 0 }, activeCommandId: "no-run-1",
  }), snapshot());
  assert.equal(activity.phase, "submitting");

  activity = reduceRunActivity(activity, event(3, "command.handled", {
    operationId: "no-run-1", kind: "extension_command",
  }), snapshot());
  assert.equal(activity.phase, "submitting");
  activity = reduceRunActivity(activity, event(4, "instance.state_changed", {
    reason: "command_handled_without_run", lifecycle: "active", execution: "idle", compacting: false, lastRun: "never",
    pending: { steering: 0, followUp: 0, total: 0 }, activeCommandId: undefined,
  }), snapshot({ execution: "idle" }));
  assert.deepEqual(activity, { phase: "idle", label: "ready" });

  activity = reduceRunActivity(activity, event(5, "command.handled", {
    operationId: "no-run-2", kind: "no_run",
  }), snapshot({ execution: "idle", pending: { steering: 0, followUp: 2, total: 2 } }));
  assert.deepEqual(activity, { phase: "idle", label: "ready" });

  const parent = snapshot({ activeCommandId: "parent-op" });
  activity = { phase: "responding", label: "responding" };
  activity = reduceRunActivity(activity, event(4, "command.accepted", {
    operationId: "extension-op", delivery: "prompt", queued: false, acceptedAt: "2026-07-15T00:00:00.000Z",
  }), parent);
  assert.deepEqual(activity, { phase: "responding", label: "responding" });
  activity = reduceRunActivity(activity, event(5, "command.handled", {
    operationId: "extension-op", kind: "extension_command",
  }), parent);
  assert.deepEqual(activity, { phase: "responding", label: "responding" });
  activity = reduceRunActivity(activity, event(6, "extension.notification", {
    level: "info", message: "Kanban status",
  }), parent);
  assert.deepEqual(activity, { phase: "responding", label: "responding" });

  const idle = snapshot({ execution: "idle", lastRun: "succeeded" });
  assert.deepEqual(reduceRunActivity(activityFromSnapshot(idle), event(7, "extension.notification", {
    level: "info", message: "rm-confirm ON",
  }), idle), { phase: "idle", label: "ready" });
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
  assert.deepEqual(activity, { phase: "idle", label: "ready" });
  activity = reduceRunActivity(activity, event(2, "instance.state_changed", {
    reason: "compaction_completed", lifecycle: "active", execution: "running", compacting: false, lastRun: "never",
    pending: { steering: 0, followUp: 0, total: 0 }, activeCommandId: undefined, lastError: undefined,
  }), running);
  assert.deepEqual(activity, { phase: "waiting", label: "waiting for model" });
  let guardActivity = reduceRunActivity(
    { phase: "compaction", label: "compacting context" },
    event(2, "run.settled", { operationId: "guard-run", result: "succeeded", stopReason: "stop" }),
    running,
  );
  assert.deepEqual(guardActivity, { phase: "compaction", label: "compacting context" });
  guardActivity = reduceRunActivity(guardActivity, event(2, "compaction.completed", {
    operationId: "guard-compaction", automatic: false, willRetry: false,
  }), running);
  assert.deepEqual(guardActivity, { phase: "waiting", label: "waiting for model" });
  guardActivity = reduceRunActivity(guardActivity, event(2, "run.started", {
    operationId: "runtime-initiated",
  }), running);
  assert.deepEqual(guardActivity, { phase: "waiting", label: "waiting for model" });
  activity = reduceRunActivity(activity, event(2, "compaction.completed", {
    operationId: "compact-cancelled", automatic: false, willRetry: false, aborted: true,
  }), idle);
  assert.deepEqual(activity, { phase: "idle", label: "ready" });

  const pending = snapshot({ execution: "idle", pending: { steering: 0, followUp: 2, total: 2 } });
  activity = reduceRunActivity(activity, event(3, "compaction.completed", {
    operationId: "compact-collision", automatic: false, willRetry: false,
    error: "Provider wrote an entry, then said nothing to compact while closing",
  }), idle);
  assert.deepEqual(activity, { phase: "idle", label: "ready" });

  activity = reduceRunActivity(activity, event(4, "queue.changed", { steering: 0, followUp: 2, total: 2 }), pending);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "idle", label: "ready" });
  activity = { phase: "waiting", label: "waiting for model" };
  activity = reduceRunActivity(activity, event(5, "message.submitted", {
    operationId: "queued-op", messageId: "user-queued-op", role: "user", text: "consumed", delivery: "followUp", queueItemId: "queue-1",
  }), running);
  assert.equal(activity.phase, "waiting", "queue consumption preserves model activity");

  activity = reduceRunActivity(activity, event(6, "interaction.requested", {
    interactionId: "interaction-1", method: "confirm", title: "Proceed?", timeoutAt: "2026-07-15T00:01:00.000Z",
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "interaction", label: "waiting for confirm" });
  assert.equal(abortingActivity().phase, "aborting");

  activity = reduceRunActivity(activity, event(7, "run.retry_completed", {
    attempt: 3, success: false, error: "offline",
  }), running);
  assert.equal(activity.phase, "error");
  activity = reduceRunActivity(activity, event(8, "run.settled", {
    operationId: "op-1", result: "failed", error: "offline",
  }), snapshot({ execution: "failed", lastRun: "failed" }));
  assert.deepEqual(activity, { phase: "error", label: "run failed" });
  assert.deepEqual(
    activityFromSnapshot(snapshot({ lifecycle: "host_lost", execution: "unavailable" })),
    { phase: "disconnected", label: "host lost" },
  );
});

test("runtime-error state projection cannot regress authoritative Activity to ready", () => {
  const failure = event(1, "instance.runtime_error", {
    operationId: "replace-1", kind: "resume", error: "replacement failed",
  });
  let projected = projectSnapshot(snapshot(), failure);
  let activity = reduceRunActivity(activityFromSnapshot(snapshot()), failure, projected);
  assert.deepEqual(activity, { phase: "error", label: "runtime error" });

  const state = event(2, "instance.state_changed", {
    reason: "runtime_replacement_failed", lifecycle: "runtime_error", execution: "unavailable", compacting: false,
    lastRun: "interrupted", pending: { steering: 0, followUp: 0, total: 0 }, activeCommandId: undefined,
    lastError: "replacement failed",
  });
  projected = projectSnapshot(projected, state);
  activity = reduceRunActivity(activity, state, projected);
  assert.equal(projected.lifecycle, "runtime_error");
  assert.deepEqual(activity, { phase: "error", label: "runtime error" });
});

test("run activity distinguishes model phases while tools remain conversation-only", () => {
  const running = snapshot();
  let activity = submittingActivity();
  activity = reduceRunActivity(activity, event(1, "command.accepted", {
    operationId: "op-1", delivery: "prompt", queued: false, acceptedAt: "2026-07-15T00:00:00.000Z",
  }), running);
  assert.equal(activity.phase, "submitting");
  activity = reduceRunActivity(activity, event(2, "run.started", {
    operationId: "op-1",
  }), running);
  assert.equal(activity.phase, "waiting");

  activity = reduceRunActivity(activity, event(3, "message.delta", {
    messageId: "a-1", block: "thinking", delta: "plan",
  }), running);
  assert.equal(activity.phase, "thinking");

  activity = reduceRunActivity(activity, event(4, "message.delta", {
    messageId: "a-1", block: "text", delta: "answer",
  }), running);
  assert.equal(activity.phase, "responding");

  activity = reduceRunActivity(activity, event(5, "tool.started", {
    toolCallId: "t-1", toolName: "read", args: {}, omittedFields: [],
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "responding", label: "responding" });
  activity = reduceRunActivity(activity, event(6, "message.completed", {
    messageId: "a-1", role: "assistant", content: [{ type: "tool_call", toolCallId: "t-1", toolName: "read", args: {} }],
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "waiting", label: "waiting for model" });

  activity = reduceRunActivity(activity, event(7, "tool.completed", {
    toolCallId: "t-1", toolName: "read", text: "done", isError: false, omittedFields: [],
  }), running);
  assert.equal(activity.phase, "waiting");

  activity = reduceRunActivity(activity, event(8, "run.retry_started", {
    attempt: 2, maxAttempts: 3, delayMs: 100, error: "retry",
  }), running);
  assert.equal(activity.label, "retry 2/3");

  const idle = snapshot({ execution: "idle", lastRun: "succeeded" });
  activity = reduceRunActivity(activity, event(9, "run.settled", {
    operationId: "op-1", result: "succeeded",
  }), idle);
  assert.deepEqual(activity, activityFromSnapshot(idle));
  assert.equal(activity.phase, "idle");
});
