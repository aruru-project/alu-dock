import type { RecordUsageDto, SystemPromptChangeDto } from "./instance-dto.js";

/** One line naming the prompt sections and tools a system prompt record changes. */
export function systemPromptChangeText(change: SystemPromptChangeDto): string {
  const list = (names: readonly string[]): string => names.length <= 6 ? names.join(", ") : `${names.slice(0, 6).join(", ")} +${names.length - 6} more`;
  const named = (label: string, names: readonly string[]): string => names.length > 0 ? `${label}${list(names)}` : "";
  // Pi declares a tool whose definition changed as removed and added again.
  const changedTools = change.toolsAdded.filter((name) => change.toolsRemoved.includes(name));
  const parts = [
    named("sections ", change.sections),
    named("removed sections ", change.removedSections),
    named("tools +", change.toolsAdded.filter((name) => !changedTools.includes(name))),
    named("tools −", change.toolsRemoved.filter((name) => !changedTools.includes(name))),
    named("tools changed ", changedTools),
  ].filter((part) => part.length > 0);
  return parts.length === 0 ? "System prompt update" : `System prompt: ${parts.join(" · ")}`;
}

/** One line for a paid request recorded outside the conversation, such as cache warming. */
export function usageRecordText(usage: RecordUsageDto, provider: string, modelId: string): string {
  const label = usage.kind === "cache_warm" ? "Cache warmed" : `Usage: ${usage.kind}`;
  // Dollars as Pi's transcript shows them: at least three decimals, up to six.
  const cost = `$${usage.cost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/u, "$1")}`;
  return `${label}${usage.note ? ` (${usage.note})` : ""} · ${cost} · ${provider}/${modelId}`;
}
