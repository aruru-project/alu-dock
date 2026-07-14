import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimePromptOptions,
  RuntimeSession,
} from "../../src/core/runtime-session.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/** Deterministic in-flight runtime used only by control-plane tests. */
export class DelayedRuntimeSession implements RuntimeSession {
  readonly sessionFile: string;
  isStreaming = false;
  abortCalls = 0;
  disposeCalls = 0;

  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private currentRun: Deferred<void> | undefined;

  constructor(readonly sessionId: string) {
    this.sessionFile = `/tmp/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(_text: string, options?: RuntimePromptOptions): Promise<void> {
    options?.preflightResult?.(true);
    if (this.isStreaming && options?.streamingBehavior) return Promise.resolve();
    if (this.isStreaming) return Promise.reject(new Error("fake runtime already streaming"));

    this.currentRun = new Deferred<void>();
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    return this.currentRun.promise;
  }

  clearQueue(): ClearedRuntimeQueue {
    this.emit({ type: "queue_update", steering: [], followUp: [] });
    return { steering: [], followUp: [] };
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.isStreaming) this.settle("aborted", "aborted");
  }

  async waitForIdle(): Promise<void> {
    await this.currentRun?.promise;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  settle(text = "done", stopReason = "stop"): void {
    if (!this.currentRun || !this.isStreaming) return;
    const run = this.currentRun;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
      },
    });
    this.isStreaming = false;
    this.emit({ type: "agent_end", messages: [], willRetry: false });
    this.emit({ type: "agent_settled" });
    run.resolve();
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
