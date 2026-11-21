import assert from "node:assert/strict";
import test from "node:test";
import { spawnDockWorker } from "../src/control/native-collaboration.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { WorkMessages } from "../src/control/work-messages.js";
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
  const spawn = { ...request, model: { provider: "local", id: "model" }, thinkingLevel: "low", allowedTools: ["read", "grep"] };
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

// Card #674 review (Astra): a lead may wait for its own child Works for hours, so two gaps in what the Host
// thinks a child Work owes became real. A parent message that crossed the child's final result for earlier
// work was cleared with it, so a later stop went unreported; and after the parent interrupted to take the
// work back, a later report from the child still reached it. Its report receipt also carried the parent's state.
test("a child Work still owes a parent message that crossed its final result, and nothing once the parent took the work back", async () => {
  const sessions = { parent: new DelayedAgentWorkerConnection("parent"), lead: new DelayedAgentWorkerConnection("lead") };
  const parent = new ManagedInstance({ id: "parent", name: "alu", cwd: process.cwd(), session: sessions.parent });
  const lead = new ManagedInstance({ id: "lead", name: "Lead", cwd: process.cwd(), session: sessions.lead, parentId: parent.id });
  const works = new Map([[parent.id, parent], [lead.id, lead]]);
  const messages = new WorkMessages({ live: () => works.values(), get: (id) => works.get(id), now: () => "2026-11-21T00:00:00.000Z" });
  messages.childStarted(lead.id);
  const fromParent = (text: string) => messages.send(parent.snapshot(), { type: "send", operationId: text, target: "Lead", message: text }, lead);
  const fromLead = (text: string, readThrough: number) => messages.send(lead.snapshot(), { type: "send", operationId: text, message: text, done: true, readThrough }, undefined);
  const notices = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return sessions.parent.workMessages.filter((message) => message.type === "child_stopped").length;
  };

  await fromParent("Q1");
  await fromParent("Q2");
  assert.deepEqual(sessions.lead.workMessages.map((message) => message.type === "message" ? message.number : undefined), [1, 2]);
  const receipt = await fromLead("A1", 1);
  assert.deepEqual(receipt, { type: "work_message", to: "parent", acceptedAt: "2026-11-21T00:00:00.000Z", done: true }, "a child learns only that its result arrived");
  messages.childLeaving(lead);
  assert.equal(await notices(), 1, "Q2 was still owed when the lead left");

  await fromParent("Q3");
  await fromLead("A3", 3);
  messages.childLeaving(lead);
  assert.equal(await notices(), 1, "a result that read the latest question settles it");

  await fromParent("Q4");
  messages.release(lead.id, true);
  for (const reason of ["aborted", "ended"] as const) await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason });
  assert.equal(await notices(), 1, "after taking the work back the parent hears of no stop");
  await fromParent("Q5");
  await messages.unreportedStop(lead.snapshot(), { type: "unreported_stop", reason: "ended" });
  assert.equal(await notices(), 2, "new work from the parent is owed a report again");
});
