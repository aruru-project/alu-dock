import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { createPiSystemTemplateProvider } from "../src/pi/system-template-provider.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const systemMessages = (body: { messages?: Array<{ role: string; content?: unknown }> }) => body.messages?.filter((message) => message.role === "system" || message.role === "developer") ?? [];
const systemPrompt = (body: { messages?: Array<{ role: string; content?: unknown }> }) => JSON.stringify(systemMessages(body));

// Card #295: a Work opened as the assistant knows her persona and the owner's notes, its conversation
// becomes hers and she can find it again; a Work not opened as her neither knows nor records anything.
test("a Work opened as the assistant loads her persona and notes, and her conversations can be searched later", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-", assistant: true });
  const { coordinator } = team.providers;
  // Like the Claude models, the model takes system messages mid-conversation: a session keeps its
  // first prompt at the head and gets later prompt changes as updates after it.
  const modelsFile = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  for (const model of models.providers.coordinator.models) model.compat = { supportsMidConvoSystemMessages: true };
  await writeFile(modelsFile, JSON.stringify(models));
  const client = await team.startHost();
  const notes = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子。", notes.revision);

  // The project has its own SYSTEM.md and AGENTS.md.
  const projectSystem = join(team.cwd, ".pi", "SYSTEM.md");
  await mkdir(join(team.cwd, ".pi"));
  await writeFile(projectSystem, "PROJECT SYSTEM TEXT");
  await writeFile(join(team.cwd, "AGENTS.md"), "PROJECT RULES TEXT");
  // Like an assistant Work created before 2026-11-12, it also carries that SYSTEM.md as its chosen system.
  const olderChoice = createPiSystemTemplateProvider(team.agentDir).workerConfig({ kind: "project-system", path: projectSystem });
  const alu = await trustOnce((trust) => client.create(team.cwd, "Alu", "assistant-create", trust, undefined, olderChoice, undefined, true));
  assert.equal(alu.assistant, true);
  const plain = await trustOnce((trust) => client.create(team.cwd, "Plain", "plain-create", trust));
  assert.equal(plain.assistant, undefined);

  await client.prompt(alu.id, "我家猫叫什么来着？", "auto", "alu-ask");
  const asked = await coordinator.request(0);
  // 2026-11-12: she is the Work's system. Her persona opens the prompt in place of Pi's "coding
  // assistant" line and of any SYSTEM.md; Pi's tool list and the project's AGENTS.md stay.
  const prompt = systemMessages(asked.body).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  assert.ok(prompt.startsWith("## 身份\n\n你是**阿露**"), `The prompt opens with her persona: ${prompt.slice(0, 200)}`);
  assert.ok(!prompt.includes("You are an expert coding assistant"), "Pi's coding-assistant line is gone");
  assert.ok(!prompt.includes("PROJECT SYSTEM TEXT"), "No SYSTEM.md is read for her");
  assert.ok(prompt.includes("<tools>") && prompt.includes("PROJECT RULES TEXT"), "Pi's tool list and the project's AGENTS.md stay");
  assert.ok(prompt.includes("主人的猫叫团子。"), "The assistant loads the owner's notes");
  asked.text("团子呀，这都忘了？");
  await settled(client, alu.id);

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

  // Continued after a crash, the Work is still her.
  process.kill(team.workerPids[0]!, "SIGKILL");
  await waitFor(async () => (await client.status(alu.id)).lifecycle === "runtime_error", "The crash was not observed");
  await trustOnce((trust) => client.reopen(alu.id, "alu-reopen", undefined, trust));
  assert.equal((await client.status(alu.id)).assistant, true);
  await client.prompt(alu.id, "还在吗？", "auto", "alu-back");
  const back = await coordinator.request(5);
  assert.ok(systemPrompt(back.body).includes("狗叫豆包"), "A continued Work loads her again");
  back.text("在。");
  await settled(client, alu.id);

  // (2026-11-12 review) A session that began with another opening, here the plain Work's with the
  // project's SYSTEM.md, still opens her requests with her once resumed in her Work.
  const plainSession = (await client.read(plain.id)).instance.executor.sessionFile;
  assert.ok(plainSession);
  await client.stop(plain.id, "plain-stop");
  await trustOnce((trust) => client.switchSession(alu.id, plainSession, "alu-resume-plain", trust));
  await client.prompt(alu.id, "接着聊。", "auto", "alu-resumed");
  const resumed = await coordinator.request(6);
  const resumedSystem = systemMessages(resumed.body).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  assert.ok(resumedSystem[0]?.startsWith("## 身份\n\n你是**阿露**"), `The request opens with her persona: ${resumedSystem[0]?.slice(0, 200)}`);
  assert.ok(!resumedSystem.some((text) => text.includes("PROJECT SYSTEM TEXT") || text.includes("You are an expert coding assistant")), "The session's earlier opening is not sent");
  assert.ok(resumedSystem.join("\n").includes("<tools>") && resumedSystem.join("\n").includes("PROJECT RULES TEXT"), "Pi's tool list and the project's AGENTS.md stay");
  resumed.text("嗯。");
  await settled(client, alu.id);
});
