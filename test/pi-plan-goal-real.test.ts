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

// One real-entry journey each for Plan, Goal, and coming back to saved work.
// Only the model transport is fake; Dock, Host, Worker and Pi run normally.
// Requirements confirmed in PR #1: planning cannot change project files, the
// person approves the full plan, and automatic work stays visible, stoppable
// and within its round budget.
type Dialog = Extract<DockEvent, { type: "interaction.requested" }>["data"];

async function setup(context: TestContext, options: { probeTools?: boolean; preparationGate?: boolean; codemodeOnlyMcp?: boolean; missingAuth?: boolean } = {}) {
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
  await mkdir(join(agentDir, "extensions"));
  // While the hold file exists, every request waits in Pi's preparation step.
  const hold = join(root, "hold-preparation"), preparing = join(root, "preparing");
  if (options.preparationGate) {
    await writeFile(join(agentDir, "extensions", "preparation-gate.ts"), `
import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_agent_start", async () => {
    if (!existsSync(${JSON.stringify(hold)})) return;
    writeFileSync(${JSON.stringify(preparing)}, "");
    while (existsSync(${JSON.stringify(hold)})) await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
`);
  }
  if (options.probeTools) {
    await writeFile(join(agentDir, "extensions", "tool-probes.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.registerTool({ name: "opaque_write", label: "Opaque write", description: "Fixture deferred write tool", exposure: "deferred", parameters: { type: "object", properties: {} },
    execute: async () => { await writeFile(${JSON.stringify(join(cwd, "fixture.txt"))}, "opaque write"); return { content: [{ type: "text", text: "written" }] }; } });
  pi.registerTool({ name: "codemode_read", label: "Codemode read", description: "Fixture on-demand read tool", exposure: "codemode", annotations: { readOnlyHint: true }, parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "read on demand" }] }) });
  pi.registerTool({ name: "nested_probe", label: "Nested probe", description: "Exercise the nested tool permission path", annotations: { readOnlyHint: true }, parameters: { type: "object", properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => {
      const outcome = await ctx.executeTool("opaque_write", {});
      return { content: [{ type: "text", text: outcome.isError ? "Nested write blocked" : "Nested write executed" }] };
    } });
}
`);
  }
  const baseUrl = await provider.start();
  await Promise.all([
    writeFile(join(cwd, "fixture.txt"), "original project contents\n"),
    writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "plan-goal-loopback": {
      baseUrl, api: "openai-completions", ...(options.missingAuth ? {} : { apiKey: "local-fixture-key" }),
      models: [{ id: "fixture", name: "Plan and Goal fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "plan-goal-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
      ...(options.codemodeOnlyMcp ? { codemode: { mode: "only" } } : {}),
    })),
    // An MCP server whose tools are reached through codemode, as Pi's MCP sets up by default.
    ...(options.codemodeOnlyMcp ? [
      writeFile(join(root, "harbor-mcp.mjs"), MCP_SERVER),
      writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { harbor: { command: process.execPath, args: [join(root, "harbor-mcp.mjs")] } } })),
    ] : []),
  ]);
  const registry = new DockRegistry((input) => createPiInstance({
    ...input, agentDir, sessionDir, projectTrusted: true,
    workerEnvironment: isolatedProcessEnvironment(home, {
      PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
      npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    }),
  }));
  host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  await host.start();
  const dock = client = new DockClient({ socketPath: join(root, "dock.sock"), timeoutMs: 5_000, longMutationTimeoutMs: 8_000 });
  const work = await dock.create(cwd, "Plan and Goal", "create-plan-goal");
  const events: DockEvent[] = [];
  subscriptions.push(await dock.streamEvents(work.id, { onEvent: (event) => events.push(event) }));
  let sequence = 0, requestIndex = 0;
  const submit = (text: string) => dock.prompt(work.id, text, "auto", `plan-goal-input-${++sequence}`);
  const start = async (text: string) => {
    const result = await submit(text);
    assert.equal(result.receipt.kind, "extension_command", `${text} is available on this Work`);
  };
  const idle = () => waitFor(async () => (await dock.read(work.id)).instance.execution === "idle", "Work did not become idle");
  const surface = async () => Object.values((await dock.read(work.id)).instance.extensionStatus).join("\n");
  const request = () => provider.request(requestIndex++);
  const ui = async () => {
    const dialogs: Dialog[] = [];
    let index = 0;
    const controller = await dock.controlExtensionUi(work.id, (event) => { if (event.type === "interaction.requested") dialogs.push(event.data); });
    subscriptions.push(controller);
    const next = async <M extends Dialog["method"]>(method: M): Promise<Extract<Dialog, { method: M }>> => {
      await waitFor(() => dialogs.length > index, `${method} did not open`);
      const dialog = dialogs[index++]!;
      assert.equal(dialog.method, method);
      return dialog as Extract<Dialog, { method: M }>;
    };
    const respond = (dialog: Dialog, response: Parameters<DockClient["respondInteraction"]>[3]) =>
      dock.respondInteraction(work.id, controller.initial.leaseToken, dialog.interactionId, response);
    const choose = async (choice: string) => {
      const dialog = await next("select");
      assert.ok(dialog.options.includes(choice), `${choice} is offered in ${dialog.title}`);
      await respond(dialog, { method: "select", value: choice });
      return dialog;
    };
    return { next, respond, choose };
  };
  return { cwd, hold, preparing, dock, work, provider, events, submit, start, request, idle, surface, ui };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** The smallest stdio MCP server, with one tool. */
const MCP_SERVER = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "harbor", version: "1.0.0" } } });
  if (method === "tools/list") return send({ id, result: { tools: [{ name: "echo", description: "Echo a word back", inputSchema: { type: "object", properties: {} } }] } });
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: "Method not found" } });
});
`;

function assertOrdinaryTools(request: HeldChatRequest): void {
  // A review probe found the Plan/Goal tools in every ordinary conversation.
  for (const name of ["plan_submit", "plan_question", "goal_update"]) assert.equal(request.toolNames.includes(name), false, `${name} is inactive outside its mode`);
  assert.ok(request.toolNames.includes("write"), "Ordinary work can write files");
}

function assertPlanningTools(request: HeldChatRequest): void {
  assert.ok(request.toolNames.includes("plan_submit"), "Planning offers plan_submit");
  for (const name of ["write", "edit", "bash"]) assert.equal(request.toolNames.includes(name), false, `Planning keeps ${name} from the model`);
}

function messageText(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part: { type?: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") : "";
}

function lastMessageText(request: HeldChatRequest): string {
  return messageText(request.body.messages?.at(-1)?.content);
}

async function assertGoalCleared(h: Harness): Promise<void> {
  assert.equal((await h.dock.read(h.work.id)).instance.extensionStatus.Goal, undefined);
  const widget = h.events.findLast((event) => event.type === "extension.widget_changed" && event.data.key === "alu-dock-goal");
  assert.ok(widget?.type === "extension.widget_changed");
  assert.equal(widget.data.lines, undefined);
}

test("Planning cannot change files, shows the full plan for review, and executes only after the person chooses", { timeout: 40_000 }, async (context) => {
  const h = await setup(context, { probeTools: true });
  const ui = await h.ui();
  const original = "original project contents\n";
  await h.dock.setActiveTools(h.work.id, ["write", "nested_probe"]);
  const request = "Prepare a report\nKeep the fixture unchanged until I approve.";
  await h.start(`/plan ${request}`);
  const investigation = await h.request();
  assert.ok(JSON.stringify(investigation.body.messages).includes(JSON.stringify(request).slice(1, -1)), "Planning keeps the person's line breaks");
  assertPlanningTools(investigation);
  for (const name of ["read", "grep", "find", "ls", "nested_probe", "plan_question"]) assert.ok(investigation.toolNames.includes(name), `Planning offers ${name}`);
  // A review found planning declaring every read-only tool, overriding on-demand exposure.
  assert.equal(investigation.toolNames.includes("codemode_read"), false, "Planning keeps on-demand tools on demand");
  investigation.tools(
    { id: "plan-write", name: "write", arguments: { path: "fixture.txt", content: "unapproved write" } },
    { id: "plan-nested", name: "nested_probe", arguments: {} },
  );
  // A review reproduced a 66-line plan cut to one 2,048-character line at the decision.
  const draft = ["## Goal", "Write the report.", "", "## Steps",
    ...Array.from({ length: 60 }, (_, index) => `${index + 1}. Step ${index + 1}: inspect the module and run its checks.`),
    "", "LAST: never deploy"].join("\n");
  (await h.request()).tools({ id: "plan-draft", name: "plan_submit", arguments: { content: draft } });
  assert.equal(await readFile(join(h.cwd, "fixture.txt"), "utf8"), original);
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "plan-nested" && event.data.text.includes("Nested write blocked")), "A read-only tool cannot write through a nested call");
  const review = await ui.next("editor");
  assert.equal(review.prefill, draft, "The whole plan is shown with its line breaks, down to the last line");

  // A review found Esc waiting for someone to close this editor.
  await h.dock.abort(h.work.id);
  await h.idle();
  await waitFor(() => h.events.some((event) => event.type === "interaction.cancelled" && event.data.interactionId === review.interactionId), "Esc did not close the plan editor");
  assert.match(await h.surface(), /规划中/);

  await h.start("/plan Show me the plan again.");
  (await h.request()).tools({ id: "plan-again", name: "plan_submit", arguments: { content: draft } });
  const edited = draft.replace("LAST: never deploy", "LAST: never deploy; ask before deleting anything");
  await ui.respond(await ui.next("editor"), { method: "editor", value: edited });
  const decision = await ui.next("select");
  assert.deepEqual(decision.options, ["按此执行", "执行并自动推进到完成", "继续讨论"]);
  assert.equal(await readFile(join(h.cwd, "fixture.txt"), "utf8"), original, "Saving the editor is not approval");
  await h.submit("Call the output approved.txt.");
  await ui.respond(decision, { method: "select", value: "按此执行" });
  const execution = await h.request();
  assertOrdinaryTools(execution);
  assert.ok(JSON.stringify(execution.body.messages).includes("ask before deleting anything"), "The model receives the person's edited plan");
  assert.ok(JSON.stringify(execution.body.messages).includes("Call the output approved.txt."), "A remark while deciding does not cancel the decision");
  execution.tools({ id: "approved-write", name: "write", arguments: { path: "approved.txt", content: "approved report" } });
  (await h.request()).text("The approved report is written.");
  await h.idle();
  assert.equal(await readFile(join(h.cwd, "approved.txt"), "utf8"), "approved report");
  assert.doesNotMatch(await h.surface(), /规划中/);

  await h.start("/plan Prepare a follow-up report.");
  (await h.request()).tools({ id: "plan-goal", name: "plan_submit", arguments: { content: draft } });
  await ui.respond(await ui.next("editor"), { method: "editor", value: draft });
  await ui.choose("执行并自动推进到完成");
  const autonomous = await h.request();
  assert.ok(autonomous.toolNames.includes("goal_update"));
  assert.match(await h.surface(), /1\s*\/\s*10/);
  autonomous.text("The follow-up report is in progress.");
  const continuation = await h.request();
  assert.match(await h.surface(), /2\s*\/\s*10/);
  // A review found every automatic round repeating the whole approved plan.
  assert.match(lastMessageText(continuation), /执行已批准的第 \d+ 版计划/);
  assert.equal(lastMessageText(continuation).includes("LAST: never deploy"), false, "Automatic rounds refer to the plan instead of repeating it");
  continuation.tools({ id: "plan-goal-complete", name: "goal_update", arguments: { status: "complete", summary: "Follow-up delivered", evidence: ["All sections are present"] } });
  (await h.request()).text("The follow-up report is delivered.");
  await h.idle();
  await assertGoalCleared(h);

  // Reviews found Dock tools reappearing in planning after a status check or
  // reload, and a switch made during planning lost when planning ended.
  await h.start("/plan");
  await h.start("/dock-tools on");
  await waitFor(async () => (await h.dock.read(h.work.id)).instance.extensionStatus["Dock tools"] === "on", "Dock tools did not turn on");
  await h.dock.reloadSession(h.work.id);
  await h.submit("Which sibling Works could help?");
  const planningWithDockTools = await h.request();
  assertPlanningTools(planningWithDockTools);
  assert.equal(planningWithDockTools.toolNames.includes("dock_send"), false, "Planning keeps Dock's sending tool from the model");
  planningWithDockTools.text("I will look at them after planning.");
  await h.idle();
  await h.start("/plan");
  await waitFor(async () => !/规划中/.test(await h.surface()), "Bare /plan did not leave planning");
  await h.submit("Ask a sibling Work for help.");
  const afterPlanning = await h.request();
  assertOrdinaryTools(afterPlanning);
  assert.ok(afterPlanning.toolNames.includes("dock_send"), "Dock tools turned on during planning are available afterwards");
  afterPlanning.text("I can reach sibling Works now.");
  await h.idle();
});

test("A Goal joins ongoing work, takes supplements, pauses on Esc, and stops at its budget until the person adds more", { timeout: 40_000 }, async (context) => {
  const h = await setup(context);
  const ui = await h.ui();
  await h.submit("Explain how you will inspect this project.");
  const ordinary = await h.request();
  assertOrdinaryTools(ordinary);
  const objective = "Inspect the fixture in stages and deliver a report";
  await h.start(`/goal --rounds 3 ${objective}`);
  await waitFor(async () => /0\s*\/\s*3/.test(await h.surface()), "The Goal was not accepted during an ordinary reply");
  assert.equal(ordinary.closed, false, "Starting a Goal leaves the current reply running");
  ordinary.text("I will inspect the project in stages.");
  const first = await h.request();
  assert.match(await h.surface(), /1\s*\/\s*3/);
  assert.ok(first.toolNames.includes("goal_update"));
  first.tools(
    { id: "goal-progress", name: "goal_update", arguments: { status: "progress", summary: "Fixture located; report still needed" } },
    { id: "goal-read", name: "read", arguments: { path: "fixture.txt" } },
  );
  const toolResult = await h.request();
  assert.match(await h.surface(), /1\s*\/\s*3/, "Tool round trips do not spend another round");
  const supplement = "Include the fixture's exact contents in the report.";
  await h.submit(supplement);
  toolResult.text("The fixture is located and readable.");
  const supplemented = await h.request();
  assert.ok(JSON.stringify(supplemented.body.messages).includes(supplement));
  assert.match(await h.surface(), /1\s*\/\s*3/, "The person's supplement does not spend a round");
  supplemented.text("The report will include the requested contents.");
  const second = await h.request();
  assert.match(await h.surface(), /2\s*\/\s*3/);
  await h.dock.abort(h.work.id); // The action behind Esc / Stop current reply.
  await waitFor(() => second.closed, "Esc did not stop the current reply");
  await h.idle();
  assert.match(await h.surface(), /已暂停/);

  await h.submit("Explain the remaining work while the Goal is paused.");
  const pausedChat = await h.request();
  assertOrdinaryTools(pausedChat);
  assert.match(await h.surface(), /已暂停/, "Ordinary chat leaves the Goal paused");
  await h.start("/goal");
  await ui.choose("继续");
  assert.equal(pausedChat.closed, false, "Continuing during a reply leaves that reply running");
  pausedChat.text("The report still needs its final verification.");
  (await h.request()).text("The third stage is finished, but the report is not delivered yet.");
  await h.idle();
  assert.match(await h.surface(), /3\s*\/\s*3/);
  assert.match(await h.surface(), /预算用尽/);
  await h.start("/goal");
  await ui.choose("再给 10 轮");
  const extended = await h.request();
  assert.match(await h.surface(), /4\s*\/\s*13/);
  assert.ok(JSON.stringify(extended.body.messages).includes(objective), "More rounds continue the same objective");
  assert.ok(JSON.stringify(extended.body.messages).includes("Fixture located; report still needed"), "More rounds keep the recorded progress");
  const completionStart = h.events.length;
  extended.tools({ id: "goal-complete", name: "goal_update", arguments: {
    status: "complete", summary: "Fixture inspection delivered", evidence: ["Report includes the exact fixture contents"],
  } });
  (await h.request()).text("Your inspection report is ready.");
  await h.idle();
  await assertGoalCleared(h);
  assert.ok(h.events.slice(completionStart).some((event) => event.type === "message.completed" && event.data.role === "system"
    && JSON.stringify(event.data.content).includes("Fixture inspection delivered") && JSON.stringify(event.data.content).includes("Report includes the exact fixture contents")),
  "Completion leaves a visible result with its evidence");
  await h.submit("Now answer an ordinary question.");
  const afterGoal = await h.request();
  assertOrdinaryTools(afterGoal);
  // A review found finished Goals appending an instruction after every later message.
  assert.equal(lastMessageText(afterGoal), "Now answer an ordinary question.");
  afterGoal.text("Here is the answer.");
  await h.idle();

  // Pi reports no result when an extension's request cannot start; without
  // Dock's start check the Goal would show as running while nothing runs.
  const unavailable = await setup(context, { missingAuth: true });
  await unavailable.start("/goal Inspect after model access is configured");
  await waitFor(async () => /受阻/.test(await unavailable.surface()), "Missing model access did not leave a blocked Goal");
  assert.match(await unavailable.surface(), /0\s*\/\s*10/);
  assert.equal(unavailable.provider.requests.length, 0);
});

// Reviews of 805f762 and b2fbce6 found planning left with only tool_search under
// codemode-only: codemode, which Pi's MCP switches on (again on reconnect), hid
// every other tool while Plan hid codemode.
test("Planning works with MCP under Pi's codemode-only setting, even after an MCP reconnect", { timeout: 40_000 }, async (context) => {
  const h = await setup(context, { codemodeOnlyMcp: true });
  await waitFor(async () => (await h.dock.tools(h.work.id)).tools.some((tool) => tool.name === "mcp__harbor__echo"), "The MCP server did not connect");
  await h.start("/plan Inspect the fixture.");
  const planning = await h.request();
  for (const name of ["read", "plan_submit", "plan_question"]) assert.ok(planning.toolNames.includes(name), `Planning offers ${name}`);
  assert.equal(planning.toolNames.includes("codemode"), false, "Planning does not run scripts");
  planning.text("I will inspect it.");
  await h.idle();
  const beforeReconnect = h.events.length;
  await h.start("/mcp reconnect harbor");
  await waitFor(() => h.events.slice(beforeReconnect).some((event) => event.type === "extension.notification" && /reconnect/i.test(event.data.message)), "MCP did not reconnect");
  await h.submit("Continue the investigation.");
  const afterReconnect = await h.request();
  for (const name of ["read", "plan_submit"]) assert.ok(afterReconnect.toolNames.includes(name), `Planning still offers ${name} after the reconnect`);
  afterReconnect.text("Continuing the investigation.");
  await h.idle();
  await h.start("/plan");
  await waitFor(async () => !/规划中/.test(await h.surface()), "Bare /plan did not leave planning");
  await h.submit("Continue normally.");
  const ordinary = await h.request();
  assert.ok(ordinary.toolNames.includes("codemode"), "codemode is back after planning");
  assert.equal(ordinary.toolNames.includes("read"), false, "The person's codemode-only setting applies again after planning");
  ordinary.text("Continuing.");
  await h.idle();
});

// Incident found in review, 2026-10-07: Stop pressed while a Goal was still
// preparing its first request returned at once, then the model was called anyway.
test("Stopping while a Goal is still preparing its first request keeps the model from being called", { timeout: 40_000 }, async (context) => {
  const h = await setup(context, { preparationGate: true });
  for (const stop of ["abort", "abortRestoreQueue"] as const) { // Stop current reply, and Esc
    await writeFile(h.hold, "");
    await rm(h.preparing, { force: true });
    const objective = `Inspect fixture.txt (stopped by ${stop})`;
    await h.start(`/goal --rounds 1 ${objective}`);
    await waitFor(async () => readFile(h.preparing).then(() => true, () => false), "The Goal did not reach its preparation step");
    await h.dock[stop](h.work.id);
    await rm(h.hold);
    await h.submit(`Answer normally after ${stop}.`);
    const next = await h.request();
    assert.equal(JSON.stringify(next.body.messages).includes(objective), false, `After ${stop}, the stopped Goal does not reach the model`);
    next.text("Answering normally.");
    await h.idle();
    assert.match(await h.surface(), /已暂停/);
    assert.match(await h.surface(), /0\s*\/\s*1/);
  }
});

test("Reopening or going back in history keeps spent rounds and the right tools, and never restarts work by itself", { timeout: 40_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal --rounds 3 Inspect this branch in stages");
  const first = await h.request();
  const earlyLeaf = (await h.dock.tree(h.work.id)).leafId;
  assert.ok(earlyLeaf);
  first.text("The first inspection stage is complete.");
  const second = await h.request();
  await h.dock.abort(h.work.id);
  await waitFor(() => second.closed, "Esc did not pause the second stage");
  await h.idle();

  await h.dock.reloadSession(h.work.id);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  await h.dock.navigateSession(h.work.id, earlyLeaf);
  await h.idle();
  assert.match(await h.surface(), /已暂停/, "A history point where the Goal was running waits for the person");
  assert.match(await h.surface(), /1\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 2, "Reopening and going back never call the model by themselves");

  await h.start("/plan");
  await waitFor(async () => /规划中/.test(await h.surface()), "Bare /plan did not enter planning");
  await h.dock.reloadSession(h.work.id);
  await h.submit("Look around before we decide.");
  const afterReload = await h.request();
  assertPlanningTools(afterReload);
  afterReload.text("I looked around.");
  await h.idle();
  await h.start("/plan");
  await waitFor(async () => !/规划中/.test(await h.surface()), "Bare /plan did not leave planning");
  // A review found the history point where planning ended restoring only the planning tools.
  const planEnded = (await h.dock.tree(h.work.id)).leafId;
  assert.ok(planEnded);
  await h.submit("Continue with ordinary work.");
  (await h.request()).text("Continuing.");
  await h.idle();
  await h.dock.navigateSession(h.work.id, planEnded);
  await h.idle();
  await h.submit("Write the report now.");
  const backAtPlanEnd = await h.request();
  assertOrdinaryTools(backAtPlanEnd);
  backAtPlanEnd.text("Writing it now.");
  await h.idle();
});
