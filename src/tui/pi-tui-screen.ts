import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
  HistoryViewport,
  composeFixedScreen,
  fitFixedScreenChrome,
  type HistoryViewportProjection,
  type HistoryViewportSnapshot,
} from "./screen-layout.js";
import type { ConversationRowAnchor } from "./conversation.js";
import { paint } from "./theme.js";

interface AnchorableHistory extends Component {
  rowAnchor(width: number, rowIndex: number): ConversationRowAnchor | undefined;
  rowIndexForAnchor(width: number, anchor: ConversationRowAnchor): number | undefined;
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
  activityPlacement?: {
    editorRow: number;
    update: (placement: { screenRow: number; width: number; screenRows: number } | undefined) => void;
  };
}

/** Thin pi-tui compositor; all viewport behavior lives in screen-layout.ts. */
export class FixedDockScreen extends Container {
  private readonly viewport = new HistoryViewport();
  private renderWidth = 1;
  private renderHeight = 1;
  private lastHistoryRows: number | undefined;
  private lastAnchor: FixedHistoryAnchor | undefined;
  private pendingAnchor: FixedHistoryAnchor | undefined;

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
      && this.viewport.snapshot().locked
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
    const placement = this.sections.activityPlacement;
    if (placement) {
      const clippedEditorRows = editor.length - chrome.editor.length;
      const visibleEditorRow = placement.editorRow - clippedEditorRows;
      placement.update(visibleEditorRow >= 0 && visibleEditorRow < chrome.editor.length
        ? {
          screenRow: height - chrome.status.length - chrome.help.length - chrome.editor.length + visibleEditorRow,
          width: nextWidth,
          screenRows: height,
        }
        : undefined);
    }
    if (
      this.lastHistoryRows !== undefined
      && chrome.historyRows !== this.lastHistoryRows
      && this.viewport.snapshot().locked
      && !this.pendingAnchor
    ) {
      this.pendingAnchor = this.captureHistoryAnchor();
    }
    this.lastHistoryRows = chrome.historyRows;
    const historyLines = this.sections.history.render(nextWidth);
    if (this.pendingAnchor) {
      const target = this.sections.history.rowIndexForAnchor(nextWidth, this.pendingAnchor.row);
      if (target !== undefined) {
        const contentRows = Math.max(0, chrome.historyRows - 1);
        const screenRow = Math.min(this.pendingAnchor.screenRow, Math.max(0, contentRows - 1));
        const desiredStart = Math.max(0, target - screenRow);
        this.viewport.restoreOffsetFromBottom(historyLines.length - desiredStart - contentRows);
      }
      this.pendingAnchor = undefined;
    }
    const version = this.sections.historyVersion();
    const projection = this.viewport.project(historyLines, chrome.historyRows, {
      width: nextWidth,
      revision: version.revision,
      outputRevision: version.outputRevision,
    });
    this.lastAnchor = this.resolveHistoryAnchor(projection);
    const projectedHistory = [...projection.lines];
    if (projection.indicatorVisible) {
      const unseen = projection.unseenUpdates > 0 ? " · new output" : "";
      projectedHistory.push(truncateToWidth(
        paint.queue(`  ↑ history paused${unseen} · PageDown/Ctrl+End to live tail`),
        nextWidth,
      ));
    }

    return composeFixedScreen({
      height,
      header: chrome.header,
      history: projectedHistory,
      status: chrome.status,
      help: chrome.help,
      editor: chrome.editor,
    });
  }

  pageUp(): boolean { return this.viewport.pageUp(); }
  pageDown(): boolean { return this.viewport.pageDown(); }
  scrollUp(rows = 3): boolean { return this.viewport.scrollUp(rows); }
  scrollDown(rows = 3): boolean { return this.viewport.scrollDown(rows); }
  captureHistoryAnchor(): FixedHistoryAnchor | undefined {
    return this.lastAnchor === undefined ? undefined : { row: { ...this.lastAnchor.row }, screenRow: this.lastAnchor.screenRow };
  }
  restoreHistoryAnchor(anchor: FixedHistoryAnchor | undefined): void {
    if (anchor) this.pendingAnchor = anchor;
  }
  revealOffsetFromBottom(resolveOffset: (width: number) => number | undefined): void {
    const offset = resolveOffset(this.renderWidth);
    if (offset !== undefined) this.viewport.scrollToOffsetFromBottom(offset);
  }
  scrollToBottom(): void { this.viewport.scrollToBottom(); }
  viewportSnapshot(): HistoryViewportSnapshot { return this.viewport.snapshot(); }

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
}
