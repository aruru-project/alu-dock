import { lstatSync, realpathSync } from "node:fs";
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
  buildContextEntries,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SettingsManager,
  type ResourceDiagnostic,
  type SessionEntry,
  type SessionTreeNode,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import { projectDisplayEditDiff } from "../core/edit-diff-projection.js";
import type { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import {
  RuntimeCompactionKnownFailureError,
  RuntimeQueueEffectUnknownError,
  RuntimeQueueRejectedBeforeEffectError,
} from "../core/runtime-session.js";
import type {
  ClearedRuntimeQueue,
  RuntimeCompactionResult,
  RuntimeEvent,
  RuntimeForkResult,
  RuntimeHistoryEntry,
  RuntimeInputKind,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeNavigateOptions,
  RuntimeNavigateResult,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeSessionMetrics,
  RuntimeSessionTarget,
  RuntimeThinkingLevel,
  RuntimeToolProjection,
  RuntimeTreeNode,
  RuntimeTreeSnapshot,
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
import { GitBranchObserver, type GitBranchObserverPort } from "./git-branch-observer.js";
import { createPiExtensionUiContext } from "./pi-extension-ui-adapter.js";
import { piToolResultNormalizerExtension } from "./pi-tool-result-normalizer.js";
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
  "setBeforeSessionInvalidate" | "setRebindSession" | "newSession" | "switchSession" | "fork" | "dispose"
>;

type ReplacementKind = "new" | "switch" | "fork" | "clone" | "reload";

export interface PiRuntimeHostOptions {
  runtime: RuntimeOwner;
  sessionCatalog?: PiSessionCatalog;
  setProjectTrust?: (cwd: string, trusted: boolean) => void;
  commitReplacement?: (change: { operationId: string; kind: ReplacementKind; previousSessionFile?: string; sessionFile?: string }) => Promise<void>;
  commitRuntimeError?: (failure: { operationId: string; kind: ReplacementKind; error: unknown; recoverySessionFile?: string }) => Promise<void>;
  isSessionFileDurable?: (path: string) => boolean;
  extensionUiBroker?: ExtensionUiBroker;
  uiContext?: ExtensionUIContext;
  gitBranchObserverFactory?: (
    cwd: string,
    onChange: (branch: string | undefined) => void,
  ) => Promise<GitBranchObserverPort>;
}

export interface CreatePiRuntimeHostOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  projectTrusted: boolean;
  extensionUiBroker?: ExtensionUiBroker;
  sessionManager?: SessionManager;
}

interface BindingToken { active: boolean }
interface Binding {
  token: BindingToken;
  session: AgentSession;
  services: AgentSessionServices;
  unsubscribe: () => void;
  gitBranchObserver?: GitBranchObserverPort;
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
  private treeNavigation: Promise<RuntimeNavigateResult> | undefined;
  private initialActivated = false;
  private queueUpdateSequence = 0;

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
  get isCompacting(): boolean { return this.active?.session.isCompacting ?? false; }
  getDurableSessionFile(): string | undefined {
    const path = this.active?.session.sessionFile;
    if (path === undefined) return undefined;
    try {
      if (this.options.isSessionFileDurable) return this.options.isSessionFileDurable(path) ? path : undefined;
      const info = lstatSync(path);
      const getuid = process.getuid;
      return info.isFile()
        && !info.isSymbolicLink()
        && realpathSync(path) === resolve(path)
        && typeof getuid === "function"
        && info.uid === getuid()
        ? path
        : undefined;
    } catch {
      return undefined;
    }
  }
  get diagnostics(): readonly unknown[] { return this.options.runtime.diagnostics; }
  get modelFallbackMessage(): string | undefined { return this.options.runtime.modelFallbackMessage; }
  getGitBranch(): string | undefined { return this.requireActive().gitBranchObserver?.branch; }
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

  classifyInput(text: string): RuntimeInputKind {
    const commandName = extensionCommandName(text);
    if (commandName === undefined) return "prompt";
    return this.requireActive().session.extensionRunner.getCommand(commandName) === undefined
      ? "prompt"
      : "extension_command";
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    return this.requireActive().session.prompt(text, options as PromptOptions | undefined);
  }

  queueMessage(text: string, delivery: "steer" | "followUp"): Promise<void> {
    const session = this.requireActive().session;
    const updateSequenceBefore = this.queueUpdateSequence;
    const before = delivery === "steer"
      ? session.getSteeringMessages().length
      : session.getFollowUpMessages().length;
    const mutation = delivery === "steer" ? session.steer(text) : session.followUp(text);
    const appliedSynchronously = this.queueUpdateSequence > updateSequenceBefore || (delivery === "steer"
      ? session.getSteeringMessages().length
      : session.getFollowUpMessages().length) > before;
    return mutation.catch((error: unknown) => {
      if (!appliedSynchronously) throw new RuntimeQueueRejectedBeforeEffectError(error);
      throw new RuntimeQueueEffectUnknownError(error);
    });
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return this.requireActive().services.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    })).sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  }

  async listTools(): Promise<RuntimeToolProjection> {
    const session = this.requireActive().session;
    return projectVisibleTools(session);
  }

  async setActiveTools(names: string[]): Promise<RuntimeToolProjection> {
    const session = this.requireActive().session;
    if (!Array.isArray(names) || names.length > MAX_PROJECTION_ITEMS) throw new Error("Active tool names must be a bounded array");
    const remaining = new Set<string>();
    for (const name of names) {
      if (typeof name !== "string" || name.length < 1 || name.length > 256) throw new Error("Active tool names must be bounded non-empty strings");
      if (remaining.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      remaining.add(name);
    }
    for (const tool of session.getAllTools()) {
      const name = validCatalogName(tool.name);
      if (name !== undefined) remaining.delete(name);
      if (remaining.size === 0) break;
    }
    const unknown = remaining.values().next().value;
    if (unknown !== undefined) throw new RuntimeUnknownToolError(unknown);
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

  async getResources(): Promise<{
    resources: ResourceDto[];
    diagnostics: DiagnosticDto[];
    resourceTotal: number;
    resourcesTruncated: boolean;
    diagnosticTotal: number;
    diagnosticsTruncated: boolean;
  }> {
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
    const sortedResources = resources.sort(compareResourceDtos);
    const sortedDiagnostics = diagnostics.sort(compareDiagnosticDtos);
    const projectedResources = capJsonItems(sortedResources, 350_000);
    const projectedDiagnostics = capJsonItems(sortedDiagnostics, 250_000);
    return {
      resources: projectedResources,
      diagnostics: projectedDiagnostics,
      resourceTotal: sortedResources.length,
      resourcesTruncated: projectedResources.length < sortedResources.length,
      diagnosticTotal: sortedDiagnostics.length,
      diagnosticsTruncated: projectedDiagnostics.length < sortedDiagnostics.length,
    };
  }

  async getCommands(): Promise<CommandDto[]> {
    const binding = this.requireActive();
    const loader = binding.services.resourceLoader;
    const commands: CommandDto[] = [];
    const extensionCommands = binding.session.extensionRunner.getRegisteredCommands();
    for (const command of extensionCommands) {
      const name = validCatalogName(command.invocationName);
      if (name === undefined) continue;
      const description = safeOptionalText(command.description, 2_048);
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        source: projectSource(command.sourceInfo, "extension"),
        argumentCompletions: typeof command.getArgumentCompletions === "function",
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
    return commands.sort(compareCommandDtos);
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
    const branch = this.requireActive().session.sessionManager.getBranch();
    return buildContextEntries(branch)
      .map(projectHistoryEntry)
      .filter((entry): entry is RuntimeHistoryEntry => entry !== undefined);
  }

  getTree(): RuntimeTreeSnapshot {
    const manager = this.requireActive().session.sessionManager;
    const nodes: RuntimeTreeNode[] = [];
    const roots = manager.getTree();
    const toolCalls = collectTreeToolCalls(roots);
    const stack: Array<{ node: SessionTreeNode; parentId?: string; depth: number }> = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ node: roots[index] as SessionTreeNode, depth: 0 });
    while (stack.length > 0) {
      const current = stack.pop() as { node: SessionTreeNode; parentId?: string; depth: number };
      projectTreeNode(current.node, current.parentId, current.depth, nodes, toolCalls);
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: current.node.children[index] as SessionTreeNode, parentId: current.node.entry.id, depth: current.depth + 1 });
      }
    }
    const leafId = manager.getLeafId() ?? undefined;
    return { nodes, ...(leafId === undefined ? {} : { leafId }) };
  }

  navigateTree(targetId: string, options: RuntimeNavigateOptions = {}): Promise<RuntimeNavigateResult> {
    if (this.treeNavigation) return Promise.reject(new Error("A session tree navigation is already active"));
    const navigation = this.serialize(async () => {
      const result = await this.requireActive().session.navigateTree(targetId, options);
      return {
        cancelled: result.cancelled,
        ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
        ...(result.editorText === undefined ? {} : { editorText: safeSelectedText(result.editorText) }),
        summaryCreated: result.summaryEntry !== undefined,
      };
    });
    const tracked = navigation.finally(() => {
      if (this.treeNavigation === tracked) this.treeNavigation = undefined;
    });
    this.treeNavigation = tracked;
    return tracked;
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
    const navigation = this.treeNavigation;
    if (navigation) {
      session.abortBranchSummary();
      await navigation.then(() => {}, (error) => { throw error; });
      return;
    }
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

  fork(
    operationId: string,
    entryId: string,
    position: "before" | "at",
    kind: "fork" | "clone",
  ): Promise<RuntimeForkResult> {
    return this.serialize(() => {
      const binding = this.requireActive();
      if (kind === "clone" && binding.session.sessionManager.getLeafId() !== entryId) {
        throw new Error("Clone entry must be the current session leaf");
      }
      if (position === "before") {
        const selected = binding.session.getUserMessagesForForking().find((entry) => entry.entryId === entryId);
        if (!selected) throw new Error("Fork-before requires a user message entry");
        safeSelectedText(selected.text);
      } else if (!binding.session.sessionManager.getEntry(entryId)) {
        throw new Error("Fork entry does not belong to the current session tree");
      }
      return this.replace(operationId, kind, async () => {
        const result = await this.options.runtime.fork(entryId, { position });
        if (result.cancelled) return { cancelled: true };
        const selectedText = result.selectedText === undefined ? undefined : safeSelectedText(result.selectedText);
        if (kind === "fork" && selectedText === undefined) throw new Error("Pi completed fork-before without selected editor text");
        return { cancelled: false, ...(selectedText === undefined ? {} : { selectedText }) };
      });
    });
  }

  setSessionName(name: string): string | undefined {
    const session = this.requireActive().session;
    session.setSessionName(name);
    return session.sessionManager.getSessionName();
  }

  compact(customInstructions?: string): Promise<RuntimeCompactionResult> {
    return this.serialize(async () => {
      const session = this.requireActive().session;
      const previousCompactionIds = new Set(
        session.sessionManager.getEntries()
          .filter((entry) => entry.type === "compaction")
          .map((entry) => entry.id),
      );
      try {
        const result = await session.compact(customInstructions);
        return {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
        };
      } catch (error) {
        const appended = session.sessionManager.getEntries()
          .some((entry) => entry.type === "compaction" && !previousCompactionIds.has(entry.id));
        if (appended) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const reason = error instanceof Error && error.name === "AbortError" ? "cancelled" : compactionFailureReason(message);
        throw new RuntimeCompactionKnownFailureError(reason, message);
      }
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
        binding.bufferEvents = false;
        this.publishReplacement("reload", previousSessionFile, binding.session.sessionFile);
        this.publishReplacementBuffer(buffered);
        return { cancelled: false };
      } catch (error) {
        binding.token.active = false;
        binding.unsubscribe();
        binding.gitBranchObserver?.dispose();
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

  private async replace<T extends { cancelled: boolean }>(operationId: string, kind: "new" | "switch" | "fork" | "clone", operation: () => Promise<T>): Promise<T> {
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
      const publishBranch = (branch: string | undefined): void => {
        if (!token.active) return;
        const event: RuntimeEvent = { type: "dock_git_branch_changed", branch };
        if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
      };
      binding.gitBranchObserver = await (this.options.gitBranchObserverFactory
        ? this.options.gitBranchObserverFactory(binding.services.cwd, publishBranch)
        : GitBranchObserver.create(binding.services.cwd, publishBranch));
    } catch (error) {
      token.active = false;
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
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

  private promoteStaged(kind: "new" | "switch" | "fork" | "clone", previousSessionFile?: string): void {
    const binding = this.staged;
    if (!binding) throw new Error("Replacement runtime binding was not staged");
    this.staged = undefined;
    this.active = binding;
    const events = binding.buffered;
    binding.buffered = [];
    binding.bufferEvents = false;
    this.publishReplacement(kind, previousSessionFile, binding.session.sessionFile);
    this.publishReplacementBuffer(events);
  }

  private publishReplacementBuffer(events: readonly RuntimeEvent[]): void {
    for (const event of events) {
      // The replacement event already carries the observer's latest cache.
      // Replaying intermediate branch invalidations could regress the new generation.
      if (event.type !== "dock_git_branch_changed") this.publish(event);
    }
  }

  private publishReplacement(kind: ReplacementKind, previousSessionFile?: string, sessionFile?: string): void {
    this.publish({
      type: "dock_session_replaced",
      reason: kind === "switch" ? "resume" : kind === "clone" ? "fork" : kind,
      previousSessionFile,
      sessionFile,
      cwd: this.active?.services.cwd,
      name: this.active?.session.sessionManager.getSessionName(),
      gitBranch: this.active?.gitBranchObserver?.branch,
    });
  }

  private invalidateBindingsSynchronously(): void {
    for (const binding of [this.active, this.staged]) {
      if (!binding) continue;
      binding.token.active = false;
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
    }
    this.active = undefined;
    this.staged = undefined;
  }

  private publish(event: RuntimeEvent): void {
    if (event.type === "queue_update") this.queueUpdateSequence += 1;
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
const MAX_TOOL_PROJECTION_BYTES = 600_000;
const DATA_URI = /data:[^,]*;base64,/i;
const RAW_BASE64 = /^(?:[A-Za-z0-9+/]{4}){32,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function boundedString(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length <= limit) return value;
  const requestedEnd = Math.max(0, limit - 1);
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}…`;
}

function safeOptionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || containsBinaryText(value)) return undefined;
  return boundedString(value, limit, "");
}

function containsBinaryText(value: string): boolean {
  if (DATA_URI.test(value) || RAW_BASE64.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => RAW_BASE64.test(part));
}

function safeRequiredText(value: unknown, limit: number, fallback: string): string {
  return safeOptionalText(value, limit) ?? fallback;
}

function projectEditToolDiff(toolName: unknown, details: unknown): string | undefined {
  if (typeof toolName !== "string" || (toolName.toLowerCase().split(/[.:/]/u).at(-1) ?? "") !== "edit") return undefined;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  return projectDisplayEditDiff((details as Record<string, unknown>).diff);
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
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
    const toolDiff = role === "toolResult" ? projectEditToolDiff(toolName, message.details) : undefined;
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
      ...(role === "compactionSummary" ? { summaryKind: "compaction" as const } : {}),
      ...(role === "branchSummary" ? { summaryKind: "branch" as const } : {}),
      content,
      ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolDiff === undefined ? {} : { toolDiff }),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    };
  }
  if (entry.type === "custom_message") {
    if (!entry.display) return undefined;
    return { ...base, role: "system", content: entry.content };
  }
  if (entry.type === "thinking_level_change") return { ...base, role: "system", content: `Thinking level changed to ${entry.thinkingLevel}` };
  if (entry.type === "model_change") return { ...base, role: "system", content: `Model changed to ${entry.provider}/${entry.modelId}` };
  if (entry.type === "compaction") return { ...base, role: "system", summaryKind: "compaction", content: entry.summary };
  if (entry.type === "branch_summary") return { ...base, role: "system", summaryKind: "branch", content: entry.summary };
  if (entry.type === "session_info" && entry.name) return { ...base, role: "system", content: `Session named ${entry.name}` };
  return undefined;
}

interface TreeToolCall { name: string; arguments: Record<string, unknown> }

function collectTreeToolCalls(roots: readonly SessionTreeNode[]): Map<string, TreeToolCall> {
  const calls = new Map<string, TreeToolCall>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as SessionTreeNode;
    const entry = node.entry;
    if (entry.type === "message") {
      const message = entry.message as unknown as Record<string, unknown>;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const block = item as Record<string, unknown>;
          if ((block.type === "toolCall" || block.type === "tool_call") && typeof block.id === "string" && typeof block.name === "string") {
            calls.set(block.id, { name: treeLine(block.name, 256, "tool"), arguments: isRecord(block.arguments) ? block.arguments : {} });
          }
        }
      }
    }
    for (const child of node.children) stack.push(child);
  }
  return calls;
}

function projectTreeNode(
  node: SessionTreeNode,
  parentId: string | undefined,
  depth: number,
  output: RuntimeTreeNode[],
  toolCalls: ReadonlyMap<string, TreeToolCall>,
): void {
  if (output.length >= 100_000) throw new Error("Pi session tree exceeds 100000 entries");
  const entry = node.entry;
  const kind = entry.type;
  if (!["message", "thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"].includes(kind)) {
    throw new Error(`Unsupported Pi session tree entry kind: ${kind}`);
  }
  const message = entry.type === "message" ? entry.message as unknown as Record<string, unknown> : undefined;
  const role = message === undefined ? undefined : treeMessageRole(message.role);
  const state = message === undefined ? undefined : treeMessageState(message);
  const displayClass = treeDisplayClass(entry, role, state);
  output.push({
    entryId: entry.id,
    ...(parentId === undefined ? {} : { parentId }),
    depth,
    kind: kind as RuntimeTreeNode["kind"],
    ...(role === undefined ? {} : { role }),
    displayClass,
    ...(state === undefined ? {} : { state }),
    ...(node.label === undefined ? {} : { label: treeLine(node.label, 256, "Session label omitted") }),
    ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: node.labelTimestamp }),
    timestamp: entry.timestamp,
    summary: projectTreeSummary(entry, toolCalls),
    hasChildren: node.children.length > 0,
  });
}

function projectTreeSummary(entry: SessionEntry, toolCalls: ReadonlyMap<string, TreeToolCall>): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as Record<string, unknown>;
      if (message.role === "bashExecution") {
        return treeLine(message.command, 2_048, "Shell execution");
      }
      if (message.role === "toolResult" || message.role === "tool") {
        const call = typeof message.toolCallId === "string" ? toolCalls.get(message.toolCallId) : undefined;
        const name = call?.name ?? treeLine(message.toolName, 256, "tool");
        return call === undefined ? `Tool: ${name}` : formatTreeToolCall(name, call.arguments);
      }
      if (message.role === "assistant" && typeof message.errorMessage === "string") {
        return treeLine(message.errorMessage, 2_048, "Assistant error");
      }
      if (message.role === "assistant" && message.stopReason === "aborted") return "(aborted)";
      return treeLine(contentText(message.content), 2_048, `${treeMessageRole(message.role)} message`);
    }
    case "thinking_level_change": return treeLine(`Thinking level: ${entry.thinkingLevel}`, 2_048, "Thinking level change");
    case "model_change": return treeLine(`Model: ${entry.provider}/${entry.modelId}`, 2_048, "Model change");
    case "compaction": return `[compaction: ${Math.round(entry.tokensBefore / 1_000)}k tokens]`;
    case "branch_summary": return treeLine(`[branch summary]: ${entry.summary}`, 2_048, "[branch summary]");
    case "custom": return treeLine(`Custom entry: ${entry.customType}`, 2_048, "Custom entry");
    case "custom_message": return treeLine(contentText(entry.content), 2_048, `Custom message: ${entry.customType}`);
    case "label": return treeLine(entry.label ? `Label ${entry.targetId}: ${entry.label}` : `Label cleared: ${entry.targetId}`, 2_048, "Label change");
    case "session_info": return treeLine(entry.name ? `Session name: ${entry.name}` : "Session name cleared", 2_048, "Session info");
  }
}

function treeMessageRole(value: unknown): "user" | "assistant" | "tool" | "system" {
  if (value === "user" || value === "assistant") return value;
  if (value === "tool" || value === "toolResult") return "tool";
  return "system";
}

function treeMessageState(message: Record<string, unknown>): RuntimeTreeNode["state"] {
  if (message.role === "assistant") {
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error" || typeof message.errorMessage === "string") return "error";
  }
  if ((message.role === "tool" || message.role === "toolResult") && message.isError === true) return "error";
  return undefined;
}

function treeDisplayClass(
  entry: SessionEntry,
  role: RuntimeTreeNode["role"],
  state: RuntimeTreeNode["state"],
): NonNullable<RuntimeTreeNode["displayClass"]> {
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    if (role === "tool") return "tool";
    if (role === "assistant" && state === undefined && !hasTreeText(message.content) && hasTreeToolCall(message.content)) return "structural";
    return "content";
  }
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return "content";
  return "metadata";
}

function hasTreeText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

function hasTreeToolCall(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const type = (item as Record<string, unknown>).type;
    return type === "toolCall" || type === "tool_call";
  });
}

function formatTreeToolCall(name: string, args: Record<string, unknown>): string {
  const normalizedName = name.toLowerCase().split(/[.:/]/u).at(-1) ?? name.toLowerCase();
  const path = treeStringArg(args, ["path", "file_path", "output_path"]);
  let detail: string | undefined;
  if (normalizedName === "read") {
    const offset = treeIntegerArg(args.offset);
    const limit = treeIntegerArg(args.limit);
    const range = offset === undefined ? undefined
      : limit === undefined ? `from line ${offset}` : `lines ${offset}-${offset + Math.max(0, limit - 1)}`;
    detail = treeJoin([path && treePathPreview(path), range]);
  } else if (normalizedName === "write") {
    detail = path && treePathPreview(path);
  } else if (normalizedName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length
      : typeof args.oldText === "string" || typeof args.newText === "string" ? 1 : undefined;
    detail = treeJoin([path && treePathPreview(path), edits === undefined ? undefined : `${edits} ${edits === 1 ? "edit" : "edits"}`]);
  } else if (normalizedName === "bash") {
    detail = treeCommandPreview(treeStringArg(args, ["command"]));
  } else if (normalizedName === "grep") {
    detail = treeJoin([treeStringArg(args, ["pattern"]), path && `in ${treePathPreview(path)}`]);
  } else if (normalizedName === "find") {
    detail = treeJoin([treeStringArg(args, ["pattern"]), path && `in ${treePathPreview(path)}`]);
  } else if (normalizedName === "ls") {
    detail = path && treePathPreview(path);
  } else {
    const action = treeStringArg(args, ["action"]);
    const cardId = treeScalarArg(args.card_id ?? args.cardId);
    const query = treeStringArg(args, ["query", "pattern"]);
    const target = treeStringArg(args, ["target_id", "instance_id", "instanceId"]);
    detail = treeJoin([
      path && treePathPreview(path),
      action,
      cardId && `card #${cardId}`,
      query && `query: ${query}`,
      target && `target ${target}`,
    ]);
  }
  return treeLine(`[${name}${detail ? `: ${detail}` : ""}]`, 2_048, `[${name}]`);
}

function treeStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function treeScalarArg(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function treeIntegerArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function treeJoin(parts: Array<string | undefined | false>): string | undefined {
  const values = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim());
  return values.length === 0 ? undefined : values.slice(0, 4).join(" · ");
}

function treePathPreview(value: string): string {
  const normalized = value.replace(/[\t\r\n]+/gu, " ").trim();
  const home = process.env.HOME;
  const shortened = home && normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : normalized;
  const parts = shortened.split(/[\\/]/u).filter(Boolean);
  return parts.length > 5 ? `…/${parts.slice(-4).join("/")}` : shortened;
}

function treeCommandPreview(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const lines = command.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const first = lines[0] as string;
  return lines.length === 1 ? first : `${first} ↵ +${lines.length - 1} ${lines.length === 2 ? "line" : "lines"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 8_192);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; index < Math.min(value.length, 200) && length < 8_192; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    const part = block.type === "text" && typeof block.text === "string"
      ? block.text
      : (block.type === "toolCall" || block.type === "tool_call") && typeof block.name === "string"
        ? `Tool call: ${block.name}`
        : undefined;
    if (part === undefined) continue;
    const bounded = part.slice(0, 8_192 - length);
    parts.push(bounded);
    length += bounded.length + 1;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function treeLine(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parts: string[] = [];
  let outputLength = 0;
  let tokenStart = -1;
  let pendingSpace = false;
  const flushToken = (end: number): boolean => {
    if (tokenStart < 0) return false;
    if (pendingSpace && outputLength > 0 && outputLength < limit) {
      parts.push(" ");
      outputLength += 1;
    }
    const remaining = limit - outputLength;
    if (remaining > 0) {
      const token = value.slice(tokenStart, Math.min(end, tokenStart + remaining));
      parts.push(token);
      outputLength += token.length;
    }
    tokenStart = -1;
    pendingSpace = false;
    return outputLength >= limit;
  };
  for (let index = 0; index < value.length && outputLength < limit; index += 1) {
    const code = value.charCodeAt(index);
    if (isTreeLineSeparator(code)) {
      if (flushToken(index)) break;
      pendingSpace = outputLength > 0;
    } else {
      if (tokenStart < 0) tokenStart = index;
      if (index - tokenStart + outputLength >= limit) {
        flushToken(index + 1);
        break;
      }
    }
  }
  if (outputLength < limit && tokenStart >= 0) flushToken(value.length);
  return safeRequiredText(parts.join(""), limit, fallback);
}

function isTreeLineSeparator(code: number): boolean {
  return code <= 0x20
    || (code >= 0x7f && code <= 0xa0)
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function safeSelectedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Pi returned invalid selected editor text");
  if (value.length > 256_000) throw new Error("Selected editor text exceeds 256000 characters");
  if (containsBinaryText(value)) throw new Error("Selected editor text cannot contain binary or image payloads");
  return value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function validCatalogName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined;
}

function extensionCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  return name.length > 0 ? name : undefined;
}

type PiTool = (ReturnType<AgentSession["getAllTools"]>)[number];
interface VisibleToolRef { tool: PiTool; name: string }

function projectVisibleTools(session: AgentSession): RuntimeToolProjection {
  const active = new Set(session.getActiveToolNames());
  const selected: VisibleToolRef[] = [];
  let total = 0;
  for (const tool of session.getAllTools()) {
    const name = validCatalogName(tool.name);
    if (name === undefined) continue;
    total += 1;
    retainCanonicalToolPrefix(selected, { tool, name }, MAX_PROJECTION_ITEMS);
  }
  selected.sort(compareVisibleToolRefs);
  const tools: ToolDto[] = [];
  let bytes = 2;
  for (const { tool, name } of selected) {
    if (tools.length >= MAX_PROJECTION_ITEMS) break;
    const schema = projectJsonObject(tool.parameters).value;
    const candidate: ToolDto = {
      name,
      description: safeRequiredText(tool.description, 2_048, "Tool description omitted"),
      active: active.has(tool.name),
      source: projectSource(tool.sourceInfo, tool.sourceInfo.source === "builtin" ? "built-in" : "extension"),
      ...(Object.keys(schema).length > 0 ? { parameterSchema: schema } : {}),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (tools.length > 0 ? 1 : 0);
    if (bytes + itemBytes > MAX_TOOL_PROJECTION_BYTES) break;
    tools.push(candidate);
    bytes += itemBytes;
  }
  tools.sort(compareToolDtos);
  return { tools, total, truncated: tools.length < total };
}

function retainCanonicalToolPrefix(heap: VisibleToolRef[], candidate: VisibleToolRef, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareVisibleToolRefs(heap[parent]!, heap[index]!) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
    return;
  }
  if (compareVisibleToolRefs(candidate, heap[0]!) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareVisibleToolRefs(heap[left]!, heap[largest]!) > 0) largest = left;
    if (right < heap.length && compareVisibleToolRefs(heap[right]!, heap[largest]!) > 0) largest = right;
    if (largest === index) break;
    [heap[index], heap[largest]] = [heap[largest]!, heap[index]!];
    index = largest;
  }
}

function compareVisibleToolRefs(left: VisibleToolRef, right: VisibleToolRef): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
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
    const services = await createAgentSessionServices({
      cwd: canonicalCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [{ name: "alu-dock-tool-result-normalizer", factory: piToolResultNormalizerExtension }],
      },
    });
    const result = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, tools: options.tools, excludeTools: options.excludeTools,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const sessionManager = options.sessionManager
    ?? (options.sessionDir
      ? SessionManager.create(options.cwd, options.sessionDir)
      : SessionManager.create(options.cwd));
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

function compactionFailureReason(message: string): "nothing_to_compact" | "already_compacted" | "cancelled" | "failed" {
  if (message === "Nothing to compact (session too small)") return "nothing_to_compact";
  if (message === "Already compacted") return "already_compacted";
  if (message === "Compaction cancelled") return "cancelled";
  return "failed";
}

function validDate(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeRequiredText(message, 2_048, "Settings error details omitted");
}
