import assert from "node:assert/strict";
import test from "node:test";
import { spawnDockWorker } from "../src/control/native-collaboration.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { WorkMessages } from "../src/control/work-messages.js";
import { ChildMessages } from "../src/worker/child-messages.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import type { InstanceSnapshot } from "../src/core/instance-dto.js";
import type { ObservedInstanceStatus } from "../src/core/instance-observation.js";

const source = { id: "parent", displayName: "Coordinator", cwd: "/project", executor: { model: { provider: "local", id: "model" }, thinkingLevel: "low" } } as InstanceSnapshot;
const child: ObservedInstanceStatus = { id: "child", parentId: "parent", cwd: "/project", lifecycle: "active", execution: "running", compacting: false, executionChangedAt: "2026-10-31T00:00:00Z", runtimeGeneration: 1, thinkingLevel: "low" };
const request = { type: "spawn", operationId: "op", name: "Reviewer", task: "Review changes" } as const;

// User decision 2026-11-04: a child Work keeps its parent's thinking level, on another model too.
// It used to start at the other model's default, which was whatever level the user set last.
test("a child Work keeps the parent's thinking level, on another model too", async () => {
  const created: Array<{ thinkingLevel?: string }> = [];
  const port = {
    create: async (input: { thinkingLevel?: string }) => { created.push(input); return { type: "create" as const, instance: child }; },
    send: async () => ({ target: child }) as never,
  };
  await spawnDockWorker(source, request, port);
  await spawnDockWorker(source, { ...request, model: { provider: "other", id: "plain" } }, port);
  assert.deepEqual(created.map((input) => input.thinkingLevel), ["low", "low"]);
});

// #671's permission boundary: a legacy Pi Work marked assistant is not Main's independent resident.
test("an assistant marker on a Pi Work does not grant access to another Work's children", async (context) => {
  const registry = new DockRegistry(async (input) => new ManagedInstance({
    ...input, session: new DelayedAgentWorkerConnection(input.id),
    ...(input.child === undefined ? {} : { parentId: input.child.parentId }),
    ...(input.name === "Legacy Pi" ? { assistant: true } : {}),
  }), undefined, { assistantWorkspace: process.cwd() });
  context.after(() => registry.stopAll());
  const marked = await registry.create({ operationId: "marked", cwd: process.cwd(), name: "Legacy Pi" });
  const parent = await registry.create({ operationId: "parent", cwd: process.cwd(), name: "Parent" });
  const child = await registry.create({ operationId: "child", cwd: process.cwd(), name: "Child", child: { parentId: parent.id } });
  assert.equal(marked.snapshot().assistant, true);
  assert.equal(marked.snapshot().executor.kind, "pi-sdk");
  assert.equal(registry.isResidentAssistant(marked.id), false);
  const listed = await registry.invokeDockTool(marked.id, { type: "list", includeHistory: true });
  assert.ok(listed.type === "list");
  assert.ok(!listed.result.instances.some((work) => work.id === child.id));
  await assert.rejects(registry.invokeDockTool(marked.id, { type: "inspect", target: child.id }));
});

test("spawn preserves a visible child and never sends an unconfirmed task twice", async () => {
  let sends = 0;
  const result = await spawnDockWorker(source, request, {
    create: async () => ({ type: "create", instance: child }),
    send: async () => { sends++; throw new Error("response lost"); },
  });
  assert.equal(result.instance.id, "child"); assert.equal(result.taskStatus, "failed");
  assert.ok(result.error, "the parent is told to inspect before sending again"); assert.equal(sends, 1);
});

test("a delegated task reaches the child as the parent's words, never as an owner slash command", async () => {
  let message = "";
  await spawnDockWorker(source, { ...request, task: "/extension-write" }, {
    create: async () => ({ type: "create", instance: child }),
    send: async input => { message = input.message; return { target: child } as never; },
  });
  assert.equal(message, `[Agent message from "Coordinator"]\n/extension-write`);
});

test("native collaboration wire validates tool selections, delivery and terminal controls", async () => {
  const { parseDockToolsRequest, parseDockToolsResult } = await import("../src/core/dock-tools-codec.js");
  const spawn = { ...request, createDirectory: true, model: { provider: "local", id: "model" }, thinkingLevel: "low", allowedTools: ["read", "grep"] };
  assert.deepEqual(parseDockToolsRequest(JSON.parse(JSON.stringify(spawn))), spawn);
  assert.deepEqual(parseDockToolsRequest({ type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" }), { type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" });
  // A child's message names no target: the Host delivers it to the child's own parent, marked final or not.
  assert.deepEqual(parseDockToolsRequest({ type: "send", operationId: "report", message: "blocked", done: false }), { type: "send", operationId: "report", message: "blocked", done: false });
  for (const type of ["interrupt", "stop"] as const) assert.deepEqual(parseDockToolsRequest({ type, operationId: "control", target: "child" }), { type, operationId: "control", target: "child" });
  // Each differs from the valid spawn above in one field. A Worker cannot name its own parent,
  // and only a child gets a tool ceiling.
  assert.throws(() => parseDockToolsRequest({ ...spawn, thinkingLevel: "infinite" }));
  assert.throws(() => parseDockToolsRequest({ ...spawn, parentId: "spoofed" }));
  // #671: a request cannot self-authorize the resident assistant's read or delegation policy.
  assert.throws(() => parseDockToolsRequest({ ...spawn, assistant: true }));
  assert.throws(() => parseDockToolsRequest({ type: "list", assistant: true }));
  assert.throws(() => parseDockToolsRequest({ type: "create", operationId: "top-level", cwd: "/project", allowedTools: ["read"] }));
  assert.throws(() => parseDockToolsRequest({ ...spawn, cwd: "relative" }));
  // A SubHost reads Main's answers with this parser, and an older Main still sends this error.
  assert.doesNotThrow(() => parseDockToolsResult({ type: "spawn", instance: child, taskStatus: "accepted", error: "Reply unavailable; inspect child" }));
});

// Card #674 review (Astra): a lead may wait for its own child Works for hours, so gaps in what the Host and
// the parent think a child Work owes became real. A parent message that crossed the child's final result for
// earlier work was cleared with it; a failed delivery undid another send's debt; after the parent interrupted
// to take the work back, a later report or an earlier send's late receipt undid that. Each is now settled by
// the numbers of the parent's messages, which the parent's own view uses too, so arrival order does not matter.
test("what a child Work owes its parent is settled by the numbers of the messages it answered, whatever arrives first", async () => {
  const sessions = { parent: new DelayedAgentWorkerConnection("parent"), lead: new DelayedAgentWorkerConnection("lead") };
  const parent = new ManagedInstance({ id: "parent", name: "alu", cwd: process.cwd(), session: sessions.parent });
  const lead = new ManagedInstance({ id: "lead", name: "Lead", cwd: process.cwd(), session: sessions.lead, parentId: parent.id });
  const works = new Map([[parent.id, parent], [lead.id, lead]]);
  const messages = new WorkMessages({ live: () => works.values(), get: (id) => works.get(id), now: () => "2026-11-21T00:00:00.000Z" });
  messages.childStarted(lead.id);
  // The parent's own view, fed what its Worker gets: its call results and the messages the Host delivers.
  const parentView = new ChildMessages();
  parentView.noteWork({ type: "spawn", taskStatus: "accepted", instance: { ...child, id: lead.id, name: "Lead" } });
  let read = 0;
  const parentHears = () => { for (const message of sessions.parent.workMessages.slice(read)) parentView.receive(message); read = sessions.parent.workMessages.length; };
  const fromParent = async (text: string) => { const receipt = await messages.send(parent.snapshot(), { type: "send", operationId: text, target: "Lead", message: text }, lead); parentView.noteWork(receipt); return receipt; };
  const fromLead = (text: string, readThrough: number) => messages.send(lead.snapshot(), { type: "send", operationId: text, message: text, done: true, readThrough }, undefined);
  const leaves = async () => {
    messages.childLeaving(lead);
    await new Promise((resolve) => setImmediate(resolve));
    parentHears();
    return sessions.parent.workMessages.filter((message) => message.type === "child_stopped").length;
  };

  // Q2 crosses the answer to Q1: the Host and the parent both still wait for it.
  await fromParent("Q1");
  await fromParent("Q2");
  assert.deepEqual(sessions.lead.workMessages.map((message) => message.type === "message" ? message.number : undefined), [1, 2]);
  const receipt = await fromLead("A1", 1);
  assert.deepEqual(receipt, { type: "work_message", to: "parent", acceptedAt: "2026-11-21T00:00:00.000Z", done: true }, "a child learns only that its result arrived");
  parentHears();
  assert.equal(parentView.owes(lead.id), true, "the parent still waits for Q2");
  assert.equal(await leaves(), 1, "Q2 was still owed when the lead left");
  assert.equal(parentView.owes(lead.id), false);

  // A message that never arrived is owed by nobody, and does not undo another send that did.
  await fromParent("Q3");
  await fromLead("A3", 3);
  sessions.lead.failWorkMessages = 1;
  const [lost, sent] = await Promise.allSettled([fromParent("Q4"), fromParent("Q5")]);
  assert.equal(lost.status, "rejected");
  assert.equal(sent.status === "fulfilled" && sent.value.type === "work_message" && sent.value.to === "child" ? sent.value.number : undefined, 5);
  assert.equal(await leaves(), 2, "Q5 arrived, so it was owed");
  sessions.lead.failWorkMessages = 1;
  await assert.rejects(fromParent("Q6"));
  await fromLead("A5", 5);
  assert.equal(await leaves(), 2, "a result for all that arrived settles it");

  const leadStatus = { ...child, id: lead.id, name: "Lead" };
  const stopNotices = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    parentHears();
    return sessions.parent.workMessages.filter((message) => message.type === "child_stopped").length;
  };

  // Taking the work back covers a message sent before it, even when that message's receipt comes back after
  // the interrupt's. A stop report while the interrupt is under way waits for it, and is dropped.
  const sending = fromParent("Q7");
  const interrupting = messages.takeBack(lead.id);
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "aborted", readThrough: 5 });
  interrupting.answered(true);
  parentView.noteWork({ type: "interrupt", instance: leadStatus, settlesThrough: interrupting.settlesThrough });
  await sending;
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "ended", readThrough: 7 });
  assert.equal(parentView.owes(lead.id), false);
  assert.equal(await leaves(), 2, "after taking the work back the parent hears of no stop");

  // A message sent after an interrupt began is not taken back by it, whichever receipt comes first.
  const interruptingAgain = messages.takeBack(lead.id);
  await fromParent("Q8");
  interruptingAgain.answered(true);
  parentView.noteWork({ type: "interrupt", instance: leadStatus, settlesThrough: interruptingAgain.settlesThrough });
  assert.equal(parentView.owes(lead.id), true, "Q8 is still owed");
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "ended", readThrough: 8 });
  assert.equal(await stopNotices(), 3, "new work from the parent is owed a report again");
  // A turn's stop report covers what that turn had read, not what reached the child since.
  await fromParent("Q9");
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "ended", readThrough: 8 });
  assert.equal(await stopNotices(), 4);
  assert.equal(parentView.owes(lead.id), true, "Q9 is still owed");

  // A refused interrupt takes nothing back: a stop report that waited for it still reaches the parent, and a
  // result that came meanwhile still counts.
  const refused = messages.takeBack(lead.id);
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "ended", readThrough: 9 });
  refused.answered(false);
  assert.equal(await stopNotices(), 5);
  const refusedAgain = messages.takeBack(lead.id);
  await fromLead("A9", 9);
  refusedAgain.answered(false);
  assert.equal(await leaves(), 5, "its result still settles Q9");
  assert.equal(parentView.owes(lead.id), false);
  // With two take-backs under way, a stop report waits for both: one refused, the other taking it back.
  await fromParent("Q9b");
  const first = messages.takeBack(lead.id);
  const second = messages.takeBack(lead.id);
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "aborted", readThrough: 10 });
  first.answered(false);
  second.answered(true);
  parentView.noteWork({ type: "interrupt", instance: leadStatus, settlesThrough: second.settlesThrough });
  assert.equal(await stopNotices(), 5);
  assert.equal(parentView.owes(lead.id), false);

  // The child leaves while its final result is still on its way to the parent: the result settles it, so no
  // notice that it stopped without one follows the result.
  await fromParent("Q11");
  const answering = fromLead("A11", 11);
  messages.childLeaving(lead);
  await answering;
  assert.equal(await stopNotices(), 5);

  // The parent stops it and, in the same breath, hands it Q12, which reaches it before it starts stopping.
  // The report of the turn the Stop took back is dropped; its leaving still settles Q12, although the Stop
  // forgot its ledger before it answered.
  const stopping = messages.takeBack(lead.id);
  await fromParent("Q12");
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "aborted", readThrough: 11 });
  messages.childLeaving(lead);
  messages.forget([lead.id]);
  stopping.answered(true);
  parentView.noteWork({ type: "stop", instance: leadStatus, settlesThrough: stopping.settlesThrough });
  assert.equal(await stopNotices(), 6);
  assert.deepEqual(sessions.parent.workMessages.at(-1), { type: "child_stopped", from: { relation: "child", id: lead.id, name: "Lead" }, reason: "stopped", settlesThrough: 12 });
  assert.equal(parentView.owes(lead.id), false);

  // The parent reloads just as its child Work is stopping: the first notice does not reach it, the one when
  // the child has stopped does.
  const helper = new ManagedInstance({ id: "helper", name: "Helper", cwd: process.cwd(), session: new DelayedAgentWorkerConnection("helper"), parentId: parent.id });
  works.set(helper.id, helper);
  messages.childStarted(helper.id);
  parentView.noteWork({ type: "spawn", taskStatus: "accepted", instance: { ...child, id: helper.id, name: "Helper" } });
  sessions.parent.failWorkMessages = 1;
  messages.childLeaving(helper);
  messages.childLeaving(helper);
  assert.equal(await stopNotices(), 7, "one notice reached the parent");
  assert.equal(parentView.owes(helper.id), false);
});

// Card #674 review (Astra): the Host took the work back before the interrupt ran; when the interrupt was
// refused, the child kept working and its parent was never told when it stopped.
test("a parent whose interrupt was refused still hears when its child Work stops without the result", async (context) => {
  const sessions = new Map<string, DelayedAgentWorkerConnection>();
  const registry = new DockRegistry(async (input) => {
    const session = new DelayedAgentWorkerConnection(input.id);
    sessions.set(input.id, session);
    return new ManagedInstance({ ...input, session, ...(input.child === undefined ? {} : { parentId: input.child.parentId }) });
  });
  context.after(() => registry.stopAll());
  registry.bindDockToolsMutationPort({ interrupt: async () => { throw new Error("The Work is busy taking back its Queue."); } } as never);
  const parent = await registry.create({ operationId: "parent", cwd: process.cwd(), name: "Coordinator" });
  const child = await registry.create({ operationId: "child", cwd: process.cwd(), name: "Reviewer", child: { parentId: parent.id } });
  await assert.rejects(registry.invokeDockTool(parent.id, { type: "interrupt", operationId: "interrupt", target: child.id }), /busy/u);
  await registry.invokeDockTool(child.id, { type: "unreported_stop", reason: "ended" });
  assert.deepEqual(sessions.get(parent.id)!.workMessages.map((message) => message.type), ["child_stopped"]);
});
