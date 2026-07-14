import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { resolve } from "node:path";

import type { DockEvent, EventPage, InstanceSnapshot } from "../core/managed-instance.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlRequest,
  parseControlEventEnvelope,
  parseControlResponse,
  parseCreateResult,
  parseEventsResult,
  parseListResult,
  parsePingResult,
  parseStatusResult,
  ProtocolValidationError,
  type EventsResult,
  type PingResult,
} from "./protocol.js";

type ControlRequestBody<T> = T extends ControlRequest
  ? Omit<T, "version" | "requestId">
  : never;
type AnyControlRequestBody = ControlRequestBody<ControlRequest>;
type ResultParser<T> = (input: unknown) => T;

const MAX_PENDING_STREAM_EVENTS = 1_000;

export interface EventSubscription {
  initial: EventsResult;
  close: () => void;
  done: Promise<void>;
}

export interface DockClientOptions {
  socketPath: string;
  timeoutMs?: number;
  requestId?: () => string;
}

export class ControlClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlClientError";
  }
}

export class DockClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;

  constructor(options: DockClientOptions) {
    this.socketPath = resolve(options.socketPath);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.createRequestId = options.requestId ?? randomUUID;
  }

  async ping(): Promise<PingResult> {
    const result = await this.request({ type: "ping" }, parsePingResult);
    if (result.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      throw new ControlClientError("invalid_response", `Host reported unsupported protocol ${result.protocolVersion}`);
    }
    return result;
  }

  async create(cwd: string, name?: string): Promise<InstanceSnapshot> {
    const result = await this.request({ type: "create", cwd, name }, parseCreateResult);
    return result.instance;
  }

  async list(): Promise<InstanceSnapshot[]> {
    const result = await this.request({ type: "list" }, parseListResult);
    return result.instances;
  }

  async status(instanceId: string): Promise<InstanceSnapshot> {
    const result = await this.request({ type: "status", instanceId }, parseStatusResult);
    return result.instance;
  }

  async events(instanceId: string, since = 0): Promise<{ instance: InstanceSnapshot; page: EventPage }> {
    const result = await this.request(
      { type: "events", instanceId, since, follow: false },
      parseEventsResult,
    );
    return { instance: result.instance, page: result.page };
  }

  streamEvents(
    instanceId: string,
    options: { since?: number; onEvent: (event: DockEvent) => void },
  ): Promise<EventSubscription> {
    const requestId = this.createRequestId();
    const request: ControlRequest = {
      version: 1,
      requestId,
      type: "events",
      instanceId,
      since: options.since,
      follow: true,
    };
    const socket = createConnection(this.socketPath);
    const decoder = new JsonLineDecoder();
    let responseReceived = false;
    let initialSettled = false;
    let doneSettled = false;
    let closeRequested = false;
    let eventCallbacksReady = false;
    let pendingEvents: DockEvent[] = [];
    let resolveInitial!: (subscription: EventSubscription) => void;
    let rejectInitial!: (error: unknown) => void;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;

    const done = new Promise<void>((resolveDonePromise, rejectDonePromise) => {
      resolveDone = resolveDonePromise;
      rejectDone = rejectDonePromise;
    });
    // Consumers often only await the initial response. Mark done as observed so
    // a later transport error does not become an unhandled rejection.
    void done.catch(() => {});
    const initial = new Promise<EventSubscription>((resolvePromise, rejectPromise) => {
      resolveInitial = resolvePromise;
      rejectInitial = rejectPromise;
    });

    const settleDone = (error?: unknown): void => {
      if (doneSettled) return;
      doneSettled = true;
      if (error === undefined) resolveDone();
      else rejectDone(error);
    };
    const fail = (error: unknown): void => {
      clearTimeout(timeout);
      const normalized = normalizeClientError(error);
      if (!initialSettled) {
        initialSettled = true;
        rejectInitial(normalized);
      }
      pendingEvents = [];
      settleDone(normalized);
      socket.destroy();
    };
    const timeout = setTimeout(() => {
      fail(new ControlClientError("timeout", `Control request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const consume = (line: string): void => {
      if (line.length === 0) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        fail(new ControlClientError("invalid_response", "Host returned invalid JSON"));
        return;
      }
      const kind = envelopeKind(raw);

      try {
        if (kind === "response") {
          if (responseReceived) throw new ProtocolValidationError("invalid_response", "Host returned duplicate responses");
          const response = parseControlResponse(raw, requestId);
          if (!response.ok) {
            fail(new ControlClientError(response.error.code, response.error.message));
            return;
          }
          const result = parseEventsResult(response.result);
          responseReceived = true;
          clearTimeout(timeout);
          if (!initialSettled) {
            initialSettled = true;
            resolveInitial({
              initial: result,
              close: () => {
                closeRequested = true;
                pendingEvents = [];
                socket.destroy();
              },
              done,
            });
            // Promise reactions queued by resolveInitial run before this flush,
            // so consumers can publish the initial snapshot before live events.
            queueMicrotask(() => {
              if (closeRequested || doneSettled) return;
              eventCallbacksReady = true;
              const events = pendingEvents;
              pendingEvents = [];
              for (const event of events) {
                try {
                  options.onEvent(event);
                } catch (error) {
                  fail(error);
                  return;
                }
              }
            });
          }
          return;
        }

        if (kind === "event") {
          if (!responseReceived) {
            throw new ProtocolValidationError("invalid_response", "Host sent an event before the initial response");
          }
          const eventEnvelope = parseControlEventEnvelope(raw, requestId);
          if (!eventCallbacksReady) {
            if (pendingEvents.length >= MAX_PENDING_STREAM_EVENTS) {
              throw new ProtocolValidationError("invalid_response", "Too many events arrived before initial delivery");
            }
            pendingEvents.push(eventEnvelope.event);
          } else {
            options.onEvent(eventEnvelope.event);
          }
          return;
        }

        throw new ProtocolValidationError("invalid_response", "Host returned an unknown envelope kind");
      } catch (error) {
        fail(error);
      }
    };

    socket.once("connect", () => socket.write(encodeJsonLine(request)));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) consume(line);
      } catch (error) {
        fail(error);
      }
    });
    socket.once("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", (error) => fail(transportError(error)));
    socket.once("close", (hadError) => {
      clearTimeout(timeout);
      if (!initialSettled) {
        initialSettled = true;
        const error = new ControlClientError("connection_closed", "Host closed before responding");
        rejectInitial(error);
        settleDone(error);
        return;
      }
      if (!doneSettled) {
        if (closeRequested) {
          settleDone();
        } else {
          const message = hadError
            ? "Event stream closed after a transport error"
            : "Host closed the event stream unexpectedly";
          settleDone(new ControlClientError("connection_closed", message));
        }
      }
    });

    return initial;
  }

  private request<T>(body: AnyControlRequestBody, parseResult: ResultParser<T>): Promise<T> {
    const requestId = this.createRequestId();
    const request = {
      ...body,
      version: 1,
      requestId,
    } as ControlRequest;

    return new Promise<T>((resolveRequest, rejectRequest) => {
      const socket = createConnection(this.socketPath);
      const decoder = new JsonLineDecoder();
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new ControlClientError("timeout", `Control request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const finish = (error?: unknown, result?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error !== undefined) rejectRequest(normalizeClientError(error));
        else resolveRequest(result as T);
      };

      const consume = (line: string): void => {
        if (line.length === 0) return;
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          finish(new ControlClientError("invalid_response", "Host returned invalid JSON"));
          return;
        }
        if (envelopeKind(raw) !== "response") {
          finish(new ControlClientError("invalid_response", "Host returned an unexpected envelope"));
          return;
        }
        try {
          const response = parseControlResponse(raw, requestId);
          if (!response.ok) {
            finish(new ControlClientError(response.error.code, response.error.message));
          } else {
            finish(undefined, parseResult(response.result));
          }
        } catch (error) {
          finish(error);
        }
      };

      socket.once("connect", () => socket.write(encodeJsonLine(request)));
      socket.on("data", (chunk: Buffer) => {
        try {
          for (const line of decoder.push(chunk)) consume(line);
        } catch (error) {
          finish(error);
        }
      });
      socket.once("end", () => {
        try {
          decoder.finish();
        } catch (error) {
          finish(error);
        }
      });
      socket.once("error", (error) => finish(transportError(error)));
      socket.once("close", () => {
        if (!settled) finish(new ControlClientError("connection_closed", "Host closed before responding"));
      });
    });
  }
}

function envelopeKind(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).kind
    : undefined;
}

function normalizeClientError(error: unknown): ControlClientError {
  if (error instanceof ControlClientError) return error;
  if (error instanceof ProtocolValidationError) {
    return new ControlClientError("invalid_response", error.message);
  }
  if (error instanceof Error) return new ControlClientError("invalid_response", error.message);
  return new ControlClientError("invalid_response", String(error));
}

function transportError(error: Error): ControlClientError {
  const code = (error as NodeJS.ErrnoException).code;
  const prefix = code ? `${code}: ` : "";
  return new ControlClientError("connection_error", `${prefix}${error.message}`);
}
