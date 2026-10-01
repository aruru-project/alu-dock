import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostMachineConnection } from "../src/control/machine-transport.js";
import { ModelVisibilityService, ModelVisibilityStore } from "../src/control/model-visibility.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { createPiModelCatalogReader } from "../src/pi/pi-model-catalog.js";

test("hiding a model on one machine removes it from that machine's model picker without disabling it", { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-model-visibility-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "sub-home"), cwd = join(home, "project"), agentDir = join(home, "agent"), sessions = join(home, "sessions");
  const subState = join(root, "sub-dock-state"), mainStateRoot = join(root, "main-dock-state");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(sessions, { recursive: true })]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "unused-no-model" } }));
  // Extensions start Pi through process.argv[1]; in the model listing process it must be Pi's CLI,
  // or such an extension would start the listing process again and again.
  const launches = join(root, "extension-launch-targets.txt");
  await mkdir(join(agentDir, "extensions"));
  await writeFile(join(agentDir, "extensions", "launch-target.ts"), `
import { appendFileSync } from "node:fs";
export default function() { appendFileSync(${JSON.stringify(launches)}, process.argv[1] + "\\n"); }
`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: join(home, "run"),
    APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), TMPDIR: root, TEMP: root, TMP: root,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];

  const registry = new DockRegistry((input) => createPiInstance({ ...input, agentDir, sessionDir: sessions, workerEnvironment: env }));
  const subHost = new DockHost({ socketPath: join(root, "sub.sock"), registry, listen: false,
    modelVisibility: new ModelVisibilityService(new ModelVisibilityStore(subState),
      createPiModelCatalogReader({ agentDir, homeDir: home, environment: async () => ({ ...env }) })) });
  const mainState = new MainMachineState(join(root, "main-machines"), "Main");
  await mainState.initialize();
  const joined = new SubHostMachineState(join(root, "sub-machines"));
  await joined.prepare(await mainState.createJoin(), "Laptop");
  const port = await reservePort();
  const settings = new MachineSettingsState(join(root, "listener"));
  await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry(async () => { throw new Error("This flow creates Work only on the SubHost"); });
  const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1",
    mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => [] });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller,
    modelVisibility: new ModelVisibilityService(new ModelVisibilityStore(mainStateRoot), { read: async () => ({ models: [], total: 0, truncated: false }) }) });
  const upstream = new SubHostMachineConnection({ state: joined, address: "127.0.0.1", port, hostEpoch: registry.hostEpoch,
    snapshots: () => registry.list(), acceptProtocolSocket: (socket) => subHost.acceptProtocolSocket(socket) });
  const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 20_000 });
  const hiddenModel = { provider: "openai", id: "gpt-4o-mini" };
  const listed = async (instanceId: string) => (await client.models(instanceId)).models.some((model) => model.provider === "openai" && model.id === "gpt-4o-mini");
  try {
    await subHost.start(); await main.start(); await upstream.start();
    await waitFor(() => upstream.connected());
    const laptop = (await client.machines()).machines.find((item) => item.name === "Laptop");
    assert.ok(laptop);

    // The settings page reads the machine's selectable models without any Work running there.
    const before = await client.modelVisibility(laptop.hostId);
    assert.ok(before.models.some((model) => model.provider === "openai" && model.id === "gpt-4o-mini"));
    assert.deepEqual(before.hidden, []);
    const targets = (await readFile(launches, "utf8")).split("\n").filter(Boolean);
    assert.ok(targets.length > 0 && targets.every((target) => !target.includes("pi-model-catalog-entry")), `extension launch targets: ${targets.join(", ")}`);

    const work = await client.create(cwd, "Picker", undefined, undefined, laptop.hostId);
    const full = await client.models(work.id);
    assert.equal(await listed(work.id), true);

    assert.deepEqual((await client.setModelVisibility([hiddenModel], laptop.hostId)).hidden, [hiddenModel]);
    const filtered = await client.models(work.id);
    assert.equal(await listed(work.id), false);
    assert.equal(filtered.total, full.total - 1);
    assert.deepEqual((await client.modelVisibility(laptop.hostId)).hidden, [hiddenModel]);
    // Hiding only affects the list: the exact provider/id can still be chosen.
    assert.equal((await client.setModel(work.id, "openai", "gpt-4o-mini")).instance.executor.model?.id, "gpt-4o-mini");
    // Each machine keeps its own list.
    assert.deepEqual((await client.modelVisibility()).hidden, []);

    // A hand edit with a mistake hides nothing and is reported until the list is saved again.
    await writeFile(join(subState, "model-visibility.json"), "{ \"hiddenModels\": [ { \"provider\": \"openai\" } ] }\n");
    const broken = await client.modelVisibility(laptop.hostId);
    assert.ok(broken.fileProblem);
    assert.deepEqual(broken.hidden, []);
    assert.equal(await listed(work.id), true);
    await client.setModelVisibility([], laptop.hostId);
    assert.equal((await client.modelVisibility(laptop.hostId)).fileProblem, undefined);

    // A correct hand edit (for example by an Agent) applies to the next list without a restart.
    await writeFile(join(subState, "model-visibility.json"), `${JSON.stringify({ hiddenModels: [hiddenModel] })}\n`);
    assert.equal(await listed(work.id), false);
  } finally {
    client.closeActiveConnections();
    await upstream.stop().catch(() => {}); await main.stop().catch(() => {}); await subHost.stop().catch(() => {});
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail("Expected local fixture result did not arrive");
}

async function reservePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port;
}
