import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, resolve } from "node:path";

import type { DockEvent, EventPage, ManagedInstance } from "../core/managed-instance.js";
import { DockRegistry, InstanceNotFoundError } from "./dock-registry.js";
import { encodeJsonLine, JsonLineDecoder, JsonLineError } from "./json-lines.js";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_CONTROL_LINE_BYTES,
  type ControlEventEnvelope,
  type ControlRequest,
  type ControlResponse,
  type EventsResult,
  parseControlRequest,
  ProtocolValidationError,
} from "./protocol.js";

const MAX_SOCKET_WRITE_BUFFER = MAX_CONTROL_LINE_BYTES;
const MAX_INITIAL_EVENT_QUEUE = 1_000;
const BACKPRESSURE_CLOSE_TIMEOUT_MS = 1_000;

type HostState = "new" | "starting" | "running" | "stopping" | "stopped";
type WriteOutcome = "written" | "backpressured" | "failed" | "too_large";
type SocketProbe = "active" | "stale" | "indeterminate";

interface SocketIdentity {
  dev: number;
  ino: number;
}

export interface DockHostOptions {
  socketPath: string;
  registry: DockRegistry;
}

export class DockHost {
  readonly socketPath: string;
  readonly registry: DockRegistry;

  private state: HostState = "new";
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly connections = new Set<Socket>();
  private readonly inFlightDispatches = new Set<Promise<void>>();

  constructor(options: DockHostOptions) {
    this.socketPath = resolve(options.socketPath);
    this.registry = options.registry;
  }

  start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting") return this.startPromise as Promise<void>;
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new Error(`Cannot start a host that is ${this.state}`));
    }

    this.state = "starting";
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.state === "stopped") return Promise.resolve();
    if (this.state === "stopping") return this.stopPromise as Promise<void>;

    this.state = "stopping";
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStart(): Promise<void> {
    let server: Server | undefined;
    let boundIdentity: SocketIdentity | undefined;
    try {
      await ensurePrivateSocketDirectory(this.socketPath);
      await prepareSocketPath(this.socketPath);
      if (this.state !== "starting") throw new Error("Host start was cancelled by shutdown");

      server = createServer(
        { allowHalfOpen: false, highWaterMark: MAX_SOCKET_WRITE_BUFFER },
        (socket) => this.handleConnection(socket),
      );
      this.server = server;
      await listen(server, this.socketPath);
      boundIdentity = await readSocketIdentity(this.socketPath);
      this.socketIdentity = boundIdentity;
      await chmod(this.socketPath, 0o600);
      await assertPrivateSocket(this.socketPath, boundIdentity);
      if (this.state === "starting") this.state = "running";
    } catch (error) {
      if (server) await closeServer(server);
      if (boundIdentity) await removeSocketIfOwned(this.socketPath, boundIdentity);
      if (this.server === server) this.server = undefined;
      if (this.state === "starting") this.state = "new";
      this.startPromise = undefined;
      throw error;
    }
  }

  private async performStop(): Promise<void> {
    try {
      if (this.startPromise) await this.startPromise.catch(() => {});

      const server = this.server;
      this.server = undefined;
      const closePromise = server ? closeServer(server) : Promise.resolve();
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      await closePromise;

      // A client disconnect does not cancel an admitted create. Shutdown waits
      // for it to finish, then stops the resulting instance with the registry.
      if (this.inFlightDispatches.size > 0) {
        await Promise.allSettled([...this.inFlightDispatches]);
      }
      await this.registry.stopAll();
      if (this.socketIdentity) {
        await removeSocketIfOwned(this.socketPath, this.socketIdentity);
      }
    } finally {
      this.socketIdentity = undefined;
      this.state = "stopped";
    }
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    const decoder = new JsonLineDecoder();
    let requestSeen = false;
    let eventUnsubscribe: (() => void) | undefined;

    const cleanup = (): void => {
      eventUnsubscribe?.();
      eventUnsubscribe = undefined;
      this.connections.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", () => {
      // close performs cleanup; transport errors never affect managed instances.
    });

    const consumeLine = (line: string): void => {
      if (line.length === 0) return;
      if (requestSeen) {
        this.sendErrorAndEnd(socket, "multiple_requests", "Only one request is allowed per connection", "unknown");
        return;
      }
      requestSeen = true;

      let request: ControlRequest;
      try {
        request = parseControlRequest(JSON.parse(line) as unknown);
      } catch (error) {
        const mapped = mapControlError(error);
        this.sendErrorAndEnd(socket, mapped.code, mapped.message, extractRequestId(line));
        return;
      }

      if (this.state !== "running") {
        this.sendErrorAndEnd(socket, "host_stopping", "Alu Dock host is not accepting requests", request.requestId);
        return;
      }

      let task!: Promise<void>;
      task = this.dispatch(request, socket, (unsubscribe) => {
        eventUnsubscribe = unsubscribe;
      }).catch((error: unknown) => {
        const mapped = mapControlError(error);
        this.sendErrorAndEnd(socket, mapped.code, mapped.message, request.requestId);
      }).finally(() => {
        this.inFlightDispatches.delete(task);
      });
      this.inFlightDispatches.add(task);
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) consumeLine(line);
      } catch (error) {
        const mapped = mapControlError(error);
        this.sendErrorAndEnd(socket, mapped.code, mapped.message, "unknown");
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        const mapped = mapControlError(error);
        this.sendErrorAndEnd(socket, mapped.code, mapped.message, "unknown");
      }
    });
  }

  private async dispatch(
    request: ControlRequest,
    socket: Socket,
    setEventUnsubscribe: (unsubscribe: () => void) => void,
  ): Promise<void> {
    switch (request.type) {
      case "ping":
        this.sendSuccessAndEnd(socket, request.requestId, {
          pid: process.pid,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
        });
        return;

      case "create": {
        const instance = await this.registry.create({ cwd: request.cwd, name: request.name });
        this.sendSuccessAndEnd(socket, request.requestId, { instance: instance.snapshot() });
        return;
      }

      case "list":
        this.sendSuccessAndEnd(socket, request.requestId, { instances: this.registry.list() });
        return;

      case "status":
        this.sendSuccessAndEnd(socket, request.requestId, {
          instance: this.registry.get(request.instanceId).snapshot(),
        });
        return;

      case "events":
        this.attachEventStream(request, socket, setEventUnsubscribe);
        return;
    }
  }

  private attachEventStream(
    request: Extract<ControlRequest, { type: "events" }>,
    socket: Socket,
    setEventUnsubscribe: (unsubscribe: () => void) => void,
  ): void {
    const instance = this.registry.get(request.instanceId);
    const since = request.since ?? 0;
    const follow = request.follow ?? false;
    let initializing = true;
    let pending: DockEvent[] = [];
    let lastSent = since;
    let unsubscribe = (): void => {};

    const closeAfterBackpressure = (): void => {
      unsubscribe();
      if (!socket.writableNeedDrain) {
        socket.end();
        return;
      }
      const timeout = setTimeout(() => socket.destroy(), BACKPRESSURE_CLOSE_TIMEOUT_MS);
      socket.once("drain", () => {
        clearTimeout(timeout);
        if (!socket.destroyed) socket.end();
      });
      socket.once("close", () => clearTimeout(timeout));
    };

    const sendLiveEvent = (event: DockEvent): boolean => {
      if (event.sequence <= lastSent) return true;
      const outcome = writeEvent(socket, request.requestId, event);
      if (outcome === "written" || outcome === "backpressured") {
        lastSent = event.sequence;
      }
      if (outcome === "written") return true;
      if (outcome === "backpressured") closeAfterBackpressure();
      else {
        unsubscribe();
        socket.destroy();
      }
      return false;
    };

    unsubscribe = instance.subscribe((event) => {
      if (initializing) {
        pending.push(event);
        if (pending.length > MAX_INITIAL_EVENT_QUEUE) {
          pending = [];
          unsubscribe();
          socket.destroy();
        }
        return;
      }
      sendLiveEvent(event);
    });
    setEventUnsubscribe(unsubscribe);

    const result = createBoundedEventsResult(instance, since, follow, request.requestId);
    const responseOutcome = writeEnvelope(socket, successResponse(request.requestId, result));
    if (responseOutcome !== "written") {
      initializing = false;
      pending = [];
      if (responseOutcome === "backpressured") {
        closeAfterBackpressure();
      } else if (responseOutcome === "too_large") {
        unsubscribe();
        this.sendErrorAndEnd(socket, "response_too_large", "Events response exceeds the JSONL record limit", request.requestId);
      } else {
        unsubscribe();
      }
      return;
    }
    lastSent = Math.max(since, result.page.latestSequence);
    initializing = false;

    pending.sort((left, right) => left.sequence - right.sequence);
    for (const event of pending) {
      if (!sendLiveEvent(event)) return;
    }
    pending = [];

    if (!follow) {
      unsubscribe();
      socket.end();
    }
  }

  private sendSuccessAndEnd(socket: Socket, requestId: string, result: unknown): void {
    if (socket.destroyed || socket.writableEnded) return;
    const outcome = endEnvelope(socket, successResponse(requestId, result));
    if (outcome === "too_large") {
      this.sendErrorAndEnd(socket, "response_too_large", "Control response exceeds the JSONL record limit", requestId);
    }
  }

  private sendErrorAndEnd(socket: Socket, code: string, message: string, requestId: string): void {
    if (socket.destroyed || socket.writableEnded) return;
    const response: ControlResponse = {
      kind: "response",
      version: 1,
      requestId,
      ok: false,
      error: { code, message: truncateMessage(message) },
    };
    const outcome = endEnvelope(socket, response);
    if (outcome === "too_large") socket.destroy();
  }
}

function successResponse(requestId: string, result: unknown): ControlResponse {
  return {
    kind: "response",
    version: 1,
    requestId,
    ok: true,
    result,
  };
}

function createBoundedEventsResult(
  instance: ManagedInstance,
  since: number,
  following: boolean,
  requestId: string,
): EventsResult {
  const source = instance.eventsSince(since);
  let events = source.events;
  let truncated = source.truncated;
  let earliestSequence = source.earliestSequence;

  while (true) {
    const page: EventPage = {
      events,
      earliestSequence,
      latestSequence: source.latestSequence,
      truncated,
    };
    const result: EventsResult = { instance: instance.snapshot(), page, following };
    if (encodedSize(successResponse(requestId, result)) <= MAX_CONTROL_LINE_BYTES) return result;
    if (events.length === 0) return result;
    events = events.slice(1);
    truncated = true;
    earliestSequence = events[0]?.sequence ?? source.latestSequence + 1;
  }
}

function writeEvent(socket: Socket, requestId: string, event: DockEvent): WriteOutcome {
  const envelope: ControlEventEnvelope = {
    kind: "event",
    version: 1,
    requestId,
    event,
  };
  return writeEnvelope(socket, envelope);
}

function writeEnvelope(socket: Socket, envelope: ControlResponse | ControlEventEnvelope): WriteOutcome {
  if (socket.destroyed || socket.writableEnded) return "failed";
  let encoded: string;
  try {
    encoded = encodeJsonLine(envelope);
  } catch {
    socket.destroy();
    return "failed";
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_CONTROL_LINE_BYTES) return "too_large";
  if (socket.writableLength + bytes > MAX_SOCKET_WRITE_BUFFER) {
    socket.destroy();
    return "failed";
  }
  try {
    return socket.write(encoded) ? "written" : "backpressured";
  } catch {
    socket.destroy();
    return "failed";
  }
}

function endEnvelope(socket: Socket, envelope: ControlResponse): WriteOutcome {
  if (socket.destroyed || socket.writableEnded) return "failed";
  let encoded: string;
  try {
    encoded = encodeJsonLine(envelope);
  } catch {
    socket.destroy();
    return "failed";
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_CONTROL_LINE_BYTES) return "too_large";
  if (socket.writableLength + bytes > MAX_SOCKET_WRITE_BUFFER) {
    socket.destroy();
    return "failed";
  }
  try {
    socket.end(encoded);
    return "written";
  } catch {
    socket.destroy();
    return "failed";
  }
}

function encodedSize(value: unknown): number {
  try {
    return Buffer.byteLength(encodeJsonLine(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function mapControlError(error: unknown): { code: string; message: string } {
  if (error instanceof ProtocolValidationError) return { code: error.code, message: error.message };
  if (error instanceof InstanceNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof SyntaxError) return { code: "invalid_json", message: "Request is not valid JSON" };
  if (error instanceof JsonLineError) {
    return {
      code: error.code === "record_too_large" ? "request_too_large" : "invalid_jsonl",
      message: error.message,
    };
  }
  return {
    code: "request_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function extractRequestId(line: string): string {
  try {
    const value = JSON.parse(line) as { requestId?: unknown };
    return typeof value.requestId === "string" ? value.requestId : "unknown";
  } catch {
    return "unknown";
  }
}

function truncateMessage(message: string): string {
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
}

async function ensurePrivateSocketDirectory(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error(`Socket parent is not a directory: ${directory}`);
  const getuid = process.getuid;
  if (typeof getuid !== "function") throw new Error("Unix socket host requires a platform with user IDs");
  if (info.uid !== getuid()) throw new Error(`Socket parent is not owned by the current user: ${directory}`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Socket parent must not grant group/other access: ${directory}`);
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const info = await lstatIfPresent(socketPath);
  if (!info) return;
  if (!info.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  const identity = identityOf(info);
  const probe = await probeSocket(socketPath);
  if (probe === "active") throw new Error(`Alu Dock host is already listening: ${socketPath}`);
  if (probe === "indeterminate") throw new Error(`Cannot safely determine whether socket is stale: ${socketPath}`);

  const current = await lstatIfPresent(socketPath);
  if (!current) return;
  if (!sameIdentity(identity, identityOf(current))) {
    throw new Error(`Socket path changed while checking staleness: ${socketPath}`);
  }
  await unlink(socketPath);
}

async function probeSocket(socketPath: string): Promise<SocketProbe> {
  return new Promise<SocketProbe>((resolveProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: SocketProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(result);
    };
    const timeout = setTimeout(() => finish("indeterminate"), 250);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "indeterminate");
    });
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveStart, rejectStart) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectStart(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveStart();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

async function assertPrivateSocket(socketPath: string, expected: SocketIdentity): Promise<void> {
  const info = await lstat(socketPath);
  if (!info.isSocket() || !sameIdentity(expected, identityOf(info))) {
    throw new Error(`Socket path changed during startup: ${socketPath}`);
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`Socket permissions are not private: ${socketPath}`);
  }
}

async function readSocketIdentity(socketPath: string): Promise<SocketIdentity> {
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error(`Listening path is not a socket: ${socketPath}`);
  return identityOf(info);
}

async function removeSocketIfOwned(socketPath: string, expected: SocketIdentity): Promise<void> {
  const info = await lstatIfPresent(socketPath);
  if (!info || !sameIdentity(expected, identityOf(info))) return;
  await unlink(socketPath);
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function identityOf(info: Stats): SocketIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
