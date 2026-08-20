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
): { draft: string; notice: string } {
  return {
    draft: prependSubmissionRecoveryText(currentDraft, message, delivery),
    notice: effectUnknown
      ? "This message may already have been sent. Its text is back in the editor; check the conversation before deciding whether to send it again."
      : "The message could not be sent. Its text is back in the editor so you can try again.",
  };
}
