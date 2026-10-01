import { createHash, randomUUID } from "node:crypto";
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
import { isNativeAbsoluteLocalPath } from "../core/local-path.js";
import { hardenWindowsPrivatePath, noFollowFlag } from "../platform/private-state.js";
import type {
  SessionInventory,
  SessionInventoryDiagnostic,
  SessionInventoryScan,
} from "../core/session-inventory.js";

const CACHE_SCHEMA_VERSION = 2;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_RECORDS = 100_000;
const HEADER_READ_BYTES = 64 * 1024;
const SCAN_CONCURRENCY = 4;
const ENTRY_SCAN_CHUNK_BYTES = 1024 * 1024;
/** Enough of an entry line to see its type and message role before buffering the rest. */
const ENTRY_HEAD_BYTES = 512;
/** Longer entries (pasted images, huge tool output) are skipped; the assistant reply after them still dates the session. */
const MAX_ENTRY_LINE_BYTES = 4 * 1024 * 1024;
/** Bytes before the resume point that must be unchanged for a larger file to count as appended to. */
const APPEND_CHECK_BYTES = 256;
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
  startedAtMs: number | null;
  /** Latest user/assistant message time, as Pi dates session activity. */
  lastActivityMs: number | null;
  /** Null until some assistant message records a cost. */
  costTotal: number | null;
  /** End of the last complete line folded into the fields above; appends resume here. */
  scannedBytes: number;
  /** Digest of the bytes just before scannedBytes; Pi rewrites (migrations) change it and force a full rescan. */
  scannedTail: string;
  /** In-memory only: session content is never copied into the durable metadata cache. */
  firstUserMessage?: string | null;
}

interface SessionInventoryCacheFile {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
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
    if (!isNativeAbsoluteLocalPath(cwd)) throw new Error("Session workspace is not an absolute path on this Host");
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

    // The Host orders and pages the listing; see sessionInventoryPage.
    const sessions = files
      .map((path) => this.records.get(path))
      .filter((record): record is SessionInventoryCacheRecord => record !== undefined)
      .map(projectSession);
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
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.cachePath, constants.O_RDONLY | noFollowFlag());
      await hardenWindowsPrivatePath(this.cachePath, false);
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
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.cachePath);
      await hardenWindowsPrivatePath(this.cachePath, false);
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
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile()) return { diagnostic: inventoryDiagnostic(path, "Persisted session path is not a regular file") };
    if (
      previous
      && previous.dev === info.dev
      && previous.ino === info.ino
      && previous.size === info.size
      && previous.mtimeMs === info.mtimeMs
    ) {
      if (previous.firstUserMessage !== undefined) return { record: previous };
      return { record: { ...previous, firstUserMessage: (await findFirstUserMessage(handle, info.size)) ?? null } };
    }

    const header = await readSessionHeader(handle, info.size);
    if (!header) return { diagnostic: inventoryDiagnostic(path, "Persisted session has an invalid or oversized Pi header") };
    const appendOnly = previous !== undefined
      && previous.dev === info.dev
      && previous.ino === info.ino
      && info.size > previous.size
      && previous.scannedBytes <= info.size
      && header.sessionId === previous.sessionId
      && header.cwd === previous.cwd
      && await tailDigest(handle, previous.scannedBytes) === previous.scannedTail;
    const summary: EntrySummary = appendOnly
      ? { name: previous.name, lastActivityMs: previous.lastActivityMs, costTotal: previous.costTotal, firstUserMessage: previous.firstUserMessage }
      : { name: null, lastActivityMs: null, costTotal: null, firstUserMessage: null };
    const scannedBytes = await summarizeEntries(handle, appendOnly ? previous.scannedBytes : 0, info.size, summary);
    return { record: {
      path: resolve(path),
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sessionId: header.sessionId,
      cwd: header.cwd,
      name: summary.name,
      startedAtMs: header.startedAtMs,
      lastActivityMs: summary.lastActivityMs,
      costTotal: summary.costTotal,
      scannedBytes,
      scannedTail: await tailDigest(handle, scannedBytes),
      // An append after a Host restart does not revisit the file start, so look the preview up once.
      firstUserMessage: summary.firstUserMessage === undefined
        ? (await findFirstUserMessage(handle, info.size)) ?? null
        : summary.firstUserMessage,
    } };
  } catch (error) {
    return { diagnostic: inventoryDiagnostic(path, `Persisted session could not be read: ${errorText(error)}`) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function tailDigest(handle: FileHandle, end: number): Promise<string> {
  const start = Math.max(0, end - APPEND_CHECK_BYTES);
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
}

async function readSessionHeader(
  handle: FileHandle,
  fileSize: number,
): Promise<{ sessionId: string; cwd: string; startedAtMs: number | null } | undefined> {
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
    const startedAtMs = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    return { sessionId, cwd, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null };
  } catch {
    return undefined;
  }
}

interface EntrySummary {
  name: string | null;
  lastActivityMs: number | null;
  costTotal: number | null;
  /** Undefined when an earlier part of the file was summarized before this Host started. */
  firstUserMessage: string | null | undefined;
}

/** Fold complete entry lines in [start, end) into the summary; returns where the next scan resumes. */
async function summarizeEntries(handle: FileHandle, start: number, end: number, summary: EntrySummary): Promise<number> {
  return scanEntryLines(handle, start, end, mayCarrySummary, (entry) => {
    if (entry.type === "session_info") {
      summary.name = typeof entry.name === "string" ? boundedOptionalText(entry.name, 256) ?? null : null;
      return false;
    }
    if (entry.type === "usage") {
      // Pi 0.99 records paid requests outside the conversation (such as cache warming) here.
      addCost(summary, entry.usage);
      return false;
    }
    const message = conversationMessage(entry);
    if (!message) return false;
    const activity = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp));
    if (Number.isFinite(activity)) summary.lastActivityMs = Math.max(summary.lastActivityMs ?? activity, activity);
    if (message.role === "user" && summary.firstUserMessage === null) summary.firstUserMessage = userMessageText(message) ?? null;
    if (message.role === "assistant") addCost(summary, message.usage);
    return false;
  });
}

function addCost(summary: EntrySummary, usage: unknown): void {
  const cost = isRecord(usage) && isRecord(usage.cost) ? usage.cost.total : undefined;
  if (typeof cost === "number" && Number.isFinite(cost)) summary.costTotal = (summary.costTotal ?? 0) + cost;
}

async function findFirstUserMessage(handle: FileHandle, fileSize: number): Promise<string | undefined> {
  let firstUserMessage: string | undefined;
  await scanEntryLines(handle, 0, fileSize, (head) => mayCarrySummary(head, "user"), (entry) => {
    const message = conversationMessage(entry);
    if (message?.role !== "user") return false;
    firstUserMessage = userMessageText(message);
    return firstUserMessage !== undefined;
  });
  return firstUserMessage;
}

/**
 * Pi writes one JSON entry per line. Most bytes are tool results, so a line is
 * only buffered and parsed when its head may be a user/assistant message or a
 * session name; an unfamiliar layout is parsed rather than guessed.
 */
function mayCarrySummary(head: string, role?: "user"): boolean {
  const type = /^\{"type":"([^"]*)"/u.exec(head)?.[1];
  if (type === undefined) return true;
  if (type === "session_info" || type === "usage") return role === undefined;
  if (type !== "message") return false;
  const messageRole = /"message":\{"role":"([^"]*)"/u.exec(head)?.[1];
  if (messageRole === undefined) return true;
  if (messageRole !== "user" && messageRole !== "assistant") return false;
  return role === undefined || messageRole === role;
}

async function scanEntryLines(
  handle: FileHandle,
  start: number,
  end: number,
  wanted: (head: string) => boolean,
  visit: (entry: Record<string, unknown>) => boolean,
): Promise<number> {
  let cursor = start;
  let consumed = start;
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let decision: boolean | undefined;
  const chunk = Buffer.allocUnsafe(Math.min(ENTRY_SCAN_CHUNK_BYTES, Math.max(1, end - start)));
  while (cursor < end) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - cursor), cursor);
    if (bytesRead < 1) break;
    let segmentStart = 0;
    while (segmentStart < bytesRead) {
      const newline = chunk.subarray(segmentStart, bytesRead).indexOf(0x0a);
      const segmentEnd = newline < 0 ? bytesRead : segmentStart + newline;
      if (decision !== false) {
        const segment = chunk.subarray(segmentStart, segmentEnd);
        if (lineBytes + segment.length > MAX_ENTRY_LINE_BYTES) {
          decision = false;
          parts = [];
        } else {
          parts.push(Buffer.from(segment));
          lineBytes += segment.length;
          if (decision === undefined && lineBytes >= ENTRY_HEAD_BYTES) decision = wanted(Buffer.concat(parts, lineBytes).toString("utf8", 0, ENTRY_HEAD_BYTES));
          if (decision === false) parts = [];
        }
      }
      if (newline < 0) break;
      const line = decision === false ? undefined : Buffer.concat(parts, lineBytes);
      consumed = cursor + segmentEnd + 1;
      parts = [];
      lineBytes = 0;
      const keep = decision ?? (line !== undefined && wanted(line.toString("utf8", 0, ENTRY_HEAD_BYTES)));
      decision = undefined;
      segmentStart = segmentEnd + 1;
      if (!keep || line === undefined || line.length === 0) continue;
      const entry = parseEntry(line);
      if (entry && visit(entry)) return consumed;
    }
    cursor += bytesRead;
  }
  // A final line without its newline is either a write still in progress (not
  // valid JSON yet, so it is read again later) or a finished entry that a later
  // append will separate with a newline first.
  if (lineBytes > 0 && decision !== false) {
    const line = Buffer.concat(parts, lineBytes);
    const entry = parseEntry(line);
    if (entry) {
      consumed = cursor;
      if (decision ?? wanted(line.toString("utf8", 0, ENTRY_HEAD_BYTES))) visit(entry);
    }
  }
  return consumed;
}

function parseEntry(line: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line.toString("utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function conversationMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  return (message.role === "user" || message.role === "assistant") && "content" in message ? message : undefined;
}

function userMessageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" ")
      : "";
  return boundedOptionalText(text.replace(/\s+/gu, " "), MAX_SESSION_FIRST_USER_MESSAGE_CHARS);
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
    lastActivityAt: new Date(record.lastActivityMs ?? record.startedAtMs ?? record.mtimeMs).toISOString(),
    ...(record.costTotal === null ? {} : { costTotal: record.costTotal }),
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
      || !nullableFinite(item.startedAtMs)
      || !nullableFinite(item.lastActivityMs)
      || !nullableFinite(item.costTotal)
      || typeof item.scannedBytes !== "number"
      || !Number.isSafeInteger(item.scannedBytes)
      || item.scannedBytes < 0
      || item.scannedBytes > item.size
      || typeof item.scannedTail !== "string"
      || !/^[0-9a-f]{64}$/u.test(item.scannedTail)
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
      startedAtMs: item.startedAtMs as number | null,
      lastActivityMs: item.lastActivityMs as number | null,
      costTotal: item.costTotal as number | null,
      scannedBytes: item.scannedBytes,
      scannedTail: item.scannedTail,
    });
  }
  return records;
}

function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
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
    && left.name === right.name
    && left.startedAtMs === right.startedAtMs
    && left.lastActivityMs === right.lastActivityMs
    && left.costTotal === right.costTotal
    && left.scannedBytes === right.scannedBytes
    && left.scannedTail === right.scannedTail;
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
