import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDefaultSystemPromptBody, SessionManager } from "@earendil-works/pi-coding-agent";
import { DockClient } from "../src/control/dock-client.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { DockHost } from "../src/control/dock-host.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { JsonLineDecoder, encodeJsonLine } from "../src/control/json-lines.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MainMachineController, SubHostMachineConnection } from "../src/control/machine-transport.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { SystemService } from "../src/control/system-service.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { createPiSystemTemplateProvider } from "../src/pi/system-template-provider.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

// Seed a real durable journal: no model request is needed to test conversation continuity.
function savedSession(cwd: string, sessionDir: string) {
  const seed = SessionManager.create(cwd, sessionDir);
  seed.appendMessage({ role: "user", content: "Saved question", timestamp: 0 });
  seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Existing conversation" }], api: "openai-completions", provider: "openai", model: "gpt-4o-mini", stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return seed.getSessionFile()!;
}

test("change an open Work’s base system, keep the conversation usable after a bad choice, and reopen with the chosen system", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ssw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "one"), other = join(root, "two"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const templates = join(root, ".aludock", "systems"), captureFile = join(root, "assembled");
  for (const path of [join(cwd, ".pi"), join(other, ".pi"), join(agentDir, "extensions"), templates, sessionDir]) await mkdir(path, { recursive: true });
  const project = join(cwd, ".pi", "SYSTEM.md"), global = join(agentDir, "SYSTEM.md");
  await writeFile(project, "BASE ONE"); await writeFile(join(other, ".pi", "SYSTEM.md"), "BASE TWO"); await writeFile(global, "BASE GLOBAL");
  await writeFile(join(templates, "review.json"), JSON.stringify({ ...getDefaultSystemPromptBody(), intro: "BASE REVIEW" }));
  await writeFile(join(templates, "broken.json"), "{}");
  await writeFile(join(agentDir, "extensions", "capture.ts"), `import {writeFileSync} from 'node:fs'; export default pi => pi.registerCommand('capture-base', { description: 'Record the current prompt without invoking a model', handler: async (_,ctx) => writeFileSync(${JSON.stringify(captureFile)}, ctx.getSystemPrompt()) });`);
  const store = new FileCatalogStore(join(root, "catalog.json"));
  const makeRegistry = () => new DockRegistry(input => createPiInstance({ ...input, agentDir, sessionDir, workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir, npm_config_cache: join(root, ".npm") }) }), undefined,
    { catalogStore: store, reopenTargetResolver: { resolve: resolvePiReopenTarget }, systemService: new SystemService(root, createPiSystemTemplateProvider(agentDir)), trustPreflight: { resolve: async ({cwd}) => ({ canonicalCwd: cwd, projectTrusted: cwd !== other }) } });
  let registry = makeRegistry();
  let sub = new DockHost({ registry, socketPath: join(root, "sub.sock"), listen: false, initialize: () => registry.initializeCatalog() });
  const state = new MainMachineState(join(root, "main"), "Main"); await state.initialize();
  const peer = new SubHostMachineState(join(root, "peer")); await peer.prepare(await state.createJoin(), "System machine");
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const address = probe.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>(r => probe.close(() => r()));
  const settings = new MachineSettingsState(join(root, "settings")); await settings.writeMainConnections({ enabled: true, port: address.port });
  const mainRegistry = new DockRegistry(async () => { throw new Error("Wrong target machine"); });
  const main = new DockHost({ registry: mainRegistry, socketPath: join(root, "main.sock"), remoteInstances: new MainMachineController({ state, settingsState: settings, bindAddress: "127.0.0.1", mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => [] }) });
  let oldPeer = false;
  const upstream = new SubHostMachineConnection({ state: peer, address: "127.0.0.1", port: address.port, hostEpoch: registry.hostEpoch, snapshots: () => registry.list(), acceptProtocolSocket: socket => {
    if (!oldPeer) return sub.acceptProtocolSocket(socket);
    const decoder = new JsonLineDecoder();
    socket.on("data", chunk => { for (const line of decoder.push(chunk)) {
      const hello = JSON.parse(line); if (hello.kind !== "hello") return;
      const missing = hello.requiredCapabilities.filter((c: string) => c === "system.set.v1");
      socket.end(encodeJsonLine({ kind: "hello_error", requestId: hello.requestId, error: { code: "capability_missing", message: "Unsupported", missing } }));
    } });
  } });
  const client = new DockClient({ socketPath: main.socketPath });
  try {
    await sub.start(); await main.start(); await upstream.start();
    for (let n = 0; !upstream.connected() && n < 100; n++) await new Promise(r => setTimeout(r, 25));
    const hostId = (await client.machines()).machines.find(m => m.name === "System machine")!.hostId;
    const file = savedSession(cwd, sessionDir), second = savedSession(other, sessionDir);
    const work = (await client.adopt(file, undefined, undefined, undefined, hostId)).instance;
    const choices = (await client.systemCatalog(cwd, hostId)).candidates;
    const choice = (name: string) => choices.find(c => c.path === name)!.id;
    const assembled = async () => {
      await rm(captureFile, { force: true });
      await client.prompt(work.id, "/capture-base", "prompt");
      for (let n = 0; n < 100; n++) { const text = await readFile(captureFile, "utf8").catch(() => ""); if (text) return text; await new Promise(r => setTimeout(r, 20)); }
      throw new Error("No assembled system received");
    };
    const review = choice(join(templates, "review.json"));
    for (const [id, kind, text] of [[choice(project), "project-system", "BASE ONE"], [choice(global), "global-system", "BASE GLOBAL"], [review, "dock-template", "BASE REVIEW"]] as const) {
      const op = `switch-${kind}`, result = await client.setInstanceSystem(work.id, id, op);
      assert.equal(result.instance.executor.piSessionId, work.executor.piSessionId);
      assert.equal(result.systemSource?.kind, kind); assert.equal(result.systemSource?.explicit, true);
      assert.equal((await client.setInstanceSystem(work.id, id, op)).instance.runtimeGeneration, result.instance.runtimeGeneration);
      assert.ok((await assembled()).includes(text));
    }
    const tree = await client.tree(work.id);
    await client.cloneSession(work.id, tree.nodes.find(n => n.role === "assistant")!.entryId);
    assert.ok((await assembled()).includes("BASE REVIEW"));
    await client.forkSession(work.id, (await client.tree(work.id)).nodes.find(n => n.role === "user")!.entryId);
    assert.ok((await assembled()).includes("BASE REVIEW"));
    await client.newSession(work.id); assert.ok((await assembled()).includes("BASE REVIEW"));
    await client.switchSession(work.id, file);
    const before = (await client.history(work.id)).instance.runtimeGeneration;
    await assert.rejects(client.setInstanceSystem(work.id, choice(join(templates, "broken.json"))), { code: "resource_unavailable" });
    // null bypasses Host candidate validation: corrupt native bytes exercise the Worker preflight itself.
    await writeFile(project, Buffer.from([0xff])); await assert.rejects(client.setInstanceSystem(work.id, null), { code: "resource_unavailable" });
    assert.equal((await client.history(work.id)).instance.runtimeGeneration, before); assert.ok((await assembled()).includes("BASE REVIEW"));
    await writeFile(project, "BASE ONE");
    assert.deepEqual((await client.setInstanceSystem(work.id, null)).systemSource, { kind: "project-system" });
    await rm(project); assert.deepEqual((await client.reloadSession(work.id)).systemSource, { kind: "global-system" });
    await client.setInstanceSystem(work.id, review); await rm(global);
    assert.deepEqual((await client.setInstanceSystem(work.id, null)).systemSource, { kind: "pi-builtin" });
    const builtin = await assembled(); assert.ok(builtin.includes(getDefaultSystemPromptBody().intro)); assert.ok(!builtin.includes("BASE REVIEW"));
    await writeFile(project, "BASE ONE"); await client.setInstanceSystem(work.id, choice(project));
    await client.switchSession(work.id, second);
    assert.deepEqual((await client.resources(work.id)).systemSource, { kind: "project-system", explicit: true, otherDirectory: true }); assert.ok((await assembled()).includes("BASE ONE"));
    const otherChoices = (await client.systemCatalog(other, hostId)).candidates;
    await assert.rejects(client.setInstanceSystem(work.id, otherChoices.find(c => c.kind === "project-system")!.id), { code: "resource_unavailable" });
    assert.deepEqual((await client.setInstanceSystem(work.id, null)).systemSource, { kind: "pi-builtin" });
    await client.setInstanceSystem(work.id, otherChoices.find(c => c.name === "review.json")!.id);
    oldPeer = true;
    await assert.rejects(client.setInstanceSystem(work.id, null), { code: "capability_missing", details: { missing: ["system.set.v1"] } });
    const nativeId = registry.list()[0]!.id;
    await upstream.stop(); await main.stop(); await sub.stop();
    registry = makeRegistry(); sub = new DockHost({ registry, socketPath: join(root, "sub.sock"), initialize: () => registry.initializeCatalog() }); await sub.start();
    const local = new DockClient({ socketPath: sub.socketPath });
    try {
      await local.reopen(nativeId);
      assert.deepEqual((await local.resources(nativeId)).systemSource, { kind: "dock-template", name: "review.json", explicit: true });
      assert.ok(JSON.stringify((await local.history(nativeId)).entries).includes("Existing conversation"));
    } finally { local.closeActiveConnections(); }
  } finally { client.closeActiveConnections(); await upstream.stop(); await main.stop(); await sub.stop(); }
});
