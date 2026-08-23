import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { hardenWindowsPrivatePath, syncPrivateDirectory } from "../platform/private-state.js";
import { claimMachineStateChange } from "./machine-state.js";

const SETTINGS_SCHEMA = 1 as const;
const MAX_SETTINGS_BYTES = 64 * 1024;
export const DEFAULT_MACHINE_PORT = 43_127;

interface StoredMachineSettings {
  schemaVersion: 1;
  revision: number;
  roleOverride?: "subhost";
  main: { connectionsEnabled: boolean; port: number; name: string };
  subhost?: { mainAddress: string; port: number; name: string };
}

export interface MachineSettings extends StoredMachineSettings {
  role: "main" | "subhost";
}

interface StoredSubHostStatus {
  schemaVersion: 1;
  hostEpoch: string;
  pid: number;
  connected: boolean;
  updatedAt: string;
}

export interface SubHostStatus {
  connected: boolean;
  processId?: number;
  hostEpoch?: string;
  updatedAt?: string;
}

export interface MachineListenerStatus {
  schemaVersion: 1;
  configRevision: number;
  state: "disabled" | "listening" | "error" | "stopped";
  activePort?: number;
  message?: string;
  updatedAt: string;
}

/** Saved settings select the next startup; a live process remains authoritative until then. */
export function currentMachineRole(settings: MachineSettings, status: SubHostStatus, mainAvailable: boolean): "main" | "subhost" {
  if (status.processId !== undefined) return "subhost";
  return settings.role === "subhost" && !mainAvailable ? "subhost" : "main";
}

export class MachineSettingsState {
  readonly filePath: string;
  readonly listenerStatusPath: string;
  readonly subHostStatusPath: string;
  private readonly changePath: string;

  constructor(stateRoot: string) {
    const root = resolve(stateRoot);
    this.filePath = join(root, "machine-settings.json");
    this.listenerStatusPath = join(root, "main-listener-status.json");
    this.subHostStatusPath = join(root, "subhost-status.json");
    this.changePath = join(root, ".machine-settings-changing");
  }

  async read(): Promise<MachineSettings> {
    const stored = await this.readStored();
    return { ...stored, role: stored.roleOverride === "subhost" ? "subhost" : "main" };
  }

  async writeMainConnections(input: { enabled: boolean; port: number; name?: string }, expectedRevision?: number): Promise<MachineSettings> {
    return this.mutateStored((current) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("Machine settings changed; review them and try again");
      return {
        ...current,
        revision: current.revision + 1,
        main: {
          connectionsEnabled: input.enabled,
          port: checkedPort(input.port),
          name: checkedName(input.name ?? current.main.name),
        },
      };
    });
  }

  async switchToSubHost(input: { mainAddress: string; port: number; name: string }): Promise<MachineSettings> {
    return this.mutateStored((current) => ({
      ...current,
      revision: current.revision + 1,
      roleOverride: "subhost",
      subhost: {
        mainAddress: checkedAddress(input.mainAddress),
        port: checkedPort(input.port),
        name: checkedName(input.name),
      },
    }));
  }

  async switchToMain(): Promise<MachineSettings> {
    return this.mutateStored((current) => {
      const next: StoredMachineSettings = { ...current, revision: current.revision + 1 };
      delete next.roleOverride;
      return next;
    });
  }

  async readMainListenerStatus(): Promise<MachineListenerStatus | undefined> {
    try {
      const info = await lstat(this.listenerStatusPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) throw new Error("Machine listener status is invalid");
      await hardenWindowsPrivatePath(this.listenerStatusPath, false);
      return parseMachineListenerStatus(JSON.parse(await readFile(this.listenerStatusPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new Error("Machine listener status is not valid JSON");
      throw error;
    }
  }

  async writeMainListenerStatus(status: MachineListenerStatus): Promise<void> {
    await writeAtomicJson(this.listenerStatusPath, parseMachineListenerStatus(status));
  }

  async writeSubHostStatus(input: { hostEpoch: string; connected: boolean }): Promise<void> {
    const status: StoredSubHostStatus = {
      schemaVersion: 1,
      hostEpoch: checkedText(input.hostEpoch, "SubHost process identity", 128),
      pid: process.pid,
      connected: input.connected,
      updatedAt: new Date().toISOString(),
    };
    await writeAtomicJson(this.subHostStatusPath, status);
  }

  async clearSubHostStatus(hostEpoch: string): Promise<void> {
    try {
      const status = parseSubHostStatus(JSON.parse(await readFile(this.subHostStatusPath, "utf8")) as unknown);
      if (status.hostEpoch === hostEpoch) await rm(this.subHostStatusPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async readSubHostStatus(): Promise<SubHostStatus> {
    try {
      const info = await lstat(this.subHostStatusPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) throw new Error("SubHost status is invalid");
      await hardenWindowsPrivatePath(this.subHostStatusPath, false);
      const status = parseSubHostStatus(JSON.parse(await readFile(this.subHostStatusPath, "utf8")) as unknown);
      return processAlive(status.pid)
        ? { connected: status.connected, processId: status.pid, hostEpoch: status.hostEpoch, updatedAt: status.updatedAt }
        : { connected: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connected: false };
      if (error instanceof SyntaxError) throw new Error("SubHost status is not valid JSON");
      throw error;
    }
  }

  private async mutateStored(update: (current: StoredMachineSettings) => StoredMachineSettings): Promise<MachineSettings> {
    const release = await claimMachineStateChange(this.changePath);
    try {
      const next = parseSettings(update(await this.readStored()));
      await writeAtomicJson(this.filePath, next);
      return { ...next, role: next.roleOverride === "subhost" ? "subhost" : "main" };
    } finally {
      await release();
    }
  }

  private async readStored(): Promise<StoredMachineSettings> {
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) throw new Error("Machine settings are invalid");
      await hardenWindowsPrivatePath(this.filePath, false);
      return parseSettings(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: SETTINGS_SCHEMA,
          revision: 0,
          main: { connectionsEnabled: false, port: DEFAULT_MACHINE_PORT, name: "Main" },
        };
      }
      if (error instanceof SyntaxError) throw new Error("Machine settings are not valid JSON");
      throw error;
    }
  }
}

export function machineSettingsStateRoot(catalogPath: string): string {
  return join(dirname(resolve(catalogPath)), "machines");
}

function parseSettings(input: unknown): StoredMachineSettings {
  const value = record(input, "Machine settings");
  exact(value, ["schemaVersion", "revision", "roleOverride", "main", "subhost"]);
  if (value.schemaVersion !== SETTINGS_SCHEMA || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error("Machine settings version is invalid");
  if (value.roleOverride !== undefined && value.roleOverride !== "subhost") throw new Error("Machine role setting is invalid");
  const main = record(value.main, "Main settings");
  exact(main, ["connectionsEnabled", "port", "name"]);
  if (typeof main.connectionsEnabled !== "boolean") throw new Error("Main connection setting is invalid");
  const subhost = value.subhost === undefined ? undefined : record(value.subhost, "SubHost settings");
  if (subhost) exact(subhost, ["mainAddress", "port", "name"]);
  if (value.roleOverride === "subhost" && !subhost) throw new Error("SubHost connection settings are missing");
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    ...(value.roleOverride === "subhost" ? { roleOverride: "subhost" as const } : {}),
    main: {
      connectionsEnabled: main.connectionsEnabled,
      port: checkedPort(main.port),
      name: checkedName(main.name),
    },
    ...(subhost === undefined ? {} : { subhost: {
      mainAddress: checkedAddress(subhost.mainAddress),
      port: checkedPort(subhost.port),
      name: checkedName(subhost.name),
    } }),
  };
}

function parseMachineListenerStatus(input: unknown): MachineListenerStatus {
  const value = record(input, "Machine listener status");
  exact(value, ["schemaVersion", "configRevision", "state", "activePort", "message", "updatedAt"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 0) throw new Error("Machine listener status is invalid");
  if (!(["disabled", "listening", "error", "stopped"] as const).includes(value.state as "disabled" | "listening" | "error" | "stopped")) throw new Error("Machine listener status is invalid");
  const updatedAt = checkedText(value.updatedAt, "Machine listener status time", 64);
  if (new Date(updatedAt).toISOString() !== updatedAt) throw new Error("Machine listener status time is invalid");
  return {
    schemaVersion: 1,
    configRevision: value.configRevision as number,
    state: value.state as MachineListenerStatus["state"],
    ...(value.activePort === undefined ? {} : { activePort: checkedPort(value.activePort) }),
    ...(value.message === undefined ? {} : { message: checkedText(value.message, "Machine listener status message", 2_048) }),
    updatedAt,
  };
}

function parseSubHostStatus(input: unknown): StoredSubHostStatus {
  const value = record(input, "SubHost status");
  exact(value, ["schemaVersion", "hostEpoch", "pid", "connected", "updatedAt"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.connected !== "boolean") throw new Error("SubHost status is invalid");
  const updatedAt = checkedText(value.updatedAt, "SubHost status time", 64);
  if (new Date(updatedAt).toISOString() !== updatedAt) throw new Error("SubHost status time is invalid");
  return {
    schemaVersion: 1,
    hostEpoch: checkedText(value.hostEpoch, "SubHost process identity", 128),
    pid: value.pid as number,
    connected: value.connected,
    updatedAt,
  };
}

function checkedPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) throw new Error("Machine port must be between 1 and 65535");
  return value as number;
}

function checkedName(value: unknown): string { return checkedText(value, "Machine name", 256); }
function checkedAddress(value: unknown): string { return checkedText(value, "Main address", 1_024); }
function checkedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${field} is invalid`);
  return value.trim();
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("Machine settings contain unknown fields");
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Machine settings directory is invalid");
  if (process.platform === "win32") await hardenWindowsPrivatePath(parent, true);
  else if ((parentInfo.mode & 0o777) !== 0o700) await chmod(parent, 0o700);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_SETTINGS_BYTES) throw new Error("Machine settings are too large");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
    await hardenWindowsPrivatePath(path, false);
    await syncPrivateDirectory(parent);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
