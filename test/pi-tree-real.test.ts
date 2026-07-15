import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CatalogTransactionCoordinator } from "../src/control/catalog-transactions.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
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

test("real Pi navigates in-file, forks before a user message, and clones the current leaf without a model run", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
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
    const initialMessages = initial.metrics?.messages.total;
    const first = await instance.getTreePage(undefined, undefined, 2);
    assert.ok(first.total >= 4);
    assert.deepEqual(first.nodes.map((node) => [node.entryId, node.depth, node.role]), [
      ["u1", 0, "user"],
      ["a1", 1, "assistant"],
    ]);
    assert.ok(first.leafId);
    assert.equal(first.truncated, true);
    const second = await instance.getTreePage(first.treeRevision, first.nextAfterEntryId, 2);
    assert.deepEqual(second.nodes.map((node) => node.entryId), ["u2", "a2"]);

    const navigated = await instance.navigateSession("navigate-real-tree", "u2");
    assert.deepEqual(navigated, { cancelled: false, editorText: "second prompt", summaryCreated: false });
    const afterNavigate = instance.snapshot();
    assert.equal(afterNavigate.runtimeGeneration, 1);
    assert.equal(afterNavigate.executor.sessionFile, sessionFile);
    assert.equal(afterNavigate.lastRun, "never");
    assert.equal(afterNavigate.metrics?.messages.total, initialMessages);
    assert.equal(instance.eventsSince().events.some((event) => event.type === "run.started"), false);
    await assert.rejects(instance.getTreePage(first.treeRevision, first.nextAfterEntryId, 2), /Session tree changed/);

    const forked = await instance.forkSession("fork-real-tree", "u2");
    assert.deepEqual(forked, { cancelled: false, selectedText: "second prompt" });
    const forkSnapshot = instance.snapshot();
    const forkFile = forkSnapshot.executor.sessionFile;
    assert.ok(forkFile && forkFile !== sessionFile);
    assert.equal(forkSnapshot.runtimeGeneration, 2);
    assert.equal(forkSnapshot.lastRun, "never");
    const forkHeader = JSON.parse((await readFile(forkFile, "utf8")).split("\n")[0] as string) as Record<string, unknown>;
    assert.equal(forkHeader.parentSession, sessionFile);
    const forkTree = await instance.getTreePage(undefined, undefined, 200);
    assert.deepEqual(forkTree.nodes.filter((node) => node.kind === "message").map((node) => node.entryId), ["u1", "a1"]);
    assert.ok(forkTree.leafId);

    const cloned = await instance.cloneSession("clone-real-tree", forkTree.leafId as string);
    assert.deepEqual(cloned, { cancelled: false });
    const cloneSnapshot = instance.snapshot();
    const cloneFile = cloneSnapshot.executor.sessionFile;
    assert.ok(cloneFile && cloneFile !== forkFile);
    assert.equal(cloneSnapshot.runtimeGeneration, 3);
    assert.equal(cloneSnapshot.lastRun, "never");
    const cloneHeader = JSON.parse((await readFile(cloneFile, "utf8")).split("\n")[0] as string) as Record<string, unknown>;
    assert.equal(cloneHeader.parentSession, forkFile);
    const cloneEvents = instance.eventsSince().events;
    const replacement = cloneEvents[0];
    assert.ok(replacement?.type === "session.replaced");
    assert.equal(replacement.data.reason, "fork");
    assert.equal(cloneEvents.some((event) => event.type === "run.started"), false);
    assert.equal(cloneSnapshot.metrics?.tokens.total, 0);
    assert.equal(cloneSnapshot.metrics?.cost, 0);
  } finally {
    await instance.disposeUnpublished();
    await rm(root, { recursive: true, force: true });
  }
});
