import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";

async function startFixture(socketPath: string, catalogPath: string, cwd: string, epoch: string, env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    new URL("./fixtures/durable-host.js", import.meta.url).pathname,
    socketPath,
    catalogPath,
    cwd,
    epoch,
  ], { stdio: ["ignore", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdout?.resume();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited before ready: ${stderr}`);
    try {
      const ping = await new DockClient({ socketPath, timeoutMs: 100 }).ping();
      if (ping.hostEpoch === epoch) return child;
    } catch (error) {
      if (!(error instanceof ControlClientError)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  child.kill("SIGKILL");
  throw new Error(`fixture did not become ready: ${stderr}`);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
}

test("SIGKILL/restart never replays queued work and SIGTERM persists reopenable host loss", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-process-"));
  await chmod(cwd, 0o700);
  const socketPath = join(cwd, "dock.sock");
  const catalogPath = join(cwd, "state", "catalog.json");
  const children = new Set<ChildProcess>();
  context.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
  });

  const first = await startFixture(socketPath, catalogPath, cwd, "epoch-crash");
  children.add(first);
  const firstClient = new DockClient({ socketPath });
  const created = await firstClient.create(cwd, "crash fixture", "create-process");
  await firstClient.prompt(created.id, "old prompt", "prompt", "run-process");
  const queued = await firstClient.prompt(created.id, "old follow-up", "followUp", "queue-process");
  assert.equal(queued.receipt.queued, true);
  first.kill("SIGKILL");
  const killed = await waitForExit(first);
  assert.equal(killed.signal, "SIGKILL");

  const second = await startFixture(socketPath, catalogPath, cwd, "epoch-reconcile");
  children.add(second);
  const secondClient = new DockClient({ socketPath });
  const info = await secondClient.hostInfo();
  assert.match(info.diagnostics[0]?.message ?? "", /normalized 1 prior live record/);
  const lost = await secondClient.status(created.id);
  assert.equal(lost.lifecycle, "host_lost");
  assert.equal(lost.execution, "unavailable");
  assert.equal(lost.lastRun, "interrupted");
  assert.equal(lost.pending.total, 0);
  assert.equal(lost.activeCommandId, undefined);
  assert.equal(lost.interruption?.reason, "host_crash");
  assert.equal(lost.reopenable, true);

  const reopened = await secondClient.reopen(created.id, "reopen-process");
  assert.equal(reopened.instance.runtimeGeneration, 2);
  assert.equal(reopened.instance.lastRun, "never");
  assert.deepEqual(reopened.instance.metrics?.messages, { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 });
  assert.equal(reopened.instance.metrics?.tokens.total, 0);
  second.kill("SIGTERM");
  const stopped = await waitForExit(second);
  assert.equal(stopped.code, 0);

  const third = await startFixture(socketPath, catalogPath, cwd, "epoch-graceful");
  children.add(third);
  const thirdClient = new DockClient({ socketPath });
  const graceful = await thirdClient.status(created.id);
  assert.equal(graceful.lifecycle, "host_lost");
  assert.equal(graceful.lastRun, "never");
  assert.equal(graceful.runtimeGeneration, 2);
  assert.equal(graceful.interruption?.reason, "host_shutdown");
  third.kill("SIGTERM");
  assert.equal((await waitForExit(third)).code, 0);
  assert.equal((await lstat(catalogPath)).mode & 0o777, 0o600);
});

test("SIGTERM waits for an admitted create before durable host-loss drain", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "alu-dock-create-race-"));
  await chmod(cwd, 0o700);
  const socketPath = join(cwd, "dock.sock");
  const catalogPath = join(cwd, "state", "catalog.json");
  const children = new Set<ChildProcess>();
  context.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
  });

  const first = await startFixture(socketPath, catalogPath, cwd, "create-race-one", {
    ...process.env,
    ALU_DOCK_FIXTURE_CREATE_DELAY_MS: "200",
  });
  children.add(first);
  const creating = new DockClient({ socketPath }).create(cwd, "create race", "create-race-operation");
  void creating.catch(() => {});
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  first.kill("SIGTERM");
  await assert.rejects(creating, (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown");
  assert.equal((await waitForExit(first)).code, 0);

  const second = await startFixture(socketPath, catalogPath, cwd, "create-race-two");
  children.add(second);
  const records = await new DockClient({ socketPath }).list();
  const recovered = records.find((record) => record.creationOperationId === "create-race-operation");
  assert.ok(recovered);
  assert.equal(recovered.lifecycle, "host_lost");
  assert.equal(recovered.lastRun, "never");
  assert.equal(recovered.reopenable, true);
  second.kill("SIGTERM");
  assert.equal((await waitForExit(second)).code, 0);
});
