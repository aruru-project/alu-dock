import assert from "node:assert/strict";
import test from "node:test";

import type { PendingMessageDto } from "../src/core/instance-dto.js";
import { prependRestoredQueueText } from "../src/tui/queue-restoration.js";

function queued(text: string): PendingMessageDto {
  return {
    queueItemId: `queue-${text}`,
    operationId: `operation-${text}`,
    delivery: "steer",
    text,
    acceptedAt: "2026-07-16T00:00:00.000Z",
  };
}

test("queue restoration prepends the authoritative batch without replacing the current draft", () => {
  assert.equal(
    prependRestoredQueueText("current draft", [queued("steer A"), queued("follow-up B")]),
    "steer A\n\nfollow-up B\n\ncurrent draft",
  );
  assert.equal(
    prependRestoredQueueText("", [queued("steer A"), queued("follow-up B")]),
    "steer A\n\nfollow-up B",
  );
});

test("empty or whitespace-bearing queue restoration preserves text exactly", () => {
  assert.equal(prependRestoredQueueText("current draft", []), "current draft");
  assert.equal(prependRestoredQueueText("  draft\n", [queued("  queued\n")]), "  queued\n\n\n  draft\n");
});
