import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROJECTED_SESSION_TREE_NODES,
  projectAgentNavigateResult,
  projectRuntimeTree,
} from "../src/core/session-tree.js";
import {
  collectSessionTree,
  filterSessionTree,
  parseTreeNavigationCommand,
  SessionTreeModel,
  treePickerItems,
} from "../src/tui/session-tree.js";
import type { TreeNodeDto } from "../src/core/instance-dto.js";

const nodes: TreeNodeDto[] = [
  { entryId: "u1", depth: 0, kind: "message", role: "user", displayClass: "content", summary: "first", hasChildren: true },
  { entryId: "tool", parentId: "u1", depth: 1, kind: "message", role: "tool", displayClass: "tool", summary: "tool output", hasChildren: true },
  { entryId: "model", parentId: "tool", depth: 2, kind: "model_change", displayClass: "metadata", summary: "model", hasChildren: true },
  { entryId: "u2", parentId: "model", depth: 3, kind: "message", role: "user", displayClass: "content", label: "decision", summary: "second", hasChildren: false },
];

test("tree projection revisions include generation, leaf, labels, and semantic summaries", () => {
  const runtime = {
    nodes: nodes.map((node) => ({ ...node, ...(node.entryId === "tool" ? { summary: `Tool result: ${"A0+/".repeat(32)}` } : {}) })),
    leafId: "u2",
  };
  const first = projectRuntimeTree(runtime, 1);
  const same = projectRuntimeTree(runtime, 1);
  const nextGeneration = projectRuntimeTree(runtime, 2);
  const nextLeaf = projectRuntimeTree({ ...runtime, leafId: "u1" }, 1);
  assert.equal(first.treeRevision, same.treeRevision);
  assert.notEqual(first.treeRevision, nextGeneration.treeRevision);
  assert.notEqual(first.treeRevision, nextLeaf.treeRevision);
  assert.equal(first.nodes.find((node) => node.entryId === "tool")?.summary, `Tool result: ${"A0+/".repeat(32)}`);
  assert.match(JSON.stringify(first), /A0\+\//);
  assert.throws(() => projectRuntimeTree({ nodes: [{ ...runtime.nodes[0]!, depth: 1 }], leafId: "u1" }, 1), /depth zero/);
  assert.throws(() => projectRuntimeTree({ nodes: [{ ...runtime.nodes[0]!, hasChildren: false }, runtime.nodes[1] as typeof runtime.nodes[number]], leafId: "tool" }, 1), /child projection/);
  assert.throws(() => projectRuntimeTree({ nodes: [runtime.nodes[0] as typeof runtime.nodes[number], { ...runtime.nodes[2]!, parentId: "tool", depth: 2 }], leafId: "model" }, 1), /depth-first pre-order/);
});

test("tree projection accepts its documented 100000-node bound and rejects the next node", () => {
  const atBound = Array.from({ length: MAX_PROJECTED_SESSION_TREE_NODES }, (_, index) => ({
    entryId: `bounded-${index}`,
    depth: 0,
    kind: "message" as const,
    role: "user" as const,
    summary: `turn ${index}`,
    hasChildren: false,
  }));
  const projected = projectRuntimeTree({ nodes: atBound, leafId: `bounded-${atBound.length - 1}` }, 1);
  assert.equal(projected.nodes.length, MAX_PROJECTED_SESSION_TREE_NODES);
  assert.throws(
    () => projectRuntimeTree({ nodes: [...atBound, { ...atBound[0]!, entryId: "overflow" }] }, 1),
    /exceeds 100000 entries/u,
  );
});

test("navigation result projection is closed, abort-consistent, and preserves semantic text", () => {
  assert.deepEqual(projectAgentNavigateResult({ cancelled: false, editorText: "line 1\r\nline 2", summaryCreated: false }), {
    cancelled: false, editorText: "line 1\nline 2", summaryCreated: false,
  });
  assert.throws(() => projectAgentNavigateResult({ cancelled: false, aborted: true, summaryCreated: false }), /must be cancelled/);
  assert.throws(() => projectAgentNavigateResult({ cancelled: true, editorText: "stale", summaryCreated: false }), /cannot return editor text/);
  assert.throws(() => projectAgentNavigateResult({ cancelled: false, editorText: "x".repeat(256_001), summaryCreated: false }), /oversized/);
  const encodedText = `attachment: ${"A0+/".repeat(32)}`;
  assert.deepEqual(projectAgentNavigateResult({ cancelled: false, editorText: encodedText, summaryCreated: false }), {
    cancelled: false, editorText: encodedText, summaryCreated: false,
  });
});

test("tree collection holds one revision and reports a bounded selector cap", async () => {
  const pages = [
    { treeRevision: "g1-r", nodes: nodes.slice(0, 2), leafId: "u2", total: 4, truncated: true, nextAfterEntryId: "tool" },
    { treeRevision: "g1-r", nodes: nodes.slice(2), leafId: "u2", total: 4, truncated: false },
  ];
  let calls = 0;
  const collected = await collectSessionTree(async () => pages[calls++] as typeof pages[number]);
  assert.deepEqual(collected.nodes.map((node) => node.entryId), ["u1", "tool", "model", "u2"]);
  assert.equal(collected.capped, false);

  calls = 0;
  const capped = await collectSessionTree(async () => pages[calls++] as typeof pages[number], 2);
  assert.equal(capped.nodes.length, 2);
  assert.equal(capped.capped, true);

  await assert.rejects(collectSessionTree(async (_revision, cursor) => cursor === undefined ? pages[0] as typeof pages[number] : { ...pages[1], treeRevision: "changed" } as typeof pages[number]), /changed during pagination/);
});

test("tree collection includes and searches entries beyond the former 5,000-node selector cap", async () => {
  const total = 14_392;
  const large = Array.from({ length: total }, (_, index): TreeNodeDto => ({
    entryId: `entry-${index}`,
    ...(index === 0 ? {} : { parentId: `entry-${index - 1}` }),
    depth: index,
    kind: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    displayClass: "content",
    summary: index === 12_345 ? "needle beyond old cap" : `turn ${index}`,
    hasChildren: index < total - 1,
  }));
  let calls = 0;
  const collected = await collectSessionTree(async (revision, afterEntryId, limit = 200) => {
    calls += 1;
    const start = afterEntryId === undefined ? 0 : Number(afterEntryId.slice("entry-".length)) + 1;
    const pageNodes = large.slice(start, start + limit);
    const truncated = start + pageNodes.length < large.length;
    return {
      treeRevision: revision ?? "g1-large",
      nodes: pageNodes,
      leafId: `entry-${total - 1}`,
      total,
      truncated,
      ...(truncated ? { nextAfterEntryId: pageNodes.at(-1)?.entryId } : {}),
    };
  });

  assert.equal(calls, Math.ceil(total / 200));
  assert.equal(collected.capped, false);
  assert.equal(collected.nodes.length, total);
  assert.equal(treePickerItems(collected.nodes, collected.leafId).find((item) => item.label.includes("needle beyond old cap"))?.value, "entry-12345");
});

test("tree picker compresses linear depth and exposes branch points, active path, and sibling leaves", () => {
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
  assert.match(longLinear.description, /branch point · 2 paths/u);
  assert.match(branchA.label, /○ Alu · original branch answer/u);
  assert.match(branchA.description, /sibling branch leaf/u);
  assert.match(branchB.label, /● Alu · new branch answer/u);
  assert.match(branchB.description, /current leaf/u);
  assert.doesNotMatch(items.map((item) => `${item.label} ${item.description}`).join("\n"), /leaf-a|leaf-b/u, "internal IDs stay searchable values, not primary copy");

  const cappedParent = treePickerItems([
    { entryId: "capped-parent", depth: 4, kind: "message", role: "assistant", displayClass: "content", summary: "children outside selector cap", hasChildren: true },
  ]).at(0)!;
  assert.doesNotMatch(cappedParent.label, /○/u);
  assert.doesNotMatch(cappedParent.description, /sibling branch leaf/u);
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

test("tree model keeps deep structural topology iterative and search clearable", () => {
  const count = 20_000;
  const deep = Array.from({ length: count }, (_, index): TreeNodeDto => ({
    entryId: `deep-${index}`,
    ...(index === 0 ? {} : { parentId: `deep-${index - 1}` }),
    depth: index,
    kind: "message",
    role: index === count - 1 ? "user" : "assistant",
    displayClass: index === count - 1 ? "content" : "structural",
    summary: index === count - 1 ? "needle leaf" : "tool wrapper",
    hasChildren: index < count - 1,
  }));
  const model = new SessionTreeModel(deep, `deep-${count - 1}`);
  assert.deepEqual(model.visible().map((item) => item.node.entryId), [`deep-${count - 1}`]);
  model.setQuery("needle");
  assert.equal(model.visible().length, 1);
  assert.equal(model.clearQueryAndFolds(), true);
  assert.equal(model.query, "");
});

test("tree view filtering, picker projection, and direct command parsing remain Dock-owned", () => {
  assert.deepEqual(filterSessionTree(nodes, "default").map((node) => node.entryId), ["u1", "tool", "u2"]);
  assert.deepEqual(filterSessionTree(nodes, "no-tools").map((node) => node.entryId), ["u1", "u2"]);
  assert.deepEqual(filterSessionTree(nodes, "user-only").map((node) => node.entryId), ["u1", "u2"]);
  assert.deepEqual(filterSessionTree(nodes, "labeled-only").map((node) => node.entryId), ["u2"]);
  assert.equal(treePickerItems(nodes, "u2").at(-1)?.label.includes("●"), true);
  assert.deepEqual(parseTreeNavigationCommand("u2"), { entryId: "u2", options: {} });
  assert.deepEqual(parseTreeNavigationCommand("u2 --summary keep decisions"), {
    entryId: "u2", options: { summarize: true, customInstructions: "keep decisions" },
  });
  assert.deepEqual(parseTreeNavigationCommand("u2 --replace preserve files"), {
    entryId: "u2", options: { summarize: true, customInstructions: "preserve files", replaceInstructions: true },
  });
  assert.equal(parseTreeNavigationCommand("u2 --replace"), undefined);
  assert.equal(parseTreeNavigationCommand("u2 --unknown"), undefined);
});
