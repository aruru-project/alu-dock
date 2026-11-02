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
import type { DockToolsRequest } from "../src/core/dock-tools.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor } from "./support/plan-goal-provider.js";

// Only provider HTTP replies are scripted. Every delegation, message, read and write
// below passes through the production model tool -> Pi -> Worker -> Host path.
test("a coordinator delegates to an implementer and an independent reviewer and hears each one's reply", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-native-team-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const coordinator = new PlanGoalProvider(), implementer = new PlanGoalProvider(), reviewer = new PlanGoalProvider();
  const providers = { coordinator, implementer, reviewer };
  let host: DockHost | undefined, dock: DockClient | undefined, registry: DockRegistry | undefined;
  let releaseHeldHelper: (() => void) | undefined;
  context.after(async () => {
    releaseHeldHelper?.();
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
    models: [{ id: "fixture", name, reasoning: name !== "implementer", input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: models }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "coordinator", defaultModel: "fixture", defaultThinkingLevel: "high", compaction: { enabled: false }, retry: { enabled: false } }));
  const socketPath = join(root, "dock.sock");
  const workerPids: number[] = [];
  // Holds one helper after its Worker process started, before Dock lists it.
  let holdNextHelper: (() => Promise<void>) | undefined;
  const startHost = async () => {
    registry = new DockRegistry(async (input) => {
      const instance = await createPiInstance({
        ...input, agentDir, sessionDir,
        onWorkerSpawn: (pid) => workerPids.push(pid),
        workerEnvironment: isolatedProcessEnvironment(home, {
          PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
          npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
        }),
      });
      const hold = input.parentId === undefined ? undefined : holdNextHelper;
      holdNextHelper = undefined;
      await hold?.();
      return instance;
    }, undefined, {
      catalogStore: new FileCatalogStore(join(root, "catalog.json")),
      reopenTargetResolver: { resolve: resolvePiReopenTarget },
      trustPreflight: new ProjectTrustCoordinator({ requiresTrust: () => true, savedDecision: () => null,
        defaultDecision: () => "ask", remember: () => assert.fail("trust_once must not persist project trust") }),
    });
    const owned = registry;
    host = new DockHost({ socketPath, registry: owned, initialize: () => owned.initializeCatalog() });
    await host.start();
    return dock = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 10_000 });
  };
  let client = await startHost();

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
  const team = await client.list();
  const implementerWork = team.find((work) => work.displayName === "Implementer")!;
  const reviewerWork = team.find((work) => work.displayName === "Reviewer")!;
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
  await client.prompt(implementerWork.id, "Ask your coordinator whether tests are needed.", "auto", "child-question");
  (await implementer.request(3)).tools({ id: "ask-parent", name: "dock_send", arguments: { message: "CHILD_QUESTION: add tests too?" } });
  const question = await coordinator.request(8);
  assert.ok(JSON.stringify(question.body.messages).includes("CHILD_QUESTION"));
  assert.ok(JSON.stringify(question.body.messages).includes("Agent message from \\\"Implementer\\\""));
  question.text("No tests are needed.");
  (await implementer.request(4)).text("Asked the coordinator.");
  await waitFor(async () => (await client.status(implementerWork.id)).execution === "idle", "Implementer did not settle after asking");

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
  for (const request of denied) await assert.rejects(registry!.invokeDockTool(implementerWork.id, request), /can only message/);
  await assert.rejects(client.create(cwd, "Nested", "nested-child", undefined, undefined, undefined, { parentId: implementerWork.id }), /top-level/);
  // Another top-level Work neither sees nor reaches the coordinator's helpers.
  const unrelated = await trustOnce((trust) => client.create(cwd, "Unrelated", "unrelated-create", trust));
  const unrelatedPid = workerPids.at(-1)!;
  const unrelatedList = await registry!.invokeDockTool(unrelated.id, { type: "list" });
  assert.ok(unrelatedList.type === "list");
  assert.deepEqual(unrelatedList.result.instances.map((status) => status.id), [parent.id]);
  await assert.rejects(registry!.invokeDockTool(unrelated.id, { type: "inspect", target: implementerWork.id }), /missing or ambiguous/);

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
  holdNextHelper = () => new Promise<void>((resolve) => { held = true; releaseHeldHelper = resolve; });
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
  (await coordinator.request(9)).text("Noted.");
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
  await host!.stop();
  await waitFor(() => exited(restartChildPid), "Host shutdown left the helper process alive");
  client = await startHost();
  await assert.rejects(client.status(restartChild.id));
  assert.ok(!(await client.list()).some((work) => work.parentId !== undefined));
  assert.equal((await client.status(unrelated.id)).lifecycle, "host_lost");
  assert.ok((await readFile(restartSession, "utf8")).includes("RESTART_CHILD_HISTORY"));
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
