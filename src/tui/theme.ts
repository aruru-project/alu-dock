import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function ansi(code: number, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const paint = {
  accent: (text: string): string => ansi(36, text),
  assistant: (text: string): string => ansi(32, text),
  user: (text: string): string => ansi(34, text),
  success: (text: string): string => ansi(32, text),
  warning: (text: string): string => ansi(33, text),
  error: (text: string): string => ansi(31, text),
  muted: (text: string): string => ansi(90, text),
  bold: (text: string): string => ansi(1, text),
  italic: (text: string): string => ansi(3, text),
  underline: (text: string): string => ansi(4, text),
  strikethrough: (text: string): string => ansi(9, text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => paint.bold(paint.accent(text)),
  link: paint.accent,
  linkUrl: paint.muted,
  code: paint.warning,
  codeBlock: (text) => text,
  codeBlockBorder: paint.muted,
  quote: paint.muted,
  quoteBorder: paint.accent,
  hr: paint.muted,
  listBullet: paint.accent,
  bold: paint.bold,
  italic: paint.italic,
  strikethrough: paint.strikethrough,
  underline: paint.underline,
  highlightCode: (code) => code.split("\n").map(paint.warning),
  codeBlockIndent: "  ",
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
