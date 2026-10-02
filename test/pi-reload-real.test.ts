import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createIsolatedPiInstance as createPiInstance } from "./fixtures/isolated-pi-instance.js";
import { DOCK_TOOL_NAMES } from "../src/pi/dock-tools-extension.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

test("package-managed Pi extensions remain loaded across new and reload", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-package-lifecycle-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const packageDirectory = join(agentDir, "fixture-package");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(join(packageDirectory, "extensions"), { recursive: true }),
  ]);
  await chmod(root, 0o700);
  await Promise.all([
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["./fixture-package"] })),
    writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "fixture-package",
      version: "1.0.0",
      pi: { extensions: ["./extensions"] },
    })),
    writeFile(join(packageDirectory, "extensions", "lifecycle-fixture.ts"), `
export default function (pi) {
  pi.registerCommand("package-lifecycle-fixture", { handler: async () => {} });
}
`),
  ]);
  context.after(async () => { await rm(root, { recursive: true, force: true }); });

  const instance = await createPiInstance({ cwd, agentDir, sessionDir, projectTrusted: true });
  context.after(async () => { await instance.stop().catch(() => {}); });
  const assertPackageLoaded = async (): Promise<void> => {
    const commands = await instance.getCommands();
    const resources = await instance.getResources();
    assert.equal(commands.commands.some((command) => command.name === "package-lifecycle-fixture"), true);
    assert.equal(resources.resources.some((resource) => resource.kind === "extension" && resource.name === "lifecycle-fixture.ts"), true);
  };

  await assertPackageLoaded();
  assert.equal((await instance.newSession("package-lifecycle-new")).cancelled, false);
  await assertPackageLoaded();
  assert.equal((await instance.reloadSession("package-lifecycle-reload")).cancelled, false);
  await assertPackageLoaded();
});

test("fresh real-Pi session status and Work tool access survive new and reload for a new Protocol reader", { timeout: 20_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-session-ui-handoff-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const dataHome = join(root, "data");
  const socketPath = join(root, "dock.sock");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(home),
    mkdir(stateHome),
    mkdir(dataHome),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
  ]);
  await chmod(root, 0o700);
  await writeFile(join(agentDir, "extensions", "session-status.ts"), `
export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    ctx.ui.setStatus("session-fixture", event.reason);
  });
}
`, "utf8");

  const workerEnvironment = isolatedProcessEnvironment(home, { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome });
  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input,
      agentDir,
      sessionDir,
      workerEnvironment,
      workerTimeouts: { mutationMs: 10_000, termMs: 300 },
    }),
    () => "session-ui-handoff-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 3_000, longMutationTimeoutMs: 12_000 });
  const reader = new DockClient({ socketPath, timeoutMs: 3_000 });
  context.after(async () => {
    client.closeActiveConnections();
    reader.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await host.start();
  const created = await client.create(cwd, "session UI handoff", "session-ui-create");
  assert.equal((await client.read(created.id)).instance.extensionStatus?.["session-fixture"], "startup");

  await client.prompt(created.id, "/dock-tools on", "auto", "session-ui-tools-on");
  const enabled = await waitForRead(client, created.id, (read) => (
    read.instance.execution === "idle"
    && read.instance.extensionStatus?.["Dock tools"] === "on"
    && read.instance.extensionStatus?.["session-fixture"] === "startup"
  ));
  assert.equal(enabled.instance.extensionStatus?.["Dock tools"], "on");
  assert.equal(enabled.instance.extensionStatus?.["session-fixture"], "startup");

  await client.reloadSession(created.id, "session-ui-reload");
  const reloaded = await reader.read(created.id);
  assert.equal(reloaded.instance.extensionStatus?.["Dock tools"], "on");
  assert.equal(reloaded.instance.extensionStatus?.["session-fixture"], "reload");
  const reloadedTools = await reader.tools(created.id);
  for (const name of DOCK_TOOL_NAMES) assert.equal(reloadedTools.tools.find((tool) => tool.name === name)?.active, true);

  await client.newSession(created.id, undefined, "session-ui-new");
  const fresh = await reader.read(created.id);
  assert.equal(fresh.instance.extensionStatus?.["Dock tools"], "on");
  assert.equal(fresh.instance.extensionStatus?.["session-fixture"], "new");
  const freshTools = await reader.tools(created.id);
  for (const name of DOCK_TOOL_NAMES) assert.equal(freshTools.tools.find((tool) => tool.name === name)?.active, true);
});

test("existing Work reads local model changes on new and both reload paths while upstream is unavailable (cards #222/#330)", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-reload-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const socketPath = join(root, "dock.sock");
  await Promise.all([mkdir(cwd), mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(sessionDir)]);
  const saveLocalModels = (id: string, name: string) => writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "local-llm": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local-fixture",
      models: [{ id: "original", name }, { id }] },
  } }));
  // A saved upstream catalog is the output consumed after `aludock update model`.
  // Use a fixed date newer than Pi's bundled model data, not a network download.
  const saveCatalog = (id: string) => writeFile(join(agentDir, "models-store.json"), JSON.stringify({ openai: {
    checkedAt: 0, lastModified: 4_102_444_800_000,
    models: [{ id, name: id, provider: "openai", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1",
      reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } }));
  await Promise.all([
    chmod(root, 0o700),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-model-call" } })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local-llm", defaultModel: "original" })),
    saveLocalModels("initial", "Original at startup"),
    writeFile(join(agentDir, "extensions", "reload-fixture.ts"), `
export default function (pi) {
  pi.registerCommand("fixture-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus("model-at-start", ctx.model?.name); });
}
`),
  ]);

  const blackhole = createServer();
  const blackholeSockets = new Set<Socket>();
  let upstreamConnections = 0;
  blackhole.on("connection", (socket) => {
    upstreamConnections += 1;
    blackholeSockets.add(socket);
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await listen(blackhole);
  const address = blackhole.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const workerEnvironment = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"),
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: root, TEMP: root, TMP: root,
    // Deliberately omit PI_OFFLINE: an accidental network refresh must reach the stalled proxy.
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
  };

  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input,
      agentDir,
      sessionDir,
      tools: [],
      workerEnvironment,
      workerTimeouts: { mutationMs: 1_500, termMs: 300 },
    }),
    () => "reload-real-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 2_000, longMutationTimeoutMs: 5_000 });

  try {
    await host.start();
    const created = await client.create(cwd, "reload real", "reload-real-create");
    for (const action of ["new", "reload", "extension-reload"] as const) {
      const localId = `local-${action}`;
      const catalogId = `cached-${action}`;
      const name = `Original after ${action}`;
      await Promise.all([saveLocalModels(localId, name), saveCatalog(catalogId)]);
      const before = (await client.read(created.id)).instance;
      if (action === "new") await client.newSession(created.id, undefined, "models-new");
      else if (action === "reload") await client.reloadSession(created.id, "models-reload");
      else {
        await client.prompt(created.id, "/fixture-reload", "auto", "models-extension-reload");
        await waitForRead(client, created.id, (read) => read.instance.execution === "idle"
          && read.instance.extensionStatus?.["model-at-start"] === name);
      }
      const after = (await client.read(created.id)).instance;
      assert.equal(after.id, created.id);
      assert.equal(after.lifecycle, "active");
      assert.equal(after.executor.model?.id, "original", `${action} keeps the selected model`);
      assert.equal(after.extensionStatus?.["model-at-start"], name, `${action} starts extensions with the refreshed model`);
      if (action !== "new") assert.equal(after.executor.piSessionId, before.executor.piSessionId, "reload retains the session");
      const models = await client.models(created.id);
      assert.ok(models.models.some((model) => model.provider === "local-llm" && model.id === localId), `${action} loads models.json`);
      assert.ok(models.models.some((model) => model.provider === "openai" && model.id === catalogId), `${action} loads the saved catalog`);
      for (const [provider, id] of [["local-llm", localId], ["openai", catalogId]] as const) {
        const selected = await client.setModel(created.id, provider, id, `select-${id}`);
        assert.equal(selected.instance.executor.model?.id, id);
      }
      await client.setModel(created.id, "local-llm", "original", `restore-${action}`);
    }
    assert.equal(upstreamConnections, 0, "the card #222 stalled-upstream incident must not return");
  } finally {
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    for (const socket of blackholeSockets) socket.destroy();
    await close(blackhole);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForRead(
  client: DockClient,
  instanceId: string,
  predicate: (read: Awaited<ReturnType<DockClient["read"]>>) => boolean,
): Promise<Awaited<ReturnType<DockClient["read"]>>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const read = await client.read(instanceId);
    if (predicate(read)) return read;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Work projection");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
