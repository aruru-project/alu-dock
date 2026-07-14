import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

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
  type ResourceDiagnostic,
  type SessionEntry,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeSessionMetrics,
  RuntimeThinkingLevel,
} from "../core/runtime-session.js";
import type {
  CommandDto,
  DiagnosticDto,
  ResourceDto,
  SettingDto,
  SettingKey,
  SettingUpdate,
  SettingValueMap,
  SourceDto,
  ToolDto,
} from "../core/config-projection.js";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../core/config-projection.js";
import { projectJsonObject } from "../core/managed-instance.js";
import { RuntimeInvalidSettingValueError, RuntimeModelNotFoundError, RuntimeSettingsWriteError, RuntimeUnknownToolError } from "../core/runtime-session.js";
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
    return SETTING_KEYS.map((key) => projectSetting(settings, key));
  }

  async updateSetting(update: SettingUpdate): Promise<SettingDto> {
    assertSettingUpdate(update);
    const binding = this.requireActive();
    const key = update.key;
    this.assertCleanSettingsBaseline(binding, key);
    validatedSettingValue(binding.services.settingsManager, key);
    applySetting(binding.session, binding.services.settingsManager, update);
    await this.persistSettings(binding, key);
    return projectSetting(binding.services.settingsManager, key);
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
      resources: resources.sort(compareResources).slice(0, MAX_PROJECTION_ITEMS),
      diagnostics: diagnostics.sort(compareDiagnostics).slice(0, MAX_PROJECTION_ITEMS),
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
    if (validatedSettingValue(binding.services.settingsManager, "enableSkillCommands")) {
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
    return commands.sort(compareCommands).slice(0, MAX_PROJECTION_ITEMS);
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
  return tools.sort(compareTools).slice(0, MAX_PROJECTION_ITEMS);
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

function compareSource(left: SourceDto, right: SourceDto): number {
  return left.kind.localeCompare(right.kind) || (left.package ?? "").localeCompare(right.package ?? "") || (left.path ?? "").localeCompare(right.path ?? "");
}
function compareTools(left: ToolDto, right: ToolDto): number {
  return left.name.localeCompare(right.name)
    || compareSource(left.source ?? { kind: "built-in" }, right.source ?? { kind: "built-in" })
    || left.description.localeCompare(right.description)
    || Number(left.active) - Number(right.active)
    || JSON.stringify(left.parameterSchema ?? {}).localeCompare(JSON.stringify(right.parameterSchema ?? {}));
}
function compareResources(left: ResourceDto, right: ResourceDto): number {
  return left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || (left.path ?? "").localeCompare(right.path ?? "")
    || compareSource(left.source ?? { kind: "built-in" }, right.source ?? { kind: "built-in" });
}
function compareCommands(left: CommandDto, right: CommandDto): number {
  return left.name.localeCompare(right.name)
    || compareSource(left.source, right.source)
    || (left.description ?? "").localeCompare(right.description ?? "")
    || Number(left.argumentCompletions) - Number(right.argumentCompletions);
}
function compareDiagnostics(left: DiagnosticDto, right: DiagnosticDto): number { return left.severity.localeCompare(right.severity) || left.message.localeCompare(right.message) || (left.source ?? "").localeCompare(right.source ?? ""); }

function projectDiagnostic(diagnostic: ResourceDiagnostic): DiagnosticDto {
  return {
    severity: diagnostic.type === "error" ? "error" : "warning",
    message: safeRequiredText(diagnostic.message, 2_048, "Resource diagnostic omitted"),
    ...(diagnostic.path ? { source: boundedString(diagnostic.path, 256, "resource") } : {}),
  };
}

function hasOwnPath(settings: unknown, path: readonly string[]): boolean {
  let current: unknown = settings;
  for (const part of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function settingSource(manager: SettingsManager, key: SettingKey): "global" | "project" | "effective" {
  const path = SETTING_DEFINITIONS[key].sourcePath;
  if (key !== "defaultProjectTrust" && manager.isProjectTrusted() && hasOwnPath(manager.getProjectSettings(), path)) return "project";
  if (hasOwnPath(manager.getGlobalSettings(), path)) return "global";
  return "effective";
}

function settingValue(manager: SettingsManager, key: SettingKey): SettingValueMap[SettingKey] {
  switch (key) {
    case "autoCompaction": return manager.getCompactionEnabled();
    case "autoRetry": return manager.getRetryEnabled();
    case "enableSkillCommands": return manager.getEnableSkillCommands();
    case "hideThinking": return manager.getHideThinkingBlock();
    case "showCacheMissNotices": return manager.getShowCacheMissNotices();
    case "showHardwareCursor": return manager.getShowHardwareCursor();
    case "clearOnShrink": return manager.getClearOnShrink();
    case "showTerminalProgress": return manager.getShowTerminalProgress();
    case "quietStartup": return manager.getQuietStartup();
    case "steeringMode": return manager.getSteeringMode();
    case "followUpMode": return manager.getFollowUpMode();
    case "transport": return manager.getTransport();
    case "doubleEscapeAction": return manager.getDoubleEscapeAction();
    case "treeFilterMode": return manager.getTreeFilterMode();
    case "defaultProjectTrust": return manager.getDefaultProjectTrust();
    case "httpIdleTimeoutMs": return manager.getHttpIdleTimeoutMs();
    case "editorPaddingX": return manager.getEditorPaddingX();
    case "outputPad": return manager.getOutputPad();
    case "autocompleteMaxVisible": return manager.getAutocompleteMaxVisible();
    case "warnings": return manager.getWarnings();
  }
}

function validatedSettingValue<K extends SettingKey>(manager: SettingsManager, key: K): SettingValueMap[K] {
  const value = settingValue(manager, key) as SettingValueMap[K];
  try { assertSettingUpdate({ key, value } as SettingUpdate); }
  catch { throw new RuntimeInvalidSettingValueError(key); }
  return value;
}

function projectSetting(manager: SettingsManager, key: SettingKey): SettingDto {
  const definition = SETTING_DEFINITIONS[key];
  const value = validatedSettingValue(manager, key);
  return {
    key,
    value,
    source: settingSource(manager, key),
    writable: true,
    valueType: definition.valueType,
    ...(definition.allowedValues ? { allowedValues: [...definition.allowedValues] } : {}),
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    reloadRequired: definition.reloadRequired,
    hostRestartRequired: definition.hostRestartRequired,
  } as SettingDto;
}

function assertSettingUpdate(update: SettingUpdate): void {
  if (update === null || typeof update !== "object" || Array.isArray(update) || Object.keys(update).length !== 2 || !("key" in update) || !("value" in update)) throw new Error("Setting update must be a closed key/value object");
  const key = (update as { key: unknown }).key;
  if (typeof key !== "string" || !SETTING_KEYS.includes(key as SettingKey)) throw new Error(`Unsupported setting key: ${String(key)}`);
  const definition = SETTING_DEFINITIONS[key as SettingKey];
  const value = (update as { value: unknown }).value;
  if (definition.valueType === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  if (definition.valueType === "enum" && (typeof value !== "string" || !definition.allowedValues?.includes(value))) throw new Error(`${key} has an unsupported value`);
  if (definition.valueType === "integer" && (!Number.isSafeInteger(value) || (value as number) < (definition.min ?? 0) || (value as number) > (definition.max ?? Number.MAX_SAFE_INTEGER))) throw new Error(`${key} is out of range`);
  if (definition.valueType === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
    if (Object.keys(value).some((field) => field !== "anthropicExtraUsage") || ((value as { anthropicExtraUsage?: unknown }).anthropicExtraUsage !== undefined && typeof (value as { anthropicExtraUsage?: unknown }).anthropicExtraUsage !== "boolean")) throw new Error("warnings must be a closed warning object");
  }
}

function applySetting(session: AgentSession, manager: SettingsManager, update: SettingUpdate): void {
  switch (update.key) {
    case "autoCompaction": manager.setCompactionEnabled(update.value); break;
    case "autoRetry": manager.setRetryEnabled(update.value); break;
    case "enableSkillCommands": manager.setEnableSkillCommands(update.value); break;
    case "hideThinking": manager.setHideThinkingBlock(update.value); break;
    case "showCacheMissNotices": manager.setShowCacheMissNotices(update.value); break;
    case "showHardwareCursor": manager.setShowHardwareCursor(update.value); break;
    case "clearOnShrink": manager.setClearOnShrink(update.value); break;
    case "showTerminalProgress": manager.setShowTerminalProgress(update.value); break;
    case "quietStartup": manager.setQuietStartup(update.value); break;
    case "steeringMode": session.setSteeringMode(update.value); break;
    case "followUpMode": session.setFollowUpMode(update.value); break;
    case "transport": manager.setTransport(update.value); break;
    case "doubleEscapeAction": manager.setDoubleEscapeAction(update.value); break;
    case "treeFilterMode": manager.setTreeFilterMode(update.value); break;
    case "defaultProjectTrust": manager.setDefaultProjectTrust(update.value); break;
    case "httpIdleTimeoutMs": manager.setHttpIdleTimeoutMs(update.value); break;
    case "editorPaddingX": manager.setEditorPaddingX(update.value); break;
    case "outputPad": manager.setOutputPad(update.value); break;
    case "autocompleteMaxVisible": manager.setAutocompleteMaxVisible(update.value); break;
    case "warnings": manager.setWarnings({ ...update.value }); break;
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
  return safeRequiredText(message, 2_048, "Settings error details omitted");
}
