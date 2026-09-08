import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { AgentWorkerState } from "../src/core/agent-worker.js";
import { projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";
import { OrderedWorkerSender, WorkerFrameReceiver, type WorkerFrame } from "../src/pi/worker-protocol.js";

import { PROVIDER_ERROR_HTML as errorPage } from "./support/provider-error-fixture.js";
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
    // The Worker entry fills checkpoint markers with history; this check concerns error events.
    if (projected.type === "conversation_checkpoint") continue;
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
    { name: "a compaction failure keeps the full diagnostic", field: "errorMessage", event: {
      type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: errorPage,
    } },
    { name: "a multiline rate-limit error remains readable", field: "errorMessage", event: {
      type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "429 Too Many Requests\nRetry later",
    } },
  ];
  for (const scenario of cases) await context.test(scenario.name, async () => {
    const events = await crossWorkerBoundary(scenario.event);
    const reported = events.find((event) => event.type === scenario.event.type);
    assert.ok(reported, "the lifecycle error must reach Host handling, not fail transport parsing");
    assert.equal(reported[scenario.field], (scenario.event as unknown as Record<string, unknown>)[scenario.field],
      "the full diagnostic, including its tail, must survive the boundary");
  });
});
