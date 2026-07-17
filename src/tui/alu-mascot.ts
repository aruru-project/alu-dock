import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { RunActivityPhase } from "./run-activity.js";
import { detectTerminalColorLevel, type TerminalColorLevel } from "./theme.js";

const LARGE_OPEN = [
  "       ▄▓▓▓▓▓▄✿",
  "     ▄▓╭─────╮▓▄",
  "     ▓│ ◆   ◆ │▓",
  "     ▓│   ᴗ   │▓",
  "     ▀▓╰──┬──╯▓▀",
  "       ╭──┴──╮",
  "      ╱ ╲╲╱╱ ╲",
  "     │   ╲▽╱  │",
  "     │    ◇   │",
  "     ╰────────╯",
] as const;

const LARGE_BLINK = LARGE_OPEN.map((line, index) => index === 2 ? line.replaceAll("◆", "━") : line);

const palette = {
  hair: { rgb: [105, 66, 78], ansi256: 95, ansi16: 31 },
  highlight: { rgb: [151, 98, 105], ansi256: 138, ansi16: 91 },
  gold: { rgb: [246, 193, 71], ansi256: 221, ansi16: 93 },
  skin: { rgb: [244, 216, 206], ansi256: 224, ansi16: 97 },
  navy: { rgb: [108, 132, 205], ansi256: 104, ansi16: 94 },
  pink: { rgb: [221, 126, 158], ansi256: 175, ansi16: 95 },
  white: { rgb: [230, 225, 242], ansi256: 255, ansi16: 97 },
} as const;

type PaletteTone = keyof typeof palette;

/** Static, protocol-free Alu asset. It never infers Host or fleet health. */
export class AluHubBrand implements Component {
  private blink = false;

  setBlink(blink: boolean): void { this.blink = blink; }
  invalidate(): void {}

  render(width: number): string[] {
    return renderHubAlu(width, this.blink);
  }

  renderLarge(width: number): string[] {
    return renderHubAlu(width, this.blink, detectTerminalColorLevel(), true);
  }

  renderCompact(width: number): string[] {
    return [truncateToWidth(colorizeSeal(this.blink, detectTerminalColorLevel()), Math.max(1, width))];
  }
}

export function renderHubAlu(
  width: number,
  blink = false,
  level: TerminalColorLevel = detectTerminalColorLevel(),
  forceLarge = false,
): string[] {
  const bounded = Math.max(1, width);
  if (!forceLarge && bounded <= 43) return [truncateToWidth(colorizeSeal(blink, level), bounded)];
  return (blink ? LARGE_BLINK : LARGE_OPEN).map((line) => truncateToWidth(colorizeMascotLine(line, level), bounded));
}

export function renderWorkAlu(
  phase: RunActivityPhase | "status",
  frame = 0,
  level: TerminalColorLevel = detectTerminalColorLevel(),
  compact = false,
): string {
  if (compact) {
    const mark = phase === "idle" || phase === "status" ? "·"
      : phase === "error" || phase === "disconnected" ? "×"
        : phase === "tool" ? "⌁" : frame % 2 === 0 ? "◆" : "◇";
    return colorizeSealFace(`✿${mark}`, level);
  }
  const face = phase === "idle" || phase === "status"
    ? "✿(•ᴗ•)"
    : phase === "error" || phase === "disconnected"
      ? "✿(×﹏×)"
      : phase === "tool" ? "✿(⌁ᴗ⌁)"
        : phase === "compaction" ? `✿(${frame % 2 === 0 ? "◆" : "◇"}ᴗ${frame % 2 === 0 ? "◇" : "◆"})`
          : `✿(${frame % 2 === 0 ? "◆" : "•"}_${frame % 2 === 0 ? "◆" : "•"})`;
  return colorizeSealFace(face, level);
}

function colorizeSeal(blink: boolean, level: TerminalColorLevel): string {
  return `${color("✿", "white", level)}${color(`(${blink ? "━" : "◆"}ᴗ${blink ? "━" : "◆"})`, "skin", level)} ${color("ALU", "navy", level)}`;
}

function colorizeSealFace(face: string, level: TerminalColorLevel): string {
  if (level === "none") return face;
  return [...face].map((character) => {
    if (character === "✿") return color(character, "white", level);
    if (character === "◆" || character === "◇") return color(character, "gold", level);
    if (character === "⌁" || character === "×") return color(character, "pink", level);
    return color(character, "skin", level);
  }).join("");
}

function colorizeMascotLine(line: string, level: TerminalColorLevel): string {
  if (level === "none") return line;
  return [...line].map((character, index) => {
    if (character === " ") return character;
    if (character === "✿") return color(character, "white", level);
    if (character === "◆" || character === "◇") return color(character, "gold", level);
    if (character === "▽") return color(character, "pink", level);
    if (/[▓▄▀]/u.test(character)) return color(character, index % 3 === 0 ? "highlight" : "hair", level);
    if (/[╱╲]/u.test(character)) return color(character, "navy", level);
    return color(character, index > 5 ? "skin" : "white", level);
  }).join("");
}

function color(text: string, tone: PaletteTone, level: TerminalColorLevel): string {
  if (level === "none" || text.length === 0) return text;
  const selected = palette[tone];
  const codes = level === "truecolor"
    ? [38, 2, ...selected.rgb]
    : level === "ansi256" ? [38, 5, selected.ansi256] : [selected.ansi16];
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

export function mascotVisibleWidth(lines: readonly string[]): number {
  return Math.max(0, ...lines.map((line) => visibleWidth(line)));
}
