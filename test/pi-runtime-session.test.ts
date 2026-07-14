import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { RuntimeSettingsWriteError } from "../src/core/runtime-session.js";
import {
  PiRuntimeSession,
  type PiSessionCatalog,
} from "../src/pi/pi-runtime-session.js";

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
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

class FakeAgentSession {
  readonly sessionId = "pi-session";
  readonly sessionFile = "/sessions/current.jsonl";
  isStreaming = false;
  thinkingLevel: "off" | "high" = "off";
  model: FakeModel | undefined;
  setModelCalls = 0;
  setThinkingCalls = 0;
  onSetModel: (() => void) | undefined;
  onSetThinking: (() => void) | undefined;

  subscribe(): () => void { return () => {}; }
  prompt(): Promise<void> { return Promise.resolve(); }
  async setModel(model: FakeModel): Promise<void> {
    this.setModelCalls += 1;
    this.model = model;
    this.onSetModel?.();
  }
  setThinkingLevel(level: "off" | "high"): void {
    this.setThinkingCalls += 1;
    this.thinkingLevel = level;
    this.onSetThinking?.();
  }
  getAvailableThinkingLevels(): Array<"off" | "high"> { return ["off", "high"]; }
  clearQueue(): { steering: string[]; followUp: string[] } { return { steering: [], followUp: [] }; }
  abort(): Promise<void> { return Promise.resolve(); }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  dispose(): void {}
}

function createAdapter(options: {
  settings?: FakeSettingsManager;
  session?: FakeAgentSession;
  usesDefaultSessionDir?: boolean;
  catalog?: PiSessionCatalog;
} = {}): {
  adapter: PiRuntimeSession;
  session: FakeAgentSession;
  settings: FakeSettingsManager;
} {
  const settings = options.settings ?? new FakeSettingsManager();
  const session = options.session ?? new FakeAgentSession();
  const model: FakeModel = {
    provider: "fixture",
    id: "model-a",
    name: "Model A",
    reasoning: true,
  };
  const modelRegistry = {
    getAvailable: () => [model],
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;
  const sessionManager = {
    getCwd: () => "/project",
    getSessionDir: () => "/sessions/project",
    usesDefaultSessionDir: () => options.usesDefaultSessionDir ?? true,
  } as Pick<SessionManager, "getCwd" | "getSessionDir" | "usesDefaultSessionDir">;
  const catalog = options.catalog ?? {
    list: async () => [],
    listAll: async () => [],
  };
  const adapter = new PiRuntimeSession(
    session as unknown as AgentSession,
    modelRegistry,
    settings as unknown as Pick<SettingsManager, "flush" | "drainErrors">,
    sessionManager,
    catalog,
  );
  return { adapter, session, settings };
}

test("Pi adapter isolates pre-existing settings errors before model side effects", async () => {
  const settings = new FakeSettingsManager();
  settings.errors.push({ scope: "project", error: new Error("old project parse failure") });
  const { adapter, session } = createAdapter({ settings });

  await assert.rejects(
    adapter.selectModel("fixture", "model-a"),
    (error: unknown) => error instanceof RuntimeSettingsWriteError
      && error.phase === "baseline"
      && error.mutationApplied === false
      && error.errors[0]?.scope === "project",
  );
  assert.equal(session.setModelCalls, 0);
  assert.deepEqual(settings.order, ["drain"]);

  settings.order.length = 0;
  const state = await adapter.selectModel("fixture", "model-a");
  assert.equal(state.model?.id, "model-a");
  assert.equal(session.setModelCalls, 1);
  assert.deepEqual(settings.order, ["drain", "flush", "drain"]);
});

test("Pi adapter attributes only post-mutation settings failures", async () => {
  const settings = new FakeSettingsManager();
  const session = new FakeAgentSession();
  session.onSetModel = () => {
    settings.errors.push({ scope: "global", error: new Error("new model write failure") });
  };
  const { adapter } = createAdapter({ settings, session });

  await assert.rejects(
    adapter.selectModel("fixture", "model-a"),
    (error: unknown) => error instanceof RuntimeSettingsWriteError
      && error.phase === "write"
      && error.mutationApplied === true
      && error.errors[0]?.scope === "global",
  );
  assert.equal(session.model?.id, "model-a");
  assert.deepEqual(settings.order, ["drain", "flush", "drain"]);

  const flushSettings = new FakeSettingsManager();
  flushSettings.flushError = new Error("flush rejected");
  const flushSession = new FakeAgentSession();
  const { adapter: flushAdapter } = createAdapter({ settings: flushSettings, session: flushSession });
  await assert.rejects(
    flushAdapter.setThinkingLevel("high"),
    (error: unknown) => error instanceof RuntimeSettingsWriteError
      && error.phase === "write"
      && error.mutationApplied === true
      && error.errors[0]?.scope === "unknown",
  );
  assert.equal(flushSession.thinkingLevel, "high");
  assert.deepEqual(flushSettings.order, ["drain", "flush", "drain"]);
});

test("Pi adapter selects default and custom session catalog branches", async () => {
  const calls: string[] = [];
  const catalog: PiSessionCatalog = {
    list: async (cwd, sessionDir) => {
      calls.push(`list:${cwd}:${String(sessionDir)}`);
      return [{
        id: "cwd-session",
        path: "/sessions/project/cwd.jsonl",
        cwd,
        name: "Current",
        modified: new Date("2026-07-14T01:02:03.000Z"),
      }];
    },
    listAll: async (sessionDir) => {
      calls.push(`all:${String(sessionDir)}`);
      return [{
        id: "all-session",
        path: "/sessions/all.jsonl",
        cwd: "/other",
        modified: new Date(Number.NaN),
      }];
    },
  };

  const { adapter: defaultAdapter } = createAdapter({
    usesDefaultSessionDir: true,
    catalog,
  });
  assert.equal((await defaultAdapter.listSessions("cwd"))[0]?.updatedAt, "2026-07-14T01:02:03.000Z");
  assert.equal((await defaultAdapter.listSessions("all"))[0]?.updatedAt, undefined);

  const { adapter: customAdapter } = createAdapter({
    usesDefaultSessionDir: false,
    catalog,
  });
  await customAdapter.listSessions("cwd");
  await customAdapter.listSessions("all");

  assert.deepEqual(calls, [
    "list:/project:/sessions/project",
    "all:undefined",
    "list:/project:/sessions/project",
    "all:/sessions/project",
  ]);
});
