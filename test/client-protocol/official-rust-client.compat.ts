import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

const SESSION_ID = "00000000-0000-4000-8000-000000002609";

/** Cross-runtime gate. Intentionally not named *.test.ts; ordinary npm test stays Node-only. */
test("official Rust client lists saved sessions for an explicitly selected Main", { timeout: 60_000 }, async (context) => {
  assert.equal(process.platform, "linux", "test:client-protocol requires Linux isolated Unix-socket process semantics");
  const root = await mkdtemp(join(tmpdir(), "alu-dock-client-protocol-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessions = join(agentDir, "sessions", "fixture");
  const state = join(root, "state", "catalog.json");
  const socket = join(root, "dock.sock");
  const identity = join(root, "client-identity");
  let host: ChildProcess | undefined;

  try {
    await Promise.all([
      mkdir(home),
      mkdir(workspace),
      mkdir(sessions, { recursive: true }),
      mkdir(join(root, "state"), { recursive: true }),
      chmod(root, 0o700),
    ]);
    await writeFile(join(sessions, "saved.jsonl"), `${[
      { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-05T00:00:00.000Z", cwd: workspace },
      { type: "session_info", id: "info-1", parentId: null, timestamp: "2026-09-05T00:00:01.000Z", name: "Protocol gate saved session" },
      { type: "message", id: "message-1", parentId: "info-1", timestamp: "2026-09-05T00:00:02.000Z", message: { role: "user", content: "restore protocol gate", timestamp: 1 } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });

    const hostEnvironment = isolatedEnvironment(root, home, agentDir);
    host = spawn(process.execPath, ["dist/src/cli.js", "--socket", socket, "serve", "--dev", "--state", state], {
      cwd: process.cwd(), env: hostEnvironment, stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    host.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    await waitForReady(host, stderr);

    const targetDirectory = resolve(process.env.CARGO_TARGET_DIR || "clients/official/target");
    const reader = join(targetDirectory, "debug", "examples", "protocol_inventory");
    const result = await run(reader, [socket, identity, workspace, SESSION_ID], process.env, context.signal);
    assert.equal(result.code, 0, `official Rust client failed:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`decoded saved session ${SESSION_ID}`));
  } finally {
    await stopChild(host);
    await rm(root, { recursive: true, force: true });
  }
});

function isolatedEnvironment(root: string, home: string, agentDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ALU_DOCK_") || key === "STATE_DIRECTORY") delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    PI_CODING_AGENT_DIR: agentDir,
  };
}

async function waitForReady(child: ChildProcess, stderr: string[]): Promise<void> {
  assert.ok(child.stdout);
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line) as { kind?: unknown };
        if (value.kind === "host.ready") resolve();
      } catch { /* Non-JSON output cannot prove readiness. */ }
    });
    child.once("exit", (code, signal) => reject(new Error(`Host exited before ready (${String(code ?? signal)}):\n${stderr.join("")}`)));
  });
  let readyTimeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    readyTimeout = setTimeout(() => reject(new Error(`Host ready timeout:\n${stderr.join("")}`)), 10_000);
  });
  try {
    await Promise.race([ready, deadline]);
  } finally {
    if (readyTimeout) clearTimeout(readyTimeout);
    lines.close();
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let child: ChildProcess | undefined;
  try {
    return await new Promise((resolveRun, reject) => {
      child = spawn(command, args, { cwd: process.cwd(), env, signal, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
    });
  } finally {
    await stopChild(child);
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
