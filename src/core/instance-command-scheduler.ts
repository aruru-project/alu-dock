import type { InstanceLifecycle } from "./instance-dto.js";

export type ExclusiveCommandKind = "general" | "navigation" | "compaction";
export type ExclusiveAdmission = "idle" | "live" | "run_preempting";
export type ControlCommandKind = "immediate" | "queue";

function isolatesProjectionReads(kind: ExclusiveCommandKind): boolean {
  return kind !== "compaction";
}

export type InstanceCommandRequest =
  | { class: "terminal" }
  | { class: "exclusive"; kind: ExclusiveCommandKind; admission: ExclusiveAdmission }
  | { class: "input" }
  | { class: "interrupt" }
  | { class: "control"; kind: ControlCommandKind };

type ProjectionReadRequest = { class: "projection_read" };
type InstanceAdmissionRequest = InstanceCommandRequest | ProjectionReadRequest;

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
  request: InstanceAdmissionRequest;
  generation: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  effectStarted: Promise<boolean>;
  resolveEffectStarted: (started: boolean) => void;
}

export interface ActiveCommandView {
  kind?: ExclusiveCommandKind | ControlCommandKind;
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
  get kind(): ExclusiveCommandKind | ControlCommandKind | undefined {
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

export type InstanceProjectionReadDecision =
  | { kind: "start"; lease: InstanceCommandLease }
  | { kind: "wait"; lease: InstanceCommandLease; forCompletion: Promise<void> }
  | { kind: "reject"; reason: "not_active"; lifecycle: InstanceLifecycle };

/**
 * Synchronous admission authority for one LocalInstance.
 * Long Worker effects run outside this object; leases retain completion custody.
 */
export class InstanceCommandScheduler {
  private readonly active = new Map<symbol, ActiveCommand>();

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

    if (request.class === "exclusive") {
      if (exclusive || input || interrupt || queue || facts.compactionActive) {
        return { kind: "reject", reason: "busy" };
      }
      if (request.admission !== "live" && this.hasQueueCustody(facts)) return { kind: "reject", reason: "busy" };
      if (request.admission === "idle" && (facts.executionRunning || facts.runtimeStreaming)) {
        return { kind: "reject", reason: "busy" };
      }
      const lease = this.activate(request, facts.runtimeGeneration);
      const projectionReads = isolatesProjectionReads(request.kind) ? this.findAll("projection_read") : [];
      return projectionReads.length === 0
        ? { kind: "start", lease }
        : { kind: "wait", lease, forCompletion: Promise.all(projectionReads.map((read) => read.completion)).then(() => {}) };
    }

    if (request.class === "control") {
      if (request.kind === "immediate") return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
      if (exclusive || interrupt || queue) return { kind: "reject", reason: "busy" };
      if (input) return { kind: "reject", reason: "input_admission" };
      return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
    }

    if (request.class === "input") {
      if (input || interrupt || queue) return { kind: "reject", reason: input ? "input_admission" : "busy" };
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
    if (input) return { kind: "reject", reason: "input_admission" };
    return { kind: "start", lease: this.activate(request, facts.runtimeGeneration) };
  }

  admitProjectionRead(): InstanceProjectionReadDecision {
    const facts = this.facts();
    const terminal = this.find("terminal");
    if (terminal || !facts.acceptingCommands) {
      return { kind: "reject", reason: "not_active", lifecycle: terminal ? "stopping" : facts.lifecycle };
    }
    const lease = this.activate({ class: "projection_read" }, facts.runtimeGeneration);
    const exclusive = this.find("exclusive");
    return exclusive?.request.class === "exclusive" && isolatesProjectionReads(exclusive.request.kind)
      ? { kind: "wait", lease, forCompletion: exclusive.completion }
      : { kind: "start", lease };
  }

  activeCommand(commandClass: InstanceCommandRequest["class"], kind?: ExclusiveCommandKind | ControlCommandKind): ActiveCommandView | undefined {
    const command = this.find(commandClass, kind);
    return command ? this.view(command) : undefined;
  }


  nonTerminalCompletions(): Promise<void>[] {
    return [...this.active.values()]
      .filter((command) => command.request.class !== "terminal" && command.request.class !== "projection_read")
      .map((command) => command.completion);
  }

  markEffectStarted(commandClass: InstanceCommandRequest["class"], kind?: ExclusiveCommandKind | ControlCommandKind): void {
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
    command.resolveCompletion();
  }

  private activate(request: InstanceAdmissionRequest, generation: number): InstanceCommandLease {
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
    };
    this.active.set(token, command);
    return new InstanceCommandLease(this, command);
  }

  private find(commandClass: InstanceAdmissionRequest["class"], kind?: ExclusiveCommandKind | ControlCommandKind): ActiveCommand | undefined {
    for (const command of this.active.values()) {
      if (command.request.class !== commandClass) continue;
      if (kind === undefined || ("kind" in command.request && command.request.kind === kind)) return command;
    }
    return undefined;
  }

  private findAll(commandClass: InstanceAdmissionRequest["class"]): ActiveCommand[] {
    return [...this.active.values()].filter((command) => command.request.class === commandClass);
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
