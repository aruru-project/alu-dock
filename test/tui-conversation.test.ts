import assert from "node:assert/strict";
import test from "node:test";

import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";

import type { DockEvent, InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockConversation, DockStatusLine } from "../src/tui/conversation.js";
import { commandCatalog, projectSnapshot } from "../src/tui/dock-tui.js";

function event(sequence: number, type: DockEvent["type"], data: Record<string, unknown>): DockEvent {
  return {
    scope: "instance",
    sequence,
    instanceId: "dock-1",
    runtimeGeneration: 1,
    occurredAt: "2026-07-14T00:00:00.000Z",
    type,
    data,
  } as DockEvent;
}

function snapshot(): InstanceSnapshot {
  return {
    id: "dock-1",
    creationOperationId: "create-1",
    name: "demo",
    cwd: "/tmp/demo",
    lifecycle: "active",
    execution: "running",
    lastRun: "never",
    reopenable: false,
    runtimeGeneration: 1,
    ownerHostEpoch: "epoch-1",
    pending: { steering: 0, followUp: 0, total: 0 },
    executor: {
      kind: "pi-sdk",
      piSessionId: "pi-1",
      model: { provider: "openai-codex", id: "gpt-test" },
    },
    extensionStatus: { "alu-kanban": "ready" },
    metrics: {
      messages: { user: 2, assistant: 1, toolCalls: 1, toolResults: 1, total: 5 },
      tokens: { input: 800, output: 200, cacheRead: 200, cacheWrite: 0, total: 1_200 },
      cost: 0.0042,
      context: { tokens: 1_000, contextWindow: 10_000, percent: 10 },
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    eventCursor: { hostEpoch: "epoch-1", instanceId: "dock-1", runtimeGeneration: 1, sequence: 1 },
  };
}

test("autocomplete combines Dock and projected extension skill and prompt commands", async () => {
  const catalog = commandCatalog([
    { name: "skill-check", description: "Run skill", source: { kind: "skill", path: "/safe/SKILL.md" }, argumentCompletions: false },
    { name: "prompt-review", source: { kind: "prompt", path: "/safe/review.md" }, argumentCompletions: true },
    { name: "extension-do", description: "Do\u001b[2J work", source: { kind: "extension", package: "fixture" }, argumentCompletions: false },
    { name: "unsafe\u001b[2J", description: "safe value", source: { kind: "extension" }, argumentCompletions: false },
    { name: "stop", description: "untrusted override", source: { kind: "extension" }, argumentCompletions: false },
  ]);
  assert.equal(catalog.find((command) => command.name === "stop")?.description, "stop and dispose the instance");
  assert.equal(catalog.find((command) => command.name === "extension-do")?.description, "Do[2J work");
  assert.ok(catalog.some((command) => command.name === "unsafe[2J"));
  assert.equal(catalog.some((command) => command.name.includes("\u001b")), false);
  assert.equal(catalog.find((command) => command.name === "prompt-review")?.argumentHint, "arguments");

  const provider = new CombinedAutocompleteProvider(catalog, "/tmp");
  const suggestions = await provider.getSuggestions(["/skill-c"], 0, 8, { signal: new AbortController().signal });
  assert.ok(suggestions?.items.some((item) => item.value === "skill-check"));
});

test("conversation projects persisted history before live replay", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    { entryId: "h1", role: "user", content: [{ type: "text", text: "old question" }] },
    { entryId: "h2", parentId: "h1", role: "assistant", content: [{ type: "thinking", text: "old plan" }, { type: "text", text: "old answer" }] },
    { entryId: "h3", parentId: "h2", role: "tool", content: [{ type: "tool_result", toolCallId: "t1", toolName: "read", text: "old result", isError: false }] },
  ], true);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "system", text: "Earlier session history is available through paged history.", complete: true },
    { kind: "user", text: "old question", complete: true },
    { kind: "thinking", text: "old plan", complete: true },
    { kind: "assistant", text: "old answer", complete: true },
    { kind: "tool", text: "read done\nresult\nold result", complete: true },
  ]);
});

test("conversation projects replay and live deltas into readable messages", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([
    event(1, "message.submitted", { operationId: "op-1", messageId: "user-op-1", role: "user", text: "hello\u001b[2J" }),
    event(2, "message.completed", { role: "user", content: [{ type: "text", text: "hello\u001b[2J" }] }),
    event(3, "message.delta", { messageId: "assistant-1", block: "thinking", delta: "secret reasoning" }),
    event(4, "message.delta", { messageId: "assistant-1", block: "text", delta: "hel" }),
    event(5, "message.delta", { messageId: "assistant-1", block: "text", delta: "lo" }),
    event(6, "message.completed", { messageId: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" }),
    event(7, "tool.started", { toolCallId: "tool-1", toolName: "read", args: {} }),
    event(8, "tool.completed", {
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      text: "done",
    }),
  ], false);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "user", text: "hello[2J", complete: true },
    { kind: "thinking", text: "secret reasoning", complete: true },
    { kind: "assistant", text: "hello", complete: true },
    { kind: "tool", text: "read done\nresult\ndone", complete: true },
  ]);
  for (const line of conversation.render(24)) assert.ok(visibleWidth(line) <= 24);
});

test("conversation collapses transport retry noise into retry status and one final error", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([
    event(1, "message.submitted", { role: "user", text: "reply 1" }),
    event(2, "message.completed", { role: "user", text: "reply 1" }),
    event(3, "message.completed", { role: "assistant", stopReason: "error", error: "fetch failed" }),
    event(4, "run.retry_started", { attempt: 1, maxAttempts: 3, error: "fetch failed" }),
    event(5, "message.completed", { role: "assistant", stopReason: "error", error: "fetch failed" }),
    event(6, "run.settled", { result: "failed", error: "fetch failed" }),
  ], false);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "user", text: "reply 1", complete: true },
    { kind: "system", text: "Retrying (1/3) in 0ms…", complete: true },
    { kind: "error", text: "fetch failed", complete: true },
  ]);
});

test("conversation renders Markdown, code, thinking policy, and diff tools at bounded widths", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "message.delta", { messageId: "a1", block: "thinking", delta: "**plan**" }));
  conversation.apply(event(2, "message.delta", { messageId: "a1", block: "text", delta: "# Result\n\n```ts\nconst answer = 42;\n```" }));
  conversation.apply(event(3, "message.completed", {
    messageId: "a1", role: "assistant",
    content: [{ type: "thinking", text: "**plan**" }, { type: "text", text: "# Result\n\n```ts\nconst answer = 42;\n```" }],
  }));
  conversation.apply(event(4, "tool.started", { toolCallId: "t1", toolName: "edit", args: { path: "src/a.ts" } }));
  conversation.apply(event(5, "tool.completed", {
    toolCallId: "t1", toolName: "edit", isError: false,
    text: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
  }));

  assert.ok(conversation.snapshot().some((entry) => entry.kind === "thinking" && entry.text === "**plan**"));
  assert.match(conversation.snapshot().at(-1)?.text ?? "", /src\/a\.ts/);
  for (const width of [20, 43, 100]) {
    for (const line of conversation.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  conversation.toggleToolsExpanded();
  assert.match(conversation.render(60).join("\n"), /Ctrl\+O expand/);

  const hidden = new DockConversation();
  hidden.setHideThinking(true);
  hidden.apply(event(1, "message.delta", { messageId: "a2", block: "thinking", delta: "private" }));
  hidden.apply(event(2, "message.completed", { messageId: "a2", role: "assistant", content: [{ type: "thinking", text: "private" }] }));
  assert.equal(hidden.snapshot().some((entry) => entry.kind === "thinking"), false);
});

test("queue, compaction, replacement, and host-loss notices remain deterministic", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "queue.changed", { steering: 1, followUp: 2, total: 3 }));
  conversation.apply(event(2, "queue.changed", { steering: 0, followUp: 1, total: 1 }));
  conversation.apply(event(3, "compaction.started", { reason: "threshold" }));
  conversation.apply(event(4, "compaction.completed", { reason: "threshold", aborted: false, willRetry: false }));
  conversation.apply(event(5, "session.replaced", { reason: "reload", runtimeGeneration: 2, cwd: "/tmp/reloaded", piSessionId: "pi-2" }));
  conversation.addNotice("Host event stream closed. No command was replayed; this TUI is now read-only.", true);

  const projected = conversation.snapshot();
  assert.equal(projected.filter((entry) => entry.text.startsWith("Queue ·")).length, 1);
  assert.match(projected.find((entry) => entry.text.startsWith("Queue ·"))?.text ?? "", /1 follow-up/);
  assert.ok(projected.some((entry) => /Compaction completed/.test(entry.text)));
  assert.ok(projected.some((entry) => /generation 2/.test(entry.text)));
  assert.match(projected.at(-1)?.text ?? "", /No command was replayed/);
});

test("live snapshot projection updates metrics, extension status, state, and replacement cursor", () => {
  let projected = projectSnapshot(snapshot(), event(2, "session.metrics_changed", {
    metrics: {
      messages: { user: 3, assistant: 2, toolCalls: 1, toolResults: 1, total: 7 },
      tokens: { input: 300, output: 100, cacheRead: 50, cacheWrite: 0, total: 450 },
      cost: 0.02,
      context: { tokens: 2_000, contextWindow: 10_000, percent: 20 },
    },
  }));
  projected = projectSnapshot(projected, event(3, "extension.status_changed", { key: "build", text: "green" }));
  projected = projectSnapshot(projected, event(4, "instance.state_changed", {
    reason: "settled", lifecycle: "active", execution: "idle", lastRun: "succeeded",
    pending: { steering: 0, followUp: 0, total: 0 },
  }));
  projected = projectSnapshot(projected, {
    ...event(1, "session.replaced", { reason: "reload", runtimeGeneration: 2, sessionFile: "/tmp/pi-2.jsonl", cwd: "/tmp/reloaded", piSessionId: "pi-2" }),
    runtimeGeneration: 2,
  });

  assert.equal(projected.metrics?.context?.percent, 20);
  assert.equal(projected.extensionStatus.build, "green");
  assert.equal(projected.execution, "idle");
  assert.equal(projected.activeCommandId, undefined);
  assert.equal(projected.runtimeGeneration, 2);
  assert.equal(projected.cwd, "/tmp/reloaded");
  assert.equal(projected.executor.piSessionId, "pi-2");
  assert.equal(projected.eventCursor.runtimeGeneration, 2);
  assert.equal(projected.eventCursor.sequence, 1);
  assert.equal(projected.executor.sessionFile, "/tmp/pi-2.jsonl");
});

test("conversation and status expose replay truncation and current state", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([], true);
  assert.match(conversation.snapshot()[0]?.text ?? "", /outside the host/);

  const status = new DockStatusLine(snapshot());
  status.setActivity("streaming");
  status.setController("observing");
  status.setConnection("connected");
  status.setAutoCompaction(true);
  const lines = status.render(80);
  const footer = lines.join("\n");
  assert.match(footer, /demo/);
  assert.match(footer, /gpt-test/);
  assert.match(footer, /running/);
  assert.match(footer, /streaming/);
  assert.match(footer, /context 1\.0k\/10\.0k 10%/);
  assert.match(footer, /cache 20%/);
  assert.match(footer, /alu-kanban: ready/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});
