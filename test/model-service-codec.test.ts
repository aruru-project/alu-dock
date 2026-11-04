import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

import { PartialDecoder, PartialEncoder } from "../src/model-service/protocol.js";

// A provider keeps changing one reply object and every in-progress event points at it. Sent as is,
// each delta would repeat the whole reply; a long tool call reached hundreds of megabytes on the wire.
test("a reply that grows in place arrives as the same reply, sending only what changed", () => {
  const partial = {
    role: "assistant", api: "openai-completions", provider: "p", model: "m", timestamp: 1, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [] as Array<Record<string, unknown>>,
  } as unknown as AssistantMessage & { content: Array<Record<string, unknown>>; responseId?: string };
  const events: Array<() => AssistantMessageEvent> = [
    () => ({ type: "start", partial }),
    () => { partial.content.push({ type: "text", text: "" }); return { type: "text_start", contentIndex: 0, partial }; },
    ...Array.from({ length: 200 }, (_, index) => () => {
      (partial.content[0] as { text: string }).text += `part ${index} `;
      return { type: "text_delta", contentIndex: 0, delta: `part ${index} `, partial } as AssistantMessageEvent;
    }),
    () => { partial.content.push({ type: "toolCall", id: "c", name: "write", arguments: {} }); partial.responseId = "r1"; return { type: "toolcall_start", contentIndex: 1, partial } as AssistantMessageEvent; },
    // Tool arguments are parsed again on each delta: a new object whose values grow or change type.
    () => { partial.content[1]!.arguments = { path: "/a", count: 1 }; return { type: "toolcall_delta", contentIndex: 1, delta: "x", partial } as AssistantMessageEvent; },
    () => { partial.content[1]!.arguments = { path: "/abc", count: 12, flag: true }; return { type: "toolcall_delta", contentIndex: 1, delta: "x", partial } as AssistantMessageEvent; },
    () => { delete partial.responseId; partial.content[0] = { type: "text", text: "rewritten" }; return { type: "text_end", contentIndex: 0, content: "rewritten", partial } as AssistantMessageEvent; },
  ];
  const encoder = new PartialEncoder();
  const decoder = new PartialDecoder();
  let received: AssistantMessage | undefined;
  let wireBytes = 0;
  for (const next of events) {
    const event = next();
    const wire = JSON.parse(JSON.stringify(encoder.encode(event)));
    wireBytes += JSON.stringify(wire).length;
    const decoded = decoder.decode(wire) as AssistantMessageEvent & { partial: AssistantMessage };
    assert.deepEqual(decoded.partial, JSON.parse(JSON.stringify(partial)));
    if (received) assert.strictEqual(decoded.partial, received, "Every event points at the one reply, as locally");
    received = decoded.partial;
  }
  assert.ok(wireBytes < 40_000, `Only changes cross the wire (${wireBytes} bytes)`);
});
