import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import type { DockClient } from "../src/control/dock-client.js";
import { startNativeTeam, trustOnce } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

const settled = (client: DockClient, id: string) => waitFor(async () => (await client.status(id)).execution === "idle", "The Work did not finish its turn");
const failed = (client: DockClient, id: string, message: string) => waitFor(async () => (await client.status(id)).execution === "failed", message);

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
      const report = { request: request.ok ? request.apiKey : request.error, provider: provider?.auth.apiKey, forProvider, error: registry.getError() ?? "none" };
      return { content: [{ type: "text", text: "PROBE " + JSON.stringify(report) }], details: {} };
    },
  });
}
`;

// Card #303, user decision 2026-11-04: Main runs the cluster's one model runtime. Works hold no
// providers or credentials, and nothing falls back to a provider of their own. The key here exists
// only in the model service's environment, so a Work can get it from nowhere but Main.
test("a Work gets its replies and its extensions' credentials only through Main's model service", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], {
    prefix: "alu-model-service-", modelService: true, settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    apiKey: "${MAIN_ONLY_KEY}", serviceEnvironment: { MAIN_ONLY_KEY: "key-from-main" },
  });
  const { coordinator } = team.providers;
  // An extension that edits provider requests cannot run there; it must not stop the Work (decision 13).
  await mkdir(join(team.agentDir, "extensions"));
  await writeFile(join(team.agentDir, "extensions", "payload-hook.ts"), "export default function (pi) { pi.on(\"before_provider_request\", () => undefined); }\n");
  await writeFile(join(team.agentDir, "extensions", "probe-credentials.ts"), PROBE_EXTENSION);
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "service-create", trust));

  await client.prompt(work.id, "Write the marker.", "auto", "service-write");
  (await coordinator.request(0)).tools({ id: "write-marker", name: "write", arguments: { path: join(team.cwd, "marker.txt"), content: "MODEL_SERVICE" } });
  (await coordinator.request(1)).tools({ id: "probe", name: "probe_credentials", arguments: {} });
  // User decision 2026-11-05: an extension calling a model itself gets the credential from Main.
  const probed = JSON.stringify((await coordinator.request(2)).body.messages);
  assert.ok(probed.includes(String.raw`PROBE {\"request\":\"key-from-main\",\"provider\":\"key-from-main\",\"forProvider\":\"key-from-main\",\"error\":\"none\"}`), probed.slice(-600));
  coordinator.requests[2]!.text("Written.");
  await settled(client, work.id);
  assert.equal(await readFile(join(team.cwd, "marker.txt"), "utf8"), "MODEL_SERVICE");
  const { diagnostics } = await client.resources(work.id);
  assert.ok(diagnostics.some((item) => item.message.includes("payload-hook.ts") && item.message.includes("before_provider_request")));
  // The model list, a reload and a summary also reach the models through Main.
  assert.deepEqual((await client.models(work.id)).models.map((model) => `${model.provider}/${model.id}`), ["coordinator/fixture"]);
  await client.reloadSession(work.id, "service-reload");
  const compacting = client.compactSession(work.id, undefined, "service-compact");
  (await coordinator.request(3)).text("SUMMARY_THROUGH_MAIN");
  await compacting;

  // Stopping a reply cancels it at the provider, so it stops costing.
  await client.prompt(work.id, "Write more.", "auto", "service-abort");
  const held = await coordinator.request(4);
  await client.abort(work.id);
  await waitFor(() => held.closed, "The cancelled request kept running at the provider");
  await settled(client, work.id);

  // Without the service the request fails; the Worker has no provider to reach the model itself.
  await team.modelService!.stop();
  await client.prompt(work.id, "Once more.", "auto", "service-down");
  await failed(client, work.id, "The Work did not report that it could not reach a model");
  assert.equal(coordinator.requests.length, 5);
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

// Cloud review of e7c5da2: when a Worker exited during a reply, the service's next event could not be
// forwarded, and that failure went unhandled, which ends the Host process (this test's process here).
test("a Worker that exits during a reply leaves Main's Host and model service working", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-model-worker-exit-", modelService: true });
  const { coordinator } = team.providers;
  const client = await team.startHost();
  const lost = await trustOnce((trust) => client.create(team.cwd, "Lost", "exit-create", trust));
  await client.prompt(lost.id, "Start.", "auto", "exit-start");
  const held = await coordinator.request(0);
  process.kill(team.workerPids.at(-1)!, "SIGKILL");
  await waitFor(() => held.closed, "The provider request outlived its Worker");
  await waitFor(async () => (await client.status(lost.id)).lifecycle === "runtime_error", "The Worker's exit was not observed");

  const next = await trustOnce((trust) => client.create(team.cwd, "Next", "exit-next", trust));
  await client.prompt(next.id, "Hello.", "auto", "exit-next-prompt");
  (await coordinator.request(1)).text("STILL_SERVING");
  await settled(client, next.id);
  assert.ok(JSON.stringify(await client.history(next.id)).includes("STILL_SERVING"));
});

// Cloud review of e7c5da2: Workers no longer send model requests, so the HTTP proxy Pi applied on
// /reload went unused; the service kept the proxy it started with. A reload applies it again.
test("a changed HTTP proxy applies to model requests after the Work reloads", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-model-proxy-", modelService: true, environment: { NO_PROXY: "", no_proxy: "" } });
  const { coordinator } = team.providers;
  const proxied: string[] = [];
  const proxy = createServer((incoming, outgoing) => {
    proxied.push(incoming.url ?? "");
    const upstream = httpRequest(incoming.url!, { method: incoming.method, headers: incoming.headers }, (reply) => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const client = await team.startHost();
  const work = await trustOnce((trust) => client.create(team.cwd, "Coder", "proxy-create", trust));
  await client.prompt(work.id, "Direct.", "auto", "proxy-direct");
  (await coordinator.request(0)).text("DIRECT");
  await settled(client, work.id);
  assert.equal(proxied.length, 0);

  const settingsPath = join(team.agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  await writeFile(settingsPath, JSON.stringify({ ...settings, httpProxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` }));
  await client.reloadSession(work.id, "proxy-reload");
  await client.prompt(work.id, "Through the proxy.", "auto", "proxy-through");
  (await coordinator.request(1)).text("PROXIED");
  await settled(client, work.id);
  assert.equal(proxied.length, 1);
});
