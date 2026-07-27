import assert from "node:assert/strict";
import test from "node:test";

import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES,
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerEnvelope,
  validateAgentWorkerResult,
  validateUiCapabilityResult,
  type WorkerFrame,
  type WorkerIdentity,
} from "../src/pi/worker-protocol.js";

const IDENTITY: WorkerIdentity = {
  hostEpoch: "host-test",
  instanceId: "instance-test",
  runtimeGeneration: 1,
  workerIncarnation: "worker-test",
};

const STATE = {
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
  extensionCommands: [],
};

function request(type: string, params: Record<string, unknown>) {
  return { kind: "request", version: 2, requestId: "request-1", type, params };
}

function agentCall(type: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { kind: "agent_request", callId: "call-1", request: request(type, params), ...extra };
}

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





test("private Worker admission reports the delivery actually chosen by the Agent", () => {
  assert.deepEqual(parseWorkerEnvelope({
    kind: "preflight", callId: "call-1", success: true, delivery: "prompt",
  }), { kind: "preflight", callId: "call-1", success: true, delivery: "prompt" });
  assert.deepEqual(parseWorkerEnvelope({
    kind: "preflight", callId: "call-2", success: false,
  }), { kind: "preflight", callId: "call-2", success: false });
  assert.throws(() => parseWorkerEnvelope({
    kind: "preflight", callId: "call-3", success: true,
  }), /delivery/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "preflight", callId: "call-4", success: false, delivery: "steer",
  }), /cannot declare delivery/i);
  const hostQueued = parseWorkerEnvelope(agentCall("command.submit", {
    operationId: "op", instanceId: "instance-test", message: "queued", delivery: "steer",
  }, { context: { type: "host_queue" } }));
  assert.equal(hostQueued.kind === "agent_request" ? hostQueued.context?.type : undefined, "host_queue");
  assert.throws(() => parseWorkerEnvelope(agentCall("command.submit", {
    operationId: "op", instanceId: "instance-test", message: "direct", delivery: "prompt",
  }, { context: { type: "host_queue" } })), /Host queue context/i);
});

test("private Worker conversation boundary accepts checkpoints and canonical persisted records", () => {
  assert.equal(parseWorkerEnvelope({
    kind: "event", event: { type: "conversation_checkpoint", history: [] }, state: STATE,
  }).kind, "event");
  assert.equal(parseWorkerEnvelope({
    kind: "event",
    event: { type: "dock_conversation_frame", frame: { type: "message.delta", data: { messageId: "assistant-1", block: "text", delta: "hello" } } },
    state: STATE,
  }).kind, "event");
  assert.throws(() => parseWorkerEnvelope({
    kind: "event", event: { type: "conversation_checkpoint", history: [], injected: true }, state: STATE,
  }), /unknown field/i);
  validateAgentWorkerResult("session.history", [{
    recordId: "record-1",
    entryId: "record-1",
    kind: "custom_message",
    source: "extension",
    visibility: "conversation",
    content: [{ type: "text", text: "visible extension output" }],
    customType: "fixture",
    display: true,
    metadata: { accepted: true },
  }]);
  assert.throws(() => validateAgentWorkerResult("session.history", [{
    entryId: "legacy",
    role: "assistant",
    content: "legacy private shape",
  }]), /unknown field|record id/i);
});

test("private worker protocol rejects malformed generic requests, events, state, and generation fences", () => {
  assert.throws(() => parseWorkerEnvelope({
    kind: "event",
    event: { type: "dock_session_replaced", reason: "unexpected", sessionFile: "/tmp/next.jsonl" },
    state: STATE,
  }), /replacement reason/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "call", callId: "x", capability: "runtime.private", args: {} }), /capability/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "response", callId: "x", ok: true, result: null, error: { injected: true } }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope({ kind: "response", callId: "x", ok: false, error: { code: "runtime_error", name: "Error", message: "failed" }, result: null }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope(agentCall("session.switch", {
    operationId: "op", instanceId: "instance-test", sessionFile: "/tmp/next.jsonl",
  })), /invoke context/i);
  assert.throws(() => parseWorkerEnvelope(agentCall("session.switch", {
    operationId: "op", instanceId: "instance-test", sessionFile: "/tmp/next.jsonl",
  }, { context: { type: "session_switch", canonicalCwd: "/tmp", projectTrusted: true, injected: true } })), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope(agentCall("settings.update", {
    operationId: "op", instanceId: "instance-test", update: { key: "autoCompaction", value: "yes" },
  })), /must be boolean/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "event", event: { type: "message_end", message: { role: "assistant", content: [], injected: true } }, state: STATE,
  }), /event type|unknown field/i);
  assert.throws(() => parseWorkerEnvelope({
    kind: "event", event: { type: "agent_start" }, state: { ...STATE, injected: true },
  }), /unknown field/i);
  assert.throws(() => parseWorkerEnvelope(agentCall("runtime.private", { instanceId: "instance-test" })), /request type|unknown/i);
  const receiver = new WorkerFrameReceiver((identity) => identity.runtimeGeneration === 2);
  assert.throws(() => receiver.accept({
    protocol: "alu-dock-pi-worker", version: 1, identity: IDENTITY,
    sequence: 1, transferId: "x", index: 0, count: 1,
    payload: JSON.stringify({ kind: "agent_control", callId: "x", control: { type: "wait_for_idle" } }),
  }), /fence/);
});
