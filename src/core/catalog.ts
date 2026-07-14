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
  kind: "new" | "switch" | "reload";
  previousSessionFile?: string;
  requestedSessionFile?: string;
  startedAt: string;
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
  stopRequestedAt?: string;
  shutdownRequestedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogProjection {
  schemaVersion: 1;
  revision: number;
  instances: CatalogInstanceRecord[];
}

export interface CatalogCommitPort {
  commit(candidate: Readonly<CatalogProjection>, context: Readonly<CatalogMutationContext>): Promise<void>;
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

export function validateInstanceStateInvariant(value: {
  lifecycle: InstanceLifecycle;
  execution: InstanceExecution;
  ownerHostEpoch?: string;
  pendingCount: number;
  activeCommandId?: string;
  admissionPending?: boolean;
  admissionOperationId?: string;
}): void {
  if (!Number.isSafeInteger(value.pendingCount) || value.pendingCount < 0) throw new Error("Instance pending count must be a non-negative integer");
  const terminal = value.lifecycle === "stopped" || value.lifecycle === "host_lost" || value.lifecycle === "runtime_error";
  if (terminal !== (value.execution === "unavailable")) throw new Error("Instance lifecycle/execution invariant failed");
  if ((value.lifecycle === "active" || value.lifecycle === "stopping") !== (value.ownerHostEpoch !== undefined)) throw new Error("Instance owner Host epoch invariant failed");
  if (terminal && (value.pendingCount !== 0 || value.activeCommandId !== undefined || value.admissionPending || value.admissionOperationId !== undefined)) throw new Error("Unavailable instance retains active catalog facts");
  if (value.activeCommandId !== undefined && value.execution !== "running") throw new Error("Active command requires running execution");
  if (value.admissionPending && ((value.lifecycle !== "active" && value.lifecycle !== "stopping") || value.admissionOperationId === undefined)) throw new Error("Admission intent is incomplete");
  if (!value.admissionPending && value.admissionOperationId !== undefined) throw new Error("Admission operation exists without an intent");
}

export function validateCatalogRecord(record: CatalogInstanceRecord): void {
  if (!record.id || !record.creationOperationId || !record.cwd || !record.piSessionId) throw new Error("Catalog identity fields must be non-empty");
  if (!Number.isSafeInteger(record.runtimeGeneration) || record.runtimeGeneration < 1) throw new Error("Catalog runtime generation must be positive");
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("Catalog timestamps must be valid");
  validateInstanceStateInvariant(record);
  if (record.replacement && record.lifecycle !== "active") throw new Error("Replacement intent requires an active instance");
  if (record.replacement && record.recoverySessionFile) throw new Error("Replacement intent cannot also expose a recovery session");
  if (record.recoverySessionFile !== undefined && (record.recoverySessionFile.length === 0 || (record.lifecycle !== "runtime_error" && record.lifecycle !== "host_lost"))) {
    throw new Error("Recovery session requires an unavailable recoverable lifecycle");
  }
}
