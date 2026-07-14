import type {
  ClearedRuntimeQueue,
  RuntimeEvent,
  RuntimeModelInfo,
  RuntimeModelState,
  RuntimePromptOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeThinkingLevel,
} from "../../src/core/runtime-session.js";
import { RuntimeSettingsWriteError } from "../../src/core/runtime-session.js";
import type { CommandDto, DiagnosticDto, ResourceDto, SettingDto, SettingUpdate, SettingValueMap, ToolDto } from "../../src/core/config-projection.js";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../../src/core/config-projection.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/** Deterministic in-flight runtime used only by control-plane tests. */
export class DelayedRuntimeSession implements RuntimeSession {
  readonly sessionFile: string;
  isStreaming = false;
  abortCalls = 0;
  disposeCalls = 0;
  promptCalls = 0;
  modelMutationCalls = 0;
  thinkingMutationCalls = 0;
  toolMutationCalls = 0;
  settingMutationCalls = 0;
  settingsFailure: Error | undefined;
  settingsReadFailure: Error | undefined;
  sessionCatalog: RuntimeSessionInfo[] = [];

  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private currentRun: Deferred<void> | undefined;
  private activeTools = new Set(["read"]);
  private readonly settingValues: SettingValueMap = {
    autoCompaction: true, autoRetry: true, enableSkillCommands: true, hideThinking: false,
    showCacheMissNotices: false, showHardwareCursor: false, clearOnShrink: true, showTerminalProgress: true,
    quietStartup: false, steeringMode: "all", followUpMode: "all", transport: "auto",
    doubleEscapeAction: "tree", treeFilterMode: "default", defaultProjectTrust: "ask",
    httpIdleTimeoutMs: 0, editorPaddingX: 0, outputPad: 0, autocompleteMaxVisible: 10, warnings: {},
  };
  private modelState: RuntimeModelState = {
    model: { provider: "fixture", id: "default" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "low", "high"],
  };

  constructor(readonly sessionId: string) {
    this.sessionFile = `/tmp/${sessionId}.jsonl`;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    this.promptCalls += 1;
    options?.preflightResult?.(true);
    if (this.isStreaming && options?.streamingBehavior) {
      if (options.streamingBehavior === "steer") this.steeringQueue.push(text);
      else this.followUpQueue.push(text);
      this.emitQueue();
      return Promise.resolve();
    }
    if (this.isStreaming) return Promise.reject(new Error("fake runtime already streaming"));

    this.currentRun = new Deferred<void>();
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
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
    return SETTING_KEYS.map((key) => ({ key, value: structuredClone(this.settingValues[key]), source: "effective", writable: true,
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
    return [{ name: "fixture", description: "fixture command", source: { kind: "extension", path: "/fixture/ext.ts" }, argumentCompletions: false }];
  }

  async selectModel(provider: string, modelId: string): Promise<RuntimeModelState> {
    this.modelMutationCalls += 1;
    this.modelState = { ...this.modelState, model: { provider, id: modelId } };
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

  clearQueue(): ClearedRuntimeQueue {
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
    if (this.isStreaming) this.settle("aborted", "aborted");
  }

  async waitForIdle(): Promise<void> {
    await this.currentRun?.promise;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
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
