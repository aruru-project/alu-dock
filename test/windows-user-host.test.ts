import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("Windows Host lifecycle reports readiness and requests a normal stop over its private endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-windows-lifecycle-"));
  const endpoint = join(root, "host.sock");
  const server = new WindowsHostLifecycleServer({ platform: "win32", endpoint });
  try {
    await server.start();
    assert.deepEqual(await readWindowsHostLifecycleStatus(1_000, endpoint), { ready: false, pid: process.pid, blockingWork: 0 });
    server.markReady("fixture-epoch", "subhost", () => 2);
    assert.deepEqual(await readWindowsHostLifecycleStatus(1_000, endpoint), {
      ready: true,
      pid: process.pid,
      hostEpoch: "fixture-epoch",
      role: "subhost",
      blockingWork: 2,
    });
    const stopping = server.waitForStop();
    assert.equal((await requestWindowsHostStop(1_000, endpoint))?.ready, true);
    await stopping;
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows local Host install replaces the running Host and returns only after the new one is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-windows-host-manager-"));
  try {
    const cliPath = join(root, "cli.js"), setupPath = join(root, ".windows-host");
    await mkdir(root, { recursive: true });
    await writeFile(cliPath, "// fixture\n", "utf8");
    let current: WindowsHostLifecycleStatus | undefined = { ready: true, pid: 41, hostEpoch: "old-epoch", role: "main", blockingWork: 0 };
    let launches = 0, stops = 0;
    const manager = new WindowsUserHostManager({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath,
      setupPath,
      readStatus: async () => current,
      requestStop: async () => { stops += 1; const previous = current; current = undefined; return previous; },
      launch: async () => { launches += 1; current = { ready: true, pid: 42 + launches, hostEpoch: `new-epoch-${launches}`, role: "main", blockingWork: 0 }; },
      sleep: async () => {},
    });

    const installed = await manager.install(true);
    assert.equal(stops, 1);
    assert.equal(launches, 1);
    assert.equal(installed.ready, true);
    assert.equal(installed.hostEpoch, "new-epoch-1");

    const restarted = await manager.restart();
    assert.equal(stops, 2);
    assert.equal(launches, 2);
    assert.equal(restarted.hostEpoch, "new-epoch-2");

    const stopped = await manager.stop();
    assert.equal(stopped.ready, false);
    assert.equal(stopped.activeState, "inactive");
    assert.equal((await manager.status()).installed, true);

    const removed = await manager.uninstall();
    assert.equal(removed.removed, true);
    assert.equal((await manager.status()).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
