import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { terminateDetachedProcessTree } from "../src/pi/worker-process.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

test("Worker cleanup terminates a descendant forked during the Linux process scan", async (context) => {
  if (process.platform !== "linux") { context.skip("Linux procfs race"); return; }
  // 2026-10-31 review reproduction: a SIGTERM-resistant descendant forks after
  // the PID snapshot, then exits before stat is read. Retained zombies used to
  // let cleanup succeed while the new descendant was still running.
  const root = await fs.mkdtemp(join(tmpdir(), "alu-fork-cleanup-"));
  const originalPidFile = join(root, "original.pid");
  const newPidFile = join(root, "new.pid");
  const newChildScript = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
require('node:fs').writeFileSync(${JSON.stringify(newPidFile)}, String(process.pid));
process.send('ready');
`;
  const originalChildScript = `
process.on('SIGTERM', () => {});
process.once('SIGUSR2', () => {
  const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(newChildScript)}], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  child.once('message', () => process.exit(0));
});
setInterval(() => {}, 1000);
require('node:fs').writeFileSync(${JSON.stringify(originalPidFile)}, String(process.pid));
`;
  const worker = spawn(process.execPath, ["-e", `
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(originalChildScript)}], {stdio: 'ignore'});
setInterval(() => {}, 1000);
`], { detached: true, stdio: "ignore", env: isolatedProcessEnvironment(root) });
  const originalReaddir = fs.readdir;
  let injected = false;
  try {
    await waitUntil(async () => await fs.stat(originalPidFile).then(() => true, () => false));
    const originalPid = Number(await fs.readFile(originalPidFile, "utf8"));
    // Pause only the real procfs snapshot; process creation, signals, process
    // state, and the production cleanup entrypoint remain real.
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await originalReaddir(...args);
      if (args[0] === "/proc" && !injected) {
        injected = true;
        process.kill(originalPid, "SIGUSR2");
        await waitUntil(async () => !await canRun(originalPid));
        const newPid = Number(await fs.readFile(newPidFile, "utf8"));
        assert.equal((entries as unknown as string[]).includes(String(newPid)), false);
        assert.equal(await canRun(newPid), true);
      }
      return entries;
    }) as typeof fs.readdir;
    syncBuiltinESMExports();
    await terminateDetachedProcessTree(worker, 300);
    assert.equal(injected, true);
    const newPid = Number(await fs.readFile(newPidFile, "utf8"));
    assert.equal(await canRun(newPid), false, "cleanup must not leave the newly forked descendant running");
  } finally {
    fs.readdir = originalReaddir;
    syncBuiltinESMExports();
    try { process.kill(-worker.pid!, "SIGKILL"); } catch { /* Already gone. */ }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function canRun(pid: number): Promise<boolean> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const state = /^State:\s+(\S)/mu.exec(status)?.[1];
    assert.ok(state);
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "process handshake must finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
