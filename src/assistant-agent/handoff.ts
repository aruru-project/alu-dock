import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, convertToLlm, estimateTokens, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";

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

/** A record is written at half the model's window, at most 100k tokens; she waits for it at one and a half times that. */
export function handoffLimits(contextWindow: number): HandoffLimits {
  const startTokens = Math.min(Math.floor((contextWindow > 0 ? contextWindow : 200_000) / 2), 100_000);
  return { startTokens, mustTokens: Math.floor(startTokens * 1.5), keepRecentTokens: Math.min(20_000, Math.floor(startTokens * 0.3)) };
}

/** After a failed write the next one waits this long: 5, 15, 30, then 60 minutes. */
const RETRY_MINUTES = [5, 15, 30, 60];
const RECORD_TOKENS = 4_096;

const WRITER = [
  "你在替一位个人助手写交接记录。她和主人的对话太长了：下面这段较早的对话会从她眼前拿掉，只留下你写的这份记录，她靠它接着往下做事。",
  "原话都另外存着，她以后搜得到，所以不要复述经过。主人是什么样的人、有什么喜好，由她的记忆保管；每天做了什么，由她的时间线保管。这两样都不要写进来。",
].join("\n");

const WHAT_TO_WRITE = [
  "写一份交接记录，用中文，直接写内容，不要开场白。只写下面这些，哪一项没有就不写那一项：",
  "1. 主人交代过、还没办完的事，以及他提的要求和边界，尽量用他的原话。",
  "2. 她派出去的 Work：叫什么、交给它什么、做到哪了、交回了什么结果。",
  "3. 她在等的回答（等主人的、等哪个 Work 的），和她答应过还没做的事。",
  "4. 这段对话里刚定下来、后面还会用到的结论。",
  "已经了结的事、寒暄和闲聊不写。对话里没有的内容不要编。",
].join("\n");

export interface HandoffDeps {
  /** The whole conversation, oldest first. */
  branch(): SessionEntry[];
  limits(): HandoffLimits;
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
  private failures = 0;
  private retryAt = 0;
  private toldFailure = false;

  constructor(private readonly deps: HandoffDeps) {}

  /** Starts a record in the background when the conversation is long enough and none is under way. */
  consider(tokens: number): void {
    if (tokens < this.deps.limits().startTokens || this.writing !== undefined || this.record !== undefined) return;
    if ((this.deps.now ?? Date.now)() < this.retryAt) return;
    this.start(true);
  }

  /**
   * Before a request to the model: past `mustTokens` she cannot go on without a record, so this
   * waits for the one under way or writes one now. Otherwise it returns at once.
   */
  async require(tokens: number): Promise<void> {
    if (tokens < this.deps.limits().mustTokens || this.record !== undefined) return;
    if (this.writing === undefined) this.start(false);
    await this.writing?.promise;
  }

  /** The finished record, handed over once. */
  take(): HandoffRecord | undefined {
    const record = this.record;
    this.record = undefined;
    return record;
  }

  /** A record that may tell something forgotten meanwhile is thrown away; the next look writes another. */
  discard(): void {
    this.writing?.cancel.abort();
    this.record = undefined;
  }

  stop(): void { this.writing?.cancel.abort(); }

  private start(background: boolean): void {
    const cancel = new AbortController();
    const promise = this.write(cancel.signal).then((record) => {
      if (cancel.signal.aborted) return;
      this.failures = 0;
      this.toldFailure = false;
      this.record = record;
      if (record !== undefined && background) this.deps.ready();
    }, (error: unknown) => {
      if (cancel.signal.aborted) return;
      this.retryAt = (this.deps.now ?? Date.now)() + RETRY_MINUTES[Math.min(this.failures, RETRY_MINUTES.length - 1)]! * 60_000;
      this.failures += 1;
      if (this.toldFailure) return;
      this.toldFailure = true;
      this.deps.tell(`助手整理较早的对话没有成功（${error instanceof Error ? error.message : String(error)}）。对话照常继续，她过一阵会再试；一直不成功的话，对话太长时回复可能出错。`);
    }).finally(() => { if (this.writing?.promise === promise) this.writing = undefined; });
    this.writing = { promise, cancel };
  }

  private async write(signal: AbortSignal): Promise<HandoffRecord | undefined> {
    const prepared = prepareHandoff(this.deps.branch(), this.deps.limits().keepRecentTokens);
    if (prepared === undefined) return undefined;
    const forgottenAtStart = new Set(await this.deps.forgotten() ?? []);
    const said = serializeConversation(convertToLlm(prepared.handedOver));
    const prompt = [
      ...(prepared.previousSummary === undefined ? [] : [`<上一份交接记录>\n${prepared.previousSummary}\n</上一份交接记录>`, "上一份记录里还没了结的事要带到新记录里，已经了结的去掉。"]),
      `<对话>\n${said}\n</对话>`,
      WHAT_TO_WRITE,
    ].join("\n\n");
    const summary = (await this.deps.complete(WRITER, prompt, RECORD_TOKENS, signal)).trim();
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
