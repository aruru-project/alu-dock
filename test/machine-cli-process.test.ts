import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { MachineSettingsState, machineSettingsStateRoot } from "../src/control/machine-settings-state.js";
import { MainMachineState, machineStateRoot, readMachineJoinFile, SubHostMachineState } from "../src/control/machine-state.js";

const cli = new URL("../src/cli.js", import.meta.url).pathname;

async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("port unavailable"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
function exited(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolve) => child.once("exit", () => resolve())); }
async function stop(child: ChildProcess): Promise<void> { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited(child); }
async function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> { await new Promise<void>((resolve, reject) => execFile(process.execPath, [cli, ...args], { env }, (error) => error ? reject(error) : resolve())); }
async function runHubAction(socketPath: string, action: string, env: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): Promise<string> {
  const driver = join(process.cwd(), "test/fixtures/pty-tui-driver.py");
  const stdout = await new Promise<string>((resolveRun, rejectRun) => {
    execFile("python3", [driver, process.execPath, cli, "--socket", socketPath], {
      env: { ...env, ...extra, ALU_DOCK_PTY_ACTION: action },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, output, stderr) => error ? rejectRun(new Error(`Hub TUI failed: ${stderr}`, { cause: error })) : resolveRun(output));
  });
  const result = JSON.parse(stdout) as { status: number; timedOut: boolean; output: string };
  const output = Buffer.from(result.output, "base64").toString("utf8");
  assert.equal(result.timedOut, false, output.slice(-2_000));
  assert.equal(result.status, 0, output.slice(-2_000));
  return output;
}

async function turnOnMachineConnectionsFromHub(socketPath: string, port: number, env: NodeJS.ProcessEnv): Promise<string> {
  return runHubAction(socketPath, "hub-machine-connections", env, { ALU_DOCK_PTY_PORT: String(port) });
}

test("Host startup rejects process-level role overrides", () => {
  const result = spawnSync(process.execPath, [cli, "serve", "--dev", "--subhost"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown serve argument: --subhost/u);
});

test("the human flow carries Main facts in one join file and does not ask for them again", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-subhost-human-"));
  const sourceStateHome = join(root, "source-state"), targetStateHome = join(root, "target-state");
  const sourceCatalog = join(sourceStateHome, "alu-dock", "catalog.json"), targetCatalog = join(targetStateHome, "alu-dock", "catalog.json");
  const sourceSocket = join(root, "source.sock"), targetSocket = join(root, "target.sock"), joinFilePath = join(root, "subhost.join");
  const sourceEnv = { ...process.env, HOME: join(root, "source-home"), XDG_STATE_HOME: sourceStateHome, XDG_DATA_HOME: join(root, "source-data") };
  const targetEnv = { ...process.env, HOME: join(root, "target-home"), XDG_STATE_HOME: targetStateHome, XDG_DATA_HOME: join(root, "target-data") };
  await Promise.all([mkdir(sourceEnv.HOME as string, { recursive: true }), mkdir(targetEnv.HOME as string, { recursive: true })]);
  const machinePort = await freePort();
  await new MachineSettingsState(machineSettingsStateRoot(sourceCatalog)).writeMainConnections({ enabled: false, port: machinePort });
  const sourceHost = spawn(process.execPath, [cli, "--socket", sourceSocket, "serve", "--dev", "--state", sourceCatalog], { env: sourceEnv, stdio: ["ignore", "pipe", "pipe"] });
  const targetHost = spawn(process.execPath, [cli, "--socket", targetSocket, "serve", "--dev", "--state", targetCatalog], { env: targetEnv, stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => { await stop(targetHost); await stop(sourceHost); await rm(root, { recursive: true, force: true }); });
  await Promise.all([waitReady(sourceHost, "source Main"), waitReady(targetHost, "target Main")]);

  const sourceOutput = await runHubAction(sourceSocket, "hub-create-subhost-join", sourceEnv, {
    ALU_DOCK_PTY_MAIN_ADDRESS: "main.example.lan",
    ALU_DOCK_PTY_JOIN_FILE: joinFilePath,
  });
  const joinFile = await readMachineJoinFile(joinFilePath);
  assert.deepEqual(joinFile.connection, { mainAddress: "main.example.lan", port: machinePort }, sourceOutput.slice(-2_000));

  const targetOutput = await runHubAction(targetSocket, "hub-new-subhost", targetEnv, { ALU_DOCK_PTY_JOIN_FILE: joinFilePath });
  const saved = await new MachineSettingsState(machineSettingsStateRoot(targetCatalog)).read();
  assert.equal(saved.role, "subhost", targetOutput.slice(-2_000));
  assert.equal(saved.subhost?.mainAddress, "main.example.lan");
  assert.equal(saved.subhost?.port, machinePort);
  assert.doesNotMatch(targetOutput, /Enter the address|SubHost port|SubHost name/u);
  assert.ok(await new SubHostMachineState(machineStateRoot(targetCatalog)).load());
});

test("an expired unfinished enrollment can be cancelled back to Main without another join file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-subhost-expired-"));
  const stateHome = join(root, "state-home"), catalog = join(stateHome, "alu-dock", "catalog.json"), socketPath = join(root, "main.sock");
  const env = { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: stateHome, XDG_DATA_HOME: join(root, "data-home") };
  await mkdir(env.HOME as string, { recursive: true });
  const host = spawn(process.execPath, [cli, "--socket", socketPath, "serve", "--dev", "--state", catalog], { env, stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => { await stop(host); await rm(root, { recursive: true, force: true }); });
  await waitReady(host, "Main with unfinished enrollment");

  const base = new Date(Date.now() - 20 * 60_000);
  const joinFile = await new MainMachineState(join(root, "other-main")).createJoin(undefined, base);
  await new SubHostMachineState(machineStateRoot(catalog)).prepare(joinFile, "Unfinished Studio", base);
  const settings = new MachineSettingsState(machineSettingsStateRoot(catalog));
  await settings.switchToSubHost({ mainAddress: "main.example.lan", port: 43127, name: "Unfinished Studio" });

  const output = await runHubAction(socketPath, "hub-expired-subhost-main", env);
  assert.equal((await settings.read()).role, "main", output.slice(-2_000));
  assert.doesNotMatch(output, /New Main join file|SubHost join file/u);
});

class TcpProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  constructor(private readonly listenPort: number, private readonly targetPort: number) {}
  async start(): Promise<void> {
    const server = createServer((client) => {
      const upstream = createConnection({ host: "::1", port: this.targetPort });
      this.sockets.add(client); this.sockets.add(upstream);
      const close = (): void => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.once("error", close); upstream.once("error", close); client.once("close", close); upstream.once("close", close);
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.listenPort, "::1", resolve); });
    this.server = server;
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined;
    const closed = server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    for (const socket of [...this.sockets]) { socket.unpipe(); socket.end(); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    await closed;
  }
}

async function waitReady(child: ChildProcess, label: string): Promise<void> {
  let output = "", error = ""; child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); }); child.stderr?.on("data", (chunk: Buffer) => { error += chunk.toString(); });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { if (output.includes('"host.ready"')) return; if (child.exitCode !== null) throw new Error(`${label} exited: ${error}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error(`${label} did not become ready: ${error}`);
}
async function waitMachine(client: DockClient, available: boolean): Promise<string> { const deadline = Date.now() + 10_000; let last = "none"; while (Date.now() < deadline) { try { const machine = (await client.machines()).machines.find((item) => item.kind === "subhost"); last = machine ? String(machine.available) : "missing"; if (machine?.available === available) return machine.hostId; } catch (error) { last = error instanceof Error ? error.message : String(error); } await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error(`SubHost availability did not become ${available} (last ${last})`); }
async function waitInstance(client: DockClient, operationId: string, id?: string): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { try { const found = (await client.list("all")).find((item) => item.creationOperationId === operationId && (id === undefined || item.id === id)); if (found && found.lifecycle === "active") return found; } catch {} await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error(`instance ${operationId} did not appear`); }
async function containsBytes(root: string, expected: Buffer): Promise<boolean> { try { for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) { if (await containsBytes(path, expected)) return true; } else if (entry.isFile()) { const bytes = await readFile(path); if (bytes.equals(expected)) return true; } } } catch {} return false; }

// Paused until card #351: this Host's Pi Worker uses the real ~/.pi/agent (settings, credentials,
// extensions) and leaves a session folder there on every run.
test("Main toggles SubHost connections live while native Pi work stays alive offline", { skip: "paused until #351 isolates its Pi Worker from the real Pi directory" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-cli-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const mainCatalog = join(root, "main-state", "alu-dock", "catalog.json"), subCatalog = join(root, "sub", "catalog.json"), joinFile = join(root, "join.json"), socketPath = join(root, "main.sock");
  const mainPort = await freePort(), proxyPort = await freePort();
  const mainEnv = { ...process.env, HOME: join(root, "main-home"), XDG_STATE_HOME: join(root, "main-state"), XDG_DATA_HOME: join(root, "main-data") };
  const subEnv = { ...process.env, HOME: join(root, "sub-home"), XDG_STATE_HOME: join(root, "sub-state"), XDG_DATA_HOME: join(root, "sub-data") };
  const machineSettings = new MachineSettingsState(machineSettingsStateRoot(mainCatalog));
  const subHostSettings = new MachineSettingsState(machineSettingsStateRoot(subCatalog));
  await subHostSettings.switchToSubHost({ mainAddress: "::1", port: proxyPort, name: "Fixture SubHost" });
  await run(["machine", "join-file", "--state", mainCatalog, "--out", joinFile], mainEnv);
  const proxy = new TcpProxy(proxyPort, mainPort); await proxy.start();
  const children: ChildProcess[] = [];
  context.after(async () => { await proxy.stop(); for (const child of children.reverse()) await stop(child); await rm(root, { recursive: true, force: true }); });

  let sub = spawn(process.execPath, [cli, "serve", "--dev", "--state", subCatalog, "--join-file", joinFile], { env: subEnv, stdio: ["ignore", "pipe", "pipe"] }); children.push(sub);
  await waitReady(sub, "SubHost");
  assert.equal(sub.exitCode, null, "SubHost stays alive before Main exists");

  const startMain = async (withPort = false): Promise<ChildProcess> => {
    const args = [cli, "--socket", socketPath, "serve", "--dev", "--state", mainCatalog];
    if (withPort) args.push("--machine-port", String(mainPort));
    const child = spawn(process.execPath, args, { env: mainEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await waitReady(child, "Main");
    return child;
  };
  const firstMain = await startMain();
  let client = new DockClient({ socketPath, timeoutMs: 5_000 });
  const machinesOutput = await turnOnMachineConnectionsFromHub(socketPath, mainPort, mainEnv);
  assert.match(machinesOutput, /Machines/u);
  assert.match(machinesOutput, /SubHost Connections · On/u);
  assert.equal((await machineSettings.read()).main.port, mainPort, machinesOutput.slice(-2_000));
  const hostId = await waitMachine(client, true);
  await stop(sub);
  await waitMachine(client, false);
  sub = spawn(process.execPath, [cli, "serve", "--dev", "--state", subCatalog], { env: subEnv, stdio: ["ignore", "pipe", "pipe"] }); children.push(sub);
  await waitReady(sub, "saved-role SubHost restart");
  assert.equal(await waitMachine(client, true), hostId, "ordinary restart must retain the enrolled SubHost identity");
  const created = await client.create(workspace, "CLI remote Pi", "cli-remote-create", undefined, hostId);
  assert.notEqual(created.id, "cli-remote-create");
  assert.equal(created.executor.kind, "pi-sdk");

  const attachment = Buffer.from("stored only by SubHost");
  await client.uploadAttachment({ name: "subhost.bin", sizeBytes: attachment.length, sha256: (await import("node:crypto")).createHash("sha256").update(attachment).digest("hex"), async *open() { yield attachment; } }, "cli-upload", created.id);
  assert.equal(await containsBytes(join(root, "sub-data"), attachment), true);
  assert.equal(await containsBytes(join(root, "main-data"), attachment), false);

  const beforeOffline = await client.status(created.id);
  await machineSettings.writeMainConnections({ enabled: false, port: mainPort });
  await waitMachine(client, false);
  assert.equal(sub.exitCode, null, "turning off Machine connections must not stop the SubHost");
  await machineSettings.writeMainConnections({ enabled: true, port: mainPort });
  await waitMachine(client, true);
  const afterReconnect = await client.status(created.id);
  assert.equal(afterReconnect.id, created.id, "turning Machine connections back on keeps the same Main identity");
  assert.equal(afterReconnect.runtimeGeneration, beforeOffline.runtimeGeneration, "the same Pi worker returns after Machine connections reopen");
  assert.equal(afterReconnect.execution, beforeOffline.execution);

  await stop(firstMain);
  assert.equal(sub.exitCode, null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondMain = await startMain(true); client = new DockClient({ socketPath, timeoutMs: 5_000 });
  const stable = await waitInstance(client, "cli-remote-create", created.id);
  assert.equal(stable.id, created.id);
  const listenerStatus = await machineSettings.readMainListenerStatus();
  assert.equal(listenerStatus?.state, "listening", "an explicit development port stays visible in Machines");
  assert.equal(listenerStatus?.port, mainPort);

  await proxy.stop();
  await waitMachine(client, false);
  await assert.rejects(client.reopen(created.id, "offline-reopen"), (error: unknown) => error instanceof ControlClientError && error.code === "host_unavailable");
  await client.stop(created.id, "offline-main-stop");
  await proxy.start();
  await waitMachine(client, true);
  const remapped = await waitInstance(client, "cli-remote-create");
  assert.notEqual(remapped.id, created.id);
  assert.equal(sub.exitCode, null);

  const localMachineState = new MainMachineState(machineStateRoot(mainCatalog));
  const rememberedJoin = await localMachineState.createJoin({ mainAddress: "main.saved.lan", port: 43127 });
  const rememberedSubHost = new SubHostMachineState(machineStateRoot(mainCatalog));
  await rememberedSubHost.prepare(rememberedJoin, "Remembered Studio");
  await rememberedSubHost.markJoined();
  await machineSettings.switchToSubHost({ mainAddress: "main.saved.lan", port: 43127, name: "Remembered Studio" });
  await machineSettings.switchToMain();
  const savedConnectionOutput = await runHubAction(socketPath, "hub-saved-subhost", mainEnv);
  assert.equal((await machineSettings.read()).role, "subhost", savedConnectionOutput.slice(-2_000));
  assert.doesNotMatch(savedConnectionOutput, /Enter the address|SubHost port|SubHost name|SubHost join file/u);
  await stop(secondMain);
});
