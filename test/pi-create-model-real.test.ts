import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { FileCatalogStore } from "../src/control/durable-catalog-store.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

// Card 361: a new Work starts with the model chosen at creation, like `pi --model`.
test("a Work created with a chosen model starts on it without changing Pi's default; a session that picked its own model keeps it, a new session starts on the chosen one again", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-pi-create-model-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const settingsPath = join(agentDir, "settings.json");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentDir, { recursive: true })]);
  const settings = () => readFile(settingsPath, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>);
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "settings-fixture", defaultModel: "reasoning-a" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "settings-fixture": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "literal-unused-fixture-key",
    models: [{ id: "reasoning-a", reasoning: true }, { id: "reasoning-b", reasoning: true }, { id: "plain", reasoning: false }]
      .map((model) => ({ ...model, name: model.id, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), TMPDIR: root, TEMP: root, TMP: root,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const catalog = new FileCatalogStore(join(root, "catalog.json"));
  const workerPids: number[] = [];
  const registry = new DockRegistry(
    (input) => createPiInstance({ ...input, agentDir, sessionDir, workerEnvironment: env, onWorkerSpawn: (pid) => workerPids.push(pid) }),
    undefined,
    { catalogStore: catalog },
  );
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  const client = new DockClient({ socketPath: host.socketPath });
  try {
    await registry.initializeCatalog();
    await host.start();
    const chosen = await client.create(cwd, "Chosen model", undefined, undefined, undefined, { model: { provider: "settings-fixture", id: "plain" } });
    assert.deepEqual(chosen.executor.model, { provider: "settings-fixture", id: "plain" });
    assert.deepEqual((await client.status(chosen.id)).executor.model, { provider: "settings-fixture", id: "plain" });
    assert.equal((await settings()).defaultModel, "reasoning-a", "the Work's starting model is not saved as Pi's default");
    const ordinary = await client.create(cwd, "Default model");
    assert.deepEqual(ordinary.executor.model, { provider: "settings-fixture", id: "reasoning-a" });
    const stored = (await catalog.load())!.instances.find((item) => item.id === chosen.id)!;
    assert.deepEqual(stored.workerConfig, { model: { provider: "settings-fixture", id: "plain" } });

    const before = workerPids.length;
    await assert.rejects(
      client.create(cwd, "Missing model", undefined, undefined, undefined, { model: { provider: "settings-fixture", id: "missing" } }),
      (error: unknown) => error instanceof ControlClientError && error.code === "model_not_found",
      "the client learns the chosen model is unavailable, the same way a failed model switch tells it",
    );
    assert.ok(workerPids.length > before, "the Worker itself resolves the model, like Pi does");
    assert.ok(!(await client.list()).some((item) => item.name === "Missing model" && item.lifecycle === "active"), "a Work whose chosen model is unavailable is not left running");

    await client.stop(ordinary.id);
    // A conversation that already chose reasoning-b (materialized through Pi's public SDK,
    // since Pi does not persist a conversation-free session) keeps its own model when the
    // Work switches to it; the creation-time model only starts sessions that have not chosen.
    const seed = SessionManager.create(cwd, sessionDir);
    seed.appendModelChange("settings-fixture", "reasoning-b");
    seed.appendMessage({ role: "user", content: "Saved conversation", timestamp: 1 });
    seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved answer" }],
      api: "openai-completions", provider: "settings-fixture", model: "reasoning-b", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const switched = await client.switchSession(chosen.id, seed.getSessionFile()!);
    assert.deepEqual(switched.instance.executor.model, { provider: "settings-fixture", id: "reasoning-b" }, "the session's own model choice outranks the creation-time model");
    const fresh = await client.newSession(chosen.id);
    assert.deepEqual(fresh.instance.executor.model, { provider: "settings-fixture", id: "plain" }, "a new session in this Work starts on the chosen model again, like `pi --model`");
    assert.equal((await settings()).defaultModel, "reasoning-a");
    assert.deepEqual((await catalog.load())!.instances.find((item) => item.id === chosen.id)!.workerConfig, { model: { provider: "settings-fixture", id: "plain" } });
  } finally {
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
