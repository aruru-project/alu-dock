import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantReaders } from "../src/assistant/readers.js";
import { AssistantStore } from "../src/assistant/store.js";
import { AssistantError, type AssistantRequest } from "../src/core/assistant.js";
import { SessionRecorder } from "../src/pi/assistant-extension.js";

// Data-layer review of 2026-11-07, confirmed on Node 24.22: ending a thread does not stop its running
// SQLite query. A search over its time limit must answer the asker at the limit, never hand its late
// result to anyone, and the next search must still be answered.
test("a memory search over its time limit is refused in time, and later searches still get their own answers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-readers-"));
  const databasePath = join(root, "memory.sqlite");
  const store = new AssistantStore(databasePath);
  const start = Date.UTC(2026, 10, 1);
  for (let batch = 0; batch < 20; batch += 1) {
    store.record({ sessionId: "s", cwd: "/w" }, Array.from({ length: 1_000 }, (_, index) => {
      const n = batch * 1_000 + index;
      return { entryId: `e${n}`, at: new Date(start + n * 1_000).toISOString(), kind: "user" as const, text: `第${n}条：今天聊了天气和项目进度。`.repeat(4) };
    }), `e${batch * 1_000 + 999}`, {});
  }
  const readers = new AssistantReaders({ databasePath, threads: 1, timeoutMs: 1 });
  context.after(async () => { await readers.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  // A short word nobody said makes a search read every row, far longer than 1 ms.
  const askedAt = Date.now();
  await assert.rejects(readers.search({ query: "火锅", limit: 5 }), (error: unknown) => error instanceof AssistantError && error.code === "assistant_query_timeout");
  assert.ok(Date.now() - askedAt < 1_000, "The asker heard at the limit, not when the scan ended");
  // Waiting behind the busy thread, or already cancelled, a read ends without running.
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(readers.search({ query: "天气", limit: 1 }, cancelled.signal));

  const patient = new AssistantReaders({ databasePath, threads: 1, timeoutMs: 10_000 });
  context.after(() => patient.close());
  const slow = patient.search({ query: "火锅", limit: 5 });
  const quick = await patient.search({ query: "第19999条", limit: 1 });
  assert.deepEqual(quick.hits.map((hit) => hit.entryId), ["e19999"]);
  assert.deepEqual((await slow).hits, []);
});

// Data-layer review of 2026-11-07: a session resumed into an assistant Work starts her memory where
// it came in, even when Main could not be reached at first; what was said meanwhile is still kept.
test("a resumed session whose first sync fails still keeps what was said after it came in", async () => {
  const entries: object[] = [
    { type: "message", id: "old", parentId: null, timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "旧的历史" } },
  ];
  const session = {
    getSessionId: () => "resumed", getSessionFile: () => undefined, getSessionName: () => undefined, getCwd: () => "/w",
    getEntries: () => entries,
  };
  const calls: AssistantRequest[] = [];
  let mainUp = false;
  const port = {
    call: async (request: AssistantRequest) => {
      if (!mainUp) throw new Error("Main is offline");
      calls.push(request);
      return (request.op === "recorded" ? {} : { lastEntryId: (request as { throughEntryId: string }).throughEntryId }) as never;
    },
  };
  const told: string[] = [];
  const recorder = new SessionRecorder(port, session as never, new Uint8Array(32), "old", (message) => told.push(message));
  await recorder.sync();
  assert.equal(told.length, 1, "The owner hears once that the conversation is not recorded yet");
  entries.push(
    { type: "message", id: "new-user", parentId: "old", timestamp: "2026-11-01T10:05:00.000Z", message: { role: "user", content: "新说的话" } },
    { type: "message", id: "new-reply", parentId: "new-user", timestamp: "2026-11-01T10:05:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "新的回复" }] } },
  );
  mainUp = true;
  await recorder.sync();
  const records = calls.filter((call): call is Extract<AssistantRequest, { op: "record" }> => call.op === "record");
  assert.deepEqual(records.map((call) => [call.throughEntryId, call.entries.map((entry) => entry.text)]), [["old", []], ["new-reply", ["新说的话", "新的回复"]]]);
});
