import assert from "node:assert/strict";
import test from "node:test";

import { JsonLineDecoder, JsonLineError } from "../src/control/json-lines.js";
import { MAX_JSON_STRING_CHARS } from "../src/core/json-value.js";
import {
  CONVERSATION_CONTENT_STREAM_CAPABILITY,
  requestOptionCapabilities,
  capabilityForRequest,
  classifyControlRequest,
  parseAttachmentDto,
  parseAttachmentUploadFrame,
  parseAttachmentUploadResult,
  parseClientHello,
  parseControlEventEnvelope,
  parseControlRequest,
  parseControlResponse,
  parseConversationContentBody,
  parseDeliverableDownloadFrame,
  parseEnsureResult,
  parseHistoryResult,
  parseFileReadBody,
  parseFileReadResult,
  parseKeyLookupResult,
  parseMachinesResult,
  parseStatusResult,
  parseWorkspaceFileReadFrame,
  ProtocolValidationError,
  INSTANCE_READ_CAPABILITY,
  EVENTS_FOLLOW_CAPABILITY,
  EXTENSION_UI_CONTROL_CAPABILITY,
  INSTANCE_KEYS_CAPABILITY,
  INSTANCE_DISPLAY_NAME_CAPABILITY,
  CONVERSATION_CONTENT_CAPABILITY,
  WORKSPACE_LIST_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  WORKER_CONFIG_CAPABILITY,
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

  const status = parseStatusResult({
    instance: { ...validSnapshot(), hostId: "machine-1", futureSnapshotField: true },
    futureResultField: true,
  });
  assert.equal(status.instance.id, "i1");
  assert.equal(status.instance.hostId, "machine-1");
  assert.throws(() => parseStatusResult({
    instance: { ...validSnapshot(), displayName: "<unsafe>\nlabel" },
  }), /canonical safe display name/u);

  const machines = parseMachinesResult({
    machines: [{
      hostId: "windows-host", name: "Draw worker", kind: "subhost", available: true,
      platform: "windows", homePath: "C:\\Users\\artist", workspaceRoots: ["C:\\", "D:\\"], futureMachineField: true,
    }],
  });
  assert.deepEqual(machines.machines[0]?.workspaceRoots, ["C:\\", "D:\\"]);

  const workspaceFrame = parseWorkspaceFileReadFrame({
    kind: "workspace_file_read_error", version: 2, requestId: "workspace-1", hostEpoch: "epoch-1",
    instanceId: "i1", path: "notes.txt", futureFrameField: true,
    error: { code: "workspace_entry_unavailable", message: "gone", futureErrorField: true },
  }, { requestId: "workspace-1", hostEpoch: "epoch-1", instanceId: "i1", path: "notes.txt" });
  assert.equal(workspaceFrame.kind, "workspace_file_read_error");

  const deliveryFrame = parseDeliverableDownloadFrame({
    kind: "deliverable_download_ready", version: 2, requestId: "delivery-1", hostEpoch: "epoch-1",
    instanceId: "i1", deliveryRef: "ref-1", futureFrameField: true,
    deliverable: { deliveryRef: "ref-1", name: "result.txt", sizeBytes: 5, futureDeliverableField: true },
  }, { requestId: "delivery-1", hostEpoch: "epoch-1", instanceId: "i1", deliveryRef: "ref-1" });
  assert.equal(deliveryFrame.kind, "deliverable_download_ready");
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
  const imageAttachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000", name: "photo.png", sizeBytes: 19,
    mediaType: "image/png", sha256: "a".repeat(64), storedAt: "2026-08-19T00:00:00.000Z",
  };
  const imageRecord = {
    recordId: "entry-2", entryId: "entry-2", kind: "message", source: "user", visibility: "conversation",
    content: [{ type: "image", mimeType: "image/png", fileId: imageAttachment.fileId }],
    attachments: [imageAttachment],
  };
  const parsed = parseHistoryResult({ historyRevision: 1, entries: [record, imageRecord], hasEarlier: false, instance: validSnapshot() });
  assert.equal(parsed.entries[0]?.recordId, "entry-1");
  assert.equal(parsed.entries[0]?.source, "extension");
  assert.deepEqual(parsed.entries[0]?.metadata, { status: "ready" });
  assert.deepEqual(parsed.entries[1]?.content, imageRecord.content);
  assert.deepEqual(parsed.entries[1]?.attachments, [imageAttachment]);
  assert.throws(() => parseHistoryResult({
    historyRevision: 1,
    entries: [{ entryId: "legacy", role: "assistant", content: [{ type: "text", text: "legacy" }] }],
    hasEarlier: false,
    instance: validSnapshot(),
  }), /Unexpected field|recordId/u);
});











test("canonical request classification selects the instance command, query, and stream paths", () => {
  const base = { kind: "request" as const, version: 2 as const };
  const upload = parseControlRequest({
    ...base, requestId: "upload", type: "attachment.upload",
    params: { operationId: "upload-op", name: "file.bin", sizeBytes: 1, sha256: "a".repeat(64) },
  });
  const routedUpload = parseControlRequest({
    ...base, requestId: "routed-upload", type: "attachment.upload",
    params: { operationId: "routed-upload-op", instanceId: "work-1", name: "file.bin", sizeBytes: 1, sha256: "a".repeat(64) },
  });
  const stop = parseControlRequest({ ...base, requestId: "stop", type: "instance.stop", params: { operationId: "stop-op", instanceId: "work-1" } });
  const follow = parseControlRequest({
    ...base, requestId: "follow", type: "instance.follow",
    params: { instanceId: "work-1", since: { hostEpoch: "host-1", instanceId: "work-1", runtimeGeneration: 1, sequence: 0 } },
  });

  assert.deepEqual(classifyControlRequest(upload), { target: "directory", effect: "command", transport: "request_stream" });
  assert.deepEqual(classifyControlRequest(routedUpload), { target: "instance", effect: "command", transport: "request_stream" });
  assert.deepEqual(classifyControlRequest(stop), { target: "instance", effect: "command", transport: "unary" });
  assert.deepEqual(classifyControlRequest(follow), { target: "instance", effect: "query", transport: "follow" });
});

test("attachment upload frames and path-free DTOs are closed and bounded", () => {
  const request = parseControlRequest({
    kind: "request", version: 2, requestId: "upload-request", type: "attachment.upload",
    params: { operationId: "upload-op", name: "文档 final.bin", sizeBytes: 3, mediaType: "application/octet-stream", sha256: "a".repeat(64) },
  });
  assert.equal(request.type, "attachment.upload");
  assert.equal(request.params.instanceId, undefined);
  const routedRequest = parseControlRequest({
    kind: "request", version: 2, requestId: "routed-upload-request", type: "attachment.upload",
    params: { operationId: "routed-upload-op", instanceId: "main-work-1", name: "remote.bin", sizeBytes: 3, sha256: "b".repeat(64) },
  });
  assert.equal(routedRequest.type, "attachment.upload");
  assert.equal(routedRequest.params.instanceId, "main-work-1");
  assert.equal(capabilityForRequest(request.type), ATTACHMENTS_CAPABILITY);
  assert.deepEqual(parseAttachmentUploadFrame({ kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: Buffer.from("abc").toString("base64") }, "upload-request"), {
    kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: "YWJj",
  });
  assert.deepEqual(parseAttachmentUploadFrame({ kind: "attachment_complete", version: 2, requestId: "upload-request", chunks: 1 }, "upload-request"), {
    kind: "attachment_complete", version: 2, requestId: "upload-request", chunks: 1,
  });
  assert.throws(() => parseAttachmentUploadFrame({ kind: "attachment_chunk", version: 2, requestId: "upload-request", index: 0, data: "YQ" }, "upload-request"), /canonical base64/u);
  assert.throws(() => parseControlRequest({ kind: "request", version: 2, requestId: "upload-request", type: "attachment.upload", params: { operationId: "upload-op", instanceId: "main-work-1", name: "x", sizeBytes: 536_870_913, sha256: "a".repeat(64) } }), /must not exceed/u);

  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000", name: "文档 final.bin", sizeBytes: 3,
    mediaType: "application/octet-stream", sha256: "a".repeat(64), storedAt: "2026-08-16T00:00:00.000Z",
  };
  assert.deepEqual(parseAttachmentDto(attachment), attachment);
  assert.deepEqual(parseAttachmentUploadResult({ attachment, status: "stored" }), { attachment, status: "stored" });
  assert.equal("path" in parseAttachmentDto({ ...attachment, path: "/private/store" }), false);
  assert.throws(() => parseAttachmentUploadResult({ attachment, status: "cached" }), /unsupported value/u);
});

test("published file pages require exact byte continuity and the requested offset", () => {
  const file = { presentation: "image" as const, fileRef: "file-1", name: "display.png", sizeBytes: 5, mediaType: "image/png" };
  assert.deepEqual(parseFileReadBody({ file, offset: 0, data: "YWJj", complete: false, nextOffset: 3 }), { file, offset: 0, data: "YWJj", complete: false, nextOffset: 3 });
  assert.deepEqual(parseFileReadBody({ file, offset: 3, data: "ZGU=", complete: true }), { file, offset: 3, data: "ZGU=", complete: true });
  assert.throws(() => parseFileReadBody({ file, offset: 0, data: "YWJj", complete: false, nextOffset: 4 }), /pagination is inconsistent/u);
  assert.throws(() => parseFileReadBody({ file, offset: 3, data: "ZGU=", complete: false, nextOffset: 5 }), /pagination is inconsistent/u);
  assert.throws(() => parseFileReadBody({ file, offset: 5, data: "", complete: true }), /non-empty|pagination is inconsistent/u);
  assert.throws(() => parseFileReadResult({ instanceId: "i1", runtimeGeneration: 1, file, offset: 1, data: "Yg==", complete: false, nextOffset: 2 }, 0), /does not match the request/u);
  const hydrated = parseConversationContentBody({
    revision: "revision-1", contentRef: "content-1", complete: true,
    chunks: [{ blockIndex: 0, type: "tool_result", toolCallId: "call-1", toolName: "show_image", text: "Published display.png for display.", offset: 0, blockComplete: true, isError: false, publishedFile: file }],
  });
  assert.deepEqual(hydrated.chunks[0]?.type === "tool_result" ? hydrated.chunks[0].publishedFile : undefined, file);
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
  assert.deepEqual(parseControlRequest({ ...base, type: "session.inventory", params: { cwd: "/tmp/project", scope: "all", hostId: "machine-1" } }).params, { cwd: "/tmp/project", scope: "all", hostId: "machine-1" });
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
  assert.deepEqual(parseControlRequest({ ...base, type: "workspace.list", params: { path: "/work", limit: 20, hostId: "machine-1" } }).params, { path: "/work", cursor: undefined, limit: 20, hostId: "machine-1" });
  assert.deepEqual(parseControlRequest({ ...base, type: "workspace.list", params: { path: "C:\\work\\project", limit: 20, hostId: "windows-1" } }).params, { path: "C:\\work\\project", cursor: undefined, limit: 20, hostId: "windows-1" });
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
  assert.ok(requiredCapabilities(WORKER_CONFIG_CAPABILITY).includes(WORKER_CONFIG_CAPABILITY));
  assert.ok(requiredCapabilities(WORKER_CONFIG_CAPABILITY).includes("instance.catalog"));
  assert.ok(requiredCapabilities(WORKER_CONFIG_CAPABILITY).includes(INSTANCE_DISPLAY_NAME_CAPABILITY));
  assert.equal(capabilityForRequest("instance.get_by_key"), INSTANCE_KEYS_CAPABILITY);
  assert.equal(capabilityForRequest("conversation.history"), CONVERSATION_CONTENT_CAPABILITY);
  assert.equal(capabilityForRequest("conversation.content"), CONVERSATION_CONTENT_CAPABILITY);
  const stream = parseControlRequest({ kind: "request", version: 2, requestId: "body", type: "conversation.content.stream", params: { instanceId: "work", contentRef: "body" } });
  assert.equal(capabilityForRequest(stream.type), CONVERSATION_CONTENT_STREAM_CAPABILITY);
  assert.deepEqual(requestOptionCapabilities(stream), ["conversation.content.v1", "conversation.references.v1", "file-transfer.v1"]);
  assert.deepEqual(classifyControlRequest(stream), { target: "instance", effect: "query", transport: "response_stream" });
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
  assert.throws(() => parseControlRequest({ ...base, type: "instance.get_by_key", params: { key: "alu", hostId: "placement-is-not-lookup" } }), /Unexpected field/u);
  const remoteEnsure = parseControlRequest({
    ...base,
    type: "instance.ensure",
    params: { operationId: "ensure-remote", key: "remote", cwd: "/tmp/project", hostId: "subhost-1" },
  });
  assert.equal(remoteEnsure.type, "instance.ensure");
  assert.equal(remoteEnsure.params.hostId, "subhost-1");
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
  const windowsAdopt = parseControlRequest({
    ...base,
    type: "instance.adopt",
    params: { operationId: "adopt-windows", sessionFile: "C:\\Users\\owner\\session.jsonl", hostId: "windows-1" },
  });
  assert.equal(windowsAdopt.type, "instance.adopt");
  if (windowsAdopt.type === "instance.adopt") assert.equal(windowsAdopt.params.sessionFile, "C:\\Users\\owner\\session.jsonl");
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
  const configuredCreate = parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-configured", cwd: "/tmp/project", workerConfig: { excludeTools: ["bash"], noTools: false } },
  });
  assert.equal(configuredCreate.type, "instance.create");
  if (configuredCreate.type === "instance.create") {
    assert.deepEqual(configuredCreate.params.workerConfig, { excludeTools: ["bash"], noTools: false });
  }
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: { operationId: "create-invalid-config", cwd: "/tmp/project", workerConfig: [] },
  }), /must be a JSON object/u);
  assert.throws(() => parseControlRequest({
    ...base,
    type: "instance.create",
    params: {
      operationId: "create-oversized-config",
      cwd: "/tmp/project",
      workerConfig: { first: "x".repeat(MAX_JSON_STRING_CHARS), second: "x".repeat(MAX_JSON_STRING_CHARS) },
    },
  }), /too large/u);
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

// #325: records are an explicit wire choice. Legacy parsers retain their old
// page limit; new framing must never publish a partial initial result.
test("instance records commit only at ready and preserve the legacy request and page contracts", async () => {
  const {InstanceRecordInitial,InstanceRecordChannel}=await import("../src/control/instance-record-delivery.js");
  const {parseFollowResult,parseInstanceRecordFrame}=await import("../src/control/protocol.js");
  const request={kind:"request",version:2,requestId:"r",type:"instance.read",params:{instanceId:"i1",replay:"conversation_bootstrap"}};
  assert.equal("delivery" in parseControlRequest(request).params,false);
  assert.equal((parseControlRequest({...request,params:{...request.params,delivery:"records"}}).params as {delivery:string}).delivery,"records");
  assert.throws(()=>parseControlRequest({...request,params:{...request.params,delivery:"other"}}));
  const latest={hostEpoch:"epoch-1",instanceId:"i1",runtimeGeneration:1,sequence:1001};
  const page={events:[],earliest:{...latest,sequence:1},latest,truncated:false,epochChanged:false,generationChanged:false};
  const response={kind:"response",version:2,requestId:"r",hostEpoch:"epoch-1",ok:true,result:{page}};
  const initial=new InstanceRecordInitial(false,"r","epoch-1");
  assert.equal(initial.consume(response),undefined);assert.throws(()=>initial.finish());
  const events=Array.from({length:1001},(_,index)=>({...validEvent(),sequence:index+1}));
  for(const event of events)assert.equal(initial.consume({kind:"event",version:2,requestId:"r",hostEpoch:"epoch-1",event}),undefined);
  assert.throws(()=>parseFollowResult({page:{...page,events}}));
  assert.throws(()=>initial.consume({kind:"instance_ready",version:2,requestId:"r",hostEpoch:"epoch-1",historyEntries:0,eventCount:1000}));
  assert.equal(initial.consume({kind:"instance_ready",version:2,requestId:"r",hostEpoch:"epoch-1",historyEntries:0,eventCount:1001})!.page.events.length,1001);
  initial.finish();
  const frame={kind:"instance_record_fragment",version:2,requestId:"r",hostEpoch:"epoch-1",recordIndex:0,index:0,count:2,data:Buffer.from('{"snow":"雪').toString("base64")};
  for(const override of [{requestId:"wrong"},{hostEpoch:"wrong"},{data:"eA"},{count:0},{index:2}])assert.throws(()=>parseInstanceRecordFrame({...frame,...override},"r","epoch-1"));
  const receiver=new InstanceRecordChannel("r","epoch-1","receive",async()=>{},()=>{});
  try {
    assert.equal(await receiver.consume(frame),undefined);assert.throws(()=>receiver.finish());
    await assert.rejects(receiver.consume(frame));
    await assert.rejects(receiver.consume({...frame,recordIndex:1,index:1}));
    assert.deepEqual(await receiver.consume({...frame,index:1,data:Buffer.from('"}').toString("base64")}),{snow:"雪"});
    assert.deepEqual(await receiver.consume({...frame,recordIndex:1,index:0,count:1,data:Buffer.from('{"next":true}').toString("base64")}),{next:true});
    receiver.finish();
    await assert.rejects(receiver.consume({kind:"event",version:2,requestId:"r",hostEpoch:"epoch-1",event:validEvent()}));
  }finally{receiver.cancel();}
});

test("instance record progress expires on true stalls but not slow fragments or quiet follow", async context=>{
  const {InstanceRecordChannel}=await import("../src/control/instance-record-delivery.js");
  context.mock.timers.enable({apis:["setTimeout"]});
  let expired=0;const notices:Record<string,unknown>[]=[];
  const channel=new InstanceRecordChannel("r","h","receive",async frame=>{notices.push(frame);},()=>{expired++;});
  try {
    const partial='{"kind":"instance_record_fragment","version":2,"requestId":"r","hostEpoch":"h","recordIndex":0,"index":0,"count":1,"data":"';
    context.mock.timers.tick(59_000);channel.observeWire(partial.length,partial);
    await new Promise<void>(resolve=>setImmediate(resolve));
    context.mock.timers.tick(59_000);channel.observeWire(1,partial+"Y");
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(expired,0);assert.ok(notices.length>=2);
    channel.quiescent();context.mock.timers.tick(120_000);assert.equal(expired,0);
    channel.observeWire(24,'{"kind":"instance_record_');
    context.mock.timers.tick(59_000);
    channel.observeWire(1,'{"kind":"instance_record_f');
    context.mock.timers.tick(1_001);assert.equal(expired,1,"unrecognized short headers cannot keep a stalled live reader open");
  }finally{channel.cancel();context.mock.timers.reset();}
  context.mock.timers.enable({apis:["setTimeout"]});
  const active=new InstanceRecordChannel("r","h","receive",async()=>{},()=>{expired++;});
  try {
    active.waiting();await active.consume({kind:"instance_record_activity",version:2,requestId:"r",hostEpoch:"h",inTransitBytes:1});
    context.mock.timers.tick(59_000);await active.consume({kind:"instance_record_activity",version:2,requestId:"r",hostEpoch:"h",inTransitBytes:1});
    context.mock.timers.tick(1_001);assert.equal(expired,2);
  }finally{active.cancel();context.mock.timers.reset();}
});

// New transport must not retry ordinary failures or reinterpret a partial
// record as an old Host. Archived Host/SubHost fallback is exercised separately.
test("instance delivery retries only explicit missing capability before records begin", async context=>{
  const {createServer}=await import("node:net");
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {DockClient}=await import("../src/control/dock-client.js");
  const {createHelloAck,defaultHostIdentity,implementedCapabilities}=await import("../src/control/protocol.js");
  const directory=await mkdtemp(join(tmpdir(),"alu-record-fallback-"));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  for(const mode of ["missing","ordinary","partial"] as const){
    let connections=0;
    const server=createServer(socket=>{
      connections++;const decoder=new JsonLineDecoder();socket.on("error",()=>{});
      socket.on("data",chunk=>{for(const line of decoder.push(chunk)){
        const raw=JSON.parse(line);const send=(value:unknown)=>socket.write(JSON.stringify(value)+"\n");
        if(raw.kind==="hello"){
          if(mode==="missing"&&raw.requiredCapabilities.includes("instance.records.v1")){send({kind:"hello_error",requestId:raw.requestId,error:{code:"capability_missing",message:"old host",missing:["instance.records.v1"]}});socket.end();}
          else send(createHelloAck(raw.requestId,defaultHostIdentity("epoch-1","2026-07-14T00:00:00.000Z"),implementedCapabilities()));
        }else if(raw.kind==="request"){
          const base={version:2,requestId:raw.requestId,hostEpoch:"epoch-1"};
          if(mode==="partial")send({...base,kind:"instance_record_fragment",recordIndex:0,index:0,count:2,data:Buffer.from('{"kind":"response",').toString("base64")});
          if(mode!=="missing"){send({...base,kind:"response",ok:false,error:{code:mode==="partial"?"capability_missing":"invalid_cursor",message:"fixture",retryable:false,details:{missing:["instance.records.v1"]}}});socket.end();}
          else {assert.equal(raw.params.delivery,undefined);const cursor=validSnapshot().eventCursor;send({...base,kind:"response",ok:true,result:{instance:validSnapshot(),page:{events:[],earliest:cursor,latest:cursor,truncated:false,epochChanged:false,generationChanged:false},recentHistory:[],historyRevision:1,historyTruncated:false,pendingMessages:[]}});socket.end();}
        }
      }});
    });
    const path=join(directory,mode+".sock");await new Promise<void>(resolve=>server.listen(path,resolve));
    const client=new DockClient({socketPath:path});const delivery:import("../src/control/dock-client.js").InstanceDeliveryContext={};
    try {
      const read=client.read("i1",undefined,"conversation_bootstrap",delivery);
      if(mode==="missing"){assert.equal((await read).instance.id,"i1");assert.equal(delivery.delivery,"legacy");assert.equal(connections,2);}
      else {await assert.rejects(read);assert.equal(connections,1);assert.equal(delivery.delivery,mode==="partial"?"records":undefined);}
    }finally{client.closeActiveConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});

// #325 review: an empty producer queue cannot discard the unacknowledged-byte deadline.
test("record senders pipeline small items but remain active until their window is consumed", async context=>{
  const {InstanceRecordChannel}=await import("../src/control/instance-record-delivery.js");
  context.mock.timers.enable({apis:["setTimeout"]});
  const frames:Record<string,unknown>[]=[];let expired=0;
  const sender=new InstanceRecordChannel("r","h","send",async frame=>{frames.push(frame);},()=>{expired++;});
  const quiet=new InstanceRecordChannel("q","h","send",async()=>{},()=>{expired++;});
  try {
    await sender.send({one:true});await sender.send({two:true});sender.quiescent();
    assert.equal(frames.length,2);
    await quiet.send({quiet:true});quiet.quiescent();
    await quiet.consume({kind:"instance_record_progress",version:2,requestId:"q",hostEpoch:"h",receivedWireBytes:100,consumedBytes:14});
    context.mock.timers.tick(59_000);
    await sender.consume({kind:"instance_record_progress",version:2,requestId:"r",hostEpoch:"h",receivedWireBytes:0,consumedBytes:0});
    context.mock.timers.tick(1_001);assert.equal(expired,1);
    context.mock.timers.tick(120_000);assert.equal(expired,1);
  }finally{sender.cancel();quiet.cancel();context.mock.timers.reset();}
});

test("records follow cannot publish a complete initial page from another Work", async context=>{
  const {createServer}=await import("node:net");
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {DockClient}=await import("../src/control/dock-client.js");
  const {InstanceRecordChannel}=await import("../src/control/instance-record-delivery.js");
  const {createHelloAck,defaultHostIdentity,implementedCapabilities}=await import("../src/control/protocol.js");
  const root=await mkdtemp(join(tmpdir(),"alu-record-wrong-work-"));
  const server=createServer(socket=>{
    const decoder=new JsonLineDecoder();let sender:InstanceType<typeof InstanceRecordChannel>|undefined;
    socket.on("error",()=>{});socket.on("close",()=>sender?.cancel());
    socket.on("data",chunk=>{for(const line of decoder.push(chunk)){
      const raw=JSON.parse(line);
      if(raw.kind==="hello")socket.write(JSON.stringify(createHelloAck(raw.requestId,defaultHostIdentity("epoch-1","2026-07-14T00:00:00.000Z"),implementedCapabilities()))+"\n");
      else if(raw.kind==="request"){
        const base={version:2,requestId:raw.requestId,hostEpoch:"epoch-1"};
        const cursor={hostEpoch:"epoch-1",instanceId:"work-B",runtimeGeneration:1,sequence:1};
        sender=new InstanceRecordChannel(raw.requestId,"epoch-1","send",async frame=>{socket.write(JSON.stringify(frame)+"\n");},()=>socket.destroy());
        void (async()=>{
          await sender!.send({...base,kind:"response",ok:true,result:{page:{events:[],earliest:cursor,latest:cursor,truncated:false,epochChanged:false,generationChanged:false}}});
          await sender!.send({...base,kind:"event",event:{...validEvent(),instanceId:"work-B"}});
          await sender!.send({...base,kind:"instance_ready",historyEntries:0,eventCount:1});
        })().catch(()=>socket.destroy());
      }else void sender!.consume(raw).catch(()=>socket.destroy());
    }});
  });
  const path=join(root,"dock.sock");await new Promise<void>(resolve=>server.listen(path,resolve));
  const client=new DockClient({socketPath:path});let callbacks=0;
  context.after(async()=>{client.closeActiveConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await assert.rejects(client.follow("work-A",{hostEpoch:"epoch-1",instanceId:"work-A",runtimeGeneration:1,sequence:0},{delivery:"records",onEvent:()=>{callbacks++;}}),{code:"invalid_response"});
  assert.equal(callbacks,0);
});
