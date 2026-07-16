import type { HistoryEntryDto, HistoryPageDto } from "../core/instance-dto.js";

export const HISTORY_PAGE_SIZE = 200;
export const MAX_HISTORY_WINDOW_ENTRIES = 1_000;
export const MAX_HISTORY_WINDOW_TEXT_CHARS = 16_000_000;

export type HistoryLoadState = "idle" | "loading" | "error";

export interface HistoryWindowSnapshot {
  entries: readonly HistoryEntryDto[];
  hasEarlier: boolean;
  hasNewer: boolean;
  nextBeforeEntryId?: string;
  newerBoundaryEntryId?: string;
  loadState: HistoryLoadState;
  error?: string;
  generation: number;
  revision: number;
}

export interface EarlierHistoryRequest {
  token: number;
  generation: number;
  beforeEntryId: string;
}

export interface HistoryWindowOptions {
  maxEntries?: number;
  maxTextChars?: number;
}

/**
 * Client-local bounded reverse-history window.
 *
 * The Host remains the history owner. This state retains an older-facing
 * contiguous window plus the pinned latest page, and advances with the
 * Host-provided before-entry cursor.
 * When the target bound is exceeded it evicts from the newer edge so repeated
 * PageUp can still reach the beginning of arbitrarily long sessions. The page
 * just fetched, its visual anchor, and the pinned latest page are never dropped
 * in the same turn; pathological maximum-size pages therefore have a bounded
 * two-page safety allowance rather than making newly fetched history invisible.
 */
export class PagedHistoryWindow {
  private entriesValue: HistoryEntryDto[] = [];
  private hasEarlierValue = false;
  private hasNewerValue = false;
  private nextBeforeEntryIdValue: string | undefined;
  private newerBoundaryEntryIdValue: string | undefined;
  private pinnedNewestIds = new Set<string>();
  private loadStateValue: HistoryLoadState = "idle";
  private errorValue: string | undefined;
  private generationValue = 0;
  private revisionValue = 0;
  private tokenCounter = 0;
  private activeRequest: EarlierHistoryRequest | undefined;
  private readonly maxEntries: number;
  private readonly maxTextChars: number;

  constructor(options: HistoryWindowOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, MAX_HISTORY_WINDOW_ENTRIES);
    this.maxTextChars = positiveInteger(options.maxTextChars, MAX_HISTORY_WINDOW_TEXT_CHARS);
  }

  reset(entries: readonly HistoryEntryDto[], hasEarlier: boolean, generation: number): void {
    this.tokenCounter += 1;
    this.activeRequest = undefined;
    this.entriesValue = deduplicate(entries);
    this.hasNewerValue = false;
    this.newerBoundaryEntryIdValue = undefined;
    this.pinnedNewestIds = new Set(this.entriesValue.slice(-HISTORY_PAGE_SIZE).map((entry) => entry.entryId));
    this.generationValue = generation;
    this.loadStateValue = "idle";
    this.errorValue = undefined;
    this.hasEarlierValue = hasEarlier && this.entriesValue.length > 0;
    this.nextBeforeEntryIdValue = this.hasEarlierValue ? this.entriesValue[0]?.entryId : undefined;
    if (hasEarlier && !this.nextBeforeEntryIdValue) {
      this.loadStateValue = "error";
      this.errorValue = "Earlier history cursor is unavailable";
    }
    this.revisionValue += 1;
  }

  invalidate(generation: number): void {
    this.reset([], false, generation);
  }

  beginEarlier(): EarlierHistoryRequest | undefined {
    if (this.activeRequest || !this.hasEarlierValue || !this.nextBeforeEntryIdValue) return undefined;
    const request: EarlierHistoryRequest = {
      token: ++this.tokenCounter,
      generation: this.generationValue,
      beforeEntryId: this.nextBeforeEntryIdValue,
    };
    this.activeRequest = request;
    this.loadStateValue = "loading";
    this.errorValue = undefined;
    this.revisionValue += 1;
    return request;
  }

  completeEarlier(request: EarlierHistoryRequest, page: HistoryPageDto): boolean {
    if (!this.isCurrent(request)) return false;
    this.activeRequest = undefined;

    const pageEntries = deduplicate(page.entries);
    const nextCursor = page.hasEarlier ? page.nextBeforeEntryId : undefined;
    if (page.hasEarlier && (!nextCursor || nextCursor === request.beforeEntryId)) {
      this.failCurrent("Earlier history cursor did not advance");
      return false;
    }

    const existingIds = new Set(this.entriesValue.map((entry) => entry.entryId));
    const uniquePage = pageEntries.filter((entry) => !existingIds.has(entry.entryId));
    const protectedEntryId = this.entriesValue[0]?.entryId;
    const protectedEntryIds = new Set(uniquePage.map((entry) => entry.entryId));
    if (protectedEntryId) protectedEntryIds.add(protectedEntryId);
    this.entriesValue = [...uniquePage, ...this.entriesValue];
    this.hasEarlierValue = page.hasEarlier;
    this.nextBeforeEntryIdValue = nextCursor;
    this.loadStateValue = "idle";
    this.errorValue = undefined;

    const evicted = trimNewerEdge(
      this.entriesValue,
      this.maxEntries,
      this.maxTextChars,
      protectedEntryIds,
      this.pinnedNewestIds,
    );
    if (evicted > 0) {
      this.hasNewerValue = true;
      this.newerBoundaryEntryIdValue = this.entriesValue.find((entry) => this.pinnedNewestIds.has(entry.entryId))?.entryId;
    }
    this.revisionValue += 1;
    return true;
  }

  failEarlier(request: EarlierHistoryRequest, message: string): boolean {
    if (!this.isCurrent(request)) return false;
    this.activeRequest = undefined;
    this.failCurrent(message);
    return true;
  }

  returnToLatest(): boolean {
    if (!this.hasNewerValue) return false;
    this.tokenCounter += 1;
    this.activeRequest = undefined;
    this.entriesValue = this.entriesValue.filter((entry) => this.pinnedNewestIds.has(entry.entryId));
    this.hasEarlierValue = this.entriesValue.length > 0;
    this.hasNewerValue = false;
    this.nextBeforeEntryIdValue = this.hasEarlierValue ? this.entriesValue[0]?.entryId : undefined;
    this.newerBoundaryEntryIdValue = undefined;
    this.loadStateValue = "idle";
    this.errorValue = undefined;
    this.revisionValue += 1;
    return true;
  }

  snapshot(): HistoryWindowSnapshot {
    return {
      entries: this.entriesValue,
      hasEarlier: this.hasEarlierValue,
      hasNewer: this.hasNewerValue,
      ...(this.nextBeforeEntryIdValue === undefined ? {} : { nextBeforeEntryId: this.nextBeforeEntryIdValue }),
      ...(this.newerBoundaryEntryIdValue === undefined ? {} : { newerBoundaryEntryId: this.newerBoundaryEntryIdValue }),
      loadState: this.loadStateValue,
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
      generation: this.generationValue,
      revision: this.revisionValue,
    };
  }

  private isCurrent(request: EarlierHistoryRequest): boolean {
    return this.activeRequest?.token === request.token
      && request.generation === this.generationValue
      && request.beforeEntryId === this.activeRequest.beforeEntryId;
  }

  private failCurrent(message: string): void {
    this.loadStateValue = "error";
    this.errorValue = terminalLine(message);
    this.revisionValue += 1;
  }
}

function trimNewerEdge(
  entries: HistoryEntryDto[],
  maxEntries: number,
  maxTextChars: number,
  protectedEntryIds: ReadonlySet<string>,
  pinnedNewestIds: ReadonlySet<string>,
): number {
  let textChars = entries.reduce((total, entry) => total + historyEntryTextChars(entry), 0);
  let removed = 0;
  while (entries.length > 1 && (entries.length > maxEntries || textChars > maxTextChars)) {
    let candidateIndex = entries.length - 1;
    while (
      candidateIndex >= 0
      && (pinnedNewestIds.has(entries[candidateIndex]!.entryId) || protectedEntryIds.has(entries[candidateIndex]!.entryId))
    ) candidateIndex -= 1;
    const candidate = entries[candidateIndex];
    if (!candidate) break;
    entries.splice(candidateIndex, 1);
    textChars -= historyEntryTextChars(candidate);
    removed += 1;
  }
  return removed;
}

function historyEntryTextChars(entry: HistoryEntryDto): number {
  let total = entry.entryId.length + (entry.parentId?.length ?? 0) + (entry.error?.length ?? 0) + (entry.stopReason?.length ?? 0);
  for (const block of entry.content) {
    if (block.type === "text" || block.type === "thinking" || block.type === "tool_result") total += block.text.length;
    if (block.type === "tool_call") total += block.toolCallId.length + block.toolName.length + JSON.stringify(block.args).length;
    if (block.type === "tool_result") total += block.toolCallId.length + block.toolName.length;
    if (block.type === "omitted") total += block.description.length;
  }
  return total;
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function terminalLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 2_048);
}
