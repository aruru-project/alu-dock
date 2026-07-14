export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface RuntimePromptOptions {
  streamingBehavior?: "steer" | "followUp";
  source?: "interactive" | "rpc" | "extension";
  preflightResult?: (success: boolean) => void;
}

export type RuntimeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface RuntimeModelState {
  model: { provider: string; id: string } | undefined;
  thinkingLevel: RuntimeThinkingLevel;
  availableThinkingLevels: RuntimeThinkingLevel[];
}

export interface ClearedRuntimeQueue {
  steering: string[];
  followUp: string[];
}

export class RuntimeModelNotFoundError extends Error {
  constructor(provider: string, modelId: string) {
    super(`Pi model not found or unavailable: ${provider}/${modelId}`);
    this.name = "RuntimeModelNotFoundError";
  }
}

/**
 * Small public-contract surface that ManagedInstance needs from Pi's
 * AgentSession. Keeping it structural makes lifecycle tests deterministic and
 * prevents the host state machine from depending on Pi internals.
 */
export interface RuntimeSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;

  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  prompt(text: string, options?: RuntimePromptOptions): Promise<void>;
  listModels(): Promise<RuntimeModelInfo[]>;
  selectModel(provider: string, modelId: string): Promise<RuntimeModelState>;
  setThinkingLevel(level: RuntimeThinkingLevel): RuntimeModelState;
  getModelState(): RuntimeModelState;
  clearQueue(): ClearedRuntimeQueue;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}
