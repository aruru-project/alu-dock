import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDefaultSystemPromptBody, SessionManager } from "@earendil-works/pi-coding-agent";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostMachineConnection } from "../src/control/machine-transport.js";
import { SystemService } from "../src/control/system-service.js";
import type { SystemCandidate, SystemCatalogCursor } from "../src/control/protocol.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";
import { createPiSystemTemplateProvider, piSystemPromptResolver } from "../src/pi/system-template-provider.js";

test("choose and read a system on the target machine before creating Work, save only on request, and retain its actual source on reopen", { timeout: 45_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-system-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "sub-home"), cwd = join(home, "project"), agentDir = join(home, "native-agent"), sessions = join(home, "sessions");
  const observed = join(home, "observed.txt"), systems = join(home, ".aludock", "systems"), saved = join(cwd, ".aludock", "system-default.json");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(sessions, { recursive: true })]);
  await writeFile(join(cwd, ".pi", "SYSTEM.md"), "PROJECT NATIVE SYSTEM");
  await writeFile(join(agentDir, "SYSTEM.md"), "GLOBAL NATIVE SYSTEM");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "NATIVE APPEND RETAINED");
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT CONTEXT RETAINED");
  await mkdir(join(agentDir, "skills", "fixture"), { recursive: true });
  await writeFile(join(agentDir, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: SYSTEM FIXTURE SKILL\n---\nSkill text.\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "unused-no-model" } }));
  await writeFile(join(agentDir, "extensions", "capture.ts"), `
import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("capture-system", { description: "Fixture records assembled system without a model", handler: async (_, ctx) => {
    writeFileSync(${JSON.stringify(observed)}, ctx.getSystemPrompt());
    pi.sendMessage({ customType: "system-fixture", content: "Captured system", display: false });
  }});
}
`);
  // Card 271: the Host-selected template must survive a different Worker login-shell HOME.
  const workerHome = join(root, "worker-home");
  await mkdir(workerHome);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: workerHome, USERPROFILE: workerHome,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
    APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), TMPDIR: root, TEMP: root, TMP: root,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const store = new FileCatalogStore(join(root, "catalog", "catalog.json"));
  const workerPids: number[] = [];
  const registryFactory = () => new DockRegistry((input) => createPiInstance({ ...input, agentDir, sessionDir: sessions,
    workerEnvironment: env, onWorkerSpawn: (pid) => workerPids.push(pid) }), undefined,
  { catalogStore: store, reopenTargetResolver: { resolve: resolvePiReopenTarget }, systemService: new SystemService(home, createPiSystemTemplateProvider(agentDir)) });
  let registry = registryFactory();
  const makeSubHost = (listen: boolean) => new DockHost({ socketPath: join(root, "sub.sock"), registry, listen,
    initialize: () => registry.initializeCatalog() });
  let subHost = makeSubHost(false);
  const mainState = new MainMachineState(join(root, "main-state"), "Main");
  await mainState.initialize();
  const subState = new SubHostMachineState(join(root, "sub-state"));
  await subState.prepare(await mainState.createJoin(), "Selected machine");
  const port = await reservePort();
  const settings = new MachineSettingsState(join(root, "listener"));
  await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry(async () => { throw new Error("This flow must create only on the selected machine"); });
  const controller = new MainMachineController({ state: mainState, settingsState: settings, bindAddress: "127.0.0.1",
    mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => [] });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller });
  const upstream = new SubHostMachineConnection({ state: subState, address: "127.0.0.1", port, hostEpoch: registry.hostEpoch,
    snapshots: () => registry.list(), acceptProtocolSocket: (socket) => subHost.acceptProtocolSocket(socket) });
  const client = new DockClient({ socketPath: main.socketPath, timeoutMs: 10_000 });
  let local: DockClient | undefined;
  try {
    await subHost.start(); await main.start(); await upstream.start();
    await waitFor(() => upstream.connected());
    const machine = (await client.machines()).machines.find((item) => item.name === "Selected machine");
    assert.ok(machine);
    const hostId = machine.hostId;
    const nativeFallback = await client.create(cwd, "No Dock default", undefined, undefined, hostId);
    assert.ok((await client.resources(nativeFallback.id)).resources.some((item) => item.path === join(cwd, ".pi", "SYSTEM.md")));
    await assert.rejects(readFile(join(systems, "pi-default.json")), { code: "ENOENT" }, "a creation default lookup does not initialize templates");
    await client.stop(nativeFallback.id);
    const first = await client.systemCatalog(cwd, hostId, undefined, 1);
    assert.equal(first.defaultSelection, undefined);
    assert.deepEqual(first.warnings, []);
    const all: SystemCandidate[] = [...first.candidates];
    let cursor: SystemCatalogCursor | undefined = first.nextCursor;
    while (cursor) { const page = await client.systemCatalog(cwd, hostId, cursor, 1); all.push(...page.candidates); cursor = page.nextCursor; }
    assert.deepEqual(all.map((item) => item.kind), ["project-system", "global-system", "dock-template"]);
    assert.deepEqual(JSON.parse(await readFile(join(systems, "pi-default.json"), "utf8")), getDefaultSystemPromptBody());
    assert.equal(registry.list().length, 0, "preview and selection must precede Work creation");
    const selectedPath = join(systems, "chosen.json");
    const body = { intro: "EXPLICIT DOCK BODY", toolNotes: "TOOL NOTES", guidelines: ["Keep the chosen body"], documentationHeading: "DOCS", documentationInstructions: ["Read docs"] };
    // Card 271 review: BOM is file encoding, not JSON syntax or prompt prose.
    const selectedText = "\uFEFF" + JSON.stringify(body, null, 2);
    await writeFile(selectedPath, selectedText);
    const chosen = (await client.systemCatalog(cwd, hostId)).candidates.find((item) => item.path === selectedPath)!;
    assert.equal(chosen.warning, undefined, "UTF-8 BOM JSON remains selectable");
    const longText = "中文 😀 café\n".repeat(9_000);
    await writeFile(join(cwd, ".pi", "SYSTEM.md"), longText);
    let offset: number | undefined, revision: string | undefined, full = "", pages = 0;
    do { const page = await client.systemContent(cwd, all[0]!.id, hostId, offset, revision); full += page.text; offset = page.nextOffset; revision = page.revision; pages++; } while (offset !== undefined);
    assert.equal(full, longText); assert.ok(pages > 1);
    assert.equal((await client.systemContentAll(cwd, chosen.id, hostId)).text, selectedText);
    // Candidate IDs, not arbitrary paths or another cwd, are the source-file read authority.
    await assert.rejects(client.systemContent(cwd, join(agentDir, "auth.json"), hostId), { code: "resource_unavailable" });
    await assert.rejects(client.systemContent(home, chosen.id, hostId), { code: "resource_unavailable" });
    await writeFile(join(cwd, ".pi", "SYSTEM.md"), "PROJECT NATIVE SYSTEM");
    let work = await client.create(cwd, "Selected system", undefined, undefined, hostId, chosen.workerConfig);
    assert.ok(workerPids[0] && workerPids[0] !== process.pid);
    await client.prompt(work.id, "/capture-system", "prompt");
    await waitFor(async () => (await readFile(observed, "utf8").catch(() => "")).includes("EXPLICIT DOCK BODY"));
    const assembled = await readFile(observed, "utf8");
    for (const text of ["EXPLICIT DOCK BODY", "NATIVE APPEND RETAINED", "PROJECT CONTEXT RETAINED", "SYSTEM FIXTURE SKILL"]) assert.ok(assembled.includes(text), text);
    assert.ok(!assembled.includes("PROJECT NATIVE SYSTEM") && !assembled.includes("GLOBAL NATIVE SYSTEM"));
    await assert.rejects(readFile(saved), { code: "ENOENT" });
    const resource = (await client.resources(work.id)).resources.find((item) => item.path === selectedPath);
    assert.ok(resource?.contentRef);
    assert.equal((await client.resourceContent(work.id, resource.contentRef)).text, selectedText);
    const receipt = await client.setSystemDefault(cwd, chosen.id, hostId, "save-choice");
    assert.equal(receipt.selection.id, chosen.id);
    assert.deepEqual(JSON.parse(await readFile(saved, "utf8")), { id: chosen.id });
    const withDefault = await client.systemCatalog(cwd, hostId, undefined, 1);
    assert.equal(withDefault.defaultSelection?.id, chosen.id, "saved default is usable even outside this candidate page");
    // Host defaults are product behavior, not a feature opt-in by newer Clients.
    const implicit = await client.create(cwd, "Old client uses Host default", "implicit-default", undefined, hostId);
    assert.ok((await client.resources(implicit.id)).resources.some((item) => item.path === selectedPath), "an ordinary create without selection uses the target Host default");
    assert.deepEqual((await store.load())!.instances.find((item) => item.creationOperationId === implicit.creationOperationId)?.workerConfig, chosen.workerConfig);
    await client.setSystemDefault(cwd, all[1]!.id, hostId);
    assert.equal((await client.create(cwd, "Old client uses Host default", "implicit-default", undefined, hostId)).id, implicit.id, "the same creation operation does not resolve a newer default again");
    await client.setSystemDefault(cwd, chosen.id, hostId);
    const configured = await client.create(cwd, "Other configuration keeps Host default", undefined, undefined, hostId, { tools: ["read"] });
    assert.ok((await client.resources(configured.id)).resources.some((item) => item.path === selectedPath), "tools are not an explicit system override");
    assert.equal((await client.tools(configured.id)).tools.some((item) => item.name === "bash" && item.active), false);
    const ensured = await client.ensure("host-default-key", cwd, "Ensure default", "ensure-default", undefined, hostId);
    assert.ok((await client.resources(ensured.instance.id)).resources.some((item) => item.path === selectedPath));
    for (const id of [work.id, configured.id]) await client.stop(id);
    work = implicit; // The later reload/reopen assertions now prove Host-resolved defaults stay bound.
    await mkdir(join(cwd, "child"));
    assert.equal((await client.systemCatalog(join(cwd, "child"), hostId)).defaultSelection, undefined, "no parent-directory inheritance");
    await writeFile(saved, "{bad JSON");
    const bad = await client.systemCatalog(cwd, hostId);
    assert.equal(bad.defaultSelection, undefined); assert.ok(bad.warnings.length); assert.ok(bad.candidates.length);
    const beforeInvalidDefault = workerPids.length;
    await assert.rejects(client.create(cwd, undefined, undefined, undefined, hostId), { code: "system_default_unavailable" });
    assert.equal(workerPids.length, beforeInvalidDefault, "an invalid configured default fails before starting a Worker");
    assert.equal((await client.ensure("host-default-key", cwd, "Existing Work", "existing-key", undefined, hostId)).instance.id, ensured.instance.id, "ensure hit retains the existing Work despite a changed default");
    await client.stop(ensured.instance.id);
    const override = await client.create(cwd, "Explicit source bypasses broken default", undefined, undefined, hostId, all[1]!.workerConfig);
    assert.ok((await client.resources(override.id)).resources.some((item) => item.path === join(agentDir, "SYSTEM.md")));
    await client.stop(override.id);
    await rm(saved); await mkdir(saved);
    await assert.rejects(client.setSystemDefault(cwd, chosen.id, hostId), { code: "system_default_unavailable" });
    await rm(saved, { recursive: true });
    await client.setSystemDefault(cwd, chosen.id, hostId);
    await writeFile(selectedPath, "{}");
    const invalidBody = await client.systemCatalog(cwd, hostId);
    assert.equal(invalidBody.defaultSelection, undefined); assert.ok(invalidBody.warnings.length);
    await assert.rejects(client.create(cwd, undefined, undefined, undefined, hostId), { code: "system_default_unavailable" });
    await rm(selectedPath); await mkdir(selectedPath);
    const unreadable = await client.systemCatalog(cwd, hostId);
    assert.equal(unreadable.defaultSelection, undefined); assert.ok(unreadable.warnings.length);
    await assert.rejects(client.create(cwd, undefined, undefined, undefined, hostId), { code: "system_default_unavailable" });
    await assert.rejects(client.systemContent(cwd, chosen.id, hostId), { code: "resource_unavailable" });
    // Explicit selected-source errors must fail creation, never turn the path into text or fall back.
    await assert.rejects(client.create(cwd, undefined, undefined, undefined, hostId, chosen.workerConfig));
    await rm(selectedPath, { recursive: true });
    await writeFile(selectedPath, selectedText);
    // A deleted built-in template must not be regenerated to revive a saved default.
    await client.setSystemDefault(cwd, all[2]!.id, hostId);
    await rm(join(systems, "pi-default.json"));
    const deleted = await client.systemCatalog(cwd, hostId);
    assert.equal(deleted.defaultSelection, undefined); assert.ok(deleted.warnings.length);
    await assert.rejects(client.create(cwd, undefined, undefined, undefined, hostId), { code: "system_default_unavailable" });
    await assert.rejects(readFile(join(systems, "pi-default.json")), { code: "ENOENT" });
    // Reload/tool rebuild retain the Work selection, not the current directory default.
    await client.setActiveTools(work.id, ["read"]);
    await client.reloadSession(work.id);
    await rm(observed);
    await client.prompt(work.id, "/capture-system", "prompt");
    await waitFor(async () => (await readFile(observed, "utf8").catch(() => "")).includes("EXPLICIT DOCK BODY"));
    const durable = (await store.load())!.instances.find((item) => item.creationOperationId === work.creationOperationId)!;
    assert.deepEqual(durable.workerConfig, chosen.workerConfig);
    await upstream.stop(); await main.stop(); await subHost.stop();
    // Pi does not persist a model-free empty session. Materialize a saved-journal fixture
    // through its public SDK after the Worker stops, so reopen needs no model traffic.
    const seed = SessionManager.create(cwd, sessions);
    seed.newSession({ id: durable.piSessionId! });
    seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixture saved answer" }],
      api: "openai-completions", provider: "openai", model: "gpt-4o-mini", stopReason: "stop", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await rename(seed.getSessionFile()!, durable.recoverySessionFile!);
    registry = registryFactory(); subHost = makeSubHost(true); await subHost.start();
    local = new DockClient({ socketPath: subHost.socketPath, timeoutMs: 10_000 });
    await local.reopen(durable.id);
    await rm(observed);
    await local.prompt(durable.id, "/capture-system", "prompt");
    await waitFor(async () => (await readFile(observed, "utf8").catch(() => "")).includes("EXPLICIT DOCK BODY"));
    assert.ok(workerPids.length >= 2);
    const reopenedResource = (await local.resources(durable.id)).resources.find((item) => item.path === selectedPath);
    assert.ok(reopenedResource?.contentRef);
    assert.equal((await local.resourceContent(durable.id, reopenedResource.contentRef)).text, selectedText);
    const native = await local.create(cwd, undefined, undefined, undefined, undefined, all[1]!.workerConfig);
    await rm(observed);
    await local.prompt(native.id, "/capture-system", "prompt");
    await waitFor(async () => (await readFile(observed, "utf8").catch(() => "")).includes("GLOBAL NATIVE SYSTEM"));
    const custom = await readFile(observed, "utf8");
    assert.ok(!custom.includes("PROJECT NATIVE SYSTEM") && !custom.includes("EXPLICIT DOCK BODY"));
    // Card 271 review: a BOM-only native SYSTEM behaves like empty SYSTEM, while previews keep the bytes.
    await writeFile(join(agentDir, "SYSTEM.md"), "\uFEFF");
    await local.reloadSession(native.id);
    await rm(observed);
    await local.prompt(native.id, "/capture-system", "prompt");
    await waitFor(async () => (await readFile(observed, "utf8").catch(() => "")).includes("<tools>"));
    const bomOnly = await readFile(observed, "utf8");
    assert.ok(bomOnly.includes("Use bash for file operations like ls, rg, find"), "native default dynamic guidelines survive");
    assert.ok(bomOnly.includes("NATIVE APPEND RETAINED"));
    const nativeResource = (await local.resources(native.id)).resources.find((item) => item.path === join(agentDir, "SYSTEM.md"));
    assert.ok(nativeResource?.contentRef);
    assert.equal((await local.resourceContent(native.id, nativeResource.contentRef)).text, "\uFEFF");
    // Initialization is one-time across Host restart, including deletion of the entire template directory.
    await rm(systems, { recursive: true });
    const missingDirectory = await local.systemCatalog(cwd);
    assert.equal(missingDirectory.defaultSelection, undefined); assert.ok(missingDirectory.warnings.length);
    await assert.rejects(readFile(join(systems, "pi-default.json")), { code: "ENOENT" });
  } finally {
    client.closeActiveConnections(); local?.closeActiveConnections();
    await upstream.stop().catch(() => {}); await main.stop().catch(() => {}); await subHost.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
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

// Card 271 P1: directory existence did not prove initialization, so empty directories
// and failed first attempts silently lost the only base candidate on the next query.
for (const scenario of ["existing empty directory", "generation failure", "partial write failure", "existing user body"] as const) {
  test(`system initialization preserves a usable base candidate after ${scenario}`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), "alu-system-init-"));
    context.after(() => rm(home, { recursive: true, force: true }));
    const systems = join(home, ".aludock", "systems"), target = join(systems, "pi-default.json");
    const marker = join(home, ".aludock", "systems-initialized");
    const provider = createPiSystemTemplateProvider(join(home, "agent"));
    const original = provider.initialTemplate();
    if (scenario === "existing empty directory" || scenario === "existing user body") await mkdir(systems, { recursive: true });
    const userBody = original.replace('"intro":', '"intro" :');
    if (scenario === "existing user body") await writeFile(target, userBody);
    if (scenario === "generation failure") {
      let first = true;
      provider.initialTemplate = () => { if (first) { first = false; throw new Error("Injected first generation failure"); } return original; };
    }
    let restoreWrite: (() => void) | undefined;
    if (scenario === "partial write failure") {
      const probe = await open(join(home, "write-probe"), "wx");
      const prototype = Object.getPrototypeOf(probe) as typeof probe;
      const originalWrite = prototype.writeFile;
      await probe.close();
      // Inject a real partial file write followed by I/O failure; never touch user paths.
      const mocked = context.mock.method(prototype, "writeFile", async function(this: typeof probe, ...args: Parameters<typeof originalWrite>) {
        await originalWrite.call(this, "{partial");
        throw Object.assign(new Error("Injected write failure"), { code: "EIO" });
      });
      restoreWrite = () => mocked.mock.restore();
    }
    const service = new SystemService(home, provider);
    if (scenario === "generation failure" || scenario === "partial write failure") {
      let first;
      try { first = await service.catalog(home); }
      finally { restoreWrite?.(); }
      assert.ok(first.warnings.length, "first failure is visible");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      await assert.rejects(readFile(target), { code: "ENOENT" });
    }
    const retried = await service.catalog(home);
    assert.deepEqual(retried.warnings, []);
    assert.equal(retried.total, 1);
    assert.equal(retried.candidates[0]?.warning, undefined);
    assert.equal(await readFile(target, "utf8"), scenario === "existing user body" ? userBody : original);
    assert.equal(await readFile(marker, "utf8"), "\n");
    // Completion survives restart; deletion cannot revive an already saved target.
    await service.setDefault(home, retried.candidates[0]!.id);
    await rm(target);
    const restarted = await new SystemService(home, provider).catalog(home);
    assert.equal(restarted.total, 0);
    assert.equal(restarted.defaultSelection, undefined);
    assert.ok(restarted.warnings.length);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  });
}

// Card 271 review: no published Work ever used a template without its source Home.
test("old Work keeps native behavior while a template must name its source Home", () => {
  assert.equal(piSystemPromptResolver(undefined, "/fixture/agent"), undefined);
  assert.equal(piSystemPromptResolver({}, "/fixture/agent"), undefined);
  assert.throws(() => piSystemPromptResolver({ systemSelection: { kind: "dock-template", path: "/fixture/.aludock/systems/test.json" } }, "/fixture/agent"));
});
