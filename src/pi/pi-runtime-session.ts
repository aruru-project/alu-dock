import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimePromptOptions,
  RuntimeSession,
} from "../core/runtime-session.js";

/** Public AgentSession adapter used by the host state machine. */
export class PiRuntimeSession implements RuntimeSession {
  constructor(readonly session: AgentSession) {}

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
