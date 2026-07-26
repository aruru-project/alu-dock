import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { parseCommandsResult } from "../src/control/protocol.js";
import { AgentCompactionKnownFailureError } from "../src/core/agent-worker.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

const EXTENSION_SOURCE = (logPath: string): string => `
import { appendFileSync } from "node:fs";

export default function stage3Fixture(pi) {
  const record = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");
  pi.on("session_start", (event) => record("start:" + event.reason));
  pi.on("session_shutdown", (event) => record("shutdown:" + event.reason));
  pi.on("session_info_changed", (event) => record("name:" + (event.name ?? "")));
  pi.on("session_before_compact", (event) => {
    record("before_compact:" + event.reason);
    return {
      compaction: {
        summary: "deterministic extension summary",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  pi.on("session_compact", (event) => record("compact:" + event.reason + ":" + event.fromExtension));
  pi.registerCommand("fixture-a", { description: "Prefix fixture", handler: async () => {} });
  pi.registerCommand("fixture-a-long", { description: "Long prefix fixture", handler: async () => {} });
  pi.registerCommand("fixture-b", { description: "Second prefix fixture", handler: async () => {} });
  pi.registerCommand("fixture-b-long", { description: "Second long prefix fixture", handler: async () => {} });
}
`;

test("real Pi Stage 3 round-trips temporary session files without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-stage3-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const extensionDir = join(agentDir, "extensions");
  const lifecycleLog = join(root, "extension-lifecycle.log");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(extensionDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-network" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { openai: { modelOverrides: { "gpt-4o-mini": { contextWindow: 111_111 } } } },
  }));
  await writeFile(join(extensionDir, "stage3-fixture.ts"), EXTENSION_SOURCE(lifecycleLog));

  const target = SessionManager.create(cwd, sessionDir);
  type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];
  const user = (text: string): SessionMessage => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as SessionMessage);
  const assistant = (text: string): SessionMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as SessionMessage);
  target.appendMessage(user("old request"));
  target.appendMessage(assistant("old answer"));
  target.appendMessage(user("recent context ".repeat(1_000)));
  target.appendMessage(assistant("recent answer"));
  const targetFile = target.getSessionFile();
  assert.ok(targetFile);

  const previousPiOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const instance = await (async () => {
    try {
      return await createPiInstance({
        cwd,
        agentDir,
        sessionDir,
        projectTrusted: true,
        name: "stage3-real",
        workerTimeouts: { mutationMs: 10_000 },
      });
    } finally {
      if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousPiOffline;
    }
  })();
  try {
    assert.equal(instance.snapshot().metrics?.context?.contextWindow, 111_111);
    const updated = await instance.updateSetting({ key: "autoRetry", value: false }, "real-setting");
    assert.equal(updated.value, false);
    assert.ok((await instance.setActiveTools(["read"], "real-tools")).tools.find((tool) => tool.name === "read")?.active);

    assert.equal((await instance.switchSession("real-resume-1", targetFile, { canonicalCwd: cwd, projectTrusted: true })).cancelled, false);
    await instance.setSessionName("real-name", "Stage 3 named");
    assert.equal(instance.snapshot().name, "Stage 3 named");

    const compacted = await instance.compactSession("real-compact", "preserve decisions");
    assert.equal(compacted.summary, "deterministic extension summary");
    assert.ok(compacted.firstKeptEntryId.length > 0);
    const compactionEvents = instance.eventsSince().events.filter((event) => event.type === "compaction.started" || event.type === "compaction.completed");
    assert.deepEqual(compactionEvents.map((event) => event.data.operationId), ["real-compact", "real-compact"]);
    assert.ok((await instance.getHistoryPage(undefined, 200)).entries.some((entry) => entry.content.some((block) => block.type === "text" && block.text === "deterministic extension summary")));

    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { openai: { modelOverrides: { "gpt-4o-mini": { contextWindow: 222_222 } } } },
    }));
    assert.equal((await instance.reloadSession("real-reload")).cancelled, false);
    assert.equal(instance.snapshot().metrics?.context?.contextWindow, 222_222);
    assert.equal((await instance.newSession("real-new")).cancelled, false);
    const newSessionFile = instance.snapshot().executor.sessionFile;
    assert.ok(newSessionFile);
    assert.notEqual(newSessionFile, targetFile);
    await instance.setSessionName("real-new-name", "Temporary child");
    assert.ok(newSessionFile.startsWith(`${sessionDir}/`), "Pi reserves the persisted path and writes it lazily after an assistant message");
    await assert.rejects(
      instance.compactSession("real-empty-compact"),
      (error: unknown) => error instanceof AgentCompactionKnownFailureError
        && error.reason === "nothing_to_compact",
    );
    assert.equal(instance.snapshot().execution, "idle");
    assert.equal((await instance.switchSession("real-resume-2", targetFile, { canonicalCwd: cwd, projectTrusted: true })).cancelled, false);
    assert.equal(instance.snapshot().runtimeGeneration, 5);
    assert.equal(instance.snapshot().name, "Stage 3 named");
    assert.equal(instance.snapshot().executor.sessionFile, targetFile);

    const persistedSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      retry?: { enabled?: unknown };
      compaction?: { enabled?: unknown; reserveTokens?: unknown; keepRecentTokens?: unknown };
    };
    assert.equal(persistedSettings.retry?.enabled, false);
    assert.deepEqual(persistedSettings.compaction, { enabled: true, reserveTokens: 100, keepRecentTokens: 100 });
    const resources = await instance.getResources();
    assert.ok(resources.resources.some((resource) => resource.kind === "extension" && resource.name.includes("stage3-fixture")));
    const commands = parseCommandsResult(await instance.getCommands()).commands;
    assert.deepEqual(commands.map((command) => command.name), ["fixture-a", "fixture-a-long", "fixture-b", "fixture-b-long"]);

    await instance.stop("real-stop");
    const lifecycle = (await readFile(lifecycleLog, "utf8")).trim().split("\n");
    assert.deepEqual(lifecycle, [
      "start:startup",
      "name:stage3-real",
      "shutdown:resume",
      "start:resume",
      "name:Stage 3 named",
      "before_compact:manual",
      "compact:manual:true",
      "shutdown:reload",
      "start:reload",
      "shutdown:new",
      "start:new",
      "name:Temporary child",
      "shutdown:resume",
      "start:resume",
      "shutdown:quit",
    ]);
  } catch (error) {
    const lifecycle = await readFile(lifecycleLog, "utf8").catch(() => "<unavailable>");
    throw new Error(`Stage 3 lifecycle before failure:\n${lifecycle.trim()}`, { cause: error });
  } finally {
    if (instance.snapshot().lifecycle === "active") await instance.stop("real-cleanup").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
