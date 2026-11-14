import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { ALU_DOCK_PI_WORKER_GUIDANCE, createPiAgentAdapter } from "../src/pi/pi-agent-adapter.js";
import { inspectPiEnvironment, loginPiProvider, logoutPiProvider } from "../src/pi/pi-environment.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

const cli = new URL("../src/cli.js", import.meta.url).pathname;

const DEFAULT_SETTINGS = { defaultProvider: "openai", defaultModel: "gpt-4o-mini" };
const DEFAULT_AUTH = { openai: { type: "api_key", key: "fixture-no-model-call" } };

test("Pi-native access uses auth.json while identity guidance leaves existing Sessions in place", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-pi-native-access-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const existingSession = join(agentDir, "sessions", "existing-session.jsonl");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(join(agentDir, "sessions"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(agentDir, "settings.json"), JSON.stringify(DEFAULT_SETTINGS)),
    writeFile(existingSession, "existing Pi history\n"),
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  const prompts: string[] = [];
  await loginPiProvider("anthropic", "api_key", {
    prompt: async (prompt) => {
      prompts.push(prompt.type);
      return "sk-ant-fixture-do-not-use";
    },
    notify: () => {},
  }, { agentDir });

  const snapshot = await inspectPiEnvironment({ agentDir });
  const anthropic = snapshot.providers.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.storedCredentialType, "api_key");
  assert.equal(anthropic.configured, true);
  assert.ok(snapshot.models.some((model) => model.provider === "anthropic"));
  assert.deepEqual(prompts, ["secret"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-ant-fixture/u);
  assert.equal(await readFile(existingSession, "utf8"), "existing Pi history\n");
  const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(auth.anthropic, { type: "api_key", key: "sk-ant-fixture-do-not-use" });
  await logoutPiProvider("anthropic", { agentDir });
  const afterLogout = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
  assert.equal(afterLogout.anthropic, undefined);

  const adapter = await createPiAgentAdapter({ cwd, agentDir, sessionDir, projectTrusted: false });
  try {
    assert.match(adapter.currentSession().systemPrompt, /running as a Pi Worker managed by Alu Dock/u);
    assert.ok(adapter.currentSession().systemPrompt.includes(ALU_DOCK_PI_WORKER_GUIDANCE));
  } finally {
    await adapter.control({ type: "dispose" });
  }
});

// Owner report, 2026-11-14: Hub sign-in ignored the proxy that already worked for Pi sessions.
// Only the OAuth endpoint and proxy are fixtures; the Hub login entry, provider loading and storage are real.
test("Hub Pi sign-in uses the configured proxy and saves the returned OAuth credential", { timeout: 20_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-hub-login-proxy-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const credentials = { access: "fixture-proxy-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 };
  const respond = (response: ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(credentials));
  };
  const origin = createServer((_request, response) => respond(response));
  const proxyTargets: string[] = [];
  const proxy = createServer((request, response) => {
    proxyTargets.push(new URL(request.url!).host);
    respond(response);
  });
  const sockets = new Set<Duplex>();
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([origin, proxy].map((server) => new Promise<void>((done) => server.close(() => done()))));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
  const originPort = (origin.address() as { port: number }).port;
  const authority = `127.0.0.1:${originPort}`;
  // Accept CONNECT too: Pi's network bootstrap supports HTTP clients that tunnel HTTP origins.
  proxy.on("connect", (request, socket, head) => {
    proxyTargets.push(request.url!);
    sockets.add(socket);
    const upstream = connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const extension = join(agentDir, "oauth-fixture.mjs");
  await writeFile(extension, `export default function (pi) {
    pi.registerProvider("proxy-fixture", {
      api: "openai-completions", baseUrl: "http://${authority}", models: [],
      oauth: {
        name: "Proxy fixture",
        async login(callbacks) {
          const code = await callbacks.onPrompt({ message: "Authorization code" });
          const response = await fetch("http://${authority}/token", {
            method: "POST", body: code, signal: AbortSignal.timeout(5000)
          });
          if (!response.ok) throw new Error("Fixture login failed");
          return await response.json();
        },
        async refreshToken(credentials) { return credentials; },
        getApiKey(credentials) { return credentials.access; }
      }
    });
  }`);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    httpProxy: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    extensions: [extension],
  }));
  // Network setup changes process globals, so neither this test nor another login can prime the child.
  await exec("--input-type=module", ["--eval", `
    import { loginPiProvider } from ${JSON.stringify(new URL("../src/pi/pi-environment.js", import.meta.url).href)};
    import { getGlobalDispatcher } from "undici";
    await loginPiProvider("proxy-fixture", "oauth", {
      prompt: async () => "fixture-authorization-code", notify: () => {}
    }, { agentDir: ${JSON.stringify(agentDir)} });
    await getGlobalDispatcher().close();
  `], isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir }), process.cwd());
  assert.ok(proxyTargets.includes(authority), "Hub login bypassed Pi's configured proxy");
  const saved = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
  assert.equal(saved["proxy-fixture"].type, "oauth");
  assert.equal(saved["proxy-fixture"].access, credentials.access);
});

test("bundled CLI install and Protocol Worker configuration work without invoking a system Pi", { timeout: 40_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-bundled-pi-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const packageDir = join(root, "fixture-package");
  const probe = join(root, "worker-aludock.txt");
  const stateDir = join(root, "state");
  const catalogPath = join(stateDir, "catalog.json");
  const socketPath = join(root, "dock.sock");
  await Promise.all([
    mkdir(cwd),
    mkdir(agentDir),
    mkdir(packageDir),
    // The CLI catalog requires a private directory, independent of the runner's umask.
    mkdir(stateDir, { mode: 0o700 }),
  ]);
  await chmod(root, 0o700);
  await Promise.all([
    writeFile(join(agentDir, "settings.json"), JSON.stringify(DEFAULT_SETTINGS)),
    writeFile(join(agentDir, "auth.json"), JSON.stringify(DEFAULT_AUTH)),
    writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "alu-dock-bundled-pi-fixture",
      version: "1.0.0",
      pi: { extensions: ["./extension.ts"] },
    })),
    writeFile(join(packageDir, "extension.ts"), `
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
const run = promisify(execFile);
export default async function (pi) {
  const result = await run("aludock", ["help", "pi:install"]);
  await writeFile(${JSON.stringify(probe)}, result.stdout);
  pi.registerCommand("bundled-install-fixture", { handler: async () => {} });
}
`),
  ]);
  const env = isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir });
  let host: ChildProcess | undefined;
  let workerHost: DockHost | undefined;
  context.after(async () => {
    if (host) await stopProcess(host);
    await workerHost?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const install = await exec(cli, ["pi:install", "./fixture-package"], env, root);
  assert.match(install.stdout, /Installed .*fixture-package for Pi/u);
  assert.equal(install.stderr, "");

  const oldSessionFile = await createExistingPiSession(cwd, env);
  assert.equal(isAbsolute(oldSessionFile), true);
  assert.equal(inside(join(agentDir, "sessions"), oldSessionFile), true);

  host = spawn(process.execPath, [cli, "--socket", socketPath, "serve", "--dev", "--state", catalogPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const client = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 15_000 });
  await waitUntilReady(client, host);

  const hubOutput = await openHubPiSettings(socketPath, env);
  assert.match(hubOutput, /Pi configuration/u);
  assert.match(hubOutput, /Provider access · \d+ configured/u);
  assert.match(hubOutput, /Install a Pi package/u);
  assert.doesNotMatch(hubOutput, /fixture-no-model-call/u);

  const inventory = await client.sessionInventory(cwd, "all");
  assert.ok(inventory.sessions.some((session) => session.sessionFile === oldSessionFile));
  client.closeActiveConnections();
  await stopProcess(host);
  host = undefined;

  // Card #351: a Worker created by the CLI-started Host above would take the developer's login-shell
  // environment. The Work runs behind a Host that gives its Worker this test's environment instead.
  workerHost = new DockHost({
    socketPath,
    registry: new DockRegistry((input) => createPiInstance({ ...input, agentDir, workerEnvironment: env })),
  });
  await workerHost.start();
  const workerClient = new DockClient({ socketPath, timeoutMs: 5_000, longMutationTimeoutMs: 15_000 });
  const created = await workerClient.create(
    cwd,
    "bundled Pi",
    "bundled-pi-create",
    undefined,
    undefined,
    { excludeTools: ["bash"] },
  );
  assert.equal(inside(join(agentDir, "sessions"), created.executor.sessionFile as string), true);
  const tools = await workerClient.tools(created.id);
  assert.equal(tools.tools.some((tool) => tool.name === "bash"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "read"), true);
  const commands = await workerClient.commands(created.id);
  assert.equal(commands.commands.some((command) => command.name === "bundled-install-fixture"), true);
  assert.match(await readFile(probe, "utf8"), /aludock pi:install — install a package for Pi/u);

  workerClient.closeActiveConnections();
  await workerHost.stop();
  workerHost = undefined;
});

async function openHubPiSettings(socketPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const driver = join(process.cwd(), "test/fixtures/pty-tui-driver.py");
  const result = await new Promise<string>((resolveRun, rejectRun) => {
    execFile("python3", [driver, process.execPath, cli, "--socket", socketPath], {
      env: { ...env, ALU_DOCK_PTY_ACTION: "hub-pi-settings" },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? rejectRun(new Error(stderr || error.message, { cause: error })) : resolveRun(stdout));
  });
  const receipt = JSON.parse(result) as { status: number; timedOut: boolean; output: string };
  const output = Buffer.from(receipt.output, "base64").toString("utf8");
  assert.equal(receipt.timedOut, false, output.slice(-2_000));
  assert.equal(receipt.status, 0, output.slice(-2_000));
  return output;
}

async function exec(path: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [path, ...args], { cwd, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || error.message, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
  });
}

async function createExistingPiSession(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const script = `
import { SessionManager } from "@earendil-works/pi-coding-agent";
const manager = SessionManager.create(${JSON.stringify(cwd)});
manager.appendMessage({ role: "user", content: [{ type: "text", text: "existing history" }], timestamp: 1 });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "existing answer" }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 2,
});
process.stdout.write(manager.getSessionFile());
`;
  const result = await new Promise<string>((resolveRun, rejectRun) => {
    execFile(process.execPath, ["--input-type=module", "--eval", script], { cwd: process.cwd(), env }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(stderr || error.message, { cause: error }));
      else resolveRun(stdout.trim());
    });
  });
  return result;
}

async function waitUntilReady(client: DockClient, child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host exited before readiness: ${stderr}`);
    try {
      await client.ping();
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error(`Host did not become ready: ${stderr}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Host did not stop")), 15_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
