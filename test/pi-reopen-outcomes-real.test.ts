import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

// RC67 Continue incident: exercise the user's existing Work through the real Host and Pi
// Worker. Only the provider is offline; a local extension holds startup when requested.
test("Continue reports failed startup, releases it, and a lost reply can finish the same Work and session", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-reopen-outcomes-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(join(agentDir, "extensions"), { recursive: true })]);
  const systemPath = join(agentDir, "SYSTEM.md");
  await writeFile(systemPath, "An offline recovery fixture.");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "offline", defaultModel: "fixture" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { offline: {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-offline-fixture",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const holdFile = join(root, "hold"), enteredFile = join(root, "entered");
  await writeFile(join(agentDir, "extensions", "hold-startup.ts"), `
import { existsSync, writeFileSync } from "node:fs";
export default async function () {
  if (!existsSync(${JSON.stringify(holdFile)})) return;
  writeFileSync(${JSON.stringify(enteredFile)}, String(process.pid));
  await new Promise(resolve => {
    const timer = setInterval(() => { if (!existsSync(${JSON.stringify(holdFile)})) { clearInterval(timer); resolve(); } }, 10);
  });
}
`);
  const seed = SessionManager.create(cwd, sessionDir);
  seed.appendModelChange("offline", "fixture");
  seed.appendMessage({ role: "user", content: "Saved question", timestamp: 1 });
  seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved answer" }], api: "openai-completions",
    provider: "offline", model: "fixture", stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const sessionFile = seed.getSessionFile()!;
  const spawned: number[] = [];
  const store = new FileCatalogStore(join(root, "catalog.json"));
  const makeRegistry = () => new DockRegistry((input) => createPiInstance({ ...input, agentDir, sessionDir,
    workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir }),
    workerTimeouts: { startupMs: 3_000, termMs: 300 }, onWorkerSpawn: (pid) => spawned.push(pid),
  }), undefined, { catalogStore: store, reopenTargetResolver: { resolve: resolvePiReopenTarget } });
  const makeHost = () => {
    const registry = makeRegistry();
    return new DockHost({ socketPath: join(root, "dock.sock"), registry, initialize: () => registry.initializeCatalog() });
  };
  let host = makeHost();
  const client = new DockClient({ socketPath: host.socketPath, timeoutMs: 10_000 });
  const interrupted = new DockClient({ socketPath: host.socketPath, timeoutMs: 10_000 });
  const waitFor = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 5_000;
    while (!await condition()) {
      assert.ok(Date.now() < deadline, "the recovery step finishes within its existing deadline");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const pidGone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  try {
    await host.start();
    let work = await client.create(cwd, "Continue fixture", "create", undefined, undefined,
      { model: { provider: "offline", id: "fixture" }, systemSelection: { kind: "global-system", path: systemPath } });
    work = (await client.switchSession(work.id, sessionFile)).instance;
    const crash = async () => {
      process.kill(spawned.at(-1)!, "SIGKILL");
      await waitFor(async () => (await client.status(work.id)).lifecycle === "runtime_error");
    };
    await crash();

    await rm(systemPath);
    await assert.rejects(client.reopen(work.id, "missing-system"), (error: unknown) => {
      assert.ok(error instanceof ControlClientError);
      assert.equal(error.code, "resource_unavailable");
      assert.ok(error.message.includes(systemPath), "startup identifies the original file to restore");
      return true;
    });
    assert.equal(pidGone(spawned.at(-1)!), true, "failed startup has released its process before another Continue");
    await writeFile(systemPath, "An offline recovery fixture.");

    await writeFile(holdFile, "hold");
    const stalled = client.reopen(work.id, "stalled-extension");
    const stalledFailure = assert.rejects(stalled, (error: unknown) => {
      assert.ok(error instanceof ControlClientError);
      assert.equal(error.code, "runtime_unavailable");
      return true;
    });
    await waitFor(async () => readFile(enteredFile).then(() => true, () => false));
    const observedFailure = assert.rejects(client.read(work.id), { code: "runtime_unavailable" });
    void observedFailure.catch(() => {});
    await client.ping();
    assert.equal((await client.status(work.id)).lifecycle, "runtime_error", "Host status stays available during startup");
    await Promise.all([stalledFailure, observedFailure]);
    assert.equal(pidGone(spawned.at(-1)!), true, "a hung startup is stopped before its wait ends");
    assert.equal((await client.status(work.id)).reopenable, true);
    await rm(enteredFile);

    const before = spawned.length;
    const pending = interrupted.reopen(work.id, "continue-after-timeout");
    const lostReply = assert.rejects(pending, (error: unknown) => error instanceof ControlClientError && error.code === "effect_unknown");
    await waitFor(async () => readFile(enteredFile).then(() => true, () => false));
    interrupted.closeActiveConnections();
    await lostReply;
    // This is the one-shot refresh used by the old UI: startup is still pending.
    const whileStarting = (await client.list()).find((item) => item.id === work.id)!;
    assert.equal(whileStarting.lifecycle, "runtime_error");
    await assert.rejects(client.reopen(work.id, "second-click"), { code: "instance_busy" });
    const observed = client.read(work.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(holdFile);
    const continued = (await observed).instance;
    assert.equal(continued.lifecycle, "active", "one observation waits for the already accepted Continue, without sending it again");
    assert.equal(spawned.length, before + 1, "a lost reply and another click do not duplicate the Worker");
    assert.equal(continued.id, work.id);
    assert.equal(continued.executor.sessionFile, sessionFile);
    assert.equal(continued.executor.piSessionId, work.executor.piSessionId);
    assert.equal(continued.runtimeGeneration, work.runtimeGeneration + 1);
    assert.ok((await client.history(work.id)).entries.some((entry) => entry.content.some((block) => block.type === "text" && block.text === "Saved answer")));
    assert.equal((await client.reopen(work.id, "continue-after-timeout")).instance.runtimeGeneration, continued.runtimeGeneration);
    assert.equal((await client.list()).length, 1);

    // A saved conversation's model choice belongs to Pi, not the creation-time
    // model. Losing that provider must still allow opening and using its picker.
    const modelsPath = join(agentDir, "models.json");
    const models = await readFile(modelsPath, "utf8");
    await rm(modelsPath);
    await crash();
    const withoutModel = (await client.reopen(work.id, "provider-removed")).instance;
    assert.equal(withoutModel.lifecycle, "active");
    assert.equal(withoutModel.executor.piSessionId, work.executor.piSessionId);
    assert.equal((await client.models(work.id)).models.length, 0, "the model picker is reachable even with no available provider");
    await writeFile(modelsPath, models);
    await client.reloadSession(work.id);
    const selectedModel = await client.setModel(work.id, "offline", "fixture");
    assert.deepEqual(selectedModel.instance.executor.model, { provider: "offline", id: "fixture" });

    await host.stop(); host = makeHost(); await host.start();
    assert.equal((await client.status(work.id)).lifecycle, "host_lost");
    await rm(enteredFile, { force: true }); await writeFile(holdFile, "hold");
    const afterRestart = client.reopen(work.id, "after-host-restart");
    await waitFor(async () => readFile(enteredFile).then(() => true, () => false));
    const restoredRead = client.read(work.id);
    await rm(holdFile);
    await afterRestart;
    assert.equal((await restoredRead).instance.executor.piSessionId, work.executor.piSessionId,
      "an admitted Continue after Host restart is observable even before a live instance exists");
  } finally {
    await rm(holdFile, { force: true });
    client.closeActiveConnections(); interrupted.closeActiveConnections();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
