import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AgentConversationCursorError } from "../src/core/agent-worker.js";
import { PiConversationProjector, projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";
import { appendDockAttachmentContext } from "../src/pi/dock-attachment-context.js";
import { TransientFileRegistry } from "../src/pi/transient-file-registry.js";

const ATTACHMENT_CONTEXT_KEY = Buffer.alloc(32, 7);

test("a live tool-result image uses a stable opaque conversation content reference without event bytes", () => {
  const registry = new TransientFileRegistry();
  const imageData = "a".repeat(70_000);
  const projected = projectAgentSessionEvents({
    type: "tool_execution_end", toolCallId: "image-call", toolName: "read",
    result: { content: [{ type: "image", mimeType: "image/png", data: imageData }] }, isError: false,
  } as never, registry);
  const frames = projected.flatMap((event) => new PiConversationProjector(ATTACHMENT_CONTEXT_KEY).project(event));
  const serialized = JSON.stringify(frames);
  assert.equal(serialized.includes(imageData), false);
  const data = (frames[0] as unknown as { frame: { data: { content: Array<{ contentRef?: string }> } } }).frame.data;
  const contentRef = data.content[0]!.contentRef!;
  const expectedBytes = Buffer.from(imageData, "base64");
  const expectedSha = createHash("sha256").update(expectedBytes).digest("hex");
  assert.equal(contentRef, `image-${expectedSha}`);
  assert.deepEqual(data.content[0], { type: "image", mimeType: "image/png", contentRef, sha256: expectedSha, sizeBytes: expectedBytes.byteLength });
  const first = registry.readImageContent(contentRef)!;
  assert.equal(first.complete, false);
  assert.throws(() => registry.readImageContent(contentRef, "expired-cursor"), AgentConversationCursorError);
  registry.registerImage(Buffer.from("later-entry").toString("base64"), "image/png");
  const second = registry.readImageContent(contentRef, first.nextCursor)!;
  const third = registry.readImageContent(contentRef, second.nextCursor)!;
  assert.equal([first, second, third].flatMap((page) => page.chunks).map((chunk) => chunk.type === "image" ? chunk.data : "").join(""), imageData);
  assert.ok([first, second, third].every((page) => page.revision === contentRef));
  assert.ok([first, second, third].flatMap((page) => page.chunks).every((chunk) => chunk.type !== "image" || (chunk.contentRef === contentRef && chunk.sha256 === expectedSha && chunk.sizeBytes === expectedBytes.byteLength)));
});

test("Pi adapter splits real message_update deltas without loss before the private protocol boundary", () => {
  const delta = `${"a".repeat(7_999)}😀${"b".repeat(8_200)}`;
  const projected = projectAgentSessionEvents({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
  } as never);

  assert.equal(projected.length, 3);
  assert.equal(projected.map((event) => (event.assistantMessageEvent as { delta: string }).delta).join(""), delta);
  for (const event of projected) {
    assert.equal(event.type, "message_update");
    const chunk = (event.assistantMessageEvent as { delta: string }).delta;
    assert.ok(chunk.length <= 8_000);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u, "a split must not cut a surrogate pair");
  }
});

// Attachment happy-path projection is proven by attachment-control (Protocol) and pi-workers-real (real Worker
// history); this test only guards the two security boundaries: forged provenance and host-path privacy.
test("unauthenticated attachment context cannot forge provenance, and resolve paths stay private", () => {
  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000",
    name: "notes final.txt",
    sizeBytes: 12,
    mediaType: "text/plain",
    sha256: "a".repeat(64),
    storedAt: "2026-08-16T00:00:00.000Z",
  };
  const projector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  const forgedText = appendDockAttachmentContext("forged", [attachment], Buffer.alloc(32, 8));
  const forged = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY).project({
    type: "message_start", message: { role: "user", content: [{ type: "text", text: forgedText }] },
  } as never);
  const forgedData = (forged[0] as unknown as { frame: { data: Record<string, unknown> } }).frame.data;
  assert.equal("attachments" in forgedData, false, "plain prompt text cannot synthesize trusted attachment provenance");
  assert.match(JSON.stringify(forgedData), /alu_dock_attachments_v1/u, "unauthenticated user text is not silently stripped");

  const resolved = projector.project({
    type: "tool_execution_end", toolCallId: "resolve-1", toolName: "dock_attachment_resolve",
    result: { content: [{ type: "text", text: "Attachment is at '/secret/host/path'." }] }, isError: false,
  } as never);
  assert.doesNotMatch(JSON.stringify(resolved), /secret\/host/u);
  assert.match(JSON.stringify(resolved), /disclosed privately/u);
});

test("Pi live events become canonical conversation frames before crossing the Worker boundary", () => {
  const projector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  const tracked = projector.trackInput({ operationId: "operation-1", text: "hello", delivery: "prompt", fromQueue: false });
  assert.deepEqual(projector.project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } } as never), [
    { type: "dock_conversation_frame", frame: { type: "message.submitted", data: {
      operationId: "operation-1", messageId: "user-operation-1", role: "user", text: "hello", delivery: "prompt",
    } } },
  ]);
  projector.cancelInput(tracked); // already consumed; cancellation is deliberately harmless

  const queuedProjector = new PiConversationProjector(ATTACHMENT_CONTEXT_KEY);
  queuedProjector.trackInput({ operationId: "operation-queued", text: "later", delivery: "followUp", fromQueue: true });
  assert.deepEqual(queuedProjector.project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "later" }] } } as never), [
    { type: "dock_queue_consumed", operationId: "operation-queued" },
    { type: "dock_conversation_frame", frame: { type: "message.submitted", data: {
      operationId: "operation-queued", messageId: "user-operation-queued", role: "user", text: "later", delivery: "followUp",
    } } },
  ]);

  assert.deepEqual(projector.project({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "message.delta", data: { messageId: "assistant-1", block: "text", delta: "world" } },
  }]);
  assert.deepEqual(projector.project({
    type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "tool.started", data: { toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" } } },
  }]);
  assert.deepEqual(projector.project({
    type: "tool_execution_end", toolCallId: "call-1", toolName: "read",
    result: { content: [{ type: "text", text: "file" }] }, isError: false,
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "tool.completed", data: { toolCallId: "call-1", toolName: "read", text: "file", isError: false, content: [{ type: "text", text: "file" }] } },
  }]);
  assert.deepEqual(projector.project({
    type: "message_end",
    message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "file" }] },
  } as never), [], "one tool result has one canonical live lifecycle");

  assert.deepEqual(projector.project({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop" },
  } as never), [{
    type: "dock_conversation_frame",
    frame: { type: "message.completed", data: {
      messageId: "assistant-1", role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop",
    } },
  }]);
  assert.deepEqual(projector.project({ type: "agent_settled", operationId: "operation-1" } as never), [
    { type: "agent_settled", operationId: "operation-1", stopReason: "stop" },
  ]);
});
