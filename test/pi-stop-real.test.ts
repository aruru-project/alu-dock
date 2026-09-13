import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createIsolatedPiInstance as createPiInstance } from "./fixtures/isolated-pi-instance.js";

test("real Protocol stop returns immediately after an idle Pi worker exits (card #222)", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-stop-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const socketPath = join(root, "dock.sock");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await chmod(root, 0o700);

  let workerPid = 0;
  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input,
      agentDir,
      sessionDir,
      tools: [],
      onWorkerSpawn: (pid) => { workerPid = pid; },
    }),
    () => "stop-real-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 2_000, longMutationTimeoutMs: 5_000 });

  try {
    await host.start();
    const created = await client.create(cwd, "stop real", "stop-real-create");
    const sessionFile = created.executor.sessionFile;
    assert.ok(sessionFile);
    await writeFile(sessionFile, "Pi session evidence\n");

    const startedAt = performance.now();
    const result = await client.stop(created.id, "stop-real-operation");
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.instance.lifecycle, "stopped");
    assert.equal(result.instance.execution, "unavailable");
    assert.ok(elapsedMs < 1_000, `stop took ${Math.round(elapsedMs)}ms; expected it to return within one second`);
    assert.equal(processExists(workerPid), false, "stop must reap the Pi worker before reporting stopped");
    assert.equal(await readFile(sessionFile, "utf8"), "Pi session evidence\n", "stop must preserve the Pi session file");
    await assert.rejects(
      client.status(created.id),
      (error: unknown) => error instanceof ControlClientError && error.code === "not_found",
    );
  } finally {
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

function processExists(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
