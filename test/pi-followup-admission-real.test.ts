import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommandPreflightResult } from "../src/core/agent-worker.js";
import { createPiAgentAdapter, type PiAgentAdapter } from "../src/pi/pi-agent-adapter.js";
import { PlanGoalProvider } from "./support/plan-goal-provider.js";

test("real Pi starts idle followUp as prompt and queues busy followUp without steering", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-followup-admission-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const provider = new PlanGoalProvider();
  let adapter: PiAgentAdapter | undefined;
  context.after(async () => { await adapter?.control({ type: "dispose" }); await provider.stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)));
  const baseUrl = await provider.start();
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl, api: "openai-completions", apiKey: "local-fixture-key",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false } }));
  adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: false, workerConfig: { toolPolicy: { allowedTools: [] } } });
  const admitted: AgentCommandPreflightResult[] = [];
  const run = adapter.dispatch({ kind: "request", version: 2, requestId: "fixture", type: "command.submit", params: { instanceId: "fixture", operationId: "initial-task", message: "INITIAL_TASK", delivery: "followUp" } },
    { type: "command", queueAvailable: true }, (result) => admitted.push(result));
  const first = await provider.request(0);
  assert.deepEqual(admitted, [{ success: true, inputKind: "prompt", delivery: "prompt", custody: "runtime" }]);
  assert.ok(JSON.stringify(first.body.messages).includes("INITIAL_TASK"));
  await adapter.dispatch({ kind: "request", version: 2, requestId: "fixture", type: "command.submit", params: { instanceId: "fixture", operationId: "peer-message", message: "QUEUED_PEER_FINDING", delivery: "followUp" } },
    { type: "command", queueAvailable: true }, (result) => admitted.push(result));
  assert.deepEqual(admitted.at(-1), { success: true, inputKind: "prompt", delivery: "followUp", custody: "runtime" });
  assert.deepEqual(adapter.currentSession().getSteeringMessages(), []);
  assert.deepEqual(adapter.currentSession().getFollowUpMessages(), ["QUEUED_PEER_FINDING"]);
  assert.equal(first.closed, false, "The peer message must not cancel the active provider request");
  assert.equal(provider.requests.length, 1, "No parallel run starts for queued peer input");
  first.text("Initial task finished.");
  const followup = await provider.request(1);
  assert.ok(JSON.stringify(followup.body.messages).includes("QUEUED_PEER_FINDING"));
  followup.text("Peer finding handled.");
  await run;
  assert.deepEqual(adapter.currentSession().getFollowUpMessages(), []);
});
