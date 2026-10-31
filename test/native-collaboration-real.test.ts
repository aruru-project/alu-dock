import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { ProjectTrustCoordinator } from "../src/control/project-trust.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor } from "./support/plan-goal-provider.js";

// Only provider HTTP replies are scripted. Every delegation, message, read and write
// below passes through the production model tool -> Pi -> Worker -> Host path.
test("native coordinator, implementer and independent reviewer collaborate through real Workers", { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-native-team-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const coordinator = new PlanGoalProvider(), implementer = new PlanGoalProvider(), reviewer = new PlanGoalProvider();
  const providers = { coordinator, implementer, reviewer };
  const implementerTools = ["read", "write", "dock_send", "dock_list", "dock_inspect", "dock_watch", "dock_cancel_watch", "dock_create", "dock_spawn", "dock_stop", "dock_interrupt"];
  let host: DockHost | undefined, dock: DockClient | undefined;
  context.after(async () => {
    dock?.closeActiveConnections();
    await host?.stop().catch(() => {});
    await Promise.all(Object.values(providers).map((provider) => provider.stop()));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
  const bugPath = join(cwd, "sum.js");
  await writeFile(bugPath, "export const sum = (a, b) => a - b;\n");
  const models: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(providers)) models[name] = {
    baseUrl: await provider.start(), api: "openai-completions", apiKey: "local-fixture-key",
    models: [{ id: "fixture", name, reasoning: name === "reviewer", input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: models }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "coordinator", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false } }));
  const socketPath = join(root, "dock.sock");
  const workerPids: number[] = [];
  let pauseChild: (() => Promise<void>) | undefined;
  const startHost = async () => {
    const registry = new DockRegistry(async (input) => {
      const instance = await createPiInstance({
      ...input, agentDir, sessionDir,
      onWorkerSpawn: (pid) => workerPids.push(pid),
      workerEnvironment: isolatedProcessEnvironment(home, {
        PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
        npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      }),
      });
      if (input.name === "CleanupFailure") {
        // Inject one supervisor failure without terminating the real Worker.
        const connection = (instance as unknown as { session: { control: (...args: unknown[]) => Promise<unknown>; process: { terminate: () => Promise<void> } } }).session;
        const control = connection.control.bind(connection);
        connection.control = async (...args) => { connection.control = control; throw new Error("Injected graceful cleanup failure"); };
        const terminate = connection.process.terminate.bind(connection.process);
        connection.process.terminate = async () => { connection.process.terminate = terminate; throw new Error("Injected supervisor cleanup failure"); };
      }
      if (input.parentId && pauseChild) { const pause = pauseChild; pauseChild = undefined; await pause(); }
      return instance;
    }, undefined, {
      catalogStore: new FileCatalogStore(join(root, "catalog.json")),
      reopenTargetResolver: { resolve: resolvePiReopenTarget },
      trustPreflight: new ProjectTrustCoordinator({ requiresTrust: () => true, savedDecision: () => null,
        defaultDecision: () => "ask", remember: () => assert.fail("trust_once must not persist project trust") }),
    });
    host = new DockHost({ socketPath, registry, initialize: () => registry.initializeCatalog() });
    await host.start();
    return dock = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 10_000 });
  };
  let client = await startHost();
  const parent = await trustOnce((trust) => client.create(cwd, "Coordinator", "team-create", trust));
  await client.prompt(parent.id, "Delegate implementation and independent review of sum.js.", "auto", "team-start");
  const spawnImplementer = await coordinator.request(0);
  assert.ok(spawnImplementer.toolNames.includes("dock_spawn"));
  assert.ok(!spawnImplementer.toolNames.includes("subagent"));
  spawnImplementer.tools({ id: "spawn-implementer", name: "dock_spawn", arguments: {
    name: "Implementer", task: "Wait for independent review before fixing sum.js.",
    model: { provider: "implementer", id: "fixture" }, thinkingLevel: "off", allowedTools: implementerTools,
  } });
  const implementerFirst = await implementer.request(0);
  const spawnReviewer = await coordinator.request(1);
  spawnReviewer.tools({ id: "spawn-reviewer", name: "dock_spawn", arguments: {
    name: "Reviewer", task: "Independently inspect sum.js and report to Coordinator.",
    model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low", allowedTools: ["read", "dock_send"],
  } });
  const reviewerFirst = await reviewer.request(0);
  let parentWaiting = await coordinator.request(2);
  const team = await client.list();
  const implementerWork = team.find((work) => work.displayName === "Implementer")!;
  const reviewerWork = team.find((work) => work.displayName === "Reviewer")!;
  assert.equal(new Set(workerPids).size, 3, "Each team member runs in its own OS process");
  assert.ok(workerPids.every((pid) => pid !== process.pid));
  for (const [work, provider] of [[implementerWork, "implementer"], [reviewerWork, "reviewer"]] as const) {
    assert.ok(work);
    assert.equal(work.parentId, parent.id);
    assert.deepEqual(work.executor.model, { provider, id: "fixture" });
    assert.equal(work.executor.thinkingLevel, provider === "reviewer" ? "low" : "off");
  }
  assert.deepEqual(reviewerFirst.toolNames.sort(), ["dock_send", "read"]);
  assert.deepEqual(implementerFirst.toolNames.sort(), [...implementerTools].sort());
  assert.ok(JSON.stringify(reviewerFirst.body.messages).includes(parent.id));
  reviewerFirst.tools({ id: "review-read", name: "read", arguments: { path: bugPath } });
  const reviewResult = await reviewer.request(1);
  assert.ok(JSON.stringify(reviewResult.body.messages).includes("a - b"));
  reviewResult.tools({ id: "peer-finding", name: "dock_send", arguments: {
    target: implementerWork.id, message: "REVIEW_FINDING: sum subtracts; change a - b to a + b.",
  } });
  const reviewSent = await reviewer.request(2);
  assert.ok(JSON.stringify(reviewSent.body.messages).includes("missing or ambiguous"), "A child cannot send directly to its sibling");
  assert.equal(implementerFirst.closed, false, "A rejected sibling message must not interrupt work");
  reviewSent.tools({ id: "parent-finding", name: "dock_send", arguments: { target: parent.id, message: "REVIEW_FINDING: sum subtracts; change a - b to a + b." } });
  (await reviewer.request(3)).text("Independent review complete.");
  parentWaiting.text("Waiting for the independent review.");
  const parentFinding = await coordinator.request(3);
  assert.ok(JSON.stringify(parentFinding.body.messages).includes("REVIEW_FINDING"));
  parentFinding.tools({ id: "relay-finding", name: "dock_send", arguments: {
    target: implementerWork.id, message: "REVIEW_FINDING: approved the review; change a - b to a + b.",
  } });
  parentWaiting = await coordinator.request(4);
  assert.equal(implementerFirst.closed, false, "The parent's follow-up queues behind active work");
  implementerFirst.text("Ready to apply the independent finding.");
  const implementerFollowup = await implementer.request(1);
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("REVIEW_FINDING"));
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("Coordinator"));
  implementerFollowup.tools({ id: "fix", name: "write", arguments: { path: bugPath, content: "export const sum = (a, b) => a + b;\n" } });
  (await implementer.request(2)).tools({ id: "report-fix", name: "dock_send", arguments: { target: parent.id, message: "FIX_COMPLETE: sum.js now adds; independent reviewer identified the bug." } });
  (await implementer.request(3)).text("Implementation complete.");
  assert.equal(await readFile(bugPath, "utf8"), "export const sum = (a, b) => a + b;\n");
  parentWaiting.text("Collecting the team's findings.");
  let sawFinding = false, sawFix = false;
  let coordinatorIndex = 5;
  // Messages and completion watches may arrive in different orders. Request a
  // second independent read only after both actual reports reached the coordinator.
  for (; coordinatorIndex < 11 && !(sawFinding && sawFix);) {
    const request = await coordinator.request(coordinatorIndex++);
    const transcript = JSON.stringify(request.body.messages);
    sawFinding ||= transcript.includes("REVIEW_FINDING");
    sawFix ||= transcript.includes("FIX_COMPLETE");
    if (sawFinding && sawFix) {
      request.tools({ id: "request-final-review", name: "dock_send", arguments: {
        target: reviewerWork.id, message: "FINAL_REVIEW_REQUEST: independently reread the corrected sum.js and report whether the fix is correct.",
      } });
    } else request.text("Received team progress.");
  }
  assert.ok(sawFinding && sawFix, "The coordinator must receive the reviewer finding and implementer completion");
  const finalReview = await reviewer.request(4);
  assert.ok(JSON.stringify(finalReview.body.messages).includes("FINAL_REVIEW_REQUEST"));
  finalReview.tools({ id: "final-review-read", name: "read", arguments: { path: bugPath } });
  const correctedRead = await reviewer.request(5);
  const correctedTranscript = JSON.stringify(correctedRead.body.messages);
  assert.ok(correctedTranscript.includes("a + b"), "The independent reviewer must see the actual corrected file, not only the implementer's claim");
  correctedRead.tools({ id: "report-final-review", name: "dock_send", arguments: {
    target: parent.id, message: "FINAL_REVIEW_PASS: independently reread sum.js; the implementation now adds a + b.",
  } });
  (await reviewer.request(6)).text("Final independent review passed.");
  let sawFinalReview = false;
  const finalReviewLimit = coordinatorIndex + 8;
  for (; coordinatorIndex < finalReviewLimit && !sawFinalReview;) {
    const request = await coordinator.request(coordinatorIndex++);
    sawFinalReview = JSON.stringify(request.body.messages).includes("FINAL_REVIEW_PASS");
    request.text(sawFinalReview ? "Implementation and final independent review are complete." : "Waiting for final independent review.");
  }
  assert.ok(sawFinalReview, "The coordinator must receive the final independent review");
  await waitFor(async () => {
    // Completion notifications may trail the explicit peer report. Drain them
    // through the real coordinator instead of assuming a particular queue order.
    while (coordinator.requests.length > coordinatorIndex) {
      coordinator.requests[coordinatorIndex++]!.text("Received remaining team completion notice.");
    }
    return (await client.read(parent.id)).instance.execution === "idle";
  }, "Coordinator did not settle after final review");
  await waitFor(async () => (await client.read(implementerWork.id)).instance.execution === "idle", "Implementer did not settle");
  await waitFor(async () => (await client.read(reviewerWork.id)).instance.execution === "idle", "Reviewer did not settle");

  // Interrupt is a per-Worker action, not a team shutdown. Keep the sibling's
  // genuine provider stream open so an accidental cascade cannot pass unnoticed.
  await client.prompt(implementerWork.id, "Begin another implementation investigation.", "auto", "team-interrupt-work");
  const busyImplementer = await implementer.request(4);
  await client.prompt(reviewerWork.id, "Begin a separate review investigation.", "auto", "team-sibling-work");
  const busyReviewer = await reviewer.request(7);
  assert.equal(busyImplementer.closed, false);
  assert.equal(busyReviewer.closed, false);
  // Review regression: a rejected reopen of an active parent must have no
  // side effects on either child's genuine in-flight model request.
  await assert.rejects(client.reopen(parent.id, "invalid-active-parent-reopen"));
  assert.equal(busyImplementer.closed, false, "Invalid parent reopen must not terminate its implementer");
  assert.equal(busyReviewer.closed, false, "Invalid parent reopen must not terminate its reviewer");
  assert.equal((await client.status(implementerWork.id)).lifecycle, "active");
  assert.equal((await client.status(reviewerWork.id)).lifecycle, "active");
  const interrupted = await client.abort(implementerWork.id, "team-interrupt-child");
  assert.equal(interrupted.instance.lifecycle, "active");
  await waitFor(() => busyImplementer.closed, "Interrupted child did not close its model stream");
  await waitFor(async () => (await client.read(implementerWork.id)).instance.execution === "idle", "Interrupted child did not become idle");
  assert.equal(busyReviewer.closed, false, "Interrupting one child must leave its sibling's live run intact");
  assert.equal((await client.read(reviewerWork.id)).instance.execution, "running");
  assert.equal((await client.read(parent.id)).instance.lifecycle, "active");
  busyReviewer.text("Separate review investigation complete.");
  await waitFor(async () => (await client.read(reviewerWork.id)).instance.execution === "idle", "Sibling did not settle");

  // The child has all relevant tools, so these checks exercise Host scope,
  // not a missing tool grant. User clients can still inspect both children.
  await client.prompt(implementerWork.id, "Check native collaboration scope.", "auto", "scope-probe");
  (await implementer.request(5)).tools({ id: "scope-list", name: "dock_list", arguments: {} });
  const scopeList = await implementer.request(6);
  const listed = JSON.stringify(scopeList.body.messages?.filter(message => message.role === "tool").at(-1));
  assert.ok(listed.includes(parent.id));
  assert.ok(!listed.includes(reviewerWork.id));
  scopeList.tools(
    ...["dock_inspect", "dock_watch", "dock_stop", "dock_interrupt", "dock_send"].map((name, index) => ({
      id: `scope-target-${index}`, name, arguments: { target: reviewerWork.id, ...(name === "dock_send" ? { message: "SHOULD_NOT_DELIVER" } : {}) },
    })),
    { id: "scope-create", name: "dock_create", arguments: { cwd, name: "ForbiddenTopLevel" } },
    { id: "scope-spawn", name: "dock_spawn", arguments: { name: "ForbiddenGrandchild", task: "Do not run" } },
  );
  const scopeResults = await implementer.request(7);
  const failures = scopeResults.body.messages?.filter(message => message.role === "tool").slice(-7) ?? [];
  assert.equal(failures.length, 7);
  for (const failure of failures.slice(0, 5)) assert.match(JSON.stringify(failure), /missing or ambiguous/);
  for (const failure of failures.slice(5)) assert.match(JSON.stringify(failure), /cannot create/);
  scopeResults.tools({ id: "scope-parent", name: "dock_inspect", arguments: { target: parent.id } });
  const parentRead = await implementer.request(8);
  assert.ok(JSON.stringify(parentRead.body.messages?.filter(message => message.role === "tool").at(-1)).includes(parent.id));
  parentRead.text("Native child scope verified.");
  await waitFor(async () => (await client.status(implementerWork.id)).execution === "idle", "Scope probe did not settle");
  assert.equal((await client.status(reviewerWork.id)).lifecycle, "active");
  assert.equal((await client.list()).length, 3);
  await assert.rejects(client.create(cwd, "NestedChild", "nested-client-create", undefined, undefined, undefined, implementerWork.id));

  await client.prompt(parent.id, "Try an unsupported child effort.", "auto", "invalid-effort");
  (await coordinator.request(coordinatorIndex++)).tools({ id: "invalid-effort-spawn", name: "dock_spawn", arguments: {
    name: "InvalidEffort", task: "Should not start", model: { provider: "implementer", id: "fixture" }, thinkingLevel: "high",
  } });
  const invalidEffort = await coordinator.request(coordinatorIndex++);
  assert.match(JSON.stringify(invalidEffort.body.messages?.filter(message => message.role === "tool").at(-1)), /does not support thinking/);
  invalidEffort.text("Invalid configuration was rejected before publishing a child.");
  await waitFor(async () => (await client.status(parent.id)).execution === "idle", "Parent did not settle after invalid configuration");
  assert.equal((await client.list()).length, 3, "Invalid thinking must not leave an empty child");
  await waitFor(() => exited(workerPids.at(-1)!), "Invalid configuration left a bootstrap process alive");

  await client.setModel(reviewerWork.id, "implementer", "fixture", "reviewer-switch-model");
  await client.reloadSession(reviewerWork.id, "reviewer-reload-model");
  assert.equal((await client.status(reviewerWork.id)).executor.model?.provider, "implementer",
    "Creation-time thinking validation must not reapply the original setting after a model switch and reload");

  const sessions = await Promise.all([implementerWork, reviewerWork].map(async child => (await client.status(child.id)).executor.sessionFile!));
  process.kill(workerPids[2]!, "SIGKILL");
  await waitFor(async () => (await client.status(reviewerWork.id)).lifecycle === "runtime_error", "Child crash was not observed");
  assert.equal((await client.status(reviewerWork.id)).reopenable, false, "A temporary child must not offer Continue");
  const pidsBeforeChildReopen = workerPids.length;
  await assert.rejects(client.reopen(reviewerWork.id, "reopen-crashed-child"));
  assert.equal(workerPids.length, pidsBeforeChildReopen, "Child reopen must be rejected before creating a replacement process");
  assert.equal((await client.status(parent.id)).lifecycle, "active");
  const unrelated = await trustOnce(trust => client.create(cwd, "Unrelated", "unrelated-create", trust, undefined, { model: { provider: "coordinator", id: "fixture" } }));
  const unrelatedPid = workerPids.at(-1)!;
  const failedChild = await trustOnce(trust => client.create(cwd, "CleanupFailure", "create-cleanup-failure", trust, undefined, undefined, parent.id));
  const failedChildPid = workerPids.at(-1)!;
  let releaseCreation!: () => void;
  let creationPaused = false;
  const gate = new Promise<void>(resolve => { releaseCreation = resolve; });
  pauseChild = async () => { creationPaused = true; await gate; };
  const racingChild = trustOnce(trust => client.create(cwd, "StopRace", "stop-race-child", trust, undefined, undefined, parent.id));
  void racingChild.catch(() => {});
  await waitFor(() => creationPaused, "Child did not pause during real Worker creation");
  const racingPid = workerPids.at(-1)!;
  let stopSettled = false;
  const stopping = client.stop(parent.id, "team-stop-parent").finally(() => { stopSettled = true; });
  void stopping.catch(() => {});
  await waitFor(() => exited(workerPids[0]!), "Parent process did not stop");
  assert.equal(stopSettled, false, "Parent stop must await its in-flight child creation");
  await assert.rejects(client.reopen(reviewerWork.id, "child-reopen-during-parent-stop"));
  releaseCreation();
  await assert.rejects(racingChild);
  await assert.rejects(stopping);
  await waitFor(() => exited(racingPid), "A child created during stop leaked its process");
  await assert.rejects(client.status(parent.id));
  assert.equal((await client.status(failedChild.id)).lifecycle, "stopping");
  assert.equal(exited(failedChildPid), false, "Failed cleanup must not claim a live process exited");
  assert.ok((await client.list()).some(work => work.id === failedChild.id), "The uncollected child remains discoverable after parent retirement");
  await client.stop(failedChild.id, "retry-child-cleanup");
  await waitFor(() => exited(failedChildPid), "Explicit cleanup retry must really reap the child");
  assert.ok(!(await client.list()).some(work => work.id === failedChild.id));
  for (const pid of workerPids.slice(0, 3)) await waitFor(() => exited(pid), "Stopped team process is still alive");
  for (const child of [implementerWork, reviewerWork]) {
    assert.ok(!(await client.list()).some(work => work.id === child.id), "Collected children disappear from the catalog");
    await assert.rejects(client.reopen(child.id, `reopen-${child.id}`));
  }
  assert.ok((await readFile(sessions[1]!, "utf8")).includes("a + b"));
  assert.equal((await client.status(unrelated.id)).lifecycle, "active");
  assert.equal(exited(unrelatedPid), false);

  // Exercise a real parent crash, then reopen that same Work identity. Old
  // child cleanup must finish before the new generation can delegate again.
  const makeChild = (name: string) => trustOnce(trust => client.create(cwd, name, `create-${name}`, trust, undefined,
    { model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low", toolPolicy: { allowedTools: ["read"] } }, unrelated.id));
  // Persist the parent's session so reopen uses the real saved conversation.
  await client.prompt(unrelated.id, "Persist this parent session.", "auto", "persist-parent");
  (await coordinator.request(coordinatorIndex++)).text("Parent session saved.");
  await waitFor(async () => (await client.status(unrelated.id)).execution === "idle", "Unrelated parent did not settle");
  creationPaused = false;
  const crashGate = new Promise<void>(resolve => { releaseCreation = resolve; });
  pauseChild = async () => { creationPaused = true; await crashGate; };
  const crashCreation = makeChild("CrashChild");
  void crashCreation.catch(() => {});
  await waitFor(() => creationPaused, "Crash child did not enter creation");
  const crashChildPid = workerPids.at(-1)!;
  process.kill(unrelatedPid, "SIGKILL");
  await waitFor(async () => (await client.status(unrelated.id)).lifecycle === "runtime_error", "Parent crash was not observed");
  releaseCreation();
  await assert.rejects(crashCreation);
  await waitFor(() => exited(crashChildPid), "Crashed parent's child process survived");
  await trustOnce(trust => client.reopen(unrelated.id, "reopen-parent", undefined, trust));
  const restartChild = await makeChild("RestartChild");
  const restartChildPid = workerPids.at(-1)!;
  await client.prompt(restartChild.id, "Keep a conversation for later diagnosis.", "auto", "persist-child");
  (await reviewer.request(8)).text("RESTART_CHILD_HISTORY");
  await waitFor(async () => (await client.status(restartChild.id)).execution === "idle", "Restart child did not settle");
  const restartSession = (await client.status(restartChild.id)).executor.sessionFile!;
  assert.equal(exited(restartChildPid), false, "Old generation cleanup must not kill the new child");
  assert.ok(!(await client.list()).some(work => work.displayName === "CrashChild"));
  const countsBeforeStop = Object.values(providers).map(provider => provider.requests.length);
  client.closeActiveConnections();
  await host!.stop();
  await waitFor(() => exited(restartChildPid), "Host shutdown left the child process alive");
  client = await startHost();
  await assert.rejects(client.status(restartChild.id));
  await assert.rejects(client.reopen(restartChild.id, "reopen-retired-child"));
  assert.ok(!(await client.list()).some(work => work.parentId));
  assert.ok((await readFile(restartSession, "utf8")).includes("RESTART_CHILD_HISTORY"));
  assert.equal((await client.status(unrelated.id)).lifecycle, "host_lost");
  assert.deepEqual(Object.values(providers).map(provider => provider.requests.length), countsBeforeStop);
  // Compatibility evidence only: the user has not decided whether this action
  // should remain exposed. A child stopping its owner must finish real cleanup.
  await trustOnce(trust => client.reopen(unrelated.id, "reopen-for-child-stop", undefined, trust));
  const ownerPid = workerPids.at(-1)!;
  await makeChild("StopSibling");
  const siblingPid = workerPids.at(-1)!;
  const stopper = await trustOnce(trust => client.create(cwd, "StopOwner", "create-stop-owner", trust, undefined,
    { model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low", toolPolicy: { allowedTools: ["dock_stop"] } }, unrelated.id));
  const stopperPid = workerPids.at(-1)!;
  await client.prompt(stopper.id, "Stop your owner through Dock.", "auto", "child-stops-owner");
  (await reviewer.request(9)).tools({ id: "stop-owner", name: "dock_stop", arguments: { target: unrelated.id } });
  await waitFor(() => [ownerPid, siblingPid, stopperPid].every(exited), "Child-initiated parent stop did not reap the whole team");
  await waitFor(async () => !(await client.list()).some(work => work.id === unrelated.id || work.parentId === unrelated.id), "Child-initiated parent stop left catalog entries behind");
  assert.equal(await readFile(bugPath, "utf8"), "export const sum = (a, b) => a + b;\n");
});

async function trustOnce<T>(operation: (trust?: { challengeId: string; decision: "trust_once" }) => Promise<T>): Promise<T> {
  let challengeId: string | undefined;
  await assert.rejects(operation(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, "project_trust_required");
    assert.equal(typeof error.details?.challengeId, "string");
    challengeId = error.details!.challengeId as string;
    return true;
  });
  return operation({ challengeId: challengeId!, decision: "trust_once" });
}

function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}
