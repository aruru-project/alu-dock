import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

// Confirmed Plan/Goal safety requirements: planning cannot change project files;
// autonomous work must remain visible, stoppable and within its approved budget.
// The tests enter through DockClient; Host, Worker and Pi are all production code.

async function setup(context: TestContext, options: { boundaryGate?: boolean; probeTools?: boolean; missingAuth?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alu-plan-goal-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const provider = new PlanGoalProvider();
  let host: DockHost | undefined;
  let client: DockClient | undefined;
  const subscriptions: Array<{ close(): void; done: Promise<void> }> = [];
  context.after(async () => {
    for (const subscription of subscriptions) subscription.close();
    await Promise.all(subscriptions.map((subscription) => subscription.done.catch(() => {})));
    client?.closeActiveConnections();
    await host?.stop();
    await provider.stop();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "preparation-fixture.ts"), `
export default function (pi) {
  let starts = 0;
  pi.on("before_agent_start", () => ({ message: {
    customType: "fixture-start-marker", content: "PLAN_GOAL_BEFORE_START_" + (++starts), display: false,
  } }));
}
`);
  const gate = join(root, "hold-boundary"), gateEntered = join(root, "boundary-entered");
  if (options.boundaryGate) {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "boundary-fixture.ts"), `
import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("agent_before_settle", async () => {
    if (!existsSync(${JSON.stringify(gate)})) return;
    writeFileSync(${JSON.stringify(gateEntered)}, "entered");
    for (let attempt = 0; attempt < 500 && existsSync(${JSON.stringify(gate)}); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}
`);
  }
  if (options.probeTools) {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "tool-probes.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.registerTool({ name: "opaque_write", label: "Opaque write", description: "Fixture tool without read-only metadata", parameters: { type: "object", properties: {} },
    execute: async () => { await writeFile(${JSON.stringify(join(cwd, "fixture.txt"))}, "opaque write"); return { content: [{ type: "text", text: "written" }] }; } });
  pi.registerTool({ name: "nested_probe", label: "Nested probe", description: "Exercise the nested tool permission path", annotations: { readOnlyHint: true }, parameters: { type: "object", properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => {
      const outcome = await ctx.executeTool("write", { path: "fixture.txt", content: "nested write" });
      return { content: [{ type: "text", text: outcome.isError ? "Nested write blocked" : "Nested write executed" }] };
    } });
}
`);
  }
  const baseUrl = await provider.start();
  await Promise.all([
    writeFile(join(cwd, "fixture.txt"), "original project contents\n"),
    writeFile(join(cwd, "AGENTS.md"), "Project instruction: PLAN_GOAL_PROJECT_CONTEXT_MARKER\n"),
    writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "plan-goal-loopback": {
      baseUrl, api: "openai-completions", ...(options.missingAuth ? {} : { apiKey: "local-fixture-key" }),
      models: [{ id: "fixture", name: "Plan and Goal fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "plan-goal-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
    })),
  ]);
  const registry = new DockRegistry((input) => createPiInstance({
    ...input, agentDir, sessionDir, projectTrusted: true,
    workerEnvironment: isolatedProcessEnvironment(home, {
      PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
      npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    }),
  }));
  const socketPath = join(root, "dock.sock");
  host = new DockHost({ socketPath, registry });
  await host.start();
  client = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 8_000 });
  const work = await client.create(cwd, "Plan and Goal", "create-plan-goal");
  const dock = client;
  const events: DockEvent[] = [];
  subscriptions.push(await dock.streamEvents(work.id, { onEvent: (event) => events.push(event) }));
  let sequence = 0;
  const submit = async (text: string) => {
    const operationId = `plan-goal-input-${++sequence}`;
    const result = await dock.prompt(work.id, text, "auto", operationId);
    return { ...result, operationId };
  };
  const start = async (text: string) => {
    const result = await submit(text);
    assert.equal(result.receipt.kind, "extension_command", `${text} is available on a new Work`);
    // Run-starting commands do not emit command.handled. Their callers await
    // the actual provider request instead, so a held response cannot deadlock.
    return result;
  };
  const command = async (text: string) => {
    const result = await start(text);
    await waitFor(() => events.some((event) => event.type === "command.handled" && event.data.operationId === result.operationId), `${text} did not finish`);
    return result;
  };
  const idle = async () => waitFor(async () => (await dock.read(work.id)).instance.execution === "idle", "Work did not become idle");
  const surface = async () => Object.values((await dock.read(work.id)).instance.extensionStatus).join("\n");
  return { root, cwd, gate, gateEntered, dock, work, provider, events, subscriptions, submit, start, command, idle, surface };
}

function assertPrepared(request: HeldChatRequest, start: number): void {
  const messages = JSON.stringify(request.body.messages);
  assert.ok(messages.includes("PLAN_GOAL_PROJECT_CONTEXT_MARKER"), "User-triggered work receives the project's AGENTS.md instructions");
  assert.ok(messages.includes(`PLAN_GOAL_BEFORE_START_${start}`), `User-triggered work runs before_agent_start for prepared request ${start}`);
}

test("Plan is available immediately, protects project files, and executes only the current approved plan", { timeout: 30_000 }, async (context) => {
  const h = await setup(context, { probeTools: true });
  const names = (await h.dock.commands(h.work.id)).commands.map((command) => command.name);
  assert.ok(names.includes("plan") && names.includes("goal"));
  const dialogs: Array<Extract<DockEvent, { type: "interaction.requested" }>> = [];
  const controller = await h.dock.controlExtensionUi(h.work.id, (event) => { if (event.type === "interaction.requested") dialogs.push(event); });
  h.subscriptions.push(controller);
  const nextDialog = async (index: number, method: "editor" | "confirm") => {
    await waitFor(() => dialogs.length > index, `${method} did not open`);
    const dialog = dialogs[index]!;
    assert.equal(dialog.data.method, method);
    return dialog;
  };
  const respond = (dialog: (typeof dialogs)[number], response: Parameters<DockClient["respondInteraction"]>[3]) =>
    h.dock.respondInteraction(h.work.id, controller.initial.leaseToken, dialog.data.interactionId, response);
  const draftA = "Inspect fixture.txt, then write the approved report.";
  const draftB = "Inspect fixture.txt, then write a human-reviewed report.";
  const draftC = "Inspect fixture.txt, then write the latest reviewed report.";

  await h.start("/plan on Prepare a report without changing project files");
  const first = await h.provider.request(0);
  assertPrepared(first, 1);
  for (const name of ["plan_update", "read", "ls", "find", "grep"]) assert.ok(first.toolNames.includes(name), `Plan exposes ${name} to the actual model request`);
  first.tools(
    { id: "plan-read", name: "read", arguments: { path: "fixture.txt" } },
    { id: "plan-write", name: "write", arguments: { path: "fixture.txt", content: "unapproved write" } },
    { id: "plan-bash", name: "bash", arguments: { command: "printf unapproved > fixture.txt" } },
    { id: "plan-opaque", name: "opaque_write", arguments: {} },
    { id: "plan-nested", name: "nested_probe", arguments: {} },
    { id: "plan-update", name: "plan_update", arguments: { content: draftA } },
  );
  (await h.provider.request(1)).text("The plan is ready for review.");
  await h.idle();
  assert.equal(await readFile(join(h.cwd, "fixture.txt"), "utf8"), "original project contents\n");
  for (const callId of ["plan-write", "plan-bash", "plan-opaque"]) {
    assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === callId && event.data.isError), `${callId} cannot change files during Plan`);
  }
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "plan-read" && !event.data.isError && event.data.text.includes("original project contents")));
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "plan-nested" && event.data.text.includes("Nested write blocked")), "Nested tool execution uses the same planning safety gate");
  assert.match(await h.surface(), /规划中/);
  assert.ok(h.events.some((event) => event.type === "extension.widget_changed" && event.data.key === "alu-dock-plan" && event.data.lines?.join("\n").includes(draftA)));

  const edit = await h.submit("/plan edit");
  const editor = await nextDialog(0, "editor");
  assert.ok(editor.data.method === "editor");
  assert.equal(editor.data.prefill, draftA);
  await respond(editor, { method: "editor", value: draftB });
  await waitFor(() => h.events.some((event) => event.type === "command.handled" && event.data.operationId === edit.operationId), "Plan edit did not finish");

  await h.submit("Revise the last step while I review the current plan.");
  const revision = await h.provider.request(2);
  assertPrepared(revision, 2);
  await h.submit("/plan apply");
  const oldApproval = await nextDialog(1, "confirm");
  assert.ok(oldApproval.data.method === "confirm");
  assert.ok(oldApproval.data.message.includes(draftB));
  revision.tools({ id: "new-plan-version", name: "plan_update", arguments: { content: draftC } });
  const revisionResult = await h.provider.request(3);
  await respond(oldApproval, { method: "confirm", confirmed: true });
  await waitFor(() => h.events.some((event) => event.type === "extension.notification" && /计划.*(?:改变|更新|变化)|重新.*(?:确认|审批|批准)/.test(event.data.message)), "A changed plan must ask for a fresh approval");
  assert.match(await h.surface(), /规划中/);
  // The current revision can be approved while the old planning reply is still
  // running, but that old reply must end before execution permissions change.
  await h.submit("/plan apply");
  const approval = await nextDialog(2, "confirm");
  assert.ok(approval.data.method === "confirm");
  assert.ok(approval.data.message.includes(draftC));
  await respond(approval, { method: "confirm", confirmed: true });
  const execution = await h.provider.request(4);
  assertPrepared(execution, 3);
  assert.equal(revisionResult.closed, true, "The old planning response ends before the approved execution request starts");
  assert.ok(JSON.stringify(execution.body.messages).includes(draftC));
  execution.tools({ id: "approved-write", name: "write", arguments: { path: "approved.txt", content: "approved report" } });
  (await h.provider.request(5)).text("The approved report is written.");
  await h.idle();
  assert.equal(await readFile(join(h.cwd, "approved.txt"), "utf8"), "approved report");
  assert.match(await h.surface(), /已批准/);
  assert.equal(h.provider.requests.length, 6, "Plan approval starts one normal run, without enabling autonomous Goal rounds");
  await h.command("/plan on");
  await h.command("/plan off");
  assert.doesNotMatch(await h.surface(), /规划中/);
});

test("Goal counts scheduled rounds rather than tool turns and reports budget, completion, and blockers", { timeout: 30_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal start --rounds 2 --minutes 2 Inspect the fixture in two stages");
  const initialGoal = await h.provider.request(0);
  assertPrepared(initialGoal, 1);
  initialGoal.tools(
    { id: "goal-expand-scope", name: "goal_update", arguments: { status: "progress", summary: "Change my assignment", objective: "Deploy unrelated work", maxRounds: 100 } },
    { id: "goal-progress", name: "goal_update", arguments: { status: "progress", summary: "First stage inspected" } },
  );
  (await h.provider.request(1)).text("First stage finished; the second stage remains.");
  const nextRound = await h.provider.request(2);
  assertPrepared(nextRound, 1);
  assert.equal(JSON.stringify(nextRound.body.messages).includes("PLAN_GOAL_BEFORE_START_2"), false, "Automatic continuation keeps the prepared context instead of inventing a new human start");
  assert.ok(JSON.stringify(nextRound.body.messages).includes("Inspect the fixture in two stages"));
  nextRound.tools({ id: "goal-read", name: "read", arguments: { path: "fixture.txt" } });
  (await h.provider.request(3)).text("The final allowed stage is finished.");
  await h.idle();
  assert.match(await h.surface(), /预算用尽/);
  assert.match(await h.surface(), /2\s*\/\s*2/);
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "goal-expand-scope" && event.data.isError), "A model cannot replace the human objective or increase its spending budget");
  assert.equal(h.provider.requests.length, 4, "The two scheduled rounds include their natural tool-result turns");

  await h.start("/goal start --rounds 5 --minutes 2 Confirm the fixture is present");
  const completionGoal = await h.provider.request(4);
  assertPrepared(completionGoal, 2);
  completionGoal.tools({ id: "goal-complete", name: "goal_update", arguments: {
    status: "complete", summary: "Fixture verified", evidence: ["fixture.txt contains the expected contents"],
  } });
  (await h.provider.request(5)).text("Fixture verified.");
  await h.idle();
  assert.match(await h.surface(), /已完成/);
  assert.match(await h.surface(), /1\s*\/\s*5/);
  assert.ok(h.events.some((event) => event.type === "extension.widget_changed" && event.data.key === "alu-dock-goal" && event.data.lines?.join("\n").includes("fixture.txt contains the expected contents")), "The person can inspect the model's recorded delivery evidence");
  await h.command("/goal status");
  assert.ok(h.events.some((event) => event.type === "extension.notification" && event.data.message.includes("Fixture verified")));
  assert.equal(h.provider.requests.length, 6, "A completed Goal does not spend its remaining rounds");

  await h.start("/goal start --rounds 5 --minutes 2 Wait for missing requirements");
  const blockedGoal = await h.provider.request(6);
  assertPrepared(blockedGoal, 3);
  blockedGoal.tools({ id: "goal-blocked", name: "goal_update", arguments: { status: "blocked", summary: "Need the report format" } });
  (await h.provider.request(7)).text("Please choose the report format.");
  await h.idle();
  assert.match(await h.surface(), /受阻/);
  assert.equal(h.provider.requests.length, 8, "Blocked work stops for the person to decide");

  const unavailable = await setup(context, { missingAuth: true });
  await unavailable.start("/goal start --rounds 2 --minutes 2 Inspect after model access is configured");
  await waitFor(async () => /受阻/.test(await unavailable.surface()), "Missing model access did not leave a clear blocked Goal");
  await unavailable.idle();
  assert.match(await unavailable.surface(), /0\s*\/\s*2/);
  assert.equal(unavailable.provider.requests.length, 0, "Failed prompt preparation does not consume a Goal round or call a provider");
});

test("Goal defaults to ten rounds and its minute deadline stops a running native response", { timeout: 30_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal start --minutes 2 Continue the approved inspection");
  for (let index = 0; index < 10; index += 1) {
    (await h.provider.request(index * 2)).tools({ id: `default-progress-${index}`, name: "goal_update", arguments: {
      status: "progress", summary: `Inspection stage ${index + 1} completed; work remains`,
    } });
    (await h.provider.request(index * 2 + 1)).text("This inspection still has work remaining.");
  }
  await h.idle();
  assert.match(await h.surface(), /预算用尽/);
  assert.match(await h.surface(), /10\s*\/\s*10/);
  assert.equal(h.provider.requests.length, 20, "Default autonomous spending is ten scheduled rounds including the first");

  await h.start("/goal start --rounds 10 --minutes 0.01 Stop this inspection at its deadline");
  const held = await h.provider.request(20);
  await waitFor(() => held.closed, "The minute deadline did not stop the native provider request");
  await h.idle();
  assert.match(await h.surface(), /预算用尽/);
  assert.equal(h.provider.requests.length, 21, "The elapsed deadline prevents a further automatic round");
});

test("A person can pause, stop, supplement, and cancel Goal work while ordinary chat preserves the chosen state", { timeout: 30_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal start --rounds 4 --minutes 2 Inspect the approved project");
  const pausedRequest = await h.provider.request(0);
  assertPrepared(pausedRequest, 1);
  await h.command("/goal pause");
  await waitFor(() => pausedRequest.closed, "Pause did not stop the native model response");
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /1\s*\/\s*4/);

  await h.submit("Explain the inspection steps while the Goal stays paused.");
  const ordinaryChat = await h.provider.request(1);
  assertPrepared(ordinaryChat, 2);
  ordinaryChat.text("These are the proposed inspection steps.");
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /1\s*\/\s*4/);
  assert.equal(h.provider.requests.length, 2, "Ordinary chat does not rearm a paused Goal");

  await h.start("/goal resume");
  const stoppedRequest = await h.provider.request(2);
  assertPrepared(stoppedRequest, 3);
  await h.dock.abort(h.work.id);
  await waitFor(() => stoppedRequest.closed, "Native Stop did not stop the Goal response");
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*4/);

  await h.start("/goal resume");
  const activeRequest = await h.provider.request(3);
  assertPrepared(activeRequest, 4);
  const input = "Include fixture.txt in this inspection and explain what it contains.";
  await h.submit(input);
  activeRequest.text("The current inspection step has ended.");
  const userRequest = await h.provider.request(4);
  assert.ok(JSON.stringify(userRequest.body.messages).includes(input));
  userRequest.tools({ id: "supplement-complete", name: "goal_update", arguments: {
    status: "complete", summary: "The supplemented inspection is delivered", evidence: ["fixture.txt reviewed with the requested explanation"],
  } });
  (await h.provider.request(5)).text("The inspection includes the requested file explanation.");
  await h.idle();
  assert.match(await h.surface(), /已完成/);
  assert.match(await h.surface(), /3\s*\/\s*4/);
  assert.equal(h.provider.requests.length, 6, "A supplement is handled within the current authorized Goal round");

  await h.start("/goal start --rounds 2 --minutes 2 Inspect an optional appendix");
  const cancelledRequest = await h.provider.request(6);
  await h.command("/goal cancel");
  await waitFor(() => cancelledRequest.closed, "Cancel did not stop the native model response");
  await h.idle();
  assert.match(await h.surface(), /已取消/);
});

test("Reload, fork, and tree navigation retain the selected Goal budget and wait for explicit resume", { timeout: 30_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal start --rounds 3 --minutes 2 Inspect this branch in stages");
  const first = await h.provider.request(0);
  const earlyLeaf = (await h.dock.tree(h.work.id)).leafId;
  assert.ok(earlyLeaf, "The running Goal has a navigable history point");
  first.text("One inspection stage is complete.");
  const second = await h.provider.request(1);
  await h.command("/goal pause");
  await waitFor(() => second.closed, "Pause did not stop the second stage");
  await h.idle();
  assert.match(await h.surface(), /2\s*\/\s*3/);

  await h.submit("Bookmark this branch before exploring an alternative.");
  (await h.provider.request(2)).text("The branch is ready to explore.");
  await h.idle();
  const sourceFile = (await h.dock.read(h.work.id)).instance.executor.sessionFile;
  assert.ok(sourceFile);
  const bookmark = (await h.dock.tree(h.work.id)).nodes.findLast((node) => node.kind === "message" && node.role === "user");
  assert.ok(bookmark);

  await h.dock.reloadSession(h.work.id);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 3, "Reloading saved work does not authorize another round");

  await h.dock.forkSession(h.work.id, bookmark.entryId);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 3, "Forking saved work does not authorize another round");
  await h.start("/goal resume");
  (await h.provider.request(3)).text("The last allowed stage in the fork is complete.");
  await h.idle();
  assert.match(await h.surface(), /预算用尽/);
  assert.match(await h.surface(), /3\s*\/\s*3/);

  await h.dock.switchSession(h.work.id, sourceFile);
  await h.dock.navigateSession(h.work.id, earlyLeaf);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /1\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 4, "Selecting earlier active Goal history requires renewed execution intent");
  await h.start("/goal resume");
  (await h.provider.request(4)).text("The resumed branch has one more stage.");
  (await h.provider.request(5)).text("The resumed branch has reached its original limit.");
  await h.idle();
  assert.match(await h.surface(), /预算用尽/);
  assert.match(await h.surface(), /3\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 6, "Resume keeps the selected branch's original three-round budget");
});

// The disk fixture runs before the inline Goal handler. It holds pre-settle
// before Goal proposes a continuation, not after a proposal has been returned.
// A person's pause or queued input must win at this explicit safety boundary.
test("Pause and new human input take priority while a Goal is deciding whether to continue", { timeout: 30_000 }, async (context) => {
  const h = await setup(context, { boundaryGate: true });
  const arm = async () => {
    await rm(h.gateEntered, { force: true });
    await writeFile(h.gate, "hold");
  };
  const atBoundary = () => waitFor(async () => readFile(h.gateEntered, "utf8").then(() => true, () => false), "Pi did not reach the held continuation boundary");
  const release = () => rm(h.gate, { force: true });
  try {
    await h.start("/goal start --rounds 3 --minutes 2 Inspect before continuing");
    const first = await h.provider.request(0);
    await arm();
    first.text("The first inspection stage is complete.");
    await atBoundary();
    await h.command("/goal pause");
    await release();
    await h.idle();
    assert.match(await h.surface(), /已暂停/);
    assert.equal(h.provider.requests.length, 1, "Pause takes effect even between native rounds");

    await h.start("/goal start --rounds 3 --minutes 2 Continue only while this remains my task");
    const second = await h.provider.request(1);
    await arm();
    second.text("The first stage has ended.");
    await atBoundary();
    const input = "Include the fixture contents in this same inspection before continuing.";
    await h.submit(input);
    await release();
    const userRequest = await h.provider.request(2);
    assert.ok(JSON.stringify(userRequest.body.messages).includes(input));
    userRequest.tools({ id: "boundary-complete", name: "goal_update", arguments: {
      status: "complete", summary: "The supplemented inspection is complete", evidence: ["The requested fixture details are included"],
    } });
    (await h.provider.request(3)).text("This inspection includes the requested fixture details.");
    await h.idle();
    assert.match(await h.surface(), /已完成/);
    assert.match(await h.surface(), /1\s*\/\s*3/);
    assert.equal(h.provider.requests.length, 4, "Queued human input takes priority while preserving the authorized Goal");

    await h.start("/goal start --rounds 3 --minutes 2 Inspect the original assignment");
    const original = await h.provider.request(4);
    await arm();
    original.text("The original assignment reached its continuation boundary.");
    await atBoundary();
    const replacement = await h.submit("/goal start --rounds 3 --minutes 2 Inspect the proposed replacement");
    await waitFor(async () => /已暂停/.test(await h.surface()), "The replacement did not wait for the previous run to stop");
    await h.command("/goal cancel");
    await release();
    await waitFor(() => h.events.some((event) => event.type === "command.handled" && event.data.operationId === replacement.operationId), "The cancelled replacement command did not finish");
    await h.idle();
    assert.match(await h.surface(), /已取消/);
    assert.equal(h.provider.requests.length, 5, "Cancelling while a new Goal waits for the old run prevents that replacement from starting");
  } finally {
    await release();
  }
});
