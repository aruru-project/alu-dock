import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPiInstance,
  resolvePiReopenTarget,
} from "../src/pi/create-pi-instance.js";

test("real Pi reopens a persisted session as a fresh Dock generation without a model run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-real-reopen-cwd-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "alu-dock-real-reopen-sessions-"));
  const original = await createPiInstance({
    id: "real-reopen",
    creationOperationId: "create-real-reopen",
    hostEpoch: "real-host-one",
    cwd,
    sessionDir,
    projectTrusted: true,
    name: "Persisted reopen fixture",
    tools: [],
  });
  const originalSnapshot = original.snapshot();
  const sessionFile = originalSnapshot.executor.sessionFile;
  assert.ok(sessionFile);
  const createdAt = originalSnapshot.createdAt;
  await original.disposeUnpublished();
  const timestamp = "2026-07-15T00:00:00.000Z";
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: originalSnapshot.executor.piSessionId, timestamp, cwd }),
    JSON.stringify({ type: "session_info", id: "session-info-1", parentId: null, timestamp, name: "Persisted reopen fixture" }),
    "",
  ].join("\n"), { mode: 0o600 });

  const target = await resolvePiReopenTarget(sessionFile);
  assert.equal(target.cwd, cwd);
  const reopened = await createPiInstance({
    id: "real-reopen",
    creationOperationId: "create-real-reopen",
    hostEpoch: "real-host-two",
    cwd: target.cwd,
    sessionDir,
    sessionFile,
    projectTrusted: true,
    initialRuntimeGeneration: 2,
    createdAt,
    reopenedFrom: "host_lost",
    tools: [],
  });
  try {
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.id, "real-reopen");
    assert.equal(snapshot.lifecycle, "active");
    assert.equal(snapshot.execution, "idle");
    assert.equal(snapshot.lastRun, "never");
    assert.equal(snapshot.runtimeGeneration, 2);
    assert.equal(snapshot.executor.sessionFile, sessionFile);
    assert.equal(snapshot.name, "Persisted reopen fixture");
    const events = reopened.eventsSince().events;
    assert.equal(events[0]?.type, "instance.reopened");
    assert.equal(events[0]?.sequence, 1);
    assert.equal(events.some((event) => event.type === "run.started"), false);
    assert.equal(snapshot.metrics?.messages.user, 0);
    assert.equal(snapshot.metrics?.tokens.total, 0);
  } finally {
    await reopened.disposeUnpublished();
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ]);
  }
});
