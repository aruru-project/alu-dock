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
  mode: "input" | "secret" | "editor";
  title: string;
  placeholder?: string;
  prefill?: string;
  requestRender: () => void;
  tui: TUI;
  /** Complete child-row budget inside the Work modal frame. */
  maxRows?: number | (() => number);
  /** Wrapped guidance rows; auth flows may need room for a complete URL. */
  maxPlaceholderRows?: number;
}

/** Thin pi-tui text/editor dialog used only for structured extension requests. */
export class ExtensionTextDialog implements Component, Focusable {
  private readonly input: Input | Editor;
  private focusedValue = false;
  private readonly title: string;
  private readonly placeholder: string | undefined;
  private readonly requestRender: () => void;
  private readonly maxRows: (() => number) | undefined;
  private readonly maxPlaceholderRows: number;
  private readonly secret: boolean;

  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(options: ExtensionTextDialogOptions) {
    this.title = safeLine(options.title);
    this.placeholder = options.placeholder === undefined ? undefined : safeLine(options.placeholder);
    this.requestRender = options.requestRender;
    this.secret = options.mode === "secret";
    this.maxPlaceholderRows = Math.max(1, Math.min(12, Math.floor(options.maxPlaceholderRows ?? 2)));
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
      if (options.prefill) {
        input.setValue(options.prefill);
        input.handleInput("\u001b[F"); // Pi Input keeps setValue() at column zero; edits should start at the end.
      }
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
      const limit = Math.min(placeholder.length, this.maxPlaceholderRows);
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
    const inputLines = this.input.render(safeWidth).map((line) => this.secret ? maskInputLine(line) : line);
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

function maskInputLine(line: string): string {
  let result = "";
  let visible = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] === "\u001b") {
      const markerEnd = line[index + 1] === "_" ? line.indexOf("\u0007", index + 2) : -1;
      if (markerEnd >= 0) {
        result += line.slice(index, markerEnd + 1);
        index = markerEnd + 1;
        continue;
      }
      const match = /^\u001b\[[0-9;?]*[ -/]*[@-~]/u.exec(line.slice(index));
      if (match) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    const character = String.fromCodePoint(line.codePointAt(index) as number);
    index += character.length;
    if (/^[\u0000-\u001f\u007f-\u009f]$/u.test(character)) {
      result += character;
      continue;
    }
    result += visible < 2 || character === " " ? character : "•";
    visible += Math.max(0, visibleWidth(character));
  }
  return result;
}
