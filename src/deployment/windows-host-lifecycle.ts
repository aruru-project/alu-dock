import { createConnection, createServer, type Server, type Socket } from "node:net";

export const WINDOWS_HOST_LIFECYCLE_PIPE = "\\\\.\\pipe\\alu-dock-host-lifecycle";
const MAX_LIFECYCLE_LINE_BYTES = 4 * 1024;
const LIFECYCLE_TIMEOUT_MS = 2_000;

export interface WindowsHostLifecycleStatus {
  ready: boolean;
  phase?: "starting" | "ready" | "stopping";
  pid: number;
  hostEpoch?: string;
  role?: "main" | "subhost";
  blockingWork: number;
  mainConnected?: boolean;
  restoringWorks?: boolean;
  unavailableWorks?: number;
}

export type WindowsHostLifecycleStopResult = WindowsHostLifecycleStatus & { stopAccepted: boolean };

export interface WindowsHostLifecycleServerOptions {
  platform?: NodeJS.Platform;
  endpoint?: string;
}

export class WindowsHostLifecycleServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private runtimeStatus: () => Pick<WindowsHostLifecycleStatus, "mainConnected" | "restoringWorks" | "unavailableWorks"> = () => ({});
  private ready: {
    hostEpoch: string;
    role: "main" | "subhost";
  } | undefined;
  private stopping = false;
  private onStop: (() => void) | undefined;
  private blockingWork: () => number = () => 0;
  private readonly stopPromise: Promise<void>;
  private requestStop!: () => void;

  constructor(private readonly options: WindowsHostLifecycleServerOptions = {}) {
    this.server = createServer((socket) => this.accept(socket));
    this.stopPromise = new Promise<void>((resolveStop) => { this.requestStop = resolveStop; });
  }

  async start(): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "win32") throw new Error("The Windows Host lifecycle endpoint is only available on Windows");
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => { this.server.off("listening", onListening); rejectStart(error); };
      const onListening = (): void => { this.server.off("error", onError); resolveStart(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ path: this.options.endpoint ?? WINDOWS_HOST_LIFECYCLE_PIPE, readableAll: false, writableAll: false });
    });
  }

  markReady(
    hostEpoch: string,
    role: "main" | "subhost",
    blockingWork: () => number,
    beginStop: () => void,
    runtimeStatus: () => Pick<WindowsHostLifecycleStatus, "mainConnected" | "restoringWorks" | "unavailableWorks"> = () => ({}),
  ): void {
    if (this.stopping) return;
    this.ready = { hostEpoch, role };
    this.runtimeStatus = runtimeStatus;
    this.onStartingStop(beginStop, blockingWork);
  }

  get stopRequested(): boolean { return this.stopping; }

  onStartingStop(callback: () => void, blockingWork: () => number = () => 0): void {
    this.onStop = callback;
    this.blockingWork = blockingWork;
    if (this.stopping) callback();
  }

  beginStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.onStop?.();
    this.requestStop();
  }

  waitForStop(): Promise<void> { return this.stopPromise; }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
      // Flush an accepted stop response, but don't let a client that sent no
      // request keep the already-stopped Host process alive indefinitely.
      for (const socket of this.sockets) socket.destroySoon();
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    const fail = (): void => { socket.destroy(); };
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_LIFECYCLE_LINE_BYTES) { fail(); return; }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      socket.removeAllListeners("data");
      if (newline !== bytes.length - 1) { fail(); return; }
      try {
        const request = parseRequest(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown);
        const blockingWork = this.blockingWork();
        const stopAccepted = request === "stop" ? blockingWork === 0 : undefined;
        if (stopAccepted) {
          this.beginStop();
        }
        const response = {
          ready: this.ready !== undefined && !this.stopping,
          phase: this.stopping ? "stopping" : this.ready ? "ready" : "starting",
          pid: process.pid,
          blockingWork,
          ...this.runtimeStatus(),
          ...(this.ready === undefined ? {} : { hostEpoch: this.ready.hostEpoch, role: this.ready.role }),
          ...(stopAccepted === undefined ? {} : { stopAccepted }),
        };
        socket.end(`${JSON.stringify(response)}\n`);
      } catch { fail(); }
    });
    socket.once("error", () => {});
  }
}

export async function readWindowsHostLifecycleStatus(timeoutMs = LIFECYCLE_TIMEOUT_MS, endpoint = WINDOWS_HOST_LIFECYCLE_PIPE): Promise<WindowsHostLifecycleStatus | undefined> {
  try { return await request("status", timeoutMs, endpoint); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) return undefined;
    throw error;
  }
}

export async function requestWindowsHostStop(timeoutMs = LIFECYCLE_TIMEOUT_MS, endpoint = WINDOWS_HOST_LIFECYCLE_PIPE): Promise<WindowsHostLifecycleStopResult | undefined> {
  try { return await request("stop", timeoutMs, endpoint) as WindowsHostLifecycleStopResult; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) return undefined;
    throw error;
  }
}

async function request(action: "status" | "stop", timeoutMs: number, endpoint: string): Promise<WindowsHostLifecycleStatus> {
  return new Promise<WindowsHostLifecycleStatus>((resolveResponse, rejectResponse) => {
    const socket = createConnection(endpoint);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Windows Host lifecycle request timed out")), timeoutMs);
    const finish = (error?: Error, value?: WindowsHostLifecycleStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(value as WindowsHostLifecycleStatus);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ action })}\n`));
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_LIFECYCLE_LINE_BYTES) { finish(new Error("Windows Host lifecycle response is too large")); return; }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) { finish(new Error("Windows Host lifecycle response has trailing data")); return; }
      try { finish(undefined, parseStatus(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown, action)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => { if (bytes.indexOf(0x0a) < 0) finish(new Error("Windows Host lifecycle response ended early")); });
  });
}

function parseRequest(input: unknown): "status" | "stop" {
  if (!isRecord(input) || Object.keys(input).length !== 1 || (input.action !== "status" && input.action !== "stop")) throw new Error("Windows Host lifecycle request is invalid");
  return input.action;
}

function parseStatus(input: unknown, action: "status" | "stop"): WindowsHostLifecycleStatus | WindowsHostLifecycleStopResult {
  if (!isRecord(input)) throw new Error("Windows Host lifecycle response is invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => !["ready", "phase", "pid", "hostEpoch", "role", "blockingWork", "stopAccepted", "mainConnected", "restoringWorks", "unavailableWorks"].includes(key))) throw new Error("Windows Host lifecycle response is invalid");
  if (typeof input.ready !== "boolean" || !Number.isSafeInteger(input.pid) || Number(input.pid) < 1 || !Number.isSafeInteger(input.blockingWork) || Number(input.blockingWork) < 0) throw new Error("Windows Host lifecycle response is invalid");
  if ((action === "stop") !== (typeof input.stopAccepted === "boolean")) throw new Error("Windows Host lifecycle stop result is invalid");
  if (input.hostEpoch !== undefined && (typeof input.hostEpoch !== "string" || input.hostEpoch.length < 1 || input.hostEpoch.length > 128)) throw new Error("Windows Host lifecycle response is invalid");
  if (input.role !== undefined && input.role !== "main" && input.role !== "subhost") throw new Error("Windows Host lifecycle response is invalid");
  if (input.phase !== undefined && !["starting", "ready", "stopping"].includes(String(input.phase))) throw new Error("Windows Host lifecycle phase is invalid");
  if (input.ready && !(input.hostEpoch !== undefined && input.role !== undefined)) throw new Error("Windows Host lifecycle readiness is inconsistent");
  if (input.mainConnected !== undefined && typeof input.mainConnected !== "boolean") throw new Error("Windows Host connection status is invalid");
  if (input.restoringWorks !== undefined && typeof input.restoringWorks !== "boolean") throw new Error("Windows Host recovery status is invalid");
  if (input.unavailableWorks !== undefined && (!Number.isSafeInteger(input.unavailableWorks) || Number(input.unavailableWorks) < 0)) throw new Error("Windows Host recovery count is invalid");
  return {
    ready: input.ready,
    ...(input.phase === undefined ? {} : { phase: input.phase as WindowsHostLifecycleStatus["phase"] }),
    pid: Number(input.pid),
    blockingWork: Number(input.blockingWork),
    ...(input.mainConnected === undefined ? {} : { mainConnected: input.mainConnected }),
    ...(input.restoringWorks === undefined ? {} : { restoringWorks: input.restoringWorks }),
    ...(input.unavailableWorks === undefined ? {} : { unavailableWorks: Number(input.unavailableWorks) }),
    ...(input.hostEpoch === undefined ? {} : { hostEpoch: input.hostEpoch }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.stopAccepted === undefined ? {} : { stopAccepted: input.stopAccepted }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
