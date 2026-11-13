import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { DockClient } from "../src/control/dock-client.js";
import { MAX_REPLY_STEPS } from "../src/assistant-agent/assistant-agent.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
/** Everything the model was given in this request, as one text. */
const given = (request: HeldChatRequest) => JSON.stringify(request.body.messages);

// Card #667: she does not work with her own hands. She hands work to child Works and stays free to
// talk; what they send wakes her. Only provider HTTP replies are scripted; the Host, her Worker and
// the child Work's Pi Worker are real.
test("the assistant hands work to a child Work, answers her owner while it works, is woken by its result, and by her own reminder", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer"], { prefix: "alu-assistant-works-", assistant: true });
  const { coordinator, implementer } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();

  // Her owner asks for something that needs hands; she hands it to a child Work.
  await client.prompt(alu.id, "帮我看看这个目录的 README 写了什么。", "auto", "alu-readme");
  const asked = await coordinator.request(0);
  assert.ok(given(asked).includes("叫醒你的：主人的消息"), "Each reply starts with what woke her");
  asked.tools({ id: "spawn", name: "dock_spawn", arguments: { name: "读 README", task: "读当前目录的 README.md，用两三句话告诉我它写了什么。", model: { provider: "implementer", id: "fixture" } } });
  const childStarted = await implementer.request(0);
  // The child Work sees only its task; her owner's words go with it as he said them.
  assert.ok(given(childStarted).includes("读当前目录的 README.md") && given(childStarted).includes("> 帮我看看这个目录的 README 写了什么。"), "The task carries the owner's own words");
  (await coordinator.request(1)).text("派了个 Work 去读，等它回话。");
  await settled(client, alu.id);
  const child = (await client.list()).find((work) => work.parentId === alu.id);
  assert.ok(child, "The Work she handed it to is her child Work");

  // The child Work is still on its first request. She answers her owner at once, and already knows what it is doing.
  await client.prompt(alu.id, "在干嘛呢？", "auto", "alu-status");
  const status = await coordinator.request(2);
  assert.ok(given(status).includes("子 Work「读 README」在干活"), `Her status says what the child Work is doing: ${given(status).slice(-600)}`);
  // Review regression: taking back the owner's input must not throw away child messages received
  // while the model is held. Stop keeps them too, but does not start another reply on their account.
  childStarted.tools({ id: "progress", name: "dock_send", arguments: { message: "README 已经找到。", done: false } });
  const reading = await implementer.request(1);
  await client.prompt(alu.id, "这句先取回", "auto", "alu-take-input");
  const taken = await client.dequeue(alu.id, "alu-take");
  assert.deepEqual(taken.receipt.restored.map((item) => item.text), ["这句先取回"]);
  reading.tools({ id: "more-progress", name: "dock_send", arguments: { message: "README 正在核对。", done: false } });
  const reporting = await implementer.request(2);
  await client.prompt(alu.id, "这句也先取回", "auto", "alu-stop-input");
  const stopped = await client.abortRestoreQueue(alu.id, "alu-stop-reply");
  assert.deepEqual(stopped.receipt.restored.map((item) => item.text), ["这句也先取回"]);
  await waitFor(async () => (await client.status(alu.id)).lastRun === "aborted", "Stop did not end her reply");

  await client.prompt(alu.id, "子 Work 刚才说了什么？", "auto", "alu-after-stop");
  const afterStop = await coordinator.request(3);
  assert.ok(given(afterStop).includes("子 Work 刚才说了什么？"), "Only the owner's next message starts another reply");
  for (const text of ["README 已经找到。", "README 正在核对。"]) {
    assert.ok(given(afterStop).includes(text), "The next reply still sees what the child Work sent");
    const messages = (await client.history(alu.id)).entries.filter((entry) => entry.customType === "dock-work-message" && JSON.stringify(entry.content).includes(text));
    assert.equal(messages.length, 1, "Each child message is kept once, outside the owner's drafts");
  }
  afterStop.text("那个 Work 找到了 README，还在核对。");
  await settled(client, alu.id);

  // The child Work's result wakes her, marked as that Work's words.
  reporting.tools({ id: "report", name: "dock_send", arguments: { message: "README 说这是一个测试目录。", done: true } });
  const woken = await coordinator.request(4);
  assert.ok(given(woken).includes("[来自子 Work「读 README」· 已完成]\\nREADME 说这是一个测试目录。"), "The result reaches her as the child Work's message");
  assert.ok(given(woken).includes("叫醒你的：子 Work「读 README」交来的结果"));
  woken.text("README 说这是一个测试目录。");
  await settled(client, alu.id);
  const shown = (await client.history(alu.id)).entries.filter((entry) => entry.visibility === "conversation");
  assert.ok(shown.some((entry) => entry.customType === "dock-work-message"), "Clients show the child Work's message in her conversation");
  assert.ok(!shown.some((entry) => JSON.stringify(entry.content).includes("[现状")), "Her status notes are not part of the conversation clients show");

  // A reminder she sets wakes her when it comes due, with nobody talking to her.
  await client.prompt(alu.id, "两秒后提醒我喝水。", "auto", "alu-remind");
  (await coordinator.request(5)).tools({ id: "remind", name: "assistant_remind", arguments: { action: "set", at: new Date(Date.now() + 2_000).toISOString(), text: "提醒主人喝水" } });
  (await coordinator.request(6)).text("两秒后叫你。");
  await settled(client, alu.id);
  const due = await coordinator.request(7);
  assert.ok(given(due).includes("提醒主人喝水") && given(due).includes("叫醒你的：你定的提醒"), "The reminder starts a reply of hers");
  due.text("喝水啦。");
  await settled(client, alu.id);

  // Stopping her stops the Work she handed things to.
  await client.stop(alu.id, "alu-stop");
  await waitFor(async () => !(await client.list()).some((work) => work.id === child.id), "Her child Work outlived her");
});

// Seen in the official client against a real Host (card #667): her Work showed "Dock Tools OFF"
// and offered no switch while she was handing work to child Works.
test("her Dock tools show as on, and her owner can switch them off and on like any Work's", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-switch-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();
  const shown = async () => (await client.status(alu.id)).extensionStatus["Dock tools"];
  await waitFor(async () => await shown() === "on", "Her Dock tools did not show as on");
  assert.ok((await client.commands(alu.id)).commands.some((command) => command.name === "dock-tools"), "Clients find her switch where every Work has it");

  await client.prompt(alu.id, "/dock-tools off", "auto", "alu-off");
  await waitFor(async () => await shown() === undefined, "Her Dock tools still show as on");
  await client.prompt(alu.id, "帮我跑一下测试。", "auto", "alu-ask");
  const asked = await coordinator.request(0);
  assert.ok(!given(asked).includes("/dock-tools off"), "The switch is not something said to her");
  assert.ok(given(asked).includes("你的 Dock tools 现在关着"), "She is told she cannot hand work to anyone now");
  asked.text("我的 Dock tools 关着，派不了 Work。");
  await settled(client, alu.id);

  await client.prompt(alu.id, "/dock-tools on", "auto", "alu-on");
  await waitFor(async () => await shown() === "on", "Her Dock tools did not come back on");
});

// Incident this guards against (the Minecraft companion this design follows, on its live server): a
// long reply ran out of steps after the work was done, and the person who asked never heard back.
test("a reply of hers that runs out of steps still ends with a word to her owner", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-steps-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();
  await client.prompt(alu.id, "把所有 Work 挨个看一遍。", "auto", "alu-busy");
  for (let step = 0; step < MAX_REPLY_STEPS; step += 1) {
    (await coordinator.request(step)).tools({ id: `list-${step}`, name: "dock_list", arguments: {} });
  }
  const last = await coordinator.request(MAX_REPLY_STEPS);
  assert.ok(given(last).includes("[步数上限]"), "At the limit she is told this is her last step");
  // In that step only a message to another Work still goes out.
  last.tools({ id: "one-more", name: "dock_list", arguments: {} });
  await settled(client, alu.id);
  assert.equal(coordinator.requests.length, MAX_REPLY_STEPS + 1, "The reply ends after its last step");
  const results = (await client.history(alu.id)).entries.filter((entry) => entry.toolCallId === "one-more" && entry.source === "tool");
  assert.ok(JSON.stringify(results).includes("这一轮已到步数上限，这个调用没有执行。"), "A call in the last step that is not a message to a Work is not run");
});

// Card #667: a child Work never outlives its parent's Worker, so after her Work is opened again she
// is told which ones are gone instead of waiting for results that will not come.
test("after her Work is opened again she knows which child Works are gone", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer"], { prefix: "alu-assistant-lost-", assistant: true });
  const { coordinator, implementer } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();
  await client.prompt(alu.id, "跑一下测试。", "auto", "alu-tests");
  (await coordinator.request(0)).tools({ id: "spawn", name: "dock_spawn", arguments: { name: "跑测试", task: "运行测试并报告结果。", model: { provider: "implementer", id: "fixture" } } });
  await implementer.request(0);
  (await coordinator.request(1)).text("派出去了。");
  await settled(client, alu.id);

  process.kill(team.workerPids[0]!, "SIGKILL");
  await waitFor(async () => (await client.status(alu.id)).lifecycle === "runtime_error", "The crash was not observed");
  await team.assistantWork();
  await client.prompt(alu.id, "测试跑完了吗？", "auto", "alu-back");
  const back = await coordinator.request(2);
  assert.ok(given(back).includes("已经不在了") && given(back).includes("「跑测试」"), `She is told the child Work is gone: ${given(back).slice(-500)}`);
  back.text("那个 Work 没了，要重新派吗？");
  await settled(client, alu.id);
});

// Card #667 replaced the Pi Work that used to be the assistant. A conversation it left behind, with
// Pi's own prompt records and file tools in it, opens as hers and goes on.
test("a conversation from when the assistant was a Pi Work opens as hers and goes on", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-old-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();
  await client.prompt(alu.id, "你好", "auto", "alu-hello");
  (await coordinator.request(0)).text("你好呀。");
  await settled(client, alu.id);

  const old = SessionManager.create(team.cwd, join(team.root, "sessions"));
  old.appendModelChange("coordinator", "fixture");
  old.appendMessage({ role: "system", content: "You are an expert coding assistant.", timestamp: 1 });
  old.appendMessage({ role: "user", content: "看看有哪些文件", timestamp: 2 });
  old.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ls-1", name: "bash", arguments: { command: "ls" } }], api: "openai-completions", provider: "coordinator", model: "fixture", stopReason: "toolUse", timestamp: 3, usage: ZERO_USAGE });
  old.appendMessage({ role: "toolResult", toolCallId: "ls-1", toolName: "bash", content: [{ type: "text", text: "README.md" }], isError: false, timestamp: 4 });
  old.appendMessage({ role: "assistant", content: [{ type: "text", text: "只有一个 README.md。" }], api: "openai-completions", provider: "coordinator", model: "fixture", stopReason: "stop", timestamp: 5, usage: ZERO_USAGE });

  // This fixture supplies the older Pi conversation, rather than waiting for automatic recovery.
  await team.registry!.stopAssistantRecovery();
  process.kill(team.workerPids[0]!, "SIGKILL");
  await waitFor(async () => (await client.status(alu.id)).lifecycle === "runtime_error", "The crash was not observed");
  await client.reopen(alu.id, "alu-reopen-old", old.getSessionFile());
  assert.ok((await client.history(alu.id)).entries.some((entry) => JSON.stringify(entry.content).includes("只有一个 README.md。")), "The old conversation is shown");
  await client.prompt(alu.id, "刚才看到了什么文件？", "auto", "alu-old");
  const asked = await coordinator.request(1);
  const system = (asked.body.messages ?? []).filter((message) => message.role === "system" || message.role === "developer").map((message) => JSON.stringify(message.content)).join("\n");
  assert.ok(system.includes("你是**阿露**") && !system.includes("You are an expert coding assistant."), "Her opening leads the request in place of the old prompt");
  assert.ok(given(asked).includes("只有一个 README.md。"), "She has the old conversation");
  asked.text("README.md。");
  await settled(client, alu.id);
});
