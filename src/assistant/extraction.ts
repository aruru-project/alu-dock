import type { DatabaseSync } from "node:sqlite";

import type { AssistantExtractionStatus, AssistantMemoryTopic, AssistantModelRef, AssistantSettings } from "../core/assistant.js";
import type { AssistantDocuments } from "./documents.js";
import {
  ReplyFormatError,
  dreamPrompt,
  extractionPrompt,
  parseDreamReply,
  parseExtractionReply,
  sourceLine,
  spokenLine,
  type ModelPrompt,
  type ShownMemory,
} from "./extraction-prompt.js";
import type { AssistantMemories, MemoryRow } from "./memories.js";
import type { EntryRow } from "./store.js";

/*
 * Her memories made in the background on Main (card #295), in two passes:
 *
 * - Extraction reads a recorded conversation once nobody has added to it for a while (or once a lot
 *   waits), a part at a time, and adds, rewrites or retires memories, each naming the entries it came
 *   from. A session's `extracted_through` marks how far it was read.
 * - Dreaming, once everything is quiet, looks again at the memories changed since it last ran, checks
 *   each against the words it came from, merges what says the same, and keeps the part loaded every
 *   session small (see extraction-prompt.ts).
 *
 * One pass runs at a time, with the model chosen in the assistant's settings; without one, nothing
 * runs. Neither pass changes a memory the owner changed last, nor whether one is loaded every session
 * once the owner chose that. Changes are checked against what the model was shown, so one the owner
 * or the assistant made meanwhile is never overwritten. Open sessions are not told: they load the
 * latest memories when they start again.
 */

/** Sends one prompt to the chosen model and returns the text of its reply. */
export interface ExtractionModel {
  complete(model: AssistantModelRef, prompt: ModelPrompt, signal: AbortSignal): Promise<string>;
}

/** A failure whose message the owner sees as it is. */
export class ExtractionModelError extends Error {}

export interface ExtractionTiming {
  /** A conversation is read once nothing was added to it for this long, */
  idleMs: number;
  /** or once this many searchable characters wait in it. */
  busyChars: number;
  /** About how much conversation one extraction reads. */
  chunkChars: number;
  /** How often to look for work while there is none. */
  tickMs: number;
  /** Dreaming waits until nothing was recorded anywhere for this long, */
  quietMs: number;
  /** and then runs once this many memories changed, */
  dreamChanges: number;
  /** or this long after it last ran when any changed. */
  dreamIntervalMs: number;
}

export const DEFAULT_EXTRACTION_TIMING: ExtractionTiming = {
  idleMs: 10 * 60_000,
  busyChars: 60_000,
  chunkChars: 24_000,
  tickMs: 60_000,
  quietMs: 30 * 60_000,
  dreamChanges: 20,
  dreamIntervalMs: 12 * 3_600_000,
};

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** A part the model answered in a form that cannot be read this many times is passed over. */
const UNREADABLE_ATTEMPTS = 3;
const ENTRIES_PER_READ = 400;
const LEAD_IN_ENTRIES = 8;
const LEAD_IN_CHARS = 3_000;
/** Memories shown to extraction: everything loaded every session first, then the newest others. */
const MEMORY_PROMPT_CHARS = 30_000;
/** Memories one dream checks, and what it shows besides them. */
const DREAM_FOCUS = 60;
const DREAM_RELATED_CHARS = 30_000;
const SOURCES_PER_MEMORY = 3;

type Job = { kind: "extract"; sessionId: string } | { kind: "dream" };

export class AssistantExtraction {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly cancel = new AbortController();
  private failure: { message: string; retryAt: number; attempts: number } | undefined;
  /** The last part passed over, for the owner to know. */
  private notice: string | undefined;
  private readonly unreadable = new Map<string, number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly memories: AssistantMemories,
    private readonly documents: Pick<AssistantDocuments, "get">,
    private readonly model: ExtractionModel,
    private readonly timing: ExtractionTiming = DEFAULT_EXTRACTION_TIMING,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops looking for work and cancels a model call under way; its part is read again next time. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.cancel.abort();
    await this.running;
  }

  /** Whether a pass runs or one is due now; what the evaluation script waits on. */
  busy(): boolean {
    return this.running !== undefined || (this.settings().extractionModel !== undefined && !this.failure && this.nextJob(this.now()) !== undefined);
  }

  settings(): AssistantSettings {
    const value = this.meta("extraction_model");
    return value === undefined ? {} : { extractionModel: JSON.parse(value) as AssistantModelRef };
  }

  /** A new model starts at once and is given a fresh start after earlier failures. */
  setModel(model: AssistantModelRef | null): AssistantSettings {
    if (model === null) this.db.prepare("DELETE FROM meta WHERE key = 'extraction_model'").run();
    else this.setMeta("extraction_model", JSON.stringify({ provider: model.provider, id: model.id }));
    this.failure = undefined;
    this.notice = undefined;
    this.unreadable.clear();
    if (!this.running) this.schedule(0);
    return this.settings();
  }

  status(): AssistantExtractionStatus {
    const model = this.settings().extractionModel;
    const { count } = this.db.prepare("SELECT count(*) AS count FROM sessions WHERE waiting_chars > 0").get() as { count: number };
    const lastRun = this.meta("last_run_ms");
    const problem = this.failure?.message ?? this.notice;
    return {
      state: model === undefined ? "off" : this.failure ? "failed" : this.running ? "working" : "idle",
      ...(model === undefined ? {} : { model }),
      waitingSessions: count,
      ...(lastRun === undefined ? {} : { lastRunAt: new Date(Number(lastRun)).toISOString() }),
      ...(problem === undefined ? {} : { lastError: problem }),
      ...(this.failure ? { retryAt: new Date(this.failure.retryAt).toISOString() } : {}),
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(0, delayMs));
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped || this.running) return;
    const model = this.settings().extractionModel;
    // Choosing a model starts it again.
    if (model === undefined) return;
    const now = this.now();
    if (this.failure && now < this.failure.retryAt) { this.schedule(this.failure.retryAt - now); return; }
    const job = this.nextJob(now);
    if (!job) { this.schedule(this.timing.tickMs); return; }
    this.running = (async () => {
      try {
        if (job.kind === "extract") await this.extract(job.sessionId, model);
        else await this.dream(model);
        this.failure = undefined;
        this.setMeta("last_run_ms", String(this.now()));
      } catch (error) {
        if (!this.stopped) this.fail(error);
      }
    })().finally(() => {
      this.running = undefined;
      // Straight on to the next part; a failure waits for its retry.
      this.schedule(this.failure ? this.failure.retryAt - this.now() : 0);
    });
  }

  private nextJob(now: number): Job | undefined {
    const session = this.db.prepare(`SELECT session_id FROM sessions WHERE waiting_chars > 0 AND (recorded_ms <= ? OR waiting_chars >= ?)
      ORDER BY recorded_ms LIMIT 1`).get(now - this.timing.idleMs, this.timing.busyChars) as { session_id: string } | undefined;
    if (session) return { kind: "extract", sessionId: session.session_id };
    const { latest } = this.db.prepare("SELECT max(recorded_ms) AS latest FROM sessions").get() as { latest: number | null };
    if (latest !== null && latest > now - this.timing.quietMs) return undefined;
    const { changed } = this.db.prepare(`SELECT count(DISTINCT m.id) AS changed FROM memory_changes c JOIN memories m ON m.id = c.memory_id
      WHERE c.id > ? AND c.author IN ('extraction', 'assistant') AND m.state = 'active' AND m.author <> 'owner'`).get(Number(this.meta("dreamed_through") ?? 0)) as { changed: number };
    if (changed === 0) return undefined;
    const dreamed = Number(this.meta("dreamed_ms") ?? 0);
    return changed >= this.timing.dreamChanges || now - dreamed >= this.timing.dreamIntervalMs ? { kind: "dream" } : undefined;
  }

  /** Reads the next part of one conversation and applies what the model makes of it. */
  private async extract(sessionId: string, model: AssistantModelRef): Promise<void> {
    const { extracted_through: after } = this.db.prepare("SELECT extracted_through FROM sessions WHERE session_id = ?").get(sessionId) as { extracted_through: number };
    const rows = this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?").all(sessionId, after, ENTRIES_PER_READ) as unknown as EntryRow[];
    const lines: string[] = [];
    const refs: number[] = [];
    let through = after;
    let chars = 0;
    for (const row of rows) {
      if (lines.length > 0 && chars >= this.timing.chunkChars) break;
      through = row.id;
      const line = spokenLine(row);
      if (line === undefined) continue;
      lines.push(line);
      refs.push(row.id);
      chars += line.length;
    }
    if (lines.length === 0) {
      // Nothing in this part to read: tool output of her own memory tools, notices, forgotten words.
      this.memories.write(() => this.advance(sessionId, through));
      return;
    }
    const leadIn = this.leadIn(sessionId, after);
    const shown = this.shownForExtraction();
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const reply = await this.model.complete(model, extractionPrompt({ persona: persona.text, notes: notes.text, memories: shown.memories, omitted: shown.omitted, leadIn, lines }), this.cancel.signal);
    let parsed: ReturnType<typeof parseExtractionReply>;
    try {
      parsed = parseExtractionReply(reply, lines.length);
    } catch (error) {
      if (!(error instanceof ReplyFormatError)) throw error;
      if (this.passOver(`${sessionId}:${after}`)) {
        this.memories.write(() => this.advance(sessionId, through));
        this.notice = "提炼用的模型对一段对话的回答看不懂，试了三次都这样，这段对话没有提炼就跳过了。经常这样的话，在助手设置里换一个更强的模型。";
        this.log(`Assistant extraction passed over part of session ${sessionId}: ${error.message}`);
        return;
      }
      throw new ExtractionModelError("提炼用的模型的回答不是约定的格式，这段对话稍后再试。");
    }
    const known = new Map(shown.memories.map((memory) => [memory.row.id, memory.row] as const));
    this.memories.write(() => {
      // Words the owner had forgotten while the model was reading may not come back as a memory.
      const forgotten = this.forgottenAmong(refs);
      for (const change of parsed.changes) {
        const sources = change.from.map((ref) => refs[ref - 1]!);
        if (sources.some((row) => forgotten.has(row))) continue;
        if (change.do === "add") {
          this.memories.insert(change.topic, change.text, change.resident, "extraction", sources);
          continue;
        }
        const row = this.changeable(change.id, known);
        if (!row) continue;
        if (change.do === "rewrite") {
          this.apply(row, { text: change.text }, "extraction", known);
          this.memories.addSources(row.id, sources);
        } else {
          this.apply(row, { state: "retired" }, "extraction", known);
        }
      }
      this.advance(sessionId, through);
    });
    this.unreadable.delete(`${sessionId}:${after}`);
  }

  /** Checks the memories changed since the last dream against what they came from and tidies them. */
  private async dream(model: AssistantModelRef): Promise<void> {
    const dreamedThrough = Number(this.meta("dreamed_through") ?? 0);
    const { latest } = this.db.prepare("SELECT coalesce(max(id), 0) AS latest FROM memory_changes").get() as { latest: number };
    const focusRows = this.dreamFocus(dreamedThrough, latest, DREAM_FOCUS);
    // More than one dream holds: the rest come next time, after the newest change this one covers.
    const through = focusRows.length === DREAM_FOCUS ? focusRows.at(-1)!.last_change : latest;
    const finish = () => { this.setMeta("dreamed_through", String(through)); this.setMeta("dreamed_ms", String(this.now())); };
    if (focusRows.length === 0) { this.memories.write(finish); return; }
    const focus: ShownMemory[] = focusRows.map(({ last_change: _last, ...row }) => ({ row, sources: this.sourcesOf(row.id) }));
    const focusIds = new Set(focus.map((memory) => memory.row.id));
    const topics = [...new Set(focus.map((memory) => memory.row.topic))];
    const related: ShownMemory[] = [];
    let chars = 0;
    // Everything loaded every session, then the newest others of the same topics.
    const candidates = this.db.prepare(`SELECT * FROM memories WHERE state = 'active' AND (resident = 1 OR topic IN (${topics.map(() => "?").join(", ")}))
      ORDER BY resident DESC, id DESC`).all(...topics) as unknown as MemoryRow[];
    for (const row of candidates) {
      if (focusIds.has(row.id)) continue;
      if (chars + row.text.length > DREAM_RELATED_CHARS) break;
      chars += row.text.length;
      related.push({ row });
    }
    const resident = this.db.prepare("SELECT count(*) AS count, coalesce(sum(length(text)), 0) AS chars FROM memories WHERE state = 'active' AND resident = 1").get() as { count: number; chars: number };
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const reply = await this.model.complete(model, dreamPrompt({ persona: persona.text, notes: notes.text, focus, related, resident }), this.cancel.signal);
    let parsed: ReturnType<typeof parseDreamReply>;
    try {
      parsed = parseDreamReply(reply);
    } catch (error) {
      if (!(error instanceof ReplyFormatError)) throw error;
      if (this.passOver(`dream:${dreamedThrough}`)) {
        this.memories.write(finish);
        this.notice = "整理记忆时，模型的回答看不懂，试了三次都这样，这次整理跳过了。经常这样的话，在助手设置里换一个更强的模型。";
        this.log(`Assistant dreaming passed over its changes: ${error.message}`);
        return;
      }
      throw new ExtractionModelError("整理记忆时，模型的回答不是约定的格式，稍后再试。");
    }
    const known = new Map([...focus, ...related].map((memory) => [memory.row.id, memory.row] as const));
    this.memories.write(() => {
      for (const change of parsed.changes) {
        if (change.do === "merge") { this.merge(change.ids, change.text, change.topic, change.resident, known); continue; }
        const row = this.changeable(change.id, known);
        if (!row) continue;
        if (change.do === "rewrite") this.apply(row, { text: change.text }, "dreaming", known);
        else if (change.do === "retire") this.apply(row, { state: "retired" }, "dreaming", known);
        else if (row.resident_fixed === 0) this.apply(row, { resident: change.resident }, "dreaming", known);
      }
      finish();
    });
    this.unreadable.delete(`dream:${dreamedThrough}`);
  }

  /** Inside a write: one new memory said wherever its parts were, which are retired into it. */
  private merge(ids: number[], text: string, topic: AssistantMemoryTopic | undefined, resident: boolean | undefined, known: Map<number, MemoryRow>): void {
    const rows = ids.map((id) => this.changeable(id, known));
    if (rows.some((row) => row === undefined)) return;
    const parts = rows as MemoryRow[];
    // A part whose loading the owner chose keeps that choice in the merged memory.
    const fixed = [...new Set(parts.filter((row) => row.resident_fixed === 1).map((row) => row.resident === 1))];
    if (fixed.length > 1) return;
    const sources = (this.db.prepare(`SELECT DISTINCT entry_row FROM memory_sources WHERE memory_id IN (${parts.map(() => "?").join(", ")})`)
      .all(...parts.map((row) => row.id)) as Array<{ entry_row: number }>).map((row) => row.entry_row);
    const merged = this.memories.insert(
      topic ?? parts[0]!.topic as AssistantMemoryTopic, text,
      fixed[0] ?? resident ?? parts.some((row) => row.resident === 1), "dreaming", sources, fixed.length === 1,
    );
    for (const row of parts) this.apply(row, { state: "retired", supersededBy: merged.id }, "dreaming", known);
  }

  /** Inside a write: one change, after which later changes of the same reply see this version. */
  private apply(row: MemoryRow, change: Parameters<AssistantMemories["change"]>[1], author: "extraction" | "dreaming", known: Map<number, MemoryRow>): void {
    known.set(row.id, this.memories.change(row, change, author));
  }

  /** Inside a write: the entries among `rows` that a forgotten memory names now. */
  private forgottenAmong(rows: readonly number[]): Set<number> {
    if (rows.length === 0) return new Set();
    return new Set((this.db.prepare(`SELECT id FROM entries WHERE forgotten > 0 AND id IN (${rows.map(() => "?").join(", ")})`).all(...rows) as Array<{ id: number }>).map((row) => row.id));
  }

  /**
   * Inside a write: the memory as the model was shown it, if it may still change: in use, not last
   * changed by the owner, and not changed by anyone since but this same reply.
   */
  private changeable(id: number, known: Map<number, MemoryRow>): MemoryRow | undefined {
    const shown = known.get(id);
    if (!shown) return undefined;
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow | undefined;
    if (!row || row.revision !== shown.revision || row.state !== "active" || row.author === "owner") return undefined;
    return row;
  }

  /** Inside a write: marks the conversation read through `through` and counts what still waits. */
  private advance(sessionId: string, through: number): void {
    this.db.prepare("UPDATE sessions SET extracted_through = max(extracted_through, ?) WHERE session_id = ?").run(through, sessionId);
    this.db.prepare(`UPDATE sessions SET waiting_chars = (SELECT coalesce(sum(length(search_text)), 0) FROM entries
      WHERE entries.session_id = sessions.session_id AND entries.id > sessions.extracted_through) WHERE session_id = ?`).run(sessionId);
  }

  private leadIn(sessionId: string, after: number): string[] {
    if (after === 0) return [];
    const rows = (this.db.prepare("SELECT * FROM entries WHERE session_id = ? AND id <= ? ORDER BY id DESC LIMIT ?").all(sessionId, after, LEAD_IN_ENTRIES) as unknown as EntryRow[]).reverse();
    const lines = rows.map((row) => spokenLine(row, 600)).filter((line): line is string => line !== undefined);
    while (lines.length > 1 && lines.reduce((sum, line) => sum + line.length, 0) > LEAD_IN_CHARS) lines.shift();
    return lines;
  }

  private shownForExtraction(): { memories: ShownMemory[]; omitted: number } {
    const rows = this.db.prepare("SELECT * FROM memories WHERE state = 'active' ORDER BY resident DESC, id DESC").all() as unknown as MemoryRow[];
    const memories: ShownMemory[] = [];
    let chars = 0;
    for (const row of rows) {
      // Everything loaded every session is shown; others while there is room.
      if (row.resident === 0 && chars + row.text.length > MEMORY_PROMPT_CHARS) break;
      chars += row.text.length;
      memories.push({ row });
    }
    return { memories, omitted: rows.length - memories.length };
  }

  /**
   * Memories in use, not last changed by the owner, that extraction or the assistant changed after
   * `after` (up to `through`), oldest change first, with their newest such change.
   */
  private dreamFocus(after: number, through: number, limit: number): Array<MemoryRow & { last_change: number }> {
    return this.db.prepare(`SELECT m.*, max(c.id) AS last_change FROM memory_changes c JOIN memories m ON m.id = c.memory_id
      WHERE c.id > ? AND c.id <= ? AND c.author IN ('extraction', 'assistant') AND m.state = 'active' AND m.author <> 'owner'
      GROUP BY m.id ORDER BY last_change LIMIT ?`).all(after, through, limit) as unknown as Array<MemoryRow & { last_change: number }>;
  }

  private sourcesOf(memoryId: number): string[] {
    const rows = this.db.prepare(`SELECT e.* FROM memory_sources s JOIN entries e ON e.id = s.entry_row WHERE s.memory_id = ? ORDER BY e.id DESC LIMIT ?`)
      .all(memoryId, SOURCES_PER_MEMORY) as unknown as EntryRow[];
    return rows.reverse().map((row) => sourceLine(row)).filter((line): line is string => line !== undefined);
  }

  /** Counts an unreadable reply for one part; true once it is to be passed over. */
  private passOver(key: string): boolean {
    const attempts = (this.unreadable.get(key) ?? 0) + 1;
    if (attempts < UNREADABLE_ATTEMPTS) { this.unreadable.set(key, attempts); return false; }
    this.unreadable.delete(key);
    return true;
  }

  private fail(error: unknown): void {
    const attempts = (this.failure?.attempts ?? 0) + 1;
    const retryAt = this.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    const reason = error instanceof Error ? error.message : String(error);
    const message = error instanceof ExtractionModelError
      ? reason
      : `整理记忆时出错了（${reason}）。稍后会自动再试；一直这样的话，看看 Main 上的 Dock Host 日志。`;
    this.failure = { message, retryAt, attempts };
    this.log(`Assistant memory pass failed (attempt ${attempts}): ${reason}`);
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
