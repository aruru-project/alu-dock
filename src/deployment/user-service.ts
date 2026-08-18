import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { ControlClientError, DockClient } from "../control/dock-client.js";
import type { PingResult } from "../control/protocol.js";
import {
  ALU_DOCK_UNIT_NAME,
  isAluDockGeneratedContent,
  localInstallLayout,
  renderAluDockUnit,
} from "./local-install.js";

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const MANAGED_HOST_CAPABILITIES = ["catalog.maintenance.v1", "catalog.v1", "service.managed.v1", "session.reopen", "session.tree.v2"] as const;

export interface ServiceCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ServiceCommandOptions {
  inherit?: boolean;
  allowFailure?: boolean;
}

export type ServiceCommandRunner = (
  executable: string,
  args: string[],
  options?: ServiceCommandOptions,
) => ServiceCommandResult;

export interface UserServiceStatus {
  unit: string;
  unitFile: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  mainPid: number;
  ready: boolean;
  hostEpoch?: string;
  linger: "yes" | "no" | "unknown";
  diagnostics: string[];
}

export interface UserServiceManagerOptions {
  nodePath: string;
  cliPath: string;
  socketPath: string;
  home?: string;
  timeoutMs?: number;
  run?: ServiceCommandRunner;
  probe?: () => Promise<PingResult>;
  sleep?: (ms: number) => Promise<void>;
}

/** Explicit systemd --user lifecycle; ordinary client entry points never call it. */
export class UserServiceManager {
  readonly unitFile: string;
  private readonly timeoutMs: number;
  private readonly run: ServiceCommandRunner;
  private readonly probe: () => Promise<PingResult>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: UserServiceManagerOptions) {
    const home = resolve(options.home ?? homedir());
    this.unitFile = localInstallLayout(home).unitFile;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? READY_TIMEOUT_MS);
    this.run = options.run ?? runCommand;
    this.probe = options.probe ?? (() => new DockClient({ socketPath: options.socketPath, timeoutMs: 500 }).ping());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  }

  async install(startNow: boolean): Promise<UserServiceStatus> {
    const previous = startNow ? await this.tryProbe() : undefined;
    await this.writeUnit();
    this.systemctl(["daemon-reload"]);
    this.systemctl(["enable", ALU_DOCK_UNIT_NAME]);
    if (startNow) {
      if (this.unitProperties().ActiveState === "active") {
        this.systemctl(["restart", ALU_DOCK_UNIT_NAME]);
        await this.waitForReady(previous?.hostEpoch);
      } else {
        this.systemctl(["start", ALU_DOCK_UNIT_NAME]);
        await this.waitForReady();
      }
    }
    return this.status();
  }

  async start(): Promise<UserServiceStatus> {
    await this.requireGeneratedUnit();
    this.systemctl(["start", ALU_DOCK_UNIT_NAME]);
    await this.waitForReady();
    return this.status();
  }

  async restart(): Promise<UserServiceStatus> {
    await this.requireGeneratedUnit();
    const previous = await this.tryProbe();
    this.systemctl(["restart", ALU_DOCK_UNIT_NAME]);
    await this.waitForReady(previous?.hostEpoch);
    return this.status();
  }

  async stop(): Promise<UserServiceStatus> {
    await this.requireGeneratedUnit();
    this.systemctl(["stop", ALU_DOCK_UNIT_NAME]);
    return this.status();
  }

  async uninstall(): Promise<{ unit: string; unitFile: string; removed: boolean }> {
    const info = await lstatIfPresent(this.unitFile);
    if (!info) {
      this.systemctl(["daemon-reload"]);
      return { unit: ALU_DOCK_UNIT_NAME, unitFile: this.unitFile, removed: false };
    }
    await this.requireGeneratedUnit();
    this.systemctl(["disable", "--now", ALU_DOCK_UNIT_NAME], true);
    await rm(this.unitFile);
    this.systemctl(["daemon-reload"]);
    return { unit: ALU_DOCK_UNIT_NAME, unitFile: this.unitFile, removed: true };
  }

  async status(): Promise<UserServiceStatus> {
    const properties = this.unitProperties();
    const mainPid = positivePid(properties.MainPID);
    const ping = await this.tryProbe();
    const ready = ping !== undefined && mainPid > 0 && ping.pid === mainPid && hasManagedHostCapabilities(ping);
    const diagnostics: string[] = [];
    if (properties.ActiveState === "active" && !ready) diagnostics.push("Unit is active but Protocol V2 hello/MainPID readiness is not established");
    if (properties.ActiveState !== "active") diagnostics.push(`Unit is ${properties.ActiveState || "unknown"}/${properties.SubState || "unknown"}`);
    const linger = this.lingerState();
    if (linger !== "yes") diagnostics.push("User linger is not enabled; Alu Dock does not modify login policy automatically");
    return {
      unit: ALU_DOCK_UNIT_NAME,
      unitFile: this.unitFile,
      activeState: properties.ActiveState || "unknown",
      subState: properties.SubState || "unknown",
      unitFileState: properties.UnitFileState || "unknown",
      mainPid,
      ready,
      ...(ping === undefined ? {} : { hostEpoch: ping.hostEpoch }),
      linger,
      diagnostics,
    };
  }

  logs(lines: number, follow: boolean): ServiceCommandResult {
    const boundedLines = Number.isSafeInteger(lines) && lines >= 1 && lines <= 10_000 ? lines : 200;
    return this.run("journalctl", [
      "--user", "-u", ALU_DOCK_UNIT_NAME, "-n", String(boundedLines), "--no-pager",
      ...(follow ? ["--follow"] : []),
    ], { inherit: true, allowFailure: true });
  }

  private async requireGeneratedUnit(): Promise<void> {
    const info = await lstatIfPresent(this.unitFile);
    if (!info) throw new Error(`Alu Dock service is not installed: ${this.unitFile}`);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to manage non-regular unit file: ${this.unitFile}`);
    const existing = await readFile(this.unitFile, "utf8");
    if (!isAluDockGeneratedContent(existing)) throw new Error(`Refusing to manage non-generated unit file: ${this.unitFile}`);
  }

  private async writeUnit(): Promise<void> {
    await mkdir(dirname(this.unitFile), { recursive: true, mode: 0o755 });
    const existingInfo = await lstatIfPresent(this.unitFile);
    if (existingInfo) {
      if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) throw new Error(`Refusing to overwrite non-regular unit file: ${this.unitFile}`);
      const existing = await readFile(this.unitFile, "utf8");
      if (!isAluDockGeneratedContent(existing)) throw new Error(`Refusing to overwrite non-generated unit file: ${this.unitFile}`);
    }
    const content = renderAluDockUnit({
      nodePath: resolve(this.options.nodePath),
      cliPath: resolve(this.options.cliPath),
      homePath: resolve(this.options.home ?? homedir()),
    });
    const temporary = `${this.unitFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
      await chmod(temporary, 0o644);
      await rename(temporary, this.unitFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async waitForReady(previousEpoch?: string): Promise<PingResult> {
    const deadline = Date.now() + this.timeoutMs;
    let last = "Protocol V2 hello unavailable";
    while (Date.now() < deadline) {
      const ping = await this.tryProbe();
      const mainPid = positivePid(this.unitProperties().MainPID);
      if (!ping) last = "Protocol V2 hello unavailable";
      else if (mainPid !== ping.pid) last = `hello PID ${ping.pid} does not match unit MainPID ${mainPid}`;
      else if (!hasManagedHostCapabilities(ping)) last = "Host does not advertise the complete managed catalog/reopen capability set";
      else if (previousEpoch !== undefined && ping.hostEpoch === previousEpoch) last = "hostEpoch did not change after restart";
      else return ping;
      await this.sleep(READY_POLL_MS);
    }
    const journal = this.run("journalctl", ["--user", "-u", ALU_DOCK_UNIT_NAME, "-n", "80", "--no-pager"], { allowFailure: true });
    throw new Error(`Alu Dock service did not become ready within ${this.timeoutMs}ms: ${last}; journal: ${(journal.stdout || journal.stderr).slice(-4_000)}`);
  }

  private async tryProbe(): Promise<PingResult | undefined> {
    try { return await this.probe(); }
    catch (error) {
      if (error instanceof ControlClientError && ["connection_error", "connection_closed", "timeout", "host_starting"].includes(error.code)) return undefined;
      throw error;
    }
  }

  private unitProperties(): Record<string, string> {
    const result = this.run("systemctl", [
      "--user", "show", ALU_DOCK_UNIT_NAME,
      "--property=ActiveState,SubState,MainPID,UnitFileState",
    ], { allowFailure: true });
    const properties: Record<string, string> = {};
    for (const line of result.stdout.split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return properties;
  }

  private lingerState(): "yes" | "no" | "unknown" {
    const getuid = process.getuid;
    if (typeof getuid !== "function") return "unknown";
    const result = this.run("loginctl", ["show-user", String(getuid()), "--property=Linger", "--value"], { allowFailure: true });
    const value = result.stdout.trim();
    return value === "yes" ? "yes" : value === "no" ? "no" : "unknown";
  }

  private systemctl(args: string[], allowFailure = false): ServiceCommandResult {
    const result = this.run("systemctl", ["--user", ...args], { allowFailure });
    if (result.status !== 0 && !allowFailure) throw new Error(`systemctl --user ${args.join(" ")} failed: ${(result.stderr || result.stdout).slice(-4_000)}`);
    return result;
  }
}

function runCommand(executable: string, args: string[], options: ServiceCommandOptions = {}): ServiceCommandResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status !== 0 && !options.allowFailure) throw new Error(`${executable} ${args.join(" ")} failed (${status}): ${(stderr || stdout).slice(-4_000)}`);
  return { status, stdout, stderr };
}

function hasManagedHostCapabilities(ping: PingResult): boolean {
  const capabilities = new Set(ping.capabilities);
  return MANAGED_HOST_CAPABILITIES.every((capability) => capabilities.has(capability));
}

function positivePid(value: string | undefined): number {
  const pid = Number(value ?? "");
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
