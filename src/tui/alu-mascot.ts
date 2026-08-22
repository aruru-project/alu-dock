import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { RunActivityPhase } from "./run-activity.js";
import { ALU_PALETTE, type AluPaletteName } from "./alu-palette.js";
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
  phase: RunActivityPhase,
  frame = 0,
  level: TerminalColorLevel = detectTerminalColorLevel(),
  compact = false,
): string {
  if (compact) {
    const mark = phase === "idle" ? "·"
      : phase === "error" || phase === "disconnected" ? "×"
        : frame % 2 === 0 ? "◆" : "◇";
    return colorizeSealFace(`✿${mark}`, level);
  }
  const face = phase === "idle"
    ? "✿(•ᴗ•)"
    : phase === "error" || phase === "disconnected"
      ? "✿(×﹏×)"
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

function color(text: string, tone: AluPaletteName, level: TerminalColorLevel): string {
  if (level === "none" || text.length === 0) return text;
  const selected = ALU_PALETTE[tone];
  const codes = level === "truecolor"
    ? [38, 2, ...selected.rgb]
    : level === "ansi256" ? [38, 5, selected.ansi256] : [selected.ansi16];
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}
