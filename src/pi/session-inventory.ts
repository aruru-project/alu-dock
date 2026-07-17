import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { SessionDto } from "../core/instance-dto.js";
import type { SessionInventory } from "../core/session-inventory.js";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_RECORDS = 100_000;
const HEADER_READ_BYTES = 64 * 1024;
const NAME_LINE_BYTES = 64 * 1024;
const NAME_SCAN_CHUNK_BYTES = 1024 * 1024;
const SCAN_CONCURRENCY = 4;
const SESSION_INFO_TOKEN = Buffer.from('"session_info"', "utf8");

interface SessionInventoryCacheRecord {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  name: string | null;
}

interface SessionInventoryCacheFile {
  schemaVersion: 1;
  sessionsRoot: string;
  records: SessionInventoryCacheRecord[];
}

export interface PiSessionInventoryOptions {
  sessionsRoot?: string;
  cachePath?: string;
}

/** Read persisted Pi session metadata without constructing an AgentSession/runtime. */
export function createPiSessionInventory(options: PiSessionInventoryOptions = {}): SessionInventory {
  const index = new PiSessionMetadataIndex(
    resolve(options.sessionsRoot ?? join(getAgentDir(), "sessions")),
    options.cachePath === undefined ? undefined : resolve(options.cachePath),
  );
  return { list: (cwd, scope) => index.list(cwd, scope) };
}

class PiSessionMetadataIndex {
  private records = new Map<string, SessionInventoryCacheRecord>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionsRoot: string,
    private readonly cachePath?: string,
  ) {}

  list(cwd: string, scope: "cwd" | "all"): Promise<SessionDto[]> {
    const task = this.queue.then(async () => this.listSerial(cwd, scope));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async listSerial(cwd: string, scope: "cwd" | "all"): Promise<SessionDto[]> {
    await this.loadCache();
    const canonicalCwd = await realpath(resolve(cwd));
    const scopeDirectory = scope === "cwd"
      ? join(this.sessionsRoot, defaultSessionDirectoryName(canonicalCwd))
      : undefined;
    const files = scopeDirectory === undefined
      ? await discoverAllSessionFiles(this.sessionsRoot)
      : await discoverSessionFiles(scopeDirectory);
    const discovered = new Set(files);
    let dirty = false;

    const refreshed = await mapConcurrent(files, SCAN_CONCURRENCY, async (path) => {
      const previous = this.records.get(path);
      const next = await refreshRecord(path, previous);
      if (!sameRecord(previous, next)) dirty = true;
      return { path, next };
    });
    for (const { path, next } of refreshed) {
      if (next) this.records.set(path, next);
      else this.records.delete(path);
    }

    for (const path of [...this.records.keys()]) {
      const inScope = scopeDirectory === undefined
        ? isWithin(this.sessionsRoot, path)
        : isWithin(scopeDirectory, path);
      if (inScope && !discovered.has(path)) {
        this.records.delete(path);
        dirty = true;
      }
    }
    if (dirty) await this.saveCache();

    return files
      .map((path) => this.records.get(path))
      .filter((record): record is SessionInventoryCacheRecord => record !== undefined)
      .map(projectSession)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionFile.localeCompare(right.sessionFile));
  }

  private async loadCache(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cachePath) return;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CACHE_BYTES) return;
      const raw = JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
      for (const record of parseCache(raw, this.sessionsRoot)) this.records.set(record.path, record);
    } catch {
      this.records.clear();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cachePath) return;
    const records = [...this.records.values()].sort((left, right) => left.path.localeCompare(right.path));
    const cache: SessionInventoryCacheFile = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      sessionsRoot: this.sessionsRoot,
      records,
    };
    const bytes = `${JSON.stringify(cache)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > MAX_CACHE_BYTES) return;
    const directory = dirname(this.cachePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.session-inventory-v1.tmp-${process.pid}-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.cachePath);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

async function refreshRecord(
  path: string,
  previous: SessionInventoryCacheRecord | undefined,
): Promise<SessionInventoryCacheRecord | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (
      previous
      && previous.dev === info.dev
      && previous.ino === info.ino
      && previous.size === info.size
      && previous.mtimeMs === info.mtimeMs
    ) return previous;

    const header = await readSessionHeader(handle, info.size);
    if (!header) return undefined;
    const appendOnly = previous !== undefined
      && previous.dev === info.dev
      && previous.ino === info.ino
      && info.size > previous.size
      && header.sessionId === previous.sessionId
      && header.cwd === previous.cwd;
    const nameResult = await findLatestSessionName(
      handle,
      appendOnly ? Math.max(0, previous.size - NAME_LINE_BYTES) : 0,
      info.size,
    );
    return {
      path: resolve(path),
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sessionId: header.sessionId,
      cwd: header.cwd,
      name: nameResult.found ? (nameResult.name ?? null) : (appendOnly ? previous.name : null),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readSessionHeader(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<{ sessionId: string; cwd: string } | undefined> {
  const length = Math.min(fileSize, HEADER_READ_BYTES);
  if (length < 1) return undefined;
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (newline < 0 && fileSize > bytesRead) return undefined;
  const end = newline < 0 ? bytesRead : newline;
  try {
    const value = JSON.parse(buffer.toString("utf8", 0, end)) as Record<string, unknown>;
    if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") return undefined;
    const sessionId = boundedText(value.id, 128);
    const cwd = boundedText(value.cwd, 16_384);
    if (sessionId.length === 0) return undefined;
    return { sessionId, cwd };
  } catch {
    return undefined;
  }
}

async function findLatestSessionName(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): Promise<{ found: boolean; name?: string }> {
  let cursor = end;
  let suffix = Buffer.alloc(0);
  while (cursor > start) {
    const chunkStart = Math.max(start, cursor - NAME_SCAN_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(cursor - chunkStart);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, chunkStart);
    if (bytesRead < 1) break;
    const current = chunk.subarray(0, bytesRead);
    const searchable = suffix.length === 0 ? current : Buffer.concat([current, suffix]);
    let index = searchable.lastIndexOf(SESSION_INFO_TOKEN);
    while (index >= 0) {
      if (index < current.length) {
        const candidate = await readMetadataLine(handle, chunkStart + index, end);
        if (candidate?.type === "session_info" && (candidate.name === undefined || typeof candidate.name === "string")) {
          const name = typeof candidate.name === "string" ? boundedOptionalText(candidate.name, 256) : undefined;
          return { found: true, ...(name === undefined ? {} : { name }) };
        }
      }
      index = searchable.lastIndexOf(SESSION_INFO_TOKEN, index - 1);
    }
    suffix = current.subarray(0, Math.min(SESSION_INFO_TOKEN.length - 1, current.length));
    cursor = chunkStart;
  }
  return { found: false };
}

async function readMetadataLine(
  handle: Awaited<ReturnType<typeof open>>,
  tokenOffset: number,
  fileSize: number,
): Promise<Record<string, unknown> | undefined> {
  const start = Math.max(0, tokenOffset - NAME_LINE_BYTES);
  const end = Math.min(fileSize, tokenOffset + SESSION_INFO_TOKEN.length + NAME_LINE_BYTES);
  const buffer = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  const tokenIndex = tokenOffset - start;
  const before = buffer.subarray(0, Math.min(tokenIndex, bytesRead));
  const previousNewline = before.lastIndexOf(0x0a);
  if (previousNewline < 0 && start > 0) return undefined;
  const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
  const nextNewline = buffer.subarray(tokenIndex, bytesRead).indexOf(0x0a);
  if (nextNewline < 0 && start + bytesRead < fileSize) return undefined;
  const lineEnd = nextNewline < 0 ? bytesRead : tokenIndex + nextNewline;
  if (lineEnd - lineStart > NAME_LINE_BYTES) return undefined;
  try {
    const value = JSON.parse(buffer.toString("utf8", lineStart, lineEnd)) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function discoverAllSessionFiles(root: string): Promise<string[]> {
  try {
    const directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
    const nested = await mapConcurrent(directories, SCAN_CONCURRENCY, discoverSessionFiles);
    return nested.flat().sort();
  } catch {
    return [];
  }
}

async function discoverSessionFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => resolve(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function defaultSessionDirectoryName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

function projectSession(record: SessionInventoryCacheRecord): SessionDto {
  return {
    sessionId: record.sessionId,
    sessionFile: record.path.slice(0, 16_384),
    ...(record.name === null ? {} : { name: record.name }),
    cwd: record.cwd,
    updatedAt: new Date(record.mtimeMs).toISOString(),
  };
}

function parseCache(input: unknown, sessionsRoot: string): SessionInventoryCacheRecord[] {
  if (!isRecord(input) || input.schemaVersion !== CACHE_SCHEMA_VERSION || input.sessionsRoot !== sessionsRoot || !Array.isArray(input.records)) return [];
  if (input.records.length > MAX_CACHE_RECORDS) return [];
  const records: SessionInventoryCacheRecord[] = [];
  for (const item of input.records) {
    if (!isRecord(item)) return [];
    if (
      typeof item.path !== "string"
      || !isWithin(sessionsRoot, item.path)
      || typeof item.dev !== "number"
      || !Number.isSafeInteger(item.dev)
      || typeof item.ino !== "number"
      || !Number.isSafeInteger(item.ino)
      || typeof item.size !== "number"
      || !Number.isSafeInteger(item.size)
      || item.size < 0
      || typeof item.mtimeMs !== "number"
      || !Number.isFinite(item.mtimeMs)
      || typeof item.sessionId !== "string"
      || typeof item.cwd !== "string"
      || (item.name !== null && typeof item.name !== "string")
    ) return [];
    records.push({
      path: resolve(item.path),
      dev: item.dev,
      ino: item.ino,
      size: item.size,
      mtimeMs: item.mtimeMs,
      sessionId: boundedText(item.sessionId, 128),
      cwd: boundedText(item.cwd, 16_384),
      name: item.name === null ? null : boundedOptionalText(item.name, 256) ?? null,
    });
  }
  return records;
}

function sameRecord(
  left: SessionInventoryCacheRecord | undefined,
  right: SessionInventoryCacheRecord | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.name === right.name;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child.length > 0 && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !child.startsWith("/") && !child.startsWith("\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, limit);
}

function boundedOptionalText(value: string, limit: number): string | undefined {
  const projected = boundedText(value, limit).trim();
  return projected.length === 0 ? undefined : projected;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
