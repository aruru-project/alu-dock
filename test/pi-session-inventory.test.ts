import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createPiSessionInventory } from "../src/pi/session-inventory.js";

test("Pi session inventory preserves authoritative names in a rebuildable incremental metadata index", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-index-"));
  const sessionsRoot = join(root, "sessions");
  const cachePath = join(root, "state", "session-inventory-v1.json");
  const project = join(root, "project");
  const otherProject = join(root, "other");
  await Promise.all([mkdir(project), mkdir(otherProject)]);
  const projectDirectory = join(sessionsRoot, sessionDirectoryName(project));
  const otherDirectory = join(sessionsRoot, sessionDirectoryName(otherProject));
  await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(otherDirectory, { recursive: true })]);
  context.after(async () => rm(root, { recursive: true, force: true }));

  const important = join(projectDirectory, "important.jsonl");
  await writeFile(important, lines(
    { type: "session", version: 3, id: "important-session", timestamp: "2026-07-17T00:00:00.000Z", cwd: project },
    { type: "session_info", id: "name-1", parentId: null, timestamp: "2026-07-17T00:00:01.000Z", name: "Important Project" },
    { type: "message", id: "message-1", parentId: "name-1", timestamp: "2026-07-17T00:00:02.000Z", message: { role: "user", content: `a false \"session_info\" token ${"x".repeat(2 * 1024 * 1024)}` } },
  ));
  const other = join(otherDirectory, "other.jsonl");
  await writeFile(other, lines(
    { type: "session", version: 3, id: "other-session", timestamp: "2026-07-17T00:00:00.000Z", cwd: otherProject },
  ));
  await writeFile(join(projectDirectory, "old.jsonl"), lines(
    { type: "session", version: 1, id: "old-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: "" },
  ));
  await writeFile(join(projectDirectory, "invalid.jsonl"), `${JSON.stringify({ type: "message" })}\n`);
  await symlink(important, join(projectDirectory, "linked.jsonl"));

  const inventory = createPiSessionInventory({ sessionsRoot, cachePath });
  const all = await inventory.list(project, "all");
  assert.deepEqual(all.sessions.map((session) => session.sessionId).sort(), ["important-session", "old-session", "other-session"]);
  assert.equal(all.sessions.find((session) => session.sessionId === "important-session")?.name, "Important Project");
  assert.equal(all.incomplete, true);
  assert.ok(all.diagnostics.some((diagnostic) => diagnostic.path === join(projectDirectory, "invalid.jsonl")));
  assert.deepEqual((await inventory.list(project, "cwd")).sessions.map((session) => session.sessionId).sort(), ["important-session", "old-session"]);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);

  await appendFile(important, lines(
    { type: "session_info", id: "name-2", parentId: "message-1", timestamp: "2026-07-17T00:00:03.000Z", name: "Renamed Project" },
  ));
  assert.equal((await inventory.list(project, "cwd")).sessions[0]?.name, "Renamed Project");

  await appendFile(important, lines(
    { type: "session_info", id: "name-3", parentId: "name-2", timestamp: "2026-07-17T00:00:04.000Z", name: "" },
  ));
  assert.equal((await inventory.list(project, "cwd")).sessions.find((session) => session.sessionId === "important-session")?.name, undefined);

  await writeFile(important, lines(
    { type: "session", version: 3, id: "replacement-session", timestamp: "2026-07-18T00:00:00.000Z", cwd: otherProject },
    { type: "session_info", id: "replacement-name", parentId: null, timestamp: "2026-07-18T00:00:01.000Z", name: "Replacement Project" },
    { type: "message", id: "replacement-message", parentId: "replacement-name", timestamp: "2026-07-18T00:00:02.000Z", message: { role: "user", content: "y".repeat(3 * 1024 * 1024) } },
  ));
  const replaced = await inventory.list(project, "cwd");
  assert.equal(replaced.sessions.some((session) => session.sessionId === "important-session"), false);
  assert.equal(replaced.sessions.find((session) => session.sessionId === "replacement-session")?.name, "Replacement Project");

  const reopened = createPiSessionInventory({ sessionsRoot, cachePath });
  assert.equal((await reopened.list(project, "all")).sessions.length, 3);
});

test("Pi session inventory distinguishes an unreadable root from a genuinely empty inventory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-index-failure-"));
  const project = join(root, "project");
  const sessionsRoot = join(root, "sessions-not-a-directory");
  await mkdir(project);
  await writeFile(sessionsRoot, "not a directory\n");
  context.after(async () => rm(root, { recursive: true, force: true }));

  const inventory = createPiSessionInventory({ sessionsRoot });
  const result = await inventory.list(project, "all");
  assert.deepEqual(result.sessions, []);
  assert.equal(result.incomplete, true);
  assert.match(result.diagnostics[0]?.message ?? "", /could not be scanned/u);
  assert.equal(result.diagnostics[0]?.path, sessionsRoot);
});

test("Pi session inventory returns authoritative scans when the rebuildable cache cannot be written", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-cache-failure-"));
  const project = join(root, "project");
  const sessionsRoot = join(root, "sessions");
  const projectDirectory = join(sessionsRoot, sessionDirectoryName(project));
  const cacheParent = join(root, "cache-parent-is-a-file");
  const cachePath = join(cacheParent, "session-inventory-v1.json");
  await mkdir(project);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(join(projectDirectory, "session.jsonl"), lines(
    { type: "session", version: 3, id: "cache-independent", timestamp: "2026-07-18T00:00:00.000Z", cwd: project },
  ));
  await writeFile(cacheParent, "not a directory\n");
  context.after(async () => rm(root, { recursive: true, force: true }));

  const result = await createPiSessionInventory({ sessionsRoot, cachePath }).list(project, "all");
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["cache-independent"]);
  assert.equal(result.incomplete, true);
  assert.ok(result.diagnostics.some((diagnostic) => /cache could not be updated/u.test(diagnostic.message)));
});

function sessionDirectoryName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

function lines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
