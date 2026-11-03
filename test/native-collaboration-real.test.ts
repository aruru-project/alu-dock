import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockToolsRequest } from "../src/core/dock-tools.js";
import { waitFor } from "./support/plan-goal-provider.js";
import { exited, startNativeTeam, trustOnce } from "./support/native-team.js";

// Only provider HTTP replies are scripted. Every delegation, message, read and write
// below passes through the production model tool -> Pi -> Worker -> Host path.
test("a coordinator delegates to an implementer and an independent reviewer and hears each one's reply", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer", "reviewer"], { prefix: "alu-native-team-" });
  const { cwd, workerPids } = team;
  const { coordinator, implementer, reviewer } = team.providers;
  let releaseHeldHelper: (() => void) | undefined;
  team.onCleanup = () => releaseHeldHelper?.();
  const bugPath = join(cwd, "sum.js");
  await writeFile(bugPath, "export const sum = (a, b) => a - b;\n");
  let client = await team.startHost();

  // The user's coordinator runs a reasoning model at high thinking. A helper on another
  // model starts at that model's own level instead of failing on the parent's.
  const parent = await trustOnce((trust) => client.create(cwd, "Coordinator", "team-create", trust));
  assert.equal(parent.executor.thinkingLevel, "high");
  await client.prompt(parent.id, "Delegate implementation and independent review of sum.js.", "auto", "team-start");
  const spawnImplementer = await coordinator.request(0);
  assert.ok(spawnImplementer.toolNames.includes("dock_spawn"));
  spawnImplementer.tools({ id: "spawn-implementer", name: "dock_spawn", arguments: {
    name: "Implementer", task: "Fix sum.js once the review finding arrives.",
    model: { provider: "implementer", id: "fixture" }, allowedTools: ["read", "write"],
  } });
  const implementerFirst = await implementer.request(0);
  const spawnReviewer = await coordinator.request(1);
  spawnReviewer.tools({ id: "spawn-reviewer", name: "dock_spawn", arguments: {
    name: "Reviewer", task: "Independently review sum.js.",
    model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low", allowedTools: ["read"],
  } });
  const reviewerFirst = await reviewer.request(0);
  let parentWaiting = await coordinator.request(2);
  const members = await client.list();
  const implementerWork = members.find((work) => work.displayName === "Implementer")!;
  const reviewerWork = members.find((work) => work.displayName === "Reviewer")!;
  assert.equal(new Set(workerPids).size, 3, "Each team member runs in its own OS process");
  for (const [work, provider, thinking] of [[implementerWork, "implementer", "off"], [reviewerWork, "reviewer", "low"]] as const) {
    assert.equal(work.parentId, parent.id);
    assert.deepEqual(work.executor.model, { provider, id: "fixture" });
    assert.equal(work.executor.thinkingLevel, thinking);
  }
  // A helper gets exactly what its parent granted, plus a way to reach that parent.
  assert.deepEqual(reviewerFirst.toolNames.sort(), ["dock_send", "read"]);
  assert.deepEqual(implementerFirst.toolNames.sort(), ["dock_send", "read", "write"]);

  // The reviewer only reads and answers. Its final reply reaches the coordinator in the
  // completion notice, without the reviewer sending it or the coordinator reading it back.
  reviewerFirst.tools({ id: "review-read", name: "read", arguments: { path: bugPath } });
  const reviewResult = await reviewer.request(1);
  assert.ok(JSON.stringify(reviewResult.body.messages).includes("a - b"));
  reviewResult.text("REVIEW_FINDING: sum subtracts; change a - b to a + b.");
  parentWaiting.text("Waiting for the independent review.");
  const parentFinding = await coordinator.request(3);
  assert.ok(JSON.stringify(parentFinding.body.messages).includes("REVIEW_FINDING"));

  // The coordinator relays the finding. It queues behind the implementer's current turn.
  parentFinding.tools({ id: "relay-finding", name: "dock_send", arguments: {
    target: implementerWork.id, message: "REVIEW_FINDING: approved; change a - b to a + b.",
  } });
  parentWaiting = await coordinator.request(4);
  assert.equal(implementerFirst.closed, false, "The parent's message must not interrupt its helper's turn");
  implementerFirst.text("Ready to apply the independent finding.");
  const implementerFollowup = await implementer.request(1);
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("REVIEW_FINDING"));
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("Coordinator"));
  implementerFollowup.tools({ id: "fix", name: "write", arguments: { path: bugPath, content: "export const sum = (a, b) => a + b;\n" } });
  (await implementer.request(2)).text("FIX_COMPLETE: sum.js now adds.");
  assert.equal(await readFile(bugPath, "utf8"), "export const sum = (a, b) => a + b;\n");
  parentWaiting.text("Waiting for the fix.");
  const parentFix = await coordinator.request(5);
  assert.ok(JSON.stringify(parentFix.body.messages).includes("FIX_COMPLETE"));

  // Handing an idle helper more work also brings its next reply back.
  parentFix.tools({ id: "request-final-review", name: "dock_send", arguments: {
    target: reviewerWork.id, message: "FINAL_REVIEW_REQUEST: reread sum.js and report whether the fix is correct.",
  } });
  parentWaiting = await coordinator.request(6);
  const finalReview = await reviewer.request(2);
  assert.ok(JSON.stringify(finalReview.body.messages).includes("FINAL_REVIEW_REQUEST"));
  finalReview.tools({ id: "final-review-read", name: "read", arguments: { path: bugPath } });
  const correctedRead = await reviewer.request(3);
  assert.ok(JSON.stringify(correctedRead.body.messages).includes("a + b"), "The reviewer sees the actual file, not only the implementer's claim");
  correctedRead.text("FINAL_REVIEW_PASS: sum.js now adds a + b.");
  parentWaiting.text("Waiting for the final review.");
  const parentPass = await coordinator.request(7);
  assert.ok(JSON.stringify(parentPass.body.messages).includes("FINAL_REVIEW_PASS"));
  parentPass.text("Implementation and independent review are complete.");
  for (const work of [parent, implementerWork, reviewerWork]) {
    await waitFor(async () => (await client.status(work.id)).execution === "idle", `${work.displayName} did not settle`);
  }

  // A helper's one Dock tool reaches its parent, whoever started the helper's turn.
  // Real-model trial 2026-11-03: a parent busy for 20 minutes got its helpers' messages
  // only after its turn, all stale by then. A busy parent now gets one at its next step.
  await client.prompt(parent.id, "Keep checking the workspace.", "auto", "parent-busy");
  const parentBusy = await coordinator.request(8);
  await client.prompt(implementerWork.id, "Ask your coordinator whether tests are needed.", "auto", "child-question");
  (await implementer.request(3)).tools({ id: "ask-parent", name: "dock_send", arguments: { message: "CHILD_QUESTION: add tests too?" } });
  const asked = await implementer.request(4);
  parentBusy.tools({ id: "parent-keeps-working", name: "read", arguments: { path: bugPath } });
  const question = await coordinator.request(9);
  assert.ok(JSON.stringify(question.body.messages).includes("CHILD_QUESTION"), "A helper's message reaches its busy parent at the parent's next step");
  assert.ok(JSON.stringify(question.body.messages).includes("Agent message from \\\"Implementer\\\""));
  question.text("No tests are needed.");
  asked.text("Asked the coordinator.");
  for (const work of [parent, implementerWork]) {
    await waitFor(async () => (await client.status(work.id)).execution === "idle", `${work.displayName} did not settle after the question`);
  }

  // User decision 2026-10-31: a helper talks only to its parent. Whatever a helper's
  // Worker asks of the Host, it cannot stop, interrupt, list, read or create Work.
  const denied: DockToolsRequest[] = [
    { type: "stop", operationId: "child-stops-parent", target: parent.id },
    { type: "interrupt", operationId: "child-interrupts-parent", target: parent.id },
    { type: "list" },
    { type: "inspect", target: reviewerWork.id },
    { type: "create", operationId: "child-creates", cwd },
    { type: "spawn", operationId: "child-spawns", name: "Grandchild", task: "Do not run" },
  ];
  for (const request of denied) await assert.rejects(team.registry!.invokeDockTool(implementerWork.id, request), /can only message/);
  await assert.rejects(client.create(cwd, "Nested", "nested-child", undefined, undefined, undefined, { parentId: implementerWork.id }), /top-level/);
  // Another top-level Work neither sees nor reaches the coordinator's helpers.
  const unrelated = await trustOnce((trust) => client.create(cwd, "Unrelated", "unrelated-create", trust));
  const unrelatedPid = workerPids.at(-1)!;
  const unrelatedList = await team.registry!.invokeDockTool(unrelated.id, { type: "list" });
  assert.ok(unrelatedList.type === "list");
  assert.deepEqual(unrelatedList.result.instances.map((status) => status.id), [parent.id]);
  await assert.rejects(team.registry!.invokeDockTool(unrelated.id, { type: "inspect", target: implementerWork.id }), /missing or ambiguous/);

  // A crashed helper offers no Continue. Stopping the parent collects every helper,
  // live or crashed; their processes end and their conversations stay on disk.
  const sessions = await Promise.all([implementerWork, reviewerWork].map(async (child) => (await client.status(child.id)).executor.sessionFile!));
  process.kill(workerPids[2]!, "SIGKILL");
  await waitFor(async () => (await client.status(reviewerWork.id)).lifecycle === "runtime_error", "Helper crash was not observed");
  assert.equal((await client.status(reviewerWork.id)).reopenable, false);
  await assert.rejects(client.reopen(reviewerWork.id, "reopen-crashed-child"));
  assert.equal(workerPids.length, 4, "Rejected helper reopen must not start a replacement process");
  // Cloud verification of e12df25 (2026-11-01): a helper still starting outlived its parent's Stop.
  let held = false;
  team.holdNextHelper = () => new Promise<void>((resolve) => { held = true; releaseHeldHelper = resolve; });
  const lateHelper = client.create(cwd, "LateHelper", "create-late-helper", undefined, undefined, undefined, { parentId: parent.id });
  void lateHelper.catch(() => {});
  await waitFor(() => held, "The late helper did not start");
  const lateHelperPid = workerPids.at(-1)!;
  const stopping = client.stop(parent.id, "team-stop-parent");
  await waitFor(() => [workerPids[0]!, workerPids[1]!].every(exited), "The parent and its listed helper did not stop");
  const stopReturned = await Promise.race([stopping.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
  releaseHeldHelper!();
  assert.equal(stopReturned, false, "The parent's Stop waits for a helper that is still starting");
  await stopping;
  assert.ok(exited(lateHelperPid), "No helper process outlives its parent's Stop");
  await assert.rejects(lateHelper);
  for (const pid of workerPids.slice(0, 3)) await waitFor(() => exited(pid), "A stopped team process is still alive");
  assert.deepEqual((await client.list()).map((work) => `${work.displayName}:${work.lifecycle}`), ["Unrelated:active"]);
  assert.ok((await readFile(sessions[0]!, "utf8")).includes("FIX_COMPLETE"));
  assert.ok((await readFile(sessions[1]!, "utf8")).includes("FINAL_REVIEW_PASS"));
  assert.equal(exited(unrelatedPid), false);

  // A helper made in its parent's directory inherits the parent's trust_once without a
  // new question. When the parent crashes, the helper ends with it.
  await client.prompt(unrelated.id, "Remember this workspace.", "auto", "persist-parent");
  (await coordinator.request(10)).text("Noted.");
  await waitFor(async () => (await client.status(unrelated.id)).execution === "idle", "Unrelated did not settle");
  const crashChild = await client.create(cwd, "CrashChild", "create-crash-child", undefined, undefined,
    { model: { provider: "reviewer", id: "fixture" } }, { parentId: unrelated.id, allowedTools: ["read"] });
  const crashChildPid = workerPids.at(-1)!;
  assert.equal(crashChild.parentId, unrelated.id);
  process.kill(unrelatedPid, "SIGKILL");
  await waitFor(async () => (await client.status(unrelated.id)).lifecycle === "runtime_error", "Parent crash was not observed");
  await waitFor(() => exited(crashChildPid), "The crashed parent's helper process survived");
  await waitFor(async () => !(await client.list()).some((work) => work.id === crashChild.id), "The crashed parent's helper stayed listed");

  // Continuing the parent lets it delegate again. A thinking level the helper's model
  // lacks is refused without leaving an empty helper behind.
  await trustOnce((trust) => client.reopen(unrelated.id, "reopen-parent", undefined, trust));
  await assert.rejects(client.create(cwd, "InvalidEffort", "invalid-effort", undefined, undefined,
    { model: { provider: "implementer", id: "fixture" }, thinkingLevel: "high" }, { parentId: unrelated.id }), /does not support thinking/);
  await waitFor(() => exited(workerPids.at(-1)!), "Refused helper configuration left a process alive");
  const restartChild = await client.create(cwd, "RestartChild", "create-restart-child", undefined, undefined,
    { model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low" }, { parentId: unrelated.id, allowedTools: ["read"] });
  const restartChildPid = workerPids.at(-1)!;
  assert.deepEqual((await client.list()).map((work) => work.id).sort(), [restartChild.id, unrelated.id].sort());
  await client.prompt(restartChild.id, "Keep a conversation for later diagnosis.", "auto", "persist-child");
  (await reviewer.request(4)).text("RESTART_CHILD_HISTORY");
  await waitFor(async () => (await client.status(restartChild.id)).execution === "idle", "Restart child did not settle");
  const restartSession = (await client.status(restartChild.id)).executor.sessionFile!;

  // After a Host restart, helpers are not restored; their conversations stay on disk.
  client.closeActiveConnections();
  await team.host!.stop();
  await waitFor(() => exited(restartChildPid), "Host shutdown left the helper process alive");
  client = await team.startHost();
  await assert.rejects(client.status(restartChild.id));
  assert.ok(!(await client.list()).some((work) => work.parentId !== undefined));
  assert.equal((await client.status(unrelated.id)).lifecycle, "host_lost");
  assert.ok((await readFile(restartSession, "utf8")).includes("RESTART_CHILD_HISTORY"));
});

// Real-model trial review 2026-11-03: in a Dock Goal, ending the turn to wait for a helper
// started the next round at once; three rounds were spent before the helper said anything.
test("a coordinator in a Goal hands a helper its conversation, waits for it in the same round, and the user can still reach it", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer"], { prefix: "alu-native-wait-" });
  const { coordinator, reviewer } = team.providers;
  const client = await team.startHost();
  const parent = await trustOnce((trust) => client.create(team.cwd, "Coordinator", "goal-create", trust));
  await client.prompt(parent.id, "USER_DECISION: every review names the file it read.", "auto", "user-decision");
  (await coordinator.request(0)).text("Noted.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not settle");
  await client.prompt(parent.id, "/dock-goal --rounds 2 Get an independent review of the workspace.", "auto", "goal-start");
  const round = await coordinator.request(1);
  round.tools({ id: "spawn", name: "dock_spawn", arguments: { name: "Reviewer", task: "Review the workspace.", model: { provider: "reviewer", id: "fixture" }, allowedTools: ["read"], withContext: true } });

  // The helper starts from the coordinator's conversation, ending before the call creating it.
  const review = await reviewer.request(0);
  const inherited = JSON.stringify(review.body.messages);
  assert.ok(inherited.includes("USER_DECISION") && inherited.includes("Review the workspace."));
  assert.ok(!inherited.includes("No result provided"), "The helper does not see its own creation without a result");
  (await coordinator.request(2)).tools({ id: "wait", name: "dock_wait", arguments: {} });

  // A message from the user ends the wait rather than queueing behind it.
  await client.prompt(parent.id, "USER_NOTE: also check the naming.", "auto", "user-note");
  const interrupted = await coordinator.request(3);
  const seen = JSON.stringify(interrupted.body.messages);
  assert.ok(seen.includes("USER_NOTE") && seen.includes("a message reached you"));
  interrupted.tools({ id: "wait-again", name: "dock_wait", arguments: {} });

  review.text("REVIEW_DONE: naming is fine.");
  const replied = JSON.stringify((await coordinator.request(4)).body.messages);
  assert.equal(replied.split("REVIEW_DONE").length - 1, 1, "The reply arrives once, as the wait's result");
  assert.doesNotMatch(replied, /Dock Goal: 2\/2/, "Waiting did not spend another Goal round");
  coordinator.requests[4]!.tools({ id: "done", name: "goal_update", arguments: { status: "complete", summary: "Reviewed", evidence: ["REVIEW_DONE"] } });
  (await coordinator.request(5)).text("The review is complete.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not settle");
});

// User decision 2026-11-04: dock_models showed every model this machine can run (432 on the
// user's). An Agent now sees its own model, which helpers use by default, and only the models
// the user lists for helpers, with the user's notes and what each supports.
test("a coordinator sees its own model and only the models the user lists for helpers", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer", "implementer"], { prefix: "alu-native-models-" });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const parent = await trustOnce((trust) => client.create(team.cwd, "Coordinator", "models-create", trust));
  await client.prompt(parent.id, "Which models can helpers use?", "auto", "models-ask");
  (await coordinator.request(0)).tools({ id: "models-unlisted", name: "dock_models", arguments: {} });
  const unlisted = await coordinator.request(1);
  const before = JSON.stringify(unlisted.body.messages);
  assert.ok(before.includes("Your model, which a helper uses when you omit model: coordinator/fixture"));
  assert.ok(before.includes("has not listed models for helpers"));
  assert.ok(!before.includes("reviewer/fixture") && !before.includes("implementer/fixture"), "Models the user did not list stay out of view");

  // An edit applies on the next call, without a restart.
  await writeFile(join(team.root, "helper-models.json"), JSON.stringify({ models: [
    { provider: "coordinator", id: "fixture", note: "MAIN_NOTE" },
    { provider: "implementer", id: "fixture", note: "CHEAP_NOTE" },
    { provider: "ghost", id: "none" },
  ] }));
  unlisted.tools({ id: "models-listed", name: "dock_models", arguments: {} });
  const listed = await coordinator.request(2);
  const after = JSON.stringify(listed.body.messages!.at(-1));
  assert.match(after, /Your model, which a helper uses when you omit model: coordinator\/fixture · note: \\"MAIN_NOTE\\" · thinking off, minimal, low, medium, high · context 32K tokens · text only/);
  assert.match(after, /- implementer\/fixture · note: \\"CHEAP_NOTE\\" · no thinking levels · context 32K tokens · text only/);
  assert.ok(after.includes("not available on this machine now: ghost/none"));
  assert.ok(!after.includes("reviewer/fixture"), "An available model the user did not list stays out of view");
  listed.text("Helpers can use the listed models.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not settle");
});
