import assert from "node:assert/strict";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const systemPrompt = (body: { messages?: Array<{ role: string; content?: unknown }> }) => JSON.stringify(body.messages?.filter((message) => message.role === "system" || message.role === "developer") ?? []);

// Card #295: Dock turns her conversations into memories on Main with the model chosen in her
// settings; each names where it was said, and her next session starts with those loaded every time.
test("what she hears becomes a memory her next session starts with, naming where it was said", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "memory"], {
    prefix: "alu-memory-", assistant: true, modelService: true,
    // A conversation is read a second after its last words; dreaming stays out of this test.
    assistantTiming: { idleMs: 1_000, tickMs: 100, quietMs: 0, dreamChanges: 1_000_000, dreamIntervalMs: 1e15 },
  });
  const { coordinator, memory } = team.providers;
  const client = await team.startHost();
  // Card #295: without a chosen model nothing is extracted, and the owner is told so.
  assert.equal((await client.assistantInfo()).extraction?.state, "off");
  await client.setAssistantSettings({ provider: "memory", id: "fixture" });

  const alu = await trustOnce((trust) => client.create(team.cwd, "Alu", "alu-create", trust, undefined, undefined, undefined, true));
  await client.prompt(alu.id, "我不吃香菜，以后点外卖记得避开。", "auto", "alu-coriander");
  (await coordinator.request(0)).text("记住啦，香菜退散～");
  await settled(client, alu.id);

  const reading = await memory.request(0);
  const read = JSON.stringify(reading.body.messages);
  assert.ok(read.includes("主人：我不吃香菜，以后点外卖记得避开。"), "Extraction reads what the owner said");
  assert.ok(read.includes("助手：记住啦，香菜退散～"), "Extraction reads what she answered");
  reading.text("```json\n{\"changes\":[{\"do\":\"add\",\"topic\":\"preferences\",\"text\":\"主人不吃香菜，点外卖要避开。\",\"resident\":true,\"from\":[1]}]}\n```");

  await waitFor(async () => (await client.assistantMemories()).memories.length === 1, "The memory was not kept");
  const [kept] = (await client.assistantMemories()).memories;
  const said = (await client.assistantSearch("香菜")).hits.find((hit) => hit.kind === "user");
  assert.ok(said, "The owner's words are in her conversations");
  assert.deepEqual(
    { text: kept!.text, topic: kept!.topic, resident: kept!.resident, author: kept!.author, sources: kept!.sources.map((source) => [source.sessionId, source.entryId]) },
    { text: "主人不吃香菜，点外卖要避开。", topic: "preferences", resident: true, author: "extraction", sources: [[said.session.sessionId, said.entryId]] },
  );

  // A session that starts again loads it; the one that was open was not told.
  await client.reloadSession(alu.id, "alu-reload");
  await client.prompt(alu.id, "晚饭点什么？", "auto", "alu-dinner");
  const dinner = await coordinator.request(1);
  assert.ok(systemPrompt(dinner.body).includes("主人不吃香菜，点外卖要避开。"), "A new session starts with what she remembers");
  dinner.text("麻辣烫，不要香菜。");
  await settled(client, alu.id);
});

// Card #295: what the owner tells her to remember in a conversation is kept at once with where he
// said it; what he has her forget is no longer loaded or found, not even the words it came from.
test("she keeps what the owner tells her to remember, and once he has her forget it, it cannot be found", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-remember-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await trustOnce((trust) => client.create(team.cwd, "Alu", "alu-create", trust, undefined, undefined, undefined, true));

  await client.prompt(alu.id, "记住：我下周三要去体检。", "auto", "alu-remember");
  (await coordinator.request(0)).tools({ id: "remember", name: "assistant_memory", arguments: { action: "add", topic: "events", text: "主人下周三要去体检。" } });
  (await coordinator.request(1)).text("记下了。");
  await settled(client, alu.id);
  const [kept] = (await client.assistantMemories()).memories;
  const said = (await client.assistantSearch("体检")).hits.find((hit) => hit.kind === "user");
  assert.ok(said, "The owner's words are in her conversations");
  assert.deepEqual(
    { text: kept!.text, author: kept!.author, sources: kept!.sources.map((source) => [source.sessionId, source.entryId]) },
    { text: "主人下周三要去体检。", author: "assistant", sources: [[said.session.sessionId, said.entryId]] },
  );

  await client.prompt(alu.id, "刚才那件事，帮我忘掉吧。", "auto", "alu-forget");
  (await coordinator.request(2)).tools({ id: "forget", name: "assistant_memory", arguments: { action: "forget", id: kept!.id } });
  (await coordinator.request(3)).text("忘掉了。");
  await settled(client, alu.id);
  assert.deepEqual((await client.assistantMemories()).memories, []);
  assert.equal((await client.assistantMemories({ state: "forgotten" })).memories[0]?.id, kept!.id, "The owner can still find it among the forgotten and restore it");
  assert.ok(!(await client.assistantPreview()).text.includes("体检"));
  await waitFor(async () => (await client.assistantSearch("忘掉")).hits.length > 0, "The second conversation was not recorded");
  assert.deepEqual((await client.assistantSearch("体检")).hits, [], "Neither the memory nor the words it came from are found");
  const around = await client.assistantContext(said.session.sessionId, said.entryId, 0, 10);
  assert.ok(!JSON.stringify(around.entries).includes("体检"), "Reading around where it was said does not show it either");
});
