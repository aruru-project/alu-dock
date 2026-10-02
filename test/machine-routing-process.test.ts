import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import test from "node:test";

import { AttachmentService } from "../src/control/attachment-service.js";
import { AttachmentStorageState } from "../src/control/attachment-storage-state.js";
import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { machineStateRoot, MainMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import { MainMachineDockToolsAuthority } from "../src/control/main-machine-dock-tools.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

function nativeRoot(path: string): string {
  const root = parse(path).root;
  return process.platform === "win32" ? `${root.slice(0, 1).toUpperCase()}${root.slice(1)}` : root;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForOperation(client: DockClient, operationId: string): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const found = (await client.list("all")).find((item) => item.creationOperationId === operationId);
      if (found) return found;
    } catch (error) { if (!(error instanceof ControlClientError)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`operation ${operationId} did not appear on Main`);
}

async function waitForRemote(client: DockClient): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> {
  const deadline = Date.now() + 8_000;
  let last = "none";
  while (Date.now() < deadline) {
    try {
      const found = (await client.list("all")).find((item) => item.creationOperationId === "native-create");
      last = found ? `${found.lifecycle}/${found.execution}` : "missing";
      if (found && found.lifecycle === "active") return found;
    } catch (error) {
      if (!(error instanceof ControlClientError)) throw error;
      last = `error:${error.code}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`remote instance did not appear on Main (last: ${last})`);
}

function source(bytes: Buffer) {
  return {
    name: "routed.bin",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    async *open(): AsyncIterable<Uint8Array> { yield bytes; },
  };
}

test("DockClient uses one Main identity for SubHost read, prompt, follow, and specialized upload while link loss leaves work running", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-machine-route-"));
  await chmod(root, 0o700);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const workspaceBytes = Buffer.alloc(900_000, 0x61);
  await writeFile(join(workspace, "note.txt"), workspaceBytes);
  const mainCatalog = join(root, "main", "catalog.json");
  const subCatalog = join(root, "sub", "catalog.json");
  const joinPath = join(root, "join.json");
  const socketPath = join(root, "main.sock");
  const port = await freePort();
  const state = new MainMachineState(machineStateRoot(mainCatalog), "Fixture Main");
  await state.initialize();
  await writeMachineJoinFile(joinPath, await state.createJoin());
  const listenerSettings = new MachineSettingsState(join(root, "main-listener"));
  await listenerSettings.writeMainConnections({ enabled: true, port });

  const children = new Set<ChildProcess>();
  const hosts: DockHost[] = [];
  context.after(async () => {
    for (const host of hosts.reverse()) await host.stop().catch(() => {});
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await waitForExit(child); }
    await rm(root, { recursive: true, force: true });
  });

  const createMain = async (): Promise<DockHost> => {
    const registry = new DockRegistry(async () => { throw new Error("Main runtime is not used in this scenario"); });
    let dockTools!: MainMachineDockToolsAuthority;
    let host!: DockHost;
    const controller = new MainMachineController({
      state: new MainMachineState(machineStateRoot(mainCatalog), "Fixture Main"), settingsState: listenerSettings, bindAddress: "::1", mainHostEpoch: registry.hostEpoch,
      invokeDockTool: (sourceMainId, sourceMachineId, request) => dockTools.invoke(sourceMainId, sourceMachineId, request),
      localSnapshots: () => registry.list(),
    });
    dockTools = new MainMachineDockToolsAuthority({
      controller: () => controller,
      instances: () => host.instanceDirectory(),
      localClient: new DockClient({ socketPath }),
      deliverLocalNotification: async () => {},
    });
    const attachmentService = new AttachmentService(new AttachmentStorageState(join(root, `main-attachments-${hosts.length}`), join(root, "main-files")));
    host = new DockHost({ socketPath, registry, remoteInstances: controller, attachmentService });
    await host.start();
    hosts.push(host);
    return host;
  };

  const firstMain = await createMain();
  const child = spawn(process.execPath, [new URL("./fixtures/subhost-machine.js", import.meta.url).pathname, subCatalog, workspace, "::1", String(port), joinPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedProcessEnvironment(root, { XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data") }),
  });
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdout?.resume();

  const client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 15_000 });
  const remote = await waitForRemote(client).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${stderr}`); });
  assert.notEqual(remote.id, "native-subhost-instance");
  const toolCreated = await waitForOperation(client, "dock-tool-create").catch((error) => { throw new Error(`${String(error)}; child exit=${String(child.exitCode)}; stderr=${stderr}`); });
  assert.notEqual(toolCreated.id, "native-tool-created");
  const machines = await client.machines();
  const subHost = machines.machines.find((machine) => machine.kind === "subhost");
  const main = machines.machines.find((machine) => machine.kind === "main");
  const subHostId = subHost?.hostId;
  const mainHostId = main?.hostId;
  assert.ok(subHost && main && subHostId && mainHostId);
  assert.equal(subHost.platform, process.platform === "win32" ? "windows" : "linux");
  assert.equal(subHost.homePath, root);
  assert.ok(subHost.workspaceRoots?.includes(nativeRoot(root)));
  assert.equal(main.platform, process.platform === "win32" ? "windows" : "linux");
  assert.ok(main.homePath && isAbsolute(main.homePath));
  assert.ok(main.workspaceRoots?.includes(nativeRoot(main.homePath)));
  assert.equal(remote.hostId, subHostId);
  const ensuredRemote = await client.ensure("one-global-key", workspace, "Remote keyed work", "ensure-remote-key", undefined, subHostId);
  const ensuredWithoutPlacement = await client.ensure("one-global-key", workspace, "Ignored placement", "ensure-existing-key-local");
  const ensuredWithDifferentPlacement = await client.ensure("one-global-key", workspace, "Ignored placement", "ensure-existing-key-main", undefined, mainHostId);
  assert.equal(ensuredRemote.created, true);
  assert.equal(ensuredRemote.instance.hostId, subHostId);
  assert.equal(ensuredWithoutPlacement.instance.id, ensuredRemote.instance.id);
  assert.equal(ensuredWithDifferentPlacement.instance.id, ensuredRemote.instance.id);
  assert.equal((await client.getByKey("one-global-key"))?.id, ensuredRemote.instance.id);
  await assert.rejects(
    client.ensure("different-key", workspace, "Must not run", "ensure-remote-key", undefined, mainHostId),
    (error: unknown) => error instanceof ControlClientError && error.code === "operation_conflict",
    "Main must retain global ensure operation identity even when a retry selects another placement",
  );
  assert.equal((await client.status(remote.id)).id, remote.id);
  const read = await client.read(remote.id);
  assert.equal(read.instance.id, remote.id);
  const workspaceChunks: Buffer[] = [];
  const workspaceRead = await client.readWorkspaceFile(remote.id, "note.txt", async (chunk) => {
    if (!workspaceChunks.length) {
      // card325: an actual consuming client slower than the old 5s drain deadline
      // must not freeze other machine requests or lose this file.
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      assert.equal((await client.status(remote.id)).id, remote.id);
    }
    workspaceChunks.push(Buffer.from(chunk));
  });
  assert.equal(workspaceRead.sizeBytes, workspaceBytes.byteLength);
  assert.deepEqual(Buffer.concat(workspaceChunks), workspaceBytes);

  const conversationImageChunks: Buffer[] = [];
  const conversationImage = await client.readConversationImage(remote.id, "fixture-routed-image", async (chunk) => {
    await new Promise((resolve) => setImmediate(resolve));
    conversationImageChunks.push(Buffer.from(chunk));
  });
  const expectedConversationImage = Buffer.alloc(100_000, 0x5a);
  assert.deepEqual(Buffer.concat(conversationImageChunks), expectedConversationImage);
  assert.equal(conversationImage.sizeBytes, expectedConversationImage.byteLength);
  assert.equal(conversationImage.sha256, createHash("sha256").update(expectedConversationImage).digest("hex"));

  const events: string[] = [];
  const follow = await client.follow(remote.id, read.page.latest, { onEvent: (event) => events.push(event.type) });
  const prompted = await client.prompt(remote.id, "keep working through Main", "auto", "routed-prompt");
  assert.equal(prompted.instance.id, remote.id);
  for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.length > 0);

  const bytes = Buffer.alloc(900_000, 0x62);
  const uploaded = await client.uploadAttachment(source(bytes), "routed-upload", remote.id);
  assert.equal(uploaded.attachment.sha256, createHash("sha256").update(bytes).digest("hex"));

  follow.close();
  await firstMain.stop();
  assert.equal(child.exitCode, null);
  const secondMain = await createMain();
  const secondClient = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 15_000 });
  const recovered = await waitForRemote(secondClient);
  assert.equal(recovered.id, remote.id);
  assert.equal(recovered.execution, "running");
  assert.equal(child.exitCode, null);
  await secondClient.stop(recovered.id, "online-remote-stop").catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${stderr}`); });
  for (let attempt = 0; attempt < 100 && (await secondClient.list("all")).some((item) => item.id === recovered.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await secondClient.list("all")).some((item) => item.id === recovered.id), false);
  const removal = await secondClient.removeMachine(subHostId, "remove-routed-subhost");
  assert.deepEqual(removal, { hostId: subHostId, removed: true });
  assert.equal((await secondClient.machines()).machines.some((machine) => machine.hostId === subHostId), false);
  assert.equal(child.exitCode, null, "removing trust must not stop the SubHost process or its work");
  await secondMain.stop();
});
