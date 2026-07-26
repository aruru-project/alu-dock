import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SettingsManager,
  type AgentSession,
  type AgentSessionServices,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

import { CatalogTransactionCoordinator } from "../src/control/catalog-transactions.js";
import { CatalogEffectUnknownError } from "../src/core/catalog.js";
import { SETTING_KEYS } from "../src/core/config-projection.js";
import { ManagedInstance, RuntimeEffectUnknownError } from "../src/core/managed-instance.js";
import {
  AgentCompactionKnownFailureError,
  AgentInvalidSettingValueError,
  AgentQueueEffectUnknownError,
  AgentQueueRejectedBeforeEffectError,
  AgentSettingsWriteError,
} from "../src/core/agent-worker.js";
import type { AgentEvent, AgentInvokeOptions, AgentRequest, AgentWorkerConnection, AgentWorkerControl, AgentWorkerState } from "../src/core/agent-worker.js";
import type { GitBranchObserverPort } from "../src/pi/git-branch-observer.js";
import {
  PiAgentAdapter,
  type PiAgentAdapterOptions,
  type PiSessionCatalog,
} from "../src/pi/pi-agent-adapter.js";
import { ScriptedCatalogCommitPort } from "./support/scripted-catalog-port.js";

function localConnection(adapter: PiAgentAdapter): AgentWorkerConnection {
  const capture = (): AgentWorkerState => {
    const durableSessionFile = adapter.getDurableSessionFile();
    return {
      sessionId: adapter.sessionId,
      ...(adapter.sessionFile === undefined ? {} : { sessionFile: adapter.sessionFile }),
      ...(durableSessionFile === undefined ? {} : { durableSessionFile }),
      isStreaming: adapter.isStreaming,
      isCompacting: adapter.isCompacting,
      ...(adapter.getGitBranch() === undefined ? {} : { gitBranch: adapter.getGitBranch() }),
      modelState: adapter.getModelState(),
      metrics: adapter.getMetrics(),
      extensionCommands: adapter.getExtensionCommandNames(),
    };
  };
  let lastState = capture();
  return {
    state(): AgentWorkerState {
      try { lastState = capture(); } catch {}
      return structuredClone(lastState);
    },
    invoke(request: AgentRequest, options?: AgentInvokeOptions): Promise<unknown> {
      return adapter.dispatch(request, options?.context, options?.preflightResult);
    },
    control(request: AgentWorkerControl): Promise<unknown> { return adapter.control(request); },
    subscribe(listener: (event: AgentEvent) => void): () => void { return adapter.subscribe(listener); },
    dispose(): Promise<void> { return adapter.dispose(); },
  };
}

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
}

class FakeSession {
  historyEntries: SessionEntry[] = [];
  treeRoots: SessionTreeNode[] = [];
  treeLeafId: string | null = null;
  readonly listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  readonly sessionManager = {
    getCwd: () => "/project",
    getSessionId: () => this.sessionId,
    getSessionDir: () => "/sessions",
    usesDefaultSessionDir: () => this.usesDefaultSessionDir,
    getBranch: () => structuredClone(this.historyEntries),
    getEntries: () => structuredClone(this.historyEntries),
    getTree: () => structuredClone(this.treeRoots),
    getLeafId: () => this.treeLeafId,
    getEntry: (entryId: string) => findTreeEntry(this.treeRoots, entryId),
    getSessionName: () => this.sessionName,
  };
  sessionName: string | undefined;
  usesDefaultSessionDir = true;
  isStreaming = false;
  isCompacting = false;
  readonly agent = {
    state: { model: undefined as FakeModel | undefined },
    transport: "auto" as "auto" | "sse" | "websocket" | "websocket-cached",
    thinkingBudgets: undefined as unknown,
    maxRetryDelayMs: undefined as number | undefined,
  };
  get model(): FakeModel | undefined { return this.agent.state.model; }
  set model(model: FakeModel | undefined) { this.agent.state.model = model; }
  scopedModels: Array<{ model: FakeModel; thinkingLevel?: "off" | "high" }> = [];
  thinkingLevel: "off" | "high" = "off";
  steeringMode: "all" | "one-at-a-time" = "all";
  followUpMode: "all" | "one-at-a-time" = "all";
  settingsManager: SettingsManager | undefined;
  bindError: Error | undefined;
  bindEvent: { type: string; [key: string]: unknown } | undefined;
  reloadError: Error | undefined;
  reloadBeforeStart: (() => void) | undefined;
  reloadEvent: { type: string; [key: string]: unknown } | undefined;
  compactError: Error | undefined;
  appendCompactionBeforeError = false;
  bindCalls = 0;
  abortCalls = 0;
  abortCompactionCalls = 0;
  abortBranchSummaryCalls = 0;
  promptCalls: Array<{ text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }> = [];
  queueCalls: Array<{ text: string; delivery: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }> = [];
  queueFailure: "before" | "after" | undefined;
  navigateCalls = 0;
  disposeCalls = 0;
  unsubscribeCalls = 0;
  toolSetCalls = 0;
  activeToolNames: string[] = [];
  stats = {
    sessionFile: "", sessionId: "", userMessages: 0, assistantMessages: 0,
    toolCalls: 0, toolResults: 0, totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextUsage: undefined as { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
  };
  allTools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    promptGuidelines?: unknown;
    sourceInfo: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string };
  }> = [];
  registeredCommands: Array<{
    invocationName: string;
    name: string;
    description?: string;
    sourceInfo: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string };
    getArgumentCompletions?: (...args: unknown[]) => unknown;
  }> = [];
  readonly extensionRunner = {
    getRegisteredCommands: () => [...this.registeredCommands],
    getCommand: (name: string) => this.registeredCommands.find((command) => command.invocationName === name),
  };

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly trace: string[],
  ) {
    this.stats.sessionFile = sessionFile;
    this.stats.sessionId = sessionId;
  }

  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
    this.trace.push(`${this.sessionId}:subscribe`);
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
      this.trace.push(`${this.sessionId}:unsubscribe`);
    };
  }

  async bindExtensions(): Promise<void> {
    this.bindCalls += 1;
    this.trace.push(`${this.sessionId}:bind`);
    if (this.bindEvent) this.emit(this.bindEvent);
    if (this.bindError) throw this.bindError;
  }

  emit(event: { type: string; [key: string]: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }

  prompt(text: string, options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> { this.promptCalls.push({ text, ...(options?.images === undefined ? {} : { images: options.images }) }); return Promise.resolve(); }
  async setModel(model: FakeModel): Promise<void> {
    this.trace.push(`${this.sessionId}:setModel`);
    this.model = model;
  }
  setThinkingLevel(level: "off" | "high"): void {
    this.trace.push(`${this.sessionId}:setThinking`);
    this.thinkingLevel = level;
  }
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.steeringMode = mode;
    this.settingsManager?.setSteeringMode(mode);
  }
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.followUpMode = mode;
    this.settingsManager?.setFollowUpMode(mode);
  }
  getAvailableThinkingLevels(): Array<"off" | "high"> { return ["off", "high"]; }
  getSessionStats(): typeof this.stats { return structuredClone(this.stats); }
  getActiveToolNames(): string[] { return [...this.activeToolNames]; }
  getAllTools(): typeof this.allTools { return [...this.allTools]; }
  setActiveToolsByName(names: string[]): void {
    this.toolSetCalls += 1;
    this.activeToolNames = [...names];
  }
  setScopedModels(models: Array<{ model: FakeModel; thinkingLevel?: "off" | "high" }>): void {
    this.scopedModels = models;
  }
  clearQueue(): { steering: string[]; followUp: string[] } { return { steering: [], followUp: [] }; }
  abort(): Promise<void> { this.abortCalls += 1; return Promise.resolve(); }
  abortCompaction(): void { this.abortCompactionCalls += 1; }
  abortBranchSummary(): void { this.abortBranchSummaryCalls += 1; }
  async steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    if (this.queueFailure === "before") throw new Error("queue validation failed");
    this.queueCalls.push({ text, delivery: "steer", ...(images === undefined ? {} : { images }) });
    if (this.queueFailure === "after") throw new Error("queue acknowledgement failed");
  }
  async followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    if (this.queueFailure === "before") throw new Error("queue validation failed");
    this.queueCalls.push({ text, delivery: "followUp", ...(images === undefined ? {} : { images }) });
    if (this.queueFailure === "after") throw new Error("queue acknowledgement failed");
  }
  getSteeringMessages(): string[] { return this.queueCalls.filter((item) => item.delivery === "steer").map((item) => item.text); }
  getFollowUpMessages(): string[] { return this.queueCalls.filter((item) => item.delivery === "followUp").map((item) => item.text); }
  finishCompaction(): void {
    this.isCompacting = false;
    this.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
  }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  setSessionName(name: string): void {
    this.sessionName = name.trim() || undefined;
    this.emit({ type: "session_info_changed", name: this.sessionName });
  }
  async compact(): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }> {
    const result = { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 321 };
    this.emit({ type: "compaction_start", reason: "manual" });
    if (this.compactError) {
      if (this.appendCompactionBeforeError) {
        this.historyEntries.push({
          type: "compaction", id: "compaction-after-effect", parentId: null, timestamp: new Date().toISOString(),
          summary: "written", firstKeptEntryId: "kept", tokensBefore: 321,
        } as SessionEntry);
      }
      this.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: `Compaction failed: ${this.compactError.message}` });
      throw this.compactError;
    }
    this.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
    return result;
  }
  async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
    this.trace.push(`${this.sessionId}:reload`);
    if (this.reloadError) throw this.reloadError;
    this.reloadBeforeStart?.();
    await options?.beforeSessionStart?.();
    if (this.reloadEvent) this.emit(this.reloadEvent);
  }
  async navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string; summaryEntry?: unknown }> {
    this.navigateCalls += 1;
    const entry = findTreeEntry(this.treeRoots, targetId);
    if (!entry) throw new Error(`Entry ${targetId} not found`);
    if (entry.type === "message" && entry.message.role === "user") {
      this.treeLeafId = entry.parentId;
      return { cancelled: false, editorText: typeof entry.message.content === "string" ? entry.message.content : "" };
    }
    this.treeLeafId = entry.id;
    return { cancelled: false };
  }
  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return flattenTree(this.treeRoots)
      .filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message" && entry.message.role === "user")
      .map((entry) => {
        const message = entry.message as unknown as Record<string, unknown>;
        return { entryId: entry.id, text: typeof message.content === "string" ? message.content : "" };
      });
  }

  markDisposed(): void {
    this.disposeCalls += 1;
    this.trace.push(`${this.sessionId}:dispose`);
  }
}

function flattenTree(roots: SessionTreeNode[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const visit = (node: SessionTreeNode): void => {
    entries.push(node.entry);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return entries;
}

function findTreeEntry(roots: SessionTreeNode[], entryId: string): SessionEntry | undefined {
  return flattenTree(roots).find((entry) => entry.id === entryId);
}

class FakeSettingsManager {
  readonly order: string[] = [];
  errors: Array<{ scope: "global" | "project"; error: Error }> = [];
  flushError: Error | undefined;

  getTransport(): "auto" { return "auto"; }
  getThinkingBudgets(): undefined { return undefined; }
  getProviderRetrySettings(): { maxRetryDelayMs?: number } { return {}; }

  async flush(): Promise<void> {
    this.order.push("flush");
    if (this.flushError) throw this.flushError;
  }

  drainErrors(): Array<{ scope: "global" | "project"; error: Error }> {
    this.order.push("drain");
    const errors = this.errors;
    this.errors = [];
    return errors;
  }
}

function settingsManagerFromRaw(globalSettings: unknown, projectSettings?: unknown, projectTrusted = false): SettingsManager {
  let global = JSON.stringify(globalSettings);
  let project = projectSettings === undefined ? undefined : JSON.stringify(projectSettings);
  return SettingsManager.fromStorage({
    withLock(scope, mutate): void {
      const next = mutate(scope === "global" ? global : project);
      if (next === undefined) return;
      if (scope === "global") global = next;
      else project = next;
    },
  }, { projectTrusted });
}

function services(options: { settings?: unknown; model?: FakeModel; modelRuntime?: unknown; cwd?: string; resourceLoader?: unknown } = {}): AgentSessionServices {
  const settings = options.settings ?? new FakeSettingsManager();
  const model = options.model;
  return {
    cwd: options.cwd ?? "/project",
    agentDir: "/agent",
    settingsManager: settings as unknown as AgentSessionServices["settingsManager"],
    modelRuntime: (options.modelRuntime ?? {
      reloadConfig: async () => {},
      getAvailable: async () => model ? [model] : [],
      getModel: (provider: string, id: string) => model?.provider === provider && model.id === id ? model : undefined,
      checkAuth: async (provider: string) => provider === model?.provider ? { state: "available" } : undefined,
      getError: () => undefined,
    }) as AgentSessionServices["modelRuntime"],
    resourceLoader: (options.resourceLoader ?? {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    }) as AgentSessionServices["resourceLoader"],
    diagnostics: [],
  };
}

type ReplacementMode = "success" | "cancel" | "hook-fail" | "factory-fail" | "bind-fail";

class FakeRuntimeOwner {
  diagnostics: [] = [];
  modelFallbackMessage: string | undefined;
  session: AgentSession;
  services: AgentSessionServices;
  mode: ReplacementMode = "success";
  candidate: FakeSession | undefined;
  beforeInvalidate: (() => void) | undefined;
  rebind: ((session: AgentSession) => Promise<void>) | undefined;
  disposeCalls = 0;
  disposeErrorBeforeInvalidate: Error | undefined;
  lastParentSession: string | undefined;
  omitForkSelectedText = false;

  constructor(readonly initial: FakeSession, private readonly trace: string[]) {
    this.session = initial as unknown as AgentSession;
    this.services = services();
  }

  get cwd(): string { return this.services.cwd; }
  setBeforeSessionInvalidate(callback?: () => void): void { this.beforeInvalidate = callback; }
  setRebindSession(callback?: (session: AgentSession) => Promise<void>): void { this.rebind = callback; }

  newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }> { this.lastParentSession = options?.parentSession; return this.replace("new"); }
  switchSession(): Promise<{ cancelled: boolean }> { return this.replace("switch"); }
  async fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }> {
    const selectedText = options?.position === "before"
      ? this.initial.getUserMessagesForForking().find((entry) => entry.entryId === entryId)?.text
      : undefined;
    const result = await this.replace("fork");
    return { ...result, ...(result.cancelled || selectedText === undefined || this.omitForkSelectedText ? {} : { selectedText }) };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.trace.push("runtime:shutdown");
    if (this.disposeErrorBeforeInvalidate) throw this.disposeErrorBeforeInvalidate;
    this.beforeInvalidate?.();
    (this.session as unknown as FakeSession).markDisposed();
  }

  private async replace(kind: "new" | "switch" | "fork"): Promise<{ cancelled: boolean }> {
    this.trace.push(`${kind}:before`);
    if (this.mode === "cancel") return { cancelled: true };
    if (this.mode === "hook-fail") throw new Error("before hook failed");
    this.trace.push(`${kind}:shutdown`);
    this.beforeInvalidate?.();
    this.initial.markDisposed();
    if (this.mode === "factory-fail") throw new Error("factory failed");
    const candidate = new FakeSession(`${kind}-session`, `/sessions/${kind}.jsonl`, this.trace);
    if (this.mode === "bind-fail") candidate.bindError = new Error("bind failed");
    candidate.bindEvent = { type: "candidate_event", value: kind };
    this.candidate = candidate;
    this.session = candidate as unknown as AgentSession;
    this.services = services({ cwd: kind === "switch" ? "/target" : "/project" });
    await this.rebind?.(this.session);
    return { cancelled: false };
  }
}

class FakeGitBranchObserver implements GitBranchObserverPort {
  disposeCalls = 0;
  constructor(
    public branch: string | undefined,
    private readonly onChange: (branch: string | undefined) => void,
  ) {}
  emit(branch: string | undefined): void {
    if (this.disposeCalls > 0) return;
    this.branch = branch;
    this.onChange(branch);
  }
  dispose(): void { this.disposeCalls += 1; }
}

async function runtimeHost(
  trace: string[],
  configure: (owner: FakeRuntimeOwner, initial: FakeSession) => void = () => {},
  options: Omit<PiAgentAdapterOptions, "runtime"> = {},
): Promise<{ host: PiAgentAdapter; owner: FakeRuntimeOwner; initial: FakeSession }> {
  const initial = new FakeSession("initial", "/sessions/initial.jsonl", trace);
  const owner = new FakeRuntimeOwner(initial, trace);
  configure(owner, initial);
  const host = await PiAgentAdapter.create({
    isSessionFileDurable: () => true,
    ...options,
    runtime: owner as unknown as PiAgentAdapterOptions["runtime"],
  });
  return { host, owner, initial };
}

test("Pi runtime host binds initial listener before extensions and delays startup events", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.bindEvent = { type: "startup_event", value: 1 };
  });
  assert.deepEqual(trace.slice(0, 2), ["initial:subscribe", "initial:bind"]);
  assert.equal(initial.bindCalls, 1);

  const events: string[] = [];
  host.subscribe((event) => events.push(event.type));
  assert.deepEqual(events, []);
  host.activateInitial();
  assert.deepEqual(events, ["startup_event"]);
  host.activateInitial();
  assert.deepEqual(events, ["startup_event"]);

  await host.dispose();
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(initial.disposeCalls, 1);
});

test("Pi runtime host converts bounded local images for prompt, steer, and follow-up without projecting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-image-"));
  const path = join(root, "fixture.custom");
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { host, initial } = await runtimeHost([]);
  const images = [{ path, mimeType: "image/x-fixture" }];
  try {
    await host.prompt("", { images });
    await host.queueMessage("same", "steer", images);
    await host.queueMessage("same", "followUp", images);
    const expected = [{ type: "image" as const, data: "iVBORw==", mimeType: "image/x-fixture" }];
    assert.deepEqual(initial.promptCalls, [{ text: "", images: expected }]);
    assert.deepEqual(initial.queueCalls, [
      { text: "same", delivery: "steer", images: expected },
      { text: "same", delivery: "followUp", images: expected },
    ]);
    await assert.rejects(
      host.queueMessage("missing", "steer", [{ path: join(root, "missing"), mimeType: "image/png" }]),
      (error: unknown) => error instanceof AgentQueueRejectedBeforeEffectError && !String(error.cause).includes(root),
    );
    assert.equal(initial.queueCalls.length, 2);

    const events: unknown[] = [];
    host.subscribe((event) => events.push(event));
    host.activateInitial();
    initial.emit({ type: "message_end", message: { role: "user", content: [{ type: "image", data: "private", mimeType: "image/x-fixture" }] } });
    assert.deepEqual(events.at(-1), { type: "message_end", message: { role: "user", content: [{ type: "image", mimeType: "image/x-fixture" }] } });
    assert.equal(JSON.stringify(events).includes("private"), false);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime host projects public compaction independently from streaming", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace);
  assert.equal(host.isStreaming, false);
  assert.equal(host.isCompacting, false);
  initial.isCompacting = true;
  assert.equal(host.isCompacting, true);
  assert.equal(host.isStreaming, false);
  initial.isStreaming = true;
  assert.equal(host.isCompacting, true);
  assert.equal(host.isStreaming, true);
  initial.isCompacting = false;
  assert.equal(host.isCompacting, false);
  await host.queueMessage("retry steer", "steer");
  await host.queueMessage("retry follow", "followUp");
  assert.deepEqual(initial.queueCalls, [
    { text: "retry steer", delivery: "steer" },
    { text: "retry follow", delivery: "followUp" },
  ]);
  initial.queueFailure = "before";
  await assert.rejects(host.queueMessage("definite", "steer"), AgentQueueRejectedBeforeEffectError);
  assert.equal(initial.queueCalls.length, 2);
  initial.queueFailure = "after";
  await assert.rejects(host.queueMessage("uncertain", "followUp"), AgentQueueEffectUnknownError);
  assert.equal(initial.queueCalls.at(-1)?.text, "uncertain");
  await host.dispose();
});

test("Pi runtime host owns Git observers across live changes and replacement disposal", async () => {
  const trace: string[] = [];
  const observers: FakeGitBranchObserver[] = [];
  const { host } = await runtimeHost(trace, undefined, {
    gitBranchObserverFactory: async (_cwd, onChange) => {
      const observer = new FakeGitBranchObserver(observers.length === 0 ? "main" : "replacement", onChange);
      observers.push(observer);
      return observer;
    },
    commitReplacement: async () => {
      observers[1]?.emit("candidate-intermediate");
      observers[1]?.emit("replacement-final");
    },
  });
  const events: Array<{ type: string; branch?: unknown }> = [];
  host.subscribe((event) => events.push({ type: event.type, branch: event.branch ?? event.gitBranch }));
  host.activateInitial();
  assert.equal(host.getGitBranch(), "main");

  observers[0]?.emit("feature/live");
  assert.equal(host.getGitBranch(), "feature/live");
  assert.deepEqual(events.at(-1), { type: "dock_git_branch_changed", branch: "feature/live" });

  await host.newSession("replace-with-observer");
  assert.equal(observers[0]?.disposeCalls, 1);
  assert.equal(host.getGitBranch(), "replacement-final");
  assert.deepEqual(events.find((event) => event.type === "dock_session_replaced"), {
    type: "dock_session_replaced",
    branch: "replacement-final",
  });
  assert.equal(events.some((event) => event.branch === "candidate-intermediate"), false);
  assert.equal(events.some((event) => event.type === "dock_git_branch_changed" && event.branch === "replacement-final"), false);

  events.length = 0;
  await host.reload("reload-with-observer");
  assert.deepEqual(events.find((event) => event.type === "dock_session_replaced"), {
    type: "dock_session_replaced",
    branch: "replacement-final",
  });
  assert.equal(events.some((event) => event.type === "dock_git_branch_changed"), false);

  const count = events.length;
  observers[0]?.emit("stale");
  assert.equal(events.length, count);
  await host.dispose();
  assert.equal(observers[1]?.disposeCalls, 1);
});

test("Pi runtime host projects public session stats for the SSH footer", async () => {
  const trace: string[] = [];
  const { host } = await runtimeHost(trace, (_owner, session) => {
    session.stats = {
      ...session.stats,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 4,
      toolResults: 4,
      totalMessages: 13,
      tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
      cost: 0.012,
      contextUsage: { tokens: 900, contextWindow: 2_000, percent: 45 },
    };
  });

  assert.deepEqual(host.getMetrics(), {
    messages: { user: 2, assistant: 3, toolCalls: 4, toolResults: 4, total: 13 },
    tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
    cost: 0.012,
    context: { tokens: 900, contextWindow: 2_000, percent: 45 },
  });
  await host.dispose();
});

test("Pi runtime events expose useful built-in presentation without raw private details", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace);
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  host.subscribe((event) => events.push(event));
  host.activateInitial();
  initial.emit({
    type: "tool_execution_end",
    toolCallId: "bash-event",
    toolName: "bash",
    isError: false,
    result: {
      content: [{ type: "text", text: "tail\n\n[Showing lines 2-3 of 3. Full output: /tmp/pi-bash-event.log]" }],
      details: {
        truncation: { truncated: true, truncatedBy: "lines", outputLines: 2, totalLines: 3, maxLines: 2, maxBytes: 51_200, content: "private duplicate" },
        fullOutputPath: "/tmp/pi-bash-event.log",
        privatePayload: "must-not-cross",
      },
    },
  });
  const event = events.find((candidate) => candidate.type === "tool_execution_end");
  const result = event?.result as Record<string, unknown> | undefined;
  assert.deepEqual(result?.presentation, {
    kind: "bash", preview: "tail", notices: [
      { code: "output_truncated", by: "lines", shown: 2, total: 3, limit: 2 },
      { code: "full_output_saved", path: "/tmp/pi-bash-event.log" },
    ],
  });
  assert.equal("details" in (result ?? {}), false);
  assert.doesNotMatch(JSON.stringify(event), /privatePayload|private duplicate|must-not-cross/u);

  initial.emit({
    type: "tool_execution_end",
    toolCallId: "extension-uppercase-bash",
    toolName: "BASH",
    isError: false,
    result: { content: [{ type: "text", text: "extension result" }], details: { fullOutputPath: "/tmp/private-extension-path", privatePayload: true } },
  });
  const extensionEvent = events.find((candidate) => candidate.type === "tool_execution_end" && candidate.toolCallId === "extension-uppercase-bash");
  const extensionResult = extensionEvent?.result as Record<string, unknown> | undefined;
  assert.equal("presentation" in (extensionResult ?? {}), false, "built-in adapters use exact names and never generalize extension details");
  assert.equal("details" in (extensionResult ?? {}), false);
  assert.doesNotMatch(JSON.stringify(extensionEvent), /private-extension-path|privatePayload/u);

  initial.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "data:image/png;base64," + "A".repeat(256) },
        { type: "image", data: "private-image-bytes", mimeType: "image/png" },
      ],
      stopReason: "stop",
    },
  });
  const messageEvent = events.find((candidate) => candidate.type === "message_end");
  assert.match(JSON.stringify(messageEvent), /data:image\/png;base64/);
  assert.match(JSON.stringify(messageEvent), /A{128}/);
  assert.doesNotMatch(JSON.stringify(messageEvent), /private-image-bytes/u);
  assert.match(JSON.stringify(messageEvent), /image\/png/u);
  await host.dispose();
});

test("Pi runtime history uses public context entries in model-visible order", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.historyEntries = [
      { type: "message", id: "h1", parentId: null, timestamp: "2026-07-14T00:00:00.000Z", message: { role: "user", content: "question", timestamp: 1 } },
      { type: "custom_message", id: "h2", parentId: "h1", timestamp: "2026-07-14T00:00:01.000Z", customType: "visible", content: "notice", display: true },
      { type: "compaction", id: "h3", parentId: "h2", timestamp: "2026-07-14T00:00:02.000Z", summary: "summary", firstKeptEntryId: "h1", tokensBefore: 10 },
    ];
  });

  assert.deepEqual(host.getHistory().map((entry) => [entry.entryId, entry.role, entry.summaryKind, entry.content]), [
    ["h3", "system", "compaction", "summary"],
    ["h1", "user", undefined, "question"],
    ["h2", "system", undefined, "notice"],
  ]);
  initial.historyEntries.push(
    { type: "custom_message", id: "hidden", parentId: "h3", timestamp: "2026-07-14T00:00:03.000Z", customType: "hidden", content: "secret", display: false },
    { type: "message", id: "hidden-guard", parentId: "hidden", timestamp: "2026-07-14T00:00:04.000Z", message: {
      role: "custom", customType: "sol-mid-turn-guard", content: "hidden continuation", display: false, timestamp: 4,
    } },
  );
  assert.equal(host.getHistory().some((entry) => entry.entryId === "hidden"), false);
  assert.equal(host.getHistory().some((entry) => entry.entryId === "hidden-guard"), false);
  await host.dispose();
});

test("Pi runtime conversation pages recover content beyond legacy text, block, and aggregate bounds", async () => {
  const longText = `${"A sentence with unicode 你.\n".repeat(23_000)}😀tail`;
  const longThinking = `${"想".repeat(40_000)}end`;
  const toolArguments = { query: "ordinary search phrase with spaces. ".repeat(2_500), nested: { keep: true } };
  const dataUri = `data:image/png;base64,${"A".repeat(256)}`;
  const imageData = "iVBORw0KGgo".repeat(20_000);
  const smallBlocks = Array.from({ length: 205 }, (_, index) => ({ type: "text" as const, text: `block-${index}` }));
  const { host, initial } = await runtimeHost([], (_owner, session) => {
    session.historyEntries = [{
      type: "message",
      id: "large-assistant",
      parentId: null,
      timestamp: "2026-07-14T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          ...smallBlocks,
          { type: "text", text: longText },
          { type: "thinking", thinking: longThinking },
          { type: "toolCall", id: "call-large", name: "search", arguments: toolArguments },
          { type: "text", text: dataUri },
        ],
        stopReason: "stop",
        timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: "fixture",
        provider: "fixture",
        model: "fixture",
      },
    }, {
      type: "message",
      id: "image-user",
      parentId: "large-assistant",
      timestamp: "2026-07-14T00:00:01.000Z",
      message: { role: "user", content: [{ type: "image", data: imageData, mimeType: "image/png" }], timestamp: 2 },
    }];
  });

  const history = await host.getConversationHistory(undefined, 2);
  assert.equal(history.entries.length, 2);
  const largeHistory = history.entries.find((item) => item.entry.entryId === "large-assistant");
  const imageHistory = history.entries.find((item) => item.entry.entryId === "image-user");
  assert.equal(largeHistory?.contentComplete, false);
  assert.equal(largeHistory?.totalBlocks, 209);
  assert.equal(imageHistory?.totalBlocks, 1);
  assert.ok(JSON.stringify(largeHistory?.entry).length < 16_000, "history is a bounded preview");

  const contentRef = largeHistory!.contentRef;
  const textByBlock = new Map<number, string>();
  let cursor: string | undefined;
  let revision: string | undefined;
  let pageCount = 0;
  do {
    const page = await host.getConversationContent(contentRef, cursor);
    revision ??= page.revision;
    assert.equal(page.revision, revision);
    pageCount += 1;
    for (const chunk of page.chunks) {
      if (chunk.type === "text" || chunk.type === "thinking") {
        const previous = textByBlock.get(chunk.blockIndex) ?? "";
        assert.equal(chunk.offset, previous.length);
        textByBlock.set(chunk.blockIndex, previous + chunk.text);
      } else if (chunk.type === "tool_call") {
        const previous = textByBlock.get(chunk.blockIndex) ?? "";
        assert.equal(chunk.offset, previous.length);
        textByBlock.set(chunk.blockIndex, previous + chunk.argumentsJson);
      }
    }
    cursor = page.nextCursor;
    if (page.complete) assert.equal(cursor, undefined);
  } while (cursor !== undefined);

  assert.ok(pageCount > 1, "content spans multiple bounded pages");
  assert.equal(textByBlock.get(205), longText);
  assert.equal(textByBlock.get(206), longThinking);
  assert.deepEqual(JSON.parse(textByBlock.get(207) ?? ""), toolArguments);
  assert.equal(textByBlock.get(208), dataUri);

  let imageCursor: string | undefined;
  let recoveredImage = "";
  do {
    const page = await host.getConversationContent(imageHistory!.contentRef, imageCursor);
    for (const chunk of page.chunks) {
      if (chunk.type !== "image") continue;
      assert.equal(chunk.offset, recoveredImage.length);
      assert.equal(chunk.mimeType, "image/png");
      recoveredImage += chunk.data;
    }
    imageCursor = page.nextCursor;
  } while (imageCursor !== undefined);
  assert.equal(recoveredImage, imageData);

  initial.historyEntries.push({
    type: "message",
    id: "new-user",
    parentId: "large-assistant",
    timestamp: "2026-07-14T00:00:01.000Z",
    message: { role: "user", content: "new", timestamp: 2 },
  });
  await assert.rejects(host.getConversationContent(contentRef), /reference is stale/);
  await host.dispose();
});

test("Pi runtime splits oversized live text deltas without losing Unicode", async () => {
  const { host, initial } = await runtimeHost([]);
  const events: Array<Record<string, unknown>> = [];
  host.subscribe((event) => events.push(event));
  host.activateInitial();
  const delta = `${"x".repeat(7_999)}😀${"y".repeat(8_100)}`;
  initial.emit({
    type: "agent_message_delta",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  });
  const updates = events
    .filter((event) => event.type === "agent_message_delta")
    .map((event) => event.assistantMessageEvent as { delta: string });
  assert.ok(updates.length >= 3);
  assert.equal(updates.map((update) => update.delta).join(""), delta);
  assert.ok(updates.every((update) => update.delta.length <= 8_000));
  assert.ok(updates.every((update) => !/[\uD800-\uDBFF]$/u.test(update.delta)));
  await host.dispose();
});

test("Pi runtime history retains Pi edit diffs without private detail payloads", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.historyEntries = [{
      type: "message",
      id: "edit-result",
      parentId: null,
      timestamp: "2026-07-14T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
        details: {
          diff: " 1 const keep = true;\n-2 const value = 'old';\n+2 const value = 'new';",
          patch: "private unified patch",
          firstChangedLine: 2,
        },
        isError: false,
        timestamp: 1,
      },
    }];
  });

  assert.deepEqual(host.getHistory(), [{
    entryId: "edit-result",
    timestamp: "2026-07-14T00:00:00.000Z",
    role: "toolResult",
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
    toolCallId: "edit-1",
    toolName: "edit",
    toolPresentation: {
      kind: "edit",
      preview: "head-tail",
      notices: [],
      displayDiff: " 1 const keep = true;\n-2 const value = 'old';\n+2 const value = 'new';",
    },
    isError: false,
  }]);
  assert.doesNotMatch(JSON.stringify(host.getHistory()), /private unified patch/u);

  initial.historyEntries.push({
    type: "message",
    id: "edit-result-malformed",
    parentId: "edit-result",
    timestamp: "2026-07-14T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: "edit-2",
      toolName: "edit",
      content: [{ type: "text", text: "Legacy edit result." }],
      details: { diff: "not a numbered Pi edit diff", patch: "private malformed patch" },
      isError: false,
      timestamp: 2,
    },
  });
  const malformed = host.getHistory().find((entry) => entry.entryId === "edit-result-malformed");
  assert.deepEqual(malformed?.toolPresentation, {
    kind: "edit", preview: "head-tail", notices: [],
  });
  assert.doesNotMatch(JSON.stringify(malformed), /private malformed patch|not a numbered Pi edit diff/u);

  const largeDiff = Array.from({ length: 2_000 }, (_, index) => `${index % 2 === 0 ? "-" : "+"}${index + 1} const value${index} = true;`).join("\n");
  initial.historyEntries.push({
    type: "message",
    id: "edit-result-large",
    parentId: "edit-result-malformed",
    timestamp: "2026-07-14T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "edit-3",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced a large block." }],
      details: { diff: largeDiff, patch: "private large patch" },
      isError: false,
      timestamp: 3,
    },
  });
  const projectedLarge = host.getHistory().find((entry) => entry.entryId === "edit-result-large")?.toolPresentation?.displayDiff;
  assert.equal(projectedLarge, largeDiff, "Dock does not re-truncate Pi's display diff");

  const singleLongRow = `+1 ${"x".repeat(20_000)}`;
  initial.historyEntries.push({
    type: "message",
    id: "edit-result-single-long-row",
    parentId: "edit-result-large",
    timestamp: "2026-07-14T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "edit-4",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced one long row." }],
      details: { diff: singleLongRow },
      isError: false,
      timestamp: 4,
    },
  });
  const projectedSingleRow = host.getHistory().find((entry) => entry.entryId === "edit-result-single-long-row")?.toolPresentation?.displayDiff;
  assert.equal(projectedSingleRow, singleLongRow, "a long Pi diff row remains available to Ctrl+O details");
  await host.dispose();
});

test("Pi runtime history projects every built-in result detail without private payloads", async () => {
  const trace: string[] = [];
  const resultEntry = (id: string, parentId: string | null, toolName: string, content: string, details?: Record<string, unknown>) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp: "2026-07-14T00:00:00.000Z",
    message: { role: "toolResult" as const, toolCallId: `call-${id}`, toolName, content: [{ type: "text" as const, text: content }], details, isError: false, timestamp: 1 },
  });
  const { host } = await runtimeHost(trace, (_owner, session) => {
    session.historyEntries = [
      resultEntry("bash", null, "bash", "latest output\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-safe.log]", {
        truncation: { truncated: true, truncatedBy: "lines", outputLines: 2_000, totalLines: 3_000, maxLines: 2_000, maxBytes: 51_200 },
        fullOutputPath: "/tmp/pi-bash-safe.log",
        privatePayload: "must-not-cross",
      }),
      resultEntry("read", "bash", "read", "file head\n\n[Showing lines 1-2000 of 4000. Use offset=2001 to continue.]", {
        truncation: { truncated: true, truncatedBy: "bytes", outputLines: 1_500, totalLines: 4_000, maxLines: 2_000, maxBytes: 51_200 },
      }),
      resultEntry("grep", "read", "grep", "matches\n\n[100 matches limit reached. 50KB limit reached. Some lines truncated to 500 chars.]", {
        truncation: { truncated: true, truncatedBy: "bytes", outputLines: 100, totalLines: 100, maxLines: 2_000, maxBytes: 51_200 },
        matchLimitReached: 100,
        linesTruncated: true,
      }),
      resultEntry("find", "grep", "find", "files\n\n[1000 results limit reached]", { resultLimitReached: 1_000 }),
      resultEntry("ls", "find", "ls", "entries\n\n[500 entries limit reached]", { entryLimitReached: 500 }),
      resultEntry("write", "ls", "write", "Successfully wrote file", undefined),
    ];
  });

  const presentations = Object.fromEntries(host.getHistory().map((entry) => [entry.entryId, entry.toolPresentation]));
  assert.deepEqual(presentations.bash, {
    kind: "bash", preview: "tail", notices: [
      { code: "output_truncated", by: "lines", shown: 2_000, total: 3_000, limit: 2_000 },
      { code: "full_output_saved", path: "/tmp/pi-bash-safe.log" },
    ],
  });
  assert.deepEqual(presentations.read, {
    kind: "read", preview: "head", notices: [
      { code: "output_truncated", by: "bytes", shown: 1_500, total: 4_000, limit: 51_200 },
      { code: "continue_with_offset", offset: 2_001 },
    ],
  });
  assert.deepEqual(presentations.grep, {
    kind: "grep", preview: "head", notices: [
      { code: "output_truncated", by: "bytes", shown: 100, total: 100, limit: 51_200 },
      { code: "limit_reached", unit: "matches", limit: 100 },
      { code: "lines_truncated", maxChars: 500 },
    ],
  });
  assert.deepEqual(presentations.find, { kind: "find", preview: "head", notices: [{ code: "limit_reached", unit: "results", limit: 1_000 }] });
  assert.deepEqual(presentations.ls, { kind: "ls", preview: "head", notices: [{ code: "limit_reached", unit: "entries", limit: 500 }] });
  assert.deepEqual(presentations.write, { kind: "write", preview: "head", notices: [] });
  assert.doesNotMatch(JSON.stringify(host.getHistory()), /privatePayload|must-not-cross/u);
  await host.dispose();
});

test("Pi runtime host resolves public session targets and forwards new-session parent metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-session-target-"));
  const cwd = join(directory, "cwd");
  const sessionDir = join(directory, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  const sessionFile = join(sessionDir, "target.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "target-session", timestamp: "2026-07-14T00:00:00.000Z", cwd })}\n`);

  const trace: string[] = [];
  const { host, owner } = await runtimeHost(trace);
  try {
    assert.deepEqual(await host.resolveSessionTarget(sessionFile), { canonicalCwd: cwd });
    await host.newSession("new-parent-op", "/sessions/parent.jsonl");
    assert.equal(owner.lastParentSession, "/sessions/parent.jsonl");
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi runtime host names and manually compacts through public AgentSession methods", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace);
  host.activateInitial();
  const events: string[] = [];
  const unsubscribe = host.subscribe((event) => events.push(event.type));

  assert.equal(host.setSessionName("  Daily work  "), "Daily work");
  assert.equal(initial.sessionName, "Daily work");
  assert.deepEqual(await host.compact("keep decisions"), { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 321 });
  assert.ok(events.includes("session_info_changed"));
  assert.ok(events.includes("compaction_start"));
  assert.ok(events.includes("compaction_end"));

  unsubscribe();
  await host.dispose();
});

test("Pi runtime host distinguishes known no-effect compaction failures from post-effect ambiguity", async () => {
  const knownRuntime = await runtimeHost([], (_owner, session) => {
    session.compactError = new Error("Nothing to compact (session too small)");
  });
  knownRuntime.host.activateInitial();
  await assert.rejects(
    knownRuntime.host.compact(),
    (error: unknown) => error instanceof AgentCompactionKnownFailureError
      && error.reason === "nothing_to_compact",
  );
  await knownRuntime.host.dispose();

  const ambiguousRuntime = await runtimeHost([], (_owner, session) => {
    session.compactError = new Error("post-append hook failed");
    session.appendCompactionBeforeError = true;
  });
  ambiguousRuntime.host.activateInitial();
  await assert.rejects(
    ambiguousRuntime.host.compact(),
    (error: unknown) => error instanceof Error
      && !(error instanceof AgentCompactionKnownFailureError)
      && error.message === "post-append hook failed",
  );
  await ambiguousRuntime.host.dispose();
});

test("Pi runtime abort selects the public compaction cancellation path", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace);
  initial.isCompacting = true;

  let abortResolved = false;
  const aborting = host.abort().then(() => { abortResolved = true; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(initial.abortCompactionCalls, 1);
  assert.equal(initial.abortCalls, 0);
  assert.equal(abortResolved, false);
  initial.finishCompaction();
  await aborting;

  await host.abort();
  assert.equal(initial.abortCalls, 1);
  await host.dispose();
});

test("Pi runtime host projects the public tree and routes navigate, fork, and clone through public APIs", async () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const user: SessionEntry = { type: "message", id: "tree-user", parentId: null, timestamp, message: { role: "user", content: "edit this prompt", timestamp: 1 } };
  const assistant: SessionEntry = { type: "message", id: "tree-assistant", parentId: "tree-user", timestamp: "2026-07-14T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: "fixture", provider: "fixture", model: "fixture" } };
  const tree: SessionTreeNode[] = [{
    entry: user,
    label: "start",
    labelTimestamp: timestamp,
    children: [{ entry: assistant, children: [] }],
  }];

  const trace: string[] = [];
  const commits: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.treeRoots = tree;
    session.treeLeafId = "tree-assistant";
  }, {
    commitReplacement: async (change) => { commits.push(`${change.kind}:${change.sessionFile}`); },
  });
  host.activateInitial();

  assert.deepEqual(host.getTree(), {
    leafId: "tree-assistant",
    nodes: [
      { entryId: "tree-user", depth: 0, kind: "message", role: "user", displayClass: "content", label: "start", labelTimestamp: timestamp, timestamp, summary: "edit this prompt", hasChildren: true },
      { entryId: "tree-assistant", parentId: "tree-user", depth: 1, kind: "message", role: "assistant", displayClass: "content", timestamp: "2026-07-14T00:00:01.000Z", summary: "answer", hasChildren: false },
    ],
  });
  assert.deepEqual(await host.navigateTree("tree-user"), { cancelled: false, editorText: "edit this prompt", summaryCreated: false });
  assert.equal(initial.navigateCalls, 1);
  assert.equal(host.sessionFile, "/sessions/initial.jsonl");
  await host.dispose();

  const forkTrace: string[] = [];
  const forkRuntime = await runtimeHost(forkTrace, (_owner, session) => {
    session.treeRoots = tree;
    session.treeLeafId = "tree-assistant";
  }, {
    commitReplacement: async (change) => { commits.push(`${change.kind}:${change.sessionFile}`); },
  });
  forkRuntime.host.activateInitial();
  assert.deepEqual(await forkRuntime.host.fork("fork-op", "tree-user", "before", "fork"), { cancelled: false, selectedText: "edit this prompt" });
  assert.equal(forkRuntime.host.sessionId, "fork-session");
  await forkRuntime.host.dispose();

  const missingTextTrace: string[] = [];
  const missingTextRuntime = await runtimeHost(missingTextTrace, (owner, session) => {
    owner.omitForkSelectedText = true;
    session.treeRoots = tree;
    session.treeLeafId = "tree-assistant";
  });
  missingTextRuntime.host.activateInitial();
  await assert.rejects(
    missingTextRuntime.host.fork("fork-without-text", "tree-user", "before", "fork"),
    /without selected editor text/,
  );
  assert.equal(missingTextRuntime.owner.candidate?.disposeCalls, 1);
  await missingTextRuntime.host.dispose();

  const cloneTrace: string[] = [];
  const cloneRuntime = await runtimeHost(cloneTrace, (_owner, session) => {
    session.treeRoots = tree;
    session.treeLeafId = "tree-assistant";
  }, {
    commitReplacement: async (change) => { commits.push(`${change.kind}:${change.sessionFile}`); },
  });
  cloneRuntime.host.activateInitial();
  await assert.rejects(cloneRuntime.host.fork("clone-wrong", "tree-user", "at", "clone"), /current session leaf/);
  assert.deepEqual(await cloneRuntime.host.fork("clone-op", "tree-assistant", "at", "clone"), { cancelled: false });
  assert.equal(cloneRuntime.host.sessionId, "fork-session");
  assert.ok(commits.some((commit) => commit.startsWith("fork:")));
  assert.ok(commits.some((commit) => commit.startsWith("clone:")));
  await cloneRuntime.host.dispose();
});

test("Pi tree projection hides tool-call wrappers semantically and summarizes invocation instead of result JSON", async () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const user = { type: "message", id: "tool-user", parentId: null, timestamp, message: { role: "user", content: "inspect card", timestamp: 1 } } as unknown as SessionEntry;
  const call = { type: "message", id: "tool-call", parentId: "tool-user", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "alu_kanban", arguments: { action: "get_card", card_id: 185 } }], timestamp: 2, stopReason: "toolUse", usage, api: "fixture", provider: "fixture", model: "fixture" } } as unknown as SessionEntry;
  const result = { type: "message", id: "tool-result", parentId: "tool-call", timestamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "alu_kanban", content: [{ type: "text", text: JSON.stringify({ description: "very large result", checklist: [1, 2, 3] }) }], isError: false, timestamp: 3 } } as unknown as SessionEntry;
  const error = { type: "message", id: "assistant-error", parentId: "tool-result", timestamp, message: { role: "assistant", content: [], timestamp: 4, stopReason: "error", errorMessage: "WebSocket error", usage, api: "fixture", provider: "fixture", model: "fixture" } } as unknown as SessionEntry;
  const roots: SessionTreeNode[] = [{ entry: user, children: [{ entry: call, children: [{ entry: result, children: [{ entry: error, children: [] }] }] }] }];
  const { host } = await runtimeHost([], (_owner, session) => {
    session.treeRoots = roots;
    session.treeLeafId = "assistant-error";
  });
  host.activateInitial();
  const tree = host.getTree();
  const wrapper = tree.nodes.find((node) => node.entryId === "tool-call");
  const tool = tree.nodes.find((node) => node.entryId === "tool-result");
  const failed = tree.nodes.find((node) => node.entryId === "assistant-error");
  assert.equal(wrapper?.displayClass, "structural");
  assert.equal(tool?.displayClass, "tool");
  assert.equal(tool?.summary, "[alu_kanban: get_card · card #185]");
  assert.doesNotMatch(JSON.stringify(tool), /very large result|checklist/u);
  assert.equal(failed?.displayClass, "content");
  assert.equal(failed?.state, "error");
  assert.equal(failed?.summary, "WebSocket error");
  await host.dispose();
});

test("navigation post-effect catalog failure exposes effect_unknown without publishing session.navigated", async () => {
  const trace: string[] = [];
  const timestamp = "2026-07-14T00:00:00.000Z";
  const assistantEntry: SessionEntry = { type: "message", id: "navigate-target", parentId: null, timestamp, message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: "fixture", provider: "fixture", model: "fixture" } };
  const { host } = await runtimeHost(trace, (_owner, session) => {
    session.treeRoots = [{ entry: assistantEntry, children: [] }];
    session.treeLeafId = null;
  });
  const instance = new ManagedInstance({ id: "navigate-fault", creationOperationId: "create-navigate-fault", hostEpoch: "epoch-navigate-fault", cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), { kind: "instance.create", effect: "rollback_contained", operationId: instance.creationOperationId, instanceId: instance.id });
  instance.markCatalogCommitted();
  port.failAt(2);

  await assert.rejects(
    instance.navigateSession("navigate-catalog-fault", "navigate-target"),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "navigate-catalog-fault",
  );
  assert.equal(catalog.health, "mutation_faulted");
  assert.equal((await instance.getTreePage(undefined, undefined, 10)).leafId, "navigate-target");
  assert.equal(instance.eventsSince().events.some((event) => event.type === "session.navigated"), false);
  await instance.disposeForHostDrain();
});

test("successful replacement invalidates old binding and publishes new generation first", async () => {
  const trace: string[] = [];
  const commits: string[] = [];
  const { host, owner, initial } = await runtimeHost(trace, undefined, {
    commitReplacement: async (change) => {
      commits.push(`${change.operationId}:${change.kind}:${change.sessionFile}`);
      trace.push("catalog:commit");
    },
  });
  const instance = new ManagedInstance({
    id: "dock-1",
    creationOperationId: "create-1",
    hostEpoch: "epoch-1",
    cwd: "/project",
    session: localConnection(host), initialHistory: host.getHistory(),
  });
  host.activateInitial();
  const staleCursor = {
    ...instance.snapshot().eventCursor,
    sequence: 50,
  };

  assert.deepEqual(await instance.newSession("replace-1"), { cancelled: false });
  assert.equal(instance.runtimeGeneration, 2);
  assert.equal(instance.snapshot().executor.piSessionId, "new-session");
  assert.deepEqual(commits, ["replace-1:new:/sessions/new.jsonl"]);
  assert.equal(initial.unsubscribeCalls, 1);
  initial.emit({ type: "candidate_event", value: "stale" });

  const staleReplay = instance.eventsSince(staleCursor);
  assert.equal(staleReplay.truncated, true);
  const events = staleReplay.events;
  assert.equal(events[0]?.sequence, 1);
  assert.equal(events[0]?.type, "session.replaced");
  assert.equal(events[0]?.runtimeGeneration, 2);
  assert.ok(events.some((event) => event.type === "session.replaced"));
  assert.ok(trace.indexOf("new-session:bind") < trace.indexOf("catalog:commit"));
  assert.equal(owner.candidate?.bindCalls, 1);
  await instance.stop("stop-1");
});

test("replacement catalog failure keeps the committed generation and reports the caller operation", async () => {
  const trace: string[] = [];
  const { host, owner } = await runtimeHost(trace);
  const instance = new ManagedInstance({
    id: "dock-catalog-fault",
    creationOperationId: "create-catalog-fault",
    hostEpoch: "epoch-catalog-fault",
    cwd: "/project",
    session: localConnection(host), initialHistory: host.getHistory(),
  });
  host.activateInitial();
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), {
    kind: "instance.create",
    effect: "rollback_contained",
    operationId: instance.creationOperationId,
    instanceId: instance.id,
  });
  instance.markCatalogCommitted();
  port.failAt(3);

  await assert.rejects(
    instance.newSession("replace-catalog-failed"),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "replace-catalog-failed",
  );
  assert.equal(catalog.health, "mutation_faulted");
  assert.equal(owner.candidate?.disposeCalls, 0);
  assert.equal(instance.runtimeGeneration, 2);
  assert.equal(instance.snapshot().runtimeGeneration, 1);
  assert.equal(instance.snapshot().executor.piSessionId, "initial");
  const conservativeAttach = await instance.getAttachProjection(undefined);
  assert.equal(conservativeAttach.instance.runtimeGeneration, 1);
  assert.equal(conservativeAttach.page.latest.runtimeGeneration, 1);
  await instance.disposeForHostDrain();
  assert.equal(owner.disposeCalls, 1);
});

test("replacement teardown failure commits runtime_error with the previous recovery session", async () => {
  const trace: string[] = [];
  const { host, owner } = await runtimeHost(trace, (runtimeOwner) => { runtimeOwner.mode = "factory-fail"; });
  const instance = new ManagedInstance({
    id: "dock-runtime-error",
    creationOperationId: "create-runtime-error",
    hostEpoch: "epoch-runtime-error",
    cwd: "/project",
    session: localConnection(host), initialHistory: host.getHistory(),
  });
  host.activateInitial();
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), {
    kind: "instance.create",
    effect: "rollback_contained",
    operationId: instance.creationOperationId,
    instanceId: instance.id,
  });
  instance.markCatalogCommitted();

  await assert.rejects(instance.newSession("replace-runtime-error"), /factory failed/);
  const committed = port.calls[2]?.candidate.instances[0];
  assert.equal(committed?.lifecycle, "runtime_error");
  assert.equal(committed?.execution, "unavailable");
  assert.equal(committed?.recoverySessionFile, "/sessions/initial.jsonl");
  assert.equal(committed?.replacement, undefined);
  assert.equal(instance.snapshot().lifecycle, "runtime_error");
  await instance.disposeForHostDrain();
  assert.equal(owner.initial.disposeCalls, 1);
});

test("runtime-error catalog failure retains the committed replacement intent", async () => {
  const trace: string[] = [];
  const { host, owner } = await runtimeHost(trace, (runtimeOwner) => { runtimeOwner.mode = "factory-fail"; });
  const instance = new ManagedInstance({
    id: "dock-runtime-error-fault",
    creationOperationId: "create-runtime-error-fault",
    hostEpoch: "epoch-runtime-error-fault",
    cwd: "/project",
    session: localConnection(host), initialHistory: host.getHistory(),
  });
  host.activateInitial();
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), {
    kind: "instance.create",
    effect: "rollback_contained",
    operationId: instance.creationOperationId,
    instanceId: instance.id,
  });
  instance.markCatalogCommitted();
  port.failAt(3);

  await assert.rejects(
    instance.newSession("runtime-error-commit-failed"),
    (error: unknown) => error instanceof CatalogEffectUnknownError && error.context.operationId === "runtime-error-commit-failed",
  );
  const conservative = catalog.current().instances[0];
  assert.equal(catalog.health, "mutation_faulted");
  assert.equal(conservative?.lifecycle, "active");
  assert.equal(conservative?.replacement?.operationId, "runtime-error-commit-failed");
  assert.equal(conservative?.replacement?.previousSessionFile, "/sessions/initial.jsonl");
  assert.equal(conservative?.recoverySessionFile, undefined);
  assert.equal(instance.snapshot().lifecycle, "active");
  assert.equal(owner.initial.disposeCalls, 1);
  await instance.disposeForHostDrain();
});

test("switch applies pre-resolved target trust before SDK hooks", async () => {
  const trace: string[] = [];
  const trustCalls: string[] = [];
  const { host } = await runtimeHost(trace, undefined, {
    setProjectTrust: (cwd, trusted) => {
      trustCalls.push(`${cwd}:${String(trusted)}`);
      trace.push("trust:resolved");
    },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await instance.switchSession("switch-1", "/sessions/target.jsonl", {
    canonicalCwd: "/target",
    projectTrusted: false,
  });
  assert.deepEqual(trustCalls, ["/target:false"]);
  assert.ok(trace.indexOf("trust:resolved") < trace.indexOf("switch:before"));
  assert.equal(instance.runtimeGeneration, 2);
  assert.equal(instance.cwd, "/target");
  assert.equal(instance.snapshot().cwd, "/target");
  assert.equal(instance.snapshot().executor.piSessionId, "switch-session");
  await instance.stop("stop-1");
});

test("cancelled replacement leaves binding and generation untouched", async () => {
  const trace: string[] = [];
  const { host, owner, initial } = await runtimeHost(trace, (runtime) => { runtime.mode = "cancel"; });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  assert.deepEqual(await instance.newSession("cancel-1"), { cancelled: true });
  assert.equal(instance.runtimeGeneration, 1);
  assert.equal(initial.unsubscribeCalls, 0);
  assert.equal(initial.disposeCalls, 0);
  assert.equal(owner.candidate, undefined);
  await instance.stop("stop-1");
});

test("cancelled cross-project switch restores the Worker construction cwd", async () => {
  const trace: string[] = [];
  const cwdCalls: string[] = [];
  const { host, owner } = await runtimeHost(trace, (runtime) => { runtime.mode = "cancel"; }, {
    setProcessCwd: (cwd) => { cwdCalls.push(cwd); },
  });
  host.activateInitial();

  assert.deepEqual(await host.switchSession("cancel-switch", "/sessions/target.jsonl", {
    canonicalCwd: "/target",
    projectTrusted: false,
  }), { cancelled: true });
  assert.deepEqual(cwdCalls, ["/project", "/target", "/project"]);
  assert.equal(owner.candidate, undefined);
  await host.dispose();
});

test("fork cancellation clears durable intent while fork factory failure preserves previous-session recovery", async () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const user: SessionEntry = { type: "message", id: "fork-user", parentId: null, timestamp, message: { role: "user", content: "fork me", timestamp: 1 } };
  const tree: SessionTreeNode[] = [{ entry: user, children: [] }];

  const cancelTrace: string[] = [];
  const cancelledRuntime = await runtimeHost(cancelTrace, (owner, session) => {
    owner.mode = "cancel";
    session.treeRoots = tree;
    session.treeLeafId = "fork-user";
  });
  const cancelled = new ManagedInstance({ id: "fork-cancel", creationOperationId: "create-fork-cancel", hostEpoch: "epoch-fork-cancel", cwd: "/project", session: localConnection(cancelledRuntime.host), initialHistory: cancelledRuntime.host.getHistory() });
  cancelledRuntime.host.activateInitial();
  const cancelPort = new ScriptedCatalogCommitPort();
  const cancelCatalog = new CatalogTransactionCoordinator(cancelPort, cancelled.hostEpoch);
  cancelled.bindCatalogPort(cancelCatalog.forInstance(cancelled.id));
  await cancelCatalog.create(cancelled.catalogRecord(), { kind: "instance.create", effect: "rollback_contained", operationId: cancelled.creationOperationId, instanceId: cancelled.id });
  cancelled.markCatalogCommitted();
  assert.deepEqual(await cancelled.forkSession("fork-cancel-op", "fork-user"), { cancelled: true });
  assert.equal(cancelCatalog.current().instances[0]?.replacement, undefined);
  assert.equal(cancelled.snapshot().runtimeGeneration, 1);
  assert.deepEqual(cancelPort.calls.slice(-2).map((call) => call.context.kind), ["session.fork.intent", "session.fork.cancelled"]);
  await cancelled.disposeForHostDrain();

  const failureTrace: string[] = [];
  const failedRuntime = await runtimeHost(failureTrace, (owner, session) => {
    owner.mode = "factory-fail";
    session.treeRoots = tree;
    session.treeLeafId = "fork-user";
  });
  const failed = new ManagedInstance({ id: "fork-failed", creationOperationId: "create-fork-failed", hostEpoch: "epoch-fork-failed", cwd: "/project", session: localConnection(failedRuntime.host), initialHistory: failedRuntime.host.getHistory() });
  failedRuntime.host.activateInitial();
  const failurePort = new ScriptedCatalogCommitPort();
  const failureCatalog = new CatalogTransactionCoordinator(failurePort, failed.hostEpoch);
  failed.bindCatalogPort(failureCatalog.forInstance(failed.id));
  await failureCatalog.create(failed.catalogRecord(), { kind: "instance.create", effect: "rollback_contained", operationId: failed.creationOperationId, instanceId: failed.id });
  failed.markCatalogCommitted();
  await assert.rejects(failed.forkSession("fork-failure-op", "fork-user"), /factory failed/);
  const failureRecord = failureCatalog.current().instances[0];
  assert.equal(failureRecord?.lifecycle, "runtime_error");
  assert.equal(failureRecord?.recoverySessionFile, "/sessions/initial.jsonl");
  assert.equal(failureRecord?.replacement, undefined);
  const runtimeError = failed.eventsSince().events.find((event) => event.type === "instance.runtime_error");
  assert.ok(runtimeError?.type === "instance.runtime_error");
  assert.equal(runtimeError.data.kind, "fork");
  await failed.disposeForHostDrain();
});

test("a replacement whose Pi file is deferred keeps only the previous durable recovery until materialization", async () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const user: SessionEntry = { type: "message", id: "deferred-user", parentId: null, timestamp, message: { role: "user", content: "defer me", timestamp: 1 } };
  const durable = new Set(["/sessions/initial.jsonl"]);
  const trace: string[] = [];
  const runtime = await runtimeHost(trace, (_owner, session) => {
    session.treeRoots = [{ entry: user, children: [] }];
    session.treeLeafId = "deferred-user";
  }, { isSessionFileDurable: (path) => durable.has(path) });
  const instance = new ManagedInstance({ id: "deferred-fork", creationOperationId: "create-deferred-fork", hostEpoch: "epoch-deferred-fork", cwd: "/project", session: localConnection(runtime.host), initialHistory: runtime.host.getHistory() });
  runtime.host.activateInitial();
  const port = new ScriptedCatalogCommitPort();
  const catalog = new CatalogTransactionCoordinator(port, instance.hostEpoch);
  instance.bindCatalogPort(catalog.forInstance(instance.id));
  await catalog.create(instance.catalogRecord(), { kind: "instance.create", effect: "rollback_contained", operationId: instance.creationOperationId, instanceId: instance.id });
  instance.markCatalogCommitted();

  assert.deepEqual(await instance.forkSession("deferred-fork-op", "deferred-user"), { cancelled: false, selectedText: "defer me" });
  const deferred = catalog.current().instances[0];
  assert.equal(instance.snapshot().executor.sessionFile, "/sessions/fork.jsonl");
  assert.equal(deferred?.sessionFile, undefined);
  assert.equal(deferred?.recoverySessionFile, "/sessions/initial.jsonl");
  assert.equal(deferred?.lifecycle, "active");

  durable.add("/sessions/fork.jsonl");
  await instance.setSessionName("materialized", "materialized-name");
  const materialized = catalog.current().instances[0];
  assert.equal(materialized?.sessionFile, "/sessions/fork.jsonl");
  assert.equal(materialized?.recoverySessionFile, undefined);
  await instance.disposeForHostDrain();
});

test("replacement commit failure disposes the candidate before runtime_error publication", async () => {
  const trace: string[] = [];
  let runtimeErrorCommits = 0;
  const { host, owner } = await runtimeHost(trace, undefined, {
    commitReplacement: async () => { throw new Error("catalog commit failed"); },
    commitRuntimeError: async () => { runtimeErrorCommits += 1; },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await assert.rejects(instance.newSession("commit-fail"), /catalog commit failed/);
  assert.equal(instance.snapshot().lifecycle, "runtime_error");
  assert.equal(instance.runtimeGeneration, 1);
  assert.equal(owner.disposeCalls, 1);
  assert.equal(owner.candidate?.disposeCalls, 1);
  assert.equal(runtimeErrorCommits, 1);
  assert.ok(!instance.eventsSince().events.some((event) => event.type === "session.replaced"));
  await instance.stop("stop-after-commit-failure");
  assert.equal(owner.disposeCalls, 1);
});

test("a replacement hook failure before invalidation preserves the active runtime", async () => {
  const trace: string[] = [];
  let runtimeErrorCommits = 0;
  const { host, owner, initial } = await runtimeHost(trace, (runtime) => { runtime.mode = "hook-fail"; }, {
    commitRuntimeError: async () => { runtimeErrorCommits += 1; },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await assert.rejects(instance.newSession("hook-fail"), /before hook failed/);
  assert.equal(instance.snapshot().lifecycle, "active");
  assert.equal(instance.runtimeGeneration, 1);
  assert.equal(initial.unsubscribeCalls, 0);
  assert.equal(initial.disposeCalls, 0);
  assert.equal(owner.disposeCalls, 0);
  assert.equal(runtimeErrorCommits, 0);
  await instance.stop("stop-1");
});

test("factory and bind failures fail closed without reviving stale sessions", async () => {
  for (const mode of ["factory-fail", "bind-fail"] as const) {
    const trace: string[] = [];
    const failures: string[] = [];
    const { host, owner, initial } = await runtimeHost(trace, (runtime) => { runtime.mode = mode; }, {
      commitRuntimeError: async (failure) => { failures.push(`${failure.operationId}:${failure.kind}`); },
    });
    const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
    host.activateInitial();

    await assert.rejects(instance.newSession(`op-${mode}`), new RegExp(mode === "factory-fail" ? "factory" : "bind"));
    const snapshot = instance.snapshot();
    assert.equal(snapshot.lifecycle, "runtime_error");
    assert.equal(snapshot.execution, "unavailable");
    assert.equal(snapshot.runtimeGeneration, 1);
    assert.equal(initial.unsubscribeCalls, 1);
    assert.equal(initial.disposeCalls, 1);
    assert.deepEqual(failures, [`op-${mode}:new`]);
    if (mode === "factory-fail") {
      assert.equal(owner.disposeCalls, 0);
    } else {
      assert.equal(owner.disposeCalls, 1);
      assert.equal(owner.candidate?.disposeCalls, 1);
      assert.equal(owner.candidate?.unsubscribeCalls, 1);
    }
    await instance.stop("stop-after-failure");
    assert.equal(owner.disposeCalls, mode === "factory-fail" ? 0 : 1);
  }
});

test("reload buffers events, commits before publication, and increments generation once", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.reloadEvent = { type: "reload_event" };
  }, {
    commitReplacement: async () => { trace.push("reload:commit"); },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  assert.deepEqual(await instance.reloadSession("reload-1"), { cancelled: false });
  assert.equal(instance.runtimeGeneration, 2);
  assert.equal(initial.bindCalls, 1);
  const events = instance.eventsSince().events;
  assert.equal(events[0]?.type, "session.replaced");
  assert.equal(events[0]?.data.reason, "reload");
  assert.ok(trace.indexOf("reload:commit") < trace.length);
  await instance.stop("stop-1");
});

test("reload refreshes model config, active model references, runtime settings, and network without restarting Host", async () => {
  const trace: string[] = [];
  const oldModel: FakeModel = { provider: "fixture", id: "model-a", name: "old", reasoning: true, contextWindow: 100 };
  const newModel: FakeModel = { provider: "fixture", id: "model-a", name: "new", reasoning: true, contextWindow: 372_000 };
  let catalogModel = oldModel;
  const modelRuntime = {
    reloadConfig: async () => { trace.push("model:reload"); },
    getAvailable: async () => [catalogModel],
    getModel: (provider: string, id: string) => provider === catalogModel.provider && id === catalogModel.id ? catalogModel : undefined,
    checkAuth: async () => ({ state: "available" }),
    getError: () => "model warning",
  };
  const reloadSettings = {
    getTransport: () => "websocket-cached" as const,
    getThinkingBudgets: () => ({ low: 2_048 }),
    getProviderRetrySettings: () => ({ maxRetryDelayMs: 321 }),
  };
  const { host, initial } = await runtimeHost(trace, (owner, session) => {
    session.model = oldModel;
    session.scopedModels = [{ model: oldModel, thinkingLevel: "high" }];
    session.reloadBeforeStart = () => { trace.push("extensions:rebuilt"); catalogModel = newModel; };
    owner.services = services({ settings: reloadSettings, modelRuntime });
  }, {
    configureNetwork: () => { trace.push("network:configure"); },
  });
  host.activateInitial();

  await host.reload("reload-runtime-config");

  assert.ok(trace.indexOf("model:reload") < trace.indexOf("initial:reload"));
  assert.ok(trace.indexOf("extensions:rebuilt") < trace.indexOf("network:configure"));
  assert.equal(initial.model, newModel);
  assert.equal(initial.scopedModels[0]?.model, newModel);
  assert.equal(initial.agent.transport, "websocket-cached");
  assert.deepEqual(initial.agent.thinkingBudgets, { low: 2_048 });
  assert.equal(initial.agent.maxRetryDelayMs, 321);
  assert.equal(trace.filter((entry) => entry === "network:configure").length, 1);
  assert.deepEqual((await host.getResources()).diagnostics.at(-1), {
    severity: "error", message: "model warning", source: "models.json",
  });
  await host.dispose();
});

test("reload failure disposes the unsafe runtime exactly once", async () => {
  const trace: string[] = [];
  const failures: string[] = [];
  const { host, owner, initial } = await runtimeHost(trace, (_runtime, session) => {
    session.reloadError = new Error("reload failed");
  }, {
    commitRuntimeError: async (failure) => { failures.push(`${failure.operationId}:${failure.kind}`); },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await assert.rejects(instance.reloadSession("reload-fail"), /reload failed/);
  assert.equal(instance.snapshot().lifecycle, "runtime_error");
  assert.equal(owner.disposeCalls, 1);
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(initial.disposeCalls, 1);
  assert.deepEqual(failures, ["reload-fail:reload"]);
  await instance.stop("stop-after-reload-failure");
  assert.equal(owner.disposeCalls, 1);
});

test("ManagedInstance rejects replacement while the runtime is busy", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace);
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();
  initial.isStreaming = true;

  await assert.rejects(instance.newSession("busy-replace"), /must be idle/);
  assert.equal(instance.runtimeGeneration, 1);
  assert.equal(initial.disposeCalls, 0);
  initial.isStreaming = false;
  await instance.stop("stop-1");
});

test("Pi runtime host isolates settings errors around model and thinking mutations", async () => {
  const trace: string[] = [];
  const settings = new FakeSettingsManager();
  const model: FakeModel = { provider: "fixture", id: "model-a", name: "Model A", reasoning: true };
  const { host, owner, initial } = await runtimeHost(trace, (runtime) => {
    runtime.services = services({ settings, model });
  });
  host.activateInitial();

  settings.errors.push({ scope: "project", error: new Error("old parse failure") });
  await assert.rejects(
    host.selectModel("fixture", "model-a"),
    (error: unknown) => error instanceof AgentSettingsWriteError
      && error.phase === "baseline"
      && error.mutationApplied === false,
  );
  assert.equal(initial.model, undefined);
  assert.deepEqual(settings.order, ["drain"]);

  settings.order.length = 0;
  await host.selectModel("fixture", "model-a");
  assert.equal(host.getModelState().model?.id, "model-a");
  assert.deepEqual(settings.order, ["drain", "flush", "drain"]);

  settings.order.length = 0;
  settings.flushError = new Error("flush failed");
  await assert.rejects(
    host.setThinkingLevel("high"),
    (error: unknown) => error instanceof AgentSettingsWriteError
      && error.phase === "write"
      && error.mutationApplied === true
      && error.errors[0]?.scope === "unknown",
  );
  assert.equal(initial.thinkingLevel, "high");
  assert.deepEqual(settings.order, ["drain", "flush", "drain"]);
  assert.equal(owner.services.settingsManager, settings as unknown as AgentSessionServices["settingsManager"]);
  await host.dispose();
});

test("Pi runtime host projects typed tool metadata without executable values or text guessing", async () => {
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, (_owner, session) => {
    session.activeToolNames = ["read"];
    session.allTools = [
      {
        name: "read",
        description: "data:image/png;base64,c2VjcmV0",
        parameters: { type: "object", safe: "value", bytes: Buffer.from("secret"), execute: () => undefined },
        promptGuidelines: ["must never cross wire"],
        sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
      },
      {
        name: "extension-tool",
        description: "Extension tool",
        parameters: { type: "object" },
        sourceInfo: { path: "/agent/extensions/tool.ts", source: "example-package", scope: "user", origin: "package" },
      },
    ];
  });
  host.activateInitial();

  const projection = await host.listTools();
  const tools = projection.tools;
  assert.deepEqual({ total: projection.total, truncated: projection.truncated }, { total: 2, truncated: false });
  assert.deepEqual(tools.map((tool) => tool.name), ["extension-tool", "read"]);
  const read = tools.find((tool) => tool.name === "read");
  assert.deepEqual(read?.source, { kind: "built-in" });
  assert.equal(read?.description, "data:image/png;base64,c2VjcmV0");
  assert.deepEqual(read?.parameterSchema, { type: "object", safe: "value" });
  assert.doesNotMatch(JSON.stringify(tools), /secret|promptGuidelines|execute/);
  assert.deepEqual(tools[0]?.source, { kind: "extension", path: "/agent/extensions/tool.ts", package: "example-package" });

  await assert.rejects(host.setActiveTools(["missing"]), /Unknown tool/);
  await assert.rejects(host.setActiveTools(["read", "read"]), /Duplicate tool name/);
  assert.equal(initial.toolSetCalls, 0);
  assert.deepEqual((await host.setActiveTools(["extension-tool"])).tools.filter((tool) => tool.active).map((tool) => tool.name), ["extension-tool"]);
  assert.equal(initial.toolSetCalls, 1);
  await host.dispose();
});

test("Pi runtime host projects executable resource and command metadata without bodies, handlers, or text guessing", async () => {
  const trace: string[] = [];
  const sourceInfo = { path: "/agent/extensions/example.ts", source: "example-package", scope: "user" as const, origin: "package" as const };
  const secondSource = { ...sourceInfo, path: "/agent/extensions/example-2.ts" };
  const command = (name: string, source = sourceInfo) => ({
    name,
    description: `${name} command`,
    sourceInfo: source,
    getArgumentCompletions: () => [],
    handler: async () => { throw new Error("must not run"); },
  });
  const resourceLoader = {
    getExtensions: () => ({
      extensions: [
        { path: sourceInfo.path, resolvedPath: sourceInfo.path, sourceInfo, commands: new Map([["safe", command("safe")]]) },
        { path: secondSource.path, resolvedPath: secondSource.path, sourceInfo: secondSource, commands: new Map([["safe", command("safe", secondSource)], ["safe:1", command("safe:1", secondSource)], ["unsafe", command("unsafe\u001b[2J", secondSource)]]) },
      ],
      errors: [{ path: "/agent/extensions/broken.ts", error: "data:image/png;base64,c2VjcmV0" }],
      runtime: {},
    }),
    getSkills: () => ({
      skills: [{ name: "skill-a", description: "Skill A", filePath: "/agent/skills/a/SKILL.md", sourceInfo: { ...sourceInfo, path: "/agent/skills/a/SKILL.md" } }],
      diagnostics: [{ type: "collision", message: "skill collision", path: "/agent/skills/a/SKILL.md" }],
    }),
    getPrompts: () => ({
      prompts: [{ name: "prompt-a", description: "Prompt", content: "TOP SECRET PROMPT", filePath: "/agent/prompts/a.md", sourceInfo: { ...sourceInfo, path: "/agent/prompts/a.md" } }],
      diagnostics: [{ type: "warning", message: "prompt warning", path: "/agent/prompts/a.md" }],
    }),
    getAgentsFiles: () => ({ agentsFiles: [{ path: "/project/AGENTS.md", content: "TOP SECRET CONTEXT" }] }),
  };
  const settings = SettingsManager.inMemory({ enableSkillCommands: true });
  const { host } = await runtimeHost(trace, (owner, session) => {
    owner.services = services({ resourceLoader, settings });
    session.registeredCommands = [
      { ...command("safe"), invocationName: "safe:1" },
      { ...command("safe", secondSource), invocationName: "safe:2" },
      { ...command("safe:1", secondSource), invocationName: "safe:1:2" },
      { ...command("unsafe\u001b[2J", secondSource), invocationName: "unsafe\u001b[2J" },
    ];
  });
  host.activateInitial();

  const result = await host.getResources();
  assert.deepEqual(result.resources.map((resource) => `${resource.kind}:${resource.name}`), [
    "context:AGENTS.md",
    "extension:example-2.ts",
    "extension:example.ts",
    "prompt:prompt-a",
    "skill:skill-a",
  ]);
  assert.equal(result.diagnostics.length, 3);
  assert.equal(result.diagnostics[0]?.message, "data:image/png;base64,c2VjcmV0");
  assert.doesNotMatch(JSON.stringify(result), /TOP SECRET|handler/);
  const commands = await host.getCommands();
  assert.deepEqual(commands.map((item) => `${item.source.kind}:${item.name}`), [
    "prompt:prompt-a",
    "extension:safe:1",
    "extension:safe:1:2",
    "extension:safe:2",
    "skill:skill:skill-a",
  ]);
  assert.equal(commands.find((item) => item.name === "safe:1")?.argumentCompletions, true);
  assert.equal(host.classifyInput("/safe:1 value"), "extension_command");
  assert.equal(host.classifyInput("/safe value"), "prompt");
  assert.equal(host.classifyInput("/prompt-a"), "prompt");
  assert.equal(host.classifyInput("/skill:skill-a"), "prompt");
  assert.doesNotMatch(JSON.stringify(commands), /handler|TOP SECRET|\u001b/);
  settings.setEnableSkillCommands(false);
  assert.equal((await host.getCommands()).some((item) => item.source.kind === "skill"), false);
  await host.dispose();
});

test("Pi runtime host exposes and persists the exact general-settings allowlist", async () => {
  const trace: string[] = [];
  const manager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 165_536, keepRecentTokens: 20_000 }, retry: { enabled: true }, enableSkillCommands: true,
    hideThinkingBlock: false, showCacheMissNotices: false, showHardwareCursor: false,
    terminal: { clearOnShrink: true, showTerminalProgress: true }, quietStartup: false,
    collapseChangelog: false, enableInstallTelemetry: true,
    steeringMode: "all", followUpMode: "all", transport: "auto", doubleEscapeAction: "tree",
    treeFilterMode: "default", defaultProjectTrust: "ask", httpIdleTimeoutMs: 300_000,
    editorPaddingX: 1, outputPad: 0, autocompleteMaxVisible: 10,
    warnings: { anthropicExtraUsage: false },
  });
  let configuredTimeout: number | undefined;
  const { host, initial } = await runtimeHost(trace, (owner, session) => {
    session.settingsManager = manager;
    owner.services = services({ settings: manager });
  }, {
    configureNetwork: (settingsManager) => { configuredTimeout = settingsManager.getHttpIdleTimeoutMs(); },
  });
  host.activateInitial();

  const settings = await host.getSettings();
  assert.equal(settings.length, SETTING_KEYS.length);
  assert.deepEqual(settings.map((setting) => setting.key), [
    "autoCompaction", "compactionReserveTokens", "compactionKeepRecentTokens", "autoRetry", "enableSkillCommands", "hideThinking", "showCacheMissNotices",
    "showHardwareCursor", "clearOnShrink", "showTerminalProgress", "quietStartup", "collapseChangelog", "enableInstallTelemetry", "steeringMode",
    "followUpMode", "transport", "doubleEscapeAction", "treeFilterMode", "defaultProjectTrust",
    "httpIdleTimeoutMs", "editorPaddingX", "outputPad", "autocompleteMaxVisible", "warnings",
  ]);
  assert.ok(settings.every((setting) => setting.source === "global"));
  assert.deepEqual(settings.filter((setting) => !setting.writable).map((setting) => [setting.key, setting.value]), [
    ["compactionReserveTokens", 165_536],
    ["compactionKeepRecentTokens", 20_000],
  ]);
  assert.equal(settings.find((setting) => setting.key === "enableSkillCommands")?.reloadRequired, true);
  assert.equal(settings.find((setting) => setting.key === "httpIdleTimeoutMs")?.hostRestartRequired, false);

  const updates = [
    { key: "autoCompaction", value: false }, { key: "autoRetry", value: false },
    { key: "enableSkillCommands", value: false }, { key: "hideThinking", value: true },
    { key: "showCacheMissNotices", value: true }, { key: "showHardwareCursor", value: true },
    { key: "clearOnShrink", value: false }, { key: "showTerminalProgress", value: false },
    { key: "quietStartup", value: true }, { key: "collapseChangelog", value: true },
    { key: "enableInstallTelemetry", value: false }, { key: "steeringMode", value: "one-at-a-time" },
    { key: "followUpMode", value: "one-at-a-time" }, { key: "transport", value: "websocket" },
    { key: "doubleEscapeAction", value: "fork" }, { key: "treeFilterMode", value: "all" },
    { key: "defaultProjectTrust", value: "never" }, { key: "httpIdleTimeoutMs", value: 1234 },
    { key: "editorPaddingX", value: 3 }, { key: "outputPad", value: 1 },
    { key: "autocompleteMaxVisible", value: 20 }, { key: "warnings", value: { anthropicExtraUsage: true } },
  ] as const;
  for (const update of updates) {
    const projected = await host.updateSetting(update);
    assert.equal(projected.key, update.key);
    assert.deepEqual(projected.value, update.value);
  }
  assert.equal(initial.steeringMode, "one-at-a-time");
  assert.equal(initial.followUpMode, "one-at-a-time");
  assert.equal(initial.agent.transport, "websocket");
  assert.equal(configuredTimeout, 1234);
  await host.dispose();
});

test("settings projection rejects malformed effective Pi values without reflecting them", async () => {
  const cases: Array<{ global: Record<string, unknown>; project?: Record<string, unknown>; key: string }> = [
    { global: { hideThinkingBlock: "yes" }, key: "hideThinking" },
    { global: { steeringMode: "invalid" }, key: "steeringMode" },
    { global: { editorPaddingX: 99 }, key: "editorPaddingX" },
    { global: { httpIdleTimeoutMs: 3_000_000_000 }, key: "httpIdleTimeoutMs" },
    { global: { warnings: { unknownWarning: true } }, key: "warnings" },
    { global: {}, project: { autocompleteMaxVisible: 100 }, key: "autocompleteMaxVisible" },
  ];
  for (const fixture of cases) {
    const trace: string[] = [];
    const manager = settingsManagerFromRaw(fixture.global, fixture.project, fixture.project !== undefined);
    const { host } = await runtimeHost(trace, (owner) => { owner.services = services({ settings: manager }); });
    host.activateInitial();
    await assert.rejects(
      host.getSettings(),
      (error: unknown) => error instanceof AgentInvalidSettingValueError
        && error.setting === fixture.key
        && error.message === `Pi setting ${fixture.key} has an invalid effective value`,
    );
    await host.dispose();
  }
});

test("settings source attribution follows Pi's effective global/project semantics", async () => {
  const trace: string[] = [];
  const manager = settingsManagerFromRaw(
    { defaultProjectTrust: "never", steeringMode: "all" },
    { defaultProjectTrust: "always", steeringMode: "one-at-a-time" },
    true,
  );
  const { host } = await runtimeHost(trace, (owner) => { owner.services = services({ settings: manager }); });
  host.activateInitial();
  const settings = await host.getSettings();
  assert.deepEqual(settings.find((setting) => setting.key === "defaultProjectTrust"), {
    key: "defaultProjectTrust", value: "never", source: "global", writable: true, valueType: "enum",
    allowedValues: ["ask", "always", "never"], reloadRequired: false, hostRestartRequired: false,
  });
  assert.equal(settings.find((setting) => setting.key === "steeringMode")?.value, "one-at-a-time");
  assert.equal(settings.find((setting) => setting.key === "steeringMode")?.source, "project");
  await host.dispose();
});

test("projection caps select canonical membership before slicing", async () => {
  const trace: string[] = [];
  const sourceInfo = { path: "/fixture/source", source: "fixture", scope: "temporary" as const, origin: "top-level" as const };
  const names = Array.from({ length: 2_001 }, (_, index) => `item-${String(index).padStart(4, "0")}`);
  let ordered = [...names];
  const prompts = () => ordered.map((name) => ({ name, description: name, content: "omitted", filePath: `/prompts/${name}.md`, sourceInfo }));
  const diagnostics = () => ordered.map((name) => ({ type: "warning", message: name, path: `/prompts/${name}.md` }));
  const contexts = () => ordered.map((name) => ({ path: `/contexts/${name}.md`, content: "omitted" }));
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: prompts(), diagnostics: diagnostics() }),
    getAgentsFiles: () => ({ agentsFiles: contexts() }),
  };
  const manager = SettingsManager.inMemory({ enableSkillCommands: false });
  const { host, initial } = await runtimeHost(trace, (owner, session) => {
    session.allTools = ordered.map((name) => ({ name, description: name, parameters: {}, sourceInfo }));
    owner.services = services({ resourceLoader, settings: manager });
  });
  host.activateInitial();

  const firstToolProjection = await host.listTools();
  const firstTools = firstToolProjection.tools.map((tool) => tool.name);
  const firstResources = (await host.getResources()).resources.map((resource) => resource.name);
  const firstDiagnostics = (await host.getResources()).diagnostics.map((diagnostic) => diagnostic.message);
  const firstCommands = (await host.getCommands()).map((command) => command.name);
  ordered = [...names].reverse();
  initial.allTools = ordered.map((name) => ({ name, description: name, parameters: {}, sourceInfo }));
  const reversedToolProjection = await host.listTools();
  assert.deepEqual(reversedToolProjection.tools.map((tool) => tool.name), firstTools);
  assert.deepEqual({ total: reversedToolProjection.total, truncated: reversedToolProjection.truncated }, { total: 2_001, truncated: true });
  assert.deepEqual((await host.getResources()).resources.map((resource) => resource.name), firstResources);
  assert.deepEqual((await host.getResources()).diagnostics.map((diagnostic) => diagnostic.message), firstDiagnostics);
  assert.deepEqual((await host.getCommands()).map((command) => command.name), firstCommands);
  assert.equal(firstTools.at(-1), "item-1999");
  assert.equal(firstCommands.at(-1), "item-2000", "ManagedInstance, not the Pi adapter, owns command completeness bounds");
  await host.setActiveTools(["item-2000"]);
  assert.equal(initial.toolSetCalls, 1, "tool validation uses the complete Pi registry, not the projected prefix");
  await host.setActiveTools(["item-1999"]);
  assert.equal(initial.toolSetCalls, 2);
  await host.dispose();
});

test("general setting persistence preserves baseline/write attribution and honest events", async () => {
  const trace: string[] = [];
  const manager = SettingsManager.inMemory({ enableSkillCommands: true });
  const calls: string[] = [];
  const originalDrain = manager.drainErrors.bind(manager);
  const originalSetter = manager.setEnableSkillCommands.bind(manager);
  const originalSteeringSetter = manager.setSteeringMode.bind(manager);
  const originalFlush = manager.flush.bind(manager);
  manager.drainErrors = () => { calls.push("drain"); return originalDrain(); };
  manager.setEnableSkillCommands = (value) => { calls.push("setter"); originalSetter(value); };
  manager.setSteeringMode = (value) => { calls.push("setter"); originalSteeringSetter(value); };
  manager.flush = async () => { calls.push("flush"); await originalFlush(); };
  const { host, initial } = await runtimeHost(trace, (owner, session) => {
    session.settingsManager = manager;
    owner.services = services({ settings: manager });
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await instance.updateSetting({ key: "enableSkillCommands", value: false });
  assert.deepEqual(calls, ["drain", "setter", "flush", "drain"]);

  calls.length = 0;
  manager.flush = async () => { calls.push("flush"); throw new Error("write failed"); };
  await assert.rejects(
    instance.updateSetting({ key: "steeringMode", value: "one-at-a-time" }),
    (error: unknown) => error instanceof AgentSettingsWriteError && error.mutationApplied,
  );
  assert.equal(initial.steeringMode, "one-at-a-time");
  const events = instance.eventsSince().events;
  assert.equal(events.filter((event) => event.type === "settings.changed").at(-1)?.data.value, "one-at-a-time");
  assert.equal(events.at(-1)?.type, "settings.write_failed");
  assert.deepEqual(calls, ["drain", "setter", "flush", "drain"]);

  await assert.rejects(
    instance.updateSetting({ key: "transport", value: "websocket" }),
    (error: unknown) => error instanceof AgentSettingsWriteError && error.mutationApplied,
  );
  assert.equal(initial.agent.transport, "auto", "failed persistence must not change the live transport");
  await instance.stop("stop-1");
});

test("Pi SettingsManager keeps native field merge, LWW, and stale snapshots", async () => {
  let global: string | undefined;
  let project: string | undefined;
  const storage = {
    withLock(scope: "global" | "project", mutate: (current: string | undefined) => string | undefined): void {
      const next = mutate(scope === "global" ? global : project);
      if (next !== undefined) {
        if (scope === "global") global = next;
        else project = next;
      }
    },
  };
  const first = SettingsManager.fromStorage(storage);
  const second = SettingsManager.fromStorage(storage);
  first.setQuietStartup(true);
  await first.flush();
  second.setHideThinkingBlock(true);
  await second.flush();
  const fresh = SettingsManager.fromStorage(storage);
  assert.equal(fresh.getQuietStartup(), true);
  assert.equal(fresh.getHideThinkingBlock(), true);
  assert.equal(first.getHideThinkingBlock(), false);
  await first.reload();
  assert.equal(first.getHideThinkingBlock(), true);

  first.setQuietStartup(false);
  await first.flush();
  second.setQuietStartup(true);
  await second.flush();
  assert.equal(SettingsManager.fromStorage(storage).getQuietStartup(), true);
});

test("Pi runtime host selects default and custom session catalog branches", async () => {
  const calls: string[] = [];
  const catalog: PiSessionCatalog = {
    list: async (cwd, sessionDir) => {
      calls.push(`list:${cwd}:${String(sessionDir)}`);
      return [{ id: "cwd", path: "/sessions/cwd.jsonl", cwd, modified: new Date("2026-07-14T00:00:00.000Z") }];
    },
    listAll: async (sessionDir) => {
      calls.push(`all:${String(sessionDir)}`);
      return [{ id: "all", path: "/sessions/all.jsonl", cwd: "/other", modified: new Date(Number.NaN) }];
    },
  };
  const trace: string[] = [];
  const { host, initial } = await runtimeHost(trace, undefined, { sessionCatalog: catalog });
  host.activateInitial();
  assert.equal((await host.listSessions("cwd"))[0]?.updatedAt, "2026-07-14T00:00:00.000Z");
  assert.equal((await host.listSessions("all"))[0]?.updatedAt, undefined);
  initial.usesDefaultSessionDir = false;
  await host.listSessions("all");
  assert.deepEqual(calls, ["list:/project:/sessions", "all:undefined", "all:/sessions"]);
  await host.dispose();
});

test("rejected runtime disposal still invalidates every binding", async () => {
  const trace: string[] = [];
  const { host, owner, initial } = await runtimeHost(trace, (runtime) => {
    runtime.disposeErrorBeforeInvalidate = new Error("shutdown hook failed");
  });
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  await assert.rejects(
    instance.stop("stop-1"),
    (error: unknown) => error instanceof RuntimeEffectUnknownError && error.operationId === "stop-1",
  );
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(owner.disposeCalls, 1);
  assert.equal(instance.snapshot().lifecycle, "stopping");
  assert.equal(instance.snapshot().reopenable, false);
});

test("stop awaits the runtime owner shutdown before reporting stopped", async () => {
  const trace: string[] = [];
  const { host } = await runtimeHost(trace);
  const instance = new ManagedInstance({ cwd: "/project", session: localConnection(host), initialHistory: host.getHistory() });
  host.activateInitial();

  const receipt = await instance.stop("stop-1");
  assert.equal(receipt.stopped, true);
  assert.deepEqual(trace.slice(-3), ["runtime:shutdown", "initial:unsubscribe", "initial:dispose"]);
  assert.equal(instance.snapshot().lifecycle, "stopped");
});
