import { performance } from "node:perf_hooks";

import type { DockEvent, HistoryEntryDto } from "../src/core/instance-dto.js";
import { DockConversation } from "../src/tui/conversation.js";

const WIDTH = 220;
const UPDATES = 120;

function event(sequence: number, type: DockEvent["type"], data: Record<string, unknown>): DockEvent {
  return {
    scope: "instance",
    sequence,
    instanceId: "render-benchmark",
    runtimeGeneration: 1,
    occurredAt: "2026-07-16T00:00:00.000Z",
    type,
    data,
  } as DockEvent;
}

const markdown = [
  "## Completed capability slice",
  "",
  "This is a representative assistant paragraph with `inline code`, **bold text**, and enough words to wrap across a wide SSH terminal. ".repeat(5),
  "",
  "- deterministic projection",
  "- closed protocol state",
  "- replacement-safe lifecycle",
  "",
  "```ts",
  "const state = { lifecycle: \"active\", execution: \"running\" };",
  "```",
].join("\n");

function longConversation(): DockConversation {
  const conversation = new DockConversation();
  const history: HistoryEntryDto[] = [];
  for (let index = 0; index < 100; index += 1) {
    history.push({
      entryId: `user-${index}`,
      role: "user",
      content: [{ type: "text", text: `request ${index}: verify the current implementation boundary` }],
    });
    history.push({
      entryId: `assistant-${index}`,
      role: "assistant",
      content: [
        { type: "thinking", text: `Checking invariant ${index}` },
        { type: "text", text: markdown },
      ],
    });
  }
  conversation.applyHistory(history, true);
  conversation.render(WIDTH);
  return conversation;
}

function measure(name: string, run: () => void): void {
  (globalThis as { gc?: () => void }).gc?.();
  const beforeCpu = process.cpuUsage();
  const before = performance.now();
  run();
  const wallMs = performance.now() - before;
  const cpu = process.cpuUsage(beforeCpu);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  process.stdout.write(`${JSON.stringify({
    name,
    updates: UPDATES,
    wallMs: Number(wallMs.toFixed(2)),
    cpuMs: Number(cpuMs.toFixed(2)),
    cpuMsPerUpdate: Number((cpuMs / UPDATES).toFixed(3)),
  })}\n`);
}

measure("text-delta apply+render", () => {
  const conversation = longConversation();
  for (let index = 0; index < UPDATES; index += 1) {
    conversation.apply(event(index + 1, "message.delta", {
      messageId: "assistant-live",
      block: "text",
      delta: ` token-${index}`,
    }));
    conversation.render(WIDTH);
  }
});

measure("tool-args apply+render", () => {
  const conversation = longConversation();
  conversation.apply(event(1, "tool.started", { toolCallId: "tool-1", toolName: "edit", args: {} }));
  conversation.render(WIDTH);
  for (let index = 0; index < UPDATES; index += 1) {
    conversation.apply(event(index + 2, "tool.args_updated", {
      toolCallId: "tool-1",
      args: { path: "/tmp/example.ts", index, replacement: "x".repeat(3_500) },
    }));
    conversation.render(WIDTH);
  }
});

measure("tool-output apply+render", () => {
  const conversation = longConversation();
  conversation.apply(event(1, "tool.started", {
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "build" },
  }));
  conversation.render(WIDTH);
  for (let index = 0; index < UPDATES; index += 1) {
    conversation.apply(event(index + 2, "tool.output_updated", {
      toolCallId: "tool-1",
      text: `${"output line\n".repeat(650)}${index}`,
    }));
    conversation.render(WIDTH);
  }
});
