export interface HistoryViewportSnapshot {
  locked: boolean;
  offsetFromBottom: number;
  unseenUpdates: number;
  visibleRows: number;
  canScrollUp: boolean;
}

export interface HistoryViewportProjection extends HistoryViewportSnapshot {
  lines: string[];
  indicatorVisible: boolean;
}

interface HistoryRenderVersion {
  width: number;
  revision: number;
  outputRevision: number;
}

/** Client-local history viewport state. It never crosses the Dock protocol. */
export class HistoryViewport {
  private offsetFromBottom = 0;
  private unseenUpdates = 0;
  private visibleRows = 1;
  private pageRows = 1;
  private canScrollUp = false;
  private previousLineCount = 0;
  private previousVersion: HistoryRenderVersion | undefined;

  project(
    allLines: readonly string[],
    availableRows: number,
    version: HistoryRenderVersion,
  ): HistoryViewportProjection {
    const rows = Math.max(0, Math.floor(availableRows));
    this.pageRows = Math.max(1, rows);
    const previous = this.previousVersion;

    if (this.offsetFromBottom > 0 && previous) {
      if (version.outputRevision > previous.outputRevision) {
        this.unseenUpdates = Math.min(
          999,
          this.unseenUpdates + version.outputRevision - previous.outputRevision,
        );
      }
      if (
        version.width === previous.width
        && version.revision !== previous.revision
        && allLines.length > this.previousLineCount
      ) {
        // Keep the same historical rows on screen while new output grows below them.
        this.offsetFromBottom += allLines.length - this.previousLineCount;
      }
    }

    const baseScrollable = rows > 0 && allLines.length > rows;
    if (!baseScrollable) this.unlock();

    const indicatorRows = this.offsetFromBottom > 0 && rows > 1 ? 1 : 0;
    const contentRows = Math.max(0, rows - indicatorRows);
    const maxOffset = Math.max(0, allLines.length - contentRows);
    this.offsetFromBottom = Math.min(this.offsetFromBottom, maxOffset);
    if (this.offsetFromBottom === 0) this.unseenUpdates = 0;

    const end = Math.max(0, allLines.length - this.offsetFromBottom);
    const start = Math.max(0, end - contentRows);
    const lines = allLines.slice(start, end);

    this.visibleRows = Math.max(1, contentRows);
    this.canScrollUp = start > 0;
    this.previousLineCount = allLines.length;
    this.previousVersion = { ...version };

    return {
      lines,
      locked: this.offsetFromBottom > 0,
      offsetFromBottom: this.offsetFromBottom,
      unseenUpdates: this.unseenUpdates,
      visibleRows: contentRows,
      canScrollUp: this.canScrollUp,
      indicatorVisible: indicatorRows === 1,
    };
  }

  pageUp(): void {
    this.offsetFromBottom += Math.max(1, this.pageRows - 1);
  }

  pageDown(): void {
    this.offsetFromBottom = Math.max(0, this.offsetFromBottom - Math.max(1, this.pageRows - 1));
    if (this.offsetFromBottom === 0) this.unseenUpdates = 0;
  }

  scrollToOffsetFromBottom(offset: number): void {
    this.offsetFromBottom = Math.max(0, Math.floor(offset));
    this.unseenUpdates = 0;
  }

  scrollToBottom(): void {
    this.unlock();
  }

  snapshot(): HistoryViewportSnapshot {
    return {
      locked: this.offsetFromBottom > 0,
      offsetFromBottom: this.offsetFromBottom,
      unseenUpdates: this.unseenUpdates,
      visibleRows: this.visibleRows,
      canScrollUp: this.canScrollUp,
    };
  }

  private unlock(): void {
    this.offsetFromBottom = 0;
    this.unseenUpdates = 0;
  }
}

export interface FixedScreenChrome {
  header: string[];
  status: string[];
  help: string[];
  editor: string[];
  historyRows: number;
}

/** Keep the composer visible by shedding low-priority chrome before clipping it. */
export function fitFixedScreenChrome(params: {
  height: number;
  header: readonly string[];
  status: readonly string[];
  help: readonly string[];
  editor: readonly string[];
}): FixedScreenChrome {
  const height = Math.max(1, Math.floor(params.height));
  let header = [...params.header];
  let status = [...params.status];
  let help = [...params.help];
  let editor = [...params.editor];

  if (editor.length > height) editor = editor.slice(-height);
  if (header.length + status.length + help.length + editor.length >= height) header = [];
  if (status.length + help.length + editor.length >= height) help = [];
  if (status.length + editor.length >= height) {
    status = status.slice(0, Math.max(0, height - editor.length - 1));
  }

  return {
    header,
    status,
    help,
    editor,
    historyRows: Math.max(0, height - header.length - status.length - help.length - editor.length),
  };
}

/** Compose exactly one terminal viewport, with history ending immediately above fixed chrome. */
export function composeFixedScreen(params: {
  height: number;
  header: readonly string[];
  history: readonly string[];
  status: readonly string[];
  help: readonly string[];
  editor: readonly string[];
}): string[] {
  const height = Math.max(1, Math.floor(params.height));
  const fixedRows = params.header.length + params.status.length + params.help.length + params.editor.length;
  const historyRows = Math.max(0, height - fixedRows);
  const history = historyRows === 0 ? [] : params.history.slice(-historyRows);
  const used = fixedRows + history.length;
  const padding = Array.from({ length: Math.max(0, height - used) }, () => "");
  const lines = [
    ...params.header,
    ...padding,
    ...history,
    ...params.status,
    ...params.help,
    ...params.editor,
  ];
  return lines.length <= height ? lines : lines.slice(-height);
}
