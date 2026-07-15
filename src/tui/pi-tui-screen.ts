import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
  HistoryViewport,
  composeFixedScreen,
  fitFixedScreenChrome,
  type HistoryViewportSnapshot,
} from "./screen-layout.js";
import { paint } from "./theme.js";

interface ScreenSections {
  header: Component;
  history: Component;
  status: Component;
  help: Component;
  editor: Component;
  historyVersion: () => { revision: number; outputRevision: number };
}

/** Thin pi-tui compositor; all viewport behavior lives in screen-layout.ts. */
export class FixedDockScreen extends Container {
  private readonly viewport = new HistoryViewport();
  private renderWidth = 1;

  constructor(
    private readonly terminal: { rows: number },
    private readonly sections: ScreenSections,
  ) {
    super();
    this.addChild(sections.header);
    this.addChild(sections.history);
    this.addChild(sections.status);
    this.addChild(sections.help);
    this.addChild(sections.editor);
  }

  override render(width: number): string[] {
    this.renderWidth = Math.max(1, width);
    const height = Math.max(1, this.terminal.rows);
    const header = this.sections.header.render(width);
    const status = this.sections.status.render(width);
    const help = this.sections.help.render(width);
    const editor = this.sections.editor.render(width);
    const chrome = fitFixedScreenChrome({ height, header, status, help, editor });
    const historyLines = this.sections.history.render(width);
    const version = this.sections.historyVersion();
    const projection = this.viewport.project(historyLines, chrome.historyRows, {
      width,
      revision: version.revision,
      outputRevision: version.outputRevision,
    });
    const projectedHistory = [...projection.lines];
    if (projection.indicatorVisible) {
      const unseen = projection.unseenUpdates > 0 ? " · new output" : "";
      projectedHistory.push(truncateToWidth(
        paint.accent(`  history paused${unseen} · PageDown/Ctrl+End bottom`),
        width,
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

  pageUp(): void { this.viewport.pageUp(); }
  pageDown(): void { this.viewport.pageDown(); }
  revealOffsetFromBottom(resolveOffset: (width: number) => number | undefined): void {
    const offset = resolveOffset(this.renderWidth);
    if (offset !== undefined) this.viewport.scrollToOffsetFromBottom(offset);
  }
  scrollToBottom(): void { this.viewport.scrollToBottom(); }
  viewportSnapshot(): HistoryViewportSnapshot { return this.viewport.snapshot(); }
}
