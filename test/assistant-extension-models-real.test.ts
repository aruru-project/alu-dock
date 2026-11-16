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
  let stderr = "";
  const write = process.stderr.write.bind(process.stderr);
  context.mock.method(process.stderr, "write", (...args: Parameters<typeof process.stderr.write>) => {
    stderr += args[0].toString();
    return write(...args);
  });
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
    async function query(signal, outcome) {
      await context.models.refresh({ allowNetwork: false, signal });
      const model = context.models.getModel("account", "fixture");
      if (!model) throw new Error("The configured account model is missing");
      const auth = await context.models.getAuth(model, { signal });
      if (!auth?.auth.apiKey) throw new Error("Sign in on Main first");
      if (outcome === "wait") {
        context.notify("Synthetic account tool waiting");
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(auth.auth.apiKey)), { once: true }));
      }
      if (outcome === "fail") throw Object.assign(new Error(auth.auth.apiKey, { cause: new Error(auth.auth.apiKey) }), { privateDetail: auth.auth.apiKey });
      const response = await fetch(context.config.url, { headers: { Authorization: "Bearer " + auth.auth.apiKey }, signal });
      if (!response.ok) throw new Error("Account lookup failed");
      return JSON.stringify(await response.json());
    }
    return {
      commands: [{ name: "account-usage", description: "Read account allowance", execute: (_args, call) => query(call.signal) }],
      tools: [{ name: "account_usage", description: "Read account allowance", parameters: { type: "object", properties: { outcome: { type: "string" } }, additionalProperties: false },
        execute: async (args, call) => ({ content: [{ type: "text", text: await query(call.signal, args.outcome) }] }) }]
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
  // PR review 2026-11-16: a credential-bearing extension exception became the next model's
  // tool result and was saved in the conversation. The real tool boundary must replace it.
  await client.prompt(assistant.id, "测试本机工具失败。", "auto", "account-tool-failure");
  const failed = await team.providers.chat.request(2);
  failed.tools({ id: "failed-account", name: "account_usage", arguments: { outcome: "fail" } });
  const recovered = await team.providers.chat.request(3);
  const failedResult = (recovered.body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>).find(message => message.role === "tool" && message.tool_call_id === "failed-account");
  assert.ok(failedResult?.content, "The assistant must get an actionable failure result rather than lose the tool response");
  recovered.text("工具查询失败，可以检查扩展设置后重试。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish after the tool failure");

  // Stopping a pending tool is cancellation, not an ordinary failure or a new model request.
  const beforeCancelLogs = stderr;
  await client.prompt(assistant.id, "等待本机工具。", "auto", "account-tool-cancel");
  const pending = await team.providers.chat.request(4);
  pending.tools({ id: "pending-account", name: "account_usage", arguments: { outcome: "wait" } });
  await waitFor(() => notifications.includes("Synthetic account tool waiting"), "The cancellable tool did not start");
  await client.abortRestoreQueue(assistant.id);
  assert.equal((await client.status(assistant.id)).execution, "idle");
  assert.equal(team.providers.chat.requests.length, 5, "Cancel must not request another model turn");
  assert.equal(stderr, beforeCancelLogs, "Cancellation must not be logged as an extension failure");
  await client.reloadSession(assistant.id);
  assert.equal(team.providers.chat.requests.length, 5, "Reload must not resume the cancelled tool turn");
  assert.equal(queries, 2, "Failed and cancelled tool calls do not issue account requests");
  assert.equal(team.providers.account.requests.length, 0, "Account authentication does not perform inference");
  // This credential access is for trusted extension code, never automatic model/UI/log output.
  const session = (await client.status(assistant.id)).executor.sessionFile!;
  for (const value of [notifications, await client.tools(assistant.id), recovered.body, await readFile(session, "utf8"), stderr]) {
    assert.ok(!JSON.stringify(value).includes(secret), "Credentials must stay out of model requests, notices, saved conversation and logs");
  }
});
