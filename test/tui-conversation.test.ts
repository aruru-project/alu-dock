import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { DockEvent, InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockConversation, DockStatusLine } from "../src/tui/conversation.js";

function event(sequence: number, type: string, data: Record<string, unknown>): DockEvent {
  return {
    sequence,
    instanceId: "dock-1",
    occurredAt: "2026-07-14T00:00:00.000Z",
    type,
    data,
  };
}

function snapshot(): InstanceSnapshot {
  return {
    id: "dock-1",
    name: "demo",
    cwd: "/tmp/demo",
    lifecycle: "active",
    execution: "running",
    lastRun: "never",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: {
      kind: "pi-sdk",
      piSessionId: "pi-1",
      model: { provider: "openai-codex", id: "gpt-test" },
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    latestEventSequence: 1,
  };
}

test("conversation projects replay and live deltas into readable messages", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([
    event(1, "message.submitted", { role: "user", text: "hello\u001b[2J" }),
    event(2, "assistant.text_delta", { delta: "hel" }),
    event(3, "assistant.text_delta", { delta: "lo" }),
    event(4, "message.completed", { role: "assistant", text: "hello", stopReason: "stop" }),
    event(5, "tool.started", { toolCallId: "tool-1", toolName: "read" }),
    event(6, "tool.completed", {
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      output: "done",
    }),
  ], false);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "user", text: "hello[2J", complete: true },
    { kind: "assistant", text: "hello", complete: true },
    { kind: "tool", text: "read done\ndone", complete: true },
  ]);
  for (const line of conversation.render(24)) assert.ok(visibleWidth(line) <= 24);
});

test("conversation and status expose replay truncation and current state", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([], true);
  assert.match(conversation.snapshot()[0]?.text ?? "", /outside the host/);

  const status = new DockStatusLine(snapshot());
  status.setActivity("streaming");
  const [line] = status.render(80);
  assert.match(line ?? "", /demo/);
  assert.match(line ?? "", /gpt-test/);
  assert.match(line ?? "", /running/);
  assert.match(line ?? "", /streaming/);
  assert.ok(visibleWidth(line ?? "") <= 80);
});
