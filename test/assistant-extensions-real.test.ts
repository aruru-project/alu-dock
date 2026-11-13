import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #670: trusted private tools run directly in the resident assistant, not in a child Work. Only
// the loopback model transport and this static local tool are fake; Main/SQLite/Host/Worker are real.
test("Main saves a local assistant extension, Reload makes its tool available directly, and disabling removes it without leaking its private configuration", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-extensions-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const module = join(team.root, "private-tools.mjs");
  const marker = "PRIVATE_EXTENSION_CONFIG_670";
  await writeFile(module, `export default async function(context) {
    if (context.config.secret !== "${marker}") throw new Error("Missing private configuration");
    return { tools: [{ name: "local_schedule", description: "Read the local test schedule.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { content: [{ type: "text", text: "The local appointment is at 14:30." }], details: { local: true } }; }
    }] };
  }`);
  const settings = [{ id: "private-schedule", module, enabled: true, config: { secret: marker } }];
  await client.setAssistantSettings({ extensions: settings });
  // Existing clients and the memory tool save only the setting they own, not the private list.
  await client.setAssistantSettings({ extractionModel: null });
  assert.deepEqual((await client.assistantSettings()).extensions, settings);
  await client.reloadSession(assistant.id);
  const catalog = await client.tools(assistant.id);
  assert.equal(catalog.tools.find(tool => tool.name === "local_schedule")?.source?.kind, "extension");
  assert.equal(catalog.tools.find(tool => tool.name === "local_schedule")?.source?.package, "private-schedule");
  assert.ok(!JSON.stringify(catalog).includes(marker), "Tool declarations never contain private configuration");
  await waitFor(async () => (await client.status(assistant.id)).extensionStatus["扩展/private-schedule"]?.includes("已加载") === true, "The assistant did not report its loaded extension");

  await client.prompt(assistant.id, "读一下本机日程，再看记忆整理设置。", "auto", "local-extension");
  const first = await team.providers.coordinator.request(0);
  assert.ok(first.toolNames.includes("local_schedule"));
  first.tools({ id: "schedule", name: "local_schedule", arguments: {} });
  const second = await team.providers.coordinator.request(1);
  assert.ok(JSON.stringify(second.body.messages).includes("The local appointment is at 14:30."));
  second.tools({ id: "memory-settings", name: "assistant_memory", arguments: { action: "settings" } });
  const third = await team.providers.coordinator.request(2);
  // Explicit credential boundary: even assistant_memory settings content/details must exclude it.
  for (const request of [first, second, third]) assert.ok(!JSON.stringify(request.body).includes(marker), "Private config reached the model");
  third.text("本机日程是 14:30，记忆整理未开启。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish");
  assert.equal((await client.list()).length, 1, "The assistant used its own tool, without a child Work");
  const sessionFile = (await client.status(assistant.id)).executor.sessionFile;
  assert.ok(sessionFile);
  assert.ok(!(await readFile(sessionFile!, "utf8")).includes(marker), "Private settings were recorded in the conversation's tool details");

  await client.setAssistantSettings({ extensions: [{ ...settings[0]!, enabled: false }] });
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"), "Saving does not hot-swap the running tools");
  await client.reloadSession(assistant.id);
  assert.ok(!(await client.tools(assistant.id)).tools.some(tool => tool.name === "local_schedule"));
  assert.ok((await client.tools(assistant.id)).tools.some(tool => tool.name === "assistant_memory"));
  await client.prompt(assistant.id, "继续聊。", "auto", "after-disable");
  const after = await team.providers.coordinator.request(3);
  assert.ok(!after.toolNames.includes("local_schedule"));
  assert.ok(!JSON.stringify(after.body).includes(marker));
  after.text("好的，继续聊。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish after Reload");
});
