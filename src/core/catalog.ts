import type { InstanceExecution, InstanceLifecycle, LastRunResult } from "./managed-instance.js";
import type { RuntimeThinkingLevel } from "./runtime-session.js";

export type CatalogMutationEffect = "pre_effect" | "post_effect" | "rollback_contained";

export interface CatalogMutationContext {
  kind: string;
  effect: CatalogMutationEffect;
  operationId?: string;
  instanceId?: string;
}

export interface CatalogReplacementIntent {
  operationId: string;
  kind: "new" | "switch" | "fork" | "clone" | "reload";
  previousSessionFile?: string;
  requestedSessionFile?: string;
  requestedEntryId?: string;
  startedAt: string;
}

export interface CatalogLastKnownState {
  lifecycle: "active" | "stopping";
  execution: "idle" | "running" | "failed";
  activeCommandId?: string;
  pendingCount: number;
}

export interface CatalogInterruption {
  reason: "host_crash" | "host_shutdown" | "replacement_failed";
  at: string;
}

export interface CatalogInstanceRecord {
  id: string;
  creationOperationId: string;
  name?: string;
  cwd: string;
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  lastRun: LastRunResult;
  runtimeGeneration: number;
  ownerHostEpoch?: string;
  piSessionId: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: RuntimeThinkingLevel;
  activeCommandId?: string;
  admissionPending: boolean;
  admissionOperationId?: string;
  pendingCount: number;
  replacement?: CatalogReplacementIntent;
  recoverySessionFile?: string;
  lastKnown?: CatalogLastKnownState;
  interruption?: CatalogInterruption;
  stopRequestedAt?: string;
  shutdownRequestedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogProjection {
  schemaVersion: 1;
  revision: number;
  lastHostEpoch: string;
  instances: CatalogInstanceRecord[];
}

export interface CatalogCommitPort {
  commit(candidate: Readonly<CatalogProjection>, context: Readonly<CatalogMutationContext>): Promise<void>;
}

export interface CatalogStore extends CatalogCommitPort {
  readonly path: string;
  load(): Promise<CatalogProjection | undefined>;
}

export interface InstanceCatalogMutationPort {
  assertWritable(): void;
  commit(record: CatalogInstanceRecord, context: CatalogMutationContext): Promise<void>;
}

export class CatalogWriteError extends Error {
  constructor(readonly context: CatalogMutationContext, cause?: unknown) {
    super(context.effect === "rollback_contained"
      ? `Catalog commit failed while publishing ${context.kind}; the candidate was not published`
      : `Catalog commit failed before ${context.kind} runtime effects`);
    this.name = "CatalogWriteError";
    this.cause = cause;
  }
}

export class CatalogEffectUnknownError extends Error {
  readonly queryHint = "Query host.info and the instance snapshot before any retry";

  constructor(readonly context: CatalogMutationContext, cause?: unknown) {
    const operation = context.operationId ?? "runtime-internal";
    super(`Catalog commit failed after ${context.kind} may have taken effect for operation ${operation}`);
    this.name = "CatalogEffectUnknownError";
    this.cause = cause;
  }
}

export class MutationFaultedError extends Error {
  constructor() {
    super("Alu Dock catalog is mutation-faulted and accepts read-only requests only");
    this.name = "MutationFaultedError";
  }
}

export class CatalogCorruptError extends Error {
  readonly code = "catalog_corrupt";

  constructor(readonly path: string, message: string, cause?: unknown) {
    super(`Catalog validation failed at ${path}: ${message}`);
    this.name = "CatalogCorruptError";
    this.cause = cause;
  }
}

export function validateInstanceStateInvariant(value: {
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  compacting?: boolean;
  ownerHostEpoch?: string;
  pendingCount: number;
  activeCommandId?: string;
  admissionPending?: boolean;
  admissionOperationId?: string;
}): void {
  if (!["active", "stopping", "stopped", "host_lost", "runtime_error"].includes(value.lifecycle)) throw new Error("Instance lifecycle is invalid");
  if (!["idle", "running", "failed", "unavailable"].includes(value.execution)) throw new Error("Instance execution is invalid");
  if (!Number.isSafeInteger(value.pendingCount) || value.pendingCount < 0) throw new Error("Instance pending count must be a non-negative integer");
  const terminal = value.lifecycle === "stopped" || value.lifecycle === "host_lost" || value.lifecycle === "runtime_error";
  if (terminal !== (value.execution === "unavailable")) throw new Error("Instance lifecycle/execution invariant failed");
  if ((value.lifecycle === "active" || value.lifecycle === "stopping") !== (value.ownerHostEpoch !== undefined)) throw new Error("Instance owner Host epoch invariant failed");
  if (terminal && (value.pendingCount !== 0 || value.activeCommandId !== undefined || value.admissionPending || value.admissionOperationId !== undefined)) throw new Error("Unavailable instance retains active catalog facts");
  if (value.activeCommandId !== undefined && value.execution !== "running") throw new Error("Active command requires running execution");
  if (value.compacting && value.execution !== "running") throw new Error("Active compaction requires running execution");
  if (value.admissionPending && ((value.lifecycle !== "active" && value.lifecycle !== "stopping") || value.admissionOperationId === undefined)) throw new Error("Admission intent is incomplete");
  if (!value.admissionPending && value.admissionOperationId !== undefined) throw new Error("Admission operation exists without an intent");
}

export function validateCatalogRecord(record: CatalogInstanceRecord): void {
  requiredBoundedText(record.id, 128, "Catalog instance ID");
  requiredBoundedText(record.creationOperationId, 128, "Catalog creation operation ID");
  absolutePath(record.cwd, "Catalog cwd");
  requiredBoundedText(record.piSessionId, 128, "Catalog Pi session ID");
  if (record.name !== undefined) requiredBoundedText(record.name, 256, "Catalog instance name");
  if (record.ownerHostEpoch !== undefined) requiredBoundedText(record.ownerHostEpoch, 128, "Catalog owner Host epoch");
  if (record.sessionFile !== undefined) absolutePath(record.sessionFile, "Catalog session file");
  if (record.model !== undefined) {
    requiredBoundedText(record.model.provider, 256, "Catalog model provider");
    requiredBoundedText(record.model.id, 512, "Catalog model ID");
  }
  if (record.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinkingLevel)) {
    throw new Error("Catalog thinking level is invalid");
  }
  if (record.activeCommandId !== undefined) requiredBoundedText(record.activeCommandId, 128, "Catalog active command ID");
  if (record.admissionOperationId !== undefined) requiredBoundedText(record.admissionOperationId, 128, "Catalog admission operation ID");
  if (!["never", "succeeded", "failed", "aborted", "interrupted"].includes(record.lastRun)) throw new Error("Catalog last-run result is invalid");
  if (!Number.isSafeInteger(record.runtimeGeneration) || record.runtimeGeneration < 1) throw new Error("Catalog runtime generation must be positive");
  timestamp(record.createdAt, "Catalog createdAt");
  timestamp(record.updatedAt, "Catalog updatedAt");
  if (record.updatedAt < record.createdAt) throw new Error("Catalog updatedAt precedes createdAt");
  validateInstanceStateInvariant(record);
  if (record.replacement) {
    if (record.lifecycle !== "active") throw new Error("Replacement intent requires an active instance");
    requiredBoundedText(record.replacement.operationId, 128, "Replacement operation ID");
    if (!["new", "switch", "fork", "clone", "reload"].includes(record.replacement.kind)) throw new Error("Replacement intent kind is invalid");
    timestamp(record.replacement.startedAt, "Replacement startedAt");
    if (record.replacement.previousSessionFile !== undefined) absolutePath(record.replacement.previousSessionFile, "Replacement previous session file");
    if (record.replacement.requestedSessionFile !== undefined) absolutePath(record.replacement.requestedSessionFile, "Replacement requested session file");
    if (record.replacement.requestedEntryId !== undefined) requiredBoundedText(record.replacement.requestedEntryId, 128, "Replacement requested entry ID");
    if (record.replacement.kind === "switch" && record.replacement.requestedSessionFile === undefined) throw new Error("Switch replacement requires a requested session file");
    if ((record.replacement.kind === "fork" || record.replacement.kind === "clone") && record.replacement.requestedEntryId === undefined) throw new Error("Fork/clone replacement requires a requested entry ID");
    if (record.replacement.kind !== "switch" && record.replacement.requestedSessionFile !== undefined) throw new Error("Only switch replacement may request a session file");
    if (record.replacement.kind !== "fork" && record.replacement.kind !== "clone" && record.replacement.requestedEntryId !== undefined) throw new Error("Only fork/clone replacement may request an entry ID");
  }
  if (record.replacement && record.recoverySessionFile) throw new Error("Replacement intent cannot also expose a recovery session");
  if (record.recoverySessionFile !== undefined) {
    absolutePath(record.recoverySessionFile, "Catalog recovery session file");
    const liveWithDeferredFile = (record.lifecycle === "active" || record.lifecycle === "stopping") && record.sessionFile === undefined;
    if (!liveWithDeferredFile && record.lifecycle !== "runtime_error" && record.lifecycle !== "host_lost") {
      throw new Error("Recovery session requires a deferred live session file or unavailable recoverable lifecycle");
    }
  }
  if (record.lastKnown) {
    if (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") throw new Error("Last-known state requires an unavailable recoverable lifecycle");
    if (!["active", "stopping"].includes(record.lastKnown.lifecycle)) throw new Error("Last-known lifecycle is invalid");
    if (!["idle", "running", "failed"].includes(record.lastKnown.execution)) throw new Error("Last-known execution is invalid");
    if (!Number.isSafeInteger(record.lastKnown.pendingCount) || record.lastKnown.pendingCount < 0) throw new Error("Last-known pending count must be non-negative");
    if (record.lastKnown.activeCommandId !== undefined) {
      requiredBoundedText(record.lastKnown.activeCommandId, 128, "Last-known command ID");
      if (record.lastKnown.execution !== "running") throw new Error("Last-known active command requires running execution");
    }
  }
  if (record.interruption) {
    if (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") throw new Error("Interruption metadata requires an unavailable recoverable lifecycle");
    if (!["host_crash", "host_shutdown", "replacement_failed"].includes(record.interruption.reason)) throw new Error("Interruption reason is invalid");
    timestamp(record.interruption.at, "Interruption timestamp");
  }
  if (record.stopRequestedAt !== undefined) {
    if (record.lifecycle !== "stopping" && record.lifecycle !== "stopped") throw new Error("Stop intent requires a stopping or stopped lifecycle");
    timestamp(record.stopRequestedAt, "Stop intent timestamp");
  }
  if (record.shutdownRequestedAt !== undefined) {
    if (record.lifecycle !== "active" && record.lifecycle !== "stopping") throw new Error("Shutdown intent requires a live lifecycle");
    timestamp(record.shutdownRequestedAt, "Shutdown intent timestamp");
  }
  if (record.stopRequestedAt !== undefined && record.shutdownRequestedAt !== undefined) throw new Error("Stop and Host-shutdown intents are mutually exclusive");
  if (record.lastError !== undefined) requiredBoundedText(record.lastError, 2_048, "Catalog last error");
}

export function validateCatalogProjection(projection: CatalogProjection): void {
  if (projection.schemaVersion !== 1) throw new Error("Catalog schema version is unsupported");
  if (!Number.isSafeInteger(projection.revision) || projection.revision < 0) throw new Error("Catalog revision must be a non-negative integer");
  requiredBoundedText(projection.lastHostEpoch, 128, "Catalog Host epoch");
  if (!Array.isArray(projection.instances) || projection.instances.length > 10_000) throw new Error("Catalog instance collection is invalid or too large");
  const ids = new Set<string>();
  const creationOperations = new Set<string>();
  for (const record of projection.instances) {
    validateCatalogRecord(record);
    if (ids.has(record.id)) throw new Error(`Duplicate catalog instance ID: ${record.id}`);
    if (creationOperations.has(record.creationOperationId)) throw new Error(`Duplicate catalog creation operation ID: ${record.creationOperationId}`);
    ids.add(record.id);
    creationOperations.add(record.creationOperationId);
    if ((record.lifecycle === "active" || record.lifecycle === "stopping") && record.ownerHostEpoch !== projection.lastHostEpoch) {
      throw new Error("Live catalog record owner does not match lastHostEpoch");
    }
  }
}

function requiredBoundedText(value: string, limit: number, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a bounded terminal-safe string`);
  }
}

function absolutePath(value: string, label: string): void {
  requiredBoundedText(value, 16_384, label);
  if (!value.startsWith("/")) throw new Error(`${label} must be absolute`);
}

function timestamp(value: string, label: string): void {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} must be canonical ISO-8601 UTC`);
}
