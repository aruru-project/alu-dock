import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ControlClientError } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { ptyUserEnvironment } from "./support/pty-user-environment.js";

test("open a saved child under its original parent, then open the same file again without creating another Work", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["parents-model", "saved-model"], { prefix: "alu-open-saved-child-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const parent = await client.create(team.cwd, "Review lead", "review-lead", undefined, undefined, undefined,
    { parentId: assistant.id, allowedTools: ["read", "dock_spawn"] });
  const cwd = join(team.root, "original-project");
  await mkdir(cwd);
  const old = SessionManager.create(cwd, join(team.root, "sessions"));
  old.appendSessionInfo("Original reviewer");
  old.appendModelChange("saved-model", "fixture");
  old.appendMessage({ role: "user", content: "Previously permitted bash, write and read.", timestamp: 1 });
  old.appendMessage({ role: "assistant", content: [{ type: "text", text: "Prior review is here." }],
    api: "openai-completions", provider: "saved-model", model: "fixture", stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const file = old.getSessionFile()!;
  const env = await ptyUserEnvironment(team.root, { ALU_DOCK_PTY_ACTION: "open-saved-child" });
  const open = async (...flags: string[]) => {
    const { stdout } = await promisify(execFile)("python3", [join(process.cwd(), "test/fixtures/pty-tui-driver.py"),
      process.execPath, join(process.cwd(), "dist/src/cli.js"), "--socket", team.host!.socketPath,
      "open", "--session-file", file, "--parent", "Review lead", ...flags], { cwd: team.root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const terminal = JSON.parse(stdout);
    const screen = Buffer.from(terminal.output, "base64").toString();
    assert.equal(terminal.status, 0, screen.slice(-2500));
    return screen;
  };
  const first = await open();
  const [child] = (await client.list()).filter(work => work.parentId === parent.id);
  assert.ok(child);
  assert.ok(first.includes("Prior review is here."), "The terminal opens the old conversation");
  assert.equal(child.name, "Original reviewer");
  assert.equal(child.cwd, cwd);
  assert.deepEqual(child.executor.model, { provider: "saved-model", id: "fixture" });
  assert.equal(child.executor.sessionFile, file);
  assert.equal(child.execution, "idle");
  assert.deepEqual((await client.tools(child.id)).tools.map(tool => tool.name), ["dock_send"]);
  await open("--allow-tool", "read"); // Existing Work keeps its grants.
  assert.deepEqual((await client.list()).filter(work => work.parentId === parent.id).map(work => work.id), [child.id]);
  assert.deepEqual((await client.tools(child.id)).tools.map(tool => tool.name), ["dock_send"]);
  // After Stop the old conversation still opens, but as a new identity, with a fresh grant.
  await client.stop(child.id);
  // A lead that only has read cannot grant write when re-adopting an old file.
  await assert.rejects(client.adopt(file, undefined, undefined, undefined, parent.hostId,
    { parentId: parent.id, allowedTools: ["write"] }), (error: unknown) => error instanceof ControlClientError && error.code === "request_failed");
  // Losing the archived model is not permission to use a different, potentially billable model.
  const modelsFile = join(team.agentDir, "models.json");
  const models = await readFile(modelsFile, "utf8"), originalSession = await readFile(file, "utf8");
  const withoutSaved = JSON.parse(models);
  delete withoutSaved.providers["saved-model"];
  await writeFile(modelsFile, JSON.stringify(withoutSaved));
  await assert.rejects(trustOnce(trust => client.adopt(file, undefined, "missing-saved-model", trust, parent.hostId,
    { parentId: parent.id })), (error: unknown) => error instanceof ControlClientError && error.code === "model_not_found");
  assert.equal(await readFile(file, "utf8"), originalSession);
  await writeFile(modelsFile, models);
  await open("--allow-tool", "read");
  const [replacement] = (await client.list()).filter(work => work.parentId === parent.id);
  assert.ok(replacement && replacement.id !== child.id);
  assert.deepEqual((await client.tools(replacement.id)).tools.map(tool => tool.name).sort(), ["dock_send", "read"]);
  assert.equal(team.providers["saved-model"].requests.length, 0, "Opening the file did not start a task");
});
