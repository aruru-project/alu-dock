import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../src/core/managed-instance.js";
import {
  abortingActivity,
  activityFromReplay,
  activityFromSnapshot,
  reduceRunActivity,
  submittingActivity,
} from "../src/tui/run-activity.js";
import { ActivityPulseController } from "../src/tui/activity-pulse.js";
import { DockActivityLine, DockConversation } from "../src/tui/conversation.js";
import { FixedDockScreen } from "../src/tui/pi-tui-screen.js";
import {
  HistoryViewport,
  composeFixedScreen,
  fitFixedScreenChrome,
} from "../src/tui/screen-layout.js";
import { filterSearchableItems } from "../src/tui/search-filter.js";
import { SearchablePicker } from "../src/tui/searchable-picker.js";
import { ExtensionTextDialog } from "../src/tui/extension-text-dialog.js";
import { pickerContentRowBudget } from "../src/tui/dock-tui.js";
import { SessionTreeSurface } from "../src/tui/session-tree-surface.js";
import { FixedActionDialog, WorkModalFrame } from "../src/tui/work-modal.js";
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
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 1 },
    ...overrides,
    compacting: overrides.compacting ?? false,
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

test("activity slot stays fixed above composer without moving a locked history anchor", () => {
  const conversation = new DockConversation();
  conversation.applyHistory(Array.from({ length: 30 }, (_, index): HistoryEntryDto => ({
    entryId: `activity-history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `activity history row ${index}` }],
  })), false);
  const activity = new DockActivityLine();
  const header: Component = { render: () => ["header"], invalidate: () => {} };
  const status: Component = { render: () => ["status one", "status two"], invalidate: () => {} };
  const editor: Component = { render: (width) => [...activity.render(width), "composer"], invalidate: () => {} };
  const screen = new FixedDockScreen({ rows: 18 }, {
    header,
    history: conversation,
    status,
    editor,
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });

  screen.render(43);
  screen.pageUp();
  screen.render(43);
  const beforeAnchor = screen.captureHistoryAnchor();
  const beforeViewport = screen.viewportSnapshot();
  assert.ok(beforeAnchor);

  activity.setActivity({ phase: "responding", label: "responding" });
  const changed = screen.render(43);
  assert.deepEqual(screen.captureHistoryAnchor(), beforeAnchor);
  assert.deepEqual(screen.viewportSnapshot(), beforeViewport);
  const historyRow = changed.findIndex((line) => line.includes("activity history row"));
  const activityRow = changed.findIndex((line) => line.includes("responding"));
  const composerRow = changed.indexOf("composer");
  const statusRow = changed.indexOf("status one");
  assert.ok(historyRow >= 0 && historyRow < activityRow);
  assert.ok(activityRow < composerRow && composerRow < statusRow);

  for (const width of [43, 80, 120]) {
    activity.setActivity({ phase: "tool", label: `tool ${"read ".repeat(40)}` });
    const lines = activity.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0] ?? "") <= width);
  }
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

test("virtual history keeps its entry anchor while live output arrives below", () => {
  const conversation = new DockConversation();
  conversation.applyHistory(Array.from({ length: 40 }, (_, index): HistoryEntryDto => ({
    entryId: `locked-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `locked history ${index}` }],
  })), false);
  const empty: Component = { render: () => [], invalidate: () => {} };
  const screen = new FixedDockScreen({ rows: 12 }, {
    header: empty,
    history: conversation,
    status: empty,
    editor: { render: () => ["COMPOSER"], invalidate: () => {} },
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });
  screen.render(60);
  screen.pageUp();
  const before = screen.render(60);
  const anchor = screen.captureHistoryAnchor();
  assert.ok(anchor);
  const anchoredText = before[anchor.screenRow]?.replace(/\x1b\[[0-9;]*m/gu, "");

  conversation.apply(event(200, "message.submitted", {
    operationId: "new-live-output",
    messageId: "new-live-output",
    role: "user",
    text: "new live output below the lock",
    delivery: "prompt",
  }));
  const after = screen.render(60);
  assert.deepEqual(screen.captureHistoryAnchor(), anchor);
  assert.equal(after[anchor.screenRow]?.replace(/\x1b\[[0-9;]*m/gu, ""), anchoredText);
  assert.equal(screen.viewportSnapshot().unseenUpdates, 1);
  assert.match(after.join("\n"), /history paused/u);
  assert.doesNotMatch(after.join("\n"), /new live output below the lock/u);
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

test("fixed screen preserves an entry-and-row anchor across contiguous prepend and resize", () => {
  const conversation = new DockConversation();
  const initial = Array.from({ length: 12 }, (_, index): HistoryEntryDto => ({
    entryId: `entry-${index + 20}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `anchor history ${index + 20} with enough words to wrap at narrow widths` }],
  }));
  conversation.replacePagedHistory({
    entries: initial,
    hasEarlier: true,
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
    entries: [...older, ...initial],
    hasEarlier: true,
    nextBeforeEntryId: older[0]!.entryId,
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

test("a temporarily zero-row history preserves its virtual lock and anchor", () => {
  const conversation = new DockConversation();
  conversation.applyHistory(Array.from({ length: 40 }, (_, index): HistoryEntryDto => ({
    entryId: `zero-row-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `zero row history ${index}` }],
  })), false);
  let editorRows = ["COMPOSER"];
  const screen = new FixedDockScreen({ rows: 12 }, {
    header: { render: () => [], invalidate: () => {} },
    history: conversation,
    status: { render: () => [], invalidate: () => {} },
    editor: { render: () => editorRows, invalidate: () => {} },
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });
  screen.render(60);
  screen.pageUp();
  screen.render(60);
  const anchor = screen.captureHistoryAnchor();
  assert.ok(anchor);
  assert.equal(screen.viewportSnapshot().locked, true);

  editorRows = Array.from({ length: 12 }, (_, index) => `editor ${index}`);
  const covered = screen.render(60);
  assert.equal(covered.some((line) => line.includes("zero row history")), false);
  assert.equal(screen.viewportSnapshot().locked, true);

  editorRows = ["COMPOSER"];
  screen.render(60);
  assert.equal(screen.viewportSnapshot().locked, true);
  assert.deepEqual(screen.captureHistoryAnchor(), anchor);
});

test("80x24 expanded long history renders only the viewport neighborhood and keeps the composer", () => {
  const conversation = new DockConversation();
  const history: HistoryEntryDto[] = [];
  for (let index = 0; index < 2_000; index += 1) {
    const callId = `long-tool-${index}`;
    history.push({
      entryId: `long-assistant-${index}`,
      role: "assistant",
      content: [{ type: "tool_call", toolCallId: callId, toolName: "bash", args: {} }],
    }, {
      entryId: `long-result-${index}`,
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: callId,
        toolName: "bash",
        text: `detail-${index}\n${"expanded output ".repeat(250)}`,
        isError: false,
      }],
    });
  }
  conversation.applyHistory(history, false);
  const screen = new FixedDockScreen({ rows: 24 }, {
    header: { render: () => ["header"], invalidate: () => {} },
    history: conversation,
    status: { render: () => ["metrics", "extensions"], invalidate: () => {} },
    editor: { render: () => ["activity", "COMPOSER"], invalidate: () => {} },
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });
  screen.render(80);

  const started = performance.now();
  assert.equal(conversation.toggleToolsExpanded(), true);
  screen.revealHistoryAnchor(() => conversation.latestToolAnchor());
  const lines = screen.render(80);
  const elapsedMs = performance.now() - started;

  assert.equal(lines.length, 24);
  assert.ok(lines.indexOf("COMPOSER") > lines.findIndex((line) => line.includes("detail-1999")));
  assert.ok(lines.indexOf("COMPOSER") < lines.indexOf("metrics"));
  assert.doesNotMatch(lines.join("\n"), /detail-0(?:\D|$)/u);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.ok(elapsedMs < 1_000, `expanded viewport render took ${elapsedMs.toFixed(1)}ms`);
});

test("virtual Work history stays continuous across thousands of rows and repeated compactions", () => {
  const conversation = new DockConversation();
  const history = Array.from({ length: 8_500 }, (_, index): HistoryEntryDto => ({
    entryId: `continuous-${index}`,
    role: index % 500 === 0 ? "system" : index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: index % 500 === 0 ? `compaction ${index}\nsummary retained` : `continuous history ${index}` }],
    ...(index % 500 === 0 ? { summaryKind: "compaction" as const } : {}),
  }));
  conversation.applyHistory(history, false);
  const empty: Component = { render: () => [], invalidate: () => {} };
  const screen = new FixedDockScreen({ rows: 24 }, {
    header: empty,
    history: conversation,
    status: empty,
    editor: { render: () => ["COMPOSER"], invalidate: () => {} },
    historyVersion: () => ({ revision: conversation.revision, outputRevision: conversation.outputRevision }),
  });
  let lines = screen.render(80);
  assert.match(lines.join("\n"), /continuous history 8499/u);

  let reachedTop = false;
  for (let page = 0; page < 1_000; page += 1) {
    reachedTop = screen.pageUp();
    lines = screen.render(80);
    if (reachedTop) break;
  }
  assert.equal(reachedTop, true);
  assert.match(lines.join("\n"), /compaction 0/u);
  assert.equal(lines.at(-1), "COMPOSER");

  let reachedBottom = false;
  for (let page = 0; page < 1_000; page += 1) {
    reachedBottom = screen.pageDown();
    lines = screen.render(80);
    if (reachedBottom) break;
  }
  assert.equal(reachedBottom, true);
  assert.match(lines.join("\n"), /continuous history 8499/u);
  assert.equal(lines.at(-1), "COMPOSER");
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

test("run activity recovers active tool and compaction phases from authoritative attach state", () => {
  const events = [
    event(1, "run.started", { operationId: "op-1", delivery: "prompt" }),
    event(2, "tool.started", { toolCallId: "t-1", toolName: "read", args: {}, omittedFields: [] }),
  ];
  assert.equal(activityFromReplay(snapshot(), events).label, "tool read");
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

  activity = reduceRunActivity(activity, event(2, "command.handled", {
    operationId: "no-run-1", kind: "extension_command",
  }), snapshot({ execution: "idle" }));
  assert.deepEqual(activity, { phase: "idle", label: "ready" });

  activity = reduceRunActivity(activity, event(3, "command.handled", {
    operationId: "no-run-2", kind: "no_run",
  }), snapshot({ execution: "idle", pending: { steering: 0, followUp: 2, total: 2 } }));
  assert.deepEqual(activity, { phase: "queued", label: "queued 2" });

  const parent = snapshot({ activeCommandId: "parent-op" });
  activity = { phase: "tool", label: "tool bash" };
  activity = reduceRunActivity(activity, event(4, "command.accepted", {
    operationId: "extension-op", delivery: "prompt", queued: false, acceptedAt: "2026-07-15T00:00:00.000Z",
  }), parent);
  assert.deepEqual(activity, { phase: "tool", label: "tool bash" });
  activity = reduceRunActivity(activity, event(5, "command.handled", {
    operationId: "extension-op", kind: "extension_command",
  }), parent);
  assert.deepEqual(activity, { phase: "tool", label: "tool bash" });
  activity = reduceRunActivity(activity, event(6, "extension.notification", {
    level: "info", message: "Kanban status",
  }), parent);
  assert.deepEqual(activity, { phase: "tool", label: "tool bash" });

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
  assert.deepEqual(activity, { phase: "idle", label: "compacted" });
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
  assert.deepEqual(guardActivity, { phase: "idle", label: "compacted" });
  guardActivity = reduceRunActivity(guardActivity, event(2, "run.started", {
    operationId: "runtime-initiated",
  }), running);
  assert.deepEqual(guardActivity, { phase: "waiting", label: "waiting for model" });
  activity = reduceRunActivity(activity, event(2, "compaction.completed", {
    operationId: "compact-cancelled", automatic: false, willRetry: false, aborted: true,
  }), idle);
  assert.deepEqual(activity, { phase: "idle", label: "compaction cancelled" });

  const pending = snapshot({ execution: "idle", pending: { steering: 0, followUp: 2, total: 2 } });
  activity = reduceRunActivity(activity, event(3, "compaction.completed", {
    operationId: "compact-collision", automatic: false, willRetry: false,
    error: "Provider wrote an entry, then said nothing to compact while closing",
  }), idle);
  assert.deepEqual(activity, { phase: "error", label: "compaction failed" });

  activity = reduceRunActivity(activity, event(4, "queue.changed", { steering: 0, followUp: 2, total: 2 }), pending);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "queued", label: "queued 2" });
  activity = reduceRunActivity(activity, event(5, "message.submitted", {
    operationId: "queued-op", messageId: "user-queued-op", role: "user", text: "consumed", delivery: "followUp", queueItemId: "queue-1",
  }), running);
  assert.equal(activity.phase, "waiting");

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
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "tool", label: "tool read" });
  activity = reduceRunActivity(activity, event(6, "message.completed", {
    messageId: "a-1", role: "assistant", content: [{ type: "tool_call", toolCallId: "t-1", toolName: "read", args: {} }],
  }), running);
  assert.deepEqual({ phase: activity.phase, label: activity.label }, { phase: "tool", label: "tool read" });

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
