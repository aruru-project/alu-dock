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

  assert.deepEqual(submissionRecovery("draft", "uncertain", "auto", true, "operation-123"), {
    draft: "uncertain\n\ndraft",
    notice: "Submission outcome is uncertain for operation operation-123. The text was restored locally; inspect current session/queue state before any manual resend.",
  });
  assert.deepEqual(submissionRecovery("", "rejected", "followUp", false, "operation-456"), {
    draft: "/follow rejected",
    notice: "Submission was not admitted; its text was restored to the editor.",
  });
});
