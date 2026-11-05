import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { RunActivityPhase } from "./run-activity.js";
import { ALU_PALETTE, type AluPaletteName } from "./alu-palette.js";
import { detectTerminalColorLevel, type TerminalColorLevel } from "./theme.js";

/**
 * Alu's portrait for terminals with 256 or more colors: 20×20 pixels, two per terminal cell.
 * Letters name colors in PORTRAIT_COLORS (w and x draw the smile); "." is the terminal's own
 * background. Drawn after the character sheet: dark bob with blue ends, gold eyes, white
 * flower, sailor collar with a pink bow, lavender cardigan.
 *
 * Windows Terminal by default re-colors a glyph whose color is close to its cell background
 * (adjustIndistinguishableColors). So a cell whose two pixels match is drawn as background
 * only, and a cell only splits into two colors where they contrast strongly (dark hair or
 * eyes against skin or white) and never into a drawn and an empty half.
 */
const PORTRAIT_OPEN = [
  "......HHHHHHHH......",
  "......HHHHHHHH......",
  "..HHHHHHHHHHHHHHHHH.",
  "..HHHHHHHHHHHHHHWHH.",
  ".HHHHHHHHHHHHHHWfWH.",
  ".HHHHHHHHHHHHHHWfWH.",
  ".HHHHHHHHHHHHHHHWHH.",
  ".HHHSSSHSSSSHSSSHHH.",
  ".HHHSSeeSSSSeeSSHHH.",
  ".HHHSSWGSSSSWGSSHHH.",
  ".HHHSsEESSSSEEsSHHH.",
  ".HHHSsEESSSSEEsSHHH.",
  ".BHHSSSSSwxSSSSSHHB.",
  ".BHHSSSSSwxSSSSSHHB.",
  ".BBBBCSSSSSSSSCBBBB.",
  ".BBBBCSSSSSSSSCBBBB.",
  "VVVCCLCCCPPCCCLCCVVV",
  "VVVCCLCCCPPCCCLCCVVV",
  "VVVVVCLCPPPPCLCVVVVV",
  "VVVVVCLCPPPPCLCVVVVV",
] as const;

/** Eyes closed: the lids are a dark line where the lashes were. */
const PORTRAIT_BLINK = PORTRAIT_OPEN.map((row, index) => ({
  8: ".HHHSSSSSSSSSSSSHHH.",
  9: ".HHHSSeeSSSSeeSSHHH.",
  10: ".HHHSsSSSSSSSSsSHHH.",
  11: ".HHHSsSSSSSSSSsSHHH.",
} as Record<number, string>)[index] ?? row);

interface PortraitColor { rgb: readonly [number, number, number]; ansi256: number }

/**
 * 256-color picks are chosen by eye and for contrast: xterm's palette has no dark brown that
 * stays apart from skin, so the hair is charcoal there.
 */
const PORTRAIT_COLORS: Record<string, PortraitColor> = {
  H: { rgb: [74, 46, 44], ansi256: 237 },
  B: { rgb: [78, 98, 168], ansi256: 61 },
  S: { rgb: [255, 233, 222], ansi256: 224 },
  s: { rgb: [246, 196, 190], ansi256: 217 },
  e: { rgb: [70, 40, 26], ansi256: 236 },
  E: { rgb: [232, 168, 52], ansi256: 179 },
  G: { rgb: [250, 206, 96], ansi256: 221 },
  W: { rgb: [255, 255, 255], ansi256: 231 },
  f: { rgb: [246, 200, 70], ansi256: 221 },
  C: { rgb: [240, 240, 252], ansi256: 255 },
  L: { rgb: [96, 118, 196], ansi256: 68 },
  P: { rgb: [232, 128, 160], ansi256: 175 },
  V: { rgb: [206, 196, 238], ansi256: 189 },
};

/** Cells drawn as one glyph over a background: the two halves of the smile, dark on skin. */
const PORTRAIT_GLYPHS: Record<string, { glyph: string; color: string; background: string }> = {
  w: { glyph: "╰", color: "e", background: "S" },
  x: { glyph: "╯", color: "e", background: "S" },
};

/**
 * The same bust in characters, for 16-color and colorless terminals. Each line has a tone mask
 * of the same length: h hair, H highlight, n navy (hair ends, cardigan), s skin, g gold,
 * p pink, w white.
 */
const LARGE_LINES = [
  ["       ▄▄█████▄▄", "       hhHHHhhhh"],
  ["     ▄██████████▄ ✿", "     hhhhhhhhhhhh w"],
  ["    ███▀▀▀▀▀▀▀▀███", "    hhhhhhhhhhhhhh"],
  ["    ██▌ ◕    ◕ ▐██", "    hhh g    g hhh"],
  ["    ██▌   ᴗ    ▐██", "    hhh   p    hhh"],
  ["    ██▙▖      ▗▟██", "    hhhh      hhhh"],
  ["    ▀██ ▀▄▄▄▄▀ ██▀", "    nhh ssssss hhn"],
  ["      ╱▔╲ ▚▞ ╱▔╲", "      www pp www"],
  ["     ▕   ╲▐▌╱   ▏", "     n   wppw   n"],
  ["     ▕    ▀▀    ▏", "     n    pp    n"],
] as const;

const LINE_TONES: Record<string, AluPaletteName> = { h: "hair", H: "highlight", n: "navy", s: "skin", g: "gold", p: "pink", w: "white" };
/** Sixteen colors have no brown; dark grey reads as dark hair, red does not. */
const LINE_ANSI16: Partial<Record<AluPaletteName, number>> = { hair: 90, highlight: 37 };

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
  const lines = level === "truecolor" || level === "ansi256"
    ? renderPortrait(blink ? PORTRAIT_BLINK : PORTRAIT_OPEN, level)
    : LARGE_LINES.map(([line, tones]) => colorizeMascotLine(blink ? line.replaceAll("◕", "‿") : line, tones, level));
  return lines.map((line) => truncateToWidth(line, bounded));
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

function colorizeMascotLine(line: string, tones: string, level: TerminalColorLevel): string {
  if (level === "none") return line;
  const mask = [...tones];
  return [...line].map((character, index) => {
    const tone = LINE_TONES[mask[index] ?? ""];
    if (!tone) return character;
    const ansi16 = level === "ansi16" ? LINE_ANSI16[tone] : undefined;
    return ansi16 === undefined ? color(character, tone, level) : `\u001b[${ansi16}m${character}\u001b[0m`;
  }).join("");
}

/**
 * Two pixel rows per line. Matching pixels become a background-colored space, which no terminal
 * re-colors; differing ones become "▀" with the upper pixel as glyph color over the lower one.
 */
function renderPortrait(rows: readonly string[], level: "truecolor" | "ansi256"): string[] {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const upper = rows[y] ?? "";
    const lower = rows[y + 1] ?? "";
    let line = " ";
    for (let x = 0; x < upper.length; x++) {
      const above = upper[x] ?? ".";
      const below = lower[x] ?? ".";
      const glyph = PORTRAIT_GLYPHS[above];
      const top = PORTRAIT_COLORS[above];
      const bottom = PORTRAIT_COLORS[below];
      if (glyph) line += `\u001b[${pixelCodes(PORTRAIT_COLORS[glyph.color]!, level, 38)};${pixelCodes(PORTRAIT_COLORS[glyph.background]!, level, 48)}m${glyph.glyph}\u001b[0m`;
      else if (top && top === bottom) line += `\u001b[${pixelCodes(top, level, 48)}m \u001b[0m`;
      else if (top && bottom) line += `\u001b[${pixelCodes(top, level, 38)};${pixelCodes(bottom, level, 48)}m▀\u001b[0m`;
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}

function pixelCodes(pixel: PortraitColor, level: "truecolor" | "ansi256", plane: 38 | 48): string {
  return level === "truecolor" ? `${plane};2;${pixel.rgb.join(";")}` : `${plane};5;${pixel.ansi256}`;
}

function color(text: string, tone: AluPaletteName, level: TerminalColorLevel): string {
  if (level === "none" || text.length === 0) return text;
  const selected = ALU_PALETTE[tone];
  const codes = level === "truecolor"
    ? [38, 2, ...selected.rgb]
    : level === "ansi256" ? [38, 5, selected.ansi256] : [selected.ansi16];
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}
