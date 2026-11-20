import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, convertToLlm, estimateTokens, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { AgentCompactionKnownFailureError } from "../core/agent-worker.js";
import type { AssistantHandoffSettings } from "../core/assistant.js";
import { shortLocalTime } from "../core/local-time.js";
import { DOCK_NOTE_TYPE, STATUS_NOTE_TYPE } from "./status.js";

export const HANDOFF_STATUS_KEY = "滚动整理";

/** Where a hand-over record takes over from the conversation before it. */
export interface HandoffRecord {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** The entries her owner had her forget when writing began; one forgotten since may be told in the record. */
  forgottenAtStart: ReadonlySet<string>;
}

export interface HandoffLimits {
  /** Past this much context a record is written in the background. */
  startTokens: number;
  /** Past this much she waits for the record before asking the model again. */
  mustTokens: number;
  /** About this much of the latest conversation stays as it was said. */
  keepRecentTokens: number;
}

/** The only calculation of automatic thresholds and the effective recent-conversation budget. */
export function handoffLimits(contextWindow: number, settings?: AssistantHandoffSettings): HandoffLimits {
  const windowBudget = Math.min(Math.floor((contextWindow > 0 ? contextWindow : 200_000) / 2), 100_000);
  const startTokens = settings?.startTokens ?? windowBudget;
  // Leave older material to hand over. The saved choice stays unchanged when a smaller model is selected.
  const recentBudget = Math.max(1, Math.min(startTokens, windowBudget) - 1);
  const keepRecentTokens = Math.min(settings?.keepRecentTokens ?? Math.min(20_000, Math.floor(startTokens * 0.3)), recentBudget);
  return { startTokens, mustTokens: Math.floor(startTokens * 1.5), keepRecentTokens };
}

/** After a failed write the next one waits this long: 5, 15, 30, then 60 minutes. */
const RETRY_MINUTES = [5, 15, 30, 60];

export interface HandoffDeps {
  /** The whole conversation, oldest first. */
  branch(): SessionEntry[];
  contextWindow(): number;
  /** Main supplies the saved instruction, including its factory default. No local prompt fallback. */
  settings(): Promise<AssistantHandoffSettings | undefined>;
  /** Brief attention/activity only. Full details are read on demand; results also stay in the session. */
  status(text: string | undefined): void;
  /** One call to her model; rejects when it fails or is cancelled. */
  complete(system: string, prompt: string, signal: AbortSignal): Promise<string>;
  /** The entries of this conversation her owner had her forget, or undefined when Main does not answer. */
  forgotten(): Promise<string[] | undefined>;
  /** A record written in the background is ready to take its place. */
  ready(): void;
  /** Tells the owner, outside the conversation. */
  tell(message: string): void;
  now?: () => number;
}

/**
 * Keeps her conversation from outgrowing the model. Past `startTokens` the older part is written
 * into a hand-over record in the background while she goes on talking; the record takes its place
 * before a later request to the model. Only past `mustTokens` does she wait for it. A write that
 * fails loses nothing: the conversation stays whole and the next write waits a while.
 */
export class Handoff {
  private writing: { promise: Promise<void>; cancel: AbortController; startedAt: Date } | undefined;
  private record: HandoffRecord | undefined;
  private adopting: { record: HandoffRecord; committed: boolean } | undefined;
  /** The Host admits one manual compact at a time. It finishes at the same adoption point as a background write. */
  private manual: { resolve(record: HandoffRecord): void; reject(error: Error): void } | undefined;
  private settings: AssistantHandoffSettings | undefined;
  private reading: Promise<void> | undefined;
  private settingsError: string | undefined;
  private failureReason: string | undefined;
  private failedAt = 0;
  private failures = 0;
  private retryAt = 0;
  private toldFailure = false;
  private stopped = false;
  private epoch = 0;

  constructor(private readonly deps: HandoffDeps) {}

  /** This never gates chatting or model selection. The first successful read enables writing. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reading !== undefined) return this.reading;
    this.showStatus();
    this.reading = this.deps.settings().then((settings) => {
      if (this.stopped) return;
      if (settings === undefined) throw new Error("Main 尚未提供滚动整理设置");
      this.settings = settings;
      this.settingsError = undefined;
    }).catch((error: unknown) => {
      if (this.stopped) return;
      if (this.settingsError === undefined) this.deps.tell(this.settings === undefined
        ? "暂时读不到滚动整理设置，完整对话会保留，聊天照常。之后会重新读取设置，再开始整理。"
        : "暂时读不到新的滚动整理设置，继续沿用上次读到的配置。聊天照常，之后会重新读取。");
      this.settingsError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      this.reading = undefined;
      if (!this.stopped) this.showStatus();
    });
    return this.reading;
  }

  /** Checks the latest settings off the chat path, then starts a record in the background. */
  consider(tokens: number): void {
    const epoch = this.epoch;
    void this.refresh().then(() => {
      if (this.stopped || epoch !== this.epoch || this.settings === undefined) return;
      if (tokens < this.limits().startTokens || this.writing !== undefined || this.record !== undefined || this.adopting !== undefined) return;
      if ((this.deps.now ?? Date.now)() < this.retryAt) return;
      this.start(true);
    });
  }

  async retryNow(tokens: number): Promise<string> {
    if (this.stopped) return "助手正在停止，没有重试。";
    await this.refresh();
    if (this.settings === undefined) return "还没读到滚动整理设置，暂时不能整理。之后会自动重新读取。";
    if (this.writing !== undefined) return "已经在整理，完成后状态栏会更新。";
    if (this.record !== undefined || this.adopting !== undefined) {
      if (this.record) this.deps.ready();
      return "交接记录已经写好，会在下一轮回复前采用。";
    }
    const { startTokens } = this.limits();
    if (this.failures === 0 && tokens < startTokens) return `对话约 ${tokens} token，还没到开始整理的 ${startTokens} token，现在不用整理。`;
    this.retryAt = 0;
    this.start(true);
    return this.writing === undefined ? "现在没有可以整理的较早对话。" : "已开始重新整理，聊天照常。完成或失败都会显示在状态栏。";
  }

  compact(instructions?: string): Promise<HandoffRecord> {
    return new Promise<HandoffRecord>((resolve, reject) => {
      this.manual = { resolve, reject };
      void this.prepareManual(instructions, this.epoch).catch(reject);
    }).finally(() => { this.manual = undefined; });
  }

  private async prepareManual(instructions: string | undefined, epoch: number): Promise<void> {
    if (!this.writing && !this.record && !this.adopting) await this.refresh();
    if (this.stopped || this.epoch !== epoch || this.writing?.cancel.signal.aborted) throw new AgentCompactionKnownFailureError("cancelled", "Compaction cancelled");
    if (!this.writing && !this.record && !this.adopting) {
      if (!this.settings) throw new AgentCompactionKnownFailureError("failed", this.settingsError ?? "Main 尚未提供滚动整理设置");
      this.start(true, instructions);
      if (!this.writing) {
        const message = "现在没有可以整理的较早对话。";
        this.deps.tell(message);
        throw new AgentCompactionKnownFailureError("nothing_to_compact", message);
      }
    }
    if (this.record) this.deps.ready();
  }

  private limits(): HandoffLimits { return handoffLimits(this.deps.contextWindow(), this.settings); }

  mustWait(tokens: number): boolean {
    if (this.stopped || this.settings === undefined || tokens < this.limits().mustTokens) return false;
    // During backoff an existing write or ready record still takes its normal place; do not start another.
    return this.writing !== undefined || this.record !== undefined || this.failures === 0 || (this.deps.now ?? Date.now)() >= this.retryAt;
  }

  /**
   * Before a request to the model: past `mustTokens` she cannot go on without a record, so this
   * waits for the one under way or writes one now unless a failed write is cooling down.
   */
  async require(tokens: number): Promise<void> {
    // No valid configuration yet: keep the whole conversation, never guess a prompt.
    if (!this.mustWait(tokens) || this.record !== undefined || this.adopting !== undefined) return;
    const epoch = this.epoch;
    // Only the existing high-water wait can wait for settings; ordinary requests never do.
    await this.refresh();
    if (epoch !== this.epoch || !this.mustWait(tokens) || this.record !== undefined || this.adopting !== undefined) return;
    if (this.writing === undefined) this.start(false);
    await this.writing?.promise;
  }

  /** Adopt the ready record once. Only report a manual compact after adoption actually completes. */
  adopt(use: (record: HandoffRecord) => Promise<boolean>): Promise<boolean> | undefined {
    const record = this.record;
    if (!record) return undefined;
    this.record = undefined;
    const adoption = this.adopting = { record, committed: false };
    return use(record).then(applied => {
      if (this.adopting !== adoption) return false;
      if (applied) this.manual?.resolve(record);
      else this.manual?.reject(new AgentCompactionKnownFailureError("cancelled", "Compaction cancelled"));
      return applied;
    }, (error: unknown) => {
      if (this.adopting === adoption) this.manual?.reject(new AgentCompactionKnownFailureError("failed", error instanceof Error ? error.message : String(error)));
      throw error;
    }).finally(() => { if (this.adopting === adoption) this.adopting = undefined; });
  }

  /** Called immediately before the synchronous session append, after the last asynchronous read. */
  beginCommit(record: HandoffRecord): boolean {
    if (this.adopting?.record !== record) return false;
    this.adopting.committed = true;
    return true;
  }

  abortManual(): void {
    if (!this.manual || this.adopting?.committed) return;
    this.adopting = undefined;
    this.discard();
  }

  /** A record that may tell something forgotten meanwhile is thrown away; the next look writes another. */
  discard(): void {
    this.epoch += 1;
    this.writing?.cancel.abort();
    if (!this.adopting) this.manual?.reject(new AgentCompactionKnownFailureError("cancelled", "Compaction cancelled"));
    this.record = undefined;
    this.showStatus();
  }

  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.writing?.cancel.abort();
    this.manual?.reject(new AgentCompactionKnownFailureError("cancelled", "Compaction cancelled"));
  }

  get problem(): string | undefined {
    if (this.settingsError !== undefined) return `滚动整理：${this.settingsError}`;
    if (this.failureReason !== undefined) return `滚动整理失败原因：${this.failureReason}`;
    return undefined;
  }

  private showStatus(): void {
    if (this.stopped) return;
    this.deps.status(this.settingsError !== undefined ? "暂未读到整理设置，下次对话时重新读取"
      : this.writing !== undefined && this.failures > 0 ? `正在重试（${shortLocalTime(this.writing.startedAt)} 开始）`
      : this.failures > 0 ? `${shortLocalTime(new Date(this.failedAt))} 失败，最早 ${shortLocalTime(new Date(this.retryAt))} 后有对话时重试`
      : undefined);
  }

  private start(background: boolean, instructions?: string): void {
    // Capture one complete configuration. Reading newer settings never changes a write in flight.
    const settings = this.settings!;
    const limits = this.limits();
    const prepared = prepareHandoff(this.deps.branch(), limits.keepRecentTokens);
    if (prepared === undefined) return;
    const startedAt = new Date((this.deps.now ?? Date.now)());
    const cancel = new AbortController();
    const promise = this.write(prepared, instructions ? `${settings.prompt}\n\n${instructions}` : settings.prompt, cancel.signal).then((record) => {
      if (cancel.signal.aborted) return;
      this.failures = 0;
      this.toldFailure = false;
      this.record = record;
      this.failureReason = undefined;
      if (background || this.manual) this.deps.ready();
    }, (error: unknown) => {
      if (cancel.signal.aborted) return;
      const at = (this.deps.now ?? Date.now)();
      const reason = error instanceof Error ? error.message : String(error);
      this.failedAt = at;
      this.retryAt = at + RETRY_MINUTES[Math.min(this.failures, RETRY_MINUTES.length - 1)]! * 60_000;
      this.failures += 1;
      this.failureReason = reason;
      this.manual?.reject(new AgentCompactionKnownFailureError("failed", reason));
      if (this.toldFailure) return;
      this.toldFailure = true;
      this.deps.tell(`对话整理没有成功（${reason}）。原对话保留，下次对话时会自动重试，也可以在助手设置的“滚动整理对话”里立即重试。`);
    }).finally(() => {
      if (this.writing?.promise === promise) this.writing = undefined;
      this.showStatus();
    });
    this.writing = { promise, cancel, startedAt };
    this.showStatus();
  }

  private async write(prepared: PreparedHandoff, instruction: string, signal: AbortSignal): Promise<HandoffRecord> {
    const forgottenAtStart = new Set(await this.deps.forgotten() ?? []);
    // Dock's own notes are not the conversation: she gets a fresh status with every reply.
    const said = serializeConversation(convertToLlm(prepared.handedOver.filter((message) =>
      message.role !== "custom" || (message.customType !== STATUS_NOTE_TYPE && message.customType !== DOCK_NOTE_TYPE))));
    const prompt = [
      ...(prepared.previousSummary === undefined ? [] : [`<上一份交接记录>\n${prepared.previousSummary}\n</上一份交接记录>`]),
      `<对话>\n${said}\n</对话>`,
    ].join("\n\n");
    const summary = (await this.deps.complete(instruction, prompt, signal)).trim();
    if (summary.length === 0) throw new Error("模型没有写出交接记录");
    return { summary, firstKeptEntryId: prepared.firstKeptEntryId, tokensBefore: prepared.tokensBefore, forgottenAtStart };
  }
}

export interface PreparedHandoff {
  /** What the record replaces, as the model was given it. */
  handedOver: AgentMessage[];
  /** The first entry that stays as it was said. */
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
}

/**
 * Where the conversation is cut for a hand-over record: at the start of a turn (her owner's
 * message, a Work's message or the status note before them), so that about `keepRecentTokens` of
 * the latest conversation stay whole. Undefined when nothing lies before such a point.
 */
export function prepareHandoff(branch: SessionEntry[], keepRecentTokens: number): PreparedHandoff | undefined {
  if (branch.at(-1)?.type === "compaction") return undefined;
  // What the model is given now: the latest record first, then what it kept and what was said since.
  const entries = buildSessionProjection(branch).entries.filter((entry) => entry.messages.length > 0);
  const previous = entries[0]?.sourceEntry.type === "compaction" ? entries[0].sourceEntry : undefined;
  const start = previous === undefined ? 0 : 1;
  const opensTurn = (index: number): boolean => {
    const role = entries[index]!.messages[0]!.role;
    if (role !== "user" && role !== "custom") return false;
    const before = index > start ? entries[index - 1]!.messages[0]!.role : undefined;
    return before !== "user" && before !== "custom";
  };
  const tokens = entries.map((entry) => entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0));
  let cut = -1;
  let kept = 0;
  for (let index = entries.length - 1; index > start; index -= 1) {
    kept += tokens[index]!;
    if (!opensTurn(index)) continue;
    cut = index;
    if (kept >= keepRecentTokens) break;
  }
  if (cut <= start) return undefined;
  return {
    handedOver: entries.slice(start, cut).flatMap((entry) => entry.messages),
    firstKeptEntryId: entries[cut]!.sourceEntry.id,
    tokensBefore: tokens.reduce((sum, value) => sum + value, 0),
    ...(previous === undefined ? {} : { previousSummary: previous.summary }),
  };
}

/** Has the model take what her owner had her forget out of a hand-over record that may tell it. */
export function rewriteWithoutPrompt(record: string, forgotten: readonly string[]): { system: string; prompt: string } {
  return {
    system: "你在替一位个人助手改她的交接记录。主人让她忘掉了一些事，记录里不能再提它们。",
    prompt: [
      `<交接记录>\n${record}\n</交接记录>`,
      `<要忘掉的事>\n${forgotten.map((text) => `- ${text}`).join("\n")}\n</要忘掉的事>`,
      "把交接记录里提到这些事的内容删掉，其余一字不改，直接输出改好的记录，不要解释。记录里本来就没提到的话，原样输出。",
    ].join("\n\n"),
  };
}
