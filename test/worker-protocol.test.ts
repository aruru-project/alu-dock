import assert from "node:assert/strict";
import test from "node:test";

import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES,
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerEnvelope,
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

test("private worker protocol preserves an aggregate result larger than the former 32 MiB ceiling", async () => {
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

test("private worker protocol carries generic Agent requests, acceptance, preflight, and reverse Dock identity", () => {
  assert.deepEqual(parseWorkerEnvelope({ kind: "accepted", callId: "mutation-1" }), { kind: "accepted", callId: "mutation-1" });
  assert.deepEqual(parseWorkerEnvelope({ kind: "preflight", callId: "prompt-1", success: true }), { kind: "preflight", callId: "prompt-1", success: true });
  assert.deepEqual(
    parseWorkerEnvelope({ kind: "call", callId: "identity-1", capability: "dock.identity", args: {} }),
    { kind: "call", callId: "identity-1", capability: "dock.identity", args: {} },
  );
  assert.equal(parseWorkerEnvelope(agentCall("tool.list", { instanceId: "instance-test" })).kind, "agent_request");
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
  }), /unknown field/i);
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

test("Worker conversation requests use Protocol V2 bounds without a runtime capability mirror", () => {
  assert.doesNotThrow(() => parseWorkerEnvelope(agentCall("conversation.history", {
    instanceId: "instance-test", cursor: "cursor-1", limit: 50,
  })));
  assert.doesNotThrow(() => parseWorkerEnvelope(agentCall("conversation.content", {
    instanceId: "instance-test", contentRef: "content-1", cursor: "cursor-2",
  })));
  assert.throws(() => parseWorkerEnvelope(agentCall("conversation.history", {
    instanceId: "instance-test", limit: 201,
  })), /limit/i);
  assert.throws(() => parseWorkerEnvelope(agentCall("conversation.content", {
    instanceId: "instance-test", contentRef: "x".repeat(513),
  })), /contentRef must be a bounded string/i);
});

test("Worker controller directive capabilities remain exact, bounded, and control-safe", () => {
  const call = (capability: "ui.setTitle" | "ui.setEditorText", args: Record<string, unknown>) => parseWorkerEnvelope({ kind: "call", callId: "directive-call", capability, args });
  assert.ok(ORDINARY_REVERSE_WORKER_CAPABILITIES.includes("ui.setTitle"));
  assert.ok(ORDINARY_REVERSE_WORKER_CAPABILITIES.includes("ui.setEditorText"));
  assert.doesNotThrow(() => call("ui.setTitle", { title: "Review queue" }));
  assert.doesNotThrow(() => call("ui.setEditorText", { text: "line one\nline two\tindented" }));
  assert.throws(() => call("ui.setTitle", { title: "bad\nline" }), /control-safe/i);
  assert.throws(() => call("ui.setTitle", { title: "x".repeat(2_049) }), /bounded/i);
  assert.throws(() => call("ui.setEditorText", { text: "bad\u001b[2J" }), /control-safe/i);
  assert.doesNotThrow(() => call("ui.setEditorText", { text: "data:image/png;base64,A0+/A0+/" }));
  assert.throws(() => call("ui.setEditorText", { text: "x".repeat(256_001) }), /bounded/i);
  assert.throws(() => call("ui.setTitle", { title: "ok", injected: true }), /unknown field/i);
  assert.throws(() => validateUiCapabilityResult("ui.setTitle", "unexpected"), /must be empty/i);
  assert.doesNotThrow(() => validateUiCapabilityResult("ui.setEditorText", null));
});

test("Worker prompt image descriptors remain closed and bounded", () => {
  assert.doesNotThrow(() => parseWorkerEnvelope(agentCall("command.submit", {
    operationId: "image-op", instanceId: "instance-test", message: "", delivery: "prompt",
    images: [{ path: "/tmp/input", mimeType: "image/x-custom" }],
  })));
  assert.throws(() => parseWorkerEnvelope(agentCall("command.submit", {
    operationId: "image-op", instanceId: "instance-test", message: "", delivery: "prompt",
    images: [{ path: "relative", mimeType: "image/png" }],
  })));
  assert.throws(() => parseWorkerEnvelope(agentCall("command.submit", {
    operationId: "image-op", instanceId: "instance-test", message: "same", delivery: "steer",
    images: [{ path: "/tmp/input", mimeType: "image/png", data: "AAAA" }],
  })));
});
