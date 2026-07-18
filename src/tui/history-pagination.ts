import type { HistoryEntryDto, HistoryPageDto } from "../core/instance-dto.js";

export const HISTORY_PAGE_SIZE = 200;

export type HistoryLoadState = "idle" | "loading" | "error";

export interface HistoryWindowSnapshot {
  entries: readonly HistoryEntryDto[];
  hasEarlier: boolean;
  nextBeforeEntryId?: string;
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

/**
 * Client-local contiguous reverse-history window.
 *
 * The Host remains the history owner. Pages are retained after they are read so
 * PageUp/PageDown is continuous and no client cache boundary becomes product
 * history semantics. Rendering is independently virtualized by viewport.
 */
export class PagedHistoryWindow {
  private entriesValue: HistoryEntryDto[] = [];
  private hasEarlierValue = false;
  private nextBeforeEntryIdValue: string | undefined;
  private loadStateValue: HistoryLoadState = "idle";
  private errorValue: string | undefined;
  private generationValue = 0;
  private revisionValue = 0;
  private tokenCounter = 0;
  private activeRequest: EarlierHistoryRequest | undefined;

  reset(entries: readonly HistoryEntryDto[], hasEarlier: boolean, generation: number): void {
    this.tokenCounter += 1;
    this.activeRequest = undefined;
    this.entriesValue = deduplicate(entries);
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
    this.entriesValue = [...uniquePage, ...this.entriesValue];
    this.hasEarlierValue = page.hasEarlier;
    this.nextBeforeEntryIdValue = nextCursor;
    this.loadStateValue = "idle";
    this.errorValue = undefined;
    this.revisionValue += 1;
    return true;
  }

  failEarlier(request: EarlierHistoryRequest, message: string): boolean {
    if (!this.isCurrent(request)) return false;
    this.activeRequest = undefined;
    this.failCurrent(message);
    return true;
  }

  snapshot(): HistoryWindowSnapshot {
    return {
      entries: this.entriesValue,
      hasEarlier: this.hasEarlierValue,
      ...(this.nextBeforeEntryIdValue === undefined ? {} : { nextBeforeEntryId: this.nextBeforeEntryIdValue }),
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

function terminalLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 2_048);
}
