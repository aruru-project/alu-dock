import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineDockToolsAuthority } from "../src/control/main-machine-dock-tools.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { machineStateRoot, MainMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import type { DockToolsHostPort } from "../src/core/dock-tools.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DOCK_TOOL_NAMES } from "../src/pi/dock-tools-extension.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("real Pi Worker toggles Dock tools and exposes its readable usage guide", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-tools-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-network" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));

  let enabled = false;
  const dockToolsHostPort: DockToolsHostPort = {
    dockToolsEnabled: () => enabled,
    configureDockTools: async (_source, next) => { enabled = next; return { enabled }; },
    invokeDockTool: async () => ({
      type: "list",
      result: {
        trust: "untrusted_cross_instance",
        observedAt: "2026-07-28T20:00:00.000Z",
        instances: [],
        total: 0,
        truncated: false,
        includesHistory: false,
      },
    }),
    attachObservationSink: () => () => {},
  };

  const instance = await createPiInstance({
    cwd,
    agentDir,
    sessionDir,
    projectTrusted: true,
    dockToolsHostPort,
    dockToolsEnabled: false,
    workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir }),
    workerTimeouts: { mutationMs: 10_000 },
  });

  try {
    const commands = await instance.getCommands();
    const resources = await instance.getResources();
    assert.ok(commands.commands.some((command) => command.name === "dock-tools"), JSON.stringify({ commands, resources, events: instance.eventsSince().events }));
    const initial = await instance.listTools();
    assert.equal(resources.resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), false);
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(initial.tools.find((tool) => tool.name === name)?.active, false);
    }

    await instance.submit("/dock-tools on", "prompt", "observation-on");
    await waitFor(() => instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "observation-on"), "Dock tools command did not finish");
    assert.equal(enabled, true);
    const active = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(active.tools.find((tool) => tool.name === name)?.active, true);
    }
    const guidePath = active.tools.find((tool) => tool.name === "dock_list")?.description.split("Usage guide (read when needed): ")[1];
    assert.ok(guidePath, "enabled tools must point to their usage guide");
    assert.match(await readFile(guidePath, "utf8"), /^# Dock tools usage guide/u);
    assert.equal((await instance.getResources()).resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), false);

    await instance.reloadSession("dock-tools-reload");
    const reloaded = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(reloaded.tools.find((tool) => tool.name === name)?.active, true);
    }

    await instance.submit("/dock-tools off", "prompt", "observation-off");
    await waitFor(() => instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "observation-off"), "Dock tools off command did not finish");
    assert.equal(enabled, false);
    const disabled = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(disabled.tools.find((tool) => tool.name === name)?.active, false);
    }
  } finally {
    await instance.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

const CROSS_MACHINE_PROVIDER = "dock-tools-loopback";
const CROSS_MACHINE_MODEL = "dock-tools-model";
const CROSS_MACHINE_PROMPT = "Use dock_list once to find the Main sentinel.";
const MAIN_SENTINEL = "Main-owned sentinel";

test("a real Pi Worker executes dock_list through its SubHost and encrypted Main authority", { timeout: 50_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-cross-machine-dock-tools-"));
  await chmod(root, 0o700);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workerHome = join(root, "worker-home");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(sessionDir), mkdir(workerHome)]);

  const provider = new DockListLoopbackProvider();
  await provider.start();
  await Promise.all([
    writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [CROSS_MACHINE_PROVIDER]: {
          baseUrl: `${provider.origin}/v1`,
          api: "openai-completions",
          apiKey: "dock-tools-loopback-key",
          models: [{
            id: CROSS_MACHINE_MODEL,
            name: "Dock tools loopback model",
            reasoning: false,
            input: ["text"],
            contextWindow: 32_000,
            maxTokens: 2_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }), "utf8"),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: CROSS_MACHINE_PROVIDER,
      defaultModel: CROSS_MACHINE_MODEL,
      retry: { enabled: false },
    }), "utf8"),
  ]);

  const mainCatalog = join(root, "main", "catalog.json");
  const subCatalog = join(root, "sub", "catalog.json");
  const joinPath = join(root, "join.json");
  const socketPath = join(root, "main.sock");
  const port = await reservePort();
  const machineState = new MainMachineState(machineStateRoot(mainCatalog), "Dock Tools Main");
  await machineState.initialize();
  await writeMachineJoinFile(joinPath, await machineState.createJoin());
  const listenerSettings = new MachineSettingsState(join(root, "main-listener"));
  await listenerSettings.writeMainConnections({ enabled: true, port });

  const mainRegistry = new DockRegistry(async (input) => new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    key: input.key,
    session: new DelayedAgentWorkerConnection(`main-worker-${input.id}`),
  }));
  const sentinel = await mainRegistry.create({ operationId: "main-sentinel-create", cwd: workspace, name: MAIN_SENTINEL });
  assert.equal(sentinel.snapshot().displayName, MAIN_SENTINEL);

  let dockTools!: MainMachineDockToolsAuthority;
  let mainHost!: DockHost;
  const controller = new MainMachineController({
    state: machineState,
    settingsState: listenerSettings,
    bindAddress: "::1",
    mainHostEpoch: mainRegistry.hostEpoch,
    localSnapshots: () => mainRegistry.list(),
    invokeDockTool: (sourceMainId, sourceMachineId, request) => dockTools.invoke(sourceMainId, sourceMachineId, request),
  });
  dockTools = new MainMachineDockToolsAuthority({
    controller: () => controller,
    instances: () => mainHost.instanceDirectory(),
    localClient: new DockClient({ socketPath }),
    deliverLocalNotification: async () => {},
  });
  mainHost = new DockHost({ socketPath, registry: mainRegistry, remoteInstances: controller });
  let child: ChildProcess | undefined;
  context.after(async () => {
    if (child) await stopChild(child);
    await mainHost.stop().catch(() => {});
    await provider.stop();
    await rm(root, { recursive: true, force: true });
  });
  await mainHost.start();

  child = spawn(process.execPath, [
    new URL("./fixtures/subhost-machine.js", import.meta.url).pathname,
    subCatalog,
    workspace,
    "::1",
    String(port),
    joinPath,
    "real-pi-dock-tools",
    agentDir,
    sessionDir,
    workerHome,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedProcessEnvironment(root, { XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data") }),
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { childStdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { childStderr += chunk.toString("utf8"); });

  const client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 20_000 });
  const remote = await waitForRemotePi(client).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${childStderr}`); });
  const ready = await waitForFixtureReady(() => childStdout).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${childStderr}`); });
  assert.equal(typeof ready.workerPid, "number");
  assert.notEqual(ready.workerPid, child.pid, "Pi must execute in a Worker process, not the SubHost process");

  await client.prompt(remote.id, "/dock-tools on", "prompt", "enable-cross-machine-dock-tools");
  await waitFor(async () => (await client.tools(remote.id)).tools.some((tool) => tool.name === "dock_list" && tool.active), "real SubHost Worker did not activate dock_list");
  const accepted = await client.prompt(remote.id, CROSS_MACHINE_PROMPT, "prompt", "cross-machine-dock-list");
  assert.equal(accepted.receipt.delivery, "prompt");
  let toolHistory: unknown;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = (await client.history(remote.id)).entries;
    toolHistory = entries.find((entry) => entry.source === "tool" && entry.toolName === "dock_list" && JSON.stringify(entry).includes(MAIN_SENTINEL));
    if (toolHistory) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(toolHistory, `real dock_list result did not reach Worker history; recent provider requests=${JSON.stringify(provider.requests.slice(-2))}; stderr=${childStderr}`);
  assert.ok(provider.requests.some(requestAdvertisesDockList), "the real Worker must advertise the registered dock_list tool to its provider");
  assert.ok(provider.requests.some(requestContainsSentinelToolResult), "the provider continuation must contain dock_list's real Main-owned sentinel result");
  assert.equal(provider.error, undefined);
});

class DockListLoopbackProvider {
  readonly requests: unknown[] = [];
  readonly sockets = new Set<Socket>();
  readonly server = createHttpServer((request, response) => {
    void this.respond(request, response).catch((error: unknown) => {
      this.error = error instanceof Error ? error : new Error(String(error));
      response.destroy(this.error);
    });
  });
  origin = "";
  error: Error | undefined;

  constructor() {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer dock-tools-loopback-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (!requestContainsToolResult(body)) {
      sendProviderDelta(response, { role: "assistant", content: "checking Dock; " });
      sendProviderDelta(response, { tool_calls: [{ index: 0, id: "dock_list_call", type: "function", function: { name: "dock_list", arguments: "{}" } }] });
      finishProviderResponse(response, "tool_calls");
      return;
    }
    sendProviderDelta(response, { role: "assistant", content: "Main sentinel found" });
    finishProviderResponse(response, "stop");
  }
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForRemotePi(client: DockClient): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const remote = (await client.list("all")).find((snapshot) => snapshot.creationOperationId === "native-create");
    if (remote?.lifecycle === "active" && remote.execution === "idle") return remote;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("real Pi SubHost instance did not become ready");
}

async function waitForFixtureReady(stdout: () => string): Promise<{ workerPid?: number }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    for (const line of stdout().split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { kind?: unknown; workerPid?: number };
        if (value.kind === "ready") return value;
      } catch { /* wait for a complete line */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("real Pi SubHost fixture did not report ready");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function requestAdvertisesDockList(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("tools" in body) || !Array.isArray(body.tools)) return false;
  return body.tools.some((tool) => JSON.stringify(tool).includes('"name":"dock_list"'));
}

function requestContainsToolResult(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return false;
  return body.messages.some((message) => message !== null && typeof message === "object" && "role" in message && message.role === "tool");
}

function requestContainsSentinelToolResult(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return false;
  return body.messages.some((message) => message !== null && typeof message === "object" && "role" in message
    && message.role === "tool" && JSON.stringify(message).includes(MAIN_SENTINEL));
}

function sendProviderDelta(response: ServerResponse, delta: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-dock-tools",
    object: "chat.completion.chunk",
    created: 1,
    model: CROSS_MACHINE_MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function finishProviderResponse(response: ServerResponse, finishReason: "stop" | "tool_calls"): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-dock-tools",
    object: "chat.completion.chunk",
    created: 1,
    model: CROSS_MACHINE_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
