import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { AttachmentStorageState } from "../control/attachment-storage-state.js";
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
    const locked = await this.withStartLock(["install", ...(startNow ? ["--now"] : [])]);
    if (locked) return locked;
    await mkdir(dirname(this.options.setupPath), { recursive: true });
    await writeFile(this.options.setupPath, "Alu Dock Windows user Host\n", "utf8");
    if (!startNow) return this.status();
    return this.start();
  }

  async start(): Promise<UserServiceStatus> {
    const locked = await this.withStartLock(["start"]);
    if (locked) return locked;
    await this.requireInstalled();
    const current = await this.readStatus();
    if (!current) {
      if (await this.absentPhase() === "unknown") throw new Error("Alu Dock startup could not be checked. Open the Host log or rerun Setup.exe before retrying.");
      await this.launch();
    }
    await this.waitForReady();
    return this.status();
  }

  async restart(): Promise<UserServiceStatus> {
    const locked = await this.withStartLock(["restart"]);
    if (locked) return locked;
    await this.requireInstalled();
    const previous = await this.readStatus();
    await this.stopSafely();
    await this.launch();
    await this.waitForReady(previous?.hostEpoch);
    return this.status();
  }

  async stop(): Promise<UserServiceStatus> {
    await this.stopSafely();
    return this.status();
  }

  async status(): Promise<UserServiceStatus & { stateDirectory: string; attachmentDirectory: string } & Pick<WindowsHostLifecycleStatus, "blockingWork" | "mainConnected" | "restoringWorks" | "unavailableWorks">> {
    const stateRoot = resolve(dirname(this.options.logPath), "..");
    const storage = await new AttachmentStorageState(stateRoot, join(stateRoot, "attachments")).readSettings();
    const stateDirectory = await realpath(stateRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return stateRoot;
      throw error;
    });
    const installed = await fileExists(this.options.cliPath) && await fileExists(this.options.setupPath);
    const current = await this.readStatus();
    const ready = current?.ready === true;
    const phase = current?.phase ?? (ready ? "ready" : current ? "starting" : await this.absentPhase());
    const diagnostics: string[] = [];
    if (phase === "starting") diagnostics.push("Alu Dock is starting. Wait a moment, then check again.");
    if (phase === "stopping") diagnostics.push("Alu Dock is stopping. Wait before starting it again.");
    if (phase === "unknown") diagnostics.push("Alu Dock could not be checked. Open the Host log or rerun Setup.exe.");
    if (phase === "stopped") diagnostics.push("Alu Dock is not running. Run `aludock service start`.");
    return {
      unit: WINDOWS_HOST_NAME,
      unitFile: this.options.setupPath,
      activeState: current ? "active" : phase === "unknown" ? "unknown" : "inactive",
      subState: ready ? "running" : phase,
      unitFileState: installed ? "enabled" : "not-found",
      installed,
      mainPid: current?.pid ?? 0,
      blockingWork: current?.blockingWork ?? 0,
      ready,
      ...(current?.hostEpoch === undefined ? {} : { hostEpoch: current.hostEpoch }),
      ...(current?.role === undefined ? {} : { role: current.role }),
      ...(current?.mainConnected === undefined ? {} : { mainConnected: current.mainConnected }),
      ...(current?.restoringWorks === undefined ? {} : { restoringWorks: current.restoringWorks }),
      ...(current?.unavailableWorks === undefined ? {} : { unavailableWorks: current.unavailableWorks }),
      logsPath: this.options.logPath,
      stateDirectory,
      attachmentDirectory: storage.directory,
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

  private async absentPhase(): Promise<"stopped" | "unknown"> {
    try {
      const owner = JSON.parse(await readFile(join(dirname(this.options.logPath), "..", "host-owner.json"), "utf8")) as { pid?: number; exited?: boolean };
      if (owner.pid === 0 && owner.exited === true) return "stopped";
      return Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && !processAlive(Number(owner.pid)) ? "stopped" : "unknown";
    } catch { return "unknown"; }
  }

  private async withStartLock(arguments_: string[]): Promise<UserServiceStatus | undefined> {
    if (process.platform !== "win32" || process.env.ALUDOCK_START_LOCK_HELD === "1") return undefined;
    const output = await nativeCommand(this.options.cliPath, ["--service", this.options.nodePath, this.options.cliPath, ...arguments_]);
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? "") as UserServiceStatus;
  }

  private async requireInstalled(): Promise<void> {
    if (!await fileExists(this.options.cliPath) || !await fileExists(this.options.setupPath)) {
      throw new Error("Alu Dock is not set up for this user. Run Setup.exe, then try again.");
    }
  }

  private async stopSafely(): Promise<void> {
    const current = await this.readStatus();
    if (!current) {
      if (await this.absentPhase() === "unknown") throw new Error("Alu Dock could not be confirmed stopped. Rerun Setup.exe or check the Host log before retrying.");
      return;
    }
    // Refuse from the status snapshot first so an obviously busy Host is not
    // asked to stop at all; the stop response re-checks under the Host's lock.
    if (current.blockingWork > 0) throw stillActiveError(current.blockingWork);
    const result = await this.requestStop();
    if (!result) throw new Error("Alu Dock stopped responding. Check the Host log before retrying.");
    if (result.stopAccepted === false) throw stillActiveError(result.blockingWork);
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

  private async waitForReady(previousEpoch?: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readStatus();
      if (current?.ready && (previousEpoch === undefined || current.hostEpoch !== previousEpoch)) return;
      await this.sleep(READY_POLL_MS);
    }
    if ((await this.readStatus())?.phase === "starting") return;
    throw new Error("Alu Dock startup could not be confirmed. Open the Host log, then check again.");
  }
}

function stillActiveError(blockingWork: number): Error {
  return new Error(
    `${blockingWork} work item${blockingWork === 1 ? " is" : "s are"} still active. `
    + "Finish or stop the listed work, then try again.",
  );
}

async function launchHiddenHost(nodePath: string, cliPath: string, logPath: string): Promise<void> {
  await rotateHostLog(logPath);
  await appendFile(logPath, `\n--- Alu Dock started ${new Date().toISOString()} ---\n`, "utf8");
  const ownerPath = join(dirname(logPath), "..", "host-owner.json");
  await writeFile(ownerPath, JSON.stringify({ launching: true }), "utf8");
  const pid = Number((await nativeCommand(cliPath, ["--launch-host", nodePath, resolve(dirname(cliPath), "deployment/windows-host-bootstrap.js"), logPath])).trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Windows did not confirm the Alu Dock launch. Check the Host log.");
  await writeFile(ownerPath, JSON.stringify({ pid }), "utf8");
}

async function nativeCommand(cliPath: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(resolve(dirname(cliPath), "../../..", "AluDock.exe"), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectResult);
    child.once("close", (code) => code === 0 ? resolveResult(stdout) : rejectResult(new Error(stderr.trim() || "Windows could not launch Alu Dock. Rerun Setup.exe.")));
  });
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
