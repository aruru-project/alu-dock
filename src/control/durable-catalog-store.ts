import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 as win32Path } from "node:path";

import {
  CatalogCorruptError,
  MAX_CATALOG_LAST_ERROR_CHARS,
  type CatalogInstanceRecord,
  type CatalogMutationContext,
  type CatalogProjection,
  type CatalogStore,
  validateCatalogProjection,
} from "../core/catalog.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../core/agent-worker.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import { hardenWindowsPrivatePath, noFollowFlag, syncPrivateDirectory } from "../platform/private-state.js";

export const MAX_DURABLE_CATALOG_BYTES = 16 * 1024 * 1024;

export type CatalogWritePhase = "temp_write" | "file_sync" | "rename" | "directory_sync";

export interface FileCatalogStoreOptions {
  fault?: (phase: CatalogWritePhase) => void | Promise<void>;
}

/** Durable single-writer catalog using same-directory fsync + rename commits. */
export class FileCatalogStore implements CatalogStore {
  readonly path: string;
  private readonly directory: string;
  private directoryHardening: Promise<void> | undefined;
  private catalogFileHardened = false;

  constructor(path: string, private readonly options: FileCatalogStoreOptions = {}) {
    this.path = resolve(path);
    this.directory = dirname(this.path);
  }

  async load(): Promise<CatalogProjection | undefined> {
    await this.ensurePrivateStateDirectory();
    const info = await lstatIfPresent(this.path);
    if (!info) return undefined;
    assertPrivateCatalogFile(this.path, info);
    if (!this.catalogFileHardened) {
      await hardenWindowsPrivatePath(this.path, false);
      this.catalogFileHardened = true;
    }
    if (info.size > MAX_DURABLE_CATALOG_BYTES) throw new CatalogCorruptError(this.path, "file exceeds the 16 MiB limit");

    let raw: unknown;
    try {
      const handle = await open(this.path, constants.O_RDONLY | noFollowFlag());
      try {
        const openedInfo = await handle.stat();
        assertPrivateCatalogFile(this.path, openedInfo);
        if (openedInfo.size > MAX_DURABLE_CATALOG_BYTES) throw new CatalogCorruptError(this.path, "file exceeds the 16 MiB limit");
        const bytes = await handle.readFile();
        if (bytes.byteLength > MAX_DURABLE_CATALOG_BYTES) throw new CatalogCorruptError(this.path, "file exceeds the 16 MiB limit");
        raw = JSON.parse(bytes.toString("utf8")) as unknown;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof CatalogCorruptError) throw error;
      throw new CatalogCorruptError(this.path, "file is not valid JSON", error);
    }
    try {
      const projection = parseCatalogProjection(raw);
      validateCatalogProjection(projection);
      return projection;
    } catch (error) {
      if (error instanceof CatalogCorruptError) throw error;
      throw new CatalogCorruptError(this.path, error instanceof Error ? error.message : String(error), error);
    }
  }

  async commit(candidate: Readonly<CatalogProjection>, _context: Readonly<CatalogMutationContext>): Promise<void> {
    validateCatalogProjection(candidate as CatalogProjection);
    await this.ensurePrivateStateDirectory();
    const existing = await lstatIfPresent(this.path);
    if (existing) assertPrivateCatalogFile(this.path, existing);

    const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > MAX_DURABLE_CATALOG_BYTES) throw new Error("Catalog candidate exceeds the 16 MiB limit");
    const temporary = join(this.directory, `.catalog.json.tmp-${process.pid}-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await this.options.fault?.("temp_write");
      await handle.writeFile(bytes, "utf8");
      await chmod(temporary, 0o600);
      await this.options.fault?.("file_sync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.options.fault?.("rename");
      await rename(temporary, this.path);
      // The temp file is created only after the parent has its private inheritable
      // DACL, and the rename stays within that directory. Re-running icacls for
      // every old/new catalog file made each durable transition spawn two extra
      // processes without strengthening the boundary.
      this.catalogFileHardened = true;
      await syncPrivateDirectory(this.directory, () => this.options.fault?.("directory_sync"));
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async ensurePrivateStateDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Catalog state path is not a real directory: ${this.directory}`);
    const canonical = await realpath(this.directory);
    if (relative(canonical, resolve(this.directory)) !== "") throw new Error(`Catalog state path traverses a symbolic link: ${this.directory}`);
    if (process.platform === "win32") {
      this.directoryHardening ??= hardenWindowsPrivatePath(this.directory, true);
      try { await this.directoryHardening; }
      catch (error) { this.directoryHardening = undefined; throw error; }
    }
    assertOwnedByCurrentUser(this.directory, info);
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) throw new Error(`Catalog state directory must have mode 0700: ${this.directory}`);
  }
}

export function defaultCatalogPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localData = env.LOCALAPPDATA && win32Path.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32Path.join(home, "AppData", "Local");
    return win32Path.join(localData, "Alu Dock", "catalog.json");
  }
  const stateDirectory = singleAbsoluteEnvironmentPath(env.STATE_DIRECTORY, "STATE_DIRECTORY");
  if (stateDirectory) return join(stateDirectory, "catalog.json");
  const stateHome = env.XDG_STATE_HOME
    ? singleAbsoluteEnvironmentPath(env.XDG_STATE_HOME, "XDG_STATE_HOME")
    : join(resolve(home), ".local", "state");
  return join(stateHome as string, "alu-dock", "catalog.json");
}

export function parseCatalogProjection(input: unknown): CatalogProjection {
  const value = object(input, "catalog");
  exact(value, ["schemaVersion", "revision", "lastHostEpoch", "instances"], "catalog");
  if (value.schemaVersion !== 1) throw new Error("Catalog schemaVersion must be exactly 1");
  const instances = array(value.instances, "catalog.instances", 10_000).map((item, index) => parseCatalogRecord(item, `catalog.instances[${index}]`));
  return {
    schemaVersion: 1,
    revision: unsigned(value.revision, "catalog.revision"),
    lastHostEpoch: text(value.lastHostEpoch, "catalog.lastHostEpoch", 128),
    instances,
  };
}

function parseCatalogRecord(input: unknown, field: string): CatalogInstanceRecord {
  const value = object(input, field);
  exact(value, [
    "id", "creationOperationId", "key", "name", "cwd", "lifecycle", "execution", "lastRun",
    "observationGrant", "dockToolsEnabled", "workerConfig", "executionChangedAt", "runStartedAt", "runtimeGeneration", "ownerHostEpoch", "piSessionId", "sessionFile", "model",
    "thinkingLevel", "activeCommandId", "admissionPending", "admissionOperationId",
    "pendingCount", "replacement", "recoverySessionFile", "lastKnown", "interruption",
    "stopRequestedAt", "shutdownRequestedAt", "ownerReleaseUnconfirmed", "lastError", "createdAt", "updatedAt",
  ], field);
  const modelValue = value.model === undefined ? undefined : object(value.model, `${field}.model`);
  if (modelValue) exact(modelValue, ["provider", "id"], `${field}.model`);
  const replacementValue = value.replacement === undefined ? undefined : object(value.replacement, `${field}.replacement`);
  if (replacementValue) exact(replacementValue, ["operationId", "kind", "previousSessionFile", "requestedSessionFile", "requestedEntryId", "startedAt"], `${field}.replacement`);
  const lastKnownValue = value.lastKnown === undefined ? undefined : object(value.lastKnown, `${field}.lastKnown`);
  if (lastKnownValue) exact(lastKnownValue, ["lifecycle", "execution", "activeCommandId", "pendingCount"], `${field}.lastKnown`);
  const interruptionValue = value.interruption === undefined ? undefined : object(value.interruption, `${field}.interruption`);
  if (interruptionValue) exact(interruptionValue, ["reason", "at"], `${field}.interruption`);

  const record: CatalogInstanceRecord = {
    id: text(value.id, `${field}.id`, 128),
    creationOperationId: text(value.creationOperationId, `${field}.creationOperationId`, 128),
    ...(value.key === undefined ? {} : { key: text(value.key, `${field}.key`, 128) }),
    ...(value.name === undefined ? {} : { name: text(value.name, `${field}.name`, 256) }),
    cwd: text(value.cwd, `${field}.cwd`, 16_384),
    lifecycle: enumeration(value.lifecycle, `${field}.lifecycle`, ["active", "stopping", "stopped", "host_lost", "runtime_error"]),
    execution: enumeration(value.execution, `${field}.execution`, ["idle", "running", "failed", "unavailable"]),
    lastRun: enumeration(value.lastRun, `${field}.lastRun`, ["never", "succeeded", "failed", "aborted", "interrupted"]),
    // The old read-only observation grant intentionally resets off when the broader Dock tools switch first appears.
    dockToolsEnabled: value.dockToolsEnabled === undefined ? false : boolean(value.dockToolsEnabled, `${field}.dockToolsEnabled`),
    ...(value.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(value.workerConfig, `${field}.workerConfig`) }),
    executionChangedAt: value.executionChangedAt === undefined
      ? timestamp(value.createdAt, `${field}.createdAt`)
      : timestamp(value.executionChangedAt, `${field}.executionChangedAt`),
    ...(value.runStartedAt === undefined
      ? (value.execution === "running" ? { runStartedAt: timestamp(value.createdAt, `${field}.createdAt`) } : {})
      : { runStartedAt: timestamp(value.runStartedAt, `${field}.runStartedAt`) }),
    runtimeGeneration: positive(value.runtimeGeneration, `${field}.runtimeGeneration`),
    ...(value.ownerHostEpoch === undefined ? {} : { ownerHostEpoch: text(value.ownerHostEpoch, `${field}.ownerHostEpoch`, 128) }),
    piSessionId: text(value.piSessionId, `${field}.piSessionId`, 128),
    ...(value.sessionFile === undefined ? {} : { sessionFile: text(value.sessionFile, `${field}.sessionFile`, 16_384) }),
    ...(modelValue === undefined ? {} : { model: { provider: text(modelValue.provider, `${field}.model.provider`, 256), id: text(modelValue.id, `${field}.model.id`, 512) } }),
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: enumeration(value.thinkingLevel, `${field}.thinkingLevel`, THINKING_LEVELS) as ThinkingLevel }),
    ...(value.activeCommandId === undefined ? {} : { activeCommandId: text(value.activeCommandId, `${field}.activeCommandId`, 128) }),
    admissionPending: boolean(value.admissionPending, `${field}.admissionPending`),
    ...(value.admissionOperationId === undefined ? {} : { admissionOperationId: text(value.admissionOperationId, `${field}.admissionOperationId`, 128) }),
    pendingCount: unsigned(value.pendingCount, `${field}.pendingCount`),
    ...(replacementValue === undefined ? {} : { replacement: {
      operationId: text(replacementValue.operationId, `${field}.replacement.operationId`, 128),
      kind: enumeration(replacementValue.kind, `${field}.replacement.kind`, ["new", "switch", "fork", "clone", "reload"]),
      ...(replacementValue.previousSessionFile === undefined ? {} : { previousSessionFile: text(replacementValue.previousSessionFile, `${field}.replacement.previousSessionFile`, 16_384) }),
      ...(replacementValue.requestedSessionFile === undefined ? {} : { requestedSessionFile: text(replacementValue.requestedSessionFile, `${field}.replacement.requestedSessionFile`, 16_384) }),
      ...(replacementValue.requestedEntryId === undefined ? {} : { requestedEntryId: text(replacementValue.requestedEntryId, `${field}.replacement.requestedEntryId`, 128) }),
      startedAt: timestamp(replacementValue.startedAt, `${field}.replacement.startedAt`),
    } }),
    ...(value.recoverySessionFile === undefined ? {} : { recoverySessionFile: text(value.recoverySessionFile, `${field}.recoverySessionFile`, 16_384) }),
    ...(lastKnownValue === undefined ? {} : { lastKnown: {
      lifecycle: enumeration(lastKnownValue.lifecycle, `${field}.lastKnown.lifecycle`, ["active", "stopping"]),
      execution: enumeration(lastKnownValue.execution, `${field}.lastKnown.execution`, ["idle", "running", "failed"]),
      ...(lastKnownValue.activeCommandId === undefined ? {} : { activeCommandId: text(lastKnownValue.activeCommandId, `${field}.lastKnown.activeCommandId`, 128) }),
      pendingCount: unsigned(lastKnownValue.pendingCount, `${field}.lastKnown.pendingCount`),
    } }),
    ...(interruptionValue === undefined ? {} : { interruption: {
      reason: enumeration(interruptionValue.reason, `${field}.interruption.reason`, ["host_crash", "host_shutdown", "replacement_failed"]),
      at: timestamp(interruptionValue.at, `${field}.interruption.at`),
    } }),
    ...(value.stopRequestedAt === undefined ? {} : { stopRequestedAt: timestamp(value.stopRequestedAt, `${field}.stopRequestedAt`) }),
    ...(value.shutdownRequestedAt === undefined ? {} : { shutdownRequestedAt: timestamp(value.shutdownRequestedAt, `${field}.shutdownRequestedAt`) }),
    ...(value.ownerReleaseUnconfirmed === undefined ? {} : {
      ownerReleaseUnconfirmed: true as const,
    }),
    ...(value.lastError === undefined ? {} : { lastError: contentText(value.lastError, `${field}.lastError`, MAX_CATALOG_LAST_ERROR_CHARS) }),
    createdAt: timestamp(value.createdAt, `${field}.createdAt`),
    updatedAt: timestamp(value.updatedAt, `${field}.updatedAt`),
  };
  if (value.ownerReleaseUnconfirmed !== undefined && boolean(value.ownerReleaseUnconfirmed, `${field}.ownerReleaseUnconfirmed`) !== true) {
    throw new Error(`${field}.ownerReleaseUnconfirmed must be true when present`);
  }
  return record;
}

function assertPrivateCatalogFile(path: string, info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new CatalogCorruptError(path, "catalog must be a regular non-symlink file");
  try { assertOwnedByCurrentUser(path, info); }
  catch (error) { throw new CatalogCorruptError(path, error instanceof Error ? error.message : String(error), error); }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) throw new CatalogCorruptError(path, "catalog file mode must be 0600");
}

function assertOwnedByCurrentUser(path: string, info: Stats): void {
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if (typeof getuid !== "function") throw new Error("Durable catalog requires a Unix user ID");
  if (info.uid !== getuid()) throw new Error(`Path is not owned by the current user: ${path}`);
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function singleAbsoluteEnvironmentPath(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes(":")) throw new Error(`${name} must contain exactly one path`);
  if (!isAbsolute(value) || /[\u0000\r\n]/u.test(value)) throw new Error(`${name} must be a safe absolute path`);
  return resolve(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function array(value: unknown, field: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${field} must be a bounded array`);
  return value;
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${field} must be a bounded terminal-safe string`);
  return value;
}

function contentText(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit) throw new Error(`${field} must be bounded non-empty text`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw new Error(`${field} must be canonical ISO-8601 UTC`);
  return result;
}

function unsigned(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

function positive(value: unknown, field: string): number {
  const result = unsigned(value, field);
  if (result < 1) throw new Error(`${field} must be positive`);
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function enumeration<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${field} has an invalid value`);
  return value as T[number];
}
