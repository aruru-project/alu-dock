import {
  CURSOR_MARKER,
  Editor,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

import { editorTheme, paint } from "./theme.js";

export interface ExtensionTextDialogOptions {
  mode: "input" | "editor";
  title: string;
  placeholder?: string;
  prefill?: string;
  requestRender: () => void;
  tui: TUI;
  /** Complete child-row budget inside the Work modal frame. */
  maxRows?: number | (() => number);
}

/** Thin pi-tui text/editor dialog used only for structured extension requests. */
export class ExtensionTextDialog implements Component, Focusable {
  private readonly input: Input | Editor;
  private focusedValue = false;
  private readonly title: string;
  private readonly placeholder: string | undefined;
  private readonly requestRender: () => void;
  private readonly maxRows: (() => number) | undefined;

  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(options: ExtensionTextDialogOptions) {
    this.title = safeLine(options.title);
    this.placeholder = options.placeholder === undefined ? undefined : safeLine(options.placeholder);
    this.requestRender = options.requestRender;
    this.maxRows = options.maxRows === undefined
      ? undefined
      : typeof options.maxRows === "function"
        ? () => normalizeRowBudget((options.maxRows as () => number)())
        : () => normalizeRowBudget(options.maxRows as number);
    if (options.mode === "editor") {
      const editor = new Editor(options.tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
      if (options.prefill) editor.setText(options.prefill);
      editor.onSubmit = (value) => this.onSubmit?.(value);
      this.input = editor;
    } else {
      const input = new Input();
      input.onSubmit = (value) => this.onSubmit?.(value);
      input.onEscape = () => this.onCancel?.();
      this.input = input;
    }
  }

  get focused(): boolean { return this.focusedValue; }
  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    }
    this.input.handleInput?.(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const maxRows = this.maxRows?.();
    const lines = [truncateToWidth(`  ${paint.bold(paint.accent(this.title))}`, safeWidth)];
    if (this.placeholder) {
      const placeholder = wrapTextWithAnsi(`  ${paint.muted(this.placeholder)}`, safeWidth)
        .map((line) => truncateToWidth(line, safeWidth));
      const limit = maxRows === undefined ? placeholder.length : Math.min(placeholder.length, 2);
      const visiblePlaceholder = placeholder.slice(0, limit);
      if (placeholder.length > limit && visiblePlaceholder.at(-1) !== undefined) {
        visiblePlaceholder[visiblePlaceholder.length - 1] = appendRightMarker(visiblePlaceholder.at(-1) ?? "", paint.faint(" …"), safeWidth);
      }
      lines.push(...visiblePlaceholder);
    }
    const footer = truncateToWidth(
      paint.muted(this.input instanceof Editor
        ? "  Enter submit · Alt+Enter/newline keys edit · Esc cancel"
        : "  Enter submit · Esc cancel"),
      safeWidth,
    );
    const inputLines = this.input.render(safeWidth);
    const fixedRows = lines.length + 3; // separator above input, separator below, footer
    const inputBudget = maxRows === undefined ? inputLines.length : Math.max(1, maxRows - fixedRows);
    const cursorLine = Math.max(0, inputLines.findIndex((line) => line.includes(CURSOR_MARKER)));
    const start = Math.max(0, Math.min(
      cursorLine - Math.floor(inputBudget / 2),
      inputLines.length - inputBudget,
    ));
    const visibleInput = inputLines.slice(start, start + inputBudget);
    if (start > 0 && visibleInput[0] !== undefined) visibleInput[0] = truncateToWidth(`${paint.faint("↑ ")}${visibleInput[0]}`, safeWidth);
    if (start + visibleInput.length < inputLines.length && visibleInput.at(-1) !== undefined) {
      visibleInput[visibleInput.length - 1] = appendRightMarker(visibleInput.at(-1) ?? "", paint.faint(" ↓"), safeWidth);
    }
    lines.push("", ...visibleInput, "", footer);
    return maxRows === undefined ? lines : lines.slice(0, maxRows);
  }

  invalidate(): void { this.input.invalidate(); }
}

function normalizeRowBudget(value: number): number {
  return Math.max(6, Math.floor(Number.isFinite(value) ? value : 6));
}

function appendRightMarker(line: string, marker: string, width: number): string {
  const markerWidth = visibleWidth(marker);
  return truncateToWidth(`${truncateToWidth(line, Math.max(1, width - markerWidth))}${marker}`, width);
}

function safeLine(value: string): string {
  return value.replace(/[\t\r\n]+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}
