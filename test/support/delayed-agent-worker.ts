import type {
  ClearedAgentQueue,
  AgentCompactionResult,
  AgentConversationContentChunk,
  AgentConversationContentPage,
  AgentConversationHistoryPage,
  AgentEvent,
  AgentHistoryEntry,
  AgentInvokeOptions,
  AgentModelInfo,
  AgentModelState,
  AgentNavigateOptions,
  AgentNavigateResult,
  AgentPromptOptions,
  AgentRequest,
  AgentWorkerConnection,
  AgentWorkerControl,
  AgentWorkerState,
  AgentSessionInfo,
  AgentSessionMetrics,
  ThinkingLevel,
  AgentTreeNode,
  AgentTreeSnapshot,
} from "../../src/core/agent-worker.js";
import { AgentConversationCursorError, AgentSettingsWriteError } from "../../src/core/agent-worker.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingUpdate, SettingValueMap, ToolDto } from "../../src/core/config-projection.js";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../../src/core/config-projection.js";
import { sliceSemanticHistory } from "../../src/core/history-pagination.js";
import type { AttachmentDto, ConversationFrame, ImagePathDto, JsonObject } from "../../src/core/instance-dto.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Deterministic in-flight runtime used only by control-plane tests. */
export class DelayedAgentWorkerConnection implements AgentWorkerConnection {
  sessionId: string;
  sessionFile: string;
  isStreaming = false;
  isCompacting = false;
  readonly extensionCommands = new Set<string>();
  sessionMutationCalls = { new: 0, switch: 0, name: 0, compact: 0, reload: 0, navigate: 0, fork: 0, clone: 0 };
  sessionName: string | undefined;
  gitBranch: string | undefined;
  abortCalls = 0;
  clearQueueCalls = 0;
  abortError: Error | undefined;
  disposeCalls = 0;
  disposeError: Error | undefined;
  promptCalls = 0;
  promptMessages: string[] = [];
  promptOptions: Array<AgentPromptOptions | undefined> = [];
  modelMutationCalls = 0;
  thinkingMutationCalls = 0;
  toolMutationCalls = 0;
  settingMutationCalls = 0;
  readonly observationNotifications: Array<Extract<AgentWorkerControl, { type: "observation_delivery" }>["notification"]> = [];
  settingsFailure: Error | undefined;
  settingsReadFailure: Error | undefined;
  sessionMutationError: Error | undefined;
  sessionCatalog: AgentSessionInfo[] = [];
  history: AgentHistoryEntry[] = [];
  conversationRevision = "fixture-conversation-revision";
  readonly conversationContent = new Map<string, AgentConversationContentChunk[]>();
  treeNodes: AgentTreeNode[] = [];
  treeLeafId: string | undefined;
  treeReadCalls = 0;
  navigationResult: AgentNavigateResult | undefined;
  metrics: AgentSessionMetrics = {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly conversationInputs: Array<{ operationId: string; text: string; delivery: "prompt" | "steer" | "followUp"; fromQueue: boolean; images?: ImagePathDto[]; attachments?: AttachmentDto[] }> = [];
  private readonly conversationToolCalls = new Set<string>();
  private readonly conversationCompletedToolCalls = new Set<string>();
  private conversationMessageSequence = 0;
  private conversationUserMessageId: string | undefined;
  private conversationUserAttachments: AttachmentDto[] | undefined;
  private conversationLastUserAttachments: AttachmentDto[] | undefined;
  private conversationAssistantMessageId: string | undefined;
  private conversationOutcome: { stopReason?: string; error?: string } | undefined;
  private historyEntrySequence = 0;
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private currentRun: Deferred<void> | undefined;
  private nextPromptPreflightBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private disposeBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private modelMutationBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private nextCompactionStartBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private nextCompactionBlock: { entered: Deferred<void>; result: Deferred<AgentCompactionResult> } | undefined;
  private activeCompactionBlock: { entered: Deferred<void>; result: Deferred<AgentCompactionResult> } | undefined;
  private nextNavigationBlock: { entered: Deferred<void>; result: Deferred<AgentNavigateResult> } | undefined;
  private activeNavigationBlock: { entered: Deferred<void>; result: Deferred<AgentNavigateResult> } | undefined;
  private postSettlementContinuation: {
    compactionStarted: Deferred<void>;
    finishCompaction: Deferred<void>;
    continuationStarted: Deferred<void>;
    toolCallId: string;
    toolName: string;
  } | undefined;
  private activeTools = new Set(["read"]);
  private readonly settingValues: SettingValueMap = {
    autoCompaction: true, compactionReserveTokens: 165_536, compactionKeepRecentTokens: 20_000,
    autoRetry: true, enableSkillCommands: true, hideThinking: false,
    showCacheMissNotices: false, showHardwareCursor: false, clearOnShrink: true, showTerminalProgress: true,
    quietStartup: false, collapseChangelog: false, enableInstallTelemetry: true,
    steeringMode: "all", followUpMode: "all", transport: "auto",
    doubleEscapeAction: "tree", treeFilterMode: "default", defaultProjectTrust: "ask",
    httpIdleTimeoutMs: 0, editorPaddingX: 0, outputPad: 0, autocompleteMaxVisible: 10, warnings: {},
  };
  private modelState: AgentModelState = {
    model: { provider: "fixture", id: "default" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "low", "high"],
  };

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.sessionFile = `/tmp/${sessionId}.jsonl`;
  }

  state(): AgentWorkerState {
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      durableSessionFile: this.sessionFile,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      ...(this.gitBranch === undefined ? {} : { gitBranch: this.gitBranch }),
      modelState: this.getModelState(),
      metrics: this.getMetrics(),
      extensionCommands: [...this.extensionCommands],
    };
  }

  async invoke(request: AgentRequest, options?: AgentInvokeOptions): Promise<unknown> {
    const p = request.params as Record<string, any>;
    switch (request.type) {
      case "command.submit": {
        const requestedDelivery = p.delivery as "auto" | "prompt" | "steer" | "followUp";
        const delivery = requestedDelivery === "auto" ? (this.isStreaming ? "steer" : "prompt") : requestedDelivery;
        const inputKind = this.classifyInput(p.message);
        const tracked = inputKind === "prompt" ? {
          operationId: p.operationId as string,
          text: p.message as string,
          delivery,
          fromQueue: options?.context?.type === "force_queue" || options?.context?.type === "host_queue",
          ...(p.images === undefined ? {} : { images: structuredClone(p.images) }),
          ...(options?.context !== undefined && options.context.type !== "session_switch" && options.context.attachments !== undefined
            ? { attachments: structuredClone(options.context.attachments) }
            : {}),
        } : undefined;
        if (tracked !== undefined) this.conversationInputs.push(tracked);
        return options?.context?.type === "force_queue"
          ? this.queueMessage(p.message, delivery === "prompt" ? "followUp" : delivery)
          : this.prompt(p.message, {
            ...(delivery === "prompt" ? {} : { streamingBehavior: delivery }),
            ...(p.images === undefined ? {} : { images: p.images }),
            preflightResult: (success) => {
              if (!success) {
                options?.preflightResult?.({ success: false });
                return;
              }
              const actualDelivery = this.isStreaming ? delivery : "prompt";
              if (tracked !== undefined) {
                tracked.delivery = actualDelivery;
                tracked.fromQueue ||= actualDelivery !== "prompt";
              }
              options?.preflightResult?.({ success: true, delivery: actualDelivery });
            },
          });
      }
      case "command.abort": return this.abort();
      case "queue.dequeue": return this.clearQueue();
      case "model.list": return this.listModels();
      case "model.set": return this.selectModel(p.provider, p.modelId);
      case "thinking.set": return this.setThinkingLevel(p.level);
      case "tool.list": return this.listTools();
      case "tool.set_active": return this.setActiveTools(p.names);
      case "settings.get": return this.getSettings();
      case "settings.update": return this.updateSetting(p.update);
      case "resource.get": return this.getResources();
      case "command.catalog": return this.getCommands();
      case "session.history": await Promise.resolve(); return this.getHistory();
      case "conversation.history": return this.getConversationHistory(p.cursor, p.limit);
      case "conversation.content": return this.getConversationContent(p.contentRef, p.cursor);
      case "session.list": return this.listSessions(p.scope);
      case "session.switch": return this.switchSession(p.operationId, p.sessionFile);
      case "session.new": return this.newSession(p.operationId, p.parentSession);
      case "session.name": return this.setSessionName(p.name);
      case "session.compact": return this.compact();
      case "session.reload": return this.reload();
      case "session.tree": return this.getTree();
      case "session.navigate": return this.navigateTree(p.targetId, p);
      case "session.fork": return this.fork(p.operationId, p.entryId, "before", "fork");
      case "session.clone": return this.fork(p.operationId, p.entryId, "at", "clone");
    }
  }

  control(request: AgentWorkerControl): Promise<unknown> {
    if (request.type === "resolve_session_target") return this.resolveSessionTarget(request.sessionFile);
    if (request.type === "wait_for_idle") return this.waitForIdle();
    if (request.type === "observation_delivery") {
      this.observationNotifications.push(structuredClone(request.notification));
      return Promise.resolve(null);
    }
    if (request.type === "dispose") return this.dispose();
    return Promise.resolve(null);
  }

  getGitBranch(): string | undefined { return this.gitBranch; }

  setGitBranch(branch: string | undefined): void {
    this.gitBranch = branch;
    this.emit({ type: "dock_git_branch_changed", branch });
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  classifyInput(text: string): "extension_command" | "prompt" {
    if (!text.startsWith("/")) return "prompt";
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return this.extensionCommands.has(commandName) ? "extension_command" : "prompt";
  }

  async prompt(text: string, options?: AgentPromptOptions): Promise<void> {
    this.promptCalls += 1;
    this.promptMessages.push(text);
    this.promptOptions.push(options === undefined ? undefined : structuredClone({ ...options, preflightResult: undefined }));
    if (this.classifyInput(text) === "extension_command") {
      options?.preflightResult?.(true);
      return;
    }
    const preflightBlock = this.nextPromptPreflightBlock;
    this.nextPromptPreflightBlock = undefined;
    if (preflightBlock) {
      preflightBlock.entered.resolve();
      await preflightBlock.release.promise;
    }
    if (this.isStreaming && options?.streamingBehavior) {
      if (options.streamingBehavior === "steer") this.steeringQueue.push(text);
      else this.followUpQueue.push(text);
      this.emitQueue();
      options.preflightResult?.(true);
      return;
    }
    if (this.isStreaming) throw new Error("fake runtime already streaming");

    options?.preflightResult?.(true);
    this.currentRun = new Deferred<void>();
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    this.emitUserMessage(text);
    await this.currentRun.promise;
  }

  queueMessage(text: string, delivery: "steer" | "followUp"): Promise<void> {
    if (delivery === "steer") this.steeringQueue.push(text);
    else this.followUpQueue.push(text);
    this.emitQueue();
    return Promise.resolve();
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return [
      { provider: "fixture", id: "default", name: "Fixture Default", reasoning: true },
      { provider: "fixture", id: "local", name: "Fixture Local", reasoning: true },
    ];
  }

  async listSessions(scope: "cwd" | "all"): Promise<AgentSessionInfo[]> {
    return this.sessionCatalog
      .filter((session) => scope === "all" || session.cwd === "/fixture/cwd")
      .map((session) => ({ ...session }));
  }

  getHistory(): AgentHistoryEntry[] { return structuredClone(this.history); }

  async getConversationHistory(cursor?: string, limit = 50): Promise<AgentConversationHistoryPage> {
    const end = cursor === undefined ? this.history.length : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(end) || end < 0 || end > this.history.length) throw new AgentConversationCursorError();
    const page = sliceSemanticHistory(this.history, end, Math.max(1, Math.min(200, Math.floor(limit))));
    const entries = this.history.slice(page.start, page.end).map((entry) => ({
      entry: structuredClone(entry),
      contentRef: `fixture-${entry.entryId}`,
      contentComplete: false,
      totalBlocks: this.conversationContent.get(`fixture-${entry.entryId}`)?.length ?? (Array.isArray(entry.content) ? entry.content.length : 1),
    }));
    return {
      revision: this.conversationRevision,
      entries,
      hasEarlier: page.hasEarlier,
      ...(page.hasEarlier ? { nextCursor: String(page.start) } : {}),
    };
  }

  async getConversationContent(contentRef: string, cursor?: string): Promise<AgentConversationContentPage> {
    if (cursor !== undefined) throw new AgentConversationCursorError();
    const chunks = this.conversationContent.get(contentRef);
    if (!chunks) throw new AgentConversationCursorError("Conversation content reference is stale");
    return {
      revision: this.conversationRevision,
      contentRef,
      chunks: structuredClone(chunks),
      complete: true,
    };
  }

  getTree(): AgentTreeSnapshot {
    this.treeReadCalls += 1;
    return {
      nodes: structuredClone(this.treeNodes),
      ...(this.treeLeafId === undefined ? {} : { leafId: this.treeLeafId }),
    };
  }

  async navigateTree(targetId: string, _options: AgentNavigateOptions = {}): Promise<AgentNavigateResult> {
    this.sessionMutationCalls.navigate += 1;
    const target = this.treeNodes.find((node) => node.entryId === targetId);
    if (!target) throw new Error(`Unknown tree entry: ${targetId}`);
    if (this.navigationResult) return structuredClone(this.navigationResult);
    const block = this.nextNavigationBlock;
    this.nextNavigationBlock = undefined;
    if (block) {
      this.activeNavigationBlock = block;
      block.entered.resolve();
      try { return structuredClone(await block.result.promise); }
      finally { if (this.activeNavigationBlock === block) this.activeNavigationBlock = undefined; }
    }
    this.treeLeafId = target.role === "user" ? target.parentId : target.entryId;
    return {
      cancelled: false,
      ...(target.role === "user" ? { editorText: target.summary } : {}),
      summaryCreated: false,
    };
  }

  async listTools(): Promise<ToolDto[]> {
    return ["read", "write"].map((name) => ({ name, description: `${name} fixture`, active: this.activeTools.has(name), source: { kind: "built-in" as const }, parameterSchema: { type: "object" } }));
  }

  async setActiveTools(names: string[]): Promise<ToolDto[]> {
    this.toolMutationCalls += 1;
    if (names.some((name) => name !== "read" && name !== "write")) throw new Error("Unknown tool");
    this.activeTools = new Set(names);
    return this.listTools();
  }

  async getSettings(): Promise<SettingDto[]> {
    if (this.settingsReadFailure) throw this.settingsReadFailure;
    return SETTING_KEYS.map((key) => ({ key, value: structuredClone(this.settingValues[key]), source: "effective", writable: SETTING_DEFINITIONS[key].writable,
      valueType: SETTING_DEFINITIONS[key].valueType,
      ...(SETTING_DEFINITIONS[key].allowedValues ? { allowedValues: [...(SETTING_DEFINITIONS[key].allowedValues as readonly (string | number | boolean)[])] } : {}),
      ...(SETTING_DEFINITIONS[key].min === undefined ? {} : { min: SETTING_DEFINITIONS[key].min }),
      ...(SETTING_DEFINITIONS[key].max === undefined ? {} : { max: SETTING_DEFINITIONS[key].max }),
      reloadRequired: SETTING_DEFINITIONS[key].reloadRequired, hostRestartRequired: SETTING_DEFINITIONS[key].hostRestartRequired,
    } as SettingDto));
  }

  async updateSetting(update: SettingUpdate): Promise<SettingDto> {
    this.settingMutationCalls += 1;
    (this.settingValues as unknown as Record<string, unknown>)[update.key] = structuredClone(update.value);
    this.throwSettingsFailure(update.key);
    return (await this.getSettings()).find((setting) => setting.key === update.key) as SettingDto;
  }

  async getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[] }> {
    return { resources: [{ kind: "context", name: "AGENTS.md", path: "/fixture/AGENTS.md" }], diagnostics: [{ severity: "warning", message: "fixture diagnostic" }] };
  }

  async getCommands(): Promise<CommandDto[]> {
    const source = { kind: "extension" as const, path: "/fixture/ext.ts" };
    return [
      { name: "fixture-prefix", description: "prefix fixture command", source, argumentCompletions: true },
      { name: "fixture-prefix-long", description: "long prefix fixture command", source, argumentCompletions: false },
    ];
  }

  async resolveSessionTarget(sessionFile: string): Promise<{ canonicalCwd: string }> {
    return { canonicalCwd: this.sessionCatalog.find((session) => session.sessionFile === sessionFile)?.cwd ?? "/fixture/cwd" };
  }

  async newSession(_operationId: string, _parentSession?: string): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.new += 1;
    const previousSessionFile = this.sessionFile;
    this.sessionId = `fixture-new-${this.sessionMutationCalls.new}`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
    this.sessionName = undefined;
    this.history = [];
    this.emit({ type: "dock_session_replaced", reason: "new", previousSessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
    return { cancelled: false };
  }

  async switchSession(_operationId: string, sessionFile: string): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.switch += 1;
    const previousSessionFile = this.sessionFile;
    const target = this.sessionCatalog.find((session) => session.sessionFile === sessionFile);
    this.sessionFile = sessionFile;
    this.sessionId = target?.sessionId ?? `fixture-resume-${this.sessionMutationCalls.switch}`;
    this.sessionName = target?.name;
    this.emit({ type: "dock_session_replaced", reason: "resume", previousSessionFile, sessionFile, cwd: target?.cwd ?? "/fixture/cwd", name: this.sessionName });
    return { cancelled: false };
  }

  async fork(_operationId: string, entryId: string, position: "before" | "at", kind: "fork" | "clone"): Promise<{ cancelled: boolean; selectedText?: string }> {
    this.sessionMutationCalls[kind] += 1;
    const target = this.treeNodes.find((node) => node.entryId === entryId);
    if (!target || (position === "before" && target.role !== "user")) throw new Error("Invalid fixture fork entry");
    if (kind === "clone" && this.treeLeafId !== entryId) throw new Error("Clone entry must be the current session leaf");
    const previousSessionFile = this.sessionFile;
    this.sessionId = `fixture-${kind}-${this.sessionMutationCalls[kind]}`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
    this.treeLeafId = position === "before" ? target.parentId : entryId;
    this.emit({ type: "dock_session_replaced", reason: "fork", previousSessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
    return { cancelled: false, ...(position === "before" ? { selectedText: target.summary } : {}) };
  }

  setSessionName(name: string): string | undefined {
    this.sessionMutationCalls.name += 1;
    const actual = name.trim() || undefined;
    this.sessionName = actual;
    this.emit({ type: "session_info_changed", name: actual });
    return actual;
  }

  async compact(): Promise<AgentCompactionResult> {
    this.sessionMutationCalls.compact += 1;
    if (this.isStreaming) this.settle("aborted for compaction", "aborted");
    const startBlock = this.nextCompactionStartBlock;
    this.nextCompactionStartBlock = undefined;
    if (startBlock) {
      startBlock.entered.resolve();
      await startBlock.release.promise;
    }
    this.isCompacting = true;
    this.emit({ type: "compaction_start", reason: "manual" });
    const block = this.nextCompactionBlock;
    this.nextCompactionBlock = undefined;
    if (block) {
      this.activeCompactionBlock = block;
      block.entered.resolve();
      try { return await block.result.promise; }
      finally { if (this.activeCompactionBlock === block) this.activeCompactionBlock = undefined; }
    }
    const result = { summary: "fixture summary", firstKeptEntryId: "kept-1", tokensBefore: 123 };
    this.isCompacting = false;
    this.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
    if (this.sessionMutationError) throw this.sessionMutationError;
    return result;
  }

  blockNextCompactionStart(): { entered: Promise<void>; release: () => void } {
    if (this.nextCompactionStartBlock) throw new Error("Fixture compaction start is already blocked");
    const block = { entered: new Deferred<void>(), release: new Deferred<void>() };
    this.nextCompactionStartBlock = block;
    return { entered: block.entered.promise, release: () => block.release.resolve() };
  }

  blockNextCompaction(): { entered: Promise<void>; finish: (result?: AgentCompactionResult) => void } {
    if (this.nextCompactionBlock || this.activeCompactionBlock) throw new Error("Fixture compaction is already blocked");
    const block = { entered: new Deferred<void>(), result: new Deferred<AgentCompactionResult>() };
    this.nextCompactionBlock = block;
    return {
      entered: block.entered.promise,
      finish: (result = { summary: "fixture summary", firstKeptEntryId: "kept-1", tokensBefore: 123 }) => {
        if (this.activeCompactionBlock === block) {
          this.isCompacting = false;
          this.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
        }
        block.result.resolve(result);
      },
    };
  }

  async reload(): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.reload += 1;
    this.emit({ type: "dock_session_replaced", reason: "reload", previousSessionFile: this.sessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
    return { cancelled: false };
  }

  blockNextNavigation(): { entered: Promise<void>; finish: (result?: AgentNavigateResult) => void } {
    if (this.nextNavigationBlock || this.activeNavigationBlock) throw new Error("Fixture navigation is already blocked");
    const block = { entered: new Deferred<void>(), result: new Deferred<AgentNavigateResult>() };
    this.nextNavigationBlock = block;
    return {
      entered: block.entered.promise,
      finish: (result = { cancelled: false, summaryCreated: false }) => block.result.resolve(result),
    };
  }

  blockNextModelMutation(): { entered: Promise<void>; release: () => void } {
    const block = { entered: new Deferred<void>(), release: new Deferred<void>() };
    this.modelMutationBlock = block;
    return { entered: block.entered.promise, release: () => block.release.resolve() };
  }

  async selectModel(provider: string, modelId: string): Promise<AgentModelState> {
    this.modelMutationCalls += 1;
    this.modelState = { ...this.modelState, model: { provider, id: modelId } };
    const block = this.modelMutationBlock;
    this.modelMutationBlock = undefined;
    if (block) {
      block.entered.resolve();
      await block.release.promise;
    }
    this.throwSettingsFailure("model");
    return this.getModelState();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<AgentModelState> {
    this.thinkingMutationCalls += 1;
    this.modelState = { ...this.modelState, thinkingLevel: level };
    this.throwSettingsFailure("thinking");
    return this.getModelState();
  }

  getModelState(): AgentModelState {
    return {
      ...this.modelState,
      model: this.modelState.model ? { ...this.modelState.model } : undefined,
      availableThinkingLevels: [...this.modelState.availableThinkingLevels],
    };
  }

  getMetrics(): AgentSessionMetrics { return structuredClone(this.metrics); }

  clearQueue(): ClearedAgentQueue {
    this.clearQueueCalls += 1;
    const cleared = {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    };
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.emitQueue();
    return cleared;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortError) throw this.abortError;
    if (this.activeNavigationBlock) {
      this.activeNavigationBlock.result.resolve({ cancelled: true, aborted: true, summaryCreated: false });
      return;
    }
    if (this.isCompacting) {
      this.isCompacting = false;
      this.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
      const block = this.activeCompactionBlock;
      this.activeCompactionBlock = undefined;
      block?.result.reject(new Error("Compaction cancelled"));
      return;
    }
    if (this.isStreaming) this.settle("aborted", "aborted");
  }

  async waitForIdle(): Promise<void> {
    await this.currentRun?.promise;
  }

  becomeIdleBeforeHostSettlement(): void {
    const run = this.currentRun;
    this.currentRun = undefined;
    this.isStreaming = false;
    run?.resolve();
  }

  blockNextPromptBeforePreflight(): { entered: Promise<void>; release: () => void } {
    const block = { entered: new Deferred<void>(), release: new Deferred<void>() };
    this.nextPromptPreflightBlock = block;
    return { entered: block.entered.promise, release: () => block.release.resolve() };
  }

  blockDispose(): { entered: Promise<void>; release: () => void } {
    const block = { entered: new Deferred<void>(), release: new Deferred<void>() };
    this.disposeBlock = block;
    return { entered: block.entered.promise, release: () => block.release.resolve() };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    const block = this.disposeBlock;
    if (block) {
      block.entered.resolve();
      await block.release.promise;
    }
    if (this.disposeError) throw this.disposeError;
  }

  drainNextQueuedWithoutMessageStart(): string | undefined {
    const text = this.steeringQueue.shift() ?? this.followUpQueue.shift();
    if (text === undefined) return undefined;
    this.emitQueue();
    return text;
  }

  finishDrainedQueued(text: string): void {
    this.emitUserMessage(text);
  }

  consumeNextQueued(): string | undefined {
    const text = this.drainNextQueuedWithoutMessageStart();
    if (text === undefined) return undefined;
    this.finishDrainedQueued(text);
    return text;
  }

  settle(text = "done", stopReason = "stop"): void {
    if (!this.currentRun || !this.isStreaming) return;
    const run = this.currentRun;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
      },
    });
    this.isStreaming = false;
    this.emit({ type: "agent_end", messages: [], willRetry: false });
    const continuation = this.postSettlementContinuation;
    this.postSettlementContinuation = undefined;
    if (continuation) {
      // Pi awaits extension agent_settled handlers before publishing its
      // AgentSession agent_settled event. ctx.compact() launches an async task;
      // its already-idle abort can resume and emit compaction_start first.
      this.isCompacting = true;
      this.emit({ type: "compaction_start", reason: "manual" });
      continuation.compactionStarted.resolve();
    }
    this.emit({ type: "agent_settled" });
    run.resolve();
    if (continuation) {
      void (async () => {
        await continuation.finishCompaction.promise;
        this.isCompacting = false;
        this.emit({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "guard summary", firstKeptEntryId: "kept", tokensBefore: 252_531 },
          aborted: false,
          willRetry: false,
        });
        await Promise.resolve();
        this.isStreaming = true;
        this.emit({ type: "agent_start" });
        const hidden = {
          role: "custom",
          customType: "sol-mid-turn-guard",
          content: "hidden continuation",
          display: false,
        };
        this.emit({ type: "message_start", message: hidden });
        this.emit({ type: "message_end", message: hidden });
        this.emit({
          type: "tool_execution_start",
          toolCallId: continuation.toolCallId,
          toolName: continuation.toolName,
          args: { path: "src/offline.ts" },
        });
        continuation.continuationStarted.resolve();
      })();
    }
  }

  armPostSettlementContinuation(options: { toolCallId?: string; toolName?: string } = {}): {
    compactionStarted: Promise<void>;
    finishCompaction: () => void;
    continuationStarted: Promise<void>;
  } {
    if (this.postSettlementContinuation) throw new Error("A post-settlement continuation is already armed");
    const continuation = {
      compactionStarted: new Deferred<void>(),
      finishCompaction: new Deferred<void>(),
      continuationStarted: new Deferred<void>(),
      toolCallId: options.toolCallId ?? "offline-tool",
      toolName: options.toolName ?? "read",
    };
    this.postSettlementContinuation = continuation;
    return {
      compactionStarted: continuation.compactionStarted.promise,
      finishCompaction: () => continuation.finishCompaction.resolve(),
      continuationStarted: continuation.continuationStarted.promise,
    };
  }

  emit(event: AgentEvent): void {
    const projectedEvents = this.projectConversationEvents(event).map((projected) => (
      projected.type === "conversation_checkpoint" && !Array.isArray(projected.history)
        ? { ...projected, history: this.getHistory() }
        : projected
    ));
    for (const projected of projectedEvents) {
      for (const listener of this.listeners) listener(projected);
    }
    if (event.type === "message_end" && event.message !== null && typeof event.message === "object" && !Array.isArray(event.message)) {
      const message = event.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "system";
      if (role === "user" || role === "assistant" || role === "toolResult" || role === "custom") {
        const parentId = this.history.at(-1)?.entryId;
        const entryId = `fixture-entry-${++this.historyEntrySequence}`;
        this.history.push({
          recordId: entryId,
          entryId,
          ...(parentId === undefined ? {} : { parentId }),
          timestamp: new Date().toISOString(),
          kind: role === "custom" ? "custom_message" : "message",
          source: role === "toolResult" ? "tool" : role === "custom" ? "extension" : role,
          visibility: role === "custom" && message.display === false ? "hidden" : "conversation",
          content: projectFixtureMessageContent(message),
          ...(role === "custom" && typeof message.customType === "string" ? { customType: message.customType } : {}),
          ...(role === "custom" && typeof message.display === "boolean" ? { display: message.display } : {}),
          ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
          ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
          ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
          ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
          ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
          ...(role !== "user" || this.conversationLastUserAttachments === undefined ? {} : { attachments: structuredClone(this.conversationLastUserAttachments) }),
        });
        if (role === "user") this.conversationLastUserAttachments = undefined;
      }
    }
    if (event.type === "turn_end" || event.type === "agent_settled" || event.type === "compaction_end" || event.type === "entry_appended") {
      this.emit({ type: "conversation_checkpoint" });
    }
  }

  private projectConversationEvents(event: AgentEvent): AgentEvent[] {
    if (event.type === "conversation_checkpoint" || event.type === "dock_conversation_frame" || event.type === "dock_queue_consumed") return [event];
    if (event.type === "agent_start") {
      this.conversationUserMessageId = undefined;
      this.conversationUserAttachments = undefined;
      this.conversationAssistantMessageId = undefined;
      this.conversationToolCalls.clear();
      this.conversationCompletedToolCalls.clear();
      this.conversationOutcome = undefined;
      return [event];
    }
    if (event.type === "agent_settled") {
      const outcome = this.conversationOutcome;
      this.conversationOutcome = undefined;
      return [{ type: "agent_settled", ...outcome }];
    }
    const message = event.message !== null && typeof event.message === "object" && !Array.isArray(event.message)
      ? event.message as Record<string, unknown>
      : undefined;
    if (event.type === "message_start") {
      if (message?.role === "assistant") this.fixtureAssistantMessageId();
      if (message?.role !== "user") return [];
      const text = fixtureMessageText(message.content);
      const inputIndex = this.conversationInputs.findIndex((candidate) => candidate.text === text);
      const input = inputIndex < 0 ? undefined : this.conversationInputs.splice(inputIndex, 1)[0];
      const operationId = input?.operationId ?? "runtime-initiated";
      this.conversationUserMessageId = input === undefined ? `fixture-user-${++this.conversationMessageSequence}` : `user-${operationId}`;
      this.conversationUserAttachments = structuredClone(input?.attachments);
      return [
        ...(input?.fromQueue === true ? [{ type: "dock_queue_consumed", operationId }] : []),
        fixtureFrame({ type: "message.submitted", data: {
          operationId,
          messageId: this.conversationUserMessageId,
          role: "user",
          text: text || input?.text || "",
          ...(input?.images === undefined ? {} : { images: structuredClone(input.images) }),
          ...(input?.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
          delivery: input?.delivery ?? "prompt",
        } }),
      ];
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent !== null && typeof event.assistantMessageEvent === "object" && !Array.isArray(event.assistantMessageEvent)
        ? event.assistantMessageEvent as Record<string, unknown>
        : undefined;
      if (!update) return [];
      if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string") {
        return [fixtureFrame({ type: "message.delta", data: {
          messageId: this.fixtureAssistantMessageId(),
          block: update.type === "text_delta" ? "text" : "thinking",
          delta: update.delta,
        } })];
      }
      if (update.type !== "toolcall_start" && update.type !== "toolcall_delta" && update.type !== "toolcall_end") return [];
      const partial = update.partial !== null && typeof update.partial === "object" && !Array.isArray(update.partial)
        ? update.partial as Record<string, unknown>
        : undefined;
      const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
      const content = Array.isArray(partial?.content) ? partial.content : [];
      const partialCall = content[index] !== null && typeof content[index] === "object" && !Array.isArray(content[index])
        ? content[index] as Record<string, unknown>
        : undefined;
      const finalCall = update.toolCall !== null && typeof update.toolCall === "object" && !Array.isArray(update.toolCall)
        ? update.toolCall as Record<string, unknown>
        : undefined;
      const call = finalCall ?? partialCall;
      if (typeof call?.id !== "string") return [];
      const args = fixtureJsonObject(call.arguments);
      if (!this.conversationToolCalls.has(call.id)) {
        this.conversationToolCalls.add(call.id);
        return [fixtureFrame({ type: "tool.started", data: { toolCallId: call.id, toolName: typeof call.name === "string" ? call.name : "tool", args } })];
      }
      return [fixtureFrame({ type: "tool.args_updated", data: { toolCallId: call.id, args } })];
    }
    if (event.type === "message_end" && message) {
      const role = typeof message.role === "string" ? message.role : "system";
      if (role === "toolResult" && this.conversationCompletedToolCalls.delete(String(message.toolCallId ?? "unknown"))) return [];
      const messageId = role === "assistant" ? this.fixtureAssistantMessageId()
        : role === "user" ? this.conversationUserMessageId ?? `fixture-user-${++this.conversationMessageSequence}`
          : role === "toolResult" ? `tool-result-${String(message.toolCallId ?? "unknown")}`
            : `fixture-message-${++this.conversationMessageSequence}`;
      if (role === "assistant") this.conversationOutcome = {
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      };
      const projected = fixtureFrame({ type: "message.completed", data: {
        messageId,
        role: role === "assistant" || role === "user" ? role : role === "toolResult" ? "tool" : "system",
        content: projectFixtureMessageContent(message),
        ...(role !== "user" || this.conversationUserAttachments === undefined ? {} : { attachments: structuredClone(this.conversationUserAttachments) }),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      } });
      if (role === "assistant") this.conversationAssistantMessageId = undefined;
      if (role === "user") {
        this.conversationLastUserAttachments = this.conversationUserAttachments;
        this.conversationUserAttachments = undefined;
        this.conversationUserMessageId = undefined;
      }
      return [projected];
    }
    if (event.type === "tool_execution_start") {
      const toolCallId = String(event.toolCallId ?? "unknown");
      const toolName = String(event.toolName ?? "tool");
      const args = fixtureJsonObject(event.args);
      if (this.conversationToolCalls.has(toolCallId)) return [fixtureFrame({ type: "tool.args_updated", data: { toolCallId, args } })];
      this.conversationToolCalls.add(toolCallId);
      return [fixtureFrame({ type: "tool.started", data: { toolCallId, toolName, args } })];
    }
    if (event.type === "tool_execution_update") {
      const toolCallId = String(event.toolCallId ?? "unknown");
      const toolName = String(event.toolName ?? "tool");
      const result = event.partialResult !== null && typeof event.partialResult === "object" && !Array.isArray(event.partialResult)
        ? event.partialResult as Record<string, unknown>
        : undefined;
      const frames: AgentEvent[] = [];
      if (!this.conversationToolCalls.has(toolCallId)) {
        this.conversationToolCalls.add(toolCallId);
        frames.push(fixtureFrame({ type: "tool.started", data: { toolCallId, toolName, args: {} } }));
      }
      frames.push(fixtureFrame({ type: "tool.output_updated", data: {
        toolCallId,
        text: fixtureMessageText(result?.content),
        ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
      } }));
      return frames;
    }
    if (event.type === "tool_execution_end") {
      const toolCallId = String(event.toolCallId ?? "unknown");
      const toolName = String(event.toolName ?? "tool");
      const result = event.result !== null && typeof event.result === "object" && !Array.isArray(event.result)
        ? event.result as Record<string, unknown>
        : undefined;
      this.conversationToolCalls.delete(toolCallId);
      this.conversationCompletedToolCalls.add(toolCallId);
      return [fixtureFrame({ type: "tool.completed", data: {
        toolCallId,
        toolName,
        text: fixtureMessageText(result?.content),
        isError: event.isError === true,
        ...(result?.presentation === undefined ? {} : { presentation: result.presentation as never }),
      } })];
    }
    return [event];
  }

  private fixtureAssistantMessageId(): string {
    this.conversationAssistantMessageId ??= `fixture-assistant-${++this.conversationMessageSequence}`;
    return this.conversationAssistantMessageId;
  }

  private emitQueue(): void {
    this.emit({
      type: "queue_update",
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    });
  }

  private emitUserMessage(text: string): void {
    const message = { role: "user", content: [{ type: "text", text }] };
    this.emit({ type: "message_start", message });
    this.emit({ type: "message_end", message });
  }

  private throwSettingsFailure(setting: import("../../src/core/config-projection.js").SettingKey | "model" | "thinking"): void {
    if (!this.settingsFailure) return;
    throw new AgentSettingsWriteError(
      setting,
      "write",
      true,
      [{ scope: "global", message: this.settingsFailure.message }],
    );
  }
}

function fixtureFrame(frame: ConversationFrame): AgentEvent {
  return { type: "dock_conversation_frame", frame };
}

function fixtureMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => (
    item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "text"
      ? [String((item as Record<string, unknown>).text ?? "")]
      : []
  )).join("");
}

function fixtureJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64_000) return {};
    return structuredClone(value) as JsonObject;
  } catch {
    return {};
  }
}

function projectFixtureMessageContent(message: Record<string, unknown>): AgentHistoryEntry["content"] {
  const items = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  if (message.role === "toolResult") {
    const text = items.flatMap((item) => (
      item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "text"
        ? [String((item as Record<string, unknown>).text ?? "")]
        : []
    )).join("");
    return [{
      type: "tool_result",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "fixture-tool",
      toolName: typeof message.toolName === "string" ? message.toolName : "tool",
      text,
      isError: message.isError === true,
    }];
  }
  return items.flatMap((item): AgentHistoryEntry["content"] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking" && typeof block.thinking === "string") return [{ type: "thinking", text: block.thinking }];
    if (block.type === "image") return [{ type: "image", mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/unknown" }];
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      const args = fixtureJsonObject(block.arguments);
      return [{ type: "tool_call", toolCallId: block.id, toolName: block.name, args }];
    }
    return [];
  });
}
