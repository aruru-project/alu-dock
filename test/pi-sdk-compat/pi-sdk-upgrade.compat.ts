import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../../src/control/dock-client.js";
import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import type { DockEvent } from "../../src/core/managed-instance.js";
import { createPiInstance, resolvePiReopenTarget } from "../../src/pi/create-pi-instance.js";

const PROVIDER = "sdk-compat-loopback";
const MODEL = "sdk-compat-model";
const TOOL_PROMPT = "SDK_COMPAT_TOOL: read fixture.txt and report its contents";
const HOLD_PROMPT = "SDK_COMPAT_HOLD: keep this turn running";
const ERROR_PROMPT = "SDK_COMPAT_ERROR: surface the provider failure";
const RECOVERY_PROMPT = "SDK_COMPAT_RECOVERY: prove the worker recovered";
const TEMPLATE_COMMAND = "/queued-template";
const TEMPLATE_PROMPT = "SDK_COMPAT_TEMPLATE_EXPANDED: consume this queued template";
const FIXTURE_TEXT = "sdk-compat-read-sentinel";

/** Pi SDK admission gate. Intentionally not named *.test.ts; ordinary npm test must not collect it. */
test("Pi SDK remains compatible through the production Dock and Worker boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-pi-sdk-compat-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const homeDir = join(root, "home");
  const socketPath = join(root, "dock.sock");
  const priorSessionFile = join(sessionDir, "pi-0.81.1-session.jsonl");
  const fixture = new LoopbackChatFixture();
  const workerPids: number[] = [];
  const events: DockEvent[] = [];
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;

  try {
    await Promise.all([mkdir(cwd), mkdir(join(agentDir, "prompts"), { recursive: true }), mkdir(sessionDir), mkdir(homeDir), chmod(root, 0o700)]);
    await Promise.all([
      writeFile(join(cwd, "fixture.txt"), `${FIXTURE_TEXT}\n`, "utf8"),
      writeFile(priorSessionFile, priorPiSession(cwd), { encoding: "utf8", mode: 0o600 }),
    ]);
    await fixture.start();
    await Promise.all([
      writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `${fixture.origin}/v1`,
            api: "openai-completions",
            apiKey: "sdk-compat-dummy-literal-key",
            models: [{
              id: MODEL,
              name: "SDK compatibility loopback model",
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
        defaultProvider: PROVIDER,
        defaultModel: MODEL,
        retry: { enabled: false },
      }), "utf8"),
      writeFile(join(agentDir, "prompts", "queued-template.md"), [
        "---",
        "description: SDK compatibility queued template",
        "---",
        TEMPLATE_PROMPT,
        "",
      ].join("\n"), "utf8"),
    ]);

    const workerEnvironment = sanitizedWorkerEnvironment(homeDir);
    const registry = new DockRegistry(
      // This is the Registry's production Pi factory. The scenario enters only through DockClient.
      (input) => createPiInstance({
        ...input,
        agentDir,
        sessionDir,
        workerEnvironment,
        onWorkerSpawn: (pid) => workerPids.push(pid),
      }),
      () => "pi-sdk-compat-instance",
      { reopenTargetResolver: { resolve: resolvePiReopenTarget } },
    );
    host = new DockHost({ socketPath, registry });
    client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 8_000 });
    await host.start();
    const created = await client.create(
      cwd,
      "Pi SDK compatibility",
      "sdk-create",
      undefined,
      undefined,
      { excludeTools: ["bash"] },
    );
    assert.equal(workerPids.length, 1);
    assert.notEqual(workerPids[0], process.pid, "Pi must run in an independent OS process");
    assert.deepEqual(created.executor.model, { provider: PROVIDER, id: MODEL });
    const models = await client.models(created.id);
    assert.ok(models.models.some((model) => model.provider === PROVIDER && model.id === MODEL));
    assert.deepEqual(models.instance.executor.model, { provider: PROVIDER, id: MODEL });
    const tools = await client.tools(created.id);
    assert.equal(tools.tools.some((tool) => tool.name === "bash"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "read"), true);

    const switched = await client.switchSession(created.id, priorSessionFile, "sdk-open-prior-session");
    assert.equal(switched.instance.runtimeGeneration, 2);
    assert.deepEqual(switched.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.deepEqual(workerPids, [workerPids[0]!], "opening an existing session must stay inside the current Worker");
    const priorHistory = (await client.history(created.id)).entries;
    assert.ok(priorHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes("prior Pi 0.81.1 session")));

    follower = await client.streamEvents(created.id, { onEvent: (event) => events.push(event) });

    const firstEvent = events.length;
    const accepted = await client.prompt(created.id, TOOL_PROMPT, "prompt", "sdk-tool-run");
    assert.equal(accepted.receipt.delivery, "prompt");
    assert.equal(accepted.receipt.queued, false);
    const firstSettled = await waitForEvent(events, firstEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-tool-run");
    assert.equal(firstSettled.type, "run.settled");
    assert.equal(firstSettled.data.result, "succeeded");
    const firstRunEvents = events.slice(firstEvent);
    assert.ok(firstRunEvents.some((event) => event.type === "message.delta" && event.data.delta.length > 0), "provider text must stream as deltas");
    assert.ok(firstRunEvents.some((event) => event.type === "tool.started" && event.data.toolName === "read"));
    assert.ok(firstRunEvents.some((event) => event.type === "tool.completed" && event.data.toolName === "read" && !event.data.isError && event.data.text.includes(FIXTURE_TEXT)));
    assert.ok(fixture.requests.some((body) => hasToolResult(body, FIXTURE_TEXT)), "Pi must continue the provider turn with the real read result");
    assert.ok(fixture.requests.some((body) => JSON.stringify(body).includes("Pi Worker managed by Alu Dock")), "the managed Worker identity must reach Pi's system prompt");

    const initialHistory = (await client.history(created.id)).entries;
    assert.ok(initialHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes(TOOL_PROMPT)));
    assert.ok(initialHistory.some((entry) => entry.source === "tool" && entry.toolName === "read" && textOf(entry.content).includes(FIXTURE_TEXT)));
    assert.ok(initialHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("read completed successfully")));

    // Regression: the 2026-08-22 /sol-checkup incident left its Dock queue item in flight
    // because Pi queued the expanded template body while Dock tracked the slash command.
    const templateEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-template-hold");
    await waitForEvent(events, templateEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    const queuedTemplate = await client.prompt(created.id, TEMPLATE_COMMAND, "steer", "sdk-template-queued");
    assert.equal(queuedTemplate.receipt.queued, true);
    fixture.releaseHold();
    const templateSubmitted = await waitForEvent(events, templateEvent, (event) => (
      event.type === "message.submitted" && event.data.operationId === "sdk-template-queued"
    ));
    assert.equal(templateSubmitted.type, "message.submitted");
    assert.equal(templateSubmitted.data.text, TEMPLATE_COMMAND);
    await waitForEvent(events, templateEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-template-hold");
    assert.equal((await client.status(created.id)).pending.total, 0);
    assert.ok(fixture.requests.some((body) => lastUserText(body).includes(TEMPLATE_PROMPT)));

    const holdEvent = events.length;
    await client.prompt(created.id, HOLD_PROMPT, "prompt", "sdk-hold-run");
    await waitForEvent(events, holdEvent, (event) => event.type === "message.delta" && event.data.delta.includes("holding"));
    const steered = await client.prompt(created.id, "queued steer must not run", "steer", "sdk-steer");
    const followed = await client.prompt(created.id, "queued follow-up must not run", "followUp", "sdk-follow-up");
    assert.equal(steered.receipt.queued, true);
    assert.equal(steered.receipt.delivery, "steer");
    assert.equal(followed.receipt.queued, true);
    assert.equal(followed.receipt.delivery, "followUp");
    const restored = await client.abortRestoreQueue(created.id, "sdk-abort-restore");
    assert.deepEqual(restored.receipt.restored.map((item) => item.operationId).sort(), ["sdk-follow-up", "sdk-steer"]);
    assert.equal(restored.instance.pending.total, 0);
    const aborted = await waitForEvent(events, holdEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-hold-run");
    assert.equal(aborted.type, "run.settled");
    assert.equal(aborted.data.result, "aborted");
    assert.equal(fixture.requests.some((body) => JSON.stringify(body).includes("queued steer must not run") || JSON.stringify(body).includes("queued follow-up must not run")), false);

    const errorEvent = events.length;
    await client.prompt(created.id, ERROR_PROMPT, "prompt", "sdk-error-run");
    const failed = await waitForEvent(events, errorEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-error-run");
    assert.equal(failed.type, "run.settled");
    assert.equal(failed.data.result, "failed");
    assert.match(failed.data.error ?? "", /deterministic provider failure/);
    assert.equal((await client.status(created.id)).lifecycle, "active", "a provider failure must not lose the Worker");

    const recoveryEvent = events.length;
    await client.prompt(created.id, RECOVERY_PROMPT, "prompt", "sdk-recovery-run");
    const recovered = await waitForEvent(events, recoveryEvent, (event) => event.type === "run.settled" && event.data.operationId === "sdk-recovery-run");
    assert.equal(recovered.type, "run.settled");
    assert.equal(recovered.data.result, "succeeded");

    await client.nameSession(created.id, "SDK compatibility persisted", "sdk-name");
    const beforeReloadHistory = (await client.history(created.id)).entries;
    const initialWorkerPid = workerPids[0]!;
    const reload = await client.reloadSession(created.id, "sdk-reload");
    assert.equal(reload.instance.name, "SDK compatibility persisted");
    assert.deepEqual(reload.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.equal(reload.instance.runtimeGeneration, 3);
    assert.deepEqual(workerPids, [initialWorkerPid], "session reload must stay inside the current Worker process");
    assert.equal(processExists(initialWorkerPid), true);
    const afterReloadHistory = (await client.history(created.id)).entries;
    assert.ok(afterReloadHistory.length >= beforeReloadHistory.length);
    assert.ok(afterReloadHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("worker recovered")));

    const killedPid = initialWorkerPid;
    process.kill(killedPid, "SIGKILL");
    const runtimeError = await waitForStatus(client, created.id, (snapshot) => snapshot.lifecycle === "runtime_error");
    assert.equal(runtimeError.reopenable, true);
    assert.equal(processExists(killedPid), false);

    const reopened = await client.reopen(created.id, "sdk-reopen");
    assert.equal(reopened.previousLifecycle, "runtime_error");
    assert.equal(reopened.instance.lifecycle, "active");
    assert.deepEqual(reopened.instance.executor.model, { provider: PROVIDER, id: MODEL });
    assert.equal(workerPids.length, 2);
    assert.notEqual(workerPids[1], killedPid);
    const reopenedHistory = (await client.history(created.id)).entries;
    assert.ok(reopenedHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes("prior Pi 0.81.1 session")));
    assert.ok(reopenedHistory.some((entry) => entry.source === "user" && textOf(entry.content).includes(TOOL_PROMPT)));
    assert.ok(reopenedHistory.some((entry) => entry.source === "tool" && textOf(entry.content).includes(FIXTURE_TEXT)));
    assert.ok(reopenedHistory.some((entry) => entry.source === "assistant" && textOf(entry.content).includes("worker recovered")));

    const livePid = workerPids.at(-1)!;
    const stopped = await client.stop(created.id, "sdk-stop");
    assert.equal(stopped.instance.lifecycle, "stopped");
    assert.equal(processExists(livePid), false, "Host stop must reap the reopened Worker");
    assert.ok(fixture.requestCount >= 5);
  } finally {
    follower?.close();
    await follower?.done.catch(() => {});
    client?.closeActiveConnections();
    if (host) await host.stop().catch(() => {});
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/** Frozen Pi 0.81.1 v3 records: the candidate SDK must parse them rather than generate its own fixture. */
function priorPiSession(cwd: string): string {
  const timestamp = "2026-07-23T00:00:00.000Z";
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return [
    JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000811", timestamp, cwd }),
    JSON.stringify({ type: "model_change", id: "08110001", parentId: null, timestamp, provider: PROVIDER, modelId: MODEL }),
    JSON.stringify({ type: "thinking_level_change", id: "08110002", parentId: "08110001", timestamp, thinkingLevel: "off" }),
    JSON.stringify({ type: "session_info", id: "08110003", parentId: "08110002", timestamp, name: "Pi 0.81.1 compatibility fixture" }),
    JSON.stringify({ type: "message", id: "08110004", parentId: "08110003", timestamp, message: { role: "user", content: "prior Pi 0.81.1 session", timestamp: 1 } }),
    JSON.stringify({
      type: "message",
      id: "08110005",
      parentId: "08110004",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prior session answer" }],
        api: "openai-completions",
        provider: PROVIDER,
        model: MODEL,
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    }),
    "",
  ].join("\n");
}

class LoopbackChatFixture {
  readonly requests: unknown[] = [];
  requestCount = 0;
  origin = "";
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((request, response) => { void this.respond(request, response); });
  private pendingHoldResponse: ServerResponse | undefined;

  async start(): Promise<void> {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  releaseHold(): void {
    const response = this.pendingHoldResponse;
    assert.ok(response, "the fixture must have an active held response");
    this.pendingHoldResponse = undefined;
    finish(response, "stop");
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sdk-compat-dummy-literal-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(body);
    this.requestCount += 1;
    const latestUserText = lastUserText(body);

    if (latestUserText.includes(ERROR_PROMPT)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "deterministic provider failure", type: "invalid_request_error" } }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (latestUserText.includes(HOLD_PROMPT)) {
      sendDelta(response, { role: "assistant", content: "holding turn open" });
      this.pendingHoldResponse = response;
      response.once("close", () => {
        if (this.pendingHoldResponse === response) this.pendingHoldResponse = undefined;
      });
      return;
    }
    if (latestUserText.includes(TOOL_PROMPT) && !hasToolResult(body, FIXTURE_TEXT)) {
      sendDelta(response, { role: "assistant", content: "reading fixture; " });
      sendDelta(response, { tool_calls: [{ index: 0, id: "sdk_read_call", type: "function", function: { name: "read", arguments: "{\"path\":\"fixture.txt\"}" } }] });
      finish(response, "tool_calls");
      return;
    }
    if (latestUserText.includes(TOOL_PROMPT) && hasToolResult(body, FIXTURE_TEXT)) {
      sendDelta(response, { role: "assistant", content: "read completed " });
      sendDelta(response, { content: "successfully" });
      finish(response, "stop");
      return;
    }
    if (latestUserText.includes(RECOVERY_PROMPT)) {
      sendDelta(response, { role: "assistant", content: "worker " });
      sendDelta(response, { content: "recovered" });
      finish(response, "stop");
      return;
    }
    sendDelta(response, { role: "assistant", content: "fixture response" });
    finish(response, "stop");
  }
}

function sendDelta(response: ServerResponse, delta: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-sdk-compat",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function finish(response: ServerResponse, finishReason: "stop" | "tool_calls"): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-sdk-compat",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function requestMessages(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return [];
  return body.messages;
}

function lastUserText(body: unknown): string {
  const user = requestMessages(body).findLast((message) => message !== null && typeof message === "object"
    && "role" in message && message.role === "user") as { content?: unknown } | undefined;
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return "";
  return user.content.flatMap((block) => block !== null && typeof block === "object"
    && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("");
}

function hasToolResult(body: unknown, expected: string): boolean {
  return requestMessages(body).some((message) => message !== null && typeof message === "object"
    && "role" in message && message.role === "tool"
    && "content" in message && typeof message.content === "string" && message.content.includes(expected));
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => block.text ?? "").join("");
}

async function waitForEvent(
  events: readonly DockEvent[],
  from: number,
  predicate: (event: DockEvent) => boolean,
): Promise<DockEvent> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for event; recent events: ${events.slice(from).map((event) => event.type).join(", ")}`);
}

async function waitForStatus(
  client: DockClient,
  instanceId: string,
  predicate: (snapshot: Awaited<ReturnType<DockClient["status"]>>) => boolean,
): Promise<Awaited<ReturnType<DockClient["status"]>>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await client.status(instanceId);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for instance state");
}

function sanitizedWorkerEnvironment(homeDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    PI_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
