import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { WorkMessage } from "../src/core/dock-tools.js";
import type { DockClient } from "../src/control/dock-client.js";
import { exited, startNativeTeam, trustOnce } from "./support/native-team.js";
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

// Card #674: she does no work herself, so the child Work she hands work to is the one that does it. It
// used to be a helper that could hand nothing out: every implementer and reviewer had to go through her.
// It now hands parts out itself, and they report to it; she hears from it alone.
test("the assistant's child Work hands parts of its task to child Works of its own, which report to it, not to her", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer", "reviewer"], { prefix: "alu-assistant-lead-", assistant: true });
  const { coordinator, implementer, reviewer } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();

  // Without createDirectory, a directory that does not exist yet fails, saying how to have Dock create it.
  const newDirectory = join(team.cwd, "新目录", "修 sum");
  await assert.rejects(team.registry!.invokeDockTool(alu.id, { type: "spawn", operationId: "missing-directory", name: "x", task: "x", cwd: newDirectory }), /start the child Work again with createDirectory=true/u);
  await client.prompt(alu.id, "把 sum.js 修好，找人独立审查一下。", "auto", "lead-start");
  // She hands it out in a directory that does not exist yet: Dock creates it, and the Work starts trusted there.
  (await coordinator.request(0)).tools({ id: "spawn-lead", name: "dock_spawn", arguments: { name: "修 sum", task: "修好 sum.js，并找人独立审查。", cwd: newDirectory, createDirectory: true, model: { provider: "implementer", id: "fixture" } } });
  const leadStarted = await implementer.request(0);
  (await coordinator.request(1)).text("派出去了。");
  await settled(client, alu.id);
  const lead = (await client.list()).find((work) => work.parentId === alu.id)!;
  assert.equal(lead.cwd, await realpath(newDirectory));
  // It may start and manage child Works of its own, and reaches no other Work.
  const workTools = (names: string[]) => names.filter((name) => name.startsWith("dock_") && !name.startsWith("dock_attachment_")).sort();
  assert.deepEqual(workTools(leadStarted.toolNames), ["dock_inspect", "dock_interrupt", "dock_list", "dock_models", "dock_send", "dock_spawn", "dock_stop", "dock_wait"]);

  leadStarted.tools({ id: "spawn-reviewer", name: "dock_spawn", arguments: { name: "审查", task: "独立审查 sum.js。", model: { provider: "reviewer", id: "fixture" } } });
  const reviewStarted = await reviewer.request(0);
  const review = (await client.list()).find((work) => work.parentId === lead.id)!;
  // Under a Work that does the work itself it is a helper: with every tool, it still starts no Work.
  assert.deepEqual(workTools(reviewStarted.toolNames), ["dock_send"]);
  await assert.rejects(team.registry!.invokeDockTool(review.id, { type: "spawn", operationId: "deeper", name: "更深", task: "再派一层。" }));
  (await implementer.request(1)).tools({ id: "wait-review", name: "dock_wait", arguments: {} });

  // The reviewer's question ends the lead's wait; the lead answers it and waits again.
  reviewStarted.tools({ id: "ask", name: "dock_send", arguments: { message: "REVIEW_QUESTION: 测试也要看吗？", done: false } });
  const asked = await implementer.request(2);
  assert.ok(given(asked).includes("REVIEW_QUESTION"), "The reviewer's question comes back as the wait's result");
  asked.tools({ id: "answer", name: "dock_send", arguments: { target: "审查", message: "LEAD_ANSWER: 只看 sum.js。" } });
  (await implementer.request(3)).tools({ id: "wait-again", name: "dock_wait", arguments: {} });
  (await reviewer.request(1)).text("等回答。");
  const answered = await reviewer.request(2);
  assert.ok(given(answered).includes("[来自父 Work「修 sum」]\\nLEAD_ANSWER"), "The reviewer hears from the lead, its parent");

  // Her message ends the lead's wait as well, instead of waiting until the wait is over.
  await client.prompt(alu.id, "问问它进度。", "auto", "lead-check");
  (await coordinator.request(2)).tools({ id: "check", name: "dock_send", arguments: { target: "修 sum", message: "PARENT_CHECK: 进度如何？" } });
  const checked = await implementer.request(4);
  assert.ok(given(checked).includes("Stopped waiting because a message reached you") && given(checked).includes("[来自父 Work「alu」]\\nPARENT_CHECK"));
  // She sees the reviewer under its lead, and is told to go through the lead to stop it.
  (await coordinator.request(3)).tools({ id: "her-list", name: "dock_list", arguments: {} }, { id: "her-stop", name: "dock_stop", arguments: { target: "审查" } });
  const overseen = await coordinator.request(4);
  assert.ok(given(overseen).includes(`\\n  - 审查 id=${review.id} · active/`), `The reviewer is listed under its lead: ${given(overseen)}`);
  assert.ok(given(overseen).includes("is a child Work of your child Work \\\"修 sum\\\", and only \\\"修 sum\\\" controls it"), "She is told whom to go through");
  overseen.text("问了。");
  await settled(client, alu.id);
  checked.tools({ id: "progress", name: "dock_send", arguments: { message: "LEAD_PROGRESS: 审查还在进行。", done: false } });
  assert.ok(given(await coordinator.request(5)).includes("[来自子 Work「修 sum」]\\nLEAD_PROGRESS"));
  coordinator.requests[5]!.text("收到。");
  (await implementer.request(5)).text("继续等审查。");
  await settled(client, lead.id);
  await settled(client, alu.id);

  // The reviewer's note wakes the lead: what its own child Works send is part of the work it owes her.
  // It sees its own child Works only. Its last call does not reach her, and it ends its turn while its
  // reviewer still works: that is no stop without a result.
  answered.tools({ id: "review-note", name: "dock_send", arguments: { message: "REVIEW_NOTE: 还在核对边界。", done: false } });
  const noted = await implementer.request(6);
  assert.ok(given(noted).includes("[来自子 Work「审查」]\\nREVIEW_NOTE"));
  noted.tools({ id: "list", name: "dock_list", arguments: {} });
  const listed = await implementer.request(7);
  const listText = JSON.stringify(listed.body.messages?.at(-1));
  assert.ok(listText.includes(review.id) && !listText.includes(alu.id), `The lead lists its own child Work only: ${listText}`);
  listed.text("继续等审查。");
  await settled(client, lead.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(coordinator.requests.length, 6, "She is not told the lead stopped while its reviewer works");

  // The reviewer's result wakes the lead. The result it owes her is still owed: ending this turn without
  // it tells her, quoting what it said last.
  const reviewing = await reviewer.request(3);
  reviewing.tools({ id: "review-done", name: "dock_send", arguments: { message: "REVIEW_DONE: 没问题。", done: true } });
  const reviewed = await implementer.request(8);
  assert.ok(given(reviewed).includes("[来自子 Work「审查」· 已完成]\\nREVIEW_DONE"));
  reviewed.text("LEAD_LAST: 审查通过了。");
  const told = await coordinator.request(6);
  assert.ok(given(told).includes("[子 Work「修 sum」异常停止]") && given(told).includes("> LEAD_LAST: 审查通过了。"), "She hears the lead stopped without its result");
  told.tools({ id: "ask-result", name: "dock_send", arguments: { target: "修 sum", message: "PARENT_ASK: 把结果发给我。" } });
  (await coordinator.request(7)).text("等它的结果。");
  await settled(client, alu.id);
  const asking = await implementer.request(9);
  assert.ok(given(asking).includes("PARENT_ASK"));
  asking.tools({ id: "result", name: "dock_send", arguments: { message: "LEAD_RESULT: 修好并通过了独立审查。", done: true } });
  const result = await coordinator.request(8);
  assert.ok(given(result).includes("[来自子 Work「修 sum」· 已完成]\\nLEAD_RESULT"));
  result.text("修好了，也审查过了。");
  await settled(client, alu.id);
  // What the reviewer said went to the lead only.
  assert.ok(!coordinator.requests.some((request) => ["REVIEW_QUESTION", "REVIEW_NOTE", "REVIEW_DONE"].some((words) => given(request).includes(words))), "The reviewer's words never reach her");
  // Its result answered her latest message, so stopping it now owes her no notice.
  await client.stop(lead.id, "lead-stop");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(coordinator.requests.length, 9, "Stopping a Work that gave her its result tells her nothing");

  // A child Work she grants no dock_spawn, such as a reviewer, starts none. A lead's child Work gets no tool the lead was not given.
  const readOnly = await client.create(team.cwd, "只读审查", "read-only", undefined, undefined, { model: { provider: "reviewer", id: "fixture" } }, { parentId: alu.id, allowedTools: ["read"] });
  await assert.rejects(team.registry!.invokeDockTool(readOnly.id, { type: "spawn", operationId: "read-only-spawn", name: "x", task: "x" }));
  const limited = await client.create(team.cwd, "只读主 Work", "limited-lead", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: alu.id, allowedTools: ["read", "dock_spawn"] });
  await assert.rejects(client.create(team.cwd, "要 shell", "wants-bash", undefined, undefined, { model: { provider: "reviewer", id: "fixture" } }, { parentId: limited.id, allowedTools: ["read", "bash"] }), /bash/u);
  const inherits = await client.create(team.cwd, "沿用上限", "inherits", undefined, undefined, { model: { provider: "reviewer", id: "fixture" } }, { parentId: limited.id });
  assert.deepEqual((await client.tools(inherits.id)).tools.filter((tool) => tool.active).map((tool) => tool.name).sort(), ["dock_send", "read"], "Leaving out allowedTools keeps the lead's limit");

  // Stopping her stops the whole tree below her: every process has exited when her Stop returns.
  const below = [...team.workerPids];
  await client.stop(alu.id, "alu-stop");
  assert.deepEqual(below.filter((pid) => !exited(pid)), [], "A Work below her outlived her Stop");
  assert.ok(!(await client.list()).some((work) => [lead.id, review.id, readOnly.id, limited.id, inherits.id].includes(work.id)));
});

// Card #674 review (Astra): a lead left the Host's list of running Works before its own child Works were
// gone. Stopping the assistant meanwhile could not find them, and returned while a grandchild still ran.
test("stopping the assistant while her child Work is stopping still waits for that Work's own child", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer"], { prefix: "alu-assistant-tree-stop-", assistant: true });
  const client = await team.startHost();
  const alu = await team.assistantWork();
  const lead = await client.create(team.cwd, "主 Work", "tree-lead", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: alu.id });
  const leadPid = team.workerPids.at(-1)!;
  let held = false;
  let release!: () => void;
  team.holdNextChild = () => new Promise<void>((resolve) => { held = true; release = resolve; });
  // A failure while it is held must not hold the Host's own Stop at cleanup.
  team.onCleanup = () => release?.();
  const late = client.create(team.cwd, "还在启动", "tree-late", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: lead.id });
  void late.catch(() => {});
  await waitFor(() => held, "The grandchild did not start");
  const latePid = team.workerPids.at(-1)!;
  const leadStopping = client.stop(lead.id, "stop-lead");
  // The lead itself has stopped; only its child still holds its Stop open.
  await waitFor(async () => exited(leadPid) && !(await client.list()).some((work) => work.id === lead.id), "The lead did not stop");
  // Her Stop also opens her again, which takes a while, so the grandchild is let go well after that.
  const letGo = setTimeout(release, 5_000);
  await client.stop(alu.id, "stop-her");
  const lateGone = exited(latePid);
  clearTimeout(letGo);
  release();
  assert.ok(lateGone, "Her Stop returns only once the grandchild still starting has exited");
  await leadStopping;
  await assert.rejects(late);

  // The same through the other way a Work leaves the list: the owner removes a lead that crashed while its
  // child was still starting.
  const reopened = await team.assistantWork();
  const crashing = await client.create(team.cwd, "会崩的主 Work", "tree-crash", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: reopened.id });
  const crashingPid = team.workerPids.at(-1)!;
  held = false;
  team.holdNextChild = () => new Promise<void>((resolve) => { held = true; release = resolve; });
  const stranded = client.create(team.cwd, "也还在启动", "tree-stranded", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: crashing.id });
  void stranded.catch(() => {});
  await waitFor(() => held, "The second grandchild did not start");
  const strandedPid = team.workerPids.at(-1)!;
  // #681: her Worker can acknowledge the crash notice after the owner removes the crashed Work.
  // Hold that acknowledgement only; she receives the notice through her real Worker.
  const parent = team.registry!.get(reopened.id), deliver = parent.deliverWorkMessage.bind(parent);
  let arrived = false, acknowledge!: () => void;
  const heldAck = new Promise<void>(resolve => { acknowledge = resolve; });
  team.onCleanup = () => { acknowledge(); release?.(); };
  context.mock.method(parent, "deliverWorkMessage", async (message: WorkMessage) => {
    await deliver(message);
    if (message.type === "child_stopped" && message.from.id === crashing.id) {
      arrived = true;
      await heldAck;
    }
  });
  // A child that has merely been created owes no result. Give it real work before killing its Worker.
  await team.registry!.invokeDockTool(reopened.id, { type: "send", operationId: "ask-crashing-lead", target: crashing.id, message: "Report on the review." });
  await team.providers.implementer.request(0);
  process.kill(crashingPid, "SIGKILL");
  await waitFor(async () => (await client.status(crashing.id)).lifecycle === "runtime_error", "The lead's crash was not observed");
  await waitFor(() => arrived, "The assistant did not receive the crash notice");
  await client.forget(crashing.id, "forget-crashed");
  acknowledge();
  // She hands the work to a new Work of the same name while the removed one waits for its child: by name, she
  // reaches the new one only.
  const again = await client.create(team.cwd, "会崩的主 Work", "tree-again", undefined, undefined, { model: { provider: "implementer", id: "fixture" } }, { parentId: reopened.id });
  const reached = await team.registry!.invokeDockTool(reopened.id, { type: "interrupt", operationId: "interrupt-by-name", target: "会崩的主 Work" });
  assert.ok(reached.type === "interrupt" && reached.instance.id === again.id);
  const letGoAgain = setTimeout(release, 5_000);
  await client.stop(reopened.id, "stop-her-again");
  const strandedGone = exited(strandedPid);
  clearTimeout(letGoAgain);
  release();
  assert.ok(strandedGone, "Removing the crashed lead does not let her Stop skip its child");
  await assert.rejects(stranded);
});

test("the owner's steer and follow-up during a reply each renew the Work wake budget", { timeout: 90_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator", "implementer"], { prefix: "alu-owner-wake-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const { coordinator, implementer } = team.providers;
  const { handoff } = await client.assistantSettings();
  await client.setAssistantSettings({ handoff: { ...handoff!, startTokens: 100_000 } });
  await client.prompt(assistant.id, "派个 Work 跟我汇报进度", "auto", "start-progress");
  (await coordinator.request(0)).tools({ id: "spawn", name: "dock_spawn", arguments: { name: "汇报进度", task: "持续报告进度。", model: { provider: "implementer", id: "fixture" } } });
  (await coordinator.request(1)).text("派好了。");
  await settled(client, assistant.id);
  let reply = 2;
  for (let report = 1; report <= 25; report++) {
    (await implementer.request(report - 1)).tools({ id: `progress-${report}`, name: "dock_send", arguments: { done: report === 25, message: `第 ${report} 份进度` } });
    const working = await coordinator.request(reply++);
    if (report === 12 || report === 24) {
      const mode = report === 12 ? "steer" : "followUp";
      const words = `回复中主人的 ${mode} 插话`;
      await client.prompt(assistant.id, words, mode, `owner-${mode}`);
      working.text("进度收到。");
      const inserted = await coordinator.request(reply++);
      assert.ok(given(inserted).includes(words));
      inserted.text("主人的消息也收到了。");
    } else working.text("收到。");
    await settled(client, assistant.id);
  }
});

test("her next status stops following an ordinary Work after cancelling a watch and after it fires", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-watch-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const target = await trustOnce(trust => client.create(team.cwd, "被观察的工作", "watched", trust));
  const provider = team.providers.coordinator;
  await client.prompt(target.id, "开始工作", "auto", "busy-target");
  const busy = await provider.request(0);
  await client.prompt(assistant.id, "留意那个工作", "auto", "watch-target");
  (await provider.request(1)).tools({ id: "watch1", name: "dock_watch", arguments: { target: target.id } });
  (await provider.request(2)).text("正在留意。");
  await settled(client, assistant.id);
  const latestStatus = (request: HeldChatRequest) => JSON.stringify(request.body.messages?.findLast(message => JSON.stringify(message.content).includes("这是 Dock 自动附上的"))?.content);
  await client.prompt(assistant.id, "不盯了", "auto", "cancel-target");
  const cancel = await provider.request(3);
  assert.ok(latestStatus(cancel).includes("- Work「被观察的工作」"));
  cancel.tools({ id: "cancel", name: "dock_cancel_watch", arguments: {} });
  (await provider.request(4)).text("不盯了。");
  await settled(client, assistant.id);
  await client.prompt(assistant.id, "再盯一次", "auto", "watch-again");
  const again = await provider.request(5);
  assert.ok(!latestStatus(again).includes("- Work「被观察的工作」"), "Cancelled watch still follows its target");
  again.tools({ id: "watch2", name: "dock_watch", arguments: { target: target.id } });
  (await provider.request(6)).text("好的。");
  await settled(client, assistant.id);
  busy.text("做完了。");
  const fired = await provider.request(7);
  assert.ok(!latestStatus(fired).includes("- Work「被观察的工作」"), "Fired watch still follows its target");
  fired.text("收到了。");
  await settled(client, assistant.id);
});

test("an impossible local reminder date is rejected with the original date", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-reminder-date-", assistant: true });
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  await client.prompt(assistant.id, "安排一个提醒", "auto", "impossible-date");
  (await team.providers.coordinator.request(0)).tools({ id: "invalid", name: "assistant_remind", arguments: { action: "set", at: "2099-02-31 08:00", text: "提醒我" } });
  const next = await team.providers.coordinator.request(1);
  assert.ok(given(next).includes("没有这个日期：2099-02-31 08:00"), "The impossible date was accepted rather than explained");
  next.text("二月没有三十一日，请换一天。");
  await settled(client, assistant.id);
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

// The private assistant used to block the 21st tool step, even during an owner's ordinary review.
test("the assistant reads the last of 21 reports and answers without a second prompt", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-steps-", assistant: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const alu = await team.assistantWork();
  for (let n = 1; n <= 21; n++) await writeFile(join(alu.cwd, `report-${n}.txt`), n === 21 ? "FINAL_REPORT: valve inspected" : `Report ${n} checked`);
  await client.prompt(alu.id, "依次读完这 21 份报告，再告诉我最后一份的结论。", "auto", "review-reports");
  for (let n = 1; n <= 21; n++) {
    const request = await coordinator.request(n - 1);
    request.tools({ id: `read-${n}`, name: "read", arguments: { path: `report-${n}.txt` } });
  }
  const readLast = () => client.history(alu.id).then(history => history.entries.find(entry => entry.source === "tool" && entry.toolCallId === "read-21"));
  await waitFor(async () => !!await readLast(), "The last read did not finish");
  assert.match(JSON.stringify((await readLast())?.content), /FINAL_REPORT: valve inspected/);
  const finalRequest = await coordinator.request(21);
  assert.ok(!given(finalRequest).includes("[步数上限]"));
  finalRequest.text("最后一份报告确认阀门已检查。");
  await settled(client, alu.id);
  assert.ok((await client.history(alu.id)).entries.some(entry => entry.source === "assistant" && entry.visibility === "conversation" && JSON.stringify(entry.content).includes("最后一份报告确认阀门已检查。")));
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
  old.appendCustomEntry("assistant-handoff-result", "旧版内部整理结果");
  old.appendCustomMessageEntry("assistant-dock-note", "[步数上限] 这是最后一步。", false);
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
  assert.ok(!given(asked).includes("旧版内部整理结果"));
  assert.ok((await client.history(alu.id)).entries.filter(entry => entry.customType === "assistant-handoff-result").every(entry => entry.visibility === "metadata"));
  assert.ok(!given(asked).includes("[步数上限]"), "A persisted internal closing instruction no longer tells her to stop");
  asked.text("README.md。");
  await settled(client, alu.id);

  // A reminder already due when Main starts tells the owner how late it is, not why.
  client.closeActiveConnections();
  await team.host!.stop();
  const reopened = SessionManager.open(old.getSessionFile()!);
  const overdue = new Date(Date.now() - 8 * 60_000).toISOString();
  reopened.appendCustomEntry("assistant-reminders", { reminders: [{ id: "restored", at: overdue, createdAt: overdue, text: "继续看看文件。" }] });
  const restarted = await team.startHost();
  const late = await coordinator.request(2);
  assert.match(given(late), /（晚了 \d+ 分钟）\]/u);
  late.text("该看看文件了。");
  await settled(restarted, alu.id);
});
