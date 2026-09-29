import type {
  ClearedAgentQueue,
  AgentCleanupResult,
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
} from "../../src/core/agent-worker.js";
import { AgentConversationCursorError, AgentInvalidDeliveryModeError, AgentInvalidTreeTargetError, AgentQueueRejectedBeforeEffectError, AgentSettingsWriteError } from "../../src/core/agent-worker.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingUpdate, SettingValueMap, ToolDto } from "../../src/core/config-projection.js";
// SETTING_DEFINITIONS/SETTING_KEYS are the frozen Dock protocol setting schema (protocol.ts imports the
// same constants and the client parser rejects any worker that omits a canonical key), not Pi internals.
// Nothing else from src may be imported here: this fake must not reuse production algorithms or
// projections, or tests stop proving anything about the real adapter.
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../../src/core/config-projection.js";
import type { AttachmentDto, ConversationFrame, ConversationImageBody, ImagePathDto, TreeNodeDto } from "../../src/core/instance-dto.js";
import type { SessionTreeResult } from "../../src/control/protocol.js";

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
  clearQueueError: Error | undefined;
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
  readonly conversationImages = new Map<string, ConversationImageBody>();
  publishedFileSource?: (fileRef: string) => unknown;
  resourceFileSource?: (ref: string) => unknown;
  treeNodes: TreeNodeDto[] = [];
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
  private conversationMessageSequence = 0;
  private conversationAssistantMessageId: string | undefined;
  private historyEntrySequence = 0;
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private currentRun: Deferred<void> | undefined;
  private currentRunOperationId: string | undefined;
  private manualCompactionOperationId: string | undefined;
  private nextPromptPreflightBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private nextTreeReadBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
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
        const inputKind = this.classifyInput(p.message);
        const attachments = options?.context !== undefined && options.context.type !== "session_switch"
          ? options.context.attachments
          : undefined;
        if (inputKind === "extension_command" && ((p.images?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0)) {
          options?.preflightResult?.({ success: false });
          throw new Error("Registered extension commands do not accept attachments");
        }
        if (inputKind === "extension_command") {
          options?.preflightResult?.({ success: true, inputKind, delivery: "prompt", custody: "runtime" });
          return this.prompt(p.message, undefined, p.operationId);
        }
        const admissionRunning = options?.context?.type === "defer_to_host" || this.isStreaming;
        const delivery = requestedDelivery === "auto" ? (admissionRunning ? "steer" : "prompt") : requestedDelivery;
        const validatesRequestedDelivery = options?.context?.type !== "force_queue" && options?.context?.type !== "host_queue";
        const invalidDelivery = validatesRequestedDelivery && (
          (admissionRunning && delivery === "prompt")
          || (!admissionRunning && delivery !== "prompt")
        );
        if (invalidDelivery) {
          options?.preflightResult?.({ success: false });
          throw new AgentInvalidDeliveryModeError(delivery, admissionRunning);
        }
        const queueAvailable = options?.context?.type === "command" || options?.context?.type === "defer_to_host"
          ? options.context.queueAvailable
          : true;
        if (validatesRequestedDelivery && delivery !== "prompt" && !queueAvailable) {
          options?.preflightResult?.({ success: false });
          throw new AgentQueueRejectedBeforeEffectError();
        }
        if (options?.context?.type === "defer_to_host") {
          if (delivery === "prompt") throw new Error("Host-deferred input requires queued delivery");
          options.preflightResult?.({ success: true, inputKind, delivery, custody: "host" });
          return;
        }
        const tracked = {
          operationId: p.operationId as string,
          text: p.message as string,
          delivery,
          fromQueue: options?.context?.type === "force_queue" || options?.context?.type === "host_queue",
          ...(p.images === undefined ? {} : { images: structuredClone(p.images) }),
          ...(options?.context !== undefined && options.context.type !== "session_switch" && options.context.attachments !== undefined
            ? { attachments: structuredClone(options.context.attachments) }
            : {}),
        };
        this.conversationInputs.push(tracked);
        return options?.context?.type === "force_queue"
          ? this.queueMessage(p.message, delivery === "prompt" ? "followUp" : delivery)
          : this.prompt(p.message, {
            ...(delivery === "prompt" ? {} : { streamingBehavior: delivery }),
            ...(p.images === undefined ? {} : { images: p.images }),
            preflightResult: (success: boolean) => {
              if (!success) {
                options?.preflightResult?.({ success: false });
                return;
              }
              const actualDelivery = this.isStreaming ? delivery : "prompt";
              tracked.delivery = actualDelivery;
              tracked.fromQueue ||= actualDelivery !== "prompt";
              options?.preflightResult?.({ success: true, inputKind, delivery: actualDelivery, custody: "runtime" });
            },
          }, p.operationId);
      }
      case "command.abort": return this.abort();
      case "queue.dequeue": return this.clearQueue();
      case "command.abort_restore_queue": { const cleared = this.clearQueue(); await this.abort(); return cleared; }
      case "model.list": return this.listModels();
      case "model.set": return this.selectModel(p.provider, p.modelId);
      case "thinking.set": return this.setThinkingLevel(p.level);
      case "tool.list": return this.listTools();
      case "tool.set_active": return this.setActiveTools(p.names);
      case "settings.get": return this.getSettings();
      case "settings.update": return this.updateSetting(p.update);
      case "resource.get": return this.getResources();
      case "command.catalog": return this.getCommands(p.prefix);
      case "command.content": return { command: p.command, available: false };
      case "command.complete": return { command: p.command, items: null, total: 0, truncated: false };
      case "session.history": await Promise.resolve(); return this.getHistory();
      case "conversation.history": return this.getConversationHistory(p.cursor, p.limit);
      case "conversation.content": return this.getConversationContent(p.contentRef, p.cursor);
      case "conversation.image": return this.getConversationImage(p.contentRef);
      case "session.list": return this.listSessions(p.scope);
      case "session.switch": return this.switchSession(p.operationId, p.sessionFile);
      case "session.new": return this.newSession(p.operationId, p.parentSession);
      case "session.name": return this.setSessionName(p.operationId, p.name);
      case "session.compact": return this.compact(p.operationId);
      case "session.reload": return this.reload(p.operationId);
      case "session.tree": return this.getTree();
      case "session.navigate": return this.navigateTree(p.targetId, p);
      case "session.fork": return this.fork(p.operationId, p.entryId, "before", "fork");
      case "session.clone": return this.fork(p.operationId, p.entryId, "at", "clone");
    }
  }

  control(request: AgentWorkerControl): Promise<unknown> {
    if (request.type === "resolve_file_source") {
      if (request.kind === "resource" && this.resourceFileSource) return Promise.resolve(this.resourceFileSource(request.ref));
      if (request.kind !== "published" || this.publishedFileSource === undefined) return Promise.reject(new Error("File sources are unavailable in this fixture"));
      return Promise.resolve().then(() => this.publishedFileSource!(request.ref));
    }
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

  async prompt(text: string, options?: AgentPromptOptions, operationId?: string): Promise<void> {
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
    this.currentRunOperationId = operationId;
    this.isStreaming = true;
    this.startConversationTurn();
    this.emit({ type: "agent_start", ...(operationId === undefined ? {} : { operationId }) });
    this.emitUserMessage(text);
    await this.currentRun.promise;
  }

  queueMessage(text: string, delivery: "steer" | "followUp"): Promise<void> {
    if (delivery === "steer") this.steeringQueue.push(text);
    else this.followUpQueue.push(text);
    this.emitQueue();
    return Promise.resolve();
  }

  async listModels(): Promise<{ models: AgentModelInfo[]; availableThinkingLevels: string[]; total: number; truncated: boolean }> {
    const models = [
      { provider: "fixture", id: "default", name: "Fixture Default", reasoning: true },
      { provider: "fixture", id: "local", name: "Fixture Local", reasoning: true },
    ];
    return { models, availableThinkingLevels: ["off", "low", "high"], total: models.length, truncated: false };
  }

  async listSessions(scope: "cwd" | "all"): Promise<{ sessions: AgentSessionInfo[]; total: number; truncated: boolean }> {
    const sessions = this.sessionCatalog
      .filter((session) => scope === "all" || session.cwd === "/fixture/cwd")
      .map((session) => ({ ...session }));
    return { sessions, total: sessions.length, truncated: false };
  }

  getHistory(): AgentHistoryEntry[] { return structuredClone(this.history); }

  async getConversationHistory(cursor?: string, limit = 50): Promise<AgentConversationHistoryPage> {
    const end = cursor === undefined ? this.history.length : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(end) || end < 0 || end > this.history.length) throw new AgentConversationCursorError();
    // Deliberately naive windowing. Semantic tool-pairing is the real adapter's behavior; it is unit-tested
    // in history-pagination.test.ts and exercised against real Pi in the pi-*-real gates.
    const page = { start: Math.max(0, end - Math.max(1, Math.min(200, Math.floor(limit)))), end, hasEarlier: end - Math.max(1, Math.min(200, Math.floor(limit))) > 0 };
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

  getConversationImage(contentRef: string): ConversationImageBody {
    const image = this.conversationImages.get(contentRef);
    if (image === undefined) throw new AgentConversationCursorError("Conversation image reference is stale");
    return structuredClone(image);
  }

  async getConversationContent(contentRef: string, cursor?: string): Promise<AgentConversationContentPage> {
    const chunks = this.conversationContent.get(contentRef);
    if (!chunks) throw new AgentConversationCursorError("Conversation content reference is stale");
    const paged = Buffer.byteLength(JSON.stringify(chunks), "utf8") > 64_000;
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= chunks.length || (!paged && cursor !== undefined)) throw new AgentConversationCursorError();
    const end = paged ? offset + 1 : chunks.length;
    return {
      revision: this.conversationRevision,
      contentRef,
      chunks: structuredClone(chunks.slice(offset, end)),
      complete: end >= chunks.length,
      ...(end >= chunks.length ? {} : { nextCursor: String(end) }),
    };
  }

  blockNextTreeRead(): { entered: Promise<void>; release: () => void } {
    const block = { entered: new Deferred<void>(), release: new Deferred<void>() };
    this.nextTreeReadBlock = block;
    return { entered: block.entered.promise, release: () => block.release.resolve() };
  }

  async getTree(): Promise<SessionTreeResult> {
    this.treeReadCalls += 1;
    const block = this.nextTreeReadBlock;
    this.nextTreeReadBlock = undefined;
    if (block) {
      block.entered.resolve();
      await block.release.promise;
    }
    return {
      nodes: structuredClone(this.treeNodes),
      ...(this.treeLeafId === undefined ? {} : { leafId: this.treeLeafId }),
    };
  }

  async navigateTree(targetId: string, _options: AgentNavigateOptions = {}): Promise<AgentNavigateResult> {
    this.sessionMutationCalls.navigate += 1;
    const target = this.treeNodes.find((node) => node.entryId === targetId);
    if (!target) throw new AgentInvalidTreeTargetError(`Unknown tree entry: ${targetId}`);
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
      ...(this.treeLeafId === undefined ? {} : { leafId: this.treeLeafId }),
      summaryCreated: false,
    };
  }

  async listTools(): Promise<{ tools: ToolDto[]; total: number; truncated: boolean }> {
    const tools = ["read", "write"].map((name) => ({ name, description: `${name} fixture`, active: this.activeTools.has(name), source: { kind: "built-in" as const }, parameterSchema: { type: "object" } }));
    return { tools, total: tools.length, truncated: false };
  }

  async setActiveTools(names: string[]): Promise<{ tools: ToolDto[]; total: number; truncated: boolean }> {
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

  async getResources(): Promise<{ resources: ResourceDto[]; diagnostics: DiagnosticDto[]; resourceTotal: number; resourcesTruncated: boolean; diagnosticTotal: number; diagnosticsTruncated: boolean }> {
    return {
      resources: [{ kind: "context", name: "AGENTS.md", path: "/fixture/AGENTS.md" }],
      diagnostics: [{ severity: "warning", message: "fixture diagnostic" }],
      resourceTotal: 1, resourcesTruncated: false, diagnosticTotal: 1, diagnosticsTruncated: false,
    };
  }

  async getCommands(prefix?: string): Promise<{ commands: CommandDto[]; total: number; truncated: boolean }> {
    const source = { kind: "extension" as const, path: "/fixture/ext.ts" };
    const commands = [
      { name: "fixture-prefix", description: "prefix fixture command", source, argumentCompletions: true },
      { name: "fixture-prefix-long", description: "long prefix fixture command", source, argumentCompletions: false },
    ].filter((command) => prefix === undefined || command.name.startsWith(prefix));
    return { commands, total: commands.length, truncated: false };
  }

  async resolveSessionTarget(sessionFile: string): Promise<{ canonicalCwd: string }> {
    return { canonicalCwd: this.sessionCatalog.find((session) => session.sessionFile === sessionFile)?.cwd ?? "/fixture/cwd" };
  }

  async newSession(operationId: string, _parentSession?: string): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.new += 1;
    const previousSessionFile = this.sessionFile;
    this.sessionId = `fixture-new-${this.sessionMutationCalls.new}`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
    this.sessionName = undefined;
    this.history = [];
    this.emit({ type: "dock_session_replaced", operationId, reason: "new", previousSessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
    return { cancelled: false };
  }

  async switchSession(operationId: string, sessionFile: string): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.switch += 1;
    const previousSessionFile = this.sessionFile;
    const target = this.sessionCatalog.find((session) => session.sessionFile === sessionFile);
    this.sessionFile = sessionFile;
    this.sessionId = target?.sessionId ?? `fixture-resume-${this.sessionMutationCalls.switch}`;
    this.sessionName = target?.name;
    this.emit({ type: "dock_session_replaced", operationId, reason: "resume", previousSessionFile, sessionFile, cwd: target?.cwd ?? "/fixture/cwd", name: this.sessionName });
    return { cancelled: false };
  }

  async fork(operationId: string, entryId: string, position: "before" | "at", kind: "fork" | "clone"): Promise<{ cancelled: boolean; selectedText?: string }> {
    this.sessionMutationCalls[kind] += 1;
    const target = this.treeNodes.find((node) => node.entryId === entryId);
    if (!target || (position === "before" && target.role !== "user")) throw new AgentInvalidTreeTargetError("Invalid fixture fork entry");
    if (kind === "clone" && this.treeLeafId !== entryId) throw new AgentInvalidTreeTargetError("Clone entry must be the current session leaf");
    const previousSessionFile = this.sessionFile;
    this.sessionId = `fixture-${kind}-${this.sessionMutationCalls[kind]}`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
    this.treeLeafId = position === "before" ? target.parentId : entryId;
    this.emit({ type: "dock_session_replaced", operationId, reason: "fork", previousSessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
    return { cancelled: false, ...(position === "before" ? { selectedText: target.summary } : {}) };
  }

  setSessionName(operationId: string, name: string): string | undefined {
    this.sessionMutationCalls.name += 1;
    const actual = name.trim() || undefined;
    this.sessionName = actual;
    this.emit({ type: "session_info_changed", name: actual, operationId });
    return actual;
  }

  async compact(operationId: string): Promise<AgentCompactionResult> {
    this.sessionMutationCalls.compact += 1;
    this.manualCompactionOperationId = operationId;
    if (this.isStreaming) this.settle("aborted for compaction", "aborted");
    const startBlock = this.nextCompactionStartBlock;
    this.nextCompactionStartBlock = undefined;
    if (startBlock) {
      startBlock.entered.resolve();
      await startBlock.release.promise;
    }
    this.isCompacting = true;
    this.emit({ type: "compaction_start", reason: "manual", operationId });
    const block = this.nextCompactionBlock;
    this.nextCompactionBlock = undefined;
    if (block) {
      this.activeCompactionBlock = block;
      block.entered.resolve();
      try { return await block.result.promise; }
      finally {
        if (this.activeCompactionBlock === block) this.activeCompactionBlock = undefined;
        if (this.manualCompactionOperationId === operationId) this.manualCompactionOperationId = undefined;
      }
    }
    const result = { summary: "fixture summary", firstKeptEntryId: "kept-1", tokensBefore: 123 };
    this.isCompacting = false;
    this.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false, operationId });
    this.emit({ type: "conversation_checkpoint", history: this.getHistory() });
    this.manualCompactionOperationId = undefined;
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
          this.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false, operationId: this.manualCompactionOperationId });
          this.emit({ type: "conversation_checkpoint", history: this.getHistory() });
        }
        block.result.resolve(result);
      },
    };
  }

  async reload(operationId: string): Promise<{ cancelled: boolean }> {
    this.sessionMutationCalls.reload += 1;
    this.emit({ type: "dock_session_replaced", operationId, reason: "reload", previousSessionFile: this.sessionFile, sessionFile: this.sessionFile, cwd: "/fixture/cwd", name: this.sessionName });
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
    if (this.clearQueueError) throw this.clearQueueError;
    const cleared = {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    };
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    for (const [delivery, texts] of [["steer", cleared.steering], ["followUp", cleared.followUp]] as const) {
      for (const text of texts) {
        const index = this.conversationInputs.findIndex((input) => input.delivery === delivery && input.text === text);
        if (index >= 0) this.conversationInputs.splice(index, 1);
      }
    }
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
      this.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false, operationId: this.manualCompactionOperationId });
      this.emit({ type: "conversation_checkpoint", history: this.getHistory() });
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

  async dispose(): Promise<AgentCleanupResult> {
    this.disposeCalls += 1;
    const cleanupErrors: string[] = [];
    if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) {
      try { this.clearQueue(); }
      catch (error) { cleanupErrors.push(`clearQueue: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.isStreaming || this.isCompacting || this.activeNavigationBlock) {
      try { await this.abort(); }
      catch (error) { cleanupErrors.push(`abort: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const block = this.disposeBlock;
    if (block) {
      block.entered.resolve();
      await block.release.promise;
    }
    if (this.disposeError) throw this.disposeError;
    if (this.currentRun) this.settle("disposed", "aborted");
    return { cleanupErrors };
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

  settle(text = "done", stopReason = "stop", error?: string): void {
    if (!this.currentRun || !this.isStreaming) return;
    const run = this.currentRun;
    const messageId = this.fixtureAssistantMessageId();
    this.emit(fixtureFrame({ type: "message.completed", data: {
      messageId,
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(error === undefined ? {} : { error }),
    } }));
    this.conversationAssistantMessageId = undefined;
    const parentId = this.history.at(-1)?.entryId;
    const entryId = `fixture-entry-${++this.historyEntrySequence}`;
    this.history.push({
      recordId: entryId,
      entryId,
      ...(parentId === undefined ? {} : { parentId }),
      timestamp: new Date().toISOString(),
      kind: "message",
      source: "assistant",
      visibility: "conversation",
      content: [{ type: "text", text }],
      stopReason,
      ...(error === undefined ? {} : { error }),
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
    this.emit({ type: "agent_settled", stopReason, ...(error === undefined ? {} : { error }), ...(this.currentRunOperationId === undefined ? {} : { operationId: this.currentRunOperationId }) });
    this.currentRunOperationId = undefined;
    this.emit({ type: "conversation_checkpoint", history: this.getHistory() });
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
        this.emit({ type: "conversation_checkpoint", history: this.getHistory() });
        await Promise.resolve();
        this.isStreaming = true;
        this.startConversationTurn();
        this.emit({ type: "agent_start" });
        const hiddenMessageId = `fixture-message-${++this.conversationMessageSequence}`;
        this.emit(fixtureFrame({ type: "message.completed", data: {
          messageId: hiddenMessageId,
          role: "system",
          content: [{ type: "text", text: "hidden continuation" }],
        } }));
        const hiddenParentId = this.history.at(-1)?.entryId;
        const hiddenEntryId = `fixture-entry-${++this.historyEntrySequence}`;
        this.history.push({
          recordId: hiddenEntryId,
          entryId: hiddenEntryId,
          ...(hiddenParentId === undefined ? {} : { parentId: hiddenParentId }),
          timestamp: new Date().toISOString(),
          kind: "custom_message",
          source: "extension",
          visibility: "hidden",
          content: [{ type: "text", text: "hidden continuation" }],
          customType: "sol-mid-turn-guard",
          display: false,
        });
        this.emit(fixtureFrame({ type: "tool.started", data: {
          toolCallId: continuation.toolCallId,
          toolName: continuation.toolName,
          args: { path: "src/offline.ts" },
        } }));
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
    const outbound = event.type === "conversation_checkpoint" && !Array.isArray(event.history)
      ? { ...event, history: this.getHistory() }
      : event;
    for (const listener of this.listeners) listener(outbound);
  }

  private startConversationTurn(): void {
    this.conversationAssistantMessageId = undefined;
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
    const inputIndex = this.conversationInputs.findIndex((candidate) => candidate.text === text);
    const input = inputIndex < 0 ? undefined : this.conversationInputs.splice(inputIndex, 1)[0];
    const operationId = input?.operationId ?? "runtime-initiated";
    const messageId = input === undefined ? `fixture-user-${++this.conversationMessageSequence}` : `user-${operationId}`;
    if (input?.fromQueue === true) this.emit({ type: "dock_queue_consumed", operationId });
    this.emit(fixtureFrame({ type: "message.submitted", data: {
      operationId,
      messageId,
      role: "user",
      text: text || input?.text || "",
      ...(input?.images === undefined ? {} : { images: structuredClone(input.images) }),
      ...(input?.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
      delivery: input?.delivery ?? "prompt",
    } }));
    this.emit(fixtureFrame({ type: "message.completed", data: {
      messageId,
      role: "user",
      content: [{ type: "text", text }],
      ...(input?.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
    } }));
    const parentId = this.history.at(-1)?.entryId;
    const entryId = `fixture-entry-${++this.historyEntrySequence}`;
    this.history.push({
      recordId: entryId,
      entryId,
      ...(parentId === undefined ? {} : { parentId }),
      timestamp: new Date().toISOString(),
      kind: "message",
      source: "user",
      visibility: "conversation",
      content: [{ type: "text", text }],
      ...(input?.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
    });
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

