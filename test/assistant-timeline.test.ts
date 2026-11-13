import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { AssistantDocuments } from "../src/assistant/documents.js";
import { AssistantExtraction } from "../src/assistant/extraction.js";
import type { ModelPrompt } from "../src/assistant/extraction-prompt.js";
import { AssistantMemories } from "../src/assistant/memories.js";
import { AssistantCore } from "../src/assistant/service.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantTimeline } from "../src/assistant/timeline.js";
import { writeTransaction } from "../src/assistant/transaction.js";
import { assistantEntryOf } from "../src/assistant-agent/recorder.js";
import { waitFor } from "./support/plan-goal-provider.js";

// Card #295: beside her memories, Dock keeps a timeline of what the two of them were doing, one line
// per stretch of a conversation, work included. A new session starts with the last week of it, a
// day of it is found by time, a line the owner wrote stays his, and what the owner has her forget is
// not loaded or found in it either.
test("what they were doing each day becomes a timeline: a week of it opens every session, a day of it is found by time, the owner's line stays his, and it forgets what she forgets", { timeout: 30_000 }, async (context) => {
  // Days and local times below are Main's local day; fix the zone so they read the same everywhere.
  process.env.TZ = "Asia/Shanghai";
  const root = await mkdtemp(join(tmpdir(), "alu-timeline-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  const documents = new AssistantDocuments(root);
  await documents.initialize();
  const memories = new AssistantMemories(store.connection);
  const timeline = new AssistantTimeline(store.connection);
  const prompts: ModelPrompt[] = [];
  let ids: { work: string; game: string } = { work: "", game: "" };
  const extraction = new AssistantExtraction(store.connection, memories, timeline, documents, {
    complete: async (_model, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return JSON.stringify({
          changes: [{ do: "add", topic: "preferences", text: "主人喜欢艾尔登法环，爱玩法师。", resident: false, from: [3] }],
          timeline: [
            { do: "add", text: "在 alu_dock 修助手记忆的搜索超时。", from: [1, 2] },
            { do: "add", text: "深夜聊艾尔登法环的法师新档。", from: [3, 4] },
          ],
        });
      }
      return `好的：\n${JSON.stringify({ changes: [], timeline: [
        // The owner rewrote this line meanwhile: his words stay, and what the model read gets a line of its own.
        { do: "rewrite", id: ids.work, text: "主人改过那行之后接着说的事。", from: [1] },
        { do: "rewrite", id: ids.game, text: "深夜聊艾尔登法环，新档从法师换成信仰流。", from: [1, 2] },
      ] })}`;
    },
  }, { idleMs: 0, busyChars: 1e9, chunkChars: 24_000, tickMs: 10, quietMs: 1e15, dreamChanges: 1e9, dreamIntervalMs: 1e15 });
  context.after(async () => { await extraction.stop(); store.close(); await rm(root, { recursive: true, force: true }); });

  // 2026-11-05 15:00–15:25 and 2026-11-06 21:00–21:00 local.
  store.record({ sessionId: "s", cwd: "/home/owner/alu_dock", name: "阿露" }, [
    { entryId: "u1", at: "2026-11-05T07:00:00.000Z", kind: "user", text: "搜索超时的问题还在，reader 线程停不下来。" },
    { entryId: "a1", parentId: "u1", at: "2026-11-05T07:25:00.000Z", kind: "assistant", text: "我看看 readers.ts 里线程怎么收的。" },
    { entryId: "u2", parentId: "a1", at: "2026-11-06T13:00:00.000Z", kind: "user", text: "睡不着，聊聊艾尔登法环吧，我开了个法师新档。" },
    { entryId: "a2", parentId: "u2", at: "2026-11-06T13:00:10.000Z", kind: "assistant", text: "又法师？" },
  ], "a2", { workId: "w1", machine: "Main" });
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  await waitFor(() => timeline.list({ limit: 10 }).episodes.length === 2, "The timeline was not written");

  // Newest first; each line covers the entries it named, as they were said, says where it happened
  // and where its words can be read from.
  const [game, work] = timeline.list({ limit: 10 }).episodes;
  assert.deepEqual(
    [game, work].map((line) => [line!.text, line!.fromAt, line!.toAt, line!.author, line!.session.sessionId, line!.session.name, line!.entryId]),
    [
      ["深夜聊艾尔登法环的法师新档。", "2026-11-06T13:00:00.000Z", "2026-11-06T13:00:10.000Z", "extraction", "s", "阿露", "u2"],
      ["在 alu_dock 修助手记忆的搜索超时。", "2026-11-05T07:00:00.000Z", "2026-11-05T07:25:00.000Z", "extraction", "s", "阿露", "u1"],
    ],
  );
  ids = { work: work!.id, game: game!.id };
  // A memory is dated by when it was said, not by when it was extracted, and can be listed by that day.
  const [liked] = memories.list({ limit: 10 }).memories;
  assert.equal(liked!.saidAt, "2026-11-06T13:00:00.000Z");
  assert.deepEqual(memories.list({ limit: 10, from: "2026-11-07" }).memories, []);
  assert.equal(memories.list({ limit: 10, to: "2026-11-06" }).memories[0]!.id, liked!.id);
  // A day's timeline, and a word of it.
  assert.deepEqual(timeline.list({ from: "2026-11-06", to: "2026-11-06", limit: 10 }).episodes.map((line) => line.id), [game!.id]);
  assert.deepEqual(timeline.list({ query: "alu_dock", limit: 10 }).episodes.map((line) => line.id), [work!.id]);

  // The owner rewrites one line; the conversation goes on the same night, and the model extends the other.
  const his = timeline.update({ id: work!.id, revision: work!.revision, text: "在 alu_dock 修助手记忆的搜索超时（主人改过）。" }, "owner");
  store.record({ sessionId: "s", cwd: "/home/owner/alu_dock", name: "阿露" }, [
    { entryId: "u3", parentId: "a2", at: "2026-11-06T13:30:00.000Z", kind: "user", text: "换成信仰流了。" },
    { entryId: "a3", parentId: "u3", at: "2026-11-06T13:30:05.000Z", kind: "assistant", text: "行，那配信仰流的装备。" },
  ], "a3", { workId: "w1", machine: "Main" });
  await waitFor(() => timeline.get(game!.id).revision === 2, "The night's line was not extended");
  // Extraction saw the conversation's lines so far, the owner's marked as his.
  assert.ok(prompts[1]!.prompt.includes("## 这个会话已有的时间线"), "Extraction is shown the conversation's timeline");
  assert.ok(prompts[1]!.prompt.includes("2026-11-06 21:00–21:00 深夜聊艾尔登法环的法师新档。"), "A shown line carries its local time");
  assert.ok(prompts[1]!.prompt.includes("（主人定的，不能改） 在 alu_dock 修助手记忆的搜索超时（主人改过）。"), "The owner's line is marked");
  const extended = timeline.get(game!.id);
  assert.deepEqual([extended.text, extended.fromAt, extended.toAt, extended.author], ["深夜聊艾尔登法环，新档从法师换成信仰流。", "2026-11-06T13:00:00.000Z", "2026-11-06T13:30:05.000Z", "extraction"]);
  assert.deepEqual([timeline.get(work!.id).text, timeline.get(work!.id).revision], [his.text, his.revision], "The owner's line is not rewritten by extraction");
  // Review of 2026-11-10, reproduced before the fix: what was read after the owner changed a line was
  // dropped with the refused rewrite, and that stretch of the conversation had no line at all.
  const [own] = timeline.list({ limit: 10, query: "接着说的事" }).episodes;
  assert.deepEqual([own?.text, own?.fromAt, own?.toAt, own?.entryId], ["主人改过那行之后接着说的事。", "2026-11-06T13:30:00.000Z", "2026-11-06T13:30:00.000Z", "u3"], "What was read still lands on the timeline");

  // A new session loads the last week of the timeline, oldest first, not what is older. The older
  // line is written here by hand, so the background stops reading first.
  await extraction.stop();
  store.record({ sessionId: "old", cwd: "/home/owner" }, [{ entryId: "o1", at: "2026-10-20T02:00:00.000Z", kind: "user", text: "三周前的一句话。" }], "o1", {});
  const o1 = store.connection.prepare("SELECT id FROM entries WHERE entry_id = 'o1'").get() as { id: number };
  const older = writeTransaction(store.connection, () =>
    timeline.insert("old", { row: o1.id, at: "2026-10-20T02:00:00.000Z", at_ms: Date.parse("2026-10-20T02:00:00.000Z") }, { row: o1.id, at: "2026-10-20T03:00:00.000Z", at_ms: Date.parse("2026-10-20T03:00:00.000Z") }, "三周前在做别的。", "extraction"));
  const readers = { search: () => Promise.reject(new Error("not read here")), context: () => Promise.reject(new Error("not read here")) };
  const core = new AssistantCore(documents, store, readers as never, memories, timeline, extraction, root, () => new Date("2026-11-08T02:00:00.000Z"));
  const loaded = (await core.answer({ op: "load" }, {})).text;
  const section = loaded.slice(loaded.indexOf("## 最近一周的时间线"), loaded.indexOf("## 记忆"));
  assert.ok(section.includes(`- 2026-11-05 15:00–15:25：在 alu_dock 修助手记忆的搜索超时（主人改过）。（#${work!.id}）\n- 2026-11-06 21:00–21:30：深夜聊艾尔登法环，新档从法师换成信仰流。（#${game!.id}）`), `A new session starts with the week's timeline:\n${section}`);
  assert.ok(!loaded.includes("三周前"), "Older lines are left for her to search");

  // A line the owner does not want is forgotten, not loaded or listed, and can come back.
  const forgotten = timeline.update({ id: game!.id, revision: extended.revision, state: "forgotten" }, "owner");
  assert.deepEqual(timeline.list({ limit: 10 }).episodes.map((line) => line.id), [own!.id, work!.id, String(older.id)]);
  assert.ok(!(await core.answer({ op: "load" }, {})).text.includes("信仰流"));
  assert.deepEqual(timeline.list({ limit: 10, state: "forgotten" }).episodes.map((line) => line.id), [game!.id]);
  assert.equal(timeline.update({ id: game!.id, revision: forgotten.revision, state: "active" }, "owner").state, "active");
  // A stale revision changes nothing.
  assert.throws(() => timeline.update({ id: game!.id, revision: forgotten.revision, text: "过期的改动" }, "owner"), (error: unknown) => (error as { code?: string }).code === "assistant_episode_changed");

  // The owner has her forget what she remembered from that night: the night's line may tell the same,
  // so it is no longer listed or loaded either, and the work line is untouched; restoring the memory
  // brings the line back.
  const gone = memories.update({ id: liked!.id, revision: memories.get(liked!.id).memory.revision, state: "forgotten" }, "owner");
  assert.deepEqual(timeline.list({ limit: 10 }).episodes.map((line) => line.id), [own!.id, work!.id, String(older.id)]);
  assert.ok(!(await core.answer({ op: "load" }, {})).text.includes("信仰流"), "A forgotten memory's night is not loaded from the timeline");
  memories.update({ id: liked!.id, revision: gone.revision, state: "active" }, "owner");
  assert.deepEqual(timeline.list({ limit: 10 }).episodes.map((line) => line.id), [own!.id, game!.id, work!.id, String(older.id)]);
});

// Owner's decision 2026-11-09 (#295 after #666): what another Work says to her — a child Work's message,
// or another Work's message Dock delivered into her input — is kept as that Work's words, and extraction
// reads it as such, never as the owner's.
test("what another Work says to her is kept and read as that Work's words, never as the owner's", { timeout: 30_000 }, async (context) => {
  const at = "2026-11-09T08:00:00.000Z";
  const entries = [
    { type: "custom_message", id: "w1", parentId: null, timestamp: at, customType: "dock-work-message", content: "[来自子 Work「构建机」· 已完成]\n打包好了。", display: true },
    { type: "message", id: "w2", parentId: "w1", timestamp: at, message: { role: "user", content: '[Agent message from "Reviewer"]\n复审通过。', timestamp: 0 } },
    { type: "custom_message", id: "w3", parentId: "w2", timestamp: at, customType: "dock-work-wake", content: "", display: false },
    { type: "message", id: "u1", parentId: "w3", timestamp: at, message: { role: "user", content: "晚上吃什么？", timestamp: 0 } },
  ] as unknown as SessionEntry[];
  const kept = entries.map((entry) => assistantEntryOf(entry, new Uint8Array(32)));
  assert.deepEqual(kept.map((entry) => entry?.kind), ["work", "work", undefined, "user"], "a Work's words are not the owner's, and the marker that only starts a turn is not kept");

  const root = await mkdtemp(join(tmpdir(), "alu-work-words-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  const documents = new AssistantDocuments(root);
  await documents.initialize();
  const memories = new AssistantMemories(store.connection);
  const prompts: ModelPrompt[] = [];
  const extraction = new AssistantExtraction(store.connection, memories, new AssistantTimeline(store.connection), documents, {
    complete: async (_model, prompt) => { prompts.push(prompt); return JSON.stringify({ changes: [], timeline: [{ do: "add", text: "子 Work 交回了结果。", from: [1] }] }); },
  }, { idleMs: 0, busyChars: 1e9, chunkChars: 24_000, tickMs: 10, quietMs: 1e15, dreamChanges: 1e9, dreamIntervalMs: 1e15 });
  context.after(async () => { await extraction.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  store.record({ sessionId: "s", cwd: "/home/owner" }, [
    { ...kept[0]!, entryId: "w1" },
    { ...kept[1]!, entryId: "w2", parentId: "w1" },
    { ...kept[3]!, entryId: "u1", parentId: "w2" },
  ], "u1", {});
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  await waitFor(() => prompts.length === 1, "The conversation was not read");
  const read = prompts[0]!.prompt;
  assert.ok(read.includes("Work 消息：[来自子 Work「构建机」· 已完成]") && read.includes('Work 消息：[Agent message from "Reviewer"]'), read);
  assert.ok(read.includes("主人：晚上吃什么？") && !read.includes("主人：[来自子 Work") && !read.includes("主人：[Agent message"), read);
});
