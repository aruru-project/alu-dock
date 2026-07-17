import assert from "node:assert/strict";
import test from "node:test";

import { projectRuntimeNavigateResult, projectRuntimeTree } from "../src/core/session-tree.js";
import {
  collectSessionTree,
  filterSessionTree,
  parseTreeNavigationCommand,
  treePickerItems,
} from "../src/tui/session-tree.js";
import type { TreeNodeDto } from "../src/core/instance-dto.js";

const nodes: TreeNodeDto[] = [
  { entryId: "u1", depth: 0, kind: "message", role: "user", summary: "first", hasChildren: true },
  { entryId: "tool", parentId: "u1", depth: 1, kind: "message", role: "tool", summary: "tool output", hasChildren: true },
  { entryId: "model", parentId: "tool", depth: 2, kind: "model_change", summary: "model", hasChildren: true },
  { entryId: "u2", parentId: "model", depth: 3, kind: "message", role: "user", label: "decision", summary: "second", hasChildren: false },
];

test("tree projection revisions include generation, leaf, labels, and structure while omitting binary summaries", () => {
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
  assert.equal(first.nodes.find((node) => node.entryId === "tool")?.summary, "Session entry details omitted");
  assert.doesNotMatch(JSON.stringify(first), /A0\+\//);
  assert.throws(() => projectRuntimeTree({ nodes: [{ ...runtime.nodes[0]!, depth: 1 }], leafId: "u1" }, 1), /depth zero/);
  assert.throws(() => projectRuntimeTree({ nodes: [{ ...runtime.nodes[0]!, hasChildren: false }, runtime.nodes[1] as typeof runtime.nodes[number]], leafId: "tool" }, 1), /child projection/);
  assert.throws(() => projectRuntimeTree({ nodes: [runtime.nodes[0] as typeof runtime.nodes[number], { ...runtime.nodes[2]!, parentId: "tool", depth: 2 }], leafId: "model" }, 1), /depth-first pre-order/);
});

test("navigation result projection is closed, abort-consistent, and binary-safe", () => {
  assert.deepEqual(projectRuntimeNavigateResult({ cancelled: false, editorText: "line 1\r\nline 2", summaryCreated: false }), {
    cancelled: false, editorText: "line 1\nline 2", summaryCreated: false,
  });
  assert.throws(() => projectRuntimeNavigateResult({ cancelled: false, aborted: true, summaryCreated: false }), /must be cancelled/);
  assert.throws(() => projectRuntimeNavigateResult({ cancelled: true, editorText: "stale", summaryCreated: false }), /cannot return editor text/);
  assert.throws(() => projectRuntimeNavigateResult({ cancelled: false, editorText: "x".repeat(256_001), summaryCreated: false }), /oversized/);
  assert.deepEqual(projectRuntimeNavigateResult({ cancelled: false, editorText: `attachment: ${"A0+/".repeat(32)}`, summaryCreated: false }), {
    cancelled: false, summaryCreated: false,
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

test("tree picker compresses linear depth and exposes branch points, active path, and sibling leaves", () => {
  const branched: TreeNodeDto[] = [
    { entryId: "root", depth: 0, kind: "message", role: "user", summary: "start task", hasChildren: true },
    ...Array.from({ length: 12 }, (_, index): TreeNodeDto => ({
      entryId: `linear-${index}`,
      parentId: index === 0 ? "root" : `linear-${index - 1}`,
      depth: index + 1,
      kind: "message",
      role: index % 2 === 0 ? "assistant" : "user",
      summary: `linear turn ${index}`,
      hasChildren: true,
    })),
    { entryId: "leaf-a", parentId: "linear-11", depth: 13, kind: "message", role: "assistant", summary: "original branch answer", hasChildren: false },
    { entryId: "branch-b-user", parentId: "linear-5", depth: 7, kind: "message", role: "user", summary: "new branch prompt", hasChildren: true },
    { entryId: "leaf-b", parentId: "branch-b-user", depth: 8, kind: "message", role: "assistant", summary: "new branch answer", hasChildren: false },
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
