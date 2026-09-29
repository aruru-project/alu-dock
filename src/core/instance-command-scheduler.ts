import type { InstanceLifecycle } from "./instance-dto.js";

export type ExclusiveCommandKind = "general" | "navigation" | "compaction";
export type ExclusiveAdmission = "idle" | "live" | "run_preempting";
export type ControlCommandKind = "immediate" | "queue";
/** An interrupt that also takes the waiting Queue back for the caller. */
export type InterruptCommandKind = "restore_queue";
type CommandKind = ExclusiveCommandKind | ControlCommandKind | InterruptCommandKind;

export type InstanceCommandRequest =
  | { class: "terminal" }
  | { class: "exclusive"; kind: ExclusiveCommandKind; admission: ExclusiveAdmission }
  | { class: "model-settings" }
  | { class: "input" }
  | { class: "interrupt"; kind?: InterruptCommandKind }
  | { class: "control"; kind: ControlCommandKind };

export interface InstanceCommandFacts {
  acceptingCommands: boolean;
  lifecycle: InstanceLifecycle;
  runtimeGeneration: number;
  executionRunning: boolean;
  runtimeStreaming: boolean;
  compactionActive: boolean;
  pendingQueueMessages: number;
  inFlightQueueMessages: number;
  pendingSteering: number;
  pendingFollowUp: number;
}

interface ActiveCommand {
  token: symbol;
  request: InstanceCommandRequest;
  generation: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  effectStarted: Promise<boolean>;
  resolveEffectStarted: (started: boolean) => void;
  releaseProjection?: () => void;
}

export interface ActiveCommandView {
  kind?: CommandKind;
  completion: Promise<void>;
  effectStarted: Promise<boolean>;
}

export class InstanceCommandLease {
  private released = false;
  private started = false;

  constructor(
    private readonly scheduler: InstanceCommandScheduler,
    private readonly command: ActiveCommand,
  ) {}

  get generation(): number { return this.command.generation; }
  get kind(): CommandKind | undefined {
    return "kind" in this.command.request ? this.command.request.kind : undefined;
  }

  markEffectStarted(): void {
    if (this.released || this.started || !this.scheduler.current(this.command)) return;
    this.started = true;
    this.command.resolveEffectStarted(true);
  }

  current(runtimeGeneration: number): boolean {
    return !this.released && runtimeGeneration === this.command.generation && this.scheduler.current(this.command);
  }

  effectAllowed(runtimeGeneration: number): boolean {
    return this.current(runtimeGeneration) && this.scheduler.effectAllowed(this.command);
  }

  /** End only the startup read barrier; the effect lease stays active. */
  releaseProjection(): void {
    const release = this.command.releaseProjection;
    this.command.releaseProjection = undefined;
    release?.();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (!this.started) this.command.resolveEffectStarted(false);
    this.scheduler.release(this.command);
  }
}

export type InstanceCommandDecision =
  | { kind: "start"; lease: InstanceCommandLease }
  | { kind: "wait"; lease: InstanceCommandLease; forCompletion: Promise<void> }
  | { kind: "preempt"; lease: InstanceCommandLease; preempted: ActiveCommandView }
  | { kind: "join"; active: ActiveCommandView }
  | { kind: "reject"; reason: "not_active" | "busy" | "input_admission"; lifecycle?: InstanceLifecycle };

export interface InstanceProjectionReadReservation {
  entered: Promise<void>;
  release(): void;
}

export type InstanceWorkerProjectionReadDecision =
  | { kind: "reserve"; reservation: InstanceProjectionReadReservation }
  | { kind: "reject"; reason: "not_active"; lifecycle: InstanceLifecycle };

export type InstanceProjectionReadDecision =
  | InstanceWorkerProjectionReadDecision
  | { kind: "available"; boundary: Promise<void> };

/**
 * Synchronous admission authority for one LocalInstance.
 * Long Worker effects run outside this object; leases retain completion custody.
 */
export class InstanceCommandScheduler {
  private readonly active = new Map<symbol, ActiveCommand>();
  private projectionTail: Promise<void> = Promise.resolve();

  constructor(private readonly facts: () => InstanceCommandFacts) {}

  admit(request: InstanceCommandRequest): InstanceCommandDecision {
    const facts = this.facts();
    const terminal = this.find("terminal");
    if (request.class === "terminal") {
      if (terminal) return { kind: "join", active: this.view(terminal) };
      if (!facts.acceptingCommands) return { kind: "reject", reason: "not_active", lifecycle: facts.lifecycle };
      return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
    }
    if (terminal || !facts.acceptingCommands) {
      return { kind: "reject", reason: "not_active", lifecycle: terminal ? "stopping" : facts.lifecycle };
    }

    const exclusive = this.find("exclusive");
    const input = this.find("input");
    const interrupt = this.find("interrupt");
    const queue = this.find("control", "queue");
    const modelSettings = this.find("model-settings");

    if (request.class === "model-settings") {
      if (modelSettings || input || interrupt || queue
        || (exclusive?.request.class === "exclusive" && exclusive.request.kind !== "compaction")) {
        return { kind: "reject", reason: "busy" };
      }
      const projection = this.reserveProjection();
      const lease = this.activate(request, facts.runtimeGeneration, projection.release);
      return { kind: "wait", lease, forCompletion: projection.entered };
    }

    if (request.class === "exclusive") {
      if (exclusive || modelSettings || input || interrupt || queue || facts.compactionActive) {
        return { kind: "reject", reason: "busy" };
      }
      if (request.admission !== "live" && this.hasQueueCustody(facts)) return { kind: "reject", reason: "busy" };
      if (request.admission === "idle" && (facts.executionRunning || facts.runtimeStreaming)) {
        return { kind: "reject", reason: "busy" };
      }
      const projection = this.reserveProjection();
      const lease = this.activate(request, facts.runtimeGeneration, projection.release);
      return { kind: "wait", lease, forCompletion: projection.entered };
    }

    if (request.class === "control") {
      if (request.kind === "immediate") return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
      if (exclusive || modelSettings || interrupt || queue) return { kind: "reject", reason: "busy" };
      if (input) return { kind: "reject", reason: "input_admission" };
      return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
    }

    if (request.class === "input") {
      if (input || modelSettings || interrupt || queue) return { kind: "reject", reason: input ? "input_admission" : "busy" };
      if (exclusive?.request.class === "exclusive" && exclusive.request.kind !== "compaction") {
        return { kind: "reject", reason: "busy" };
      }
      return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
    }

    if (interrupt || queue) return { kind: "reject", reason: "busy" };
    if (exclusive?.request.class === "exclusive") {
      const lease = this.activate(request, facts.runtimeGeneration);
      const view = this.view(exclusive);
      if (exclusive.request.kind === "navigation" || exclusive.request.kind === "compaction") {
        return { kind: "preempt", lease, preempted: view };
      }
      return { kind: "wait", lease, forCompletion: exclusive.completion };
    }
    // Preserve normal configuration ordering, but never delay aborting an
    // active auto-compaction behind a settings write.
    if (modelSettings && !facts.compactionActive) {
      return { kind: "wait", lease: this.activate(request, facts.runtimeGeneration), forCompletion: modelSettings.completion };
    }
    if (input) return { kind: "reject", reason: "input_admission" };
    return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
  }

  admitProjectionRead(kind: "worker"): InstanceWorkerProjectionReadDecision;
  admitProjectionRead(kind: "committed"): InstanceProjectionReadDecision;
  admitProjectionRead(kind: "worker" | "committed"): InstanceProjectionReadDecision {
    const facts = this.facts();
    const terminal = this.find("terminal");
    if (terminal || !facts.acceptingCommands) {
      return { kind: "reject", reason: "not_active", lifecycle: terminal ? "stopping" : facts.lifecycle };
    }
    const exclusive = this.find("exclusive");
    if (kind === "committed" && exclusive?.request.class === "exclusive" && exclusive.request.kind === "compaction") {
      return { kind: "available", boundary: exclusive.completion };
    }
    return { kind: "reserve", reservation: this.reserveProjection() };
  }

  activeCommand(commandClass: InstanceCommandRequest["class"], kind?: CommandKind): ActiveCommandView | undefined {
    const command = this.find(commandClass, kind);
    return command ? this.view(command) : undefined;
  }


  nonTerminalCompletions(): Promise<void>[] {
    return [...this.active.values()]
      .filter((command) => command.request.class !== "terminal")
      .map((command) => command.completion);
  }

  markEffectStarted(commandClass: InstanceCommandRequest["class"], kind?: CommandKind): void {
    this.find(commandClass, kind)?.resolveEffectStarted(true);
  }

  current(command: ActiveCommand): boolean {
    return this.active.get(command.token) === command;
  }

  effectAllowed(command: ActiveCommand): boolean {
    return command.request.class === "terminal" || this.find("terminal") === undefined;
  }

  release(command: ActiveCommand): void {
    if (!this.current(command)) return;
    this.active.delete(command.token);
    command.releaseProjection?.();
    command.resolveCompletion();
  }

  private activate(request: InstanceCommandRequest, generation: number, releaseProjection?: () => void): InstanceCommandLease {
    const token = Symbol(request.class);
    let resolveCompletion!: () => void;
    let resolveEffectStarted!: (started: boolean) => void;
    const command: ActiveCommand = {
      token,
      request,
      generation,
      completion: new Promise<void>((resolve) => { resolveCompletion = resolve; }),
      resolveCompletion: () => resolveCompletion(),
      effectStarted: new Promise<boolean>((resolve) => { resolveEffectStarted = resolve; }),
      resolveEffectStarted: (started) => resolveEffectStarted(started),
      ...(releaseProjection === undefined ? {} : { releaseProjection }),
    };
    this.active.set(token, command);
    return new InstanceCommandLease(this, command);
  }

  private find(commandClass: InstanceCommandRequest["class"], kind?: CommandKind): ActiveCommand | undefined {
    for (const command of this.active.values()) {
      if (command.request.class !== commandClass) continue;
      if (kind === undefined || ("kind" in command.request && command.request.kind === kind)) return command;
    }
    return undefined;
  }

  private reserveProjection(): InstanceProjectionReadReservation {
    const entered = this.projectionTail;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    this.projectionTail = entered.then(() => held, () => held);
    let released = false;
    return {
      entered,
      release: () => {
        if (released) return;
        released = true;
        releaseHeld();
      },
    };
  }

  private view(command: ActiveCommand): ActiveCommandView {
    return {
      ...("kind" in command.request ? { kind: command.request.kind } : {}),
      completion: command.completion,
      effectStarted: command.effectStarted,
    };
  }

  private hasQueueCustody(facts: InstanceCommandFacts): boolean {
    return facts.pendingQueueMessages > 0
      || facts.inFlightQueueMessages > 0
      || facts.pendingSteering > 0
      || facts.pendingFollowUp > 0;
  }
}
