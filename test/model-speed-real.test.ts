import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// The requested workflow: one Work, its current/future children and the independent assistant.
// Only model HTTP replies are fake. No subscription, credentials or external service is used.
test("Work speed can be shared with children, overridden individually and extended through Main's support data", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator", "worker"], { prefix: "alu-model-speed-", modelService: true, assistant: true, settings: { compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 100 } } });
  const supportFile = join(team.agentDir, "model-speed-support.json");
  const support = { providers: { upstream: { fast: ["fixture"], ultrafast: [] as string[] } }, aliases: { coordinator: "upstream", worker: "upstream" } };
  await writeFile(supportFile, JSON.stringify(support));
  const memo = join(team.cwd, "memo.txt");
  await writeFile(memo, "A local tool step.\n");
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const parent = await trustOnce(trust => client.create(team.cwd, "parent", "speed-parent", trust));
  const other = await trustOnce(trust => client.create(team.cwd, "independent", "speed-independent", trust));
  const { coordinator, worker } = team.providers;
  const tier = (request: { body: unknown }) => (request.body as { service_tier?: string }).service_tier;
  const setting = async (id: string) => (await client.settings(id)).settings.find(item => item.key === "modelSpeed")!;
  const idle = (id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "Work did not settle");

  // The Agent tool and client share the same Host settings action.
  await team.registry!.invokeDockTool(parent.id, { type: "speed", operationId: "speed-all", selection: { tier: "fast", scope: "all" } });
  await client.prompt(parent.id, "Hold this step while the children work.");
  const parentRequest = await coordinator.request(0);
  assert.equal(tier(parentRequest), "priority");
  assert.deepEqual((await setting(parent.id)).value, { tier: "fast", scope: "all" });
  assert.equal((await setting(other.id)).value, null, "Unrelated Works retain their own selection");

  const child = await team.registry!.invokeDockTool(parent.id, { type: "spawn", operationId: "first-child", task: "Read the memo and report.", name: "child", model: { provider: "worker", id: "fixture" } });
  assert.equal(child.type, "spawn");
  if (child.type !== "spawn") return;
  const first = await worker.request(0);
  assert.equal(tier(first), "priority", "A new child follows its parent's shared speed before its first request");
  await client.updateSetting(parent.id, { key: "modelSpeed", value: { tier: "standard", scope: "all" } });
  first.tools({ id: "read-1", name: "read", arguments: { path: memo } });
  const second = await worker.request(1);
  assert.equal(tier(second), "default", "Turning off shared speed reaches an already-running child at its next request");

  // Add support as data, not a Dock or SDK update. New/reloaded runtimes receive it from Main.
  support.providers.upstream.ultrafast.push("fixture");
  await writeFile(supportFile, JSON.stringify(support));
  await client.updateSetting(child.instance.id, { key: "modelSpeed", value: { tier: "fast", scope: "work" } });
  await client.updateSetting(parent.id, { key: "modelSpeed", value: { tier: "ultrafast", scope: "all" } });
  second.tools({ id: "read-2", name: "read", arguments: { path: memo } });
  const third = await worker.request(2);
  assert.equal(tier(third), "priority", "A child's explicit choice takes precedence over the parent's new speed");
  third.tools({ id: "done", name: "dock_send", arguments: { message: "Done.", done: true } });
  await idle(child.instance.id);

  const later = await team.registry!.invokeDockTool(parent.id, { type: "spawn", operationId: "later-child", task: "Report done.", name: "later", model: { provider: "worker", id: "fixture" } });
  assert.equal(later.type, "spawn");
  if (later.type !== "spawn") return;
  const fourth = await worker.request(3);
  assert.equal(tier(fourth), "ultrafast");
  fourth.tools({ id: "done-later", name: "dock_send", arguments: { message: "Done too.", done: true } });
  await idle(later.instance.id);
  await client.updateSetting(child.instance.id, { key: "modelSpeed", value: null });
  await client.reloadSession(child.instance.id);
  await client.prompt(child.instance.id, "Answer directly.");
  const following = await worker.request(4);
  assert.equal(tier(following), "ultrafast", "Restoring inheritance uses the shared speed after Reload too");
  following.text("Ready.");
  await idle(child.instance.id);

  // Review caught two gaps: Pi summaries bypassed the payload hook, and a busy child
  // rejected a parent's shared speed change. Keep this request open while changing all.
  const compacting = client.compactSession(child.instance.id);
  const summary = await worker.request(5);
  try {
    await client.updateSetting(parent.id, { key: "modelSpeed", value: { tier: "standard", scope: "all" } });
  } finally { summary.text("The memo was read; the child is ready for the next task."); }
  await compacting;
  assert.equal(tier(summary), "ultrafast", "Pi compaction uses the Work's speed too; an already-sent request keeps its choice");
  await client.prompt(child.instance.id, "Continue after compaction.");
  const afterCompaction = await worker.request(6);
  assert.equal(tier(afterCompaction), "default", "A child busy compacting still follows the parent's change at its next request");
  afterCompaction.text("Ready again.");
  await idle(child.instance.id);
  await Promise.all([
    client.reloadSession(child.instance.id),
    client.updateSetting(parent.id, { key: "modelSpeed", value: { tier: "ultrafast", scope: "all" } }),
  ]);

  parentRequest.text("The first step is complete.");
  const parentNext = await coordinator.request(1);
  parentNext.text("Both reports received.");
  await idle(parent.id);
  await client.reloadSession(assistant.id);
  assert.deepEqual((await setting(assistant.id)).allowedValues, ["standard", "fast", "ultrafast"]);
  await client.updateSetting(assistant.id, { key: "modelSpeed", value: { tier: "ultrafast", scope: "work" } });
  await client.setAssistantSettings({ extractionSpeed: "fast" });
  await client.prompt(assistant.id, "Say hello.");
  const hers = await coordinator.request(2);
  assert.equal(tier(hers), "ultrafast", "The assistant uses the same speed path without a Pi extension");
  hers.text("你好。");
  await idle(assistant.id);
  assert.equal((await client.assistantSettings()).extractionSpeed, "fast", "Background memory has a separate selection");

  const catalog = JSON.parse(await readFile(join(team.root, "catalog.json"), "utf8"));
  assert.deepEqual(catalog.instances.find((item: { id: string }) => item.id === parent.id).modelSpeed, { tier: "ultrafast", scope: "all" });
});
