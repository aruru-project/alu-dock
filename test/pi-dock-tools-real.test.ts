import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssistantChildrenElsewhere } from "../src/control/assistant-children-elsewhere.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineDockToolsAuthority } from "../src/control/main-machine-dock-tools.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { machineStateRoot, MainMachineState, writeMachineJoinFile } from "../src/control/machine-state.js";
import { MainMachineController } from "../src/control/machine-transport.js";
import type { DockToolsHostPort } from "../src/core/dock-tools.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DOCK_TOOL_NAMES } from "../src/pi/dock-tools-extension.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { exited } from "./support/native-team.js";
import { PlanGoalProvider } from "./support/plan-goal-provider.js";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("real Pi Worker toggles Dock tools and exposes its readable usage guide", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-tools-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-network" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));

  let enabled = false;
  const dockToolsHostPort: DockToolsHostPort = {
    dockToolsEnabled: () => enabled,
    configureDockTools: async (_source, next) => { enabled = next; return { enabled }; },
    invokeDockTool: async () => ({
      type: "list",
      result: {
        trust: "untrusted_cross_instance",
        observedAt: "2026-07-28T20:00:00.000Z",
        instances: [],
        total: 0,
        truncated: false,
        includesHistory: false,
      },
    }),
    attachObservationSink: () => () => {},
  };

  const instance = await createPiInstance({
    cwd,
    agentDir,
    sessionDir,
    projectTrusted: true,
    dockToolsHostPort,
    dockToolsEnabled: false,
    workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir }),
    workerTimeouts: { mutationMs: 10_000 },
  });

  try {
    const commands = await instance.getCommands();
    const resources = await instance.getResources();
    assert.ok(commands.commands.some((command) => command.name === "dock-tools"), JSON.stringify({ commands, resources, events: instance.eventsSince().events }));
    const initial = await instance.listTools();
    assert.equal(resources.resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), false);
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(initial.tools.find((tool) => tool.name === name)?.active, false);
    }

    await instance.submit("/dock-tools on", "prompt", "observation-on");
    await waitFor(() => instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "observation-on"), "Dock tools command did not finish");
    assert.equal(enabled, true);
    const active = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(active.tools.find((tool) => tool.name === name)?.active, true);
    }
    const guidePath = active.tools.find((tool) => tool.name === "dock_list")?.description.split("Usage guide (read when needed): ")[1];
    assert.ok(guidePath, "enabled tools must point to their usage guide");
    assert.match(await readFile(guidePath, "utf8"), /^# Native Dock collaboration/u);
    assert.equal((await instance.getResources()).resources.some((resource) => resource.kind === "skill" && resource.name === "dock-tools"), false);

    await instance.reloadSession("dock-tools-reload");
    const reloaded = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(reloaded.tools.find((tool) => tool.name === name)?.active, true);
    }

    await instance.submit("/dock-tools off", "prompt", "observation-off");
    await waitFor(() => instance.eventsSince().events.some((event) => event.type === "command.handled" && event.data.operationId === "observation-off"), "Dock tools off command did not finish");
    assert.equal(enabled, false);
    const disabled = await instance.listTools();
    for (const name of DOCK_TOOL_NAMES) {
      assert.equal(disabled.tools.find((tool) => tool.name === name)?.active, false);
    }
  } finally {
    await instance.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

const CROSS_MACHINE_PROVIDER = "dock-tools-loopback";
const CROSS_MACHINE_MODEL = "dock-tools-model";
const CROSS_MACHINE_PROMPT = "Use dock_list once to find the Main sentinel.";
const MAIN_SENTINEL = "Main-owned sentinel";

test("real Pi Workers discover, delegate and exchange findings through SubHost and encrypted Main authority", { timeout: 50_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-cross-machine-dock-tools-"));
  await chmod(root, 0o700);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workerHome = join(root, "worker-home");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(sessionDir), mkdir(workerHome)]);

  const provider = new DockListLoopbackProvider();
  await provider.start();
  const coordinatorProvider = new PlanGoalProvider(), reviewerProvider = new PlanGoalProvider();
  const collaborationModels: Record<string, unknown> = {};
  for (const [name, localProvider] of [["routed-coordinator", coordinatorProvider], ["routed-reviewer", reviewerProvider]] as const) {
    collaborationModels[name] = { baseUrl: await localProvider.start(), api: "openai-completions", apiKey: "fixture-only",
      models: [{ id: "fixture", name, reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  }
  await Promise.all([
    writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        ...collaborationModels,
        [CROSS_MACHINE_PROVIDER]: {
          baseUrl: `${provider.origin}/v1`,
          api: "openai-completions",
          apiKey: "dock-tools-loopback-key",
          models: [{
            id: CROSS_MACHINE_MODEL,
            name: "Dock tools loopback model",
            reasoning: false,
            input: ["text"],
            contextWindow: 32_000,
            maxTokens: 2_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }), "utf8"),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: CROSS_MACHINE_PROVIDER,
      defaultModel: CROSS_MACHINE_MODEL,
      retry: { enabled: false },
    }), "utf8"),
  ]);

  const mainCatalog = join(root, "main", "catalog.json");
  const subCatalog = join(root, "sub", "catalog.json");
  const joinPath = join(root, "join.json");
  const socketPath = join(root, "main.sock");
  const port = await reservePort();
  const machineState = new MainMachineState(machineStateRoot(mainCatalog), "Dock Tools Main");
  await machineState.initialize();
  await writeMachineJoinFile(joinPath, await machineState.createJoin());
  const listenerSettings = new MachineSettingsState(join(root, "main-listener"));
  await listenerSettings.writeMainConnections({ enabled: true, port });

  const mainRegistry = new DockRegistry(async (input) => new ManagedInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    key: input.key,
    session: new DelayedAgentWorkerConnection(`main-worker-${input.id}`),
  }));
  const sentinel = await mainRegistry.create({ operationId: "main-sentinel-create", cwd: workspace, name: MAIN_SENTINEL });
  assert.equal(sentinel.snapshot().displayName, MAIN_SENTINEL);

  let dockTools!: MainMachineDockToolsAuthority;
  let mainHost!: DockHost;
  const controller = new MainMachineController({
    state: machineState,
    settingsState: listenerSettings,
    bindAddress: "::1",
    mainHostEpoch: mainRegistry.hostEpoch,
    localSnapshots: () => mainRegistry.list(),
    invokeDockTool: (sourceMainId, sourceMachineId, request) => dockTools.invoke(sourceMainId, sourceMachineId, request),
  });
  dockTools = new MainMachineDockToolsAuthority({
    controller: () => controller,
    instances: () => mainHost.instanceDirectory(),
    localClient: new DockClient({ socketPath }),
    deliverLocalNotification: async () => {},
  });
  mainHost = new DockHost({ socketPath, registry: mainRegistry, remoteInstances: controller });
  let child: ChildProcess | undefined;
  context.after(async () => {
    if (child) await stopChild(child);
    await mainHost.stop().catch(() => {});
    await provider.stop();
    await coordinatorProvider.stop();
    await reviewerProvider.stop();
    await rm(root, { recursive: true, force: true });
  });
  await mainHost.start();

  child = spawn(process.execPath, [
    new URL("./fixtures/subhost-machine.js", import.meta.url).pathname,
    subCatalog,
    workspace,
    "::1",
    String(port),
    joinPath,
    "real-pi-dock-tools",
    agentDir,
    sessionDir,
    workerHome,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedProcessEnvironment(root, { XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data") }),
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { childStdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { childStderr += chunk.toString("utf8"); });

  const client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 20_000 });
  const remote = await waitForRemotePi(client).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${childStderr}`); });
  const ready = await waitForFixtureReady(() => childStdout).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${childStderr}`); });
  assert.equal(typeof ready.workerPid, "number");
  assert.notEqual(ready.workerPid, child.pid, "Pi must execute in a Worker process, not the SubHost process");

  await client.prompt(remote.id, "/dock-tools on", "prompt", "enable-cross-machine-dock-tools");
  await waitFor(async () => (await client.tools(remote.id)).tools.some((tool) => tool.name === "dock_list" && tool.active), "real SubHost Worker did not activate dock_list");
  const accepted = await client.prompt(remote.id, CROSS_MACHINE_PROMPT, "prompt", "cross-machine-dock-list");
  assert.equal(accepted.receipt.delivery, "prompt");
  let toolHistory: unknown;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = (await client.history(remote.id)).entries;
    toolHistory = entries.find((entry) => entry.source === "tool" && entry.toolName === "dock_list" && JSON.stringify(entry).includes(MAIN_SENTINEL));
    if (toolHistory) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(toolHistory, `real dock_list result did not reach Worker history; recent provider requests=${JSON.stringify(provider.requests.slice(-2))}; stderr=${childStderr}`);
  assert.ok(provider.requests.some(requestAdvertisesDockList), "the real Worker must advertise the registered dock_list tool to its provider");
  assert.ok(provider.requests.some(requestContainsSentinelToolResult), "the provider continuation must contain dock_list's real Main-owned sentinel result");
  assert.equal(provider.error, undefined);

  // Both workers below are real separate processes on the SubHost. Creation
  // and messages travel through the encrypted Main authority and back, so
  // native/global identity mismatches cannot hide behind a fake route map.
  await waitFor(async () => (await client.status(remote.id)).execution === "idle", "Remote list did not settle");
  await client.setModel(remote.id, "routed-coordinator", "fixture", "routed-team-model");
  await client.prompt(remote.id, "Delegate an independent review.", "auto", "routed-team-start");
  // The child Work model list belongs to the source's own machine, so the SubHost answers it.
  (await coordinatorProvider.request(0)).tools({ id: "routed-models", name: "dock_models", arguments: {} });
  const choosing = await coordinatorProvider.request(1);
  assert.match(JSON.stringify(choosing.body.messages?.at(-1)), /Your model, which child Works use unless you are asked for another: routed-coordinator\/fixture/);
  choosing.tools({ id: "routed-spawn", name: "dock_spawn", arguments: {
    name: "Routed reviewer", task: "Review the workspace.",
    model: { provider: "routed-reviewer", id: "fixture" }, thinkingLevel: "low", allowedTools: ["read"],
  } });
  const reviewing = await reviewerProvider.request(0);
  const waiting = await coordinatorProvider.request(2);
  const reviewer = (await client.list()).find((work) => work.displayName === "Routed reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer.parentId, remote.id, "Main must expose the global source identity as parent");
  // User decision 2026-10-31: Main's authority holds a child Work to messaging its parent.
  // The parent's turn goes on and it later hears from its child, so neither request took effect.
  for (const type of ["stop", "interrupt"] as const) {
    await assert.rejects(dockTools.invoke(reviewer.id, remote.hostId!, { type, target: remote.id, operationId: `main-denied-${type}` }), `the child's ${type} is refused`);
    assert.equal(waiting.closed, false);
  }
  // An ordinary Work's child runs on its Machine: one on Main cannot own a child on a SubHost. Only the resident
  // assistant's may run elsewhere (card #676), and Main starts those itself.
  await assert.rejects(client.create(workspace, "CrossHostChild", "cross-host-child", undefined, remote.hostId, undefined, { parentId: sentinel.id }), /Only the resident assistant's child Works/u);
  assert.ok(!(await client.list()).some((work) => work.displayName === "CrossHostChild"));
  assert.equal(typeof ready.nativeInstanceId, "string");
  assert.notEqual(remote.id, ready.nativeInstanceId);
  assert.deepEqual(reviewer.executor.model, { provider: "routed-reviewer", id: "fixture" });
  assert.equal(reviewer.executor.thinkingLevel, "low");
  assert.deepEqual(reviewing.toolNames.sort(), ["dock_send", "read"]);
  // Card #666: a child Work and its parent run on the same SubHost, which carries their messages itself.
  reviewing.tools({ id: "routed-note", name: "dock_send", arguments: { message: "ROUTED_NOTE", done: false } });
  const noted = await reviewerProvider.request(1);
  assert.match(JSON.stringify(noted.body.messages?.filter(message => message.role === "tool").at(-1)), /Your message reached your parent Work/);
  let routedReply = "ROUTED_REVIEW_FINDING";
  for (let index = 0; routedReply.length < 20_000; index += 1) routedReply += ` finding-${index}`;
  routedReply += " ROUTED_END";
  // It reads on and then answers in its own conversation without sending it, so its parent is told it stopped.
  noted.tools({ id: "routed-read", name: "read", arguments: { path: join(workspace, "notes.txt") } });
  (await reviewerProvider.request(2)).text(routedReply);
  assert.equal(waiting.closed, false, "A message must not interrupt its busy recipient");
  waiting.text("Waiting for the independent report.");
  let next = 3, sawNote = false, sawStop = false, inspected = false;
  while (next < 12 && !(sawNote && inspected)) {
    const request = await coordinatorProvider.request(next++);
    const transcript = JSON.stringify(request.body.messages);
    sawNote ||= transcript.includes("[来自子 Work「Routed reviewer」]\\nROUTED_NOTE");
    if (!sawStop && transcript.includes("[子 Work「Routed reviewer」异常停止]")) {
      sawStop = true;
      assert.ok(transcript.includes("> ROUTED_REVIEW_FINDING") && transcript.includes("[…shortened]") && !transcript.includes("ROUTED_END"), "The notice quotes the start of what the reviewer said last");
      request.tools({ id: "routed-inspect", name: "dock_inspect", arguments: { target: reviewer.id } });
      continue;
    }
    if (sawStop && !inspected) {
      inspected = true;
      assert.ok(JSON.stringify(request.body.messages?.filter(message => message.role === "tool").at(-1)).includes(routedReply), "dock_inspect through Main reads the whole reply");
      // Main's ID for the child Work, from dock_spawn and dock_list, reaches it on the SubHost too.
      request.tools({ id: "routed-followup", name: "dock_send", arguments: { target: reviewer.id, message: "ROUTED_FOLLOWUP: send your finding." } });
      continue;
    }
    request.text("Received the routed report.");
  }
  assert.ok(sawNote && sawStop && inspected, "The routed parent must receive its child Work's message and stop notice, and read the whole reply");
  const followup = await reviewerProvider.request(3);
  assert.ok(JSON.stringify(followup.body.messages).includes("[来自父 Work「Remote work」]\\nROUTED_FOLLOWUP"));
  followup.tools({ id: "routed-done", name: "dock_send", arguments: { message: "ROUTED_DONE", done: true } });
  await waitFor(async () => {
    while (coordinatorProvider.requests.length > next) {
      const request = coordinatorProvider.requests[next++]!;
      request.text(JSON.stringify(request.body.messages).includes("[来自子 Work「Routed reviewer」· 已完成]\\nROUTED_DONE") ? "ROUTED_RESULT_SEEN" : "Received completion.");
    }
    return (await client.status(remote.id)).execution === "idle"
      && coordinatorProvider.requests.some((request) => JSON.stringify(request.body.messages).includes("ROUTED_DONE"));
  }, "Routed coordinator did not settle with its child Work's final result");
  assert.equal(reviewerProvider.requests.length, 4, "The final result ended the routed child Work's turn");

  // A Work on a SubHost sees which Machine it is on, and a wrong Machine name gets the real names.
  await client.prompt(remote.id, "Which Machine are you on?", "auto", "routed-machines");
  (await coordinatorProvider.request(next++)).tools({ id: "routed-machines", name: "dock_machines", arguments: {} });
  const machines = await coordinatorProvider.request(next++);
  const machineList = JSON.stringify(machines.body.messages?.at(-1));
  assert.match(machineList, /- Fixture SubHost \(this Work's Machine\) · SubHost/);
  assert.match(machineList, /- Dock Tools Main · Main/);
  machines.tools({ id: "routed-guess", name: "dock_create", arguments: { cwd: workspace, machine: "local" } });
  const guessed = await coordinatorProvider.request(next++);
  const refusal = JSON.stringify(guessed.body.messages?.at(-1));
  assert.ok(refusal.includes("Dock Tools Main") && refusal.includes("Fixture SubHost"), "The refusal names the Machines there are");
  guessed.text("I am on Fixture SubHost.");
  await waitFor(async () => (await client.status(remote.id)).execution === "idle", "Routed coordinator did not settle after Machines");
  const spawned = childStdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { kind: string; parentId?: string; pid?: number });
  const childPid = spawned.find(record => record.kind === "worker_started" && record.parentId === ready.nativeInstanceId)?.pid;
  assert.equal(typeof childPid, "number", "Child ownership is stored using the SubHost's native parent identity");
  // Main can learn that the parent is gone before SubHost finishes its children.
  // Hold only this fixture child to reproduce the lost Stop receipt (2026-11-18).
  const holdChild = process.platform !== "win32";
  if (holdChild) process.kill(childPid!, "SIGSTOP");
  const stopping = client.stop(remote.id, "routed-parent-stop");
  void stopping.catch(() => {});
  if (holdChild) {
    try {
      await waitFor(async () => !(await client.list()).some(work => work.id === remote.id), "Parent did not leave the Main directory during child cleanup");
    } finally { if (!exited(childPid!)) process.kill(childPid!, "SIGCONT"); }
  }
  const stopped = await stopping;
  assert.equal(stopped.receipt.operationId, "routed-parent-stop");
  assert.equal(stopped.instance.id, remote.id);
  assert.equal(stopped.instance.lifecycle, "stopped");
  await waitFor(() => [Number(ready.workerPid), childPid!].every(exited), "Routed parent stop must terminate both real SubHost Worker processes");
  await waitFor(async () => !(await client.list()).some(work => work.id === reviewer.id), "Retired SubHost child remained in Main's inventory");
  assert.equal((await client.status(sentinel.id)).lifecycle, "active");
});

// Card #676 (user decision 2026-11-22): the resident assistant stays on Main, and the Work she hands engineering
// work to runs where the project is. It reports to her through Main and stops with her.
test("the resident assistant's child Work runs on a SubHost, reports to her through Main and stops with her", { timeout: 50_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-child-elsewhere-"));
  await chmod(root, 0o700);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workerHome = join(root, "worker-home");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(sessionDir), mkdir(workerHome)]);
  const leadProvider = new PlanGoalProvider();
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "remote-lead": {
    baseUrl: await leadProvider.start(), api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "fixture", name: "remote-lead", reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), "utf8");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "remote-lead", defaultModel: "fixture", retry: { enabled: false } }), "utf8");

  const mainCatalog = join(root, "main", "catalog.json");
  const joinPath = join(root, "join.json");
  const socketPath = join(root, "main.sock");
  const port = await reservePort();
  const machineState = new MainMachineState(machineStateRoot(mainCatalog), "Assistant Main");
  await machineState.initialize();
  await writeMachineJoinFile(joinPath, await machineState.createJoin());
  const listenerSettings = new MachineSettingsState(join(root, "main-listener"));
  await listenerSettings.writeMainConnections({ enabled: true, port });

  const mainSessions = new Map<string, DelayedAgentWorkerConnection>();
  let controller!: MainMachineController;
  let mainHost!: DockHost;
  const client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 20_000 });
  const elsewhere: AssistantChildrenElsewhere = new AssistantChildrenElsewhere({
    local: (instanceId) => mainRegistry.list().find((item) => item.id === instanceId),
    snapshots: () => mainHost.instanceDirectory().snapshots(),
    isResidentAssistant: (instanceId) => instanceId === assistant.id,
    machineAvailable: async (machineId) => (await controller.machines()).some((machine) => machine.hostId === machineId && machine.available),
    deliver: (parentId, message) => mainRegistry.get(parentId).deliverWorkMessage(message),
    stop: async (instanceId) => { await client.stop(instanceId, randomUUID()); },
    speedOf: (parentId) => mainRegistry.passedDownSpeed(parentId),
    sendSpeed: (machineId, parentId, tier) => controller.sendParentSpeed(machineId, parentId, tier),
  });
  const mainRegistry: DockRegistry = new DockRegistry(async (input) => {
    const session = new DelayedAgentWorkerConnection(`main-worker-${input.id}`);
    mainSessions.set(input.id, session);
    return new ManagedInstance({ id: input.id, creationOperationId: input.creationOperationId, hostEpoch: input.hostEpoch, cwd: input.cwd, name: input.name, key: input.key, session });
  }, undefined, { remoteChildren: elsewhere });
  // The resident assistant's own Worker is not needed here: Main's authority knows her by this ID.
  const assistant = await mainRegistry.create({ operationId: "assistant-stand-in", cwd: workspace, name: "Alu" });
  const ordinary = await mainRegistry.create({ operationId: "ordinary", cwd: workspace, name: "Ordinary Main Work" });
  let dockTools!: MainMachineDockToolsAuthority;
  controller = new MainMachineController({
    state: machineState, settingsState: listenerSettings, bindAddress: "::1", mainHostEpoch: mainRegistry.hostEpoch,
    localSnapshots: () => mainRegistry.list(),
    invokeDockTool: (sourceMainId, sourceMachineId, request) => dockTools.invoke(sourceMainId, sourceMachineId, request),
    remoteChildren: elsewhere,
  });
  dockTools = new MainMachineDockToolsAuthority({
    controller: () => controller, instances: () => mainHost.instanceDirectory(), localClient: new DockClient({ socketPath }),
    deliverLocalNotification: async () => {}, isResidentAssistant: (instanceId) => instanceId === assistant.id, childrenElsewhere: elsewhere,
  });
  mainHost = new DockHost({ socketPath, registry: mainRegistry, remoteInstances: controller });
  let child: ChildProcess | undefined;
  context.after(async () => {
    if (child) await stopChild(child);
    await mainHost.stop().catch(() => {});
    await leadProvider.stop();
    await rm(root, { recursive: true, force: true });
  });
  await mainHost.start();
  child = spawn(process.execPath, [
    new URL("./fixtures/subhost-machine.js", import.meta.url).pathname,
    join(root, "sub", "catalog.json"), workspace, "::1", String(port), joinPath, "real-pi-dock-tools", agentDir, sessionDir, workerHome,
  ], { stdio: ["ignore", "pipe", "pipe"], env: isolatedProcessEnvironment(root, { XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data") }) });
  let childStdout = "";
  let childStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { childStdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { childStderr += chunk.toString("utf8"); });
  const remote = await waitForRemotePi(client).catch((error) => { throw new Error(`${String(error)}; SubHost stderr: ${childStderr}`); });
  await waitForFixtureReady(() => childStdout);
  const mainHostId = (await controller.machines()).find((machine) => machine.kind === "main")!.hostId;
  const her = mainSessions.get(assistant.id)!;
  const workerOf = (parentId: string): number | undefined => childStdout.split("\n").filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { kind: string; parentId?: string; pid?: number })
    .filter((record) => record.kind === "worker_started" && record.parentId === parentId).at(-1)?.pid;
  const spawnThere = (source: string, operationId: string, name: string, cwd: string | null = workspace) => dockTools.invoke(source, mainHostId, {
    type: "spawn", operationId, name, task: `${name}: lead the remote work.`, ...(cwd === null ? {} : { cwd }), machine: "Fixture SubHost",
    model: { provider: "remote-lead", id: "fixture" }, thinkingLevel: "low",
  });

  // An ordinary Work keeps its child Works on its own Machine, and she names a directory on the other one.
  await assert.rejects(spawnThere(ordinary.id, "ordinary-elsewhere", "Elsewhere"), /runs on the Machine of the Work that starts it/u);
  await assert.rejects(spawnThere(assistant.id, "no-directory", "Nowhere", null), /Give cwd/u);

  const spawned = await spawnThere(assistant.id, "remote-lead", "Remote lead");
  assert.ok(spawned.type === "spawn" && spawned.taskStatus === "accepted", JSON.stringify(spawned));
  const lead = spawned.instance;
  assert.equal(lead.parentId, assistant.id, "it appears under her");
  assert.equal((await client.status(lead.id)).hostId, remote.hostId);
  const first = await leadProvider.request(0);
  assert.ok(first.toolNames.includes("dock_spawn"), "she does no work herself, so it may hand parts out on its Machine");
  assert.match(JSON.stringify(first.body.messages), /Remote lead: lead the remote work/u);

  // What it tells her reaches her under the ID her dock_spawn result gave her.
  first.tools({ id: "lead-note", name: "dock_send", arguments: { message: "LEAD_NOTE", done: false } });
  await waitFor(() => her.workMessages.length > 0, "The child Work's message did not reach her on Main");
  assert.deepEqual(her.workMessages[0], { type: "message", from: { relation: "child", id: lead.id, name: "Remote lead" }, text: "LEAD_NOTE" });
  const noted = await leadProvider.request(1);
  assert.match(JSON.stringify(noted.body.messages?.filter((message) => message.role === "tool").at(-1)), /Your message reached your parent Work/u);
  // It reads on and ends its turn without the result: Dock tells her.
  noted.tools({ id: "lead-read", name: "read", arguments: { path: join(workspace, "notes.txt") } });
  (await leadProvider.request(2)).text("Still reading.");
  await waitFor(() => her.workMessages.some((message) => message.type === "child_stopped"), "She was not told her child Work stopped without its result");
  const notice = her.workMessages.find((message) => message.type === "child_stopped")!;
  assert.deepEqual(notice.from, { relation: "child", id: lead.id, name: "Remote lead" });

  // Her message reaches it numbered, and its final result answers it.
  const asked = await dockTools.invoke(assistant.id, mainHostId, { type: "send", operationId: "followup", target: lead.id, message: "PARENT_FOLLOWUP" });
  assert.ok(asked.type === "work_message" && asked.to === "child");
  assert.equal(asked.target.id, lead.id);
  assert.equal(asked.number, 1);
  const followup = await leadProvider.request(3);
  assert.ok(JSON.stringify(followup.body.messages).includes("[来自父 Work「Alu」]\\nPARENT_FOLLOWUP"));
  followup.tools({ id: "lead-done", name: "dock_send", arguments: { message: "LEAD_DONE", done: true } });
  await waitFor(() => her.workMessages.some((message) => message.type === "message" && message.done === true), "Her child Work's final result did not reach her");
  assert.deepEqual(her.workMessages.at(-1), { type: "message", from: { relation: "child", id: lead.id, name: "Remote lead" }, text: "LEAD_DONE", done: true, settlesThrough: 1 });

  // She stops it: nothing is owed any more, and its Worker exits on its Machine.
  const leadPid = workerOf(assistant.id);
  assert.equal(typeof leadPid, "number");
  const heard = her.workMessages.length;
  const stopped = await dockTools.invoke(assistant.id, mainHostId, { type: "stop", operationId: "stop-lead", target: lead.id });
  assert.ok(stopped.type === "stop");
  assert.equal(stopped.instance.id, lead.id);
  assert.equal(stopped.settlesThrough, 1);
  await waitFor(() => exited(leadPid!), "The stopped child Work's Worker kept running on its Machine");
  assert.equal(her.workMessages.length, heard, "no stop notice follows her own Stop");

  // When she stops, her child Work on the other Machine stops with her.
  const again = await spawnThere(assistant.id, "second-lead", "Second lead");
  assert.ok(again.type === "spawn" && again.taskStatus === "accepted");
  await leadProvider.request(4);
  const secondPid = workerOf(assistant.id);
  assert.ok(secondPid !== undefined && secondPid !== leadPid);
  await mainRegistry.stop(assistant.id, "assistant-stop");
  await waitFor(() => exited(secondPid), "Her child Work on the SubHost outlived her");
  await waitFor(async () => !(await client.list()).some((work) => work.id === again.instance.id), "Her stopped child Work stayed in Main's list");
  assert.equal((await client.status(remote.id)).lifecycle, "active", "the SubHost's own Work is not hers");
});

class DockListLoopbackProvider {
  readonly requests: unknown[] = [];
  readonly sockets = new Set<Socket>();
  readonly server = createHttpServer((request, response) => {
    void this.respond(request, response).catch((error: unknown) => {
      this.error = error instanceof Error ? error : new Error(String(error));
      response.destroy(this.error);
    });
  });
  origin = "";
  error: Error | undefined;

  constructor() {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer dock-tools-loopback-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    this.requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (!requestContainsToolResult(body)) {
      sendProviderDelta(response, { role: "assistant", content: "checking Dock; " });
      sendProviderDelta(response, { tool_calls: [{ index: 0, id: "dock_list_call", type: "function", function: { name: "dock_list", arguments: "{}" } }] });
      finishProviderResponse(response, "tool_calls");
      return;
    }
    sendProviderDelta(response, { role: "assistant", content: "Main sentinel found" });
    finishProviderResponse(response, "stop");
  }
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port is unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForRemotePi(client: DockClient): Promise<Awaited<ReturnType<DockClient["list"]>>[number]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const remote = (await client.list("all")).find((snapshot) => snapshot.creationOperationId === "native-create");
    if (remote?.lifecycle === "active" && remote.execution === "idle") return remote;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("real Pi SubHost instance did not become ready");
}

async function waitForFixtureReady(stdout: () => string): Promise<{ workerPid?: number; nativeInstanceId?: string }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    for (const line of stdout().split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { kind?: unknown; workerPid?: number; nativeInstanceId?: string };
        if (value.kind === "ready") return value;
      } catch { /* wait for a complete line */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("real Pi SubHost fixture did not report ready");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function requestAdvertisesDockList(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("tools" in body) || !Array.isArray(body.tools)) return false;
  return body.tools.some((tool) => JSON.stringify(tool).includes('"name":"dock_list"'));
}

function requestContainsToolResult(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return false;
  return body.messages.some((message) => message !== null && typeof message === "object" && "role" in message && message.role === "tool");
}

function requestContainsSentinelToolResult(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return false;
  return body.messages.some((message) => message !== null && typeof message === "object" && "role" in message
    && message.role === "tool" && JSON.stringify(message).includes(MAIN_SENTINEL));
}

function sendProviderDelta(response: ServerResponse, delta: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-dock-tools",
    object: "chat.completion.chunk",
    created: 1,
    model: CROSS_MACHINE_MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
}

function finishProviderResponse(response: ServerResponse, finishReason: "stop" | "tool_calls"): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-dock-tools",
    object: "chat.completion.chunk",
    created: 1,
    model: CROSS_MACHINE_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
