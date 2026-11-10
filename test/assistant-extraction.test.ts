import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AssistantDocuments } from "../src/assistant/documents.js";
import { AssistantExtraction, ExtractionModelError, type ExtractionModel } from "../src/assistant/extraction.js";
import type { ModelPrompt } from "../src/assistant/extraction-prompt.js";
import { AssistantMemories } from "../src/assistant/memories.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantTimeline } from "../src/assistant/timeline.js";
import { writeTransaction } from "../src/assistant/transaction.js";
import type { AssistantEntry } from "../src/core/assistant.js";
import { waitFor } from "./support/plan-goal-provider.js";

// Owner's decisions of 2026-11-10 (card #295): the background reads only what was said and every word
// of it; it is shown the memories loaded every session and searches for the others, as she does; a
// part it could not read is read again by the next model; and the owner can start over with another
// model, which reads every conversation again in the order things were said.

/** No memory worth keeping; the part read still lands on the timeline, as every reply must. */
const LINE = [{ do: "add", text: "聊了几句。", from: [1] }];
const NOTHING = JSON.stringify({ changes: [], timeline: LINE });

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

/** Whether a prompt asks the model to read a conversation, rather than only whether it answers at all (asked after a call failed). */
const reads = (prompt: ModelPrompt): boolean => prompt.prompt.includes("## 这次要读的对话");

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
    return JSON.stringify({ changes: [{ do: "rewrite", id, text: "主人不学日语了，改学韩语。", from: [1] }], timeline: LINE });
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
    : JSON.stringify({ changes: [{ do: "add", topic: "owner", text: "主人对芒果过敏。", resident: true, from: [1] }], timeline: LINE }),
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
  const { say, extraction, memories, timeline, store } = await setUp(context, async (_model, prompt) => {
    const words = readThisTime(prompt);
    reads.push(words);
    if (again) return words.includes("上海") ? JSON.stringify({ changes: [], timeline: [{ do: "add", text: "又读到去上海的事。", from: [1] }] }) : NOTHING;
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
  // She corrects a line at the owner's word, and reading on extends it since.
  const corrected = timeline.update({ id: hangzhouLine!.id, revision: hangzhouLine!.revision, text: "周三在杭州（她改正的）。" }, "assistant");
  writeTransaction(store.connection, () => timeline.change(timeline.row(Number(corrected.id)), { text: "周三在杭州，后来又聊了一会儿。" }, "extraction"));

  again = true;
  reads.length = 0;
  assert.deepEqual(extraction.reorganize({ provider: "memory", id: "second" }), { extractionModel: { provider: "memory", id: "second" }, retiredMemories: 1, removedLines: 1 });
  assert.deepEqual(memories.list({ limit: 10 }).memories.map((memory) => memory.id).sort(), [owners.id, hers.id].sort(), "What the owner and she wrote stays");
  assert.deepEqual(memories.list({ limit: 10, state: "retired" }).memories.map((memory) => memory.id), [hangzhou!.id], "What the background made can be found among the retired");
  assert.deepEqual(timeline.list({ limit: 10 }).episodes.map((line) => line.id), [corrected.id], "A line she corrected stays though reading extended it since");
  assert.throws(() => timeline.get(shanghaiLine!.id));
  assert.deepEqual(extraction.settings(), { extractionModel: { provider: "memory", id: "second" } });
  await waitFor(() => reads.length === 2 && extraction.status().waitingSessions === 0, "The conversations were not read again");
  assert.ok(reads[0]!.includes("上海") && reads[1]!.includes("杭州"), "Read again in the order it was said");
  // Review of 2026-11-10: a client or a session still naming the removed line must not reach the new one.
  const fresh = timeline.list({ limit: 10, query: "又读到" }).episodes[0];
  assert.ok(fresh && fresh.id !== shanghaiLine!.id, `The new line takes a new number: ${fresh?.id}`);
});

// Review of 2026-11-10 (card #295), reproduced before the fix: a conversation the model service refused
// every time was tried over and over while every later conversation waited behind it, unread. The
// same must hold when the other conversation failed once too, as in a short outage (independent
// review of the fix: the conversation that always fails then took every later try).
test("a conversation the model service keeps refusing does not hold the others up, and is set aside for another model to read", { timeout: 30_000 }, async (context) => {
  // The clock runs an hour on at every look, so every wait before another try is over at once.
  let clock = Date.parse("2026-11-10T00:00:00.000Z");
  const asked: string[] = [];
  // A short outage at the start: the first try at each conversation fails, and the model answers nothing.
  let outage = 4;
  const { say, extraction, memories } = await setUp(context, async (model, prompt) => {
    if (reads(prompt)) asked.push(readThisTime(prompt).includes("咖啡") ? "first" : "second");
    if (outage > 0) { outage -= 1; throw new ExtractionModelError("The model service is not reachable."); }
    // Asked whether it answers at all, the model does: the trouble is with the one conversation.
    if (!reads(prompt)) return "好";
    const first = asked.at(-1) === "first";
    if (first && model.id === "strict") throw new ExtractionModelError("The provider refused this request.");
    return JSON.stringify({ changes: [{ do: "add", topic: "preferences", text: first ? "主人爱喝咖啡。" : "主人喜欢喝乌龙茶。", resident: false, from: [1] }], timeline: LINE });
  }, { now: () => (clock += 3_600_000) });
  say("first", [{ entryId: "a1", at: "2026-11-01T02:00:00.000Z", kind: "user", text: "我每天早上都要喝咖啡。" }]);
  say("second", [{ entryId: "b1", at: "2026-11-02T02:00:00.000Z", kind: "user", text: "我喜欢喝乌龙茶。" }]);
  extraction.setModel({ provider: "memory", id: "strict" });
  extraction.start();
  await waitFor(() => extraction.status().skippedParts === 1 && extraction.status().waitingSessions === 0, "The refused conversation was not set aside");
  assert.deepEqual(memories.list({ limit: 10 }).memories.map((memory) => memory.text), ["主人喜欢喝乌龙茶。"], "The other conversation was read");
  assert.deepEqual(asked.slice(0, 2), ["first", "second"], "The other conversation is read right after the refusal, not after the retries");

  extraction.setModel({ provider: "memory", id: "lenient" });
  await waitFor(() => memories.list({ limit: 10 }).memories.length === 2, "The conversation set aside was not read by the next model");
  assert.equal(extraction.status().skippedParts, undefined);
});

// Review of 2026-11-10 (card #295): the background saw only the memories in use, so a conversation read
// again, as after starting over, made anew what the owner had set aside or had her forget.
test("starting over does not bring back what the owner set aside or had her forget", { timeout: 30_000 }, async (context) => {
  let again = false;
  let shown = "";
  const { say, extraction, memories } = await setUp(context, async (_model, prompt, _signal, tools) => {
    const words = readThisTime(prompt);
    if (again) shown += tools!.list[0]!.run({ queries: ["A公司", "花生"] });
    // The model makes of the words what it made of them the first time, whatever its search showed.
    return JSON.stringify({ changes: [
      ...(words.includes("A公司") ? [{ do: "add", topic: "owner", text: "主人在A公司上班。", resident: false, from: [1] }] : []),
      ...(words.includes("花生") ? [{ do: "add", topic: "owner", text: "主人对花生过敏。", resident: false, from: [2] }] : []),
    ], timeline: LINE });
  });
  say("old", [
    { entryId: "u1", at: "2026-10-01T02:00:00.000Z", kind: "user", text: "我在A公司上班。" },
    { entryId: "u2", parentId: "u1", at: "2026-10-01T02:01:00.000Z", kind: "user", text: "对了，我花生过敏。" },
  ]);
  extraction.setModel({ provider: "memory", id: "first" });
  extraction.start();
  await waitFor(() => memories.list({ limit: 10 }).memories.length === 2, "The conversation was not read");
  const [allergy, work] = memories.list({ limit: 10 }).memories;
  memories.update({ id: work!.id, revision: work!.revision, state: "retired" }, "owner");
  memories.update({ id: allergy!.id, revision: allergy!.revision, state: "forgotten" }, "owner");

  again = true;
  extraction.reorganize({ provider: "memory", id: "second" });
  await waitFor(() => shown.length > 0 && extraction.status().waitingSessions === 0, "The conversation was not read again");
  assert.deepEqual(memories.list({ limit: 10 }).memories, [], "Neither is in use again");
  assert.ok(shown.includes("主人在A公司上班。") && shown.includes("主人对花生过敏。"), `The background's search shows what is not to be recorded again: ${shown}`);
});

// Independent review of 2026-11-10 (card #295): a conversation is set aside only when the trouble is its
// own. One call failed for its own reasons, another conversation was read fine, then the model service
// went down: the earlier success must not count as proof that the service works now. And a model that
// answers a short question but can read no conversation at all (its settings, what every reading
// carries) has no trouble with any one of them. Set aside wrongly, a conversation would stay unread
// until the owner chose another model.
test("no conversation is set aside while the model service answers nothing, or while none can be read at all", { timeout: 30_000 }, async (context) => {
  for (const trouble of ["the service goes down", "no reading works"] as const) {
    let clock = Date.parse("2026-11-10T00:00:00.000Z");
    let down = false;
    let failed = 0;
    const { say, extraction, memories } = await setUp(context, async (_model, prompt) => {
      if (down) {
        failed += 1;
        throw new ExtractionModelError("The model service is not reachable.");
      }
      if (!reads(prompt)) return "好";
      if (trouble === "no reading works" || readThisTime(prompt).includes("咖啡")) {
        failed += 1;
        throw new ExtractionModelError("The provider refused this request.");
      }
      // The other conversation is read, and then the service goes down.
      down = true;
      return JSON.stringify({ changes: [{ do: "add", topic: "preferences", text: "主人喜欢喝乌龙茶。", resident: false, from: [1] }], timeline: LINE });
    }, { now: () => (clock += 3_600_000) });
    say("first", [{ entryId: "a1", at: "2026-11-01T02:00:00.000Z", kind: "user", text: "我每天早上都要喝咖啡。" }]);
    say("second", [{ entryId: "b1", at: "2026-11-02T02:00:00.000Z", kind: "user", text: "我喜欢喝乌龙茶。" }]);
    extraction.setModel({ provider: "memory", id: "fixture" });
    extraction.start();
    // Many more failures than it takes to set a conversation aside when the trouble is its own.
    await waitFor(() => failed >= 16, `${trouble}: the conversations were not tried again`);
    const read = trouble === "the service goes down" ? 1 : 0;
    assert.deepEqual([extraction.status().state, extraction.status().skippedParts, extraction.status().waitingSessions], ["failed", undefined, 2 - read], `${trouble}: they wait to be read; nothing is set aside`);
    assert.equal(memories.list({ limit: 10 }).memories.length, read, trouble);
    await extraction.stop();
  }
});

/** One conversation whose first words became a memory and a timeline line, and whose next words are being read while `meanwhile` happens. */
async function readOnWhile(context: TestContext, meanwhile: (made: { memoryId: string; lineId: string }, parts: Awaited<ReturnType<typeof setUp>>) => void, answer: (lineId: string) => object) {
  let round = 0;
  let during = (): void => {};
  let lineId = "";
  const parts = await setUp(context, async () => {
    round += 1;
    if (round === 1) return JSON.stringify({ changes: [{ do: "add", topic: "owner", text: "主人对花生过敏。", resident: false, from: [1] }], timeline: [{ do: "add", text: "聊到主人花生过敏。", from: [1] }] });
    if (round === 2) { during(); return JSON.stringify({ changes: [], timeline: [answer(lineId)] }); }
    return JSON.stringify({ changes: [], timeline: [{ do: "add", text: "说起周末去爬山。", from: [1] }] });
  });
  const { say, extraction, memories, timeline } = parts;
  say("s", [{ entryId: "u1", at: "2026-11-09T02:00:00.000Z", kind: "user", text: "我对花生过敏。" }]);
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  await waitFor(() => memories.list({ limit: 10 }).memories.length === 1 && timeline.list({ limit: 10 }).episodes.length === 1, "The first words were not read");
  lineId = timeline.list({ limit: 10 }).episodes[0]!.id;
  during = () => meanwhile({ memoryId: memories.list({ limit: 10 }).memories[0]!.id, lineId }, parts);
  say("s", [{ entryId: "u2", parentId: "u1", at: "2026-11-09T03:00:00.000Z", kind: "user", text: "周末去爬山吧，多带点吃的。" }]);
  await waitFor(() => round >= 3 && extraction.status().waitingSessions === 0, "The next words were not read again");
  return timeline.list({ limit: 10 }).episodes.map((line) => line.text);
}

// Independent review of 2026-11-10 (card #295): the model is shown the conversation's timeline and her
// memories beside the words it reads. When the owner has her forget something while it reads, what it
// writes may still tell of it, also on a line of its own about the new words. Nothing of that answer
// is kept, and the words are read again without what was forgotten.
test("what she forgets while the background is reading does not come back on the timeline", { timeout: 30_000 }, async (context) => {
  const lines = await readOnWhile(context,
    ({ memoryId }, { memories }) => { memories.update({ id: memoryId, revision: memories.get(memoryId).memory.revision, state: "forgotten" }, "owner"); },
    () => ({ do: "add", text: "商量周末爬山，准备不含花生的吃的。", from: [1] }));
  assert.deepEqual(lines, ["说起周末去爬山。"]);
});

// The same review: a line the owner puts right while the model reads on is not extended from what it
// said before, nor is the old wording kept on a line beside it.
test("a timeline line the owner rewrites while the background is reading is not written over or repeated", { timeout: 30_000 }, async (context) => {
  const lines = await readOnWhile(context,
    ({ lineId }, { timeline }) => { timeline.update({ id: lineId, revision: timeline.get(lineId).revision, text: "主人说起他对花生过敏（其实是轻微不耐受）。" }, "owner"); },
    (lineId) => ({ do: "rewrite", id: lineId, text: "聊到主人花生过敏，后来说起周末去爬山。", from: [1] }));
  assert.deepEqual(lines, ["说起周末去爬山。", "主人说起他对花生过敏（其实是轻微不耐受）。"]);
});
