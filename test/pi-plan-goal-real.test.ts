import assert from "node:assert/strict";
import { spawn } from "node:child_process"; // TEMPORARY_PTY_QA
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { ptyUserEnvironment } from "./support/pty-user-environment.js"; // TEMPORARY_PTY_QA
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

// Product review, 2026-10-07: three real-entry user journeys replace the old
// command/timing matrix. Only the model transport is fake; Dock, Host, Worker
// and Pi run normally. Planning's file protection and bounded autonomous work
// are explicit safety requirements in STORY.md and the approved Plan/Goal UX.
type Dialog = Extract<DockEvent, { type: "interaction.requested" }>["data"];

async function setup(context: TestContext, options: { probeTools?: boolean; missingAuth?: boolean } = {}) {
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
  if (options.probeTools) {
    await mkdir(join(agentDir, "extensions"));
    await writeFile(join(agentDir, "extensions", "tool-probes.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.registerTool({ name: "opaque_write", label: "Opaque write", description: "Fixture deferred write tool", exposure: "deferred", parameters: { type: "object", properties: {} },
    execute: async () => { await writeFile(${JSON.stringify(join(cwd, "fixture.txt"))}, "opaque write"); return { content: [{ type: "text", text: "written" }] }; } });
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
  return { root, cwd, sessionDir, dock, work, provider, events, submit, start, request, idle, surface, ui, socketPath: join(root, "dock.sock") };
}

function assertOrdinaryTools(request: HeldChatRequest): void {
  // Review probe found these tools leaking into every ordinary conversation.
  for (const name of ["plan_submit", "plan_question", "goal_update"]) assert.equal(request.toolNames.includes(name), false, `${name} is inactive outside its mode`);
  assert.ok(request.toolNames.includes("write"));
}

function lastMessageText(request: HeldChatRequest): string {
  const content = request.body.messages?.at(-1)?.content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part: { type?: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") : "";
}

async function assertGoalCleared(h: Awaited<ReturnType<typeof setup>>): Promise<void> {
  assert.equal((await h.dock.read(h.work.id)).instance.extensionStatus.Goal, undefined);
  const widget = h.events.findLast((event) => event.type === "extension.widget_changed" && event.data.key === "alu-dock-goal");
  assert.ok(widget?.type === "extension.widget_changed");
  assert.equal(widget.data.lines, undefined);
}

// The 2026-10-07 review reproduced full plans/evidence being appended on every
// save. Keep a small persistence check in the journeys that expose that growth.
async function savedChanges(h: Awaited<ReturnType<typeof setup>>) {
  const file = (await h.dock.read(h.work.id)).instance.executor.sessionFile;
  assert.ok(file);
  const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return records.filter((entry) => entry.type === "custom" && entry.customType === "alu-dock-plan-goal-state" && entry.data?.version === 2)
    .map((entry) => entry.data as { plan?: { content: string } | null; goal?: { id?: string; rounds?: number; summary?: string; evidence?: string[] } | null });
}

function assertSmallRoundRecords(changes: Awaited<ReturnType<typeof savedChanges>>): void {
  const ticks = changes.filter((change) => change.goal?.rounds !== undefined && change.goal.id === undefined);
  assert.ok(ticks.length > 0);
  for (const tick of ticks) {
    assert.equal(tick.plan, undefined, "Advancing a round does not append the full plan again");
    assert.equal(tick.goal?.summary, undefined, "Advancing a round does not append unchanged progress again");
    assert.equal(tick.goal?.evidence, undefined, "Advancing a round does not append unchanged evidence again");
  }
}

test("Plan investigates safely, lets the person discuss and edit the full plan, then executes their chosen version", { timeout: 40_000 }, async (context) => {
  const h = await setup(context, { probeTools: true });
  const ui = await h.ui();
  const request = "Prepare a report\nKeep the fixture unchanged until I approve.";
  await h.start(`/plan ${request}`);
  const investigation = await h.request();
  assert.ok(JSON.stringify(investigation.body.messages).includes(JSON.stringify(request).slice(1, -1)), "Planning preserves the person's multiline request");
  for (const name of ["read", "ls", "find", "grep", "nested_probe", "plan_submit", "plan_question"]) assert.ok(investigation.toolNames.includes(name), `Planning offers ${name}`);
  for (const name of ["write", "edit", "bash", "opaque_write", "goal_update"]) assert.equal(investigation.toolNames.includes(name), false, `Planning removes ${name} from the model loadout`);
  investigation.tools(
    { id: "plan-read", name: "read", arguments: { path: "fixture.txt" } },
    { id: "plan-write", name: "write", arguments: { path: "fixture.txt", content: "unapproved write" } },
    { id: "plan-nested", name: "nested_probe", arguments: {} },
  );
  const question = await h.request();
  assert.equal(await readFile(join(h.cwd, "fixture.txt"), "utf8"), "original project contents\n");
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "plan-nested" && event.data.text.includes("Nested write blocked")), "A read-only extension cannot write through a nested tool call");
  question.tools({ id: "plan-question", name: "plan_question", arguments: { question: "Which report format?", options: ["Plain text", "Markdown"] } });
  await ui.choose("Markdown");
  const draft = "Read fixture.txt, then write the approved report.";
  const edited = "Read fixture.txt, then write the human-reviewed Markdown report.";
  (await h.request()).tools({ id: "plan-draft", name: "plan_submit", arguments: { content: draft } });
  const selection = await ui.next("select");
  assert.ok(selection.title.includes(draft), "The complete short plan is visible at the decision");
  assert.deepEqual(selection.options, ["按此执行", "执行并自动推进到完成", "我来改", "继续讨论"]);
  await ui.respond(selection, { method: "select", value: "我来改" });
  const editor = await ui.next("editor");
  assert.equal(editor.prefill, draft);
  await ui.respond(editor, { method: "editor", value: edited });
  const discussion = await ui.choose("继续讨论");
  assert.ok(discussion.title.includes(edited), "Saving an edit returns to the same decision with the edited plan");
  (await h.request()).text("The revised report plan is ready for your comments.");
  await h.idle();
  assert.match(await h.surface(), /规划中/);

  await h.submit("That version is ready to execute.");
  (await h.request()).tools({ id: "plan-ready", name: "plan_submit", arguments: { content: edited } });
  const approval = await ui.next("select");
  await h.submit("Please call the output approved.txt.");
  await ui.respond(approval, { method: "select", value: "按此执行" });
  const execution = await h.request();
  assertOrdinaryTools(execution);
  assert.ok(JSON.stringify(execution.body.messages).includes(edited));
  assert.ok(JSON.stringify(execution.body.messages).includes("Please call the output approved.txt."), "A supplement reaches the work without invalidating the unchanged plan");
  execution.tools({ id: "approved-write", name: "write", arguments: { path: "approved.txt", content: "approved report" } });
  (await h.request()).text("The approved report is written.");
  await h.idle();
  assert.equal(await readFile(join(h.cwd, "approved.txt"), "utf8"), "approved report");
  assert.doesNotMatch(await h.surface(), /规划中|推进中/);
  assert.deepEqual((await savedChanges(h)).flatMap((change) => change.plan ? [change.plan.content] : []), [draft, edited], "Submitting an unchanged plan does not append another full copy");

  await h.start("/plan");
  await waitFor(async () => /规划中/.test(await h.surface()), "Bare /plan did not enter planning");
  await h.start("/plan");
  await waitFor(async () => !/规划中/.test(await h.surface()), "Bare /plan did not leave planning");
  await h.start("/plan Prepare a detailed follow-up report");
  const longPlan = "Detailed report plan\n" + "Inspect each documented section and include its evidence.\n".repeat(160) + "Final approved step: deliver the report.";
  (await h.request()).tools({ id: "long-plan", name: "plan_submit", arguments: { content: longPlan } });
  const fullReview = await ui.next("editor");
  assert.equal(fullReview.prefill, longPlan, "A long plan is shown in full before approval");
  await ui.respond(fullReview, { method: "editor", value: longPlan });
  await ui.choose("执行并自动推进到完成");
  const autonomous = await h.request();
  assert.ok(autonomous.toolNames.includes("goal_update"));
  assert.ok(JSON.stringify(autonomous.body.messages).includes("Final approved step: deliver the report."));
  assert.match(await h.surface(), /1\s*\/\s*10/);
  autonomous.tools({ id: "plan-goal-complete", name: "goal_update", arguments: { status: "complete", summary: "Detailed report delivered", evidence: ["All requested sections are present"] } });
  (await h.request()).text("The detailed report is delivered.");
  await h.idle();
  await assertGoalCleared(h);
  assertSmallRoundRecords(await savedChanges(h));
});

test("Goal joins ongoing work, honors supplements and Esc, then adds budget and clears its completed result", { timeout: 40_000 }, async (context) => {
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
  assert.equal(first.toolNames.includes("plan_question"), false);
  first.tools(
    { id: "goal-progress", name: "goal_update", arguments: { status: "progress", summary: "Fixture located; report still needed" } },
    { id: "goal-read", name: "read", arguments: { path: "fixture.txt" } },
  );
  const toolResult = await h.request();
  assert.match(await h.surface(), /1\s*\/\s*3/, "Tool round trips do not spend another Goal round");
  const supplement = "Include the fixture's exact contents in the report.";
  await h.submit(supplement);
  toolResult.text("The fixture is located and readable.");
  const supplemented = await h.request();
  assert.ok(JSON.stringify(supplemented.body.messages).includes(supplement));
  assert.match(await h.surface(), /1\s*\/\s*3/, "Human supplements do not consume the automatic budget");
  supplemented.text("The report will include the requested contents.");
  const second = await h.request();
  assert.match(await h.surface(), /2\s*\/\s*3/);
  await h.dock.abort(h.work.id); // The same action used by Esc / Stop current reply.
  await waitFor(() => second.closed, "Esc did not stop the current reply");
  await h.idle();
  assert.match(await h.surface(), /已暂停/);

  await h.submit("Explain the remaining work while the Goal is paused.");
  const pausedChat = await h.request();
  assertOrdinaryTools(pausedChat);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  assert.match(await h.surface(), /已暂停/, "Ordinary chat leaves the Goal paused");
  await h.start("/goal");
  const resume = await ui.choose("继续");
  assert.match(resume.title, /暂停/);
  assert.equal(pausedChat.closed, false, "Resuming during a reply leaves that reply running");
  pausedChat.text("The report still needs its final verification.");
  (await h.request()).text("The third scheduled stage is finished, but the report is not delivered yet.");
  await h.idle();
  assert.match(await h.surface(), /3\s*\/\s*3/);
  assert.match(await h.surface(), /用完|用尽/);
  await h.start("/goal");
  const addBudget = await ui.choose("再给 10 轮");
  assert.match(addBudget.title, /用完|用尽/);
  const extended = await h.request();
  assert.match(await h.surface(), /4\s*\/\s*13/);
  assert.ok(JSON.stringify(extended.body.messages).includes(objective), "Additional budget continues the same objective");
  assert.ok(JSON.stringify(extended.body.messages).includes("Fixture located; report still needed"));
  const completionStart = h.events.length;
  extended.tools({ id: "goal-complete", name: "goal_update", arguments: {
    status: "complete", summary: "Fixture inspection delivered", evidence: ["Report includes the exact fixture contents"],
  } });
  const finalReply = await h.request();
  assertOrdinaryTools(finalReply);
  finalReply.text("Your inspection report is ready.");
  await h.idle();
  await assertGoalCleared(h);
  const resultEvents = h.events.slice(completionStart).filter((event) => event.type === "message.completed" && event.data.role === "system"
    && JSON.stringify(event.data.content).includes("Fixture inspection delivered") && JSON.stringify(event.data.content).includes("Report includes the exact fixture contents"));
  assert.equal(resultEvents.length, 1, "Completion leaves one visible result with its evidence");
  await h.submit("Now tell me what tools are available for ordinary work.");
  const afterGoal = await h.request();
  assertOrdinaryTools(afterGoal);
  assert.equal(lastMessageText(afterGoal), "Now tell me what tools are available for ordinary work.", "Completed Goals no longer append an instruction after the person's message");
  afterGoal.text("Ordinary project tools are available.");
  await h.idle();
  assertSmallRoundRecords(await savedChanges(h));

  await h.start("/goal Inspect an optional appendix");
  const optional = await h.request();
  assert.match(await h.surface(), /1\s*\/\s*10/, "A plain /goal request uses the default ten rounds");
  // A real SDK probe on 2026-10-07 reproduced an old in-flight completion
  // finishing a newly replaced Goal. The old reply may finish, but owns only A.
  const replacementObjective = "Inspect the replacement appendix instead";
  await h.start(`/goal ${replacementObjective}`);
  await waitFor(async () => /0\s*\/\s*10/.test(await h.surface()), "The replacement Goal was not accepted during the old reply");
  assert.equal(optional.closed, false, "Replacing a Goal leaves the old reply running");
  optional.tools({ id: "old-goal-complete", name: "goal_update", arguments: {
    status: "complete", summary: "The old optional appendix is complete", evidence: ["Only the old appendix was inspected"],
  } });
  const oldResult = await h.request();
  assert.ok(h.events.some((event) => event.type === "tool.completed" && event.data.toolCallId === "old-goal-complete" && event.data.isError), "The old Goal's completion cannot finish the replacement");
  assert.match(await h.surface(), /0\s*\/\s*10/);
  oldResult.text("The previous appendix inspection has ended.");
  const replacement = await h.request();
  assert.match(await h.surface(), /1\s*\/\s*10/);
  assert.ok(JSON.stringify(replacement.body.messages).includes(replacementObjective), "The replacement begins naturally after the old reply ends");
  await h.start("/goal");
  await ui.choose("结束");
  await waitFor(() => replacement.closed, "Ending the Goal did not stop its current reply");
  await h.idle();
  await assertGoalCleared(h);
  await h.submit("Leave the appendix aside and answer normally.");
  const afterCancel = await h.request();
  assertOrdinaryTools(afterCancel);
  assert.equal(lastMessageText(afterCancel), "Leave the appendix aside and answer normally.", "Ended Goals no longer append instructions");
  afterCancel.text("The appendix is set aside.");
  await h.idle();

  const unavailable = await setup(context, { missingAuth: true });
  await unavailable.start("/goal Inspect after model access is configured");
  await waitFor(async () => /受阻/.test(await unavailable.surface()), "Missing model access did not leave an actionable blocked Goal");
  await unavailable.idle();
  assert.match(await unavailable.surface(), /0\s*\/\s*10/);
  assert.equal(unavailable.provider.requests.length, 0, "A request that cannot start does not spend a round or call the provider");
});

test("Reloading and selecting branches retain spent rounds and wait for the person, including old saved Goals", { timeout: 40_000 }, async (context) => {
  const h = await setup(context);
  await h.start("/goal --rounds 3 Inspect this branch in stages");
  const first = await h.request();
  const earlyLeaf = (await h.dock.tree(h.work.id)).leafId;
  assert.ok(earlyLeaf);
  first.text("The first inspection stage is complete.");
  const second = await h.request();
  await h.dock.abort(h.work.id);
  await waitFor(() => second.closed, "Esc did not pause the second inspection stage");
  await h.idle();
  await h.submit("Bookmark this branch before exploring an alternative.");
  (await h.request()).text("The branch is ready to explore.");
  await h.idle();
  const sourceFile = (await h.dock.read(h.work.id)).instance.executor.sessionFile;
  assert.ok(sourceFile);
  const bookmark = (await h.dock.tree(h.work.id)).nodes.findLast((node) => node.kind === "message" && node.role === "user");
  assert.ok(bookmark);

  await h.dock.reloadSession(h.work.id);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  await h.dock.forkSession(h.work.id, bookmark.entryId);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 3, "Opening or forking saved work does not authorize another model round");
  const forkUi = await h.ui();
  await h.start("/goal");
  await forkUi.choose("继续");
  (await h.request()).text("The last allowed stage of this fork is complete.");
  await h.idle();
  assert.match(await h.surface(), /3\s*\/\s*3/);

  await h.dock.switchSession(h.work.id, sourceFile);
  await h.dock.navigateSession(h.work.id, earlyLeaf);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /1\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 4, "Selecting earlier active Goal history waits for explicit continuation");

  // Frozen v1 record from the previous release, including its obsolete deadline.
  // Loading it must preserve this person's remaining round, not revive the timer.
  const legacyFile = join(h.sessionDir, "legacy-plan-goal.jsonl");
  const timestamp = "2026-10-01T00:00:00.000Z";
  await writeFile(legacyFile, [
    { type: "session", version: 3, id: "legacy-plan-goal", timestamp, cwd: h.cwd },
    { type: "message", id: "legacy-user", parentId: null, timestamp, message: { role: "user", content: "Inspect the archived fixture", timestamp: 1 } },
    { type: "custom", id: "legacy-goal", parentId: "legacy-user", timestamp, customType: "alu-dock-plan-goal-state", data: {
      version: 1, mode: "execute", goal: { id: "saved-goal", objective: "Inspect the archived fixture", status: "active", maxRounds: 3, rounds: 2,
        expiresAt: 1, summary: "Two stages already checked", evidence: ["Archived fixture located"] },
    } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await h.dock.switchSession(h.work.id, legacyFile);
  await h.idle();
  assert.match(await h.surface(), /已暂停/);
  assert.match(await h.surface(), /2\s*\/\s*3/);
  assert.equal(h.provider.requests.length, 4, "Old active records reopen disarmed");
  const legacyUi = await h.ui();
  await h.start("/goal");
  await legacyUi.choose("继续");
  const restored = await h.request();
  assert.ok(JSON.stringify(restored.body.messages).includes("Inspect the archived fixture"));
  restored.text("The archived fixture's final allowed stage is checked.");
  await h.idle();
  assert.match(await h.surface(), /3\s*\/\s*3/);
  assert.match(await h.surface(), /用完|用尽/);
});
