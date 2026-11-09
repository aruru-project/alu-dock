import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AssistantDocuments } from "../src/assistant/documents.js";
import { AssistantExtraction, type ExtractionModel } from "../src/assistant/extraction.js";
import type { ModelPrompt } from "../src/assistant/extraction-prompt.js";
import { AssistantMemories } from "../src/assistant/memories.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantTimeline } from "../src/assistant/timeline.js";
import type { AssistantEntry } from "../src/core/assistant.js";
import { waitFor } from "./support/plan-goal-provider.js";

// Owner's decisions of 2026-11-10 (card #295): the background reads only what was said and every word
// of it; it is shown the memories loaded every session and searches for the others, as she does; a
// part it could not read is read again by the next model; and the owner can start over with another
// model, which reads every conversation again in the order things were said.

const NOTHING = JSON.stringify({ changes: [], timeline: [] });

async function setUp(context: TestContext, complete: ExtractionModel["complete"], options: { chunkChars?: number; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alu-extraction-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  const documents = new AssistantDocuments(root);
  await documents.initialize();
  const memories = new AssistantMemories(store.connection);
  const timeline = new AssistantTimeline(store.connection);
  const extraction = new AssistantExtraction(store.connection, memories, timeline, documents, { complete },
    { idleMs: 0, busyChars: 1e9, chunkChars: options.chunkChars ?? 24_000, tickMs: 10, quietMs: 1e15, dreamChanges: 1e9, dreamIntervalMs: 1e15 },
    () => {}, options.now);
  context.after(async () => { await extraction.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  const say = (sessionId: string, entries: AssistantEntry[]) => store.record({ sessionId, cwd: "/home/owner" }, entries, entries.at(-1)!.entryId, {});
  return { store, memories, timeline, extraction, say };
}

/** The part of a prompt holding the words read this time. */
function readThisTime(prompt: ModelPrompt): string {
  return prompt.prompt.slice(prompt.prompt.indexOf("## 这次要读的对话"));
}

test("the background reads every word said to her, whole, and not what tools returned or what compaction summed up", { timeout: 30_000 }, async (context) => {
  const prompts: ModelPrompt[] = [];
  const { say, extraction } = await setUp(context, async (_model, prompt) => { prompts.push(prompt); return NOTHING; }, { chunkChars: 4_000 });
  // The allergy sits in the middle of words longer than one part reads.
  const long = `${"路上的风景".repeat(500)}我对芒果过敏。${"山上的云海".repeat(500)}`;
  say("trip", [
    { entryId: "u1", at: "2026-11-09T01:00:00.000Z", kind: "user", text: "出发去黄山了。" },
    { entryId: "a1", parentId: "u1", at: "2026-11-09T01:00:05.000Z", kind: "assistant", text: "一路顺风！", toolCalls: [{ name: "bash", arguments: "{\"command\":\"cat /etc/hostname\"}" }] },
    { entryId: "t1", parentId: "a1", at: "2026-11-09T01:00:06.000Z", kind: "tool_result", toolName: "bash", text: "TOOL-OUTPUT-hostname" },
    { entryId: "s1", parentId: "t1", at: "2026-11-09T02:00:00.000Z", kind: "summary", text: "SUMMARY-之前聊了黄山" },
    { entryId: "u2", parentId: "s1", at: "2026-11-09T03:00:00.000Z", kind: "user", text: long },
    { entryId: "a2", parentId: "u2", at: "2026-11-09T03:00:05.000Z", kind: "assistant", text: "芒果过敏，记住了。" },
  ]);
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  await waitFor(() => extraction.status().waitingSessions === 0 && prompts.length === 3, "The conversation was not read through");

  // The long words are read whole, in a part of their own.
  const alone = readThisTime(prompts[1]!);
  assert.ok(alone.includes(long) && !alone.includes("[2]"), alone.slice(0, 300));
  // Owner's decision of 2026-11-10: only what was said is read.
  const read = prompts.map(readThisTime).join("\n");
  for (const left of ["TOOL-OUTPUT", "SUMMARY-", "/etc/hostname"]) assert.ok(!read.includes(left), `${left} was read`);
  assert.ok(readThisTime(prompts[0]!).includes("助手：一路顺风！"));
});

test("the background looks up an old memory instead of being handed them all, and corrects it rather than adding another", { timeout: 30_000 }, async (context) => {
  const prompts: ModelPrompt[] = [];
  let found = "";
  const { say, extraction, memories } = await setUp(context, async (_model, prompt, _signal, tools) => {
    prompts.push(prompt);
    found = tools!.list[0]!.run({ queries: ["日语"] });
    const id = /\[#(\d+)\]/u.exec(found)?.[1];
    return JSON.stringify({ changes: [{ do: "rewrite", id, text: "主人不学日语了，改学韩语。", from: [1] }], timeline: [] });
  });
  memories.add({ topic: "owner", text: "主人的猫叫团子。", resident: true }, "owner");
  const old = memories.add({ topic: "preferences", text: "主人在学日语，每天早上背单词。", resident: false }, "extraction");
  for (let index = 0; index < 50; index += 1) memories.add({ topic: "events", text: `主人看完了第 ${index} 部动画。`, resident: false }, "extraction");
  say("lang", [{ entryId: "u1", at: "2026-11-09T13:30:00.000Z", kind: "user", text: "日语我早就不学了，最近改学韩语。" }]);
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  await waitFor(() => memories.get(old.id).memory.text === "主人不学日语了，改学韩语。", "The old memory was not corrected");

  // Shown what every session loads, not every memory (owner's decision of 2026-11-10); the search found the old one.
  assert.ok(prompts[0]!.prompt.includes("主人的猫叫团子。"));
  assert.ok(!prompts[0]!.prompt.includes("主人在学日语") && !prompts[0]!.prompt.includes("第 3 部动画"), "Memories not loaded every session are not handed over");
  assert.ok(found.includes("主人在学日语，每天早上背单词。"), found);
  assert.equal(memories.list({ limit: 100 }).memories.length, 52, "Corrected, not added");
});

test("a part the model could not make sense of is noted and read again once another model is chosen", { timeout: 30_000 }, async (context) => {
  // The clock runs an hour on at every look, so the retries after an unreadable answer come at once.
  let clock = Date.parse("2026-11-10T00:00:00.000Z");
  const { say, extraction, memories } = await setUp(context, async (model) => model.id === "weak"
    ? "我看不太懂你要什么。"
    : JSON.stringify({ changes: [{ do: "add", topic: "owner", text: "主人对芒果过敏。", resident: true, from: [1] }], timeline: [] }),
  { now: () => (clock += 3_600_000) });
  say("fruit", [{ entryId: "u1", at: "2026-11-09T13:30:00.000Z", kind: "user", text: "我对芒果过敏，吃了会起疹子。" }]);
  extraction.setModel({ provider: "memory", id: "weak" });
  extraction.start();
  await waitFor(() => extraction.status().skippedParts === 1, "The part was not passed over");
  assert.equal(extraction.status().waitingSessions, 0, "The conversation goes on past it");
  assert.deepEqual(memories.list({ limit: 10 }).memories, []);

  extraction.setModel({ provider: "memory", id: "strong" });
  await waitFor(() => memories.list({ limit: 10 }).memories.length === 1, "The part was not read again");
  assert.equal(extraction.status().skippedParts, undefined);
});

test("starting over sets aside what the background made, keeps what the owner and she wrote, and reads everything again in the order it was said", { timeout: 30_000 }, async (context) => {
  const reads: string[] = [];
  let again = false;
  const { say, extraction, memories, timeline } = await setUp(context, async (_model, prompt) => {
    const words = readThisTime(prompt);
    reads.push(words);
    if (again) return NOTHING;
    const city = words.includes("上海") ? "上海" : "杭州";
    return JSON.stringify({ changes: [{ do: "add", topic: "events", text: `主人去了${city}。`, resident: false, from: [1] }], timeline: [{ do: "add", text: `聊去${city}的事。`, from: [1] }] });
  });
  // The later conversation arrives first; what was said earlier is still read first.
  say("late", [{ entryId: "l1", at: "2026-11-03T02:00:00.000Z", kind: "user", text: "我周三去了杭州。" }]);
  say("early", [{ entryId: "e1", at: "2026-11-01T02:00:00.000Z", kind: "user", text: "我周一去了上海。" }]);
  extraction.setModel({ provider: "memory", id: "first" });
  extraction.start();
  await waitFor(() => memories.list({ limit: 10 }).memories.length === 2 && timeline.list({ limit: 10 }).episodes.length === 2, "The conversations were not read");
  assert.ok(reads[0]!.includes("上海") && reads[1]!.includes("杭州"), "What was said earlier is read first");

  const [hangzhou, shanghai] = memories.list({ limit: 10 }).memories;
  const owners = memories.update({ id: shanghai!.id, revision: shanghai!.revision, text: "主人周一去上海出差。" }, "owner");
  const hers = memories.add({ topic: "self", text: "她答应主人出差时提醒带充电器。", resident: true }, "assistant");
  const [hangzhouLine, shanghaiLine] = timeline.list({ limit: 10 }).episodes;
  const ownersLine = timeline.update({ id: hangzhouLine!.id, revision: hangzhouLine!.revision, text: "周三在杭州（主人写的）。" }, "owner");

  again = true;
  reads.length = 0;
  assert.deepEqual(extraction.reorganize({ provider: "memory", id: "second" }), { extractionModel: { provider: "memory", id: "second" }, retiredMemories: 1, removedLines: 1 });
  assert.deepEqual(memories.list({ limit: 10 }).memories.map((memory) => memory.id).sort(), [owners.id, hers.id].sort(), "What the owner and she wrote stays");
  assert.deepEqual(memories.list({ limit: 10, state: "retired" }).memories.map((memory) => memory.id), [hangzhou!.id], "What the background made can be found among the retired");
  assert.deepEqual(timeline.list({ limit: 10 }).episodes.map((line) => line.id), [ownersLine.id]);
  assert.throws(() => timeline.get(shanghaiLine!.id));
  assert.deepEqual(extraction.settings(), { extractionModel: { provider: "memory", id: "second" } });
  await waitFor(() => reads.length === 2 && extraction.status().waitingSessions === 0, "The conversations were not read again");
  assert.ok(reads[0]!.includes("上海") && reads[1]!.includes("杭州"), "Read again in the order it was said");
});
