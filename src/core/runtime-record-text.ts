import type { RecordUsageDto, SystemPromptBlockDto, SystemPromptChangeDto } from "./instance-dto.js";

/** The sections and tools a system prompt record changes, grouped the way Pi records them: a short prefix for one line, a title for the detail. */
function systemPromptChangeGroups(change: SystemPromptChangeDto): Array<{ prefix: string; title: string; names: string[] }> {
  // Pi declares a tool whose definition changed as removed and added again.
  const changedTools = change.toolsAdded.filter((name) => change.toolsRemoved.includes(name));
  return [
    { prefix: "sections ", title: "Sections set", names: change.sections },
    { prefix: "removed sections ", title: "Sections removed", names: change.removedSections },
    { prefix: "tools +", title: "Tools added", names: change.toolsAdded.filter((name) => !changedTools.includes(name)) },
    { prefix: "tools −", title: "Tools removed", names: change.toolsRemoved.filter((name) => !changedTools.includes(name)) },
    { prefix: "tools changed ", title: "Tools changed", names: changedTools },
  ].filter((group) => group.names.length > 0);
}

/** One line naming the prompt sections and tools a system prompt record changes; long lists are cut short. */
export function systemPromptChangeText(change: SystemPromptChangeDto): string {
  const list = (names: readonly string[]): string => names.length <= 6 ? names.join(", ") : `${names.slice(0, 6).join(", ")} +${names.length - 6} more`;
  const parts = systemPromptChangeGroups(change).map((group) => `${group.prefix}${list(group.names)}`);
  return parts.length === 0 ? "System prompt update" : `System prompt: ${parts.join(" · ")}`;
}

/** Every section and tool the record changes, one group per line, nothing cut short. */
export function systemPromptChangeDetail(change: SystemPromptChangeDto): string {
  const groups = systemPromptChangeGroups(change);
  if (groups.length === 0) return "This record names no section or tool.";
  return groups.map((group) => `${group.title} (${group.names.length}): ${group.names.join(", ")}`).join("\n");
}

/** What one text block of a system prompt record is, as a heading for that text. */
export function systemPromptBlockLabel(block: SystemPromptBlockDto | undefined): string {
  if (block === undefined) return "Text";
  if (block.kind === "instructions") return "Instructions";
  return block.kind === "section" ? `Section ${block.name}` : `Tool ${block.name}`;
}

/** One line for a paid request recorded outside the conversation, such as cache warming. */
export function usageRecordText(usage: RecordUsageDto, provider: string, modelId: string): string {
  const label = usage.kind === "cache_warm" ? "Cache warmed" : `Usage: ${usage.kind}`;
  // Dollars as Pi's transcript shows them: at least three decimals, up to six.
  const cost = `$${usage.cost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/u, "$1")}`;
  return `${label}${usage.note ? ` (${usage.note})` : ""} · ${cost} · ${provider}/${modelId}`;
}
