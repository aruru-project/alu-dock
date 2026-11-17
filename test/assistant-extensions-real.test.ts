import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  let client = await team.startHost();
  const assistant = await team.assistantWork();
  async function extensionDetails(operationId: string): Promise<string> {
    let details: string | undefined;
    const follower = await client.streamEvents(assistant.id, { onEvent: event => {
      if (event.type === "extension.notification" && event.data.operationId === operationId) details = event.data.message;
    } });
    try {
      await client.prompt(assistant.id, "/assistant-status", "auto", operationId);
      await waitFor(() => details !== undefined, "Requested extension details did not reach the owner");
      return details!;
    } finally { follower.close(); await follower.done; }
  }
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
  assert.equal((await client.status(assistant.id)).extensionStatus["工具扩展"], undefined, "Successful loads do not occupy the chat status strip");

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
  assert.equal((await client.status(assistant.id)).extensionStatus["工具扩展"], undefined, "Disabled extensions do not occupy the chat status strip");
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
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["工具扩展"] !== undefined, "Missing configuration failure");
  const failure = await extensionDetails("configuration-failure-details");
  assert.ok(failure.includes(configFile));
  assert.ok(!failure.includes(marker));
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => ["local_schedule", "web_search"].includes(tool.name)));
  // A factory can include its secret in an exception. Keep that out of the UI too, and leave
  // independent working extensions available rather than failing the whole list.
  await writeFile(qqModule, 'export default async function(context) { throw new Error(context.config.token); }');
  await writeFile(configFile, JSON.stringify([settings[0], settings[2]]));
  await client.reloadSession(assistant.id);
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["工具扩展"] !== undefined, "Missing extension failure");
  const factoryFailure = await extensionDetails("factory-failure-details");
  assert.ok(factoryFailure.includes(configFile));
  assert.ok(!factoryFailure.includes("PRIVATE_QQ_TOKEN"));
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "web_search"));
  await writeFile(configFile, "[]");
  await client.reloadSession(assistant.id);
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => ["local_schedule", "web_search"].includes(tool.name)));
  assert.equal((await client.status(assistant.id)).extensionStatus["工具扩展"], undefined);

  // Local configuration must stay usable when Main's memory service is temporarily unavailable,
  // both on Reload and when the resident Worker starts again. No CLI-wide readiness barrier.
  await client.setAssistantSettings({ displayName: "重启后的小满" });
  await team.stopAssistantService();
  await writeFile(configFile, JSON.stringify([settings[1]]));
  await client.reloadSession(assistant.id);
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"));
  await client.stop(assistant.id);
  assert.equal((await client.status(assistant.id)).lifecycle, "active");
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"));

  // With no file, a failed readiness check must keep the running tools, not assume an empty old
  // database and load default web. Starting without either source still keeps ordinary chat alive.
  await rm(configFile);
  await client.reloadSession(assistant.id);
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"));
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => tool.name === "web_search"));
  await client.stop(assistant.id);
  assert.equal((await client.status(assistant.id)).lifecycle, "active");
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => tool.name === "web_search"));
  await client.prompt(assistant.id, "继续聊天。", "auto", "memory-service-offline");
  (await team.providers.coordinator.request(4)).text("可以，继续聊。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant could not chat while the memory service was offline");
  assert.equal((await client.status(assistant.id)).displayName, "重启后的小满", "An unavailable memory service keeps the known name");

  // #671 regression: a global name read once became a prerequisite for creating/reopening the
  // chat Worker. Cold Main startup must also work before the memory process can become ready.
  // This gate blocks only the real service's startup, not its request handling or settings data.
  await team.host!.stop();
  client.closeActiveConnections();
  const ready = join(team.root, "memory-can-start");
  const entry = join(team.root, "delayed-memory-service.mjs");
  await writeFile(entry, `import { existsSync } from "node:fs";
    if (!existsSync(${JSON.stringify(ready)})) process.exit(1);
    await import(${JSON.stringify(new URL("../src/assistant/service-entry.js", import.meta.url).href)});`);
  await writeFile(configFile, JSON.stringify([settings[1]]));
  client = await team.startHost({ entry, readyWaitMs: 20, background: true });
  const cold = await team.assistantWork();
  assert.equal(cold.id, assistant.id);
  assert.equal(cold.displayName, "alu", "A cold Main can show the default until memory is available");
  assert.ok((await client.tools(cold.id)).tools.some(tool => tool.name === "local_schedule"));
  await client.prompt(cold.id, "记忆还没恢复，也继续聊。", "auto", "cold-memory-offline");
  (await team.providers.coordinator.request(5)).text("我在，继续聊。");
  await waitFor(() => team.registry!.getSnapshot(cold.id).execution === "idle", "Cold Main could not chat before memory became ready");
  const beforeMemory = team.registry!.getSnapshot(cold.id);

  // The existing supervisor retries; no settings request, list refresh or client action starts
  // recovery. Its ready notification must restore the saved name on the same live conversation.
  await writeFile(ready, "ready");
  await waitFor(() => team.registry!.getSnapshot(cold.id).displayName === "重启后的小满", "Service readiness did not restore the global name");
  const recovered = team.registry!.getSnapshot(cold.id);
  assert.equal(recovered.executor.piSessionId, beforeMemory.executor.piSessionId);
  assert.equal(recovered.runtimeGeneration, beforeMemory.runtimeGeneration);
});
