export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface RuntimePromptOptions {
  streamingBehavior?: "steer" | "followUp";
  source?: "interactive" | "rpc" | "extension";
  preflightResult?: (success: boolean) => void;
}

export interface ClearedRuntimeQueue {
  steering: string[];
  followUp: string[];
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
  clearQueue(): ClearedRuntimeQueue;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}
