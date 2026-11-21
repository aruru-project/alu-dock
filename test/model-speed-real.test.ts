import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readModelSpeedSupport } from "../src/model-service/speed-support.js";
import { createPiModelCatalogReader } from "../src/pi/pi-model-catalog.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// The requested workflow: one Work, its current/future children and the independent assistant.
// Only model HTTP replies are fake. No subscription, credentials or external service is used.
test("Work speed can be shared with children, overridden individually and extended through Main's support data", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator", "worker", "helper"], { prefix: "alu-model-speed-", modelService: true, assistant: true, settings: { compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 100 } } });
  const supportFile = join(team.root, "model-speed-support.json");
  const support = { providers: { upstream: { fast: ["fixture"], ultrafast: [] as string[] } }, aliases: {} as Record<string, string> };
  await writeFile(supportFile, JSON.stringify(support));
  // This is Dock configuration: a conflicting file in Pi's directory must not own either Agent's speed.
  await writeFile(join(team.agentDir, "model-speed-support.json"), JSON.stringify({
    providers: { upstream: { fast: [], ultrafast: [] } }, aliases: support.aliases,
  }));
  const memo = join(team.cwd, "memo.txt");
  await writeFile(memo, "A local tool step.\n");
  const client = await team.startHost();
  const catalogReader = createPiModelCatalogReader({
    agentDir: team.agentDir, homeDir: team.cwd,
    environment: async () => isolatedProcessEnvironment(join(team.root, "catalog-home"), { PI_CODING_AGENT_DIR: team.agentDir }),
    speedSupport: () => readModelSpeedSupport(team.root),
  });
  assert.deepEqual((await catalogReader.read()).models.find(model => model.provider === "worker" && model.id === "fixture")?.speedTiers,
    ["standard"], "An unregistered alias starts with standard speed only");
  const assistant = await team.assistantWork();
  const parent = await trustOnce(trust => client.create(team.cwd, "parent", "speed-parent", trust));
  const other = await trustOnce(trust => client.create(team.cwd, "independent", "speed-independent", trust));
  const { coordinator, worker, helper } = team.providers;
  const tier = (request: { body: unknown }) => (request.body as { service_tier?: string }).service_tier;
  const setting = async (id: string) => (await client.settings(id)).settings.find(item => item.key === "modelSpeed")!;
  const supportNotices: string[] = [];
  const followers = await Promise.all([parent, assistant].map(item => client.streamEvents(item.id, { onEvent: event => {
    if (event.type === "settings.changed" && event.data.key === "modelSpeed") supportNotices.push(item.id);
  } })));
  context.after(async () => { for (const follower of followers) follower.close(); await Promise.all(followers.map(follower => follower.done.catch(() => {}))); });
  const expectSupport = async (id: string, expected: string[]) => {
    const before = supportNotices.length;
    const initial = await setting(id);
    if (JSON.stringify(initial.allowedValues) !== JSON.stringify(expected)) {
      await waitFor(() => supportNotices.slice(before).includes(id), "Updated support did not notify the open client");
    }
    assert.deepEqual((await setting(id)).allowedValues, expected);
  };
  const idle = (id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "Work did not settle");

  // Field regression: adding Main's provider alias must reach already-open Works, not just
  // the machine model picker. Read the same settings/model queries the speed UI uses.
  assert.deepEqual((await setting(parent.id)).allowedValues, ["standard"]);
  assert.deepEqual((await setting(assistant.id)).allowedValues, ["standard"]);
  Object.assign(support.aliases, { coordinator: "upstream", worker: "upstream", helper: "upstream" });
  await writeFile(supportFile, JSON.stringify(support));
  assert.deepEqual((await catalogReader.read()).models.find(model => model.provider === "worker")?.speedTiers, ["standard", "fast"]);
  await client.models(parent.id); // Also starts an optional support refresh.
  await expectSupport(parent.id, ["standard", "fast"]);
  await expectSupport(assistant.id, ["standard", "fast"]);
  assert.deepEqual((await client.models(parent.id)).models.find(model => model.provider === "coordinator")?.speedTiers, ["standard", "fast"]);
  assert.equal((await setting(parent.id)).value, null, "Refreshing support does not select a speed");

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

  // Extend support again while Pi is answering. No Work/session replacement is needed.
  support.providers.upstream.ultrafast.push("fixture");
  await writeFile(supportFile, JSON.stringify(support));
  await expectSupport(parent.id, ["standard", "fast", "ultrafast"]);
  await expectSupport(assistant.id, ["standard", "fast", "ultrafast"]);
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
  await client.prompt(child.instance.id, "Answer directly.");
  const following = await worker.request(4);
  assert.equal(tier(following), "ultrafast", "An existing child uses newly supported speed without Reload or a model/settings query");
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
  // An unfinished support-file edit must retain the last good table for both Agents.
  await writeFile(supportFile, "{");
  assert.deepEqual((await setting(parent.id)).allowedValues, ["standard", "fast", "ultrafast"]);
  assert.deepEqual((await setting(assistant.id)).allowedValues, ["standard", "fast", "ultrafast"]);
  await client.updateSetting(assistant.id, { key: "modelSpeed", value: { tier: "ultrafast", scope: "work" } });
  await client.setAssistantSettings({ extractionSpeed: "fast" });
  await client.prompt(assistant.id, "Say hello.");
  const hers = await coordinator.request(2);
  assert.equal(tier(hers), "ultrafast", "The assistant uses the same speed path without a Pi extension");
  hers.text("你好。");
  await idle(assistant.id);
  // Card #674: her child Work may start child Works of its own. Shared speed passes through it to them.
  await client.updateSetting(assistant.id, { key: "modelSpeed", value: { tier: "fast", scope: "all" } });
  const lead = await team.registry!.invokeDockTool(assistant.id, { type: "spawn", operationId: "her-lead", task: "Have a helper read the memo.", name: "lead", model: { provider: "worker", id: "fixture" } });
  assert.ok(lead.type === "spawn");
  const leadFirst = await worker.request(7);
  assert.equal(tier(leadFirst), "priority");
  leadFirst.tools({ id: "lead-spawn", name: "dock_spawn", arguments: { name: "helper", task: "Read the memo.", model: { provider: "helper", id: "fixture" } } });
  const helperFirst = await helper.request(0);
  assert.equal(tier(helperFirst), "priority", "A child of her child Work follows her shared speed through it");
  (await worker.request(8)).text("Waiting for the helper.");
  await idle(lead.instance.id);
  await client.updateSetting(assistant.id, { key: "modelSpeed", value: { tier: "ultrafast", scope: "all" } });
  helperFirst.tools({ id: "helper-read", name: "read", arguments: { path: memo } });
  const helperNext = await helper.request(1);
  assert.equal(tier(helperNext), "ultrafast", "Her change reaches it through its parent, which still follows her");
  helperNext.tools({ id: "helper-done", name: "dock_send", arguments: { message: "Memo read.", done: true } });
  (await worker.request(9)).tools({ id: "lead-done", name: "dock_send", arguments: { message: "Done.", done: true } });
  (await coordinator.request(3)).text("收到。");
  await idle(assistant.id);
  assert.equal((await client.assistantSettings()).extractionSpeed, "fast", "Background memory has a separate selection");
  for (const original of [parent, assistant]) {
    const current = await client.status(original.id);
    assert.equal(current.id, original.id);
    assert.equal(current.runtimeGeneration, original.runtimeGeneration, "Speed support refresh retains the running Work");
    assert.equal(current.executor.piSessionId, original.executor.piSessionId, "Speed support refresh retains the conversation");
    assert.deepEqual(current.executor.model, original.executor.model, "Speed support refresh does not change the model");
  }
  // Losing Main's model service must not prevent reading other settings or erase known support.
  await team.modelService!.stop();
  const settings = await client.settings(parent.id);
  assert.ok(settings.settings.some(item => item.key === "transport"));
  assert.deepEqual(settings.settings.find(item => item.key === "modelSpeed")?.allowedValues, ["standard", "fast", "ultrafast"]);
  assert.deepEqual((await setting(assistant.id)).allowedValues, ["standard", "fast", "ultrafast"]);

  const catalog = JSON.parse(await readFile(join(team.root, "catalog.json"), "utf8"));
  assert.deepEqual(catalog.instances.find((item: { id: string }) => item.id === parent.id).modelSpeed, { tier: "ultrafast", scope: "all" });
});
