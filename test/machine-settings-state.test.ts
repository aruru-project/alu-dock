import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { currentMachineRole, MachineSettingsState, SubHostStatusReporter } from "../src/control/machine-settings-state.js";

async function temporaryState(): Promise<{ state: MachineSettingsState; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-settings-"));
  return { state: new MachineSettingsState(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Card #260 status contention keeps the last observation and a later shutdown clear cannot be resurrected", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-status-order-"));
  let mode: "pass" | "fail" | "block" = "pass";
  let enteredBlock!: () => void;
  let releaseBlock!: () => void;
  const blockEntered = new Promise<void>((resolve) => { enteredBlock = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseBlock = resolve; });
  const state = new MachineSettingsState(root, {
    fault: async (_phase, path) => {
      if (path !== state.subHostStatusPath) return;
      if (mode === "fail") throw Object.assign(new Error("status file is held"), { code: "EPERM" });
      if (mode === "block") { enteredBlock(); await blocked; }
    },
  });
  try {
    await state.writeSubHostStatus({ hostEpoch: "ordering-epoch", connected: false });
    const first = await state.readSubHostStatus();
    mode = "fail";
    await assert.rejects(state.writeSubHostStatus({ hostEpoch: "ordering-epoch", connected: true }), /could not replace its machine state/u);
    const preserved = await state.readSubHostStatus();
    assert.equal(preserved.connected, false);
    assert.equal(preserved.updatedAt, first.updatedAt, "a failed replacement leaves the prior valid status intact");

    mode = "block";
    const lateWrite = state.writeSubHostStatus({ hostEpoch: "ordering-epoch", connected: true });
    await blockEntered;
    const clear = state.clearSubHostStatus("ordering-epoch");
    releaseBlock();
    await Promise.all([lateWrite, clear]);
    await assert.rejects(lstat(state.subHostStatusPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Card #260 repeated unchanged status does not bypass persistence retry backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-status-retry-"));
  let replacementAttempts = 0;
  let reportFailure!: () => void;
  const failureReported = new Promise<void>((resolve) => { reportFailure = resolve; });
  const state = new MachineSettingsState(root, {
    fault: (_phase, path) => {
      if (path === state.subHostStatusPath) {
        replacementAttempts += 1;
        throw Object.assign(new Error("status file is held"), { code: "EPERM" });
      }
    },
  });
  const reporter = new SubHostStatusReporter({ state, hostEpoch: "retry-epoch", onError: reportFailure });
  let failureTimeout: NodeJS.Timeout | undefined;
  try {
    reporter.update(false);
    await Promise.race([
      failureReported,
      new Promise<never>((_resolve, reject) => { failureTimeout = setTimeout(() => reject(new Error("status failure was not reported")), 3_000); }),
    ]);
    if (failureTimeout) clearTimeout(failureTimeout);
    const attemptsAfterFailure = replacementAttempts;

    reporter.update(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(replacementAttempts, attemptsAfterFailure, "unchanged status preserves the scheduled retry delay");
  } finally {
    if (failureTimeout) clearTimeout(failureTimeout);
    await reporter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Card #260 rejects a replaced private state root before following it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "alu-machine-root-replacement-"));
  const root = join(parent, "machines");
  const movedRoot = join(parent, "original-machines");
  const outside = join(parent, "outside");
  const state = new MachineSettingsState(root);
  try {
    await state.writeSubHostStatus({ hostEpoch: "root-replacement", connected: true });
    await rename(root, movedRoot);
    await mkdir(outside);
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      state.writeSubHostStatus({ hostEpoch: "root-replacement", connected: false }),
      /Machine settings directory is invalid/u,
    );
    await assert.rejects(lstat(join(outside, "subhost-status.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a saved role applies on the next startup while the live process keeps its current surface", async () => {
  const fixture = await temporaryState();
  try {
    const initial = await fixture.state.read();
    assert.equal(initial.role, "main");
    assert.equal(initial.main.connectionsEnabled, false);

    await fixture.state.writeMainConnections({ enabled: true, port: 43127 });
    await fixture.state.writeMainAdvertisedAddress("main.lan");
    const subhost = await fixture.state.switchToSubHost({ mainAddress: "main.lan", port: 43127, name: "Studio" });
    assert.equal(subhost.role, "subhost");
    assert.deepEqual(subhost.subhost, { mainAddress: "main.lan", port: 43127, name: "Studio" });
    assert.equal(currentMachineRole(subhost, { connected: false }, true), "main");
    assert.equal(currentMachineRole(subhost, { connected: false }, false), "subhost");

    const main = await fixture.state.switchToMain();
    assert.equal(main.role, "main");
    assert.equal(main.main.connectionsEnabled, true);
    assert.equal(main.main.advertisedAddress, "main.lan");
    assert.deepEqual(main.subhost, { mainAddress: "main.lan", port: 43127, name: "Studio" });
    assert.equal((await fixture.state.read()).role, "main");
    assert.equal(currentMachineRole(main, { connected: true, processId: 42 }, false), "subhost");
  } finally {
    await fixture.cleanup();
  }
});
