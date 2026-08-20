import { ControlClientError, DockClient } from "./dock-client.js";
import type { PingResult } from "./protocol.js";

const HOST_WAIT_MS = 2_000;
const HOST_PING_INTERVAL_MS = 100;

export interface EnsuredHost {
  ping: PingResult;
  started: false;
}

export interface EnsureHostOptions {
  managedWaitMs?: number;
}

export class ServiceUnavailableError extends Error {
  readonly code = "service_unavailable";

  constructor() {
    super("Alu Dock is not available. Run `aludock service start`; if it does not start, run `aludock service logs --lines 200`.");
    this.name = "ServiceUnavailableError";
  }
}

/** Connect to the managed Host; ordinary clients never start or fork a Host. */
export async function ensureHost(socketPath: string, options: EnsureHostOptions = {}): Promise<EnsuredHost> {
  const deadline = Date.now() + Math.max(0, options.managedWaitMs ?? HOST_WAIT_MS);
  do {
    const ping = await pingIfRunning(socketPath);
    if (ping) return { ping, started: false };
    if (Date.now() >= deadline) break;
    await delay(HOST_PING_INTERVAL_MS);
  } while (true);
  throw new ServiceUnavailableError();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
