export type KnownCompactionFeedback = "nothing_to_compact" | "already_compacted";

/**
 * Recognize only Pi's canonical, definitive no-effect completion messages.
 * Keep this anchored: arbitrary provider failures containing similar words are
 * real errors and must remain visible.
 */
export function knownCompactionFeedback(error: string | undefined): KnownCompactionFeedback | undefined {
  if (!error) return undefined;
  const canonical = error.match(/^Compaction failed: (Nothing to compact(?: \(session too small\))?|Already compacted[.!]?)$/iu)?.[1];
  if (!canonical) return undefined;
  return /^Already compacted/iu.test(canonical) ? "already_compacted" : "nothing_to_compact";
}
