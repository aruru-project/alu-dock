import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  ASSISTANT_TOOL_NAMES,
  AssistantError,
  MAX_ASSISTANT_RESULT_BYTES,
  MAX_ASSISTANT_SNIPPET_CHARS,
  type AssistantContextRequest,
  type AssistantContextResult,
  type AssistantEntry,
  type AssistantEntryKind,
  type AssistantRecordSession,
  type AssistantSearchHit,
  type AssistantSearchRequest,
  type AssistantSearchResult,
  type AssistantSessionInfo,
  type AssistantSource,
  type AssistantToolCall,
} from "../core/assistant.js";

/*
 * The conversations of the Works opened as the assistant, in Node's own SQLite. Every entry keeps
 * where it came from: the Agent's session and entry IDs, the Work and machine it was said in, and
 * when.
 *
 * An entry's row ID is its time in milliseconds times ENTRY_IDS_PER_MS plus a counter, so the rows,
 * and the full-text index that shares their IDs, are in time order, and a time range is a range of
 * IDs. More than ENTRY_IDS_PER_MS entries said in one millisecond take IDs of the next free
 * millisecond; the store remembers the furthest such shift, widens a range's upper end by it, and
 * filters on each entry's own time, so a time range still means the times said. Times outside
 * ASSISTANT_TIME_RANGE_MS are refused where entries enter.
 *
 * The index cuts text into three-character pieces, so Chinese works without a word list; words of one
 * or two characters are checked with LIKE (letters A–Z in either case), row by row. A search goes from
 * the newest entry back and stops once it has enough: with only indexed words it follows the index
 * alone; otherwise it reads SCAN_WINDOW rows at a time and checks its deadline between them, since
 * Node's synchronous SQLite cannot be interrupted from outside.
 *
 * One connection writes (the service's main thread); searches and context reads use their own
 * read connections on other threads (see readers.ts), which SQLite's WAL journal lets run alongside a write.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  session_file TEXT, cwd TEXT, name TEXT, work_id TEXT, machine TEXT,
  started_at TEXT NOT NULL, started_ms INTEGER NOT NULL,
  last_at TEXT NOT NULL, last_ms INTEGER NOT NULL,
  through_entry_id TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  entry_id TEXT NOT NULL, parent_id TEXT,
  at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  work_id TEXT, machine TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, tool_calls TEXT, truncated INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL,
  UNIQUE (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_parent ON entries (session_id, parent_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (search_text, content = 'entries', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS entries_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_delete AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('max_shift_ms', '0');
`;
/** The database layout this code reads and writes; a newer one is refused rather than misread. */
const SCHEMA_VERSION = "1";

/** Room for entries said in the same millisecond. */
const ENTRY_IDS_PER_MS = 1024;
const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** Pieces shorter than this cannot use the three-character index and are checked row by row. */
const INDEXED_TERM_CHARS = 3;
/** Rows one step of a search reads before it checks its deadline again. */
const SCAN_WINDOW = 5_000;
const TIMEOUT_MESSAGE = "这次查询超时，没有返回结果。请换个更具体的词，或者缩小时间范围再试。";

interface EntryRow {
  id: number;
  session_id: string;
  entry_id: string;
  parent_id: string | null;
  at: string;
  at_ms: number;
  work_id: string | null;
  machine: string | null;
  kind: string;
  text: string;
  tool_name: string | null;
  tool_calls: string | null;
  truncated: number;
  search_text: string;
}

interface SessionRow {
  session_id: string;
  session_file: string | null;
  cwd: string | null;
  name: string | null;
  work_id: string | null;
  machine: string | null;
  started_at: string;
  last_at: string;
  through_entry_id: string | null;
}

export class AssistantStore {
  private readonly db: DatabaseSync;

  /**
   * `reader` opens a connection that only reads, for a thread that answers searches. The layout is
   * checked before anything is created: an empty file becomes a new memory; one whose layout this
   * code does not know is refused and left exactly as it was.
   */
  constructor(path: string, options: { reader?: boolean } = {}) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(options.reader ? "PRAGMA query_only = 1; PRAGMA busy_timeout = 5000;" : "PRAGMA busy_timeout = 5000;");
      const tables = (this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
      const version = tables.includes("meta")
        ? (this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value
        : undefined;
      const fresh = tables.length === 0;
      if (!(version === SCHEMA_VERSION || (fresh && !options.reader))) {
        throw new Error(`The assistant's memory at ${path} has ${fresh ? "not been set up" : `layout ${version ?? "unknown"}`}, which this Dock cannot read. It is left as it is.`);
      }
      if (!options.reader) this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** The last entry of the Agent's session recorded so far, kept or not. */
  recorded(sessionId: string): { lastEntryId?: string } {
    const row = this.db.prepare("SELECT through_entry_id FROM sessions WHERE session_id = ?").get(sessionId) as { through_entry_id: string | null } | undefined;
    return row?.through_entry_id ? { lastEntryId: row.through_entry_id } : {};
  }

  /** Keeps a batch; an entry already kept stays as it was, so a batch sent twice changes nothing. */
  record(session: AssistantRecordSession, entries: readonly AssistantEntry[], throughEntryId: string, source: AssistantSource): { lastEntryId: string } {
    const now = new Date().toISOString();
    const times = entries.map((entry) => ({ at: entry.at, ms: Date.parse(entry.at) }));
    const first = times.reduce((earliest, time) => (time.ms < earliest.ms ? time : earliest), times[0] ?? { at: now, ms: Date.parse(now) });
    const last = times.reduce((latest, time) => (time.ms > latest.ms ? time : latest), first);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO sessions (session_id, session_file, cwd, name, work_id, machine, started_at, started_ms, last_at, last_ms, through_entry_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          session_file = coalesce(excluded.session_file, session_file),
          cwd = excluded.cwd,
          name = coalesce(excluded.name, name),
          work_id = coalesce(excluded.work_id, work_id),
          machine = coalesce(excluded.machine, machine),
          started_at = CASE WHEN excluded.started_ms < started_ms THEN excluded.started_at ELSE started_at END,
          started_ms = min(started_ms, excluded.started_ms),
          last_at = CASE WHEN excluded.last_ms > last_ms THEN excluded.last_at ELSE last_at END,
          last_ms = max(last_ms, excluded.last_ms),
          through_entry_id = excluded.through_entry_id
      `).run(session.sessionId, session.sessionFile ?? null, session.cwd, session.name ?? null, source.workId ?? null, source.machine ?? null,
        first.at, first.ms, last.at, last.ms, throughEntryId);
      const known = this.db.prepare("SELECT 1 FROM entries WHERE session_id = ? AND entry_id = ?");
      const latestIn = this.db.prepare("SELECT max(id) AS id FROM entries WHERE id >= ? AND id < ?");
      const insert = this.db.prepare(`
        INSERT INTO entries (id, session_id, entry_id, parent_id, at, at_ms, work_id, machine, kind, text, tool_name, tool_calls, truncated, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let shift = 0;
      for (const entry of entries) {
        if (known.get(session.sessionId, entry.entryId)) continue;
        // A parent this session has not kept, such as history before a resume, is not named.
        const parentId = entry.parentId !== undefined && known.get(session.sessionId, entry.parentId) ? entry.parentId : null;
        const ms = Date.parse(entry.at);
        const id = this.nextId(latestIn, ms);
        shift = Math.max(shift, Math.floor(id / ENTRY_IDS_PER_MS) - ms);
        insert.run(id, session.sessionId, entry.entryId, parentId, entry.at, ms, source.workId ?? null, source.machine ?? null,
          entry.kind, entry.text, entry.toolName ?? null, entry.toolCalls === undefined ? null : JSON.stringify(entry.toolCalls), entry.truncated ? 1 : 0, searchText(entry));
      }
      if (shift > 0) this.db.prepare("UPDATE meta SET value = max(CAST(value AS INTEGER), ?) WHERE key = 'max_shift_ms'").run(shift);
      this.db.exec("COMMIT");
    } catch (error) {
      // SQLite may already have rolled back (a full disk, an I/O error); the first error is the one to report.
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction was left open */ }
      throw error;
    }
    return { lastEntryId: throughEntryId };
  }

  /**
   * Newest first; every word must occur. Without words, everything in the time range. Past `deadline`
   * (a Date.now() time) it stops between steps and refuses with assistant_query_timeout.
   */
  search(request: AssistantSearchRequest, deadline = Number.POSITIVE_INFINITY): AssistantSearchResult {
    if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
    const terms = (request.query ?? "").trim().split(/\s+/u).filter((term) => term.length > 0);
    const indexed = terms.filter((term) => [...term].length >= INDEXED_TERM_CHARS);
    const short = terms.filter((term) => [...term].length < INDEXED_TERM_CHARS);
    // IDs bound the walk; each entry's own time decides, since a burst may sit a few milliseconds late.
    const fromMs = request.from === undefined ? undefined : boundary(request.from, "start");
    const toMs = request.to === undefined ? undefined : boundary(request.to, "end");
    const shift = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'max_shift_ms'").get() as { value: string }).value);
    const lowest = fromMs === undefined ? Number.MIN_SAFE_INTEGER : idAt(fromMs);
    let below = Math.min(
      toMs === undefined ? Number.MAX_SAFE_INTEGER : idAt(toMs + shift),
      request.cursor === undefined ? Number.MAX_SAFE_INTEGER : parseCursor(request.cursor),
    );
    const wanted = request.limit + 1;
    const filters = [
      ...(fromMs === undefined ? [] : ["e.at_ms >= ?"]),
      ...(toMs === undefined ? [] : ["e.at_ms < ?"]),
      ...short.map(() => "e.search_text LIKE ? ESCAPE '\\'"),
    ];
    const filterValues: SQLInputValue[] = [
      ...(fromMs === undefined ? [] : [fromMs]),
      ...(toMs === undefined ? [] : [toMs]),
      ...short.map((term) => `%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`),
    ];
    const expression = indexed.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
    const fromIndex = (extra: string[]) => this.db.prepare(`SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ${extra.map((condition) => `AND ${condition}`).join(" ")} ORDER BY f.rowid DESC LIMIT ?`);
    const rows: EntryRow[] = [];
    if (indexed.length > 0 && short.length === 0) {
      // The index alone: it is read newest first and the read stops at the limit.
      rows.push(...fromIndex(filters).all(expression, lowest, below, ...filterValues, wanted) as unknown as EntryRow[]);
    } else {
      const windowEnd = this.db.prepare("SELECT id FROM entries WHERE id >= ? AND id < ? ORDER BY id DESC LIMIT 1 OFFSET ?");
      const step = indexed.length > 0
        ? fromIndex(filters)
        : this.db.prepare(`SELECT e.* FROM entries e WHERE e.id >= ? AND e.id < ? AND e.search_text <> '' ${filters.map((condition) => `AND ${condition}`).join(" ")} ORDER BY e.id DESC LIMIT ?`);
      while (rows.length < wanted) {
        if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
        // [low, below) holds at most SCAN_WINDOW rows; the next window ends where this one began.
        const end = windowEnd.get(lowest, below, SCAN_WINDOW - 1) as { id: number } | undefined;
        const low = end?.id ?? lowest;
        const need = wanted - rows.length;
        rows.push(...(indexed.length > 0 ? step.all(expression, low, below, ...filterValues, need) : step.all(low, below, ...filterValues, need)) as unknown as EntryRow[]);
        if (end === undefined) break;
        below = low;
      }
    }
    const page = rows.slice(0, request.limit);
    const sessions = new Map<string, AssistantSessionInfo>();
    const hits: AssistantSearchHit[] = page.map((row) => {
      let session = sessions.get(row.session_id);
      if (!session) { session = this.session(row.session_id); sessions.set(row.session_id, session); }
      return { session: saidIn(session, row), entryId: row.entry_id, at: row.at, kind: row.kind as AssistantEntryKind, snippet: snippet(row.search_text, terms) };
    });
    const last = page.at(-1);
    return { hits, ...(rows.length > request.limit && last ? { nextCursor: encodeCursor(last.id) } : {}) };
  }

  /** The entry with what came before it on its branch and what followed on the latest branch after it; at most about 2 × 50 lookups. */
  context(request: AssistantContextRequest, deadline = Number.POSITIVE_INFINITY): AssistantContextResult {
    if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
    const byId = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND entry_id = ?");
    const latestChild = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND parent_id = ? ORDER BY id DESC LIMIT 1");
    const target = byId.get(request.sessionId, request.entryId) as unknown as EntryRow | undefined;
    if (!target) throw new AssistantError("assistant_entry_not_found", "没有找到这条对话记录。它可能还没记下来，或者编号写错了。");
    const before: EntryRow[] = [];
    let cursor: EntryRow | undefined = target;
    while (before.length < request.before && cursor?.parent_id) {
      cursor = byId.get(request.sessionId, cursor.parent_id) as unknown as EntryRow | undefined;
      if (cursor) before.unshift(cursor);
    }
    let hasBefore = Boolean(cursor?.parent_id && byId.get(request.sessionId, cursor.parent_id));
    const after: EntryRow[] = [];
    cursor = target;
    while (after.length < request.after && cursor) {
      cursor = latestChild.get(request.sessionId, cursor.entry_id) as unknown as EntryRow | undefined;
      if (cursor) after.push(cursor);
    }
    let hasAfter = Boolean(cursor && latestChild.get(request.sessionId, cursor.entry_id));
    // Leave out the farthest entries until the answer fits one record; the entry asked for always stays.
    const entries = new Map<EntryRow, { entry: AssistantEntry; bytes: number }>();
    for (const row of [...before, target, ...after]) {
      const entry = entryOf(row);
      entries.set(row, { entry, bytes: Buffer.byteLength(JSON.stringify(entry), "utf8") + 1 });
    }
    let bytes = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (bytes > MAX_ASSISTANT_RESULT_BYTES && before.length + after.length > 0) {
      if (before.length >= after.length) { bytes -= entries.get(before.shift()!)!.bytes; hasBefore = true; }
      else { bytes -= entries.get(after.pop()!)!.bytes; hasAfter = true; }
    }
    const kept = [...before, target, ...after];
    return { session: saidIn(this.session(request.sessionId), kept.at(-1)!), entries: kept.map((row) => entries.get(row)!.entry), hasBefore, hasAfter };
  }

  /** The ID for an entry said at `ms`: its millisecond's next free ID, or the next millisecond's when that is full. */
  private nextId(latestIn: StatementSync, ms: number): number {
    for (let base = ms * ENTRY_IDS_PER_MS; ; base += ENTRY_IDS_PER_MS) {
      // Entry times stop well short of this (ASSISTANT_TIME_RANGE_MS); only an absurd burst gets here.
      if (base + ENTRY_IDS_PER_MS > Number.MAX_SAFE_INTEGER) throw new Error("The assistant's memory has no room left for entries at this time");
      const latest = (latestIn.get(base, base + ENTRY_IDS_PER_MS) as { id: number | null }).id;
      if (latest === null) return base;
      if (latest + 1 < base + ENTRY_IDS_PER_MS) return latest + 1;
    }
  }

  private sessionStatement: StatementSync | undefined;
  private session(sessionId: string): AssistantSessionInfo {
    this.sessionStatement ??= this.db.prepare("SELECT * FROM sessions WHERE session_id = ?");
    const row = this.sessionStatement.get(sessionId) as unknown as SessionRow;
    return {
      sessionId: row.session_id,
      ...(row.session_file ? { sessionFile: row.session_file } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.work_id ? { workId: row.work_id } : {}),
      ...(row.machine ? { machine: row.machine } : {}),
      startedAt: row.started_at,
      lastAt: row.last_at,
    };
  }
}

/** Where the IDs of a search bound at `ms` lie; a bound past every possible entry stays a safe integer. */
function idAt(ms: number): number {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, ms * ENTRY_IDS_PER_MS));
}

/** The session as it was where this entry was said: the Work and machine of the entry itself. */
function saidIn(session: AssistantSessionInfo, row: EntryRow): AssistantSessionInfo {
  const { workId: _workId, machine: _machine, ...rest } = session;
  return { ...rest, ...(row.work_id ? { workId: row.work_id } : {}), ...(row.machine ? { machine: row.machine } : {}) };
}

/** What search looks through: the words, and the assistant's tool calls except her own memory tools. */
function searchText(entry: AssistantEntry): string {
  if (entry.kind === "tool_result" && entry.toolName !== undefined && OWN_TOOLS.has(entry.toolName)) return "";
  const calls = (entry.toolCalls ?? []).filter((call) => !OWN_TOOLS.has(call.name)).map((call) => `${call.name} ${call.arguments}`);
  return [entry.text, ...calls].filter((part) => part.length > 0).join("\n");
}

function entryOf(row: EntryRow): AssistantEntry {
  const toolCalls = row.tool_calls === null ? undefined : JSON.parse(row.tool_calls) as AssistantToolCall[];
  return {
    entryId: row.entry_id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    at: row.at,
    kind: row.kind as AssistantEntryKind,
    text: row.text,
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
    ...(row.truncated ? { truncated: true as const } : {}),
  };
}

/**
 * A part of the text around the first word found, at most MAX_ASSISTANT_SNIPPET_CHARS code units with
 * its "…" marks, never splitting a character such as an emoji.
 */
function snippet(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const lower = flat.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((position) => position >= 0);
  const found = positions.length === 0 ? 0 : Math.min(...positions);
  if (flat.length <= MAX_ASSISTANT_SNIPPET_CHARS) return flat;
  // Room for a mark at each end.
  const budget = MAX_ASSISTANT_SNIPPET_CHARS - 2;
  const start = characterStart(flat, Math.max(0, Math.min(found - Math.floor(budget / 3), flat.length - budget)));
  const end = characterStart(flat, Math.min(flat.length, start + budget));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Moves an index off the second half of a surrogate pair. */
function characterStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/**
 * A day without a time means Main's local day: `from` its start, `to` its end, so "until 2026-11-07"
 * includes that day.
 */
function boundary(value: string, side: "start" | "end"): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  // A full time is included as given.
  if (!day) return side === "start" ? Date.parse(value) : Date.parse(value) + 1;
  const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  return side === "start" ? start : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1).getTime();
}

function encodeCursor(id: number): string { return Buffer.from(String(id)).toString("base64url"); }
function parseCursor(cursor: string): number {
  const id = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (Number.isSafeInteger(id)) return id;
  throw new AssistantError("invalid_request", "这个续读位置不是这次搜索给出的，请重新搜索。");
}
