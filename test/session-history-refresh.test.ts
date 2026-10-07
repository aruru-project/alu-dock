import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHistoryEntry } from "../src/core/agent-worker.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

test("a completed compaction stays visible after a pending session-name history read", async () => {
  // Controlled reproduction of the missing-summary symptom in CI run 37576558805.
  // It proves a baseline defect; that CI log did not record the internal ordering.
  // Standalone instances have no catalog queue.
  const runtime = new DelayedAgentWorkerConnection("history-readback");
  const before: AgentHistoryEntry[] = [{
    recordId: "old", entryId: "old", kind: "message", source: "user", visibility: "conversation",
    content: [{ type: "text", text: "old request" }],
  }];
  const after: AgentHistoryEntry[] = [{
    recordId: "summary", entryId: "summary", kind: "compaction_summary", source: "system", visibility: "conversation",
    content: [{ type: "text", text: "fixture summary" }],
  }];
  runtime.history = before;
  let resolveHistory!: (entries: AgentHistoryEntry[]) => void;
  const pendingHistory = new Promise<AgentHistoryEntry[]>((resolve) => { resolveHistory = resolve; });
  const invoke = runtime.invoke.bind(runtime);
  runtime.invoke = (request, options) => request.type === "session.history" ? pendingHistory : invoke(request, options);
  const compaction = runtime.blockNextCompaction();
  const instance = new ManagedInstance({
    id: "history-instance", hostEpoch: "history-host", cwd: "/tmp/history-readback",
    session: runtime, initialHistory: before,
  });
  try {
    await instance.setSessionName("name-op", "Named");
    const result = instance.compactSession("compact-op");
    await compaction.entered;
    runtime.history = after;
    // Node delivers coalesced IPC messages through nextTick before running the
    // response Promise continuation. Keep the response before the checkpoint,
    // exactly as the ordered Worker transport does; do not reorder wire messages.
    process.nextTick(() => resolveHistory(before));
    process.nextTick(() => compaction.finish());
    assert.equal((await result).summary, "fixture summary");
    const history = await instance.getHistoryPage(undefined, 200);
    assert.deepEqual(history.entries.map((entry) => entry.content), [[{ type: "text", text: "fixture summary" }]]);
  } finally {
    resolveHistory(before);
    compaction.finish();
    await instance.stop("stop-op");
  }
});
