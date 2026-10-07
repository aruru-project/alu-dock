import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planGoalExtension, PlanGoalControl } from "../src/pi/plan-goal-extension.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";
import { PlanGoalProvider, waitFor } from "./support/plan-goal-provider.js";

// The Host scenario's disk extension runs before Goal. This distinct real-SDK
// ordering protects a person's stop AFTER Goal proposed another paid round.
test("Pausing after Goal proposes another round prevents its request and preserves the spent budget", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-goal-boundary-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const previousEnvironment = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolatedProcessEnvironment(home, {
    PATH: previousEnvironment.PATH, PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(root, "run"),
    TMPDIR: root, TEMP: root, TMP: root, npm_config_cache: join(root, "npm"),
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  }));
  const provider = new PlanGoalProvider();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let proposed = false;
  let session: Awaited<ReturnType<typeof import("@earendil-works/pi-coding-agent")["createAgentSession"]>>["session"] | undefined;
  try {
    await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
    const baseUrl = await provider.start();
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "boundary-loopback": {
      baseUrl, api: "openai-completions", apiKey: "local-fixture-key",
      models: [{ id: "fixture", name: "Boundary fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "boundary-loopback", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
    }));
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const control = new PlanGoalControl();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [
      { name: "alu-dock-plan-goal", factory: planGoalExtension(control) },
      { name: "after-goal-proposal", factory: (pi) => {
        pi.on("agent_before_settle", async (event) => { if (event.continue) { proposed = true; await gate; } });
      } },
    ] });
    await resourceLoader.reload();
    const manager = SessionManager.create(cwd, sessionDir);
    ({ session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, resourceLoader }));
    const active = session;
    control.bindPrompt(async (text, mayStart) => {
      let started = false;
      await active.prompt(text, { source: "extension", expandPromptTemplates: false, preflightResult: (disposition) => {
        if (disposition === "started") { assert.equal(mayStart(), true); started = true; }
      } });
      return started;
    });
    await active.bindExtensions({ mode: "print" });
    await active.prompt("/goal start --rounds 3 --minutes 2 Inspect the approved project");
    (await provider.request(0)).text("The first stage is complete; one more stage remains.");
    await waitFor(() => proposed, "The later SDK extension did not observe Goal's continuation proposal");
    await active.prompt("/goal pause");
    release();
    await active.waitForIdle();
    assert.equal(provider.requests.length, 1, "The proposed but cancelled round must not contact the model");
    const file = manager.getSessionFile();
    assert.ok(file);
    const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const state = records.findLast((entry) => entry.type === "custom" && entry.customType === "alu-dock-plan-goal-state");
    assert.ok(state?.data.goal);
    assert.deepEqual({ status: state.data.goal.status, rounds: state.data.goal.rounds, limit: state.data.goal.maxRounds }, {
      status: "paused", rounds: 1, limit: 3,
    });
  } finally {
    release();
    await session?.abort().catch(() => {});
    session?.dispose();
    await provider.stop();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    await rm(root, { recursive: true, force: true });
  }
});
