import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { controlRequestDescriptor } from "../control/protocol.js";
import type {
  AgentCommandPreflightResult, AgentEvent, AgentInvokeContext, AgentRequest, AgentWorkerControl, AgentWorkerState,
} from "../core/agent-worker.js";
import { parseAssistantResult, type AssistantRequest, type AssistantResultFor } from "../core/assistant.js";
import type { DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { AttachmentAccessRequest, AttachmentAccessResult } from "../core/instance-attachments.js";
import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES,
  OrderedWorkerSender,
  forwardWorkerEvent,
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

/**
 * The Agent inside a Worker, of any kind. The shell carries the Host's requests to it and its events
 * and answers back; `docs/agent_maps/runtime.md` says what each must be.
 */
export interface WorkerAgent {
  /** Answers one Protocol V2 Agent request; a submission reports how it was taken through `preflight` first. */
  dispatch(request: AgentRequest, context: AgentInvokeContext | undefined, preflight: (result: AgentCommandPreflightResult) => void): Promise<unknown>;
  /** Answers one of the Host's private controls. */
  control(control: AgentWorkerControl): Promise<unknown>;
  /** The Host's own calls into the Worker's extension UI, for a kind that has one. */
  hostCall?(capability: UiCapability, args: Record<string, unknown>): unknown;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  state(): AgentWorkerState;
  dispose(): Promise<unknown>;
  /** What went wrong while starting that the Work can still run with. */
  diagnostics: readonly unknown[];
  modelFallbackMessage?: string;
  /** The name the reopened conversation already has. */
  persistedName?: string;
}

/** What the Host lets this Worker ask of it. */
export interface WorkerHost {
  readonly identity: WorkerIdentity;
  /** One call to the Host. An aborted UI call is cancelled there; an aborted model call releases its caller at once. */
  call(capability: UiCapability | DockCapability, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dockToolsEnabled(): boolean;
  /** Turns this Work's Dock tools on or off; resolves to what the Host settled on. */
  configureDockTools(enabled: boolean): Promise<boolean>;
  invokeDockTool(request: DockToolsRequest): Promise<DockToolsResult>;
  /** Present when the Host lets this Work read Dock attachments. */
  attachments?: (request: AttachmentAccessRequest) => Promise<AttachmentAccessResult>;
  /** Present when the Host offers Main's model service: the Work takes its model configuration and credentials from Main. */
  models?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** Present only for a Work opened as the personal assistant: her persona, notes and memory on Main. */
  assistant?: <R extends AssistantRequest>(request: R) => Promise<AssistantResultFor<R>>;
}

export interface AgentWorkerOptions<Init> {
  /** Reads the kind's own startup input. */
  parseInit(raw: unknown): Init;
  /** Builds the Agent, after the Host has proven its identity and said what this Worker may call. */
  create(init: Init, host: WorkerHost): Promise<WorkerAgent>;
  /** What a call to the Host is rejected with when the conversation it was made for is replaced. */
  replacedCallError?: () => Error;
}

interface PendingHostCall {
  capability: UiCapability | DockCapability;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Runs this process as one Work's Worker until the Host disposes it or goes away. */
export async function runAgentWorker<Init>(options: AgentWorkerOptions<Init>): Promise<void> {
  const identity = parseWorkerIdentity(parseEnvJson("ALU_DOCK_WORKER_IDENTITY"));
  const init = options.parseInit(parseEnvJson("ALU_DOCK_WORKER_INIT"));
  let generation = identity.runtimeGeneration;
  let hostGenerationSeen = generation;
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, undefined, undefined, callback));
  const receiver = new WorkerFrameReceiver((received) => sameWorker(received, identity)
    && (received.runtimeGeneration === generation
      || (received.runtimeGeneration === generation - 1 && hostGenerationSeen < generation)));
  const hostCalls = new Map<string, PendingHostCall>();
  let nextHostCall = 0;
  let agent: WorkerAgent | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let hostCapabilities = new Set<ReverseWorkerCapability>(["dock.identity"]);

  const callHost = (capability: UiCapability | DockCapability, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const callId = `child-${++nextHostCall}`;
    if (!hostCapabilities.has(capability as ReverseWorkerCapability)) {
      return Promise.reject(new Error(`Host capability is not authorized for this Worker: ${capability}`));
    }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const abort = !signal ? undefined
        : capability.startsWith("ui.") ? (): void => { void sender.sendEnvelope({ kind: "call", callId: `cancel-${callId}`, capability: "ui.cancel", args: { callId } }); }
        // A cancelled question to Main releases its caller at once; the Host cancels it there.
        : capability === "dock.models" ? (): void => {
          hostCalls.delete(callId);
          rejectCall(new Error("Model request cancelled"));
          void sender.sendEnvelope({ kind: "call", callId: `cancel-${callId}`, capability: "dock.models", args: { op: "cancel", callId } }).catch(() => {});
        }
        : undefined;
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
  // channel before constructing Agent resources.
  const dockContext = await callHost("dock.identity", {});
  hostCapabilities = verifyDockContext(dockContext, identity, generation);
  const host: WorkerHost = {
    identity,
    call: callHost,
    dockToolsEnabled: () => hostCapabilities.has("dock.tools"),
    configureDockTools: async (enabled) => {
      const capability: DockCapability = "dock.tools.configure";
      const result = await callHost(capability, { enabled, operationId: randomUUID() });
      validateDockCapabilityResult(capability, result);
      const settled = (result as { enabled: boolean }).enabled;
      if (settled) hostCapabilities.add("dock.tools"); else hostCapabilities.delete("dock.tools");
      return settled;
    },
    invokeDockTool: async (request) => {
      const capability: DockCapability = "dock.tools";
      const result = await callHost(capability, { request });
      validateDockCapabilityResult(capability, result);
      return result as DockToolsResult;
    },
    ...(hostCapabilities.has("dock.attachments") ? {
      attachments: async (request: AttachmentAccessRequest) => {
        const capability: DockCapability = "dock.attachments";
        const result = await callHost(capability, { request });
        validateDockCapabilityResult(capability, result);
        return result as AttachmentAccessResult;
      },
    } : {}),
    ...(hostCapabilities.has("dock.models") ? {
      models: (args: Record<string, unknown>, signal?: AbortSignal) => callHost("dock.models", args, signal),
    } : {}),
    ...(hostCapabilities.has("dock.assistant") ? {
      assistant: async <R extends AssistantRequest>(request: R) => parseAssistantResult(request, await callHost("dock.assistant", { request })),
    } : {}),
  };

  try {
    agent = await options.create(init, host);
  } catch (error) {
    // The Host learns why this Work could not start (an unavailable chosen model, an
    // unreadable selected system) instead of only seeing the exit code.
    await sender.sendEnvelope({ kind: "fatal", error: encodeWorkerError(error) }).catch(() => {});
    throw error;
  }
  const running = agent;
  running.subscribe((event) => {
    const envelope: WorkerEnvelope = { kind: "event", event, state: running.state() };
    forwardWorkerEvent(sender, envelope, () => process.exit(1));
    if (event.type === "dock_session_replaced") {
      generation += 1;
      sender.updateRuntimeGeneration(generation);
      const replaced = options.replacedCallError ?? (() => new Error("The conversation this call was made for was replaced"));
      for (const pending of hostCalls.values()) pending.reject(replaced());
      hostCalls.clear();
    }
  });

  await sender.sendEnvelope({
    kind: "ready",
    state: running.state(),
    diagnostics: running.diagnostics.map((item) => boundedError(item)),
    ...(running.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: running.modelFallbackMessage }),
    ...(running.persistedName === undefined ? {} : { persistedName: running.persistedName }),
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
          && (envelope.control.type === "dispose" || envelope.control.type === "observation_delivery" || envelope.control.type === "work_message");
      if (accepted) await sender.sendEnvelope({ kind: "accepted", callId: envelope.callId });
      let result: unknown;
      if (envelope.kind === "agent_request") {
        result = await agent!.dispatch(
          envelope.request,
          envelope.context,
          (preflight) => { void sender.sendEnvelope({ kind: "preflight", callId: envelope.callId, ...preflight }); },
        );
      } else if (envelope.kind === "agent_control") {
        result = await agent!.control(envelope.control);
      } else {
        const hostCall = agent!.hostCall;
        if (!hostCall) throw new Error(`Host cannot invoke Worker capability ${envelope.capability}`);
        result = hostCall.call(agent, envelope.capability as UiCapability, envelope.args as Record<string, unknown>);
      }
      const disposed = envelope.kind === "agent_control" && envelope.control.type === "dispose";
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result, ...(disposed ? {} : { state: agent!.state() }) }, envelope.kind === "agent_request" && envelope.request.type === "conversation.image" ? "conversation.image" : undefined);
      if (disposed) setTimeout(() => process.exit(0), 0);
    } catch (error) {
      const state = tryState(agent!);
      await sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(error), ...(state === undefined ? {} : { state }) }).catch(() => {});
    }
  }

  function shutdown(code: number): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      sender.close();
      for (const pending of hostCalls.values()) pending.reject(new Error("Host IPC disconnected"));
      hostCalls.clear();
      // A Host crash must not leave this detached Worker or the descendants it
      // owns alive behind an unresolved dispose Promise.
      const watchdog = setTimeout(hardKillOwnProcessGroup, 3_000);
      try { await agent?.dispose().catch(() => {}); }
      finally {
        clearTimeout(watchdog);
        process.exit(code);
      }
    })();
    return shutdownPromise;
  }
}

function tryState(agent: WorkerAgent): AgentWorkerState | undefined { try { return agent.state(); } catch { return undefined; } }
function isAcceptedRequest(type: AgentRequest["type"]): boolean {
  return controlRequestDescriptor(type).effect === "command";
}
function parseEnvJson(name: string): unknown { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return JSON.parse(value); }
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
  // dock.models and dock.assistant are not ordinary: only a Host that offers model access grants the
  // first, and only to an assistant Work the second.
  const known = new Set<string>([...ORDINARY_REVERSE_WORKER_CAPABILITIES, "dock.models", "dock.assistant"]);
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
