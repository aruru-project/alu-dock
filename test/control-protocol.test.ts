import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import {
  capabilityForRequest,
  parseAttachmentDto,
  parseAttachmentUploadFrame,
  parseAttachmentUploadResult,
  parseClientHello,
  parseControlEventEnvelope,
  parseControlRequest,
  parseControlResponse,
  parseEnsureResult,
  parseHistoryResult,
  parseKeyLookupResult,
  parseStatusResult,
  ProtocolValidationError,
  INSTANCE_READ_CAPABILITY,
  EVENTS_FOLLOW_CAPABILITY,
  EXTENSION_UI_CONTROL_CAPABILITY,
  INSTANCE_KEYS_CAPABILITY,
  INSTANCE_DISPLAY_NAME_CAPABILITY,
  CONVERSATION_CONTENT_CAPABILITY,
  WORKSPACE_LIST_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  requiredCapabilities,
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
    id: "i1", creationOperationId: "op-create", key: "alu", displayName: "alu", cwd: "/tmp/project",
    lifecycle: "active", execution: "idle", compacting: false, lastRun: "never", reopenable: false,
    runtimeGeneration: 1, ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: "fixture", piSessionId: "pi-1" }, extensionStatus: {}, toolsExpanded: false,
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z", executionChangedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 },
  };
}



function validEvent(type = "message.delta", data: Record<string, unknown> = { messageId: "m1", block: "text", delta: "hello" }): Record<string, unknown> {
  return { scope: "instance", sequence: 1, instanceId: "i1", runtimeGeneration: 1, occurredAt: "2026-07-14T00:00:00.000Z", type, data };
}

test("Protocol V2 clients accept additive Host response and event fields", () => {
  assert.equal(parseControlResponse({
    kind: "response", version: 2, requestId: "response-1", hostEpoch: "epoch-1", ok: true,
    result: { accepted: true }, futureEnvelopeField: true,
  }, "response-1", "epoch-1").ok, true);

  const parsed = parseControlEventEnvelope({
    kind: "event", version: 2, requestId: "follow-1", hostEpoch: "epoch-1", futureEnvelopeField: true,
    event: {
      ...validEvent("extension.notification", {
        message: "command output", level: "info", operationId: "operation-1", futureDataField: true,
      }),
      futureEventField: true,
    },
  }, "follow-1", "epoch-1");
  assert.equal(parsed.event.type, "extension.notification");
  if (parsed.event.type === "extension.notification") {
    assert.deepEqual(parsed.event.data, { message: "command output", level: "info", operationId: "operation-1" });
  }

  assert.equal(parseStatusResult({
    instance: { ...validSnapshot(), futureSnapshotField: true },
    futureResultField: true,
  }).instance.id, "i1");
  assert.throws(() => parseStatusResult({
    instance: { ...validSnapshot(), displayName: "<unsafe>\nlabel" },
  }), /canonical safe display name/u);
});

test("Protocol V2 history exposes only canonical persisted conversation records", () => {
  const record = {
    recordId: "entry-1",
    entryId: "entry-1",
    kind: "custom_message",
    source: "extension",
    visibility: "conversation",
    content: [{ type: "text", text: "extension output" }],
    customType: "fixture",
    display: true,
    metadata: { status: "ready" },
  };
  const parsed = parseHistoryResult({ historyRevision: 1, entries: [record], hasEarlier: false, instance: validSnapshot() });
  assert.equal(parsed.entries[0]?.recordId, "entry-1");
  assert.equal(parsed.entries[0]?.source, "extension");
  assert.deepEqual(parsed.entries[0]?.metadata, { status: "ready" });
  assert.throws(() => parseHistoryResult({
    historyRevision: 1,
    entries: [{ entryId: "legacy", role: "assistant", content: [{ type: "text", text: "legacy" }] }],
    hasEarlier: false,
    instance: validSnapshot(),
  }), /Unexpected field|recordId/u);
});











test("attachment upload frames and path-free DTOs are closed and bounded", () => {
  const request = parseControlRequest({
    kind: "request", version: 2, requestId: "upload-request", type: "attachment.upload",
    params: { operationId: "upload-op", name: "文档 final.bin", sizeBytes: 3, mediaType: "application/octet-stream", sha256: "a".repeat(64) },
  });
  assert.equal(request.type, "attachment.upload");
  assert.equal(capabilityForRequest(request.type), ATTACHMENTS_CAPABILITY);
  assert.deepEqual(parseAttachmentUploadFrame({ kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: Buffer.from("abc").toString("base64") }, "upload-request"), {
    kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: "YWJj",
  });
  assert.deepEqual(parseAttachmentUploadFrame({ kind: "attachment_complete", version: 2, requestId: "upload-request", chunks: 1 }, "upload-request"), {
    kind: "attachment_complete", version: 2, requestId: "upload-request", chunks: 1,
  });
  assert.throws(() => parseAttachmentUploadFrame({ kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: "YQ" }, "upload-request"), /canonical base64/u);
  assert.throws(() => parseControlRequest({ kind: "request", version: 2, requestId: "upload-request", type: "attachment.upload", params: { operationId: "upload-op", name: "x", sizeBytes: 536_870_913, sha256: "a".repeat(64) } }), /must not exceed/u);

  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000", name: "文档 final.bin", sizeBytes: 3,
    mediaType: "application/octet-stream", sha256: "a".repeat(64), storedAt: "2026-08-16T00:00:00.000Z",
  };
  assert.deepEqual(parseAttachmentDto(attachment), attachment);
  assert.deepEqual(parseAttachmentUploadResult({ attachment, status: "stored" }), { attachment, status: "stored" });
  assert.equal("path" in parseAttachmentDto({ ...attachment, path: "/private/store" }), false);
  assert.throws(() => parseAttachmentUploadResult({ attachment, status: "cached" }), /unsupported value/u);
});

test("V2 requests reject unsupported versions, unknown fields, invalid cursors, and invalid enums", () => {
  assert.throws(
    () => parseControlRequest({ version: 3, requestId: "r1", type: "ping" }),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "unsupported_protocol",
  );
  const base = { kind: "request", version: 2, requestId: "r2" };
  assert.throws(() => parseControlRequest({ ...base, type: "host.info", params: { extra: true } }), /Unexpected field/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.follow",
    params: { instanceId: "i1", since: { hostEpoch: "e1", instanceId: "i1", runtimeGeneration: 1, sequence: -1 } },
  }), (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_request");
  assert.throws(() => parseControlRequest({ ...base, type: "instance.follow", params: { instanceId: "i1" } }), /params\.since/);
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "instance.read",
    params: { instanceId: "i1", replay: "event_log" },
  }).params, { instanceId: "i1", since: undefined, replay: "event_log" });
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "interaction.control",
    params: { instanceId: "i1" },
  }).params, { instanceId: "i1" });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.read",
    params: { instanceId: "i1", since: { hostEpoch: "e1", instanceId: "i1", runtimeGeneration: 1, sequence: 1 }, replay: "conversation_bootstrap" },
  }), /requires a fresh read/);
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
  assert.deepEqual(parseControlRequest({ ...base, type: "session.history", params: { instanceId: "i1", beforeEntryId: "entry-2", limit: 200 } }).params, { instanceId: "i1", beforeEntryId: "entry-2", limit: 200 });
  assert.throws(() => parseControlRequest({ ...base, type: "session.history", params: { instanceId: "i1", limit: 201 } }), /between 1 and 200/);
  assert.deepEqual(parseControlRequest({ ...base, type: "conversation.history", params: { instanceId: "i1", cursor: "cursor-1", limit: 50 } }).params, { instanceId: "i1", cursor: "cursor-1", limit: 50 });
  assert.deepEqual(parseControlRequest({ ...base, type: "conversation.content", params: { instanceId: "i1", contentRef: "content-1", cursor: "cursor-2" } }).params, { instanceId: "i1", contentRef: "content-1", cursor: "cursor-2" });
  assert.throws(() => parseControlRequest({ ...base, type: "conversation.content", params: { instanceId: "i1", contentRef: "" } }), /non-empty/);
  assert.deepEqual(parseControlRequest({ ...base, type: "session.inventory", params: { cwd: "/tmp/project", scope: "cwd" } }), {
    ...base, type: "session.inventory", params: { cwd: "/tmp/project", scope: "cwd" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.inventory", params: { cwd: "relative", scope: "all" } }), /must be absolute/);
  assert.deepEqual(parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "all" } }), {
    ...base, type: "session.list", params: { instanceId: "i1", scope: "all" },
  });
  assert.throws(() => parseControlRequest({ ...base, type: "session.list", params: { instanceId: "i1", scope: "project" } }), /unsupported value/);
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "workspace.list",
    params: { path: "/work/project", cursor: { revision: "listing-1", offset: 200 }, limit: 200 },
  }).params, { path: "/work/project", cursor: { revision: "listing-1", offset: 200 }, limit: 200 });
  assert.throws(() => parseControlRequest({ ...base, type: "workspace.list", params: { path: "relative", limit: 200 } }), /must be absolute/u);
  assert.throws(() => parseControlRequest({ ...base, type: "workspace.list", params: { path: "/work", limit: 201 } }), /must not exceed 200/u);
  assert.deepEqual(parseControlRequest({ ...base, type: "command.abort", params: { operationId: "abort-op", instanceId: "i1" } }).params, { operationId: "abort-op", instanceId: "i1" });
  assert.throws(() => parseControlRequest({ ...base, type: "command.abort", params: { operationId: "abort-op", instanceId: "i1", force: true } }), /Unexpected field/);
  assert.deepEqual(parseControlRequest({ ...base, type: "queue.dequeue", params: { operationId: "dequeue-op", instanceId: "i1" } }).params, { operationId: "dequeue-op", instanceId: "i1" });
  assert.throws(() => parseControlRequest({ ...base, type: "queue.dequeue", params: { operationId: "dequeue-op", instanceId: "i1", abort: true } }), /Unexpected field/);
  assert.deepEqual(parseControlRequest({
    ...base,
    type: "instance.list",
    params: { selector: "actionable", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 },
  }).params, { selector: "actionable", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.list",
    params: { selector: "all", cursor: { revision: 7, offset: 100, selector: "actionable" }, limit: 100 },
  }), /selector does not match/u);
  assert.throws(() => parseControlRequest({ ...base, type: "instance.list", params: { selector: "all", limit: 101 } }), /must not exceed 100/u);
  assert.equal(capabilityForRequest("instance.adopt"), "session.adopt.v1");
  assert.equal(capabilityForRequest("instance.ensure"), INSTANCE_KEYS_CAPABILITY);
  assert.equal(capabilityForRequest("instance.get_by_key"), INSTANCE_KEYS_CAPABILITY);
  assert.equal(capabilityForRequest("conversation.history"), CONVERSATION_CONTENT_CAPABILITY);
  assert.equal(capabilityForRequest("conversation.content"), CONVERSATION_CONTENT_CAPABILITY);
  assert.equal(capabilityForRequest("workspace.list"), WORKSPACE_LIST_CAPABILITY);
  assert.equal(capabilityForRequest("session.inventory"), "session.inventory.v1");
  assert.equal(capabilityForRequest("extension.tools_expanded.set"), "extension_ui.tools-expanded.v1");
  assert.equal(capabilityForRequest("extension.widget_viewport.set"), "extension_ui.widgets.v1");
  assert.equal(capabilityForRequest("instance.read"), INSTANCE_READ_CAPABILITY);
  assert.equal(capabilityForRequest("instance.follow"), EVENTS_FOLLOW_CAPABILITY);
  assert.equal(capabilityForRequest("interaction.control"), EXTENSION_UI_CONTROL_CAPABILITY);
  assert.deepEqual(requiredCapabilities(EVENTS_FOLLOW_CAPABILITY), ["core.v2", INSTANCE_READ_CAPABILITY, "extension_ui.tools-expanded.v1", "git.branch-footer.v1", "instance.keys.v1", INSTANCE_DISPLAY_NAME_CAPABILITY, "tool-result-presentation.v1", EVENTS_FOLLOW_CAPABILITY]);

  const ensured = parseControlRequest({
    ...base,
    type: "instance.ensure",
    params: { operationId: "ensure-1", key: "alu", cwd: "/tmp/project", name: "Alu Workstation" },
  });
  assert.deepEqual(ensured.params, {
    operationId: "ensure-1", key: "alu", cwd: "/tmp/project", name: "Alu Workstation",
    trustChallengeId: undefined, projectTrustDecision: undefined,
  });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.ensure",
    params: { operationId: "ensure-2", key: "", cwd: "/tmp/project" },
  }), /non-empty/u);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.ensure",
    params: { operationId: "ensure-3", key: "bad\nkey", cwd: "/tmp/project" },
  }), /control characters/u);
  assert.deepEqual(parseEnsureResult({ created: false, instance: validSnapshot() }), {
    created: false,
    instance: parseStatusResult({ instance: validSnapshot() }).instance,
  });
  assert.deepEqual(parseControlRequest({ ...base, type: "instance.get_by_key", params: { key: "alu" } }).params, { key: "alu" });
  assert.equal(parseKeyLookupResult({ instance: null }).instance, null);
  assert.equal(parseKeyLookupResult({ instance: validSnapshot() }).instance?.key, "alu");

  const adopted = parseControlRequest({
    ...base,
    type: "instance.adopt",
    params: { operationId: "adopt-1", sessionFile: "/tmp/session.jsonl", name: "adopted" },
  });
  assert.deepEqual(adopted.params, {
    operationId: "adopt-1", sessionFile: "/tmp/session.jsonl", name: "adopted",
    trustChallengeId: undefined, projectTrustDecision: undefined,
  });
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.adopt",
    params: { operationId: "adopt-2", sessionFile: "relative.jsonl" },
  }), /must be absolute/);

  const trustedCreate = parseControlRequest({
    ...base,
    type: "instance.create",
    params: {
      operationId: "create-1",
      cwd: "/tmp/project",
      trustChallengeId: "challenge-1",
      projectTrustDecision: "deny_once",
    },
  });
  assert.equal(trustedCreate.type, "instance.create");
  assert.equal(trustedCreate.params.projectTrustDecision, "deny_once");
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-1", cwd: "/tmp/project", trustChallengeId: "challenge-1" },
  }), /must be supplied together/);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-1", cwd: "/tmp/project", trustChallengeId: "challenge-1", projectTrustDecision: "allow" },
  }), /unsupported value/);
});
