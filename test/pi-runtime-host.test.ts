import assert from "node:assert/strict";
import test from "node:test";

import {
  SettingsManager,
  type AgentSession,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import { ManagedInstance } from "../src/core/managed-instance.js";
import { RuntimeInvalidSettingValueError, RuntimeSettingsWriteError } from "../src/core/runtime-session.js";
import {
  PiRuntimeHost,
  type PiRuntimeHostOptions,
  type PiSessionCatalog,
} from "../src/pi/pi-runtime-host.js";

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

class FakeSession {
  readonly listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  readonly sessionManager = {
    getCwd: () => "/project",
    getSessionDir: () => "/sessions",
    usesDefaultSessionDir: () => this.usesDefaultSessionDir,
  };
  usesDefaultSessionDir = true;
  isStreaming = false;
  model: FakeModel | undefined;
  thinkingLevel: "off" | "high" = "off";
  steeringMode: "all" | "one-at-a-time" = "all";
  followUpMode: "all" | "one-at-a-time" = "all";
  settingsManager: SettingsManager | undefined;
  bindError: Error | undefined;
  bindEvent: { type: string; [key: string]: unknown } | undefined;
  reloadError: Error | undefined;
  reloadEvent: { type: string; [key: string]: unknown } | undefined;
  bindCalls = 0;
  disposeCalls = 0;
  unsubscribeCalls = 0;
  toolSetCalls = 0;
  activeToolNames: string[] = [];
  allTools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    promptGuidelines?: unknown;
    sourceInfo: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string };
  }> = [];

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly trace: string[],
  ) {}

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

  prompt(): Promise<void> { return Promise.resolve(); }
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
  getActiveToolNames(): string[] { return [...this.activeToolNames]; }
  getAllTools(): typeof this.allTools { return [...this.allTools]; }
  setActiveToolsByName(names: string[]): void {
    this.toolSetCalls += 1;
    this.activeToolNames = [...names];
  }
  clearQueue(): { steering: string[]; followUp: string[] } { return { steering: [], followUp: [] }; }
  abort(): Promise<void> { return Promise.resolve(); }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  setSessionName(): void {}
  async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
    this.trace.push(`${this.sessionId}:reload`);
    if (this.reloadError) throw this.reloadError;
    await options?.beforeSessionStart?.();
    if (this.reloadEvent) this.emit(this.reloadEvent);
  }

  markDisposed(): void {
    this.disposeCalls += 1;
    this.trace.push(`${this.sessionId}:dispose`);
  }
}

class FakeSettingsManager {
  readonly order: string[] = [];
  errors: Array<{ scope: "global" | "project"; error: Error }> = [];
  flushError: Error | undefined;

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

function services(options: { settings?: unknown; model?: FakeModel; cwd?: string; resourceLoader?: unknown } = {}): AgentSessionServices {
  const settings = options.settings ?? new FakeSettingsManager();
  const model = options.model;
  return {
    cwd: options.cwd ?? "/project",
    agentDir: "/agent",
    authStorage: {} as AgentSessionServices["authStorage"],
    settingsManager: settings as unknown as AgentSessionServices["settingsManager"],
    modelRegistry: {
      getAvailable: () => model ? [model] : [],
      find: (provider: string, id: string) => model?.provider === provider && model.id === id ? model : undefined,
      hasConfiguredAuth: (candidate: FakeModel) => candidate === model,
    } as unknown as AgentSessionServices["modelRegistry"],
    resourceLoader: (options.resourceLoader ?? {}) as AgentSessionServices["resourceLoader"],
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

  constructor(readonly initial: FakeSession, private readonly trace: string[]) {
    this.session = initial as unknown as AgentSession;
    this.services = services();
  }

  get cwd(): string { return this.services.cwd; }
  setBeforeSessionInvalidate(callback?: () => void): void { this.beforeInvalidate = callback; }
  setRebindSession(callback?: (session: AgentSession) => Promise<void>): void { this.rebind = callback; }

  newSession(): Promise<{ cancelled: boolean }> { return this.replace("new"); }
  switchSession(): Promise<{ cancelled: boolean }> { return this.replace("switch"); }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.trace.push("runtime:shutdown");
    if (this.disposeErrorBeforeInvalidate) throw this.disposeErrorBeforeInvalidate;
    this.beforeInvalidate?.();
    (this.session as unknown as FakeSession).markDisposed();
  }

  private async replace(kind: "new" | "switch"): Promise<{ cancelled: boolean }> {
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

async function runtimeHost(
  trace: string[],
  configure: (owner: FakeRuntimeOwner, initial: FakeSession) => void = () => {},
  options: Omit<PiRuntimeHostOptions, "runtime"> = {},
): Promise<{ host: PiRuntimeHost; owner: FakeRuntimeOwner; initial: FakeSession }> {
  const initial = new FakeSession("initial", "/sessions/initial.jsonl", trace);
  const owner = new FakeRuntimeOwner(initial, trace);
  configure(owner, initial);
  const host = await PiRuntimeHost.create({
    ...options,
    runtime: owner as unknown as PiRuntimeHostOptions["runtime"],
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
    session: host,
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

test("switch applies pre-resolved target trust before SDK hooks", async () => {
  const trace: string[] = [];
  const trustCalls: string[] = [];
  const { host } = await runtimeHost(trace, undefined, {
    setProjectTrust: (cwd, trusted) => {
      trustCalls.push(`${cwd}:${String(trusted)}`);
      trace.push("trust:resolved");
    },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
  host.activateInitial();

  assert.deepEqual(await instance.newSession("cancel-1"), { cancelled: true });
  assert.equal(instance.runtimeGeneration, 1);
  assert.equal(initial.unsubscribeCalls, 0);
  assert.equal(initial.disposeCalls, 0);
  assert.equal(owner.candidate, undefined);
  await instance.stop("stop-1");
});

test("replacement commit failure disposes the candidate before runtime_error publication", async () => {
  const trace: string[] = [];
  let runtimeErrorCommits = 0;
  const { host, owner } = await runtimeHost(trace, undefined, {
    commitReplacement: async () => { throw new Error("catalog commit failed"); },
    commitRuntimeError: async () => { runtimeErrorCommits += 1; },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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
    const instance = new ManagedInstance({ cwd: "/project", session: host });
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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

test("reload failure disposes the unsafe runtime exactly once", async () => {
  const trace: string[] = [];
  const failures: string[] = [];
  const { host, owner, initial } = await runtimeHost(trace, (_runtime, session) => {
    session.reloadError = new Error("reload failed");
  }, {
    commitRuntimeError: async (failure) => { failures.push(`${failure.operationId}:${failure.kind}`); },
  });
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
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
    (error: unknown) => error instanceof RuntimeSettingsWriteError
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
    (error: unknown) => error instanceof RuntimeSettingsWriteError
      && error.phase === "write"
      && error.mutationApplied === true
      && error.errors[0]?.scope === "unknown",
  );
  assert.equal(initial.thinkingLevel, "high");
  assert.deepEqual(settings.order, ["drain", "flush", "drain"]);
  assert.equal(owner.services.settingsManager, settings as unknown as AgentSessionServices["settingsManager"]);
  await host.dispose();
});

test("Pi runtime host projects tools without executable or binary payloads", async () => {
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

  const tools = await host.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["extension-tool", "read"]);
  const read = tools.find((tool) => tool.name === "read");
  assert.deepEqual(read?.source, { kind: "built-in" });
  assert.equal(read?.description, "Tool description omitted");
  assert.deepEqual(read?.parameterSchema, { type: "object", safe: "value" });
  assert.doesNotMatch(JSON.stringify(tools), /data:image|secret|promptGuidelines|execute/);
  assert.deepEqual(tools[0]?.source, { kind: "extension", path: "/agent/extensions/tool.ts", package: "example-package" });

  await assert.rejects(host.setActiveTools(["missing"]), /Unknown tool/);
  await assert.rejects(host.setActiveTools(["read", "read"]), /Duplicate tool name/);
  assert.equal(initial.toolSetCalls, 0);
  assert.deepEqual((await host.setActiveTools(["extension-tool"])).filter((tool) => tool.active).map((tool) => tool.name), ["extension-tool"]);
  assert.equal(initial.toolSetCalls, 1);
  await host.dispose();
});

test("Pi runtime host projects executable resource and command metadata without bodies or handlers", async () => {
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
        { path: secondSource.path, resolvedPath: secondSource.path, sourceInfo: secondSource, commands: new Map([["safe", command("safe", secondSource)], ["safe:1", command("safe:1", secondSource)]]) },
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
  const { host } = await runtimeHost(trace, (owner) => {
    owner.services = services({ resourceLoader, settings });
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
  assert.equal(result.diagnostics[0]?.message, "Extension load failure omitted");
  assert.doesNotMatch(JSON.stringify(result), /data:image|TOP SECRET|handler/);
  const commands = await host.getCommands();
  assert.deepEqual(commands.map((item) => `${item.source.kind}:${item.name}`), [
    "prompt:prompt-a",
    "extension:safe:1",
    "extension:safe:1:2",
    "extension:safe:2",
    "skill:skill:skill-a",
  ]);
  assert.equal(commands.find((item) => item.name === "safe:1")?.argumentCompletions, true);
  assert.doesNotMatch(JSON.stringify(commands), /handler|TOP SECRET/);
  settings.setEnableSkillCommands(false);
  assert.equal((await host.getCommands()).some((item) => item.source.kind === "skill"), false);
  await host.dispose();
});

test("Pi runtime host exposes and persists the exact general-settings allowlist", async () => {
  const trace: string[] = [];
  const manager = SettingsManager.inMemory({
    compaction: { enabled: true }, retry: { enabled: true }, enableSkillCommands: true,
    hideThinkingBlock: false, showCacheMissNotices: false, showHardwareCursor: false,
    terminal: { clearOnShrink: true, showTerminalProgress: true }, quietStartup: false,
    steeringMode: "all", followUpMode: "all", transport: "auto", doubleEscapeAction: "tree",
    treeFilterMode: "default", defaultProjectTrust: "ask", httpIdleTimeoutMs: 300_000,
    editorPaddingX: 1, outputPad: 0, autocompleteMaxVisible: 10,
    warnings: { anthropicExtraUsage: false },
  });
  const { host, initial } = await runtimeHost(trace, (owner, session) => {
    session.settingsManager = manager;
    owner.services = services({ settings: manager });
  });
  host.activateInitial();

  const settings = await host.getSettings();
  assert.equal(settings.length, 20);
  assert.deepEqual(settings.map((setting) => setting.key), [
    "autoCompaction", "autoRetry", "enableSkillCommands", "hideThinking", "showCacheMissNotices",
    "showHardwareCursor", "clearOnShrink", "showTerminalProgress", "quietStartup", "steeringMode",
    "followUpMode", "transport", "doubleEscapeAction", "treeFilterMode", "defaultProjectTrust",
    "httpIdleTimeoutMs", "editorPaddingX", "outputPad", "autocompleteMaxVisible", "warnings",
  ]);
  assert.ok(settings.every((setting) => setting.source === "global"));
  assert.equal(settings.find((setting) => setting.key === "enableSkillCommands")?.reloadRequired, true);
  assert.equal(settings.find((setting) => setting.key === "httpIdleTimeoutMs")?.hostRestartRequired, true);

  const updates = [
    { key: "autoCompaction", value: false }, { key: "autoRetry", value: false },
    { key: "enableSkillCommands", value: false }, { key: "hideThinking", value: true },
    { key: "showCacheMissNotices", value: true }, { key: "showHardwareCursor", value: true },
    { key: "clearOnShrink", value: false }, { key: "showTerminalProgress", value: false },
    { key: "quietStartup", value: true }, { key: "steeringMode", value: "one-at-a-time" },
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
      (error: unknown) => error instanceof RuntimeInvalidSettingValueError
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

  const firstTools = (await host.listTools()).map((tool) => tool.name);
  const firstResources = (await host.getResources()).resources.map((resource) => resource.name);
  const firstDiagnostics = (await host.getResources()).diagnostics.map((diagnostic) => diagnostic.message);
  const firstCommands = (await host.getCommands()).map((command) => command.name);
  ordered = [...names].reverse();
  initial.allTools = ordered.map((name) => ({ name, description: name, parameters: {}, sourceInfo }));
  assert.deepEqual((await host.listTools()).map((tool) => tool.name), firstTools);
  assert.deepEqual((await host.getResources()).resources.map((resource) => resource.name), firstResources);
  assert.deepEqual((await host.getResources()).diagnostics.map((diagnostic) => diagnostic.message), firstDiagnostics);
  assert.deepEqual((await host.getCommands()).map((command) => command.name), firstCommands);
  assert.equal(firstTools.at(-1), "item-1999");
  assert.equal(firstCommands.at(-1), "item-1999");
  await assert.rejects(host.setActiveTools(["item-2000"]), /Unknown tool/);
  assert.equal(initial.toolSetCalls, 0);
  await host.setActiveTools(["item-1999"]);
  assert.equal(initial.toolSetCalls, 1);
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
  host.activateInitial();

  await instance.updateSetting({ key: "enableSkillCommands", value: false });
  assert.deepEqual(calls, ["drain", "setter", "flush", "drain"]);

  calls.length = 0;
  manager.flush = async () => { calls.push("flush"); throw new Error("write failed"); };
  await assert.rejects(
    instance.updateSetting({ key: "steeringMode", value: "one-at-a-time" }),
    (error: unknown) => error instanceof RuntimeSettingsWriteError && error.mutationApplied,
  );
  assert.equal(initial.steeringMode, "one-at-a-time");
  const events = instance.eventsSince().events;
  assert.equal(events.filter((event) => event.type === "settings.changed").at(-1)?.data.value, "one-at-a-time");
  assert.equal(events.at(-1)?.type, "settings.write_failed");
  assert.deepEqual(calls, ["drain", "setter", "flush", "drain"]);
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
  const instance = new ManagedInstance({ cwd: "/project", session: host });
  host.activateInitial();

  const receipt = await instance.stop("stop-1");
  assert.deepEqual(receipt.cleanupErrors, ["dispose: shutdown hook failed"]);
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(owner.disposeCalls, 1);
  assert.equal(instance.snapshot().lifecycle, "stopped");
});

test("stop awaits the runtime owner shutdown before reporting stopped", async () => {
  const trace: string[] = [];
  const { host } = await runtimeHost(trace);
  const instance = new ManagedInstance({ cwd: "/project", session: host });
  host.activateInitial();

  const receipt = await instance.stop("stop-1");
  assert.equal(receipt.stopped, true);
  assert.deepEqual(trace.slice(-3), ["runtime:shutdown", "initial:unsubscribe", "initial:dispose"]);
  assert.equal(instance.snapshot().lifecycle, "stopped");
});
