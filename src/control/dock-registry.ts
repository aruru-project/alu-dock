import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type CatalogCommitPort,
  type CatalogInstanceRecord,
  type CatalogStore,
  validateInstanceKey,
} from "../core/catalog.js";
import { AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import type { ConversationRecordDto, DockEvent } from "../core/instance-dto.js";
import { InstanceBusyError, type InstanceLifecycle, type ManagedInstance, type InstanceSnapshot } from "../core/managed-instance.js";
import {
  CROSS_INSTANCE_TRUST,
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  MAX_OBSERVATION_ACTIVITY_BYTES,
  MAX_OBSERVATION_LIST_ITEMS,
  OBSERVATION_DATA_NOTICE,
  type InstanceObservation,
  type InstanceObservationHostPort,
  type ObservationDeliverySink,
  type ObservationNotification,
  type ObservationRequest,
  type ObservationResult,
  type ObservationTerminalReason,
  type ObservationWatchReceipt,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
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
  key?: string;
  name?: string;
  projectTrusted: boolean;
  sessionFile?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
  observationHostPort: InstanceObservationHostPort;
  observationGrant: boolean;
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
}

export interface EnsureRegistryInstanceInput extends CreateRegistryInstanceInput {
  key: string;
}

export interface AdoptRegistryInstanceInput {
  operationId: string;
  sessionFile: string;
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

interface ObservationWatch {
  receipt: ObservationWatchReceipt;
  sourceInstanceId: string;
  targetInstanceId: string;
  unsubscribe: () => void;
  lastStatus: ObservedInstanceStatus;
  initializing: boolean;
  pendingReason?: ObservationTerminalReason;
}

export class DockRegistry implements InstanceObservationHostPort {
  readonly hostEpoch: string;
  readonly startedAt: string;
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly catalog: CatalogTransactionCoordinator;
  private readonly catalogStore: CatalogStore | undefined;
  private readonly reopenInFlight = new Map<string, string>();
  private readonly sessionFileClaims = new Map<string, { ownerId: string; operationId: string }>();
  private readonly keyEnsureTails = new Map<string, Promise<void>>();
  private catalogMaintenancePending = false;
  private readonly runtimeReopenListeners = new Set<(instanceId: string) => void>();
  private readonly catalogRemovalListeners = new Set<(instanceIds: readonly string[]) => void>();
  private readonly observationSinks = new Map<string, ObservationDeliverySink>();
  private readonly pendingObservationDeliveries = new Map<string, ObservationNotification[]>();
  private readonly observationWatches = new Map<string, ObservationWatch>();
  private readonly observationSourceTails = new Map<string, Promise<void>>();
  private readonly instanceObservationSubscriptions = new Map<string, () => void>();
  private readonly instanceObservationSinkDetachments = new Map<string, () => void>();
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
    return this.createNew(input);
  }

  async ensure(input: EnsureRegistryInstanceInput): Promise<{ created: boolean; instance: InstanceSnapshot }> {
    this.assertCatalogReady();
    validateInstanceKey(input.key);
    const previous = this.keyEnsureTails.get(input.key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
    this.keyEnsureTails.set(input.key, turn);
    await previous.catch(() => {});
    try {
      this.catalog.assertWritable();
      const existing = this.catalog.current().instances.find((record) => record.key === input.key);
      if (existing) return { created: false, instance: this.safeSnapshot(existing) };
      const instance = await this.createNew(input, input.key);
      return { created: true, instance: instance.snapshot() };
    } finally {
      release();
      if (this.keyEnsureTails.get(input.key) === turn) this.keyEnsureTails.delete(input.key);
    }
  }

  private async createNew(input: CreateRegistryInstanceInput, key?: string): Promise<ManagedInstance> {
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
    const instance = await this.factory({ id, creationOperationId: input.operationId, hostEpoch: this.hostEpoch, cwd, key, name: input.name, projectTrusted: resolution.projectTrusted, observationHostPort: this, observationGrant: false });
    if (
      instance.id !== id
      || instance.creationOperationId !== input.operationId
      || instance.hostEpoch !== this.hostEpoch
      || instance.key !== key
    ) {
      await instance.disposeUnpublished().catch(() => {});
      throw new Error("Instance factory returned an identity outside the registry Host domain");
    }
    instance.bindCatalogPort(this.catalog.forInstance(id));
    try {
      await this.catalog.create(instance.catalogRecord(), {
        kind: key === undefined ? "instance.create" : "instance.ensure",
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
    this.trackInstanceForObservation(instance);
    return instance;
  }

  async adopt(input: AdoptRegistryInstanceInput): Promise<ManagedInstance> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalog.current().instances.some((record) => record.creationOperationId === input.operationId)) {
      throw new CatalogOperationRecordedError(input.operationId);
    }
    if (!this.reopenTargetResolver) throw new Error("Persisted Pi session adoption is unavailable");
    const sessionFile = resolve(input.sessionFile);
    const releaseClaim = this.claimSessionFile(`adopt:${input.operationId}`, input.operationId, sessionFile);
    try {
      return await this.performAdopt(input, sessionFile);
    } finally {
      releaseClaim();
    }
  }

  private async performAdopt(input: AdoptRegistryInstanceInput, sessionFile: string): Promise<ManagedInstance> {
    const target = await this.reopenTargetResolver!.resolve(sessionFile);
    const trust = await this.resolveProjectTrust({
      operationType: "instance.adopt",
      operationId: input.operationId,
      cwd: target.cwd,
      name: sessionFile,
      trustChallengeId: input.trustChallengeId,
      projectTrustDecision: input.projectTrustDecision,
    });
    const id = this.createId();
    if (this.instances.has(id) || this.catalog.current().instances.some((record) => record.id === id)) {
      throw new Error(`Generated duplicate instance identity: ${id}`);
    }
    const instance = await this.factory({
      id,
      creationOperationId: input.operationId,
      hostEpoch: this.hostEpoch,
      cwd: trust.canonicalCwd,
      name: input.name,
      projectTrusted: trust.projectTrusted,
      sessionFile,
      observationHostPort: this,
      observationGrant: false,
    });
    if (
      instance.id !== id
      || instance.creationOperationId !== input.operationId
      || instance.hostEpoch !== this.hostEpoch
      || instance.snapshot().executor.sessionFile !== sessionFile
    ) {
      await instance.disposeUnpublished().catch(() => {});
      throw new Error("Adopt factory returned an identity or session outside the registry Host domain");
    }
    instance.bindCatalogPort(this.catalog.forInstance(id));
    try {
      await this.catalog.create(instance.catalogRecord(), {
        kind: "instance.adopt",
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
    this.trackInstanceForObservation(instance);
    return instance;
  }

  claimSessionFile(ownerId: string, operationId: string, rawSessionFile: string): () => void {
    const sessionFile = resolve(rawSessionFile);
    const liveOwner = [...this.instances.values()].find((instance) => {
      const snapshot = instance.snapshot();
      return instance.id !== ownerId
        && (snapshot.lifecycle === "active" || snapshot.lifecycle === "stopping")
        && snapshot.executor.sessionFile === sessionFile;
    });
    if (liveOwner) throw new InstanceBusyError(liveOwner.id, "use persisted session");
    const pending = this.sessionFileClaims.get(sessionFile);
    if (pending && (pending.ownerId !== ownerId || pending.operationId !== operationId)) {
      throw new InstanceBusyError(pending.ownerId, "use persisted session");
    }
    this.sessionFileClaims.set(sessionFile, { ownerId, operationId });
    return () => {
      const current = this.sessionFileClaims.get(sessionFile);
      if (current?.ownerId === ownerId && current.operationId === operationId) this.sessionFileClaims.delete(sessionFile);
    };
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
    if (record.ownerReleaseUnconfirmed) throw new InstanceNotReopenableError(input.instanceId);
    const previousLifecycle = record.lifecycle;
    const sessionFile = input.sessionFile ?? catalogReopenSessionFile(record);
    if (!sessionFile || !this.reopenTargetResolver) throw new InstanceNotReopenableError(input.instanceId);
    const releaseClaim = this.claimSessionFile(record.id, input.operationId, sessionFile);
    try {
      return await this.performClaimedReopen(input, record, previousLifecycle, sessionFile);
    } finally {
      releaseClaim();
    }
  }

  private async performClaimedReopen(
    input: ReopenRegistryInstanceInput,
    record: CatalogInstanceRecord,
    previousLifecycle: "host_lost" | "runtime_error",
    sessionFile: string,
  ): Promise<{ instance: ManagedInstance; previousLifecycle: "host_lost" | "runtime_error" }> {
    const target = await this.reopenTargetResolver!.resolve(sessionFile);
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
      key: record.key,
      name: record.name,
      projectTrusted: trust.projectTrusted,
      sessionFile,
      initialRuntimeGeneration: nextGeneration,
      createdAt: record.createdAt,
      reopenedFrom: previousLifecycle,
      observationHostPort: this,
      observationGrant: record.observationGrant ?? false,
    });
    if (
      candidate.id !== record.id
      || candidate.creationOperationId !== record.creationOperationId
      || candidate.hostEpoch !== this.hostEpoch
      || candidate.key !== record.key
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
    this.trackInstanceForObservation(candidate);
    for (const listener of this.runtimeReopenListeners) {
      try { listener(record.id); } catch { /* A stale client cannot roll back a committed reopen. */ }
    }
    if (previous && previous !== candidate) await previous.disposeUnpublished().catch(() => {});
    return { instance: candidate, previousLifecycle };
  }

  observationGrant(sourceInstanceId: string): boolean {
    this.assertCatalogReady();
    return this.catalogRecord(sourceInstanceId).observationGrant ?? false;
  }

  configureObservation(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }> {
    return this.withObservationSource(sourceInstanceId, async () => {
      this.assertCatalogReady();
      const instance = this.get(sourceInstanceId);
      await instance.setObservationGrant(enabled, operationId);
      if (!enabled) this.cancelSourceWatches(sourceInstanceId);
      return { enabled: instance.observationGrant() };
    });
  }

  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void {
    this.observationSinks.set(sourceInstanceId, sink);
    void this.flushPendingObservationDeliveries(sourceInstanceId, sink);
    return () => { if (this.observationSinks.get(sourceInstanceId) === sink) this.observationSinks.delete(sourceInstanceId); };
  }

  observe(sourceInstanceId: string, request: ObservationRequest): Promise<ObservationResult> {
    return this.withObservationSource(sourceInstanceId, async () => {
      if (!this.observationGrant(sourceInstanceId)) throw new Error("Dock observation is not granted for this source instance");
      if (this.getSnapshot(sourceInstanceId).lifecycle !== "active") throw new Error("Dock observation requires an active source instance");
      if (request.type === "cancel") {
        const cancelledWatchIds = request.watchId === undefined
          ? this.cancelSourceWatches(sourceInstanceId)
          : this.cancelOneWatch(sourceInstanceId, request.watchId);
        return { type: "cancel", cancelledWatchIds };
      }
      if (request.type === "list") {
        const all = this.list().filter((item) => item.id !== sourceInstanceId).map(observationStatus);
        const instances = all.slice(0, MAX_OBSERVATION_LIST_ITEMS);
        return {
          type: "list",
          result: {
            trust: CROSS_INSTANCE_TRUST,
            observedAt: new Date().toISOString(),
            instances,
            total: all.length,
            truncated: instances.length < all.length,
          },
        };
      }
      const target = this.resolveObservationTarget(sourceInstanceId, request.target);
      if (request.type === "inspect") return { type: "inspect", result: await this.inspectObservation(target.id) };
      return this.watchObservation(sourceInstanceId, target.id);
    });
  }

  private async watchObservation(sourceInstanceId: string, targetInstanceId: string): Promise<ObservationResult> {
    const activeForSource = [...this.observationWatches.values()].filter((watch) => watch.sourceInstanceId === sourceInstanceId).length;
    if (activeForSource >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) {
      throw new Error(`Dock observation is limited to ${MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE} active watches per source instance`);
    }
    const watchId = randomUUID();
    const registeredAt = new Date().toISOString();
    const receipt = { watchId, targetInstanceId, registeredAt };
    const target = this.instances.get(targetInstanceId);
    const initial = this.getSnapshot(targetInstanceId);
    const initialStatus = observationStatus(initial);
    const immediate = observationTerminalReason(initial);
    if (immediate) {
      return { type: "watch", status: "completed", completion: await this.makeObservationNotification(receipt, immediate, initialStatus) };
    }
    if (!target) {
      return { type: "watch", status: "completed", completion: await this.makeObservationNotification(receipt, "execution_unavailable", initialStatus) };
    }
    const unsubscribe = target.subscribe(() => { void this.maybeCompleteWatch(watchId); });
    const watch: ObservationWatch = {
      receipt,
      sourceInstanceId,
      targetInstanceId,
      unsubscribe,
      lastStatus: initialStatus,
      initializing: true,
    };
    this.observationWatches.set(watchId, watch);
    const afterSubscribe = this.getSnapshot(targetInstanceId);
    watch.lastStatus = observationStatus(afterSubscribe);
    const racedTerminal = observationTerminalReason(afterSubscribe) ?? watch.pendingReason;
    watch.initializing = false;
    if (racedTerminal) {
      const completion = await this.completeWatch(watchId, racedTerminal, false);
      if (completion) return { type: "watch", status: "completed", completion };
    }
    return { type: "watch", status: "watching", receipt };
  }

  private async maybeCompleteWatch(watchId: string): Promise<void> {
    const watch = this.observationWatches.get(watchId);
    if (!watch) return;
    let snapshot: InstanceSnapshot;
    try { snapshot = this.getSnapshot(watch.targetInstanceId); }
    catch {
      if (watch.initializing) watch.pendingReason = "execution_unavailable";
      else await this.completeWatch(watchId, "execution_unavailable", true);
      return;
    }
    watch.lastStatus = observationStatus(snapshot);
    const reason = observationTerminalReason(snapshot);
    if (!reason) return;
    if (watch.initializing) watch.pendingReason = reason;
    else await this.completeWatch(watchId, reason, true);
  }

  private async completeWatch(watchId: string, reason: ObservationTerminalReason, deliver: boolean): Promise<ObservationNotification | undefined> {
    const watch = this.observationWatches.get(watchId);
    if (!watch) return undefined;
    this.observationWatches.delete(watchId);
    watch.unsubscribe();
    const notification = await this.makeObservationNotification(watch.receipt, reason, watch.lastStatus);
    if (deliver) this.deliverObservationCompletion(watch.sourceInstanceId, notification);
    return notification;
  }

  private async makeObservationNotification(
    receipt: ObservationWatchReceipt,
    reason: ObservationTerminalReason,
    fallbackStatus: ObservedInstanceStatus,
  ): Promise<ObservationNotification> {
    const firedAt = new Date().toISOString();
    let observation: InstanceObservation;
    try { observation = await this.inspectObservation(receipt.targetInstanceId); }
    catch {
      const status = reason === "execution_unavailable"
        ? { ...fallbackStatus, lifecycle: "stopped" as const, execution: "unavailable" as const, executionChangedAt: firedAt, runStartedAt: undefined }
        : fallbackStatus;
      observation = { trust: CROSS_INSTANCE_TRUST, observedAt: firedAt, status };
    }
    return {
      trust: CROSS_INSTANCE_TRUST,
      notice: OBSERVATION_DATA_NOTICE,
      watchId: receipt.watchId,
      firedAt,
      reason,
      observation,
    };
  }

  private deliverObservationCompletion(sourceInstanceId: string, notification: ObservationNotification): void {
    const sink = this.observationSinks.get(sourceInstanceId);
    if (!sink) { this.queuePendingObservationDelivery(sourceInstanceId, notification); return; }
    void sink(notification).catch((error) => {
      if (error instanceof AgentUnavailableBeforeEffectError) this.queuePendingObservationDelivery(sourceInstanceId, notification);
      if (this.observationSinks.get(sourceInstanceId) === sink) this.observationSinks.delete(sourceInstanceId);
    });
  }

  private queuePendingObservationDelivery(sourceInstanceId: string, notification: ObservationNotification): void {
    const pending = this.pendingObservationDeliveries.get(sourceInstanceId) ?? [];
    if (pending.some((item) => item.watchId === notification.watchId)) return;
    if (pending.length >= MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) pending.shift();
    pending.push(notification);
    this.pendingObservationDeliveries.set(sourceInstanceId, pending);
  }

  private async flushPendingObservationDeliveries(sourceInstanceId: string, sink: ObservationDeliverySink): Promise<void> {
    const pending = this.pendingObservationDeliveries.get(sourceInstanceId);
    if (!pending || pending.length === 0) return;
    this.pendingObservationDeliveries.delete(sourceInstanceId);
    for (let index = 0; index < pending.length; index += 1) {
      try { await sink(pending[index]!); }
      catch (error) {
        const remaining = error instanceof AgentUnavailableBeforeEffectError ? pending.slice(index) : pending.slice(index + 1);
        for (const notification of remaining) this.queuePendingObservationDelivery(sourceInstanceId, notification);
        if (this.observationSinks.get(sourceInstanceId) === sink) this.observationSinks.delete(sourceInstanceId);
        return;
      }
    }
  }

  private async inspectObservation(targetInstanceId: string): Promise<InstanceObservation> {
    const observedAt = new Date().toISOString();
    const target = this.instances.get(targetInstanceId);
    if (!target) return { trust: CROSS_INSTANCE_TRUST, observedAt, status: observationStatus(this.getSnapshot(targetInstanceId)) };
    const projection = await target.getAttachProjection(undefined, 24, "conversation_bootstrap");
    return {
      trust: CROSS_INSTANCE_TRUST,
      observedAt,
      status: observationStatus(projection.instance),
      activity: boundedObservationActivity(
        projection.historyRevision,
        projection.recentHistory,
        projection.page.events,
      ),
    };
  }

  private resolveObservationTarget(sourceInstanceId: string, selector: string): InstanceSnapshot {
    const candidates = this.list();
    const exactId = candidates.find((item) => item.id === selector);
    if (exactId) {
      if (exactId.id === sourceInstanceId) throw new Error("An instance cannot observe itself");
      return exactId;
    }
    const exactKey = candidates.find((item) => item.key === selector);
    if (exactKey) {
      if (exactKey.id === sourceInstanceId) throw new Error("An instance cannot observe itself");
      return exactKey;
    }
    const matches = new Map<string, InstanceSnapshot>();
    for (const item of candidates) {
      if (item.id.startsWith(selector) || item.name === selector) matches.set(item.id, item);
    }
    if (matches.size !== 1) throw new Error(`Observation target is missing or ambiguous: ${selector}`);
    const resolved = [...matches.values()][0]!;
    if (resolved.id === sourceInstanceId) throw new Error("An instance cannot observe itself");
    return resolved;
  }

  private withObservationSource<T>(sourceInstanceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.observationSourceTails.get(sourceInstanceId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.observationSourceTails.set(sourceInstanceId, tail);
    void tail.finally(() => {
      if (this.observationSourceTails.get(sourceInstanceId) === tail) this.observationSourceTails.delete(sourceInstanceId);
    });
    return result;
  }

  private cancelOneWatch(sourceInstanceId: string, watchId: string): string[] {
    const watch = this.observationWatches.get(watchId);
    if (!watch || watch.sourceInstanceId !== sourceInstanceId) return [];
    this.observationWatches.delete(watchId); watch.unsubscribe(); return [watchId];
  }

  private cancelSourceWatches(sourceInstanceId: string): string[] {
    const cancelled: string[] = [];
    for (const [watchId, watch] of this.observationWatches) {
      if (watch.sourceInstanceId !== sourceInstanceId) continue;
      this.observationWatches.delete(watchId); watch.unsubscribe(); cancelled.push(watchId);
    }
    this.pendingObservationDeliveries.delete(sourceInstanceId);
    return cancelled;
  }

  private trackInstanceForObservation(instance: ManagedInstance): void {
    this.instanceObservationSubscriptions.get(instance.id)?.();
    this.instanceObservationSinkDetachments.get(instance.id)?.();
    const detachSink = this.attachObservationSink(instance.id, (notification) => instance.deliverObservation(notification));
    this.instanceObservationSinkDetachments.set(instance.id, detachSink);
    this.instanceObservationSubscriptions.set(instance.id, instance.subscribe(() => {
      const snapshot = instance.snapshot();
      if (snapshot.lifecycle === "stopping" || snapshot.lifecycle === "stopped") this.cancelSourceWatches(instance.id);
      if (snapshot.lifecycle === "stopped" || snapshot.lifecycle === "host_lost" || snapshot.lifecycle === "runtime_error") {
        detachSink();
        if (this.instanceObservationSinkDetachments.get(instance.id) === detachSink) this.instanceObservationSinkDetachments.delete(instance.id);
      }
    }));
  }

  private cleanupObservationForForgottenTargets(instanceIds: readonly string[]): void {
    const forgotten = new Set(instanceIds);
    for (const id of forgotten) {
      this.instanceObservationSubscriptions.get(id)?.();
      this.instanceObservationSubscriptions.delete(id);
      this.instanceObservationSinkDetachments.get(id)?.();
      this.instanceObservationSinkDetachments.delete(id);
      this.cancelSourceWatches(id);
      this.observationSinks.delete(id);
    }
    for (const [watchId, watch] of this.observationWatches) {
      if (forgotten.has(watch.targetInstanceId)) void this.completeWatch(watchId, "execution_unavailable", true);
    }
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
    return this.safeSnapshot(this.catalogRecord(instanceId));
  }

  getSnapshotByKey(key: string): InstanceSnapshot | undefined {
    this.assertCatalogReady();
    validateInstanceKey(key);
    const record = this.catalog.current().instances.find((item) => item.key === key);
    return record === undefined ? undefined : this.safeSnapshot(record);
  }

  list(): InstanceSnapshot[] {
    this.assertCatalogReady();
    return this.catalog.current().instances
      .map((record) => this.safeSnapshot(record))
      .sort(newestInstanceFirst);
  }

  /**
   * A live projection fault belongs to one instance. Fall back to its last
   * committed catalog record so Hub/list/status for unrelated instances stay
   * usable; strict Protocol validation remains unchanged.
   */
  private safeSnapshot(record: CatalogInstanceRecord): InstanceSnapshot {
    const live = this.instances.get(record.id);
    if (live) {
      try { return live.snapshot(); }
      catch { /* bounded catalog fallback below */ }
    }
    return catalogSnapshotFromRecord(record, this.hostEpoch);
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
      .map((record) => this.safeSnapshot(record))
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
      this.cleanupObservationForForgottenTargets([instanceId]);
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
      this.cleanupObservationForForgottenTargets(forgottenIds);
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

function observationStatus(snapshot: InstanceSnapshot): ObservedInstanceStatus {
  return {
    id: snapshot.id,
    ...(snapshot.key === undefined ? {} : { key: snapshot.key }),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    lifecycle: snapshot.lifecycle,
    execution: snapshot.execution,
    executionChangedAt: snapshot.executionChangedAt,
    ...(snapshot.runStartedAt === undefined ? {} : { runStartedAt: snapshot.runStartedAt }),
    runtimeGeneration: snapshot.runtimeGeneration,
  };
}

function observationTerminalReason(snapshot: InstanceSnapshot): ObservationTerminalReason | undefined {
  if (snapshot.lifecycle === "stopped") return "stopped";
  if (snapshot.lifecycle === "host_lost") return "host_lost";
  if (snapshot.lifecycle === "runtime_error") return "runtime_error";
  if (snapshot.execution === "failed") return "execution_failed";
  if (snapshot.execution === "unavailable") return "execution_unavailable";
  if (snapshot.execution === "idle") return "idle";
  return undefined;
}

function boundedObservationActivity(
  historyRevision: number,
  allRecords: ConversationRecordDto[],
  allEvents: DockEvent[],
): { historyRevision: number; records: ConversationRecordDto[]; liveEvents: DockEvent[] } {
  const records = allRecords.slice(-24);
  const liveEvents = allEvents.slice(-40);
  while (records.length > 0 || liveEvents.length > 0) {
    const candidate = { historyRevision, records, liveEvents };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_OBSERVATION_ACTIVITY_BYTES) return candidate;
    if (records.length > 0 && (liveEvents.length === 0 || records.length >= liveEvents.length)) records.shift();
    else liveEvents.shift();
  }
  return { historyRevision, records: [], liveEvents: [] };
}

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${lexical}`);
  return realpath(lexical);
}
