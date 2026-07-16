import assert from "node:assert/strict";
import test from "node:test";

import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";

import type { SettingDto } from "../src/core/config-projection.js";
import type { DockEvent, InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockConversation, DockStatusLine } from "../src/tui/conversation.js";
import { commandCatalog } from "../src/tui/dock-tui.js";
import { PendingQueueTray } from "../src/tui/pending-queue.js";
import { projectSnapshot } from "../src/tui/snapshot-projection.js";
import { parseSettingCommandValue } from "../src/tui/settings-controls.js";
import { createNightConsolePaint, detectTerminalColorLevel } from "../src/tui/theme.js";

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
  for (const name of ["settings", "tools", "tree", "fork", "clone", "new", "resume", "name", "compact", "reload", "resources", "mouse"]) assert.ok(catalog.some((command) => command.name === name));

  const provider = new CombinedAutocompleteProvider(catalog, "/tmp");
  const suggestions = await provider.getSuggestions(["/skill-c"], 0, 8, { signal: new AbortController().signal });
  assert.ok(suggestions?.items.some((item) => item.value === "skill-check"));
});

test("Stage 3 setting command values are typed and bounded", () => {
  const boolSetting = { key: "autoRetry", value: true, source: "effective", writable: true, valueType: "boolean", reloadRequired: false, hostRestartRequired: false } as SettingDto;
  const enumSetting = { key: "transport", value: "auto", source: "effective", writable: true, valueType: "enum", allowedValues: ["auto", "sse", "websocket", "websocket-cached"], reloadRequired: false, hostRestartRequired: false } as SettingDto;
  const intSetting = { key: "editorPaddingX", value: 1, source: "effective", writable: true, valueType: "integer", min: 0, max: 3, reloadRequired: false, hostRestartRequired: false } as SettingDto;
  const warnings = { key: "warnings", value: {}, source: "effective", writable: true, valueType: "object", reloadRequired: false, hostRestartRequired: false } as SettingDto;
  const readOnly = { key: "compactionReserveTokens", value: 165_536, source: "project", writable: false, valueType: "integer", min: 0, max: 2_147_483_647, reloadRequired: false, hostRestartRequired: false } as SettingDto;

  assert.deepEqual(parseSettingCommandValue(boolSetting, "off"), { key: "autoRetry", value: false });
  assert.deepEqual(parseSettingCommandValue(enumSetting, "websocket"), { key: "transport", value: "websocket" });
  assert.deepEqual(parseSettingCommandValue(intSetting, "3"), { key: "editorPaddingX", value: 3 });
  assert.deepEqual(parseSettingCommandValue(warnings, "true"), { key: "warnings", value: { anthropicExtraUsage: true } });
  assert.equal(parseSettingCommandValue(boolSetting, "yes"), undefined);
  assert.equal(parseSettingCommandValue(enumSetting, "udp"), undefined);
  assert.equal(parseSettingCommandValue(intSetting, "4"), undefined);
  assert.equal(parseSettingCommandValue(warnings, "{\"other\":true}"), undefined);
  assert.equal(parseSettingCommandValue(readOnly, "200000"), undefined);
});

test("Night Console uses semantic local surfaces without taking over the terminal background", () => {
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color", NO_COLOR: "" }, true), "none");
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color" }, true), "ansi256");
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color", COLORTERM: "truecolor" }, true), "truecolor");

  const plain = createNightConsolePaint("none");
  assert.equal(plain.userSurface("question"), "question");
  assert.equal(plain.running("run"), "run");

  const truecolor = createNightConsolePaint("truecolor");
  assert.match(truecolor.userSurface("question"), /\u001b\[38;2;214;225;240;48;2;17;28;48mquestion\u001b\[0m/u);
  assert.notEqual(truecolor.running("state"), truecolor.success("state"));
  assert.notEqual(truecolor.success("state"), truecolor.error("state"));

  const ansi16 = createNightConsolePaint("ansi16");
  assert.doesNotMatch(ansi16.userSurface("question"), /\u001b\[4[0-7]m/u, "local surfaces fall back to foreground-only at 16 colors");
});

test("conversation reset replaces old session history", () => {
  const conversation = new DockConversation();
  conversation.addNotice("old session");
  conversation.reset();
  conversation.applyHistory([{ entryId: "new", role: "assistant", content: [{ type: "text", text: "new session" }] }], false);
  assert.deepEqual(conversation.snapshot(), [{ kind: "assistant", text: "new session", complete: true }]);
});

test("conversation projects persisted history before live replay", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    { entryId: "h1", role: "user", content: [{ type: "text", text: "old question" }] },
    { entryId: "h2", parentId: "h1", role: "assistant", content: [{ type: "thinking", text: "old plan" }, { type: "text", text: "old answer" }, { type: "tool_call", toolCallId: "t1", toolName: "read", args: { path: "/tmp/old" } }] },
    { entryId: "h3", parentId: "h2", role: "tool", content: [{ type: "tool_result", toolCallId: "t1", toolName: "read", text: "old result", isError: false }] },
  ], true);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "system", text: "Earlier session history is available through paged history.", complete: true },
    { kind: "user", text: "old question", complete: true },
    { kind: "thinking", text: "old plan", complete: true },
    { kind: "assistant", text: "old answer", complete: true },
    { kind: "tool", text: "read done\nargs\n{\n  \"path\": \"/tmp/old\"\n}\nresult\nold result", complete: true },
  ]);
  assert.match(conversation.render(100).join("\n"), /read done.*\/tmp\/old/u);
});

test("paged history rebuild keeps the bounded gap ordered before live events", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    { entryId: "h8", role: "user", content: [{ type: "text", text: "recent eight" }] },
    { entryId: "h9", role: "assistant", content: [{ type: "text", text: "recent nine" }] },
  ], true);
  conversation.apply(event(1, "message.submitted", {
    operationId: "live-op",
    messageId: "live-user",
    role: "user",
    text: "live tail",
    delivery: "prompt",
  }));

  conversation.replacePagedHistory({
    entries: [
      { entryId: "h0", role: "user", content: [{ type: "text", text: "old zero" }] },
      { entryId: "h1", role: "assistant", content: [{ type: "text", text: "old one" }] },
      { entryId: "h8", role: "user", content: [{ type: "text", text: "recent eight" }] },
      { entryId: "h9", role: "assistant", content: [{ type: "text", text: "recent nine" }] },
    ],
    hasEarlier: false,
    hasNewer: true,
    newerBoundaryEntryId: "h8",
    loadState: "idle",
    generation: 1,
    revision: 2,
  });

  assert.deepEqual(conversation.snapshot().map((item) => item.text), [
    "old zero",
    "old one",
    "Newer session history crossed a bounded-memory gap · PageDown continues at the retained live tail.",
    "recent eight",
    "recent nine",
    "live tail",
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
  const rendered = conversation.render(24);
  for (const line of rendered) assert.ok(visibleWidth(line) <= 24);
  assert.match(rendered.join("\n"), /▎/);
  assert.match(rendered.join("\n"), /│ secret reasoning/);
  assert.doesNotMatch(rendered.join("\n"), /^\s*(You|Assistant|Thinking)\s*$/mu);
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
  const collapsed = conversation.render(60).join("\n");
  assert.match(collapsed, /Alt\+O detail/);
  assert.doesNotMatch(collapsed, /\+new/);
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "edit" });
  assert.match(conversation.render(60).join("\n"), /\+new/);
  conversation.toggleToolsExpanded();
  for (const width of [20, 43, 100]) {
    for (const line of conversation.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }

  const hidden = new DockConversation();
  hidden.setHideThinking(true);
  hidden.apply(event(1, "message.delta", { messageId: "a2", block: "thinking", delta: "private" }));
  hidden.apply(event(2, "message.completed", { messageId: "a2", role: "assistant", content: [{ type: "thinking", text: "private" }] }));
  assert.equal(hidden.snapshot().some((entry) => entry.kind === "thinking"), false);
});

test("collapsed tool rows identify common operations without exposing arbitrary payload fields", () => {
  const conversation = new DockConversation();
  const calls = [
    { name: "read", args: { path: "/home/luziyi/workshop/alu_dock/src/tui/conversation.ts", offset: 10, limit: 5 }, result: "source" },
    { name: "bash", args: { command: "npm run check\nnpm test" }, result: "ok" },
    { name: "edit", args: { path: "src/tui/theme.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, result: "updated" },
    { name: "write", args: { path: "README.md", content: "one\ntwo\nthree" }, result: "written" },
    { name: "alu_kanban", args: { action: "get_card", card_id: 164, content: "ARBITRARY PAYLOAD MUST STAY FOLDED" }, result: "done" },
  ] as const;
  let sequence = 0;
  for (const call of calls) {
    const toolCallId = `summary-${++sequence}`;
    conversation.apply(event(sequence * 2, "tool.started", { toolCallId, toolName: call.name, args: call.args }));
    conversation.apply(event(sequence * 2 + 1, "tool.completed", {
      toolCallId, toolName: call.name, isError: false, text: call.result,
    }));
  }

  const rendered = conversation.render(120).join("\n");
  assert.match(rendered, /read done.*…\/src\/tui\/conversation\.ts.*lines 10–14/u);
  assert.match(rendered, /bash done.*npm run check.*↵ \+1 line/u);
  assert.match(rendered, /edit done.*src\/tui\/theme\.ts.*2 edits/u);
  assert.match(rendered, /write done.*README\.md.*3 lines/u);
  assert.match(rendered, /alu_kanban done.*get_card.*card #164/u);
  assert.doesNotMatch(rendered, /ARBITRARY PAYLOAD MUST STAY FOLDED/u);
  for (const width of [20, 43, 80]) {
    for (const line of conversation.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
});

test("live tool argument updates refresh the collapsed operation summary", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "summary-update", toolName: "read", args: { path: "src/old.ts" },
  }));
  const initialRevision = conversation.revision;
  assert.match(conversation.render(80).join("\n"), /src\/old\.ts/u);

  conversation.apply(event(2, "tool.args_updated", {
    toolCallId: "summary-update", args: { path: "src/new\u001b[2J.ts", offset: 20, limit: 2 },
  }));
  assert.ok(conversation.revision > initialRevision);
  const updated = conversation.render(80).join("\n");
  assert.match(updated, /src\/new\[2J\.ts.*lines 20–21/u);
  assert.doesNotMatch(updated, /src\/old\.ts/u);

  const longPrefix = "x".repeat(5_000);
  conversation.apply(event(3, "tool.args_updated", {
    toolCallId: "summary-update", args: { content: longPrefix, path: "src/first.ts" },
  }));
  const truncatedArgsRevision = conversation.revision;
  conversation.apply(event(4, "tool.args_updated", {
    toolCallId: "summary-update", args: { content: longPrefix, path: "src/second.ts" },
  }));
  assert.ok(conversation.revision > truncatedArgsRevision, "summary changes beyond truncated detail JSON remain visible");
  assert.match(conversation.render(80).join("\n"), /src\/second\.ts/u);
});

test("duplicate tool projections do not invalidate cached conversation output", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "tool-cache",
    toolName: "edit",
    args: { path: "src/a.ts" },
  }));
  const startedRevision = conversation.revision;
  const startedLines = conversation.render(80);

  conversation.apply(event(2, "tool.args_updated", {
    toolCallId: "tool-cache",
    args: { path: "src/a.ts" },
  }));
  assert.equal(conversation.revision, startedRevision);
  assert.strictEqual(conversation.render(80), startedLines);

  conversation.apply(event(3, "tool.output_updated", {
    toolCallId: "tool-cache",
    text: "partial output",
  }));
  const outputRevision = conversation.revision;
  const outputLines = conversation.render(80);
  assert.ok(outputRevision > startedRevision);

  conversation.apply(event(4, "tool.output_updated", {
    toolCallId: "tool-cache",
    text: "partial output",
  }));
  assert.equal(conversation.revision, outputRevision);
  assert.strictEqual(conversation.render(80), outputLines);

  conversation.apply(event(5, "tool.output_updated", {
    toolCallId: "tool-cache",
    text: "changed output",
  }));
  assert.ok(conversation.revision > outputRevision);
});

test("tool failures stay collapsed by default and preserve expandable error detail", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", { toolCallId: "failed-tool", toolName: "bash", args: { command: "false" } }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "failed-tool", toolName: "bash", isError: true, text: "expanded failure detail",
  }));
  conversation.addNotice("later assistant-visible output");
  const collapsed = conversation.render(60).join("\n");
  assert.match(collapsed, /× bash failed/);
  assert.match(collapsed, /bash failed.*false/u);
  assert.doesNotMatch(collapsed, /expanded failure detail/);
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "bash" });
  assert.ok((conversation.latestToolOffsetFromBottom(60) ?? 0) > 0);
  assert.match(conversation.render(60).join("\n"), /expanded failure detail/);
});

test("compaction, replacement, and host-loss notices remain deterministic without queue transcript noise", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "queue.changed", { steering: 1, followUp: 2, total: 3 }));
  conversation.apply(event(2, "queue.changed", { steering: 0, followUp: 1, total: 1 }));
  conversation.apply(event(3, "compaction.started", { reason: "threshold" }));
  conversation.apply(event(4, "compaction.completed", { reason: "threshold", aborted: false, willRetry: false }));
  conversation.apply(event(5, "session.replaced", { reason: "reload", runtimeGeneration: 2, cwd: "/tmp/reloaded", piSessionId: "pi-2" }));
  conversation.addNotice("Host event stream closed. No command was replayed; this TUI is now read-only.", true);

  const projected = conversation.snapshot();
  assert.equal(projected.filter((entry) => entry.text.startsWith("Queue ·")).length, 0);
  assert.ok(projected.some((entry) => /Compaction completed/.test(entry.text)));
  assert.ok(projected.some((entry) => /generation 2/.test(entry.text)));
  assert.match(projected.at(-1)?.text ?? "", /No command was replayed/);
});

test("pending queue tray follows Pi consumption order and leaves the transcript at message_start", () => {
  const tray = new PendingQueueTray();
  tray.reset([
    { queueItemId: "follow-1", operationId: "op-follow", delivery: "followUp", text: "afterward", acceptedAt: "2026-07-14T00:00:02.000Z" },
    { queueItemId: "steer-1", operationId: "op-steer", delivery: "steer", text: "change direction", acceptedAt: "2026-07-14T00:00:01.000Z" },
  ]);
  assert.deepEqual(tray.render(80).map((line) => line.trim()), [
    "↳ 1. steer next · change direction",
    "↳ 2. follow-up · afterward",
  ]);

  tray.apply(event(1, "queue.changed", { steering: 0, followUp: 1, total: 1 }));
  assert.equal(tray.count, 2, "queue_update is not the user-message consumption boundary");
  tray.apply(event(2, "message.submitted", {
    operationId: "op-steer", messageId: "user-op-steer", role: "user", text: "change direction", delivery: "steer", queueItemId: "steer-1",
  }));
  assert.equal(tray.count, 1);
  assert.match(tray.render(80).join("\n"), /afterward/);
  tray.apply(event(3, "queue.cleared", {
    steering: 0, followUp: 0, total: 0, queueItemIds: [], reason: "dequeued",
  }));
  assert.equal(tray.count, 1, "an in-flight item remains until message_start");
  tray.apply(event(4, "queue.cleared", {
    steering: 0, followUp: 1, total: 1, queueItemIds: ["follow-1"], reason: "dequeued",
  }));
  assert.equal(tray.count, 0);
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
  assert.deepEqual(projected.extensionStatus, {});
  assert.equal(projected.execution, "idle");
  assert.equal(projected.lastRun, "never");
  assert.equal(projected.activeCommandId, undefined);
  assert.equal(projected.runtimeGeneration, 2);
  assert.equal(projected.cwd, "/tmp/reloaded");
  assert.equal(projected.name, undefined);
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
  const lines = status.render(120);
  assert.equal(lines.length, 2);
  const footer = lines.join("\n");
  assert.match(footer, /demo/);
  assert.match(footer, /gpt-test/);
  assert.match(footer, /running/);
  assert.match(footer, /streaming/);
  assert.match(footer, /ctx 1\.0k\/10\.0k 10%/);
  assert.match(footer, /cache 20%/);
  assert.match(footer, /alu-kanban:ready/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 120);

  status.setActivity({ phase: "waiting", label: "waiting for model" });
  const narrow = status.render(43);
  assert.equal(narrow.length, 2);
  assert.match(narrow[0] ?? "", /waiting for model/);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 43);
});
