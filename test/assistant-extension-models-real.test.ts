import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #671: a personal assistant must query another configured provider's account through Main,
// both as a direct command and a model tool, without switching her chatting model or logging in again.
test("assistant commands and tools query a different account using Main's existing model authentication", { timeout: 60_000 }, async context => {
  const secret = "MAIN_ONLY_ACCOUNT_CREDENTIAL_671";
  const team = await startNativeTeam(context, ["chat", "account"], {
    prefix: "alu-assistant-extension-models-", assistant: true, modelService: true,
    serviceEnvironment: { ACCOUNT_SERVICE_KEY: secret },
  });
  const modelsPath = join(team.agentDir, "models.json");
  const configuration = JSON.parse(await readFile(modelsPath, "utf8"));
  configuration.providers.account.apiKey = "${ACCOUNT_SERVICE_KEY}";
  await writeFile(modelsPath, JSON.stringify(configuration));
  let queries = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return; }
    queries++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ remainingPercent: 72, resetsAt: "2030-01-02T03:00:00Z" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const module = join(team.root, "account-extension.mjs");
  await writeFile(module, `export default async function(context) {
    async function query(signal) {
      await context.models.refresh({ allowNetwork: false, signal });
      const model = context.models.getModel("account", "fixture");
      if (!model) throw new Error("The configured account model is missing");
      const auth = await context.models.getAuth(model, { signal });
      if (!auth?.auth.apiKey) throw new Error("Sign in on Main first");
      const response = await fetch(context.config.url, { headers: { Authorization: "Bearer " + auth.auth.apiKey }, signal });
      if (!response.ok) throw new Error("Account lookup failed");
      return JSON.stringify(await response.json());
    }
    return {
      commands: [{ name: "account-usage", description: "Read account allowance", execute: (_args, call) => query(call.signal) }],
      tools: [{ name: "account_usage", description: "Read account allowance", parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_args, call) => ({ content: [{ type: "text", text: await query(call.signal) }] }) }]
    };
  }`);
  await writeFile(join(team.cwd, "extensions.json"), JSON.stringify([
    { id: "account-usage", module, enabled: true, config: { url: `http://127.0.0.1:${address.port}/usage` } },
  ]));
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const notifications: string[] = [];
  const follower = await client.streamEvents(assistant.id, { onEvent: event => {
    if (event.type === "extension.notification") notifications.push(event.data.message);
  } });
  context.after(async () => { follower.close(); await follower.done.catch(() => {}); });

  await client.prompt(assistant.id, "/account-usage", "auto", "account-command");
  await waitFor(() => notifications.some(message => message.includes('"remainingPercent":72')), "The command did not show the account allowance");
  assert.equal(team.providers.chat.requests.length, 0, "A direct account command does not make an inference request");
  assert.equal(queries, 1);
  assert.equal((await client.status(assistant.id)).executor.model?.provider, "chat");

  await client.prompt(assistant.id, "看看我的订阅还剩多少。", "auto", "account-tool");
  const first = await team.providers.chat.request(0);
  assert.ok(first.toolNames.includes("account_usage"));
  first.tools({ id: "read-account", name: "account_usage", arguments: {} });
  const after = await team.providers.chat.request(1);
  assert.ok(JSON.stringify(after.body.messages).includes('remainingPercent'));
  assert.ok(JSON.stringify(after.body.messages).includes('72'));
  after.text("剩余 72%，这不是美元余额。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish explaining the allowance");
  assert.equal(queries, 2);
  assert.equal((await client.list()).length, 1, "This account query does not create another Work");
  assert.equal((await client.status(assistant.id)).executor.model?.provider, "chat");
  // This new credential access is for trusted extension code, never automatic model/UI output.
  const session = (await client.status(assistant.id)).executor.sessionFile!;
  for (const value of [notifications, await client.tools(assistant.id), first.body, after.body, await readFile(session, "utf8")]) {
    assert.ok(!JSON.stringify(value).includes(secret), "Credentials must stay out of notices, tool schemas and conversation");
  }
});
