import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { paint } from "./theme.js";

export interface FixedActionItem<T extends string = string> {
  value: T;
  label: string;
  description?: string;
}

/** Visible modal boundary shared by Work overlays; delegates focus and input. */
export class WorkModalFrame implements Component, Focusable {
  private focusedValue = false;

  constructor(private readonly child: Component) {}

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    if ("focused" in this.child) (this.child as Component & Focusable).focused = value;
  }

  handleInput(data: string): void { this.child.handleInput?.(data); }
  invalidate(): void { this.child.invalidate(); }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const top = paint.accent(`╭${"─".repeat(Math.max(0, safeWidth - 2))}╮`);
    const bottom = paint.accent(`╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`);
    const rows = this.child.render(innerWidth).map((line) => {
      const clipped = truncateToWidth(line, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return `${paint.accent("│")} ${clipped}${padding} ${paint.accent("│")}`;
    });
    return [top, ...rows, bottom];
  }
}

/** Input-free action list for small, fixed semantic decisions. */
export class FixedActionDialog<T extends string = string> implements Component, Focusable {
  private selectedIndex: number;
  focused = false;
  onSelect?: (value: T) => void;
  onCancel?: () => void;

  constructor(
    private readonly title: string,
    private readonly body: readonly string[],
    private readonly items: readonly FixedActionItem<T>[],
    initialValue?: T,
  ) {
    const initialIndex = initialValue === undefined ? -1 : items.findIndex((item) => item.value === initialValue);
    this.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.onCancel?.();
    else if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.enter)) {
      const selected = this.items[this.selectedIndex];
      if (selected) this.onSelect?.(selected.value);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [truncateToWidth(`  ${paint.bold(paint.accent(this.title))}`, safeWidth)];
    let bodyRows = 3;
    for (const text of this.body) {
      if (bodyRows < 1) break;
      const wrapped = wrapTextWithAnsi(`  ${paint.muted(text)}`, safeWidth)
        .map((line) => truncateToWidth(line, safeWidth));
      lines.push(...wrapped.slice(0, bodyRows));
      bodyRows -= wrapped.length;
    }
    lines.push("");
    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index]!;
      const selected = index === this.selectedIndex;
      lines.push(truncateToWidth(
        `  ${selected ? paint.accent("›") : " "} ${selected ? paint.bold(item.label) : item.label}`,
        safeWidth,
      ));
    }
    const description = this.items[this.selectedIndex]?.description;
    if (description) {
      lines.push("", ...wrapTextWithAnsi(`  ${paint.muted(description)}`, safeWidth)
        .slice(0, 1)
        .map((line) => truncateToWidth(line, safeWidth)));
    }
    lines.push("", truncateToWidth(`  ${paint.muted("↑↓ choose · Enter continue · Esc back")}`, safeWidth));
    return lines;
  }

  private move(delta: number): void {
    if (this.items.length < 1) return;
    this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
  }
}
