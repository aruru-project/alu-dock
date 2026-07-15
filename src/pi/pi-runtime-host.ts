import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type PromptOptions,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SettingsManager,
  type ResourceDiagnostic,
  type SessionEntry,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import type { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import type {
  ClearedRuntimeQueue,
  RuntimeCompactionResult,
  RuntimeEvent,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeSessionMetrics,
  RuntimeSessionTarget,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import type {
  CommandDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  SourceDto,
  ToolDto,
} from "../core/config-projection.js";
import {
  compareCommandDtos,
  compareDiagnosticDtos,
  compareResourceDtos,
  compareToolDtos,
} from "../core/config-projection.js";
import { projectJsonObject } from "../core/managed-instance.js";
import { RuntimeModelNotFoundError, RuntimeSettingsWriteError, RuntimeUnknownToolError } from "../core/runtime-session.js";
import { configurePiNetwork } from "./configure-pi-network.js";
import { createPiExtensionUiContext } from "./pi-extension-ui-adapter.js";
import {
  applyPiSetting,
  assertPiSettingUpdate,
  projectPiSetting,
  projectPiSettings,
  projectSettingsErrors,
  validatedPiSettingValue,
} from "./pi-settings-adapter.js";

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
  extensionUiBroker?: ExtensionUiBroker;
  uiContext?: ExtensionUIContext;
}

export interface CreatePiRuntimeHostOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  projectTrusted: boolean;
  extensionUiBroker?: ExtensionUiBroker;
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
      options.extensionUiBroker?.beginGenerationChange();
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

  async listTools(): Promise<ToolDto[]> {
    const session = this.requireActive().session;
    return projectVisibleTools(session);
  }

  async setActiveTools(names: string[]): Promise<ToolDto[]> {
    const session = this.requireActive().session;
    if (!Array.isArray(names) || names.length > MAX_PROJECTION_ITEMS) throw new Error("Active tool names must be a bounded array");
    const registry = new Set(projectVisibleTools(session).map((tool) => tool.name));
    const seen = new Set<string>();
    for (const name of names) {
      if (typeof name !== "string" || name.length < 1 || name.length > 256) throw new Error("Active tool names must be bounded non-empty strings");
      if (seen.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      seen.add(name);
      if (!registry.has(name)) throw new RuntimeUnknownToolError(name);
    }
    session.setActiveToolsByName([...names]);
    return this.listTools();
  }

  async getSettings(): Promise<SettingDto[]> {
    const settings = this.requireActive().services.settingsManager;
    return projectPiSettings(settings);
  }

  async updateSetting(update: SettingUpdate): Promise<SettingDto> {
    assertPiSettingUpdate(update);
    const binding = this.requireActive();
    const key = update.key;
    this.assertCleanSettingsBaseline(binding, key);
    validatedPiSettingValue(binding.services.settingsManager, key);
    applyPiSetting(binding.session, binding.services.settingsManager, update);
    await this.persistSettings(binding, key);
    return projectPiSetting(binding.services.settingsManager, key);
  }

  async getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[] }> {
    const loader = this.requireActive().services.resourceLoader;
    const extensions = loader.getExtensions();
    const skills = loader.getSkills();
    const prompts = loader.getPrompts();
    const contexts = loader.getAgentsFiles();
    const resources: ResourceDto[] = [];
    for (const extension of extensions.extensions) {
      const path = boundedString(extension.resolvedPath || extension.path, 16_384, "");
      resources.push({
        kind: "extension", name: boundedString(basename(extension.path || extension.resolvedPath), 256, "extension"),
        ...(path ? { path } : {}), source: projectSource(extension.sourceInfo, "extension"),
      });
    }
    for (const skill of skills.skills) {
      const path = boundedString(skill.filePath, 16_384, "");
      resources.push({
        kind: "skill", name: boundedString(skill.name, 256, "skill"), ...(path ? { path } : {}),
        source: projectSource(skill.sourceInfo, "skill"),
      });
    }
    for (const prompt of prompts.prompts) {
      const path = boundedString(prompt.filePath, 16_384, "");
      resources.push({
        kind: "prompt", name: boundedString(prompt.name, 256, "prompt"), ...(path ? { path } : {}),
        source: projectSource(prompt.sourceInfo, "prompt"),
      });
    }
    for (const context of contexts.agentsFiles) {
      const path = boundedString(context.path, 16_384, "");
      resources.push({
        kind: "context", name: boundedString(basename(context.path), 256, "context"), ...(path ? { path } : {}),
      });
    }
    const diagnostics: DiagnosticDto[] = [
      ...extensions.errors.map((failure) => ({ severity: "error" as const, message: safeRequiredText(failure.error, 2_048, "Extension load failure omitted"), source: boundedString(failure.path, 256, "extension") })),
      ...skills.diagnostics.map(projectDiagnostic),
      ...prompts.diagnostics.map(projectDiagnostic),
    ];
    return {
      resources: capJsonItems(resources.sort(compareResourceDtos), 350_000),
      diagnostics: capJsonItems(diagnostics.sort(compareDiagnosticDtos), 250_000),
    };
  }

  async getCommands(): Promise<CommandDto[]> {
    const binding = this.requireActive();
    const loader = binding.services.resourceLoader;
    const commands: CommandDto[] = [];
    const extensionCommands = resolveExtensionCommands(loader.getExtensions().extensions);
    for (const command of extensionCommands) {
      const name = validCatalogName(command.invocationName);
      if (name === undefined) continue;
      const description = safeOptionalText(command.description, 2_048);
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        source: projectSource(command.sourceInfo, "extension"),
        argumentCompletions: command.argumentCompletions,
      });
    }
    for (const prompt of loader.getPrompts().prompts) {
      const name = validCatalogName(prompt.name);
      if (name === undefined) continue;
      const description = safeOptionalText(prompt.description, 2_048);
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        source: projectSource(prompt.sourceInfo, "prompt"),
        argumentCompletions: false,
      });
    }
    if (validatedPiSettingValue(binding.services.settingsManager, "enableSkillCommands")) {
      for (const skill of loader.getSkills().skills) {
        const name = validCatalogName(`skill:${skill.name}`);
        if (name === undefined) continue;
        const description = safeOptionalText(skill.description, 2_048);
        commands.push({
          name,
          ...(description === undefined ? {} : { description }),
          source: projectSource(skill.sourceInfo, "skill"),
          argumentCompletions: false,
        });
      }
    }
    return commands.sort(compareCommandDtos).slice(0, MAX_PROJECTION_ITEMS);
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

  getHistory(): RuntimeHistoryEntry[] {
    return this.requireActive().session.sessionManager.getBranch()
      .map(projectHistoryEntry)
      .filter((entry): entry is RuntimeHistoryEntry => entry !== undefined);
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

  getMetrics(): RuntimeSessionMetrics {
    const stats = this.requireActive().session.getSessionStats();
    return {
      messages: {
        user: stats.userMessages,
        assistant: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        total: stats.totalMessages,
      },
      tokens: { ...stats.tokens },
      cost: stats.cost,
      ...(stats.contextUsage === undefined ? {} : { context: { ...stats.contextUsage } }),
    };
  }

  clearQueue(): ClearedRuntimeQueue { return this.requireActive().session.clearQueue(); }
  async abort(): Promise<void> {
    const session = this.active?.session;
    if (!session) return;
    if (session.isCompacting) {
      let resolveCompaction!: () => void;
      const compactionEnded = new Promise<void>((resolve) => { resolveCompaction = resolve; });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "compaction_end") resolveCompaction();
      });
      try {
        session.abortCompaction();
        await compactionEnded;
      } finally {
        unsubscribe();
      }
    } else {
      await session.abort();
    }
    await session.waitForIdle();
  }
  waitForIdle(): Promise<void> { return this.active?.session.waitForIdle() ?? Promise.resolve(); }

  async resolveSessionTarget(path: string): Promise<RuntimeSessionTarget> {
    const manager = SessionManager.open(path);
    return { canonicalCwd: await realpath(resolve(manager.getCwd())) };
  }

  newSession(operationId: string, parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.serialize(() => this.replace(
      operationId,
      "new",
      () => this.options.runtime.newSession(parentSession === undefined ? undefined : { parentSession }),
    ));
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

  setSessionName(name: string): string | undefined {
    const session = this.requireActive().session;
    session.setSessionName(name);
    return session.sessionManager.getSessionName();
  }

  compact(customInstructions?: string): Promise<RuntimeCompactionResult> {
    return this.serialize(async () => {
      const result = await this.requireActive().session.compact(customInstructions);
      return {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      };
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
      this.options.extensionUiBroker?.beginGenerationChange();
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
        await this.options.extensionUiBroker?.failGenerationChange();
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
      await this.options.extensionUiBroker?.failGenerationChange();
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
      await session.bindExtensions({ uiContext: this.options.uiContext, mode: this.options.uiContext ? "rpc" : "print", onError: (error) => {
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
      name: this.active?.session.sessionManager.getSessionName(),
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

  private assertCleanSettingsBaseline(binding: Binding, setting: SettingKey | "model" | "thinking"): void {
    const failures = projectSettingsErrors(binding.services.settingsManager.drainErrors());
    if (failures.length > 0) throw new RuntimeSettingsWriteError(setting, "baseline", false, failures);
  }

  private async persistSettings(binding: Binding, setting: SettingKey | "model" | "thinking"): Promise<void> {
    const failures: Array<{ scope: "global" | "project" | "unknown"; message: string }> = [];
    try { await binding.services.settingsManager.flush(); }
    catch (error) { failures.push({ scope: "unknown", message: boundedErrorMessage(error) }); }
    failures.push(...projectSettingsErrors(binding.services.settingsManager.drainErrors()));
    if (failures.length > 0) throw new RuntimeSettingsWriteError(setting, "write", true, failures);
  }
}

const MAX_PROJECTION_ITEMS = 2_000;
const DATA_URI = /data:[^,]*;base64,/i;
const RAW_BASE64 = /^(?:[A-Za-z0-9+/]{4}){32,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function boundedString(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function safeOptionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || DATA_URI.test(value) || RAW_BASE64.test(value.replace(/\s+/g, ""))) return undefined;
  return boundedString(value, limit, "");
}

function safeRequiredText(value: unknown, limit: number, fallback: string): string {
  return safeOptionalText(value, limit) ?? fallback;
}

function projectHistoryEntry(entry: SessionEntry): RuntimeHistoryEntry | undefined {
  const base = {
    entryId: entry.id,
    ...(entry.parentId === null ? {} : { parentId: entry.parentId }),
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "custom" && message.display === false) return undefined;
    let content: unknown = message.content;
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      content = `! ${command}${output ? `\n${output}` : ""}`;
    } else if (role === "branchSummary" || role === "compactionSummary") {
      content = typeof message.summary === "string" ? message.summary : "";
    }
    return {
      ...base,
      role,
      content,
      ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    };
  }
  if (entry.type === "custom_message") {
    if (!entry.display) return undefined;
    return { ...base, role: "system", content: entry.content };
  }
  if (entry.type === "thinking_level_change") return { ...base, role: "system", content: `Thinking level changed to ${entry.thinkingLevel}` };
  if (entry.type === "model_change") return { ...base, role: "system", content: `Model changed to ${entry.provider}/${entry.modelId}` };
  if (entry.type === "compaction") return { ...base, role: "system", content: entry.summary };
  if (entry.type === "branch_summary") return { ...base, role: "system", content: entry.summary };
  if (entry.type === "session_info" && entry.name) return { ...base, role: "system", content: `Session named ${entry.name}` };
  return undefined;
}

function validCatalogName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined;
}

function projectVisibleTools(session: AgentSession): ToolDto[] {
  const active = new Set(session.getActiveToolNames());
  const tools: ToolDto[] = [];
  for (const tool of session.getAllTools()) {
    const name = validCatalogName(tool.name);
    if (name === undefined) continue;
    const schema = projectJsonObject(tool.parameters).value;
    tools.push({
      name,
      description: safeRequiredText(tool.description, 2_048, "Tool description omitted"),
      active: active.has(tool.name),
      source: projectSource(tool.sourceInfo, tool.sourceInfo.source === "builtin" ? "built-in" : "extension"),
      ...(Object.keys(schema).length > 0 ? { parameterSchema: schema } : {}),
    });
  }
  return tools.sort(compareToolDtos).slice(0, MAX_PROJECTION_ITEMS);
}

function resolveExtensionCommands(extensions: ReturnType<AgentSessionServices["resourceLoader"]["getExtensions"]>["extensions"]): Array<{
  invocationName: string;
  name: string;
  description?: string;
  sourceInfo: SourceInfo;
  argumentCompletions: boolean;
}> {
  const commands = extensions.flatMap((extension) => [...extension.commands.values()]);
  const counts = new Map<string, number>();
  for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  return commands.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1;
    seen.set(command.name, occurrence);
    let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
    if (taken.has(invocationName)) {
      let suffix = occurrence;
      do { suffix += 1; invocationName = `${command.name}:${suffix}`; } while (taken.has(invocationName));
    }
    taken.add(invocationName);
    return {
      invocationName,
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      sourceInfo: command.sourceInfo,
      argumentCompletions: typeof command.getArgumentCompletions === "function",
    };
  });
}

function projectSource(source: SourceInfo, kind: SourceDto["kind"]): SourceDto {
  if (kind === "built-in") return { kind };
  const path = boundedString(source.path, 16_384, "");
  const packageName = source.origin === "package" ? boundedString(source.source, 256, "") : "";
  return {
    kind,
    ...(path ? { path } : {}),
    ...(packageName ? { package: packageName } : {}),
  };
}

function capJsonItems<T>(items: T[], maxBytes: number): T[] {
  const result: T[] = [];
  let bytes = 2;
  for (const item of items.slice(0, MAX_PROJECTION_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (result.length === 0 ? 0 : 1);
    if (bytes + itemBytes > maxBytes) break;
    result.push(item);
    bytes += itemBytes;
  }
  return result;
}

function projectDiagnostic(diagnostic: ResourceDiagnostic): DiagnosticDto {
  return {
    severity: diagnostic.type === "error" ? "error" : "warning",
    message: safeRequiredText(diagnostic.message, 2_048, "Resource diagnostic omitted"),
    ...(diagnostic.path ? { source: boundedString(diagnostic.path, 256, "resource") } : {}),
  };
}

export async function createPiRuntimeHost(options: CreatePiRuntimeHostOptions): Promise<PiRuntimeHost> {
  const uiContext = options.extensionUiBroker ? createPiExtensionUiContext(options.extensionUiBroker) : undefined;
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
    extensionUiBroker: options.extensionUiBroker,
    uiContext,
    setProjectTrust: (cwd, trusted) => trustByCwd.set(cwd, trusted),
  });
}

function validDate(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeRequiredText(message, 2_048, "Settings error details omitted");
}
