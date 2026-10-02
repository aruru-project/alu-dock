import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MachineSettingsState, machineSettingsStateRoot } from "../src/control/machine-settings-state.js";
import { machineStateRoot, MainMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForRemote(client: DockClient, operationId: string): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const found = (await client.list("all")).find((item) => item.creationOperationId === operationId && item.lifecycle === "active");
      if (found) return found;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`remote Work ${operationId} did not appear`);
}

async function waitForMachine(client: DockClient, hostId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const machine = (await client.machines()).machines.find((item) => item.hostId === hostId);
      if (machine?.available) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("SubHost did not reconnect");
}

async function waitForConnectedStatus(state: MachineSettingsState, after?: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await state.readSubHostStatus();
    if (status.connected && status.updatedAt && status.updatedAt !== after) return status.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("SubHost status did not reconcile");
}

async function startWindowsSharingLock(path: string, childEnv: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$stream = [System.IO.File]::Open($env:ALU_DOCK_TEST_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)",
    "[Console]::Out.WriteLine('locked')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const lock = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...childEnv, ALU_DOCK_TEST_LOCK_PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  lock.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  lock.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  lock.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("locked") && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (lock.exitCode !== null) throw new Error(`Windows sharing lock exited early (${String(lock.exitCode)}): ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!stdout.includes("locked")) {
    lock.kill();
    throw new Error(`Windows sharing lock did not become ready: ${stderr}`);
  }
  return lock;
}

async function releaseWindowsSharingLock(lock: ChildProcess): Promise<void> {
  if (lock.exitCode !== null || lock.signalCode !== null) return;
  lock.stdin?.end("\n");
  const exited = await Promise.race([
    waitForExit(lock).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!exited && lock.exitCode === null && lock.signalCode === null) {
    lock.kill();
    await Promise.race([waitForExit(lock), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
}

// Regression for Card #260: an observational status replacement failure must not
// terminate the SubHost or prevent its real machine link and Work from recovering.
test("temporary SubHost status contention does not interrupt Work recovery or new Work creation", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-subhost-status-recovery-"));
  const workspace = join(root, "workspace");
  const mainCatalog = join(root, "main", "catalog.json");
  const subCatalog = join(root, "sub", "catalog.json");
  const joinPath = join(root, "join.json");
  const faultPath = join(root, "hold-status-replacement");
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\alu-dock-status-recovery-${randomUUID()}`
    : join(root, "main.sock");
  const port = await freePort();
  await mkdir(workspace, { recursive: true });

  const machineState = new MainMachineState(machineStateRoot(mainCatalog), "Recovery Main");
  await machineState.initialize();
  await writeMachineJoinFile(joinPath, await machineState.createJoin());
  const listenerSettings = new MachineSettingsState(join(root, "listener"));
  await listenerSettings.writeMainConnections({ enabled: true, port });
  const statusState = new MachineSettingsState(machineSettingsStateRoot(subCatalog));

  const hosts: DockHost[] = [];
  let child: ChildProcess | undefined;
  let statusLock: ChildProcess | undefined;
  context.after(async () => {
    if (statusLock) await releaseWindowsSharingLock(statusLock);
    await rm(faultPath, { force: true });
    for (const host of hosts.reverse()) await host.stop().catch(() => {});
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForExit(child);
    }
    await rm(root, { recursive: true, force: true });
  });

  const createMain = async (): Promise<DockHost> => {
    const registry = new DockRegistry(async () => { throw new Error("Main runtime is not used in this regression"); });
    const controller = new MainMachineController({
      state: new MainMachineState(machineStateRoot(mainCatalog), "Recovery Main"),
      settingsState: listenerSettings,
      bindAddress: "::1",
      mainHostEpoch: registry.hostEpoch,
      localSnapshots: () => registry.list(),
    });
    const host = new DockHost({ socketPath, registry, remoteInstances: controller });
    await host.start();
    hosts.push(host);
    return host;
  };

  const firstMain = await createMain();
  const childHome = join(root, "sub-home");
  const childTemp = join(root, "sub-temp");
  await Promise.all([mkdir(childHome, { recursive: true }), mkdir(childTemp, { recursive: true })]);
  const childEnv = isolatedProcessEnvironment(childHome, { TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp });
  child = spawn(process.execPath, [
    fileURLToPath(new URL("./fixtures/subhost-machine.js", import.meta.url)),
    subCatalog,
    workspace,
    "::1",
    String(port),
    joinPath,
    "status-recovery",
    faultPath,
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdout?.resume();

  let client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 10_000 });
  const original = await waitForRemote(client, "native-create").catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${stderr}`); });
  const firstStatusTime = await waitForConnectedStatus(statusState).catch(async (error) => {
    throw new Error(`${String(error)}; initial status=${JSON.stringify(await statusState.readSubHostStatus())}; child exit=${String(child?.exitCode)}; SubHost stderr: ${stderr}`);
  });
  const subHostId = (await client.machines()).machines.find((machine) => machine.kind === "subhost")?.hostId;
  assert.ok(subHostId);

  if (process.platform === "win32") statusLock = await startWindowsSharingLock(statusState.subHostStatusPath, childEnv);
  else await writeFile(faultPath, "held\n");
  await firstMain.stop();
  const diagnosticDeadline = Date.now() + 5_000;
  while (!stderr.includes("SubHost status diagnostic") && Date.now() < diagnosticDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(stderr, /SubHost status diagnostic:[^\n]*(?:EPERM|EACCES|EBUSY)[^\n]*(?:fixture holds|rename)/u);
  assert.equal(child.exitCode, null, "status persistence failure must not terminate the SubHost");
  const heldObservation = await statusState.readSubHostStatus();
  assert.equal(heldObservation.connected, true, "the outage keeps only the prior recorded observation");
  assert.equal(heldObservation.updatedAt, firstStatusTime, "the held observation is not refreshed while persistence is unavailable");

  await createMain();
  client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 10_000 });
  await waitForMachine(client, subHostId);
  const recovered = await client.status(original.id);
  assert.equal(recovered.id, original.id, "Main rediscovers the same Work from the same SubHost process");
  const created = await client.create(workspace, "Created after recovery", "create-after-status-contention", undefined, subHostId);
  assert.equal(created.lifecycle, "active");
  assert.equal(child.exitCode, null);

  if (statusLock) {
    await releaseWindowsSharingLock(statusLock);
    statusLock = undefined;
  } else {
    await rm(faultPath, { force: true });
  }
  const reconciledAt = await waitForConnectedStatus(statusState, firstStatusTime).catch(async (error) => {
    throw new Error(`${String(error)}; last status=${JSON.stringify(await statusState.readSubHostStatus())}; SubHost stderr: ${stderr}`);
  });
  assert.notEqual(reconciledAt, firstStatusTime, "the latest connected status is reconciled without another link transition");
});
