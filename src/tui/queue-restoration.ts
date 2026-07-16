import type { PendingMessageDto } from "../core/managed-instance.js";

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
