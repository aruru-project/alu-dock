import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiSessionInventory } from "../src/pi/session-inventory.js";

test("Pi session inventory provides the first user message without copying conversation content into its cache", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-preview-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, "project");
  const sessionsRoot = join(root, "sessions");
  const sessionDirectory = join(sessionsRoot, "project-sessions");
  const cachePath = join(root, "cache", "session-metadata.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-preview", timestamp: "2026-08-20T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: "assistant-first", parentId: null, timestamp: "2026-08-20T00:00:01.000Z", message: { role: "assistant", content: "setup" } }),
    JSON.stringify({ type: "message", id: "user-first", parentId: "assistant-first", timestamp: "2026-08-20T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "准备进行 Alu Dock 0.2 release 检查" }] } }),
    JSON.stringify({ type: "session_info", id: "name", parentId: "user-first", timestamp: "2026-08-20T00:00:03.000Z", name: "" }),
    "",
  ].join("\n"), "utf8");

  const first = await createPiSessionInventory({ sessionsRoot, cachePath }).list(cwd, "all");
  assert.equal(first.sessions[0]?.firstUserMessage, "准备进行 Alu Dock 0.2 release 检查");
  assert.doesNotMatch(await readFile(cachePath, "utf8"), /准备进行|firstUserMessage/u);

  const afterCacheReload = await createPiSessionInventory({ sessionsRoot, cachePath }).list(cwd, "all");
  assert.equal(afterCacheReload.sessions[0]?.firstUserMessage, "准备进行 Alu Dock 0.2 release 检查");
});

test("saved session shows its latest conversation time and recorded cost; renaming keeps the time and appends update both", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-summary-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, "project");
  const sessionsRoot = join(root, "sessions");
  const sessionDirectory = join(sessionsRoot, "project-sessions");
  const cachePath = join(root, "cache", "session-metadata.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const assistant = (id: string, at: string, cost?: number) => line({
    type: "message", id, parentId: null, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: "done" }], ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }), timestamp: Date.parse(at) },
  });
  const paid = join(sessionDirectory, "paid.jsonl");
  await writeFile(paid, [
    line({ type: "session", version: 3, id: "paid", timestamp: "2026-09-01T00:00:00.000Z", cwd }),
    line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: "整理发布清单", timestamp: Date.parse("2026-09-01T00:00:01.000Z") } }),
    assistant("a1", "2026-09-01T00:00:05.000Z", 0.5),
    line({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-09-01T00:00:09.000Z", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "x".repeat(10_000) }], timestamp: Date.parse("2026-09-01T00:00:09.000Z") } }),
  ].join(""), "utf8");
  const free = join(sessionDirectory, "free.jsonl");
  await writeFile(free, [
    line({ type: "session", version: 3, id: "free", timestamp: "2026-09-02T00:00:00.000Z", cwd }),
    assistant("a1", "2026-09-02T00:00:03.000Z"),
  ].join(""), "utf8");
  const empty = join(sessionDirectory, "empty.jsonl");
  await writeFile(empty, line({ type: "session", version: 3, id: "empty", timestamp: "2026-09-03T00:00:00.000Z", cwd }), "utf8");

  const byId = async () => new Map((await createPiSessionInventory({ sessionsRoot, cachePath }).list(cwd, "all")).sessions.map((session) => [session.sessionId, session]));
  let sessions = await byId();
  assert.equal(sessions.get("paid")?.lastActivityAt, "2026-09-01T00:00:05.000Z", "a tool result is not conversation activity");
  assert.equal(sessions.get("paid")?.costTotal, 0.5);
  assert.equal(sessions.get("free")?.lastActivityAt, "2026-09-02T00:00:03.000Z");
  assert.equal(sessions.get("free")?.costTotal, undefined, "no recorded cost stays distinguishable from zero");
  assert.equal(sessions.get("empty")?.lastActivityAt, "2026-09-03T00:00:00.000Z", "a session without messages dates from its start");

  await appendFile(paid, line({ type: "session_info", id: "n1", parentId: "t1", timestamp: "2026-09-20T00:00:00.000Z", name: "发布清单" }), "utf8");
  sessions = await byId();
  assert.equal(sessions.get("paid")?.name, "发布清单");
  assert.equal(sessions.get("paid")?.lastActivityAt, "2026-09-01T00:00:05.000Z", "renaming is not a conversation");

  await appendFile(paid, assistant("a2", "2026-09-21T00:00:00.000Z", 0.25), "utf8");
  sessions = await byId();
  assert.equal(sessions.get("paid")?.lastActivityAt, "2026-09-21T00:00:00.000Z");
  assert.equal(sessions.get("paid")?.costTotal, 0.75);
  assert.equal(sessions.get("paid")?.firstUserMessage, "整理发布清单", "a restarted Host still finds the preview before the appended part");

  // Pi 0.99 records paid cache warming between runs outside the conversation.
  await appendFile(paid, line({ type: "usage", id: "w1", parentId: "a2", timestamp: "2026-09-22T00:00:00.000Z", kind: "cache_warm", provider: "fixture", model: "fixture", usage: { cost: { total: 0.125 } } }), "utf8");
  sessions = await byId();
  assert.equal(sessions.get("paid")?.costTotal, 0.875);
  assert.equal(sessions.get("paid")?.lastActivityAt, "2026-09-21T00:00:00.000Z", "cache warming is not conversation activity");

  // Pi rewrites old-format sessions in place when it migrates them; the file only grows.
  const migrated = (await readFile(paid, "utf8")).replaceAll('"parentId":', '"migratedFrom":"an older Pi session format that had no entry ids yet","parentId":');
  await writeFile(paid, migrated, "utf8");
  sessions = await byId();
  assert.equal(sessions.get("paid")?.costTotal, 0.875, "a rewritten file is summarized again, not counted twice");
});
