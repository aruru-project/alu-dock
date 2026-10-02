import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createIsolatedPiInstance } from "./fixtures/isolated-pi-instance.js";
import { resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";

// #291: menus and settings were held behind the complete manual compaction.
// Only the loopback provider response is held; Host, independent Worker and Pi are real.
test("change the next model and Thinking while the current compaction continues", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-compact-settings-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)));
  let releaseSummary!: () => void, summaryEntered!: () => void;
  const heldSummary = new Promise<void>((resolve) => { releaseSummary = resolve; });
  const entered = new Promise<void>((resolve) => { summaryEntered = resolve; });
  const requests: Array<{ model: string; reasoning_effort?: string }> = [];
  let readTemplatesNext = false;
  const readTemplatesCommand = 'cd "$(dirname "$ALU_DOCK_PI_CLI_ENTRY")" && "$ALU_DOCK_PI_NODE" --input-type=module -e \'import { getCompactionPromptTemplates } from "@earendil-works/pi-coding-agent"; console.log(JSON.stringify(getCompactionPromptTemplates()));\'';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (requests.length === 1) { summaryEntered(); await heldSummary; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (readTemplatesNext) {
      readTemplatesNext = false;
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: "read-compaction-prompts", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: readTemplatesCommand }),
      } }] }, null);
      send(response, {}, "tool_calls");
    } else {
      send(response, { role: "assistant", content: "Local fixture completed." }, null);
      send(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  let host: DockHost | undefined, client: DockClient | undefined;
  let compacting: ReturnType<DockClient["compactSession"]> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "compaction-loopback": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
      models: ["reasoning-a", "reasoning-b"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: true } })),
    } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "compaction-loopback", defaultModel: "reasoning-a", defaultThinkingLevel: "high",
      compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 100 }, retry: { enabled: false },
    }));
    const prior = SessionManager.create(cwd, sessionDir);
    prior.appendModelChange("compaction-loopback", "reasoning-a");
    prior.appendThinkingLevelChange("high");
    for (const text of ["Earlier request", "Recent request ".repeat(200)]) {
      prior.appendMessage({ role: "user", content: text, timestamp: 1 });
      prior.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved answer" }],
        api: "openai-completions", provider: "compaction-loopback", model: "reasoning-a", stopReason: "stop", timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    const registry = new DockRegistry((input) => createIsolatedPiInstance({ ...input, agentDir, sessionDir }), undefined, {
      reopenTargetResolver: { resolve: resolvePiReopenTarget },
    });
    host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
    await host.start(); client = new DockClient({ socketPath: host.socketPath, timeoutMs: 5_000 });
    const { instance } = await client.adopt(prior.getSessionFile()!);
    compacting = client.compactSession(instance.id, "Keep decisions", "held-compaction");
    void compacting.catch(() => {});
    await entered;
    assert.equal((await client.status(instance.id)).compacting, true);
    // A preceding ordinary read must not put the menu back behind the old long-held queue.
    const tree = client.tree(instance.id);
    void tree.catch(() => {});
    const models = await client.models(instance.id);
    assert.ok(models.models.some((model) => model.id === "reasoning-b"));
    assertTemplates(await client.compactionPrompts(instance.id));
    assert.ok((await tree).nodes.length > 0);
    const changed = await client.setModel(instance.id, "compaction-loopback", "reasoning-b", "next-model");
    assert.equal(changed.settingsWrite.persisted, true);
    assert.equal(changed.instance.executor.thinkingLevel, "high");
    const thinking = await client.setThinking(instance.id, "low", "next-thinking");
    assert.equal(thinking.settingsWrite.persisted, true);
    assert.equal(thinking.actualLevel, "low");
    assert.equal((await client.status(instance.id)).compacting, true, "changing settings does not cancel the current compaction");
    assert.equal(requests.length, 1, "changing settings does not replay the held provider call");
    const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(saved.defaultModel, "reasoning-b"); assert.equal(saved.defaultThinkingLevel, "low");
    releaseSummary();
    await compacting;
    assert.ok(requests.every((request) => request.model === "reasoning-a"), "the already-started compaction retains its captured model");
    const after = await client.status(instance.id);
    assert.equal(after.executor.model?.id, "reasoning-b"); assert.equal(after.executor.thinkingLevel, "low");
    const beforeNext = requests.length;
    readTemplatesNext = true;
    await client.prompt(instance.id, "Continue using the selected model.", "prompt", "after-compaction");
    for (let attempt = 0; ; attempt++) {
      if (requests.length > beforeNext && (await client.status(instance.id)).execution === "idle") break;
      assert.ok(attempt < 200, "the next local response completes");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.at(-1)?.model, "reasoning-b");
    assert.equal(requests.at(-1)?.reasoning_effort, "low");
    const toolResult = (await client.read(instance.id)).page.events.find((event) => event.type === "tool.completed" && event.data.toolCallId === "read-compaction-prompts");
    assert.ok(toolResult?.type === "tool.completed");
    assert.equal(toolResult.data.isError, false, toolResult.data.text);
    assertTemplates(JSON.parse(toolResult.data.text));
  } finally {
    releaseSummary(); await compacting?.catch(() => {});
    client?.closeActiveConnections(); await host?.stop();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function assertTemplates(templates: Awaited<ReturnType<DockClient["compactionPrompts"]>>): void {
  // Frozen from the upstream release text, not recomputed with the getter under test;
  // Pi 0.99.2 rewrote only the turn-prefix prompt.
  // Both Protocol and Agent bash must read the complete native text, not a preview or assembled payload.
  assert.deepEqual(Object.fromEntries(Object.entries(templates).map(([key, text]) => [key, createHash("sha256").update(text).digest("hex")])), {
    system: "c464889dcfa60441e642f291445b49523f263e6fb2725d0c25075543a2ec3f8f",
    summarize: "9b00aa68df1a64279bc36e9093367f638701d48ec82e3d08436f65092a515f9b",
    update: "240c52982209146eae47d73c7172f6ba1dab60f44520bcb6a6ec1a883fef2ec7",
    turnPrefix: "7b0a15be5e0fdcce338ce7c1ef1fdd386faed258cc25d03915a05b05e7a6a183",
  });
}

function send(response: ServerResponse, delta: Record<string, unknown>, finish_reason: string | null): void {
  response.write(`data: ${JSON.stringify({ id: "compaction-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
}
