import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { startNativeTeam } from "./support/native-team.js";
import { waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

const toolText = (request: HeldChatRequest, id: string): string => {
  const message = (request.body.messages as Array<{ role: string; tool_call_id?: string; content: string }>).find((item) => item.role === "tool" && item.tool_call_id === id);
  assert.ok(message, `The tool result ${id} should reach the next model request`);
  return message.content;
};

// #670: public Dock must supply its own web extension, not rely on a user's installed Pi
// extension. Only the search/page HTTP endpoints and model replies are loopback fixtures.
test("the shipped assistant web extension searches, reads a page and retrieves its stored content without creating a Work", { timeout: 60_000 }, async (context) => {
  let base = "";
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, base);
    requested.push(url.pathname);
    if (url.pathname === "/search") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [{ title: "Local event", url: `${base}/article`, content: "The meeting starts at 14:30.", engine: "fixture" }] }));
    } else if (url.pathname === "/article") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><head><title>Local event schedule</title></head><body><article><h1>Local event schedule</h1>${"<p>The meeting starts at 14:30 in the quiet reading room. Bring your notes and a blue umbrella for the walk home.</p>".repeat(8)}</article></body></html>`);
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  context.after(() => { server.closeAllConnections(); server.close(); });
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-web-extension-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  await client.setAssistantSettings({ extensions: [{ id: "web", module: "builtin:web", enabled: true, config: {
    provider: "searxng", searxngBaseUrl: base, webSearch: { allowedProviders: ["searxng"] },
    ssrf: { allowRanges: ["127.0.0.1/32"] }, proxy: "", allowBrowserCookies: false,
  } }] });
  await client.reloadSession(assistant.id);
  const tools = await client.tools(assistant.id);
  for (const name of ["web_search", "fetch_content", "get_search_content"]) {
    assert.equal(tools.tools.find((tool) => tool.name === name)?.source?.package, "web");
  }
  await client.prompt(assistant.id, "查一下活动时间，打开原网页并取回正文。");
  (await team.providers.coordinator.request(0)).tools({ id: "search", name: "web_search", arguments: { query: "local event", provider: "searxng" } });
  const found = await team.providers.coordinator.request(1);
  assert.ok(toolText(found, "search").includes("14:30"));
  found.tools({ id: "fetch", name: "fetch_content", arguments: { url: `${base}/article` } });
  const fetched = await team.providers.coordinator.request(2);
  const text = toolText(fetched, "fetch");
  assert.ok(text.includes("blue umbrella"), text.slice(0, 500));
  const responseId = /responseId["']?\s*[:=]\s*["']([^"']+)["']/u.exec(text)?.[1];
  assert.ok(responseId, "The fetched content has a retrieval reference");
  fetched.tools({ id: "retrieve", name: "get_search_content", arguments: { responseId, urlIndex: 0, offset: 0, limit: 300 } });
  const retrieved = await team.providers.coordinator.request(3);
  assert.ok(toolText(retrieved, "retrieve").includes("14:30"));
  retrieved.text("活动在 14:30，原网页也核对过了。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish");
  assert.ok(requested.includes("/search") && requested.includes("/article"));
  assert.equal((await client.list()).length, 1);
});
