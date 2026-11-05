// Real-provider check on this machine. It calls real models and spends quota: run it only with the
// user's authorization (docs/qa.md, "真实模型调用"). See scripts/trials/README.md.
//
// A separate Host with its own socket, catalog and session directory, sharing the user's Pi
// directory the way the installed Host does: subscription logins must stay in the one auth.json
// (a refreshed refresh token in a copy would log the real one out), so only the files the test
// writes are put back afterwards, and auth.json never is.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const D = join(repo, "dist", "src");
const CODEX = (process.env.CODEX_MODEL ?? "openai-codex/gpt-6-luna").split("/");
const COPILOT = (process.env.COPILOT_MODEL ?? "github-copilot/claude-haiku-5.5").split("/");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const { DockClient, ControlClientError } = await import(`${D}/control/dock-client.js`);
const { DockHost } = await import(`${D}/control/dock-host.js`);
const { DockRegistry } = await import(`${D}/control/dock-registry.js`);
const { FileCatalogStore } = await import(`${D}/control/durable-catalog-store.js`);
const { ChildModelsStore } = await import(`${D}/control/child-models.js`);
const { ProjectTrustCoordinator } = await import(`${D}/control/project-trust.js`);
const { createPiInstance, resolvePiReopenTarget } = await import(`${D}/pi/create-pi-instance.js`);
const { ModelServiceProcess } = await import(`${D}/model-service/service-process.js`);

// What the test may change in the Pi directory, recorded as hashes and timestamps only.
const TRACKED = ["settings.json", "trust.json", "models.json", "models-store.json", "auth.json"];
const DEFAULT_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
function snapshot() {
  const hash = (file) => existsSync(join(agentDir, file)) ? createHash("sha256").update(readFileSync(join(agentDir, file))).digest("hex").slice(0, 16) : null;
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const auth = existsSync(join(agentDir, "auth.json")) ? JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) : {};
  const sessions = join(agentDir, "sessions");
  return {
    files: Object.fromEntries(TRACKED.map((file) => [file, hash(file)])),
    defaults: Object.fromEntries(DEFAULT_KEYS.map((key) => [key, settings[key]])),
    auth: Object.fromEntries(Object.entries(auth).map(([provider, entry]) => [provider, `${entry.type}${entry.expires ? ` expires ${new Date(entry.expires).toISOString()}` : ""} ${createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 8)}`])),
    sessions: existsSync(sessions) ? readdirSync(sessions).length : 0,
  };
}

const before = snapshot();
const root = mkdtempSync(join(tmpdir(), "alu-real-"));
const sessionDir = join(root, "sessions");
mkdirSync(sessionDir);
const workspace = (name, settings) => {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
  return cwd;
};

// Every question the Works ask Main, with what kind of answer came back; never a credential value.
const questions = [];
const service = new ModelServiceProcess({ agentDir });
const port = {
  async configuration(signal) { const r = await service.configuration(signal); questions.push("configuration"); return r; },
  async authState(signal) { const r = await service.authState(signal); questions.push("auth_state"); return r; },
  async auth(request, signal) {
    const r = await service.auth(request, signal);
    const target = typeof request.target === "string" ? request.target : `${request.target.provider}/${request.target.id}`;
    questions.push(`auth ${target}: ${r ? `key=${r.auth.apiKey ? "yes" : "no"}${r.auth.baseUrl ? ` baseUrl=${new URL(r.auth.baseUrl).host}` : ""}` : "none"}`);
    return r;
  },
};

const results = [];
const step = async (label, run) => {
  const started = Date.now();
  try {
    const detail = await run();
    results.push(`PASS ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)${detail ? `: ${detail}` : ""}`);
  } catch (error) { results.push(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`); }
  console.log(results.at(-1));
};

let host;
let client;
try {
  await service.start();
  const registry = new DockRegistry(async (input) => createPiInstance({ ...input, agentDir, sessionDir, modelHostPort: port }), undefined, {
    catalogStore: new FileCatalogStore(join(root, "catalog.json")),
    reopenTargetResolver: { resolve: resolvePiReopenTarget },
    trustPreflight: new ProjectTrustCoordinator({ requiresTrust: () => true, savedDecision: () => null, defaultDecision: () => "ask",
      remember: () => { throw new Error("the test must not remember project trust"); } }),
  });
  host = new DockHost({ socketPath: join(root, "dock.sock"), registry, initialize: () => registry.initializeCatalog(), childModels: new ChildModelsStore(root) });
  await host.start();
  client = new DockClient({ socketPath: join(root, "dock.sock"), timeoutMs: 30_000, longMutationTimeoutMs: 180_000 });

  // A trust challenge is answered with the same operation ID that raised it.
  const create = async (cwd, name) => {
    const operationId = `real-create-${name.replace(/\W/g, "-")}`;
    try { return await client.create(cwd, name, operationId); } catch (error) {
      if (!(error instanceof ControlClientError) || error.code !== "project_trust_required") throw error;
      return client.create(cwd, name, operationId, { challengeId: error.details.challengeId, decision: "trust_once" });
    }
  };
  const finish = async (id, ms = 240_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { execution } = await client.status(id);
      if (execution === "idle") return;
      if (execution === "failed") throw new Error("the turn failed");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("the turn did not finish in time");
  };
  // Replies are read from the session files, which this Host keeps in its own directory.
  const replies = () => readdirSync(sessionDir, { recursive: true }).filter((file) => String(file).endsWith(".jsonl"))
    .flatMap((file) => readFileSync(join(sessionDir, String(file)), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).message))
    .filter((message) => message?.role === "assistant");
  const lastText = () => replies().at(-1)?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 60);
  // Pi records a fallback from WebSocket to HTTP on the reply.
  const transportFallbacks = () => JSON.stringify(replies()).split("provider_transport_failure").length - 1;

  const sse = await create(workspace("codex-http", { transport: "sse" }), "Codex HTTP");
  await client.setModel(sse.id, CODEX[0], CODEX[1]);
  await client.setThinking(sse.id, "low");
  await step(`Codex ${CODEX.join("/")} over HTTP with a tool call`, async () => {
    await client.prompt(sse.id, "Use the write tool to create the file ok.txt in the current directory containing exactly OK. Then reply with only the word DONE.");
    await finish(sse.id);
    if (readFileSync(join(root, "codex-http", "ok.txt"), "utf8").trim() !== "OK") throw new Error("ok.txt was not written");
    return `ok.txt written, reply "${lastText()}"`;
  });

  const ws = await create(workspace("codex-websocket", { transport: "websocket" }), "Codex WebSocket");
  await client.setModel(ws.id, CODEX[0], CODEX[1]);
  await client.setThinking(ws.id, "low");
  await step(`Codex ${CODEX.join("/")} over WebSocket`, async () => {
    const fallbacks = transportFallbacks();
    await client.prompt(ws.id, "Reply with only the word PONG.");
    await finish(ws.id);
    if (transportFallbacks() !== fallbacks) throw new Error("the reply fell back from WebSocket to HTTP");
    return `no fallback to HTTP, reply "${lastText()}"`;
  });

  // pi-alu-sol-tuner's /codex-usage takes the Codex token through ModelRegistry, as any extension does.
  await step("/codex-usage takes the Codex token from Main", async () => {
    const notes = [];
    const follow = await client.streamEvents(ws.id, { onEvent: (event) => { if (event.type === "extension.notification") notes.push(event.data); } });
    try {
      await client.prompt(ws.id, "/codex-usage");
      const deadline = Date.now() + 30_000;
      while (notes.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally { follow.close(); }
    const note = notes.at(-1);
    if (!note) throw new Error("no notification arrived; is pi-alu-sol-tuner installed?");
    if (note.level !== "info") throw new Error(`the command reported ${note.level}: ${note.message.split("\n")[0]}`);
    return note.message.split("\n").slice(0, 3).join(" | ");
  });

  const copilot = await create(workspace("copilot", {}), "Copilot");
  await client.setModel(copilot.id, COPILOT[0], COPILOT[1]);
  await step(`GitHub Copilot ${COPILOT.join("/")}`, async () => {
    await client.prompt(copilot.id, "Reply with only the word PONG.");
    await finish(copilot.id);
    return `reply "${lastText()}"`;
  });

  for (const work of [sse, ws, copilot]) await client.stop(work.id).catch(() => {});
} finally {
  client?.closeActiveConnections();
  await host?.stop().catch(() => {});
  await service.stop();
  rmSync(root, { recursive: true, force: true });

  console.log("\nQuestions the Works asked Main:");
  const counts = new Map();
  for (const question of questions) counts.set(question, (counts.get(question) ?? 0) + 1);
  for (const [question, count] of counts) console.log(`  ${count} × ${question}`);

  // Put back only what the test wrote: switching a Work's model and thinking saves them as Pi's
  // defaults. A value someone else changed meanwhile is left alone.
  const path = join(agentDir, "settings.json");
  const raw = readFileSync(path, "utf8");
  const settings = JSON.parse(raw);
  const written = { defaultProvider: COPILOT[0], defaultModel: COPILOT[1], defaultThinkingLevel: "low" };
  let restored = false;
  for (const key of DEFAULT_KEYS) {
    if (settings[key] === before.defaults[key]) continue;
    if (settings[key] === written[key]) { settings[key] = before.defaults[key]; restored = true; }
    else console.log(`Left ${key} as ${settings[key]}: it was changed by someone else during the test`);
  }
  if (restored) writeFileSync(path, `${JSON.stringify(settings, null, raw.startsWith("{\n  \"") ? 2 : undefined)}${raw.endsWith("\n") ? "\n" : ""}`);

  const after = snapshot();
  console.log("\nPi directory, before → after:");
  for (const file of TRACKED) console.log(`  ${file.padEnd(18)} ${before.files[file] === after.files[file] ? "unchanged" : "CHANGED"}`);
  for (const provider of new Set([...Object.keys(before.auth), ...Object.keys(after.auth)])) {
    if (before.auth[provider] !== after.auth[provider]) console.log(`  auth.json ${provider}: ${before.auth[provider] ?? "none"} → ${after.auth[provider] ?? "none"} (a login Pi refreshed; not put back)`);
  }
  console.log(`  sessions           ${before.sessions} → ${after.sessions} entries`);
}
