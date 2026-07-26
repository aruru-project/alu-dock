import assert from "node:assert/strict";
import test from "node:test";

import {
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerEnvelope,
  validateCapabilityResult,
  type WorkerFrame,
  type WorkerIdentity,
} from "../src/pi/worker-protocol.js";

const IDENTITY: WorkerIdentity = {
  hostEpoch: "host-test",
  instanceId: "instance-test",
  runtimeGeneration: 1,
  workerIncarnation: "worker-test",
};

const CACHE = {
  sessionId: "session-test",
  sessionFile: "/tmp/session-test.jsonl",
  durableSessionFile: "/tmp/session-test.jsonl",
  isStreaming: false,
  isCompacting: false,
  modelState: { model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", availableThinkingLevels: ["off"] },
  metrics: {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  },
  history: [],
  tree: { nodes: [] },
  extensionCommands: [],
};

test("private worker protocol chunks and reassembles one ordered bounded result", async () => {
  const frames: WorkerFrame[] = [];
  const sender = new OrderedWorkerSender(IDENTITY, (message, callback) => {
    frames.push(structuredClone(message));
    queueMicrotask(() => callback(null));
    return true;
  });
  const payload = "阿露".repeat(80_000);
  await sender.sendEnvelope({ kind: "response", callId: "call-1", ok: true, result: { payload } });
  assert.ok(frames.length > 1);
  const receiver = new WorkerFrameReceiver((identity) => identity.workerIncarnation === IDENTITY.workerIncarnation);
  let result;
  for (const frame of frames) result = receiver.accept(frame) ?? result;
  assert.equal(result?.kind, "response");
  if (result?.kind !== "response" || !result.ok) assert.fail("result did not round trip");
  assert.equal((result.result as { payload: string }).payload, payload);
});

test("private worker protocol preserves an aggregate projection larger than the former 32 MiB ceiling", async () => {
  const frames: WorkerFrame[] = [];
  const sender = new OrderedWorkerSender(IDENTITY, (message, callback) => { frames.push(message); queueMicrotask(() => callback(null)); return true; });
  const payload = Array.from({ length: 34 }, (_, index) => `${index}:` + "x".repeat(1024 * 1024));
  await sender.sendEnvelope({ kind: "response", callId: "large", ok: true, result: { payload } });
  const receiver = new WorkerFrameReceiver(() => true);
  let result;
  for (const frame of frames) result = receiver.accept(frame) ?? result;
  assert.equal(result?.kind, "response");
  if (result?.kind === "response" && result.ok) assert.equal((result.result as { payload: string[] }).payload[33], payload[33]);
});

test("private worker protocol accepts effect custody and the bounded reverse Dock identity capability", () => {
  assert.deepEqual(parseWorkerEnvelope({ kind: "accepted", callId: "mutation-1" }), { kind: "accepted", callId: "mutation-1" });
  assert.deepEqual(
    parseWorkerEnvelope({ kind: "call", callId: "identity-1", capability: "dock.identity", args: {} }),
    { kind: "call", callId: "identity-1", capability: "dock.identity", args: {} },
  );
});

test("private worker protocol rejects malformed critical events, unknown capabilities, and generation fences", () => {
  assert.throws(() => parseWorkerEnvelope({
    kind: "event",
    event: { type: "dock_session_replaced", reason: "unexpected", sessionFile: "/tmp/next.jsonl" },
    cache: CACHE,
  }), /replacement reason/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "call", callId: "x", capability: "runtime.private", args: {} }), /capability/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "response", callId: "x", ok: true, result: null, error: { injected: true } }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "response", callId: "x", ok: false, error: { code: "runtime_error", name: "Error", message: "failed" }, result: null }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "call", callId: "x", capability: "runtime.switchSession",
    args: { operationId: "op", sessionFile: "/tmp/next.jsonl", trust: { canonicalCwd: "/tmp", projectTrusted: true, injected: true } },
  }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "call", callId: "x", capability: "runtime.updateSetting",
    args: { update: { key: "autoCompaction", value: "yes" } },
  }), /value is invalid/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "event",
    event: { type: "message_end", message: { role: "assistant", content: [], injected: true } },
    cache: CACHE,
  }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "event", event: { type: "agent_start" },
    cache: { ...CACHE, metrics: { ...CACHE.metrics, injected: true } },
  }), /unknown field/i);
  assert.throws(() => validateCapabilityResult("runtime.setActiveTools", {
    tools: [{ name: "read", description: "read", active: true, injected: true }], total: 1, truncated: false,
  }), /unknown field/i);
  assert.throws(() => validateCapabilityResult("runtime.updateSetting", {
    key: "autoCompaction", value: true, source: "global", writable: true, valueType: "boolean",
    reloadRequired: false, hostRestartRequired: false, injected: true,
  }), /unknown field/i);
  const receiver = new WorkerFrameReceiver((identity) => identity.runtimeGeneration === 2);
  assert.throws(() => receiver.accept({
    protocol: "alu-dock-pi-worker", version: 1, identity: IDENTITY,
    sequence: 1, transferId: "x", index: 0, count: 1,
    payload: JSON.stringify({ kind: "call", callId: "x", capability: "runtime.abort", args: {} }),
  }), /fence/);
});
