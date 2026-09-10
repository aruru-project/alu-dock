import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WindowsHostLifecycleStatus } from "../src/deployment/windows-host-lifecycle.js";
import {
  readWindowsHostLifecycleStatus,
  requestWindowsHostStop,
  WindowsHostLifecycleServer,
} from "../src/deployment/windows-host-lifecycle.js";
import { WindowsUserHostManager } from "../src/deployment/windows-user-host.js";

test("Windows Host reports live SubHost status and stops even with an idle status client", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-windows-lifecycle-"));
  const endpoint = join(root, "host.sock");
  const server = new WindowsHostLifecycleServer({ platform: "win32", endpoint });
  let idle: ReturnType<typeof createConnection> | undefined;
  try {
    await server.start();
    idle = createConnection(endpoint);
    idle.resume();
    await once(idle, "connect");
    assert.deepEqual(await readWindowsHostLifecycleStatus(1_000, endpoint), { ready: false, phase: "starting", pid: process.pid, blockingWork: 0 });
    let blockingWork = 2;
    let beganStopping = 0;
    let mainConnected = false;
    server.markReady("fixture-epoch", "subhost", () => blockingWork, () => { beganStopping += 1; }, () => ({ mainConnected, restoringWorks: false, unavailableWorks: 1 }));
    assert.deepEqual(await readWindowsHostLifecycleStatus(1_000, endpoint), {
      ready: true,
      phase: "ready",
      pid: process.pid,
      hostEpoch: "fixture-epoch",
      role: "subhost",
      blockingWork: 2,
      mainConnected: false,
      restoringWorks: false,
      unavailableWorks: 1,
    });
    mainConnected = true;
    assert.equal((await readWindowsHostLifecycleStatus(1_000, endpoint))?.mainConnected, true);
    assert.equal((await requestWindowsHostStop(1_000, endpoint))?.stopAccepted, false);
    assert.equal(beganStopping, 0);

    blockingWork = 0;
    const stopping = server.waitForStop();
    assert.equal((await requestWindowsHostStop(1_000, endpoint))?.stopAccepted, true);
    assert.equal(beganStopping, 1);
    await stopping;
    assert.equal((await readWindowsHostLifecycleStatus(1_000, endpoint))?.phase, "stopping");
    assert.equal((await readWindowsHostLifecycleStatus(1_000, endpoint))?.ready, false);
    await server.stop();
  } finally {
    idle?.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("#270 slow Windows startup stays observable and retry does not launch another Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-windows-host-manager-"));
  try {
    const cliPath = join(root, "cli.js"), setupPath = join(root, ".windows-host"), logPath = join(root, "logs", "host.log");
    await mkdir(root, { recursive: true });
    await writeFile(cliPath, "// fixture\n", "utf8");
    const ownerPath = join(root, "host-owner.json");
    await writeFile(ownerPath, JSON.stringify({ pid: 0, exited: true }));
    let current: WindowsHostLifecycleStatus | undefined;
    let launches = 0, stops = 0;
    const manager = new WindowsUserHostManager({
      timeoutMs: 1,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath,
      setupPath,
      logPath,
      readStatus: async () => current,
      requestStop: async () => {
        stops += 1;
        const previous = current;
        if (!previous) return undefined;
        if (previous.blockingWork > 0) return { ...previous, stopAccepted: false };
        current = undefined;
        return { ...previous, stopAccepted: true };
      },
      launch: async () => { launches += 1; current = { ready: false, phase: "starting", pid: 42 + launches, blockingWork: 0 }; },
      sleep: async () => {},
    });

    const installed = await manager.install(true);
    assert.equal(stops, 0);
    assert.equal(launches, 1);
    assert.equal(installed.ready, false);
    assert.equal(installed.subState, "starting");
    await manager.start();
    assert.equal(launches, 1);
    current = { ready: true, phase: "ready", pid: 43, hostEpoch: "new-epoch-1", role: "main", blockingWork: 0 };
    assert.equal((await manager.status()).ready, true);

    const restarted = await manager.restart();
    assert.equal(stops, 1);
    assert.equal(launches, 2);
    assert.equal(restarted.subState, "starting");

    current = { ready: true, pid: 99, hostEpoch: "busy-epoch", role: "main", blockingWork: 1 };
    await assert.rejects(manager.stop(), /1 work item is still active/u);
    assert.equal(stops, 1, "a Host with active work is not asked to stop");
    current.blockingWork = 0;
    const stopped = await manager.stop();
    assert.equal(stops, 2);
    assert.equal(stopped.ready, false);
    assert.equal(stopped.activeState, "inactive");
    const status = await manager.status();
    assert.equal(status.installed, true);
    assert.equal(status.logsPath, logPath);

    // Installer safety uses the Host storage reader, not a second JSON schema.
    const attachmentDirectory = join(root, "custom-attachments");
    await writeFile(join(root, "attachment-storage.json"), JSON.stringify({ schemaVersion: 1, revision: 0, directory: attachmentDirectory }));
    const storageStatus = await manager.status();
    assert.equal(storageStatus.attachmentDirectory, attachmentDirectory);
    assert.equal(storageStatus.stateDirectory, root);

    // #270: a missing pipe with an unconfirmed launch is not a stopped Host.
    await writeFile(ownerPath, JSON.stringify({ launching: true }));
    assert.equal((await manager.status()).subState, "unknown");
    await assert.rejects(manager.stop());
    await writeFile(ownerPath, JSON.stringify({ pid: 0, exited: true }));
    const removed = await manager.uninstall();
    assert.equal(removed.removed, true);
    assert.equal((await manager.status()).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #270: stop during Pi/settings initialization must latch before ready/recovery.
test("Windows stop during startup cannot become ready afterwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-windows-early-stop-"));
  const endpoint = join(root, "host.sock");
  const server = new WindowsHostLifecycleServer({ platform: "win32", endpoint });
  try {
    await server.start();
    const duplicate = new WindowsHostLifecycleServer({ platform: "win32", endpoint });
    await assert.rejects(duplicate.start());
    assert.equal((await requestWindowsHostStop(1_000, endpoint))?.stopAccepted, true);
    let cancelled = false;
    server.onStartingStop(() => { cancelled = true; });
    server.markReady("late", "main", () => 0, () => {});
    assert.equal(cancelled, true);
    assert.equal(server.stopRequested, true);
    const observed = await readWindowsHostLifecycleStatus(1_000, endpoint);
    assert.equal(observed?.phase, "stopping");
    assert.equal(observed?.ready, false);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
