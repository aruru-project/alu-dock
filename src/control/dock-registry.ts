import { randomUUID } from "node:crypto";
import type { SystemService } from "./system-service.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type CatalogCommitPort,
  type CatalogInstanceRecord,
  type CatalogStore,
  validateInstanceKey,
} from "../core/catalog.js";
import type { ObservationDeliverySink } from "../core/instance-observation.js";
import {
  type DockChildSelection,
  type DockChildStart,
  type DockToolsHostPort,
  type DockToolsMutationPort,
  type DockToolsRequest,
  type DockToolsResult,
  type LocalDockToolsHostPort,
} from "../core/dock-tools.js";
import type { InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import { isNativeAbsoluteLocalPath } from "../core/local-path.js";
import type { JsonObject } from "../core/json-value.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import { InstanceBusyError, InstanceNotActiveError, type InstanceLifecycle, type ManagedInstance, type InstanceSnapshot, type StopReceipt } from "../core/managed-instance.js";
import { CatalogTransactionCoordinator, type CatalogFault, type CatalogHealth } from "./catalog-transactions.js";
import { InstanceObservationService, observationStatus } from "./instance-observation-service.js";
import { boundedInstanceListPage } from "./instance-list-page.js";
import { ProtocolValidationError } from "./protocol.js";
import { assertChildMayRequest, childCreationOperation, sendDockMessage, spawnDockWorker } from "./native-collaboration.js";
import { WorkMessages } from "./work-messages.js";
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
  /** Not persisted: a child Work is never reopened. */
  child?: DockChildStart;
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
  /** Opened as the personal assistant (card #295); fixed at creation and kept for reopen. */
  assistant?: true;
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  child?: DockChildSelection;
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
  workerConfig?: JsonObject;
  /** Omitted: the directory's saved default decides. A child Work is never the assistant. */
  assistant?: boolean;
}

export interface EnsureRegistryInstanceInput extends Omit<CreateRegistryInstanceInput, "workerConfig" | "child" | "assistant"> {
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

export class DockRegistry implements LocalDockToolsHostPort {
  readonly hostEpoch: string;
  readonly startedAt: string;
  readonly systemService: SystemService | undefined;
  private readonly instances = new Map<string, ManagedInstance>();
  /** Per parent runtime: a parent continued after a crash retires its own new children. */
  private readonly childRetirements = new WeakMap<ManagedInstance, Promise<void>>();
  /** Children whose Worker is still starting, per parent runtime. */
  private readonly childStarts = new WeakMap<ManagedInstance, Set<Promise<unknown>>>();
  private readonly catalog: CatalogTransactionCoordinator;
  private readonly catalogStore: CatalogStore | undefined;
  private readonly reopenInFlight = new Map<string, string>();
  private readonly sessionFileClaims = new Map<string, { ownerId: string; operationId: string }>();
  private readonly keyEnsureTails = new Map<string, Promise<void>>();
  private catalogMaintenancePending = false;
  private readonly runtimeReopenListeners = new Set<(instanceId: string) => void>();
  private readonly catalogRemovalListeners = new Set<(instanceIds: readonly string[]) => void>();
  private readonly observationService: InstanceObservationService;
  private readonly workMessages: WorkMessages;
  private readonly attachmentHostPort: InstanceAttachmentHostPort;
  private readonly dockToolsHostPort: DockToolsHostPort;
  private dockToolsMutationPort: DockToolsMutationPort | undefined;
  private readonly instanceObservationSubscriptions = new Map<string, () => void>();
  private readonly instanceObservationSinkDetachments = new Map<string, () => void>();
  private catalogReady: boolean;
  private lastReconciledAtValue: string;
  private startupNormalizedCountValue = 0;
  /** Only Main supplies her workspace. Clients cannot create another assistant. */
  private readonly assistantWorkspace: string | undefined;
  private assistantRecoveryEnabled = false;
  private assistantRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private assistantRecovery: Promise<void> | undefined;
  private assistantRecoveryDelay = 1_000;

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
      /** Main owns one resident assistant here; SubHosts omit it. */
      assistantWorkspace?: string;
    } = {},
  ) {
    this.assistantWorkspace = options.assistantWorkspace;
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
      readLiveConversation: async (instanceId) => {
        const instance = this.instances.get(instanceId);
        if (!instance) return undefined;
        const projection = await instance.getAttachProjection(undefined, 1, "conversation_bootstrap");
        return { instance: projection.instance, liveEvents: projection.page.events };
      },
      readConversationHistory: async (instanceId, cursor, limit) => {
        const instance = this.instances.get(instanceId);
        return instance === undefined ? undefined : instance.getConversationHistory(cursor, limit, "references");
      },
      readConversationContent: (instanceId, contentRef, cursor) => this.get(instanceId).getConversationContent(contentRef, cursor, "references"),
      subscribe: (instanceId, listener) => {
        const instance = this.instances.get(instanceId);
        if (!instance) return undefined;
        return instance.subscribe(() => {
          try { listener(instance.snapshot()); } catch { /* A later read or lifecycle cleanup owns the failure. */ }
        });
      },
      sourceAuthorized: (instanceId) => this.dockToolsEnabled(instanceId),
    });
    this.workMessages = new WorkMessages({
      live: () => this.instances.values(),
      get: (instanceId) => this.instances.get(instanceId),
      now: () => new Date().toISOString(),
    });
  }

  private readonly trustPreflight: CreateTrustPreflight | undefined;
  private readonly reopenTargetResolver: ReopenTargetResolver | undefined;

  async initializeCatalog(): Promise<void> {
    if (!this.catalogStore) return;
    if (this.catalogReady) throw new Error("Durable catalog is already initialized");
    const loaded = await this.catalogStore.load();
    // Choose from the last saved activity, before startup normalizes timestamps. Main keeps the
    // most recently used assistant; other old assistant Works reopen as ordinary Pi Works.
    const selected = this.assistantWorkspace === undefined ? undefined : loaded?.instances
      .filter((record) => record.assistant && record.parentId === undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]?.id;
    const reconciled = reconcileCatalogProjection(loaded, this.hostEpoch, new Date(this.startedAt));
    for (const record of reconciled.projection.instances) {
      if (record.id !== selected) delete record.assistant;
      else record.cwd = resolve(this.assistantWorkspace!);
    }
    await this.catalogStore.commit(reconciled.projection, {
      kind: "host.startup_reconcile",
      effect: "pre_effect",
    });
    this.catalog.initialize(reconciled.projection);
    this.startupNormalizedCountValue = reconciled.normalizedCount;
    this.lastReconciledAtValue = this.startedAt;
    this.catalogReady = true;
  }

  create(input: CreateRegistryInstanceInput): Promise<ManagedInstance> {
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
    if (input.assistant === true) throw new ProtocolValidationError("invalid_request", "常驻助手只有一个，由 Main 自动打开。请从工作列表打开助手，或去掉助手选择来创建普通 Work。");
    this.assertCatalogReady();
    this.catalog.assertWritable();
    if (this.catalog.current().instances.some((record) => record.creationOperationId === input.operationId)) {
      throw new CatalogOperationRecordedError(input.operationId);
    }
    const parent = input.child === undefined ? undefined : this.get(input.child.parentId);
    const parentActive = () => parent === undefined || (this.instances.get(parent.id) === parent
      && parent.parentId === undefined && parent.lifecycle === "active");
    if (!parentActive()) throw new Error("A child Work needs an active top-level Work on this machine as its parent.");
    if (parent === undefined) return this.startNew(input, key, undefined, parentActive);
    // A parent that starts stopping from here on waits for this child, which then stops itself.
    const starting = this.childStarts.get(parent) ?? new Set<Promise<unknown>>();
    this.childStarts.set(parent, starting);
    const creation = this.startNew(input, key, parent, parentActive);
    starting.add(creation);
    try {
      return await creation;
    } finally {
      starting.delete(creation);
    }
  }

  private async startNew(
    input: CreateRegistryInstanceInput,
    key: string | undefined,
    parent: ManagedInstance | undefined,
    parentActive: () => boolean,
    assistant = false,
  ): Promise<ManagedInstance> {
    // Her own workspace loads no project resources, so opening her does not grant project trust.
    const resolution = assistant
      ? { canonicalCwd: await canonicalDirectory(input.cwd), projectTrusted: false }
      : await this.resolveCreationTrust(input, parent);
    const cwd = resolution.canonicalCwd;
    const resolvedConfig = !assistant && this.systemService
      ? (await this.systemService.resolveCreation(cwd, input.workerConfig)).workerConfig
      : input.workerConfig;
    const workerConfig = resolvedConfig === undefined
      ? undefined
      : cloneWorkerConfig(resolvedConfig, "Worker configuration");
    // The parent's Worker owns its conversation and writes the copy for the child's directory.
    const sessionFile = input.child?.withParentContext ? await parent!.branchConversationForChild(cwd) : undefined;

    const id = this.createId();
    if (this.instances.has(id) || this.catalog.current().instances.some((record) => record.id === id)) {
      throw new Error(`Generated duplicate instance identity: ${id}`);
    }
    const instance = await this.factory({ id, creationOperationId: input.operationId, hostEpoch: this.hostEpoch, cwd, key, name: input.name, projectTrusted: resolution.projectTrusted, dockToolsHostPort: this.dockToolsHostPort, attachmentHostPort: this.attachmentHostPort, dockToolsEnabled: true, ...(input.child === undefined ? {} : { child: { parentId: input.child.parentId, ...(input.child.allowedTools === undefined ? {} : { allowedTools: input.child.allowedTools }) } }), ...(sessionFile === undefined ? {} : { sessionFile }), ...(workerConfig === undefined ? {} : { workerConfig }), ...(assistant ? { assistant: true as const } : {}) });
    if (
      instance.id !== id
      || instance.creationOperationId !== input.operationId
      || instance.hostEpoch !== this.hostEpoch
      || instance.key !== key
    ) {
      await instance.disposeUnpublished().catch(() => {});
      throw new Error("Instance factory returned an identity outside the registry Host domain");
    }
    this.bindInstanceCatalog(instance);
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
    if (input.child !== undefined) this.workMessages.childStarted(id);
    if (!parentActive()) {
      // The parent stopped while this child was starting; it leaves with its parent.
      await this.stop(id, randomUUID()).catch(() => {});
      throw new Error("The parent Work stopped before its child could start.");
    }
    return instance;
  }

  /** A child in its parent's directory runs under the parent's current decision, including trust_once, without asking again. */
  private async resolveCreationTrust(input: CreateRegistryInstanceInput, parent: ManagedInstance | undefined): Promise<ProjectTrustResolution> {
    const inherited = parent?.projectTrust();
    if (inherited && input.trustChallengeId === undefined && input.projectTrustDecision === undefined
      && await canonicalDirectory(input.cwd) === inherited.canonicalCwd) return inherited;
    return this.resolveProjectTrust({
      operationType: "instance.create",
      operationId: input.operationId,
      cwd: input.cwd,
      name: input.name,
      trustChallengeId: input.trustChallengeId,
      projectTrustDecision: input.projectTrustDecision,
    });
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
      dockToolsEnabled: true,
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
    if (record.parentId !== undefined || (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error")) throw new InstanceNotReopenableError(input.instanceId);
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
    const trust = record.assistant && this.assistantWorkspace !== undefined
      ? { canonicalCwd: await canonicalDirectory(this.assistantWorkspace), projectTrusted: false }
      : await this.resolveProjectTrust({
        operationType: "instance.reopen", operationId: input.operationId, cwd: target.cwd, name: sessionFile,
        trustChallengeId: input.trustChallengeId, projectTrustDecision: input.projectTrustDecision,
      });
    return { instance: await this.openRecord(input.operationId, record, trust, sessionFile, previousLifecycle), previousLifecycle };
  }

  private async openRecord(
    operationId: string, record: CatalogInstanceRecord, trust: ProjectTrustResolution,
    sessionFile?: string, previousLifecycle?: "host_lost" | "runtime_error",
  ): Promise<ManagedInstance> {
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
      ...(previousLifecycle === undefined || sessionFile === undefined ? {} : { reopenedFrom: previousLifecycle }),
      dockToolsHostPort: this.dockToolsHostPort,
      attachmentHostPort: this.attachmentHostPort,
      dockToolsEnabled: record.dockToolsEnabled ?? true,
      ...(record.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(record.workerConfig, "Catalog Worker configuration") }),
      ...(record.assistant ? { assistant: true as const } : {}),
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
    this.bindInstanceCatalog(candidate);
    try {
      await this.catalog.forInstance(record.id).commit(candidate.catalogRecord(), {
        kind: "instance.reopen",
        effect: "rollback_contained",
        operationId,
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
    return candidate;
  }

  /** Stop retires ordinary Works; her stopped record remains, so reopening keeps her identity. */
  private bindInstanceCatalog(instance: ManagedInstance): void {
    const port = this.catalog.forInstance(instance.id);
    instance.bindCatalogPort(instance.snapshot().assistant && this.assistantWorkspace !== undefined
      ? { ...port, retire: (context) => port.commit(instance.catalogRecord(), context) }
      : port);
  }

  /** Called by a running Host, not by a client or an Agent. No model is called just to keep her open. */
  startAssistant(): void {
    if (this.assistantWorkspace === undefined) return;
    this.assistantRecoveryEnabled = true;
    this.scheduleAssistantRecovery(0);
  }

  /** Shutdown cancels her restart timer before waiting for admitted operations and stopping Workers. */
  async stopAssistantRecovery(): Promise<void> {
    this.assistantRecoveryEnabled = false;
    clearTimeout(this.assistantRecoveryTimer);
    this.assistantRecoveryTimer = undefined;
    await this.assistantRecovery?.catch(() => {});
  }

  private scheduleAssistantRecovery(delayMs: number): void {
    if (!this.assistantRecoveryEnabled || this.assistantRecoveryTimer !== undefined) return;
    this.assistantRecoveryTimer = setTimeout(() => {
      this.assistantRecoveryTimer = undefined;
      void this.recoverAssistant().catch(() => {});
    }, delayMs);
    this.assistantRecoveryTimer.unref();
  }

  private recoverAssistant(): Promise<void> {
    if (this.assistantRecovery) return this.assistantRecovery;
    if (!this.assistantRecoveryEnabled) return Promise.resolve();
    clearTimeout(this.assistantRecoveryTimer);
    this.assistantRecoveryTimer = undefined;
    const task = this.ensureAssistant().then(() => { this.assistantRecoveryDelay = 1_000; }, (error: unknown) => {
      // A failing Worker must not spin at full speed or keep the rest of Dock from starting.
      process.stderr.write(`Alu Dock: 常驻助手暂时没能重新打开，稍后会再试；其他 Work 不受影响。${error instanceof Error ? error.message : String(error)}\n`);
      this.scheduleAssistantRecovery(this.assistantRecoveryDelay);
      this.assistantRecoveryDelay = Math.min(this.assistantRecoveryDelay * 2, 30_000);
      throw error;
    }).finally(() => { if (this.assistantRecovery === task) this.assistantRecovery = undefined; });
    this.assistantRecovery = task;
    return task;
  }

  private async ensureAssistant(): Promise<void> {
    this.assertCatalogReady();
    this.catalog.assertWritable();
    const workspace = this.assistantWorkspace!;
    await mkdir(workspace, { recursive: true });
    if (!this.assistantRecoveryEnabled) return;
    const record = this.catalog.current().instances.find((work) => work.assistant);
    if (!record) {
      await this.startNew({ operationId: randomUUID(), cwd: workspace, name: "助手" }, undefined, undefined, () => true, true);
      return;
    }
    if (record.lifecycle === "active") return;
    if (record.lifecycle === "stopping" || this.reopenInFlight.has(record.id)) {
      this.scheduleAssistantRecovery(1_000);
      return;
    }
    // Do not risk a second owner when the old process tree could not be stopped.
    if (record.ownerReleaseUnconfirmed) throw new InstanceNotReopenableError(record.id);
    const previous = this.instances.get(record.id);
    if (previous) await this.childRetirements.get(previous);
    const operationId = randomUUID();
    const sessionFile = record.lifecycle === "stopped" ? record.sessionFile : catalogReopenSessionFile(record);
    const release = sessionFile === undefined ? () => {} : this.claimSessionFile(record.id, operationId, sessionFile);
    this.reopenInFlight.set(record.id, operationId);
    try {
      if (sessionFile !== undefined) {
        if (!this.reopenTargetResolver) throw new InstanceNotReopenableError(record.id);
        await this.reopenTargetResolver.resolve(sessionFile);
      }
      if (!this.assistantRecoveryEnabled) return;
      await this.openRecord(operationId, record, { canonicalCwd: await canonicalDirectory(workspace), projectTrusted: false }, sessionFile,
        record.lifecycle === "host_lost" || record.lifecycle === "runtime_error" ? record.lifecycle : undefined);
    } finally {
      release();
      this.reopenInFlight.delete(record.id);
    }
  }

  bindDockToolsMutationPort(port: DockToolsMutationPort): void {
    // Tests and preflight probes may construct a losing Host around the same
    // Registry. The first Host owns the application boundary; a later socket
    // contender must not replace it before admission decides which Host runs.
    this.dockToolsMutationPort ??= port;
  }

  dockToolsEnabled(sourceInstanceId: string): boolean {
    this.assertCatalogReady();
    return this.catalogRecord(sourceInstanceId).dockToolsEnabled ?? true;
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

  /** What passes between a Work and its own child Works: they all run here, so this Host answers it without Main. */
  answersLocally(sourceInstanceId: string, request: DockToolsRequest): boolean {
    let source: InstanceSnapshot;
    try { source = this.getSnapshot(sourceInstanceId); } catch { return false; }
    if (source.parentId !== undefined) return this.instances.has(sourceInstanceId);
    if (request.type !== "send" && request.type !== "interrupt" && request.type !== "stop") return false;
    return request.target !== undefined && this.workMessages.ownChild(source, request.target) !== undefined;
  }

  noteSpawnedChild(sourceInstanceId: string, spawnOperationId: string, result: DockToolsResult): void {
    if (result.type !== "spawn") return;
    const creation = childCreationOperation(spawnOperationId);
    const child = [...this.instances.values()].find((instance) => instance.parentId === sourceInstanceId && instance.creationOperationId === creation);
    if (child) this.workMessages.rememberMainIdentity(child.id, { child: result.instance.id, ...(result.instance.parentId === undefined ? {} : { parent: result.instance.parentId }) });
  }

  async invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    this.assertDockToolsSource(sourceInstanceId);
    const source = this.getSnapshot(sourceInstanceId);
    assertChildMayRequest(source, request);
    if (request.type === "unreported_stop") return this.workMessages.unreportedStop(source, request);
    const child = request.type === "send" || request.type === "interrupt" || request.type === "stop" ? this.ownChild(source, request.target) : undefined;
    if (request.type === "send" && (source.parentId !== undefined || child !== undefined)) return this.workMessages.send(source, request, child);
    if (request.type === "list" || request.type === "inspect" || request.type === "watch" || request.type === "cancel") {
      return this.observationService.observe(sourceInstanceId, request);
    }
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
    // The list belongs to this Host's machine, where the source's child Works run.
    if (request.type === "models") return { type: "models", ...await mutations.childModels() };
    if (request.type === "spawn") return spawnDockWorker(source, request, { create: (input) => mutations.create(input), send: (input) => mutations.send(input) });
    if (request.type === "interrupt" || request.type === "stop") {
      if (child) {
        // The parent takes back the work it handed out, so nothing is owed for it any more.
        this.workMessages.release(child.id, request.type === "interrupt");
        await mutations[request.type](child.id, request.operationId);
        return { type: request.type, instance: this.workMessages.forParent(child.snapshot()) };
      }
      const target = this.observationService.resolveTarget(sourceInstanceId, request.target);
      return { type: request.type, instance: await mutations[request.type](target.id, request.operationId) };
    }
    if (request.type !== "send") throw new Error("Unknown Dock tool request");
    return sendDockMessage(source, request, {
      send: (input) => mutations.send(input),
      resolveTarget: (target) => this.observationService.resolveTarget(sourceInstanceId, target),
    });
  }

  private ownChild(source: InstanceSnapshot, target: string | undefined): ManagedInstance | undefined {
    if (target === undefined) return undefined;
    const child = this.workMessages.ownChild(source, target);
    if (child === "ambiguous") throw new Error(`More than one of your child Works matches ${target}; use its id from dock_list.`);
    return child;
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
    // Through the Host's Dock tools port: a SubHost Work's watches live on Main.
    const detachSink = this.dockToolsHostPort.attachObservationSink(instance.id, (notification) => instance.deliverObservation(notification));
    this.instanceObservationSinkDetachments.set(instance.id, detachSink);
    this.instanceObservationSubscriptions.set(instance.id, instance.subscribe(() => {
      if (this.instances.get(instance.id) !== instance) return;
      const snapshot = instance.snapshot();
      // Children leave with their parent however it stops. The owning Host observes
      // the real runtime lifecycle, never Main's offline projection.
      if (snapshot.lifecycle === "stopping" || snapshot.lifecycle === "runtime_error") void this.retireChildren(instance);
      if (snapshot.assistant && (snapshot.lifecycle === "runtime_error" || snapshot.lifecycle === "stopped")) this.scheduleAssistantRecovery(1_000);
      if (instance.parentId !== undefined && (snapshot.lifecycle === "stopping" || snapshot.lifecycle === "stopped" || snapshot.lifecycle === "runtime_error")) {
        this.workMessages.childLeaving(instance);
      }
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
    this.workMessages.forget(instanceIds);
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
    // A crashed top-level Work offers Continue or Remove; only a crashed child is collected by Stop.
    if (instance.parentId === undefined && instance.lifecycle === "runtime_error") throw new InstanceNotActiveError(instanceId, "runtime_error");
    try {
      const receipt = await instance.stop(operationId);
      const snapshot = instance.snapshot();
      if (snapshot.assistant && this.assistantWorkspace !== undefined) {
        await this.childRetirements.get(instance);
        // Return the old Work's truthful stopped receipt. The same ID is already open again when
        // the client refreshes after this operation; Protocol V2 stop keeps its original contract.
        try { await this.recoverAssistant(); }
        catch {
          receipt.cleanupErrors = [...(receipt.cleanupErrors ?? []), "回复已停止，助手暂时没能重新打开，Host 会继续重试。请刷新状态查看；对话和记忆都还在。"];
        }
      } else if (this.instances.get(instanceId) === instance) {
        this.instances.delete(instanceId);
        this.notifyCatalogRemoval([instanceId]);
        void this.cleanupObservationForForgottenTargets([instanceId]).catch(() => {
          // Post-retirement in-memory cleanup cannot roll back the stopped receipt.
        });
      }
      return { receipt, instance: snapshot };
    } finally {
      // The lifecycle subscription started this when the parent began stopping.
      await this.childRetirements.get(instance);
    }
  }

  /** Never rejects: a child whose cleanup fails stays listed, and Stop can be retried on it. */
  private retireChildren(parent: ManagedInstance): Promise<void> {
    const pending = this.childRetirements.get(parent);
    if (pending) return pending;
    const children = [...this.instances.values()].filter((child) => child.parentId === parent.id);
    // A child still starting stops itself once it sees this parent gone; wait for that too,
    // so no child process outlives its parent's Stop.
    const starting = [...(this.childStarts.get(parent) ?? [])];
    const task = Promise.allSettled([...children.map((child) => this.stop(child.id, randomUUID())), ...starting]).then(() => {
      if (this.childRetirements.get(parent) === task) this.childRetirements.delete(parent);
    });
    this.childRetirements.set(parent, task);
    return task;
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
        if (record.assistant) throw new ProtocolValidationError("invalid_request", "常驻助手不能从工作列表移除。要打断回复请用中止，要重新打开请用重启。");
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
      }, (record) => record.lifecycle === "stopped" && !record.assistant, limit);
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
    await this.stopAssistantRecovery();
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
