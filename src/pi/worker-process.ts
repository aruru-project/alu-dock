import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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
    if (!this.child.pid) throw new Error("Pi worker process identity is unavailable during termination");
    await terminateDetachedProcessTree(this.child, this.timeouts.termMs);
  }
}

/** End a detached Pi process and every extension descendant left in its process group. */
export async function terminateDetachedProcessTree(child: ChildProcess, termMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(pid, child, termMs);
    return;
  }
  if (child.connected) {
    try { child.disconnect(); } catch { /* Continue to process-group termination. */ }
  }

  // The direct process may already have exited while extension descendants
  // remain in its detached process group. Always signal and verify the group.
  signalGroup(pid, child, "SIGTERM");
  const [termExited, termGroupGone] = await Promise.all([
    waitForExit(child, termMs).then(() => true, () => false),
    waitForGroupGone(pid, termMs).then(() => true, () => false),
  ]);
  if (termExited && termGroupGone) return;

  signalGroup(pid, child, "SIGKILL");
  await Promise.all([
    waitForExit(child, termMs),
    waitForGroupGone(pid, termMs),
  ]);
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

export function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function signalGroup(pid: number, child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); return; } catch { /* Fall back for platforms without process groups. */ }
  try { child.kill(signal); } catch { /* Already gone. */ }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<void> {
  if (!await processGroupExists(pid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    if (!await processGroupExists(pid)) return;
  }
  throw new Error("Pi worker process group did not exit before the process deadline");
}

async function processGroupExists(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); }
  catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
  if (process.platform !== "linux") return true;

  // 2026-10-31: a container's PID 1 retained killed extension descendants as
  // zombies, so kill(-pgid, 0) prevented Host from publishing Worker loss.
  // Zombies cannot own a session or execute work. A zombie group leader can
  // still have live threads, however, so inspect its tasks before releasing it.
  let foundGroup = false;
  try {
    const entries = (await readdir("/proc")).filter((entry) => /^\d+$/u.test(entry));
    for (const entry of entries) {
      const stat = await readProcessStat(`/proc/${entry}/stat`);
      if (!stat || stat.group !== pid) continue;
      foundGroup = true;
      if (stat.state !== "Z" && stat.state !== "X") return true;
      let tasks: string[];
      try { tasks = await readdir(`/proc/${entry}/task`); }
      catch (error) { if (processDisappeared(error)) continue; throw error; }
      for (const task of tasks) {
        const thread = await readProcessStat(`/proc/${entry}/task/${task}/stat`);
        if (thread && thread.state !== "Z" && thread.state !== "X") return true;
      }
    }
    // If procfs did not expose this group, do not infer that it is dead.
    if (foundGroup) {
      // A descendant can fork after the snapshot and exit before its stat is
      // read. Do not release ownership while that new PID escaped this scan.
      // This is not an atomic procfs snapshot: unrelated PID churn also keeps
      // cleanup pending, and PID reuse remains subject to the OS identity race.
      const confirmed = (await readdir("/proc")).filter((entry) => /^\d+$/u.test(entry));
      const original = new Set(entries);
      return confirmed.length !== entries.length || confirmed.some((entry) => !original.has(entry));
    }
    try { process.kill(-pid, 0); return true; }
    catch (error) { return !processDisappeared(error); }
  } catch { return true; } // Unreadable procfs cannot prove termination.
}

async function readProcessStat(path: string): Promise<{ state: string; group: number } | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (processDisappeared(error)) return undefined; throw error; }
  // comm is parenthesized and may itself contain spaces and closing parentheses.
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const group = Number(fields[2]);
  if (fields[0]?.length !== 1 || !Number.isSafeInteger(group)) throw new Error("Cannot read Linux process state");
  return { state: fields[0], group };
}

function processDisappeared(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
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
