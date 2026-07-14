import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import { RuntimeModelNotFoundError } from "../core/runtime-session.js";

/** Public AgentSession adapter used by the host state machine. */
export class PiRuntimeSession implements RuntimeSession {
  constructor(
    readonly session: AgentSession,
    private readonly modelRegistry: ModelRegistry,
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.session.subscribe((event: AgentSessionEvent) => {
      listener(event as unknown as RuntimeEvent);
    });
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    return this.session.prompt(text, options as PromptOptions | undefined);
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return this.modelRegistry.getAvailable()
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
      }))
      .sort((left, right) => (
        left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name)
      ));
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    const model = this.modelRegistry.find(provider, modelId);
    if (!model || !this.modelRegistry.hasConfiguredAuth(model)) {
      throw new RuntimeModelNotFoundError(provider, modelId);
    }
    await this.session.setModel(model);
    return this.getModelState();
  }

  setThinkingLevel(level: RuntimeThinkingLevel): RuntimeModelState {
    this.session.setThinkingLevel(level);
    return this.getModelState();
  }

  getModelState(): RuntimeModelState {
    return {
      model: this.session.model
        ? { provider: this.session.model.provider, id: this.session.model.id }
        : undefined,
      thinkingLevel: this.session.thinkingLevel,
      availableThinkingLevels: [...this.session.getAvailableThinkingLevels()],
    };
  }

  clearQueue(): ClearedRuntimeQueue {
    return this.session.clearQueue();
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.session.waitForIdle();
  }

  dispose(): void {
    this.session.dispose();
  }
}
