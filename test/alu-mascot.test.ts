import assert from "node:assert/strict";
import test from "node:test";

import type { Component } from "@earendil-works/pi-tui";

import { AluHubBrand, mascotVisibleWidth, renderHubAlu, renderWorkAlu } from "../src/tui/alu-mascot.js";
import { HubBlinkController, HubMenuLayout, HubProcessTerminal, visibleHubItemIndices } from "../src/tui/dock-hub.js";

const CONTROL_PATTERN = /\u001b\](?:[^\u0007]|\u001b(?!\\))*(?:\u0007|\u001b\\)|\u001b\[(?:[0-?]*[ -/]*)?[@-~]/gu;

test("Alu assets are responsive, monochrome-safe, and use only bounded SGR color", () => {
  const large = renderHubAlu(80, false, "none");
  const narrow = renderHubAlu(43, false, "none");
  assert.equal(large.length, 10);
  assert.match(large.join("\n"), /◆   ◆/u);
  assert.deepEqual(narrow, ["✿(◆ᴗ◆) ALU"]);
  assert.ok(mascotVisibleWidth(large) <= 22);

  const color = renderHubAlu(80, false, "truecolor").join("\n");
  for (const rgb of ["105;66;78", "151;98;105", "246;193;71", "244;216;206", "108;132;205", "221;126;158", "230;225;242"]) {
    assert.match(color, new RegExp(`38;2;${rgb}`, "u"));
  }
  const stripped = color.replace(CONTROL_PATTERN, "");
  assert.equal(stripped, large.join("\n"));
  assert.doesNotMatch(color, /\u001b\]|\u001b\[[0-9;]*[HJKABCD]/u, "assets must not contain OSC or cursor control");

  assert.equal(renderWorkAlu("idle", 0, "none"), "✿(•ᴗ•)");
  assert.equal(renderWorkAlu("idle", 0, "none", true), "✿·");
  assert.equal(renderWorkAlu("tool", 0, "none", true), "✿⌁");
  assert.notEqual(renderWorkAlu("waiting", 0, "none"), renderWorkAlu("waiting", 1, "none"));
  assert.match(renderWorkAlu("error", 0, "none"), /×﹏×/u);
});

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
  assert.match(standard.join("\n"), /◆   ◆/u);
  assert.equal(layout.hitTest(25, 10), 8);
  assert.equal(layout.hitTest(24, 10), undefined, "mascot/gutter is outside the list panel");
  assert.equal(layout.hitTest(80, 14), 12);
  assert.equal(layout.hitTest(25, 15), undefined, "scroll indicator is not hittable");

  rows = 40;
  assert.equal(layout.render(120).length, 40);
  assert.equal(layout.hitTest(25, 18), 8);
  assert.equal(layout.hitTest(121, 18), undefined);
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

test("Hub blink owns one visible-only timer and tears it down", () => {
  const brand = new AluHubBrand();
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let clears = 0;
  let renders = 0;
  const timer = { unref() {} } as NodeJS.Timeout;
  const controller = new HubBlinkController(brand, () => { renders += 1; }, {
    setTimeout: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return timer;
    },
    clearTimeout: () => { clears += 1; },
  });

  controller.start();
  controller.start();
  assert.equal(callbacks.length, 1);
  assert.equal(delays[0], 3_600);
  assert.equal(controller.active, true);
  callbacks.shift()?.();
  assert.equal(renders, 1);
  assert.equal(callbacks.length, 1, "blink reschedules one timer only");
  assert.equal(delays.at(-1), 160);
  assert.match(brand.render(80).join("\n"), /━   ━/u);

  controller.stop();
  assert.equal(clears, 1);
  assert.equal(controller.active, false);
  assert.match(brand.render(80).join("\n"), /◆   ◆/u);
});
