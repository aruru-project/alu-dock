import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

import { ALU_PALETTE } from "./alu-palette.js";

export type TerminalColorLevel = "none" | "ansi16" | "ansi256" | "truecolor";

interface Tone {
  rgb: readonly [red: number, green: number, blue: number];
  ansi256: number;
  ansi16: number;
}

interface Decoration {
  foreground?: Tone;
  background?: Tone;
  attributes?: readonly number[];
  backgroundAtAnsi16?: boolean;
}

function mixTone(left: Tone, right: Tone, ratio: number, ansi256: number, ansi16: number): Tone {
  const mix = (index: 0 | 1 | 2): number => Math.round(left.rgb[index] * (1 - ratio) + right.rgb[index] * ratio);
  return { rgb: [mix(0), mix(1), mix(2)], ansi256, ansi16 };
}

function shadeTone(source: Tone, factor: number, ansi256: number, ansi16: number): Tone {
  return {
    rgb: [
      Math.round(source.rgb[0] * factor),
      Math.round(source.rgb[1] * factor),
      Math.round(source.rgb[2] * factor),
    ],
    ansi256,
    ansi16,
  };
}

// The terminal background remains user-owned. Every semantic color and local
// surface is either canonical or a deterministic mix/shade of canonical Alu.
const plumIndigo = mixTone(ALU_PALETTE.hair, ALU_PALETTE.navy, 0.5, 60, 35);
const warmError = mixTone(ALU_PALETTE.hair, ALU_PALETTE.pink, 0.25, 96, 31);
const warmRunning = mixTone(ALU_PALETTE.hair, ALU_PALETTE.gold, 0.18, 94, 33);
const tones = {
  text: ALU_PALETTE.white,
  muted: mixTone(ALU_PALETTE.hair, ALU_PALETTE.white, 0.55, 145, 37),
  faint: ALU_PALETTE.highlight,
  accent: ALU_PALETTE.pink,
  user: ALU_PALETTE.navy,
  thinking: mixTone(ALU_PALETTE.navy, ALU_PALETTE.white, 0.5, 147, 95),
  running: ALU_PALETTE.gold,
  success: ALU_PALETTE.white,
  queue: ALU_PALETTE.highlight,
  warning: ALU_PALETTE.gold,
  error: ALU_PALETTE.pink,
  userSurface: shadeTone(plumIndigo, 0.33, 235, 34),
  toolSurface: shadeTone(ALU_PALETTE.hair, 0.26, 234, 30),
  toolRunningSurface: shadeTone(warmRunning, 0.34, 237, 33),
  toolErrorSurface: shadeTone(warmError, 0.38, 236, 31),
  compactionSurface: shadeTone(plumIndigo, 0.4, 236, 35),
  selection: ALU_PALETTE.navy,
} satisfies Record<string, Tone>;

export function detectTerminalColorLevel(
  environment: NodeJS.ProcessEnv = process.env,
  isTty = process.stdout.isTTY === true,
): TerminalColorLevel {
  if (!isTty || environment.NO_COLOR !== undefined || environment.TERM === "dumb") return "none";
  const colorTerm = environment.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor";
  if (environment.TERM?.toLowerCase().includes("256color")) return "ansi256";
  return "ansi16";
}

export function createAluPaint(level: TerminalColorLevel) {
  const decorate = (text: string, decoration: Decoration): string => {
    if (level === "none" || text.length === 0) return text;
    const codes = [...(decoration.attributes ?? [])];
    if (decoration.foreground) codes.push(...foregroundCodes(level, decoration.foreground));
    const backgroundEnabled = decoration.background !== undefined
      && (level !== "ansi16" || decoration.backgroundAtAnsi16 === true);
    if (decoration.background && backgroundEnabled) codes.push(...backgroundCodes(level, decoration.background));
    if (codes.length === 0) return text;
    const opening = `\u001b[${codes.join(";")}m`;
    // Nested Markdown/semantic painters reset SGR. Re-apply a local surface
    // after each reset so its background reaches the row padding as one block.
    const content = backgroundEnabled ? text.replaceAll("\u001b[0m", `\u001b[0m${opening}`) : text;
    return `${opening}${content}\u001b[0m`;
  };

  return {
    primary: (text: string): string => decorate(text, { foreground: tones.text }),
    accent: (text: string): string => decorate(text, { foreground: tones.accent }),
    assistant: (text: string): string => decorate(text, { foreground: tones.text }),
    user: (text: string): string => decorate(text, { foreground: tones.user }),
    thinking: (text: string): string => decorate(text, { foreground: tones.thinking, attributes: [3] }),
    running: (text: string): string => decorate(text, { foreground: tones.running }),
    success: (text: string): string => decorate(text, { foreground: tones.success }),
    queue: (text: string): string => decorate(text, { foreground: tones.queue }),
    warning: (text: string): string => decorate(text, { foreground: tones.warning }),
    error: (text: string): string => decorate(text, { foreground: tones.error }),
    muted: (text: string): string => decorate(text, { foreground: tones.muted }),
    faint: (text: string): string => decorate(text, { foreground: tones.faint }),
    userSurface: (text: string): string => decorate(text, {
      foreground: tones.text,
      background: tones.userSurface,
    }),
    toolSurface: (text: string): string => decorate(text, {
      foreground: tones.muted,
      background: tones.toolSurface,
    }),
    toolRunningSurface: (text: string): string => decorate(text, {
      foreground: tones.text,
      background: tones.toolRunningSurface,
    }),
    toolErrorSurface: (text: string): string => decorate(text, {
      foreground: tones.text,
      background: tones.toolErrorSurface,
    }),
    compactionSurface: (text: string): string => decorate(text, {
      foreground: tones.text,
      background: tones.compactionSurface,
    }),
    selection: (text: string): string => decorate(text, {
      foreground: tones.text,
      background: tones.selection,
      backgroundAtAnsi16: true,
    }),
    bold: (text: string): string => decorate(text, { attributes: [1] }),
    dim: (text: string): string => decorate(text, { attributes: [2] }),
    italic: (text: string): string => decorate(text, { attributes: [3] }),
    underline: (text: string): string => decorate(text, { attributes: [4] }),
    strikethrough: (text: string): string => decorate(text, { attributes: [9] }),
  };
}

function foregroundCodes(level: Exclude<TerminalColorLevel, "none">, tone: Tone): number[] {
  if (level === "truecolor") return [38, 2, ...tone.rgb];
  if (level === "ansi256") return [38, 5, tone.ansi256];
  return [tone.ansi16];
}

function backgroundCodes(level: Exclude<TerminalColorLevel, "none">, tone: Tone): number[] {
  if (level === "truecolor") return [48, 2, ...tone.rgb];
  if (level === "ansi256") return [48, 5, tone.ansi256];
  const foreground = tone.ansi16;
  if (foreground >= 90 && foreground <= 97) return [foreground + 10];
  if (foreground >= 30 && foreground <= 37) return [foreground + 10];
  return [40];
}

export const paint = createAluPaint(detectTerminalColorLevel());

export const markdownTheme: MarkdownTheme = {
  heading: (text) => paint.bold(paint.accent(text)),
  link: paint.accent,
  linkUrl: paint.muted,
  code: paint.warning,
  codeBlock: paint.primary,
  codeBlockBorder: paint.faint,
  quote: paint.muted,
  quoteBorder: paint.thinking,
  hr: paint.faint,
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
  selectedText: paint.selection,
  description: paint.muted,
  scrollInfo: paint.faint,
  noMatch: paint.warning,
};

export const editorTheme: EditorTheme = {
  borderColor: paint.accent,
  selectList: selectListTheme,
};
