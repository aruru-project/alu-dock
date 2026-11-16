import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ControlClientError, DockClient } from "../src/control/dock-client.js";
import type { DockEvent } from "../src/core/instance-dto.js";
import { exited, startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// PR review P1, 2026-11-16: automatic settings.get killed a healthy Worker after Main's
// model service was SIGKILLed and the supervised replacement had not become ready.
// The follow-up review reproduced the same Worker loss from model.list's required auth-state read.
// Keep production Worker/service deadlines. Only the model HTTP peer and restart entry are fixtures.
test("During Main recovery settings stay readable, model reads time out without stopping Work, and the same Work can retry", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["local"], {
    prefix: "alu-speed-restart-", modelService: true, assistant: true,
    modelServiceEntry: fileURLToPath(new URL("./fixtures/restarting-model-service.js", import.meta.url)),
  });
  const supportFile = join(team.root, "model-speed-support.json");
  const support = { providers: { local: { fast: ["fixture"], ultrafast: [] as string[] } } };
  await writeFile(supportFile, JSON.stringify(support));
  await team.startHost();
  // Wait longer than the production Worker query so a red run records Worker loss, not a client timeout.
  const client = new DockClient({ socketPath: team.host!.socketPath, timeoutMs: 45_000 });
  context.after(() => client.closeActiveConnections());
  const work = await trustOnce(trust => client.create(team.cwd, "running Work", "speed-restart", trust));
  const assistant = await team.assistantWork();
  const events: DockEvent[] = [];
  const followers = await Promise.all([work, assistant].map(item => client.streamEvents(item.id, { onEvent: event => { events.push(event); } })));
  context.after(async () => { for (const follower of followers) follower.close(); await Promise.all(followers.map(follower => follower.done.catch(() => {}))); });
  const setting = async (id: string) => (await client.settings(id)).settings.find(item => item.key === "modelSpeed")!;
  for (const item of [work, assistant]) assert.deepEqual((await setting(item.id)).allowedValues, ["standard", "fast"]);
  await client.updateSetting(work.id, { key: "modelSpeed", value: { tier: "fast", scope: "all" } });
  await client.prompt(work.id, "Keep the local tool running.");
  const first = await team.providers.local.request(0);
  first.tools({ id: "waiting-bash", name: "bash", arguments: {
    command: "echo TOOL_RUNNING; while [ ! -f release ]; do date +%s%N > heartbeat; sleep 0.2; done; echo TOOL_COMPLETED", timeout: 120,
  } });
  await waitFor(() => existsSync(join(team.cwd, "heartbeat")), "The real Pi bash tool did not start");
  const pids = [...team.workerPids];
  process.kill(team.modelService!.pid!, "SIGKILL");
  await waitFor(() => existsSync(join(team.root, "model-service-restarting")), "The replacement model service did not start");
  const started = Date.now();
  const readings = await Promise.all([work, assistant].map(item => setting(item.id)));
  context.diagnostic(`Settings returned in ${Date.now() - started}ms while the replacement service was not ready`);
  for (const reading of readings) assert.deepEqual(reading.allowedValues, ["standard", "fast"]);
  assert.deepEqual(readings[0]!.value, { tier: "fast", scope: "all" });
  await client.updateSetting(work.id, { key: "modelSpeed", value: { tier: "fast", scope: "all" } });
  // Model availability still asks Main. Its existing 15-second query deadline ends this read,
  // not the normal Worker or the bash tool it is running. Do not substitute cached model results.
  const queryStarted = Date.now();
  const modelReads = await Promise.allSettled([work, assistant].map(item => client.models(item.id)));
  context.diagnostic(`Model reads settled after ${Date.now() - queryStarted}ms: ${modelReads.map(result => result.status === "rejected" ? String(result.reason) : "succeeded").join("; ")}`);
  for (const result of modelReads) {
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") continue;
    assert.ok(result.reason instanceof ControlClientError);
    assert.equal(result.reason.code, "query_timeout");
  }
  const heartbeat = await readFile(join(team.cwd, "heartbeat"), "utf8");
  await waitFor(async () => await readFile(join(team.cwd, "heartbeat"), "utf8") !== heartbeat, "Reading settings stopped the real tool");
  for (const pid of pids) assert.equal(exited(pid), false, "The original Worker must remain alive");
  for (const original of [work, assistant]) {
    const current = await client.status(original.id);
    assert.equal(current.lifecycle, "active");
    assert.equal(current.runtimeGeneration, original.runtimeGeneration);
    assert.equal(current.executor.piSessionId, original.executor.piSessionId);
    assert.deepEqual(current.executor.model, original.executor.model);
  }
  assert.equal((await client.status(work.id)).execution, "running");
  await client.abort(work.id);
  await waitFor(async () => (await client.status(work.id)).execution === "idle", "The user could not stop the current reply after a read timed out");
  for (const pid of pids) assert.equal(exited(pid), false, "Stopping a reply retains its Worker");
  // A new support read after recovery must reach this same follower, not require closing/reopening UI.
  support.providers.local.ultrafast.push("fixture");
  await writeFile(supportFile, JSON.stringify(support));
  await writeFile(join(team.root, "model-service-release"), "ready");
  await waitFor(async () => {
    try { await team.modelService!.configuration(new AbortController().signal); return true; }
    catch { return false; }
  }, "The replacement model service did not become ready");
  events.length = 0;
  await Promise.all([work, assistant].map(item => setting(item.id)));
  for (const item of [work, assistant]) {
    await waitFor(() => events.some(event => event.instanceId === item.id && event.type === "settings.changed"
      && event.data.key === "modelSpeed"), "Fresh speed support did not notify the already-open follower");
    const notice = events.find(event => event.instanceId === item.id && event.type === "settings.changed" && event.data.key === "modelSpeed");
    assert.ok(notice?.type === "settings.changed");
    assert.deepEqual(notice.data.value, item.id === work.id ? { tier: "fast", scope: "all" } : null, "Support notifications retain Host's saved selection, not the Worker's effective tier");
    assert.deepEqual((await setting(item.id)).allowedValues, ["standard", "fast", "ultrafast"]);
  }
  assert.deepEqual((await setting(work.id)).value, { tier: "fast", scope: "all" });
  for (const item of [work, assistant]) {
    const available = await client.models(item.id);
    assert.ok(available.models.some(model => model.provider === "local" && model.id === "fixture"));
    assert.equal(available.instance.lifecycle, "active");
    assert.equal(available.instance.executor.piSessionId, item.executor.piSessionId);
  }
  await client.prompt(work.id, "Continue after the model service recovered.");
  const continuation = await team.providers.local.request(1);
  assert.equal((continuation.body as { service_tier: string }).service_tier, "priority");
  continuation.text("The same Work can continue normally.");
  await waitFor(async () => (await client.status(work.id)).execution === "idle", "The same Work did not finish its next reply");
  assert.equal((await client.stop(work.id)).instance.lifecycle, "stopped");
});
