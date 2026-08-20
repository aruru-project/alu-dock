import assert from "node:assert/strict";
import test from "node:test";

import type { PendingMessageDto } from "../src/core/instance-dto.js";
import { prependRestoredQueueText, prependSubmissionRecoveryText, submissionRecovery } from "../src/tui/queue-restoration.js";

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

test("failed or uncertain submission recovery preserves delivery intent and concurrent draft text", () => {
  assert.equal(prependSubmissionRecoveryText("new draft", "ordinary", "auto"), "ordinary\n\nnew draft");
  assert.equal(prependSubmissionRecoveryText("", "later", "followUp"), "/follow later");
  assert.equal(prependSubmissionRecoveryText("draft", "redirect", "steer"), "/steer redirect\n\ndraft");
  assert.equal(prependSubmissionRecoveryText("", "fresh", "prompt"), "fresh");

  const uncertain = submissionRecovery("draft", "uncertain", "auto", true);
  assert.equal(uncertain.draft, "uncertain\n\ndraft");
  assert.match(uncertain.notice, /may already have been sent.*back in the editor/su);

  const rejected = submissionRecovery("", "rejected", "followUp", false);
  assert.equal(rejected.draft, "/follow rejected");
  assert.match(rejected.notice, /could not be sent.*back in the editor/su);
});
