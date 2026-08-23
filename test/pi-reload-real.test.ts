import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy",
  "NO_PROXY", "no_proxy", "PI_OFFLINE",
] as const;

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

test("real Protocol reload completes when remote model catalogs are unavailable (card #222)", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-reload-real-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const socketPath = join(root, "dock.sock");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  await Promise.all([
    chmod(root, 0o700),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-model-call" } })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" })),
  ]);

  const blackhole = createServer();
  const blackholeSockets = new Set<Socket>();
  blackhole.on("connection", (socket) => {
    blackholeSockets.add(socket);
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await listen(blackhole);
  const address = blackhole.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const originalEnvironment = new Map(PROXY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const) {
    process.env[key] = proxyUrl;
  }
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  delete process.env.PI_OFFLINE;

  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input,
      agentDir,
      sessionDir,
      tools: [],
      workerEnvironment: { ...process.env },
      workerTimeouts: { mutationMs: 1_500, termMs: 300 },
    }),
    () => "reload-real-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 2_000, longMutationTimeoutMs: 5_000 });

  try {
    await host.start();
    const created = await client.create(cwd, "reload real", "reload-real-create");
    restoreEnvironment(originalEnvironment);

    const result = await client.reloadSession(created.id, "reload-real-operation");

    assert.equal(result.instance.lifecycle, "active");
    assert.equal(result.instance.runtimeGeneration, 2);
  } finally {
    restoreEnvironment(originalEnvironment);
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    for (const socket of blackholeSockets) socket.destroy();
    await close(blackhole);
    await rm(root, { recursive: true, force: true });
  }
});

function restoreEnvironment(original: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
