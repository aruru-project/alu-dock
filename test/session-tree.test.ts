import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionTreeModel,
  treePickerItems,
} from "../src/tui/session-tree.js";
import type { TreeNodeDto } from "../src/core/instance-dto.js";



test("tree picker compresses linear depth and describes branches without exposing IDs", () => {
  const branched: TreeNodeDto[] = [
    { entryId: "root", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "start task", hasChildren: true },
    ...Array.from({ length: 12 }, (_, index): TreeNodeDto => ({
      entryId: `linear-${index}`,
      parentId: index === 0 ? "root" : `linear-${index - 1}`,
      depth: index + 1,
      kind: "message",
      role: index % 2 === 0 ? "assistant" : "user",
      displayClass: "content",
      summary: `linear turn ${index}`,
      hasChildren: true,
    })),
    { entryId: "leaf-a", parentId: "linear-11", depth: 13, kind: "message", role: "assistant", displayClass: "content", summary: "original branch answer", hasChildren: false },
    { entryId: "branch-b-user", parentId: "linear-5", depth: 7, kind: "message", role: "user", displayClass: "content", summary: "new branch prompt", hasChildren: true },
    { entryId: "leaf-b", parentId: "branch-b-user", depth: 8, kind: "message", role: "assistant", displayClass: "content", summary: "new branch answer", hasChildren: false },
  ];
  // Correct the depth-first topology around the branch: branch B is a sibling
  // after branch A's leaf in the flattened projection.
  const items = treePickerItems(branched, "leaf-b", branched);
  const longLinear = items.find((item) => item.value === "linear-5")!;
  const branchA = items.find((item) => item.value === "leaf-a")!;
  const branchB = items.find((item) => item.value === "leaf-b")!;
  assert.ok((longLinear.label.match(/│/gu) ?? []).length <= 1, "raw depth must not drive indentation");
  assert.match(longLinear.description, /conversation splits here · 2 paths/u);
  assert.match(branchA.label, /○ Alu · original branch answer/u);
  assert.match(branchA.description, /other branch ends here/u);
  assert.match(branchB.label, /● Alu · new branch answer/u);
  assert.match(branchB.description, /current point/u);
  assert.doesNotMatch(items.map((item) => `${item.label} ${item.description}`).join("\n"), /leaf-a|leaf-b/u, "internal IDs stay searchable values, not primary copy");

  const cappedParent = treePickerItems([
    { entryId: "capped-parent", depth: 4, kind: "message", role: "assistant", displayClass: "content", summary: "children outside selector cap", hasChildren: true },
  ]).at(0)!;
  assert.doesNotMatch(cappedParent.label, /○/u);
  assert.doesNotMatch(cappedParent.description, /other branch ends here/u);
});

test("tree model reconstructs visible topology, prioritizes active branches, and navigates segments", () => {
  const topology: TreeNodeDto[] = [
    { entryId: "root", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "root", hasChildren: true },
    { entryId: "wrapper-a", parentId: "root", depth: 1, kind: "message", role: "assistant", displayClass: "structural", summary: "Tool call: read", hasChildren: true },
    { entryId: "tool-a", parentId: "wrapper-a", depth: 2, kind: "message", role: "tool", displayClass: "tool", summary: "[read: a.ts]", hasChildren: true },
    { entryId: "leaf-a", parentId: "tool-a", depth: 3, kind: "message", role: "assistant", displayClass: "content", summary: "branch A", hasChildren: false },
    { entryId: "user-b", parentId: "root", depth: 1, kind: "message", role: "user", displayClass: "content", summary: "branch B", hasChildren: true },
    { entryId: "error-b", parentId: "user-b", depth: 2, kind: "message", role: "assistant", displayClass: "content", state: "error", summary: "timeout", hasChildren: false },
  ];
  const model = new SessionTreeModel(topology, "error-b");
  assert.deepEqual(model.visible().map((item) => item.node.entryId), ["root", "user-b", "error-b", "tool-a", "leaf-a"]);
  assert.equal(model.visible().find((item) => item.node.entryId === "tool-a")?.parentId, "root", "hidden structural nodes reattach descendants");
  assert.equal(model.visible().find((item) => item.node.entryId === "root")?.branchPoint, true);

  model.setSelected("user-b");
  model.foldOrJumpUp();
  assert.equal(model.foldedCount, 1);
  assert.deepEqual(model.visible().map((item) => item.node.entryId), ["root", "user-b", "tool-a", "leaf-a"]);
  model.unfoldOrJumpDown();
  assert.equal(model.foldedCount, 0);
  model.unfoldOrJumpDown();
  assert.equal(model.selectedId, "error-b", "Ctrl/Alt+Right follows the branch segment to its end");
  model.foldOrJumpUp();
  assert.equal(model.selectedId, "user-b", "Ctrl/Alt+Left returns to the segment start");

  model.setFilter("no-tools");
  assert.deepEqual(model.visible().map((item) => item.node.entryId), ["root", "user-b", "error-b", "leaf-a"]);
  assert.equal(model.visible().find((item) => item.node.entryId === "leaf-a")?.parentId, "root");
  model.setFilter("user-only");
  assert.deepEqual(model.visible().map((item) => item.node.entryId), ["root", "user-b"]);
  assert.equal(model.selectedId, "user-b", "filtered selection resolves to its nearest visible ancestor");
  model.cycleFilter(1);
  assert.equal(model.filterMode, "labeled-only");
  model.setFilter("all");
  assert.ok(model.visible().some((item) => item.node.entryId === "wrapper-a"), "All reveals structural tool-call wrappers");
});
