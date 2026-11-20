import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DOCK_VERSION } from "../src/version.js";
import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
/** Everything the model was given in this request, as one text. */
const given = (request: HeldChatRequest) => JSON.stringify(request.body.messages);
const system = (request: HeldChatRequest) => JSON.stringify((request.body.messages ?? []).filter((message) => message.role === "system" || message.role === "developer"));
/** Long enough to pass the point where a hand-over record is written for a 100k-token model, short of where she must wait for it. */
const LONG_PASTE = "lorem ipsum dolor sit amet ".repeat(7_400);

async function assistantWithSmallWindow(context: test.TestContext, prefix: string, maxTokens?: number) {
  const team = await startNativeTeam(context, ["coordinator"], { prefix, assistant: true });
  const modelsFile = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  for (const model of models.providers.coordinator.models) {
    model.contextWindow = 100_000;
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
  }
  await writeFile(modelsFile, JSON.stringify(models));
  const client = await team.startHost();
  const alu = await team.assistantWork();
  return { team, client, alu, coordinator: team.providers.coordinator };
}

const records = async (client: DockClient, id: string) => (await client.history(id)).entries.filter((entry) => entry.kind === "compaction_summary");

const handoffDiagnostic = async (client: DockClient, id: string) => (await client.resources(id)).diagnostics.find(item => item.message.startsWith("滚动整理"));

async function retryNow(client: DockClient, id: string): Promise<string> {
  const command = "/retry-handoff";
  const operationId = randomUUID();
  let details: string | undefined;
  const follower = await client.streamEvents(id, { onEvent: event => {
    if (event.type === "extension.notification" && event.data.operationId === operationId) details = event.data.message;
  } });
  try {
    await client.prompt(id, command, "auto", operationId);
    await waitFor(() => details !== undefined, `The assistant's reply to ${command} did not arrive`);
    return details!;
  } finally {
    follower.close();
    await follower.done.catch(() => {});
  }
}

// Card #667: her conversation never starts over. When it grows long, the older part is written into a
// hand-over record in the background while she goes on answering (compacting in place made the
// Minecraft companion this follows deaf for 90 to 194 seconds), and the record takes its place later.
test("saved hand-over settings guide background writing while she answers, and survive restarting Main", { timeout: 90_000 }, async (context) => {
  const { team, client, alu, coordinator } = await assistantWithSmallWindow(context, "alu-assistant-handoff-", 8_192);
  const handoff = { startTokens: 55_000, keepRecentTokens: 1_200, prompt: "你是小满的交接记录员。用主人选的名字，只交接还没办完的事情，保留原话中的要求。" };
  assert.ok((await client.assistantSettings()).handoff?.prompt.includes("交接记录"), "Main supplies the editable factory instruction");
  await client.setAssistantSettings({ handoff });
  // An existing model-only caller leaves hand-over settings alone.
  assert.deepEqual((await client.setAssistantSettings({ extractionModel: null })).handoff, handoff);

  await client.prompt(alu.id, "周末去爬山，到时候记得提醒我带水壶。", "auto", "alu-plan");
  (await coordinator.request(0)).text("好，记着呢。");
  await settled(client, alu.id);
  await client.prompt(alu.id, `这是我贴的资料：${LONG_PASTE}`, "auto", "alu-paste");
  (await coordinator.request(1)).text("收到。");
  await settled(client, alu.id);

  // The record is being written: the model is asked for it and has not answered.
  const writing = await coordinator.request(2);
  assert.equal(writing.headers["user-agent"], `AluDock-Assistant/${DOCK_VERSION} (${process.platform}; node/${process.version}; ${process.arch})`, "Assistant handoff User-Agent");
  assert.equal(Reflect.get(writing.body, "max_completion_tokens"), 8_192, "The record can use the model's full output budget");
  assert.equal(writing.body.messages?.find((message) => message.role === "system" || message.role === "developer")?.content, handoff.prompt, "The entire saved instruction replaces the factory role and writing rules");
  // #671: routine background work is available on demand, not presented as a chat warning.
  assert.equal((await client.status(alu.id)).extensionStatus["滚动整理"], undefined);
  assert.equal(await handoffDiagnostic(client, alu.id), undefined);
  assert.ok(given(writing).includes("交接记录") && given(writing).includes("周末去爬山，到时候记得提醒我带水壶。"), "The older part of the conversation is given to the model to write the record from");
  // She answers her owner meanwhile, from the whole conversation.
  await client.prompt(alu.id, "在吗？", "auto", "alu-there");
  const meanwhile = await coordinator.request(3);
  assert.ok(given(meanwhile).includes("周末去爬山，到时候记得提醒我带水壶。"));
  meanwhile.text("在。");
  await settled(client, alu.id);

  // What her owner changed since she started reaches her when the record takes its place.
  const notes = await client.assistantDocument("notes");
  await client.setAssistantDocument("notes", "主人的猫叫团子。", notes.revision);
  writing.fail(400, "摘要请求失败" + "长".repeat(2_048));
  const status = async () => (await client.status(alu.id)).extensionStatus["滚动整理"];
  await waitFor(async () => (await status())?.includes("失败") === true, "The failure did not reach the status bar");
  assert.match((await status())!, /^(?:\d{1,2}月\d{1,2}日 )?\d{2}:\d{2} 失败，最早 (?:\d{1,2}月\d{1,2}日 )?\d{2}:\d{2} 后有对话时重试$/u);
  const failed = await handoffDiagnostic(client, alu.id);
  assert.ok(failed);
  assert.equal(failed.severity, "warning");
  assert.equal(failed.message.length, 2_048);
  assert.ok(failed.message.endsWith("…"));
  assert.ok(failed.message.startsWith('滚动整理失败原因：400: {"message":"摘要请求失败'));
  assert.equal(await retryNow(client, alu.id), "已开始重新整理，聊天照常。完成或失败都会显示在状态栏。");
  const retry = await coordinator.request(4);
  assert.equal(system(retry), system(writing), "The new request is another hand-over write, without waiting for the cooldown");
  assert.match((await status())!, /^正在重试（(?:\d{1,2}月\d{1,2}日 )?\d{2}:\d{2} 开始）$/u);
  retry.text("主人周末要去爬山；她答应到时候提醒他带上要带的东西。");
  await waitFor(async () => (await records(client, alu.id)).length === 1, "The hand-over record did not take its place");

  await waitFor(async () => (await status()) === undefined, "The status bar did not clear after the successful retry");
  assert.equal(await handoffDiagnostic(client, alu.id), undefined, "A successful retry clears the recorded failure reason");
  await client.prompt(alu.id, "周末要干嘛来着？", "auto", "alu-weekend");
  const after = await coordinator.request(5);
  assert.ok(given(after).includes("主人周末要去爬山；她答应到时候提醒他带上要带的东西。"), "She goes on from the record");
  assert.ok(!given(after).includes("到时候记得提醒我带水壶"), "What the record replaced is no longer given to the model");
  assert.ok(given(after).includes("lorem ipsum") && given(after).includes("在吗？"), "The latest conversation stays as it was said");
  assert.ok(system(after).includes("主人的猫叫团子。"), "Her notes are loaded anew with the record");
  after.text("爬山呀。");
  await settled(client, alu.id);
  // Clients still show the conversation from before the record, with the record in it.
  const shown = (await client.history(alu.id)).entries;
  assert.ok(shown.some((entry) => JSON.stringify(entry.content).includes("周末去爬山，到时候记得提醒我带水壶。")), "Clients keep showing what was said before the latest record");

  client.closeActiveConnections();
  await team.host!.stop();
  const reopened = await team.startHost();
  assert.deepEqual((await reopened.assistantSettings()).handoff, handoff, "Main keeps the saved parameters and full instruction after restarting");
  const resident = await team.assistantWork();
  assert.equal(await handoffDiagnostic(reopened, resident.id), undefined);
  assert.equal((await reopened.status(resident.id)).extensionStatus["滚动整理"], undefined, "A healthy idle assistant leaves the chat status bar clear");
});

// Card #667: what she is told to forget is no longer in front of her either: not where it was said
// or answered, not the request to forget it, and not a hand-over record written before.
test("what she is told to forget leaves what the model is given, also a hand-over record written before", { timeout: 90_000 }, async (context) => {
  const { client, alu, coordinator } = await assistantWithSmallWindow(context, "alu-assistant-forget-");
  // Review #670 found the cached opening still repeated forgotten resident memories, even ones
  // written in the UI with no source entry in this conversation.
  const resident = await client.addAssistantMemory({ topic: "owner", text: "主人家的门铃暗号是青栀。", resident: true });
  // Records are written and rewritten in the background at their own time; the model answers those
  // requests here whenever they come, and the test takes only the requests of her replies.
  const hers: HeldChatRequest[] = [];
  const rewrites: string[] = [];
  let handled = 0;
  const model = setInterval(() => {
    for (; handled < coordinator.requests.length; handled += 1) {
      const request = coordinator.requests[handled]!;
      if (request.closed) continue; // A record cancelled after forgetting no longer needs a reply.
      if (given(request).includes("要忘掉的事")) {
        rewrites.push(given(request));
        if (rewrites.length === 1) request.fail(400, "这一次没能改写");
        else request.text("没有还没了结的事。");
      }
      else if (given(request).includes("写一份交接记录")) request.text(given(request).includes("水壶") ? "主人周末爬山，她要提醒他带水壶。" : "主人贴过一份资料。");
      else hers.push(request);
    }
  }, 5);
  context.after(() => clearInterval(model));
  const reply = async (index: number): Promise<HeldChatRequest> => {
    await waitFor(() => hers.length > index, `Her model request ${index + 1} did not arrive`);
    return hers[index]!;
  };

  await client.prompt(alu.id, "记住：周末爬山我要带水壶。", "auto", "alu-remember");
  (await reply(0)).tools({ id: "remember", name: "assistant_memory", arguments: { action: "add", topic: "events", text: "主人周末爬山要带水壶。", resident: true } });
  (await reply(1)).text("记下了。");
  await settled(client, alu.id);
  const memory = (await client.assistantMemories()).memories.find((item) => item.text.includes("水壶"));
  // Older forgets with larger IDs occupy the entire first page. The relevant memory will be on the next page.
  for (let n = 0; n < 50; n++) {
    const other = await client.addAssistantMemory({ topic: "events", text: `旧资料 ${n}`, resident: false });
    await client.updateAssistantMemory({ id: other.id, revision: other.revision, state: "forgotten" });
  }
  await client.prompt(alu.id, `这是我贴的资料：${LONG_PASTE}`, "auto", "alu-paste");
  (await reply(2)).text("收到。");
  await settled(client, alu.id);
  await waitFor(async () => (await records(client, alu.id)).some((record) => JSON.stringify(record.content).includes("她要提醒他带水壶")), "The hand-over record did not take its place");

  await client.prompt(alu.id, "把爬山带水壶那件事忘掉吧。", "auto", "alu-forget");
  const beforeForget = await reply(3);
  assert.ok(system(beforeForget).includes("青栀") && system(beforeForget).includes("水壶"), "Both resident facts have entered the cached opening");
  beforeForget.tools({ id: "forget", name: "assistant_memory", arguments: { action: "forget", id: memory!.id } });
  (await reply(4)).text("好，忘了。");
  await settled(client, alu.id);
  // The record written before tells it: the model is asked to take it out.
  await waitFor(() => rewrites.length >= 1, "The record was not submitted for rewriting");
  await client.prompt(alu.id, "在吗？", "auto", "retry-forget");
  (await reply(5)).text("在。");
  await settled(client, alu.id);
  await waitFor(() => rewrites.length >= 2, "The failed rewrite was not retried on the next turn with the same forgotten entries");
  assert.ok(rewrites[1]!.includes("主人周末爬山要带水壶。") && rewrites[1]!.includes("她要提醒他带水壶") && !rewrites[1]!.includes("旧资料"));
  await waitFor(async () => (await records(client, alu.id)).some((record) => JSON.stringify(record.content).includes("没有还没了结的事。")), "The rewritten record did not take its place");

  await client.updateAssistantMemory({ id: resident.id, revision: resident.revision, state: "forgotten" });
  await client.prompt(alu.id, "周末我要带什么来着？", "auto", "alu-ask");
  const asked = await reply(6);
  assert.ok(!given(asked).includes("水壶") && !given(asked).includes("青栀"), `Nothing she is given still tells it: ${given(asked).replace(/lorem ipsum dolor sit amet /gu, "").slice(-1_500)}`);
  asked.text("不记得了。");
  await settled(client, alu.id);
});
