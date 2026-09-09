import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { PROVIDER_ERROR_HTML } from "./support/provider-error-fixture.js";

// #265: a recoverable upstream HTML error was escalated to Worker SIGTERM.
// Only the HTTP peer is a fixture; Host, catalog, Worker, Pi retry and client parsing are real.
test("upstream errors remain local and /retry repeats the failed request without replaying tools",  { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-provider-error-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const rateLimitError = `429 Too Many Requests\n${PROVIDER_ERROR_HTML}`;
  const replies = ["tool", 520, 200, 429, 429, 200, 200];
  const requests: Array<{ messages: unknown[] }> = [];
  let requestIndex = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const status = replies[requestIndex++];
    if (status === "tool") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sendChunk(response, { role: "assistant", tool_calls: [{ index: 0, id: "write-once", type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "printf once >> retry-once.txt" }) } }] }, null);
      sendChunk(response, {}, "tool_calls");
      response.end("data: [DONE]\n\n");
    } else if (status === 520 || status === 429) {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(status === 520 ? PROVIDER_ERROR_HTML : rateLimitError);
    } else if (status === 200) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sendChunk(response, { role: "assistant", content: "Request completed." }, null);
      sendChunk(response, {}, "stop");
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(400); response.end("Unexpected fixture request");
    }
  });
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  let follower: Awaited<ReturnType<DockClient["streamEvents"]>> | undefined;
  const events: DockEvent[] = [];
  const workerPids: number[] = [];
  try {
    await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "error-loopback": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "offline-fixture-key",
      models: [{ id: "fixture", name: "Error fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "error-loopback", defaultModel: "fixture", compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 30, provider: { maxRetries: 0 } },
    }));
    const workerEnvironment: NodeJS.ProcessEnv = {
      HOME: home, USERPROFILE: home, PATH: process.env.PATH, LANG: process.env.LANG,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      PI_OFFLINE: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    };
    const store = new FileCatalogStore(join(root, "state/catalog.json"));
    const registry = new DockRegistry((input) => createPiInstance({
      ...input, agentDir, sessionDir, workerEnvironment, onWorkerSpawn: (pid) => workerPids.push(pid),
    }), randomUUID, { catalogStore: store });
    await registry.initializeCatalog();
    const socketPath = join(root, "dock.sock");
    host = new DockHost({ socketPath, registry }); await host.start();
    client = new DockClient({ socketPath, timeoutMs: 5_000 });
    const work = await client.create(cwd, "Provider recovery", "error-create");
    const sibling = await client.create(cwd, "Unaffected sibling", "sibling-create");
    const originalPids = [...workerPids];
    follower = await client.streamEvents(work.id, { onEvent: (event) => events.push(event) });

    await client.prompt(work.id, "Retry this request.", "prompt", "retry-run");
    const recovered = await waitForSettlement(events, "retry-run");
    assert.equal(recovered.data.result, "succeeded", JSON.stringify(events));
    const retry = events.find((event) => event.type === "run.retry_started");
    assert.ok(retry?.type === "run.retry_started" && retry.data.error.includes(PROVIDER_ERROR_HTML), "retry feedback must retain the entire upstream error");

    const failureStart = events.length;
    await client.prompt(work.id, "Report the exhausted request.", "prompt", "failure-run");
    const failed = await waitForSettlement(events, "failure-run");
    assert.equal(failed.data.result, "failed");
    assert.ok(failed.data.error?.includes(rateLimitError), "final failure must retain the original multiline diagnostic");
    const retryEnd = events.slice(failureStart).find((event) => event.type === "run.retry_completed" && !event.data.success);
    assert.ok(retryEnd?.type === "run.retry_completed" && retryEnd.data.error?.includes(rateLimitError));
    assert.ok(events.some((event) => event.type === "message.completed" && event.data.error?.includes(rateLimitError)));
    const history = await client.history(work.id);
    assert.ok(history.entries.some((entry) => entry.error?.includes(rateLimitError)), "reloading history must not lose the diagnostic tail");
    const catalogWork = (await store.load())?.instances.find((entry) => entry.id === work.id);
    assert.equal(catalogWork?.lastRun, "failed");
    assert.ok(catalogWork?.lastError, "the bounded status preview must still persist successfully");

    await client.prompt(work.id, "/retry", "prompt", "manual-retry");
    assert.equal((await waitForSettlement(events, "manual-retry")).data.result, "succeeded");
    assert.deepEqual(requests[5]!.messages, requests[3]!.messages, "manual retry must reuse the failed model context without an extra instruction");
    assert.equal(await readFile(join(cwd, "retry-once.txt"), "utf8"), "once", "completed tool side effects must not be replayed");
    const retriedHistory = await client.history(work.id);
    assert.deepEqual(retriedHistory.entries.filter((entry) => entry.source === "user").map((entry) => entry.content),
      history.entries.filter((entry) => entry.source === "user").map((entry) => entry.content), "the command must not add a user chat message");
    const siblingEvents: DockEvent[] = [];
    const siblingFollower = await client.streamEvents(sibling.id, { onEvent: (event) => siblingEvents.push(event) });
    try {
      await client.prompt(sibling.id, "Continue the other Work.", "prompt", "sibling-run");
      assert.equal((await waitForSettlement(siblingEvents, "sibling-run")).data.result, "succeeded");
    } finally { siblingFollower.close(); await siblingFollower.done.catch(() => {}); }
    assert.deepEqual(workerPids, originalPids, "recovering errors must not replace either Worker");
    assert.equal((await client.status(work.id)).runtimeGeneration, work.runtimeGeneration);
    assert.equal((await client.status(sibling.id)).lifecycle, "active");
  } finally {
    follower?.close(); await follower?.done.catch(() => {}); client?.closeActiveConnections();
    await host?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function sendChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-error-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

async function waitForSettlement(events: readonly DockEvent[], operationId: string): Promise<Extract<DockEvent, { type: "run.settled" }>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const settled = events.find((event) => event.type === "run.settled" && event.data.operationId === operationId);
    if (settled?.type === "run.settled") return settled;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No settlement for ${operationId}: ${JSON.stringify(events)}`);
}
