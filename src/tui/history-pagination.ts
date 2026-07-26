import type {
  DockEvent,
  HistoryEntryDto,
  InstanceSnapshot,
} from "../core/instance-dto.js";
import { reconcileConversationEventsWithHistory } from "../core/managed-instance.js";

export const HISTORY_PAGE_SIZE = 200;

export interface FullHistoryPage {
  entries: HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
  instance: InstanceSnapshot;
}

export interface FullHistoryResult {
  entries: HistoryEntryDto[];
  /** Present only when an empty seed required a latest-page bootstrap. */
  bootstrapBoundary?: InstanceSnapshot;
}

/** Drain a reverse-paged branch into one oldest-to-newest, gap-free projection. */
export async function drainFullHistory(
  instanceId: string,
  generation: number,
  seed: readonly HistoryEntryDto[],
  seedHasEarlier: boolean,
  load: (beforeEntryId?: string) => Promise<FullHistoryPage>,
): Promise<FullHistoryResult> {
  let newest = deduplicate(seed);
  let hasEarlier = seedHasEarlier;
  let before = newest[0]?.entryId;
  let bootstrapBoundary: InstanceSnapshot | undefined;

  // Only an empty seed may establish a newer live-event boundary. Pages loaded
  // before a nonempty attach/projection tail are historical data and must not
  // advance that tail's original reconciliation cursor.
  if (hasEarlier && !before) {
    const latest = await load(undefined);
    assertPageIdentity(latest, instanceId, generation);
    newest = deduplicate(latest.entries);
    hasEarlier = latest.hasEarlier;
    before = latest.nextBeforeEntryId ?? newest[0]?.entryId;
    bootstrapBoundary = latest.instance;
  }

  const seenEntryIds = new Set(newest.map((entry) => entry.entryId));
  const newestFirstSegments: HistoryEntryDto[][] = [newest];
  const seenCursors = new Set<string>();
  while (hasEarlier) {
    if (!before || seenCursors.has(before)) throw new Error("History cursor did not advance");
    seenCursors.add(before);
    const page = await load(before);
    assertPageIdentity(page, instanceId, generation);
    const older = deduplicate(page.entries).filter((entry) => {
      if (seenEntryIds.has(entry.entryId)) return false;
      seenEntryIds.add(entry.entryId);
      return true;
    });
    newestFirstSegments.push(older);
    hasEarlier = page.hasEarlier;
    const next = page.nextBeforeEntryId ?? page.entries[0]?.entryId;
    if (hasEarlier && (!next || next === before || seenCursors.has(next))) {
      throw new Error("History cursor did not advance");
    }
    before = next;
  }

  return {
    entries: newestFirstSegments.reverse().flat(),
    ...(bootstrapBoundary === undefined ? {} : { bootstrapBoundary }),
  };
}

/**
 * Merge a coherent attach bootstrap with events observed while older history
 * pages were loading. Persisted message/tool frames are removed by content
 * identity; unresolved frames and non-durable live feedback remain exactly once.
 */
export function reconcileFlowingEvents(
  history: readonly HistoryEntryDto[],
  bootstrapEvents: readonly DockEvent[],
  bufferedEvents: readonly DockEvent[],
): DockEvent[] {
  const candidates = new Map<string, DockEvent>();
  for (const event of bootstrapEvents) {
    if (isConversationFrame(event)) candidates.set(eventKey(event), event);
  }
  for (const event of bufferedEvents) candidates.set(eventKey(event), event);
  const ordered = [...candidates.values()].sort((left, right) => (
    left.runtimeGeneration - right.runtimeGeneration || left.sequence - right.sequence
  ));
  return reconcileConversationEventsWithHistory(ordered, history, true);
}

function assertPageIdentity(page: FullHistoryPage, instanceId: string, generation: number): void {
  if (page.instance.id !== instanceId || page.instance.runtimeGeneration !== generation) {
    throw new Error("Session changed while history was loading");
  }
}

function deduplicate(entries: readonly HistoryEntryDto[]): HistoryEntryDto[] {
  const seen = new Set<string>();
  const result: HistoryEntryDto[] = [];
  for (const entry of entries) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    result.push(entry);
  }
  return result;
}

function eventKey(event: DockEvent): string {
  return `${event.runtimeGeneration}:${event.sequence}`;
}

function isConversationFrame(event: DockEvent): boolean {
  return event.type === "message.submitted"
    || event.type === "message.delta"
    || event.type === "message.completed"
    || event.type === "tool.started"
    || event.type === "tool.args_updated"
    || event.type === "tool.output_updated"
    || event.type === "tool.completed";
}
