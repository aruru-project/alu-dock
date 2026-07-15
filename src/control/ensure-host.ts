import { closeSync, chmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { ControlClientError, DockClient } from "./dock-client.js";
import type { PingResult } from "./protocol.js";

const HOST_START_TIMEOUT_MS = 10_000;
const MANAGED_HOST_WAIT_MS = 2_000;
const HOST_PING_INTERVAL_MS = 100;

export interface EnsuredHost {
  ping: PingResult;
  started: boolean;
  logPath?: string;
}

export interface EnsureHostOptions {
  managed?: boolean;
  managedWaitMs?: number;
}

/** Start a development Host on demand; managed releases never fall back to detached ownership. */
export async function ensureHost(socketPath: string, options: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const existing = await pingIfRunning(socketPath);
  if (existing) return { ping: existing, started: false };

  const managed = options.managed ?? process.env.ALU_DOCK_MANAGED === "1";
  if (managed) {
    const deadline = Date.now() + (options.managedWaitMs ?? MANAGED_HOST_WAIT_MS);
    while (Date.now() < deadline) {
      await delay(HOST_PING_INTERVAL_MS);
      const ping = await pingIfRunning(socketPath);
      if (ping) return { ping, started: false };
    }
    throw new Error("Managed Alu Dock service is unavailable; run `systemctl --user status alu-dock.service` and `journalctl --user -u alu-dock.service -n 200 --no-pager`");
  }

  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Cannot locate the alu-dock CLI entry point for host startup");

  const runDirectory = dirname(socketPath);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(runDirectory, "host.log");
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  try {
    const child = spawn(process.execPath, [entryPath, "--socket", socketPath, "serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ping = await pingIfRunning(socketPath);
    if (ping) return { ping, started: true, logPath };
    await delay(HOST_PING_INTERVAL_MS);
  }

  throw new Error(`Alu Dock host did not start within ${HOST_START_TIMEOUT_MS}ms${logTail(logPath)}`);
}

async function pingIfRunning(socketPath: string): Promise<PingResult | undefined> {
  try {
    return await new DockClient({ socketPath, timeoutMs: 400 }).ping();
  } catch (error) {
    if (isUnavailable(error)) return undefined;
    throw error;
  }
}

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof ControlClientError)) return false;
  return error.code === "connection_error"
    || error.code === "connection_closed"
    || error.code === "timeout";
}

function logTail(path: string): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return `; see ${path}`;
    return `; host log: ${content.slice(-1_000)}`;
  } catch {
    return `; see ${path}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
