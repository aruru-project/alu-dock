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

import {
  MAX_SESSION_FIRST_USER_MESSAGE_CHARS,
  type SessionDto,
} from "../core/instance-dto.js";
import type {
  SessionInventory,
  SessionInventoryDiagnostic,
  SessionInventoryScan,
} from "../core/session-inventory.js";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_RECORDS = 100_000;
const HEADER_READ_BYTES = 64 * 1024;
const NAME_LINE_BYTES = 64 * 1024;
const NAME_SCAN_CHUNK_BYTES = 1024 * 1024;
const SCAN_CONCURRENCY = 4;
const SESSION_INFO_TOKEN = Buffer.from('"session_info"', "utf8");
const FIRST_MESSAGE_SCAN_CHUNK_BYTES = 256 * 1024;
const MAX_FIRST_MESSAGE_LINE_BYTES = 1024 * 1024;
const MAX_INVENTORY_DIAGNOSTICS = 100;

interface SessionInventoryCacheRecord {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  name: string | null;
  /** In-memory only: session content is never copied into the durable metadata cache. */
  firstUserMessage?: string | null;
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

  list(cwd: string, scope: "cwd" | "all"): Promise<SessionInventoryScan> {
    const task = this.queue.then(async () => this.listSerial(cwd, scope));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async listSerial(cwd: string, scope: "cwd" | "all"): Promise<SessionInventoryScan> {
    await this.loadCache();
    const canonicalCwd = await realpath(resolve(cwd));
    const scopeDirectory = scope === "cwd"
      ? join(this.sessionsRoot, defaultSessionDirectoryName(canonicalCwd))
      : undefined;
    const discovery = scopeDirectory === undefined
      ? await discoverAllSessionFiles(this.sessionsRoot)
      : await discoverSessionFiles(scopeDirectory);
    const files = discovery.files;
    const diagnostics = [...discovery.diagnostics];
    const discovered = new Set(files);
    let dirty = false;

    const refreshed = await mapConcurrent(files, SCAN_CONCURRENCY, async (path) => {
      const previous = this.records.get(path);
      const result = await refreshRecord(path, previous);
      if (!sameRecord(previous, result.record)) dirty = true;
      return { path, ...result };
    });
    for (const { path, record, diagnostic } of refreshed) {
      if (record) this.records.set(path, record);
      else this.records.delete(path);
      if (diagnostic) diagnostics.push(diagnostic);
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
    if (dirty) {
      try {
        const saved = await this.saveCache();
        if (!saved && this.cachePath) diagnostics.push(inventoryDiagnostic(this.cachePath, "Session metadata cache exceeded its 32 MiB bound; authoritative sessions were scanned without updating the cache"));
      } catch (error) {
        if (this.cachePath) diagnostics.push(inventoryDiagnostic(this.cachePath, `Session metadata cache could not be updated; authoritative sessions were still scanned: ${errorText(error)}`));
      }
    }

    const sessions = files
      .map((path) => this.records.get(path))
      .filter((record): record is SessionInventoryCacheRecord => record !== undefined)
      .map(projectSession)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionFile.localeCompare(right.sessionFile));
    return {
      sessions,
      incomplete: diagnostics.length > 0,
      diagnostics: diagnostics.slice(0, MAX_INVENTORY_DIAGNOSTICS),
      ...(diagnostics.length > MAX_INVENTORY_DIAGNOSTICS ? { diagnosticsTruncated: true } : {}),
    };
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

  private async saveCache(): Promise<boolean> {
    if (!this.cachePath) return true;
    const records = [...this.records.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ firstUserMessage: _firstUserMessage, ...record }) => record);
    const cache: SessionInventoryCacheFile = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      sessionsRoot: this.sessionsRoot,
      records,
    };
    const bytes = `${JSON.stringify(cache)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > MAX_CACHE_BYTES) return false;
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
      return true;
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

async function refreshRecord(
  path: string,
  previous: SessionInventoryCacheRecord | undefined,
): Promise<{ record?: SessionInventoryCacheRecord; diagnostic?: SessionInventoryDiagnostic }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { diagnostic: inventoryDiagnostic(path, "Persisted session path is not a regular file") };
    if (
      previous
      && previous.dev === info.dev
      && previous.ino === info.ino
      && previous.size === info.size
      && previous.mtimeMs === info.mtimeMs
      && previous.firstUserMessage !== undefined
    ) return { record: previous };

    const header = await readSessionHeader(handle, info.size);
    if (!header) return { diagnostic: inventoryDiagnostic(path, "Persisted session has an invalid or oversized Pi header") };
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
    const firstUserMessage = appendOnly && previous.firstUserMessage
      ? previous.firstUserMessage
      : await findFirstUserMessage(handle, info.size);
    return { record: {
      path: resolve(path),
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sessionId: header.sessionId,
      cwd: header.cwd,
      name: nameResult.found ? (nameResult.name ?? null) : (appendOnly ? previous.name : null),
      firstUserMessage: firstUserMessage ?? null,
    } };
  } catch (error) {
    return { diagnostic: inventoryDiagnostic(path, `Persisted session could not be read: ${errorText(error)}`) };
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

async function findFirstUserMessage(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<string | undefined> {
  let cursor = 0;
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let lineOversized = false;
  while (cursor < fileSize) {
    const chunk = Buffer.allocUnsafe(Math.min(FIRST_MESSAGE_SCAN_CHUNK_BYTES, fileSize - cursor));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor);
    if (bytesRead < 1) break;
    cursor += bytesRead;
    let start = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(start, index);
      if (!lineOversized && lineBytes + segment.length <= MAX_FIRST_MESSAGE_LINE_BYTES) {
        parts.push(segment);
        lineBytes += segment.length;
        const firstUserMessage = firstUserMessageFromLine(Buffer.concat(parts, lineBytes));
        if (firstUserMessage) return firstUserMessage;
      }
      parts = [];
      lineBytes = 0;
      lineOversized = false;
      start = index + 1;
    }
    const tail = chunk.subarray(start, bytesRead);
    if (!lineOversized) {
      if (lineBytes + tail.length <= MAX_FIRST_MESSAGE_LINE_BYTES) {
        parts.push(tail);
        lineBytes += tail.length;
      } else {
        parts = [];
        lineBytes = 0;
        lineOversized = true;
      }
    }
  }
  if (!lineOversized && lineBytes > 0) return firstUserMessageFromLine(Buffer.concat(parts, lineBytes));
  return undefined;
}

function firstUserMessageFromLine(line: Buffer): string | undefined {
  try {
    const entry = JSON.parse(line.toString("utf8")) as unknown;
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return undefined;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" ")
        : "";
    return boundedOptionalText(text.replace(/\s+/gu, " "), MAX_SESSION_FIRST_USER_MESSAGE_CHARS);
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

interface SessionFileDiscovery {
  files: string[];
  diagnostics: SessionInventoryDiagnostic[];
}

async function discoverAllSessionFiles(root: string): Promise<SessionFileDiscovery> {
  try {
    const directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
    const nested = await mapConcurrent(directories, SCAN_CONCURRENCY, discoverSessionFiles);
    return {
      files: nested.flatMap((result) => result.files).sort(),
      diagnostics: nested.flatMap((result) => result.diagnostics),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { files: [], diagnostics: [] };
    return { files: [], diagnostics: [inventoryDiagnostic(root, `Persisted session root could not be scanned: ${errorText(error)}`)] };
  }
}

async function discoverSessionFiles(directory: string): Promise<SessionFileDiscovery> {
  try {
    return {
      files: (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => resolve(directory, entry.name))
        .sort(),
      diagnostics: [],
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { files: [], diagnostics: [] };
    return { files: [], diagnostics: [inventoryDiagnostic(directory, `Persisted session directory could not be scanned: ${errorText(error)}`)] };
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
    ...(record.firstUserMessage ? { firstUserMessage: record.firstUserMessage } : {}),
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

function inventoryDiagnostic(path: string, message: string): SessionInventoryDiagnostic {
  return {
    path: boundedText(resolve(path), 16_384),
    message: boundedText(message, 2_048),
  };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(message, 1_024) || "unknown I/O error";
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
