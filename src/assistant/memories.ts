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

/*
 * Her memories, kept in the same database as the conversations they came from (store.ts holds the
 * layout). Nothing is ever deleted: a memory set aside is `retired`, one the owner wants gone is
 * `forgotten`, and both can be restored. While a memory is forgotten, the entries it names as where
 * it was said are not found by searches either, and read as forgotten (entries.forgotten counts
 * the forgotten memories naming each entry).
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

  update(request: AssistantMemoryUpdateRequest, author: AssistantMemoryAuthor): AssistantMemory {
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
      return this.memoryOf(this.change(row, request, author));
    });
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite already rolled back */ }
      throw error;
    }
  }

  /** Inside `write`: a new memory naming `entryRows` as where it was said; `residentFixed` when the owner chose its loading. */
  insert(topic: AssistantMemoryTopic, text: string, resident: boolean, author: AssistantMemoryAuthor, entryRows: readonly number[], residentFixed = false): MemoryRow {
    const at = this.now().toISOString();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO memories (topic, text, resident, state, author, created_at, updated_at, resident_fixed) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)")
      .run(topic, text, resident ? 1 : 0, author, at, at, residentFixed ? 1 : 0);
    const id = Number(lastInsertRowid);
    this.addSources(id, entryRows);
    this.log(id, at, author, "added", text);
    return this.row(id);
  }

  /** Inside `write`: names more places a memory was said. */
  addSources(memoryId: number, entryRows: readonly number[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, entry_row) VALUES (?, ?)");
    for (const entryRow of new Set(entryRows)) insert.run(memoryId, entryRow);
  }

  /** Inside `write`: applies the changes `request` names and logs each; the revision goes up once. */
  change(row: MemoryRow, request: Omit<AssistantMemoryUpdateRequest, "id" | "revision"> & { supersededBy?: number }, author: AssistantMemoryAuthor): MemoryRow {
    const at = this.now().toISOString();
    const actions: Array<[AssistantMemoryAction, string | null]> = [];
    if (request.text !== undefined && request.text !== row.text) actions.push(["rewritten", request.text]);
    if (request.topic !== undefined && request.topic !== row.topic) actions.push(["moved", null]);
    // The owner choosing whether it is loaded counts even when it already was: from then on that choice is his.
    const ownerChoosesLoading = author === "owner" && request.resident !== undefined && row.resident_fixed === 0;
    if (request.resident !== undefined && (request.resident !== (row.resident === 1) || ownerChoosesLoading)) actions.push([request.resident ? "resident" : "query_only", null]);
    const state = request.state ?? row.state;
    if (state !== row.state) {
      actions.push([request.supersededBy !== undefined ? "merged" : state === "active" ? "restored" : state as "retired" | "forgotten", null]);
      // Entries said where a forgotten memory came from are hidden while it stays forgotten.
      const step = state === "forgotten" ? 1 : row.state === "forgotten" ? -1 : 0;
      if (step !== 0) this.db.prepare("UPDATE entries SET forgotten = forgotten + ? WHERE id IN (SELECT entry_row FROM memory_sources WHERE memory_id = ?)").run(step, row.id);
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

  /** Several reads that should agree, in one read transaction. */
  private read<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN");
    try { return work(); }
    finally { if (this.db.isTransaction) this.db.exec("COMMIT"); }
  }
}

function encodeCursor(id: number): string { return Buffer.from(`m${id}`).toString("base64url"); }
function parseCursor(cursor: string): number {
  const match = /^m([1-9][0-9]{0,14})$/u.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw new AssistantError("invalid_request", "这个续读位置不是这次列出时给出的，请重新列出。");
  return Number(match[1]);
}
