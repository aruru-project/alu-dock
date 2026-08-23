import { spawnSync } from "node:child_process";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ServiceCommandResult, UserServiceStatus } from "./user-service.js";
import {
  readWindowsHostLifecycleStatus,
  requestWindowsHostStop,
  type WindowsHostLifecycleStatus,
} from "./windows-host-lifecycle.js";

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const WINDOWS_HOST_NAME = "Alu Dock Host";

export interface WindowsUserHostManagerOptions {
  nodePath: string;
  cliPath: string;
  setupPath: string;
  timeoutMs?: number;
  readStatus?: () => Promise<WindowsHostLifecycleStatus | undefined>;
  requestStop?: () => Promise<WindowsHostLifecycleStatus | undefined>;
  launch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** User-session Host lifecycle. It intentionally creates no Windows service or startup task. */
export class WindowsUserHostManager {
  private readonly timeoutMs: number;
  private readonly readStatus: () => Promise<WindowsHostLifecycleStatus | undefined>;
  private readonly requestStop: () => Promise<WindowsHostLifecycleStatus | undefined>;
  private readonly launch: () => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WindowsUserHostManagerOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? READY_TIMEOUT_MS);
    this.readStatus = options.readStatus ?? (() => readWindowsHostLifecycleStatus());
    this.requestStop = options.requestStop ?? (() => requestWindowsHostStop());
    this.launch = options.launch ?? (() => launchVisibleHost(options.nodePath, options.cliPath));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  }

  async install(startNow: boolean): Promise<UserServiceStatus> {
    await mkdir(dirname(this.options.setupPath), { recursive: true });
    await writeFile(this.options.setupPath, "Alu Dock Windows foreground Host\n", "utf8");
    if (!startNow) return this.status();
    const current = await this.readStatus();
    if (current) await this.stopRunning();
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
    if (previous) await this.stopRunning();
    await this.launch();
    await this.waitForReady(previous?.hostEpoch);
    return this.status();
  }

  async stop(): Promise<UserServiceStatus> {
    await this.requireInstalled();
    await this.stopRunning();
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
      linger: "unknown",
      diagnostics,
    };
  }

  logs(_lines: number, _follow: boolean): ServiceCommandResult {
    process.stdout.write("Alu Dock logs are shown in the Windows Host window.\n");
    return { status: 0, stdout: "", stderr: "" };
  }

  async uninstall(): Promise<{ unit: string; unitFile: string; removed: boolean }> {
    if (await this.readStatus()) await this.stopRunning();
    const removed = await fileExists(this.options.setupPath);
    await rm(this.options.setupPath, { force: true });
    return { unit: WINDOWS_HOST_NAME, unitFile: this.options.setupPath, removed };
  }

  private async requireInstalled(): Promise<void> {
    if (!await fileExists(this.options.cliPath) || !await fileExists(this.options.setupPath)) throw new Error("Alu Dock is not installed for this user. Run `npm run install:local` from the checkout first.");
  }

  private async stopRunning(): Promise<void> {
    const current = await this.readStatus();
    if (!current) return;
    await this.requestStop();
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (!await this.readStatus()) return;
      await this.sleep(READY_POLL_MS);
    }
    throw new Error("Alu Dock did not stop. Return to the Windows Host window, press Ctrl+C, then try again.");
  }

  private async waitForReady(previousEpoch?: string): Promise<WindowsHostLifecycleStatus> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readStatus();
      if (current?.ready && (previousEpoch === undefined || current.hostEpoch !== previousEpoch)) return current;
      await this.sleep(READY_POLL_MS);
    }
    throw new Error("Alu Dock did not become ready. Review the Windows Host window, then try again.");
  }
}

async function launchVisibleHost(nodePath: string, cliPath: string): Promise<void> {
  const hostScript = [
    "$Host.UI.RawUI.WindowTitle = 'Alu Dock Host'",
    `& '${powerShellLiteral(nodePath)}' '${powerShellLiteral(cliPath)}' host`,
    "if ($LASTEXITCODE -ne 0) { Write-Host ''; Read-Host 'Alu Dock stopped with an error. Press Enter to close this window' }",
  ].join("\r\n");
  const hostCommand = Buffer.from(hostScript, "utf16le").toString("base64");
  const launchScript = `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${hostCommand}') | Out-Null`;
  const launchCommand = Buffer.from(launchScript, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", launchCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Alu Dock could not open the Windows Host window: ${(result.stderr || result.stdout).slice(-2_000)}`);
}

function powerShellLiteral(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("Windows Host path is invalid");
  return value.replaceAll("'", "''");
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
