import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AssistantStore } from "../src/assistant/store.js";
import { DOCK_TOOLS_STATUS_KEY } from "../src/worker/dock-tools-client.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #670 and the RC6/7 correction: private extensions belong to Main's local file, not public
// settings. Only the loopback model transport and local extension factories are fake.
test("Main migrates its private tools once, keeps their configuration and data, and Reload reads only the local file", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-extensions-", assistant: true });
  const module = join(team.root, "private-tools.mjs");
  const qqModule = join(team.root, "private-qq.mjs");
  const marker = "PRIVATE_EXTENSION_CONFIG_670";
  const configFile = join(team.cwd, "extensions.json");
  const dataDir = join(team.cwd, ".assistant-extensions", "private-kanban");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "prior-state.txt"), "original data");
  await writeFile(module, `import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    export default async function(context) {
      if (context.config.secret !== "${marker}" || await readFile(join(context.dataDir, "prior-state.txt"), "utf8") !== "original data") throw new Error("Missing private configuration or original data");
      await writeFile(${JSON.stringify(join(team.root, "factory-received.json"))}, JSON.stringify({ config: context.config, dataDir: context.dataDir }));
      return { tools: [{ name: "local_schedule", description: "Read the local test schedule.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { content: [{ type: "text", text: "The local appointment is at 14:30." }], details: { local: true } }; }
      }] };
    }`);
  await writeFile(qqModule, `import { writeFile } from "node:fs/promises";
    export default async function(context) {
      await writeFile(${JSON.stringify(join(team.root, "qq-received.json"))}, JSON.stringify({ config: context.config, dataDir: context.dataDir }));
      return { tools: [] };
    }`);
  const settings = [
    { id: "web", module: "builtin:web", enabled: true, config: {} },
    { id: "private-kanban", module, enabled: true, config: { secret: marker, endpoint: "local-only" } },
    { id: "private-qq", module: qqModule, enabled: true, config: { token: "PRIVATE_QQ_TOKEN", account: "test-owner" } },
  ];
  await mkdir(join(team.root, "assistant"));
  const databasePath = join(team.root, "assistant", "memory.sqlite");
  const oldStore = new AssistantStore(databasePath);
  oldStore.connection.prepare("INSERT INTO meta(key, value) VALUES ('tool_extensions', ?)").run(JSON.stringify(settings));
  oldStore.close();

  const client = await team.startHost();
  const assistant = await team.assistantWork();
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), settings);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'tool_extensions'").get(), undefined); }
  finally { database.close(); }
  assert.deepEqual(JSON.parse(await readFile(join(team.root, "factory-received.json"), "utf8")), { config: settings[1]!.config, dataDir });
  assert.deepEqual(JSON.parse(await readFile(join(team.root, "qq-received.json"), "utf8")), { config: settings[2]!.config, dataDir: join(team.cwd, ".assistant-extensions", "private-qq") });

  // The owner's file-only configuration decision removes the old public write entry as well.
  await assert.rejects(client.setAssistantSettings({ extensions: settings } as never), { code: "invalid_request" });
  // Ordinary settings no longer include extensions, and saving them cannot change that file.
  for (const result of [await client.assistantSettings(), await client.setAssistantSettings({ extractionModel: null })]) {
    assert.ok(!Object.hasOwn(result, "extensions"));
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_QQ_TOKEN"));
  }
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), settings);
  const catalog = await client.tools(assistant.id);
  assert.equal(catalog.tools.find(tool => tool.name === "local_schedule")?.source?.package, "private-kanban");
  assert.ok(catalog.tools.some(tool => tool.name === "web_search"));
  assert.ok(!JSON.stringify(catalog).includes(marker), "Tool declarations must not contain private configuration");
  assert.ok(!Object.keys((await client.status(assistant.id)).extensionStatus).some(key => key.startsWith("扩展/")), "Successful loads do not occupy the chat status strip");

  await client.prompt(assistant.id, "读一下本机日程，再看记忆整理设置。", "auto", "local-extension");
  const first = await team.providers.coordinator.request(0);
  assert.ok(first.toolNames.includes("local_schedule"));
  first.tools({ id: "schedule", name: "local_schedule", arguments: {} });
  const second = await team.providers.coordinator.request(1);
  assert.ok(JSON.stringify(second.body.messages).includes("The local appointment is at 14:30."));
  second.tools({ id: "memory-settings", name: "assistant_memory", arguments: { action: "settings" } });
  const third = await team.providers.coordinator.request(2);
  // Credential boundary: configuration must not enter any model request or recorded tool result.
  for (const request of [first, second, third]) {
    assert.ok(!JSON.stringify(request.body).includes(marker));
    assert.ok(!JSON.stringify(request.body).includes("PRIVATE_QQ_TOKEN"));
  }
  third.text("本机日程是 14:30，记忆整理未开启。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish");
  assert.equal((await client.list()).length, 1, "The assistant used its own tool, without a child Work");
  const sessionFile = (await client.status(assistant.id)).executor.sessionFile;
  assert.ok(sessionFile);
  assert.ok(!(await readFile(sessionFile!, "utf8")).includes(marker));

  await writeFile(configFile, JSON.stringify(settings.map(setting => ({ ...setting, enabled: false }))));
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"), "Saving does not hot-swap the running tools");
  await client.reloadSession(assistant.id);
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"));
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "assistant_memory"));
  assert.ok(!Object.keys((await client.status(assistant.id)).extensionStatus).some(key => key.startsWith("扩展/")), "Disabled extensions do not occupy the chat status strip");
  assert.equal((await client.status(assistant.id)).extensionStatus[DOCK_TOOLS_STATUS_KEY], "on");
  await client.prompt(assistant.id, "继续聊。", "auto", "after-disable");
  const after = await team.providers.coordinator.request(3);
  assert.ok(!after.toolNames.includes("local_schedule"));
  assert.ok(!JSON.stringify(after.body).includes(marker));
  after.text("好的，继续聊。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish after Reload");

  // A malformed local file must not revive the old database config or default web tools. Parse
  // errors can contain the input text; the UI must only show an actionable, sanitized failure.
  await writeFile(configFile, `{"secret":"${marker}" BROKEN`);
  await client.reloadSession(assistant.id);
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["扩展/配置"] !== undefined, "Missing configuration failure");
  const failure = (await client.status(assistant.id)).extensionStatus;
  assert.ok(failure["扩展/配置"]!.includes(configFile));
  assert.ok(!JSON.stringify(failure).includes(marker));
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => ["local_schedule", "web_search"].includes(tool.name)));
  // A factory can include its secret in an exception. Keep that out of the UI too, and leave
  // independent working extensions available rather than failing the whole list.
  await writeFile(qqModule, 'export default async function(context) { throw new Error(context.config.token); }');
  await writeFile(configFile, JSON.stringify([settings[0], settings[2]]));
  await client.reloadSession(assistant.id);
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["扩展/private-qq"] !== undefined, "Missing extension failure");
  const factoryFailure = (await client.status(assistant.id)).extensionStatus;
  assert.ok(factoryFailure["扩展/private-qq"]!.includes(configFile));
  assert.ok(!JSON.stringify(factoryFailure).includes("PRIVATE_QQ_TOKEN"));
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "web_search"));
  await writeFile(configFile, "[]");
  await client.reloadSession(assistant.id);
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => ["local_schedule", "web_search"].includes(tool.name)));
  assert.ok(!Object.keys((await client.status(assistant.id)).extensionStatus).some(key => key.startsWith("扩展/")));
});
