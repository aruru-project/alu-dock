import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockEvent } from "../src/core/instance-dto.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// PR review 2026-11-16: factory, command and dispose exceptions copied credentials obtained
// from Main's getAuth into Worker stderr, which the real Host also forwards to its own logs.
test("assistant extension failures keep Main authentication out of logs and owner results", { timeout: 60_000 }, async context => {
  const secret = "SYNTHETIC_MAIN_AUTH_EXTENSION_ERROR";
  let stderr = "";
  const write = process.stderr.write.bind(process.stderr);
  context.mock.method(process.stderr, "write", (...args: Parameters<typeof process.stderr.write>) => {
    stderr += args[0].toString();
    return write(...args);
  });
  const team = await startNativeTeam(context, ["chat", "account"], {
    prefix: "alu-extension-errors-", assistant: true, modelService: true,
    serviceEnvironment: { EXTENSION_ERROR_KEY: secret },
  });
  const modelsPath = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  models.providers.account.apiKey = "${EXTENSION_ERROR_KEY}";
  await writeFile(modelsPath, JSON.stringify(models));
  const receipts = join(team.root, "auth-receipts.jsonl");
  const module = join(team.root, "credential-errors.mjs");
  await writeFile(module, `import { appendFile } from "node:fs/promises";
    export default async function(context) {
      async function fail(phase, signal) {
        await context.models.refresh({ allowNetwork: false, signal });
        const model = context.models.getModel("account", "fixture");
        if (!model) throw new Error("Synthetic account model missing");
        const auth = await context.models.getAuth(model, { signal });
        if (!auth?.auth.apiKey) throw new Error("Synthetic Main auth missing");
        await appendFile(context.config.receipts, JSON.stringify({ phase, pid: process.pid,
          acquiredViaGetAuth: true, envTokenPresent: process.env.EXTENSION_ERROR_KEY !== undefined,
          configContainsToken: JSON.stringify(context.config).includes(auth.auth.apiKey),
        }) + "\\n");
        // Secrets can be in any part of an exception, not just a recognized header/key name.
        throw Object.assign(new Error("Synthetic " + phase + " failure " + auth.auth.apiKey,
          { cause: new Error(auth.auth.apiKey) }), { arbitraryDetail: auth.auth.apiKey });
      }
      if (context.config.failFactory) await fail("factory");
      return {
        commands: [{ name: "credential-fail", description: "Synthetic account failure",
          execute: (_args, call) => fail("execute", call.signal) }],
        dispose: () => fail("dispose"),
      };
    }`);
  const configFile = join(team.cwd, "extensions.json");
  const settings = (failFactory: boolean) => [{ id: "credential-errors", module, enabled: true, config: { receipts, failFactory } }];
  await writeFile(configFile, JSON.stringify(settings(false)));
  const client = await team.startHost();
  const work = await team.assistantWork();
  const events: DockEvent[] = [];
  const follower = await client.streamEvents(work.id, { onEvent: event => { events.push(event); } });
  context.after(async () => { follower.close(); await follower.done.catch(() => {}); });
  assert.ok((await client.commands(work.id)).commands.some(command => command.name === "credential-fail"));
  const receipt = await client.prompt(work.id, "/credential-fail", "auto", "failed-command");
  assert.equal(receipt.receipt.kind, "extension_command");
  await waitFor(() => events.some(event => event.type === "instance.error" && event.data.operationId === "failed-command"), "The command failure did not reach the owner");
  // An idle Reload reaches the previous extension's dispose and then the failing factory.
  await writeFile(configFile, JSON.stringify(settings(true)));
  const reloaded = await client.reloadSession(work.id);
  const resources = await client.resources(work.id);
  assert.ok(resources.diagnostics.some(item => item.severity === "error" && item.message.includes("工具扩展 credential-errors：加载失败")));
  const status = await client.status(work.id);
  const history = await client.history(work.id);
  const commands = await client.commands(work.id);
  const tools = await client.tools(work.id);
  const sessionFile = status.executor.sessionFile;
  const session = sessionFile && existsSync(sessionFile) ? await readFile(sessionFile, "utf8") : "";
  const acquired = (await readFile(receipts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(acquired.map(item => item.phase), ["execute", "dispose", "factory"]);
  assert.ok(acquired.every(item => item.acquiredViaGetAuth && !item.envTokenPresent && !item.configContainsToken));
  assert.ok(acquired.every(item => team.workerPids.includes(item.pid) && item.pid !== process.pid));
  assert.equal(team.providers.chat.requests.length + team.providers.account.requests.length, 0, "These failures do not request model inference");
  const notifications = events.filter((event): event is Extract<DockEvent, { type: "extension.notification" }> => event.type === "extension.notification");
  assert.ok(notifications.some(event => event.data.operationId === "failed-command" && event.data.level === "error"));
  assert.ok(notifications.some(event => event.data.level === "warning"));
  assert.equal(status.lifecycle, "active");
  assert.equal(status.execution, "idle");
  assert.ok(!JSON.stringify({ receipt, reloaded, status, history, commands, tools, events, session, resources }).includes(secret), "Credentials must stay out of owner results and saved conversation");
  // Do not allow removal of diagnostics to make the credential assertion pass vacuously.
  await waitFor(() => stderr.includes("credential-errors") && stderr.includes("load") && stderr.includes("dispose") && stderr.includes("command"), "Host did not receive safe extension failure diagnostics");
  assert.ok(!stderr.includes(secret), "Worker stderr forwarded to Host logs must not contain Main authentication");
});
