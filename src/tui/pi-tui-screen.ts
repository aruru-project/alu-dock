import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
  HistoryViewport,
  composeFixedScreen,
  fitFixedScreenChrome,
  type HistoryViewportProjection,
  type HistoryViewportSnapshot,
} from "./screen-layout.js";
import type { ConversationAnchorMove, ConversationRowAnchor, ConversationViewportSlice } from "./conversation.js";
import { paint } from "./theme.js";

interface AnchorableHistory extends Component {
  rowAnchor(width: number, rowIndex: number): ConversationRowAnchor | undefined;
  rowIndexForAnchor(width: number, anchor: ConversationRowAnchor): number | undefined;
  renderViewport?(width: number, rows: number, anchor?: ConversationRowAnchor): ConversationViewportSlice;
  moveAnchor?(width: number, anchor: ConversationRowAnchor, deltaRows: number): ConversationAnchorMove | undefined;
}

export interface FixedHistoryAnchor {
  row: ConversationRowAnchor;
  screenRow: number;
}

interface ScreenSections {
  header: Component;
  history: AnchorableHistory;
  status: Component;
  help?: Component;
  editor: Component;
  historyVersion: () => { revision: number; outputRevision: number };
}

/** Thin pi-tui compositor; all viewport behavior lives in screen-layout.ts. */
export class FixedDockScreen extends Container {
  private readonly viewport = new HistoryViewport();
  private renderWidth = 1;
  private renderHeight = 1;
  private lastHistoryRows: number | undefined;
  private lastAnchor: FixedHistoryAnchor | undefined;
  private pendingAnchor: FixedHistoryAnchor | undefined;
  private virtualTopAnchor: ConversationRowAnchor | undefined;
  private virtualLocked = false;
  private virtualUnseenUpdates = 0;
  private virtualVisibleRows = 1;
  private virtualCanScrollUp = false;
  private virtualCanScrollDown = false;
  private virtualOffsetFromBottom = 0;
  private lastVirtualVersion: { revision: number; outputRevision: number } | undefined;
  private explicitVirtualNavigation = false;

  constructor(
    private readonly terminal: { rows: number },
    private readonly sections: ScreenSections,
  ) {
    super();
    this.addChild(sections.header);
    this.addChild(sections.history);
    this.addChild(sections.editor);
    this.addChild(sections.status);
    if (sections.help) this.addChild(sections.help);
  }

  override render(width: number): string[] {
    const nextWidth = Math.max(1, width);
    const height = Math.max(1, this.terminal.rows);
    if (
      (nextWidth !== this.renderWidth || height !== this.renderHeight)
      && this.historyLocked()
      && !this.pendingAnchor
    ) {
      this.pendingAnchor = this.captureHistoryAnchor();
    }
    this.renderWidth = nextWidth;
    this.renderHeight = height;
    const header = this.sections.header.render(nextWidth);
    const status = this.sections.status.render(nextWidth);
    const help = this.sections.help?.render(nextWidth) ?? [];
    const editor = this.sections.editor.render(nextWidth);
    const chrome = fitFixedScreenChrome({ height, header, status, help, editor });
    if (
      this.lastHistoryRows !== undefined
      && chrome.historyRows !== this.lastHistoryRows
      && this.historyLocked()
      && !this.pendingAnchor
    ) {
      this.pendingAnchor = this.captureHistoryAnchor();
    }
    this.lastHistoryRows = chrome.historyRows;
    const version = this.sections.historyVersion();
    const projectedHistory = this.virtualHistory()
      ? this.renderVirtualHistory(nextWidth, chrome.historyRows, version)
      : this.renderMaterializedHistory(nextWidth, chrome.historyRows, version);

    return composeFixedScreen({
      height,
      header: chrome.header,
      history: projectedHistory,
      status: chrome.status,
      help: chrome.help,
      editor: chrome.editor,
    });
  }

  pageUp(): boolean {
    return this.virtualHistory() ? this.scrollVirtual(-Math.max(1, this.virtualVisibleRows - 1)) : this.viewport.pageUp();
  }
  pageDown(): boolean {
    return this.virtualHistory() ? this.scrollVirtual(Math.max(1, this.virtualVisibleRows - 1)) : this.viewport.pageDown();
  }
  scrollUp(rows = 3): boolean {
    return this.virtualHistory() ? this.scrollVirtual(-Math.max(1, Math.floor(rows))) : this.viewport.scrollUp(rows);
  }
  scrollDown(rows = 3): boolean {
    return this.virtualHistory() ? this.scrollVirtual(Math.max(1, Math.floor(rows))) : this.viewport.scrollDown(rows);
  }
  captureHistoryAnchor(): FixedHistoryAnchor | undefined {
    return this.lastAnchor === undefined ? undefined : { row: { ...this.lastAnchor.row }, screenRow: this.lastAnchor.screenRow };
  }
  restoreHistoryAnchor(anchor: FixedHistoryAnchor | undefined): void {
    if (!anchor) return;
    this.pendingAnchor = anchor;
    if (this.virtualHistory()) this.virtualLocked = true;
  }
  revealHistoryAnchor(resolveAnchor: () => ConversationRowAnchor | undefined): void {
    const anchor = resolveAnchor();
    if (!anchor || !this.virtualHistory()) return;
    this.virtualTopAnchor = { ...anchor };
    this.virtualLocked = true;
    this.virtualOffsetFromBottom = Math.max(1, this.virtualOffsetFromBottom);
    this.pendingAnchor = undefined;
    this.explicitVirtualNavigation = true;
  }
  revealOffsetFromBottom(resolveOffset: (width: number) => number | undefined): void {
    const offset = resolveOffset(this.renderWidth);
    if (offset === undefined) return;
    if (this.virtualHistory()) {
      if (offset === 0) this.scrollToBottom();
      return;
    }
    this.viewport.scrollToOffsetFromBottom(offset);
  }
  scrollToBottom(): void {
    if (this.virtualHistory()) {
      this.virtualLocked = false;
      this.virtualTopAnchor = undefined;
      this.virtualOffsetFromBottom = 0;
      this.virtualUnseenUpdates = 0;
      this.pendingAnchor = undefined;
      this.explicitVirtualNavigation = true;
      return;
    }
    this.viewport.scrollToBottom();
  }
  viewportSnapshot(): HistoryViewportSnapshot {
    if (!this.virtualHistory()) return this.viewport.snapshot();
    return {
      locked: this.virtualLocked,
      offsetFromBottom: this.virtualOffsetFromBottom,
      unseenUpdates: this.virtualUnseenUpdates,
      visibleRows: this.virtualVisibleRows,
      canScrollUp: this.virtualCanScrollUp,
    };
  }

  private renderMaterializedHistory(
    width: number,
    historyRows: number,
    version: { revision: number; outputRevision: number },
  ): string[] {
    const historyLines = this.sections.history.render(width);
    if (this.pendingAnchor) {
      const target = this.sections.history.rowIndexForAnchor(width, this.pendingAnchor.row);
      if (target !== undefined) {
        const contentRows = Math.max(0, historyRows - 1);
        const screenRow = Math.min(this.pendingAnchor.screenRow, Math.max(0, contentRows - 1));
        const desiredStart = Math.max(0, target - screenRow);
        this.viewport.restoreOffsetFromBottom(historyLines.length - desiredStart - contentRows);
      }
      this.pendingAnchor = undefined;
    }
    const projection = this.viewport.project(historyLines, historyRows, {
      width,
      revision: version.revision,
      outputRevision: version.outputRevision,
    });
    this.lastAnchor = this.resolveHistoryAnchor(projection);
    const projected = [...projection.lines];
    if (projection.indicatorVisible) projected.push(this.historyPausedLine(width, projection.unseenUpdates));
    return projected;
  }

  private renderVirtualHistory(
    width: number,
    historyRows: number,
    version: { revision: number; outputRevision: number },
  ): string[] {
    const history = this.virtualHistory();
    if (!history) return [];
    const previousVersion = this.lastVirtualVersion;
    if (
      this.virtualLocked
      && previousVersion
      && version.revision !== previousVersion.revision
      && !this.pendingAnchor
      && !this.explicitVirtualNavigation
    ) this.pendingAnchor = this.captureHistoryAnchor();
    if (this.virtualLocked && previousVersion && version.outputRevision > previousVersion.outputRevision) {
      this.virtualUnseenUpdates = Math.min(999, this.virtualUnseenUpdates + version.outputRevision - previousVersion.outputRevision);
    }

    const indicatorRows = this.virtualLocked && historyRows > 1 ? 1 : 0;
    let contentRows = Math.max(0, historyRows - indicatorRows);
    if (this.pendingAnchor) {
      const screenRow = Math.min(this.pendingAnchor.screenRow, Math.max(0, contentRows - 1));
      this.virtualTopAnchor = history.moveAnchor(width, this.pendingAnchor.row, -screenRow)?.anchor
        ?? { ...this.pendingAnchor.row };
      this.virtualLocked = true;
      this.virtualOffsetFromBottom = Math.max(1, this.virtualOffsetFromBottom);
      this.pendingAnchor = undefined;
    }
    if (historyRows === 0) {
      this.virtualVisibleRows = 1;
      this.lastVirtualVersion = { ...version };
      this.explicitVirtualNavigation = false;
      return [];
    }

    let slice = history.renderViewport(width, contentRows, this.virtualLocked ? this.virtualTopAnchor : undefined);
    if (this.virtualLocked && !slice.canScrollDown) {
      this.virtualLocked = false;
      this.virtualTopAnchor = undefined;
      this.virtualOffsetFromBottom = 0;
      this.virtualUnseenUpdates = 0;
      contentRows = Math.max(0, historyRows);
      slice = history.renderViewport(width, contentRows);
    } else if (this.virtualLocked) {
      this.virtualTopAnchor = slice.topAnchor ? { ...slice.topAnchor } : this.virtualTopAnchor;
    }

    this.virtualVisibleRows = Math.max(1, contentRows);
    this.virtualCanScrollUp = slice.canScrollUp;
    this.virtualCanScrollDown = slice.canScrollDown;
    this.lastAnchor = this.resolveVirtualHistoryAnchor(slice);
    this.lastVirtualVersion = { ...version };
    this.explicitVirtualNavigation = false;
    const projected = [...slice.lines];
    if (this.virtualLocked && historyRows > 1) projected.push(this.historyPausedLine(width, this.virtualUnseenUpdates));
    return projected;
  }

  private scrollVirtual(deltaRows: number): boolean {
    const history = this.virtualHistory();
    const top = this.virtualTopAnchor ?? this.lastAnchor?.row;
    if (!history || !top) return true;
    if (deltaRows < 0 && !this.virtualCanScrollUp) return true;
    if (deltaRows > 0 && !this.virtualLocked) return true;
    const moved = history.moveAnchor(this.renderWidth, top, deltaRows);
    if (!moved) return true;
    if (deltaRows > 0 && moved.reachedBoundary) {
      this.scrollToBottom();
      return true;
    }
    this.virtualTopAnchor = moved.anchor;
    this.virtualLocked = true;
    this.virtualOffsetFromBottom = Math.max(1, this.virtualOffsetFromBottom - deltaRows);
    this.pendingAnchor = undefined;
    this.explicitVirtualNavigation = true;
    return moved.reachedBoundary;
  }

  private historyLocked(): boolean {
    return this.virtualHistory() ? this.virtualLocked : this.viewport.snapshot().locked;
  }

  private virtualHistory(): Required<Pick<AnchorableHistory, "renderViewport" | "moveAnchor">> | undefined {
    const history = this.sections.history;
    return history.renderViewport && history.moveAnchor
      ? { renderViewport: history.renderViewport.bind(history), moveAnchor: history.moveAnchor.bind(history) }
      : undefined;
  }

  private historyPausedLine(width: number, unseenUpdates: number): string {
    const unseen = unseenUpdates > 0 ? " · new output" : "";
    return truncateToWidth(paint.queue(`  ↑ history paused${unseen} · PageDown/Ctrl+End to live tail`), width);
  }

  private resolveHistoryAnchor(projection: HistoryViewportProjection): FixedHistoryAnchor | undefined {
    if (projection.lines.length === 0) return undefined;
    for (let rowIndex = projection.startRow; rowIndex < projection.endRow; rowIndex += 1) {
      const row = this.sections.history.rowAnchor(this.renderWidth, rowIndex);
      if (!row || row.entryKey.endsWith("-boundary")) continue;
      return { row, screenRow: rowIndex - projection.startRow };
    }
    const row = this.sections.history.rowAnchor(this.renderWidth, projection.startRow);
    return row ? { row, screenRow: 0 } : undefined;
  }

  private resolveVirtualHistoryAnchor(slice: ConversationViewportSlice): FixedHistoryAnchor | undefined {
    for (let index = 0; index < slice.anchors.length; index += 1) {
      const row = slice.anchors[index];
      if (!row || row.entryKey.endsWith("-boundary")) continue;
      return { row: { ...row }, screenRow: index };
    }
    const row = slice.anchors[0];
    return row ? { row: { ...row }, screenRow: 0 } : undefined;
  }
}
