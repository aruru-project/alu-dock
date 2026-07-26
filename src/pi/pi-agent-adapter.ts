import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
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

import {
  MAX_IMAGE_AGGREGATE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MIME_TYPE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_INPUT_IMAGES,
} from "../core/instance-dto.js";
import { projectBuiltInToolPresentation } from "../core/tool-result-presentation.js";
import type { PiExtensionUiPort } from "./pi-extension-ui-adapter.js";
import {
  AgentCompactionKnownFailureError,
  AgentConversationCursorError,
  AgentQueueEffectUnknownError,
  AgentQueueRejectedBeforeEffectError,
} from "../core/agent-worker.js";
import type {
  ClearedAgentQueue,
  AgentCompactionResult,
  AgentConversationContentChunk,
  AgentConversationContentPage,
  AgentConversationHistoryPage,
  AgentEvent,
  AgentForkResult,
  AgentHistoryEntry,
  AgentImagePath,
  AgentInputKind,
  AgentInvokeContext,
  AgentModelInfo,
  AgentModelState,
  AgentNavigateOptions,
  AgentNavigateResult,
  AgentPromptOptions,
  AgentRequest,
  AgentWorkerControl,
  AgentSessionInfo,
  AgentSessionMetrics,
  AgentSessionTarget,
  ThinkingLevel,
  AgentToolProjection,
  AgentTreeNode,
  AgentTreeSnapshot,
} from "../core/agent-worker.js";
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
import { AgentModelNotFoundError, AgentSettingsWriteError, AgentUnknownToolError } from "../core/agent-worker.js";
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

export interface PiExtensionUiLifecyclePort extends PiExtensionUiPort {
  beginGenerationChange(kind?: "binding" | "reload"): void;
  completeGenerationChange(): Promise<void>;
  failGenerationChange(): Promise<void>;
}

export interface PiAgentAdapterOptions {
  runtime: RuntimeOwner;
  sessionCatalog?: PiSessionCatalog;
  setProjectTrust?: (cwd: string, trusted: boolean) => void;
  commitReplacement?: (change: { operationId: string; kind: ReplacementKind; previousSessionFile?: string; sessionFile?: string }) => Promise<void>;
  commitRuntimeError?: (failure: { operationId: string; kind: ReplacementKind; error: unknown; recoverySessionFile?: string }) => Promise<void>;
  isSessionFileDurable?: (path: string) => boolean;
  extensionUiBroker?: PiExtensionUiLifecyclePort;
  uiContext?: ExtensionUIContext;
  uiContextFactory?: () => ExtensionUIContext;
  initialProcessCwd?: string;
  setProcessCwd?: (cwd: string) => void;
  gitBranchObserverFactory?: (
    cwd: string,
    onChange: (branch: string | undefined) => void,
  ) => Promise<GitBranchObserverPort>;
  configureNetwork?: (settingsManager: AgentSessionServices["settingsManager"]) => void;
}

export interface CreatePiAgentAdapterOptions {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  projectTrusted: boolean;
  extensionUiBroker?: PiExtensionUiLifecyclePort;
  extensionUiContextPortFactory?: () => PiExtensionUiPort;
  setProcessCwd?: (cwd: string) => void;
  sessionManager?: SessionManager;
}

interface BindingToken { active: boolean }
interface Binding {
  token: BindingToken;
  session: AgentSession;
  services: AgentSessionServices;
  cwd: string;
  unsubscribe: () => void;
  gitBranchObserver?: GitBranchObserverPort;
  buffered: AgentEvent[];
  bufferEvents: boolean;
}

/** In-Worker Pi adapter around the SDK's mutable AgentSessionRuntime. */
export class PiAgentAdapter {
  private readonly subscribers = new Set<(event: AgentEvent) => void>();
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
  private treeNavigation: Promise<AgentNavigateResult> | undefined;
  private initialActivated = false;
  private queueUpdateSequence = 0;
  private processCwdValue: string | undefined;
  private conversationRevisionValue: string | undefined;
  private conversationScope = randomUUID();
  private readonly conversationHistoryCursors = new Map<string, { revision: string; end: number }>();
  private readonly conversationContentCursors = new Map<string, { revision: string; contentRef: string; blockIndex: number; offset: number }>();

  private constructor(private readonly options: PiAgentAdapterOptions) {
    this.processCwdValue = options.initialProcessCwd;
    options.runtime.setBeforeSessionInvalidate(() => {
      if (this.replacementRunning) this.replacementInvalidated = true;
      options.extensionUiBroker?.beginGenerationChange("binding");
      this.invalidateBindingsSynchronously();
    });
    options.runtime.setRebindSession(async (session) => {
      this.rebindEntered = true;
      await this.stageCandidate(session);
    });
  }

  static async create(options: PiAgentAdapterOptions): Promise<PiAgentAdapter> {
    const host = new PiAgentAdapter(options);
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
  getExtensionCommandNames(): string[] {
    return this.requireActive().session.extensionRunner.getRegisteredCommands()
      .map((command) => command.invocationName)
      .filter((name) => typeof name === "string" && name.length > 0 && name.length <= 256)
      .sort();
  }

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

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async dispatch(request: AgentRequest, context?: AgentInvokeContext, preflightResult?: (success: boolean) => void): Promise<unknown> {
    switch (request.type) {
      case "command.submit": {
        const { delivery: requestedDelivery, message, images } = request.params;
        const delivery = requestedDelivery === "auto" ? (this.isStreaming ? "followUp" : "prompt") : requestedDelivery;
        if (context?.type === "force_queue") {
          if (delivery === "prompt") throw new Error("Forced Agent queue delivery requires steer or followUp");
          return this.queueMessage(message, delivery, images);
        }
        return this.prompt(message, {
          source: "rpc",
          ...(delivery === "prompt" ? {} : { streamingBehavior: delivery }),
          ...(images === undefined ? {} : { images }),
          preflightResult,
        });
      }
      case "command.abort": await this.abort(); return null;
      case "queue.dequeue": return this.clearQueue();
      case "model.list": return this.listModels();
      case "model.set": return this.selectModel(request.params.provider, request.params.modelId);
      case "thinking.set": return this.setThinkingLevel(request.params.level);
      case "tool.list": return this.listTools();
      case "tool.set_active": return this.setActiveTools(request.params.names);
      case "settings.get": return this.getSettings();
      case "settings.update": return this.updateSetting(request.params.update);
      case "resource.get": return this.getResources();
      case "command.catalog": return this.getCommands();
      case "session.history": return this.getHistory();
      case "conversation.history": return this.getConversationHistory(request.params.cursor, request.params.limit);
      case "conversation.content": return this.getConversationContent(request.params.contentRef, request.params.cursor);
      case "session.list": return this.listSessions(request.params.scope);
      case "session.switch": {
        if (context?.type !== "session_switch") throw new Error("Session switch requires resolved Host trust context");
        return this.switchSession(request.params.operationId, request.params.sessionFile, context);
      }
      case "session.new": return this.newSession(request.params.operationId, request.params.parentSession);
      case "session.name": return this.setSessionName(request.params.name);
      case "session.compact": return this.compact(request.params.customInstructions);
      case "session.reload": return this.reload(request.params.operationId);
      case "session.tree": return this.getTree();
      case "session.navigate": return this.navigateTree(request.params.targetId, request.params);
      case "session.fork": return this.fork(request.params.operationId, request.params.entryId, "before", "fork");
      case "session.clone": return this.fork(request.params.operationId, request.params.entryId, "at", "clone");
    }
  }

  async control(request: AgentWorkerControl): Promise<unknown> {
    switch (request.type) {
      case "activate": this.activateInitial(); return null;
      case "resolve_session_target": return this.resolveSessionTarget(request.sessionFile);
      case "wait_for_idle": await this.waitForIdle(); return null;
      case "dispose": await this.dispose(); return null;
    }
  }

  classifyInput(text: string): AgentInputKind {
    const commandName = extensionCommandName(text);
    if (commandName === undefined) return "prompt";
    return this.requireActive().session.extensionRunner.getCommand(commandName) === undefined
      ? "prompt"
      : "extension_command";
  }

  async prompt(text: string, options?: AgentPromptOptions): Promise<void> {
    const { images, ...promptOptions } = options ?? {};
    const visualContent = await loadPiImages(images);
    await this.requireActive().session.prompt(text, {
      ...promptOptions,
      ...(visualContent === undefined ? {} : { images: visualContent }),
    } as PromptOptions);
  }

  async queueMessage(text: string, delivery: "steer" | "followUp", images?: AgentImagePath[]): Promise<void> {
    let visualContent: PiImageContent[] | undefined;
    try { visualContent = await loadPiImages(images); }
    catch (error) { throw new AgentQueueRejectedBeforeEffectError(error); }
    const session = this.requireActive().session;
    const updateSequenceBefore = this.queueUpdateSequence;
    const before = delivery === "steer"
      ? session.getSteeringMessages().length
      : session.getFollowUpMessages().length;
    const mutation = delivery === "steer" ? session.steer(text, visualContent) : session.followUp(text, visualContent);
    const appliedSynchronously = this.queueUpdateSequence > updateSequenceBefore || (delivery === "steer"
      ? session.getSteeringMessages().length
      : session.getFollowUpMessages().length) > before;
    return mutation.catch((error: unknown) => {
      if (!appliedSynchronously) throw new AgentQueueRejectedBeforeEffectError(error);
      throw new AgentQueueEffectUnknownError(error);
    });
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const models = await this.requireActive().services.modelRuntime.getAvailable();
    return models.map((model) => ({
      provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    })).sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  }

  async listTools(): Promise<AgentToolProjection> {
    const session = this.requireActive().session;
    return projectVisibleTools(session);
  }

  async setActiveTools(names: string[]): Promise<AgentToolProjection> {
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
    if (unknown !== undefined) throw new AgentUnknownToolError(unknown);
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
    if (key === "transport") binding.session.agent.transport = update.value;
    if (key === "httpIdleTimeoutMs") this.options.configureNetwork?.(binding.services.settingsManager);
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
    const binding = this.requireActive();
    const loader = binding.services.resourceLoader;
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
    const modelError = binding.services.modelRuntime.getError();
    const diagnostics: DiagnosticDto[] = [
      ...extensions.errors.map((failure) => ({ severity: "error" as const, message: safeRequiredText(failure.error, 2_048, "Extension load failure omitted"), source: boundedString(failure.path, 256, "extension") })),
      ...skills.diagnostics.map(projectDiagnostic),
      ...prompts.diagnostics.map(projectDiagnostic),
      ...(modelError ? [{ severity: "error" as const, message: safeRequiredText(modelError, 2_048, "Model configuration error omitted"), source: "models.json" }] : []),
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

  async listSessions(scope: "cwd" | "all"): Promise<AgentSessionInfo[]> {
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

  getHistory(): AgentHistoryEntry[] {
    return this.conversationEntries().map(({ projected }) => projected);
  }

  async getConversationHistory(cursor?: string, limit = 50): Promise<AgentConversationHistoryPage> {
    const state = this.conversationState();
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    let end = state.entries.length;
    if (cursor !== undefined) {
      const continuation = this.conversationHistoryCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision) throw new AgentConversationCursorError("Conversation history cursor is stale");
      end = continuation.end;
    }
    const start = Math.max(0, end - boundedLimit);
    const entries = state.entries.slice(start, end).map(({ source, projected }) => ({
      entry: projected,
      contentRef: conversationContentRef(state.revision, source.id),
      contentComplete: conversationPreviewIsComplete(source, projected),
      totalBlocks: conversationBlockCount(source),
    }));
    if (start === 0) return { revision: state.revision, entries, hasEarlier: false };
    const nextCursor = randomUUID();
    this.conversationHistoryCursors.set(nextCursor, { revision: state.revision, end: start });
    trimTokenMap(this.conversationHistoryCursors);
    return { revision: state.revision, entries, hasEarlier: true, nextCursor };
  }

  async getConversationContent(contentRef: string, cursor?: string): Promise<AgentConversationContentPage> {
    const state = this.conversationState();
    let blockIndex = 0;
    let offset = 0;
    if (cursor !== undefined) {
      const continuation = this.conversationContentCursors.get(cursor);
      if (!continuation || continuation.revision !== state.revision || continuation.contentRef !== contentRef) {
        throw new AgentConversationCursorError("Conversation content cursor is stale");
      }
      blockIndex = continuation.blockIndex;
      offset = continuation.offset;
    }
    const selected = state.entries.find(({ source }) => conversationContentRef(state.revision, source.id) === contentRef);
    if (!selected) throw new AgentConversationCursorError("Conversation content reference is stale");
    const blocks = conversationContentBlocks(selected.source, selected.projected);
    const chunks: AgentConversationContentChunk[] = [];
    let chars = 0;
    while (blockIndex < blocks.length && chunks.length < 64 && chars < 64_000) {
      const block = blocks[blockIndex]!;
      if (block.type === "text" || block.type === "thinking") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(32_000, remaining)));
        const text = block.text.slice(offset, end);
        const blockComplete = end >= block.text.length;
        chunks.push({ blockIndex, type: block.type, text, offset, blockComplete });
        chars += text.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "image") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.data, Math.min(block.data.length, offset + Math.min(32_000, remaining)));
        const data = block.data.slice(offset, end);
        const blockComplete = end >= block.data.length;
        chunks.push({ ...block, blockIndex, data, offset, blockComplete });
        chars += data.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_call") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.argumentsJson, Math.min(block.argumentsJson.length, offset + Math.min(32_000, remaining)));
        const argumentsJson = block.argumentsJson.slice(offset, end);
        const blockComplete = end >= block.argumentsJson.length;
        chunks.push({ ...block, blockIndex, argumentsJson, offset, blockComplete });
        chars += argumentsJson.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else if (block.type === "tool_result") {
        const remaining = Math.max(1, 64_000 - chars);
        const end = unicodeSafeEnd(block.text, Math.min(block.text.length, offset + Math.min(32_000, remaining)));
        const text = block.text.slice(offset, end);
        const blockComplete = end >= block.text.length;
        chunks.push({ ...block, blockIndex, text, offset, blockComplete });
        chars += text.length;
        if (blockComplete) { blockIndex += 1; offset = 0; } else { offset = end; break; }
      } else {
        chunks.push({ ...block, blockIndex } as AgentConversationContentChunk);
        blockIndex += 1;
        offset = 0;
      }
    }
    if (blockIndex >= blocks.length) return { revision: state.revision, contentRef, chunks, complete: true };
    const nextCursor = randomUUID();
    this.conversationContentCursors.set(nextCursor, { revision: state.revision, contentRef, blockIndex, offset });
    trimTokenMap(this.conversationContentCursors);
    return { revision: state.revision, contentRef, chunks, complete: false, nextCursor };
  }

  private conversationEntries(): Array<{ source: SessionEntry; projected: AgentHistoryEntry }> {
    const branch = this.requireActive().session.sessionManager.getBranch();
    return buildContextEntries(branch).flatMap((source) => {
      const projected = projectHistoryEntry(source);
      return projected === undefined ? [] : [{ source, projected }];
    });
  }

  private conversationState(): { revision: string; entries: Array<{ source: SessionEntry; projected: AgentHistoryEntry }> } {
    const entries = this.conversationEntries();
    const manager = this.requireActive().session.sessionManager;
    const revision = createHash("sha256")
      .update(this.conversationScope)
      .update("\u0000")
      .update(manager.getSessionId())
      .update("\u0000")
      .update(manager.getLeafId() ?? "")
      .update("\u0000")
      .update(entries.map(({ source }) => source.id).join("\u0000"))
      .digest("hex");
    if (revision !== this.conversationRevisionValue) {
      this.conversationRevisionValue = revision;
      this.conversationHistoryCursors.clear();
      this.conversationContentCursors.clear();
    }
    return { revision, entries };
  }

  getTree(): AgentTreeSnapshot {
    const manager = this.requireActive().session.sessionManager;
    const nodes: AgentTreeNode[] = [];
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

  navigateTree(targetId: string, options: AgentNavigateOptions = {}): Promise<AgentNavigateResult> {
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

  async selectModel(provider: string, modelId: string): Promise<AgentModelState> {
    const binding = this.requireActive();
    const model = binding.services.modelRuntime.getModel(provider, modelId);
    if (!model || !(await binding.services.modelRuntime.checkAuth(provider))) throw new AgentModelNotFoundError(provider, modelId);
    this.assertCleanSettingsBaseline(binding, "model");
    await binding.session.setModel(model);
    await this.persistSettings(binding, "model");
    return this.getModelState();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<AgentModelState> {
    const binding = this.requireActive();
    this.assertCleanSettingsBaseline(binding, "thinking");
    binding.session.setThinkingLevel(level);
    await this.persistSettings(binding, "thinking");
    return this.getModelState();
  }

  getModelState(): AgentModelState {
    const session = this.requireActive().session;
    return {
      model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: [...session.getAvailableThinkingLevels()],
    };
  }

  getMetrics(): AgentSessionMetrics {
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

  clearQueue(): ClearedAgentQueue { return this.requireActive().session.clearQueue(); }
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

  async resolveSessionTarget(path: string): Promise<AgentSessionTarget> {
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
      return this.replace(
        operationId,
        "switch",
        () => this.options.runtime.switchSession(path),
        trust.canonicalCwd,
      );
    });
  }

  fork(
    operationId: string,
    entryId: string,
    position: "before" | "at",
    kind: "fork" | "clone",
  ): Promise<AgentForkResult> {
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

  compact(customInstructions?: string): Promise<AgentCompactionResult> {
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
        throw new AgentCompactionKnownFailureError(reason, message);
      }
    });
  }

  reload(operationId: string): Promise<{ cancelled: false }> {
    return this.serialize(async () => {
      const previousSessionFile = this.sessionFile;
      const binding = this.requireActive();
      const buffered: AgentEvent[] = [];
      const originalBuffer = binding.buffered;
      binding.buffered = buffered;
      binding.bufferEvents = true;
      this.options.extensionUiBroker?.beginGenerationChange("reload");
      try {
        await binding.services.modelRuntime.reloadConfig();
        let seamCalls = 0;
        await binding.session.reload({
          beforeSessionStart: () => {
            seamCalls += 1;
            // Extension providers have been re-registered by this point, so
            // refresh model objects only now rather than against the old runner.
            refreshSessionModelReferences(binding.session, binding.services);
            syncAgentRuntimeSettings(binding.session, binding.services.settingsManager);
            this.options.configureNetwork?.(binding.services.settingsManager);
          },
        });
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

  private async replace<T extends { cancelled: boolean }>(
    operationId: string,
    kind: "new" | "switch" | "fork" | "clone",
    operation: () => Promise<T>,
    constructionCwd?: string,
  ): Promise<T> {
    const previousSessionFile = this.sessionFile;
    const previousProcessCwd = this.processCwdValue;
    this.rebindEntered = false;
    this.replacementInvalidated = false;
    this.replacementRunning = true;
    try {
      if (constructionCwd !== undefined) {
        this.options.setProcessCwd?.(constructionCwd);
        this.processCwdValue = constructionCwd;
      }
      const result = await operation();
      if (result.cancelled) {
        if (this.rebindEntered || this.replacementInvalidated || !this.active) {
          throw new Error("Cancelled replacement changed the active runtime binding");
        }
        this.restoreProcessCwd(previousProcessCwd);
        return result;
      }
      if (!this.rebindEntered || !this.staged) throw new Error("Runtime replacement completed without exactly one rebind");
      await this.options.commitReplacement?.({ operationId, kind, previousSessionFile, sessionFile: this.staged.session.sessionFile });
      this.promoteStaged(kind, previousSessionFile);
      return result;
    } catch (error) {
      if (!this.replacementInvalidated) {
        this.restoreProcessCwd(previousProcessCwd);
        throw error;
      }
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

  private restoreProcessCwd(previousProcessCwd: string | undefined): void {
    if (previousProcessCwd === undefined || previousProcessCwd === this.processCwdValue) return;
    this.options.setProcessCwd?.(previousProcessCwd);
    this.processCwdValue = previousProcessCwd;
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
    const binding: Binding = { token, session, services: this.options.runtime.services, cwd: this.options.runtime.services.cwd, unsubscribe: () => {}, buffered: [], bufferEvents: true };
    binding.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (!token.active) return;
      for (const projected of projectAgentSessionEvents(event)) {
        if (this.active === binding && !binding.bufferEvents) this.publish(projected);
        else binding.buffered.push(projected);
      }
    });
    this.staged = binding;
    const previousProcessCwd = this.processCwdValue;
    try {
      this.options.setProcessCwd?.(binding.cwd);
      this.processCwdValue = binding.cwd;
      const uiContext = this.options.uiContextFactory?.() ?? this.options.uiContext;
      await session.bindExtensions({ uiContext, mode: uiContext ? "rpc" : "print", onError: (error) => {
        if (!token.active) return;
        const event = { type: "dock_extension_error", error: boundedErrorMessage(error) };
        if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
      } });
      const publishBranch = (branch: string | undefined): void => {
        if (!token.active) return;
        const event: AgentEvent = { type: "dock_git_branch_changed", branch };
        if (this.active === binding && !binding.bufferEvents) this.publish(event); else binding.buffered.push(event);
      };
      binding.gitBranchObserver = await (this.options.gitBranchObserverFactory
        ? this.options.gitBranchObserverFactory(binding.cwd, publishBranch)
        : GitBranchObserver.create(binding.cwd, publishBranch));
    } catch (error) {
      token.active = false;
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
      if (this.staged === binding) this.staged = undefined;
      if (previousProcessCwd !== undefined) {
        try { this.options.setProcessCwd?.(previousProcessCwd); this.processCwdValue = previousProcessCwd; }
        catch { /* Runtime replacement will fail closed and dispose this Worker. */ }
      }
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

  private publishReplacementBuffer(events: readonly AgentEvent[]): void {
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
      cwd: this.active?.cwd,
      name: this.active?.session.sessionManager.getSessionName(),
      gitBranch: this.active?.gitBranchObserver?.branch,
    });
  }

  private invalidateBindingsSynchronously(): void {
    this.conversationScope = randomUUID();
    this.conversationRevisionValue = undefined;
    this.conversationHistoryCursors.clear();
    this.conversationContentCursors.clear();
    for (const binding of [this.active, this.staged]) {
      if (!binding) continue;
      binding.token.active = false;
      binding.unsubscribe();
      binding.gitBranchObserver?.dispose();
    }
    this.active = undefined;
    this.staged = undefined;
  }

  private publish(event: AgentEvent): void {
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
    if (failures.length > 0) throw new AgentSettingsWriteError(setting, "baseline", false, failures);
  }

  private async persistSettings(binding: Binding, setting: SettingKey | "model" | "thinking"): Promise<void> {
    const failures: Array<{ scope: "global" | "project" | "unknown"; message: string }> = [];
    try { await binding.services.settingsManager.flush(); }
    catch (error) { failures.push({ scope: "unknown", message: boundedErrorMessage(error) }); }
    failures.push(...projectSettingsErrors(binding.services.settingsManager.drainErrors()));
    if (failures.length > 0) throw new AgentSettingsWriteError(setting, "write", true, failures);
  }
}

const MAX_PROJECTION_ITEMS = 2_000;
const MAX_TOOL_PROJECTION_BYTES = 600_000;

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

interface PiImageContent { type: "image"; data: string; mimeType: string }

function safeImageMimeType(value: unknown): string {
  return typeof value === "string"
    && value.length <= MAX_IMAGE_MIME_TYPE_CHARS
    && /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : "image/unknown";
}

async function loadPiImages(images: readonly AgentImagePath[] | undefined): Promise<PiImageContent[] | undefined> {
  if (images === undefined || images.length === 0) return undefined;
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error(`Image input exceeds ${MAX_INPUT_IMAGES} files`);
  const opened: Array<{ handle: Awaited<ReturnType<typeof open>>; mimeType: string; size: number }> = [];
  let aggregate = 0;
  try {
    const seen = new Set<string>();
    for (const [index, image] of images.entries()) {
      const imageNumber = index + 1;
      if (!image || typeof image.path !== "string" || image.path.length < 1 || image.path.length > MAX_IMAGE_PATH_CHARS || !image.path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(image.path)) throw new Error(`Image ${imageNumber} path must be a bounded absolute local path`);
      const mimeType = safeImageMimeType(image.mimeType);
      if (mimeType !== image.mimeType) throw new Error(`Image ${imageNumber} MIME type must be a bounded image/* value`);
      const descriptorKey = `${image.path}\u0000${mimeType}`;
      if (seen.has(descriptorKey)) throw new Error("Image descriptors must be unique");
      seen.add(descriptorKey);
      let handle: Awaited<ReturnType<typeof open>>;
      try { handle = await open(image.path, "r"); }
      catch { throw new Error(`Image ${imageNumber} could not be opened`); }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Image ${imageNumber} path is not a regular file`);
        if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image ${imageNumber} exceeds ${MAX_IMAGE_BYTES} bytes`);
        aggregate += stat.size;
        if (aggregate > MAX_IMAGE_AGGREGATE_BYTES) throw new Error(`Image input exceeds ${MAX_IMAGE_AGGREGATE_BYTES} aggregate bytes`);
        opened.push({ handle, mimeType, size: stat.size });
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    const result: PiImageContent[] = [];
    for (const [index, image] of opened.entries()) {
      const bytes = Buffer.allocUnsafe(image.size);
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const read = await image.handle.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const extra = Buffer.allocUnsafe(1);
        const extraRead = await image.handle.read(extra, 0, 1, offset);
        if (extraRead.bytesRead > 0) throw new Error("changed");
      } catch {
        throw new Error(`Image ${index + 1} could not be read as a stable file`);
      }
      result.push({ type: "image", data: bytes.subarray(0, offset).toString("base64"), mimeType: image.mimeType });
    }
    return result;
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})));
  }
}

function safeOptionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return boundedString(value, limit, "");
}

function safeRequiredText(value: unknown, limit: number, fallback: string): string {
  return safeOptionalText(value, limit) ?? fallback;
}

function projectAgentSessionEvents(event: AgentSessionEvent): AgentEvent[] {
  const source = event as unknown as Record<string, unknown>;
  if (source.type === "agent_message_delta" && isRecord(source.assistantMessageEvent)) {
    const update = source.assistantMessageEvent;
    if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string" && update.delta.length > 8_000) {
      const projected: AgentEvent[] = [];
      let offset = 0;
      while (offset < update.delta.length) {
        const end = unicodeSafeEnd(update.delta, Math.min(update.delta.length, offset + 8_000));
        projected.push(projectAgentSessionEvent({ ...source, assistantMessageEvent: { ...update, delta: update.delta.slice(offset, end) } }));
        offset = end;
      }
      return projected;
    }
  }
  return [projectAgentSessionEvent(source)];
}

function projectAgentSessionEvent(event: AgentSessionEvent | Record<string, unknown>): AgentEvent {
  const source = event as unknown as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : "unknown";
  if (type === "agent_end") return { type, willRetry: source.willRetry === true };
  if (type === "turn_end" || type === "entry_appended") return { type };
  if ((type === "message_start" || type === "message_end") && isRecord(source.message)) {
    return { type, message: projectRuntimeMessage(source.message) };
  }
  if (type === "message_update" && isRecord(source.assistantMessageEvent)) {
    return { type, assistantMessageEvent: projectAssistantMessageEvent(source.assistantMessageEvent) };
  }
  if (type === "tool_execution_start") {
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      args: projectJsonObject(source.args).value,
    };
  }
  if (type === "tool_execution_end" || type === "tool_execution_update") {
    const resultKey = type === "tool_execution_end" ? "result" : "partialResult";
    const result = isRecord(source[resultKey]) ? source[resultKey] as Record<string, unknown> : undefined;
    const toolName = typeof source.toolName === "string" ? source.toolName : undefined;
    const isError = type === "tool_execution_end" && source.isError === true;
    const contentText = safeOptionalText(toolResultText(result?.content), 256_000);
    const content = projectPrivateToolContent(result?.content);
    const presentation = projectBuiltInToolPresentation(toolName, contentText, result?.details, isError);
    return {
      type,
      toolCallId: safeRequiredText(source.toolCallId, 128, "unknown"),
      toolName: safeRequiredText(source.toolName, 256, "tool"),
      [resultKey]: { content, ...(presentation === undefined ? {} : { presentation }) },
      ...(type === "tool_execution_end" ? { isError } : {}),
    };
  }
  if (type === "compaction_end") {
    return {
      type,
      reason: source.reason,
      aborted: source.aborted === true,
      willRetry: source.willRetry === true,
      ...(safeOptionalText(source.errorMessage, 2_048) === undefined ? {} : { errorMessage: safeOptionalText(source.errorMessage, 2_048) }),
    };
  }
  return source as AgentEvent;
}

function projectRuntimeMessage(message: Record<string, unknown>): Record<string, unknown> {
  const role = safeRequiredText(message.role, 64, "system");
  const projected: Record<string, unknown> = {
    role,
    content: role === "toolResult" ? projectPrivateToolContent(message.content) : projectPrivateContent(message.content),
  };
  const stopReason = safeOptionalText(message.stopReason, 128);
  const errorMessage = safeOptionalText(message.errorMessage, 2_048);
  const toolCallId = safeOptionalText(message.toolCallId, 128);
  if (stopReason !== undefined) projected.stopReason = stopReason;
  if (errorMessage !== undefined) projected.errorMessage = errorMessage;
  if (toolCallId !== undefined) projected.toolCallId = toolCallId;
  return projected;
}

function projectAssistantMessageEvent(update: Record<string, unknown>): Record<string, unknown> {
  const type = safeRequiredText(update.type, 64, "unknown");
  const projected: Record<string, unknown> = { type };
  if (typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0) projected.contentIndex = update.contentIndex;
  const delta = safeOptionalText(update.delta, 8_000);
  if (delta !== undefined) projected.delta = delta;
  if (isRecord(update.partial)) projected.partial = { content: projectPrivateContent(update.partial.content) };
  if (isRecord(update.toolCall)) projected.toolCall = projectPrivateToolCall(update.toolCall);
  return projected;
}

function projectPrivateContent(content: unknown): unknown {
  if (typeof content === "string") return safeRequiredText(content, 256_000, "Content unavailable");
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content.slice(0, 200)) {
    if (!isRecord(item)) continue;
    if (item.type === "text") blocks.push({ type: "text", text: item.text === "" ? "" : safeRequiredText(item.text, 8_000, "Content unavailable") });
    else if (item.type === "thinking") {
      const thinking = safeOptionalText(item.thinking, 8_000);
      if (thinking !== undefined) blocks.push({ type: "thinking", thinking });
    }
    else if (item.type === "toolCall" || item.type === "tool_call") blocks.push(projectPrivateToolCall(item));
    else if (item.type === "image") blocks.push({ type: "image", mimeType: safeImageMimeType(item.mimeType) });
  }
  if (content.length > 200) blocks.push({ type: "text", text: "[Additional content omitted]" });
  return blocks;
}

function projectPrivateToolContent(content: unknown): unknown {
  if (typeof content === "string") return boundedString(content, 256_000, "");
  if (!Array.isArray(content)) return [];
  return content.slice(0, 200).flatMap((item): Record<string, unknown>[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: boundedString(item.text, 256_000, "") }];
    if (item.type === "image") return [{ type: "image", mimeType: safeImageMimeType(item.mimeType) }];
    return [];
  });
}

function projectPrivateToolCall(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "toolCall",
    id: safeRequiredText(value.id, 128, "unknown"),
    name: safeRequiredText(value.name, 256, "tool"),
    arguments: projectJsonObject(value.arguments).value,
  };
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content.slice(0, 200)) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    parts.push(item.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function projectHistoryEntry(entry: SessionEntry): AgentHistoryEntry | undefined {
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
    const isError = message.isError === true;
    const toolPresentation = role === "toolResult"
      ? projectBuiltInToolPresentation(toolName, toolResultText(message.content), message.details, isError)
      : undefined;
    let content: unknown = role === "toolResult"
      ? projectPrivateToolContent(message.content)
      : projectPrivateContent(message.content);
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? boundedString(message.command, 8_000, "") : "";
      const output = typeof message.output === "string" ? boundedString(message.output, 256_000, "") : "";
      content = `! ${command}${output ? `\n${output}` : ""}`;
    } else if (role === "branchSummary" || role === "compactionSummary") {
      content = typeof message.summary === "string" ? boundedString(message.summary, 256_000, "") : "";
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
      ...(toolPresentation === undefined ? {} : { toolPresentation }),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    };
  }
  if (entry.type === "custom_message") {
    if (!entry.display) return undefined;
    return { ...base, role: "system", content: projectPrivateContent(entry.content) };
  }
  if (entry.type === "thinking_level_change") return { ...base, role: "system", content: `Thinking level changed to ${entry.thinkingLevel}` };
  if (entry.type === "model_change") return { ...base, role: "system", content: `Model changed to ${entry.provider}/${entry.modelId}` };
  if (entry.type === "compaction") return { ...base, role: "system", summaryKind: "compaction", content: entry.summary };
  if (entry.type === "branch_summary") return { ...base, role: "system", summaryKind: "branch", content: entry.summary };
  if (entry.type === "session_info" && entry.name) return { ...base, role: "system", content: `Session named ${entry.name}` };
  return undefined;
}

type ConversationTextSourceBlock = { type: "text" | "thinking"; text: string };
type ConversationOmittedSourceBlock = { type: "omitted"; kind: "image" | "binary"; description: string };
type ConversationSourceBlock =
  | ConversationTextSourceBlock
  | { type: "image"; mimeType: string; data: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; argumentsJson: string }
  | { type: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean; omittedFields?: string[] }
  | ConversationOmittedSourceBlock;

function conversationContentBlocks(entry: SessionEntry, projected: AgentHistoryEntry): ConversationSourceBlock[] {
  const omitted = (kind: "image" | "binary", description: string): ConversationOmittedSourceBlock => ({ type: "omitted", kind, description });
  const text = (type: "text" | "thinking", value: unknown): ConversationTextSourceBlock => ({
    type,
    text: typeof value === "string" ? value : "",
  });
  if (entry.type === "compaction" || entry.type === "branch_summary") return [text("text", entry.summary)];
  if (entry.type === "thinking_level_change" || entry.type === "model_change" || entry.type === "session_info") {
    const value = typeof projected.content === "string" ? projected.content : String(projected.content ?? "");
    return [text("text", value)];
  }
  const content = entry.type === "custom_message"
    ? entry.content
    : entry.type === "message"
      ? (entry.message as unknown as Record<string, unknown>).content
      : undefined;
  if (entry.type === "message") {
    const message = entry.message as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "system";
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return [text("text", `! ${command}${output ? `\n${output}` : ""}`)];
    }
    if (role === "branchSummary" || role === "compactionSummary") return [text("text", message.summary)];
    if (role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? boundedString(message.toolCallId, 128, "unknown") : "unknown";
      const toolName = typeof message.toolName === "string" ? boundedString(message.toolName, 256, "tool") : "tool";
      const isError = message.isError === true;
      const items = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
      return items.flatMap((item): ConversationSourceBlock[] => {
        if (!isRecord(item)) return [];
        if (item.type === "image") return [{ type: "image", mimeType: safeImageMimeType(item.mimeType), data: typeof item.data === "string" ? item.data : "" }];
        if (item.type !== "text") return [];
        const value = text("text", item.text);
        return [{ type: "tool_result", toolCallId, toolName, text: value.text, isError }];
      });
    }
  }
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  return items.flatMap((item): ConversationSourceBlock[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text") return [text("text", item.text)];
    if (item.type === "thinking") return [text("thinking", item.thinking)];
    if (item.type === "image") return [{ type: "image", mimeType: safeImageMimeType(item.mimeType), data: typeof item.data === "string" ? item.data : "" }];
    if ((item.type === "toolCall" || item.type === "tool_call") && typeof item.name === "string") {
      try {
        const argumentsJson = JSON.stringify(item.arguments ?? {});
        return [{
          type: "tool_call",
          toolCallId: safeRequiredText(item.id, 128, "unknown"),
          toolName: safeRequiredText(item.name, 256, "tool"),
          argumentsJson,
        }];
      } catch {
        return [omitted("binary", "Unserializable tool arguments omitted")];
      }
    }
    return [];
  });
}

function conversationBlockCount(entry: SessionEntry): number {
  const projected = projectHistoryEntry(entry);
  return projected === undefined ? 0 : conversationContentBlocks(entry, projected).length;
}

function conversationPreviewIsComplete(_entry: SessionEntry, _projected: AgentHistoryEntry): boolean {
  // Legacy history was not designed to prove exactness. New clients hydrate via
  // contentRef; never claim a bounded preview is authoritative by inference.
  return false;
}

function unicodeSafeEnd(value: string, requestedEnd: number): number {
  return requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
}

function conversationContentRef(revision: string, entryId: string): string {
  return createHash("sha256").update(revision).update("\u0000").update(entryId).digest("hex");
}

function trimTokenMap<T>(map: Map<string, T>, max = 8_192): void {
  while (map.size > max) map.delete(map.keys().next().value as string);
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
  output: AgentTreeNode[],
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
    kind: kind as AgentTreeNode["kind"],
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

function treeMessageState(message: Record<string, unknown>): AgentTreeNode["state"] {
  if (message.role === "assistant") {
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error" || typeof message.errorMessage === "string") return "error";
  }
  if ((message.role === "tool" || message.role === "toolResult") && message.isError === true) return "error";
  return undefined;
}

function treeDisplayClass(
  entry: SessionEntry,
  role: AgentTreeNode["role"],
  state: AgentTreeNode["state"],
): NonNullable<AgentTreeNode["displayClass"]> {
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

function projectVisibleTools(session: AgentSession): AgentToolProjection {
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

function refreshSessionModelReferences(session: AgentSession, services: AgentSessionServices): void {
  const current = session.model;
  if (current) {
    const refreshed = services.modelRuntime.getModel(current.provider, current.id);
    if (refreshed) session.agent.state.model = refreshed;
  }
  if (session.scopedModels.length > 0) {
    session.setScopedModels(session.scopedModels.map((scoped) => ({
      ...scoped,
      model: services.modelRuntime.getModel(scoped.model.provider, scoped.model.id) ?? scoped.model,
    })));
  }
}

function syncAgentRuntimeSettings(session: AgentSession, settingsManager: SettingsManager): void {
  session.agent.transport = settingsManager.getTransport();
  session.agent.thinkingBudgets = settingsManager.getThinkingBudgets();
  session.agent.maxRetryDelayMs = settingsManager.getProviderRetrySettings().maxRetryDelayMs;
}

export async function createPiAgentAdapter(options: CreatePiAgentAdapterOptions): Promise<PiAgentAdapter> {
  const uiContext = options.extensionUiBroker && !options.extensionUiContextPortFactory
    ? createPiExtensionUiContext(options.extensionUiBroker)
    : undefined;
  const createUiContext = options.extensionUiContextPortFactory
    ? () => createPiExtensionUiContext(options.extensionUiContextPortFactory!())
    : undefined;
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
  return PiAgentAdapter.create({
    runtime,
    extensionUiBroker: options.extensionUiBroker,
    uiContext,
    uiContextFactory: createUiContext,
    setProjectTrust: (cwd, trusted) => trustByCwd.set(cwd, trusted),
    configureNetwork: configurePiNetwork,
    initialProcessCwd: options.cwd,
    ...(options.setProcessCwd === undefined ? {} : { setProcessCwd: options.setProcessCwd }),
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
