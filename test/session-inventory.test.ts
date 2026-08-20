import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
