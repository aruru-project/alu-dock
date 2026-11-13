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
  const alu = await trustOnce((trust) => client.create(team.cwd, "Alu", "assistant-create", trust, undefined, undefined, undefined, true));
  assert.equal(alu.assistant, true);
  assert.equal(alu.executor.kind, "dock-assistant");
  const plain = await trustOnce((trust) => client.create(team.cwd, "Plain", "plain-create", trust));
  assert.equal(plain.assistant, undefined);

  await client.prompt(alu.id, "我家猫叫什么来着？", "auto", "alu-ask");
  const asked = await coordinator.request(0);
  const prompt = systemMessages(asked.body).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  assert.ok(prompt.startsWith("## 身份\n\n你是**阿露**"), `The prompt opens with her persona: ${prompt.slice(0, 200)}`);
  assert.ok(prompt.includes("主人的猫叫团子。"), "The assistant loads the owner's notes");
  // Card #667: she is not a coding Work. The project's rules belong to the Works that work there, and
  // she has no file or shell tools of her own.
  assert.ok(!prompt.includes("PROJECT SYSTEM TEXT") && !prompt.includes("PROJECT RULES TEXT") && !prompt.includes("You are an expert coding assistant"), "Nothing of the project or of Pi's coding prompt is loaded for her");
  assert.deepEqual(asked.toolNames.filter((name) => !name.startsWith("assistant_")), [], "Her own Agent offers the model only her tools");
  assert.ok(asked.toolNames.includes("assistant_search"));
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
  await trustOnce((trust) => client.reopen(alu.id, "alu-reopen", undefined, trust));
  assert.equal((await client.status(alu.id)).assistant, true);
  await client.prompt(alu.id, "狗呢？", "auto", "alu-dog");
  const dog = await coordinator.request(4);
  assert.ok(systemPrompt(dog.body).includes("狗叫豆包"), "A continued Work loads her again, as she is now");
  assert.ok(JSON.stringify(dog.body.messages).includes("团子呀，这都忘了？"), "A continued Work has its conversation back");
  dog.text("豆包。");
  await settled(client, alu.id);
});
