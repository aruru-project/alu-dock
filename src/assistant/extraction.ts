import type { DatabaseSync } from "node:sqlite";

import type { AssistantExtractionStatus, AssistantMemoryTopic, AssistantModelRef, AssistantReorganizeResult, AssistantSettings } from "../core/assistant.js";
import type { AssistantDocuments } from "./documents.js";
import {
  ReplyFormatError,
  SEARCH_HITS,
  SEARCH_ROUNDS,
  SEARCH_TOOL,
  dreamPrompt,
  extractionPrompt,
  parseDreamReply,
  parseExtractionReply,
  searchQueries,
  searchResultText,
  spokenLine,
  type ModelPrompt,
  type ShownMemory,
} from "./extraction-prompt.js";
import type { AssistantMemories, MemoryRow } from "./memories.js";
import { SPOKEN, type EntryRow } from "./store.js";
import type { AssistantTimeline, EpisodeRow } from "./timeline.js";

/*
 * Her memories made in the background on Main (card #295), in two passes:
 *
 * - Extraction reads what was said in a recorded conversation (see extraction-prompt.ts) once nobody
 *   has added to it for a while (or once a lot waits), a part at a time and every word once, and
 *   adds, rewrites or retires memories, each naming the entries it came from. Of all conversations
 *   waiting, the one whose unread words are oldest goes first, so memories follow the order things
 *   were said in. The same reading writes her timeline (timeline.ts): a line per stretch of the
 *   conversation saying what they were doing, whose time is the first and last entry it covers; the
 *   session's latest lines are shown so the model extends them rather than adds. A session's
 *   `extracted_through` marks how far it was read. A part whose answers could not be read is passed
 *   over and noted in skipped_parts, to be read again once another model is chosen.
 * - Dreaming, once everything is quiet, looks again at the memories changed since it last ran, checks
 *   each against the words it came from, merges what says the same, and keeps the part loaded every
 *   session small (see extraction-prompt.ts). It does not touch the timeline.
 *
 * Either pass is shown the memories loaded every session and looks up the others with a search the
 * model calls (SEARCH_TOOL), as she does in a conversation.
 *
 * One pass runs at a time, with the model chosen in the assistant's settings; without one, nothing
 * runs. Starting over (reorganize) sets aside what the background made and reads everything again.
 * Neither pass changes a memory or a timeline line the owner changed last, nor whether a memory
 * is loaded every session once the owner chose that. Changes are checked against what the model was
 * shown, so one the owner or the assistant made meanwhile is never overwritten. Open sessions are not
 * told: they load the latest memories when they start again.
 */

/** A tool the model may call while it reads; `run` answers it at once. */
export interface ModelTool { name: string; description: string; parameters: object; run(args: Record<string, unknown>): string }

/** Sends one prompt to the chosen model and returns the text of its reply. */
export interface ExtractionModel {
  /** `tools`: what the model may call first, in at most `rounds` rounds of calls before it answers. */
  complete(model: AssistantModelRef, prompt: ModelPrompt, signal: AbortSignal, tools?: { list: readonly ModelTool[]; rounds: number }): Promise<string>;
}

/** A failure whose message the owner sees as it is. */
export class ExtractionModelError extends Error {}

export interface ExtractionTiming {
  /** A conversation is read once nothing was added to it for this long, */
  idleMs: number;
  /** or once this many characters said wait in it. */
  busyChars: number;
  /** At most how many characters said one extraction reads; words longer than that are read alone. */
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
/** Words already read shown again before a part, for its start to make sense: the last of them, up to this much. */
const LEAD_IN_ENTRIES = 8;
const LEAD_IN_CHARS = 3_000;
/**
 * Memories one dream checks, each with every place it was said, whole: at most this many, and while
 * they fit in DREAM_FOCUS_CHARS. A first memory said in more words than that shows what fits.
 */
const DREAM_FOCUS = 60;
const DREAM_FOCUS_CHARS = 40_000;
/** A conversation's latest timeline lines shown to extraction, for it to extend. */
const EPISODES_SHOWN = 5;

/** A part passed over, being read again from after `after` through `through`. */
interface SkippedPart { id: number; after: number; through: number }
type Job = { kind: "extract"; sessionId: string; part?: SkippedPart } | { kind: "dream" };

export class AssistantExtraction {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly cancel = new AbortController();
  private failure: { message: string; retryAt: number; attempts: number } | undefined;
  /** The last part passed over, for the owner to know. */
  private notice: string | undefined;
  private readonly unreadable = new Map<string, number>();
  /** Goes up when everything is read again, so a pass started before does not apply what it made. */
  private generation = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly memories: AssistantMemories,
    private readonly timeline: AssistantTimeline,
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

  /**
   * A new model starts at once and is given a fresh start after earlier failures; the parts passed
   * over are read again with it.
   */
  setModel(model: AssistantModelRef | null): AssistantSettings {
    const before = this.settings().extractionModel;
    this.memories.write(() => {
      if (model === null) this.db.prepare("DELETE FROM meta WHERE key = 'extraction_model'").run();
      else this.setMeta("extraction_model", JSON.stringify({ provider: model.provider, id: model.id }));
      if (model !== null && (before?.provider !== model.provider || before.id !== model.id)) this.db.prepare("UPDATE skipped_parts SET due = 1").run();
    });
    this.restart();
    return this.settings();
  }

  /**
   * The owner starts over with `model`: what the background made is set aside, its memories among
   * the retired, where each can be restored, and its timeline lines removed; every conversation is
   * read again from its start. What the owner or she wrote or changed stays, and so does whatever
   * the owner had her forget, with the lines that went with it.
   */
  reorganize(model: AssistantModelRef): AssistantReorganizeResult {
    const counts = this.memories.write(() => {
      const made = this.db.prepare(`SELECT * FROM memories m WHERE m.state = 'active' AND m.resident_fixed = 0
        AND NOT EXISTS (SELECT 1 FROM memory_changes c WHERE c.memory_id = m.id AND c.author IN ('owner', 'assistant'))`).all() as unknown as MemoryRow[];
      for (const row of made) this.memories.change(row, { state: "retired" }, "owner");
      const lines = this.db.prepare(`DELETE FROM episodes WHERE author = 'extraction'
        AND NOT EXISTS (SELECT 1 FROM episodes_forgotten_with w WHERE w.episode_id = episodes.id)`).run();
      this.db.prepare("DELETE FROM skipped_parts").run();
      this.db.prepare(`UPDATE sessions SET extracted_through = 0, waiting_chars = (SELECT coalesce(sum(length(text)), 0) FROM entries
        WHERE entries.session_id = sessions.session_id AND ${SPOKEN})`).run();
      this.setMeta("extraction_model", JSON.stringify({ provider: model.provider, id: model.id }));
      return { retiredMemories: made.length, removedLines: Number(lines.changes) };
    });
    this.generation += 1;
    this.restart();
    return { extractionModel: { provider: model.provider, id: model.id }, ...counts };
  }

  /** After the owner's change: earlier failures are forgotten and the next pass may start at once. */
  private restart(): void {
    this.failure = undefined;
    this.notice = undefined;
    this.unreadable.clear();
    if (!this.running) this.schedule(0);
  }

  status(): AssistantExtractionStatus {
    const model = this.settings().extractionModel;
    const { count } = this.db.prepare("SELECT count(*) AS count FROM sessions WHERE waiting_chars > 0").get() as { count: number };
    const { skipped } = this.db.prepare("SELECT count(*) AS skipped FROM skipped_parts").get() as { skipped: number };
    const lastRun = this.meta("last_run_ms");
    const problem = this.failure?.message ?? this.notice;
    return {
      state: model === undefined ? "off" : this.failure ? "failed" : this.running ? "working" : "idle",
      ...(model === undefined ? {} : { model }),
      waitingSessions: count,
      ...(skipped === 0 ? {} : { skippedParts: skipped }),
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
        if (job.kind === "extract") await this.extract(job.sessionId, model, job.part);
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
    const part = this.db.prepare("SELECT id, session_id, after_row, through_row FROM skipped_parts WHERE due = 1 ORDER BY after_row LIMIT 1")
      .get() as { id: number; session_id: string; after_row: number; through_row: number } | undefined;
    if (part) return { kind: "extract", sessionId: part.session_id, part: { id: part.id, after: part.after_row, through: part.through_row } };
    const session = this.db.prepare(`SELECT s.session_id FROM sessions s WHERE s.waiting_chars > 0 AND (s.recorded_ms <= ? OR s.waiting_chars >= ?)
      ORDER BY (SELECT min(id) FROM entries WHERE entries.session_id = s.session_id AND entries.id > s.extracted_through AND ${SPOKEN}) LIMIT 1`)
      .get(now - this.timing.idleMs, this.timing.busyChars) as { session_id: string } | undefined;
    if (session) return { kind: "extract", sessionId: session.session_id };
    const { latest } = this.db.prepare("SELECT max(recorded_ms) AS latest FROM sessions").get() as { latest: number | null };
    if (latest !== null && latest > now - this.timing.quietMs) return undefined;
    const { changed } = this.db.prepare(`SELECT count(DISTINCT m.id) AS changed FROM memory_changes c JOIN memories m ON m.id = c.memory_id
      WHERE c.id > ? AND c.author IN ('extraction', 'assistant') AND m.state = 'active' AND m.author <> 'owner'`).get(Number(this.meta("dreamed_through") ?? 0)) as { changed: number };
    if (changed === 0) return undefined;
    const dreamed = Number(this.meta("dreamed_ms") ?? 0);
    return changed >= this.timing.dreamChanges || now - dreamed >= this.timing.dreamIntervalMs ? { kind: "dream" } : undefined;
  }

  /**
   * Reads the next part of one conversation, or of a part passed over before, and applies what the
   * model makes of it.
   */
  private async extract(sessionId: string, model: AssistantModelRef, part?: SkippedPart): Promise<void> {
    const generation = this.generation;
    const after = part?.after ?? (this.db.prepare("SELECT extracted_through FROM sessions WHERE session_id = ?").get(sessionId) as { extracted_through: number }).extracted_through;
    const rows = this.db.prepare(`SELECT * FROM entries WHERE session_id = ? AND id > ? AND id <= ? AND ${SPOKEN} ORDER BY id LIMIT ?`)
      .all(sessionId, after, part?.through ?? Number.MAX_SAFE_INTEGER, ENTRIES_PER_READ) as unknown as EntryRow[];
    const lines: string[] = [];
    const refs: number[] = [];
    const rowById = new Map<number, EntryRow>();
    let through = after;
    let chars = 0;
    for (const row of rows) {
      const line = spokenLine(row);
      // The part ends before words that would take it past chunkChars; longer words are read alone.
      if (line !== undefined && lines.length > 0 && chars + line.length > this.timing.chunkChars) break;
      through = row.id;
      if (line === undefined) continue;
      lines.push(line);
      refs.push(row.id);
      rowById.set(row.id, row);
      chars += line.length;
    }
    const read = () => (part ? this.partRead(part, through) : this.advance(sessionId, through));
    if (lines.length === 0) {
      // Nothing in this part to read: words the owner had her forget.
      this.memories.write(read);
      return;
    }
    const leadIn = this.leadIn(sessionId, after);
    const resident = this.residentShown();
    const shownEpisodes = this.timeline.latestOf(sessionId, EPISODES_SHOWN, rowById.get(refs[0]!)!.at_ms);
    const found = new Map<number, MemoryRow>();
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const reply = await this.model.complete(model, extractionPrompt({ persona: persona.text, notes: notes.text, resident, episodes: shownEpisodes, leadIn, lines }), this.cancel.signal,
      { list: [this.searchTool(found)], rounds: SEARCH_ROUNDS });
    // Everything is being read again from the start: what this pass made is not wanted.
    if (generation !== this.generation) return;
    const key = `${part ? `part ${part.id}` : sessionId}:${after}`;
    let parsed: ReturnType<typeof parseExtractionReply>;
    try {
      parsed = parseExtractionReply(reply, lines.length);
    } catch (error) {
      if (!(error instanceof ReplyFormatError)) throw error;
      if (this.passOver(key)) {
        this.memories.write(() => {
          if (part) this.db.prepare("UPDATE skipped_parts SET due = 0 WHERE id = ?").run(part.id);
          else {
            this.db.prepare("INSERT INTO skipped_parts (session_id, after_row, through_row) VALUES (?, ?, ?)").run(sessionId, after, through);
            this.advance(sessionId, through);
          }
        });
        this.notice = "整理记忆用的模型对一段对话的回答看不懂，试了三次都这样，这段先跳过了。已经记下是哪段，换一个模型或从头整理时会重新读它。经常这样的话，在助手设置里换一个更强的模型。";
        this.log(`Assistant extraction passed over part of session ${sessionId}: ${error.message}`);
        return;
      }
      throw new ExtractionModelError("整理记忆用的模型的回答不是约定的格式，这段对话稍后再试。");
    }
    const known = new Map([...resident.map((memory) => memory.row), ...found.values()].map((row) => [row.id, row] as const));
    const knownEpisodes = new Map(shownEpisodes.map((row) => [row.id, row] as const));
    this.memories.write(() => {
      // Words the owner had forgotten while the model was reading may not come back as a memory or a timeline line.
      const forgotten = this.forgottenAmong(refs);
      // A line tells of everything in its stretch, so it may not span any of them either.
      const forgottenAt = [...forgotten].map((id) => rowById.get(id)!.at_ms);
      for (const change of parsed.timeline) {
        const sources = change.from.map((ref) => refs[ref - 1]!);
        // The line covers the entries it names: from the earliest said to the latest.
        const covered = sources.map((id) => rowById.get(id)!);
        const first = covered.reduce((earliest, row) => (row.at_ms < earliest.at_ms ? row : earliest));
        const last = covered.reduce((latest, row) => (row.at_ms > latest.at_ms ? row : latest));
        const from = { row: first.id, at: first.at, at_ms: first.at_ms };
        const to = { row: last.id, at: last.at, at_ms: last.at_ms };
        const row = change.do === "rewrite" ? this.changeableEpisode(change.id, knownEpisodes) : undefined;
        if (change.do === "rewrite" && !row) continue;
        const spanFrom = Math.min(row?.from_ms ?? first.at_ms, first.at_ms);
        const spanTo = Math.max(row?.to_ms ?? last.at_ms, last.at_ms);
        if (forgottenAt.some((at) => at >= spanFrom && at <= spanTo)) continue;
        if (row) knownEpisodes.set(row.id, this.timeline.change(row, { text: change.text, from, to }, "extraction"));
        else this.timeline.insert(sessionId, from, to, change.text, "extraction");
      }
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
      read();
    });
    this.unreadable.delete(key);
  }

  /** Checks the memories changed since the last dream against what they came from and tidies them. */
  private async dream(model: AssistantModelRef): Promise<void> {
    const dreamedThrough = Number(this.meta("dreamed_through") ?? 0);
    const { latest } = this.db.prepare("SELECT coalesce(max(id), 0) AS latest FROM memory_changes").get() as { latest: number };
    const focusRows = this.dreamFocus(dreamedThrough, latest, DREAM_FOCUS);
    // Each memory with the words it came from, whole, while they fit; at least one.
    const focus: ShownMemory[] = [];
    let chars = 0;
    for (const { last_change: _last, ...row } of focusRows) {
      const sources = this.sourcesOf(row.id);
      const size = row.text.length + sources.reduce((sum, source) => sum + source.length, 0);
      if (focus.length > 0 && chars + size > DREAM_FOCUS_CHARS) break;
      if (size <= DREAM_FOCUS_CHARS) {
        chars += size;
        focus.push({ row, sources });
        continue;
      }
      const shown: string[] = [];
      let room = DREAM_FOCUS_CHARS - row.text.length;
      for (const source of sources) {
        if (shown.length > 0 && source.length > room) break;
        shown.push(source);
        room -= source.length;
      }
      chars = DREAM_FOCUS_CHARS;
      focus.push({ row, sources: shown, unshownSources: sources.length - shown.length });
    }
    // More than one dream holds: the rest come next time, after the newest change this one covers.
    const through = focus.length < focusRows.length || focusRows.length === DREAM_FOCUS ? focusRows[focus.length - 1]?.last_change ?? latest : latest;
    const finish = () => { this.setMeta("dreamed_through", String(through)); this.setMeta("dreamed_ms", String(this.now())); };
    if (focus.length === 0) { this.memories.write(finish); return; }
    const focusIds = new Set(focus.map((memory) => memory.row.id));
    const resident = this.residentShown().filter((memory) => !focusIds.has(memory.row.id));
    const residentTotal = this.db.prepare("SELECT count(*) AS count, coalesce(sum(length(text)), 0) AS chars FROM memories WHERE state = 'active' AND resident = 1").get() as { count: number; chars: number };
    const found = new Map<number, MemoryRow>();
    const [persona, notes] = await Promise.all([this.documents.get("persona"), this.documents.get("notes")]);
    const reply = await this.model.complete(model, dreamPrompt({ persona: persona.text, notes: notes.text, focus, resident, residentTotal }), this.cancel.signal,
      { list: [this.searchTool(found)], rounds: SEARCH_ROUNDS });
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
    const known = new Map([...focus, ...resident].map((memory) => memory.row).concat([...found.values()]).map((row) => [row.id, row] as const));
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

  /** Inside a write: the timeline line as the model was shown it, if it may still change: in use, not the owner's, and unchanged since. */
  private changeableEpisode(id: number, known: Map<number, EpisodeRow>): EpisodeRow | undefined {
    const shown = known.get(id);
    if (!shown) return undefined;
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as unknown as EpisodeRow | undefined;
    if (!row || row.revision !== shown.revision || row.state !== "active" || row.author === "owner") return undefined;
    return row;
  }

  /** Inside a write: marks the conversation read through `through` and counts the words still waiting. */
  private advance(sessionId: string, through: number): void {
    this.db.prepare("UPDATE sessions SET extracted_through = max(extracted_through, ?) WHERE session_id = ?").run(through, sessionId);
    this.db.prepare(`UPDATE sessions SET waiting_chars = (SELECT coalesce(sum(length(text)), 0) FROM entries
      WHERE entries.session_id = sessions.session_id AND entries.id > sessions.extracted_through AND ${SPOKEN}) WHERE session_id = ?`).run(sessionId);
  }

  /** Inside a write: a part passed over is read through `through`; once all of it is, it is done. */
  private partRead(part: SkippedPart, through: number): void {
    if (through >= part.through) this.db.prepare("DELETE FROM skipped_parts WHERE id = ?").run(part.id);
    else this.db.prepare("UPDATE skipped_parts SET after_row = ? WHERE id = ?").run(through, part.id);
  }

  /** The last words said before a part, up to LEAD_IN_CHARS of them, oldest first. */
  private leadIn(sessionId: string, after: number): string[] {
    if (after === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM entries WHERE session_id = ? AND id <= ? AND ${SPOKEN} ORDER BY id DESC LIMIT ?`).all(sessionId, after, LEAD_IN_ENTRIES) as unknown as EntryRow[];
    const lines: string[] = [];
    let room = LEAD_IN_CHARS;
    for (const row of rows) {
      if (room <= 0) break;
      const line = spokenLine(row, room);
      if (line === undefined) continue;
      lines.unshift(line);
      room -= line.length;
    }
    return lines;
  }

  /** The memories in use loaded every session, as a session loads them. */
  private residentShown(): ShownMemory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE state = 'active' AND resident = 1 ORDER BY id").all() as unknown as MemoryRow[]).map((row) => ({ row }));
  }

  /** The search the model calls while it reads; every memory it finds goes into `found`, and may then be changed. */
  private searchTool(found: Map<number, MemoryRow>): ModelTool {
    return {
      ...SEARCH_TOOL,
      run: (args) => {
        const queries = searchQueries(args);
        if (queries === undefined) return "queries 要给至少一组词。";
        return searchResultText(queries.map((words) => {
          const rows = this.db.prepare(`SELECT * FROM memories WHERE state = 'active' ${words.map(() => "AND text LIKE ? ESCAPE '\\'").join(" ")} ORDER BY id DESC LIMIT ?`)
            .all(...words.map((word) => `%${word.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`), SEARCH_HITS) as unknown as MemoryRow[];
          for (const row of rows) found.set(row.id, row);
          return { words, rows };
        }));
      },
    };
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

  /** Every place a memory was said, as the model reads it, in the order said. */
  private sourcesOf(memoryId: number): string[] {
    const rows = this.db.prepare("SELECT e.* FROM memory_sources s JOIN entries e ON e.id = s.entry_row WHERE s.memory_id = ? ORDER BY e.id").all(memoryId) as unknown as EntryRow[];
    return rows.map((row) => spokenLine(row)).filter((line): line is string => line !== undefined);
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
