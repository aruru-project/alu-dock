import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { HistoryEntryDto } from "../src/core/instance-dto.js";
import {
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_WINDOW_ENTRIES,
  PagedHistoryWindow,
} from "../src/tui/history-pagination.js";
import { parseMouseWheel, mouseTrackingSequences, TerminalSelectionMode } from "../src/tui/mouse-input.js";

function entry(index: number, text = `history ${index}`): HistoryEntryDto {
  return {
    entryId: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text }],
  };
}

test("paged history deduplicates concurrent loads and rejects stale generation completions", () => {
  const history = new PagedHistoryWindow();
  history.reset([entry(4), entry(5)], true, 3);
  const request = history.beginEarlier();
  assert.ok(request);
  assert.equal(request.beforeEntryId, "history-4");
  assert.equal(history.beginEarlier(), undefined);
  assert.equal(history.snapshot().loadState, "loading");

  history.invalidate(4);
  assert.equal(history.completeEarlier(request, {
    entries: [entry(2), entry(3)],
    hasEarlier: true,
    nextBeforeEntryId: "history-2",
  }), false);
  assert.deepEqual(history.snapshot().entries, []);
  assert.equal(history.snapshot().generation, 4);
});

test("paged history reaches 8500 entries through bounded reverse pages while pinning the live tail", () => {
  const all = Array.from({ length: 8_500 }, (_, index) => entry(index));
  const history = new PagedHistoryWindow();
  history.reset(all.slice(-HISTORY_PAGE_SIZE), true, 1);
  const reached = new Set(history.snapshot().entries.map((item) => item.entryId));
  let pages = 0;

  while (history.snapshot().hasEarlier) {
    const request = history.beginEarlier();
    assert.ok(request);
    const end = all.findIndex((item) => item.entryId === request.beforeEntryId);
    assert.ok(end > 0);
    const start = Math.max(0, end - HISTORY_PAGE_SIZE);
    const page = all.slice(start, end);
    assert.equal(history.completeEarlier(request, {
      entries: page,
      hasEarlier: start > 0,
      ...(start > 0 ? { nextBeforeEntryId: page[0]!.entryId } : {}),
    }), true);
    for (const item of history.snapshot().entries) reached.add(item.entryId);
    assert.ok(history.snapshot().entries.length <= MAX_HISTORY_WINDOW_ENTRIES);
    pages += 1;
    assert.ok(pages < 100);
  }

  const snapshot = history.snapshot();
  assert.equal(pages, 42);
  assert.equal(reached.size, all.length);
  assert.equal(snapshot.entries[0]?.entryId, "history-0");
  assert.equal(snapshot.entries.at(-1)?.entryId, "history-8499");
  assert.equal(snapshot.hasNewer, true);
  assert.equal(snapshot.newerBoundaryEntryId, "history-8300");

  assert.equal(history.returnToLatest(), true);
  const latest = history.snapshot();
  assert.equal(latest.entries.length, HISTORY_PAGE_SIZE);
  assert.equal(latest.entries[0]?.entryId, "history-8300");
  assert.equal(latest.entries.at(-1)?.entryId, "history-8499");
  assert.equal(latest.hasEarlier, true);
  assert.equal(latest.hasNewer, false);
  assert.equal(latest.nextBeforeEntryId, "history-8300");
});

test("paged history exposes retryable cursor errors without advancing or looping", () => {
  const history = new PagedHistoryWindow();
  history.reset([entry(10), entry(11)], true, 2);
  const request = history.beginEarlier();
  assert.ok(request);
  assert.equal(history.completeEarlier(request, {
    entries: [entry(10)],
    hasEarlier: true,
    nextBeforeEntryId: "history-10",
  }), false);
  assert.equal(history.snapshot().loadState, "error");
  assert.match(history.snapshot().error ?? "", /did not advance/);
  assert.ok(history.beginEarlier(), "a PageUp retry should be admitted after an error");
});

test("terminal selection mode is explicit, bounded, and inactive by default", () => {
  const mode = new TerminalSelectionMode();
  assert.equal(mode.active, false);
  assert.deepEqual(mode.render(80), []);
  assert.equal(mode.setActive(true), true);
  assert.equal(mode.setActive(true), false);
  const line = mode.render(43)[0] ?? "";
  assert.match(line, /terminal selection/u);
  assert.ok(visibleWidth(line) <= 43);
  assert.equal(mode.setActive(false), true);
  assert.deepEqual(mode.render(80), []);
});

test("mouse wheel parser accepts SGR and legacy xterm presses and ignores non-wheel input", () => {
  assert.equal(parseMouseWheel("\u001b[<64;20;5M"), "up");
  assert.equal(parseMouseWheel("\u001b[<65;20;5M"), "down");
  assert.equal(parseMouseWheel("\u001b[<68;20;5M"), "up", "modifier bits must not change direction");
  assert.equal(parseMouseWheel(`\u001b[M${String.fromCharCode(96, 42, 37)}`), "up");
  assert.equal(parseMouseWheel(`\u001b[M${String.fromCharCode(97, 42, 37)}`), "down");
  assert.equal(parseMouseWheel("\u001b[<0;20;5M"), undefined);
  assert.equal(parseMouseWheel("\u001b[5~"), undefined);

  const sequences = mouseTrackingSequences();
  assert.match(sequences.enable, /\?1000h/);
  assert.match(sequences.enable, /\?1006h/);
  assert.match(sequences.disable, /\?1006l/);
  assert.match(sequences.disable, /\?1000l/);
});
