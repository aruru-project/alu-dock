import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const systemMessages = (body: { messages?: Array<{ role: string; content?: unknown }> }) => body.messages?.filter((message) => message.role === "system" || message.role === "developer") ?? [];
const systemPrompt = (body: { messages?: Array<{ role: string; content?: unknown }> }) => JSON.stringify(systemMessages(body));

// Cards #295 and #667: a Work opened as the assistant runs her own Agent. It knows her persona and the
// owner's notes, its conversation becomes hers and she can find it again; a Work not opened as her
// neither knows nor records anything.
test("a Work opened as the assistant is her: it loads her persona and notes, answers with her own tools only, and her conversations can be searched later", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const notes = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子。", notes.revision);

  // The project has its own SYSTEM.md and AGENTS.md.
  await mkdir(join(team.cwd, ".pi"));
  await writeFile(join(team.cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM TEXT");
  await writeFile(join(team.cwd, "AGENTS.md"), "PROJECT RULES TEXT");
  const alu = await team.assistantWork();
  assert.equal(alu.assistant, true);
  assert.equal(alu.executor.kind, "dock-assistant");
  const plain = await trustOnce((trust) => client.create(team.cwd, "Plain", "plain-create", trust));
  assert.equal(plain.assistant, undefined);

  await client.prompt(alu.id, "我家猫叫什么来着？", "auto", "alu-ask");
  const asked = await coordinator.request(0);
  const prompt = systemMessages(asked.body).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  assert.ok(prompt.startsWith("## 身份\n\n你是**阿露**"), `The prompt opens with her persona: ${prompt.slice(0, 200)}`);
  assert.ok(prompt.includes("主人的猫叫团子。"), "The assistant loads the owner's notes");
  // Card #667: she is not a coding Work. The project's rules belong to the Works that work there.
  assert.ok(!prompt.includes("PROJECT SYSTEM TEXT") && !prompt.includes("PROJECT RULES TEXT") && !prompt.includes("You are an expert coding assistant"), "Nothing of the project or of Pi's coding prompt is loaded for her");
  assert.ok(asked.toolNames.includes("assistant_search") && asked.toolNames.includes("dock_spawn"));
  asked.text("团子呀，这都忘了？");
  await settled(client, alu.id);
  assert.deepEqual((await client.history(alu.id)).entries.filter((entry) => entry.visibility === "conversation").map((entry) => entry.source), ["user", "assistant"]);

  await client.prompt(plain.id, "随便聊聊天气（不该记住）", "auto", "plain-ask");
  const plainAsked = await coordinator.request(1);
  // Card #295: a Work not opened as her neither reads nor writes her memory.
  assert.ok(!systemPrompt(plainAsked.body).includes("团子"), "A Work not opened as the assistant knows nothing of her");
  assert.ok(systemPrompt(plainAsked.body).includes("PROJECT SYSTEM TEXT"), "A Work not opened as her still uses the project's SYSTEM.md");
  plainAsked.text("晴。");
  await settled(client, plain.id);

  // Her conversation reaches Main with where it came from; the other Work's does not.
  await waitFor(async () => (await client.assistantSearch("团子")).hits.length === 1, "The assistant's conversation was not recorded");
  const found = await client.assistantSearch("团子");
  assert.equal(found.hits[0]!.kind, "assistant");
  assert.equal(found.hits[0]!.session.workId, alu.id);
  assert.equal((await client.assistantSearch("天气")).hits.length, 0, "Card #295: a Work not opened as her is not recorded");
  const around = await client.assistantContext(found.hits[0]!.session.sessionId, found.hits[0]!.entryId, 5, 5);
  assert.deepEqual(around.entries.map((entry) => entry.text), ["我家猫叫什么来着？", "团子呀，这都忘了？"]);

  // She searches her memory herself, with a two-character word.
  await client.prompt(alu.id, "上次说的猫叫啥？自己查。", "auto", "alu-recall");
  (await coordinator.request(2)).tools({ id: "recall", name: "assistant_search", arguments: { query: "团子" } });
  const recalled = await coordinator.request(3);
  assert.ok(JSON.stringify(recalled.body.messages).includes("团子呀，这都忘了？"), "Her search returns the earlier reply");
  recalled.text("团子。");
  await settled(client, alu.id);

  // Card #667: her conversation is one line. Asking for a new session changes nothing, and she goes on.
  assert.equal((await client.newSession(alu.id, undefined, "alu-new")).cancelled, true);
  assert.equal((await client.status(alu.id)).runtimeGeneration, alu.runtimeGeneration);

  // Continued after a crash, the Work is still her, with her conversation and the notes as they are now.
  const current = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子，狗叫豆包。", current.revision);
  process.kill(team.workerPids[0]!, "SIGKILL");
  await waitFor(async () => (await client.status(alu.id)).lifecycle === "runtime_error", "The crash was not observed");
  await team.assistantWork();
  assert.equal((await client.status(alu.id)).assistant, true);
  await client.prompt(alu.id, "狗呢？", "auto", "alu-dog");
  const dog = await coordinator.request(4);
  assert.ok(systemPrompt(dog.body).includes("狗叫豆包"), "A continued Work loads her again, as she is now");
  assert.ok(JSON.stringify(dog.body.messages).includes("团子呀，这都忘了？"), "A continued Work has its conversation back");
  dog.text("豆包。");
  await settled(client, alu.id);
});

// Card #667: what a Pi Work lets its owner do while it replies stays with her own Agent: a message sent
// meanwhile waits and joins the reply at its next step, can be taken back, and Stop ends the reply.
test("while she replies a message waits its turn, can be taken back or joins at her next step, and Stop ends the reply", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "second"], { prefix: "alu-assistant-queue-", assistant: true });
  const { coordinator, second } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();

  await client.prompt(alu.id, "第一句", "auto", "alu-first");
  const first = await coordinator.request(0);
  const waiting = await client.prompt(alu.id, "这句发错了", "auto", "alu-mistake");
  assert.deepEqual({ queued: waiting.receipt.queued, delivery: waiting.receipt.delivery }, { queued: true, delivery: "steer" });
  assert.equal((await client.status(alu.id)).pending.total, 1);
  const taken = await client.dequeue(alu.id, "alu-take-back");
  assert.deepEqual(taken.receipt.restored.map((item) => item.text), ["这句发错了"]);
  assert.equal((await client.status(alu.id)).pending.total, 0);

  await client.prompt(alu.id, "顺便看看记忆里有没有团子", "auto", "alu-join");
  first.tools({ id: "look", name: "assistant_search", arguments: { query: "团子" } });
  const joined = await coordinator.request(1);
  const said = (joined.body.messages ?? []).filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
  assert.ok(said.some((text) => text.includes("顺便看看记忆里有没有团子")) && !said.some((text) => text.includes("这句发错了")), "What waited joins the reply at its next step; what was taken back does not");
  joined.text("没有团子。");
  await settled(client, alu.id);
  assert.equal((await client.status(alu.id)).pending.total, 0);

  // Stop ends a reply that waits for the model; she takes the next message.
  await client.prompt(alu.id, "讲个很长的故事", "auto", "alu-long");
  await coordinator.request(2);
  await client.abort(alu.id, "alu-stop");
  await waitFor(async () => (await client.status(alu.id)).lastRun === "aborted", "Stop did not end her reply");

  // She changes model when asked, keeps the choice when the Work is opened again, and asks a failed request again.
  await client.setModel(alu.id, "second", "fixture", "alu-model");
  await client.prompt(alu.id, "换了模型还在吗？", "auto", "alu-after-model");
  (await second.request(0)).fail(503, "overloaded");
  (await second.request(1)).text("在。");
  await settled(client, alu.id);
  assert.equal((await client.status(alu.id)).lastRun, "succeeded");
  process.kill(team.workerPids[0]!, "SIGKILL");
  await waitFor(async () => (await client.status(alu.id)).lifecycle === "runtime_error", "The crash was not observed");
  await team.assistantWork();
  assert.deepEqual((await client.status(alu.id)).executor.model, { provider: "second", id: "fixture" });
});
