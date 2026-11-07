import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";

/*
 * A long-lived helper process a Host starts and keeps alive, such as Main's model service (card
 * #303) and assistant service (card #295). One question at a time goes out as a request with an ID
 * and comes back as one result; the process says when it is ready.
 */

export type ServiceInbound =
  | { type: "request"; id: string; request: unknown }
  | { type: "cancel"; id: string };

export type ServiceOutbound =
  | { type: "ready" }
  | { type: "result"; id: string; ok: true; result: unknown }
  /** `code` names a refusal the asker can act on; without it the failure is the service's own. */
  | { type: "result"; id: string; ok: false; error: string; code?: string };

/** The service answered, and its answer was a refusal. */
export class ServiceAnswerError extends Error {
  constructor(message: string, readonly code: string | undefined) { super(message); this.name = "ServiceAnswerError"; }
}

export interface SupervisedServiceOptions {
  /** Names the service in messages, such as "The model service on Main". */
  label: string;
  entry: string;
  /** The environment the process starts with; read again for every start. */
  environment(): Promise<NodeJS.ProcessEnv>;
  /** Builds the error for a service that is not there to answer. */
  unavailable(message: string): Error;
  /** The message of a question its asker cancelled. */
  cancelledMessage: string;
  /** How long a question waits for a starting or restarting service. */
  readyWaitMs?: number;
  /** A service that has not said it is ready by then is stopped and started again. */
  startTimeoutMs?: number;
}

interface Pending {
  child: ChildProcess;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** A service that stayed up this long after saying it is ready starts its restart delays over. */
const STABLE_RUN_MS = 60_000;

/**
 * Starts and watches one service process. A crash fails the questions in flight and starts the
 * service again; questions not yet sent wait for it.
 */
export class SupervisedService {
  private child: ChildProcess | undefined;
  /** The child once it said it is ready; requests go only to it. */
  private readyChild: ChildProcess | undefined;
  private firstStart: Promise<void> | undefined;
  private onFirstStart: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly pending = new Map<string, Pending>();
  private stopped = false;
  /** Set when a wait for the service ran out; questions then fail at once until it is ready again. */
  private unavailable = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: SupervisedServiceOptions) {}

  /** Resolves when the service first becomes ready; it keeps restarting on its own after that. */
  start(): Promise<void> {
    this.stopped = false;
    this.firstStart ??= new Promise<void>((resolve, reject) => {
      this.onFirstStart = { resolve, reject };
      this.spawn();
    });
    return this.firstStart;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    const child = this.child;
    this.child = undefined;
    this.readyChild = undefined;
    this.wakeWaiters();
    this.failPending(this.options.unavailable(`The Dock Host stopped ${lowerFirst(this.options.label)}`));
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(kill); resolve(); });
      child.kill("SIGTERM");
    });
  }

  /** The service process while it runs; tests use it to stop the service from outside. */
  get pid(): number | undefined { return this.child?.pid; }

  async request(request: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = await this.running(signal);
    // A cancel that came while waiting for the service: the question is not sent.
    if (signal?.aborted) throw new Error(this.options.cancelledMessage);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      // The caller is released at once; a late answer is dropped.
      const cancel = () => {
        this.pending.delete(id);
        reject(new Error(this.options.cancelledMessage));
        void this.send(child, { type: "cancel", id }).catch(() => {});
      };
      const settle = <T>(done: (value: T) => void) => (value: T) => { signal?.removeEventListener("abort", cancel); done(value); };
      this.pending.set(id, { child, resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener("abort", cancel, { once: true });
      this.send(child, { type: "request", id, request }).catch((error) => {
        this.pending.get(id)?.reject(this.options.unavailable(`${this.options.label} did not take the request: ${error instanceof Error ? error.message : String(error)}`));
        this.pending.delete(id);
      });
    });
  }

  /** A question not yet sent waits for a start or restart, until its deadline or its cancel. */
  private async running(signal?: AbortSignal): Promise<ChildProcess> {
    const deadline = Date.now() + (this.options.readyWaitMs ?? 15_000);
    while (true) {
      if (this.stopped) throw this.options.unavailable(`${this.options.label} is stopped`);
      if (signal?.aborted) throw new Error(this.options.cancelledMessage);
      if (this.readyChild?.connected) return this.readyChild;
      const left = deadline - Date.now();
      if (left <= 0 || this.unavailable) {
        this.unavailable = true;
        throw this.options.unavailable(`${this.options.label} is not running. Check the Dock Host log on Main.`);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        signal?.addEventListener("abort", done, { once: true });
        this.waiters.add(done);
      });
    }
  }

  private spawn(): void {
    void (async () => {
      let environment: NodeJS.ProcessEnv;
      try {
        environment = await this.options.environment();
      } catch (error) {
        this.startFailed(this.options.unavailable(`${this.options.label} could not read the login environment: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (this.stopped) return;
      let child: ChildProcess;
      try {
        child = fork(this.options.entry, [], { env: environment, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      } catch (error) {
        this.startFailed(this.options.unavailable(`${this.options.label} could not start: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.child = child;
      let started = false;
      let ended = false;
      const startTimer = setTimeout(() => { if (!started) child.kill("SIGKILL"); }, this.options.startTimeoutMs ?? 60_000);
      // A process that could not be created reports "error" and may never report "exit".
      const end = (how: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(startTimer);
        clearTimeout(this.stableTimer);
        if (this.child === child) this.child = undefined;
        if (this.readyChild === child) this.readyChild = undefined;
        this.failPending(this.options.unavailable(`${this.options.label} stopped while answering (${how}).`), child);
        if (started) this.scheduleRestart();
        else this.startFailed(this.options.unavailable(`${this.options.label} could not start (${how}). Check the Dock Host log on Main.`));
      };
      child.on("message", (message: ServiceOutbound) => {
        if (message?.type === "ready") {
          if (started) return;
          started = true;
          clearTimeout(startTimer);
          // Only a service that keeps running starts its restart delays over; one that says it is
          // ready and then falls over again and again keeps backing off.
          clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => { if (this.readyChild === child) this.restarts = 0; }, STABLE_RUN_MS);
          this.stableTimer.unref();
          this.unavailable = false;
          this.readyChild = child;
          this.onFirstStart?.resolve();
          this.onFirstStart = undefined;
          this.wakeWaiters();
          return;
        }
        this.receive(message);
      });
      child.on("error", (error) => { if (child.pid === undefined) end(error.message); });
      child.once("exit", (code, signal) => end(signal ?? `exit ${code}`));
    })();
  }

  private startFailed(error: Error): void {
    this.onFirstStart?.reject(error);
    this.onFirstStart = undefined;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts++, RESTART_DELAYS_MS.length - 1)];
    this.restartTimer = setTimeout(() => { if (!this.stopped) this.spawn(); }, delay);
  }

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private receive(message: ServiceOutbound): void {
    if (message?.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ServiceAnswerError(message.error, message.code));
  }

  private failPending(error: Error, child?: ChildProcess): void {
    for (const [id, pending] of this.pending) {
      if (child && pending.child !== child) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private send(child: ChildProcess, message: ServiceInbound): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error(`${this.options.label} is not connected`)); return; }
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * The service process's side: answers each request with `answer`, relays cancels, and says it is
 * ready. Call it once the service is set up. A failed answer carries the error's `code` when it has
 * one. `stop` runs when the Host goes away; by default the process exits.
 */
export async function serveRequests(answer: (request: unknown, signal: AbortSignal) => Promise<unknown>, stop: () => void = () => process.exit(0)): Promise<void> {
  if (!process.send) throw new Error("The service must be started by the Dock Host");
  const active = new Map<string, AbortController>();
  const send = (message: ServiceOutbound): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error("The Dock Host disconnected")); return; }
    process.send!(message, undefined, undefined, (error) => (error ? reject(error) : resolve()));
  });
  const run = async (id: string, request: unknown): Promise<void> => {
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const result = await answer(request, controller.signal);
      await send({ type: "result", id, ok: true, result });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      await send({
        type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error),
        ...(typeof code === "string" ? { code } : {}),
      }).catch(() => {});
    } finally {
      active.delete(id);
    }
  };
  process.on("message", (raw: ServiceInbound) => {
    if (raw?.type === "request" && typeof raw.id === "string" && !active.has(raw.id)) void run(raw.id, raw.request);
    else if (raw?.type === "cancel" && typeof raw.id === "string") active.get(raw.id)?.abort();
  });
  process.on("disconnect", stop);
  await send({ type: "ready" });
}

function lowerFirst(text: string): string { return text.charAt(0).toLowerCase() + text.slice(1); }
