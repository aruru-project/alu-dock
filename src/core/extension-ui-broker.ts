import { randomUUID } from "node:crypto";

import type { EventDataMap } from "./instance-dto.js";

export type DialogMethod = "select" | "confirm" | "input" | "editor";
export type InteractionCancelReason = "user" | "timeout" | "signal" | "detach" | "replacement" | "host_draining" | "overflow";
export type InteractionResponse =
  | { method: "select" | "input" | "editor"; value: string }
  | { method: "confirm"; confirmed: boolean }
  | { method: DialogMethod; cancelled: true };

export interface ExtensionDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export type ControllerClaim =
  | { status: "acquired"; leaseToken: string }
  | { status: "unavailable" };

export interface InteractionResult {
  interactionId: string;
  state: "resolved" | "already_resolved";
}

export interface ExtensionUiProjection {
  extensionStatus: Record<string, string>;
  activeInteraction?: { id: string; method: DialogMethod; expiresAt: string };
}

export type ExtensionUiEventType =
  | "interaction.requested"
  | "interaction.resolved"
  | "interaction.cancelled"
  | "extension.notification"
  | "extension.status_changed"
  | "extension.widget_changed"
  | "extension.error";

export interface ExtensionUiEventSink {
  generation(): number;
  emit<T extends ExtensionUiEventType>(type: T, data: EventDataMap[T]): Promise<void> | void;
  projectionChanged(): void;
}

interface ControllerLease {
  token: string;
  generation: number;
}

type DialogValue = string | boolean | undefined;
type DialogInput =
  | { method: "select"; title: string; options: string[] }
  | { method: "confirm"; title: string; message: string }
  | { method: "input"; title: string; placeholder?: string }
  | { method: "editor"; title: string; prefill?: string };

interface PendingDialog {
  id: string;
  method: DialogMethod;
  request: EventDataMap["interaction.requested"];
  defaultValue: DialogValue;
  resolve: (value: DialogValue) => void;
  expiresAtMs: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: NodeJS.Timeout;
  selectValues?: Map<string, string>;
}

interface InteractionTombstone {
  generation: number;
  leaseToken: string;
  state: "resolved" | "cancelled";
  responseKey?: string;
  expiresAtMs: number;
}

const MAX_DIALOGS = 16;
const MAX_DIALOG_LIFETIME_MS = 5 * 60_000;
const TOMBSTONE_TTL_MS = 5 * 60_000;
const MAX_TOMBSTONES = 256;
const MAX_STATUS_KEYS = 64;
const MAX_WIDGET_KEYS = 64;
const MAX_TITLE_CHARS = 2_048;
const MAX_TEXT_CHARS = 8_000;
const MAX_EDITOR_CHARS = 256_000;
const MAX_OPTIONS = 200;
const MAX_LINES = 200;
const BINARY_OMISSION = "[binary/image payload omitted]";
const DATA_URI = /data:[^,]*;base64,/i;
const RAW_BASE64 = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Host-owned, renderer-independent extension UI state machine.
 *
 * Pi adapters call the dialog/fire-and-forget methods. Control connections own
 * leases and call respond(). The broker never imports Pi or pi-tui types.
 */
export class ExtensionUiBroker {
  private sink: ExtensionUiEventSink | undefined;
  private readonly bufferedEvents: Array<{ type: ExtensionUiEventType; data: EventDataMap[ExtensionUiEventType] }> = [];
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>();
  private readonly queue: PendingDialog[] = [];
  private active: PendingDialog | undefined;
  private controller: ControllerLease | undefined;
  private readonly tombstones = new Map<string, InteractionTombstone>();
  private unsupportedWarningEmitted = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private suspended = false;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  bind(sink: ExtensionUiEventSink): void {
    if (this.sink) throw new Error("Extension UI broker is already bound");
    this.sink = sink;
    sink.projectionChanged();
    const buffered = this.bufferedEvents.splice(0);
    for (const event of buffered) void this.emit(event.type, event.data);
  }

  isSuspended(): boolean { return this.suspended; }

  projection(): ExtensionUiProjection {
    return {
      extensionStatus: Object.fromEntries([...this.statuses.entries()].sort(([left], [right]) => left.localeCompare(right))),
      ...(this.active === undefined ? {} : {
        activeInteraction: {
          id: this.active.id,
          method: this.active.method,
          expiresAt: this.active.request.expiresAt,
        },
      }),
    };
  }

  claimController(): Promise<ControllerClaim> {
    return this.serialize(async () => {
      if (this.suspended || this.controller) return { status: "unavailable" };
      const lease: ControllerLease = {
        token: this.createId(),
        generation: this.generation(),
      };
      this.controller = lease;
      this.projectionChanged();
      return { status: "acquired", leaseToken: lease.token };
    });
  }

  releaseController(leaseToken: string, reason: "detach" | "host_draining" = "detach"): Promise<void> {
    return this.serialize(async () => {
      if (this.controller?.token !== leaseToken) return;
      this.controller = undefined;
      this.projectionChanged();
      await this.cancelAllDialogs(reason, leaseToken);
    });
  }

  beginGenerationChange(): void {
    if (this.suspended) return;
    this.suspended = true;
    const leaseToken = this.controller?.token;
    this.controller = undefined;
    this.statuses.clear();
    this.widgets.clear();
    this.projectionChanged();
    void this.serialize(async () => {
      await this.cancelAllDialogs("replacement", leaseToken);
      this.tombstones.clear();
    });
  }

  completeGenerationChange(): Promise<void> {
    return this.serialize(async () => {
      this.suspended = false;
      this.pruneTombstones();
      this.projectionChanged();
      const buffered = this.bufferedEvents.splice(0);
      for (const event of buffered) await this.emit(event.type, event.data, true);
    });
  }

  failGenerationChange(): Promise<void> {
    this.suspended = true;
    return this.serialize(async () => {
      this.controller = undefined;
      this.statuses.clear();
      this.widgets.clear();
      this.tombstones.clear();
      this.bufferedEvents.length = 0;
      this.projectionChanged();
    });
  }

  cancelForHostDrain(): Promise<void> {
    this.suspended = true;
    return this.serialize(async () => {
      const leaseToken = this.controller?.token;
      this.controller = undefined;
      this.statuses.clear();
      this.widgets.clear();
      this.projectionChanged();
      await this.cancelAllDialogs("host_draining", leaseToken);
      this.tombstones.clear();
      this.bufferedEvents.length = 0;
    });
  }

  select(title: string, options: string[], opts?: ExtensionDialogOptions): Promise<string | undefined> {
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS) {
      this.recordError("Extension select options must contain between 1 and 200 items");
      return Promise.resolve(undefined);
    }
    const wireToOriginal = new Map<string, string>();
    const projected: string[] = [];
    const safeTitle = safeLine(title, MAX_TITLE_CHARS);
    let projectedChars = safeTitle.length;
    for (const original of options) {
      if (typeof original !== "string" || original.length > MAX_TEXT_CHARS) {
        this.recordError("Extension select options must be bounded strings");
        return Promise.resolve(undefined);
      }
      const wire = safeLine(original, MAX_TEXT_CHARS);
      if (wireToOriginal.has(wire)) {
        this.recordError("Extension select options collide after terminal sanitization");
        return Promise.resolve(undefined);
      }
      projectedChars += wire.length;
      if (projectedChars > MAX_EDITOR_CHARS) {
        this.recordError("Extension select payload exceeds the bounded interaction surface");
        return Promise.resolve(undefined);
      }
      wireToOriginal.set(wire, original);
      projected.push(wire);
    }
    return this.requestDialog({
      method: "select",
      title: safeTitle,
      options: projected,
    }, undefined, opts, wireToOriginal);
  }

  confirm(title: string, message: string, opts?: ExtensionDialogOptions): Promise<boolean> {
    return this.requestDialog({
      method: "confirm",
      title: safeLine(title, MAX_TITLE_CHARS),
      message: safeText(message, MAX_TEXT_CHARS),
    }, false, opts);
  }

  input(title: string, placeholder?: string, opts?: ExtensionDialogOptions): Promise<string | undefined> {
    return this.requestDialog({
      method: "input",
      title: safeLine(title, MAX_TITLE_CHARS),
      ...(placeholder === undefined ? {} : { placeholder: safeLine(placeholder, MAX_TITLE_CHARS) }),
    }, undefined, opts);
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.requestDialog({
      method: "editor",
      title: safeLine(title, MAX_TITLE_CHARS),
      ...(prefill === undefined ? {} : { prefill: safeText(prefill, MAX_EDITOR_CHARS) }),
    }, undefined);
  }

  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    void this.emit("extension.notification", {
      message: safeText(message, MAX_TEXT_CHARS),
      level: level === "warning" || level === "error" ? level : "info",
    });
  }

  setStatus(key: string, text: string | undefined): void {
    const safeKey = safeLine(key, 128);
    if (!safeKey || isUnsafeRecordKey(safeKey)) {
      this.recordError("Extension status key must be non-empty and safe");
      return;
    }
    if (text === undefined) {
      this.statuses.delete(safeKey);
    } else {
      if (!this.statuses.has(safeKey) && this.statuses.size >= MAX_STATUS_KEYS) {
        this.recordError("Extension status key limit exceeded");
        return;
      }
      this.statuses.set(safeKey, safeLine(text, MAX_TITLE_CHARS));
    }
    this.projectionChanged();
    void this.emit("extension.status_changed", { key: safeKey, ...(text === undefined ? {} : { text: this.statuses.get(safeKey) }) });
  }

  setWidget(key: string, lines: string[] | undefined, placement: "aboveEditor" | "belowEditor" = "aboveEditor"): void {
    const safeKey = safeLine(key, 128);
    if (!safeKey || isUnsafeRecordKey(safeKey)) {
      this.recordError("Extension widget key must be non-empty and safe");
      return;
    }
    if (lines === undefined) {
      this.widgets.delete(safeKey);
      void this.emit("extension.widget_changed", { key: safeKey });
      return;
    }
    if (!Array.isArray(lines) || lines.length > MAX_LINES) {
      this.recordError("Extension widget lines exceed the bounded declarative surface");
      return;
    }
    if (!this.widgets.has(safeKey) && this.widgets.size >= MAX_WIDGET_KEYS) {
      this.recordError("Extension widget key limit exceeded");
      return;
    }
    const projected = lines.map((line) => safeLine(line, MAX_TEXT_CHARS));
    const actualPlacement = placement === "belowEditor" ? "belowEditor" : "aboveEditor";
    this.widgets.set(safeKey, { lines: projected, placement: actualPlacement });
    void this.emit("extension.widget_changed", { key: safeKey, lines: projected, placement: actualPlacement });
  }

  unsupported(feature: string): void {
    if (this.unsupportedWarningEmitted) return;
    this.unsupportedWarningEmitted = true;
    const safeFeature = safeLine(feature, 256) || "visual customization";
    void this.emit("extension.notification", {
      level: "warning",
      message: `Extension visual UI (${safeFeature}) is unavailable in Alu Dock; the visual request was ignored and any tool failure is reported separately`,
    });
  }

  respond(leaseToken: string, interactionId: string, response: InteractionResponse): Promise<InteractionResult> {
    return this.serialize(async () => {
      this.pruneTombstones();
      const lease = this.controller;
      if (!lease) throw new InteractionExpiredError(interactionId);
      if (lease.token !== leaseToken) throw new InteractionWrongLeaseError(interactionId);
      if (lease.generation !== this.generation()) throw new InteractionExpiredError(interactionId);

      const responseKey = canonicalResponse(response);
      const tombstone = this.tombstones.get(interactionId);
      if (tombstone) {
        if (
          tombstone.state === "resolved"
          && tombstone.generation === lease.generation
          && tombstone.leaseToken === leaseToken
          && tombstone.responseKey === responseKey
        ) return { interactionId, state: "already_resolved" };
        throw new InteractionExpiredError(interactionId);
      }

      const dialog = this.active;
      if (!dialog || dialog.id !== interactionId) throw new InteractionNotFoundError(interactionId);
      const value = this.validateResponse(dialog, response);
      if ("cancelled" in response) await this.finishUserCancellation(dialog, leaseToken, responseKey);
      else await this.finishDialog(dialog, value, "resolved", leaseToken, responseKey);
      return { interactionId, state: "resolved" };
    });
  }

  private requestDialog<T extends DialogValue>(
    input: DialogInput,
    defaultValue: T,
    opts?: ExtensionDialogOptions,
    selectValues?: Map<string, string>,
  ): Promise<T> {
    if (opts?.signal?.aborted || this.suspended || !this.controller) return Promise.resolve(defaultValue);
    const issuedAtMs = this.now().getTime();
    const requestedTimeout = opts?.timeout;
    const lifetime = requestedTimeout === undefined
      ? MAX_DIALOG_LIFETIME_MS
      : Number.isFinite(requestedTimeout) ? Math.max(0, Math.min(MAX_DIALOG_LIFETIME_MS, Math.floor(requestedTimeout))) : 0;
    if (lifetime === 0) return Promise.resolve(defaultValue);
    const expiresAtMs = issuedAtMs + lifetime;
    const interactionId = this.createId();
    const request = {
      ...input,
      interactionId,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    } as EventDataMap["interaction.requested"];

    let resolveDialog!: (value: DialogValue) => void;
    const result = new Promise<T>((resolve) => { resolveDialog = (value) => resolve(value as T); });
    const dialog: PendingDialog = {
      id: interactionId,
      method: input.method,
      request,
      defaultValue,
      resolve: resolveDialog,
      expiresAtMs,
      signal: opts?.signal,
      selectValues,
    };

    void this.serialize(async () => {
      if (dialog.signal?.aborted || this.suspended || !this.controller) {
        dialog.resolve(defaultValue);
        return;
      }
      if (this.dialogCount() >= MAX_DIALOGS) {
        await this.emit("interaction.cancelled", { interactionId, method: dialog.method, reason: "overflow" });
        this.recordError("Extension interaction queue limit exceeded");
        dialog.resolve(defaultValue);
        return;
      }
      this.installCancellation(dialog);
      this.queue.push(dialog);
      await this.activateNextDialog();
    });
    return result;
  }

  private installCancellation(dialog: PendingDialog): void {
    const delay = Math.max(0, dialog.expiresAtMs - this.now().getTime());
    dialog.timer = setTimeout(() => {
      void this.serialize(() => this.cancelDialog(dialog, "timeout"));
    }, delay);
    dialog.timer.unref();
    if (dialog.signal) {
      dialog.abortListener = () => { void this.serialize(() => this.cancelDialog(dialog, "signal")); };
      dialog.signal.addEventListener("abort", dialog.abortListener, { once: true });
    }
  }

  private async activateNextDialog(): Promise<void> {
    if (this.active || this.suspended || !this.controller) return;
    while (this.queue.length > 0) {
      const dialog = this.queue.shift()!;
      if (dialog.expiresAtMs <= this.now().getTime()) {
        await this.cancelDialog(dialog, "timeout");
        continue;
      }
      this.active = dialog;
      this.projectionChanged();
      await this.emit("interaction.requested", dialog.request);
      return;
    }
  }

  private async cancelDialog(dialog: PendingDialog, reason: InteractionCancelReason, leaseToken = this.controller?.token): Promise<void> {
    if (dialog !== this.active) {
      const index = this.queue.indexOf(dialog);
      if (index < 0) return;
      this.queue.splice(index, 1);
    } else {
      this.active = undefined;
      this.projectionChanged();
    }
    this.cleanupDialog(dialog);
    this.rememberTombstone(dialog.id, {
      generation: this.generation(),
      leaseToken: leaseToken ?? "released",
      state: "cancelled",
      expiresAtMs: this.now().getTime() + TOMBSTONE_TTL_MS,
    });
    await this.emit("interaction.cancelled", { interactionId: dialog.id, method: dialog.method, reason });
    dialog.resolve(dialog.defaultValue);
    await this.activateNextDialog();
  }

  private async cancelAllDialogs(reason: InteractionCancelReason, leaseToken?: string): Promise<void> {
    const dialogs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    this.projectionChanged();
    for (const dialog of dialogs) {
      this.cleanupDialog(dialog);
      this.rememberTombstone(dialog.id, {
        generation: this.generation(),
        leaseToken: leaseToken ?? "released",
        state: "cancelled",
        expiresAtMs: this.now().getTime() + TOMBSTONE_TTL_MS,
      });
      await this.emit("interaction.cancelled", { interactionId: dialog.id, method: dialog.method, reason }, true);
      dialog.resolve(dialog.defaultValue);
    }
  }

  private validateResponse(dialog: PendingDialog, response: InteractionResponse): string | boolean | undefined {
    if (response.method !== dialog.method) throw new InteractionInvalidResponseError(dialog.id);
    if ("cancelled" in response) return dialog.defaultValue;
    if (dialog.method === "confirm") {
      if (!("confirmed" in response) || typeof response.confirmed !== "boolean") throw new InteractionInvalidResponseError(dialog.id);
      return response.confirmed;
    }
    if (!("value" in response) || typeof response.value !== "string") throw new InteractionInvalidResponseError(dialog.id);
    const limit = dialog.method === "select" ? MAX_TEXT_CHARS : MAX_EDITOR_CHARS;
    if (response.value.length > limit) throw new InteractionInvalidResponseError(dialog.id);
    if (dialog.method === "select") {
      const original = dialog.selectValues?.get(response.value);
      if (original === undefined) throw new InteractionInvalidResponseError(dialog.id);
      return original;
    }
    return safeText(response.value, MAX_EDITOR_CHARS);
  }

  private async finishUserCancellation(dialog: PendingDialog, leaseToken: string, responseKey: string): Promise<void> {
    if (this.active !== dialog) throw new InteractionNotFoundError(dialog.id);
    this.active = undefined;
    this.projectionChanged();
    this.cleanupDialog(dialog);
    this.rememberTombstone(dialog.id, {
      generation: this.generation(),
      leaseToken,
      state: "resolved",
      responseKey,
      expiresAtMs: this.now().getTime() + TOMBSTONE_TTL_MS,
    });
    await this.emit("interaction.cancelled", { interactionId: dialog.id, method: dialog.method, reason: "user" });
    dialog.resolve(dialog.defaultValue);
    await this.activateNextDialog();
  }

  private async finishDialog(
    dialog: PendingDialog,
    value: string | boolean | undefined,
    state: "resolved",
    leaseToken: string,
    responseKey: string,
  ): Promise<void> {
    if (this.active !== dialog) throw new InteractionNotFoundError(dialog.id);
    this.active = undefined;
    this.projectionChanged();
    this.cleanupDialog(dialog);
    this.rememberTombstone(dialog.id, {
      generation: this.generation(),
      leaseToken,
      state,
      responseKey,
      expiresAtMs: this.now().getTime() + TOMBSTONE_TTL_MS,
    });
    await this.emit("interaction.resolved", { interactionId: dialog.id, method: dialog.method });
    dialog.resolve(value);
    await this.activateNextDialog();
  }

  private cleanupDialog(dialog: PendingDialog): void {
    if (dialog.timer) clearTimeout(dialog.timer);
    if (dialog.signal && dialog.abortListener) dialog.signal.removeEventListener("abort", dialog.abortListener);
  }

  private rememberTombstone(id: string, tombstone: InteractionTombstone): void {
    this.tombstones.delete(id);
    this.tombstones.set(id, tombstone);
    this.pruneTombstones();
    while (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value as string);
  }

  private pruneTombstones(): void {
    const now = this.now().getTime();
    for (const [id, tombstone] of this.tombstones) if (tombstone.expiresAtMs <= now) this.tombstones.delete(id);
  }

  private dialogCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private generation(): number {
    return this.sink?.generation() ?? 1;
  }

  private projectionChanged(): void {
    this.sink?.projectionChanged();
  }

  private recordError(error: string): void {
    void this.emit("extension.error", { error: safeLine(error, MAX_TITLE_CHARS) });
  }

  private emit<T extends ExtensionUiEventType>(type: T, data: EventDataMap[T], force = false): Promise<void> {
    if ((this.suspended && !force) || !this.sink) {
      if (this.bufferedEvents.length < 256) this.bufferedEvents.push({ type, data } as { type: ExtensionUiEventType; data: EventDataMap[ExtensionUiEventType] });
      return Promise.resolve();
    }
    try {
      return Promise.resolve(this.sink.emit(type, data));
    } catch {
      return Promise.resolve();
    }
  }

  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }
}

export class InteractionNotFoundError extends Error {
  readonly code = "interaction_not_found";
  constructor(readonly interactionId: string) { super(`Interaction ${interactionId} was not found`); this.name = "InteractionNotFoundError"; }
}
export class InteractionExpiredError extends Error {
  readonly code = "interaction_expired";
  constructor(readonly interactionId: string) { super(`Interaction ${interactionId} has expired`); this.name = "InteractionExpiredError"; }
}
export class InteractionWrongLeaseError extends Error {
  readonly code = "interaction_wrong_lease";
  constructor(readonly interactionId: string) { super(`Interaction ${interactionId} belongs to another controller lease`); this.name = "InteractionWrongLeaseError"; }
}
export class InteractionInvalidResponseError extends Error {
  readonly code = "interaction_invalid_response";
  constructor(readonly interactionId: string) { super(`Interaction ${interactionId} response is invalid`); this.name = "InteractionInvalidResponseError"; }
}

function canonicalResponse(response: InteractionResponse): string {
  if ("cancelled" in response) return JSON.stringify({ method: response.method, cancelled: true });
  if (response.method === "confirm") return JSON.stringify({ method: response.method, confirmed: response.confirmed });
  return JSON.stringify({ method: response.method, value: response.value });
}

export function containsBinaryPayload(value: string): boolean {
  if (DATA_URI.test(value) || RAW_BASE64.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => RAW_BASE64.test(part));
}

function isUnsafeRecordKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function safeLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  const projected = containsBinaryPayload(safe) ? BINARY_OMISSION : safe;
  return projected.length <= limit ? projected : `${projected.slice(0, Math.max(0, limit - 1))}…`;
}

function safeText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  const projected = containsBinaryPayload(normalized) ? BINARY_OMISSION : normalized;
  return projected.length <= limit ? projected : `${projected.slice(0, Math.max(0, limit - 1))}…`;
}
