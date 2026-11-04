import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockToolsRequest } from "../src/core/dock-tools.js";
import { waitFor, type PlanGoalProvider } from "./support/plan-goal-provider.js";
import { exited, startNativeTeam, trustOnce } from "./support/native-team.js";

// Only provider HTTP replies are scripted; the Host, Pi Workers and their processes are real.
// Where a test checks what the Host itself allows, it calls the Host as a Worker's tool would.
test("a coordinator delegates to an implementer and an independent reviewer and hears each one's reply", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "implementer", "reviewer"], { prefix: "alu-native-team-" });
  const { cwd, workerPids } = team;
  const { coordinator, implementer, reviewer } = team.providers;
  const bugPath = join(cwd, "sum.js");
  await writeFile(bugPath, "export const sum = (a, b) => a - b;\n");
  const client = await team.startHost();

  // The user's coordinator runs a reasoning model at high thinking. A child Work on another
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
  // A child Work gets exactly what its parent granted, plus a way to reach that parent.
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
  assert.equal(implementerFirst.closed, false, "The parent's message must not interrupt its child Work's turn");
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

  // Handing an idle child Work more work also brings its next reply back.
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

  // A child Work's one Dock tool reaches its parent, whoever started the child Work's turn.
  // Real-model trial 2026-11-03: a parent busy for 20 minutes got its child Works' messages
  // only after its turn, all stale by then. A busy parent now gets one at its next step.
  await client.prompt(parent.id, "Keep checking the workspace.", "auto", "parent-busy");
  const parentBusy = await coordinator.request(8);
  await client.prompt(implementerWork.id, "Ask your coordinator whether tests are needed.", "auto", "child-question");
  (await implementer.request(3)).tools({ id: "ask-parent", name: "dock_send", arguments: { message: "CHILD_QUESTION: add tests too?" } });
  const asked = await implementer.request(4);
  parentBusy.tools({ id: "parent-keeps-working", name: "read", arguments: { path: bugPath } });
  const question = await coordinator.request(9);
  assert.ok(JSON.stringify(question.body.messages).includes("CHILD_QUESTION"), "A child Work's message reaches its busy parent at the parent's next step");
  assert.ok(JSON.stringify(question.body.messages).includes("Agent message from \\\"Implementer\\\""));
  question.text("No tests are needed.");
  asked.text("Asked the coordinator.");
  for (const work of [parent, implementerWork]) {
    await waitFor(async () => (await client.status(work.id)).execution === "idle", `${work.displayName} did not settle after the question`);
  }

});

// User decision 2026-10-31: a child Work talks only to its parent, and the runtime holds it
// there rather than its prompt. Other top-level Works neither see nor reach it.
test("a child Work can only message its parent, and other top-level Works cannot see it", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer"], { prefix: "alu-native-bounds-" });
  const { cwd, workerPids } = team;
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const registry = team.registry!;
  const parent = await trustOnce((trust) => client.create(cwd, "Coordinator", "bounds-create", trust));
  // In its parent's directory a child runs under the parent's trust_once without being asked again.
  const child = await client.create(cwd, "Reviewer", "bounds-child", undefined, undefined,
    { model: { provider: "reviewer", id: "fixture" } }, { parentId: parent.id, allowedTools: ["read"] });
  const unrelated = await trustOnce((trust) => client.create(cwd, "Unrelated", "bounds-unrelated", trust));
  const processes = workerPids.length;

  // The Host itself refuses, whatever the child's Worker asks: these calls skip the model.
  const denied: DockToolsRequest[] = [
    { type: "stop", operationId: "child-stops-parent", target: parent.id },
    { type: "interrupt", operationId: "child-interrupts-parent", target: parent.id },
    { type: "list" },
    { type: "inspect", target: parent.id },
    { type: "spawn", operationId: "child-spawns", name: "Grandchild", task: "Do not run" },
  ];
  for (const request of denied) await assert.rejects(registry.invokeDockTool(child.id, request), `the child's ${request.type} is refused`);
  // A top-level Work's create goes on to ask the user to trust the directory. A child's is
  // refused before that, so it never reaches the user.
  const asksTrust = (error: unknown) => (error as { code?: unknown }).code === "project_trust_required";
  await assert.rejects(registry.invokeDockTool(parent.id, { type: "create", operationId: "parent-creates", cwd }), asksTrust);
  await assert.rejects(registry.invokeDockTool(child.id, { type: "create", operationId: "child-creates", cwd }), (error) => !asksTrust(error));
  await assert.rejects(client.create(cwd, "Nested", "nested-child", undefined, undefined, undefined, { parentId: child.id }), "a child has no children");
  assert.deepEqual((await client.list()).map((work) => `${work.displayName}:${work.lifecycle}`).sort(),
    ["Coordinator:active", "Reviewer:active", "Unrelated:active"], "nothing was stopped or created");
  assert.equal(workerPids.length, processes);

  // Its one request still works: a message reaches the parent.
  await registry.invokeDockTool(child.id, { type: "send", operationId: "child-notes", message: "CHILD_NOTE" });
  const noted = await coordinator.request(0);
  assert.ok(JSON.stringify(noted.body.messages).includes("CHILD_NOTE"));
  noted.text("Noted.");

  // The parent sees its child; another top-level Work sees only the parent and cannot read the child.
  const listed = async (sourceId: string) => {
    const result = await registry.invokeDockTool(sourceId, { type: "list" });
    assert.ok(result.type === "list");
    return result.result.instances.map((status) => status.id).sort();
  };
  assert.deepEqual(await listed(parent.id), [child.id, unrelated.id].sort());
  assert.deepEqual(await listed(unrelated.id), [parent.id]);
  assert.equal((await registry.invokeDockTool(parent.id, { type: "inspect", target: child.id })).type, "inspect");
  await assert.rejects(registry.invokeDockTool(unrelated.id, { type: "inspect", target: child.id }), "an unrelated Work cannot read the child");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not settle");
});

test("a top-level Work's child Works end with it and do not come back after a Host restart", { timeout: 90_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer", "implementer"], { prefix: "alu-native-life-" });
  const { cwd, workerPids } = team;
  const { coordinator, reviewer, implementer } = team.providers;
  let releaseHeldChild: (() => void) | undefined;
  team.onCleanup = () => releaseHeldChild?.();
  let client = await team.startHost();
  const startChild = async (parentId: string, name: string, provider = "reviewer") => {
    const child = await client.create(cwd, name, `create-${name}`, undefined, undefined,
      { model: { provider, id: "fixture" } }, { parentId, allowedTools: ["read"] });
    return { ...child, pid: workerPids.at(-1)! };
  };
  /** Gives a Work a saved conversation: one prompt and the given reply. */
  const converse = async (workId: string, provider: PlanGoalProvider, reply: string) => {
    const index = provider.requests.length;
    await client.prompt(workId, "Keep a conversation.", "auto", `converse-${workId}`);
    (await provider.request(index)).text(reply);
    await waitFor(async () => (await client.status(workId)).execution === "idle", "The conversation did not settle");
    return (await client.status(workId)).executor.sessionFile!;
  };
  const parent = await trustOnce((trust) => client.create(cwd, "Coordinator", "life-parent", trust));
  const parentPid = workerPids.at(-1)!;
  const other = await trustOnce((trust) => client.create(cwd, "Other", "life-other", trust));
  const otherPid = workerPids.at(-1)!;
  await converse(other.id, coordinator, "Noted.");

  // A crashed child offers no Continue; it can only be stopped.
  const crashed = await startChild(parent.id, "Crashed");
  process.kill(crashed.pid, "SIGKILL");
  await waitFor(async () => (await client.status(crashed.id)).lifecycle === "runtime_error", "The child's crash was not observed");
  assert.equal((await client.status(crashed.id)).reopenable, false);
  const processes = workerPids.length;
  await assert.rejects(client.reopen(crashed.id, "reopen-crashed-child"));
  assert.equal(workerPids.length, processes, "Refusing to continue a child starts no replacement process");

  // Stopping the parent collects every child, live, crashed or still starting. Their
  // processes end and their conversations stay on disk; other top-level Works keep running.
  const kept = await startChild(parent.id, "Kept");
  const keptSession = await converse(kept.id, reviewer, "KEPT_HISTORY");
  // Cloud verification of e12df25 (2026-11-01): a child still starting outlived its parent's Stop.
  let held = false;
  team.holdNextChild = () => new Promise<void>((resolve) => { held = true; releaseHeldChild = resolve; });
  const lateChild = client.create(cwd, "Late", "create-late-child", undefined, undefined, undefined, { parentId: parent.id });
  void lateChild.catch(() => {});
  await waitFor(() => held, "The late child did not start");
  const latePid = workerPids.at(-1)!;
  const stopping = client.stop(parent.id, "stop-parent");
  await waitFor(() => [parentPid, kept.pid].every(exited), "The parent and its listed child did not stop");
  const stopReturned = await Promise.race([stopping.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
  releaseHeldChild!();
  assert.equal(stopReturned, false, "The parent's Stop waits for a child that is still starting");
  await stopping;
  assert.ok(exited(latePid), "No child process outlives its parent's Stop");
  await assert.rejects(lateChild);
  assert.deepEqual((await client.list()).map((work) => `${work.displayName}:${work.lifecycle}`), ["Other:active"]);
  assert.ok((await readFile(keptSession, "utf8")).includes("KEPT_HISTORY"));
  assert.equal(exited(otherPid), false);

  // When a parent crashes, its child ends with it.
  const orphaned = await startChild(other.id, "Orphaned");
  process.kill(otherPid, "SIGKILL");
  await waitFor(async () => (await client.status(other.id)).lifecycle === "runtime_error", "The parent's crash was not observed");
  await waitFor(() => exited(orphaned.pid), "The crashed parent's child process survived");
  await waitFor(async () => !(await client.list()).some((work) => work.id === orphaned.id), "The crashed parent's child stayed listed");

  // Continuing the parent lets it delegate again. A thinking level the child's model lacks
  // is refused without leaving a child behind; the same model without it starts.
  await trustOnce((trust) => client.reopen(other.id, "reopen-other", undefined, trust));
  const beforeRefusal = workerPids.length;
  await assert.rejects(client.create(cwd, "InvalidEffort", "invalid-effort", undefined, undefined,
    { model: { provider: "implementer", id: "fixture" }, thinkingLevel: "high" }, { parentId: other.id }));
  await waitFor(() => workerPids.slice(beforeRefusal).every(exited), "A refused child left a process alive");
  assert.deepEqual((await client.list()).map((work) => work.displayName), ["Other"]);
  const restarted = await startChild(other.id, "Restarted", "implementer");
  const restartedSession = await converse(restarted.id, implementer, "RESTARTED_HISTORY");

  // After a Host restart, children are not restored; their conversations stay on disk.
  client.closeActiveConnections();
  await team.host!.stop();
  await waitFor(() => exited(restarted.pid), "Host shutdown left the child process alive");
  client = await team.startHost();
  await assert.rejects(client.status(restarted.id));
  assert.deepEqual((await client.list()).map((work) => `${work.displayName}:${work.lifecycle}`), ["Other:host_lost"]);
  assert.ok((await readFile(restartedSession, "utf8")).includes("RESTARTED_HISTORY"));
});
// Real-model trial review 2026-11-03: in a Dock Goal, ending the turn to wait for a child Work
// started the next round at once; three rounds were spent before the child Work said anything.
test("a coordinator in a Goal hands a child Work its conversation, waits for it in the same round, and the user can still reach it", { timeout: 60_000 }, async (context) => {
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

  // The child Work starts from the coordinator's conversation, ending before the call creating it.
  const review = await reviewer.request(0);
  const inherited = JSON.stringify(review.body.messages);
  assert.ok(inherited.includes("USER_DECISION") && inherited.includes("Review the workspace."));
  assert.ok(!inherited.includes("No result provided"), "The child Work does not see its own creation without a result");
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

  // Cloud review of abb061b: the copied conversation carried the coordinator's name, so
  // after a reload the child Work was called Coordinator and could not be reached as Reviewer.
  const child = (await client.list()).find((work) => work.parentId === parent.id)!;
  await client.reloadSession(child.id, "reload-child");
  assert.equal((await client.status(child.id)).displayName, "Reviewer");
});

// User decision 2026-11-04: dock_models showed every model this machine can run (432 on the
// user's). An Agent now sees its own model, which child Works use by default, and only the models
// the user lists for child Works, with the user's notes and what each supports.
test("a coordinator sees its own model and only the models the user lists for child Works", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator", "reviewer", "implementer"], { prefix: "alu-native-models-" });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const parent = await trustOnce((trust) => client.create(team.cwd, "Coordinator", "models-create", trust));
  await client.prompt(parent.id, "Which models can child Works use?", "auto", "models-ask");
  (await coordinator.request(0)).tools({ id: "models-unlisted", name: "dock_models", arguments: {} });
  const unlisted = await coordinator.request(1);
  const before = JSON.stringify(unlisted.body.messages);
  assert.ok(before.includes("Your model, which a child Work uses when you omit model: coordinator/fixture"));
  assert.ok(before.includes("has not listed models for child Works"));
  assert.ok(!before.includes("reviewer/fixture") && !before.includes("implementer/fixture"), "Models the user did not list stay out of view");

  // An edit applies on the next call, without a restart.
  await writeFile(join(team.root, "child-models.json"), JSON.stringify({ models: [
    { provider: "coordinator", id: "fixture", note: "MAIN_NOTE" },
    { provider: "implementer", id: "fixture", note: "CHEAP_NOTE" },
    { provider: "ghost", id: "none" },
  ] }));
  unlisted.tools({ id: "models-listed", name: "dock_models", arguments: {} });
  const listed = await coordinator.request(2);
  const after = JSON.stringify(listed.body.messages!.at(-1));
  assert.match(after, /Your model, which a child Work uses when you omit model: coordinator\/fixture · note: \\"MAIN_NOTE\\" · thinking off, minimal, low, medium, high · context 32K tokens · text only/);
  assert.match(after, /- implementer\/fixture · note: \\"CHEAP_NOTE\\" · no thinking levels · context 32K tokens · text only/);
  assert.ok(after.includes("not available on this machine now: ghost/none"));
  assert.ok(!after.includes("reviewer/fixture"), "An available model the user did not list stays out of view");
  listed.text("Child Works can use the listed models.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "The coordinator did not settle");
});
