export interface AluPaletteTone {
  rgb: readonly [red: number, green: number, blue: number];
  ansi256: number;
  ansi16: number;
}

/** Canonical terminal palette sampled from the original Alu character artwork. */
export const ALU_PALETTE = {
  hair: { rgb: [105, 66, 78], ansi256: 95, ansi16: 31 },
  highlight: { rgb: [151, 98, 105], ansi256: 138, ansi16: 91 },
  gold: { rgb: [246, 193, 71], ansi256: 221, ansi16: 93 },
  skin: { rgb: [244, 216, 206], ansi256: 224, ansi16: 97 },
  navy: { rgb: [108, 132, 205], ansi256: 104, ansi16: 94 },
  pink: { rgb: [221, 126, 158], ansi256: 175, ansi16: 95 },
  white: { rgb: [230, 225, 242], ansi256: 255, ansi16: 97 },
} as const satisfies Record<string, AluPaletteTone>;

export type AluPaletteName = keyof typeof ALU_PALETTE;
