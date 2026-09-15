import { randomUUID } from "node:crypto";
import type { SystemService } from "./system-service.js";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type CatalogCommitPort,
  type CatalogInstanceRecord,
  type CatalogStore,
  validateInstanceKey,
} from "../core/catalog.js";
import type { ObservationDeliverySink } from "../core/instance-observation.js";
import {
  dockMessageText,
  type DockToolsHostPort,
  type DockToolsMutationPort,
  type DockToolsRequest,
  type DockToolsResult,
} from "../core/dock-tools.js";
import type { InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import { isNativeAbsoluteLocalPath } from "../core/local-path.js";
import type { JsonObject } from "../core/json-value.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import { InstanceBusyError, type InstanceLifecycle, type ManagedInstance, type InstanceSnapshot, type StopReceipt } from "../core/managed-instance.js";
import { CatalogTransactionCoordinator, type CatalogFault, type CatalogHealth } from "./catalog-transactions.js";
import { InstanceObservationService, observationStatus } from "./instance-observation-service.js";
import { boundedInstanceListPage } from "./instance-list-page.js";
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
  dockToolsHostPort: DockToolsHostPort;
  attachmentHostPort: InstanceAttachmentHostPort;
  dockToolsEnabled: boolean;
  /** Adapter-owned creation input; the Registry only validates, persists, and relays it. */
  workerConfig?: JsonObject;
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
  workerConfig?: JsonObject;
}

export interface EnsureRegistryInstanceInput extends Omit<CreateRegistryInstanceInput, "workerConfig"> {
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

export class DockRegistry implements DockToolsHostPort {
  readonly hostEpoch: string;
  readonly startedAt: string;
  readonly systemService: SystemService | undefined;
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly catalog: CatalogTransactionCoordinator;
  private readonly catalogStore: CatalogStore | undefined;
  private readonly reopenInFlight = new Map<string, string>();
  private readonly sessionFileClaims = new Map<string, { ownerId: string; operationId: string }>();
  private readonly keyEnsureTails = new Map<string, Promise<void>>();
  private catalogMaintenancePending = false;
  private readonly runtimeReopenListeners = new Set<(instanceId: string) => void>();
  private readonly catalogRemovalListeners = new Set<(instanceIds: readonly string[]) => void>();
  private readonly observationService: InstanceObservationService;
  private readonly attachmentHostPort: InstanceAttachmentHostPort;
  private readonly dockToolsHostPort: DockToolsHostPort;
  private dockToolsMutationPort: DockToolsMutationPort | undefined;
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
      systemService?: SystemService;
      catalogCommitPort?: CatalogCommitPort;
      catalogStore?: CatalogStore;
      reopenTargetResolver?: ReopenTargetResolver;
      attachmentHostPort?: InstanceAttachmentHostPort;
      dockToolsHostPort?: DockToolsHostPort;
    } = {},
  ) {
    if (options.catalogCommitPort && options.catalogStore) throw new Error("Configure either catalogCommitPort or catalogStore, not both");
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.lastReconciledAtValue = this.startedAt;
    this.trustPreflight = options.trustPreflight;
    this.systemService = options.systemService;
    this.reopenTargetResolver = options.reopenTargetResolver;
    this.catalogStore = options.catalogStore;
    this.catalogReady = options.catalogStore === undefined;
    this.catalog = new CatalogTransactionCoordinator(options.catalogStore ?? options.catalogCommitPort, this.hostEpoch);
    this.attachmentHostPort = options.attachmentHostPort ?? unavailableAttachmentHostPort;
    this.dockToolsHostPort = options.dockToolsHostPort ?? this;
    this.observationService = new InstanceObservationService({
      listSnapshots: () => this.list(),
      getSnapshot: (instanceId) => this.getSnapshot(instanceId),
      readConversationBootstrap: async (instanceId, historyLimit) => {
        const instance = this.instances.get(instanceId);
        if (!instance) return undefined;
        const projection = await instance.getAttachProjection(undefined, historyLimit, "conversation_bootstrap");
        return {
          instance: projection.instance,
          recentHistory: projection.recentHistory,
          historyRevision: projection.historyRevision,
          historyTruncated: projection.historyTruncated,
          liveEvents: projection.page.events,
        };
      },
      readHistoryPage: async (instanceId, beforeEntryId, limit) => {
        const instance = this.instances.get(instanceId);
        return instance === undefined ? undefined : instance.getHistoryPage(beforeEntryId, limit);
      },
      subscribe: (instanceId, listener) => {
        const instance = this.instances.get(instanceId);
        if (!instance) return undefined;
        return instance.subscribe(() => {
          try { listener(instance.snapshot()); } catch { /* A later read or lifecycle cleanup owns the failure. */ }
        });
      },
      sourceAuthorized: (instanceId) => this.dockToolsEnabled(instanceId),
    });
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
    const resolvedConfig = this.systemService
      ? await this.systemService.resolveWorkerConfig(cwd, input.workerConfig)
      : input.workerConfig;
    const workerConfig = resolvedConfig === undefined
      ? undefined
      : cloneWorkerConfig(resolvedConfig, "Worker configuration");

    const id = this.createId();
    if (this.instances.has(id) || this.catalog.current().instances.some((record) => record.id === id)) {
      throw new Error(`Generated duplicate instance identity: ${id}`);
    }
    const instance = await this.factory({ id, creationOperationId: input.operationId, hostEpoch: this.hostEpoch, cwd, key, name: input.name, projectTrusted: resolution.projectTrusted, dockToolsHostPort: this.dockToolsHostPort, attachmentHostPort: this.attachmentHostPort, dockToolsEnabled: false, ...(workerConfig === undefined ? {} : { workerConfig }) });
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
    if (!isNativeAbsoluteLocalPath(input.sessionFile)) throw new Error("Pi session file is not an absolute path on this Host");
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
      dockToolsHostPort: this.dockToolsHostPort,
      attachmentHostPort: this.attachmentHostPort,
      dockToolsEnabled: false,
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
    if (!isNativeAbsoluteLocalPath(rawSessionFile)) throw new Error("Pi session file is not an absolute path on this Host");
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
      dockToolsHostPort: this.dockToolsHostPort,
      attachmentHostPort: this.attachmentHostPort,
      dockToolsEnabled: record.dockToolsEnabled ?? false,
      ...(record.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(record.workerConfig, "Catalog Worker configuration") }),
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

  bindDockToolsMutationPort(port: DockToolsMutationPort): void {
    // Tests and preflight probes may construct a losing Host around the same
    // Registry. The first Host owns the application boundary; a later socket
    // contender must not replace it before admission decides which Host runs.
    this.dockToolsMutationPort ??= port;
  }

  dockToolsEnabled(sourceInstanceId: string): boolean {
    this.assertCatalogReady();
    return this.catalogRecord(sourceInstanceId).dockToolsEnabled ?? false;
  }

  async configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }> {
    this.assertCatalogReady();
    const instance = this.get(sourceInstanceId);
    await this.observationService.configureSource(sourceInstanceId, enabled, () => instance.setDockToolsEnabled(enabled, operationId));
    return { enabled: instance.dockToolsEnabled() };
  }

  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void {
    return this.observationService.attachSink(sourceInstanceId, sink);
  }

  async invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    if (request.type === "list" || request.type === "inspect" || request.type === "watch" || request.type === "cancel") {
      return this.observationService.observe(sourceInstanceId, request);
    }
    this.assertDockToolsSource(sourceInstanceId);
    if (request.type === "machines") throw new Error("Machine discovery requires this work to be connected to Main.");
    if (request.type === "deliver") {
      return { type: "deliver", deliverable: await this.get(sourceInstanceId).registerDeliverable(request.path) };
    }
    const mutations = this.dockToolsMutationPort;
    if (!mutations) throw new Error("Dock tools are not connected to the Host mutation service");
    if (request.type === "create" || request.type === "system") {
      if (request.machine !== undefined) throw new Error("Machine selection requires a connection to Main. No local fallback was used.");
      return request.type === "create" ? mutations.create(request) : mutations.system(request);
    }
    const source = this.getSnapshot(sourceInstanceId);
    const target = this.observationService.resolveTarget(sourceInstanceId, request.target);
    const result = await mutations.send({
      operationId: request.operationId,
      instanceId: target.id,
      message: dockMessageText(source.displayName, request.message),
    });
    return { type: "send", target: result.target, receipt: result.receipt };
  }

  observationStatus(instanceId: string) {
    return observationStatus(this.getSnapshot(instanceId));
  }

  private assertDockToolsSource(sourceInstanceId: string): void {
    if (!this.dockToolsEnabled(sourceInstanceId)) throw new Error("Dock tools are off for this instance. Use /dock-tools on first.");
    if (this.getSnapshot(sourceInstanceId).lifecycle !== "active") throw new Error("Dock tools require an active source instance");
  }

  private trackInstanceForObservation(instance: ManagedInstance): void {
    this.instanceObservationSubscriptions.get(instance.id)?.();
    this.instanceObservationSinkDetachments.get(instance.id)?.();
    const detachSink = this.attachObservationSink(instance.id, (notification) => instance.deliverObservation(notification));
    this.instanceObservationSinkDetachments.set(instance.id, detachSink);
    this.instanceObservationSubscriptions.set(instance.id, instance.subscribe(() => {
      const snapshot = instance.snapshot();
      if (snapshot.lifecycle === "stopping" || snapshot.lifecycle === "stopped") void this.observationService.cancelSource(instance.id);
      if (snapshot.lifecycle === "stopped" || snapshot.lifecycle === "host_lost" || snapshot.lifecycle === "runtime_error") {
        detachSink();
        if (this.instanceObservationSinkDetachments.get(instance.id) === detachSink) this.instanceObservationSinkDetachments.delete(instance.id);
      }
    }));
  }

  private async cleanupObservationForForgottenTargets(instanceIds: readonly string[]): Promise<void> {
    for (const id of instanceIds) {
      this.instanceObservationSubscriptions.get(id)?.();
      this.instanceObservationSubscriptions.delete(id);
      this.instanceObservationSinkDetachments.get(id)?.();
      this.instanceObservationSinkDetachments.delete(id);
    }
    await this.observationService.forgetInstances(instanceIds);
  }

  get(instanceId: string): ManagedInstance {
    this.assertCatalogReady();
    const instance = this.instances.get(instanceId);
    if (instance) return instance;
    const record = this.catalog.current().instances.find((item) => item.id === instanceId);
    if (record) throw new InstanceUnavailableError(instanceId, record.lifecycle);
    throw new InstanceNotFoundError(instanceId);
  }

  async stop(instanceId: string, operationId: string): Promise<{ receipt: StopReceipt; instance: InstanceSnapshot }> {
    const instance = this.get(instanceId);
    const receipt = await instance.stop(operationId);
    const snapshot = instance.snapshot();
    if (this.instances.get(instanceId) === instance) {
      this.instances.delete(instanceId);
      this.notifyCatalogRemoval([instanceId]);
      void this.cleanupObservationForForgottenTargets([instanceId]).catch(() => {
        // Post-retirement in-memory cleanup cannot roll back the stopped receipt.
      });
    }
    return { receipt, instance: snapshot };
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
    return boundedInstanceListPage({
      selected,
      selector: input.selector,
      revision: projection.revision,
      offset,
      limit: input.limit,
      hiddenStopped,
      maxBytes: input.maxBytes,
    });
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
      await this.cleanupObservationForForgottenTargets([instanceId]);
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
      await this.cleanupObservationForForgottenTargets(forgottenIds);
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
    await Promise.allSettled([...this.instances.keys()].map((instanceId) => this.stop(instanceId, randomUUID())));
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

const unavailableAttachmentHostPort: InstanceAttachmentHostPort = {
  accessAttachments: async (_sourceInstanceId, request) => {
    if (request.type === "list") return { type: "list", attachments: [], total: 0, truncated: false };
    throw new Error("Dock attachments require managed Host storage");
  },
};

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${lexical}`);
  return realpath(lexical);
}
