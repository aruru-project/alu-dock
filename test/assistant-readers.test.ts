import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantReaders } from "../src/assistant/readers.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantError, type AssistantRequest } from "../src/core/assistant.js";
import { assistantExtension } from "../src/pi/assistant-extension.js";
import { waitFor } from "./support/plan-goal-provider.js";

async function memoryWithManyEntries(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-readers-"));
  const databasePath = join(root, "memory.sqlite");
  const store = new AssistantStore(databasePath);
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const start = Date.UTC(2026, 10, 1);
  for (let batch = 0; batch < 20; batch += 1) {
    store.record({ sessionId: "s", cwd: "/w" }, Array.from({ length: 1_000 }, (_, index) => {
      const n = batch * 1_000 + index;
      return { entryId: `e${n}`, at: new Date(start + n * 1_000).toISOString(), kind: "user" as const, text: `第${n}条：今天聊了天气和项目进度。`.repeat(4) };
    }), `e${batch * 1_000 + 999}`, {});
  }
  return databasePath;
}

// Data-layer review of 2026-11-07, confirmed on Node 24.22: ending a thread does not stop its running
// SQLite query. The asker hears at the limit; a read it gave up on keeps its thread until it ends,
// and its late result goes to nobody else.
test("a memory search the asker gave up on keeps its thread until it ends, and the next search gets its own answer", async (context) => {
  const databasePath = await memoryWithManyEntries(context);
  const quick = new AssistantReaders({ databasePath, threads: 1, timeoutMs: 1 });
  context.after(() => quick.close());
  // A short word nobody said makes a search read every row, far longer than 1 ms.
  const askedAt = Date.now();
  await assert.rejects(quick.search({ query: "火锅", limit: 5 }), (error: unknown) => error instanceof AssistantError && error.code === "assistant_query_timeout");
  assert.ok(Date.now() - askedAt < 1_000, "The asker heard at the limit, not when the scan ended");

  const readers = new AssistantReaders({ databasePath, threads: 1, timeoutMs: 10_000 });
  context.after(() => readers.close());
  await readers.search({ query: "第0条", limit: 1 });
  // Given up while it runs on the only thread: the asker hears at once.
  const leaving = new AbortController();
  const abandoned = readers.search({ query: "火锅", limit: 5 }, leaving.signal);
  leaving.abort();
  await assert.rejects(abandoned);
  // Given up while waiting behind it: it never runs.
  const waiting = new AbortController();
  const queued = readers.search({ query: "天气", limit: 1 }, waiting.signal);
  waiting.abort();
  await assert.rejects(queued);
  // The next read waits for the thread, then gets its own result, not the abandoned one's empty one.
  const next = await readers.search({ query: "第19999条", limit: 1 });
  assert.deepEqual(next.hits.map((hit) => hit.entryId), ["e19999"]);
});

// Data-layer review of 2026-11-07: an assistant session written while Main was away, then left and
// resumed in the same Work, still has what was said in it recorded once Main is back.
test("an assistant session written while Main was away keeps its conversation after switching away and back", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
  };
  const calls: AssistantRequest[] = [];
  let mainUp = false;
  const port = {
    call: async (request: AssistantRequest) => {
      if (!mainUp) throw new Error("Main is offline");
      calls.push(request);
      if (request.op === "load") return { text: "persona", loadedAt: new Date().toISOString() } as never;
      return (request.op === "recorded" ? {} : { lastEntryId: (request as { throughEntryId: string }).throughEntryId }) as never;
    },
  };
  assistantExtension(port, new Uint8Array(32))(pi as never);
  const sessionA = `away-${Date.now()}`;
  const entriesA: object[] = [];
  const contextOf = (sessionId: string, entries: object[]) => ({
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getSessionName: () => undefined, getCwd: () => "/w", getEntries: () => entries },
    ui: { notify: () => {} },
  });
  const run = async (sessionId: string, entries: object[]) => {
    await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, contextOf(sessionId, entries));
    await handlers.get("agent_settled")!({}, contextOf(sessionId, entries));
  };
  await handlers.get("session_start")!({ reason: "startup" }, contextOf(sessionA, entriesA));
  entriesA.push(
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "离线时说的话" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "离线时的回复" }] } },
  );
  await run(sessionA, entriesA);
  await handlers.get("session_start")!({ reason: "new" }, contextOf(`other-${Date.now()}`, []));
  await handlers.get("session_start")!({ reason: "resume" }, contextOf(sessionA, entriesA));
  mainUp = true;
  await run(sessionA, entriesA);
  await waitFor(() => calls.some((call) => call.op === "record" && call.entries.length > 0), "The session's conversation was not recorded");
  const kept = calls.flatMap((call) => call.op === "record" ? call.entries.map((entry) => entry.text) : []);
  assert.deepEqual(kept, ["离线时说的话", "离线时的回复"]);
});
