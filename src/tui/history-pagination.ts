import type {
  DockEvent,
  HistoryEntryDto,
  InstanceSnapshot,
} from "../core/instance-dto.js";

export const HISTORY_PAGE_SIZE = 200;

export interface FullHistoryPage {
  historyRevision: number;
  entries: HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
  instance: InstanceSnapshot;
}

export interface FullHistoryResult {
  entries: HistoryEntryDto[];
}

/** Drain a reverse-paged branch into one oldest-to-newest, gap-free projection. */
export async function drainFullHistory(
  instanceId: string,
  generation: number,
  historyRevision: number,
  seed: readonly HistoryEntryDto[],
  seedHasEarlier: boolean,
  load: (beforeEntryId?: string) => Promise<FullHistoryPage>,
): Promise<FullHistoryResult> {
  let newest = deduplicate(seed);
  let hasEarlier = seedHasEarlier;
  let before = newest[0]?.entryId;
  if (hasEarlier && !before) throw new Error("History page is incomplete without a continuation entry");

  const seenEntryIds = new Set(newest.map((entry) => entry.entryId));
  const newestFirstSegments: HistoryEntryDto[][] = [newest];
  const seenCursors = new Set<string>();
  while (hasEarlier) {
    if (!before || seenCursors.has(before)) throw new Error("History cursor did not advance");
    seenCursors.add(before);
    const page = await load(before);
    assertPageIdentity(page, instanceId, generation, historyRevision);
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

  return { entries: newestFirstSegments.reverse().flat() };
}

/**
 * Join the Host's active bootstrap with events which arrived while older
 * history pages were loading. The bootstrap contains only frames not yet
 * released into persisted history, so overlap is removed solely by event
 * identity; conversation content is never compared.
 */
export function reconcileFlowingEvents(
  bootstrapEvents: readonly DockEvent[],
  bufferedEvents: readonly DockEvent[],
): DockEvent[] {
  const candidates = new Map<string, DockEvent>();
  for (const event of bootstrapEvents) candidates.set(eventKey(event), event);
  for (const event of bufferedEvents) candidates.set(eventKey(event), event);
  return [...candidates.values()].sort((left, right) => (
    left.runtimeGeneration - right.runtimeGeneration || left.sequence - right.sequence
  ));
}

function assertPageIdentity(page: FullHistoryPage, instanceId: string, generation: number, historyRevision: number): void {
  if (page.instance.id !== instanceId || page.instance.runtimeGeneration !== generation) {
    throw new Error("Session changed while history was loading");
  }
  if (page.historyRevision !== historyRevision) throw new Error("History changed while history was loading");
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
