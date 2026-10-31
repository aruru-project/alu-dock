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
  const startHost = async () => {
    const registry = new DockRegistry((input) => createPiInstance({
      ...input, agentDir, sessionDir,
      onWorkerSpawn: (pid) => workerPids.push(pid),
      workerEnvironment: isolatedProcessEnvironment(home, {
        PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
        npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      }),
    }), undefined, {
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
    model: { provider: "implementer", id: "fixture" }, thinkingLevel: "off", allowedTools: ["read", "write", "dock_send"],
  } });
  const implementerFirst = await implementer.request(0);
  const spawnReviewer = await coordinator.request(1);
  spawnReviewer.tools({ id: "spawn-reviewer", name: "dock_spawn", arguments: {
    name: "Reviewer", task: "Independently inspect sum.js. Send the finding to Implementer and Coordinator.",
    model: { provider: "reviewer", id: "fixture" }, thinkingLevel: "low", allowedTools: ["read", "dock_send"],
  } });
  const reviewerFirst = await reviewer.request(0);
  const parentWaiting = await coordinator.request(2);
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
  assert.deepEqual(implementerFirst.toolNames.sort(), ["dock_send", "read", "write"]);
  assert.ok(JSON.stringify(reviewerFirst.body.messages).includes(parent.id));
  reviewerFirst.tools({ id: "review-read", name: "read", arguments: { path: bugPath } });
  const reviewResult = await reviewer.request(1);
  assert.ok(JSON.stringify(reviewResult.body.messages).includes("a - b"));
  reviewResult.tools({ id: "peer-finding", name: "dock_send", arguments: {
    target: implementerWork.id, message: "REVIEW_FINDING: sum subtracts; change a - b to a + b.",
  } });
  const reviewSent = await reviewer.request(2);
  assert.equal(implementerFirst.closed, false, "An ordinary peer message must not interrupt active work");
  reviewSent.tools({ id: "parent-finding", name: "dock_send", arguments: { target: parent.id, message: "REVIEW_FINDING: subtraction bug found; implementer notified." } });
  (await reviewer.request(3)).text("Independent review complete.");
  implementerFirst.text("Ready to apply the independent finding.");
  const implementerFollowup = await implementer.request(1);
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("REVIEW_FINDING"));
  assert.ok(JSON.stringify(implementerFollowup.body.messages).includes("Reviewer"));
  implementerFollowup.tools({ id: "fix", name: "write", arguments: { path: bugPath, content: "export const sum = (a, b) => a + b;\n" } });
  (await implementer.request(2)).tools({ id: "report-fix", name: "dock_send", arguments: { target: parent.id, message: "FIX_COMPLETE: sum.js now adds; independent reviewer identified the bug." } });
  (await implementer.request(3)).text("Implementation complete.");
  assert.equal(await readFile(bugPath, "utf8"), "export const sum = (a, b) => a + b;\n");
  parentWaiting.text("Collecting the team's findings.");
  let sawFinding = false, sawFix = false;
  let coordinatorIndex = 3;
  // Messages and completion watches may arrive in different orders. Request a
  // second independent read only after both actual reports reached the coordinator.
  for (; coordinatorIndex < 9 && !(sawFinding && sawFix);) {
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
  const interrupted = await client.abort(implementerWork.id, "team-interrupt-child");
  assert.equal(interrupted.instance.lifecycle, "active");
  await waitFor(() => busyImplementer.closed, "Interrupted child did not close its model stream");
  await waitFor(async () => (await client.read(implementerWork.id)).instance.execution === "idle", "Interrupted child did not become idle");
  assert.equal(busyReviewer.closed, false, "Interrupting one child must leave its sibling's live run intact");
  assert.equal((await client.read(reviewerWork.id)).instance.execution, "running");
  assert.equal((await client.read(parent.id)).instance.lifecycle, "active");
  busyReviewer.text("Separate review investigation complete.");
  await waitFor(async () => (await client.read(reviewerWork.id)).instance.execution === "idle", "Sibling did not settle");

  // A real Host restart must retain relationships, sessions and explicit grants
  // without persisting trust_once or replaying the team's completed model work.
  await client.prompt(reviewerWork.id, "/dock-tools off", "auto", "reviewer-opt-out");
  await waitFor(async () => !(await client.tools(reviewerWork.id)).tools.some((tool) => tool.name === "dock_send" && tool.active), "Reviewer opt-out did not take effect");
  const countsBeforeStop = Object.values(providers).map((provider) => provider.requests.length);
  client.closeActiveConnections();
  await host!.stop();
  client = await startHost();
  for (const work of [parent, implementerWork, reviewerWork]) {
    assert.equal((await client.status(work.id)).lifecycle, "host_lost");
    await trustOnce((trust) => client.reopen(work.id, `reopen-${work.id}`, undefined, trust));
  }
  assert.equal(new Set(workerPids).size, 6);
  for (const child of [implementerWork, reviewerWork]) {
    const restored = await client.status(child.id);
    assert.equal(restored.parentId, parent.id);
    assert.deepEqual(restored.executor.model, child.executor.model);
    assert.equal(restored.executor.thinkingLevel, child.executor.thinkingLevel);
  }
  assert.deepEqual((await client.tools(implementerWork.id)).tools.map((tool) => tool.name).sort(), ["dock_send", "read", "write"]);
  assert.deepEqual((await client.tools(reviewerWork.id)).tools.filter((tool) => tool.active).map((tool) => tool.name), ["read"]);
  await client.prompt(reviewerWork.id, "/dock-tools on", "auto", "reviewer-opt-in");
  await waitFor(async () => (await client.tools(reviewerWork.id)).tools.some((tool) => tool.name === "dock_send" && tool.active), "Reviewer opt-in did not take effect");
  assert.deepEqual((await client.tools(reviewerWork.id)).tools.filter((tool) => tool.active).map((tool) => tool.name).sort(), ["dock_send", "read"]);
  assert.ok(JSON.stringify((await client.history(reviewerWork.id)).entries).includes("a + b"));
  assert.deepEqual(Object.values(providers).map((provider) => provider.requests.length), countsBeforeStop);
  const parentStopped = await client.stop(parent.id, "team-stop-parent");
  assert.equal(parentStopped.instance.lifecycle, "stopped");
  for (const child of [implementerWork, reviewerWork]) {
    const snapshot = (await client.read(child.id)).instance;
    assert.equal(snapshot.lifecycle, "active", "Stopping a parent does not silently stop an independent child");
    assert.equal(snapshot.execution, "idle");
  }
  for (const child of [implementerWork, reviewerWork]) {
    const stopped = await client.stop(child.id, `team-stop-${child.id}`);
    assert.equal(stopped.instance.lifecycle, "stopped");
  }
  assert.deepEqual(Object.values(providers).map((provider) => provider.requests.length), countsBeforeStop,
    "Interrupt and explicit stop cleanup must not replay completed tasks or start another model turn");
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
