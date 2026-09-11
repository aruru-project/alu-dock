import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createPiAgentAdapter, type PiAgentAdapter } from "./pi-agent-adapter.js";
import { openValidatedPiSession } from "./pi-session-target.js";
import { WorkerExtensionUiEndpoint, WorkerUiLifecycleCancelledError } from "./worker-extension-ui.js";
import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES,
  OrderedWorkerSender,
  WorkerFrameReceiver,
  decodeWorkerError,
  encodeWorkerError,
  parseWorkerIdentity,
  validateDockCapabilityResult,
  validateUiCapabilityResult,
  type DockCapability,
  type ReverseWorkerCapability,
  type UiCapability,
  type WorkerEnvelope,
  type WorkerIdentity,
} from "./worker-protocol.js";
import type { PiWorkerInitOptions } from "./worker-process.js";
import type { AgentRequest, AgentWorkerState } from "../core/agent-worker.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import type { DockToolsResult } from "../core/dock-tools.js";
import type { AttachmentAccessRequest, AttachmentAccessResult } from "../core/instance-attachments.js";
import { DockToolsBridge } from "./dock-tools-extension.js";
import type { DockAttachmentCallPort } from "./dock-attachments-extension.js";
import { enterPiWorkerRuntime } from "./pi-runtime-environment.js";

interface PendingHostCall {
  capability: UiCapability | DockCapability;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abort?: () => void;
}

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  enterPiWorkerRuntime();
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
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, undefined, undefined, callback));
  const receiver = new WorkerFrameReceiver((received) => sameWorker(received, identity)
    && (received.runtimeGeneration === generation
      || (received.runtimeGeneration === generation - 1 && hostGenerationSeen < generation)));
  const hostCalls = new Map<string, PendingHostCall>();
  let nextHostCall = 0;
  let runtime: PiAgentAdapter | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let hostCapabilities = new Set<ReverseWorkerCapability>(["dock.identity"]);
  let dockToolsBridge: DockToolsBridge | undefined;
  let attachmentPort: DockAttachmentCallPort | undefined;

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
  attachmentPort = hostCapabilities.has("dock.attachments") ? {
    access: async (request: AttachmentAccessRequest) => {
      const capability: DockCapability = "dock.attachments";
      const result = await callHost(capability, { request });
      validateDockCapabilityResult(capability, result);
      return result as AttachmentAccessResult;
    },
  } : undefined;
  dockToolsBridge = new DockToolsBridge(hostCapabilities.has("dock.tools"), {
    configure: async (action) => {
      if (action === "status") return { enabled: dockToolsBridge!.enabled };
      const capability: DockCapability = "dock.tools.configure";
      const result = await callHost(capability, { enabled: action === "on", operationId: randomUUID() });
      validateDockCapabilityResult(capability, result);
      const enabled = (result as { enabled: boolean }).enabled;
      if (enabled) hostCapabilities.add("dock.tools"); else hostCapabilities.delete("dock.tools");
      return { enabled };
    },
    invoke: async (request) => {
      const capability: DockCapability = "dock.tools";
      const result = await callHost(capability, { request });
      validateDockCapabilityResult(capability, result);
      return result as DockToolsResult;
    },
  });

  const sessionPath = init.sessionFile ? resolve(init.sessionFile) : undefined;
  const reopened = sessionPath
    ? await openValidatedPiSession(sessionPath, init.sessionDir ? resolve(init.sessionDir) : undefined, init.cwd)
    : undefined;
  if (reopened && reopened.cwd !== init.cwd) throw new Error("Pi session working directory changed before worker runtime construction");
  runtime = await createPiAgentAdapter({
    cwd: init.cwd,
    agentDir: init.agentDir,
    ...(init.sessionDir === undefined ? {} : { sessionDir: init.sessionDir }),
    ...(init.tools === undefined ? {} : { tools: init.tools }),
    ...(init.excludeTools === undefined ? {} : { excludeTools: init.excludeTools }),
    ...(init.workerConfig === undefined ? {} : { workerConfig: init.workerConfig }),
    projectTrusted: init.projectTrusted,
    extensionUiBroker: ui,
    extensionUiContextPortFactory: () => ui.createGenerationPort(),
    setProcessCwd: (cwd) => process.chdir(cwd),
    ...(reopened === undefined ? {} : { sessionManager: reopened.manager }),
    dockToolsBridge,
    ...(attachmentPort === undefined ? {} : { dockAttachmentPort: attachmentPort }),
  });
  if (init.initialName !== undefined && !reopened) runtime.currentSession().setSessionName(init.initialName);
  runtime.subscribe((event) => {
    const envelope: WorkerEnvelope = { kind: "event", event, state: captureState(runtime!) };
    void sender.sendEnvelope(envelope).catch(() => process.exit(1));
    if (event.type === "dock_session_replaced") {
      generation += 1;
      sender.updateRuntimeGeneration(generation);
      for (const pending of hostCalls.values()) pending.reject(new WorkerUiLifecycleCancelledError());
      hostCalls.clear();
    }
  });

  const diagnostics = runtime.diagnostics.map((item) => boundedError(item));
  await sender.sendEnvelope({
    kind: "ready",
    state: captureState(runtime),
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
        if (pending.capability.startsWith("ui.")) validateUiCapabilityResult(pending.capability as UiCapability, envelope.result);
        else validateDockCapabilityResult(pending.capability as DockCapability, envelope.result);
        pending.resolve(envelope.result);
      } else pending.reject(decodeWorkerError(envelope.error));
      return;
    }
    if (envelope.kind !== "agent_request" && envelope.kind !== "agent_control" && envelope.kind !== "call") return;
    try {
      if (envelope.kind === "agent_request" && envelope.request.params.instanceId !== identity.instanceId) {
        throw new Error("Worker Agent request instance identity mismatch");
      }
      const accepted = envelope.kind === "agent_request" ? isAcceptedRequest(envelope.request.type)
        : envelope.kind === "agent_control"
          && (envelope.control.type === "dispose" || envelope.control.type === "observation_delivery");
      if (accepted) await sender.sendEnvelope({ kind: "accepted", callId: envelope.callId });
      let result: unknown;
      if (envelope.kind === "agent_request") {
        const dispatchAgentRequest = (): Promise<unknown> => runtime!.dispatch(
          envelope.request,
          envelope.context,
          (preflight) => { void sender.sendEnvelope({ kind: "preflight", callId: envelope.callId, ...preflight }); },
        );
        result = envelope.request.type === "command.submit"
          && runtime!.classifyInput(envelope.request.params.message) === "extension_command"
          ? await ui.withCommandNotificationOrigin(envelope.request.params.operationId, dispatchAgentRequest)
          : await dispatchAgentRequest();
      } else if (envelope.kind === "agent_control") {
        if (envelope.control.type === "observation_delivery") {
          dockToolsBridge!.deliver(envelope.control.notification);
          result = null;
        } else result = await runtime!.control(envelope.control);
      } else {
        result = dispatchHostUi(ui, envelope.capability as UiCapability, envelope.args as Record<string, unknown>);
      }
      const disposed = envelope.kind === "agent_control" && envelope.control.type === "dispose";
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result, ...(disposed ? {} : { state: captureState(runtime!) }) });
      if (disposed) setTimeout(() => process.exit(0), 0);
    } catch (error) {
      const state = tryCaptureState(runtime!);
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(error), ...(state === undefined ? {} : { state }) }).catch(() => {});
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

function dispatchHostUi(ui: WorkerExtensionUiEndpoint, capability: UiCapability, args: Record<string, unknown>): unknown {
  switch (capability) {
    case "ui.setToolsExpanded": ui.applyHostToolsExpanded(args.expanded === true); return null;
    case "ui.viewport": ui.setViewport(args.width as number, args.height as number); return null;
    case "ui.reset": ui.resetFromHost(); return null;
    default: throw new Error(`Host cannot invoke child UI capability ${capability}`);
  }
}

function captureState(runtime: PiAgentAdapter): AgentWorkerState {
  return {
    sessionId: runtime.sessionId,
    ...(runtime.sessionFile === undefined ? {} : { sessionFile: runtime.sessionFile }),
    ...(runtime.getDurableSessionFile() === undefined ? {} : { durableSessionFile: runtime.getDurableSessionFile() }),
    isStreaming: runtime.isStreaming,
    isCompacting: runtime.isCompacting,
    ...(runtime.getGitBranch() === undefined ? {} : { gitBranch: runtime.getGitBranch() }),
    modelState: runtime.getModelState(),
    metrics: runtime.getMetrics(),
    extensionCommands: runtime.getExtensionCommandNames(),
  };
}

function tryCaptureState(runtime: PiAgentAdapter): AgentWorkerState | undefined { try { return captureState(runtime); } catch { return undefined; } }
function isAcceptedRequest(type: AgentRequest["type"]): boolean {
  return !["model.list", "tool.list", "settings.get", "resource.get", "resource.content", "command.catalog", "command.content", "command.complete", "session.history", "conversation.history", "conversation.content", "conversation.image", "file.read", "session.list", "session.tree"].includes(type);
}
function parseEnvJson(name: string): unknown { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return JSON.parse(value); }
function parseInit(raw: unknown): PiWorkerInitOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worker init is invalid");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["cwd", "agentDir", "sessionDir", "tools", "excludeTools", "workerConfig", "projectTrusted", "sessionFile", "initialName"]);
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
    ...(value.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(value.workerConfig, "Worker configuration") }),
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
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { detached: true, stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    } catch { process.exit(1); }
  }
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(1); }
}
function boundedError(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.length <= 2_048 ? text : text.slice(0, 2_048); }
