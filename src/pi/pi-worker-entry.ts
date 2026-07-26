import { resolve } from "node:path";

import { createPiRuntimeHost, type PiRuntimeHost } from "./pi-runtime-host.js";
import { openValidatedPiSession } from "./pi-session-target.js";
import { WorkerExtensionUiEndpoint } from "./worker-extension-ui.js";
import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES,
  OrderedWorkerSender,
  WorkerFrameReceiver,
  decodeWorkerError,
  encodeWorkerError,
  parseWorkerIdentity,
  validateCapabilityResult,
  type DockCapability,
  type ReverseWorkerCapability,
  type RuntimeCapability,
  type UiCapability,
  type WorkerCache,
  type WorkerEnvelope,
  type WorkerIdentity,
} from "./worker-protocol.js";
import type { PiWorkerInitOptions } from "./worker-process.js";

interface PendingHostCall {
  capability: UiCapability | DockCapability;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abort?: () => void;
}

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  void runWorker().catch((error) => {
    try { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch {}
    process.exit(1);
  });
}

async function runWorker(): Promise<void> {
  const identity = parseWorkerIdentity(parseEnvJson("ALU_DOCK_WORKER_IDENTITY"));
  const init = parseInit(parseEnvJson("ALU_DOCK_WORKER_INIT"));
  let generation = identity.runtimeGeneration;
  let hostGenerationSeen = generation;
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, callback));
  const receiver = new WorkerFrameReceiver((received) => sameWorker(received, identity)
    && (received.runtimeGeneration === generation
      || (received.runtimeGeneration === generation - 1 && hostGenerationSeen < generation)));
  const hostCalls = new Map<string, PendingHostCall>();
  let nextHostCall = 0;
  let runtime: PiRuntimeHost | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let hostCapabilities = new Set<ReverseWorkerCapability>(["dock.identity"]);

  const callHost = (capability: UiCapability | DockCapability, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const callId = `child-${++nextHostCall}`;
    if (!hostCapabilities.has(capability as ReverseWorkerCapability)) {
      return Promise.reject(new Error(`Host capability is not authorized for this Worker: ${capability}`));
    }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const abort = signal && capability.startsWith("ui.") ? (): void => { void sender.sendEnvelope({ kind: "call", callId: `cancel-${callId}`, capability: "ui.cancel", args: { callId } }); } : undefined;
      if (signal && abort) signal.addEventListener("abort", abort, { once: true });
      hostCalls.set(callId, {
        capability,
        resolve: (value) => { if (signal && abort) signal.removeEventListener("abort", abort); resolveCall(value); },
        reject: (error) => { if (signal && abort) signal.removeEventListener("abort", abort); rejectCall(error); },
      });
      void sender.sendEnvelope({ kind: "call", callId, capability, args }).catch((error) => {
        hostCalls.delete(callId);
        rejectCall(error);
      });
    });
  };

  const ui = new WorkerExtensionUiEndpoint(callHost);
  process.on("message", (raw) => {
    try {
      const envelope = receiver.accept(raw);
      if (envelope) {
        const frameGeneration = receiver.lastIdentity?.runtimeGeneration ?? generation;
        if (frameGeneration < generation) {
          if (envelope.kind === "call") void sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(new Error("Stale worker generation call")) });
          return;
        }
        hostGenerationSeen = generation;
        void handleHostEnvelope(envelope).catch(() => shutdown(1));
      }
    } catch {
      void shutdown(1);
    }
  });
  process.on("disconnect", () => { void shutdown(0); });

  // Prove Host authorization and the generation-bound reverse capability
  // channel before constructing Pi resources or loading extensions.
  const dockContext = await callHost("dock.identity", {});
  hostCapabilities = verifyDockContext(dockContext, identity, generation);

  const sessionPath = init.sessionFile ? resolve(init.sessionFile) : undefined;
  const reopened = sessionPath
    ? await openValidatedPiSession(sessionPath, init.sessionDir ? resolve(init.sessionDir) : undefined, init.cwd)
    : undefined;
  if (reopened && reopened.cwd !== init.cwd) throw new Error("Pi session working directory changed before worker runtime construction");
  runtime = await createPiRuntimeHost({
    cwd: init.cwd,
    agentDir: init.agentDir,
    ...(init.sessionDir === undefined ? {} : { sessionDir: init.sessionDir }),
    ...(init.tools === undefined ? {} : { tools: init.tools }),
    ...(init.excludeTools === undefined ? {} : { excludeTools: init.excludeTools }),
    projectTrusted: init.projectTrusted,
    extensionUiBroker: ui,
    extensionUiContextPortFactory: () => ui.createGenerationPort(),
    setProcessCwd: (cwd) => process.chdir(cwd),
    ...(reopened === undefined ? {} : { sessionManager: reopened.manager }),
  });
  if (init.initialName !== undefined && !reopened) runtime.currentSession().setSessionName(init.initialName);
  runtime.subscribe((event) => {
    const includeHistory = refreshesHistory(event.type);
    const envelope: WorkerEnvelope = { kind: "event", event, cache: captureCache(runtime!, includeHistory, event.type === "dock_session_replaced") };
    void sender.sendEnvelope(envelope).catch(() => process.exit(1));
    if (event.type === "dock_session_replaced") {
      generation += 1;
      sender.updateRuntimeGeneration(generation);
      for (const pending of hostCalls.values()) pending.resolve(undefined);
      hostCalls.clear();
    }
  });

  const diagnostics = runtime.diagnostics.map((item) => boundedError(item));
  await sender.sendEnvelope({
    kind: "ready",
    cache: captureCache(runtime, true, true),
    diagnostics,
    ...(runtime.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: runtime.modelFallbackMessage }),
    ...(runtime.currentSession().sessionManager.getSessionName() === undefined ? {} : { persistedName: runtime.currentSession().sessionManager.getSessionName() }),
    pid: process.pid,
  });

  async function handleHostEnvelope(envelope: WorkerEnvelope): Promise<void> {
    if (envelope.kind === "response") {
      const pending = hostCalls.get(envelope.callId);
      if (!pending) return;
      hostCalls.delete(envelope.callId);
      if (envelope.ok) {
        if (pending.capability.startsWith("ui.")) validateCapabilityResult(pending.capability as UiCapability, envelope.result);
        pending.resolve(envelope.result);
      } else pending.reject(decodeWorkerError(envelope.error));
      return;
    }
    if (envelope.kind !== "call") return;
    try {
      if (isAcceptedCapability(envelope.capability)) await sender.sendEnvelope({ kind: "accepted", callId: envelope.callId });
      const result = envelope.capability.startsWith("runtime.")
        ? await dispatchRuntime(runtime!, envelope.capability as RuntimeCapability, envelope.args as Record<string, unknown>, envelope.callId, sender)
        : dispatchHostUi(ui, envelope.capability as UiCapability, envelope.args as Record<string, unknown>);
      const cache = envelope.capability === "runtime.dispose" ? undefined : responseCache(runtime!, envelope.capability);
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result, ...(cache === undefined ? {} : { cache }) });
      if (envelope.capability === "runtime.dispose") setTimeout(() => process.exit(0), 0);
    } catch (error) {
      const cache = tryCaptureCache(runtime!);
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(error), ...(cache === undefined ? {} : { cache }) }).catch(() => {});
    }
  }

  function shutdown(code: number): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      sender.close();
      for (const pending of hostCalls.values()) pending.reject(new Error("Host IPC disconnected"));
      hostCalls.clear();
      // A Host crash must not leave this detached Worker or extension-owned
      // descendants alive behind an unresolved dispose Promise.
      const watchdog = setTimeout(hardKillOwnProcessGroup, 3_000);
      try { await runtime?.dispose().catch(() => {}); }
      finally {
        clearTimeout(watchdog);
        process.exit(code);
      }
    })();
    return shutdownPromise;
  }
}

async function dispatchRuntime(runtime: PiRuntimeHost, capability: RuntimeCapability, args: Record<string, unknown>, callId: string, sender: OrderedWorkerSender): Promise<unknown> {
  switch (capability) {
    case "runtime.activate": runtime.activateInitial(); return null;
    case "runtime.prompt": return runtime.prompt(args.text as string, {
      ...((args.options ?? {}) as object),
      preflightResult: (success) => { void sender.sendEnvelope({ kind: "preflight", callId, success }); },
    });
    case "runtime.queueMessage": return runtime.queueMessage(args.text as string, args.delivery as "steer" | "followUp");
    case "runtime.listModels": return runtime.listModels();
    case "runtime.listSessions": return runtime.listSessions(args.scope as "cwd" | "all");
    case "runtime.navigateTree": return runtime.navigateTree(args.targetId as string, args.options as never);
    case "runtime.listTools": return runtime.listTools();
    case "runtime.setActiveTools": return runtime.setActiveTools(args.names as string[]);
    case "runtime.getSettings": return runtime.getSettings();
    case "runtime.updateSetting": return runtime.updateSetting(args.update as never);
    case "runtime.getResources": return runtime.getResources();
    case "runtime.getCommands": return runtime.getCommands();
    case "runtime.resolveSessionTarget": return runtime.resolveSessionTarget(args.sessionFile as string);
    case "runtime.newSession": return runtime.newSession(args.operationId as string, args.parentSession as string | undefined);
    case "runtime.switchSession": return runtime.switchSession(args.operationId as string, args.sessionFile as string, args.trust as never);
    case "runtime.fork": return runtime.fork(args.operationId as string, args.entryId as string, args.position as "before" | "at", args.forkKind as "fork" | "clone");
    case "runtime.setSessionName": return runtime.setSessionName(args.name as string);
    case "runtime.compact": return runtime.compact(args.customInstructions as string | undefined);
    case "runtime.reload": return runtime.reload(args.operationId as string);
    case "runtime.selectModel": return runtime.selectModel(args.provider as string, args.modelId as string);
    case "runtime.setThinkingLevel": return runtime.setThinkingLevel(args.level as never);
    case "runtime.clearQueue": return runtime.clearQueue();
    case "runtime.abort": return runtime.abort();
    case "runtime.waitForIdle": return runtime.waitForIdle();
    case "runtime.dispose": return runtime.dispose();
  }
}

function dispatchHostUi(ui: WorkerExtensionUiEndpoint, capability: UiCapability, args: Record<string, unknown>): unknown {
  switch (capability) {
    case "ui.setToolsExpanded": ui.applyHostToolsExpanded(args.expanded === true); return null;
    case "ui.viewport": ui.setViewport(args.width as number, args.height as number); return null;
    case "ui.reset": ui.resetFromHost(); return null;
    default: throw new Error(`Host cannot invoke child UI capability ${capability}`);
  }
}

function captureCache(runtime: PiRuntimeHost, includeHistory: boolean, includeTree: boolean): WorkerCache {
  const tree = includeTree ? tryCaptureTree(runtime) : undefined;
  return {
    sessionId: runtime.sessionId,
    ...(runtime.sessionFile === undefined ? {} : { sessionFile: runtime.sessionFile }),
    ...(runtime.getDurableSessionFile() === undefined ? {} : { durableSessionFile: runtime.getDurableSessionFile() }),
    isStreaming: runtime.isStreaming,
    isCompacting: runtime.isCompacting,
    ...(runtime.getGitBranch() === undefined ? {} : { gitBranch: runtime.getGitBranch() }),
    modelState: runtime.getModelState(),
    metrics: runtime.getMetrics(),
    ...(includeHistory ? { history: runtime.getHistory() } : {}),
    ...(tree === undefined ? {} : { tree }),
    extensionCommands: runtime.getExtensionCommandNames(),
  };
}

function responseCache(runtime: PiRuntimeHost, capability: string): WorkerCache | undefined {
  try {
    return captureCache(runtime, capability === "runtime.navigateTree", capability === "runtime.navigateTree");
  } catch { return undefined; }
}
function tryCaptureCache(runtime: PiRuntimeHost): WorkerCache | undefined { try { return captureCache(runtime, false, false); } catch { return undefined; } }
function tryCaptureTree(runtime: PiRuntimeHost): ReturnType<PiRuntimeHost["getTree"]> | undefined {
  try { return runtime.getTree(); }
  catch { return undefined; }
}
function isAcceptedCapability(capability: string): boolean {
  return capability === "runtime.prompt" || capability === "runtime.queueMessage"
    || capability === "runtime.navigateTree" || capability === "runtime.setActiveTools"
    || capability === "runtime.updateSetting" || capability === "runtime.newSession"
    || capability === "runtime.switchSession" || capability === "runtime.fork"
    || capability === "runtime.setSessionName" || capability === "runtime.compact"
    || capability === "runtime.reload" || capability === "runtime.selectModel"
    || capability === "runtime.setThinkingLevel" || capability === "runtime.clearQueue"
    || capability === "runtime.abort" || capability === "runtime.dispose";
}
function parseEnvJson(name: string): unknown { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return JSON.parse(value); }
function parseInit(raw: unknown): PiWorkerInitOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worker init is invalid");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["cwd", "agentDir", "sessionDir", "tools", "excludeTools", "projectTrusted", "sessionFile", "initialName"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Worker init contains unknown field ${key}`);
  const text = (input: unknown, limit: number, label: string, optional = false): string | undefined => {
    if (input === undefined && optional) return undefined;
    if (typeof input !== "string" || input.length < 1 || input.length > limit) throw new Error(`${label} is invalid`);
    return input;
  };
  const list = (input: unknown, label: string): string[] | undefined => {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.length > 2_000) throw new Error(`${label} is invalid`);
    return input.map((item) => text(item, 256, label) as string);
  };
  if (typeof value.projectTrusted !== "boolean") throw new Error("Worker init project trust is invalid");
  return {
    cwd: text(value.cwd, 16_384, "Worker cwd") as string,
    agentDir: text(value.agentDir, 16_384, "Worker agent directory") as string,
    ...(text(value.sessionDir, 16_384, "Worker session directory", true) === undefined ? {} : { sessionDir: value.sessionDir as string }),
    ...(list(value.tools, "Worker tools") === undefined ? {} : { tools: list(value.tools, "Worker tools") }),
    ...(list(value.excludeTools, "Worker excluded tools") === undefined ? {} : { excludeTools: list(value.excludeTools, "Worker excluded tools") }),
    projectTrusted: value.projectTrusted,
    ...(text(value.sessionFile, 16_384, "Worker session file", true) === undefined ? {} : { sessionFile: value.sessionFile as string }),
    ...(text(value.initialName, 256, "Worker initial name", true) === undefined ? {} : { initialName: value.initialName as string }),
  };
}
function sameWorker(received: WorkerIdentity, initial: WorkerIdentity): boolean { return received.hostEpoch === initial.hostEpoch && received.instanceId === initial.instanceId && received.workerIncarnation === initial.workerIncarnation; }
function verifyDockContext(raw: unknown, expected: WorkerIdentity, runtimeGeneration: number): Set<ReverseWorkerCapability> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Dock Worker identity capability returned an invalid result");
  const value = raw as { identity?: Partial<WorkerIdentity>; capabilities?: unknown };
  if (Object.keys(value).some((key) => key !== "identity" && key !== "capabilities")) throw new Error("Dock Worker identity result contains unknown fields");
  const identity = value.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).some((key) => !["hostEpoch", "instanceId", "runtimeGeneration", "workerIncarnation"].includes(key))) {
    throw new Error("Dock Worker identity result is not closed");
  }
  if (identity.hostEpoch !== expected.hostEpoch || identity.instanceId !== expected.instanceId
    || identity.workerIncarnation !== expected.workerIncarnation || identity.runtimeGeneration !== runtimeGeneration) {
    throw new Error("Dock Worker identity capability did not match bootstrap identity");
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.includes("dock.identity")) {
    throw new Error("Dock Worker identity capability was not authorized by Host");
  }
  const known = new Set<string>(ORDINARY_REVERSE_WORKER_CAPABILITIES);
  const capabilities = new Set<ReverseWorkerCapability>();
  for (const capability of value.capabilities) {
    if (typeof capability !== "string" || !known.has(capability)) throw new Error("Host advertised an unknown Worker capability");
    if (capabilities.has(capability as ReverseWorkerCapability)) throw new Error("Host advertised a duplicate Worker capability");
    capabilities.add(capability as ReverseWorkerCapability);
  }
  return capabilities;
}
function hardKillOwnProcessGroup(): void {
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(1); }
}
function refreshesHistory(type: string): boolean { return type === "entry_appended" || type === "message_end" || type === "session_info_changed" || type === "compaction_end" || type === "dock_session_replaced"; }
function boundedError(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.length <= 2_048 ? text : text.slice(0, 2_048); }
