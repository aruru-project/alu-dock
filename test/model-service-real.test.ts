import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");

// An extension that calls a model itself asks Pi for the credential through every entry Pi offers.
const PROBE_EXTENSION = `export default function (pi) {
  pi.registerTool({
    name: "probe_credentials", label: "Probe", description: "Report the credentials an extension gets.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const registry = ctx.modelRegistry;
      const request = await registry.getApiKeyAndHeaders(ctx.model);
      const provider = await registry.getProviderAuth(ctx.model.provider);
      const forProvider = await registry.getApiKeyForProvider(ctx.model.provider);
      const report = { request: request.ok ? request.apiKey : request.error, provider: provider?.auth.apiKey, forProvider };
      return { content: [{ type: "text", text: "PROBE " + JSON.stringify(report) }], details: {} };
    },
  });
}
`;
// Like pi-alu-sol-tuner's /codex-fast: it edits the request the Work sends.
const PAYLOAD_HOOK = `export default function (pi) {
  pi.on("before_provider_request", (event) => ({ ...event.payload, service_tier: "priority" }));
}
`;

// Card #303, user decision 2026-11-05: Main keeps the model configuration and credentials, and each
// Work sends its own requests with them. The key exists only in the model service's environment, so
// a Work can get it from nowhere but Main, and nothing falls back to this machine's configuration.
test("a Work sends its own model requests with Main's models and credentials", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], {
    prefix: "alu-model-service-", modelService: true, settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    apiKey: "${MAIN_ONLY_KEY}", serviceEnvironment: { MAIN_ONLY_KEY: "key-from-main" },
  });
  const { coordinator } = team.providers;
  await mkdir(join(team.agentDir, "extensions"));
  await writeFile(join(team.agentDir, "extensions", "payload-hook.ts"), PAYLOAD_HOOK);
  await writeFile(join(team.agentDir, "extensions", "probe-credentials.ts"), PROBE_EXTENSION);
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "service-create", trust));

  await client.prompt(work.id, "Write the marker.", "auto", "service-write");
  const first = await coordinator.request(0);
  assert.equal(first.headers.authorization, "Bearer key-from-main");
  assert.equal((first.body as { service_tier?: string }).service_tier, "priority");
  first.tools({ id: "write-marker", name: "write", arguments: { path: join(team.cwd, "marker.txt"), content: "MODEL_SERVICE" } });
  (await coordinator.request(1)).tools({ id: "probe", name: "probe_credentials", arguments: {} });
  // User decision 2026-11-05: an extension calling a model itself gets the credential from Main.
  const probed = JSON.stringify((await coordinator.request(2)).body.messages);
  assert.ok(probed.includes(String.raw`PROBE {\"request\":\"key-from-main\",\"provider\":\"key-from-main\",\"forProvider\":\"key-from-main\"}`), probed.slice(-600));
  coordinator.requests[2]!.text("Written.");
  await settled(client, work.id);
  assert.equal(await readFile(join(team.cwd, "marker.txt"), "utf8"), "MODEL_SERVICE");

  // A model added on Main reaches the Work when it reloads; a summary also uses Main's credential.
  const modelsPath = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8")) as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
  models.providers.coordinator!.models.push({ ...models.providers.coordinator!.models[0], id: "added-on-main" });
  await writeFile(modelsPath, JSON.stringify(models));
  await client.reloadSession(work.id, "service-reload");
  assert.deepEqual((await client.models(work.id)).models.map((model) => `${model.provider}/${model.id}`).sort(), ["coordinator/added-on-main", "coordinator/fixture"]);
  const compacting = client.compactSession(work.id, undefined, "service-compact");
  const summary = await coordinator.request(3);
  assert.equal(summary.headers.authorization, "Bearer key-from-main");
  summary.text("SUMMARY");
  await compacting;

  // Without Main's service a Work cannot get a credential, and says so instead of using its own.
  await team.modelService!.stop();
  await client.prompt(work.id, "Once more.", "auto", "service-down");
  await waitFor(async () => (await client.status(work.id)).execution === "failed", "The Work did not report that it could not reach Main");
  assert.equal(coordinator.requests.length, 4);
});

// The reply goes from the provider straight to the Work, so a service crash cannot cut it off.
test("a reply in progress survives a model service crash, and the next request works once the service is back", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-model-crash-", modelService: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "crash-create", trust));

  await client.prompt(work.id, "Start.", "auto", "crash-start");
  const held = await coordinator.request(0);
  const crashed = team.modelService!.pid!;
  process.kill(crashed, "SIGKILL");
  await waitFor(() => team.modelService!.pid !== undefined && team.modelService!.pid !== crashed, "The Host did not start the model service again");
  assert.equal(held.closed, false);
  held.text("FINISHED_AFTER_CRASH");
  await settled(client, work.id);

  await client.prompt(work.id, "Again.", "auto", "crash-again");
  (await coordinator.request(1)).text("BACK");
  await settled(client, work.id);
  const history = JSON.stringify(await client.history(work.id));
  assert.ok(history.includes("FINISHED_AFTER_CRASH") && history.includes("BACK"));
});
