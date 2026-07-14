import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";

const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function ansi(code: number, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const paint = {
  accent: (text: string): string => ansi(36, text),
  assistant: (text: string): string => ansi(32, text),
  user: (text: string): string => ansi(34, text),
  warning: (text: string): string => ansi(33, text),
  error: (text: string): string => ansi(31, text),
  muted: (text: string): string => ansi(90, text),
  bold: (text: string): string => ansi(1, text),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: paint.accent,
  selectedText: paint.accent,
  description: paint.muted,
  scrollInfo: paint.muted,
  noMatch: paint.warning,
};

export const editorTheme: EditorTheme = {
  borderColor: paint.accent,
  selectList: selectListTheme,
};
