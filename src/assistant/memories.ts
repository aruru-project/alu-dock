import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  AssistantError,
  MAX_ASSISTANT_MEMORY_HISTORY,
  MAX_ASSISTANT_MEMORY_SOURCES,
  type AssistantMemory,
  type AssistantMemoryAction,
  type AssistantMemoryAddRequest,
  type AssistantMemoryAuthor,
  type AssistantMemoryDetail,
  type AssistantMemoryList,
  type AssistantMemoryListRequest,
  type AssistantMemoryState,
  type AssistantMemoryTopic,
  type AssistantMemoryUpdateRequest,
} from "../core/assistant.js";
import { ANSWER, HIDDEN_WITH, noteForgetting, timeBoundary } from "./store.js";
import { forgetLinesWith, restoreLinesWith } from "./timeline.js";
import { readTransaction, writeTransaction } from "./transaction.js";

/*
 * Her memories, kept in the same database as the conversations they came from (store.ts holds the
 * layout). Nothing is ever deleted: a memory set aside is `retired`, one the owner wants gone is
 * `forgotten`, and both can be restored. While a memory is forgotten, the entries it names as where
 * it was said are not found by searches either, and read as forgotten (entries.forgotten counts
 * the forgotten memories hiding each entry). So are the entries that tell the same thing by their
 * place in the conversation (memory_hides): what was said in answer to those places, the exchange
 * in which the owner asked her to forget it, and the summaries Pi wrote of those conversations
 * afterwards. The timeline lines covering those words are forgotten with it and come back with it
 * (timeline.ts). Other places where the same thing happens to be said stay as they are; a forgotten
 * memory stays on record so that the background does not make it again (extraction.ts).
 *
 * A memory is dated by when it was said: the earliest place it was said, kept up to date as places
 * are added; one written without a place is dated when it was written.
 *
 * Every change is one transaction on the writing connection and leaves a line in memory_changes.
 */

export interface MemoryRow {
  id: number;
  topic: string;
  text: string;
  resident: number;
  state: string;
  author: string;
  created_at: string;
  updated_at: string;
  revision: number;
  superseded_by: number | null;
  resident_fixed: number;
  said_at: string;
  said_ms: number;
}

const NOT_FOUND = "没有找到这条记忆。它的编号可能写错了。";
const CHANGED = "这条记忆刚被改过，这次没有改动。请重新读一遍再改。";

export class AssistantMemories {
  constructor(private readonly db: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  /** Newest first. */
  list(request: AssistantMemoryListRequest): AssistantMemoryList {
    const conditions = ["state = ?"];
    const values: SQLInputValue[] = [request.state ?? "active"];
    if (request.topic !== undefined) { conditions.push("topic = ?"); values.push(request.topic); }
    if (request.resident !== undefined) { conditions.push("resident = ?"); values.push(request.resident ? 1 : 0); }
    if (request.author !== undefined) { conditions.push("author = ?"); values.push(request.author); }
    if (request.from !== undefined) { conditions.push("said_ms >= ?"); values.push(timeBoundary(request.from, "start")); }
    if (request.to !== undefined) { conditions.push("said_ms < ?"); values.push(timeBoundary(request.to, "end")); }
    for (const term of (request.query ?? "").trim().split(/\s+/u).filter((word) => word.length > 0)) {
      conditions.push("text LIKE ? ESCAPE '\\'");
      values.push(`%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
    }
    if (request.cursor !== undefined) { conditions.push("id < ?"); values.push(parseCursor(request.cursor)); }
    return this.read(() => {
      const rows = this.db.prepare(`SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`)
        .all(...values, request.limit + 1) as unknown as MemoryRow[];
      const page = rows.slice(0, request.limit);
      return { memories: page.map((row) => this.memoryOf(row)), ...(rows.length > request.limit ? { nextCursor: encodeCursor(page.at(-1)!.id) } : {}) };
    });
  }

  get(id: string): AssistantMemoryDetail {
    return this.read(() => {
      const row = this.row(Number(id));
      const history = this.db.prepare("SELECT at, author, action, text FROM memory_changes WHERE memory_id = ? ORDER BY id DESC LIMIT ?")
        .all(row.id, MAX_ASSISTANT_MEMORY_HISTORY) as Array<{ at: string; author: string; action: string; text: string | null }>;
      return {
        memory: this.memoryOf(row),
        history: history.map((change) => ({ at: change.at, author: change.author as AssistantMemoryAuthor, action: change.action as AssistantMemoryAction, ...(change.text === null ? {} : { text: change.text }) })),
      };
    });
  }

  /** What every new assistant session loads, grouped as listed by topic, oldest first within a topic. */
  resident(): AssistantMemory[] {
    return this.read(() => (this.db.prepare("SELECT * FROM memories WHERE state = 'active' AND resident = 1 ORDER BY id").all() as unknown as MemoryRow[]).map((row) => this.memoryOf(row)));
  }

  /** `sources` name entries by session and entry ID; `entryRows` are rows extraction already looked up. */
  add(request: AssistantMemoryAddRequest, author: AssistantMemoryAuthor, entryRows: readonly number[] = []): AssistantMemory {
    return this.write(() => {
      const rows = [...entryRows, ...(request.sources ?? []).map((source) => this.entryRow(source.sessionId, source.entryId))];
      return this.memoryOf(this.insert(request.topic, request.text, request.resident, author, rows, author === "owner"));
    });
  }

  /** `askedAt`: the entry in which the owner asked for this change; forgetting hides that exchange too. */
  update(request: AssistantMemoryUpdateRequest, author: AssistantMemoryAuthor, askedAt?: { sessionId: string; entryId: string }): AssistantMemory {
    return this.write(() => {
      const row = this.row(Number(request.id));
      if (row.revision !== request.revision) throw new AssistantError("assistant_memory_changed", CHANGED);
      if (request.state === "forgotten" && row.state !== "forgotten") {
        // What it said lives on in the memory it was merged into; forgetting it alone would leave that.
        const into = this.mergedInto(row);
        if (into?.state === "active") {
          throw new AssistantError("assistant_memory_merged", `这条记忆已经合并进 #${into.id}（“${into.text}”），只忘掉它的话，那一条里还留着同样的事。要忘掉，请忘掉 #${into.id}，或者把 #${into.id} 里的这部分改掉。这次没有改动。`);
        }
      }
      const asked = askedAt === undefined ? undefined
        : this.db.prepare("SELECT id FROM entries WHERE session_id = ? AND entry_id = ?").get(askedAt.sessionId, askedAt.entryId) as { id: number } | undefined;
      // An exchange Main has not recorded yet is noted, and hidden when it arrives (store.ts).
      if (askedAt !== undefined && !asked && request.state === "forgotten") {
        this.db.prepare("INSERT OR IGNORE INTO memory_asks (session_id, entry_id, memory_id) VALUES (?, ?, ?)").run(askedAt.sessionId, askedAt.entryId, row.id);
      }
      return this.memoryOf(this.change(row, { ...request, ...(asked ? { askedRow: asked.id } : {}) }, author));
    });
  }

  /** The entries a forgotten memory hides now. */
  private hidden(memoryId: number): Set<number> {
    return new Set((this.db.prepare(HIDDEN_WITH).all(memoryId) as Array<{ entry_row: number }>).map((row) => row.entry_row));
  }

  /**
   * Inside a write, as a memory is forgotten: notes what goes with the places it was said. That is
   * the exchange the owner asked in (`askedRow`), everything said in answer to any of these, on
   * every branch, and the summaries written of those conversations afterwards. A summary ends the
   * answers before it: what follows it is not hidden for it (store.ts keeps to the same rule for
   * entries that arrive later).
   */
  private hideWith(memoryId: number, askedRow: number | undefined): void {
    const note = this.db.prepare("INSERT OR IGNORE INTO memory_hides (memory_id, entry_row) VALUES (?, ?)");
    if (askedRow !== undefined) note.run(memoryId, askedRow);
    type Place = { id: number; session_id: string; entry_id: string };
    const places = this.db.prepare(`SELECT id, session_id, entry_id FROM entries WHERE id IN (${HIDDEN_WITH}) AND kind <> 'summary'`).all(memoryId) as unknown as Place[];
    const answers = this.db.prepare(`SELECT id, session_id, entry_id FROM entries WHERE session_id = ? AND parent_id = ? AND ${ANSWER}`);
    const seen = new Set(places.map((place) => place.id));
    for (let place = places.pop(); place !== undefined; place = places.pop()) {
      for (const answer of answers.all(place.session_id, place.entry_id) as unknown as Place[]) {
        if (seen.has(answer.id)) continue;
        seen.add(answer.id);
        note.run(memoryId, answer.id);
        places.push(answer);
      }
    }
    this.db.prepare(`INSERT OR IGNORE INTO memory_hides (memory_id, entry_row)
      SELECT ?1, s.id FROM entries s WHERE s.kind = 'summary' AND EXISTS (
        SELECT 1 FROM entries e WHERE e.session_id = s.session_id AND e.id < s.id AND e.kind <> 'summary' AND e.id IN (${HIDDEN_WITH}))`).run(memoryId);
  }

  /** The memory a merged one lives on in, following later merges; undefined for one never merged. */
  private mergedInto(row: MemoryRow): MemoryRow | undefined {
    let current = row;
    const seen = new Set<number>([row.id]);
    while (current.superseded_by !== null && !seen.has(current.superseded_by)) {
      seen.add(current.superseded_by);
      current = this.row(current.superseded_by);
    }
    return current === row ? undefined : current;
  }

  /** Runs `work` as one write transaction on the writing connection. */
  write<T>(work: () => T): T {
    return writeTransaction(this.db, work);
  }

  /** Inside `write`: a new memory naming `entryRows` as where it was said; `residentFixed` when the owner chose its loading. */
  insert(topic: AssistantMemoryTopic, text: string, resident: boolean, author: AssistantMemoryAuthor, entryRows: readonly number[], residentFixed = false): MemoryRow {
    const now = this.now();
    const at = now.toISOString();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO memories (topic, text, resident, state, author, created_at, updated_at, resident_fixed, said_at, said_ms) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)")
      .run(topic, text, resident ? 1 : 0, author, at, at, residentFixed ? 1 : 0, at, now.getTime());
    const id = Number(lastInsertRowid);
    this.addSources(id, entryRows);
    this.log(id, at, author, "added", text);
    return this.row(id);
  }

  /** Inside `write`: names more places a memory was said, and dates it by the earliest. */
  addSources(memoryId: number, entryRows: readonly number[]): void {
    if (entryRows.length === 0) return;
    const insert = this.db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, entry_row) VALUES (?, ?)");
    for (const entryRow of new Set(entryRows)) insert.run(memoryId, entryRow);
    const first = this.db.prepare("SELECT e.at, e.at_ms FROM memory_sources s JOIN entries e ON e.id = s.entry_row WHERE s.memory_id = ? ORDER BY e.at_ms LIMIT 1").get(memoryId) as { at: string; at_ms: number } | undefined;
    if (first) this.db.prepare("UPDATE memories SET said_at = ?, said_ms = ? WHERE id = ?").run(first.at, first.at_ms, memoryId);
  }

  /** Inside `write`: applies the changes `request` names and logs each; the revision goes up once. */
  change(row: MemoryRow, request: Omit<AssistantMemoryUpdateRequest, "id" | "revision"> & { supersededBy?: number; askedRow?: number }, author: AssistantMemoryAuthor): MemoryRow {
    const at = this.now().toISOString();
    const actions: Array<[AssistantMemoryAction, string | null]> = [];
    if (request.text !== undefined && request.text !== row.text) actions.push(["rewritten", request.text]);
    if (request.topic !== undefined && request.topic !== row.topic) actions.push(["moved", null]);
    // The owner choosing whether it is loaded counts even when it already was: from then on that choice is his.
    const ownerChoosesLoading = author === "owner" && request.resident !== undefined && row.resident_fixed === 0;
    if (request.resident !== undefined && (request.resident !== (row.resident === 1) || ownerChoosesLoading)) actions.push([request.resident ? "resident" : "query_only", null]);
    const state = request.state ?? row.state;
    if (state !== row.state) actions.push([request.supersededBy !== undefined ? "merged" : state === "active" ? "restored" : state as "retired" | "forgotten", null]);
    // The entries where a forgotten memory was said, and those that go with them, are hidden while
    // it stays forgotten, and the timeline lines telling of them go with it. Asked again to forget
    // what is forgotten already, the new request is hidden too: each entry counts once per memory.
    if (state === "forgotten" && (row.state !== "forgotten" || request.askedRow !== undefined)) {
      const counted = row.state === "forgotten" ? this.hidden(row.id) : new Set<number>();
      noteForgetting(this.db);
      this.hideWith(row.id, request.askedRow);
      const count = this.db.prepare("UPDATE entries SET forgotten = forgotten + 1 WHERE id = ?");
      for (const entryRow of this.hidden(row.id)) if (!counted.has(entryRow)) count.run(entryRow);
      forgetLinesWith(this.db, row.id, at);
    } else if (state !== "forgotten" && row.state === "forgotten") {
      this.db.prepare(`UPDATE entries SET forgotten = forgotten - 1 WHERE id IN (${HIDDEN_WITH})`).run(row.id);
      this.db.prepare("DELETE FROM memory_hides WHERE memory_id = ?").run(row.id);
      this.db.prepare("DELETE FROM memory_asks WHERE memory_id = ?").run(row.id);
      restoreLinesWith(this.db, row.id, at);
    }
    if (actions.length === 0) return row;
    this.db.prepare(`UPDATE memories SET text = ?, topic = ?, resident = ?, state = ?, author = ?, updated_at = ?, revision = revision + 1,
      superseded_by = ?, resident_fixed = ? WHERE id = ?`).run(
      request.text ?? row.text, request.topic ?? row.topic, (request.resident ?? row.resident === 1) ? 1 : 0, state, author, at,
      state === "active" ? null : request.supersededBy ?? row.superseded_by,
      author === "owner" && request.resident !== undefined ? 1 : row.resident_fixed, row.id,
    );
    for (const [action, text] of actions) this.log(row.id, at, author, action, text);
    return this.row(row.id);
  }

  /** The row; refuses an ID that names no memory. */
  row(id: number): MemoryRow {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow | undefined;
    if (!row) throw new AssistantError("assistant_memory_not_found", NOT_FOUND);
    return row;
  }

  memoryOf(row: MemoryRow): AssistantMemory {
    const sources = this.db.prepare(`SELECT e.session_id, e.entry_id, e.at FROM memory_sources s JOIN entries e ON e.id = s.entry_row
      WHERE s.memory_id = ? ORDER BY e.id LIMIT ?`).all(row.id, MAX_ASSISTANT_MEMORY_SOURCES) as Array<{ session_id: string; entry_id: string; at: string }>;
    const { count } = this.db.prepare("SELECT count(*) AS count FROM memory_sources WHERE memory_id = ?").get(row.id) as { count: number };
    return {
      id: String(row.id),
      topic: row.topic as AssistantMemoryTopic,
      text: row.text,
      resident: row.resident === 1,
      state: row.state as AssistantMemoryState,
      author: row.author as AssistantMemoryAuthor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      saidAt: row.said_at,
      revision: row.revision,
      sources: sources.map((source) => ({ sessionId: source.session_id, entryId: source.entry_id, at: source.at })),
      sourceCount: count,
      ...(row.superseded_by === null ? {} : { supersededBy: String(row.superseded_by) }),
    };
  }

  private entryRow(sessionId: string, entryId: string): number {
    const row = this.db.prepare("SELECT id FROM entries WHERE session_id = ? AND entry_id = ?").get(sessionId, entryId) as { id: number } | undefined;
    if (!row) throw new AssistantError("assistant_entry_not_found", "没有找到这条对话记录。它可能还没记下来，或者编号写错了。");
    return row.id;
  }

  private log(memoryId: number, at: string, author: AssistantMemoryAuthor, action: AssistantMemoryAction, text: string | null): void {
    this.db.prepare("INSERT INTO memory_changes (memory_id, at, author, action, text) VALUES (?, ?, ?, ?, ?)").run(memoryId, at, author, action, text);
  }

  private read<T>(work: () => T): T {
    return readTransaction(this.db, work);
  }
}

function encodeCursor(id: number): string { return Buffer.from(`m${id}`).toString("base64url"); }
function parseCursor(cursor: string): number {
  const match = /^m([1-9][0-9]{0,14})$/u.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw new AssistantError("invalid_request", "这个续读位置不是这次列出时给出的，请重新列出。");
  return Number(match[1]);
}
