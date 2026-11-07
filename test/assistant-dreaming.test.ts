import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantDocuments } from "../src/assistant/documents.js";
import { AssistantExtraction } from "../src/assistant/extraction.js";
import type { ModelPrompt } from "../src/assistant/extraction-prompt.js";
import { AssistantMemories } from "../src/assistant/memories.js";
import { AssistantStore } from "../src/assistant/store.js";
import { waitFor } from "./support/plan-goal-provider.js";

// Card #295, with "Components of agent memory" (Anthropic, 2026): what extraction keeps is later
// checked against the words it came from, merged where it repeats itself, and the part loaded every
// session kept small; neither pass changes what the owner set.
test("her memories are checked against what was said and merged, and what the owner set stays as it is", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dreaming-"));
  const store = new AssistantStore(join(root, "memory.sqlite"));
  const documents = new AssistantDocuments(root);
  await documents.initialize();
  const memories = new AssistantMemories(store.connection);
  const prompts: ModelPrompt[] = [];
  let owners = "";
  const extraction = new AssistantExtraction(store.connection, memories, documents, {
    complete: async (_model, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return JSON.stringify({ changes: [
          { do: "add", topic: "owner", text: "主人最近常熬夜。", resident: true, from: [1] },
          { do: "add", topic: "owner", text: "主人又熬夜到两点。", resident: true, from: [3] },
          { do: "add", topic: "preferences", text: "主人睡前总要刷B站。", resident: true, from: [4] },
          { do: "rewrite", id: owners, text: "主人养了一只猫。", from: [1] },
        ] });
      }
      const [habit, second, first] = memories.list({ limit: 10, author: "extraction" }).memories.map((memory) => memory.id);
      return `整理好了：\n${JSON.stringify({ changes: [
        { do: "merge", ids: [second, first], text: "主人这阵子常熬夜到凌晨两点，多半是项目赶的。", resident: false },
        { do: "retire", id: owners },
        // Two changes to one memory in one reply both count.
        { do: "rewrite", id: habit, text: "主人睡前习惯刷一会儿 B 站。" },
        { do: "resident", id: habit, resident: false },
      ] })}`;
    },
  }, { idleMs: 0, busyChars: 1e9, chunkChars: 24_000, tickMs: 10, quietMs: 0, dreamChanges: 1, dreamIntervalMs: 1e15 });
  context.after(async () => { await extraction.stop(); store.close(); await rm(root, { recursive: true, force: true }); });

  owners = memories.add({ topic: "owner", text: "主人的猫叫团子。", resident: true }, "owner").id;
  store.record({ sessionId: "s", cwd: "/w" }, [
    { entryId: "u1", at: "2026-11-05T15:00:00.000Z", kind: "user", text: "我最近每天都熬夜到两点，项目赶不完。" },
    { entryId: "a1", parentId: "u1", at: "2026-11-05T15:00:05.000Z", kind: "assistant", text: "啧，又熬？身体要紧。" },
    { entryId: "u2", parentId: "a1", at: "2026-11-06T18:00:00.000Z", kind: "user", text: "今天又熬到两点了。" },
    { entryId: "u3", parentId: "u2", at: "2026-11-06T18:01:00.000Z", kind: "user", text: "睡前我一般刷会儿B站。" },
  ], "u3", {});
  extraction.setModel({ provider: "memory", id: "fixture" });
  extraction.start();
  // One dream applies all its changes at once.
  await waitFor(() => memories.list({ limit: 10, author: "dreaming" }).memories.length > 0, "The memories were not tidied");

  // The tidying pass saw each new memory with the words it came from, and what the owner set as his.
  assert.ok(prompts[1]!.prompt.includes("主人：我最近每天都熬夜到两点，项目赶不完。"), "Dreaming checks a memory against where it was said");
  assert.ok(prompts[1]!.prompt.includes("主人定的）主人的猫叫团子。"), "Dreaming is told what the owner set");
  const inUse = memories.list({ limit: 10 }).memories;
  assert.deepEqual(inUse.map((memory) => [memory.text, memory.resident, memory.author]), [
    ["主人这阵子常熬夜到凌晨两点，多半是项目赶的。", false, "dreaming"],
    ["主人睡前习惯刷一会儿 B 站。", false, "dreaming"],
    ["主人的猫叫团子。", true, "owner"],
  ]);
  assert.deepEqual(inUse[0]!.sources.map((source) => source.entryId), ["u1", "u2"], "A merged memory keeps every place its parts were said");
  const retired = memories.list({ limit: 10, state: "retired" }).memories;
  assert.deepEqual(retired.map((memory) => memory.supersededBy), [inUse[0]!.id, inUse[0]!.id]);
  // Card #295, review of 2026-11-07: forgetting a part that lives on in a merged memory would forget nothing; she is told which one to forget.
  assert.throws(() => memories.update({ id: retired[0]!.id, revision: retired[0]!.revision, state: "forgotten" }, "owner"), (error: unknown) => (error as { code?: string }).code === "assistant_memory_merged");
  assert.equal(memories.get(inUse[0]!.id).memory.state, "active");
  // Its own changes are not tidied again: without this the passes would call the model forever.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(prompts.length, 2);
});
