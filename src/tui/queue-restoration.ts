import type { DeliveryMode, PendingMessageDto } from "../core/managed-instance.js";

/**
 * Pi consumes steering messages before follow-ups. The Host receipt already
 * carries that authoritative order; restore it as one block before whatever
 * the user typed while the dequeue request was in flight.
 */
export function prependRestoredQueueText(
  currentDraft: string,
  restored: readonly Pick<PendingMessageDto, "text">[],
): string {
  if (restored.length === 0) return currentDraft;
  const queued = restored.map((message) => message.text).join("\n\n");
  return currentDraft.length > 0 ? `${queued}\n\n${currentDraft}` : queued;
}

/** Preserve the only local copy after definite rejection or effect ambiguity. */
export function prependSubmissionRecoveryText(
  currentDraft: string,
  message: string,
  delivery: DeliveryMode,
): string {
  const recovered = delivery === "followUp"
    ? `/follow ${message}`
    : delivery === "steer"
      ? `/steer ${message}`
      : message;
  return currentDraft.length > 0 ? `${recovered}\n\n${currentDraft}` : recovered;
}

export function submissionRecovery(
  currentDraft: string,
  message: string,
  delivery: DeliveryMode,
  effectUnknown: boolean,
  operationId: string,
): { draft: string; notice: string } {
  return {
    draft: prependSubmissionRecoveryText(currentDraft, message, delivery),
    notice: effectUnknown
      ? `Submission outcome is uncertain for operation ${operationId}. The text was restored locally; inspect current session/queue state before any manual resend.`
      : "Submission was not admitted; its text was restored to the editor.",
  };
}
