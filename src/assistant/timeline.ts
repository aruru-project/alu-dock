import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

import {
  AssistantError,
  type AssistantEpisode,
  type AssistantEpisodeState,
  type AssistantMemoryAuthor,
  type AssistantTimelineList,
  type AssistantTimelineListRequest,
  type AssistantTimelineUpdateRequest,
} from "../core/assistant.js";
import { sessionInfoOf, timeBoundary, type SessionRow } from "./store.js";
import { readTransaction, writeTransaction } from "./transaction.js";

/*
 * Her timeline (card #295): one line per stretch of a conversation saying what the two of them were
 * doing or talking about, kept beside her memories in the conversations' database (store.ts holds
 * the layout). Extraction writes it as it reads a conversation (extraction.ts): it extends a
 * session's last line while the same day's doings go on and adds one when the day or the subject
 * changes. The timeline judges nothing and says what she was working on even when no memory came of
 * it: it is what she turns to for "what were we up to that day", and its latest week is loaded into
 * every new session.
 *
 * A line's time is the first and last entry it covers, as they were said, and the first entry is
 * where its words can be read from. Nothing is deleted: a line the owner does not want is `forgotten`
 * and can be restored; forgetting a line leaves the words it covers as they are. Forgetting a memory
 * forgets the lines covering words it came from, since a line may tell the same thing, and restoring
 * the memory brings back those no other forgotten memory still holds (episodes_forgotten_with).
 * Extraction never rewrites a line the owner changed last.
 */

export interface EpisodeRow {
  id: number;
  session_id: string;
  from_row: number;
  from_at: string;
  from_ms: number;
  to_at: string;
  to_ms: number;
  text: string;
  state: string;
  author: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/** An end of the stretch a line covers: the entry's row and when it was said. */
export interface EpisodeBound { row: number; at: string; at_ms: number }

const NOT_FOUND = "没有找到时间线上的这一行。它的编号可能写错了。";
const CHANGED = "时间线上的这一行刚被改过，这次没有改动。请重新读一遍再改。";

export class AssistantTimeline {
  constructor(private readonly db: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  /** Newest first by when each stretch began; a time range lists every line overlapping it. */
  list(request: AssistantTimelineListRequest): AssistantTimelineList {
    const conditions = ["state = ?"];
    const values: SQLInputValue[] = [request.state ?? "active"];
    if (request.from !== undefined) { conditions.push("to_ms >= ?"); values.push(timeBoundary(request.from, "start")); }
    if (request.to !== undefined) { conditions.push("from_ms < ?"); values.push(timeBoundary(request.to, "end")); }
    for (const term of (request.query ?? "").trim().split(/\s+/u).filter((word) => word.length > 0)) {
      conditions.push("text LIKE ? ESCAPE '\\'");
      values.push(`%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
    }
    if (request.cursor !== undefined) {
      const after = parseCursor(request.cursor);
      conditions.push("(from_ms < ? OR (from_ms = ? AND id < ?))");
      values.push(after.ms, after.ms, after.id);
    }
    return readTransaction(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM episodes WHERE ${conditions.join(" AND ")} ORDER BY from_ms DESC, id DESC LIMIT ?`)
        .all(...values, request.limit + 1) as unknown as EpisodeRow[];
      const page = rows.slice(0, request.limit);
      const last = page.at(-1);
      return { episodes: page.map((row) => this.episodeOf(row)), ...(rows.length > request.limit && last ? { nextCursor: encodeCursor(last.from_ms, last.id) } : {}) };
    });
  }

  get(id: string): AssistantEpisode {
    return readTransaction(this.db, () => this.episodeOf(this.row(Number(id))));
  }

  /** The lines in use reaching past `sinceMs`, oldest first, the newest `limit` of them: what a session loads. */
  recent(sinceMs: number, limit: number): AssistantEpisode[] {
    return readTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM episodes WHERE state = 'active' AND to_ms >= ? ORDER BY from_ms DESC, id DESC LIMIT ?").all(sinceMs, limit) as unknown as EpisodeRow[];
      return rows.reverse().map((row) => this.episodeOf(row));
    });
  }

  /** One session's latest lines in use, oldest first: what extraction may extend. */
  latestOf(sessionId: string, limit: number): EpisodeRow[] {
    return (this.db.prepare("SELECT * FROM episodes WHERE session_id = ? AND state = 'active' ORDER BY to_ms DESC, id DESC LIMIT ?").all(sessionId, limit) as unknown as EpisodeRow[]).reverse();
  }

  /**
   * The owner's or the assistant's change: rewrite a line, forget it or restore it. Forgetting or
   * restoring it by hand is the final word on it: restoring a memory no longer brings it back.
   */
  update(request: AssistantTimelineUpdateRequest, author: AssistantMemoryAuthor): AssistantEpisode {
    return writeTransaction(this.db, () => {
      const row = this.row(Number(request.id));
      if (row.revision !== request.revision) throw new AssistantError("assistant_episode_changed", CHANGED);
      if (request.state !== undefined) this.db.prepare("DELETE FROM episodes_forgotten_with WHERE episode_id = ?").run(row.id);
      return this.episodeOf(this.change(row, { text: request.text, state: request.state }, author));
    });
  }

  /** Inside a write: a new line covering `from` through `to`. */
  insert(sessionId: string, from: EpisodeBound, to: EpisodeBound, text: string, author: AssistantMemoryAuthor): EpisodeRow {
    const at = this.now().toISOString();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO episodes (session_id, from_row, from_at, from_ms, to_at, to_ms, text, state, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)")
      .run(sessionId, from.row, from.at, from.at_ms, to.at, to.at_ms, text, author, at, at);
    return this.row(Number(lastInsertRowid));
  }

  /** Inside a write: the line changed; `from` and `to` only widen what it covers. The revision goes up once. */
  change(row: EpisodeRow, change: { text?: string; state?: AssistantEpisodeState; from?: EpisodeBound; to?: EpisodeBound }, author: AssistantMemoryAuthor): EpisodeRow {
    const from = change.from !== undefined && change.from.at_ms < row.from_ms ? change.from : { row: row.from_row, at: row.from_at, at_ms: row.from_ms };
    const to = change.to !== undefined && change.to.at_ms > row.to_ms ? change.to : { at: row.to_at, at_ms: row.to_ms };
    const text = change.text ?? row.text;
    const state = change.state ?? row.state;
    if (text === row.text && state === row.state && from.at_ms === row.from_ms && to.at_ms === row.to_ms) return row;
    this.db.prepare("UPDATE episodes SET text = ?, state = ?, from_row = ?, from_at = ?, from_ms = ?, to_at = ?, to_ms = ?, author = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(text, state, from.row, from.at, from.at_ms, to.at, to.at_ms, author, this.now().toISOString(), row.id);
    return this.row(row.id);
  }

  /** The row; refuses a number that names no line. */
  row(id: number): EpisodeRow {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as unknown as EpisodeRow | undefined;
    if (!row) throw new AssistantError("assistant_episode_not_found", NOT_FOUND);
    return row;
  }

  private sessionStatement: StatementSync | undefined;
  private entryStatement: StatementSync | undefined;
  episodeOf(row: EpisodeRow): AssistantEpisode {
    this.sessionStatement ??= this.db.prepare("SELECT * FROM sessions WHERE session_id = ?");
    this.entryStatement ??= this.db.prepare("SELECT entry_id FROM entries WHERE id = ?");
    const session = this.sessionStatement.get(row.session_id) as unknown as SessionRow;
    const first = this.entryStatement.get(row.from_row) as { entry_id: string };
    return {
      id: String(row.id),
      session: sessionInfoOf(session),
      entryId: first.entry_id,
      fromAt: row.from_at,
      toAt: row.to_at,
      text: row.text,
      state: row.state as AssistantEpisodeState,
      author: row.author as AssistantMemoryAuthor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    };
  }
}

/**
 * Inside a write, as memory `memoryId` is forgotten at `at`: forgets the lines in use covering words it
 * came from and notes which it took; a line another forgotten memory took is noted for this one too.
 */
export function forgetLinesWith(db: DatabaseSync, memoryId: number, at: string): void {
  const lines = db.prepare(`SELECT DISTINCT p.id, p.state FROM episodes p
    JOIN entries e ON e.session_id = p.session_id AND e.at_ms BETWEEN p.from_ms AND p.to_ms
    WHERE e.id IN (SELECT entry_row FROM memory_sources WHERE memory_id = ?)
      AND (p.state = 'active' OR EXISTS (SELECT 1 FROM episodes_forgotten_with w WHERE w.episode_id = p.id))`).all(memoryId) as Array<{ id: number; state: string }>;
  const note = db.prepare("INSERT OR IGNORE INTO episodes_forgotten_with (memory_id, episode_id) VALUES (?, ?)");
  const forget = db.prepare("UPDATE episodes SET state = 'forgotten', updated_at = ?, revision = revision + 1 WHERE id = ?");
  for (const line of lines) {
    note.run(memoryId, line.id);
    if (line.state === "active") forget.run(at, line.id);
  }
}

/** Inside a write, as memory `memoryId` comes back at `at`: brings back the lines it took that no other forgotten memory holds. */
export function restoreLinesWith(db: DatabaseSync, memoryId: number, at: string): void {
  const lines = db.prepare("SELECT episode_id FROM episodes_forgotten_with WHERE memory_id = ?").all(memoryId) as Array<{ episode_id: number }>;
  db.prepare("DELETE FROM episodes_forgotten_with WHERE memory_id = ?").run(memoryId);
  const restore = db.prepare(`UPDATE episodes SET state = 'active', updated_at = ?1, revision = revision + 1
    WHERE id = ?2 AND state = 'forgotten' AND NOT EXISTS (SELECT 1 FROM episodes_forgotten_with WHERE episode_id = ?2)`);
  for (const line of lines) restore.run(at, line.episode_id);
}

function encodeCursor(ms: number, id: number): string { return Buffer.from(`t${ms}:${id}`).toString("base64url"); }
function parseCursor(cursor: string): { ms: number; id: number } {
  const match = /^t(-?[0-9]{1,16}):([1-9][0-9]{0,14})$/u.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new AssistantError("invalid_request", "这个续读位置不是这次列出时给出的，请重新列出。");
  return { ms: Number(match[1]), id: Number(match[2]) };
}
