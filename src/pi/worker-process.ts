import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WORKER_INCIDENT_STDERR_MAX_BYTES } from "../core/worker-incident.js";
import { piWorkerRuntimeEnvironment } from "./pi-runtime-environment.js";
import type { WorkerIdentity } from "./worker-protocol.js";
import type { JsonObject } from "../core/json-value.js";

export interface PiWorkerInitOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  workerConfig?: JsonObject;
  projectTrusted: boolean;
  sessionFile?: string;
  initialName?: string;
}

export interface WorkerProcessTimeouts {
  startupMs: number;
  requestMs: number;
  mutationMs: number;
  controlMs: number;
  disconnectMs: number;
  gracefulShutdownMs: number;
  termMs: number;
}

export const DEFAULT_WORKER_TIMEOUTS: WorkerProcessTimeouts = {
  startupMs: 30_000,
  requestMs: 15_000,
  mutationMs: 60_000,
  controlMs: 2_000,
  disconnectMs: 1_000,
  gracefulShutdownMs: 3_000,
  termMs: 2_000,
};

export interface PiWorkerProcessOptions {
  identity: WorkerIdentity;
  init: PiWorkerInitOptions;
  environment: NodeJS.ProcessEnv;
  entry?: string;
  timeouts?: Partial<WorkerProcessTimeouts>;
  onSpawn?: (pid: number) => void;
}

/** Owns one Worker process tree and always reaps its direct child. */
export class PiWorkerProcess {
  readonly child: ChildProcess;
  readonly timeouts: WorkerProcessTimeouts;
  private terminating: Promise<void> | undefined;
  private stderrTail = Buffer.alloc(0);
  private stderrBytesSeen = 0;
  private readonly stderrClosed: Promise<void>;

  constructor(options: PiWorkerProcessOptions) {
    this.timeouts = { ...DEFAULT_WORKER_TIMEOUTS, ...options.timeouts };
    const entry = options.entry ?? fileURLToPath(new URL("./pi-worker-entry.js", import.meta.url));
    this.child = spawn(process.execPath, [entry], {
      cwd: options.init.cwd,
      detached: true,
      // A detached Windows process otherwise receives its own visible console.
      // Keep the Worker process group while preventing background Work from
      // interrupting the desktop.
      windowsHide: true,
      // Invoking the entry directly also keeps parent runner/debug flags (for
      // example --test or --input-type) out of the managed runtime process.
      env: {
        ...definedEnvironment(piWorkerRuntimeEnvironment(options.environment)),
        ALU_DOCK_PI_WORKER: "1",
        // Keep Pi's own config/session contract coherent even though the login-shell
        // capture intentionally drops Host process overrides.
        PI_CODING_AGENT_DIR: options.init.agentDir,
        ALU_DOCK_WORKER_IDENTITY: JSON.stringify(options.identity),
        ALU_DOCK_WORKER_INIT: JSON.stringify(options.init),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    if (!this.child.pid) throw new Error("Pi worker did not receive a process identity");
    const stderr = this.child.stderr;
    if (!stderr) throw new Error("Pi worker did not expose its error output");
    this.stderrClosed = new Promise((resolveClosed) => {
      let closed = false;
      const finish = (): void => { if (!closed) { closed = true; resolveClosed(); } };
      stderr.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        try {
          if (!process.stderr.write(chunk)) {
            stderr.pause();
            process.stderr.once("drain", () => stderr.resume());
          }
        } catch { /* The incident tail remains available. */ }
        this.appendStderr(chunk);
      });
      stderr.once("end", finish);
      stderr.once("close", finish);
      stderr.once("error", finish);
    });
    options.onSpawn?.(this.child.pid);
  }

  async incidentStderr(timeoutMs: number): Promise<{ stderrTail: string; stderrTruncated: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.stderrClosed,
      new Promise<void>((resolveWait) => { timer = setTimeout(resolveWait, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return {
      stderrTail: this.stderrTail.toString("utf8"),
      stderrTruncated: this.stderrBytesSeen > this.stderrTail.length,
    };
  }

  terminate(): Promise<void> {
    if (this.terminating) return this.terminating;
    this.terminating = this.performTerminate();
    return this.terminating;
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrBytesSeen += chunk.length;
    if (chunk.length >= WORKER_INCIDENT_STDERR_MAX_BYTES) {
      this.stderrTail = Buffer.from(chunk.subarray(chunk.length - WORKER_INCIDENT_STDERR_MAX_BYTES));
      return;
    }
    const overflow = this.stderrTail.length + chunk.length - WORKER_INCIDENT_STDERR_MAX_BYTES;
    this.stderrTail = overflow > 0
      ? Buffer.concat([this.stderrTail.subarray(overflow), chunk])
      : Buffer.concat([this.stderrTail, chunk]);
  }

  private async performTerminate(): Promise<void> {
    const child = this.child;
    const pid = child.pid;
    if (!pid) throw new Error("Pi worker process identity is unavailable during termination");
    if (process.platform === "win32") {
      await terminateWindowsProcessTree(pid, child, this.timeouts.termMs);
      return;
    }
    if (child.connected) {
      try { child.disconnect(); } catch { /* Continue to process-group termination. */ }
    }

    // The direct Worker may already have exited while extension descendants
    // remain in its detached process group. Always signal and verify the group.
    signalGroup(pid, child, "SIGTERM");
    const [termExited, termGroupGone] = await Promise.all([
      waitForExit(child, this.timeouts.termMs).then(() => true, () => false),
      waitForGroupGone(pid, this.timeouts.termMs).then(() => true, () => false),
    ]);
    if (termExited && termGroupGone) return;

    signalGroup(pid, child, "SIGKILL");
    await Promise.all([
      waitForExit(child, this.timeouts.termMs),
      waitForGroupGone(pid, this.timeouts.termMs),
    ]);
  }
}

async function terminateWindowsProcessTree(pid: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    killer.once("error", reject);
    killer.once("close", resolve);
  });
  if (exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
    throw new Error("Windows could not terminate the Pi worker process tree");
  }
  await waitForExit(child, timeoutMs);
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function signalGroup(pid: number, child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); return; } catch { /* Fall back for platforms without process groups. */ }
  try { child.kill(signal); } catch { /* Already gone. */ }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<void> {
  if (!processGroupExists(pid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    if (!processGroupExists(pid)) return;
  }
  throw new Error("Pi worker process group did not exit before the process deadline");
}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = (): void => { cleanup(); resolve(); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Pi worker did not exit before the process deadline"));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", done);
      child.off("close", done);
    };
    // `close` may never follow `exit` when the IPC channel is disconnected and
    // stderr is inherited. Process ownership is released at `exit`; group
    // verification below independently proves that descendants are gone.
    child.once("exit", done);
    child.once("close", done);
    if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(done);
  });
}
