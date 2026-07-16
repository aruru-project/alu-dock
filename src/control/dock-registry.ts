import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  CatalogCommitPort,
  CatalogInstanceRecord,
  CatalogStore,
} from "../core/catalog.js";
import { InstanceBusyError, type InstanceLifecycle, type ManagedInstance, type InstanceSnapshot } from "../core/managed-instance.js";
import { CatalogTransactionCoordinator, type CatalogFault, type CatalogHealth } from "./catalog-transactions.js";
import {
  catalogReopenSessionFile,
  catalogSnapshotFromRecord,
  reconcileCatalogProjection,
} from "./catalog-reconcile.js";
import type {
  ProjectTrustChoice,
  ProjectTrustRequest,
  ProjectTrustResolution,
} from "./project-trust.js";

export interface InstanceFactoryInput {
  id: string;
  creationOperationId: string;
  hostEpoch: string;
  cwd: string;
  name?: string;
  projectTrusted: boolean;
  sessionFile?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
}

export interface ReopenRegistryInstanceInput {
  operationId: string;
  instanceId: string;
  sessionFile?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
}

export interface ReopenTargetResolver {
  resolve(sessionFile: string): Promise<{ cwd: string }>;
}

export interface CreateTrustPreflight {
  resolve(input: ProjectTrustRequest): Promise<ProjectTrustResolution>;
}

export class InstanceNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`Managed instance not found: ${instanceId}`);
    this.name = "InstanceNotFoundError";
  }
}

export class InstanceUnavailableError extends Error {
  constructor(readonly instanceId: string, readonly lifecycle: InstanceLifecycle) {
    super(`Instance ${instanceId} is ${lifecycle} and has no live runtime`);
    this.name = "InstanceUnavailableError";
  }
}

export class InstanceNotReopenableError extends Error {
  constructor(readonly instanceId: string) {
    super(`Instance ${instanceId} has no validated session context to reopen`);
    this.name = "InstanceNotReopenableError";
  }
}

export class CatalogListCursorStaleError extends Error {
  readonly retryable = true;

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Catalog list cursor revision ${expectedRevision} does not match current revision ${actualRevision}`);
    this.name = "CatalogListCursorStaleError";
  }
}

export class InstanceForgetRejectedError extends Error {
  constructor(readonly instanceId: string, readonly lifecycle: InstanceLifecycle) {
    super(`Instance ${instanceId} is ${lifecycle}; only stopped, host_lost, or runtime_error records can be forgotten`);
    this.name = "InstanceForgetRejectedError";
  }
}

export class CatalogOperationRecordedError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} is already recorded by the durable catalog; query instance.list instead of retrying`);
    this.name = "CatalogOperationRecordedError";
  }
}

function newestInstanceFirst(left: InstanceSnapshot, right: InstanceSnapshot): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export class DockRegistry {
  readonly hostEpoch: string;
  readonly startedAt: string;
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly catalog: CatalogTransactionCoordinator;
  private readonly catalogStore: CatalogStore | undefined;
  private readonly reopenInFlight = new Map<string, string>();
  private catalogMaintenancePending = false;
  private readonly runtimeReopenListeners = new Set<(instanceId: string) => void>();
  private readonly catalogRemovalListeners = new Set<(instanceIds: readonly string[]) => void>();
  private catalogReady: boolean;
  private lastReconciledAtValue: string;
  private startupNormalizedCountValue = 0;

  constructor(
    private readonly factory: InstanceFactory,
    private readonly createId: () => string = randomUUID,
    options: {
      hostEpoch?: string;
      startedAt?: string;
      trustPreflight?: CreateTrustPreflight;
      catalogCommitPort?: CatalogCommitPort;
      catalogStore?: CatalogStore;
      reopenTargetResolver?: ReopenTargetResolver;
    } = {},
  ) {
    if (options.catalogCommitPort && options.catalogStore) throw new Error("Configure either catalogCommitPort or catalogStore, not both");
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.lastReconciledAtValue = this.startedAt;
    this.trustPreflight = options.trustPreflight;
    this.reopenTargetResolver = options.reopenTargetResolver;
    this.catalogStore = options.catalogStore;
    this.catalogReady = options.catalogStore === undefined;
    this.catalog = new CatalogTransactionCoordinator(options.catalogStore ?? options.catalogCommitPort, this.hostEpoch);
  }

  private readonly trustPreflight: CreateTrustPreflight | undefined;
  private readonly reopenTargetResolver: ReopenTargetResolver | undefined;

  async initializeCatalog(): Promise<void> {
    if (!this.catalogStore) return;
    if (this.catalogReady) throw new Error("Durable catalog is already initialized");
    const loaded = await this.catalogStore.load();
    const reconciled = reconcileCatalogProjection(loaded, this.hostEpoch, new Date(this.startedAt));
    await this.catalogStore.commit(reconciled.projection, {
      kind: "host.startup_reconcile",
      effect: "pre_effect",
    });
    this.catalog.initialize(reconciled.projection);
    this.startupNormalizedCountValue = reconciled.normalizedCount;
    this.lastReconciledAtValue = this.startedAt;
    this.catalogReady = true;
  }

  async create(input: CreateRegistryInstanceInput): Promise<ManagedInstance> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalog.current().instances.some((record) => record.creationOperationId === input.operationId)) {
      throw new CatalogOperationRecordedError(input.operationId);
    }
    const resolution = await this.resolveProjectTrust({
      operationType: "instance.create",
      operationId: input.operationId,
      cwd: input.cwd,
      name: input.name,
      trustChallengeId: input.trustChallengeId,
      projectTrustDecision: input.projectTrustDecision,
    });
    const cwd = resolution.canonicalCwd;

    const id = this.createId();
    if (this.instances.has(id) || this.catalog.current().instances.some((record) => record.id === id)) {
      throw new Error(`Generated duplicate instance identity: ${id}`);
    }
    const instance = await this.factory({ id, creationOperationId: input.operationId, hostEpoch: this.hostEpoch, cwd, name: input.name, projectTrusted: resolution.projectTrusted });
    if (
      instance.id !== id
      || instance.creationOperationId !== input.operationId
      || instance.hostEpoch !== this.hostEpoch
    ) {
      await instance.disposeUnpublished().catch(() => {});
      throw new Error("Instance factory returned an identity outside the registry Host domain");
    }
    instance.bindCatalogPort(this.catalog.forInstance(id));
    try {
      await this.catalog.create(instance.catalogRecord(), {
        kind: "instance.create",
        effect: "rollback_contained",
        operationId: input.operationId,
        instanceId: id,
      });
    } catch (error) {
      await instance.disposeUnpublished().catch(() => {});
      throw error;
    }
    instance.markCatalogCommitted();
    this.instances.set(id, instance);
    return instance;
  }

  async reopen(input: ReopenRegistryInstanceInput): Promise<{ instance: ManagedInstance; previousLifecycle: "host_lost" | "runtime_error" }> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalogMaintenancePending || this.reopenInFlight.has(input.instanceId)) throw new InstanceBusyError(input.instanceId, "reopen");
    this.reopenInFlight.set(input.instanceId, input.operationId);
    try {
      return await this.performReopen(input);
    } finally {
      if (this.reopenInFlight.get(input.instanceId) === input.operationId) this.reopenInFlight.delete(input.instanceId);
    }
  }

  private async performReopen(input: ReopenRegistryInstanceInput): Promise<{ instance: ManagedInstance; previousLifecycle: "host_lost" | "runtime_error" }> {
    const record = this.catalogRecord(input.instanceId);
    if (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") throw new InstanceNotReopenableError(input.instanceId);
    const previousLifecycle = record.lifecycle;
    const sessionFile = input.sessionFile ?? catalogReopenSessionFile(record);
    if (!sessionFile || !this.reopenTargetResolver) throw new InstanceNotReopenableError(input.instanceId);
    const target = await this.reopenTargetResolver.resolve(sessionFile);
    const trust = await this.resolveProjectTrust({
      operationType: "instance.reopen",
      operationId: input.operationId,
      cwd: target.cwd,
      name: sessionFile,
      trustChallengeId: input.trustChallengeId,
      projectTrustDecision: input.projectTrustDecision,
    });
    const nextGeneration = record.runtimeGeneration + 1;
    const candidate = await this.factory({
      id: record.id,
      creationOperationId: record.creationOperationId,
      hostEpoch: this.hostEpoch,
      cwd: trust.canonicalCwd,
      name: record.name,
      projectTrusted: trust.projectTrusted,
      sessionFile,
      initialRuntimeGeneration: nextGeneration,
      createdAt: record.createdAt,
      reopenedFrom: previousLifecycle,
    });
    if (
      candidate.id !== record.id
      || candidate.creationOperationId !== record.creationOperationId
      || candidate.hostEpoch !== this.hostEpoch
      || candidate.runtimeGeneration !== nextGeneration
      || candidate.snapshot().lifecycle !== "active"
    ) {
      await candidate.disposeUnpublished().catch(() => {});
      throw new Error("Reopen factory returned an identity outside the catalog transaction");
    }
    candidate.bindCatalogPort(this.catalog.forInstance(record.id));
    try {
      await this.catalog.forInstance(record.id).commit(candidate.catalogRecord(), {
        kind: "instance.reopen",
        effect: "rollback_contained",
        operationId: input.operationId,
        instanceId: record.id,
      });
    } catch (error) {
      await candidate.disposeUnpublished().catch(() => {});
      throw error;
    }
    candidate.markCatalogCommitted();
    const previous = this.instances.get(record.id);
    this.instances.set(record.id, candidate);
    for (const listener of this.runtimeReopenListeners) {
      try { listener(record.id); } catch { /* A stale client cannot roll back a committed reopen. */ }
    }
    if (previous && previous !== candidate) await previous.disposeUnpublished().catch(() => {});
    return { instance: candidate, previousLifecycle };
  }

  get(instanceId: string): ManagedInstance {
    this.assertCatalogReady();
    const instance = this.instances.get(instanceId);
    if (instance) return instance;
    const record = this.catalog.current().instances.find((item) => item.id === instanceId);
    if (record) throw new InstanceUnavailableError(instanceId, record.lifecycle);
    throw new InstanceNotFoundError(instanceId);
  }

  getSnapshot(instanceId: string): InstanceSnapshot {
    this.assertCatalogReady();
    const live = this.instances.get(instanceId);
    if (live) return live.snapshot();
    return catalogSnapshotFromRecord(this.catalogRecord(instanceId), this.hostEpoch);
  }

  list(): InstanceSnapshot[] {
    this.assertCatalogReady();
    return this.catalog.current().instances
      .map((record) => this.instances.get(record.id)?.snapshot() ?? catalogSnapshotFromRecord(record, this.hostEpoch))
      .sort(newestInstanceFirst);
  }

  listPage(input: {
    selector: "actionable" | "all";
    cursor?: { revision: number; offset: number; selector: "actionable" | "all" };
    limit: number;
    maxBytes: number;
  }): {
    instances: InstanceSnapshot[];
    page: {
      revision: number;
      total: number;
      hiddenStopped: number;
      nextCursor?: { revision: number; offset: number; selector: "actionable" | "all" };
    };
  } {
    this.assertCatalogReady();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("Catalog list limit must be a positive safe integer");
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4_096) throw new Error("Catalog list byte limit must be a bounded positive safe integer");
    const projection = this.catalog.current();
    if (input.cursor && input.cursor.revision !== projection.revision) {
      throw new CatalogListCursorStaleError(input.cursor.revision, projection.revision);
    }
    if (input.cursor && input.cursor.selector !== input.selector) throw new Error("Catalog list cursor selector mismatch");
    const all = projection.instances
      .map((record) => this.instances.get(record.id)?.snapshot() ?? catalogSnapshotFromRecord(record, this.hostEpoch))
      .sort(newestInstanceFirst);
    const hiddenStopped = all.filter((instance) => instance.lifecycle === "stopped").length;
    const selected = input.selector === "all" ? all : all.filter((instance) => instance.lifecycle !== "stopped");
    const offset = input.cursor?.offset ?? 0;
    if (offset > selected.length) throw new CatalogListCursorStaleError(projection.revision, projection.revision);
    const instances: InstanceSnapshot[] = [];
    // Reserve space for the result keys and page metadata. The Host separately
    // keeps the complete response envelope below the control line cap.
    const snapshotBudget = input.maxBytes - 4_096;
    let snapshotsBytes = 2; // JSON array brackets
    for (const candidate of selected.slice(offset, offset + input.limit)) {
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      const separatorBytes = instances.length === 0 ? 0 : 1;
      if (snapshotsBytes + separatorBytes + candidateBytes > snapshotBudget) {
        if (instances.length === 0) throw new Error(`Catalog instance snapshot exceeds the bounded list result: ${candidate.id}`);
        break;
      }
      instances.push(candidate);
      snapshotsBytes += separatorBytes + candidateBytes;
    }
    const nextOffset = offset + instances.length;
    const result = {
      instances,
      page: {
        revision: projection.revision,
        total: selected.length,
        hiddenStopped: input.selector === "all" ? 0 : hiddenStopped,
        ...(nextOffset < selected.length
          ? { nextCursor: { revision: projection.revision, offset: nextOffset, selector: input.selector } }
          : {}),
      },
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > input.maxBytes) throw new Error("Catalog list result exceeded its serialized byte bound");
    return result;
  }

  async forget(operationId: string, instanceId: string): Promise<{ forgottenId: string; previousLifecycle: "stopped" | "host_lost" | "runtime_error" }> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalogMaintenancePending || this.reopenInFlight.has(instanceId)) throw new InstanceBusyError(instanceId, "forget");
    this.catalogMaintenancePending = true;
    try {
      const removed = await this.catalog.remove(instanceId, {
        kind: "instance.forget",
        // The atomic rename may have removed the record even if durability
        // acknowledgement fails; never invite an automatic destructive retry.
        effect: "post_effect",
        operationId,
        instanceId,
      }, (record) => {
        if (record.lifecycle !== "stopped" && record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") {
          throw new InstanceForgetRejectedError(instanceId, record.lifecycle);
        }
      });
      if (!removed) throw new InstanceNotFoundError(instanceId);
      this.instances.delete(instanceId);
      this.notifyCatalogRemoval([instanceId]);
      return { forgottenId: removed.id, previousLifecycle: removed.lifecycle as "stopped" | "host_lost" | "runtime_error" };
    } finally {
      this.catalogMaintenancePending = false;
    }
  }

  async pruneStopped(operationId: string, limit = 1_000): Promise<{ forgottenIds: string[]; hasMore: boolean }> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalogMaintenancePending || this.reopenInFlight.size > 0) throw new InstanceBusyError("catalog", "prune stopped records");
    this.catalogMaintenancePending = true;
    try {
      const result = await this.catalog.removeWhere({
        kind: "catalog.prune",
        // Treat any commit failure conservatively because the catalog removal
        // may already be visible after rename.
        effect: "post_effect",
        operationId,
      }, (record) => record.lifecycle === "stopped", limit);
      const forgottenIds = result.removed.map((record) => record.id);
      for (const instanceId of forgottenIds) this.instances.delete(instanceId);
      this.notifyCatalogRemoval(forgottenIds);
      return { forgottenIds, hasMore: result.hasMore };
    } finally {
      this.catalogMaintenancePending = false;
    }
  }

  catalogRevision(): number {
    this.assertCatalogReady();
    return this.catalog.revision;
  }

  async resolveProjectTrust(input: ProjectTrustRequest): Promise<ProjectTrustResolution> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    return this.trustPreflight
      ? this.trustPreflight.resolve(input)
      : { canonicalCwd: await canonicalDirectory(input.cwd), projectTrusted: true };
  }

  catalogHealth(): CatalogHealth { return this.catalog.health; }
  catalogFault(): CatalogFault | undefined { return this.catalog.fault; }
  catalogPath(): string | undefined { return this.catalogStore?.path; }
  lastReconciledAt(): string { return this.lastReconciledAtValue; }
  startupNormalizedCount(): number { return this.startupNormalizedCountValue; }
  isDurable(): boolean { return this.catalogStore !== undefined; }
  assertMutationAllowed(): void { this.assertCatalogReady(); this.catalog.assertWritable(); }
  onMutationFault(listener: (fault: CatalogFault) => void): () => void { return this.catalog.onFault(listener); }
  onRuntimeReopened(listener: (instanceId: string) => void): () => void {
    this.runtimeReopenListeners.add(listener);
    return () => this.runtimeReopenListeners.delete(listener);
  }

  onCatalogRecordsRemoved(listener: (instanceIds: readonly string[]) => void): () => void {
    this.catalogRemovalListeners.add(listener);
    return () => this.catalogRemovalListeners.delete(listener);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.stop()));
  }

  beginMutationDrain(): void { this.catalog.beginDraining(); }

  async cancelInteractionsForHostDrain(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.cancelInteractionsForHostDrain()));
  }

  async shutdownAllForHostDrain(): Promise<void> {
    const active = [...this.instances.values()].filter((instance) => {
      const lifecycle = instance.snapshot().lifecycle;
      return lifecycle === "active" || lifecycle === "stopping";
    });
    const results = await Promise.allSettled(active.map((instance) => instance.shutdownForHostDrain()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "One or more instances failed durable Host shutdown");
  }

  async disposeAllForHostDrain(): Promise<void> {
    this.beginMutationDrain();
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.disposeForHostDrain()));
  }

  private notifyCatalogRemoval(instanceIds: readonly string[]): void {
    if (instanceIds.length === 0) return;
    const immutableIds = Object.freeze([...instanceIds]);
    for (const listener of this.catalogRemovalListeners) {
      try { listener(immutableIds); } catch { /* Stream cleanup cannot roll back committed catalog removal. */ }
    }
  }

  private catalogRecord(instanceId: string): CatalogInstanceRecord {
    const record = this.catalog.current().instances.find((item) => item.id === instanceId);
    if (!record) throw new InstanceNotFoundError(instanceId);
    return record;
  }

  private assertCatalogReady(): void {
    if (!this.catalogReady) throw new Error("Durable catalog startup reconciliation has not completed");
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${lexical}`);
  return realpath(lexical);
}
