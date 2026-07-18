import assert from "node:assert/strict";
import test from "node:test";

import { mouseTrackingSequences, parseMouseWheel, parseTerminalMouseEvent } from "../src/tui/mouse-input.js";

test("bounded SGR mouse parser accepts Hub click and one-step wheel reports", () => {
  assert.deepEqual(parseTerminalMouseEvent("\u001b[<0;25;18M"), { kind: "left-press", x: 25, y: 18 });
  assert.deepEqual(parseTerminalMouseEvent("\u001b[<4;7;9M"), { kind: "left-press", x: 7, y: 9 });
  assert.deepEqual(parseTerminalMouseEvent("\u001b[<64;10;5M"), { kind: "wheel", direction: "up", x: 10, y: 5 });
  assert.deepEqual(parseTerminalMouseEvent("\u001b[<73;11;6M"), { kind: "wheel", direction: "down", x: 11, y: 6 });
  assert.equal(parseMouseWheel("\u001b[<64;10;5M"), "up");
  assert.equal(parseMouseWheel(`\u001b[M${String.fromCharCode(97, 42, 37)}`), "down");
});

test("mouse parser ignores release, motion, other buttons, and malformed or unbounded coordinates", () => {
  for (const report of [
    "\u001b[<0;2;3m",
    "\u001b[<32;2;3M",
    "\u001b[<1;2;3M",
    "\u001b[<2;2;3M",
    "\u001b[<0;0;3M",
    "\u001b[<0;2;0M",
    "\u001b[<0;32768;3M",
    "\u001b[<128;2;3M",
    "\u001b[<999;2;3M",
    "\u001b[<0;x;3M",
    `\u001b[<0;${"9".repeat(80)};3M`,
    `\u001b[M${String.fromCharCode(32, 40_000, 37)}`,
  ]) assert.equal(parseTerminalMouseEvent(report), undefined, JSON.stringify(report));
});

test("tracking sequences pair xterm normal and SGR modes", () => {
  assert.deepEqual(mouseTrackingSequences(), {
    enable: "\u001b[?1000h\u001b[?1006h",
    disable: "\u001b[?1006l\u001b[?1000l",
  });
});
