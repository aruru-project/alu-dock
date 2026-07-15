import {
  Editor,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
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
}

/** Thin pi-tui text/editor dialog used only for structured extension requests. */
export class ExtensionTextDialog implements Component, Focusable {
  private readonly input: Input | Editor;
  private focusedValue = false;
  private readonly title: string;
  private readonly placeholder: string | undefined;
  private readonly requestRender: () => void;

  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(options: ExtensionTextDialogOptions) {
    this.title = safeLine(options.title);
    this.placeholder = options.placeholder === undefined ? undefined : safeLine(options.placeholder);
    this.requestRender = options.requestRender;
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
    const lines = [truncateToWidth(`  ${paint.bold(paint.accent(this.title))}`, safeWidth)];
    if (this.placeholder) {
      lines.push(...wrapTextWithAnsi(`  ${paint.muted(this.placeholder)}`, safeWidth).map((line) => truncateToWidth(line, safeWidth)));
    }
    lines.push("", ...this.input.render(safeWidth), "", truncateToWidth(
      paint.muted(this.input instanceof Editor
        ? "  Enter submit · Alt+Enter/newline keys edit · Esc cancel"
        : "  Enter submit · Esc cancel"),
      safeWidth,
    ));
    return lines;
  }

  invalidate(): void { this.input.invalidate(); }
}

function safeLine(value: string): string {
  return value.replace(/[\t\r\n]+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}
