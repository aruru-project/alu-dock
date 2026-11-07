import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantStore } from "../src/assistant/store.js";
import { parseAssistantSearchResult, type AssistantEntry } from "../src/core/assistant.js";

const entry = (entryId: string, parentId: string | undefined, at: string, kind: AssistantEntry["kind"], text: string, extra: Partial<AssistantEntry> = {}): AssistantEntry =>
  ({ entryId, ...(parentId === undefined ? {} : { parentId }), at, kind, text, ...extra });

// Card #295: she finds what was said by keywords and time, Chinese included, pages through older
// results, and reads around a hit along the branch it was said on.
test("the assistant's memory finds Chinese keywords by time, pages back, and reads along a branch", async (context) => {
  // A day without a time is Main's local day; fix the zone so the days below are the same everywhere.
  process.env.TZ = "Asia/Shanghai";
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-store-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const session = { sessionId: "s1", cwd: "/home/owner", name: "闲聊" };
  store.record(session, [
    entry("a", undefined, "2026-11-01T10:00:00.000Z", "user", "最近在玩艾尔登法环，魂系太难了"),
    entry("b", "a", "2026-11-01T10:00:05.000Z", "assistant", "哈？魂系就是要受苦啊"),
    entry("c", "b", "2026-11-01T10:00:06.000Z", "tool_result", `${"😀".repeat(300)}找到了：受苦${"🎮".repeat(300)}`, { toolName: "web_search" }),
    // The owner went back to "a" and asked again; "d" is the later branch.
    entry("d", "a", "2026-11-03T09:00:00.000Z", "assistant", "那就先打打艾尔登法环的支线吧"),
    entry("e", "d", "2026-11-03T09:00:10.000Z", "user", "好，魂系先放放"),
  ], "e", { workId: "w1", machine: "Main" });
  assert.deepEqual(store.recorded("s1"), { lastEntryId: "e" });

  // Two-character words, three-character words and both together.
  assert.deepEqual(store.search({ query: "魂系", limit: 10 }).hits.map((hit) => hit.entryId), ["e", "b", "a"]);
  assert.deepEqual(store.search({ query: "艾尔登 魂系", limit: 10 }).hits.map((hit) => hit.entryId), ["a"]);
  assert.deepEqual(store.search({ query: "魂系", from: "2026-11-02", limit: 10 }).hits.map((hit) => hit.entryId), ["e"]);
  assert.deepEqual(store.search({ query: "魂系", to: "2026-11-01", limit: 10 }).hits.map((hit) => hit.entryId), ["b", "a"]);
  const first = store.search({ query: "魂系", limit: 2 });
  assert.deepEqual(first.hits.map((hit) => hit.entryId), ["e", "b"]);
  assert.deepEqual(store.search({ query: "魂系", limit: 2, cursor: first.nextCursor! }).hits.map((hit) => hit.entryId), ["a"]);
  assert.equal(first.hits[0]!.session.name, "闲聊");
  assert.equal(first.hits[0]!.session.workId, "w1");
  // A long excerpt full of emoji still comes back (review of the first version: it failed the whole search).
  const emoji = parseAssistantSearchResult(store.search({ query: "受苦", limit: 10 })).hits.find((hit) => hit.entryId === "c")!;
  assert.ok(emoji.snippet.includes("找到了：受苦"));

  // A batch sent again changes nothing.
  store.record(session, [entry("e", "d", "2026-11-03T09:00:10.000Z", "user", "好，魂系先放放")], "e", {});
  assert.equal(store.search({ query: "先放放", limit: 10 }).hits.length, 1);

  const around = store.context({ sessionId: "s1", entryId: "a", before: 3, after: 3 });
  assert.deepEqual(around.entries.map((item) => item.entryId), ["a", "d", "e"]);
  assert.deepEqual([around.hasBefore, around.hasAfter], [false, false]);
  const earlier = store.context({ sessionId: "s1", entryId: "c", before: 1, after: 0 });
  assert.deepEqual(earlier.entries.map((item) => item.entryId), ["b", "c"]);
  assert.equal(earlier.hasBefore, true);
});

// Data-layer review of 2026-11-07: searches that read row by row go a window at a time, so their
// pages must neither skip nor repeat entries across windows; many entries said in one millisecond
// are all kept in order; a parent the session never kept (history before a resume) is not named.
test("the assistant's memory pages through many rows without gaps, keeps a burst of entries, and names only kept parents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-store-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const start = Date.UTC(2026, 10, 1);
  // 12,000 entries, more than two windows; every 7th holds the short word.
  for (let batch = 0; batch < 12; batch += 1) {
    store.record({ sessionId: "many", cwd: "/w" }, Array.from({ length: 1_000 }, (_, index) => {
      const n = batch * 1_000 + index;
      return entry(`m${n}`, undefined, new Date(start + n * 1_000).toISOString(), "user", n % 7 === 0 ? `第${n}条 猫猫` : `第${n}条`);
    }), `m${batch * 1_000 + 999}`, {});
  }
  const expected = Array.from({ length: 12_000 }, (_, n) => n).filter((n) => n % 7 === 0).reverse().map((n) => `m${n}`);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = store.search({ query: "猫猫", limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    seen.push(...page.hits.map((hit) => hit.entryId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual(seen, expected);
  // A short word with a long one goes the same way.
  assert.deepEqual(store.search({ query: "猫猫 第11", limit: 3 }).hits.map((hit) => hit.entryId), ["m11998", "m11991", "m11984"]);
  assert.deepEqual(store.search({ query: "猫猫 第1", from: new Date(start).toISOString(), to: new Date(start + 20_000).toISOString(), limit: 10 }).hits.map((hit) => hit.entryId), ["m14"]);

  const at = new Date(start - 60_000).toISOString();
  store.record({ sessionId: "burst", cwd: "/w" }, Array.from({ length: 1_100 }, (_, n) => entry(`b${n}`, n === 0 ? "before-resume" : `b${n - 1}`, at, "user", `连发 ${n}`)), "b1099", {});
  const burst = store.search({ query: "连发", to: "2026-11-01T00:00:00.000Z", limit: 50 }).hits.map((hit) => hit.entryId);
  assert.deepEqual(burst.slice(0, 3), ["b1099", "b1098", "b1097"]);
  const first = store.context({ sessionId: "burst", entryId: "b0", before: 5, after: 1 });
  assert.equal(first.entries[0]!.parentId, undefined);
  assert.equal(first.hasBefore, false);
});
