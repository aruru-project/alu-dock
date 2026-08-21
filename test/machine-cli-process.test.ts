import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";

const cli = new URL("../src/cli.js", import.meta.url).pathname;

async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("port unavailable"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
function exited(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolve) => child.once("exit", () => resolve())); }
async function stop(child: ChildProcess): Promise<void> { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited(child); }
async function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> { await new Promise<void>((resolve, reject) => execFile(process.execPath, [cli, ...args], { env }, (error) => error ? reject(error) : resolve())); }

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

test("CLI Main/SubHost keeps native Pi work alive offline and remaps only an offline-stopped Main identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-cli-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const mainCatalog = join(root, "main", "catalog.json"), subCatalog = join(root, "sub", "catalog.json"), joinFile = join(root, "join.json"), socketPath = join(root, "main.sock");
  const mainPort = await freePort(), proxyPort = await freePort();
  const mainEnv = { ...process.env, HOME: join(root, "main-home"), XDG_STATE_HOME: join(root, "main-state"), XDG_DATA_HOME: join(root, "main-data") };
  const subEnv = { ...process.env, HOME: join(root, "sub-home"), XDG_STATE_HOME: join(root, "sub-state"), XDG_DATA_HOME: join(root, "sub-data") };
  await run(["machine", "join-file", "--state", mainCatalog, "--out", joinFile], mainEnv);
  const proxy = new TcpProxy(proxyPort, mainPort); await proxy.start();
  const children: ChildProcess[] = [];
  context.after(async () => { await proxy.stop(); for (const child of children.reverse()) await stop(child); await rm(root, { recursive: true, force: true }); });

  const sub = spawn(process.execPath, [cli, "serve", "--dev", "--subhost", "--state", subCatalog, "--main-address", "::1", "--machine-port", String(proxyPort), "--join-file", joinFile], { env: subEnv, stdio: ["ignore", "pipe", "pipe"] }); children.push(sub);
  await waitReady(sub, "SubHost");
  assert.equal(sub.exitCode, null, "SubHost stays alive before Main exists");

  const startMain = async (): Promise<ChildProcess> => { const child = spawn(process.execPath, [cli, "--socket", socketPath, "serve", "--dev", "--main", "--state", mainCatalog, "--machine-port", String(mainPort)], { env: mainEnv, stdio: ["ignore", "pipe", "pipe"] }); children.push(child); await waitReady(child, "Main"); return child; };
  const firstMain = await startMain();
  let client = new DockClient({ socketPath, timeoutMs: 5_000 });
  const hostId = await waitMachine(client, true);
  const created = await client.create(workspace, "CLI remote Pi", "cli-remote-create", undefined, hostId);
  assert.notEqual(created.id, "cli-remote-create");
  assert.equal(created.executor.kind, "pi-sdk");

  const attachment = Buffer.from("stored only by SubHost");
  await client.uploadAttachment(created.id, { name: "subhost.bin", sizeBytes: attachment.length, sha256: (await import("node:crypto")).createHash("sha256").update(attachment).digest("hex"), async *open() { yield attachment; } }, "cli-upload");
  assert.equal(await containsBytes(join(root, "sub-data"), attachment), true);
  assert.equal(await containsBytes(join(root, "main-data"), attachment), false);

  await stop(firstMain);
  assert.equal(sub.exitCode, null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondMain = await startMain(); client = new DockClient({ socketPath, timeoutMs: 5_000 });
  const stable = await waitInstance(client, "cli-remote-create", created.id);
  assert.equal(stable.id, created.id);

  await proxy.stop();
  await waitMachine(client, false);
  await assert.rejects(client.reopen(created.id, "offline-reopen"), (error: unknown) => error instanceof ControlClientError && error.code === "host_unavailable");
  await client.stop(created.id, "offline-main-stop");
  await proxy.start();
  await waitMachine(client, true);
  const remapped = await waitInstance(client, "cli-remote-create");
  assert.notEqual(remapped.id, created.id);
  assert.equal(sub.exitCode, null);
  await stop(secondMain);
});
