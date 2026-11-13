import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, convertToLlm, estimateTokens, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { AssistantHandoffSettings } from "../core/assistant.js";
import { localTime } from "../core/local-time.js";
import { DOCK_NOTE_TYPE, STATUS_NOTE_TYPE } from "./status.js";

export const HANDOFF_STATUS_KEY = "滚动整理";
export const HANDOFF_STATE_TYPE = "assistant-handoff-result";

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
const RECORD_TOKENS = 4_096;

export interface HandoffDeps {
  /** The whole conversation, oldest first. */
  branch(): SessionEntry[];
  contextWindow(): number;
  /** Main supplies the saved instruction, including its factory default. No local prompt fallback. */
  settings(): Promise<AssistantHandoffSettings | undefined>;
  /** The Work's existing status surface; terminal results also stay in its own session. */
  status(text: string): void;
  rememberResult(text: string): void;
  /** One call to her model; rejects when it fails or is cancelled. */
  complete(system: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string>;
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
  private writing: { promise: Promise<void>; cancel: AbortController } | undefined;
  private record: HandoffRecord | undefined;
  private settings: AssistantHandoffSettings | undefined;
  private reading: Promise<void> | undefined;
  private settingsError = false;
  private inUse: { settings: AssistantHandoffSettings; limits: HandoffLimits } | undefined;
  private lastResult = "尚无整理结果。";
  private activity = "等待整理。";
  private failures = 0;
  private retryAt = 0;
  private toldFailure = false;
  private stopped = false;
  private epoch = 0;

  constructor(private readonly deps: HandoffDeps) {}

  /** Last result belongs to this Work, not to Main's memory service. */
  restore(result: unknown, lastCompactionAt?: string): void {
    if (typeof result === "string") this.lastResult = result;
    else if (lastCompactionAt !== undefined) this.lastResult = `最近采用交接记录：${localTime(new Date(lastCompactionAt))}。`;
  }

  /** This never gates chatting or model selection. The first successful read enables writing. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reading !== undefined) return this.reading;
    this.showStatus();
    this.reading = this.deps.settings().then((settings) => {
      if (this.stopped) return;
      if (settings === undefined) throw new Error("Main 尚未提供滚动整理设置");
      this.settings = settings;
      this.settingsError = false;
    }).catch(() => {
      if (this.stopped) return;
      if (!this.settingsError) this.deps.tell(this.settings === undefined
        ? "暂时读不到滚动整理设置，完整对话会保留，聊天照常。之后会重新读取设置，再开始整理。"
        : "暂时读不到新的滚动整理设置，继续沿用上次读到的配置。聊天照常，之后会重新读取。");
      this.settingsError = true;
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
      if (tokens < this.limits().startTokens || this.writing !== undefined || this.record !== undefined) return;
      if ((this.deps.now ?? Date.now)() < this.retryAt) return;
      this.start(true);
    });
  }

  private limits(): HandoffLimits { return handoffLimits(this.deps.contextWindow(), this.settings); }

  mustWait(tokens: number): boolean {
    return !this.stopped && this.settings !== undefined && tokens >= this.limits().mustTokens;
  }

  /**
   * Before a request to the model: past `mustTokens` she cannot go on without a record, so this
   * waits for the one under way or writes one now. Otherwise it returns at once.
   */
  async require(tokens: number): Promise<void> {
    // No valid configuration yet: keep the whole conversation, never guess a prompt.
    if (!this.mustWait(tokens) || this.record !== undefined) return;
    const epoch = this.epoch;
    // Only the existing high-water wait can wait for settings; ordinary requests never do.
    await this.refresh();
    if (this.stopped || epoch !== this.epoch || tokens < this.limits().mustTokens || this.record !== undefined) return;
    if (this.writing === undefined) this.start(false);
    await this.writing?.promise;
  }

  /** The finished record, handed over once. */
  take(): HandoffRecord | undefined {
    const record = this.record;
    this.record = undefined;
    return record;
  }

  applied(): void {
    this.activity = "等待下一次整理。";
    this.showStatus();
  }

  /** A record that may tell something forgotten meanwhile is thrown away; the next look writes another. */
  discard(): void {
    this.epoch += 1;
    this.writing?.cancel.abort();
    this.record = undefined;
    this.activity = "等待重新整理。";
    this.showStatus();
  }

  stop(): void { this.stopped = true; this.epoch += 1; this.writing?.cancel.abort(); }

  private showStatus(): void {
    if (this.stopped) return;
    const settings = this.inUse?.settings ?? this.settings;
    if (settings === undefined) {
      this.deps.status(`${this.settingsError ? "暂未读到" : "正在读取"}滚动整理设置，暂不整理，完整对话保留；聊天照常。${this.lastResult}`);
      return;
    }
    const limits = this.inUse?.limits ?? this.limits();
    const parts = [this.activity, this.lastResult,
      `${this.inUse ? "本次采用" : "当前采用"}：${limits.startTokens} token 开始整理，保留最近原话约 ${limits.keepRecentTokens} token（按整轮保留）。`];
    if (settings.keepRecentTokens !== null && settings.keepRecentTokens !== limits.keepRecentTokens) parts.push(`保存的保留量 ${settings.keepRecentTokens} token 超过当前整理预算，运行时已收敛为 ${limits.keepRecentTokens}；保存值未改。`);
    if (this.settingsError) parts.push("未读到新设置，沿用上次有效配置；之后会重新读取。");
    this.deps.status(parts.join("\n"));
  }

  private result(text: string): void {
    this.lastResult = text;
    this.deps.rememberResult(text);
  }

  private start(background: boolean): void {
    // Capture one complete configuration. Reading newer settings never changes a write in flight.
    const settings = this.settings!;
    const limits = this.limits();
    const prepared = prepareHandoff(this.deps.branch(), limits.keepRecentTokens);
    if (prepared === undefined) return;
    this.inUse = { settings, limits };
    this.activity = `正在后台整理（${localTime(new Date((this.deps.now ?? Date.now)()))} 开始），聊天照常。`;
    this.showStatus();
    const cancel = new AbortController();
    const promise = this.write(prepared, settings.prompt, cancel.signal).then((record) => {
      if (cancel.signal.aborted) return;
      this.failures = 0;
      this.toldFailure = false;
      this.record = record;
      this.activity = "交接记录已写好，在后续请求或两轮回复之间采用。";
      this.result(`上次整理成功：${localTime(new Date((this.deps.now ?? Date.now)()))}。`);
      if (background) this.deps.ready();
    }, (error: unknown) => {
      if (cancel.signal.aborted) return;
      this.retryAt = (this.deps.now ?? Date.now)() + RETRY_MINUTES[Math.min(this.failures, RETRY_MINUTES.length - 1)]! * 60_000;
      this.failures += 1;
      this.activity = `对话保留，${localTime(new Date(this.retryAt))} 后会再试；对话过长时也会再试。`;
      this.result(`上次整理失败：${localTime(new Date((this.deps.now ?? Date.now)()))}（${error instanceof Error ? error.message : String(error)}）。`);
      if (this.toldFailure) return;
      this.toldFailure = true;
      this.deps.tell(`助手整理较早的对话没有成功（${error instanceof Error ? error.message : String(error)}）。对话照常继续，她过一阵会再试；一直不成功的话，对话太长时回复可能出错。`);
    }).finally(() => {
      if (this.writing?.promise === promise) { this.writing = undefined; this.inUse = undefined; }
      this.showStatus();
    });
    this.writing = { promise, cancel };
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
    const summary = (await this.deps.complete(instruction, prompt, RECORD_TOKENS, signal)).trim();
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
