import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { ChildModelsStore } from "../src/control/child-models.js";
import { ModelVisibilityService, ModelVisibilityStore } from "../src/control/model-visibility.js";
import { MainMachineController, SubHostDockToolsPort, SubHostMachineConnection, SubHostModelLists, SubHostModelPort } from "../src/control/machine-transport.js";
import { ModelServiceProcess } from "../src/model-service/service-process.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor } from "./support/plan-goal-provider.js";

// Card #303 step 2: a SubHost keeps no model files. Its Works ask Main over the machine connection
// and send their requests themselves. The key exists only in Main's model service, and Main's
// models.json is larger than one machine record, so its answer must arrive in parts. The child
// Work list exists only on Main too (decision 3).
test("a SubHost's Work sends its own requests with Main's models and credentials", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-model-subhost-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mainAgent = join(root, "main-agent"), subAgent = join(root, "sub-agent"), cwd = join(root, "project"), home = join(root, "home");
  await Promise.all([mainAgent, subAgent, cwd, home, join(root, "main-sessions"), join(root, "sub-sessions")].map((path) => mkdir(path, { recursive: true })));
  const provider = new PlanGoalProvider();
  context.after(() => provider.stop());
  const padding = "m".repeat(1_000);
  const models = [{ id: "fixture", name: "fixture" }, ...Array.from({ length: 2_500 }, (_, index) => ({ id: `extra-${index}`, name: `${padding}-${index}` }))]
    .map((model) => ({ ...model, reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const modelsJson = JSON.stringify({ providers: { coordinator: { baseUrl: await provider.start(), api: "openai-completions", apiKey: "${MAIN_ONLY_KEY}", models } } });
  assert.ok(modelsJson.length > 2 * 1024 * 1024);
  await writeFile(join(mainAgent, "models.json"), modelsJson);
  // Settings stay per machine; only model configuration and credentials move to Main.
  for (const agentDir of [mainAgent, subAgent]) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "coordinator", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false } }));
  }
  const environment = isolatedProcessEnvironment(home, { XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  const service = new ModelServiceProcess({ agentDir: mainAgent, environment: { ...environment, MAIN_ONLY_KEY: "key-from-main" } });
  context.after(() => service.stop());
  await service.start();

  const mainState = new MainMachineState(join(root, "main-machines"), "Main");
  await mainState.initialize();
  const joined = new SubHostMachineState(join(root, "sub-machines"));
  await joined.prepare(await mainState.createJoin(), "Laptop");
  const port = await reservePort();
  const settings = new MachineSettingsState(join(root, "listener"));
  await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry((input) => createPiInstance({ ...input, agentDir: mainAgent, sessionDir: join(root, "main-sessions"), workerEnvironment: { ...environment, PI_CODING_AGENT_DIR: mainAgent }, modelHostPort: service }));
  await writeFile(join(root, "child-models.json"), JSON.stringify({ models: [{ provider: "coordinator", id: "extra-7" }] }));
  const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1", mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => mainRegistry.list(),
    // The settings page that reads the catalog is covered in model-visibility-real.test.ts.
    models: { service, childModels: new ChildModelsStore(root), visibility: new ModelVisibilityService(new ModelVisibilityStore(root), { read: () => assert.fail("the catalog is not read here") }) } });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller });
  // Built as the SubHost Host builds itself in src/cli.ts.
  const subHostEpoch = randomUUID();
  let subRegistry!: DockRegistry;
  let subHost!: DockHost;
  const upstream = new SubHostMachineConnection({ state: joined, address: "127.0.0.1", port, hostEpoch: subHostEpoch,
    snapshots: () => subRegistry.list(), acceptProtocolSocket: (socket) => subHost.acceptProtocolSocket(socket) });
  const mainModels = new SubHostModelPort(upstream), lists = new SubHostModelLists(upstream);
  subRegistry = new DockRegistry((input) => createPiInstance({ ...input, agentDir: subAgent, sessionDir: join(root, "sub-sessions"), workerEnvironment: { ...environment, PI_CODING_AGENT_DIR: subAgent }, modelHostPort: mainModels }),
    undefined, { hostEpoch: subHostEpoch, dockToolsHostPort: new SubHostDockToolsPort({ upstream, local: () => subRegistry }) });
  subHost = new DockHost({ socketPath: join(root, "sub.sock"), registry: subRegistry, listen: false, modelVisibility: lists, childModels: lists });
  const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 30_000 });
  try {
    await subHost.start(); await main.start(); await upstream.start();
    await waitFor(() => upstream.connected(), "The SubHost did not connect to Main");
    const laptop = (await client.machines()).machines.find((item) => item.name === "Laptop");
    assert.ok(laptop);
    const work = await client.create(cwd, "On the laptop", undefined, undefined, laptop.hostId);
    assert.equal((await client.models(work.id)).total, models.length);

    await client.prompt(work.id, "Hello.");
    const request = await provider.request(0);
    assert.equal(request.headers.authorization, "Bearer key-from-main");
    request.tools({ id: "child-models", name: "dock_models", arguments: {} });
    const listed = await provider.request(1);
    assert.equal(listed.headers.authorization, "Bearer key-from-main");
    assert.match(JSON.stringify(listed.body.messages?.at(-1)), /coordinator\/extra-7/);
    listed.text("FROM_THE_LAPTOP");
    await waitFor(async () => (await client.status(work.id)).execution === "idle", "The SubHost Work did not finish its turn");
    assert.ok(JSON.stringify(await client.history(work.id)).includes("FROM_THE_LAPTOP"));
  } finally {
    client.closeActiveConnections();
    await upstream.stop().catch(() => {}); await main.stop().catch(() => {}); await subHost.stop().catch(() => {});
  }
});

async function reservePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port;
}
