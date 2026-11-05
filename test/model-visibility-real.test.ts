import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { MainMachineController, SubHostMachineConnection, SubHostModelLists, SubHostModelPort } from "../src/control/machine-transport.js";
import { ModelVisibilityService, ModelVisibilityStore } from "../src/control/model-visibility.js";
import { ChildModelsService, ChildModelsStore } from "../src/control/child-models.js";
import { ModelServiceProcess } from "../src/model-service/service-process.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { createPiModelCatalogReader } from "../src/pi/pi-model-catalog.js";

// Card #303, decision 3: the hidden-model list and the child Work list exist only on Main. A SubHost's
// Works pick from Main's models, and each list is the same whichever machine's settings page shows or edits it.
test("Main's model lists: hiding a model leaves every picker, and the child Work list reaches every machine's Agents", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-model-visibility-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(home, "project"), mainAgent = join(home, "main-agent"), subAgent = join(home, "sub-agent");
  const mainStateRoot = join(root, "main-dock-state");
  await Promise.all([cwd, mainAgent, subAgent, join(root, "main-sessions"), join(root, "sub-sessions")].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(mainAgent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "unused-no-model" } }));
  // Extensions start Pi through process.argv[1]; in the model listing process it must be Pi's CLI,
  // or such an extension would start the listing process again and again.
  const launches = join(root, "extension-launch-targets.txt");
  await mkdir(join(mainAgent, "extensions"));
  await writeFile(join(mainAgent, "extensions", "launch-target.ts"), `
import { appendFileSync } from "node:fs";
export default function() { appendFileSync(${JSON.stringify(launches)}, process.argv[1] + "\\n"); }
`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: join(home, "run"),
    APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), TMPDIR: root, TEMP: root, TMP: root, PI_OFFLINE: "1" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];

  const service = new ModelServiceProcess({ agentDir: mainAgent, environment: { ...env, PI_CODING_AGENT_DIR: mainAgent } });
  context.after(() => service.stop());
  await service.start();
  const catalog = createPiModelCatalogReader({ agentDir: mainAgent, homeDir: home, environment: async () => ({ ...env, PI_CODING_AGENT_DIR: mainAgent }) });
  const visibility = new ModelVisibilityService(new ModelVisibilityStore(mainStateRoot), catalog);
  const childModels = new ChildModelsService(new ChildModelsStore(mainStateRoot), catalog, visibility);
  const mainState = new MainMachineState(join(root, "main-machines"), "Main");
  await mainState.initialize();
  const joined = new SubHostMachineState(join(root, "sub-machines"));
  await joined.prepare(await mainState.createJoin(), "Laptop");
  const port = await reservePort();
  const settings = new MachineSettingsState(join(root, "listener"));
  await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry((input) => createPiInstance({ ...input, agentDir: mainAgent, sessionDir: join(root, "main-sessions"), workerEnvironment: { ...env, PI_CODING_AGENT_DIR: mainAgent }, modelHostPort: service }));
  const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1",
    mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => mainRegistry.list(), models: { service, visibility, childModels } });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller, modelVisibility: visibility, childModels, childModelsEditor: childModels });
  // Built as the SubHost Host builds itself in src/cli.ts.
  const subHostEpoch = randomUUID();
  let subRegistry!: DockRegistry;
  let subHost!: DockHost;
  const upstream = new SubHostMachineConnection({ state: joined, address: "127.0.0.1", port, hostEpoch: subHostEpoch,
    snapshots: () => subRegistry.list(), acceptProtocolSocket: (socket) => subHost.acceptProtocolSocket(socket) });
  const mainModels = new SubHostModelPort(upstream), lists = new SubHostModelLists(upstream);
  subRegistry = new DockRegistry((input) => createPiInstance({ ...input, agentDir: subAgent, sessionDir: join(root, "sub-sessions"), workerEnvironment: { ...env, PI_CODING_AGENT_DIR: subAgent }, modelHostPort: mainModels }),
    undefined, { hostEpoch: subHostEpoch });
  subHost = new DockHost({ socketPath: join(root, "sub.sock"), registry: subRegistry, listen: false, modelVisibility: lists, childModels: lists });
  const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 20_000 });
  const hiddenModel = { provider: "openai", id: "gpt-4o-mini" };
  const listed = async (instanceId: string) => (await client.models(instanceId)).models.some((model) => model.provider === "openai" && model.id === "gpt-4o-mini");
  try {
    await subHost.start(); await main.start(); await upstream.start();
    await waitFor(() => upstream.connected());
    const laptop = (await client.machines()).machines.find((item) => item.name === "Laptop");
    assert.ok(laptop);

    // The settings page reads the selectable models without any Work running; both machines show Main's.
    const mainCatalog = await client.modelVisibility();
    assert.ok(mainCatalog.models.some((model) => model.provider === "openai" && model.id === "gpt-4o-mini"));
    assert.deepEqual(mainCatalog.hidden, []);
    assert.deepEqual((await client.modelVisibility(laptop.hostId)).models, mainCatalog.models);
    const targets = (await readFile(launches, "utf8")).split("\n").filter(Boolean);
    assert.ok(targets.length > 0 && targets.every((target) => !target.includes("pi-model-catalog-entry")), `extension launch targets: ${targets.join(", ")}`);

    const mainWork = await client.create(cwd, "Main picker");
    const work = await client.create(cwd, "Picker", undefined, undefined, laptop.hostId);
    const full = await client.models(work.id);
    assert.equal(await listed(work.id), true);

    // Hidden from the SubHost's page, it is gone from both machines' pickers: there is one list.
    assert.deepEqual((await client.setModelVisibility([hiddenModel], laptop.hostId)).hidden, [hiddenModel]);
    const filtered = await client.models(work.id);
    assert.equal(await listed(work.id), false);
    assert.equal(filtered.total, full.total - 1);
    assert.equal(await listed(mainWork.id), false);
    assert.deepEqual((await client.modelVisibility()).hidden, [hiddenModel]);
    // Hiding only affects the list: the exact provider/id can still be chosen.
    assert.equal((await client.setModel(work.id, "openai", "gpt-4o-mini")).instance.executor.model?.id, "gpt-4o-mini");
    await client.setModelVisibility([]);
    assert.equal(await listed(work.id), true);
    assert.deepEqual((await client.modelVisibility(laptop.hostId)).hidden, []);

    // A hand edit with a mistake hides nothing and is reported until the list is saved again.
    await writeFile(join(mainStateRoot, "model-visibility.json"), "{ \"hiddenModels\": [ { \"provider\": \"openai\" } ] }\n");
    const broken = await client.modelVisibility(laptop.hostId);
    assert.ok(broken.fileProblem);
    assert.deepEqual(broken.hidden, []);
    assert.equal(await listed(work.id), true);
    await client.setModelVisibility([], laptop.hostId);
    assert.equal((await client.modelVisibility()).fileProblem, undefined);

    // A correct hand edit (for example by an Agent) applies to the next list without a restart.
    await writeFile(join(mainStateRoot, "model-visibility.json"), `${JSON.stringify({ hiddenModels: [hiddenModel] })}\n`);
    assert.equal(await listed(work.id), false);

    // The child Work list is offered from Main's models, less the hidden ones.
    const children = await client.childModels();
    assert.deepEqual(children.listed, []);
    assert.equal(children.models.some((model) => model.provider === hiddenModel.provider && model.id === hiddenModel.id), false);
    const [first, second] = children.models.map(({ provider, id }) => ({ provider, id }));
    assert.ok(first && second);
    // Saved in the order given, once each; a SubHost's Agents read the same list through dock_models.
    assert.deepEqual((await client.setChildModels([second, first, second])).listed, [second, first]);
    assert.deepEqual(await lists.read(), { models: [second, first] });
    assert.deepEqual(JSON.parse(await readFile(join(mainStateRoot, "child-models.json"), "utf8")), { models: [second, first] });
    // A hand edit with a mistake is reported, and saving from the page writes a correct file again.
    await writeFile(join(mainStateRoot, "child-models.json"), "{ \"models\": [ { \"provider\": \"openai\" } ] }\n");
    const brokenList = await client.childModels();
    assert.ok(brokenList.fileProblem);
    assert.deepEqual(brokenList.listed, []);
    await client.setChildModels([first]);
    const repaired = await client.childModels();
    assert.deepEqual([repaired.listed, repaired.fileProblem], [[first], undefined]);
    // The user's limit: at most 50 models.
    await assert.rejects(client.setChildModels(Array.from({ length: 51 }, (_, index) => ({ provider: "openai", id: `model-${index}` }))), { code: "invalid_request" });
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
