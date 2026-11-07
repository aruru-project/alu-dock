import { Worker } from "node:worker_threads";

import { AssistantError, isAssistantErrorCode, type AssistantContextRequest, type AssistantContextResult, type AssistantSearchRequest, type AssistantSearchResult } from "../core/assistant.js";

/*
 * Searches and context reads run on a fixed number of threads, each with its own read connection, so
 * a slow read holds up neither writes nor the other reads.
 *
 * Node's synchronous SQLite cannot be interrupted, and ending a thread waits for its running query
 * (measured on Node 24.22: about 11 s for an 11 s query). So a read's time limit works in two ways:
 * the asker hears "timed out" when the limit passes, counted from when it asked, queue time
 * included; and the thread stops the read itself at its next step past that time (store.ts). Until
 * the thread answers, it stays busy and gets nothing new: at worst reads wait or are refused, and
 * there are never more threads than configured.
 */

export type ReaderTask =
  | { op: "search"; request: AssistantSearchRequest }
  | { op: "context"; request: AssistantContextRequest };
export type ReaderMessage = { id: number; task: ReaderTask; deadline: number };
export type ReaderAnswer =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; message: string; code?: string };

export interface AssistantReadersOptions {
  databasePath: string;
  /** Threads answering at the same time. */
  threads?: number;
  /** How long an asker waits, queue time included. */
  timeoutMs?: number;
  /** Reads waiting for a thread; more are refused at once. */
  maxWaiting?: number;
}

interface Read {
  id: number;
  task: ReaderTask;
  deadline: number;
  settled: boolean;
  timer: NodeJS.Timeout;
  resolve(result: unknown): void;
  reject(error: Error): void;
  detach(): void;
}

interface Thread {
  worker: Worker;
  read: Read | undefined;
}

const ENTRY = new URL("./reader-entry.js", import.meta.url);
const DEFAULT_THREADS = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_WAITING = 32;
/** A thread that failed is started again after this long, so a broken database does not spin. */
const RESTART_DELAY_MS = 1_000;
const TIMEOUT_MESSAGE = "这次查询超时，没有返回结果。请换个更具体的词，或者缩小时间范围再试。";
const BUSY_MESSAGE = "助手正在处理很多查询，这次没有排上。请稍后再试。";
const STOPPING_MESSAGE = "The assistant service is stopping";

export class AssistantReaders {
  private readonly threads: Thread[] = [];
  private readonly waiting: Read[] = [];
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: AssistantReadersOptions) {
    for (let index = 0; index < (options.threads ?? DEFAULT_THREADS); index += 1) this.start();
  }

  search(request: AssistantSearchRequest, signal?: AbortSignal): Promise<AssistantSearchResult> {
    return this.run({ op: "search", request }, signal) as Promise<AssistantSearchResult>;
  }

  context(request: AssistantContextRequest, signal?: AbortSignal): Promise<AssistantContextResult> {
    return this.run({ op: "context", request }, signal) as Promise<AssistantContextResult>;
  }

  /** Answers every open read with a refusal; threads still in a query end when it returns. */
  async close(): Promise<void> {
    this.closed = true;
    for (const read of this.waiting.splice(0)) settle(read, new AssistantError("assistant_unavailable", STOPPING_MESSAGE));
    for (const thread of this.threads) if (thread.read) settle(thread.read, new AssistantError("assistant_unavailable", STOPPING_MESSAGE));
    await Promise.all(this.threads.splice(0).map((thread) => thread.worker.terminate().catch(() => 0)));
  }

  private run(task: ReaderTask, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new AssistantError("assistant_unavailable", STOPPING_MESSAGE));
    if (signal?.aborted) return Promise.reject(new Error("Assistant request cancelled"));
    if (this.waiting.length >= (this.options.maxWaiting ?? DEFAULT_MAX_WAITING)) return Promise.reject(new AssistantError("assistant_unavailable", BUSY_MESSAGE));
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const cancel = () => { this.drop(read); settle(read, new Error("Assistant request cancelled")); };
      const read: Read = {
        id: ++this.nextId,
        task,
        deadline: Date.now() + timeoutMs,
        settled: false,
        // The asker hears at the deadline; a thread still in the read stays busy until it answers.
        timer: setTimeout(() => { this.drop(read); settle(read, new AssistantError("assistant_query_timeout", TIMEOUT_MESSAGE)); }, timeoutMs),
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", cancel),
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiting.push(read);
      this.dispatch();
    });
  }

  /** Removes a read that has not reached a thread. */
  private drop(read: Read): void {
    const index = this.waiting.indexOf(read);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  private dispatch(): void {
    for (const thread of this.threads) {
      if (thread.read) continue;
      const read = this.waiting.shift();
      if (!read) return;
      thread.read = read;
      thread.worker.postMessage({ id: read.id, task: read.task, deadline: read.deadline } satisfies ReaderMessage);
    }
  }

  private start(): void {
    const thread: Thread = { worker: new Worker(ENTRY, { workerData: { databasePath: this.options.databasePath } }), read: undefined };
    this.threads.push(thread);
    thread.worker.on("message", (answer: ReaderAnswer) => {
      const read = thread.read;
      // A late answer to a read that timed out or was cancelled frees the thread and is dropped.
      if (!read || read.id !== answer.id) return;
      thread.read = undefined;
      settle(read, answer.ok ? { result: answer.result } : isAssistantErrorCode(answer.code) ? new AssistantError(answer.code, answer.message) : new Error(answer.message));
      this.dispatch();
    });
    // A thread that failed, or exited, is taken out; the read it held fails, and a new one starts later.
    let ended = false;
    const end = (error: Error) => {
      if (ended) return;
      ended = true;
      const index = this.threads.indexOf(thread);
      if (index < 0) return;
      this.threads.splice(index, 1);
      if (thread.read) settle(thread.read, error);
      thread.read = undefined;
      if (this.closed) return;
      setTimeout(() => { if (!this.closed) { this.start(); this.dispatch(); } }, RESTART_DELAY_MS).unref();
    };
    thread.worker.on("error", (error) => end(new AssistantError("assistant_unavailable", `A memory reader stopped: ${error instanceof Error ? error.message : String(error)}`)));
    thread.worker.on("exit", (code) => end(new AssistantError("assistant_unavailable", `A memory reader exited (${code})`)));
    thread.worker.unref();
  }
}

/** Answers a read once; later outcomes of the same read are ignored. */
function settle(read: Read, outcome: { result: unknown } | Error): void {
  if (read.settled) return;
  read.settled = true;
  clearTimeout(read.timer);
  read.detach();
  if (outcome instanceof Error) read.reject(outcome);
  else read.resolve(outcome.result);
}
