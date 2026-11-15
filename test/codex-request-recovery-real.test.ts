import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// 2026-11-15: the same saved context was rejected as zstd and accepted as JSON.
// Run the published SDK in both real Agents; replace only the external HTTP service.
test("Pi and the assistant recover Codex encoding failures through the SDK and reset after compaction", { timeout: 60_000 }, async context => {
  const received: Array<{ encoding: string; json: Buffer; authorization: string | undefined }> = [];
  let ordinaryError = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const encoding = String(request.headers["content-encoding"] ?? "identity");
    received.push({ encoding, json: encoding === "zstd" ? zstdDecompressSync(bytes) : bytes, authorization: request.headers.authorization });
    if (ordinaryError || encoding === "zstd") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: ordinaryError ? "Invalid model parameter" : "Bad Request" }));
      return;
    }
    const item = { type: "message", id: `msg_${received.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered without changing the request.", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${received.length}`, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Recovered without changing the request." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${received.length}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  const team = await startNativeTeam(context, ["coordinator"], {
    prefix: "alu-codex-request-", modelService: true, assistant: true, apiKey: token,
    settings: { transport: "sse", compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 256 } },
  });
  const path = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(path, "utf8"));
  Object.assign(models.providers.coordinator, { api: "openai-codex-responses", baseUrl: `http://127.0.0.1:${address.port}` });
  await writeFile(path, JSON.stringify(models));
  const client = await team.startHost();
  const pi = await trustOnce(trust => client.create(team.cwd, "Pi request recovery", "codex-recovery-pi", trust));
  const assistant = await team.assistantWork();
  for (const work of [pi, assistant]) {
    const start = received.length;
    await client.prompt(work.id, "Reply directly; no tools are needed.");
    await waitFor(async () => received.length > start && ["idle", "failed"].includes((await client.status(work.id)).execution), "The reply did not settle");
    assert.equal((await client.status(work.id)).execution, "idle", "The original reply continues after the compressed request is refused");
    assert.deepEqual(received.slice(start).map(request => request.encoding), ["zstd", "identity"]);
    const [compressed, plain] = received.slice(start);
    assert.equal(Buffer.compare(compressed!.json, plain!.json), 0, "Only the transport encoding changes, not conversation, model or tools");
    assert.equal(compressed!.authorization, plain!.authorization);
    assert.ok(JSON.stringify(await client.history(work.id)).includes("Recovered without changing the request."));
    const next = received.length;
    await client.prompt(work.id, "Continue with another short reply.");
    await waitFor(async () => received.length > next && ["idle", "failed"].includes((await client.status(work.id)).execution), "The next reply did not settle");
    assert.equal((await client.status(work.id)).execution, "idle");
    assert.deepEqual(received.slice(next).map(request => request.encoding), ["identity"], "The affected session remembers successful uncompressed recovery");
  }
  await client.compactSession(pi.id);
  const afterCompaction = received.length;
  await client.prompt(pi.id, "Continue after the summary.");
  await waitFor(async () => received.length > afterCompaction && ["idle", "failed"].includes((await client.status(pi.id)).execution), "The reply after compaction did not settle");
  assert.equal((await client.status(pi.id)).execution, "idle");
  assert.deepEqual(received.slice(afterCompaction).map(request => request.encoding), ["zstd", "identity"], "Adopting a context summary restores normal transport compression");
  ordinaryError = true;
  const start = received.length;
  await client.prompt(pi.id, "Reply once more.");
  await waitFor(async () => (await client.status(pi.id)).execution === "failed", "The unrelated parameter error was not returned");
  assert.equal(received.length - start, 1, "An unrelated 400 is not treated as the compression failure");
});
