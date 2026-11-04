import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const failed = (client: DockClient, id: string, message: string) => waitFor(async () => (await client.status(id)).execution === "failed", message);

// Card #303, user decision 2026-11-04: Main runs the cluster's one model runtime. Works hold no
// providers or credentials, and nothing falls back to a provider of their own.
test("a Work gets its replies only through Main's model service", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], {
    prefix: "alu-model-service-", modelService: true, settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  });
  const { coordinator } = team.providers;
  // An extension that edits provider requests cannot run there; it must not stop the Work (decision 13).
  await mkdir(join(team.agentDir, "extensions"));
  await writeFile(join(team.agentDir, "extensions", "payload-hook.ts"), "export default function (pi) { pi.on(\"before_provider_request\", () => undefined); }\n");
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "service-create", trust));

  await client.prompt(work.id, "Write the marker.", "auto", "service-write");
  (await coordinator.request(0)).tools({ id: "write-marker", name: "write", arguments: { path: join(team.cwd, "marker.txt"), content: "MODEL_SERVICE" } });
  (await coordinator.request(1)).text("Written.");
  await settled(client, work.id);
  assert.equal(await readFile(join(team.cwd, "marker.txt"), "utf8"), "MODEL_SERVICE");
  const { diagnostics } = await client.resources(work.id);
  assert.ok(diagnostics.some((item) => item.message.includes("payload-hook.ts") && item.message.includes("before_provider_request")));
  // The model list, a reload and a summary also reach the models through Main.
  assert.deepEqual((await client.models(work.id)).models.map((model) => `${model.provider}/${model.id}`), ["coordinator/fixture"]);
  await client.reloadSession(work.id, "service-reload");
  const compacting = client.compactSession(work.id, undefined, "service-compact");
  (await coordinator.request(2)).text("SUMMARY_THROUGH_MAIN");
  await compacting;

  // Stopping a reply cancels it at the provider, so it stops costing.
  await client.prompt(work.id, "Write more.", "auto", "service-abort");
  const held = await coordinator.request(3);
  await client.abort(work.id);
  await waitFor(() => held.closed, "The cancelled request kept running at the provider");
  await settled(client, work.id);

  // Without the service the request fails; the Worker has no provider to reach the model itself.
  await team.modelService!.stop();
  await client.prompt(work.id, "Once more.", "auto", "service-down");
  await failed(client, work.id, "The Work did not report that it could not reach a model");
  assert.equal(coordinator.requests.length, 4);
});

// A provider may already charge for a request the service was answering when it stopped; Pi's own
// retry must not send it again. The next request works once the Host has started the service again.
test("a reply cut off by a model service crash is reported once and not sent again", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], {
    prefix: "alu-model-crash-", modelService: true, settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
  });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "crash-create", trust));

  await client.prompt(work.id, "Start.", "auto", "crash-start");
  const held = await coordinator.request(0);
  process.kill(team.modelService!.pid!, "SIGKILL");
  await waitFor(() => held.closed, "The provider request outlived the model service");
  await failed(client, work.id, "The cut-off reply was not reported");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(coordinator.requests.length, 1, "The cut-off request was sent again");

  await client.prompt(work.id, "Again.", "auto", "crash-again");
  (await coordinator.request(1)).text("BACK");
  await settled(client, work.id);
  const history = JSON.stringify(await client.history(work.id));
  assert.ok(history.includes("BACK"));
});
