import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// 2026-11-17 regression: switching a large conversation to a smaller model made
// the first message silently wait for SDK pre-prompt compaction, then time out.
// Hold only the real summarization HTTP reply, never manufacture compaction events.
test("the first message after switching to a smaller model shows compaction and starts once without a false timeout", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["preprompt"], {
    prefix: "alu-preprompt-compaction-", thinkingLevel: "off",
    settings: { compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 } },
  });
  const provider = team.providers.preprompt;
  const modelsPath = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  const model = models.providers.preprompt.models[0];
  model.contextWindow = 128_000;
  models.providers.preprompt.models.push({ ...model, id: "small", name: "Small window", contextWindow: 12_000 });
  await writeFile(modelsPath, JSON.stringify(models));
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Large conversation", "preprompt", trust));
  assert.equal(team.workerPids.length, 1);
  assert.notEqual(team.workerPids[0], process.pid, "Pi runs in an independent Worker");

  // Build context through the real user entry, not a fake session/event stream.
  await client.prompt(work.id, "Saved local context.\n".repeat(4_000), "auto", "large-window-message");
  (await provider.request(0)).text("The earlier context has been read.");
  await waitFor(async () => (await client.status(work.id)).execution === "idle", "The large-window turn did not finish");
  const switched = await client.setModel(work.id, "preprompt", "small", "switch-to-small-window");
  assert.equal(switched.instance.executor.model?.id, "small");
  assert.equal(provider.requests.length, 1, "Switching models does not itself send a model request");

  const events: DockEvent[] = [];
  const began = Date.now();
  let compactionStartedAt: number | undefined;
  const recordEvent = (event: DockEvent) => {
    events.push(event);
    if (event.type === "compaction.started") compactionStartedAt ??= Date.now();
    if (["compaction.started", "compaction.completed", "run.started", "run.settled", "message.submitted"].includes(event.type)) {
      context.diagnostic(JSON.stringify({ elapsedMs: Date.now() - began, type: event.type,
        ...(event.type === "message.submitted" ? { operationId: event.data.operationId } : { data: event.data }) }));
    }
  };
  const follow = await client.streamEvents(work.id, { onEvent: recordEvent, conversationBootstrap: true, requireTuiProjection: true });
  context.after(() => follow.close());
  const submitter = new DockClient({ socketPath: join(team.root, "dock.sock"), timeoutMs: 1_000, longMutationTimeoutMs: 10_000 });
  context.after(() => submitter.closeActiveConnections());
  const message = "FIRST_AFTER_SWITCH: continue from the saved context.";
  const operationId = "first-message-after-switch";
  let receiptState = "pending";
  const submitted = submitter.prompt(work.id, message, "auto", operationId).then(
    (result) => { receiptState = "accepted"; context.diagnostic(JSON.stringify({ phase: "submission-result", elapsedMs: Date.now() - began, receipt: receiptState })); return result; },
    (error: unknown) => { receiptState = error instanceof ControlClientError ? error.code : String(error); context.diagnostic(JSON.stringify({ phase: "submission-result", elapsedMs: Date.now() - began, receipt: receiptState })); return undefined; },
  );
  const summary = await provider.request(1);
  assert.equal(summary.toolNames.length, 0, "The SDK asks for a summary before sending the new prompt");
  assert.match(JSON.stringify(summary.body.messages?.[0]), /context summarization assistant/);
  const summaryEntered = Date.now();
  // Stay beyond the ordinary query deadline, but below the long mutation wait.
  // This uses only DockClient's existing test options, not production time limits.
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const heldStatus = await client.status(work.id);
  const heldListed = (await client.list()).find((item) => item.id === work.id)!;
  // STORY requires feedback within one second; the summary transport proves Pi is busy.
  const liveStarted = compactionStartedAt !== undefined && compactionStartedAt - summaryEntered <= 1_000;
  const heldReceiptState = receiptState;
  const prematureRun = events.some((event) => event.type === "run.started");
  // A fresh observer must learn about the same ongoing work, without the sender.
  follow.close(); await follow.done;
  const reconnect = await client.streamEvents(work.id, { onEvent: recordEvent, conversationBootstrap: true, requireTuiProjection: true });
  context.after(() => reconnect.close());
  const held = {
    status: { execution: heldStatus.execution, compacting: heldStatus.compacting },
    list: { execution: heldListed.execution, compacting: heldListed.compacting },
    reconnect: { execution: reconnect.initial.instance.execution, compacting: reconnect.initial.instance.compacting },
    liveStarted, receipt: heldReceiptState, prematureRun,
  };
  context.diagnostic(JSON.stringify({ phase: "summary-held", heldMs: Date.now() - summaryEntered, ...held }));

  // Collect the full old-implementation outcome before asserting visibility: its
  // timed-out message actually starts only now, despite the client's failure.
  let nextRequest = 1;
  for (;;) {
    const request = await provider.request(nextRequest++);
    if (request.toolNames.length > 0) {
      assert.equal(request.body.messages?.filter((item) => item.role === "user" && JSON.stringify(item.content).includes(message)).length, 1);
      await waitFor(() => events.some((event) => event.type === "run.started" && event.data.operationId === operationId), "The original message never started after releasing compaction");
      const running = await client.status(work.id);
      assert.equal(running.execution, "running");
      assert.equal(running.compacting, false);
      context.diagnostic(JSON.stringify({ phase: "same-message-running", elapsedMs: Date.now() - began, receipt: receiptState }));
      request.text("FIRST_AFTER_SWITCH_FINISHED");
      break;
    }
    request.text("## Goal\nContinue from the saved context.\n## Progress\nEarlier context has been read.");
  }
  const receipt = await submitted;
  await waitFor(async () => (await client.status(work.id)).execution === "idle" && events.some((event) => event.type === "run.settled"), "The original message did not finish after compaction");
  const history = (await client.history(work.id)).entries;
  const userMessages = history.filter((entry) => entry.source === "user" && entry.content.some((block) => block.type === "text" && block.text === message));
  const replies = history.filter((entry) => entry.source === "assistant" && entry.content.some((block) => block.type === "text" && block.text === "FIRST_AFTER_SWITCH_FINISHED"));
  context.diagnostic(JSON.stringify({ phase: "finished", receipt: receiptState, userMessages: userMessages.length, replies: replies.length }));
  assert.equal(userMessages.length, 1, "The first message is saved once without resubmission");
  assert.equal(replies.length, 1);
  assert.ok(history.some((entry) => entry.kind === "compaction_summary" && (entry.tokensBefore ?? 0) > 12_000));
  assert.ok(events.some((event) => event.type === "compaction.completed" && !event.data.aborted && event.data.error === undefined));
  assert.equal(events.filter((event) => event.type === "run.started" && event.data.operationId === operationId).length, 1);
  assert.deepEqual({ ...held, receipt: heldReceiptState === "pending" || heldReceiptState === "accepted" ? "waiting-or-accepted" : heldReceiptState }, {
    status: { execution: "running", compacting: true }, list: { execution: "running", compacting: true },
    reconnect: { execution: "running", compacting: true }, liveStarted: true, receipt: "waiting-or-accepted", prematureRun: false,
  }, "Every observer sees compaction while the original submission waits without a false failure");
  assert.equal(receipt?.receipt.operationId, operationId);
  assert.equal(receipt?.receipt.queued, false);
});

// 2026-11-17 regression: an active Work showed idle after within-run compaction.
// SDK 1.3 compacts between tool steps in the same run. A Work message
// starts a run without a Dock command ID; compaction ending must not mark it idle.
// Only the local HTTP model replies are scripted: Pi, read/bash and both Workers are real.
test("a Work keeps running through automatic compaction, accepts messages and wakes its watcher only when finished", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "target"], {
    prefix: "alu-compaction-run-", thinkingLevel: "off",
    settings: { compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 } },
  });
  const { coordinator, target } = team.providers;
  const modelsPath = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  models.providers.target.models[0].contextWindow = 12_000;
  await writeFile(modelsPath, JSON.stringify(models));
  const evidence = join(team.cwd, "evidence.txt");
  const script = join(team.cwd, "wait-for-release.cjs");
  const entered = join(team.cwd, "tool-entered"), release = join(team.cwd, "release-tool");
  await writeFile(evidence, "READ_EVIDENCE\n" + "local workspace evidence\n".repeat(1_800));
  await writeFile(script, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(entered)}, "running");
console.log("POST_COMPACTION_TOOL_RUNNING");
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    console.log("POST_COMPACTION_TOOL_FINISHED");
  }
}, 20);
`);
  team.onCleanup = () => writeFileSync(release, "");
  const client = await team.startHost();
  const parent = await trustOnce((trust) => client.create(team.cwd, "Coordinator", "compact-parent", trust));
  const work = await client.create(team.cwd, "Compacting Work", "compact-target", undefined, undefined,
    { model: { provider: "target", id: "fixture" } }, { parentId: parent.id, allowedTools: ["read", "bash"] });
  assert.equal(new Set(team.workerPids).size, 2, "The two Works have independent Worker processes");
  assert.ok(team.workerPids.every((pid) => pid !== process.pid));
  const events: DockEvent[] = [];
  const recordEvent = (event: DockEvent) => {
    events.push(event);
    if (["run.started", "run.settled", "compaction.started", "compaction.completed"].includes(event.type)) {
      context.diagnostic(JSON.stringify({ type: event.type, data: event.data }));
    } else if (event.type === "tool.started" || event.type === "tool.completed") {
      context.diagnostic(JSON.stringify({ type: event.type, toolCallId: event.data.toolCallId }));
    }
  };
  const follow = await client.streamEvents(work.id, {
    onEvent: recordEvent, conversationBootstrap: true, requireTuiProjection: true,
  });
  context.after(() => follow.close());

  // A real parent-to-child Work message wakes Pi independently of command.submit.
  await client.prompt(parent.id, "Ask the child to read evidence and keep working.", "auto", "wake-child");
  (await coordinator.request(0)).tools({ id: "wake-child", name: "dock_send", arguments: { target: work.id, message: "Read evidence.txt, then run the gated command." } });
  const first = await target.request(0);
  await waitFor(() => events.some((event) => event.type === "run.started"), "The runtime-initiated run was not published");
  const before = await client.status(work.id);
  assert.equal(before.execution, "running");
  assert.equal(before.activeCommandId, undefined, "The regression needs a runtime-initiated run, not a Dock prompt");
  assert.ok(events.some((event) => event.type === "run.started" && event.data.operationId === "runtime-initiated"));
  context.diagnostic(JSON.stringify({ phase: "before-read", execution: before.execution, activeCommandId: before.activeCommandId ?? null }));
  (await coordinator.request(1)).tools({ id: "watch-child", name: "dock_watch", arguments: { target: work.id } });
  const watching = await coordinator.request(2);
  assert.match(JSON.stringify(watching.body.messages?.at(-1)), /Watching Compacting Work/);
  watching.text("Waiting for the child.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not finish registering its watch");

  first.tools({ id: "large-read", name: "read", arguments: { path: evidence } });
  let targetRequest = 1;
  const nextTargetStep = async () => {
    for (;;) {
      const request = await target.request(targetRequest++);
      if (request.toolNames.length > 0) return request;
      assert.match(JSON.stringify(request.body.messages?.[0]), /context summarization assistant/);
      context.diagnostic(JSON.stringify({ phase: "local-summary", request: targetRequest }));
      request.text("## Goal\nRead the workspace evidence, run the remaining command, and report to the parent.\n## Progress\nThe evidence has been read.");
    }
  };
  const afterCompaction = await nextTargetStep();
  await waitFor(() => events.some((event) => event.type === "compaction.completed"), "Pi did not finish real automatic compaction");
  const started = events.find((event) => event.type === "compaction.started");
  const completed = events.find((event) => event.type === "compaction.completed");
  assert.ok(started?.type === "compaction.started" && started.data.reason === "threshold");
  assert.ok(completed?.type === "compaction.completed" && completed.data.reason === "threshold" && !completed.data.aborted && !completed.data.willRetry && completed.data.error === undefined);
  assert.equal(events.filter((event) => event.type === "run.started").length, 1, "Compaction continues the same run, without another agent_start");
  assert.equal(events.some((event) => event.type === "run.settled"), false);

  afterCompaction.tools({ id: "gated-bash", name: "bash", arguments: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, timeout: 30 } });
  await waitFor(() => existsSync(entered) && events.some((event) => event.type === "tool.started" && event.data.toolCallId === "gated-bash"), "The real post-compaction bash tool did not start");
  // Detach every target observer. The command keeps running, independent of clients.
  follow.close();
  await follow.done;
  const observer = new DockClient({ socketPath: join(team.root, "dock.sock") });
  context.after(() => observer.closeActiveConnections());
  const status = await observer.status(work.id);
  const listed = (await observer.list()).find((item) => item.id === work.id)!;
  const reconnect = await observer.streamEvents(work.id, { onEvent: recordEvent, conversationBootstrap: true, requireTuiProjection: true });
  context.after(() => reconnect.close());
  const snapshot = reconnect.initial.instance;
  const visible = [status, listed, snapshot].map((item) => ({ execution: item.execution, compacting: item.compacting, activeCommandId: item.activeCommandId ?? null }));
  context.diagnostic(JSON.stringify({ phase: "post-compaction-tool-held", status: visible[0], list: visible[1], reconnect: visible[2] }));
  assert.ok(reconnect.initial.page.events.some((event) => event.type === "tool.started" && event.data.toolCallId === "gated-bash"));

  // Check a watch registered after compaction too, before any new input can change
  // the target's status. On the broken Host, the original watch has already woken Pi.
  await client.prompt(parent.id, "Check the child's watch again.", "auto", "watch-after-compaction");
  const checkWatch = await coordinator.request(3);
  const wokeEarly = JSON.stringify(checkWatch.body.messages).includes("[Dock watch completed");
  checkWatch.tools({ id: "watch-again", name: "dock_watch", arguments: { target: work.id } });
  const checkedWatch = await coordinator.request(4);
  const postCompactionWatch = JSON.stringify(checkedWatch.body.messages?.findLast((message) => message.role === "tool"));
  checkedWatch.text("I will wait for the actual finish.");
  let answeredCoordinator = 5;

  // A user message follows the same admission path as a top-level Work's dock_send.
  // It must be accepted while the real tool is still waiting and reach Pi's next step.
  const busyMessage = "BUSY_MESSAGE: include the post-compaction tool result in your report.";
  const accepted = await client.prompt(work.id, busyMessage, "auto", "message-while-tool-running");
  assert.equal(accepted.receipt.queued, true);
  assert.equal(accepted.receipt.delivery, "steer");
  context.diagnostic(JSON.stringify({ phase: "tool-still-held", wokeEarly, postCompactionWatch, busyMessageDelivery: accepted.receipt.delivery }));

  await writeFile(release, "");
  const finishedTool = await nextTargetStep();
  assert.ok(JSON.stringify(finishedTool.body.messages).includes("POST_COMPACTION_TOOL_FINISHED"));
  assert.ok(JSON.stringify(finishedTool.body.messages).includes(busyMessage), "Pi must receive the message accepted while the tool was running");
  finishedTool.tools({ id: "done", name: "dock_send", arguments: { message: "The remaining tool finished.", done: true } });
  await waitFor(async () => {
    while (answeredCoordinator < coordinator.requests.length) coordinator.requests[answeredCoordinator++]!.text("The child finished.");
    return events.some((event) => event.type === "run.settled")
      && coordinator.requests.slice(3).some((request) => JSON.stringify(request.body.messages).includes("[Dock watch completed"))
      && (await client.status(work.id)).execution === "idle" && (await client.status(parent.id)).execution === "idle";
  }, "The Works did not settle and deliver the watch notice after the tool finished");
  const watchNotices = (await client.history(parent.id)).entries.filter((entry) => entry.customType === "dock-tools-watch");
  context.diagnostic(JSON.stringify({ phase: "settled", execution: (await client.status(work.id)).execution, watchNotices: watchNotices.length }));
  assert.deepEqual(visible, Array.from({ length: 3 }, () => ({ execution: "running", compacting: false, activeCommandId: null })), "Status, list and a fresh reconnect must show the still-running Work after compaction");
  assert.equal(wokeEarly, false, "Compaction must not wake the watcher before the tool finishes");
  assert.equal(watchNotices.length, 1, "The watcher receives one completion notice");
  assert.match(postCompactionWatch, /Watching Compacting Work/, "A watch after compaction waits for the still-running Work");
});
