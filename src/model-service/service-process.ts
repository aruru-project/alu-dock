import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { Api, Model } from "@earendil-works/pi-ai";

import { captureWorkspaceShellEnvironment } from "../pi/workspace-shell-environment.js";
import type {
  ModelAuthRequest,
  ModelAuthResult,
  ModelCatalogSnapshot,
  ModelRequestAuthResult,
  ModelRouteRequest,
  ModelRouteResult,
  ModelServiceRequest,
  ModelStreamRequest,
  WireModelEvent,
} from "./protocol.js";
import { MODEL_SERVICE_AGENT_DIR_ENV, type ServiceInbound, type ServiceOutbound } from "./service-messages.js";

/** What a Host offers its Workers for model access. */
export interface ModelHostPort {
  catalog(): Promise<ModelCatalogSnapshot>;
  resolve(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteResult>;
  /** Resolves after the final event; rejects when the request ended without one. */
  stream(request: ModelStreamRequest, onEvent: (wire: WireModelEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
  auth(request: ModelAuthRequest, signal: AbortSignal): Promise<ModelAuthResult>;
  requestAuth(model: Model<Api>, signal: AbortSignal): Promise<ModelRequestAuthResult>;
}

export class ModelServiceUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ModelServiceUnavailableError"; }
}

export interface ModelServiceProcessOptions {
  agentDir: string;
  /** Test seam; production captures the owner's login shell like Workers do, so key variables match. */
  environment?: NodeJS.ProcessEnv;
  entry?: string;
  /** How long a request that was not sent yet waits for a starting or restarting service. */
  readyWaitMs?: number;
  /** A service that has not said it is ready by then is stopped and started again. */
  startTimeoutMs?: number;
}

interface Pending {
  child: ChildProcess;
  resolve(result: unknown): void;
  reject(error: Error): void;
  onEvent?: (wire: WireModelEvent) => Promise<void>;
  /** Events are forwarded in order; the result waits for the last one. It never rejects. */
  chain: Promise<void>;
}

const DEFAULT_ENTRY = fileURLToPath(new URL("./service-entry.js", import.meta.url));
const RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Starts and watches the model service process for a Host. A crash fails the requests in flight,
 * which may already have reached a provider, and starts the service again; requests not yet sent wait.
 */
export class ModelServiceProcess implements ModelHostPort {
  private child: ChildProcess | undefined;
  /** The child once it said it is ready; requests go only to it. */
  private readyChild: ChildProcess | undefined;
  private firstStart: Promise<void> | undefined;
  private readonly pending = new Map<string, Pending>();
  private stopped = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: ModelServiceProcessOptions) {}

  /** Resolves when the service first becomes ready; it keeps restarting on its own after that. */
  start(): Promise<void> {
    this.stopped = false;
    this.firstStart ??= new Promise<void>((resolve, reject) => {
      this.onFirstStart = { resolve, reject };
      this.spawn();
    });
    return this.firstStart;
  }

  private onFirstStart: { resolve(): void; reject(error: Error): void } | undefined;

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    this.readyChild = undefined;
    this.wakeWaiters();
    this.failPending(new ModelServiceUnavailableError("The Dock Host stopped the model service"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(kill); resolve(); });
      child.kill("SIGTERM");
    });
  }

  /** The service process while it runs; tests use it to stop the service from outside. */
  get pid(): number | undefined { return this.child?.pid; }

  catalog(): Promise<ModelCatalogSnapshot> {
    return this.request({ op: "catalog" }) as Promise<ModelCatalogSnapshot>;
  }

  resolve(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteResult> {
    return this.request({ op: "resolve", ...request }, signal) as Promise<ModelRouteResult>;
  }

  async stream(request: ModelStreamRequest, onEvent: (wire: WireModelEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    await this.request({ op: "stream", ...request }, signal, onEvent);
  }

  auth(request: ModelAuthRequest, signal: AbortSignal): Promise<ModelAuthResult> {
    return this.request({ op: "auth", ...request }, signal) as Promise<ModelAuthResult>;
  }

  requestAuth(model: Model<Api>, signal: AbortSignal): Promise<ModelRequestAuthResult> {
    return this.request({ op: "request_auth", model }, signal) as Promise<ModelRequestAuthResult>;
  }

  private async request(request: ModelServiceRequest, signal?: AbortSignal, onEvent?: (wire: WireModelEvent) => Promise<void>): Promise<unknown> {
    const child = await this.running(signal);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => { void this.send(child, { type: "cancel", id }).catch(() => {}); };
      const settle = <T>(done: (value: T) => void) => (value: T) => { signal?.removeEventListener("abort", cancel); done(value); };
      this.pending.set(id, { child, resolve: settle(resolve), reject: settle(reject), ...(onEvent ? { onEvent } : {}), chain: Promise.resolve() });
      signal?.addEventListener("abort", cancel, { once: true });
      this.send(child, { type: "request", id, request }).catch((error) => {
        this.pending.get(id)?.reject(new ModelServiceUnavailableError(`The model service on Main did not take the request: ${error instanceof Error ? error.message : String(error)}`));
        this.pending.delete(id);
      });
    });
  }

  /** A request not yet sent can safely wait for a start or restart, until its deadline or its cancel. */
  private async running(signal?: AbortSignal): Promise<ChildProcess> {
    const deadline = Date.now() + (this.options.readyWaitMs ?? 30_000);
    while (true) {
      if (this.stopped) throw new ModelServiceUnavailableError("The model service on Main is stopped");
      if (signal?.aborted) throw new Error("Model request cancelled");
      if (this.readyChild?.connected) return this.readyChild;
      const left = deadline - Date.now();
      if (left <= 0) throw new ModelServiceUnavailableError("The model service on Main is not running. Check the Dock Host log on Main.");
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
        environment = this.options.environment ?? await captureWorkspaceShellEnvironment(homedir());
      } catch (error) {
        this.startFailed(new ModelServiceUnavailableError(`The model service on Main could not read the login environment: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (this.stopped) return;
      const child = fork(this.options.entry ?? DEFAULT_ENTRY, [], {
        env: { ...environment, [MODEL_SERVICE_AGENT_DIR_ENV]: this.options.agentDir },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      this.child = child;
      let started = false;
      const startTimer = setTimeout(() => { if (!started) child.kill("SIGKILL"); }, this.options.startTimeoutMs ?? 60_000);
      child.on("message", (message: ServiceOutbound) => {
        if (message?.type === "ready") {
          if (started) return;
          started = true;
          clearTimeout(startTimer);
          this.restarts = 0;
          this.readyChild = child;
          this.onFirstStart?.resolve();
          this.onFirstStart = undefined;
          this.wakeWaiters();
          return;
        }
        this.receive(message);
      });
      child.once("error", () => { /* "exit" follows and handles it. */ });
      child.once("exit", (code, signal) => {
        clearTimeout(startTimer);
        if (this.child === child) this.child = undefined;
        if (this.readyChild === child) this.readyChild = undefined;
        const how = signal ?? `exit ${code}`;
        this.failPending(new ModelServiceUnavailableError(`The model service on Main stopped while answering (${how}).`), child);
        if (started) this.scheduleRestart();
        else this.startFailed(new ModelServiceUnavailableError(`The model service on Main could not start (${how}). Check the Dock Host log on Main.`));
      });
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
    if (message?.type !== "event" && message?.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      const onEvent = pending.onEvent;
      // A reply the Worker can no longer take (it exited, say) ends here and stops at the provider.
      if (onEvent) pending.chain = pending.chain.then(() => onEvent(message.wire)).catch((error: unknown) => this.abandon(message.id, pending, error));
      return;
    }
    this.pending.delete(message.id);
    void pending.chain.then(() => (message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error))));
  }

  private abandon(id: string, pending: Pending, error: unknown): void {
    if (this.pending.get(id) === pending) this.pending.delete(id);
    void this.send(pending.child, { type: "cancel", id }).catch(() => {});
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private failPending(error: Error, child?: ChildProcess): void {
    for (const [id, pending] of this.pending) {
      if (child && pending.child !== child) continue;
      this.pending.delete(id);
      void pending.chain.then(() => pending.reject(error));
    }
  }

  private send(child: ChildProcess, message: ServiceInbound): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error("The model service is not connected")); return; }
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }
}
