import assert from "node:assert/strict";
import test from "node:test";

import { CombinedAutocompleteProvider, TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";

import type { SettingDto } from "../src/core/config-projection.js";
import { projectDisplayEditDiff } from "../src/core/edit-diff-projection.js";
import type { DockEvent, InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockActivityLine, DockConversation, DockStatusLine, DockWorkMetadata } from "../src/tui/conversation.js";
import { commandCatalog, formatWorkStatus, workHelpText } from "../src/tui/dock-tui.js";
import { PendingQueueTray } from "../src/tui/pending-queue.js";
import { projectSnapshot } from "../src/tui/snapshot-projection.js";
import { parseSettingCommandValue } from "../src/tui/settings-controls.js";
import { createAluPaint, detectTerminalColorLevel } from "../src/tui/theme.js";

class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(lines: number): void { this.writes.push(lines > 0 ? `\u001b[${lines}B` : lines < 0 ? `\u001b[${-lines}A` : ""); }
  hideCursor(): void { this.writes.push("\u001b[?25l"); }
  showCursor(): void { this.writes.push("\u001b[?25h"); }
  clearLine(): void { this.writes.push("\u001b[K"); }
  clearFromCursor(): void { this.writes.push("\u001b[J"); }
  clearScreen(): void { this.writes.push("\u001b[2J\u001b[H"); }
  setTitle(title: string): void { this.writes.push(`\u001b]0;${title}\u0007`); }
  setProgress(_active: boolean): void {}
}

async function flushTuiRender(tui: TUI): Promise<void> {
  tui.requestRender();
  await new Promise((resolve) => setTimeout(resolve, 30));
}

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
    compacting: false,
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
    toolsExpanded: false,
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
  for (const name of ["settings", "tools", "tree", "fork", "clone", "new", "resume", "name", "compact", "reload", "resources"]) assert.ok(catalog.some((command) => command.name === name));

  assert.equal(catalog.some((command) => command.name === "mouse"), false);

  const provider = new CombinedAutocompleteProvider(catalog, "/tmp");
  const suggestions = await provider.getSuggestions(["/skill-c"], 0, 8, { signal: new AbortController().signal });
  assert.ok(suggestions?.items.some((item) => item.value === "skill-check"));
});

test("Work help is scope-grouped and keeps every command syntax on one source line", () => {
  const help = workHelpText();
  assert.match(help, /^SESSION$/mu);
  assert.match(help, /^RUNTIME$/mu);
  assert.match(help, /^CLIENT$/mu);
  assert.match(help, /^EXTENSION$/mu);
  for (const line of help.split("\n")) assert.ok(visibleWidth(line) <= 72, line);
  assert.ok(help.indexOf("SESSION") < help.indexOf("RUNTIME"));
  assert.ok(help.indexOf("RUNTIME") < help.indexOf("CLIENT"));
  assert.ok(help.indexOf("CLIENT") < help.indexOf("EXTENSION"));
  for (const command of ["config", "install", "login"]) assert.match(help, new RegExp(`/${command}\\b`, "u"));
  assert.doesNotMatch(help, /\/mouse\b/u);
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

test("Alu palette uses semantic local surfaces without taking over the terminal background", () => {
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color", NO_COLOR: "" }, true), "none");
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color" }, true), "ansi256");
  assert.equal(detectTerminalColorLevel({ TERM: "xterm-256color", COLORTERM: "truecolor" }, true), "truecolor");

  const plain = createAluPaint("none");
  assert.equal(plain.userSurface("question"), "question");
  assert.equal(plain.running("run"), "run");

  const truecolor = createAluPaint("truecolor");
  assert.match(truecolor.userSurface("question"), /\u001b\[38;2;230;225;242;48;2;66;38;47mquestion\u001b\[0m/u);
  assert.notEqual(truecolor.running("state"), truecolor.success("state"));
  assert.notEqual(truecolor.success("state"), truecolor.error("state"));
  assert.match(truecolor.accent("accent"), /38;2;221;126;158/u);
  assert.match(truecolor.success("success"), /38;2;230;225;242/u);
  assert.match(truecolor.warning("truncated"), /38;2;246;193;71/u, "tool decision notices use canonical Alu gold");
  assert.match(truecolor.selection("selected"), /48;2;108;132;205/u);
  const nestedSurface = truecolor.toolSurface(`${truecolor.success("✓")} trailing padding`);
  assert.match(nestedSurface, /\u001b\[0m\u001b\[38;2;174;153;168;48;2;27;17;20m trailing padding/u,
    "nested semantic colors must restore the enclosing surface after SGR reset");
  for (const sample of [truecolor.accent("x"), truecolor.success("x"), truecolor.selection("x")]) {
    assert.doesNotMatch(sample, /125;211;252|94;234;212|22;78;99/u, "legacy cyan/teal colors are forbidden");
  }

  const ansi16 = createAluPaint("ansi16");
  assert.doesNotMatch(ansi16.userSurface("question"), /\u001b\[4[0-7]m/u, "local surfaces fall back to foreground-only at 16 colors");
});

test("local UI status replaces at the chat tail without becoming runtime activity", () => {
  const conversation = new DockConversation();
  conversation.addStatus("loading tools");
  conversation.addStatus("tools updated");
  assert.deepEqual(conversation.snapshot(), [{ kind: "status", text: "tools updated", complete: true }]);
  conversation.addNotice("model output");
  conversation.addStatus("settings saved");
  assert.deepEqual(conversation.snapshot().map((entry) => entry.text), ["tools updated", "model output", "settings saved"]);
});

test("full flowing conversation render includes the complete ordered transcript", () => {
  const conversation = new DockConversation();
  for (let index = 0; index < 500; index += 1) {
    conversation.apply(event(index + 1, "message.submitted", {
      operationId: `live-${index}`,
      messageId: `live-${index}`,
      role: "user",
      text: `live entry ${index}`,
      delivery: "steer",
    }));
  }
  assert.equal(conversation.snapshot().length, 500);
  const rendered = conversation.render(40).join("\n");
  assert.ok(rendered.indexOf("live entry 0") < rendered.indexOf("live entry 499"));
  assert.match(rendered, /live entry 250/u);
});

test("conversation reset replaces old session history", () => {
  const conversation = new DockConversation();
  conversation.addNotice("old session");
  conversation.reset();
  conversation.applyHistory([{ entryId: "new", role: "assistant", content: [{ type: "text", text: "new session" }] }], false);
  assert.deepEqual(conversation.snapshot(), [{ kind: "assistant", text: "new session", complete: true }]);
});

test("extension notifications follow Pi tail replacement and severity semantics", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([
    event(1, "command.handled", { operationId: "no-run-1", kind: "extension_command" }),
    event(2, "command.handled", { operationId: "no-run-2", kind: "no_run" }),
  ], false);
  assert.deepEqual(conversation.snapshot(), []);

  conversation.apply(event(3, "extension.notification", { level: "info", message: "rm-confirm ON" }));
  conversation.apply(event(4, "extension.notification", { level: "info", message: "rm-confirm status ON" }));
  conversation.apply(event(5, "message.submitted", {
    operationId: "prompt-1", messageId: "prompt-1", role: "user", text: "intervening message", delivery: "prompt",
  }));
  conversation.apply(event(6, "extension.notification", { level: "info", message: "Kanban status" }));
  conversation.apply(event(7, "extension.notification", { level: "warning", message: "rm-confirm OFF" }));
  conversation.apply(event(8, "extension.notification", { level: "warning", message: "rm-confirm remains OFF" }));
  conversation.apply(event(9, "extension.notification", { level: "error", message: "Extension command failed" }));
  conversation.apply(event(10, "extension.error", { error: "Extension hook failed" }));

  assert.deepEqual(conversation.snapshot().map((entry) => [entry.kind, entry.text]), [
    ["status", "rm-confirm status ON"],
    ["user", "intervening message"],
    ["status", "Kanban status"],
    ["warning", "rm-confirm OFF"],
    ["warning", "rm-confirm remains OFF"],
    ["error", "Extension command failed"],
    ["error", "Extension hook failed"],
  ]);
  const rendered = conversation.render(80).join("\n");
  assert.match(rendered, /rm-confirm status ON/u);
  assert.match(rendered, /rm-confirm OFF/u);
  assert.match(rendered, /Extension command failed/u);
});

test("conversation projects persisted history before live replay", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    { entryId: "h1", role: "user", content: [{ type: "text", text: "old question" }] },
    { entryId: "h2", parentId: "h1", role: "assistant", content: [{ type: "thinking", text: "old plan" }, { type: "text", text: "old answer" }, { type: "tool_call", toolCallId: "t1", toolName: "read", args: { path: "/tmp/old" } }] },
    { entryId: "h3", parentId: "h2", role: "tool", content: [{ type: "tool_result", toolCallId: "t1", toolName: "read", text: "old result", isError: false }] },
  ], true);

  assert.deepEqual(conversation.snapshot(), [
    { kind: "user", text: "old question", complete: true },
    { kind: "thinking", text: "old plan", complete: true },
    { kind: "assistant", text: "old answer", complete: true },
    { kind: "tool", text: "read done\nargs\n{\n  \"path\": \"/tmp/old\"\n}\nresult\nold result", complete: true },
  ]);
  assert.match(conversation.render(100).join("\n"), /✓ read.*\/tmp\/old/u);
});

test("persisted Pi edit results retain the same explicit added and deleted preview as live events", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    {
      entryId: "edit-call",
      role: "assistant",
      content: [{
        type: "tool_call",
        toolCallId: "edit-history",
        toolName: "edit",
        args: {
          path: "src/history.ts",
          edits: [{ oldText: "return oldValue;", newText: "return newValue;" }],
        },
      }],
    },
    {
      entryId: "edit-result",
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "edit-history",
        toolName: "edit",
        text: "-1 return oldValue;\n+1 return newValue;",
        isError: false,
      }],
    },
  ], false);

  const rendered = conversation.render(80).join("\n");
  assert.match(rendered, /-1 return oldValue;/u);
  assert.match(rendered, /\+1 return newValue;/u);
  assert.doesNotMatch(rendered, /Successfully replaced/u);
});

test("persisted assistant content blocks retain Pi order instead of telemetry grouping", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([{
    entryId: "ordered-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "first answer" },
      { type: "thinking", text: "later reasoning" },
      { type: "text", text: "final answer" },
      { type: "tool_call", toolCallId: "ordered-tool", toolName: "read", args: { path: "ordered.ts" } },
    ],
  }], false);
  assert.deepEqual(conversation.snapshot().map((entry) => entry.kind), ["assistant", "thinking", "assistant", "tool"]);
  const rendered = conversation.render(80).join("\n");
  assert.ok(rendered.indexOf("first answer") < rendered.indexOf("later reasoning"));
  assert.ok(rendered.indexOf("later reasoning") < rendered.indexOf("final answer"));
  assert.ok(rendered.indexOf("final answer") < rendered.indexOf("read"));
});

test("compaction summaries have a readable folded surface and expand explicitly", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    {
      entryId: "compact-1",
      role: "system",
      summaryKind: "compaction",
      content: [{ type: "text", text: "## Goal\n\nKeep the release safe.\n\n## Constraints\n\nDo not replay mutations.\n\nEND OF SUMMARY" }],
    },
    {
      entryId: "assistant-after-summary",
      role: "assistant",
      content: [{ type: "tool_call", toolCallId: "later-tool", toolName: "read", args: { path: "/tmp/later" } }],
    },
    {
      entryId: "tool-after-summary",
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "later-tool", toolName: "read", text: "later result", isError: false }],
    },
  ], false);

  const folded = conversation.render(43).filter((line) => line.trim().length > 0);
  const summaryLine = folded.find((line) => /\[compaction\]/u.test(line));
  assert.ok(summaryLine, "the folded compaction surface remains visible");
  assert.match(folded.join("\n"), /Earlier conversation was compacted/u);
  assert.doesNotMatch(folded.join("\n"), /END OF SUMMARY/u);
  assert.deepEqual(conversation.toggleLatestDetailExpanded(), { expanded: true, name: "compaction" });
  const expanded = conversation.render(80).join("\n");
  assert.match(expanded, /Goal/u);
  assert.match(expanded, /END OF SUMMARY/u);
  assert.deepEqual(conversation.toggleLatestDetailExpanded(), { expanded: false, name: "compaction" });

  const ordinary = new DockConversation();
  ordinary.applyHistory([{ entryId: "system-1", role: "system", content: [{ type: "text", text: "ordinary system text" }] }], false);
  assert.equal(ordinary.toggleLatestDetailExpanded(), undefined);
});

test("fresh conversation bootstrap ignores lifecycle replay and keeps only unresolved message/tool frames", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([{ entryId: "h1", role: "assistant", content: [{ type: "text", text: "current branch" }] }], false);
  conversation.applyBootstrapReplay([
    event(1, "session.replaced", { reason: "resume", previousSessionId: "old", runtimeGeneration: 1 }),
    event(2, "session.navigated", { targetId: "old-branch", leafId: "old-branch", treeRevision: "r1", summaryCreated: false }),
    event(3, "compaction.completed", { reason: "manual", aborted: false, willRetry: false }),
    event(4, "message.submitted", { operationId: "active", messageId: "u-active", role: "user", text: "current prompt", delivery: "prompt" }),
    event(5, "message.delta", { messageId: "a-active", block: "text", delta: "partial" }),
  ]);
  const projected = conversation.snapshot();
  assert.deepEqual(projected.map((entry) => entry.text), ["current branch", "current prompt", "partial"]);
  assert.equal(JSON.stringify(projected).includes("old-branch"), false);
  assert.equal(JSON.stringify(projected).includes("Compaction completed"), false);
});

test("an empty persisted branch still shows an unresolved active tool bootstrap", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([], false);
  conversation.applyBootstrapReplay([
    event(20, "run.started", { operationId: "runtime-initiated" }),
    event(21, "message.completed", {
      messageId: "hidden-guard",
      role: "system",
      content: [{ type: "text", text: "hidden continuation control" }],
    }),
    event(22, "tool.started", {
      toolCallId: "offline-continuation-tool",
      toolName: "read",
      args: { path: "src/offline.ts" },
    }),
  ]);
  assert.deepEqual(conversation.snapshot().map((entry) => [entry.kind, entry.text]), [
    ["tool", "read running\nargs\n{\n  \"path\": \"src/offline.ts\"\n}"],
  ]);
  assert.doesNotMatch(conversation.render(80).join("\n"), /Start a conversation|hidden continuation control/u);
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
  assert.doesNotMatch(rendered.join("\n"), /▎/);
  assert.equal(rendered[0], " ".repeat(24), "Pi-style user box reserves a full-width top padding row");
  assert.match(rendered[1] ?? "", /^ hello\[2J\s+$/u);
  assert.equal(rendered[2], " ".repeat(24), "Pi-style user box reserves a full-width bottom padding row");
  assert.match(rendered.join("\n"), /secret reasoning/);
  assert.doesNotMatch(rendered.join("\n"), /│ secret reasoning/);
  assert.doesNotMatch(rendered.join("\n"), /^\s*(You|Assistant|Thinking)\s*$/mu);
});

test("user messages mirror Pi box padding and Markdown semantics with a full-width surface", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "message.submitted", {
    operationId: "markdown-user",
    messageId: "markdown-user",
    role: "user",
    text: "Use **bold** and `inline` code.\n\n3. keep this marker",
    delivery: "prompt",
  }));

  const rendered = conversation.render(32);
  assert.equal(rendered[0], " ".repeat(32));
  assert.equal(rendered.at(-2), " ".repeat(32));
  assert.match(rendered.join("\n"), /Use bold and inline code\./u);
  assert.match(rendered.join("\n"), /3\. keep this marker/u);
  assert.doesNotMatch(rendered.join("\n"), /\*\*bold\*\*|`inline`|▎/u);
  for (const line of rendered) assert.ok(visibleWidth(line) <= 32);
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

test("bash tool details preserve hard newlines and indentation without JSON escapes", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "bash-lines", toolName: "bash", args: { command: "printf one\n  printf two\n\tprintf three" },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "bash-lines", toolName: "bash", isError: false, text: "first\n  second\nthird",
  }));
  conversation.toggleLatestToolExpanded();
  const rendered = conversation.render(80).join("\n");
  assert.match(rendered, /^\s+printf one\s*$/mu);
  assert.match(rendered, /^\s+printf two\s*$/mu);
  assert.match(rendered, /^\s+printf three\s*$/mu);
  assert.match(rendered, /^\s+second\s*$/mu);
  assert.doesNotMatch(rendered, /\\n/u);

  for (const line of conversation.render(18)) assert.ok(visibleWidth(line) <= 18);
});

test("conversation renders Markdown, code, thinking policy, and diff tools at bounded widths", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "message.delta", { messageId: "a1", block: "thinking", delta: "**plan**" }));
  conversation.apply(event(2, "message.delta", { messageId: "a1", block: "text", delta: "# Result\n\n```ts\nconst answer = 42;\n```" }));
  conversation.apply(event(3, "message.completed", {
    messageId: "a1", role: "assistant",
    content: [{ type: "thinking", text: "**plan**" }, { type: "text", text: "# Result\n\n```ts\nconst answer = 42;\n```" }],
  }));
  conversation.apply(event(4, "tool.started", {
    toolCallId: "t1",
    toolName: "edit",
    args: { path: "src/a.ts", edits: [{ oldText: "const value = 'old';", newText: "const value = 'new';" }] },
  }));
  const runningEdit = conversation.render(60);
  conversation.apply(event(5, "tool.completed", {
    toolCallId: "t1", toolName: "edit", isError: false,
    text: "     ...\n  9 const keep = true;\n-10 const value = 'old';\n+10 const value = 'new';\n 11 return value;\n     ...",
  }));
  assert.ok(conversation.render(60).length >= runningEdit.length, "a successful real Pi edit result must not collapse its tool surface");

  assert.ok(conversation.snapshot().some((entry) => entry.kind === "thinking" && entry.text === "**plan**"));
  assert.match(conversation.snapshot().at(-1)?.text ?? "", /src\/a\.ts/);
  const collapsed = conversation.render(60).join("\n");
  assert.match(collapsed, /✓ edit.*src\/a\.ts/u);
  assert.match(collapsed, /-10 const value = 'old';/u);
  assert.match(collapsed, /\+10 const value = 'new';/u, "real Pi edit result details retain an explicit added/deleted preview");
  assert.doesNotMatch(collapsed, /Successfully replaced/u, "the semantic diff replaces redundant edit success telemetry");
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "edit" });
  assert.match(conversation.render(60).join("\n"), /\+10 const value = 'new';/u);
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

test("Host-truncated Pi edit diffs keep diff semantics and never fall back to raw edit arguments", () => {
  const conversation = new DockConversation();
  const projectedDiff = projectDisplayEditDiff(`-1 oldValue();\n+1 newValue();\n+2 ${"const next = value; ".repeat(1_000)}`);
  assert.ok(projectedDiff !== undefined);
  conversation.apply(event(1, "tool.started", {
    toolCallId: "edit-truncated",
    toolName: "edit",
    args: { path: "src/large.ts", edits: [{ oldText: "private old argument", newText: "private new argument" }] },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "edit-truncated",
    toolName: "edit",
    isError: false,
    text: projectedDiff,
  }));

  const collapsed = conversation.render(80).join("\n");
  assert.match(collapsed, /-1 oldValue\(\);/u);
  assert.match(collapsed, /\+1 newValue\(\);/u);
  assert.match(collapsed, /truncated by Host projection/u);
  conversation.toggleLatestToolExpanded();
  const expanded = conversation.render(80).join("\n");
  assert.doesNotMatch(expanded, /private old argument|private new argument/u);
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
  assert.match(rendered, /✓ read.*…\/src\/tui\/conversation\.ts.*lines 10–14/u);
  assert.match(rendered, /✓ bash.*npm run check.*↵ \+1 line/u);
  assert.match(rendered, /✓ edit.*src\/tui\/theme\.ts.*2 edits/u);
  assert.match(rendered, /✓ write.*README\.md.*3 lines/u);
  assert.match(rendered, /✓ alu_kanban.*get_card.*card #164/u);
  assert.doesNotMatch(rendered, /ARBITRARY PAYLOAD MUST STAY FOLDED/u);
  for (const width of [20, 43, 80]) {
    for (const line of conversation.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
});

test("tool surfaces expand terminal tabs so background rows stay contiguous", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "tabbed-bash-output",
    toolName: "bash",
    args: { command: "du -sh $HOME/.local/share/alu-dock" },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "tabbed-bash-output",
    toolName: "bash",
    isError: false,
    text: "current install: 176M\t/home/luziyi/.local/share/alu-dock\ncurrent files: 20503",
  }));

  const rendered = conversation.render(80);
  assert.equal(rendered.some((line) => line.includes("\t")), false);
  assert.match(rendered.join("\n"), /current install: 176M +\/home\/luziyi/u);
  const outputRow = rendered.find((line) => line.includes("current install"));
  assert.equal(visibleWidth(outputRow ?? ""), 80, "the entire painted surface row remains materialized");
});

test("bounded tool previews retain content without shrinking across automatic lifecycle updates", () => {
  for (const width of [20, 43, 80]) {
    const conversation = new DockConversation();
    conversation.apply(event(1, "tool.started", {
      toolCallId: `stable-${width}`,
      toolName: "read",
      args: { path: "src/stable.ts" },
    }));
    conversation.render(width);

    conversation.apply(event(2, "tool.output_updated", {
      toolCallId: `stable-${width}`,
      text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
    }));
    const longPreview = conversation.render(width);
    assert.match(longPreview.join("\n"), /line 1/u);
    assert.match(longPreview.join("\n"), /line 10/u);
    assert.doesNotMatch(longPreview.join("\n"), /line 11|line 30/u);
    assert.match(longPreview.join("\n"), /20 more visu/u);
    if (width >= 43) assert.match(longPreview.join("\n"), /Ctrl\+O/u);

    conversation.apply(event(3, "tool.output_updated", {
      toolCallId: `stable-${width}`,
      text: "short update",
    }));
    const shortPreview = conversation.render(width);
    assert.equal(shortPreview.length, longPreview.length, `tool update shrank at width ${width}`);
    assert.match(shortPreview.join("\n"), /short update/u);

    conversation.apply(event(4, "tool.completed", {
      toolCallId: `stable-${width}`,
      toolName: "read",
      isError: false,
      text: "final",
    }));
    const completed = conversation.render(width);
    assert.equal(completed.length, longPreview.length, `tool completion shrank at width ${width}`);
    assert.match(completed.join("\n"), /final/u);
    for (const line of completed) assert.ok(visibleWidth(line) <= width);
  }
});

test("built-in presentations keep decision-critical tail, limits, continuation, and saved-output notices visible", () => {
  const renderCompleted = (toolName: string, text: string, presentation: Record<string, unknown>) => {
    const live = new DockConversation();
    live.apply(event(1, "tool.completed", { toolCallId: `call-${toolName}`, toolName, isError: false, text, presentation }));
    const history = new DockConversation();
    history.applyHistory([{
      entryId: `history-${toolName}`,
      role: "tool",
      content: [{ type: "tool_result", toolCallId: `call-${toolName}`, toolName, text, isError: false, presentation: presentation as never }],
    }], false);
    assert.deepEqual(history.render(100), live.render(100), `${toolName} live/history rendering diverged`);
    return live.render(100).join("\n");
  };

  const bashText = `${Array.from({ length: 30 }, (_, index) => `bash line ${index + 1}`).join("\n")}\n\n[Showing lines 71-100 of 100. Full output: /tmp/pi-bash-visible.log]`;
  const bash = renderCompleted("bash", bashText, {
    kind: "bash", preview: "tail", completeness: "truncated", notices: [
      { code: "output_truncated", by: "lines", shown: 30, total: 100, limit: 30 },
      { code: "full_output_saved", path: "/tmp/pi-bash-visible.log" },
    ],
  });
  assert.match(bash, /bash line 30/u);
  assert.doesNotMatch(bash, /bash line 1\s*$/mu);
  assert.match(bash, /earlier visual lines · Ctrl\+O details/u);
  assert.match(bash, /truncated · showing 30 lines of 100/u);
  assert.match(bash, /full output saved · \/tmp\/pi-bash-visible\.log/u);
  assert.doesNotMatch(bash, /Showing lines 71-100/u, "raw Pi footer is replaced by one styled semantic notice set");

  const readText = `${Array.from({ length: 15 }, (_, index) => `read line ${index + 1}`).join("\n")}\n\n[Showing lines 1-15 of 40. Use offset=16 to continue.]`;
  const read = renderCompleted("read", readText, {
    kind: "read", preview: "head", completeness: "truncated", notices: [{ code: "continue_with_offset", offset: 16 }],
  });
  assert.match(read, /read line 1/u);
  assert.doesNotMatch(read, /read line 15/u);
  assert.match(read, /continue with read offset=16/u);

  const hostProjectedRead = renderCompleted("read", `${Array.from({ length: 30 }, (_, index) => `projected line ${index + 1}`).join("\n")}\n[tool output truncated by Host projection]`, {
    kind: "read", preview: "head", completeness: "truncated", notices: [{ code: "host_projection_truncated" }],
  });
  assert.match(hostProjectedRead, /projected line 1/u);
  assert.doesNotMatch(hostProjectedRead, /projected line 30/u, "head preview may fold ordinary tail rows");
  assert.match(hostProjectedRead, /tool output truncated by Host projection/u, "Host truncation stays outside the foldable content budget");

  const grep = renderCompleted("grep", Array.from({ length: 20 }, (_, index) => `match ${index + 1}`).join("\n"), {
    kind: "grep", preview: "head", completeness: "truncated", notices: [
      { code: "limit_reached", unit: "matches", limit: 100 },
      { code: "lines_truncated", maxChars: 500 },
    ],
  });
  assert.match(grep, /100 matches limit reached/u);
  assert.match(grep, /use read for full lines/u);

  const find = renderCompleted("find", "a.ts\nb.ts", {
    kind: "find", preview: "head", completeness: "truncated", notices: [{ code: "limit_reached", unit: "results", limit: 1_000 }],
  });
  assert.match(find, /1,000 results limit reached/u);
  const ls = renderCompleted("ls", "a\nb", {
    kind: "ls", preview: "head", completeness: "truncated", notices: [{ code: "limit_reached", unit: "entries", limit: 500 }],
  });
  assert.match(ls, /500 entries limit reached/u);

  const semanticUpdate = new DockConversation();
  semanticUpdate.apply(event(1, "tool.started", { toolCallId: "same-output", toolName: "find", args: { path: "." } }));
  semanticUpdate.apply(event(2, "tool.output_updated", {
    toolCallId: "same-output", text: "same projected text",
    presentation: { kind: "find", preview: "head", completeness: "complete", notices: [] },
  }));
  assert.doesNotMatch(semanticUpdate.render(100).join("\n"), /results limit reached/u);
  semanticUpdate.apply(event(3, "tool.output_updated", {
    toolCallId: "same-output", text: "same projected text",
    presentation: { kind: "find", preview: "head", completeness: "truncated", notices: [{ code: "limit_reached", unit: "results", limit: 1_000 }] },
  }));
  assert.match(semanticUpdate.render(100).join("\n"), /1,000 results limit reached/u, "presentation-only updates are decision data");

  for (const rendered of [bash, read, hostProjectedRead, grep, find, ls]) assert.doesNotMatch(rendered, /full details/u);
});

test("automatic tool preview contraction does not trigger pi-tui full redraw", async () => {
  const conversation = new DockConversation();
  for (let index = 0; index < 20; index += 1) conversation.addNotice(`settled history ${index}`);
  conversation.apply(event(100, "tool.started", {
    toolCallId: "renderer-stable",
    toolName: "read",
    args: { path: "src/stable.ts" },
  }));

  const terminal = new RecordingTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(true);
  tui.addChild(conversation);
  tui.start();
  await flushTuiRender(tui);

  conversation.apply(event(101, "tool.output_updated", {
    toolCallId: "renderer-stable",
    text: Array.from({ length: 30 }, (_, index) => `renderer line ${index + 1}`).join("\n"),
  }));
  await flushTuiRender(tui);
  const redrawsBeforeContraction = tui.fullRedraws;
  const writesBeforeContraction = terminal.writes.length;

  conversation.apply(event(102, "tool.output_updated", {
    toolCallId: "renderer-stable",
    text: "short renderer update",
  }));
  await flushTuiRender(tui);
  conversation.apply(event(103, "tool.completed", {
    toolCallId: "renderer-stable",
    toolName: "read",
    isError: false,
    text: "final renderer output",
  }));
  await flushTuiRender(tui);
  tui.stop();

  assert.equal(tui.fullRedraws, redrawsBeforeContraction);
  const contractionWrites = terminal.writes.slice(writesBeforeContraction).join("");
  assert.doesNotMatch(contractionWrites, /\u001b\[3J/u);
  assert.doesNotMatch(contractionWrites, /\u001b\[\?1049h|\u001b\[\?1000h|\u001b\[\?1006h/u);
});

test("generic structured tool previews expose safe outcome fields without arbitrary payloads", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "kanban-safe-preview",
    toolName: "alu_kanban",
    args: { action: "update_card", card_id: 209, description: "PRIVATE INPUT" },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "kanban-safe-preview",
    toolName: "alu_kanban",
    isError: false,
    text: JSON.stringify({
      ok: true,
      action: "update_card",
      card_id: 209,
      persisted: { description: "PRIVATE OUTPUT" },
    }),
  }));

  const preview = conversation.render(80).join("\n");
  assert.match(preview, /ok · update_card · card #209/u);
  assert.doesNotMatch(preview, /PRIVATE INPUT|PRIVATE OUTPUT|persisted/u);
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "alu_kanban" });
  assert.match(conversation.render(80).join("\n"), /PRIVATE OUTPUT/u);

  const malformed = new DockConversation();
  malformed.apply(event(3, "tool.started", {
    toolCallId: "malformed-structured-preview",
    toolName: "alu_kanban",
    args: { action: "update_card", card_id: 210 },
  }));
  malformed.apply(event(4, "tool.completed", {
    toolCallId: "malformed-structured-preview",
    toolName: "alu_kanban",
    isError: false,
    text: "{\"ok\":true,\"private\":\"MUST NOT LEAK",
  }));
  const malformedPreview = malformed.render(80).join("\n");
  assert.match(malformedPreview, /structured result truncated or unavailable/u);
  assert.doesNotMatch(malformedPreview, /MUST NOT LEAK|private/u);
});

test("authoritative toolsExpanded updates clear per-tool overrides", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "authoritative-tool", toolName: "read", args: { path: "src/current.ts" },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "authoritative-tool", toolName: "read", isError: false,
    text: Array.from({ length: 14 }, (_, index) => `authoritative detail ${index + 1}`).join("\n"),
  }));

  conversation.setToolsExpanded(true);
  assert.match(conversation.render(80).join("\n"), /authoritative detail 14/u);
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: false, name: "read" });
  const preview = conversation.render(80).join("\n");
  assert.match(preview, /authoritative detail 1/u);
  assert.doesNotMatch(preview, /authoritative detail 14/u);
  assert.match(preview, /visual lines · Ctrl\+O details/u);

  conversation.setToolsExpanded(true);
  assert.equal(conversation.areToolsExpanded(), true);
  assert.match(conversation.render(80).join("\n"), /authoritative detail 14/u);
});

test("collapsed tool failures expose a safe first-line reason and preserve expandable detail", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", { toolCallId: "failed-tool", toolName: "bash", args: { command: "false" } }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "failed-tool", toolName: "bash", isError: true, text: "expanded failure detail",
  }));
  conversation.addNotice("later assistant-visible output");
  const collapsed = conversation.render(120).join("\n");
  assert.match(collapsed, /× bash.*false.*expanded failure detail/u);
  assert.doesNotMatch(collapsed, /bash failed/u);
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "bash" });
  assert.match(conversation.render(60).join("\n"), /expanded failure detail/);

  const longBashFailure = new DockConversation();
  longBashFailure.apply(event(3, "tool.started", { toolCallId: "long-bash-error", toolName: "bash", args: { command: "long-command" } }));
  longBashFailure.apply(event(4, "tool.completed", {
    toolCallId: "long-bash-error",
    toolName: "bash",
    isError: true,
    text: `${Array.from({ length: 30 }, (_, index) => `noisy output ${index + 1}`).join("\n")}\n\nCommand exited with code 7`,
    presentation: { kind: "bash", preview: "tail", completeness: "complete", notices: [] },
  }));
  const longFailurePreview = longBashFailure.render(100).join("\n");
  assert.match(longFailurePreview, /× bash.*Command exited with code 7/u, "terminal failure reason stays in the header even after noisy output");
  assert.match(longFailurePreview, /noisy output 30/u);
  assert.doesNotMatch(longFailurePreview, /noisy output 1\s*$/mu);

  const structured = new DockConversation();
  structured.apply(event(3, "tool.started", { toolCallId: "json-error", toolName: "subagent", args: { agent: "scout" } }));
  structured.apply(event(4, "tool.completed", {
    toolCallId: "json-error",
    toolName: "subagent",
    isError: true,
    text: JSON.stringify({ error: { message: "child exited 2" }, privatePayload: { token: "must-not-render" } }),
  }));
  const structuredCollapsed = structured.render(100).join("\n");
  assert.match(structuredCollapsed, /child exited 2/u);
  assert.doesNotMatch(structuredCollapsed, /privatePayload|must-not-render/u);
});

test("interrupted active tools retain the settlement reason in preview and full detail", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "interrupted-tool",
    toolName: "read",
    args: { path: "src/long-running.ts" },
  }));
  conversation.apply(event(2, "tool.output_updated", {
    toolCallId: "interrupted-tool",
    text: Array.from({ length: 30 }, (_, index) => `partial line ${index + 1}`).join("\n"),
  }));
  conversation.apply(event(3, "run.settled", { result: "aborted" }));
  const preview = conversation.render(80).join("\n");
  assert.match(preview, /× read.*interrupted by aborted/u);
  assert.doesNotMatch(preview, /partial line 30/u, "the reason must remain visible even when a head preview clips the output tail");
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "read" });
  assert.match(conversation.render(80).join("\n"), /partial line 30[\s\S]*interrupted by aborted/u);
});

test("subagent tool completion mirrors the closed isError lifecycle instead of claiming done", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "subagent-failed", toolName: "subagent", args: { agent: "scout" },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "subagent-failed", toolName: "subagent", isError: true,
    text: "Native pi-subagents intercom currently handles supervisor replies. Child agents initiate asks with contact_supervisor.",
  }));
  const projected = conversation.render(120).join("\n");
  assert.match(projected, /× subagent.*scout/u);
  assert.doesNotMatch(projected, /subagent failed/u);
  assert.match(projected, /Native pi-subagents intercom/u);
  assert.doesNotMatch(projected, /✓ subagent done/u);
});

test("compaction keeps successful and real failures durable while no-op/cancel stay transient", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "compaction.started", { reason: "manual" }));
  conversation.apply(event(2, "compaction.completed", { reason: "manual", aborted: false, willRetry: false, error: "Compaction failed: Nothing to compact (session too small)" }));
  conversation.apply(event(3, "compaction.completed", { reason: "manual", aborted: true, willRetry: false }));
  conversation.apply(event(4, "compaction.completed", { reason: "manual", aborted: false, willRetry: false, error: "Provider compaction failed" }));
  conversation.apply(event(5, "compaction.completed", { reason: "manual", aborted: false, willRetry: false, error: "Provider wrote an entry, then said nothing to compact while closing" }));

  assert.deepEqual(conversation.snapshot().map((entry) => [entry.kind, entry.text]), [
    ["error", "Provider compaction failed"],
    ["error", "Provider wrote an entry, then said nothing to compact while closing"],
  ]);
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
  projected = projectSnapshot(projected, event(4, "extension.tools_expanded_changed", { expanded: true }));
  assert.equal(projected.toolsExpanded, true);
  projected = projectSnapshot(projected, event(5, "git.branch_changed", { branch: "feature/live" }));
  assert.equal(projected.gitBranch, "feature/live");
  projected = projectSnapshot(projected, event(6, "instance.state_changed", {
    reason: "settled", lifecycle: "active", execution: "idle", compacting: false, lastRun: "succeeded",
    pending: { steering: 0, followUp: 0, total: 0 },
  }));
  projected = projectSnapshot(projected, {
    ...event(1, "session.replaced", { reason: "reload", runtimeGeneration: 2, sessionFile: "/tmp/pi-2.jsonl", cwd: "/tmp/reloaded", piSessionId: "pi-2", gitBranch: "replacement" }),
    runtimeGeneration: 2,
  });

  assert.equal(projected.metrics?.context?.percent, 20);
  assert.deepEqual(projected.extensionStatus, {});
  assert.equal(projected.toolsExpanded, false, "session replacement resets extension UI state");
  assert.equal(projected.execution, "idle");
  assert.equal(projected.lastRun, "never");
  assert.equal(projected.activeCommandId, undefined);
  assert.equal(projected.runtimeGeneration, 2);
  assert.equal(projected.cwd, "/tmp/reloaded");
  assert.equal(projected.gitBranch, "replacement");
  assert.equal(projected.name, undefined);
  assert.equal(projected.executor.piSessionId, "pi-2");
  assert.equal(projected.eventCursor.runtimeGeneration, 2);
  assert.equal(projected.eventCursor.sequence, 1);
  assert.equal(projected.executor.sessionFile, "/tmp/pi-2.jsonl");
});

test("Work chrome separates semantic metadata metrics extensions and activity", () => {
  const conversation = new DockConversation();
  conversation.applyReplay([], true);
  assert.deepEqual(conversation.snapshot(), []);

  let current = snapshot();
  const metadata = new DockWorkMetadata(() => current);
  const activity = new DockActivityLine();
  const status = new DockStatusLine(current);
  activity.setActivity({ phase: "responding", label: "responding" });
  const metadataLine = metadata.render(120).join("\n");
  const lines = status.render(120);
  assert.equal(lines.length, 2);
  const footer = lines.join("\n");
  assert.match(metadataLine, /demo/);
  assert.match(metadataLine, /\/tmp\/demo/);
  assert.match(metadataLine, /openai-codex\/gpt-test/);
  assert.match(metadataLine, /think off/);
  assert.match(footer, /ctx 1\.0k\/10\.0k 10%/);
  assert.match(footer, /cache 20%/);
  assert.match(footer, /↑800 ↓200/);
  assert.match(footer, /\$0\.0042/);
  assert.match(footer, /alu-kanban: ready/);
  assert.doesNotMatch(`${metadataLine}\n${footer}`, /ALU DOCK|NIGHT CONSOLE|connected|acquired|observing|d:dock|p:pi-|running|cmp/u);
  assert.doesNotMatch(footer, /demo|gpt-test|streaming/);
  for (const line of [metadataLine, ...lines]) assert.ok(visibleWidth(line) <= 120);

  current = {
    ...current,
    name: "A very long customer migration session name",
    cwd: "/work/customer/project",
    gitBranch: "feature/live",
    executor: { ...current.executor, thinkingLevel: "high" },
  };
  const responsiveMetadata = metadata.render(80).join("\n");
  assert.match(responsiveMetadata, /A very.*…er\/project \(feature\/live\).*gpt-test.*think high/u);
  activity.setActivity({ phase: "waiting", label: "waiting for model" });
  const narrowActivity = activity.render(43);
  const narrowMetadata = metadata.render(43);
  const narrowStatus = status.render(43);
  assert.match(narrowMetadata.join("\n"), /A ve.*\(featur.*gpt-test.*high/u);
  assert.equal(narrowActivity.length, 1);
  assert.match(narrowActivity[0] ?? "", /waiting for model/);
  assert.equal(narrowStatus.length, 2);
  assert.doesNotMatch(narrowStatus.join("\n"), /waiting for model/);
  for (const line of [...narrowMetadata, ...narrowActivity, ...narrowStatus]) assert.ok(visibleWidth(line) <= 43);

  const flowingFooter = [...metadata.render(120), ...status.render(120)];
  assert.match(flowingFooter[0] ?? "", /customer migration/u, "metadata is the first footer row");
  assert.match(flowingFooter[1] ?? "", /cache 20%/u, "metrics follow metadata");
  assert.match(flowingFooter[2] ?? "", /alu-kanban: ready/u, "reserved extension row remains last");

  const detachedMetadata = new DockWorkMetadata(() => ({ ...current, gitBranch: "detached" })).render(100).join("\n");
  assert.match(detachedMetadata, /project \(detached\)/u);
  const nonRepositoryMetadata = new DockWorkMetadata(() => ({ ...current, gitBranch: undefined })).render(100).join("\n");
  assert.match(nonRepositoryMetadata, /customer\/project/u);
  assert.doesNotMatch(nonRepositoryMetadata, /\(feature\/live\)|\(detached\)/u);

  const emptyExtensions = new DockStatusLine({ ...current, extensionStatus: {} }).render(80);
  assert.equal(emptyExtensions[1], "");

  const diagnostics = formatWorkStatus(current);
  assert.match(diagnostics, /Work cwd: \/work\/customer\/project \(feature\/live\)/u);
  assert.match(diagnostics, /Dock ID: dock-1/u);
  assert.match(diagnostics, /Pi session ID: pi-1/u);
  assert.match(diagnostics, /Runtime generation: 1/u);
});
