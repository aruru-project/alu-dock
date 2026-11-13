import assert from "node:assert/strict";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const systemPrompt = (body: { messages?: Array<{ role: string; content?: unknown }> }) => JSON.stringify(body.messages?.filter((message) => message.role === "system" || message.role === "developer") ?? []);

// Card #295: Dock turns her conversations into memories on Main with the model chosen in her
// settings; each names where it was said, and her next session starts with those loaded every time.
// The same reading writes her timeline, which her next session starts with too and which she sees
// first when she looks up a time.
test("what she hears becomes a memory and a timeline line her next session starts with, naming where it was said, and starting over reads it all again", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "memory"], {
    prefix: "alu-memory-", assistant: true, modelService: true,
    // A conversation is read a second after its last words; dreaming stays out of this test.
    assistantTiming: { idleMs: 1_000, tickMs: 100, quietMs: 0, dreamChanges: 1_000_000, dreamIntervalMs: 1e15 },
  });
  const { coordinator, memory } = team.providers;
  const client = await team.startHost();
  // Card #295: without a chosen model nothing is extracted, and the owner is told so.
  assert.equal((await client.assistantInfo()).extraction?.state, "off");
  await client.setAssistantSettings({ extractionModel: { provider: "memory", id: "fixture" } });

  const alu = await team.assistantWork();
  await client.prompt(alu.id, "我不吃香菜，以后点外卖记得避开。", "auto", "alu-coriander");
  (await coordinator.request(0)).text("记住啦，香菜退散～");
  await settled(client, alu.id);

  const reading = await memory.request(0);
  const read = JSON.stringify(reading.body.messages);
  assert.ok(read.includes("主人：我不吃香菜，以后点外卖记得避开。"), "Extraction reads what the owner said");
  assert.ok(read.includes("助手：记住啦，香菜退散～"), "Extraction reads what she answered");
  // Owner's decision of 2026-11-10: it looks up her other memories itself, and gets its answer before it replies.
  reading.tools({ id: "look", name: "search_memories", arguments: { queries: ["香菜"] } });
  const answered = await memory.request(1);
  assert.ok(JSON.stringify(answered.body.messages?.find((message) => message.role === "tool")?.content ?? "").includes("香菜"), "The search is answered");
  answered.text("```json\n{\"changes\":[{\"do\":\"add\",\"topic\":\"preferences\",\"text\":\"主人不吃香菜，点外卖要避开。\",\"resident\":true,\"from\":[1]}],\"timeline\":[{\"do\":\"add\",\"text\":\"聊外卖，主人交代不吃香菜。\",\"from\":[1,2]}]}\n```");

  await waitFor(async () => (await client.assistantMemories()).memories.length === 1, "The memory was not kept");
  const [kept] = (await client.assistantMemories()).memories;
  const said = (await client.assistantSearch("香菜")).hits.find((hit) => hit.kind === "user");
  assert.ok(said, "The owner's words are in her conversations");
  assert.deepEqual(
    { text: kept!.text, topic: kept!.topic, resident: kept!.resident, author: kept!.author, saidAt: kept!.saidAt, sources: kept!.sources.map((source) => [source.sessionId, source.entryId]) },
    { text: "主人不吃香菜，点外卖要避开。", topic: "preferences", resident: true, author: "extraction", saidAt: said.at, sources: [[said.session.sessionId, said.entryId]] },
  );
  // The timeline line covers the owner's words and her answer, says which Work it happened in, and
  // starts where the owner said it.
  const [line] = (await client.assistantTimeline()).episodes;
  assert.deepEqual(
    { text: line!.text, fromAt: line!.fromAt, workId: line!.session.workId, author: line!.author, entryId: line!.entryId },
    { text: "聊外卖，主人交代不吃香菜。", fromAt: said.at, workId: alu.id, author: "extraction", entryId: said.entryId },
  );

  // A session that starts again loads both; the one that was open was not told.
  await client.reloadSession(alu.id, "alu-reload");
  await client.prompt(alu.id, "晚饭点什么？我们今天聊过啥来着？", "auto", "alu-dinner");
  const dinner = await coordinator.request(1);
  assert.ok(systemPrompt(dinner.body).includes("主人不吃香菜，点外卖要避开。"), "A new session starts with what she remembers");
  assert.ok(systemPrompt(dinner.body).includes("聊外卖，主人交代不吃香菜。"), "A new session starts with the week's timeline");
  // Looking up a time shows the memories said then and the timeline before the words said then, and
  // the timeline line says where to read its words.
  dinner.tools({ id: "today", name: "assistant_search", arguments: { from: new Date(Date.now() - 86_400_000).toISOString() } });
  const looked = await coordinator.request(2);
  const shown = JSON.stringify(looked.body.messages?.find((message) => message.role === "tool")?.content ?? "");
  const lineAt = shown.indexOf("聊外卖，主人交代不吃香菜。");
  const wordsAt = shown.indexOf("我不吃香菜，以后点外卖记得避开。");
  assert.ok(shown.indexOf("主人不吃香菜，点外卖要避开。") >= 0 && shown.indexOf("主人不吃香菜，点外卖要避开。") < lineAt, `The memory said then comes first: ${shown}`);
  assert.ok(lineAt >= 0 && lineAt < wordsAt, `The timeline comes before the words said: ${shown}`);
  assert.ok(shown.slice(lineAt, shown.indexOf("Found ", lineAt)).includes(`entryId=${said.entryId}`), `The timeline line says where its words are: ${shown}`);
  looked.text("麻辣烫，不要香菜。今天就聊了外卖。");
  await settled(client, alu.id);
  // Nothing new to remember; the dinner still lands on the day's line.
  (await memory.request(2)).text(JSON.stringify({ changes: [], timeline: [{ do: "rewrite", id: line!.id, text: "聊外卖，主人交代不吃香菜；晚饭点了麻辣烫。", from: [1, 2] }] }));
  await waitFor(async () => (await client.assistantInfo()).extraction?.waitingSessions === 0, "The dinner was not read");

  // The owner starts over: what the background made is set aside and everything is read again.
  assert.deepEqual(await client.reorganizeAssistant({ provider: "memory", id: "fixture" }), { extractionModel: { provider: "memory", id: "fixture" }, retiredMemories: 1, removedLines: 1 });
  assert.deepEqual((await client.assistantMemories()).memories, []);
  assert.equal((await client.assistantMemories({ state: "retired" })).memories[0]?.id, kept!.id);
  const again = await memory.request(3);
  assert.ok(JSON.stringify(again.body.messages).includes("主人：我不吃香菜，以后点外卖记得避开。"), "The conversation is read again from its start");
  again.text(JSON.stringify({ changes: [], timeline: [{ do: "add", text: "聊外卖。", from: [1] }] }));
});

// Card #295: what the owner tells her to remember in a conversation is kept at once with where he
// said it; what he has her forget is no longer loaded or found: not the words it came from, not what
// she answered to them, not the request to forget it (review of 2026-11-10: her answer and the request
// were still found, each saying the very thing). She chooses the model that keeps her memories and
// starts them over when he asks, once he has confirmed.
test("she keeps what the owner tells her to remember, forgets it so it cannot be found, chooses the model that keeps her memories and starts them over once he confirms", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-remember-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();

  await client.prompt(alu.id, "记住：我下周三要去体检。", "auto", "alu-remember");
  (await coordinator.request(0)).tools({ id: "remember", name: "assistant_memory", arguments: { action: "add", topic: "events", text: "主人下周三要去体检。" } });
  (await coordinator.request(1)).text("记下了，下周三体检。");
  await settled(client, alu.id);
  const [kept] = (await client.assistantMemories()).memories;
  const said = (await client.assistantSearch("体检")).hits.find((hit) => hit.kind === "user");
  assert.ok(said, "The owner's words are in her conversations");
  assert.deepEqual(
    { text: kept!.text, author: kept!.author, sources: kept!.sources.map((source) => [source.sessionId, source.entryId]) },
    { text: "主人下周三要去体检。", author: "assistant", sources: [[said.session.sessionId, said.entryId]] },
  );

  await client.prompt(alu.id, "把我下周三体检那件事忘掉吧。", "auto", "alu-forget");
  (await coordinator.request(2)).tools({ id: "forget", name: "assistant_memory", arguments: { action: "forget", id: kept!.id } });
  (await coordinator.request(3)).text("好，体检的事忘掉了。");
  await settled(client, alu.id);
  assert.deepEqual((await client.assistantMemories()).memories, []);
  const [gone] = (await client.assistantMemories({ state: "forgotten" })).memories;
  assert.equal(gone?.id, kept!.id, "The owner can still find it among the forgotten and restore it");
  assert.ok(!(await client.assistantPreview()).text.includes("体检"));
  // Both exchanges are recorded: his words, her tool call and her answer, twice.
  const conversation = () => client.assistantContext(said.session.sessionId, said.entryId, 0, 10);
  await waitFor(async () => (await conversation()).entries.length === 6, "The second conversation was not recorded");
  assert.deepEqual((await client.assistantSearch("体检")).hits, [], "Neither the words it came from, nor her answer, nor the request to forget it are found");
  assert.deepEqual((await client.assistantSearch("忘掉")).hits, []);
  assert.ok(!JSON.stringify((await conversation()).entries).includes("体检"), "Reading around where it was said does not show it either");
  // Restored by the owner, everything that went with it is back.
  await client.updateAssistantMemory({ id: gone!.id, revision: gone!.revision, state: "active" });
  assert.deepEqual((await client.assistantSearch("体检")).hits.map((hit) => hit.snippet).sort(), ["好，体检的事忘掉了。", "把我下周三体检那件事忘掉吧。", "记下了，下周三体检。", "记住：我下周三要去体检。"]);

  // Card #295: she can also choose the model that keeps her memories, when the owner asks her to.
  await client.prompt(alu.id, "整理记忆就用 coordinator 的 fixture 吧。", "auto", "alu-model");
  (await coordinator.request(4)).tools({ id: "model", name: "assistant_memory", arguments: { action: "set_model", model: "coordinator/fixture" } });
  (await coordinator.request(5)).text("换好了。");
  await settled(client, alu.id);
  assert.deepEqual((await client.assistantSettings()).extractionModel, { provider: "coordinator", id: "fixture" });

  // Card #295: what the owner can do in her settings she can do too. Starting over asks him first.
  await client.prompt(alu.id, "用这个模型把记忆从头整理一遍吧。", "auto", "alu-restart");
  (await coordinator.request(6)).tools({ id: "restart", name: "assistant_memory", arguments: { action: "reorganize" } });
  await waitFor(async () => (await client.status(alu.id)).activeInteraction?.method === "confirm", "The owner was not asked to confirm");
  await client.respondInteraction(alu.id, undefined, (await client.status(alu.id)).activeInteraction!.id, { method: "confirm", confirmed: true });
  const restarted = await coordinator.request(7);
  assert.ok(JSON.stringify(restarted.body.messages?.findLast((message) => message.role === "tool")?.content ?? "").includes("Started over with coordinator/fixture"), "She is told it started");
  restarted.text("开始从头读了。");
  await settled(client, alu.id);
  assert.equal((await client.assistantMemories()).memories[0]?.id, kept!.id, "What she wrote down at his word stays");
});
