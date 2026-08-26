import { spawn } from "node:child_process";
import { closeSync, openSync, unwatchFile, watchFile } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ServiceCommandResult, UserServiceStatus } from "./user-service.js";
import {
  readWindowsHostLifecycleStatus,
  requestWindowsHostStop,
  type WindowsHostLifecycleStatus,
  type WindowsHostLifecycleStopResult,
} from "./windows-host-lifecycle.js";

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const WINDOWS_HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;
const WINDOWS_HOST_NAME = "Alu Dock Host";

export interface WindowsUserHostManagerOptions {
  nodePath: string;
  cliPath: string;
  setupPath: string;
  logPath: string;
  timeoutMs?: number;
  readStatus?: () => Promise<WindowsHostLifecycleStatus | undefined>;
  requestStop?: () => Promise<WindowsHostLifecycleStopResult | undefined>;
  launch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** Owns the current-user Windows Host lifecycle without tying it to a Desktop window. */
export class WindowsUserHostManager {
  private readonly timeoutMs: number;
  private readonly readStatus: () => Promise<WindowsHostLifecycleStatus | undefined>;
  private readonly requestStop: () => Promise<WindowsHostLifecycleStopResult | undefined>;
  private readonly launch: () => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WindowsUserHostManagerOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? READY_TIMEOUT_MS);
    this.readStatus = options.readStatus ?? (() => readWindowsHostLifecycleStatus());
    this.requestStop = options.requestStop ?? (() => requestWindowsHostStop());
    this.launch = options.launch ?? (() => launchHiddenHost(options.nodePath, options.cliPath, options.logPath));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  }

  async install(startNow: boolean): Promise<UserServiceStatus> {
    await mkdir(dirname(this.options.setupPath), { recursive: true });
    await writeFile(this.options.setupPath, "Alu Dock Windows user Host\n", "utf8");
    if (!startNow) return this.status();
    const current = await this.readStatus();
    if (current) await this.stopSafely();
    await this.launch();
    await this.waitForReady(current?.hostEpoch);
    return this.status();
  }

  async start(): Promise<UserServiceStatus> {
    await this.requireInstalled();
    const current = await this.readStatus();
    if (!current) await this.launch();
    await this.waitForReady();
    return this.status();
  }

  async restart(): Promise<UserServiceStatus> {
    await this.requireInstalled();
    const previous = await this.readStatus();
    if (previous) await this.stopSafely();
    await this.launch();
    await this.waitForReady(previous?.hostEpoch);
    return this.status();
  }

  async stop(): Promise<UserServiceStatus> {
    await this.stopSafely();
    return this.status();
  }

  async status(): Promise<UserServiceStatus> {
    const installed = await fileExists(this.options.cliPath) && await fileExists(this.options.setupPath);
    const current = await this.readStatus();
    const ready = current?.ready === true;
    const diagnostics: string[] = [];
    if (current && !ready) diagnostics.push("Alu Dock is starting. Wait a moment, then check again.");
    if (!current) diagnostics.push("Alu Dock is not running. Run `aludock service start`.");
    diagnostics.push("Alu Dock stops after you log out of Windows. Start it again after signing in.");
    return {
      unit: WINDOWS_HOST_NAME,
      unitFile: this.options.setupPath,
      activeState: current ? "active" : "inactive",
      subState: ready ? "running" : current ? "starting" : "stopped",
      unitFileState: installed ? "enabled" : "not-found",
      installed,
      mainPid: current?.pid ?? 0,
      ready,
      ...(current?.hostEpoch === undefined ? {} : { hostEpoch: current.hostEpoch }),
      ...(current?.role === undefined ? {} : { role: current.role }),
      logsPath: this.options.logPath,
      linger: "unknown",
      diagnostics,
    };
  }

  async logs(lines: number, follow: boolean): Promise<ServiceCommandResult> {
    await mkdir(dirname(this.options.logPath), { recursive: true });
    const content = await readFileIfPresent(this.options.logPath);
    process.stdout.write(lastLines(content, lines));
    if (follow) await followLog(this.options.logPath, content.length);
    return { status: 0, stdout: "", stderr: "" };
  }

  async uninstall(): Promise<{ unit: string; unitFile: string; removed: boolean }> {
    await this.stopSafely();
    const removed = await fileExists(this.options.setupPath);
    await rm(this.options.setupPath, { force: true });
    return { unit: WINDOWS_HOST_NAME, unitFile: this.options.setupPath, removed };
  }

  private async requireInstalled(): Promise<void> {
    if (!await fileExists(this.options.cliPath) || !await fileExists(this.options.setupPath)) {
      throw new Error("Alu Dock is not set up for this user. Run Setup.cmd from the Windows package, then try again.");
    }
  }

  private async stopSafely(): Promise<void> {
    const current = await this.readStatus();
    if (!current) return;
    const result = await this.requestStop();
    if (result?.stopAccepted === false) {
      throw new Error(
        `${result.blockingWork} work item${result.blockingWork === 1 ? " is" : "s are"} still active. `
        + "Finish or stop the listed work, then try again.",
      );
    }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (!await this.readStatus()) {
        if (process.platform === "win32") await waitForProcessExit(current.pid, deadline, this.sleep);
        return;
      }
      await this.sleep(READY_POLL_MS);
    }
    throw new Error("Alu Dock is still stopping. Wait a moment, then try again.");
  }

  private async waitForReady(previousEpoch?: string): Promise<WindowsHostLifecycleStatus> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readStatus();
      if (current?.ready && (previousEpoch === undefined || current.hostEpoch !== previousEpoch)) return current;
      await this.sleep(READY_POLL_MS);
    }
    throw new Error("Alu Dock did not finish starting. Open the Host log from Alu Dock, then try again.");
  }
}

async function launchHiddenHost(nodePath: string, cliPath: string, logPath: string): Promise<void> {
  await rotateHostLog(logPath);
  await appendFile(logPath, `\n--- Alu Dock started ${new Date().toISOString()} ---\n`, "utf8");
  const log = openSync(logPath, "a");
  try {
    const child = spawn(nodePath, [cliPath, "host"], {
      cwd: homedir(),
      detached: true,
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const fail = (error: Error): void => { child.off("spawn", ready); rejectSpawn(error); };
      const ready = (): void => { child.off("error", fail); resolveSpawn(); };
      child.once("error", fail);
      child.once("spawn", ready);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

async function rotateHostLog(logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  try {
    if ((await stat(logPath)).size < WINDOWS_HOST_LOG_MAX_BYTES) return;
    const previous = `${logPath}.previous`;
    await rm(previous, { force: true });
    await rename(logPath, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readFileIfPresent(path: string): Promise<Buffer> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

function lastLines(content: Buffer, count: number): string {
  if (content.length === 0) return "";
  const lines = content.toString("utf8").split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const selected = lines.slice(-count);
  return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
}

async function followLog(path: string, initialPosition: number): Promise<void> {
  let position = initialPosition;
  let reading = false;
  let pending = false;
  let settled = false;
  let resolveFollow!: () => void;
  let rejectFollow!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { resolveFollow = resolve; rejectFollow = reject; });

  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    unwatchFile(path, changed);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    resolveFollow();
  };
  const stop = (): void => cleanup();
  const changed = (): void => {
    pending = true;
    void drain();
  };
  const drain = async (): Promise<void> => {
    if (reading || settled) return;
    reading = true;
    try {
      while (pending && !settled) {
        pending = false;
        let size = 0;
        try { size = (await stat(path)).size; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { position = 0; continue; }
          throw error;
        }
        if (size < position) position = 0;
        if (size <= position) continue;
        const handle = await open(path, "r");
        try {
          const chunk = Buffer.alloc(size - position);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          position += bytesRead;
          if (bytesRead > 0) process.stdout.write(chunk.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        unwatchFile(path, changed);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        rejectFollow(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      reading = false;
    }
  };

  watchFile(path, { interval: 250 }, changed);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await finished;
}

async function waitForProcessExit(pid: number, deadline: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error("Alu Dock is still stopping. Wait a moment, then try again.");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
