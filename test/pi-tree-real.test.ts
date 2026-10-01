import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CatalogTransactionCoordinator } from "../src/control/catalog-transactions.js";
import { createIsolatedPiInstance as createPiInstance } from "./fixtures/isolated-pi-instance.js";
import { ScriptedCatalogCommitPort } from "./support/scripted-catalog-port.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: string, timestamp: number): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
  };
}

test("real Pi keeps a previous durable recovery when fork-before-first-user defers the candidate file", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-deferred-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const sessionFile = join(sessionDir, "tree-source.jsonl");
  const timestamp = "2026-07-14T00:00:00.000Z";
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "tree-deferred-source", timestamp, cwd }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "first prompt", timestamp: 1 } }),
    "",
  ].join("\n"), { mode: 0o600 });

  const instance = await createPiInstance({
    id: "real-tree-deferred",
    creationOperationId: "create-real-tree-deferred",
    hostEpoch: "real-tree-deferred-host",
    cwd,
    agentDir,
    sessionDir,
    sessionFile,
    projectTrusted: true,
    tools: [],
  });
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), {
    kind: "instance.create", effect: "rollback_contained", operationId: instance.creationOperationId, instanceId: instance.id,
  });
  instance.markCatalogCommitted();
  try {
    assert.deepEqual(await instance.forkSession("fork-deferred-real", "u1"), { cancelled: false, selectedText: "first prompt" });
    const candidatePath = instance.snapshot().executor.sessionFile;
    assert.ok(candidatePath && candidatePath !== sessionFile);
    await assert.rejects(lstat(candidatePath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const active = catalog.current().instances[0];
    assert.equal(active?.sessionFile, undefined);
    assert.equal(active?.recoverySessionFile, sessionFile);
    assert.equal(active?.runtimeGeneration, 2);

    await instance.shutdownForHostDrain();
    const lost = catalog.current().instances[0];
    assert.equal(lost?.lifecycle, "host_lost");
    assert.equal(lost?.recoverySessionFile, sessionFile);
    assert.equal(lost?.sessionFile, undefined);
    assert.equal(instance.eventsSince().events.some((event) => event.type === "run.started"), false);
  } finally {
    await instance.disposeUnpublished().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi navigates, forks, and clones selected branch points without a model run", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(sessionDir)]);
  await writeFile(join(agentDir, "extensions", "session-status.ts"), `
export default function (pi) {
  pi.on("session_start", (event, ctx) => ctx.ui.setStatus("session-fixture", event.reason));
}
`, "utf8");
  const sessionFile = join(sessionDir, "tree-source.jsonl");
  const timestamp = "2026-07-14T00:00:00.000Z";
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "tree-source-session", timestamp, cwd }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "first prompt", timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-14T00:00:01.000Z", message: assistant("first answer", 2) }),
    JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-07-14T00:00:02.000Z", message: { role: "user", content: "second prompt", timestamp: 3 } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-14T00:00:03.000Z", message: assistant("second answer", 4) }),
    "",
  ].join("\n"), { mode: 0o600 });

  const instance = await createPiInstance({
    id: "real-tree",
    creationOperationId: "create-real-tree",
    hostEpoch: "real-tree-host",
    cwd,
    agentDir,
    sessionDir,
    sessionFile,
    projectTrusted: true,
    tools: [],
  });
  try {
    const initial = instance.snapshot();
    assert.equal(initial.extensionStatus?.["session-fixture"], "startup");
    const initialMessages = initial.metrics?.messages.total;
    const first = await instance.getTree();
    assert.deepEqual(first.nodes.filter((node) => node.kind === "message").map((node) => [node.entryId, node.depth, node.role]), [
      ["u1", 0, "user"],
      ["a1", 1, "assistant"],
      ["u2", 2, "user"],
      ["a2", 3, "assistant"],
    ]);
    assert.ok(first.nodes.every((node) => node.summary.length > 0 && typeof node.hasChildren === "boolean"));
    assert.equal(first.leafId, first.nodes.at(-1)?.entryId);

    // #292: the UI promises Clone from the selected node, not only the current leaf.
    const sourceBytes = await readFile(sessionFile, "utf8");
    assert.deepEqual(await instance.cloneSession("clone-history-point", "a1"), { cancelled: false });
    assert.notEqual(instance.snapshot().executor.sessionFile, sessionFile);
    assert.deepEqual((await instance.getTree()).nodes.filter((node) => node.kind === "message").map((node) => node.entryId), ["u1", "a1"]);
    assert.equal(await readFile(sessionFile, "utf8"), sourceBytes, "cloning a history point preserves the original saved branch");
    assert.deepEqual(await instance.switchSession("restore-original-branch", sessionFile, { canonicalCwd: cwd, projectTrusted: true }), { cancelled: false });

    const navigated = await instance.navigateSession("navigate-real-tree", "u2");
    assert.equal(navigated.cancelled, false);
    assert.equal(navigated.editorText, "second prompt");
    assert.equal(navigated.summaryCreated, false);
    const afterNavigate = instance.snapshot();
    assert.equal(afterNavigate.runtimeGeneration, 3);
    assert.equal(afterNavigate.executor.sessionFile, sessionFile);
    assert.equal(afterNavigate.lastRun, "never");
    assert.equal(afterNavigate.metrics?.messages.total, initialMessages);
    assert.equal(instance.eventsSince().events.some((event) => event.type === "run.started"), false);
    assert.equal((await instance.getTree()).leafId, "a1");

    const forked = await instance.forkSession("fork-real-tree", "u2");
    assert.deepEqual(forked, { cancelled: false, selectedText: "second prompt" });
    const forkSnapshot = instance.snapshot();
    const forkFile = forkSnapshot.executor.sessionFile;
    assert.ok(forkFile && forkFile !== sessionFile);
    assert.equal(forkSnapshot.runtimeGeneration, 4);
    assert.equal(forkSnapshot.extensionStatus?.["session-fixture"], "fork");
    assert.equal(forkSnapshot.lastRun, "never");
    const forkHeader = JSON.parse((await readFile(forkFile, "utf8")).split("\n")[0] as string) as Record<string, unknown>;
    assert.equal(forkHeader.parentSession, sessionFile);
    const forkTree = await instance.getTree();
    assert.deepEqual(forkTree.nodes.filter((node) => node.kind === "message").map((node) => node.entryId), ["u1", "a1"]);
    assert.ok(forkTree.leafId);

    const cloned = await instance.cloneSession("clone-real-tree", forkTree.leafId as string);
    assert.deepEqual(cloned, { cancelled: false });
    const cloneSnapshot = instance.snapshot();
    const cloneFile = cloneSnapshot.executor.sessionFile;
    assert.ok(cloneFile && cloneFile !== forkFile);
    assert.equal(cloneSnapshot.runtimeGeneration, 5);
    assert.equal(cloneSnapshot.extensionStatus?.["session-fixture"], "fork");
    assert.equal(cloneSnapshot.lastRun, "never");
    const cloneHeader = JSON.parse((await readFile(cloneFile, "utf8")).split("\n")[0] as string) as Record<string, unknown>;
    assert.equal(cloneHeader.parentSession, forkFile);
    const cloneEvents = instance.eventsSince().events;
    const replacement = cloneEvents[0];
    assert.ok(replacement?.type === "session.replaced");
    assert.equal(replacement.data.reason, "clone");
    assert.equal(cloneEvents.some((event) => event.type === "run.started"), false);
    assert.equal(cloneSnapshot.metrics?.tokens.total, 0);
    assert.equal(cloneSnapshot.metrics?.cost, 0);
  } finally {
    await instance.disposeUnpublished();
    await rm(root, { recursive: true, force: true });
  }
});

test("a saved Pi 0.99 session keeps its conversation, tree and total cost alongside system, cache-warming and retry records", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-records-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const sessionFile = join(sessionDir, "pi-0.99-records.jsonl");
  const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
  const paid = (total: number) => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost, total } });
  // Pi 0.99 opens a session with its system prompt as a message, records cache warming
  // between runs, and removes a failed attempt from model context before retrying.
  await writeFile(sessionFile, [
    { type: "session", version: 3, id: "pi-0.99-records", timestamp: at(0), cwd },
    { type: "message", id: "s1", parentId: null, timestamp: at(1), message: { role: "system", content: "", sections: { preamble: "Fixture system prompt." }, timestamp: 1 } },
    { type: "message", id: "u1", parentId: "s1", timestamp: at(2), message: { role: "user", content: "first prompt", timestamp: 2 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at(3), message: { ...assistant("first answer", 3), usage: paid(0.5) } },
    { type: "usage", id: "w1", parentId: "a1", timestamp: at(4), kind: "cache_warm", provider: "fixture", model: "fixture", usage: paid(0.125) },
    { type: "message", id: "u2", parentId: "w1", timestamp: at(5), message: { role: "user", content: "second prompt", timestamp: 5 } },
    { type: "message", id: "a2", parentId: "u2", timestamp: at(6), message: { ...assistant("", 6), content: [], stopReason: "error", errorMessage: "provider overloaded" } },
    { type: "context_edit", id: "e1", parentId: "a2", timestamp: at(7), targetId: "a2", replacement: null },
    { type: "message", id: "a3", parentId: "e1", timestamp: at(8), message: assistant("second answer", 8) },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });

  const instance = await createPiInstance({
    id: "real-tree-records",
    creationOperationId: "create-real-tree-records",
    hostEpoch: "real-tree-records-host",
    cwd,
    agentDir,
    sessionDir,
    sessionFile,
    projectTrusted: true,
    tools: [],
  });
  try {
    const conversation = ["u1", "a1", "u2", "a2", "a3"];
    const history = (await instance.getHistoryPage(undefined, 200)).entries;
    assert.deepEqual(history.filter((entry) => entry.visibility === "conversation").map((entry) => entry.entryId), conversation);
    assert.equal(history.some((entry) => entry.kind === "label"), false, "runtime records must not read as label changes");
    const page = await instance.getConversationHistory();
    assert.deepEqual(page.entries.filter((item) => item.entry.visibility === "conversation").map((item) => item.entry.entryId), conversation);

    const tree = await instance.getTree();
    assert.deepEqual(tree.nodes.filter((node) => node.displayClass !== "metadata").map((node) => node.entryId), conversation);
    const byId = new Map(tree.nodes.map((node) => [node.entryId, node]));
    assert.deepEqual(["s1", "w1", "e1"].map((id) => byId.get(id)?.displayClass), ["metadata", "metadata", "metadata"]);

    assert.equal(instance.snapshot().metrics?.cost, 0.625, "cache warming counts toward the session total");
  } finally {
    await instance.disposeUnpublished();
    await rm(root, { recursive: true, force: true });
  }
});
