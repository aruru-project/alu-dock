import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiInstance } from "../src/pi/create-pi-instance.js";

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: string, timestamp: number): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text: content }], api: "openai-responses", provider: "fixture", model: "fixture", usage: ZERO_USAGE, stopReason: "stop", timestamp };
}

async function waitForHook(path: string, predicate: (record: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => "");
    const records = content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    if (records.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for real Pi extension hook");
}

test("real Pi extension tree/fork cancellation and replacement hooks remain authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-real-tree-hooks-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const extensionsDir = join(agentDir, "extensions");
  const hookLog = join(root, "hooks.jsonl");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(extensionsDir, { recursive: true })]);
  await writeFile(join(extensionsDir, "tree-hooks.js"), `
import { appendFileSync } from "node:fs";
const path = ${JSON.stringify(hookLog)};
const record = (value) => appendFileSync(path, JSON.stringify(value) + "\\n");
export default function (pi) {
  pi.on("session_start", (event) => record({ type: event.type, reason: event.reason }));
  pi.on("session_before_tree", async (event) => {
    record({ type: event.type, targetId: event.preparation.targetId });
    if (event.preparation.targetId === "u1") return { cancel: true };
    if (event.preparation.targetId === "a2") {
      await new Promise((resolve) => event.signal.addEventListener("abort", resolve, { once: true }));
      record({ type: "tree_abort_signal", targetId: event.preparation.targetId });
      return { cancel: true };
    }
  });
  pi.on("session_tree", (event) => record({ type: event.type, newLeafId: event.newLeafId }));
  pi.on("session_before_fork", (event) => {
    record({ type: event.type, entryId: event.entryId, position: event.position });
    if (event.entryId === "u1" || event.position === "at") return { cancel: true };
  });
  pi.on("session_shutdown", (event) => record({ type: event.type, reason: event.reason }));
}
`, { mode: 0o600 });

  const sessionFile = join(sessionDir, "hook-source.jsonl");
  const timestamp = "2026-07-14T00:00:00.000Z";
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "hook-source-session", timestamp, cwd }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "first prompt", timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-14T00:00:01.000Z", message: assistant("first answer", 2) }),
    JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-07-14T00:00:02.000Z", message: { role: "user", content: "second prompt", timestamp: 3 } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-14T00:00:03.000Z", message: assistant("second answer", 4) }),
    "",
  ].join("\n"), { mode: 0o600 });

  const instance = await createPiInstance({
    id: "real-tree-hooks",
    creationOperationId: "create-real-tree-hooks",
    hostEpoch: "real-tree-hooks-host",
    cwd,
    agentDir,
    sessionDir,
    sessionFile,
    projectTrusted: true,
    tools: [],
  });
  try {
    const originalFile = instance.snapshot().executor.sessionFile;
    assert.deepEqual(await instance.navigateSession("navigate-cancelled", "u1"), { cancelled: true, summaryCreated: false });
    assert.equal(instance.snapshot().runtimeGeneration, 1);
    assert.equal(instance.snapshot().executor.sessionFile, originalFile);
    assert.equal(instance.eventsSince().events.some((event) => event.type === "session.navigated"), false);

    const pendingNavigation = instance.navigateSession("navigate-abort", "a2", { summarize: true });
    await waitForHook(hookLog, (record) => record.type === "session_before_tree" && record.targetId === "a2");
    await instance.abort("abort-tree-summary");
    assert.deepEqual(await pendingNavigation, { cancelled: true, summaryCreated: false });
    assert.equal(instance.snapshot().lifecycle, "active");
    assert.equal(instance.snapshot().lastRun, "never");

    assert.deepEqual(await instance.navigateSession("navigate-success", "u2"), { cancelled: false, editorText: "second prompt", summaryCreated: false });
    assert.equal(instance.snapshot().runtimeGeneration, 1);
    assert.equal(instance.eventsSince().events.some((event) => event.type === "session.navigated"), true);

    assert.deepEqual(await instance.cloneSession("clone-cancelled", "a1"), { cancelled: true });
    assert.equal(instance.snapshot().runtimeGeneration, 1);
    assert.equal(instance.snapshot().executor.sessionFile, originalFile);

    assert.deepEqual(await instance.forkSession("fork-cancelled", "u1"), { cancelled: true });
    assert.equal(instance.snapshot().runtimeGeneration, 1);
    assert.equal(instance.snapshot().executor.sessionFile, originalFile);

    assert.deepEqual(await instance.forkSession("fork-success", "u2"), { cancelled: false, selectedText: "second prompt" });
    assert.equal(instance.snapshot().runtimeGeneration, 2);
    assert.notEqual(instance.snapshot().executor.sessionFile, originalFile);
    assert.equal(instance.snapshot().lastRun, "never");
    assert.equal(instance.eventsSince().events.some((event) => event.type === "run.started"), false);

    const records = (await readFile(hookLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.some((record) => record.type === "session_start" && record.reason === "startup"));
    assert.ok(records.some((record) => record.type === "session_before_tree" && record.targetId === "u1"));
    assert.ok(records.some((record) => record.type === "session_before_tree" && record.targetId === "u2"));
    assert.ok(records.some((record) => record.type === "tree_abort_signal" && record.targetId === "a2"));
    assert.equal(records.filter((record) => record.type === "session_tree").length, 1);
    assert.ok(records.some((record) => record.type === "session_before_fork" && record.entryId === "a1" && record.position === "at"));
    assert.ok(records.some((record) => record.type === "session_before_fork" && record.entryId === "u1" && record.position === "before"));
    assert.ok(records.some((record) => record.type === "session_before_fork" && record.entryId === "u2" && record.position === "before"));
    assert.ok(records.some((record) => record.type === "session_shutdown" && record.reason === "fork"));
    assert.ok(records.some((record) => record.type === "session_start" && record.reason === "fork"));
  } finally {
    await instance.disposeUnpublished();
    await rm(root, { recursive: true, force: true });
  }
});
