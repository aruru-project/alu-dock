import assert from "node:assert/strict";
import test from "node:test";

import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";

import { projectDisplayEditDiff } from "../src/core/edit-diff-projection.js";
import type { DockEvent, HistoryEntryDto, InstanceSnapshot } from "../src/core/managed-instance.js";
import { DockActivityLine, DockConversation, DockStatusLine, DockWorkMetadata } from "../src/tui/conversation.js";
import { commandCatalog, shellCommandInput, workHelpText } from "../src/tui/dock-tui.js";
import { PendingQueueTray } from "../src/tui/pending-queue.js";

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

function historyRecord(
  entryId: string,
  source: HistoryEntryDto["source"],
  content: HistoryEntryDto["content"],
  overrides: Partial<HistoryEntryDto> = {},
): HistoryEntryDto {
  return {
    recordId: entryId,
    entryId,
    kind: "message",
    source,
    visibility: "conversation",
    content,
    ...overrides,
  };
}

function snapshot(): InstanceSnapshot {
  return {
    id: "dock-1",
    creationOperationId: "create-1",
    name: "demo",
    displayName: "demo",
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
    executionChangedAt: "2026-07-14T00:00:00.000Z",
    runStartedAt: "2026-07-14T00:00:00.000Z",
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
  assert.equal(catalog.find((command) => command.name === "stop")?.description, "end this work and remove it from Dock");
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
  assert.match(help, /^CONVERSATION$/mu);
  assert.match(help, /^PI$/mu);
  assert.match(help, /^WORK$/mu);
  assert.match(help, /^DETAILS$/mu);
  for (const line of help.split("\n")) assert.ok(visibleWidth(line) <= 72, line);
  assert.ok(help.indexOf("CONVERSATION") < help.indexOf("PI"));
  assert.ok(help.indexOf("PI") < help.indexOf("WORK"));
  assert.ok(help.indexOf("WORK") < help.indexOf("DETAILS"));
  for (const command of ["config", "install", "login"]) assert.match(help, new RegExp(`/${command}\\b`, "u"));
  assert.doesNotMatch(help, /\/mouse\b/u);
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

test("conversation renders live and historical image and attachment metadata without blank turns", () => {
  const live = new DockConversation();
  live.apply(event(1, "message.submitted", {
    operationId: "image-only",
    messageId: "image-only",
    role: "user",
    text: "",
    images: [{ path: "/tmp/input.png", mimeType: "image/png" }],
    delivery: "prompt",
  }));
  assert.deepEqual(live.snapshot(), [{ kind: "user", text: "[Image 1 · image/png]", complete: true }]);

  const historical = new DockConversation();
  historical.applyHistory([
    historyRecord("historical-image", "user", [{ type: "text", text: "caption" }, { type: "image", mimeType: "image/webp" }]),
  ], false);
  assert.deepEqual(historical.snapshot(), [{ kind: "user", text: "caption\n\n[Image 1 · image/webp]", complete: true }]);

  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000", name: "报告 final.pdf", sizeBytes: 1_572_864,
    mediaType: "application/pdf", sha256: "a".repeat(64), storedAt: "2026-08-16T00:00:00.000Z",
  };
  const attachmentConversation = new DockConversation();
  attachmentConversation.apply(event(2, "message.submitted", {
    operationId: "attachment-only", messageId: "attachment-only", role: "user", text: "",
    attachments: [attachment], delivery: "prompt",
  }));
  assert.deepEqual(attachmentConversation.snapshot(), [{
    kind: "user", text: "[Attachment · 报告 final.pdf · 1.5 MiB · application/pdf]", complete: true,
  }]);
  const historicalAttachment = new DockConversation();
  historicalAttachment.applyHistory([historyRecord("historical-attachment", "user", [{ type: "text", text: "inspect" }], { attachments: [attachment] })], false);
  assert.deepEqual(historicalAttachment.snapshot(), [{
    kind: "user", text: "inspect\n\n[Attachment · 报告 final.pdf · 1.5 MiB · application/pdf]", complete: true,
  }]);

  const imageAttachment = {
    fileId: "223e4567-e89b-42d3-a456-426614174000", name: "photo.png", sizeBytes: 68,
    mediaType: "image/png", sha256: "b".repeat(64), storedAt: "2026-08-19T00:00:00.000Z",
  };
  const linkedImage = new DockConversation();
  linkedImage.applyHistory([historyRecord("linked-image", "user", [
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", fileId: imageAttachment.fileId },
  ], { attachments: [imageAttachment] })], false);
  assert.deepEqual(linkedImage.snapshot(), [{
    kind: "user", text: "look\n\n[Attachment · photo.png · 68 B · image/png]", complete: true,
  }]);
});

test("conversation reset replaces old session history", () => {
  const conversation = new DockConversation();
  conversation.addNotice("old session");
  conversation.reset();
  conversation.applyHistory([historyRecord("new", "assistant", [{ type: "text", text: "new session" }])], false);
  assert.deepEqual(conversation.snapshot(), [{ kind: "assistant", text: "new session", complete: true }]);
});

test("a reopened conversation says what its system prompt, cost and model-context records changed (card #347)", () => {
  const conversation = new DockConversation();
  const runtime = { kind: "custom", source: "runtime", visibility: "metadata" } as const;
  conversation.applyHistory([
    historyRecord("s1", "system", [{ type: "text", text: "Fixture prompt." }], {
      visibility: "metadata",
      systemPrompt: { sections: ["preamble", "skills"], removedSections: [], toolsAdded: ["read", "bash"], toolsRemoved: ["bash"] },
    }),
    historyRecord("u1", "user", [{ type: "text", text: "hello" }]),
    historyRecord("a1", "assistant", [], { error: "provider overloaded", stopReason: "error" }),
    historyRecord("e1", "runtime", [], { ...runtime, customType: "context_edit", targetEntryId: "a1", contextEdit: "omit" }),
    historyRecord("w1", "runtime", [], {
      ...runtime, customType: "usage", provider: "anthropic", modelId: "claude",
      usage: { kind: "cache_warm", tokens: { input: 0, output: 1, cacheRead: 9_000, cacheWrite: 0, total: 9_001 }, cost: 0.0042 },
    }),
  ], false);
  assert.deepEqual(conversation.snapshot().filter((entry) => entry.kind === "system").map((entry) => entry.text), [
    "System prompt: sections preamble, skills \u00b7 tools +read \u00b7 tools changed bash \u00b7 /context-changes shows it in full",
    "Model context: a failed reply was removed; the conversation still shows it.",
    "Cache warmed \u00b7 $0.0042 \u00b7 anthropic/claude",
  ]);
});

test("fresh TUI recovery keeps extension command feedback visible", () => {
  const conversation = new DockConversation();
  conversation.applyBootstrapReplay([
    event(1, "extension.notification", { level: "warning", message: "rm confirmation is off", operationId: "rm-off" }),
  ]);
  assert.deepEqual(conversation.snapshot(), [{ kind: "warning", text: "rm confirmation is off", complete: true }]);
  assert.match(conversation.render(80).join("\n"), /rm confirmation is off/u);
});







test("collapsed multi-hunk edit previews prioritize actual changes over surrounding context", () => {
  const conversation = new DockConversation();
  const displayDiff = [
    "     ...",
    "  50 success: ALU_PALETTE.white,",
    "  51 queue: ALU_PALETTE.highlight,",
    "  52 warning: ALU_PALETTE.gold,",
    "  53 error: ALU_PALETTE.pink,",
    "+ 54 diffAdded: ALU_PALETTE.navy,",
    "+ 55 diffRemoved: ALU_PALETTE.pink,",
    "+ 56 diffHunk: ALU_PALETTE.gold,",
    "  54 userSurface: shadeTone(ALU_PALETTE.pink),",
    "  55 toolSurface: shadeTone(ALU_PALETTE.hair),",
    "     ...",
    "  96 success: decorate(tones.success),",
    "  97 queue: decorate(tones.queue),",
    "  98 warning: decorate(tones.warning),",
    "  99 error: decorate(tones.error),",
    "+103 diffAdded: decorate(tones.diffAdded),",
    "+104 diffRemoved: decorate(tones.diffRemoved),",
    "+105 diffHunk: decorate(tones.diffHunk),",
    " 100 muted: decorate(tones.muted),",
    " 101 faint: decorate(tones.faint),",
    "     ...",
  ].join("\n");
  conversation.apply(event(1, "tool.started", {
    toolCallId: "multi-edit",
    toolName: "edit",
    args: {
      path: "src/tui/theme.ts",
      edits: [
        { oldText: "old first block", newText: "new first block" },
        { oldText: "old second block", newText: "new second block" },
      ],
    },
  }));
  conversation.apply(event(2, "tool.completed", {
    toolCallId: "multi-edit",
    toolName: "edit",
    isError: false,
    text: displayDiff,
    presentation: {
      kind: "edit",
      preview: "head-tail",
      notices: [],
      displayDiff,
    },
  }));

  const collapsed = conversation.render(100).join("\n");
  assert.match(collapsed, /\+ 54 diffAdded/u);
  assert.match(collapsed, /\+ 56 diffHunk/u);
  assert.match(collapsed, /\+103 diffAdded/u);
  assert.match(collapsed, /\+105 diffHunk/u);
  assert.match(collapsed, /context visual lines hidden · Ctrl\+O details/u);
  assert.doesNotMatch(collapsed, /old first block|old second block/u, "collapsed success must not fall back to edit arguments");
});



test("compaction summaries have a readable folded surface and expand explicitly", () => {
  const conversation = new DockConversation();
  conversation.applyHistory([
    historyRecord("compact-1", "runtime", [{ type: "text", text: "## Goal\n\nKeep the release safe.\n\n## Constraints\n\nDo not replay mutations.\n\nEND OF SUMMARY" }], { kind: "compaction_summary" }),
    historyRecord("assistant-after-summary", "assistant", [{ type: "tool_call", toolCallId: "later-tool", toolName: "read", args: { path: "/tmp/later" } }]),
    historyRecord("tool-after-summary", "tool", [{ type: "tool_result", toolCallId: "later-tool", toolName: "read", text: "later result", isError: false }]),
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
  ordinary.applyHistory([historyRecord("system-1", "system", [{ type: "text", text: "ordinary system text" }])], false);
  assert.equal(ordinary.toggleLatestDetailExpanded(), undefined);
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
  assert.equal(rendered[0], " ".repeat(24), "Pi-style user box reserves a full-width top padding row");
  assert.match(rendered[1] ?? "", /^ hello\[2J\s+$/u);
  assert.equal(rendered[2], " ".repeat(24), "Pi-style user box reserves a full-width bottom padding row");
  assert.match(rendered.join("\n"), /secret reasoning/);
});

// Card #336: a user shell command typed as `!` / `!!` in Work TUI shows as its own
// running row with streamed output and survives the Agent reply settling around it.
test("user shell commands stream output in their own row and outlive the reply that was running (card #336)", () => {
  assert.deepEqual(shellCommandInput("!git status"), { command: "git status", excludeFromContext: false });
  assert.deepEqual(shellCommandInput("!! ls -la "), { command: "ls -la", excludeFromContext: true });
  assert.equal(shellCommandInput("hello!"), undefined);

  const conversation = new DockConversation();
  conversation.applyReplay([
    event(1, "run.started", { operationId: "reply-1" }),
    event(2, "bash.started", { operationId: "sh-1", command: "printf 'a\\nb\\n'", excludeFromContext: true }),
    event(3, "bash.output", { operationId: "sh-1", delta: "a\n" }),
    event(4, "run.settled", { operationId: "reply-1", result: "succeeded" }),
  ], false);
  assert.deepEqual(conversation.snapshot(), [
    { kind: "tool", text: "!! running\nargs\nprintf 'a\\nb\\n'\nresult\na\n", complete: false },
  ], "the reply settling does not finish a shell command the user started");

  conversation.apply(event(5, "bash.output", { operationId: "sh-1", delta: "b\n" }));
  conversation.apply(event(6, "bash.completed", { operationId: "sh-1", exitCode: 0, cancelled: false, truncated: false }));
  assert.deepEqual(conversation.snapshot(), [
    { kind: "tool", text: "!! done\nargs\nprintf 'a\\nb\\n'\nresult\na\nb\n", complete: true },
  ]);
  assert.match(conversation.render(40).join("\n"), /✓ !! · printf 'a\\nb\\n'/u);

  conversation.apply(event(7, "bash.started", { operationId: "sh-2", command: "sleep 30", excludeFromContext: false }));
  conversation.apply(event(8, "bash.completed", { operationId: "sh-2", cancelled: true, truncated: true, fullOutputPath: "/tmp/pi-bash-1.log" }));
  const stopped = conversation.render(60).join("\n");
  assert.match(stopped, /× ! · sleep 30 · stopped/u);
  assert.match(stopped, /\/tmp\/pi-bash-1\.log/u, "the full-output path is shown so the user or Pi can read it on that machine");

  conversation.apply(event(9, "bash.started", { operationId: "sh-3", command: "false", excludeFromContext: false }));
  conversation.apply(event(10, "bash.completed", { operationId: "sh-3", exitCode: 1, cancelled: false, truncated: false }));
  assert.match(conversation.render(60).join("\n"), /× ! · false · exit 1/u);

  // Review follow-up: a long output must not push the full-output path past the display bound.
  conversation.apply(event(11, "bash.started", { operationId: "sh-4", command: "yes", excludeFromContext: true }));
  for (let index = 0; index < 3; index++) conversation.apply(event(12 + index, "bash.output", { operationId: "sh-4", delta: `${"y\n".repeat(2_000)}` }));
  conversation.apply(event(15, "bash.completed", { operationId: "sh-4", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/pi-bash-long.log" }));
  conversation.setToolsExpanded(true);
  assert.match(conversation.render(80).join("\n"), /\/tmp\/pi-bash-long\.log/u, "the path stays visible after a long output");

  // A window opened mid-command did not see the earlier output; it must not look empty.
  const late = new DockConversation();
  late.applyBootstrapReplay([event(20, "bash.started", { operationId: "sh-5", command: "make", excludeFromContext: true })]);
  late.apply(event(21, "bash.completed", { operationId: "sh-5", exitCode: 0, cancelled: false, truncated: false }));
  assert.match(late.snapshot()[0]?.text ?? "", /not shown; the run record has it/u);
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

test("long Pi edit diffs remain available and never fall back to raw edit arguments", () => {
  const conversation = new DockConversation();
  const sourceDiff = `-1 oldValue();\n+1 newValue();\n+2 ${"const next = value; ".repeat(1_000)}`;
  const projectedDiff = projectDisplayEditDiff(sourceDiff);
  assert.equal(projectedDiff, sourceDiff, "Dock does not add a second display truncation layer");
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
  conversation.toggleLatestToolExpanded();
  const expanded = conversation.render(80).join("\n");
  assert.doesNotMatch(expanded, /private old argument|private new argument/u);
});

test("collapsed tool rows identify common operations without exposing arbitrary payload fields", () => {
  const conversation = new DockConversation();
  const calls = [
    { name: "read", args: { path: "/workspace/sample-project/src/tui/conversation.ts", offset: 10, limit: 5 }, result: "source" },
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
    history.applyHistory([
      historyRecord(`history-${toolName}`, "tool", [{ type: "tool_result", toolCallId: `call-${toolName}`, toolName, text, isError: false, presentation: presentation as never }]),
    ], false);
    assert.deepEqual(history.render(100), live.render(100), `${toolName} live/history rendering diverged`);
    return live.render(100).join("\n");
  };

  const bashText = `${Array.from({ length: 30 }, (_, index) => `bash line ${index + 1}`).join("\n")}\n\n[Showing lines 71-100 of 100. Full output: /tmp/pi-bash-visible.log]`;
  const bash = renderCompleted("bash", bashText, {
    kind: "bash", preview: "tail", notices: [
      { code: "output_truncated", by: "lines", shown: 30, total: 100, limit: 30 },
      { code: "full_output_saved", path: "/tmp/pi-bash-visible.log" },
    ],
  });
  assert.match(bash, /bash line 30/u);
  assert.doesNotMatch(bash, /bash line 1\s*$/mu);
  assert.match(bash, /earlier visual lines · Ctrl\+O details/u);
  assert.match(bash, /truncated · showing 30 lines of 100/u);
  assert.match(bash, /full output saved · \/tmp\/pi-bash-visible\.log/u);

  const readText = `${Array.from({ length: 15 }, (_, index) => `read line ${index + 1}`).join("\n")}\n\n[Showing lines 1-15 of 40. Use offset=16 to continue.]`;
  const read = renderCompleted("read", readText, {
    kind: "read", preview: "head", notices: [{ code: "continue_with_offset", offset: 16 }],
  });
  assert.match(read, /read line 1/u);
  assert.doesNotMatch(read, /read line 15/u);
  assert.match(read, /continue with read offset=16/u);

  const grep = renderCompleted("grep", Array.from({ length: 20 }, (_, index) => `match ${index + 1}`).join("\n"), {
    kind: "grep", preview: "head", notices: [
      { code: "limit_reached", unit: "matches", limit: 100 },
      { code: "lines_truncated", maxChars: 500 },
    ],
  });
  assert.match(grep, /100 matches limit reached/u);
  assert.match(grep, /use read for full lines/u);

  const find = renderCompleted("find", "a.ts\nb.ts", {
    kind: "find", preview: "head", notices: [{ code: "limit_reached", unit: "results", limit: 1_000 }],
  });
  assert.match(find, /1,000 results limit reached/u);
  const ls = renderCompleted("ls", "a\nb", {
    kind: "ls", preview: "head", notices: [{ code: "limit_reached", unit: "entries", limit: 500 }],
  });
  assert.match(ls, /500 entries limit reached/u);

  const semanticUpdate = new DockConversation();
  semanticUpdate.apply(event(1, "tool.started", { toolCallId: "same-output", toolName: "find", args: { path: "." } }));
  semanticUpdate.apply(event(2, "tool.output_updated", {
    toolCallId: "same-output", text: "same projected text",
    presentation: { kind: "find", preview: "head", notices: [] },
  }));
  assert.doesNotMatch(semanticUpdate.render(100).join("\n"), /results limit reached/u);
  semanticUpdate.apply(event(3, "tool.output_updated", {
    toolCallId: "same-output", text: "same projected text",
    presentation: { kind: "find", preview: "head", notices: [{ code: "limit_reached", unit: "results", limit: 1_000 }] },
  }));
  assert.match(semanticUpdate.render(100).join("\n"), /1,000 results limit reached/u, "presentation-only updates are decision data");

});



test("generic tool previews summarize JSON without hiding bracketed text results", () => {
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

  const dockList = new DockConversation();
  dockList.apply(event(5, "tool.started", {
    toolCallId: "dock-list-preview",
    toolName: "dock_list",
    args: {},
  }));
  dockList.apply(event(6, "tool.completed", {
    toolCallId: "dock-list-preview",
    toolName: "dock_list",
    isError: false,
    text: "[Dock sibling list · live siblings]\n- Alu Work · active/idle",
  }));
  const dockListPreview = dockList.render(80).join("\n");
  assert.match(dockListPreview, /Dock sibling list · live siblings/u);
  assert.doesNotMatch(dockListPreview, /structured result truncated or unavailable/u);
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
  assert.deepEqual(conversation.toggleLatestToolExpanded(), { expanded: true, name: "bash" });
  assert.match(conversation.render(60).join("\n"), /expanded failure detail/);

  const longBashFailure = new DockConversation();
  longBashFailure.apply(event(3, "tool.started", { toolCallId: "long-bash-error", toolName: "bash", args: { command: "long-command" } }));
  longBashFailure.apply(event(4, "tool.completed", {
    toolCallId: "long-bash-error",
    toolName: "bash",
    isError: true,
    text: `${Array.from({ length: 30 }, (_, index) => `noisy output ${index + 1}`).join("\n")}\n\nCommand exited with code 7`,
    presentation: { kind: "bash", preview: "tail", notices: [] },
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

test("a codemode call lists the tools its script called while it runs and after the Work is reopened (card #350)", () => {
  const running = { toolName: "mcp__harbor__echo", argumentsJson: "{\"text\":\"lantern\"}", status: "running" } as const;
  const failed = { toolName: "mcp__harbor__fail", argumentsJson: "{}", status: "error", durationMs: 1_500, error: "harbor is closed" } as const;
  const live = new DockConversation();
  const code = "const echoed = await tools.mcp__harbor__echo({ text: 'lantern' });\nreturn echoed;";
  live.apply(event(1, "tool.started", { toolCallId: "script", toolName: "codemode", args: { code } }));
  live.apply(event(2, "tool.output_updated", { toolCallId: "script", text: "", nestedCalls: { calls: [running], complete: true } }));
  assert.match(live.render(120).join("\n"), /\u2026 mcp__harbor__echo \{"text":"lantern"\}/u);
  const nestedCalls = { calls: [{ ...running, status: "ok" as const, durationMs: 12 }, failed], complete: true };
  live.apply(event(3, "tool.completed", { toolCallId: "script", toolName: "codemode", isError: false, text: "Script completed\nOutput:\nharbor echoed lantern", nestedCalls }));

  const reopened = new DockConversation();
  reopened.applyHistory([
    historyRecord("a", "assistant", [{ type: "tool_call", toolCallId: "script", toolName: "codemode", args: { code } }]),
    historyRecord("t", "tool", [{ type: "tool_result", toolCallId: "script", toolName: "codemode", isError: false, text: "Script completed\nOutput:\nharbor echoed lantern", nestedCalls }]),
  ], false);
  for (const conversation of [live, reopened]) {
    const collapsed = conversation.render(120).join("\n");
    assert.match(collapsed, /\u2713 mcp__harbor__echo \{"text":"lantern"\} 12ms/u);
    assert.match(collapsed, /\u00d7 mcp__harbor__fail \{\} 1\.5s/u);
    assert.match(collapsed, /harbor echoed lantern/u);
    assert.doesNotMatch(collapsed, /harbor is closed/u, "errors wait for the expanded view");
    conversation.toggleLatestToolExpanded();
    const expanded = conversation.render(120).join("\n");
    assert.match(expanded, /script\s*\n\s*const echoed[^\n]*\n\s*return echoed;/u, "the script keeps its lines");
    assert.match(expanded, /mcp__harbor__fail[\s\S]*harbor is closed/u);
  }

  // Review of card #350: stopping the run while the script waits must not leave its call running.
  const stopped = new DockConversation();
  stopped.apply(event(1, "tool.started", { toolCallId: "script", toolName: "codemode", args: { code } }));
  stopped.apply(event(2, "tool.output_updated", { toolCallId: "script", text: "", nestedCalls: { calls: [running], complete: true } }));
  stopped.apply(event(3, "run.settled", { result: "aborted" }));
  const afterStop = stopped.render(120).join("\n");
  assert.match(afterStop, /\u2298 mcp__harbor__echo \{"text":"lantern"\} not finished/u);
  assert.doesNotMatch(afterStop, /\u2026 mcp__harbor__echo|too many/u);
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

test("compaction and session-change notices stay visible without queue transcript noise", () => {
  const conversation = new DockConversation();
  conversation.apply(event(1, "queue.changed", { steering: 1, followUp: 2, total: 3 }));
  conversation.apply(event(2, "queue.changed", { steering: 0, followUp: 1, total: 1 }));
  conversation.apply(event(3, "compaction.started", { reason: "threshold" }));
  conversation.apply(event(4, "compaction.completed", { reason: "threshold", aborted: false, willRetry: false }));
  conversation.apply(event(5, "session.replaced", { reason: "reload", runtimeGeneration: 2, cwd: "/tmp/reloaded", piSessionId: "pi-2" }));
  conversation.addNotice("Connection lost. No command was resent.", true);

  const projected = conversation.snapshot();
  assert.equal(projected.filter((entry) => entry.text.startsWith("Queue ·")).length, 0);
  assert.ok(projected.some((entry) => /Compaction completed/.test(entry.text)));
  assert.ok(projected.some((entry) => /Session resources reloaded/.test(entry.text)));
  assert.match(projected.at(-1)?.text ?? "", /No command was resent/);
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
  tray.apply(event(5, "message.queued", {
    queueItemId: "attachment-1", operationId: "op-attachment", delivery: "followUp", text: "",
    attachments: [{
      fileId: "123e4567-e89b-42d3-a456-426614174000", name: "notes final.txt", sizeBytes: 2_048,
      sha256: "a".repeat(64), storedAt: "2026-08-16T00:00:00.000Z",
    }],
    acceptedAt: "2026-07-14T00:00:03.000Z",
  }));
  assert.match(tray.render(80).join("\n"), /attachment: notes final\.txt \(2\.0 KiB\)/u);
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
});
