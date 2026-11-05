import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import { AluHubBrand, renderHubAlu } from "../src/tui/alu-mascot.js";
import { HubMenuLayout, HubProcessTerminal, visibleHubItemIndices } from "../src/tui/dock-hub.js";


test("fullscreen Hub keeps responsive brand geometry and deterministic item hitboxes", () => {
  const component = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });
  let rows = 18;
  const visible = visibleHubItemIndices(20, 5, 10);
  assert.deepEqual(visible, [8, 9, 10, 11, 12]);
  const layout = new HubMenuLayout(
    new AluHubBrand(),
    component(["title", "subtitle"]),
    component(["one", "two", "three", "four", "five", "  (11/20)"]),
    component(["hint"]),
    () => rows,
    () => visible,
  );

  for (const width of [43, 44, 63]) {
    const lines = layout.render(width);
    assert.equal(lines.length, 18);
    assert.match(lines[4] ?? "", /✿\(◆ᴗ◆\) ALU/u);
    assert.equal(layout.hitTest(1, 8), 8);
    assert.equal(layout.hitTest(width, 12), 12);
    assert.equal(layout.hitTest(1, 7), undefined, "heading is not an item");
    assert.equal(layout.hitTest(1, 13), undefined, "scroll indicator is not an item");
  }

  rows = 24;
  const standard = layout.render(80);
  assert.equal(standard.length, 24);
  assert.match(standard.join("\n"), /◕    ◕/u);
  assert.equal(layout.hitTest(25, 10), 8);
  assert.equal(layout.hitTest(24, 10), undefined, "mascot/gutter is outside the list panel");
  assert.equal(layout.hitTest(80, 14), 12);
  assert.equal(layout.hitTest(25, 15), undefined, "scroll indicator is not hittable");

  rows = 40;
  assert.equal(layout.render(120).length, 40);
  assert.equal(layout.hitTest(25, 18), 8);
  assert.equal(layout.hitTest(121, 18), undefined);
});

test("the color portrait keeps the Hub's mascot column: ten lines, never wider than the character version", () => {
  for (const level of ["truecolor", "ansi256"] as const) {
    for (const blink of [false, true]) {
      const portrait = renderHubAlu(22, blink, level, true);
      assert.equal(portrait.length, 10);
      assert.ok(portrait.every((line) => visibleWidth(line) <= 21), `${level} portrait fits beside the menu`);
    }
    assert.notDeepEqual(renderHubAlu(22, true, level, true), renderHubAlu(22, false, level, true), "Alu still blinks");
  }
});

// Windows Terminal re-colors a glyph whose color is within OKLab distance 0.5 of its cell
// background (adjustIndistinguishableColors, on by default), which once turned Alu's dark hair
// pink. Every glyph in the portrait must keep that distance from its own background, and none
// may be drawn over the terminal's unknown background.
test("the color portrait survives Windows Terminal's color adjustment", () => {
  const cube = [0, 95, 135, 175, 215, 255];
  const xterm = (index: number): number[] => index >= 232
    ? Array.from({ length: 3 }, () => 8 + (index - 232) * 10)
    : [cube[Math.floor((index - 16) / 36)]!, cube[Math.floor((index - 16) / 6) % 6]!, cube[(index - 16) % 6]!];
  const oklab = ([red, green, blue]: number[]): number[] => {
    const [r, g, b] = [red!, green!, blue!].map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
    const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
    const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  for (const level of ["truecolor", "ansi256"] as const) {
    for (const blink of [false, true]) {
      let glyphs = 0;
      for (const line of renderHubAlu(22, blink, level, true)) {
        for (const [, codes, text] of line.matchAll(/\u001b\[([\d;]+)m([^\u001b]+)\u001b\[0m/gu)) {
          if (text === " ") continue;
          const values = codes!.split(";").map(Number);
          const plane = (code: number): number[] | undefined => {
            const at = values.indexOf(code);
            if (at < 0) return undefined;
            return values[at + 1] === 2 ? values.slice(at + 2, at + 5) : xterm(values[at + 2]!);
          };
          const color = plane(38), background = plane(48);
          assert.ok(color && background, `${level}: "${text}" is drawn over its own background`);
          const [a, b] = [oklab(color), oklab(background)];
          assert.ok(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) >= 0.5, `${level}: "${text}" ${color} over ${background} stays distinguishable`);
          glyphs++;
        }
      }
      assert.ok(glyphs > 0);
    }
  }
});

test("short Hub height never exposes truncated item rows", () => {
  const component = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });
  const layout = new HubMenuLayout(
    new AluHubBrand(),
    component(["title", "subtitle"]),
    component(Array.from({ length: 12 }, (_, index) => `item ${index}`)),
    component(["hint"]),
    () => 6,
    () => Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal(layout.render(43).length, 6);
  assert.equal(layout.hitTest(1, 4), 0);
  assert.equal(layout.hitTest(1, 6), 2);
  assert.equal(layout.hitTest(1, 7), undefined);
});

test("Hub alternate-screen owner enters and leaves idempotently with mouse cleanup first", () => {
  class RecordingTerminal extends HubProcessTerminal {
    readonly output: string[] = [];
    override write(data: string): void { this.output.push(data); }
  }
  const terminal = new RecordingTerminal();
  terminal.enterHubPresentation();
  terminal.enterHubPresentation();
  terminal.leaveHubPresentation();
  terminal.leaveHubPresentation();
  assert.equal(terminal.output.join(""), "\u001b[?1049h\u001b[?1006l\u001b[?1000l\u001b[?1049l");
});
