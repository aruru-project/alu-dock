import assert from "node:assert/strict";
import test from "node:test";
import { spawnDockWorker } from "../src/control/native-collaboration.js";
import type { InstanceSnapshot } from "../src/core/instance-dto.js";
import type { ObservedInstanceStatus } from "../src/core/instance-observation.js";

const source = { id: "parent", displayName: "Coordinator", cwd: "/project", executor: { model: { provider: "local", id: "model" }, thinkingLevel: "low" } } as InstanceSnapshot;
const child: ObservedInstanceStatus = { id: "child", parentId: "parent", cwd: "/project", lifecycle: "active", execution: "idle", compacting: false, executionChangedAt: "2026-10-31T00:00:00Z", runtimeGeneration: 1, thinkingLevel: "low" };
const request = { type: "spawn", operationId: "op", name: "Reviewer", task: "Review changes" } as const;

test("spawn creates a child then admits its task and registers nonblocking completion", async () => {
  const calls: unknown[] = [];
  const result = await spawnDockWorker(source, request, {
    create: async input => { calls.push(input); return { type: "create", instance: child }; },
    send: async input => { calls.push(input); return { target: child } as never; },
    watch: async target => { calls.push(target); return { type: "watch", status: "watching" } as never; },
  });
  assert.equal(result.taskStatus, "accepted"); assert.equal(result.watchStatus, "watching");
  assert.equal((calls[0] as {parentId:string}).parentId, "parent");
  assert.equal((calls[1] as {delivery:string}).delivery, "followUp");
  assert.equal((calls[1] as {message:string}).message, `[Agent message from "Coordinator"]\nReview changes`);
  assert.equal(calls.length, 3);
});

test("spawn preserves visible child and never retries uncertain task acceptance", async () => {
  let sends = 0;
  const result = await spawnDockWorker(source, request, {
    create: async () => ({ type: "create", instance: child }),
    send: async () => { sends++; throw new Error("response lost"); },
    watch: async () => { throw new Error("must not watch"); },
  });
  assert.equal(result.instance.id, "child"); assert.equal(result.taskStatus, "failed");
  assert.match(result.error!, /acceptance was not confirmed/); assert.equal(sends, 1);
});

test("failed completion watch does not misreport an accepted task as failed", async () => {
  const result = await spawnDockWorker(source, request, {
    create: async () => ({ type: "create", instance: child }),
    send: async () => ({ target: child }) as never,
    watch: async () => { throw new Error("watch quota"); },
  });
  assert.equal(result.taskStatus, "accepted"); assert.equal(result.watchStatus, "failed");
  assert.match(result.error!, /do not resend/);
});

test("delegated task is agent-attributed text, never an owner slash command", async () => {
  let message = "";
  await spawnDockWorker(source, { ...request, task: "/extension-write" }, {
    create: async () => ({ type: "create", instance: child }),
    send: async input => { message = input.message; return { target: child } as never; },
    watch: async () => ({ type: "watch", status: "watching" }) as never,
  });
  assert.equal(message, `[Agent message from "Coordinator"]\n/extension-write`);
  assert.equal(message.startsWith("/"), false);
});

test("native collaboration wire validates tool selections, delivery and terminal controls", async () => {
  const { parseDockToolsRequest, parseDockToolsResult } = await import("../src/core/dock-tools-codec.js");
  const spawn = { ...request, model: { provider: "local", id: "model" }, thinkingLevel: "low", allowedTools: ["read", "dock_send"] };
  assert.deepEqual(parseDockToolsRequest(JSON.parse(JSON.stringify(spawn))), spawn);
  assert.deepEqual(parseDockToolsRequest({ type: "create", operationId: "delegated", cwd: "/project", allowedTools: ["read"] }), { type: "create", operationId: "delegated", cwd: "/project", allowedTools: ["read"] });
  assert.deepEqual(parseDockToolsRequest({ type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" }), { type: "send", operationId: "message", target: "child", message: "review", delivery: "followUp" });
  for (const type of ["interrupt", "stop"] as const) assert.deepEqual(parseDockToolsRequest({ type, operationId: "control", target: "child" }), { type, operationId: "control", target: "child" });
  assert.throws(() => parseDockToolsRequest({ ...spawn, thinkingLevel: "infinite" }), /Thinking level/);
  assert.throws(() => parseDockToolsRequest({ ...spawn, parentId: "spoofed" }), /unknown|unexpected/i);
  assert.throws(() => parseDockToolsRequest({ ...spawn, cwd: "relative" }), /absolute/);
  assert.doesNotThrow(() => parseDockToolsResult({ type: "spawn", instance: child, taskStatus: "accepted", watchStatus: "failed", error: "Watch unavailable; inspect child" }));
});
