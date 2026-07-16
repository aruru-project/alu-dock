import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

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

// Night Console assumes the user's terminal already owns a dark background.
// Only local transcript surfaces receive a background; Dock never paints the screen.
const tones = {
  text: { rgb: [214, 225, 240], ansi256: 253, ansi16: 97 },
  muted: { rgb: [127, 142, 163], ansi256: 102, ansi16: 90 },
  faint: { rgb: [83, 97, 118], ansi256: 60, ansi16: 90 },
  accent: { rgb: [125, 211, 252], ansi256: 117, ansi16: 96 },
  user: { rgb: [147, 197, 253], ansi256: 111, ansi16: 94 },
  thinking: { rgb: [196, 181, 253], ansi256: 183, ansi16: 95 },
  running: { rgb: [129, 140, 248], ansi256: 105, ansi16: 94 },
  success: { rgb: [94, 234, 212], ansi256: 80, ansi16: 96 },
  queue: { rgb: [242, 200, 121], ansi256: 222, ansi16: 93 },
  warning: { rgb: [251, 191, 36], ansi256: 214, ansi16: 93 },
  error: { rgb: [251, 113, 133], ansi256: 204, ansi16: 91 },
  userSurface: { rgb: [17, 28, 48], ansi256: 234, ansi16: 34 },
  toolSurface: { rgb: [11, 18, 32], ansi256: 233, ansi16: 30 },
  selection: { rgb: [22, 78, 99], ansi256: 23, ansi16: 34 },
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

export function createNightConsolePaint(level: TerminalColorLevel) {
  const decorate = (text: string, decoration: Decoration): string => {
    if (level === "none" || text.length === 0) return text;
    const codes = [...(decoration.attributes ?? [])];
    if (decoration.foreground) codes.push(...foregroundCodes(level, decoration.foreground));
    if (decoration.background && (level !== "ansi16" || decoration.backgroundAtAnsi16 === true)) {
      codes.push(...backgroundCodes(level, decoration.background));
    }
    return codes.length === 0 ? text : `\u001b[${codes.join(";")}m${text}\u001b[0m`;
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

export const paint = createNightConsolePaint(detectTerminalColorLevel());

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
