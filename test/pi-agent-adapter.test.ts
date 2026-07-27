import assert from "node:assert/strict";
import test from "node:test";

import { PiConversationProjector, projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";

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

test("Pi adapter emits explicit Worker-owned persistence checkpoints", () => {
  assert.deepEqual(projectAgentSessionEvents({ type: "turn_end" } as never), [
    { type: "turn_end" },
    { type: "conversation_checkpoint" },
  ]);
  assert.deepEqual(projectAgentSessionEvents({ type: "agent_settled" } as never), [
    { type: "agent_settled" },
    { type: "conversation_checkpoint" },
  ]);
  assert.deepEqual(projectAgentSessionEvents({ type: "entry_appended", entry: {} } as never), [
    { type: "conversation_checkpoint" },
  ]);
});

test("Pi live events become canonical conversation frames before crossing the Worker boundary", () => {
  const projector = new PiConversationProjector();
  const tracked = projector.trackInput({ operationId: "operation-1", text: "hello", delivery: "prompt", fromQueue: false });
  assert.deepEqual(projector.project({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } } as never), [
    { type: "dock_conversation_frame", frame: { type: "message.submitted", data: {
      operationId: "operation-1", messageId: "user-operation-1", role: "user", text: "hello", delivery: "prompt",
    } } },
  ]);
  projector.cancelInput(tracked); // already consumed; cancellation is deliberately harmless

  const queuedProjector = new PiConversationProjector();
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
    frame: { type: "tool.completed", data: { toolCallId: "call-1", toolName: "read", text: "file", isError: false } },
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
  assert.deepEqual(projector.project({ type: "agent_settled" } as never), [
    { type: "agent_settled", stopReason: "stop" },
  ]);
});
