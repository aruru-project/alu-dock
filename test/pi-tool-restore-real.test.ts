import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

const DOCK_TOOL_NAMES = ["dock_list", "dock_send", "dock_create"];

// Card #615: since Pi 1.3 a resumed session restores the tools it last used.
// Dock's own switch still decides the Dock tools, whatever the session recorded.
test("reopening a Work or switching back to its session keeps the person's tools, and Dock tools follow their switch", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-tool-restore-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the provider request. */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const workerPids: number[] = [];
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  context.after(async () => {
    client?.closeActiveConnections();
    await host?.stop().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "tool-restore-loopback": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-key",
    models: [{ id: "fixture", name: "Tool restore fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "tool-restore-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
  }));
  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input, agentDir, sessionDir, projectTrusted: true,
      workerEnvironment: isolatedProcessEnvironment(home, {
        PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
        NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      }),
      onWorkerSpawn: (pid) => workerPids.push(pid),
    }),
    () => "tool-restore-instance",
    { reopenTargetResolver: { resolve: resolvePiReopenTarget } },
  );
  const socketPath = join(root, "dock.sock");
  host = new DockHost({ socketPath, registry });
  await host.start();
  const dock = client = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 10_000 });
  const work = await dock.create(cwd, "Tool restore", "tool-restore-create");
  const idle = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await dock.read(work.id)).instance.execution === "idle") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("Work did not become idle");
  };
  const active = async () => new Set((await dock.tools(work.id)).tools.filter((tool) => tool.active).map((tool) => tool.name));
  const assertToolsKept = async (moment: string) => {
    const names = await active();
    for (const name of ["read", "write"]) assert.equal(names.has(name), true, `${name} stays on after ${moment}`);
    for (const name of ["bash", "edit"]) assert.equal(names.has(name), false, `${name} stays off after ${moment}`);
    for (const name of DOCK_TOOL_NAMES) assert.equal(names.has(name), false, `${name} follows the Dock tools switch after ${moment}`);
  };

  // The session records read, write and the Dock tools; then the person turns Dock tools off.
  await dock.setActiveTools(work.id, ["read", "write"], "tool-restore-choose");
  await dock.prompt(work.id, "/dock-tools on", "auto", "tool-restore-dock-on");
  await idle();
  await dock.prompt(work.id, "Record the tools.", "auto", "tool-restore-record");
  await idle();
  await dock.prompt(work.id, "/dock-tools off", "auto", "tool-restore-dock-off");
  await idle();
  const sessionFile = (await dock.read(work.id)).instance.executor.sessionFile;
  assert.ok(sessionFile);

  process.kill(workerPids.at(-1)!, "SIGKILL");
  for (let attempt = 0; attempt < 200 && (await dock.status(work.id)).lifecycle !== "runtime_error"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await dock.reopen(work.id, "tool-restore-reopen");
  await assertToolsKept("reopening the Work");

  await dock.newSession(work.id, undefined, "tool-restore-new");
  await dock.switchSession(work.id, sessionFile, "tool-restore-switch-back");
  await assertToolsKept("switching back to the session");
});
