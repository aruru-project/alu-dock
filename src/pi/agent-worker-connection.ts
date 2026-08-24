import { randomUUID } from "node:crypto";

import type { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import type { DockToolsHostPort, DockToolsRequest } from "../core/dock-tools.js";
import type { AttachmentAccessRequest, InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import type { AgentCommandPreflightResult, AgentEvent, AgentInvokeOptions, AgentRequest, AgentWorkerConnection as AgentWorkerConnectionPort, AgentWorkerControl, AgentWorkerState } from "../core/agent-worker.js";
import type { WorkerIncidentRecorder } from "../core/worker-incident.js";
import { AgentMutationEffectUnknownError, AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import { PiWorkerProcess, type PiWorkerInitOptions, type WorkerProcessTimeouts } from "./worker-process.js";
import { captureWorkspaceShellEnvironment } from "./workspace-shell-environment.js";
import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES, OrderedWorkerSender, WorkerFrameReceiver, decodeWorkerError, encodeWorkerError, validateAgentWorkerResult,
  type DockCapability, type ReverseWorkerCapability, type UiCapability, type WorkerEnvelope, type WorkerIdentity,
} from "./worker-protocol.js";

interface PendingCall {
  label: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
  preflight?: (result: AgentCommandPreflightResult) => void;
  accepted: boolean;
  generation: number;
}

export interface CreateAgentWorkerConnectionOptions {
  identity: Omit<WorkerIdentity, "workerIncarnation">;
  init: PiWorkerInitOptions;
  extensionUiBroker: ExtensionUiBroker;
  workerEntry?: string;
  workerTimeouts?: Partial<WorkerProcessTimeouts>;
  /** Test-only deterministic environment seam; production captures the workspace login shell. */
  workerEnvironment?: NodeJS.ProcessEnv;
  onWorkerSpawn?: (pid: number) => void;
  dockToolsHostPort: DockToolsHostPort;
  attachmentHostPort: InstanceAttachmentHostPort;
  initialDockToolsEnabled: boolean;
  workName?: string;
  workerIncidentRecorder?: WorkerIncidentRecorder;
}

export class AgentWorkerUnavailableError extends AgentUnavailableBeforeEffectError {
  constructor(message: string) { super(message); this.name = "AgentWorkerUnavailableError"; }
}

/** Host-side AgentWorkerConnection proxy; no Pi SDK object crosses this boundary. */
export class AgentWorkerConnection implements AgentWorkerConnectionPort {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly uiAbort = new Map<string, AbortController>();
  private readonly process: PiWorkerProcess;
  private readonly sender: OrderedWorkerSender;
  private readonly receiver: WorkerFrameReceiver;
  private readonly identity: WorkerIdentity;
  private readonly reverseCapabilities = new Set<ReverseWorkerCapability>(ORDINARY_REVERSE_WORKER_CAPABILITIES);
  private stateValue!: AgentWorkerState;
  private nextCall = 0;
  private expectedExit = false;
  private unavailable = false;
  private lossPublished = false;
  private readonly readyPromise: Promise<{ diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }>;
  private resolveReady!: (value: { diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }) => void;
  private rejectReady!: (error: unknown) => void;
  private expectedGeneration: number;

  private constructor(
    private readonly options: CreateAgentWorkerConnectionOptions,
    identity: WorkerIdentity,
    workerEnvironment: NodeJS.ProcessEnv,
  ) {
    this.identity = identity;
    this.expectedGeneration = identity.runtimeGeneration;
    if (!options.initialDockToolsEnabled) this.reverseCapabilities.delete("dock.tools");
    this.process = new PiWorkerProcess({
      identity,
      init: options.init,
      environment: workerEnvironment,
      entry: options.workerEntry,
      timeouts: options.workerTimeouts,
      onSpawn: options.onWorkerSpawn,
    });
    this.sender = new OrderedWorkerSender(identity, (message, callback) => this.process.child.send(message, callback));
    this.receiver = new WorkerFrameReceiver((received) => this.acceptIdentity(received, identity));
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.process.child.on("message", (raw) => this.receive(raw));
    this.process.child.on("error", (error) => this.failTransport(error));
    this.process.child.on("disconnect", () => {
      if (this.expectedExit || this.unavailable) return;
      const watchdog = setTimeout(() => this.failTransport(new AgentWorkerUnavailableError("Pi worker IPC disconnected")), this.process.timeouts.disconnectMs);
      this.process.child.once("exit", () => clearTimeout(watchdog));
    });
    this.process.child.on("exit", (code, signal) => this.handleExit(code, signal));
    options.extensionUiBroker.bindRemoteEndpoint({ setToolsExpanded: (expanded) => { void this.callUi("ui.setToolsExpanded", { expanded }, "request").catch(() => {}); } });
    options.extensionUiBroker.bindWidgetRenderer({
      render: (viewport) => { void this.callUi("ui.viewport", { width: viewport.width, height: viewport.height }, "request").catch(() => {}); },
      reset: () => { /* Child generation lifecycle disposes component renderers locally. */ },
    });
  }

  static async create(options: CreateAgentWorkerConnectionOptions): Promise<{ session: AgentWorkerConnection; diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }> {
    const identity = { ...options.identity, workerIncarnation: randomUUID() };
    const workerEnvironment = options.workerEnvironment === undefined
      ? await captureWorkspaceShellEnvironment(options.init.cwd)
      : { ...options.workerEnvironment };
    const session = new AgentWorkerConnection(options, identity, workerEnvironment);
    const startup = session.process.timeouts.startupMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const ready = await Promise.race([
        session.readyPromise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pi worker startup deadline exceeded")), startup); }),
      ]);
      return { session, ...ready };
    } catch (error) {
      session.expectedExit = true;
      await session.process.terminate().catch(() => {});
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  state(): AgentWorkerState { return structuredClone(this.stateValue); }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  invoke(request: AgentRequest, options?: AgentInvokeOptions): Promise<unknown> {
    return this.sendAgentEnvelope(
      { kind: "agent_request", callId: "", request: structuredClone(request), ...(options?.context === undefined ? {} : { context: structuredClone(options.context) }) },
      request.type,
      deadlineForRequest(request.type),
      options?.preflightResult,
    );
  }

  control(control: AgentWorkerControl): Promise<unknown> {
    return this.sendAgentEnvelope(
      { kind: "agent_control", callId: "", control: structuredClone(control) },
      `agent.${control.type}`,
      control.type === "dispose" ? "shutdown" : control.type === "wait_for_idle" ? "none" : "request",
    );
  }

  async dispose(): Promise<void> {
    if (this.expectedExit) return;
    this.expectedExit = true;
    if (!this.unavailable) {
      try { await this.control({ type: "dispose" }); } catch { /* Supervisor owns the hard stop. */ }
    }
    this.sender.close();
    await this.process.terminate();
    this.rejectPending(new AgentWorkerUnavailableError("Pi worker was disposed"));
  }

  private callUi(capability: UiCapability, args: Record<string, unknown>, deadline: "request"): Promise<unknown> {
    return this.sendAgentEnvelope({ kind: "call", callId: "", capability, args }, capability, deadline);
  }

  private sendAgentEnvelope(
    envelope: Extract<WorkerEnvelope, { kind: "agent_request" | "agent_control" | "call" }>,
    label: string,
    deadline: "request" | "mutation" | "control" | "shutdown" | "none",
    preflight?: (result: AgentCommandPreflightResult) => void,
  ): Promise<unknown> {
    if (this.unavailable) return Promise.reject(new AgentWorkerUnavailableError("Pi worker is unavailable"));
    const callId = `host-${++this.nextCall}`;
    const timeoutMs = deadline === "none" ? undefined : deadline === "request" ? this.process.timeouts.requestMs
      : deadline === "mutation" ? this.process.timeouts.mutationMs : deadline === "control" ? this.process.timeouts.controlMs : this.process.timeouts.gracefulShutdownMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => this.failTransport(new AgentWorkerUnavailableError(`Pi worker ${label} deadline exceeded`)), timeoutMs);
      this.pending.set(callId, { label, resolve, reject, timer, preflight, accepted: false, generation: this.expectedGeneration });
      void this.sender.sendEnvelope({ ...envelope, callId } as WorkerEnvelope).catch((error) => {
        if (this.pending.has(callId)) this.failTransport(error);
      });
    });
  }

  private receive(raw: unknown): void {
    try {
      const envelope = this.receiver.accept(raw);
      if (envelope) void this.handleEnvelope(envelope).catch((error) => this.failTransport(error));
    } catch (error) { this.failTransport(error); }
  }

  private async handleEnvelope(envelope: WorkerEnvelope): Promise<void> {
    if (envelope.kind === "ready") {
      this.applyState(envelope.state);
      this.resolveReady({ diagnostics: envelope.diagnostics, ...(envelope.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: envelope.modelFallbackMessage }), ...(envelope.persistedName === undefined ? {} : { persistedName: envelope.persistedName }), pid: envelope.pid });
      return;
    }
    if (envelope.kind === "accepted") { const pending = this.pending.get(envelope.callId); if (pending) pending.accepted = true; return; }
    if (envelope.kind === "preflight") {
      this.pending.get(envelope.callId)?.preflight?.(envelope);
      return;
    }
    if (envelope.kind === "response") {
      const pending = this.pending.get(envelope.callId); if (!pending) return;
      if (envelope.state) this.applyState(envelope.state);
      if (envelope.ok) validateAgentWorkerResult(pending.label, envelope.result);
      this.pending.delete(envelope.callId); if (pending.timer) clearTimeout(pending.timer);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(decodeWorkerError(envelope.error));
      return;
    }
    if (envelope.kind === "event") {
      // Advance the outbound fence before listeners can synchronously issue
      // generation-reset UI calls from ManagedInstance.
      if (envelope.event.type === "dock_session_replaced") {
        const previous = this.expectedGeneration;
        this.expectedGeneration += 1;
        this.sender.updateRuntimeGeneration(this.expectedGeneration);
        this.cancelGenerationCalls(previous);
      }
      this.applyState(envelope.state);
      for (const listener of this.listeners) { try { listener(envelope.event as AgentEvent); } catch {} }
      return;
    }
    if (envelope.kind === "call" && !this.reverseCapabilities.has(envelope.capability as ReverseWorkerCapability)) {
      await this.sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(new Error(`Worker capability is not authorized: ${envelope.capability}`)) }).catch((error) => this.failTransport(error));
      return;
    }
    if (envelope.kind === "call" && envelope.capability.startsWith("dock.")) {
      await this.handleDockCall(envelope.callId, envelope.capability as DockCapability, envelope.args as Record<string, unknown>);
      return;
    }
    if (envelope.kind === "call" && envelope.capability.startsWith("ui.")) {
      await this.handleUiCall(envelope.callId, envelope.capability as UiCapability, envelope.args as Record<string, unknown>);
      return;
    }
    if (envelope.kind === "fatal") this.failTransport(decodeWorkerError(envelope.error));
  }

  private async handleDockCall(callId: string, capability: DockCapability, args: Record<string, unknown>): Promise<void> {
    try {
      let result: unknown;
      if (capability === "dock.identity") {
        result = {
          identity: { ...this.identity, runtimeGeneration: this.expectedGeneration },
          capabilities: [...this.reverseCapabilities],
        };
      } else if (capability === "dock.tools.configure") {
        result = await this.options.dockToolsHostPort.configureDockTools(this.identity.instanceId, args.enabled as boolean, args.operationId as string);
        if ((result as { enabled: boolean }).enabled) this.reverseCapabilities.add("dock.tools");
        else this.reverseCapabilities.delete("dock.tools");
      } else if (capability === "dock.tools") {
        result = await this.options.dockToolsHostPort.invokeDockTool(this.identity.instanceId, args.request as DockToolsRequest);
      } else {
        result = await this.options.attachmentHostPort.accessAttachments(this.identity.instanceId, args.request as AttachmentAccessRequest);
      }
      await this.sender.sendEnvelope({ kind: "response", callId, ok: true, result });
    } catch (error) {
      await this.sender.sendEnvelope({ kind: "response", callId, ok: false, error: encodeWorkerError(error) }).catch(() => {});
    }
  }

  private async handleUiCall(callId: string, capability: UiCapability, args: Record<string, unknown>): Promise<void> {
    try {
      let result: unknown = null;
      const broker = this.options.extensionUiBroker;
      const meta = args.optionsMeta as { timeout?: number; signalAborted?: boolean } | undefined;
      const controller = meta ? new AbortController() : undefined;
      if (controller && meta?.signalAborted) controller.abort();
      if (controller) this.uiAbort.set(callId, controller);
      const opts = meta ? { ...(meta.timeout === undefined ? {} : { timeout: meta.timeout }), ...(controller === undefined ? {} : { signal: controller.signal }) } : undefined;
      switch (capability) {
        case "ui.select": result = await broker.select(args.title as string, args.options as string[], opts); break;
        case "ui.confirm": result = await broker.confirm(args.title as string, args.message as string, opts); break;
        case "ui.input": result = await broker.input(args.title as string, args.placeholder as string | undefined, opts); break;
        case "ui.editor": result = await broker.editor(args.title as string, args.prefill as string | undefined); break;
        case "ui.notify": broker.notify(args.message as string, args.level as never, args.operationId as string | undefined); break;
        case "ui.setTitle": broker.setTitle(args.title as string); break;
        case "ui.setEditorText": broker.setEditorText(args.text as string); break;
        case "ui.setStatus": broker.setStatus(args.key as string, args.text as string | undefined); break;
        case "ui.setWidget": broker.setWidget(args.key as string, args.lines as string[] | undefined, args.placement as never); break;
        case "ui.widgetError": broker.reportWidgetError(args.key as string, args.error); break;
        case "ui.unsupported": broker.unsupported(args.feature as string); break;
        case "ui.setToolsExpanded": broker.applyRemoteToolsExpanded(args.expanded === true); break;
        case "ui.runtimeReload": await broker.resetForRuntimeReload(); break;
        case "ui.cancel": this.uiAbort.get(args.callId as string)?.abort(); break;
        default: throw new Error(`Worker cannot invoke Host UI capability ${capability}`);
      }
      await this.sender.sendEnvelope({ kind: "response", callId, ok: true, result });
    } catch (error) { await this.sender.sendEnvelope({ kind: "response", callId, ok: false, error: encodeWorkerError(error) }).catch(() => {}); }
    finally { this.uiAbort.delete(callId); }
  }

  private applyState(state: AgentWorkerState): void {
    this.stateValue = structuredClone(state);
  }

  private acceptIdentity(received: WorkerIdentity, initial: WorkerIdentity): boolean { return received.hostEpoch === initial.hostEpoch && received.instanceId === initial.instanceId && received.workerIncarnation === initial.workerIncarnation && received.runtimeGeneration === this.expectedGeneration; }
  private failTransport(error: unknown): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.sender.close();
    this.rejectReady(error);
    void this.finishTransportLoss(error);
  }
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new AgentWorkerUnavailableError(`Pi worker exited (${signal ?? code ?? "unknown"})`);
    this.failTransport(error);
  }
  private async finishTransportLoss(error: unknown): Promise<void> {
    try {
      await this.process.terminate();
      // Publish only after process ownership is conclusively released. Publishing
      // first would let a reopen race the old session owner.
      if (!this.expectedExit) {
        await this.recordIncident(error);
        this.publishLoss(error);
      }
      // Runtime-loss listeners synchronously register required catalog work;
      // settle the operation only after that boundary is visible.
      this.rejectPending(error);
    } catch (terminationError) {
      if (!this.expectedExit) await this.recordIncident(new AggregateError([error, terminationError], "Worker ownership could not be released"));
      // Keep the instance non-reopenable when reaping could not be proven.
      this.rejectPending(new AgentWorkerUnavailableError(
        `Pi worker termination could not be confirmed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
      ));
    }
  }
  private async recordIncident(error: unknown): Promise<void> {
    const recorder = this.options.workerIncidentRecorder;
    if (!recorder) return;
    try {
      const stderr = await this.process.incidentStderr(this.process.timeouts.disconnectMs);
      const exitCode = this.process.child.exitCode;
      const signal = this.process.child.signalCode;
      const cause = error instanceof Error ? error.message : String(error);
      await recorder.record({
        instanceId: this.identity.instanceId,
        ...(this.options.workName === undefined ? {} : { workName: this.options.workName }),
        runtimeGeneration: this.expectedGeneration,
        workerIncarnation: this.identity.workerIncarnation,
        occurredAt: new Date().toISOString(),
        cause: cause || "Agent runtime became unavailable",
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
        ...stderr,
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      });
    } catch (incidentError) {
      try { process.stderr.write(`Alu Dock could not save the Worker failure diagnostic: ${incidentError instanceof Error ? incidentError.message : String(incidentError)}\n`); } catch {}
    }
  }
  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(pending.accepted
        ? new AgentMutationEffectUnknownError(`Pi worker lost after accepting ${pending.label}`, error)
        : new AgentUnavailableBeforeEffectError(`Pi worker lost before accepting ${pending.label}`));
    }
    this.pending.clear(); for (const controller of this.uiAbort.values()) controller.abort(); this.uiAbort.clear();
  }
  private cancelGenerationCalls(generation: number): void {
    for (const [callId, pending] of this.pending) {
      if (pending.generation !== generation || isReplacementRequest(pending.label)) continue;
      this.pending.delete(callId); if (pending.timer) clearTimeout(pending.timer);
      pending.reject(pending.accepted
        ? new AgentMutationEffectUnknownError(`Runtime generation changed after accepting ${pending.label}`)
        : new AgentUnavailableBeforeEffectError("Runtime generation was replaced"));
    }
    for (const controller of this.uiAbort.values()) controller.abort();
    this.uiAbort.clear();
  }
  private publishLoss(error: unknown): void { if (this.lossPublished) return; this.lossPublished = true; const event: AgentEvent = { type: "dock_runtime_lost", operationId: "runtime-worker", kind: "create", error: error instanceof Error ? error.message : String(error), recoverySessionFile: this.stateValue?.durableSessionFile ?? this.stateValue?.sessionFile }; for (const listener of this.listeners) { try { listener(event); } catch {} } }
}

function isReplacementRequest(label: string): boolean { return label === "session.new" || label === "session.switch" || label === "session.fork" || label === "session.clone" || label === "session.reload"; }
function deadlineForRequest(type: AgentRequest["type"]): "request" | "mutation" | "control" | "none" {
  if (type === "queue.dequeue") return "control";
  // Pi abort waits for the Agent to become idle. Queued input may legally start
  // another turn first, so abort completion is not a Worker liveness signal.
  if (["command.submit", "command.abort", "session.navigate", "session.compact"].includes(type)) return "none";
  if (["model.list", "tool.list", "settings.get", "resource.get", "command.catalog", "command.content", "command.complete", "session.history", "conversation.history", "conversation.content", "conversation.image", "file.read", "session.list", "session.tree"].includes(type)) return "request";
  return "mutation";
}
