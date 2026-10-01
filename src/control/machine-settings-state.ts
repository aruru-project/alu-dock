import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { hardenWindowsPrivatePath, replaceStateFile, syncPrivateDirectory } from "../platform/private-state.js";

const SETTINGS_SCHEMA = 1 as const;
const MAX_SETTINGS_BYTES = 64 * 1024;
const SUBHOST_STATUS_RECONCILE_INTERVAL_MS = 1_000;
const MAX_DIAGNOSTIC_FIELD_CHARS = 64;
export const DEFAULT_MACHINE_PORT = 43_127;

export type MachineSettingsWritePhase = "replace";

export interface MachineSettingsStateOptions {
  fault?: (phase: MachineSettingsWritePhase, path: string) => void | Promise<void>;
}

export interface MachineEndpoint {
  mainAddress: string;
  port: number;
}

export interface SubHostConnectionSettings extends MachineEndpoint {
  name: string;
}

interface StoredMachineSettings {
  schemaVersion: 1;
  revision: number;
  roleOverride?: "subhost";
  main: { connectionsEnabled: boolean; port: number; name: string; advertisedAddress?: string };
  subhost?: SubHostConnectionSettings;
}

export interface MachineSettings extends StoredMachineSettings {
  role: "main" | "subhost";
}

export interface MachineListenerConfiguration {
  configRevision: number;
  connectionsEnabled: boolean;
  port: number;
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

export interface MachineListenerStatus extends MachineListenerConfiguration {
  schemaVersion: 1;
  state: "disabled" | "listening" | "error";
}

export function machineListenerConfiguration(settings: MachineSettings): MachineListenerConfiguration {
  return {
    configRevision: settings.revision,
    connectionsEnabled: settings.main.connectionsEnabled,
    port: settings.main.port,
  };
}

export function sameMachineListenerConfiguration(
  left: MachineListenerConfiguration | undefined,
  right: MachineListenerConfiguration,
): boolean {
  return left?.configRevision === right.configRevision
    && left.connectionsEnabled === right.connectionsEnabled
    && left.port === right.port;
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
  private readonly root: string;
  private windowsRootIdentity: string | undefined;
  private windowsRootPreparationTail = Promise.resolve();
  private readonly hardenedFiles = new Map<string, string>();
  private subHostStatusTail = Promise.resolve();

  constructor(stateRoot: string, private readonly options: MachineSettingsStateOptions = {}) {
    this.root = resolve(stateRoot);
    this.filePath = join(this.root, "machine-settings.json");
    this.listenerStatusPath = join(this.root, "main-listener-status.json");
    this.subHostStatusPath = join(this.root, "subhost-status.json");
  }

  async read(): Promise<MachineSettings> {
    const stored = await this.readStored();
    return { ...stored, role: stored.roleOverride === "subhost" ? "subhost" : "main" };
  }

  async writeMainConnections(input: { enabled: boolean; port: number; name?: string }): Promise<MachineSettings> {
    return this.mutateStored((current) => {
      return {
        ...current,
        revision: current.revision + 1,
        main: {
          ...current.main,
          connectionsEnabled: input.enabled,
          port: checkedPort(input.port),
          name: checkedName(input.name ?? current.main.name),
        },
      };
    });
  }

  async writeMainAdvertisedAddress(address: string): Promise<MachineSettings> {
    return this.mutateStored((current) => ({
      ...current,
      revision: current.revision + 1,
      main: { ...current.main, advertisedAddress: checkedAddress(address) },
    }));
  }

  async switchToSubHost(input: SubHostConnectionSettings): Promise<MachineSettings> {
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
      const info = await this.prepareExistingFile(this.listenerStatusPath);
      if (!info) return undefined;
      if (info.size > BigInt(MAX_SETTINGS_BYTES)) throw new Error("Machine listener status is invalid");
      return parseMachineListenerStatus(JSON.parse(await readFile(this.listenerStatusPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new Error("Machine listener status is not valid JSON");
      throw error;
    }
  }

  async writeMainListenerStatus(status: MachineListenerStatus): Promise<void> {
    await this.writeAtomicJson(this.listenerStatusPath, parseMachineListenerStatus(status));
  }

  async writeSubHostStatus(input: { hostEpoch: string; connected: boolean }): Promise<void> {
    const hostEpoch = checkedText(input.hostEpoch, "SubHost process identity", 128);
    await this.serializeSubHostStatus(async () => {
      const status: StoredSubHostStatus = {
        schemaVersion: 1,
        hostEpoch,
        pid: process.pid,
        connected: input.connected,
        updatedAt: new Date().toISOString(),
      };
      await this.writeAtomicJson(this.subHostStatusPath, status);
    });
  }

  async clearSubHostStatus(hostEpoch: string): Promise<void> {
    const expectedEpoch = checkedText(hostEpoch, "SubHost process identity", 128);
    await this.serializeSubHostStatus(async () => {
      try {
        const info = await this.prepareExistingFile(this.subHostStatusPath);
        if (!info) return;
        if (info.size > BigInt(MAX_SETTINGS_BYTES)) throw new Error("SubHost status is invalid");
        const status = parseSubHostStatus(JSON.parse(await readFile(this.subHostStatusPath, "utf8")) as unknown);
        if (status.hostEpoch === expectedEpoch) {
          await rm(this.subHostStatusPath, { force: true });
          this.hardenedFiles.delete(this.subHostStatusPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  async readSubHostStatus(): Promise<SubHostStatus> {
    try {
      const info = await this.prepareExistingFile(this.subHostStatusPath);
      if (!info) return { connected: false };
      if (info.size > BigInt(MAX_SETTINGS_BYTES)) throw new Error("SubHost status is invalid");
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
    const next = parseSettings(update(await this.readStored()));
    await this.writeAtomicJson(this.filePath, next);
    return { ...next, role: next.roleOverride === "subhost" ? "subhost" : "main" };
  }

  private async readStored(): Promise<StoredMachineSettings> {
    try {
      const info = await this.prepareExistingFile(this.filePath);
      if (!info) {
        return {
          schemaVersion: SETTINGS_SCHEMA,
          revision: 0,
          main: { connectionsEnabled: false, port: DEFAULT_MACHINE_PORT, name: "Main" },
        };
      }
      if (info.size > BigInt(MAX_SETTINGS_BYTES)) throw new Error("Machine settings are invalid");
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

  private serializeSubHostStatus<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.subHostStatusTail.then(operation);
    this.subHostStatusTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async preparePrivateRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const observed = await lstat(this.root, { bigint: true });
    assertPrivateRoot(observed);
    if (process.platform !== "win32") {
      if ((observed.mode & 0o777n) !== 0o700n) await chmod(this.root, 0o700);
      return;
    }

    const observedIdentity = filesystemIdentity(observed);
    if (observedIdentity === this.windowsRootIdentity) return;
    const preparation = this.windowsRootPreparationTail.then(async () => {
      const current = await lstat(this.root, { bigint: true });
      assertPrivateRoot(current);
      const currentIdentity = filesystemIdentity(current);
      if (currentIdentity === this.windowsRootIdentity) return;
      this.windowsRootIdentity = undefined;
      this.hardenedFiles.clear();
      await hardenWindowsPrivatePath(this.root, true);
      const hardened = await lstat(this.root, { bigint: true });
      assertPrivateRoot(hardened);
      if (filesystemIdentity(hardened) !== currentIdentity) {
        throw new Error("Machine settings directory changed while Alu Dock was protecting it");
      }
      this.windowsRootIdentity = currentIdentity;
    });
    this.windowsRootPreparationTail = preparation.then(() => undefined, () => undefined);
    await preparation;
  }

  private async prepareExistingFile(path: string): Promise<BigIntStats | undefined> {
    await this.preparePrivateRoot();
    let info: BigIntStats;
    try { info = await lstat(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    assertMachineStateFile(info);
    if (process.platform === "win32") {
      const identity = filesystemIdentity(info);
      if (this.hardenedFiles.get(path) !== identity) {
        await hardenWindowsPrivatePath(path, false);
        const hardened = await lstat(path, { bigint: true });
        assertMachineStateFile(hardened);
        if (filesystemIdentity(hardened) !== identity) {
          this.hardenedFiles.delete(path);
          throw new Error("Machine state file changed while Alu Dock was protecting it");
        }
        this.hardenedFiles.set(path, identity);
        info = hardened;
      }
    }
    return info;
  }

  private async writeAtomicJson(path: string, value: unknown): Promise<void> {
    await this.prepareExistingFile(path);
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_SETTINGS_BYTES) throw new Error("Machine settings are too large");
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: string | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      const temporaryInfo = await handle.stat({ bigint: true });
      assertMachineStateFile(temporaryInfo);
      temporaryIdentity = filesystemIdentity(temporaryInfo);
      await handle.close(); handle = undefined;
      await this.replaceAtomicFile(temporary, path);
      // The temporary is created only after the parent has a private inheritable
      // DACL. Cache that known object after rename; a destination stat could
      // already be observing an external replacement.
      if (process.platform === "win32") {
        if (temporaryIdentity === undefined) throw new Error("Machine state temporary file identity is missing");
        this.hardenedFiles.set(path, temporaryIdentity);
      }
      await syncPrivateDirectory(this.root);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async replaceAtomicFile(temporary: string, path: string): Promise<void> {
    try {
      await replaceStateFile(temporary, path, () => this.options.fault?.("replace", path));
    } catch (error) {
      throw new Error(`Alu Dock could not replace its machine state at ${path}. Check that the directory is writable and no program is locking the file, then try again.`, { cause: error });
    }
  }
}

function assertPrivateRoot(info: BigIntStats): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Machine settings directory is invalid");
}

function assertMachineStateFile(info: { isFile(): boolean; isSymbolicLink(): boolean }): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Machine state file is invalid");
}

function filesystemIdentity(info: { dev: bigint; ino: bigint }): string {
  return `${info.dev}:${info.ino}`;
}

/** Bounded detail for the known machine-state wrapper; unrelated CLI errors stay unchanged. */
export function machineStatePersistenceDiagnostic(error: unknown): string {
  const message = diagnosticText(error instanceof Error ? error.message : String(error));
  if (!(error instanceof Error) || error.cause === undefined) return message;
  const cause = error.cause;
  const record = cause !== null && typeof cause === "object" ? cause as Record<string, unknown> : undefined;
  const code = typeof record?.code === "string" ? diagnosticText(record.code, MAX_DIAGNOSTIC_FIELD_CHARS) : undefined;
  const syscall = typeof record?.syscall === "string" ? diagnosticText(record.syscall, MAX_DIAGNOSTIC_FIELD_CHARS) : undefined;
  const reason = cause instanceof Error ? diagnosticText(cause.message) : typeof cause === "string" ? diagnosticText(cause) : undefined;
  const details = [code, syscall, reason].filter((part): part is string => Boolean(part));
  return details.length > 0 ? `${message} Cause: ${details.join(" · ")}` : message;
}

function diagnosticText(value: string, maximum = 500): string {
  const oneLine = value.replace(/[\r\n\t]+/gu, " ").trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 1)}…`;
}

/** Best-effort observational cache; transport and Workers never wait for it. */
export class SubHostStatusReporter {
  private desired: boolean | undefined;
  private persisted: boolean | undefined;
  private inFlight: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private failureReported = false;

  constructor(private readonly options: {
    state: MachineSettingsState;
    hostEpoch: string;
    onError: (error: unknown) => void;
  }) {}

  update(connected: boolean): void {
    if (this.stopped) return;
    const changed = connected !== this.desired;
    this.desired = connected;
    if (changed && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.retryTimer) this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.inFlight?.catch(() => {});
  }

  private flush(): void {
    if (this.stopped || this.inFlight || this.desired === undefined || this.desired === this.persisted) return;
    const target = this.desired;
    const attempt = this.options.state.writeSubHostStatus({ hostEpoch: this.options.hostEpoch, connected: target });
    this.inFlight = attempt;
    void attempt.then(() => {
      this.persisted = target;
      this.failureReported = false;
    }, (error) => {
      this.persisted = undefined;
      if (!this.failureReported) {
        this.failureReported = true;
        try { this.options.onError(error); } catch {}
      }
      this.scheduleRetry();
    }).finally(() => {
      if (this.inFlight === attempt) this.inFlight = undefined;
      if (!this.retryTimer) this.flush();
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.flush();
    }, SUBHOST_STATUS_RECONCILE_INTERVAL_MS);
    this.retryTimer.unref?.();
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
  exact(main, ["connectionsEnabled", "port", "name", "advertisedAddress"]);
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
      ...(main.advertisedAddress === undefined ? {} : { advertisedAddress: checkedAddress(main.advertisedAddress) }),
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
  exact(value, ["schemaVersion", "configRevision", "connectionsEnabled", "port", "state"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 0) throw new Error("Machine listener status is invalid");
  if (typeof value.connectionsEnabled !== "boolean") throw new Error("Machine listener status is invalid");
  if (!(["disabled", "listening", "error"] as const).includes(value.state as "disabled" | "listening" | "error")) throw new Error("Machine listener status is invalid");
  return {
    schemaVersion: 1,
    configRevision: value.configRevision as number,
    connectionsEnabled: value.connectionsEnabled,
    port: checkedPort(value.port),
    state: value.state as MachineListenerStatus["state"],
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

export function validateMachineEndpoint(mainAddress: unknown, port: unknown): MachineEndpoint {
  return { mainAddress: checkedAddress(mainAddress), port: checkedPort(port) };
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
