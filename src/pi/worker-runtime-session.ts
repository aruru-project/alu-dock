import { randomUUID } from "node:crypto";

import type { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import type {
  ClearedRuntimeQueue, RuntimeCompactionResult, RuntimeEvent, RuntimeForkResult,
  RuntimeHistoryEntry, RuntimeInputKind, RuntimeModelInfo, RuntimeModelState,
  RuntimeNavigateOptions, RuntimeNavigateResult, RuntimePromptOptions, RuntimeProjectTrust,
  RuntimeReplacementResult, RuntimeSession, RuntimeSessionInfo, RuntimeSessionMetrics,
  RuntimeSessionTarget, RuntimeThinkingLevel, RuntimeToolProjection, RuntimeTreeSnapshot,
} from "../core/runtime-session.js";
import { RuntimeMutationEffectUnknownError, RuntimeUnavailableBeforeEffectError } from "../core/runtime-session.js";
import type { CommandDto, SettingDto, SettingUpdate, ToolDto } from "../core/config-projection.js";
import { PiWorkerProcess, type PiWorkerInitOptions, type WorkerProcessTimeouts } from "./worker-process.js";
import {
  ORDINARY_REVERSE_WORKER_CAPABILITIES, OrderedWorkerSender, WorkerFrameReceiver, decodeWorkerError, encodeWorkerError, validateCapabilityResult,
  type DockCapability, type ReverseWorkerCapability, type RuntimeCapability, type UiCapability, type WorkerCache, type WorkerEnvelope, type WorkerIdentity,
} from "./worker-protocol.js";

interface PendingCall {
  capability: RuntimeCapability | UiCapability;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
  preflight?: (success: boolean) => void;
  accepted: boolean;
  generation: number;
}

export interface CreateWorkerRuntimeSessionOptions {
  identity: Omit<WorkerIdentity, "workerIncarnation">;
  init: PiWorkerInitOptions;
  extensionUiBroker: ExtensionUiBroker;
  workerEntry?: string;
  workerTimeouts?: Partial<WorkerProcessTimeouts>;
  onWorkerSpawn?: (pid: number) => void;
}

export class WorkerRuntimeUnavailableError extends RuntimeUnavailableBeforeEffectError {
  constructor(message: string) { super(message); this.name = "WorkerRuntimeUnavailableError"; }
}

/** Host-side RuntimeSession proxy; no Pi SDK object crosses this boundary. */
export class WorkerRuntimeSession implements RuntimeSession {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly uiAbort = new Map<string, AbortController>();
  private readonly process: PiWorkerProcess;
  private readonly sender: OrderedWorkerSender;
  private readonly receiver: WorkerFrameReceiver;
  private readonly identity: WorkerIdentity;
  private readonly reverseCapabilities = new Set<ReverseWorkerCapability>(ORDINARY_REVERSE_WORKER_CAPABILITIES);
  private cacheValue!: WorkerCache;
  private historyValue: RuntimeHistoryEntry[] = [];
  private treeValue: RuntimeTreeSnapshot | undefined;
  private extensionCommands = new Set<string>();
  private nextCall = 0;
  private expectedExit = false;
  private unavailable = false;
  private lossPublished = false;
  private readonly readyPromise: Promise<{ diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }>;
  private resolveReady!: (value: { diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }) => void;
  private rejectReady!: (error: unknown) => void;
  private expectedGeneration: number;

  private constructor(private readonly options: CreateWorkerRuntimeSessionOptions, identity: WorkerIdentity) {
    this.identity = identity;
    this.expectedGeneration = identity.runtimeGeneration;
    this.process = new PiWorkerProcess({ identity, init: options.init, entry: options.workerEntry, timeouts: options.workerTimeouts, onSpawn: options.onWorkerSpawn });
    this.sender = new OrderedWorkerSender(identity, (message, callback) => this.process.child.send(message, callback));
    this.receiver = new WorkerFrameReceiver((received) => this.acceptIdentity(received, identity));
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.process.child.on("message", (raw) => this.receive(raw));
    this.process.child.on("error", (error) => this.failTransport(error));
    this.process.child.on("disconnect", () => {
      if (this.expectedExit || this.unavailable) return;
      const watchdog = setTimeout(() => this.failTransport(new WorkerRuntimeUnavailableError("Pi worker IPC disconnected")), this.process.timeouts.disconnectMs);
      this.process.child.once("exit", () => clearTimeout(watchdog));
    });
    this.process.child.on("exit", (code, signal) => this.handleExit(code, signal));
    options.extensionUiBroker.bindRemoteEndpoint({ setToolsExpanded: (expanded) => { void this.call("ui.setToolsExpanded", { expanded }, "request").catch(() => {}); } });
    options.extensionUiBroker.bindWidgetRenderer({
      render: (viewport) => { void this.call("ui.viewport", { width: viewport.width, height: viewport.height }, "request").catch(() => {}); },
      reset: () => { /* Child generation lifecycle disposes component renderers locally. */ },
    });
  }

  static async create(options: CreateWorkerRuntimeSessionOptions): Promise<{ session: WorkerRuntimeSession; diagnostics: string[]; modelFallbackMessage?: string; persistedName?: string; pid: number }> {
    const identity = { ...options.identity, workerIncarnation: randomUUID() };
    const session = new WorkerRuntimeSession(options, identity);
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

  get sessionId(): string { return this.cacheValue.sessionId; }
  get sessionFile(): string | undefined { return this.cacheValue.sessionFile; }
  get isStreaming(): boolean { return this.cacheValue.isStreaming; }
  get isCompacting(): boolean { return this.cacheValue.isCompacting; }
  getDurableSessionFile(): string | undefined { return this.cacheValue.durableSessionFile; }
  getGitBranch(): string | undefined { return this.cacheValue.gitBranch; }
  getHistory(): RuntimeHistoryEntry[] { return structuredClone(this.historyValue); }
  getTree(): RuntimeTreeSnapshot { if (!this.treeValue) throw new WorkerRuntimeUnavailableError("Worker tree cache is unavailable"); return structuredClone(this.treeValue); }
  getModelState(): RuntimeModelState { return structuredClone(this.cacheValue.modelState as RuntimeModelState); }
  getMetrics(): RuntimeSessionMetrics { return structuredClone(this.cacheValue.metrics as RuntimeSessionMetrics); }

  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  classifyInput(text: string): RuntimeInputKind { const name = extensionCommandName(text); return name !== undefined && this.extensionCommands.has(name) ? "extension_command" : "prompt"; }
  activateInitial(): Promise<void> { return this.call("runtime.activate", {}, "request").then(() => {}); }
  prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    const wireOptions = options ? { ...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }), ...(options.source === undefined ? {} : { source: options.source }) } : undefined;
    return this.call("runtime.prompt", { text, ...(wireOptions === undefined ? {} : { options: wireOptions }) }, "none", options?.preflightResult).then(() => {});
  }
  queueMessage(text: string, delivery: "steer" | "followUp"): Promise<void> { return this.call("runtime.queueMessage", { text, delivery }, "mutation").then(() => {}); }
  listModels(): Promise<RuntimeModelInfo[]> { return this.call("runtime.listModels", {}, "request") as Promise<RuntimeModelInfo[]>; }
  listSessions(scope: "cwd" | "all"): Promise<RuntimeSessionInfo[]> { return this.call("runtime.listSessions", { scope }, "request") as Promise<RuntimeSessionInfo[]>; }
  navigateTree(targetId: string, options?: RuntimeNavigateOptions): Promise<RuntimeNavigateResult> { return this.call("runtime.navigateTree", { targetId, ...(options === undefined ? {} : { options }) }, "none") as Promise<RuntimeNavigateResult>; }
  listTools(): Promise<ToolDto[] | RuntimeToolProjection> { return this.call("runtime.listTools", {}, "request") as Promise<ToolDto[] | RuntimeToolProjection>; }
  setActiveTools(names: string[]): Promise<ToolDto[] | RuntimeToolProjection> { return this.call("runtime.setActiveTools", { names }, "mutation") as Promise<ToolDto[] | RuntimeToolProjection>; }
  getSettings(): Promise<SettingDto[]> { return this.call("runtime.getSettings", {}, "request") as Promise<SettingDto[]>; }
  updateSetting(update: SettingUpdate): Promise<SettingDto> { return this.call("runtime.updateSetting", { update }, "mutation") as Promise<SettingDto>; }
  getResources(): ReturnType<RuntimeSession["getResources"]> { return this.call("runtime.getResources", {}, "request") as ReturnType<RuntimeSession["getResources"]>; }
  getCommands(): Promise<CommandDto[]> { return this.call("runtime.getCommands", {}, "request") as Promise<CommandDto[]>; }
  resolveSessionTarget(sessionFile: string): Promise<RuntimeSessionTarget> { return this.call("runtime.resolveSessionTarget", { sessionFile }, "request") as Promise<RuntimeSessionTarget>; }
  newSession(operationId: string, parentSession?: string): Promise<RuntimeReplacementResult> { return this.call("runtime.newSession", { operationId, ...(parentSession === undefined ? {} : { parentSession }) }, "mutation") as Promise<RuntimeReplacementResult>; }
  switchSession(operationId: string, sessionFile: string, trust: RuntimeProjectTrust): Promise<RuntimeReplacementResult> { return this.call("runtime.switchSession", { operationId, sessionFile, trust }, "mutation") as Promise<RuntimeReplacementResult>; }
  fork(operationId: string, entryId: string, position: "before" | "at", kind: "fork" | "clone"): Promise<RuntimeForkResult> { return this.call("runtime.fork", { operationId, entryId, position, forkKind: kind }, "mutation") as Promise<RuntimeForkResult>; }
  setSessionName(name: string): Promise<string | undefined> { return this.call("runtime.setSessionName", { name }, "mutation") as Promise<string | undefined>; }
  compact(customInstructions?: string): Promise<RuntimeCompactionResult> { return this.call("runtime.compact", { ...(customInstructions === undefined ? {} : { customInstructions }) }, "none") as Promise<RuntimeCompactionResult>; }
  reload(operationId: string): Promise<RuntimeReplacementResult> { return this.call("runtime.reload", { operationId }, "mutation") as Promise<RuntimeReplacementResult>; }
  selectModel(provider: string, modelId: string): Promise<RuntimeModelState> { return this.call("runtime.selectModel", { provider, modelId }, "mutation") as Promise<RuntimeModelState>; }
  setThinkingLevel(level: RuntimeThinkingLevel): Promise<RuntimeModelState> { return this.call("runtime.setThinkingLevel", { level }, "mutation") as Promise<RuntimeModelState>; }
  clearQueue(): Promise<ClearedRuntimeQueue> { return this.call("runtime.clearQueue", {}, "control") as Promise<ClearedRuntimeQueue>; }
  abort(): Promise<void> { return this.call("runtime.abort", {}, "control").then(() => {}); }
  waitForIdle(): Promise<void> { return this.call("runtime.waitForIdle", {}, "none").then(() => {}); }

  async dispose(): Promise<void> {
    if (this.expectedExit) return;
    this.expectedExit = true;
    if (!this.unavailable) {
      try { await this.call("runtime.dispose", {}, "shutdown"); } catch { /* Supervisor owns the hard stop. */ }
    }
    this.sender.close();
    await this.process.terminate();
    this.rejectPending(new WorkerRuntimeUnavailableError("Pi worker was disposed"));
  }

  private call(capability: RuntimeCapability | UiCapability, args: Record<string, unknown>, deadline: "request" | "mutation" | "control" | "shutdown" | "none", preflight?: (success: boolean) => void): Promise<unknown> {
    if (this.unavailable) return Promise.reject(new WorkerRuntimeUnavailableError("Pi worker is unavailable"));
    const callId = `host-${++this.nextCall}`;
    const timeoutMs = deadline === "none"
      ? undefined
      : deadline === "request"
        ? this.process.timeouts.requestMs
        : deadline === "mutation"
          ? this.process.timeouts.mutationMs
          : deadline === "control"
            ? this.process.timeouts.controlMs
            : this.process.timeouts.gracefulShutdownMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        const error = new WorkerRuntimeUnavailableError(`Pi worker ${capability} deadline exceeded`);
        this.failTransport(error);
      }, timeoutMs);
      this.pending.set(callId, { capability, resolve, reject, timer, preflight, accepted: false, generation: this.expectedGeneration });
      void this.sender.sendEnvelope({ kind: "call", callId, capability, args }).catch((error) => {
        if (!this.pending.has(callId)) return;
        // The child dispatches only after it sends an accepted frame, so keep
        // this call pending and let transport-loss classification decide
        // pre-effect versus effect-unknown.
        this.failTransport(error);
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
      this.applyCache(envelope.cache);
      this.resolveReady({ diagnostics: envelope.diagnostics, ...(envelope.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: envelope.modelFallbackMessage }), ...(envelope.persistedName === undefined ? {} : { persistedName: envelope.persistedName }), pid: envelope.pid });
      return;
    }
    if (envelope.kind === "accepted") { const pending = this.pending.get(envelope.callId); if (pending) pending.accepted = true; return; }
    if (envelope.kind === "preflight") { this.pending.get(envelope.callId)?.preflight?.(envelope.success); return; }
    if (envelope.kind === "response") {
      const pending = this.pending.get(envelope.callId); if (!pending) return;
      if (envelope.ok) {
        try { validateCapabilityResult(pending.capability, envelope.result); }
        catch (error) {
          // Keep the call pending: once custody was accepted, a malformed
          // success cannot prove whether the mutation took effect. Transport
          // loss classification settles it only after the Worker is reaped.
          this.failTransport(error);
          return;
        }
      }
      if (envelope.cache) this.applyCache(envelope.cache);
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
        // Omitted means the new tree exceeded the explicit projection bound;
        // never retain a previous generation's topology.
        this.treeValue = undefined;
      }
      this.applyCache(envelope.cache);
      for (const listener of this.listeners) { try { listener(envelope.event as RuntimeEvent); } catch {} }
      return;
    }
    if (envelope.kind === "call" && !this.reverseCapabilities.has(envelope.capability as ReverseWorkerCapability)) {
      await this.sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: false, error: encodeWorkerError(new Error(`Worker capability is not authorized: ${envelope.capability}`)) }).catch((error) => this.failTransport(error));
      return;
    }
    if (envelope.kind === "call" && envelope.capability === "dock.identity") {
      await this.handleDockCall(envelope.callId, envelope.capability);
      return;
    }
    if (envelope.kind === "call" && envelope.capability.startsWith("ui.")) {
      await this.handleUiCall(envelope.callId, envelope.capability as UiCapability, envelope.args as Record<string, unknown>);
      return;
    }
    if (envelope.kind === "fatal") this.failTransport(decodeWorkerError(envelope.error));
  }

  private async handleDockCall(callId: string, capability: DockCapability): Promise<void> {
    if (capability !== "dock.identity") return;
    await this.sender.sendEnvelope({
      kind: "response",
      callId,
      ok: true,
      result: {
        identity: { ...this.identity, runtimeGeneration: this.expectedGeneration },
        capabilities: [...this.reverseCapabilities],
      },
    }).catch((error) => this.failTransport(error));
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
        case "ui.notify": broker.notify(args.message as string, args.level as never); break;
        case "ui.setStatus": broker.setStatus(args.key as string, args.text as string | undefined); break;
        case "ui.setWidget": broker.setWidget(args.key as string, args.lines as string[] | undefined, args.placement as never); break;
        case "ui.widgetError": broker.reportWidgetError(args.key as string, args.error); break;
        case "ui.unsupported": broker.unsupported(args.feature as string); break;
        case "ui.setToolsExpanded": broker.applyRemoteToolsExpanded(args.expanded === true); break;
        case "ui.generationBegin": broker.beginGenerationChange(); break;
        case "ui.cancel": this.uiAbort.get(args.callId as string)?.abort(); break;
        default: throw new Error(`Worker cannot invoke Host UI capability ${capability}`);
      }
      await this.sender.sendEnvelope({ kind: "response", callId, ok: true, result });
    } catch (error) { await this.sender.sendEnvelope({ kind: "response", callId, ok: false, error: encodeWorkerError(error) }).catch(() => {}); }
    finally { this.uiAbort.delete(callId); }
  }

  private applyCache(cache: WorkerCache): void {
    this.cacheValue = cache;
    if (cache.history) this.historyValue = structuredClone(cache.history as RuntimeHistoryEntry[]);
    if (cache.tree) this.treeValue = structuredClone(cache.tree as RuntimeTreeSnapshot);
    if (cache.extensionCommands) this.extensionCommands = new Set(cache.extensionCommands);
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
    const error = new WorkerRuntimeUnavailableError(`Pi worker exited (${signal ?? code ?? "unknown"})`);
    this.failTransport(error);
  }
  private async finishTransportLoss(error: unknown): Promise<void> {
    try {
      await this.process.terminate();
      // Publish only after process ownership is conclusively released. Publishing
      // first would let a reopen race the old session owner.
      if (!this.expectedExit) this.publishLoss(error);
      // Runtime-loss listeners synchronously register required catalog work;
      // settle the operation only after that boundary is visible.
      this.rejectPending(error);
    } catch (terminationError) {
      // Keep the instance non-reopenable when reaping could not be proven.
      this.rejectPending(new WorkerRuntimeUnavailableError(
        `Pi worker termination could not be confirmed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
      ));
    }
  }
  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(pending.accepted
        ? new RuntimeMutationEffectUnknownError(`Pi worker lost after accepting ${pending.capability}`, error)
        : new RuntimeUnavailableBeforeEffectError(`Pi worker lost before accepting ${pending.capability}`));
    }
    this.pending.clear(); for (const controller of this.uiAbort.values()) controller.abort(); this.uiAbort.clear();
  }
  private cancelGenerationCalls(generation: number): void {
    for (const [callId, pending] of this.pending) {
      if (pending.generation !== generation || isReplacementCapability(pending.capability)) continue;
      this.pending.delete(callId); if (pending.timer) clearTimeout(pending.timer);
      pending.reject(pending.accepted
        ? new RuntimeMutationEffectUnknownError(`Runtime generation changed after accepting ${pending.capability}`)
        : new RuntimeUnavailableBeforeEffectError("Runtime generation was replaced"));
    }
    for (const controller of this.uiAbort.values()) controller.abort();
    this.uiAbort.clear();
  }
  private publishLoss(error: unknown): void { if (this.lossPublished) return; this.lossPublished = true; const event: RuntimeEvent = { type: "dock_runtime_lost", operationId: "runtime-worker", kind: "create", error: error instanceof Error ? error.message : String(error), recoverySessionFile: this.cacheValue?.durableSessionFile ?? this.cacheValue?.sessionFile }; for (const listener of this.listeners) { try { listener(event); } catch {} } }
}

function isReplacementCapability(capability: RuntimeCapability | UiCapability): boolean {
  return capability === "runtime.newSession" || capability === "runtime.switchSession"
    || capability === "runtime.fork" || capability === "runtime.reload";
}
function extensionCommandName(text: string): string | undefined { if (!text.startsWith("/")) return undefined; const end = text.search(/\s/); const name = text.slice(1, end < 0 ? undefined : end); return name || undefined; }
