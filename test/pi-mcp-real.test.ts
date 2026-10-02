import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

const PROVIDER = "mcp-loopback";
const MODEL = "mcp-loopback-model";
const PROMPT = "Ask the harbor server to echo a word";
const SCRIPT = "const echoed = await tools.mcp__harbor__echo({ text: \"lantern\" });\nreturn echoed;";

/** The smallest stdio MCP server: one `echo` tool. */
const MCP_SERVER = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "harbor", version: "1.0.0" } } });
  if (method === "tools/list") return send({ id, result: { tools: [{ name: "echo", description: "Echo a word back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  if (method === "tools/call") return send({ id, result: { content: [{ type: "text", text: "harbor echoed " + params.arguments.text }] } });
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: "Method not found" } });
});
`;

test("a Work reaches a configured MCP server through codemode and reports the server with /mcp", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-mcp-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const serverPath = join(root, "harbor-mcp.mjs");
  const socketPath = join(root, "dock.sock");
  const model = new LoopbackModel();
  const events: DockEvent[] = [];
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentDir, { recursive: true })]);
  await chmod(root, 0o700);
  await model.start();
  await Promise.all([
    writeFile(serverPath, MCP_SERVER),
    writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl: `${model.origin}/v1`, api: "openai-completions", apiKey: "mcp-loopback-literal-key",
          models: [{ id: MODEL, name: "MCP loopback model", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, retry: { enabled: false } })),
    writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { harbor: { command: process.execPath, args: [serverPath] } } })),
  ]);
  const registry = new DockRegistry(
    (input) => createPiInstance({ ...input, agentDir, sessionDir, workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir }) }),
    () => "mcp-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 5_000 });
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;
  try {
    await host.start();
    const work = await client.create(cwd, "mcp", "mcp-create");
    follower = await client.streamEvents(work.id, { onEvent: (event) => events.push(event) });

    await client.prompt(work.id, PROMPT, "prompt", "mcp-run");
    const settled = await waitForEvent(events, (event) => event.type === "run.settled" && event.data.operationId === "mcp-run");
    assert.equal(settled.type === "run.settled" && settled.data.result, "succeeded");
    assert.ok(model.requests.some((body) => JSON.stringify(body).includes("harbor echoed lantern")), "the script's MCP result reaches the model");
    assert.ok((await client.tools(work.id)).tools.some((tool) => tool.name === "mcp__harbor__echo"), "the server's tool is listed");

    const statusStart = events.length;
    await client.prompt(work.id, "/mcp", "prompt", "mcp-status");
    const status = await waitForEvent(events, (event) => event.type === "extension.notification" && event.data.operationId === "mcp-status", statusStart);
    assert.ok(status.type === "extension.notification" && /harbor: connected, 1 tools/u.test(status.data.message));
  } finally {
    follower?.close();
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await model.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForEvent(events: DockEvent[], predicate: (event: DockEvent) => boolean, from = 0): Promise<DockEvent> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the expected event did not arrive");
}

/** OpenAI-compatible loopback: the first reply runs a codemode script, the next one answers. */
class LoopbackModel {
  readonly requests: unknown[] = [];
  origin = "";
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((request, response) => { void this.respond(request, response); });

  async start(): Promise<void> {
    this.server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const messages = (body as { messages?: { role?: string }[] }).messages ?? [];
    if (messages.at(-1)?.role !== "tool") {
      delta(response, { role: "assistant", tool_calls: [{ index: 0, id: "codemode_call", type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: SCRIPT }) } }] });
      finish(response, "tool_calls");
      return;
    }
    delta(response, { role: "assistant", content: "the harbor answered" });
    finish(response, "stop");
  }
}

function delta(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({ id: "mcp", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`);
}

function finish(response: ServerResponse, reason: "stop" | "tool_calls"): void {
  response.write(`data: ${JSON.stringify({ id: "mcp", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}
