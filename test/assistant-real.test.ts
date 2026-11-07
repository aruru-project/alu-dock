import assert from "node:assert/strict";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const systemPrompt = (body: { messages?: Array<{ role: string; content?: unknown }> }) => JSON.stringify(body.messages?.filter((message) => message.role === "system" || message.role === "developer") ?? []);

// Card #295: a Work opened as the assistant knows her persona and the owner's notes, its conversation
// becomes hers and she can find it again; a Work not opened as her neither knows nor records anything.
test("a Work opened as the assistant loads her persona and notes, and her conversations can be searched later", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const notes = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子。", notes.revision);

  const alu = await trustOnce((trust) => client.create(team.cwd, "Alu", "assistant-create", trust, undefined, undefined, undefined, true));
  assert.equal(alu.assistant, true);
  const plain = await trustOnce((trust) => client.create(team.cwd, "Plain", "plain-create", trust));
  assert.equal(plain.assistant, undefined);

  await client.prompt(alu.id, "我家猫叫什么来着？", "auto", "alu-ask");
  const asked = await coordinator.request(0);
  assert.ok(systemPrompt(asked.body).includes("你是**阿露**"), "The assistant loads the shipped persona");
  assert.ok(systemPrompt(asked.body).includes("主人的猫叫团子。"), "The assistant loads the owner's notes");
  asked.text("团子呀，这都忘了？");
  await settled(client, alu.id);

  await client.prompt(plain.id, "随便聊聊天气（不该记住）", "auto", "plain-ask");
  const plainAsked = await coordinator.request(1);
  assert.ok(!systemPrompt(plainAsked.body).includes("团子"), "A Work not opened as the assistant knows nothing of her");
  plainAsked.text("晴。");
  await settled(client, plain.id);

  // Her conversation reaches Main with where it came from; the other Work's does not.
  await waitFor(async () => (await client.assistantSearch("团子")).hits.length === 1, "The assistant's conversation was not recorded");
  const found = await client.assistantSearch("团子");
  assert.equal(found.hits[0]!.kind, "assistant");
  assert.equal(found.hits[0]!.session.workId, alu.id);
  assert.equal(found.hits[0]!.session.machine, "Main");
  assert.equal((await client.assistantSearch("天气")).hits.length, 0);
  const around = await client.assistantContext(found.hits[0]!.session.sessionId, found.hits[0]!.entryId, 5, 5);
  assert.deepEqual(around.entries.map((entry) => entry.text), ["我家猫叫什么来着？", "团子呀，这都忘了？"]);

  // She searches her memory herself, with a two-character word.
  await client.prompt(alu.id, "上次说的猫叫啥？自己查。", "auto", "alu-recall");
  (await coordinator.request(2)).tools({ id: "recall", name: "assistant_search", arguments: { query: "团子" } });
  const recalled = await coordinator.request(3);
  assert.ok(JSON.stringify(recalled.body.messages).includes("团子呀，这都忘了？"), "Her search returns the earlier reply");
  recalled.text("团子。");
  await settled(client, alu.id);

  // Notes changed later reach her session when it reloads; what she loads is what the client sees.
  const current = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子，狗叫豆包。", current.revision);
  assert.ok((await client.assistantPreview()).text.includes("狗叫豆包"));
  await client.reloadSession(alu.id, "alu-reload");
  await client.prompt(alu.id, "狗呢？", "auto", "alu-dog");
  const dog = await coordinator.request(4);
  assert.ok(systemPrompt(dog.body).includes("狗叫豆包"), "A reloaded session loads the latest notes");
  dog.text("豆包。");
  await settled(client, alu.id);
});
