import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { ListResult } from "./protocol.js";

/** The single serialized-byte pagination algorithm for local and merged instance lists. */
export function boundedInstanceListPage(input: {
  selected: readonly InstanceSnapshot[];
  selector: "actionable" | "all";
  revision: number;
  offset: number;
  limit: number;
  hiddenStopped: number;
  maxBytes: number;
}): ListResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("Catalog list limit must be a positive safe integer");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4_096) throw new Error("Catalog list byte limit must be a bounded positive safe integer");
  const instances: InstanceSnapshot[] = [];
  // Reserve space for the result keys and page metadata. The Host separately
  // keeps the complete response envelope below the control line cap.
  const snapshotBudget = input.maxBytes - 4_096;
  let snapshotsBytes = 2;
  for (const candidate of input.selected.slice(input.offset, input.offset + input.limit)) {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const separatorBytes = instances.length === 0 ? 0 : 1;
    if (snapshotsBytes + separatorBytes + candidateBytes > snapshotBudget) {
      if (instances.length === 0) throw new Error(`Catalog instance snapshot exceeds the bounded list result: ${candidate.id}`);
      break;
    }
    instances.push(candidate);
    snapshotsBytes += separatorBytes + candidateBytes;
  }
  const nextOffset = input.offset + instances.length;
  const result: ListResult = {
    instances,
    page: {
      revision: input.revision,
      total: input.selected.length,
      hiddenStopped: input.selector === "all" ? 0 : input.hiddenStopped,
      ...(nextOffset < input.selected.length
        ? { nextCursor: { revision: input.revision, offset: nextOffset, selector: input.selector } }
        : {}),
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > input.maxBytes) throw new Error("Catalog list result exceeded its serialized byte bound");
  return result;
}
