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
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ControlClientError } from "../control/dock-client.js";
import {
  MAX_WORKSPACE_LIST_ITEMS,
  type WorkspaceDirectoryEntry,
  type WorkspaceListCursor,
  type WorkspaceListResult,
} from "../control/protocol.js";
import { filterSearchableItems } from "./search-filter.js";
import { paint } from "./theme.js";

const MAX_COLLECTED_WORKSPACE_ENTRIES = 100_000;

export interface CollectedWorkspaceDirectory extends Omit<WorkspaceListResult, "truncated" | "nextCursor"> {
  truncated: false;
}

export async function collectWorkspaceDirectory(
  fetchPage: (cursor?: WorkspaceListCursor, limit?: number) => Promise<WorkspaceListResult>,
): Promise<CollectedWorkspaceDirectory> {
  const first = await fetchPage(undefined, MAX_WORKSPACE_LIST_ITEMS);
  const entries = [...first.entries];
  let page = first;
  while (page.truncated && entries.length < MAX_COLLECTED_WORKSPACE_ENTRIES) {
    const cursor = page.nextCursor;
    if (!cursor) throw new Error("This folder could not be fully loaded. Refresh it and try again.");
    page = await fetchPage(cursor, MAX_WORKSPACE_LIST_ITEMS);
    if (page.path !== first.path || page.revision !== first.revision || page.total !== first.total) {
      throw new Error("This folder changed while it was loading. Refresh it and try again.");
    }
    entries.push(...page.entries);
  }
  if (page.truncated) {
    throw new Error("This folder contains too many folders to browse at once. Enter the path you want directly.");
  }
  return {
    path: first.path,
    ...(first.parent === undefined ? {} : { parent: first.parent }),
    revision: first.revision,
    entries,
    total: first.total,
    truncated: false,
  };
}

export interface WorkspaceBrowserSurfaceOptions {
  initialPath: string;
  terminalRows: () => number;
  requestRender: () => void;
}

type BrowserRow =
  | { kind: "confirm"; value: string; label: string; description: string }
  | { kind: "parent"; value: string; label: string; description: string }
  | { kind: "entry"; value: string; label: string; description?: string; entry: WorkspaceDirectoryEntry };

/** Hub directory picker with complete local filtering over one Host-provided listing. */
export class WorkspaceBrowserSurface extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly pathInput = new Input();
  private listing: CollectedWorkspaceDirectory | undefined;
  private selectedIndex = 0;
  private lastPageSize = 10;
  private showHidden = false;
  private pathMode = false;
  private busy = true;
  private status = "Opening folder…";
  private error: string | undefined;
  private focusedValue = false;

  onOpenPath?: (path: string) => void;
  onConfirm?: (path: string) => void;
  onCancel?: () => void;

  constructor(private readonly options: WorkspaceBrowserSurfaceOptions) {
    super();
    this.addChild(this.searchInput);
    this.addChild(this.pathInput);
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    this.searchInput.focused = value && !this.pathMode;
    this.pathInput.focused = value && this.pathMode;
  }

  get currentPath(): string { return this.listing?.path ?? resolve(this.options.initialPath); }
  get hiddenVisible(): boolean { return this.showHidden; }
  get enteringPath(): boolean { return this.pathMode; }
  get query(): string { return this.searchInput.getValue(); }
  get directPath(): string { return this.pathInput.getValue(); }
  get selectedRow(): BrowserRow | undefined { return this.rows()[this.selectedIndex]; }

  setLoading(message = "Opening folder…"): void {
    this.busy = true;
    this.status = safeLine(message);
    this.error = undefined;
    this.options.requestRender();
  }

  replaceDirectory(listing: CollectedWorkspaceDirectory): void {
    this.listing = listing;
    this.busy = false;
    this.status = "";
    this.error = undefined;
    this.pathMode = false;
    this.searchInput.setValue("");
    this.pathInput.setValue("");
    this.selectedIndex = 0;
    this.syncInputFocus();
    this.options.requestRender();
  }

  setError(message: string): void {
    this.busy = false;
    this.error = safeLine(message) || "Couldn't open this directory.";
    this.syncInputFocus();
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (this.pathMode) {
      this.handlePathInput(data);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue().length > 0) {
        this.searchInput.setValue("");
        this.selectedIndex = 0;
      } else {
        this.onCancel?.();
      }
    } else if (matchesKey(data, Key.alt("h"))) {
      this.showHidden = !this.showHidden;
      this.selectedIndex = 0;
      this.error = undefined;
    } else if (matchesKey(data, Key.ctrl("l"))) {
      this.pathMode = true;
      this.pathInput.setValue("");
      this.error = undefined;
      this.syncInputFocus();
    } else if (!this.busy && matchesKey(data, Key.up)) {
      this.move(-1);
    } else if (!this.busy && matchesKey(data, Key.down)) {
      this.move(1);
    } else if (!this.busy && (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp))) {
      this.movePage(-1);
    } else if (!this.busy && (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown))) {
      this.movePage(1);
    } else if (!this.busy && matchesKey(data, Key.enter)) {
      this.activateSelected();
    } else if (!this.busy) {
      const previous = this.searchInput.getValue();
      this.searchInput.handleInput(data);
      if (this.searchInput.getValue() !== previous) {
        this.selectedIndex = 0;
        this.error = undefined;
      }
    }
    this.reconcileSelection();
    this.options.requestRender();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [truncateToWidth(`  ${paint.bold(paint.accent("Choose a working directory"))}`, safeWidth)];
    lines.push(...wrapTextWithAnsi(
      `  ${paint.muted("↑↓ move · ←→/PgUp/PgDn page · Enter open · Ctrl+L enter path · Alt+H hidden")}`,
      safeWidth,
    ).map((line) => truncateToWidth(line, safeWidth)));
    lines.push("", truncateToWidth(`  ${paint.muted("Current:")} ${safeLine(this.currentPath)}`, safeWidth));

    if (this.pathMode) {
      const prefix = "  Path: ";
      const inputWidth = Math.max(1, safeWidth - visibleWidth(prefix) - 1);
      lines.push(truncateToWidth(`${paint.muted(prefix)}${this.pathInput.render(inputWidth)[0] ?? ""}`, safeWidth));
      lines.push(truncateToWidth(`  ${paint.muted("Absolute, ~/…, or relative to the current folder")}`, safeWidth));
      if (this.busy) lines.push("", truncateToWidth(`  ${paint.muted(this.status)}`, safeWidth));
      if (this.error) lines.push("", truncateToWidth(`  ${paint.error(this.error)}`, safeWidth));
      lines.push("", truncateToWidth(`  ${paint.muted("Enter open · Esc return to folder list")}`, safeWidth));
      return lines;
    }

    const searchPrefix = `  Search${this.showHidden ? " [hidden shown]" : ""}: `;
    const inputWidth = Math.max(1, safeWidth - visibleWidth(searchPrefix) - 1);
    lines.push(truncateToWidth(`${paint.muted(searchPrefix)}${this.searchInput.render(inputWidth)[0] ?? ""}`, safeWidth), "");

    if (this.busy || !this.listing) {
      lines.push(truncateToWidth(`  ${paint.muted(this.status)}`, safeWidth));
    } else {
      const rows = this.rows();
      if (rows.length === 0) {
        lines.push(truncateToWidth(`  ${paint.warning("No matching folders")}`, safeWidth));
      } else {
        const visibleLimit = Math.max(1, Math.min(rows.length, this.visibleRowCount()));
        this.lastPageSize = visibleLimit;
        const start = Math.max(0, Math.min(
          this.selectedIndex - Math.floor(visibleLimit / 2),
          rows.length - visibleLimit,
        ));
        const end = Math.min(rows.length, start + visibleLimit);
        for (let index = start; index < end; index += 1) {
          const row = rows[index];
          if (!row) continue;
          lines.push(renderRow(row, index === this.selectedIndex, safeWidth));
        }
        lines.push(truncateToWidth(`  ${paint.muted(`(${this.selectedIndex + 1}/${rows.length})`)}`, safeWidth));
      }
    }
    if (this.error) lines.push("", truncateToWidth(`  ${paint.error(this.error)}`, safeWidth));
    lines.push("", truncateToWidth(`  ${paint.muted("Enter open/select · Esc clears search, then returns to Hub")}`, safeWidth));
    return lines;
  }

  private handlePathInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.pathMode = false;
      this.busy = false;
      this.error = undefined;
      this.syncInputFocus();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const value = this.pathInput.getValue();
      if (value.trim().length === 0) {
        this.error = "Enter a folder path, then press Enter.";
        return;
      }
      let path: string;
      try {
        path = resolveWorkspacePathInput(value, this.currentPath);
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Enter a valid folder path.";
        return;
      }
      this.setLoading("Opening entered path…");
      this.onOpenPath?.(path);
      return;
    }
    if (!this.busy) {
      const previous = this.pathInput.getValue();
      this.pathInput.handleInput(data);
      if (this.pathInput.getValue() !== previous) this.error = undefined;
    }
  }

  private activateSelected(): void {
    const row = this.selectedRow;
    if (!row) return;
    if (row.kind === "confirm") {
      this.onConfirm?.(row.value);
      return;
    }
    this.setLoading(row.kind === "parent" ? "Opening parent folder…" : `Opening ${safeLine(row.label)}…`);
    this.onOpenPath?.(row.value);
  }

  private rows(): BrowserRow[] {
    const listing = this.listing;
    if (!listing) return [];
    const visibleEntries = listing.entries.filter((entry) => this.showHidden || !entry.hidden);
    const query = this.searchInput.getValue();
    if (query.length > 0) {
      const searchable = visibleEntries.map((entry) => ({
        value: entry.name,
        label: entry.name,
        description: entry.kind === "symlink" ? "symbolic link" : "folder",
      }));
      const byName = new Map(visibleEntries.map((entry) => [entry.name, entry]));
      return filterSearchableItems(searchable, query).flatMap((item) => {
        const entry = byName.get(item.value);
        return entry ? [entryRow(listing.path, entry)] : [];
      });
    }
    return [
      { kind: "confirm", value: listing.path, label: "Use this directory", description: listing.path },
      ...(listing.parent === undefined
        ? []
        : [{ kind: "parent" as const, value: listing.parent, label: "..", description: "parent folder" }]),
      ...visibleEntries.map((entry) => entryRow(listing.path, entry)),
    ];
  }

  private move(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta % rows.length + rows.length) % rows.length;
  }

  private movePage(direction: -1 | 1): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(rows.length - 1, this.selectedIndex + direction * this.lastPageSize));
  }

  private reconcileSelection(): void {
    const rows = this.rows();
    this.selectedIndex = rows.length === 0 ? 0 : Math.max(0, Math.min(this.selectedIndex, rows.length - 1));
  }

  private visibleRowCount(): number {
    return Math.max(4, Math.floor(this.options.terminalRows()) - 13);
  }

  private syncInputFocus(): void {
    this.searchInput.focused = this.focusedValue && !this.pathMode;
    this.pathInput.focused = this.focusedValue && this.pathMode;
  }
}

export function workspaceBrowserErrorMessage(error: unknown): string {
  if (!(error instanceof ControlClientError)) return "Couldn't load this directory. Try again.";
  if (error.code === "workspace_changed") return "This directory changed. Open it again.";
  if (error.code === "workspace_not_found") return "This directory no longer exists.";
  if (error.code === "workspace_not_directory") return "That path is not a directory.";
  if (error.code === "workspace_permission_denied") return "You don't have permission to open this directory.";
  if (error.code === "workspace_too_large") return "There are too many entries here. Use Ctrl+L to open a more specific path.";
  if (error.code === "workspace_unavailable") return "This directory can't be opened.";
  return "Couldn't load this directory. Try again.";
}

export function resolveWorkspacePathInput(input: string, currentPath: string): string {
  if (input.includes("\0")) throw new Error("That path isn't valid.");
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(currentPath, input);
}

function entryRow(path: string, entry: WorkspaceDirectoryEntry): BrowserRow {
  return {
    kind: "entry",
    value: join(path, entry.name),
    label: entry.kind === "symlink" ? `${entry.name} @` : entry.name,
    ...(entry.kind === "symlink" ? { description: "symbolic link" } : {}),
    entry,
  };
}

function renderRow(row: BrowserRow, selected: boolean, width: number): string {
  const marker = selected ? "▶ " : "  ";
  const description = row.description ? `  ${safeLine(row.description)}` : "";
  const text = truncateToWidth(`${marker}${safeLine(row.label)}${description}`, width);
  if (!selected) return text;
  const padded = `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
  return paint.selection(padded);
}

function safeLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
