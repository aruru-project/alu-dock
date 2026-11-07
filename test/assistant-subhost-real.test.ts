import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantServiceProcess } from "../src/assistant/service-process.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostAssistantPort, SubHostMachineConnection } from "../src/control/machine-transport.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor } from "./support/plan-goal-provider.js";

// Card #295: a Work opened as the assistant on a SubHost loads her persona and notes from Main, and
// its conversation goes into her memory on Main, named by the Work's Main ID and the machine.
test("an assistant Work on a SubHost loads her from Main and its conversation reaches her memory there", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-subhost-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const subAgent = join(root, "sub-agent"), cwd = join(root, "project"), home = join(root, "home");
  await Promise.all([subAgent, cwd, home, join(root, "sub-sessions")].map((path) => mkdir(path, { recursive: true })));
  const provider = new PlanGoalProvider();
  context.after(() => provider.stop());
  await writeFile(join(subAgent, "models.json"), JSON.stringify({ providers: { coordinator: { baseUrl: await provider.start(), api: "openai-completions", apiKey: "fixture-key",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(subAgent, "settings.json"), JSON.stringify({ defaultProvider: "coordinator", defaultModel: "fixture", defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false } }));
  const environment = isolatedProcessEnvironment(home, { XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  const assistant = new AssistantServiceProcess({ directory: join(root, "assistant"), workspacePath: join(root, "assistant-workspace"), agentDir: join(root, "main-agent"), environment });
  context.after(() => assistant.stop());
  await assistant.start();

  const mainState = new MainMachineState(join(root, "main-machines"), "Main");
  await mainState.initialize();
  const joined = new SubHostMachineState(join(root, "sub-machines"));
  await joined.prepare(await mainState.createJoin(), "Laptop");
  const port = await reservePort();
  const settings = new MachineSettingsState(join(root, "listener"));
  await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry(() => assert.fail("This test creates its Work on the SubHost"));
  const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1", mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => mainRegistry.list(), models: { assistant } });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller, assistant });
  // Built as the SubHost Host builds itself in src/cli.ts.
  const subHostEpoch = randomUUID();
  let subRegistry!: DockRegistry;
  let subHost!: DockHost;
  const upstream = new SubHostMachineConnection({ state: joined, address: "127.0.0.1", port, hostEpoch: subHostEpoch,
    snapshots: () => subRegistry.list(), acceptProtocolSocket: (socket) => subHost.acceptProtocolSocket(socket) });
  const mainAssistant = new SubHostAssistantPort(upstream);
  subRegistry = new DockRegistry((input) => createPiInstance({ ...input, agentDir: subAgent, sessionDir: join(root, "sub-sessions"), workerEnvironment: { ...environment, PI_CODING_AGENT_DIR: subAgent }, assistantHostPort: mainAssistant }),
    undefined, { hostEpoch: subHostEpoch, assistantAvailable: true });
  subHost = new DockHost({ socketPath: join(root, "sub.sock"), registry: subRegistry, listen: false });
  const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 30_000 });
  try {
    await subHost.start(); await main.start(); await upstream.start();
    await waitFor(() => upstream.connected(), "The SubHost did not connect to Main");
    const notes = await client.assistantDocument("notes");
    await client.setAssistantDocument("notes", "主人住在杭州。", notes.revision);
    const laptop = (await client.machines()).machines.find((item) => item.name === "Laptop");
    assert.ok(laptop);
    const work = await client.create(cwd, "Alu on the laptop", undefined, undefined, laptop.hostId, undefined, undefined, true);
    assert.equal(work.assistant, true);

    await client.prompt(work.id, "我住哪？");
    const request = await provider.request(0);
    assert.ok(JSON.stringify(request.body.messages).includes("主人住在杭州。"), "The SubHost Work loads the owner's notes from Main");
    request.text("杭州呀，西湖边那个。");
    await waitFor(async () => (await client.status(work.id)).execution === "idle", "The SubHost Work did not finish its turn");

    await waitFor(async () => (await client.assistantSearch("西湖")).hits.length === 1, "The SubHost Work's conversation did not reach Main");
    const [hit] = (await client.assistantSearch("西湖")).hits;
    assert.equal(hit!.session.workId, work.id);
    assert.equal(hit!.session.machine, "Laptop");
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
