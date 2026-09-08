import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { AgentWorkerState } from "../src/core/agent-worker.js";
import { projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";
import { OrderedWorkerSender, WorkerFrameReceiver, type WorkerFrame } from "../src/pi/worker-protocol.js";

// #265, 2026-09-08: a 5,767-character Cloudflare 520 page caused Dock to
// terminate a real Worker while Pi was reporting an ordinary upstream retry.
// Synthetic HTML keeps the shape/approximate size without the user's IP/Ray ID.
const errorPage = `<html><head><style>${"/* upstream error page styling */\n".repeat(165)}</style></head>
<body>520: Web server is returning an unknown error</body></html>`;
const state: AgentWorkerState = {
  sessionId: "error-fixture", sessionFile: "/tmp/error-fixture.jsonl",
  isStreaming: false, isCompacting: false,
  modelState: { model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", availableThinkingLevels: ["off"] },
  metrics: {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
  },
  extensionCommands: [],
};

async function crossWorkerBoundary(event: AgentSessionEvent) {
  const frames: WorkerFrame[] = [];
  const sender = new OrderedWorkerSender({
    hostEpoch: "error-host", instanceId: "error-work", runtimeGeneration: 1, workerIncarnation: "error-worker",
  }, (frame, callback) => { frames.push(frame); queueMicrotask(() => callback(null)); return true; });
  for (const projected of projectAgentSessionEvents(event)) {
    await sender.sendEnvelope({ kind: "event", event: projected, state: structuredClone(state) });
  }
  const receiver = new WorkerFrameReceiver(() => true);
  return frames.flatMap((frame) => {
    const envelope = receiver.accept(frame);
    return envelope?.kind === "event" ? [envelope.event] : [];
  });
}

test("provider failures remain reportable during retries and final failure", async (context) => {
  const cases: Array<{ name: string; event: AgentSessionEvent; field: "errorMessage" | "finalError" }> = [
    { name: "a long upstream error allows ordinary request retry", field: "errorMessage", event: {
      type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: errorPage,
    } },
    { name: "a long upstream error allows summary retry", field: "errorMessage", event: {
      type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: errorPage,
    } },
    { name: "an exhausted request reports its long final error", field: "finalError", event: {
      type: "auto_retry_end", success: false, attempt: 3, finalError: errorPage,
    } },
    { name: "a multiline rate-limit error remains readable", field: "errorMessage", event: {
      type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "429 Too Many Requests\nRetry later",
    } },
  ];
  for (const scenario of cases) await context.test(scenario.name, async () => {
    const events = await crossWorkerBoundary(scenario.event);
    const reported = events.find((event) => event.type === scenario.event.type);
    assert.ok(reported, "the lifecycle error must reach Host handling, not fail transport parsing");
    const text = reported[scenario.field];
    assert.ok(typeof text === "string" && text.length > 0,
      "keep useful failure evidence instead of dropping the error");
    if (scenario.name.startsWith("a multiline")) assert.equal(reported.errorMessage, "429 Too Many Requests\nRetry later");
  });
});
