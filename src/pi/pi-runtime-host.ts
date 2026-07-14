import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type PromptOptions,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
import { configurePiNetwork } from "./configure-pi-network.js";

export interface PiSessionCatalogInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: Date;
}

export interface PiSessionCatalog {
  list(cwd: string, sessionDir?: string): Promise<PiSessionCatalogInfo[]>;
  listAll(sessionDir?: string): Promise<PiSessionCatalogInfo[]>;
}

const DEFAULT_SESSION_CATALOG: PiSessionCatalog = {
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  listAll: (sessionDir) => sessionDir === undefined ? SessionManager.listAll() : SessionManager.listAll(sessionDir),
};

type RuntimeOwner = Pick<AgentSessionRuntime,
  "session" | "services" | "cwd" | "diagnostics" | "modelFallbackMessage" |
  "setBeforeSessionInvalidate" | "setRebindSession" | "newSession" | "switchSession" | "dispose"
>;

type ReplacementKind = "new" | "switch" | "reload";

export interface PiRuntimeHostOptions {
  runtime: RuntimeOwner;
  sessionCatalog?: PiSessionCatalog;
  setProjectTrust?: (cwd: string, trusted: boolean) => void;
  commitReplacement?: (change: { operationId: string; kind: ReplacementKind; previousSessionFile?: string; sessionFile?: string }) => Promise<void>;
  commitRuntimeError?: (failure: { operationId: string; kind: ReplacementKind; error: unknown; recoverySessionFile?: string }) => Promise<void>;
}

export interface CreatePiRuntimeHostOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  projectTrusted: boolean;
}

interface BindingToken { active: boolean }
interface Binding {
  token: BindingToken;
  session: AgentSession;
  services: AgentSessionServices;
  unsubscribe: () => void;
  buffered: RuntimeEvent[];
  bufferEvents: boolean;
}

/** Stable Host-owned facade around the SDK's one mutable AgentSessionRuntime. */
export class PiRuntimeHost implements RuntimeSession {
  private readonly subscribers = new Set<(event: RuntimeEvent) => void>();
  private active: Binding | undefined;
  private staged: Binding | undefined;
  private disposed = false;
  private runtimeDisposed = false;
  private unavailable = false;
  private disposePromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private rebindEntered = false;
  private replacementInvalidated = false;
  private replacementRunning = false;
  private initialActivated = false;

  private constructor(private readonly options: PiRuntimeHostOptions) {
    options.runtime.setBeforeSessionInvalidate(() => {
      if (this.replacementRunning) this.replacementInvalidated = true;
      this.invalidateBindingsSynchronously();
    });
    options.runtime.setRebindSession(async (session) => {
      this.rebindEntered = true;
      await this.stageCandidate(session);
    });
  }

  static async create(options: PiRuntimeHostOptions): Promise<PiRuntimeHost> {
    const host = new PiRuntimeHost(options);
    try {
      await host.stageCandidate(options.runtime.session);
      host.promoteInitial();
      return host;
    } catch (error) {
      await host.disposeRuntimeOnce().catch(() => {});
      host.disposed = true;
      throw error;
    }
  }

  get sessionId(): string { return this.requireActive().session.sessionId; }
  get sessionFile(): string | undefined { return this.requireActive().session.sessionFile; }
  get isStreaming(): boolean { return this.active?.session.isStreaming ?? false; }
  get diagnostics(): readonly unknown[] { return this.options.runtime.diagnostics; }
  get modelFallbackMessage(): string | undefined { return this.options.runtime.modelFallbackMessage; }
  currentSession(): AgentSession { return this.requireActive().session; }

  /** Flush startup events only after ManagedInstance has attached its stable subscriber. */
  activateInitial(): void {
    if (this.initialActivated) return;
    const binding = this.requireActive();
    this.initialActivated = true;
    const events = binding.buffered;
    binding.buffered = [];
    binding.bufferEvents = false;
    for (const event of events) this.publish(event);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    return this.requireActive().session.prompt(text, options as PromptOptions | undefined);
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return this.requireActive().services.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    })).sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  }

  async listSessions(scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]> {
    const binding = this.requireActive();
    const manager = binding.session.sessionManager;
    const catalog = this.options.sessionCatalog ?? DEFAULT_SESSION_CATALOG;
    const sessions = scope === "cwd"
      ? await catalog.list(manager.getCwd(), manager.getSessionDir())
      : manager.usesDefaultSessionDir() ? await catalog.listAll() : await catalog.listAll(manager.getSessionDir());
    return sessions.map((info) => ({
      sessionId: info.id, sessionFile: info.path, ...(info.name === undefined ? {} : { name: info.name }), cwd: info.cwd,
      ...(validDate(info.modified) ? { updatedAt: info.modified.toISOString() } : {}),
    }));
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    const binding = this.requireActive();
    const model = binding.services.modelRegistry.find(provider, modelId);
    if (!model || !binding.services.modelRegistry.hasConfiguredAuth(model)) throw new RuntimeModelNotFoundError(provider, modelId);
    this.assertCleanSettingsBaseline(binding, "model");
    await binding.session.setModel(model);
    await this.persistSettings(binding, "model");
    return this.getModelState();
  }

  async setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> {
    const binding = this.requireActive();
    this.assertCleanSettingsBaseline(binding, "thinking");
    binding.session.setThinkingLevel(level);
    await this.persistSettings(binding, "thinking");
    return this.getModelState();
  }

  getModelState(): RuntimeModelState {
    const session = this.requireActive().session;
    return {
      model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: [...session.getAvailableThinkingLevels()],
    };
  }

  clearQueue(): ClearedRuntimeQueue { return this.requireActive().session.clearQueue(); }
  abort(): Promise<void> { return this.active?.session.abort() ?? Promise.resolve(); }
  waitForIdle(): Promise<void> { return this.active?.session.waitForIdle() ?? Promise.resolve(); }

  newSession(operationId: string): Promise<{ cancelled: boolean }> {
    return this.serialize(() => this.replace(operationId, "new", () => this.options.runtime.newSession()));
  }

  switchSession(
    operationId: string,
    path: string,
    trust: { canonicalCwd: string; projectTrusted: boolean },
  ): Promise<{ cancelled: boolean }> {
    return this.serialize(() => {
      this.options.setProjectTrust?.(trust.canonicalCwd, trust.projectTrusted);
      return this.replace(operationId, "switch", () => this.options.runtime.switchSession(path));
    });
  }

  reload(operationId: string): Promise<{ cancelled: false }> {
    return this.serialize(async () => {
      const previousSessionFile = this.sessionFile;
      const binding = this.requireActive();
      const buffered: RuntimeEvent[] = [];
      const originalBuffer = binding.buffered;
      binding.buffered = buffered;
      binding.bufferEvents = true;
      try {
        let seamCalls = 0;
        await binding.session.reload({ beforeSessionStart: () => { seamCalls += 1; } });
        if (seamCalls !== 1) throw new Error(`Reload rebind seam ran ${seamCalls} times`);
        await this.options.commitReplacement?.({ operationId, kind: "reload", previousSessionFile, sessionFile: binding.session.sessionFile });
        this.publishReplacement("reload", previousSessionFile, binding.session.sessionFile);
        for (const event of buffered) this.publish(event);
        return { cancelled: false };
      } catch (error) {
        binding.token.active = false;
        binding.unsubscribe();
        this.active = undefined;
        await this.disposeRuntimeOnce().catch(() => {});
        this.unavailable = true;
        await this.commitRuntimeError(operationId, "reload", error, previousSessionFile);
        throw error;
      } finally {
        binding.bufferEvents = false;
        binding.buffered = originalBuffer;
      }
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      if (this.disposed) return;
      this.disposed = true;
      await this.mutationTail.catch(() => {});
      try {
        await this.disposeRuntimeOnce();
      } finally {
        this.invalidateBindingsSynchronously();
        this.subscribers.clear();
      }
    })();
    return this.disposePromise;
  }

  private async replace(operationId: string, kind: "new" | "switch", operation: () => Promise<{ cancelled: boolean }>): Promise<{ cancelled: boolean }> {
    const previousSessionFile = this.sessionFile;
    this.rebindEntered = false;
    this.replacementInvalidated = false;
    this.replacementRunning = true;
    try {
      const result = await operation();
      if (result.cancelled) {
        if (this.rebindEntered || this.replacementInvalidated || !this.active) {
          throw new Error("Cancelled replacement changed the active runtime binding");
        }
        return result;
      }
      if (!this.rebindEntered || !this.staged) throw new Error("Runtime replacement completed without exactly one rebind");
      await this.options.commitReplacement?.({ operationId, kind, previousSessionFile, sessionFile: this.staged.session.sessionFile });
      this.promoteStaged(kind, previousSessionFile);
      return result;
    } catch (error) {
      if (!this.replacementInvalidated) throw error;
      if (this.rebindEntered) await this.disposeRuntimeOnce().catch(() => {});
      else this.runtimeDisposed = true; // SDK already disposed the old session before factory failure.
      this.invalidateBindingsSynchronously();
      this.unavailable = true;
      await this.commitRuntimeError(operationId, kind, error, previousSessionFile);
      throw error;
    } finally {
      this.replacementRunning = false;
    }
  }

  private async commitRuntimeError(operationId: string, kind: ReplacementKind, error: unknown, recoverySessionFile?: string): Promise<void> {
    await this.options.commitRuntimeError?.({ operationId, kind, error, recoverySessionFile });
    this.publish({ type: "dock_runtime_error", operationId, kind, error: boundedErrorMessage(error), recoverySessionFile });
  }

  private async disposeRuntimeOnce(): Promise<void> {
    if (this.runtimeDisposed) return;
    this.runtimeDisposed = true;
    await this.options.runtime.dispose();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(() => {
      if (this.disposed || this.unavailable) throw new Error("Pi runtime is unavailable");
      return operation();
    });
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }

  private async stageCandidate(session: AgentSession): Promise<void> {
    if (this.staged) throw new Error("Runtime attempted more than one candidate rebind");
    const token = { active: true };
    const binding: Binding = { token, session, services: this.options.runtime.services, unsubscribe: () => {}, buffered: [], bufferEvents: true };
    binding.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (!token.active) return;
      const projected = event as unknown as RuntimeEvent;
      if (this.active === binding && !binding.bufferEvents) this.publish(projected);
      else binding.buffered.push(projected);
    });
    this.staged = binding;
    try {
      await session.bindExtensions({ mode: "print", onError: (error) => {
        if (!token.active) return;
        const event = { type: "dock_extension_error", error: boundedErrorMessage(error) };
        if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
      } });
    } catch (error) {
      token.active = false;
      binding.unsubscribe();
      if (this.staged === binding) this.staged = undefined;
      throw error;
    }
  }

  private promoteInitial(): void {
    const binding = this.staged;
    if (!binding) throw new Error("Initial runtime binding was not staged");
    this.staged = undefined;
    this.active = binding;
    // Keep startup events buffered until createPiInstance constructs ManagedInstance
    // and explicitly activates the initial binding.
  }

  private promoteStaged(kind: "new" | "switch", previousSessionFile?: string): void {
    const binding = this.staged;
    if (!binding) throw new Error("Replacement runtime binding was not staged");
    this.staged = undefined;
    this.active = binding;
    const events = binding.buffered;
    binding.buffered = [];
    binding.bufferEvents = false;
    this.publishReplacement(kind, previousSessionFile, binding.session.sessionFile);
    for (const event of events) this.publish(event);
  }

  private publishReplacement(kind: ReplacementKind, previousSessionFile?: string, sessionFile?: string): void {
    this.publish({
      type: "dock_session_replaced",
      reason: kind === "switch" ? "resume" : kind,
      previousSessionFile,
      sessionFile,
      cwd: this.active?.services.cwd,
    });
  }

  private invalidateBindingsSynchronously(): void {
    for (const binding of [this.active, this.staged]) {
      if (!binding) continue;
      binding.token.active = false;
      binding.unsubscribe();
    }
    this.active = undefined;
    this.staged = undefined;
  }

  private publish(event: RuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch { /* isolate Host observers from Pi callbacks */ }
    }
  }

  private requireActive(): Binding {
    if (!this.active || this.disposed || this.unavailable) throw new Error("Pi runtime is unavailable");
    return this.active;
  }

  private assertCleanSettingsBaseline(binding: Binding, setting: "model" | "thinking"): void {
    const failures = projectSettingsErrors(binding.services.settingsManager.drainErrors());
    if (failures.length > 0) throw new RuntimeSettingsWriteError(setting, "baseline", false, failures);
  }

  private async persistSettings(binding: Binding, setting: "model" | "thinking"): Promise<void> {
    const failures: Array<{ scope: "global" | "project" | "unknown"; message: string }> = [];
    try { await binding.services.settingsManager.flush(); }
    catch (error) { failures.push({ scope: "unknown", message: boundedErrorMessage(error) }); }
    failures.push(...projectSettingsErrors(binding.services.settingsManager.drainErrors()));
    if (failures.length > 0) throw new RuntimeSettingsWriteError(setting, "write", true, failures);
  }
}

export async function createPiRuntimeHost(options: CreatePiRuntimeHostOptions): Promise<PiRuntimeHost> {
  const trustByCwd = new Map<string, boolean>([[options.cwd, options.projectTrusted]]);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const canonicalCwd = await realpath(resolve(cwd));
    const settingsManager = SettingsManager.create(canonicalCwd, agentDir, {
      projectTrusted: trustByCwd.get(canonicalCwd) ?? false,
    });
    configurePiNetwork(settingsManager);
    const services = await createAgentSessionServices({ cwd: canonicalCwd, agentDir, settingsManager });
    const result = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, tools: options.tools, excludeTools: options.excludeTools,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const sessionManager = options.sessionDir
    ? SessionManager.create(options.cwd, options.sessionDir)
    : SessionManager.create(options.cwd);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd, agentDir: options.agentDir, sessionManager,
  });
  return PiRuntimeHost.create({
    runtime,
    setProjectTrust: (cwd, trusted) => trustByCwd.set(cwd, trusted),
  });
}

function projectSettingsErrors(errors: Array<{ scope: "global" | "project"; error: Error }>): Array<{ scope: "global" | "project"; message: string }> {
  return errors.map((failure) => ({ scope: failure.scope, message: boundedErrorMessage(failure.error) }));
}
function validDate(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`;
}
