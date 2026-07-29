import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { WorkerIdentity } from "./worker-protocol.js";

export interface PiWorkerInitOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
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

/** Owns one detached process group and always reaps its direct child. */
export class PiWorkerProcess {
  readonly child: ChildProcess;
  readonly timeouts: WorkerProcessTimeouts;
  private terminating: Promise<void> | undefined;

  constructor(options: PiWorkerProcessOptions) {
    this.timeouts = { ...DEFAULT_WORKER_TIMEOUTS, ...options.timeouts };
    const entry = options.entry ?? fileURLToPath(new URL("./pi-worker-entry.js", import.meta.url));
    this.child = fork(entry, [], {
      cwd: options.init.cwd,
      detached: true,
      // Do not leak parent runner/debug flags (for example --test or
      // --input-type) into the managed runtime process.
      execArgv: [],
      env: {
        ...definedEnvironment(options.environment),
        ALU_DOCK_PI_WORKER: "1",
        ALU_DOCK_WORKER_IDENTITY: JSON.stringify(options.identity),
        ALU_DOCK_WORKER_INIT: JSON.stringify(options.init),
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "json",
    });
    if (!this.child.pid) throw new Error("Pi worker did not receive a process identity");
    options.onSpawn?.(this.child.pid);
  }

  terminate(): Promise<void> {
    if (this.terminating) return this.terminating;
    this.terminating = this.performTerminate();
    return this.terminating;
  }

  private async performTerminate(): Promise<void> {
    const child = this.child;
    const pid = child.pid;
    if (!pid) throw new Error("Pi worker process identity is unavailable during termination");
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
