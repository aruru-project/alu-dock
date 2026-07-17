import assert from "node:assert/strict";
import test from "node:test";

import type { Component } from "@earendil-works/pi-tui";

import { AluHubBrand, mascotVisibleWidth, renderHubAlu, renderWorkAlu } from "../src/tui/alu-mascot.js";
import { HubBlinkController, HubMenuLayout } from "../src/tui/dock-hub.js";

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

test("stacked Hub keeps the compact seal through the side-layout breakpoint", () => {
  const component = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });
  const layout = new HubMenuLayout(
    new AluHubBrand(),
    component(["title", "subtitle"]),
    component(["one", "two", "three", "four", "five"]),
    component(["hint"]),
  );
  for (const width of [43, 44, 63]) {
    const lines = layout.render(width);
    assert.equal(lines.length, 9);
    assert.match(lines[0] ?? "", /✿\(◆ᴗ◆\) ALU/u);
  }
  assert.ok(layout.render(64).length <= 10, "side-by-side layout must fit the standard mascot without a row cliff");
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
