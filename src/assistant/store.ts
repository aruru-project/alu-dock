import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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
 * when. Search is keyword search: SQLite's full-text index cuts text into three-character pieces, so
 * Chinese works without a word list; shorter words are matched one row at a time.
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
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  entry_id TEXT NOT NULL, parent_id TEXT,
  at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  work_id TEXT, machine TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, tool_calls TEXT, truncated INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL,
  UNIQUE (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_parent ON entries (session_id, parent_id, seq);
CREATE INDEX IF NOT EXISTS entries_time ON entries (at_ms, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (search_text, content = 'entries', content_rowid = 'seq', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS entries_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, search_text) VALUES (new.seq, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_delete AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, search_text) VALUES ('delete', old.seq, old.search_text);
END;
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');
`;

const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** Words searched at once; more are ignored rather than refused. */
const MAX_SEARCH_TERMS = 8;
/** Pieces shorter than this cannot use the three-character index and are matched row by row. */
const INDEXED_TERM_CHARS = 3;

interface EntryRow {
  seq: number;
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

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
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
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO entries (session_id, entry_id, parent_id, at, at_ms, work_id, machine, kind, text, tool_name, tool_calls, truncated, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(session.sessionId, entry.entryId, entry.parentId ?? null, entry.at, Date.parse(entry.at), source.workId ?? null, source.machine ?? null,
          entry.kind, entry.text, entry.toolName ?? null, entry.toolCalls === undefined ? null : JSON.stringify(entry.toolCalls), entry.truncated ? 1 : 0, searchText(entry));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { lastEntryId: throughEntryId };
  }

  /** Newest first; every word must occur, in any letter case. Without words, everything in the time range. */
  search(request: AssistantSearchRequest): AssistantSearchResult {
    const terms = (request.query ?? "").trim().split(/\s+/u).filter((term) => term.length > 0).slice(0, MAX_SEARCH_TERMS);
    const indexed = terms.filter((term) => [...term].length >= INDEXED_TERM_CHARS);
    const scanned = terms.filter((term) => [...term].length < INDEXED_TERM_CHARS);
    const where = ["e.search_text <> ''"];
    const values: SQLInputValue[] = [];
    if (indexed.length > 0) {
      where.push("e.seq IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)");
      values.push(indexed.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND "));
    }
    for (const term of scanned) {
      where.push("e.search_text LIKE ? ESCAPE '\\'");
      values.push(`%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
    }
    if (request.from !== undefined) { where.push("e.at_ms >= ?"); values.push(boundary(request.from, "start")); }
    if (request.to !== undefined) { where.push("e.at_ms < ?"); values.push(boundary(request.to, "end")); }
    const after = request.cursor === undefined ? undefined : parseCursor(request.cursor);
    if (after) { where.push("(e.at_ms < ? OR (e.at_ms = ? AND e.seq < ?))"); values.push(after.ms, after.ms, after.seq); }
    const rows = this.db.prepare(`SELECT e.* FROM entries e WHERE ${where.join(" AND ")} ORDER BY e.at_ms DESC, e.seq DESC LIMIT ?`)
      .all(...values, request.limit + 1) as unknown as EntryRow[];
    const page = rows.slice(0, request.limit);
    const sessions = new Map<string, AssistantSessionInfo>();
    const hits: AssistantSearchHit[] = page.map((row) => {
      let session = sessions.get(row.session_id);
      if (!session) { session = this.session(row.session_id); sessions.set(row.session_id, session); }
      return { session: saidIn(session, row), entryId: row.entry_id, at: row.at, kind: row.kind as AssistantEntryKind, snippet: snippet(row.search_text, terms) };
    });
    const last = page.at(-1);
    return { hits, ...(rows.length > request.limit && last ? { nextCursor: encodeCursor(last.at_ms, last.seq) } : {}) };
  }

  /** The entry with what came before it on its branch and what followed on the latest branch after it. */
  context(request: AssistantContextRequest): AssistantContextResult {
    const byId = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND entry_id = ?");
    const latestChild = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND parent_id = ? ORDER BY seq DESC LIMIT 1");
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
    const latest = kept.at(-1)!;
    return { session: saidIn(this.session(request.sessionId), latest), entries: kept.map((row) => entries.get(row)!.entry), hasBefore, hasAfter };
  }

  private session(sessionId: string): AssistantSessionInfo {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as unknown as SessionRow;
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

function encodeCursor(ms: number, seq: number): string { return Buffer.from(JSON.stringify([ms, seq])).toString("base64url"); }
function parseCursor(cursor: string): { ms: number; seq: number } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((item) => Number.isSafeInteger(item))) return { ms: value[0] as number, seq: value[1] as number };
  } catch { /* reported below */ }
  throw new AssistantError("invalid_request", "这个续读位置不是这次搜索给出的，请重新搜索。");
}
