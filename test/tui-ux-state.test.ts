import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import type { InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockWorkMetadata } from "../src/tui/conversation.js";
import { filterSearchableItems } from "../src/tui/search-filter.js";
import { SearchablePicker } from "../src/tui/searchable-picker.js";
import { ExtensionTextDialog } from "../src/tui/extension-text-dialog.js";
import { formatWorkStatus, pickerContentRowBudget } from "../src/tui/dock-tui.js";
import { SessionTreeSurface } from "../src/tui/session-tree-surface.js";
import { FixedActionDialog, WorkModalFrame } from "../src/tui/work-modal.js";
import { WorkspaceBrowserSurface } from "../src/tui/workspace-browser.js";
import type { TreeNodeDto } from "../src/core/instance-dto.js";

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
    displayName: overrides.displayName ?? "demo",
    compacting: overrides.compacting ?? false,
    executionChangedAt: overrides.executionChangedAt ?? "2026-07-15T00:00:00.000Z",
  };
}

test("keyed instances display their business key beside the Work name", () => {
  const keyed = snapshot({ key: "alu", name: "Alu Workstation" });
  const metadata = new DockWorkMetadata(() => keyed).render(120).join("\n");
  assert.match(metadata, /Alu Workstation.*\[alu\]/u);
  assert.match(formatWorkStatus(keyed), /Session: Alu Workstation \[alu\]/u);
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

test("searchable picker filters typed input and sanitizes display text", () => {
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

test("workspace browser hides dot folders by default while direct paths remain reachable", () => {
  let opened: string | undefined;
  const surface = new WorkspaceBrowserSurface({
    initialPath: "/work",
    terminalRows: () => 24,
    requestRender: () => {},
  });
  surface.onOpenPath = (path) => { opened = path; };
  surface.replaceDirectory({
    path: "/work",
    parent: "/",
    revision: "workspace-1",
    entries: [
      { name: ".secret", kind: "directory", hidden: true },
      { name: "project", kind: "directory", hidden: false },
      { name: "shared", kind: "symlink", hidden: false },
    ],
    total: 3,
    truncated: false,
  });
  surface.focused = true;

  assert.doesNotMatch(surface.render(80).join("\n"), /\.secret/u);
  surface.handleInput("\u001bh"); // Alt+H
  assert.match(surface.render(80).join("\n"), /\.secret/u);
  surface.handleInput("\u001bh");
  surface.handleInput("\x0c"); // Ctrl+L
  assert.equal(surface.enteringPath, true);
  surface.handleInput(".secret");
  surface.handleInput("\r");
  assert.equal(opened, "/work/.secret");
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
  const initialSelection = initial.split("\n").filter((line) => line.startsWith("▶ "));
  assert.equal(initialSelection.length, 1, "tree selection uses one unmistakable solid cursor even without color");
  assert.match(initialSelection[0] ?? "", /\[compaction: 42k tokens\]/u);
  surface.handleInput("\u001b[A");
  const moved = surface.render(80).join("\n");
  assert.equal(moved.split("\n").filter((line) => line.startsWith("▶ ")).length, 1);
  assert.doesNotMatch(moved.split("\n").find((line) => line.includes("[compaction: 42k tokens]")) ?? "", /^▶ /u, "selection highlight moves with the cursor");
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
