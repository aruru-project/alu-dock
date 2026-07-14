import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import {
  parseClientHello,
  parseControlEventEnvelope,
  parseControlRequest,
  parseControlResponse,
  parseEventsResult,
  parseModelConfigurationResult,
  parseSessionsResult,
  parseStatusResult,
  ProtocolValidationError,
} from "../src/control/protocol.js";

test("JSONL decoder preserves split UTF-8 and treats Unicode separators as data", () => {
  const decoder = new JsonLineDecoder();
  const line = JSON.stringify({ text: "你\u2028好" });
  const encoded = Buffer.from(`${line}\n`, "utf8");
  const split = encoded.indexOf(Buffer.from("你")) + 1;
  assert.deepEqual(decoder.push(encoded.subarray(0, split)), []);
  assert.deepEqual(decoder.push(encoded.subarray(split)), [line]);
  assert.deepEqual(decoder.finish(), []);
});

test("JSONL decoder rejects oversized and unterminated records", () => {
  const oversized = new JsonLineDecoder(4);
  assert.throws(() => oversized.push("12345"), (error: unknown) => error instanceof JsonLineError && error.code === "record_too_large");
  const incomplete = new JsonLineDecoder();
  incomplete.push('{"ok":true}');
  assert.throws(() => incomplete.finish(), (error: unknown) => error instanceof JsonLineError && error.code === "incomplete_record");
});

test("V2 hello is closed, bounded, and rejects duplicate capabilities", () => {
  const hello = { kind: "hello", requestId: "h1", versions: [2], client: { name: "test", version: "0.1.0", clientId: "c1" }, requiredCapabilities: ["core.v2"] };
  assert.deepEqual(parseClientHello(hello), hello);
  assert.throws(() => parseClientHello({ ...hello, extra: true }), /Unexpected field/);
  assert.throws(() => parseClientHello({ ...hello, requiredCapabilities: ["core.v2", "core.v2"] }), /must be unique/);
  assert.throws(() => parseClientHello({ ...hello, versions: [1, 2.5] }), /bounded positive integer array/);
});

function validSnapshot(): Record<string, unknown> {
  return {
    id: "i1", creationOperationId: "op-create", cwd: "/tmp/project",
    lifecycle: "active", execution: "idle", lastRun: "never", reopenable: false,
    runtimeGeneration: 1, ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: "pi-1" }, extensionStatus: {},
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 },
  };
}

function validEvent(type = "message.delta", data: Record<string, unknown> = { messageId: "m1", block: "text", delta: "hello" }): Record<string, unknown> {
  return { scope: "instance", sequence: 1, instanceId: "i1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:00.000Z", type, data };
}

test("V2 requests reject unsupported versions, unknown fields, invalid cursors, and invalid enums", () => {
  assert.throws(
    () => parseControlRequest({ version: 3, requestId: "r1", type: "ping" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "unsupported_protocol",
  );
  const base = { kind: "request", version: 2, requestId: "r2" };
  assert.throws(() => parseControlRequest({ ...base, type: "host.info", params: { extra: true } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "observe", since: { hostEpoch: "e1", instanceId: "i1", runtimeGeneration: 1, sequence: -1 } },
  }), (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_request");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.attach",
    params: { instanceId: "i1", follow: false, controller: "observe", since: 4 },
  }), (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_request");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "command.submit",
    params: { operationId: "op1", instanceId: "i1", message: "hello", delivery: "parallel" },
  }), /unsupported value/);

  assert.deepEqual(parseControlRequest({
    ...base,
    type: "model.set",
    params: { operationId: "op1", instanceId: "i1", provider: "local", modelId: "qwen/test" },
  }), {
    ...base,
    type: "model.set",
    params: { operationId: "op1", instanceId: "i1", provider: "local", modelId: "qwen/test" },
  });
  assert.deepEqual(parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "all" } }), {
    ...base, type: "session.list", params: { instanceId: "i1", scope: "all" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "project" } }), /unsupported value/);
});

test("model persistence and session list results are closed", () => {
  assert.deepEqual(parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: true } }).settingsWrite, { persisted: true });
  assert.throws(() => parseModelConfigurationResult({ instance: validSnapshot(), settingsWrite: { persisted: false } }), /must be true/);
  assert.deepEqual(parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z" }] }).sessions[0], {
    sessionId: "s1", sessionFile: "/tmp/s1.jsonl", name: undefined, cwd: "/tmp", updatedAt: "2026-07-14T00:00:00.000Z",
  });
  assert.throws(() => parseSessionsResult({ sessions: [{ sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp", raw: true }] }), /Unexpected field/);
});

test("response, snapshot, replay, and event parsers reject open or inconsistent DTOs", () => {
  assert.throws(() => parseControlResponse({ kind: "response", version: 2, requestId: "r1", hostEpoch: "epoch-1", ok: false, error: { code: "not_found", message: "missing", retryable: false, details: { arbitrary: true } } }, "r1", "epoch-1"), /does not allow details/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), extra: true } }), /Unexpected field/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), pending: { steering: 1, followUp: 1, total: 1 } } }), /total is inconsistent/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), lifecycle: "stopped", execution: "idle", ownerHostEpoch: undefined } }), /Lifecycle\/execution/);
  assert.throws(() => parseStatusResult({ instance: { ...validSnapshot(), eventCursor: { hostEpoch: "epoch-1", instanceId: "other", runtimeGeneration: 1, sequence: 1 } } }), /cursor domain/);

  const envelope = (event: unknown): Record<string, unknown> => ({ kind: "event", version: 2, requestId: "attach-1", hostEpoch: "epoch-1", event });
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", delta: "missing block" })), "attach-1", "epoch-1"), /block/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("message.delta", { messageId: "m1", block: "text", delta: "x", extra: true })), "attach-1", "epoch-1"), /Unexpected field/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("future.unknown", {})), "attach-1", "epoch-1"), /Unsupported event type/);

  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [validEvent()], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, controller: { status: "observing" }, following: false, extra: true,
  }), /Unexpected field/);
  assert.throws(() => parseEventsResult({
    instance: validSnapshot(),
    page: { events: [{ ...validEvent(), instanceId: "other" }], earliest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, latest: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, truncated: false, epochChanged: false, generationChanged: false },
    recentHistory: [], historyTruncated: true, controller: { status: "observing" }, following: false,
  }), /cursor domain\/order/);
  assert.throws(() => parseControlEventEnvelope(envelope(validEvent("settings.changed", { key: "unknown", value: true, reloadRequired: false, hostRestartRequired: false })), "attach-1", "epoch-1"), /Unsupported setting key/);
});
