import {
  Container,
  Input,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
} from "@earendil-works/pi-tui";

import type { TreeNodeDto } from "../core/instance-dto.js";
import { semanticTreeRole, SessionTreeModel, type TreeFilterMode, type VisibleTreeNode } from "./session-tree.js";
import { paint } from "./theme.js";

export interface SessionTreeSurfaceOptions {
  title: string;
  initialFilter: TreeFilterMode;
  initialSelectedId?: string;
  terminalRows: () => number;
  requestRender: () => void;
}

interface RenderedTreeRow {
  gutter: string;
  body: string;
  bodyWidth: number;
  anchorColumn: number;
  selected: boolean;
}

/** Dedicated, runtime-agnostic tree navigator over the closed TreeNodeDto. */
export class SessionTreeSurface extends Container implements Focusable {
  private readonly search = new Input();
  private model: SessionTreeModel | undefined;
  private loadingText = "Loading the complete session tree…";
  private failed = false;
  private focusedValue = false;

  onSelect?: (node: TreeNodeDto) => void;
  onCancel?: () => void;

  constructor(private readonly options: SessionTreeSurfaceOptions) {
    super();
    this.addChild(this.search);
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    this.search.focused = value;
  }

  replaceTree(nodes: readonly TreeNodeDto[], leafId?: string): void {
    this.model = new SessionTreeModel(nodes, leafId, this.options.initialFilter, this.options.initialSelectedId);
    this.failed = false;
    this.loadingText = "";
    this.search.setValue("");
    this.options.requestRender();
  }

  setLoadFailure(message = "Could not load the session tree"): void {
    this.model = undefined;
    this.failed = true;
    this.loadingText = message;
    this.options.requestRender();
  }

  getSelectedNode(): TreeNodeDto | undefined { return this.model?.selected()?.node; }
  getFilterMode(): TreeFilterMode | undefined { return this.model?.filterMode; }
  getQuery(): string { return this.model?.query ?? this.search.getValue(); }

  handleInput(data: string): void {
    const model = this.model;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (model?.clearQueryAndFolds()) this.search.setValue("");
      else this.onCancel?.();
      this.options.requestRender();
      return;
    }
    if (!model) return;

    if (matchesKey(data, Key.up)) model.move(-1);
    else if (matchesKey(data, Key.down)) model.move(1);
    else if (matchesKey(data, Key.ctrl("left")) || matchesKey(data, Key.alt("left"))) model.foldOrJumpUp();
    else if (matchesKey(data, Key.ctrl("right")) || matchesKey(data, Key.alt("right"))) model.unfoldOrJumpDown();
    else if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) model.movePage(-1, this.visibleRowCount());
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) model.movePage(1, this.visibleRowCount());
    else if (matchesKey(data, Key.ctrlShift("o")) || matchesKey(data, Key.shiftCtrl("o"))) model.cycleFilter(-1);
    else if (matchesKey(data, Key.ctrl("o"))) model.cycleFilter(1);
    else if (matchesKey(data, Key.ctrl("d"))) model.setFilter("default");
    else if (matchesKey(data, Key.ctrl("t"))) model.toggleFilter("no-tools");
    else if (matchesKey(data, Key.ctrl("u"))) model.toggleFilter("user-only");
    else if (matchesKey(data, Key.ctrl("l"))) model.toggleFilter("labeled-only");
    else if (matchesKey(data, Key.ctrl("a"))) model.toggleFilter("all");
    else if (matchesKey(data, Key.enter)) {
      const selected = model.selected()?.node;
      if (selected) this.onSelect?.(selected);
    } else {
      const previous = this.search.getValue();
      this.search.handleInput(data);
      const query = this.search.getValue();
      if (query !== previous) model.setQuery(query);
    }
    this.options.requestRender();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [truncateToWidth(`  ${paint.bold(paint.accent(this.options.title))}`, safeWidth)];
    lines.push(...renderHelp(safeWidth));

    const model = this.model;
    if (!model) {
      lines.push("", truncateToWidth(`  ${this.failed ? paint.error(this.loadingText) : paint.muted(this.loadingText)}`, safeWidth));
      lines.push("", truncateToWidth(`  ${paint.muted("Esc cancel")}`, safeWidth));
      return lines;
    }

    const searchPrefix = `  Search [${model.filterMode}]: `;
    const inputWidth = Math.max(1, safeWidth - visibleWidth(searchPrefix) - 1);
    lines.push(truncateToWidth(`${paint.muted(searchPrefix)}${this.search.render(inputWidth)[0] ?? ""}`, safeWidth), "");

    const visible = model.visible();
    if (visible.length === 0) {
      lines.push(truncateToWidth(`  ${paint.warning("No matching tree entries")}`, safeWidth));
    } else {
      const selectedIndex = Math.max(0, visible.findIndex((item) => item.node.entryId === model.selectedId));
      const maxVisible = this.visibleRowCount();
      const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), visible.length - maxVisible));
      const end = Math.min(visible.length, start + maxVisible);
      const rows = visible.slice(start, end).map((item, offset) => renderTreeRow(item, start + offset === selectedIndex));
      lines.push(...renderHorizontalViewport(rows, safeWidth));
      lines.push(truncateToWidth(
        `  ${paint.muted(`(${selectedIndex + 1}/${visible.length})`)}${model.foldedCount > 0 ? paint.accent(` · ${model.foldedCount} folded`) : ""}`,
        safeWidth,
      ));
    }
    lines.push("", truncateToWidth(`  ${paint.muted("Enter select · Esc clears search/folds, then cancels")}`, safeWidth));
    return lines;
  }

  private visibleRowCount(): number {
    return Math.max(4, Math.floor(this.options.terminalRows()) - 11);
  }
}

function renderHelp(width: number): string[] {
  const help = "↑↓ move · ←→/PgUp/PgDn page · Ctrl/Alt+←→ branch · Ctrl+O filter · Ctrl+D/T/U/L/A views";
  return wrapTextWithAnsi(`  ${paint.muted(help)}`, width).map((line) => truncateToWidth(line, width));
}

function renderTreeRow(item: VisibleTreeNode, selected: boolean): RenderedTreeRow {
  const cursor = selected ? paint.bold(paint.warning("▶ ")) : "  ";
  const branchMarker = item.folded ? paint.accent("⊞ ") : item.foldable ? paint.faint("⊟ ") : "";
  const pathMarker = item.currentLeaf ? paint.accent("● ") : item.activePath ? paint.accent("• ") : "";
  const prefix = paint.faint(item.prefix);
  const label = item.node.label ? paint.warning(`[${item.node.label}] `) : "";
  const content = renderNodeContent(item.node, selected);
  const body = `${prefix}${branchMarker}${pathMarker}${label}${content}`;
  return {
    gutter: cursor,
    body,
    bodyWidth: visibleWidth(body),
    anchorColumn: visibleWidth(`${prefix}${branchMarker}${pathMarker}`),
    selected,
  };
}

function renderNodeContent(node: TreeNodeDto, selected: boolean): string {
  const emphasize = (text: string): string => selected ? paint.bold(text) : text;
  if (node.state === "error") {
    const role = node.role === "assistant" ? `${paint.success("assistant:")} ` : "";
    return emphasize(`${role}${paint.error(node.summary)}`);
  }
  if (node.state === "aborted") return emphasize(`${paint.success("assistant:")} ${paint.muted(node.summary || "(aborted)")}`);
  if (node.displayClass === "tool") return emphasize(paint.muted(node.summary));
  if (node.kind === "compaction") return emphasize(paint.thinking(node.summary));
  if (node.kind === "branch_summary") return emphasize(paint.warning(node.summary));
  if (node.displayClass === "metadata") return emphasize(paint.faint(`[${semanticTreeRole(node)}] ${node.summary}`));
  if (node.kind === "message" && node.role === "user") return emphasize(`${paint.user("user:")} ${node.summary}`);
  if (node.kind === "message" && node.role === "assistant") return emphasize(`${paint.success("assistant:")} ${node.summary}`);
  if (node.kind === "message" && node.role === "system") return emphasize(paint.muted(`[system] ${node.summary}`));
  return emphasize(`${paint.accent(`[${semanticTreeRole(node)}]`)} ${node.summary}`);
}

function renderHorizontalViewport(rows: readonly RenderedTreeRow[], width: number): string[] {
  const gutterWidth = 2;
  const bodyWidth = Math.max(0, width - gutterWidth);
  const maxBody = rows.reduce((maximum, row) => Math.max(maximum, row.bodyWidth), 0);
  const maxScroll = Math.max(0, maxBody - bodyWidth);
  const selected = rows.find((row) => row.selected);
  let scroll = 0;
  if (selected && selected.anchorColumn > bodyWidth - Math.max(4, Math.floor(bodyWidth / 3))) {
    scroll = Math.min(maxScroll, Math.max(0, selected.anchorColumn - Math.max(2, Math.floor(bodyWidth / 4))));
  }
  return rows.map((row) => {
    const visible = truncateToWidth(
      scroll > 0 ? `${row.gutter}${sliceByColumn(row.body, scroll, bodyWidth, true)}\u001b[0m` : `${row.gutter}${row.body}`,
      width,
      "",
    );
    if (!row.selected) return visible;
    const padded = `${visible}${" ".repeat(Math.max(0, width - visibleWidth(visible)))}`;
    return paint.selection(padded);
  });
}
