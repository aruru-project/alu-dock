import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance, resolvePiReopenTarget } from "../src/pi/create-pi-instance.js";

test("model and Thinking choices preserve saved preferences and report real disk failures", { timeout: 30_000 }, async () => {
  // Card 271: Pi 0.85 changes persistence defaults. The public success receipt must still mean the Dock action was saved.
  const root = await mkdtemp(join(tmpdir(), "alu-pi-model-settings-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const settingsPath = join(agentDir, "settings.json"), observerPath = join(root, "model-observer.jsonl");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(join(agentDir, "extensions"), { recursive: true })]);
  const settings = () => readFile(settingsPath, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>);
  await writeFile(settingsPath, JSON.stringify({
    defaultProvider: "settings-fixture", defaultModel: "reasoning-a", defaultThinkingLevel: "low",
    enabledModels: ["settings-fixture/reasoning-a"],
    modelThinkingLevels: { "settings-fixture/reasoning-b": "low" },
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "settings-fixture": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "literal-unused-fixture-key",
    models: [
      { id: "reasoning-a", reasoning: true }, { id: "reasoning-b", reasoning: true }, { id: "plain", reasoning: false },
    ].map((model) => ({ ...model, name: model.id, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  await writeFile(join(agentDir, "extensions", "model-observer.ts"), `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("fixture-model-preference", { handler: async (id, ctx) => {
    const model = ctx.modelRegistry.find("settings-fixture", id.trim());
    if (!model || !await pi.setModel(model)) throw new Error("fixture model unavailable");
    ctx.ui.notify("fixture preference applied: " + pi.getThinkingLevel(), "info");
  } });
  pi.registerCommand("fixture-thinking-preference", { handler: (level, ctx) => {
    pi.setThinkingLevel(level.trim());
    ctx.ui.notify("fixture preference applied: " + pi.getThinkingLevel(), "info");
  } });
  pi.on("model_select", (event) => appendFileSync(${JSON.stringify(observerPath)}, JSON.stringify({
    model: event.model.id, thinking: pi.getThinkingLevel(),
  }) + "\\n"));
}
`);
  const prior = SessionManager.create(cwd, sessionDir);
  prior.appendModelChange("settings-fixture", "reasoning-a");
  prior.appendThinkingLevelChange("high");
  prior.appendMessage({ role: "user", content: "Saved conversation", timestamp: 1 });
  prior.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved answer" }],
    api: "openai-completions", provider: "settings-fixture", model: "reasoning-a", stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), TMPDIR: root, TEMP: root, TMP: root,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const registry = new DockRegistry(
    (input) => createPiInstance({ ...input, agentDir, sessionDir, workerEnvironment: env }),
    undefined,
    { reopenTargetResolver: { resolve: resolvePiReopenTarget } },
  );
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  const client = new DockClient({ socketPath: host.socketPath });
  try {
    await host.start();
    const { instance } = await client.adopt(prior.getSessionFile()!);
    const id = instance.id;
    assert.equal(instance.executor.thinkingLevel, "high");
    assert.equal((await settings()).defaultThinkingLevel, "low");

    const invokePlugin = async (command: string, operationId: string, expectedThinking: Parameters<DockClient["setThinking"]>[1]) => {
      await client.prompt(id, command, "prompt", operationId);
      for (let attempt = 0; ; attempt++) {
        const applied = (await client.read(id)).page.events.find((event) => event.type === "extension.notification" && event.data.operationId === operationId);
        if (applied?.type === "extension.notification") {
          assert.equal(applied.data.message, `fixture preference applied: ${expectedThinking}`);
          break;
        }
        assert.ok(attempt < 100, "the plugin command finishes without a model run");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Wait for the plugin's own post-setter observation, not command admission.
      // Repeating that observed level only flushes queued settings; it cannot
      // compensate for a plugin that forgot to save or preserve its preference.
      await client.setThinking(id, expectedThinking);
      return client.status(id);
    };
    // Card 271 blind review: plugins bypass the Protocol setter compensation.
    const pluginModel = await invokePlugin("/fixture-model-preference reasoning-b", "plugin-model-b", "high");
    assert.equal(pluginModel.executor.thinkingLevel, "high");
    assert.equal((await settings()).defaultModel, "reasoning-b");
    assert.equal((await settings()).defaultThinkingLevel, "low");
    assert.deepEqual((await settings()).enabledModels, ["settings-fixture/reasoning-a"]);
    await invokePlugin("/fixture-model-preference reasoning-a", "plugin-model-a", "high");

    const unchanged = await client.setThinking(id, "high");
    assert.equal(unchanged.settingsWrite.persisted, true);
    assert.equal((await settings()).defaultThinkingLevel, "low", "an unchanged session choice must not replace another saved preference");
    const model = await client.setModel(id, "settings-fixture", "reasoning-b");
    assert.equal(model.settingsWrite.persisted, true);
    assert.equal(model.instance.executor.thinkingLevel, "high");
    assert.equal((await settings()).defaultModel, "reasoning-b");
    assert.equal((await settings()).defaultThinkingLevel, "low");
    assert.deepEqual((await settings()).enabledModels, ["settings-fixture/reasoning-a"]);
    const observed = (await readFile(observerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(observed.at(-1), { model: "reasoning-b", thinking: "high" });

    await client.setThinking(id, "low");
    const clamped = await client.setThinking(id, "max");
    assert.equal(clamped.actualLevel, "high");
    assert.equal(clamped.settingsWrite.persisted, true);
    assert.equal((await settings()).defaultThinkingLevel, "high");
    const plain = await client.setModel(id, "settings-fixture", "plain");
    assert.equal(plain.instance.executor.thinkingLevel, "off");
    await client.setThinking(id, "off");
    assert.equal((await settings()).defaultThinkingLevel, "high");
    const restored = await client.setModel(id, "settings-fixture", "reasoning-a");
    assert.equal(restored.instance.executor.thinkingLevel, "high");

    await invokePlugin("/fixture-thinking-preference low", "plugin-thinking-low", "low");
    assert.equal((await settings()).defaultThinkingLevel, "low");
    const pluginThinking = await invokePlugin("/fixture-thinking-preference max", "plugin-thinking-clamp", "high");
    assert.equal(pluginThinking.executor.thinkingLevel, "high");
    assert.equal((await settings()).defaultThinkingLevel, "high", "plugins save the changed effective level, not unsupported max");

    for (const key of ["thinking", "model"] as const) {
      const backup = join(agentDir, "saved-settings.json");
      await rename(settingsPath, backup);
      await mkdir(settingsPath); // Deterministic write failure without changing machine permissions or limits.
      try {
        await assert.rejects(
          key === "thinking" ? client.setThinking(id, "low") : client.setModel(id, "settings-fixture", "reasoning-b"),
          (error: unknown) => error instanceof ControlClientError && error.code === "settings_write_failed",
        );
        const actual = await client.status(id);
        assert.equal(actual.executor.thinkingLevel, "low");
        if (key === "model") assert.deepEqual(actual.executor.model, { provider: "settings-fixture", id: "reasoning-b" });
        assert.ok((await client.read(id)).page.events.some((event) => event.type === "settings.write_failed" && event.data.key === key));
      } finally {
        await rm(settingsPath, { recursive: true });
        await rename(backup, settingsPath);
      }
    }
    const recovered = await client.setModel(id, "settings-fixture", "reasoning-b");
    assert.equal(recovered.settingsWrite.persisted, true);
    assert.equal((await settings()).defaultModel, "reasoning-b");
  } finally {
    client.closeActiveConnections();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
