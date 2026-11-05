import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { RunActivityPhase } from "./run-activity.js";
import { ALU_PALETTE, type AluPaletteName } from "./alu-palette.js";
import { detectTerminalColorLevel, type TerminalColorLevel } from "./theme.js";

/**
 * Alu's portrait for terminals with 256 or more colors: 20×20 pixels, two per cell drawn with
 * half blocks. Letters name colors in PORTRAIT_COLORS; "." is the terminal's own background.
 * Drawn after the character sheet: dark brown bob with blue ends, gold eyes, white flower,
 * sailor collar with a pink bow, lavender cardigan.
 */
const PORTRAIT_OPEN = [
  ".......DDDDDDD......",
  "....DDDHHhhHHHDD....",
  "...DHHHHhhhHHhhHD...",
  "..DHHHHHHHHHHHHHWWW.",
  ".DHHHHHHHHHHHHHHWfW.",
  ".DHHHSHHSSHHSHHHHWW.",
  ".DHHSSSSSSSSSSSSHHD.",
  ".DHHSeeeSSSSeeeSHHD.",
  ".DHHSeWESSSSeWESHHD.",
  ".DHHSEEESSSSEEESHHD.",
  ".DHHsGGGSSSSGGGsHHD.",
  ".DHHssSSSSSSSSssHHD.",
  ".DBHkSSSSmmSSSSkHBb.",
  ".DBBBkkSSSSSSkkBBBb.",
  "..BBbCCCkSSkCCCbBB..",
  ".VVBCLLCCSSCCLLCBVV.",
  ".VVVVCCLCPPCLCCVVVV.",
  "VVVVVVCCPPPPCCVVVVVV",
  "VVVVVVVCPpPpCVVVVVVV",
  "vVVVVVVVCCCCVVVVVVVv",
] as const;

/** Eyes closed: the lids meet where the lower eye was. */
const PORTRAIT_BLINK = PORTRAIT_OPEN.map((row, index) => ({
  7: ".DHHSSSSSSSSSSSSHHD.",
  8: ".DHHSSSSSSSSSSSSHHD.",
  9: ".DHHSeeeSSSSeeeSHHD.",
  10: ".DHHsSSSSSSSSSSsHHD.",
} as Record<number, string>)[index] ?? row);

interface PortraitColor { rgb: readonly [number, number, number]; ansi256: number }

/** 256-color picks are chosen by eye: the nearest cube colors turn the brown hair grey. */
const PORTRAIT_COLORS: Record<string, PortraitColor> = {
  D: { rgb: [52, 32, 34], ansi256: 236 },
  H: { rgb: [74, 46, 44], ansi256: 95 },
  h: { rgb: [122, 82, 72], ansi256: 138 },
  B: { rgb: [78, 98, 168], ansi256: 61 },
  b: { rgb: [58, 70, 130], ansi256: 60 },
  S: { rgb: [255, 233, 222], ansi256: 224 },
  s: { rgb: [246, 196, 190], ansi256: 217 },
  k: { rgb: [232, 196, 182], ansi256: 181 },
  e: { rgb: [70, 40, 26], ansi256: 236 },
  E: { rgb: [232, 168, 52], ansi256: 179 },
  G: { rgb: [250, 206, 96], ansi256: 221 },
  W: { rgb: [255, 255, 255], ansi256: 231 },
  f: { rgb: [246, 200, 70], ansi256: 221 },
  m: { rgb: [226, 150, 146], ansi256: 174 },
  C: { rgb: [240, 240, 252], ansi256: 255 },
  L: { rgb: [96, 118, 196], ansi256: 68 },
  P: { rgb: [232, 128, 160], ansi256: 175 },
  p: { rgb: [200, 96, 130], ansi256: 168 },
  V: { rgb: [206, 196, 238], ansi256: 189 },
  v: { rgb: [176, 164, 220], ansi256: 146 },
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

/** Two pixel rows per line: the upper pixel is the foreground of "▀", the lower one its background. */
function renderPortrait(rows: readonly string[], level: "truecolor" | "ansi256"): string[] {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const upper = rows[y] ?? "";
    const lower = rows[y + 1] ?? "";
    let line = " ";
    for (let x = 0; x < upper.length; x++) {
      const top = PORTRAIT_COLORS[upper[x] ?? ""];
      const bottom = PORTRAIT_COLORS[lower[x] ?? ""];
      if (!top && !bottom) line += " ";
      else if (!top) line += `\u001b[${pixelCodes(bottom!, level, 38)}m▄\u001b[0m`;
      else if (!bottom) line += `\u001b[${pixelCodes(top, level, 38)}m▀\u001b[0m`;
      else if (top === bottom) line += `\u001b[${pixelCodes(top, level, 38)}m█\u001b[0m`;
      else line += `\u001b[${pixelCodes(top, level, 38)};${pixelCodes(bottom, level, 48)}m▀\u001b[0m`;
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
