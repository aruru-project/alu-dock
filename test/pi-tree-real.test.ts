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

test("a saved Pi 0.99 session keeps its conversation, tree and total cost, and shows what its system, cache-warming and retry records changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-records-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const sessionFile = join(sessionDir, "pi-0.99-records.jsonl");
  const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
  const paid = (total: number) => ({ ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost, total } });
  // Longer than one history preview block, so reading it whole needs the content path.
  const projectContext = `<project_context>\n${"Project rule. ".repeat(1_000)}\n</project_context>`;
  const readTool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } };
  // Pi 0.99 opens a session with its system prompt as a message, records cache warming
  // between runs, records later prompt and tool changes as further system messages,
  // and removes a failed attempt from model context before retrying.
  await writeFile(sessionFile, [
    { type: "session", version: 3, id: "pi-0.99-records", timestamp: at(0), cwd },
    { type: "message", id: "s1", parentId: null, timestamp: at(1), message: { role: "system", content: "", sections: { preamble: "Fixture system prompt.", project_context: projectContext }, toolsAdded: [readTool], timestamp: 1 } },
    { type: "message", id: "u1", parentId: "s1", timestamp: at(2), message: { role: "user", content: "first prompt", timestamp: 2 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at(3), message: { ...assistant("first answer", 3), usage: paid(0.5) } },
    { type: "usage", id: "w1", parentId: "a1", timestamp: at(4), kind: "cache_warm", provider: "fixture", model: "fixture-model", usage: { ...paid(0.125), cacheRead: 1_000, output: 1, totalTokens: 1_001 }, note: "extension override" },
    { type: "message", id: "s2", parentId: "w1", timestamp: at(5), message: { role: "system", content: "", sections: { project_context: null }, toolsRemoved: [{ name: "read" }], timestamp: 5 } },
    { type: "message", id: "u2", parentId: "s2", timestamp: at(5), message: { role: "user", content: "second prompt", timestamp: 5 } },
    { type: "message", id: "a2", parentId: "u2", timestamp: at(6), message: { ...assistant("", 6), content: [], stopReason: "error", errorMessage: "provider overloaded" } },
    { type: "context_edit", id: "e1", parentId: "a2", timestamp: at(7), targetId: "a2", replacement: null },
    { type: "context_edit", id: "e2", parentId: "e1", timestamp: at(7), targetId: "u2", replacement: { content: "second prompt, shortened" } },
    { type: "message", id: "a3", parentId: "e2", timestamp: at(8), message: assistant("second answer", 8) },
    // An extension shortening an attachment lookup keeps its private path out of every client.
    { type: "message", id: "u3", parentId: "a3", timestamp: at(9), message: { role: "user", content: "third prompt", timestamp: 9 } },
    { type: "message", id: "a4", parentId: "u3", timestamp: at(9), message: { ...assistant("", 9), content: [{ type: "toolCall", id: "call-r", name: "dock_attachment_resolve", arguments: { fileId: "file-1" } }], stopReason: "toolUse" } },
    { type: "message", id: "t4", parentId: "a4", timestamp: at(9), message: { role: "toolResult", toolCallId: "call-r", toolName: "dock_attachment_resolve", content: [{ type: "text", text: "/home/private/report.pdf" }], isError: false, timestamp: 9 } },
    { type: "context_edit", id: "e3", parentId: "t4", timestamp: at(9), targetId: "t4", replacement: { content: [{ type: "text", text: "Shortened: /home/private/report.pdf" }] } },
    { type: "message", id: "a5", parentId: "e3", timestamp: at(9), message: assistant("third answer", 9) },
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
    const conversation = ["u1", "a1", "u2", "a2", "a3", "u3", "a4", "t4", "a5"];
    const history = (await instance.getHistoryPage(undefined, 200)).entries;
    assert.deepEqual(history.filter((entry) => entry.visibility === "conversation").map((entry) => entry.entryId), conversation);
    assert.equal(history.some((entry) => entry.kind === "label"), false, "runtime records must not read as label changes");
    const page = await instance.getConversationHistory();
    assert.deepEqual(page.entries.filter((item) => item.entry.visibility === "conversation").map((item) => item.entry.entryId), conversation);

    // Each runtime record says what it changed, so a client can show it without Pi's file.
    const record = (id: string) => history.find((entry) => entry.entryId === id);
    assert.deepEqual(record("s1")?.systemPrompt, { sections: ["preamble", "project_context"], removedSections: [], toolsAdded: ["read"], toolsRemoved: [] });
    assert.deepEqual(record("s2")?.systemPrompt, { sections: [], removedSections: ["project_context"], toolsAdded: [], toolsRemoved: ["read"] });
    assert.deepEqual(record("w1")?.usage, {
      kind: "cache_warm", tokens: { input: 0, output: 1, cacheRead: 1_000, cacheWrite: 0, total: 1_001 }, cost: 0.125, note: "extension override",
    });
    assert.deepEqual([record("w1")?.provider, record("w1")?.modelId], ["fixture", "fixture-model"]);
    assert.deepEqual([record("e1")?.contextEdit, record("e1")?.targetEntryId, record("e1")?.content], ["omit", "a2", []]);
    assert.deepEqual([record("e2")?.contextEdit, record("e2")?.targetEntryId, record("e2")?.content], ["replace", "u2", [{ type: "text", text: "second prompt, shortened" }]]);
    assert.deepEqual(record("e3")?.content, [{ type: "text",
      text: "Dock attachment resolved. The Host-local path was disclosed privately to the Agent and is omitted from external conversation projections." }]);

    // The whole system prompt record (sections, then added tool definitions) reads back in full.
    const system = page.entries.find((item) => item.entry.entryId === "s1");
    assert.deepEqual([system?.entry.content, system?.contentComplete], [[], false], "the prompt texts are read on demand");
    const text: string[] = [];
    for (let cursor: string | undefined, done = false; !done;) {
      const content = await instance.getConversationContent(system!.contentRef, cursor);
      for (const chunk of content.chunks) {
        assert.equal(chunk.type, "text");
        if (chunk.type === "text") text[chunk.blockIndex] = (text[chunk.blockIndex] ?? "") + chunk.text;
      }
      cursor = content.nextCursor;
      done = content.complete;
    }
    assert.deepEqual(text, ["Fixture system prompt.", projectContext, JSON.stringify(readTool, null, 2)]);

    const tree = await instance.getTree();
    assert.deepEqual(tree.nodes.filter((node) => node.displayClass !== "metadata").map((node) => node.entryId), conversation);
    const byId = new Map(tree.nodes.map((node) => [node.entryId, node]));
    assert.deepEqual(["s1", "w1", "s2", "e1", "e2"].map((id) => [byId.get(id)?.displayClass, byId.get(id)?.summary]), [
      ["metadata", "System prompt: sections preamble, project_context \u00b7 tools +read"],
      ["metadata", "Cache warmed (extension override) \u00b7 $0.125 \u00b7 fixture/fixture-model"],
      ["metadata", "System prompt: removed sections project_context \u00b7 tools \u2212read"],
      ["metadata", "Removed from model context: provider overloaded"],
      ["metadata", "Replaced in model context: second prompt"],
    ]);

    assert.equal(instance.snapshot().metrics?.cost, 0.625, "cache warming counts toward the session total");
  } finally {
    await instance.disposeUnpublished();
    await rm(root, { recursive: true, force: true });
  }
});
