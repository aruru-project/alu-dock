import type { ContentBlockDto, HistoryEntryDto } from "./instance-dto.js";

/** Pagination needs immutable tool identities, not cached message bodies. */
type SemanticHistoryEntry = Pick<HistoryEntryDto, "source"> & {
  content: readonly (
    | { type: "tool_call" | "tool_result"; toolCallId: string }
    | { type: Exclude<ContentBlockDto["type"], "tool_call" | "tool_result"> }
  )[];
};

export interface SemanticHistoryRange {
  start: number;
  end: number;
}

export interface SemanticHistorySlice extends SemanticHistoryRange {
  hasEarlier: boolean;
}

/**
 * Return the smallest contiguous record ranges that keep every persisted
 * assistant tool call together with every matching persisted tool result.
 */
export function semanticHistoryRanges(entries: readonly SemanticHistoryEntry[]): SemanticHistoryRange[] {
  const ownerByToolCallId = new Map<string, number>();
  const toolGroupEndByOwner = new Map<number, number>();

  for (const [index, entry] of entries.entries()) {
    if (entry.source === "assistant") {
      for (const block of entry.content) {
        if (block.type !== "tool_call") continue;
        ownerByToolCallId.set(block.toolCallId, index);
        toolGroupEndByOwner.set(index, Math.max(toolGroupEndByOwner.get(index) ?? 0, index + 1));
      }
    }

    for (const block of entry.content) {
      if (block.type !== "tool_result") continue;
      const owner = ownerByToolCallId.get(block.toolCallId);
      // A compaction or imported session can legitimately omit the historical
      // owner. That result is not split by this page and remains its own unit.
      if (owner === undefined) continue;
      toolGroupEndByOwner.set(owner, Math.max(toolGroupEndByOwner.get(owner) ?? owner + 1, index + 1));
    }
  }

  const toolRanges = [...toolGroupEndByOwner]
    .map(([start, end]) => ({ start, end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedToolRanges: SemanticHistoryRange[] = [];
  for (const range of toolRanges) {
    const previous = mergedToolRanges.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else mergedToolRanges.push({ ...range });
  }

  const ranges: SemanticHistoryRange[] = [];
  let index = 0;
  let toolIndex = 0;
  while (index < entries.length) {
    const toolRange = mergedToolRanges[toolIndex];
    if (toolRange?.start === index) {
      ranges.push(toolRange);
      index = toolRange.end;
      toolIndex += 1;
      continue;
    }
    ranges.push({ start: index, end: index + 1 });
    index += 1;
  }
  return ranges;
}

/** Select a reverse-history page without cutting any semantic range. */
export function sliceSemanticHistory(
  entries: readonly SemanticHistoryEntry[],
  requestedEnd: number,
  requestedLimit: number,
): SemanticHistorySlice {
  const ranges = semanticHistoryRanges(entries);
  let end = Math.max(0, Math.min(entries.length, Math.floor(requestedEnd)));
  const containingEnd = ranges.find((range) => range.start < end && end < range.end);
  if (containingEnd) end = containingEnd.start;
  if (end === 0) return { start: 0, end: 0, hasEarlier: false };

  const limit = Math.max(1, Math.floor(requestedLimit));
  const lastRangeIndex = ranges.findLastIndex((range) => range.end <= end);
  if (lastRangeIndex < 0) return { start: 0, end: 0, hasEarlier: false };
  let start = ranges[lastRangeIndex]!.start;
  for (let index = lastRangeIndex - 1; index >= 0; index -= 1) {
    const candidate = ranges[index]!;
    if (end - candidate.start > limit) break;
    start = candidate.start;
  }
  return { start, end, hasEarlier: start > 0 };
}

/** Remove exactly one complete oldest semantic range from an existing page. */
export function dropOldestSemanticHistoryRange<T extends HistoryEntryDto>(entries: readonly T[]): T[] {
  if (entries.length === 0) return [];
  const first = semanticHistoryRanges(entries)[0];
  return first === undefined ? [] : entries.slice(first.end);
}

/** Content that remains useful after its readable payload is removed. */
export function slimSemanticHistoryBlock(block: ContentBlockDto): ContentBlockDto | undefined {
  if (block.type === "tool_result") {
    const { presentation, nestedCalls, ...identity } = block;
    if (block.text.length === 0 && presentation === undefined && nestedCalls === undefined) return block;
    return {
      ...identity,
      text: "",
      omittedFields: [...new Set([
        ...(block.omittedFields ?? []),
        ...(block.text.length === 0 ? [] : ["/content"]),
        ...(presentation === undefined ? [] : ["/presentation"]),
        ...(nestedCalls === undefined ? [] : ["/nestedCalls"]),
      ])],
    };
  }
  if (block.type === "tool_call") {
    if (Object.keys(block.args).length === 0) return block;
    return { ...block, args: {}, omittedFields: [...new Set([...(block.omittedFields ?? []), "/arguments"])] };
  }
  if (block.type === "image") return block;
  return undefined;
}

/** Keep record and tool identities while removing content available by continuation. */
export function slimSemanticHistoryEntry(entry: HistoryEntryDto): HistoryEntryDto {
  const content = entry.content.flatMap((block) => {
    const identity = slimSemanticHistoryBlock(block);
    return identity === undefined ? [] : [identity];
  });
  const { metadata: _metadata, ...slimmed } = entry;
  return {
    ...slimmed,
    content,
    ...(entry.metadata === undefined ? {} : { metadataOmittedFields: [...new Set([...(entry.metadataOmittedFields ?? []), "/"])] }),
  };
}
