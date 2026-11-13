import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  ASSISTANT_SPOKEN_KINDS,
  ASSISTANT_TOOL_NAMES,
  AssistantError,
  MAX_ASSISTANT_FORGOTTEN_ENTRIES,
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
  through_entry_id TEXT,
  -- Extraction: the last entry row read for memories, the characters said (see SPOKEN) recorded since,
  -- and when (Main's clock) the latest entry arrived.
  extracted_through INTEGER NOT NULL DEFAULT 0,
  waiting_chars INTEGER NOT NULL DEFAULT 0,
  recorded_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  entry_id TEXT NOT NULL, parent_id TEXT,
  at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  work_id TEXT, machine TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, tool_calls TEXT, truncated INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL,
  -- How many forgotten memories name this entry as where they were said; while any do, it is not found.
  forgotten INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_parent ON entries (session_id, parent_id, id);
CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (search_text, content = 'entries', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS entries_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_delete AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL, text TEXT NOT NULL, resident INTEGER NOT NULL,
  state TEXT NOT NULL, author TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER,
  -- The owner chose whether it is loaded every session; the background passes leave that as it is.
  resident_fixed INTEGER NOT NULL DEFAULT 0,
  -- When it was said: the earliest place it was said, or when it was written without one.
  said_at TEXT NOT NULL, said_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_state ON memories (state, id);
CREATE INDEX IF NOT EXISTS memories_said ON memories (state, said_ms);
-- Her timeline: one line per stretch of a conversation, from the first entry it covers (from_row) to the last.
-- Its ID is never used again once removed: a client or a session may still name it.
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  from_row INTEGER NOT NULL REFERENCES entries(id),
  from_at TEXT NOT NULL, from_ms INTEGER NOT NULL,
  to_at TEXT NOT NULL, to_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL, author TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  -- The owner or she changed it by hand at some point, even if extraction extended it since; starting over keeps it.
  edited INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodes_time ON episodes (state, from_ms, id);
CREATE INDEX IF NOT EXISTS episodes_session ON episodes (session_id, state, to_ms);
-- Timeline lines forgotten along with a memory because they cover words it came from; restoring the
-- memory brings back those no other forgotten memory still holds.
CREATE TABLE IF NOT EXISTS episodes_forgotten_with (
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  PRIMARY KEY (memory_id, episode_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS episodes_forgotten_with_episode ON episodes_forgotten_with (episode_id);
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  entry_row INTEGER NOT NULL REFERENCES entries(id),
  PRIMARY KEY (memory_id, entry_row)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_sources_entry ON memory_sources (entry_row);
-- Entries hidden with a forgotten memory besides the places it was said: what was said in answer to
-- those places, the exchange in which the owner asked for it to be forgotten, and the summaries Pi
-- wrote of those conversations afterwards. The rows last while the memory stays forgotten.
CREATE TABLE IF NOT EXISTS memory_hides (
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  entry_row INTEGER NOT NULL REFERENCES entries(id),
  PRIMARY KEY (memory_id, entry_row)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_hides_entry ON memory_hides (entry_row);
-- Where the owner asked for a memory to be forgotten, when Main had not recorded that entry yet: the
-- exchange is hidden as it arrives.
CREATE TABLE IF NOT EXISTS memory_asks (
  session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  PRIMARY KEY (session_id, entry_id, memory_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_changes (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  at TEXT NOT NULL, author TEXT NOT NULL, action TEXT NOT NULL, text TEXT
);
CREATE INDEX IF NOT EXISTS memory_changes_memory ON memory_changes (memory_id, id);
-- Parts of a conversation, after_row to through_row, that extraction passed over because the model's
-- answers could not be read; due once a newly chosen model is to read them again.
CREATE TABLE IF NOT EXISTS skipped_parts (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  after_row INTEGER NOT NULL, through_row INTEGER NOT NULL,
  due INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('max_shift_ms', '0');
`;
/** The database layout this code reads and writes; a newer one is refused rather than misread. */
const SCHEMA_VERSION = "1";

/**
 * The entries that are words said, by the owner, by her or by another Work, as an SQL condition on
 * `entries`: what her memories and timeline are made from (ASSISTANT_SPOKEN_KINDS).
 */
export const SPOKEN = `kind IN (${ASSISTANT_SPOKEN_KINDS.map((kind) => `'${kind}'`).join(", ")}) AND text <> ''`;

/**
 * What is said or done in answer within an exchange, as an SQL condition on `entries`: her words, what
 * her tools returned and the notices between them. They follow the words they answer: while those are
 * forgotten, the answers are not found either, since they tell the same thing. The owner's next
 * words, another Work's, or a command the owner ran start a new exchange.
 */
export const ANSWER = "kind IN ('assistant', 'tool_result', 'notice')";
const ANSWER_KINDS = new Set<AssistantEntryKind>(["assistant", "tool_result", "notice"]);
/**
 * Inside a write: notes that something was forgotten just now, a memory with what it hides or a
 * timeline line. A background pass that was shown things before this happened may have been shown
 * the very thing, so it keeps nothing of what it made and reads again (extraction.ts).
 */
export function noteForgetting(db: DatabaseSync): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('forgettings', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
}
/** How many times something was forgotten so far. */
export function forgettings(db: DatabaseSync): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'forgettings'").get() as { value: string } | undefined)?.value ?? 0);
}

/** The entries a forgotten memory hides, as an SQL list of entry rows for the memory bound as ?1. */
export const HIDDEN_WITH = "SELECT entry_row FROM memory_sources WHERE memory_id = ?1 UNION SELECT entry_row FROM memory_hides WHERE memory_id = ?1";

/** Room for entries said in the same millisecond. */
const ENTRY_IDS_PER_MS = 1024;
const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** Pieces shorter than this cannot use the three-character index and are checked row by row. */
const INDEXED_TERM_CHARS = 3;
/** Rows one step of a search reads before it checks its deadline again. */
const SCAN_WINDOW = 5_000;
const FORGOTTEN_TEXT = "（这一条里的事主人让我忘掉了。）";
const TIMEOUT_MESSAGE = "这次查询超时，没有返回结果。请换个更具体的词，或者缩小时间范围再试。";

export interface EntryRow {
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
  forgotten: number;
}

export interface SessionRow {
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

  /** The writing connection, shared with her memories (memories.ts), her timeline and extraction, which keep their rows beside the conversations. */
  get connection(): DatabaseSync { return this.db; }

  /** The last entry of the Agent's session recorded so far, kept or not. */
  recorded(sessionId: string): { lastEntryId?: string } {
    const row = this.db.prepare("SELECT through_entry_id FROM sessions WHERE session_id = ?").get(sessionId) as { through_entry_id: string | null } | undefined;
    return row?.through_entry_id ? { lastEntryId: row.through_entry_id } : {};
  }

  /** The entries of a session hidden with a forgotten memory, newest first, from `fromEntryId` on. */
  forgotten(sessionId: string, fromEntryId?: string): { entryIds: string[]; revision: number } {
    const from = fromEntryId === undefined ? undefined
      : this.db.prepare("SELECT id FROM entries WHERE session_id = ? AND entry_id = ?").get(sessionId, fromEntryId) as { id: number } | undefined;
    const rows = this.db.prepare("SELECT entry_id FROM entries WHERE session_id = ? AND id >= ? AND forgotten > 0 ORDER BY id DESC LIMIT ?")
      .all(sessionId, from?.id ?? Number.MIN_SAFE_INTEGER, MAX_ASSISTANT_FORGOTTEN_ENTRIES) as Array<{ entry_id: string }>;
    return { entryIds: rows.map((row) => row.entry_id), revision: forgettings(this.db) };
  }

  /** Keeps a batch; an entry already kept stays as it was, so a batch sent twice changes nothing. */
  record(session: AssistantRecordSession, entries: readonly AssistantEntry[], throughEntryId: string, source: AssistantSource): { lastEntryId: string } {
    const now = new Date().toISOString();
    const times = entries.map((entry) => ({ at: entry.at, ms: Date.parse(entry.at) }));
    const first = times.reduce((earliest, time) => (time.ms < earliest.ms ? time : earliest), times[0] ?? { at: now, ms: Date.parse(now) });
    const last = times.reduce((latest, time) => (time.ms > latest.ms ? time : latest), first);
    // A batch without entries only moves the mark: a session's times are those of what was said in it.
    const moveTimes = entries.length === 0 ? "" : `
          started_at = CASE WHEN excluded.started_ms < started_ms THEN excluded.started_at ELSE started_at END,
          started_ms = min(started_ms, excluded.started_ms),
          last_at = CASE WHEN excluded.last_ms > last_ms THEN excluded.last_at ELSE last_at END,
          last_ms = max(last_ms, excluded.last_ms),`;
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
          machine = coalesce(excluded.machine, machine),${moveTimes}
          through_entry_id = excluded.through_entry_id
      `).run(session.sessionId, session.sessionFile ?? null, session.cwd, session.name ?? null, source.workId ?? null, source.machine ?? null,
        first.at, first.ms, last.at, last.ms, throughEntryId);
      const known = this.db.prepare("SELECT id, forgotten, kind FROM entries WHERE session_id = ? AND entry_id = ?");
      const latestIn = this.db.prepare("SELECT max(id) AS id FROM entries WHERE id >= ? AND id < ?");
      const insert = this.db.prepare(`
        INSERT INTO entries (id, session_id, entry_id, parent_id, at, at_ms, work_id, machine, kind, text, tool_name, tool_calls, truncated, search_text, forgotten)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const hide = this.db.prepare("INSERT OR IGNORE INTO memory_hides (memory_id, entry_row) VALUES (?, ?)");
      let shift = 0;
      let waiting = 0;
      let inserted = 0;
      for (const entry of entries) {
        if (known.get(session.sessionId, entry.entryId)) continue;
        // A parent this session has not kept, such as history before a resume, is not named.
        const parent = entry.parentId === undefined ? undefined : known.get(session.sessionId, entry.parentId) as { id: number; forgotten: number; kind: string } | undefined;
        const ms = Date.parse(entry.at);
        const id = this.nextId(latestIn, ms);
        shift = Math.max(shift, Math.floor(id / ENTRY_IDS_PER_MS) - ms);
        const searched = searchText(entry);
        const hiding = this.hidingMemories(session.sessionId, entry, parent);
        if (ASSISTANT_SPOKEN_KINDS.includes(entry.kind) && entry.text.length > 0) waiting += entry.text.length;
        inserted += 1;
        insert.run(id, session.sessionId, entry.entryId, parent ? entry.parentId! : null, entry.at, ms, source.workId ?? null, source.machine ?? null,
          entry.kind, entry.text, entry.toolName ?? null, entry.toolCalls === undefined ? null : JSON.stringify(entry.toolCalls), entry.truncated ? 1 : 0, searched, hiding.length);
        for (const memoryId of hiding) hide.run(memoryId, id);
      }
      // Anything said or done keeps the conversation going; only words said wait to be read.
      if (inserted > 0) this.db.prepare("UPDATE sessions SET waiting_chars = waiting_chars + ?, recorded_ms = ? WHERE session_id = ?").run(waiting, Date.now(), session.sessionId);
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
   * The forgotten memories a new entry is hidden with, as it arrives, by the rules memories.ts hides
   * the entries already there with: an answer follows the words it answers, but not a summary, which
   * is hidden for what its conversation said before and says nothing of what comes after; a summary
   * repeats whatever its conversation said before it; and the exchange the owner asked in, named
   * before it was recorded, is hidden now.
   */
  private hidingMemories(sessionId: string, entry: AssistantEntry, parent: { id: number; forgotten: number; kind: string } | undefined): number[] {
    let rows: Array<{ id: number }> = [];
    if (ANSWER_KINDS.has(entry.kind) && parent !== undefined && parent.forgotten > 0 && parent.kind !== "summary") {
      rows = this.db.prepare(`SELECT s.memory_id AS id FROM memory_sources s JOIN memories m ON m.id = s.memory_id WHERE s.entry_row = ?1 AND m.state = 'forgotten'
        UNION SELECT memory_id FROM memory_hides WHERE entry_row = ?1`).all(parent.id) as Array<{ id: number }>;
    } else if (entry.kind === "summary" && this.db.prepare("SELECT 1 FROM entries WHERE session_id = ? AND forgotten > 0 LIMIT 1").get(sessionId)) {
      rows = this.db.prepare(`SELECT s.memory_id AS id FROM memory_sources s JOIN memories m ON m.id = s.memory_id JOIN entries e ON e.id = s.entry_row
          WHERE e.session_id = ?1 AND m.state = 'forgotten'
        UNION SELECT h.memory_id FROM memory_hides h JOIN entries e ON e.id = h.entry_row WHERE e.session_id = ?1`).all(sessionId) as Array<{ id: number }>;
    }
    const asked = this.db.prepare("SELECT memory_id AS id FROM memory_asks WHERE session_id = ? AND entry_id = ?").all(sessionId, entry.entryId) as Array<{ id: number }>;
    if (asked.length > 0) this.db.prepare("DELETE FROM memory_asks WHERE session_id = ? AND entry_id = ?").run(sessionId, entry.entryId);
    return [...new Set([...rows, ...asked].map((row) => row.id))];
  }

  /**
   * Newest first by when each entry was said; every word must occur. Without words, everything in the
   * time range. Past `deadline` (a Date.now() time) it stops between steps and refuses with
   * assistant_query_timeout. The whole search reads one snapshot of the memory.
   */
  search(request: AssistantSearchRequest, deadline = Number.POSITIVE_INFINITY): AssistantSearchResult {
    if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
    return this.snapshot(() => this.searchSnapshot(request, deadline));
  }

  /**
   * The walk goes down the IDs, which are in time order except that an entry of a full millisecond
   * sits up to `shift` milliseconds late. Every entry not yet reached was said no later than the
   * millisecond of the current position, so an entry reached is handed out once its own time is at or
   * past that; until then it waits, and the hits come out in (time, ID) order. The cursor is that pair.
   */
  private searchSnapshot(request: AssistantSearchRequest, deadline: number): AssistantSearchResult {
    const terms = (request.query ?? "").trim().split(/\s+/u).filter((term) => term.length > 0);
    const indexed = terms.filter((term) => [...term].length >= INDEXED_TERM_CHARS);
    const short = terms.filter((term) => [...term].length < INDEXED_TERM_CHARS);
    const shift = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'max_shift_ms'").get() as { value: string }).value);
    const fromMs = request.from === undefined ? undefined : timeBoundary(request.from, "start");
    const toMs = request.to === undefined ? undefined : timeBoundary(request.to, "end");
    const after = request.cursor === undefined ? undefined : parseCursor(request.cursor);
    const lowest = fromMs === undefined ? Number.MIN_SAFE_INTEGER : idAt(fromMs);
    let position = Math.min(
      toMs === undefined ? Number.MAX_SAFE_INTEGER : idAt(toMs + shift),
      after === undefined ? Number.MAX_SAFE_INTEGER : idAt(after.ms + 1 + shift),
    );
    const filters = [
      "e.forgotten = 0",
      ...(fromMs === undefined ? [] : ["e.at_ms >= ?"]),
      ...(toMs === undefined ? [] : ["e.at_ms < ?"]),
      ...(after === undefined ? [] : ["(e.at_ms < ? OR (e.at_ms = ? AND e.id < ?))"]),
      ...short.map(() => "e.search_text LIKE ? ESCAPE '\\'"),
    ];
    const filterValues: SQLInputValue[] = [
      ...(fromMs === undefined ? [] : [fromMs]),
      ...(toMs === undefined ? [] : [toMs]),
      ...(after === undefined ? [] : [after.ms, after.ms, after.id]),
      ...short.map((term) => `%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`),
    ];
    const conditions = filters.map((condition) => `AND ${condition}`).join(" ");
    const expression = indexed.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
    const wanted = request.limit + 1;
    // With only indexed words the index is followed alone; otherwise SCAN_WINDOW rows at a time.
    const indexOnly = indexed.length > 0 && short.length === 0;
    const step = indexed.length > 0
      ? this.db.prepare(`SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ${conditions} ORDER BY f.rowid DESC LIMIT ?`)
      : this.db.prepare(`SELECT e.* FROM entries e WHERE e.id >= ? AND e.id < ? AND e.search_text <> '' ${conditions} ORDER BY e.id DESC LIMIT ?`);
    const windowEnd = this.db.prepare("SELECT id FROM entries WHERE id >= ? AND id < ? ORDER BY id DESC LIMIT 1 OFFSET ?");
    const hits: EntryRow[] = [];
    let waiting: EntryRow[] = [];
    for (;;) {
      if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
      const end = indexOnly ? undefined : windowEnd.get(lowest, position, SCAN_WINDOW - 1) as { id: number } | undefined;
      const low = end?.id ?? lowest;
      const rows = (indexed.length > 0 ? step.all(expression, low, position, ...filterValues, wanted) : step.all(low, position, ...filterValues, wanted)) as unknown as EntryRow[];
      // Everything from here down is still to be read, unless this step reached the bottom.
      const reachedBottom = rows.length < wanted && end === undefined;
      position = rows.length === wanted ? rows.at(-1)!.id : low;
      // Only the best entries this page can still use wait; the rest come back on the next page.
      waiting = waiting.concat(rows).sort(newestFirst).slice(0, wanted - hits.length);
      const ready = reachedBottom ? waiting.length : waiting.findIndex((row) => row.at_ms < Math.floor((position - 1) / ENTRY_IDS_PER_MS));
      const count = ready < 0 ? waiting.length : ready;
      for (const row of waiting.slice(0, count)) hits.push(row);
      waiting = waiting.slice(count);
      if (hits.length >= wanted || reachedBottom || position <= lowest) break;
    }
    for (const row of waiting) hits.push(row);
    const page = hits.slice(0, request.limit);
    const sessions = new Map<string, AssistantSessionInfo>();
    const result: AssistantSearchHit[] = page.map((row) => {
      let session = sessions.get(row.session_id);
      if (!session) { session = this.session(row.session_id); sessions.set(row.session_id, session); }
      return { session: saidIn(session, row), entryId: row.entry_id, at: row.at, kind: row.kind as AssistantEntryKind, snippet: snippet(row.search_text, terms) };
    });
    const last = page.at(-1);
    return { hits: result, ...(hits.length > request.limit && last ? { nextCursor: encodeCursor(last.at_ms, last.id) } : {}) };
  }

  /**
   * Runs reads in one transaction, so they all see the same committed state. The transaction must end
   * to let go of that state; if it cannot be ended, the connection is closed and `broken` set, and the
   * reading thread is replaced.
   */
  private snapshot<T>(read: () => T): T {
    this.db.exec("BEGIN");
    let result: T;
    try {
      result = read();
    } catch (error) {
      // The read's own failure is the one to report; `broken` still tells the thread to go.
      try { this.end(); } catch { /* reported through broken */ }
      throw error;
    }
    this.end();
    return result;
  }

  /** Whether this connection had to be closed because a read transaction would not end. */
  broken = false;

  private end(): void {
    try { this.db.exec("COMMIT"); } catch { /* tried again below */ }
    if (!this.db.isTransaction) return;
    try { this.db.exec("ROLLBACK"); } catch { /* checked below */ }
    if (!this.db.isTransaction) return;
    this.broken = true;
    try { this.db.close(); } catch { /* closing is all that is left */ }
    throw new AssistantError("assistant_unavailable", "A memory reader could not end its read and is being replaced");
  }

  /** The entry with what came before it on its branch and what followed on the latest branch after it; at most about 2 × 50 lookups. */
  context(request: AssistantContextRequest, deadline = Number.POSITIVE_INFINITY): AssistantContextResult {
    if (Date.now() > deadline) throw new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE);
    return this.snapshot(() => this.contextSnapshot(request));
  }

  private contextSnapshot(request: AssistantContextRequest): AssistantContextResult {
    const byId = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND entry_id = ?");
    const latestChild = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND parent_id = ? ORDER BY at_ms DESC, id DESC LIMIT 1");
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
    return sessionInfoOf(this.sessionStatement.get(sessionId) as unknown as SessionRow);
  }
}

/** A recorded session as the asker sees it. */
export function sessionInfoOf(row: SessionRow): AssistantSessionInfo {
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

/** An entry as she reads it; one said where a forgotten memory came from shows only that it was forgotten. */
export function entryOf(row: EntryRow): AssistantEntry {
  if (row.forgotten > 0) {
    return { entryId: row.entry_id, ...(row.parent_id === null ? {} : { parentId: row.parent_id }), at: row.at, kind: row.kind as AssistantEntryKind, text: FORGOTTEN_TEXT };
  }
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
 * includes that day. The same reading serves the time ranges of memories and the timeline.
 */
export function timeBoundary(value: string, side: "start" | "end"): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  // A full time is included as given.
  if (!day) return side === "start" ? Date.parse(value) : Date.parse(value) + 1;
  const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  return side === "start" ? start : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1).getTime();
}

/** Later said first; among entries of one millisecond, the later ID first. */
function newestFirst(left: EntryRow, right: EntryRow): number {
  return right.at_ms - left.at_ms || right.id - left.id;
}

function encodeCursor(ms: number, id: number): string { return Buffer.from(`${ms}:${id}`).toString("base64url"); }
function parseCursor(cursor: string): { ms: number; id: number } {
  const [ms, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split(":").map(Number);
  if (extra === undefined && Number.isSafeInteger(ms) && Number.isSafeInteger(id)) return { ms: ms!, id: id! };
  throw new AssistantError("invalid_request", "这个续读位置不是这次搜索给出的，请重新搜索。");
}
