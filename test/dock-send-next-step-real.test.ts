import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #681: a child's receipt can precede its busy parent's next step. Kill the parent in that gap.
test("a reopened parent sees the result it acknowledged while busy and does not repeat what dock_wait already took", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["parent", "child"], { prefix: "alu-unread-result-" });
  const { parent, child } = team.providers;
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Parent", "parent", trust));
  await client.prompt(work.id, "Get the reviewer's result.");
  (await parent.request(0)).tools({ id: "spawn", name: "dock_spawn", arguments: { name: "Reviewer", task: "Review the work.", model: { provider: "child", id: "fixture" } } });
  const working = await child.request(0);
  (await parent.request(1)).tools({ id: "wait", name: "dock_wait", arguments: {} });
  working.tools({ id: "progress", name: "dock_send", arguments: { message: "REVIEW_PROGRESS", done: false } });
  const ready = await child.request(1);
  assert.match(JSON.stringify((await parent.request(2)).body.messages?.at(-1)), /REVIEW_PROGRESS/u); // Busy again; its dock_wait result is in the conversation.
  ready.tools({ id: "done", name: "dock_send", arguments: { message: "ACKNOWLEDGED_FINAL", done: true } });
  const reviewer = (await client.list()).find((candidate) => candidate.parentId === work.id)!;
  await waitFor(async () => (await client.status(reviewer.id)).execution === "idle", "Reviewer did not receive its final receipt");

  let parentPid = team.workerPids[0]!;
  for (const operation of ["read-unanswered", "read-again"]) {
    process.kill(parentPid, "SIGKILL");
    await waitFor(async () => (await client.status(work.id)).lifecycle === "runtime_error", "Host did not observe the parent leave");
    await client.reopen(work.id, operation);
    parentPid = team.workerPids.at(-1)!;
    const history = (await client.history(work.id)).entries.filter((entry) => entry.customType === "dock-work-message");
    assert.equal(history.length, 1, "What dock_wait took does not become a second message");
    assert.match(JSON.stringify(history[0]!.content), /ACKNOWLEDGED_FINAL/u);
  }
  assert.equal(parent.requests.length, 3, "Reading the recovered result starts no model turn");
});

// 2026-11-13: the owner's other top-level Work sent a finding, but it waited until this
// Work's whole turn ended. Default send must reach the next step; explicit followUp still waits.
test("dock_send reaches a busy top-level Work at its next step unless the sender explicitly asks for followUp", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["sender", "receiver"], { prefix: "alu-next-step-" });
  const { sender, receiver } = team.providers;
  const file = join(team.cwd, "note.txt");
  await writeFile(file, "keep working");
  const client = await team.startHost();
  const from = await trustOnce((trust) => client.create(team.cwd, "Sender", "from", trust));
  const to = await trustOnce((trust) => client.create(team.cwd, "Receiver", "to", trust));
  await client.setModel(to.id, "receiver", "fixture");
  await client.prompt(to.id, "Read the note and keep working.");
  const underway = await receiver.request(0);
  await client.prompt(from.id, "Tell Receiver the new finding.");
  (await sender.request(0)).tools({ id: "send-now", name: "dock_send", arguments: { target: to.id, message: "NEXT_STEP_FINDING" } });
  const delivered = await sender.request(1);
  underway.tools({ id: "read-one", name: "read", arguments: { path: file } });
  const nextStep = await receiver.request(1);
  assert.ok(JSON.stringify(nextStep.body.messages).includes("NEXT_STEP_FINDING"), "The finding reaches the tool continuation, before the receiver ends its turn");

  delivered.tools({ id: "send-later", name: "dock_send", arguments: { target: to.id, message: "AFTER_THIS_TURN", delivery: "followUp" } });
  (await sender.request(2)).text("Sent both messages.");
  nextStep.tools({ id: "read-two", name: "read", arguments: { path: file } });
  const stillWorking = await receiver.request(2);
  assert.ok(!JSON.stringify(stillWorking.body.messages).includes("AFTER_THIS_TURN"), "An explicitly deferred message is not a mid-turn interruption");
  stillWorking.text("This turn is complete.");
  const following = await receiver.request(3);
  assert.ok(JSON.stringify(following.body.messages).includes("AFTER_THIS_TURN"));
  following.text("Read the deferred message.");
  await waitFor(async () => (await client.status(to.id)).execution === "idle" && (await client.status(from.id)).execution === "idle", "Both Works should finish");
});
