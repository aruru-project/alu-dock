import type { Api, AssistantMessage, AssistantMessageEvent, AuthCheck, AuthResult, Context, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelRef } from "../control/protocol.js";
import { MAX_DOCK_TRANSFER_BYTES } from "../core/transport-bounds.js";

/**
 * Private format between a Worker's Pi, its Host and the model service. Pi's own message, event
 * and model types are carried as they are; Dock only frames them.
 */

/** One model request (context with images included) shares the aggregate Worker envelope bound. */
export const MAX_MODEL_REQUEST_BYTES = MAX_DOCK_TRANSFER_BYTES;
/** One wire event; the largest is the final message, sent once. */
export const MAX_MODEL_EVENT_BYTES = 16 * 1024 * 1024;

export type ModelStreamMode = "simple" | "raw";

export interface ProviderAuthState {
  provider: string;
  configured: boolean;
  oauth: boolean;
  check?: AuthCheck;
}

/** What a Worker's Pi reads about models without holding providers or credentials. */
export interface ModelCatalogSnapshot {
  models: Model<Api>[];
  available: Model<Api>[];
  /** Models that route to another model per request. */
  virtual: ModelRef[];
  providers: ProviderAuthState[];
  error?: string;
}

export interface ModelRouteRequest {
  model: ModelRef;
  messages: Message[];
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: ModelThinkingLevel;
  failed?: AssistantMessage;
  state?: unknown;
}

export interface ModelRouteResult {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  state?: unknown;
}

export interface ModelStreamRequest {
  mode: ModelStreamMode;
  model: ModelRef;
  context: Context;
  /** Pi request options that are data; callbacks and credentials never cross. */
  options: Record<string, unknown>;
}

/** Overrides an extension may pass to getAuth; the signal is relayed as a cancel. */
export interface ModelAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
  minOAuthValidityMs?: number;
}

/**
 * A credential for an extension that calls a model itself (user decision 2026-11-05). Main's
 * runtime resolves and refreshes it; a subscription yields a short-lived token, never its refresh token.
 */
export interface ModelAuthRequest {
  /** A provider, or the model being called, whose own headers take part. */
  target: string | Model<Api>;
  overrides?: ModelAuthOverrides;
}

export type ModelAuthResult = AuthResult | null;
export type ModelRequestAuthResult = Awaited<ReturnType<ModelRuntime["getRequestAuth"]>>;

export type ModelServiceRequest =
  | { op: "catalog" }
  | ({ op: "resolve" } & ModelRouteRequest)
  | ({ op: "stream" } & ModelStreamRequest)
  | ({ op: "auth" } & ModelAuthRequest)
  | { op: "request_auth"; model: Model<Api> };

/** Options a caller cannot hand to the model service: credentials and transport belong to Main. */
export const SERVICE_OWNED_OPTIONS = ["apiKey", "env", "fetch"] as const;
/** Provider callbacks run beside the provider; Pi leaves them unset here, and a caller setting one is told. */
const PROVIDER_CALLBACK_OPTIONS = new Set(["onPayload", "onResponse", "onProviderStreamEvent", "transformHeaders"]);
/** Local to this request: the signal is relayed as a cancel, the model is named separately, tracing stays here. */
const LOCAL_OPTIONS = new Set(["signal", "model", "telemetryContext"]);

/**
 * The data of a Pi request. Pi's agent loop passes its whole loop configuration here, callbacks
 * included; those run in the Worker and are not sent. Everything else is data and crosses as is,
 * so an option Pi adds later is not lost.
 */
export function modelRequestOptions(options: object | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value === undefined || LOCAL_OPTIONS.has(key)) continue;
    if ((SERVICE_OWNED_OPTIONS as readonly string[]).includes(key)) throw new Error(`${key} belongs to the model service on Main and cannot be set by a Work`);
    if (PROVIDER_CALLBACK_OPTIONS.has(key)) throw new Error(`${key} runs beside the provider, which is the model service on Main, so it cannot run for this request`);
    if (typeof value === "function") continue;
    data[key] = value;
  }
  return data;
}

export function encodeBounded(value: unknown, limit: number, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > limit) throw new Error(`${label} exceeds its size limit`);
  return json;
}

/** A failure the caller must not replay automatically: the provider may already have charged for it. */
export function failedModelEvent(model: ModelRef & { api?: string }, message: string, aborted = false, partial?: AssistantMessage): AssistantMessageEvent {
  const stopReason = aborted ? "aborted" : "error";
  const errorMessage = message.slice(0, 4_096);
  const error: AssistantMessage = partial
    ? { ...partial, stopReason, errorMessage, retryable: false }
    : {
        role: "assistant", content: [], api: (model.api ?? "unknown") as Api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason, errorMessage, retryable: false,
      };
  return { type: "error", reason: stopReason, error };
}

/** Pi streams are one start, then deltas, then exactly one terminal. */
export class ModelEventOrder {
  started = false;
  terminal = false;

  accept(event: AssistantMessageEvent): void {
    if (this.terminal) throw new Error("Model event after the terminal event");
    if (event.type === "start") {
      if (this.started) throw new Error("Duplicate model start event");
      this.started = true;
    } else if (event.type !== "error" && !this.started) throw new Error("Model event before start");
    if (event.type === "done" || event.type === "error") this.terminal = true;
  }
}

/*
 * Each in-progress Pi event carries the whole reply so far as `partial`; in-process that is one object
 * the provider keeps changing. Sent as is, every delta would repeat the full reply. On the wire an
 * event carries only how `partial` changed since the previous event, and the receiver keeps one
 * object it changes the same way, as the provider does locally. The codec knows nothing of providers.
 */

type Path = Array<string | number>;
export type PartialChange = { path: Path; append: string } | { path: Path; set: unknown } | { path: Path; delete: true };
export interface WireModelEvent { event: Record<string, unknown>; changes?: PartialChange[] }

type Shadow = string | number | boolean | null | undefined | Shadow[] | { [key: string]: Shadow };

/*
 * Tool arguments are whatever JSON the model wrote, so keys such as "__proto__" or "constructor"
 * are data. Reading and writing them as plain properties would reach the object's prototype and
 * from there every object in the process (cloud review of e7c5da2). Only own properties are used.
 */
const own = (value: object, key: string | number): unknown => (Object.hasOwn(value, key) ? (value as Record<string | number, unknown>)[key] : undefined);
const define = (target: object, key: string | number, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};

/** Structure-only copy: strings are shared, so remembering a reply costs its node count, not its size. */
function shadowOf(value: unknown): Shadow {
  if (Array.isArray(value)) return value.map(shadowOf);
  if (value !== null && typeof value === "object") {
    const copy = Object.create(null) as { [key: string]: Shadow };
    for (const [key, item] of Object.entries(value)) if (item !== undefined) copy[key] = shadowOf(item);
    return copy;
  }
  return value as Shadow;
}

function diff(previous: Shadow, current: unknown, path: Path, changes: PartialChange[]): void {
  if (typeof current === "string" && typeof previous === "string") {
    if (current === previous) return;
    if (current.startsWith(previous)) changes.push({ path, append: current.slice(previous.length) });
    else changes.push({ path, set: current });
    return;
  }
  if (Array.isArray(current) && Array.isArray(previous)) {
    if (current.length < previous.length) { changes.push({ path, set: current }); return; }
    current.forEach((item, index) => {
      if (index < previous.length) diff(previous[index] as Shadow, item, [...path, index], changes);
      else changes.push({ path: [...path, index], set: item });
    });
    return;
  }
  if (isRecord(current) && isRecord(previous) && !Array.isArray(previous)) {
    for (const key of Object.keys(previous)) if (own(current, key) === undefined) changes.push({ path: [...path, key], delete: true });
    for (const [key, item] of Object.entries(current)) {
      if (item === undefined) continue;
      if (Object.hasOwn(previous, key)) diff(previous[key] as Shadow, item, [...path, key], changes);
      else changes.push({ path: [...path, key], set: item });
    }
    return;
  }
  if (current !== previous) changes.push({ path, set: current });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PartialEncoder {
  private shadow: Shadow | undefined;

  encode(event: AssistantMessageEvent): WireModelEvent {
    if (!("partial" in event)) return { event: event as unknown as Record<string, unknown> };
    const { partial, ...rest } = event;
    const changes: PartialChange[] = [];
    if (this.shadow === undefined) changes.push({ path: [], set: partial });
    else diff(this.shadow, partial, [], changes);
    this.shadow = shadowOf(partial);
    return { event: rest, changes };
  }
}

export class PartialDecoder {
  private partial: AssistantMessage | undefined;

  decode(wire: WireModelEvent): AssistantMessageEvent {
    if (!wire.changes) return wire.event as unknown as AssistantMessageEvent;
    for (const change of wire.changes) this.apply(change);
    if (!this.partial) throw new Error("Model event changes a reply that never started");
    return { ...wire.event, partial: this.partial } as unknown as AssistantMessageEvent;
  }

  private apply(change: PartialChange): void {
    if (change.path.length === 0) {
      if (!("set" in change) || !isRecord(change.set)) throw new Error("Model reply must start as an object");
      this.partial = change.set as unknown as AssistantMessage;
      return;
    }
    let target: unknown = this.partial;
    for (const key of change.path.slice(0, -1)) {
      target = target !== null && typeof target === "object" ? own(target, key) : undefined;
      if (target === null || typeof target !== "object") throw new Error("Model event changes a missing part of the reply");
    }
    const container = target as object;
    const key = change.path[change.path.length - 1]!;
    if ("append" in change) {
      const existing = own(container, key);
      if (typeof existing !== "string") throw new Error("Model event appends to text that does not exist");
      define(container, key, existing + change.append);
    } else if ("delete" in change) delete (container as Record<string | number, unknown>)[key];
    else define(container, key, change.set);
  }
}
