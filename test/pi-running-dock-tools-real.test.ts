import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

// 2026-09-12 alu incident: /dock-tools on reloaded extensions while a model
// response still held the old Bash tool. Only the HTTP model peer is scripted.
test("switching Dock tools during a response keeps its Bash call usable", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-running-dock-tools-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const pendingResponses: ServerResponse[] = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real provider request. */ }
    const index = requestCount++;
    if (index % 2 === 0) {
      pendingResponses.push(response);
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sendChunk(response, { role: "assistant", content: "Bash completed." }, null);
      sendChunk(response, {}, "stop");
      response.end("data: [DONE]\n\n");
    }
  });
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;
  const events: DockEvent[] = [];
  try {
    await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "reload-loopback": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-key",
      models: [{ id: "fixture", name: "Reload fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "reload-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
    }));
    const registry = new DockRegistry((input) => createPiInstance({
      ...input, agentDir, sessionDir,
      workerEnvironment: {
        HOME: home, USERPROFILE: home, PATH: process.env.PATH, LANG: process.env.LANG,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
        PI_OFFLINE: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      },
    }));
    const socketPath = join(root, "dock.sock");
    host = new DockHost({ socketPath, registry }); await host.start();
    client = new DockClient({ socketPath, timeoutMs: 5_000 });
    const work = await client.create(cwd, "Running tool toggle", "toggle-create");
    follower = await client.streamEvents(work.id, { onEvent: (event) => events.push(event) });

    for (const [index, action] of (["on", "off"] as const).entries()) {
      const operationId = `run-${action}`;
      await client.prompt(work.id, `Check Bash with Dock tools ${action}.`, "prompt", operationId);
      await waitFor(() => pendingResponses.length > index, "model request did not arrive");
      await client.prompt(work.id, `/dock-tools ${action}`, "auto", `toggle-${action}`);
      await waitFor(() => events.some((event) => event.type === "command.handled" && event.data.operationId === `toggle-${action}`), "tool toggle did not finish during the response");

      const response = pendingResponses[index]!;
      response.writeHead(200, { "content-type": "text/event-stream" });
      sendChunk(response, { role: "assistant", tool_calls: [{ index: 0, id: `bash-${action}`, type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: `printf kept > ${action}.txt` }) } }] }, null);
      sendChunk(response, {}, "tool_calls");
      response.end("data: [DONE]\n\n");
      await waitFor(() => events.some((event) => event.type === "run.settled" && event.data.operationId === operationId), "response did not finish");
      const completed = events.find((event) => event.type === "tool.completed" && event.data.toolCallId === `bash-${action}`);
      assert.ok(completed?.type === "tool.completed", JSON.stringify(events));
      assert.equal(completed.data.isError, false, completed.data.text);
      assert.equal(await readFile(join(cwd, `${action}.txt`), "utf8"), "kept");
      const tools = await client.tools(work.id);
      assert.equal(tools.tools.find((tool) => tool.name === "dock_list")?.active, action === "on");
    }
  } finally {
    follower?.close(); await follower?.done.catch(() => {});
    client?.closeActiveConnections();
    await host?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function sendChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-reload", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
