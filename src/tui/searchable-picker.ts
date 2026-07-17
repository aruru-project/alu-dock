import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
} from "@earendil-works/pi-tui";

import { filterSearchableItems, type SearchableItem } from "./search-filter.js";
import { paint } from "./theme.js";

export interface SearchablePickerOptions {
  title: string;
  footer?: string;
  body?: string;
  maxVisible?: number;
  initialValue?: string;
  pageNavigation?: boolean;
  requestRender: () => void;
}

/** Public-pi-tui adapter around Dock-owned deterministic search behavior. */
export class SearchablePicker extends Container implements Focusable {
  private readonly searchInput = new Input();
  private allItems: SearchableItem[];
  private filteredItems: SearchableItem[];
  private selectedIndex = 0;
  private readonly maxVisible: number;
  private readonly title: string;
  private readonly footer: string;
  private body: string | undefined;
  private emptyText = "No matching items";
  private readonly requestRender: () => void;
  private readonly pageNavigation: boolean;
  private focusedValue = false;

  onSelect?: (item: SearchableItem) => void;
  onCancel?: () => void;

  constructor(items: readonly SearchableItem[], options: SearchablePickerOptions) {
    super();
    this.allItems = items.map((item) => ({
      value: item.value,
      label: safeDisplayText(item.label),
      ...(item.description === undefined ? {} : { description: safeDisplayText(item.description) }),
    }));
    this.filteredItems = [...this.allItems];
    this.maxVisible = Math.max(1, Math.floor(options.maxVisible ?? 12));
    this.title = safeDisplayText(options.title);
    this.footer = safeDisplayText(options.footer ?? "type to filter · ↑↓ choose · Enter select · Esc cancel");
    this.body = options.body === undefined ? undefined : safeBodyText(options.body);
    this.requestRender = options.requestRender;
    this.pageNavigation = options.pageNavigation === true;
    const initialIndex = options.initialValue === undefined
      ? -1
      : this.filteredItems.findIndex((item) => item.value === options.initialValue);
    if (initialIndex >= 0) this.selectedIndex = initialIndex;
    this.addChild(this.searchInput);
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.move(-1);
    } else if (matchesKey(data, Key.down)) {
      this.move(1);
    } else if (matchesKey(data, Key.pageUp) || (this.pageNavigation && matchesKey(data, Key.left))) {
      this.movePage(-1);
    } else if (matchesKey(data, Key.pageDown) || (this.pageNavigation && matchesKey(data, Key.right))) {
      this.movePage(1);
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) this.onSelect?.(selected);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    } else {
      const previous = this.searchInput.getValue();
      this.searchInput.handleInput(data);
      const query = this.searchInput.getValue();
      if (query !== previous) {
        this.filteredItems = filterSearchableItems(this.allItems, query);
        this.selectedIndex = 0;
      }
    }
    this.requestRender();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const searchPrefix = "  Search: ";
    const inputWidth = Math.max(1, safeWidth - visibleWidth(searchPrefix) - 1);
    const inputLine = this.searchInput.render(inputWidth)[0] ?? "";
    const lines = [truncateToWidth(`  ${paint.bold(paint.accent(this.title))}`, safeWidth)];
    if (this.body) {
      lines.push(...wrapTextWithAnsi(`  ${this.body}`, safeWidth).map((line) => truncateToWidth(line, safeWidth)), "");
    }
    lines.push(truncateToWidth(`${paint.muted(searchPrefix)}${inputLine}`, safeWidth), "");

    if (this.filteredItems.length === 0) {
      lines.push(truncateToWidth(paint.muted(`  ${this.emptyText}`), safeWidth));
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.maxVisible / 2),
          this.filteredItems.length - this.maxVisible,
        ),
      );
      const end = Math.min(this.filteredItems.length, start + this.maxVisible);
      for (let index = start; index < end; index += 1) {
        const item = this.filteredItems[index];
        if (!item) continue;
        const selected = index === this.selectedIndex;
        const prefix = selected ? "→ " : "  ";
        const detail = item.description ? `  ${item.description.replace(/[\r\n]+/gu, " ")}` : "";
        const text = `${prefix}${item.label}${detail}`;
        lines.push(truncateToWidth(selected ? paint.accent(text) : text, safeWidth));
      }
      if (start > 0 || end < this.filteredItems.length) {
        lines.push(truncateToWidth(
          paint.muted(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`),
          safeWidth,
        ));
      }
    }

    lines.push("", truncateToWidth(`  ${paint.muted(this.footer)}`, safeWidth));
    return lines;
  }

  override invalidate(): void {
    super.invalidate();
  }

  getQuery(): string { return this.searchInput.getValue(); }
  getSelectedItem(): SearchableItem | undefined { return this.filteredItems[this.selectedIndex]; }
  getFilteredItems(): readonly SearchableItem[] { return this.filteredItems; }

  replaceItems(items: readonly SearchableItem[]): void {
    const selectedValue = this.filteredItems[this.selectedIndex]?.value;
    this.allItems = items.map((item) => ({
      value: item.value,
      label: safeDisplayText(item.label),
      ...(item.description === undefined ? {} : { description: safeDisplayText(item.description) }),
    }));
    this.filteredItems = filterSearchableItems(this.allItems, this.searchInput.getValue());
    const retainedIndex = selectedValue === undefined
      ? -1
      : this.filteredItems.findIndex((item) => item.value === selectedValue);
    this.selectedIndex = retainedIndex >= 0 ? retainedIndex : 0;
    this.requestRender();
  }

  setBody(body: string | undefined): void {
    this.body = body === undefined ? undefined : safeBodyText(body);
    this.requestRender();
  }

  setEmptyText(text: string): void {
    this.emptyText = safeDisplayText(text) || "No matching items";
    this.requestRender();
  }

  setSelectedValue(value: string | undefined): void {
    if (value === undefined) return;
    const index = this.filteredItems.findIndex((item) => item.value === value);
    if (index < 0) return;
    this.selectedIndex = index;
    this.requestRender();
  }

  private move(delta: number): void {
    if (this.filteredItems.length === 0) return;
    const length = this.filteredItems.length;
    this.selectedIndex = (this.selectedIndex + delta % length + length) % length;
  }

  private movePage(direction: -1 | 1): void {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.filteredItems.length - 1, this.selectedIndex + direction * this.maxVisible),
    );
  }
}

function safeDisplayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}

function safeBodyText(value: string): string {
  return value.replace(/[\t\r\n]+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}
