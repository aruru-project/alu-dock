import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeThinkingLevel,
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
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private currentRun: Deferred<void> | undefined;
  private modelState: RuntimeModelState = {
    model: { provider: "fixture", id: "default" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "low", "high"],
  };

  constructor(readonly sessionId: string) {
    this.sessionFile = `/tmp/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    options?.preflightResult?.(true);
    if (this.isStreaming && options?.streamingBehavior) {
      if (options.streamingBehavior === "steer") this.steeringQueue.push(text);
      else this.followUpQueue.push(text);
      this.emitQueue();
      return Promise.resolve();
    }
    if (this.isStreaming) return Promise.reject(new Error("fake runtime already streaming"));

    this.currentRun = new Deferred<void>();
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    return this.currentRun.promise;
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return [
      { provider: "fixture", id: "default", name: "Fixture Default", reasoning: true },
      { provider: "fixture", id: "local", name: "Fixture Local", reasoning: true },
    ];
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    this.modelState = { ...this.modelState, model: { provider, id: modelId } };
    return this.getModelState();
  }

  setThinkingLevel(level: RuntimeThinkingLevel): RuntimeModelState {
    this.modelState = { ...this.modelState, thinkingLevel: level };
    return this.getModelState();
  }

  getModelState(): RuntimeModelState {
    return {
      ...this.modelState,
      model: this.modelState.model ? { ...this.modelState.model } : undefined,
      availableThinkingLevels: [...this.modelState.availableThinkingLevels],
    };
  }

  clearQueue(): ClearedRuntimeQueue {
    const cleared = {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    };
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.emitQueue();
    return cleared;
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

  private emitQueue(): void {
    this.emit({
      type: "queue_update",
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    });
  }
}
