import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { spawnDockWorker } from "../src/control/native-collaboration.js";
import type { InstanceSnapshot } from "../src/core/instance-dto.js";
import type { ObservedInstanceStatus } from "../src/core/instance-observation.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

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
    notifyWhenDone: async () => {},
  };
  await spawnDockWorker(source, request, port);
  await spawnDockWorker(source, { ...request, model: { provider: "other", id: "plain" } }, port);
  assert.deepEqual(created.map((input) => input.thinkingLevel), ["low", "low"]);
});

test("spawn preserves a visible child and never sends an unconfirmed task twice", async () => {
  let sends = 0;
  const result = await spawnDockWorker(source, request, {
    create: async () => ({ type: "create", instance: child }),
    send: async () => { sends++; throw new Error("response lost"); },
    notifyWhenDone: async () => { throw new Error("must not arrange a reply for an unconfirmed task"); },
  });
  assert.equal(result.instance.id, "child"); assert.equal(result.taskStatus, "failed");
  assert.ok(result.error, "the parent is told to inspect before sending again"); assert.equal(sends, 1);
});

test("a delegated task reaches the child as the parent's words, never as an owner slash command", async () => {
  let message = "";
  await spawnDockWorker(source, { ...request, task: "/extension-write" }, {
    create: async () => ({ type: "create", instance: child }),
    send: async input => { message = input.message; return { target: child } as never; },
    notifyWhenDone: async () => {},
  });
  assert.equal(message, `[Agent message from "Coordinator"]\n/extension-write`);
});

test("native collaboration wire validates tool selections, delivery and terminal controls", async () => {
  const { parseDockToolsRequest, parseDockToolsResult } = await import("../src/core/dock-tools-codec.js");
  const spawn = { ...request, model: { provider: "local", id: "model" }, thinkingLevel: "low", allowedTools: ["read", "grep"] };
  assert.deepEqual(parseDockToolsRequest(JSON.parse(JSON.stringify(spawn))), spawn);
  assert.deepEqual(parseDockToolsRequest({ type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" }), { type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" });
  // A child's message names no target: the Host delivers it to the child's own parent.
  assert.deepEqual(parseDockToolsRequest({ type: "send", operationId: "report", message: "blocked" }), { type: "send", operationId: "report", message: "blocked" });
  for (const type of ["interrupt", "stop"] as const) assert.deepEqual(parseDockToolsRequest({ type, operationId: "control", target: "child" }), { type, operationId: "control", target: "child" });
  // Each differs from the valid spawn above in one field. A Worker cannot name its own parent,
  // and only a child gets a tool ceiling.
  assert.throws(() => parseDockToolsRequest({ ...spawn, thinkingLevel: "infinite" }));
  assert.throws(() => parseDockToolsRequest({ ...spawn, parentId: "spoofed" }));
  assert.throws(() => parseDockToolsRequest({ type: "create", operationId: "top-level", cwd: "/project", allowedTools: ["read"] }));
  assert.throws(() => parseDockToolsRequest({ ...spawn, cwd: "relative" }));
  assert.doesNotThrow(() => parseDockToolsResult({ type: "spawn", instance: child, taskStatus: "accepted", error: "Reply unavailable; inspect child" }));
});

test("a child Work that finishes the instant it gets work still hands its reply to the parent", async (context) => {
  // Cloud verification of e12df25 (2026-11-01): a child Work that finished before its reply was
  // arranged, or in the same millisecond its task was accepted, never reported back.
  const root = await mkdtemp(join(tmpdir(), "alu-child-reply-"));
  const runtimes: DelayedAgentWorkerConnection[] = [];
  const sameInstant = new Date("2026-11-02T00:00:00.000Z");
  const registry = new DockRegistry(async (input) => {
    const runtime = new DelayedAgentWorkerConnection(input.id);
    runtimes.push(runtime);
    if (input.child !== undefined) {
      const prompt = runtime.prompt.bind(runtime);
      runtime.prompt = (text, options, operationId) => {
        const run = prompt(text, options, operationId);
        setImmediate(() => runtime.settle(`REPLY: ${text.split("\n").at(-1)}`));
        return run;
      };
    }
    return new ManagedInstance({ ...input, parentId: input.child?.parentId, session: runtime, initialHistory: runtime.getHistory(), now: () => sameInstant });
  });
  context.after(async () => { await registry.stopAll(); await rm(root, { recursive: true, force: true }); });
  // Constructing the Host connects the registry's Dock tools to it; its socket is never opened.
  new DockHost({ socketPath: join(root, "unused.sock"), registry });
  const parent = await registry.create({ operationId: "parent", cwd: root });
  const replies = () => runtimes[0]!.observationNotifications.map((notification) => notification.target.reply);
  const waitForReplies = async (count: number) => {
    for (let attempt = 0; attempt < 200 && replies().length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const spawned = await registry.invokeDockTool(parent.id, { type: "spawn", operationId: "spawn", name: "Reviewer", task: "FIRST_TASK" });
  assert.ok(spawned.type === "spawn" && spawned.taskStatus === "accepted");
  await waitForReplies(1);
  assert.deepEqual(replies(), ["REPLY: FIRST_TASK"], "the reply to the spawned task reaches the parent");
  await registry.invokeDockTool(parent.id, { type: "send", operationId: "more", target: spawned.instance.id, message: "SECOND_TASK" });
  await waitForReplies(2);
  assert.deepEqual(replies(), ["REPLY: FIRST_TASK", "REPLY: SECOND_TASK"], "the reply to work sent later reaches the parent too");
});
