import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { DockEvent } from "../core/instance-dto.js";

export type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

/** Client-owned mount point for Host-rendered Pi extension widgets. */
export class ExtensionWidgetSurface implements Component {
  private readonly widgets = new Map<string, string[]>();

  constructor(
    private readonly placement: ExtensionWidgetPlacement,
    private readonly reportViewport: (width: number) => void,
  ) {}

  apply(event: DockEvent): void {
    if (event.type !== "extension.widget_changed") return;
    if (event.data.lines === undefined || event.data.placement !== this.placement) {
      this.widgets.delete(event.data.key);
      return;
    }
    this.widgets.set(event.data.key, [...event.data.lines]);
  }

  reset(): void {
    this.widgets.clear();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.reportViewport(safeWidth);
    return [...this.widgets.values()].flatMap((lines) => (
      lines.map((line) => truncateToWidth(line, safeWidth))
    ));
  }
}
