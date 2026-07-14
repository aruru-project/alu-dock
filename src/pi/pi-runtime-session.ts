import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type PromptOptions,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

interface SessionCatalogInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: Date;
}

export interface PiSessionCatalog {
  list(cwd: string, sessionDir?: string): Promise<SessionCatalogInfo[]>;
  listAll(sessionDir?: string): Promise<SessionCatalogInfo[]>;
}

const DEFAULT_SESSION_CATALOG: PiSessionCatalog = {
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  listAll: (sessionDir) => sessionDir === undefined
    ? SessionManager.listAll()
    : SessionManager.listAll(sessionDir),
};

import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import { RuntimeModelNotFoundError, RuntimeSettingsWriteError } from "../core/runtime-session.js";

/** Public AgentSession adapter used by the host state machine. */
export class PiRuntimeSession implements RuntimeSession {
  constructor(
    readonly session: AgentSession,
    private readonly modelRegistry: ModelRegistry,
    private readonly settingsManager: Pick<SettingsManager, "flush" | "drainErrors">,
    private readonly sessionManager: Pick<SessionManager, "getCwd" | "getSessionDir" | "usesDefaultSessionDir">,
    private readonly sessionCatalog: PiSessionCatalog = DEFAULT_SESSION_CATALOG,
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

  async listSessions(scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]> {
    const sessions = scope === "cwd"
      ? await this.sessionCatalog.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir())
      : this.sessionManager.usesDefaultSessionDir()
        ? await this.sessionCatalog.listAll()
        : await this.sessionCatalog.listAll(this.sessionManager.getSessionDir());
    return sessions.map((info) => ({
      sessionId: info.id,
      sessionFile: info.path,
      ...(info.name === undefined ? {} : { name: info.name }),
      cwd: info.cwd,
      ...(validDate(info.modified) ? { updatedAt: info.modified.toISOString() } : {}),
    }));
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    const model = this.modelRegistry.find(provider, modelId);
    if (!model || !this.modelRegistry.hasConfiguredAuth(model)) {
      throw new RuntimeModelNotFoundError(provider, modelId);
    }
    this.assertCleanSettingsBaseline("model");
    await this.session.setModel(model);
    await this.persistSettings("model");
    return this.getModelState();
  }

  async setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> {
    this.assertCleanSettingsBaseline("thinking");
    this.session.setThinkingLevel(level);
    await this.persistSettings("thinking");
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

  private assertCleanSettingsBaseline(setting: "model" | "thinking"): void {
    const failures = projectSettingsErrors(this.settingsManager.drainErrors());
    if (failures.length > 0) {
      throw new RuntimeSettingsWriteError(setting, "baseline", false, failures);
    }
  }

  private async persistSettings(setting: "model" | "thinking"): Promise<void> {
    const failures: Array<{ scope: "global" | "project" | "unknown"; message: string }> = [];
    try {
      await this.settingsManager.flush();
    } catch (error) {
      failures.push({ scope: "unknown", message: boundedErrorMessage(error) });
    }
    failures.push(...projectSettingsErrors(this.settingsManager.drainErrors()));
    if (failures.length > 0) {
      throw new RuntimeSettingsWriteError(setting, "write", true, failures);
    }
  }
}

function projectSettingsErrors(
  errors: ReturnType<Pick<SettingsManager, "drainErrors">["drainErrors"]>,
): Array<{ scope: "global" | "project"; message: string }> {
  return errors.map((failure) => ({
    scope: failure.scope,
    message: boundedErrorMessage(failure.error),
  }));
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`;
}
