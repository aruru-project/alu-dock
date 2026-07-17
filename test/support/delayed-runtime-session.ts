import type {
  ClearedRuntimeQueue,
  RuntimeCompactionResult,
  RuntimeEvent,
  RuntimeHistoryEntry,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimeNavigateOptions,
  RuntimeNavigateResult,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeSessionMetrics,
  RuntimeThinkingLevel,
  RuntimeTreeNode,
  RuntimeTreeSnapshot,
} from "../../src/core/runtime-session.js";
import { RuntimeSettingsWriteError } from "../../src/core/runtime-session.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingUpdate, SettingValueMap, ToolDto } from "../../src/core/config-projection.js";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../../src/core/config-projection.js";

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
export class DelayedRuntimeSession implements RuntimeSession {
  sessionId: string;
  sessionFile: string;
  isStreaming = false;
  isCompacting = false;
  readonly extensionCommands = new Set<string>();
  sessionMutationCalls = { new: 0, switch: 0, name: 0, compact: 0, reload: 0, navigate: 0, fork: 0, clone: 0 };
  sessionName: string | undefined;
  abortCalls = 0;
  clearQueueCalls = 0;
  abortError: Error | undefined;
  disposeCalls = 0;
  promptCalls = 0;
  promptMessages: string[] = [];
  modelMutationCalls = 0;
  thinkingMutationCalls = 0;
  toolMutationCalls = 0;
  settingMutationCalls = 0;
  settingsFailure: Error | undefined;
  settingsReadFailure: Error | undefined;
  sessionMutationError: Error | undefined;
  sessionCatalog: RuntimeSessionInfo[] = [];
  history: RuntimeHistoryEntry[] = [];
  treeNodes: RuntimeTreeNode[] = [];
  treeLeafId: string | undefined;
  treeReadCalls = 0;
  navigationResult: RuntimeNavigateResult | undefined;
  metrics: RuntimeSessionMetrics = {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };

  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private currentRun: Deferred<void> | undefined;
  private disposeBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private modelMutationBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private nextCompactionStartBlock: { entered: Deferred<void>; release: Deferred<void> } | undefined;
  private nextCompactionBlock: { entered: Deferred<void>; result: Deferred<RuntimeCompactionResult> } | undefined;
  private activeCompactionBlock: { entered: Deferred<void>; result: Deferred<RuntimeCompactionResult> } | undefined;
  private nextNavigationBlock: { entered: Deferred<void>; result: Deferred<RuntimeNavigateResult> } | undefined;
  private activeNavigationBlock: { entered: Deferred<void>; result: Deferred<RuntimeNavigateResult> } | undefined;
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
  private modelState: RuntimeModelState = {
    model: { provider: "fixture", id: "default" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "low", "high"],
  };

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.sessionFile = `/tmp/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  classifyInput(text: string): "extension_command" | "prompt" {
    if (!text.startsWith("/")) return "prompt";
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return this.extensionCommands.has(commandName) ? "extension_command" : "prompt";
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    this.promptCalls += 1;
    this.promptMessages.push(text);
    if (this.classifyInput(text) === "extension_command") {
      options?.preflightResult?.(true);
      return Promise.resolve();
    }
    if (this.isStreaming && options?.streamingBehavior) {
      if (options.streamingBehavior === "steer") this.steeringQueue.push(text);
      else this.followUpQueue.push(text);
      this.emitQueue();
      options.preflightResult?.(true);
      return Promise.resolve();
    }
    if (this.isStreaming) return Promise.reject(new Error("fake runtime already streaming"));

    options?.preflightResult?.(true);
    this.currentRun = new Deferred<void>();
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    this.emitUserMessage(text);
    return this.currentRun.promise;
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return [
      { provider: "fixture", id: "default", name: "Fixture Default", reasoning: true },
      { provider: "fixture", id: "local", name: "Fixture Local", reasoning: true },
    ];
  }

  async listSessions(scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]> {
    return this.sessionCatalog
      .filter((session) => scope === "all" || session.cwd === "/fixture/cwd")
      .map((session) => ({ ...session }));
  }

  getHistory(): RuntimeHistoryEntry[] { return structuredClone(this.history); }

  getTree(): RuntimeTreeSnapshot {
    this.treeReadCalls += 1;
    return {
      nodes: structuredClone(this.treeNodes),
      ...(this.treeLeafId === undefined ? {} : { leafId: this.treeLeafId }),
    };
  }

  async navigateTree(targetId: string, _options: RuntimeNavigateOptions = {}): Promise<RuntimeNavigateResult> {
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
      { name: "chain", description: "chain command", source, argumentCompletions: true },
      { name: "chain-prompts", description: "chain prompts command", source, argumentCompletions: false },
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

  async compact(): Promise<RuntimeCompactionResult> {
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

  blockNextCompaction(): { entered: Promise<void>; finish: (result?: RuntimeCompactionResult) => void } {
    if (this.nextCompactionBlock || this.activeCompactionBlock) throw new Error("Fixture compaction is already blocked");
    const block = { entered: new Deferred<void>(), result: new Deferred<RuntimeCompactionResult>() };
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

  blockNextNavigation(): { entered: Promise<void>; finish: (result?: RuntimeNavigateResult) => void } {
    if (this.nextNavigationBlock || this.activeNavigationBlock) throw new Error("Fixture navigation is already blocked");
    const block = { entered: new Deferred<void>(), result: new Deferred<RuntimeNavigateResult>() };
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

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
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

  async setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> {
    this.thinkingMutationCalls += 1;
    this.modelState = { ...this.modelState, thinkingLevel: level };
    this.throwSettingsFailure("thinking");
    return this.getModelState();
  }

  getModelState(): RuntimeModelState {
    return {
      ...this.modelState,
      model: this.modelState.model ? { ...this.modelState.model } : undefined,
      availableThinkingLevels: [...this.modelState.availableThinkingLevels],
    };
  }

  getMetrics(): RuntimeSessionMetrics { return structuredClone(this.metrics); }

  clearQueue(): ClearedRuntimeQueue {
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
    this.emit({ type: "agent_settled" });
    run.resolve();
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
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
    throw new RuntimeSettingsWriteError(
      setting,
      "write",
      true,
      [{ scope: "global", message: this.settingsFailure.message }],
    );
  }
}
