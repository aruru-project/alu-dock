import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { captureWorkspaceShellEnvironment } from "../pi/workspace-shell-environment.js";
import type { ModelCatalogSnapshot, ModelRouteRequest, ModelRouteResult, ModelServiceRequest, ModelStreamRequest, WireModelEvent } from "./protocol.js";
import { MODEL_SERVICE_AGENT_DIR_ENV, type ServiceInbound, type ServiceOutbound } from "./service-messages.js";

/** What a Host offers its Workers for model access. */
export interface ModelHostPort {
  catalog(): Promise<ModelCatalogSnapshot>;
  resolve(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteResult>;
  /** Resolves after the final event; rejects when the request ended without one. */
  stream(request: ModelStreamRequest, onEvent: (wire: WireModelEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
}

export class ModelServiceUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ModelServiceUnavailableError"; }
}

export interface ModelServiceProcessOptions {
  agentDir: string;
  /** Test seam; production captures the owner's login shell like Workers do, so key variables match. */
  environment?: NodeJS.ProcessEnv;
  entry?: string;
  /** How long a request that was not sent yet waits for a restarting service. */
  readyWaitMs?: number;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  onEvent?: (wire: WireModelEvent) => Promise<void>;
  /** Events are forwarded in order; the result waits for the last one. */
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
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<string, Pending>();
  private stopped = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: ModelServiceProcessOptions) {}

  start(): Promise<void> {
    this.stopped = false;
    this.ready ??= this.spawn();
    return this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
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

  private async request(request: ModelServiceRequest, signal?: AbortSignal, onEvent?: (wire: WireModelEvent) => Promise<void>): Promise<unknown> {
    const child = await this.running();
    if (signal?.aborted) throw new Error("Model request cancelled");
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => { void this.send(child, { type: "cancel", id }).catch(() => {}); };
      const settle = <T>(done: (value: T) => void) => (value: T) => { signal?.removeEventListener("abort", cancel); done(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), ...(onEvent ? { onEvent } : {}), chain: Promise.resolve() });
      signal?.addEventListener("abort", cancel, { once: true });
      this.send(child, { type: "request", id, request }).catch((error) => {
        this.pending.get(id)?.reject(new ModelServiceUnavailableError(`The model service on Main did not take the request: ${error instanceof Error ? error.message : String(error)}`));
        this.pending.delete(id);
      });
    });
  }

  /** A request not yet sent can safely wait for a restart. */
  private async running(): Promise<ChildProcess> {
    if (this.stopped) throw new ModelServiceUnavailableError("The model service on Main is stopped");
    const wait = this.options.readyWaitMs ?? 30_000;
    const deadline = Date.now() + wait;
    while (true) {
      try {
        await (this.ready ?? Promise.reject(new Error("restarting")));
        if (this.child?.connected) return this.child;
      } catch { /* restarting */ }
      const left = deadline - Date.now();
      if (left <= 0 || this.stopped) throw new ModelServiceUnavailableError("The model service on Main is not running. Check the Dock Host log on Main.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const environment = this.options.environment ?? await captureWorkspaceShellEnvironment(homedir());
        if (this.stopped) { reject(new ModelServiceUnavailableError("The model service on Main is stopped")); return; }
        const child = fork(this.options.entry ?? DEFAULT_ENTRY, [], {
          env: { ...environment, [MODEL_SERVICE_AGENT_DIR_ENV]: this.options.agentDir },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        this.child = child;
        let started = false;
        child.on("message", (message: ServiceOutbound) => {
          if (message?.type === "ready") {
            started = true;
            this.restarts = 0;
            resolve();
            for (const wake of this.waiters.splice(0)) wake();
            return;
          }
          this.receive(message);
        });
        child.once("error", (error) => { if (!started) reject(error); });
        child.once("exit", (code, signal) => {
          if (this.child === child) this.child = undefined;
          this.failPending(new ModelServiceUnavailableError(`The model service on Main stopped while answering (${signal ?? `exit ${code}`}).`));
          if (!started) reject(new ModelServiceUnavailableError(`The model service on Main could not start (${signal ?? `exit ${code}`}). Check the Dock Host log on Main.`));
          if (this.stopped) return;
          this.ready = undefined;
          const delay = RESTART_DELAYS_MS[Math.min(this.restarts++, RESTART_DELAYS_MS.length - 1)];
          this.restartTimer = setTimeout(() => {
            if (this.stopped) return;
            this.ready = this.spawn();
            this.ready.catch(() => {});
          }, delay);
        });
      })().catch(reject);
    });
  }

  private receive(message: ServiceOutbound): void {
    if (message?.type !== "event" && message?.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      const onEvent = pending.onEvent;
      if (onEvent) pending.chain = pending.chain.then(() => onEvent(message.wire));
      return;
    }
    this.pending.delete(message.id);
    pending.chain.then(
      () => (message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error))),
      (error) => pending.reject(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.chain.then(() => pending.reject(error), () => pending.reject(error));
    }
  }

  private send(child: ChildProcess, message: ServiceInbound): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error("The model service is not connected")); return; }
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }
}
