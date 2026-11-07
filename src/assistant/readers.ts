import { Worker } from "node:worker_threads";

import { AssistantError, isAssistantErrorCode, type AssistantContextRequest, type AssistantContextResult, type AssistantSearchRequest, type AssistantSearchResult } from "../core/assistant.js";

/*
 * Searches and context reads run on their own threads, each with its own read connection, so a
 * slow one holds up neither writes nor the other reads. A read that takes too long is stopped by
 * ending its thread, and a fresh thread takes its place.
 */

export type ReaderTask =
  | { op: "search"; request: AssistantSearchRequest }
  | { op: "context"; request: AssistantContextRequest };
export type ReaderMessage = { id: number; task: ReaderTask };
export type ReaderAnswer =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; message: string; code?: string };

export interface AssistantReadersOptions {
  databasePath: string;
  /** Threads answering at the same time. */
  threads?: number;
  /** A read still running after this long is stopped and answered with a refusal. */
  timeoutMs?: number;
}

interface Waiting {
  id: number;
  task: ReaderTask;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const ENTRY = new URL("./reader-entry.js", import.meta.url);
const DEFAULT_THREADS = 2;
const DEFAULT_TIMEOUT_MS = 15_000;

export class AssistantReaders {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, { waiting: Waiting; timer: NodeJS.Timeout }>();
  private readonly queue: Waiting[] = [];
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: AssistantReadersOptions) {
    for (let index = 0; index < (options.threads ?? DEFAULT_THREADS); index += 1) this.idle.push(this.spawn());
  }

  search(request: AssistantSearchRequest): Promise<AssistantSearchResult> {
    return this.run({ op: "search", request }) as Promise<AssistantSearchResult>;
  }

  context(request: AssistantContextRequest): Promise<AssistantContextResult> {
    return this.run({ op: "context", request }) as Promise<AssistantContextResult>;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.queue.splice(0)) waiting.reject(new AssistantError("assistant_unavailable", "The assistant service is stopping"));
    const threads = [...this.idle.splice(0), ...this.busy.keys()];
    for (const [, running] of this.busy) { clearTimeout(running.timer); running.waiting.reject(new AssistantError("assistant_unavailable", "The assistant service is stopping")); }
    this.busy.clear();
    await Promise.all(threads.map((thread) => thread.terminate()));
  }

  private run(task: ReaderTask): Promise<unknown> {
    if (this.closed) return Promise.reject(new AssistantError("assistant_unavailable", "The assistant service is stopping"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, task, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const thread = this.idle.pop()!;
      const waiting = this.queue.shift()!;
      const timer = setTimeout(() => this.stopSlow(thread), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.busy.set(thread, { waiting, timer });
      thread.postMessage({ id: waiting.id, task: waiting.task } satisfies ReaderMessage);
    }
  }

  private spawn(): Worker {
    const thread = new Worker(ENTRY, { workerData: { databasePath: this.options.databasePath } });
    thread.on("message", (answer: ReaderAnswer) => {
      const running = this.busy.get(thread);
      if (!running || running.waiting.id !== answer.id) return;
      clearTimeout(running.timer);
      this.busy.delete(thread);
      if (answer.ok) running.waiting.resolve(answer.result);
      else running.waiting.reject(isAssistantErrorCode(answer.code) ? new AssistantError(answer.code, answer.message) : new Error(answer.message));
      this.idle.push(thread);
      this.dispatch();
    });
    // A thread that failed outside a read is replaced; the read it held fails with the reason.
    thread.on("error", (error) => this.replace(thread, error instanceof Error ? error : new Error(String(error))));
    thread.unref();
    return thread;
  }

  private stopSlow(thread: Worker): void {
    this.replace(thread, new AssistantError("assistant_query_timeout", "这次查询太久没有结果，已经停下。请换个更具体的词，或者缩小时间范围再试。"));
    void thread.terminate();
  }

  private replace(thread: Worker, error: Error): void {
    const running = this.busy.get(thread);
    if (running) { clearTimeout(running.timer); this.busy.delete(thread); running.waiting.reject(error); }
    const idle = this.idle.indexOf(thread);
    if (idle >= 0) this.idle.splice(idle, 1);
    thread.removeAllListeners("message");
    if (this.closed) return;
    this.idle.push(this.spawn());
    this.dispatch();
  }
}
