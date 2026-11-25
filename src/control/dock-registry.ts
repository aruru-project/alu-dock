import { randomUUID } from "node:crypto";
import { DEFAULT_ASSISTANT_DISPLAY_NAME } from "../core/assistant.js";
import type { SystemService } from "./system-service.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type CatalogCommitPort,
  type CatalogInstanceRecord,
  type CatalogStore,
  validateInstanceKey,
} from "../core/catalog.js";
import { AgentModelNotFoundError, AgentStartupTimeoutError, AgentUnavailableBeforeEffectError } from "../core/agent-worker.js";
import { ResourceContentError } from "../core/resource-content.js";
import type { ObservationDeliverySink } from "../core/instance-observation.js";
import {
  DOCK_REPORT_TOOL,
  DOCK_SPAWN_TOOL,
  type DockChildSelection,
  type DockChildStart,
  type DockToolsHostPort,
  type DockToolsMutationPort,
  type DockToolsRequest,
  type DockToolsResult,
  type LocalDockToolsHostPort,
  type MainParentRequest,
  type WorkMessage,
} from "../core/dock-tools.js";
import type { InstanceAttachmentHostPort } from "../core/instance-attachments.js";
import { isNativeAbsoluteLocalPath, isPortableAbsoluteLocalPath, MISSING_WORKING_DIRECTORY } from "../core/local-path.js";
import type { JsonObject } from "../core/json-value.js";
import { cloneWorkerConfig } from "../core/worker-config.js";
import { InstanceBusyError, InstanceNotActiveError, type InstanceLifecycle, type ManagedInstance, type InstanceSnapshot, type StopReceipt } from "../core/managed-instance.js";
import { CatalogTransactionCoordinator, type CatalogFault, type CatalogHealth } from "./catalog-transactions.js";
import type { CreateInstanceMutation } from "./instance-manager.js";
import { controlledByOwnChild, InstanceObservationService, observationStatus } from "./instance-observation-service.js";
import { boundedInstanceListPage } from "./instance-list-page.js";
import { ProtocolValidationError } from "./protocol.js";
import { assertChildMayRequest, childCreationOperation, sendDockMessage, spawnDockWorker } from "./native-collaboration.js";
import { inheritedModelSpeed, type ModelSpeedSelection, type ModelSpeedTier } from "../core/model-speed.js";
import type { SettingDto, SettingUpdate } from "../core/config-projection.js";
import { WorkMessages, type WorkMessageRecipient, type WorkParent } from "./work-messages.js";
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
  /** Includes the original role and tool ceiling when continuing an interrupted child. */
  child?: DockChildStart;
  modelSpeed?: ModelSpeedSelection;
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

export interface CreateRegistryInstanceInput extends CreateInstanceMutation {
  modelSpeed?: ModelSpeedSelection;
}

export interface EnsureRegistryInstanceInput extends Omit<CreateRegistryInstanceInput, "workerConfig" | "child" | "assistant" | "createDirectory"> {
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

/**
 * A SubHost's way to the resident assistant on Main (card #676). Main starts child Works here only for
 * her; what they tell her goes through Main.
 */
export interface MainParentPort {
  deliver(parentId: string, message: WorkMessage): Promise<void>;
}

/** Main's child Works on other Machines, whose parent runs here (card #676). */
export interface RemoteChildrenPort {
  /** Their parent is stopping: they stop as well. Never rejects. */
  retire(parentId: string): Promise<void>;
  /** The speed their parent passes down is now `tier`. Never rejects. */
  passSpeed(parentId: string, tier: ModelSpeedTier): Promise<void>;
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
  constructor(readonly instanceId: string, reason = `Instance ${instanceId} has no validated session context to reopen`) {
    super(reason);
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
  /** Active child Works' roles and ceilings, as saved at creation. */
  private readonly childGrants = new WeakMap<ManagedInstance, DockChildStart>();
  /**
   * Works that left the list, stopped or removed, and stay in `instances` only until their own child Works
   * are retired (card #674): a parent no longer finds them by name, a Stop of a Work above still waits.
   */
  private readonly departed = new WeakSet<ManagedInstance>();
  /** On a SubHost: child Works Main started here for its resident assistant (card #676). */
  private readonly mainParented = new WeakSet<ManagedInstance>();
  /** On a SubHost: the speed the resident assistant passes to her child Works here, when not standard. */
  private readonly mainParentSpeeds = new Map<string, ModelSpeedTier>();
  private readonly mainParent: MainParentPort | undefined;
  private readonly remoteChildren: RemoteChildrenPort | undefined;
  private readonly catalog: CatalogTransactionCoordinator;
  private readonly catalogStore: CatalogStore | undefined;
  private readonly stoppingInterrupted = new Set<string>();
  private readonly reopenInFlight = new Map<string, Promise<unknown>>();
  private readonly sessionFileClaims = new Map<string, { ownerId: string; operationId: string }>();
  private readonly keyEnsureTails = new Map<string, Promise<void>>();
  private readonly speedChangeTails = new Map<string, Promise<void>>();
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
  private assistantDisplayName = DEFAULT_ASSISTANT_DISPLAY_NAME;
  private assistantNameRevision = 0;
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
      /** A SubHost's way to the resident assistant, for the child Works Main starts here for her. */
      mainParent?: MainParentPort;
      /** Main's child Works on other Machines, stopped with their parent here. */
      remoteChildren?: RemoteChildrenPort;
    } = {},
  ) {
    this.assistantWorkspace = options.assistantWorkspace;
    this.mainParent = options.mainParent;
    this.remoteChildren = options.remoteChildren;
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
      isResidentAssistant: (instanceId) => this.isResidentAssistant(instanceId),
    });
    this.workMessages = new WorkMessages({
      children: (parentId) => this.catalog.current().instances.filter((record) => record.parentId === parentId).map((record) => this.safeSnapshot(record)),
      parent: (child) => this.workParent(child),
      now: () => new Date().toISOString(),
    });
  }

  /** A child Work's parent while it can take messages: an active Work here, or the resident assistant on Main. */
  private workParent(child: InstanceSnapshot): WorkMessageRecipient | undefined {
    if (child.parentId === undefined) return undefined;
    const local = this.instances.get(child.parentId);
    if (local) return local.snapshot().lifecycle === "active" ? local : undefined;
    const instance = this.instances.get(child.id);
    const port = this.mainParent;
    if (!port || !instance || !this.mainParented.has(instance)) return undefined;
    // Main tells the child Work if she is gone or her Machine is offline.
    const parentId = child.parentId;
    return { id: parentId, deliverWorkMessage: (message) => port.deliver(parentId, message) };
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
    for (const record of reconciled.projection.instances) {
      if (record.mainIdentity) this.workMessages.rememberMainIdentity(record.id, record.mainIdentity);
    }
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
    // Main names a parent this Host does not run only for its resident assistant (card #676).
    if (input.child !== undefined && this.mainParent !== undefined
      && !this.catalog.current().instances.some((record) => record.id === input.child!.parentId)) return this.startForMainParent(input, key);
    const parent = input.child === undefined ? undefined : this.get(input.child.parentId);
    const parentActive = () => parent === undefined || (this.instances.get(parent.id) === parent
      && this.mayStartChildren(parent) && parent.lifecycle === "active");
    if (!parentActive()) throw new Error("A child Work needs an active Work on this machine that may start child Works as its parent.");
    if (parent === undefined) return this.startNew(input, key, undefined, parentActive);
    const child = this.childStart(parent, input.child!);
    // A parent that starts stopping from here on waits for this child, which then stops itself.
    const starting = this.childStarts.get(parent) ?? new Set<Promise<unknown>>();
    this.childStarts.set(parent, starting);
    const creation = this.startNew(input, key, parent, parentActive, { child });
    starting.add(creation);
    try {
      return await creation;
    } finally {
      starting.delete(creation);
    }
  }

  /**
   * Card #674: the Works that do the work themselves count, and they get one level of helpers. A top-level
   * Work may start child Works; so may a lead, the child of a Work that only coordinates.
   */
  private mayStartChildren(instance: ManagedInstance): boolean {
    return instance.parentId === undefined || this.childGrants.get(instance)?.role === "lead";
  }

  /**
   * A child Work of the resident assistant, who does no work herself and runs on Main (card #676). It leads
   * unless she left dock_spawn out of its tools, and starts with only its task.
   */
  private startForMainParent(input: CreateRegistryInstanceInput, key: string | undefined): Promise<ManagedInstance> {
    const { parentId, allowedTools, withParentContext } = input.child!;
    if (withParentContext) throw new Error("A child Work on another Machine than its parent starts with only its task, not a copy of the parent's conversation.");
    const lead = allowedTools === undefined || allowedTools.includes(DOCK_SPAWN_TOOL);
    const child: DockChildStart = { parentId, ...(allowedTools === undefined ? {} : { allowedTools }), role: lead ? "lead" : "helper" };
    return this.startNew(input, key, undefined, () => true, { child, mainParented: true });
  }

  /** The new child's tools stay within its parent's; it may hand work out only below a Work that does none itself. */
  private childStart(parent: ManagedInstance, selection: DockChildSelection): DockChildStart {
    const ceiling = this.childGrants.get(parent)?.allowedTools;
    let allowedTools = selection.allowedTools;
    if (ceiling !== undefined) {
      if (allowedTools === undefined) allowedTools = [...ceiling];
      const extra = allowedTools.filter((name) => !ceiling.includes(name) && name !== DOCK_REPORT_TOOL);
      if (extra.length > 0) throw new Error(`A child Work cannot use tools you were not given: ${extra.join(", ")}.`);
    }
    const lead = !parent.handsOn && (allowedTools === undefined || allowedTools.includes(DOCK_SPAWN_TOOL));
    return { parentId: parent.id, ...(allowedTools === undefined ? {} : { allowedTools }), role: lead ? "lead" : "helper" };
  }

  private async startNew(
    input: CreateRegistryInstanceInput,
    key: string | undefined,
    parent: ManagedInstance | undefined,
    parentActive: () => boolean,
    { assistant = false, child, mainParented = false }: { assistant?: boolean; child?: DockChildStart; mainParented?: boolean } = {},
  ): Promise<ManagedInstance> {
    const created = input.createDirectory === true && await createMissingWorkingDirectory(input.cwd);
    // Her own workspace loads no project resources, so opening her does not grant project trust. A directory
    // created for this Work holds nothing of its own to trust, so the Work starts trusted there (card #674).
    const resolution = assistant
      ? { canonicalCwd: await canonicalDirectory(input.cwd), projectTrusted: false }
      : created ? { canonicalCwd: await canonicalDirectory(input.cwd), projectTrusted: true } : await this.resolveCreationTrust(input, parent);
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
    const instance = await this.factory({ id, creationOperationId: input.operationId, hostEpoch: this.hostEpoch, cwd, key, name: input.name, projectTrusted: resolution.projectTrusted, dockToolsHostPort: this.dockToolsHostPort, attachmentHostPort: this.attachmentHostPort, dockToolsEnabled: true, ...(child === undefined ? {} : { child }), ...(sessionFile === undefined ? {} : { sessionFile }), ...(workerConfig === undefined ? {} : { workerConfig }), ...(assistant ? { assistant: true as const } : {}), ...(input.modelSpeed === undefined ? {} : { modelSpeed: input.modelSpeed }) });
    if (
      instance.id !== id
      || instance.creationOperationId !== input.operationId
      || instance.hostEpoch !== this.hostEpoch
      || instance.key !== key
      || instance.parentId !== child?.parentId
    ) {
      await instance.disposeUnpublished().catch(() => {});
      throw new Error("Instance factory returned an identity outside the registry Host domain");
    }
    this.bindInstanceCatalog(instance);
    try {
      const record = instance.catalogRecord();
      if (child !== undefined) record.childGrant = { role: child.role, allowedTools: child.allowedTools, ...(mainParented ? { mainParent: true } : {}) };
      await this.catalog.create(record, {
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
    if (child !== undefined) this.childGrants.set(instance, child);
    if (mainParented) this.mainParented.add(instance);
    this.trackInstanceForObservation(instance);
    if (child !== undefined) this.workMessages.childStarted(id);
    if (!parentActive()) {
      // The parent stopped while this child was starting; it leaves with its parent.
      await this.stop(id, randomUUID()).catch(() => {});
      throw new Error("The parent Work stopped before its child could start.");
    }
    if (child !== undefined) await this.changeModelSpeed(this.treeRoot(instance), () => this.followSpeedOnStart(instance));
    return instance;
  }

  /** A new or continued child takes its parent's current choice before the first message. */
  private async followSpeedOnStart(child: ManagedInstance): Promise<void> {
    const tier = this.speedFollowed(child);
    if (child.modelSpeed === undefined && tier !== "standard") {
      await child.updateSetting({ key: "modelSpeed", value: null }, randomUUID(), tier);
    }
  }

  /** Change one Work's setting; only Works below it still following it take a group speed change. */
  async updateSetting(instanceId: string, update: SettingUpdate, operationId: string): Promise<SettingDto> {
    const instance = this.get(instanceId);
    if (update.key !== "modelSpeed") return instance.updateSetting(update, operationId);
    return this.changeModelSpeed(this.treeRoot(instance), async () => {
      const current = this.get(instanceId);
      const setting = await current.updateSetting(update, operationId, this.speedFollowed(current));
      // Her child Works on other Machines follow too (card #676); a Machine offline now is told when it reconnects.
      await this.remoteChildren?.passSpeed(current.id, this.speedPassedDown(current));
      await this.passSpeedDown(current);
      return setting;
    });
  }

  /** The speed a Work passes to its child Works, as it passes it now (card #676). */
  passedDownSpeed(instanceId: string): ModelSpeedTier {
    return this.speedPassedDown(this.get(instanceId));
  }

  /**
   * On a SubHost: the speed the resident assistant on Main passes down is now `tier`. Her child Works here
   * that follow it take it, and pass it on as a parent here would (card #676).
   */
  async followMainParentSpeed(parentId: string, tier: ModelSpeedTier): Promise<void> {
    if (tier === "standard") this.mainParentSpeeds.delete(parentId);
    else this.mainParentSpeeds.set(parentId, tier);
    const children = [...this.instances.values()].filter((child) => child.parentId === parentId && this.mainParented.has(child));
    await Promise.allSettled(children.map((child) => this.changeModelSpeed(child.id, async () => {
      if (child.modelSpeed !== undefined || child.lifecycle !== "active") return;
      await child.updateSetting({ key: "modelSpeed", value: null }, randomUUID(), tier);
      await this.passSpeedDown(child);
    })));
  }

  /** A child still following passes the change on to its own children still following it, so all of them take one tier. */
  private async passSpeedDown(above: ManagedInstance): Promise<void> {
    let failure: unknown;
    const tier = this.speedPassedDown(above);
    const following = (work: ManagedInstance) => [...this.instances.values()]
      .filter((child) => child.parentId === work.id && child.modelSpeed === undefined && child.lifecycle === "active");
    for (let next = following(above); next.length > 0;) {
      const level = next;
      next = [];
      for (const child of level) {
        try {
          await child.updateSetting({ key: "modelSpeed", value: null }, randomUUID(), tier);
          next.push(...following(child));
        } catch (error) { if (child.lifecycle === "active") failure ??= error; }
      }
    }
    if (failure) throw failure;
  }

  /** The top of a Work's tree: speed changes in one tree are ordered, other trees are not held up. */
  private treeRoot(instance: ManagedInstance): string {
    let current = instance;
    for (let parent = this.parentOf(current); parent !== undefined; parent = this.parentOf(current)) current = parent;
    return current.id;
  }

  /** The speed a Work's children follow: its own choice for its children, or what it follows itself. */
  private speedPassedDown(instance: ManagedInstance): ModelSpeedTier {
    if (instance.modelSpeed !== undefined) return inheritedModelSpeed(instance.modelSpeed);
    return this.speedFollowed(instance);
  }

  /** The speed a Work without a choice of its own follows: its parent's, here or the resident assistant's on Main. */
  private speedFollowed(instance: ManagedInstance): ModelSpeedTier {
    const parent = this.parentOf(instance);
    if (parent !== undefined) return this.speedPassedDown(parent);
    return instance.parentId !== undefined && this.mainParented.has(instance) ? this.mainParentSpeeds.get(instance.parentId) ?? "standard" : "standard";
  }

  private parentOf(instance: ManagedInstance): ManagedInstance | undefined {
    return instance.parentId === undefined ? undefined : this.instances.get(instance.parentId);
  }

  /** Keep parent/child choices ordered, without locking sessions or unrelated Work trees. */
  private changeModelSpeed<T>(rootId: string, change: () => Promise<T>): Promise<T> {
    const result = (this.speedChangeTails.get(rootId) ?? Promise.resolve()).then(change);
    const tail = result.then(() => {}, () => {});
    this.speedChangeTails.set(rootId, tail);
    void tail.then(() => { if (this.speedChangeTails.get(rootId) === tail) this.speedChangeTails.delete(rootId); });
    return result;
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
    if (this.catalogMaintenancePending || this.reopenInFlight.has(input.instanceId) || this.stoppingInterrupted.has(input.instanceId)) throw new InstanceBusyError(input.instanceId, "reopen");
    return this.trackReopen(input.instanceId, () => this.performReopen(input));
  }

  private async trackReopen<T>(instanceId: string, open: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(open);
    this.reopenInFlight.set(instanceId, pending);
    try { return await pending; }
    finally { if (this.reopenInFlight.get(instanceId) === pending) this.reopenInFlight.delete(instanceId); }
  }

  /** Observation after an admitted reopen reads its committed runtime, not the old
   * unavailable one. Host-only status/list never wait for Worker startup. */
  async getForObservation(instanceId: string): Promise<ManagedInstance> {
    await this.reopenInFlight.get(instanceId);
    return this.get(instanceId);
  }

  private async performReopen(input: ReopenRegistryInstanceInput): Promise<{ instance: ManagedInstance; previousLifecycle: "host_lost" | "runtime_error" }> {
    const record = this.catalogRecord(input.instanceId);
    if (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") throw new InstanceNotReopenableError(input.instanceId);
    if (record.ownerReleaseUnconfirmed) throw new InstanceNotReopenableError(input.instanceId);
    const previousLifecycle = record.lifecycle;
    const savedFile = catalogReopenSessionFile(record);
    const parent = record.parentId === undefined || record.childGrant?.mainParent ? undefined : this.instances.get(record.parentId);
    if (record.parentId !== undefined) {
      if (!savedFile || (input.sessionFile !== undefined && resolve(input.sessionFile) !== savedFile)) {
        throw new InstanceNotReopenableError(record.id, "无法沿原来的会话和工具权限继续这个子 Work。请查看它的状态，或由父 Work 重新分派任务。");
      }
      if (record.childGrant?.mainParent ? !this.mainParent : parent?.lifecycle !== "active") {
        throw new InstanceNotReopenableError(record.id, "父 Work 尚未打开。请先继续原来的父 Work，再继续这个子 Work。");
      }
    }
    const sessionFile = input.sessionFile ?? savedFile;
    if (!sessionFile || !this.reopenTargetResolver) throw new InstanceNotReopenableError(input.instanceId);
    const releaseClaim = this.claimSessionFile(record.id, input.operationId, sessionFile);
    try {
      const opened = await this.performClaimedReopen(input, record, previousLifecycle, sessionFile);
      // A parent's concurrent Stop waits for this reopen, then retires the child.
      if (parent && (this.instances.get(parent.id) !== parent || parent.lifecycle !== "active")) throw new InstanceNotReopenableError(record.id, "子 Work 打开时父 Work 已停止，子 Work 将随它一起收回。");
      return opened;
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
    const target = await this.reopenTargetResolver!.resolve(sessionFile).catch(async (error: unknown) => {
      if (record.parentId === undefined) throw error;
      const message = "无法打开子 Work 原来的会话。请检查它所在机器的会话文件和工作目录，修复后重试。";
      await this.catalog.forInstance(record.id).commit({ ...record, lastError: message, updatedAt: new Date().toISOString() },
        { kind: "instance.reopen.failed", effect: "rollback_contained", operationId: input.operationId, instanceId: record.id });
      throw new InstanceNotReopenableError(record.id, message);
    });
    let trust: ProjectTrustResolution;
    if (record.assistant && this.assistantWorkspace !== undefined) {
      trust = { canonicalCwd: await canonicalDirectory(this.assistantWorkspace), projectTrusted: false };
    } else {
      const canonicalCwd = await canonicalDirectory(target.cwd);
      // Compare to the saved scope verbatim: resolving the old path again could move
      // this Work's permission to a different project after a symlink is retargeted.
      trust = record.projectTrusted !== undefined && canonicalCwd === record.cwd
        && input.trustChallengeId === undefined && input.projectTrustDecision === undefined
        ? { canonicalCwd, projectTrusted: record.projectTrusted }
        : await this.resolveProjectTrust({
          operationType: "instance.reopen", operationId: input.operationId, cwd: canonicalCwd, name: sessionFile,
          trustChallengeId: input.trustChallengeId, projectTrustDecision: input.projectTrustDecision,
        });
    }
    return { instance: await this.openRecord(input.operationId, record, trust, sessionFile, previousLifecycle), previousLifecycle };
  }

  private async openRecord(
    operationId: string, record: CatalogInstanceRecord, trust: ProjectTrustResolution,
    sessionFile?: string, previousLifecycle?: "host_lost" | "runtime_error",
  ): Promise<ManagedInstance> {
    const nextGeneration = record.runtimeGeneration + 1;
    const child = record.parentId !== undefined && record.childGrant !== undefined
      ? { parentId: record.parentId, role: record.childGrant.role, allowedTools: record.childGrant.allowedTools } : undefined;
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
      ...(child === undefined ? {} : { child }),
      createdAt: record.createdAt,
      ...(previousLifecycle === undefined || sessionFile === undefined ? {} : { reopenedFrom: previousLifecycle }),
      dockToolsHostPort: this.dockToolsHostPort,
      attachmentHostPort: this.attachmentHostPort,
      dockToolsEnabled: record.dockToolsEnabled ?? true,
      ...(record.workerConfig === undefined ? {} : { workerConfig: cloneWorkerConfig(record.workerConfig, "Catalog Worker configuration") }),
      ...(record.modelSpeed === undefined ? {} : { modelSpeed: record.modelSpeed }),
      ...(record.assistant ? { assistant: true as const } : {}),
    }).catch(async (error: unknown) => {
      // Only producer-owned diagnoses enter the catalog. Extension errors can
      // contain credentials or configuration; their original stays in local logs.
      const known = error instanceof AgentModelNotFoundError || error instanceof ResourceContentError || error instanceof AgentStartupTimeoutError;
      if (!known) {
        try { process.stderr.write(`Alu Dock: Work ${record.id} failed to reopen: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); }
        catch { /* A closed log sink must not keep the failed startup occupied. */ }
      }
      const message = error instanceof AgentModelNotFoundError
        ? `模型 ${error.provider}/${error.modelId} 现在不可用。请在 Main 上恢复这个模型的配置或登录，再继续这个 Work；原会话保留。`
        : known ? (error as Error).message
          : "Work 没有启动成功。请在 Work 所在机器查看 Dock 日志，检查扩展和配置后继续；原会话保留。";
      const previous = this.instances.get(record.id);
      if (previous) await previous.recordReopenFailure(message, operationId);
      else await this.catalog.forInstance(record.id).commit({ ...record, lastError: message, updatedAt: new Date().toISOString() },
        { kind: "instance.reopen.failed", effect: "rollback_contained", operationId, instanceId: record.id });
      throw known ? error : new AgentUnavailableBeforeEffectError(message);
    });
    if (
      candidate.id !== record.id
      || candidate.creationOperationId !== record.creationOperationId
      || candidate.hostEpoch !== this.hostEpoch
      || candidate.key !== record.key
      || candidate.parentId !== record.parentId
      || (child !== undefined && candidate.snapshot().executor.sessionFile !== sessionFile)
      || candidate.runtimeGeneration !== nextGeneration
      || candidate.snapshot().lifecycle !== "active"
    ) {
      await candidate.disposeUnpublished().catch(() => {});
      throw new Error("Reopen factory returned an identity outside the catalog transaction");
    }
    const previous = this.instances.get(record.id);
    if (child) this.childGrants.set(candidate, child);
    if (record.childGrant?.mainParent) this.mainParented.add(candidate);
    const publish = async () => {
      if (child) await this.followSpeedOnStart(candidate);
      this.bindInstanceCatalog(candidate);
      await this.catalog.forInstance(record.id).commit(candidate.catalogRecord(), {
        kind: "instance.reopen",
        effect: "rollback_contained",
        operationId,
        instanceId: record.id,
      });
      candidate.markCatalogCommitted();
      this.instances.set(record.id, candidate);
    };
    try {
      if (child) await this.changeModelSpeed(this.treeRoot(candidate), publish);
      else await publish();
    } catch (error) {
      await candidate.disposeUnpublished().catch(() => {});
      throw error;
    }
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

  /** A ready memory service can update the label independently of starting the chat Worker. */
  async refreshAssistantDisplayName(readName: () => Promise<string | undefined>): Promise<void> {
    const revision = this.assistantNameRevision;
    const name = await readName();
    if (name !== undefined && revision === this.assistantNameRevision) this.setAssistantDisplayName(name);
  }

  /** Publish Main's saved identity without changing the Work, session title, or conversation. */
  setAssistantDisplayName(name: string): void {
    this.assistantDisplayName = name;
    this.assistantNameRevision++;
    for (const instance of this.instances.values()) instance.setAssistantDisplayName(name);
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
      await this.startNew({ operationId: randomUUID(), cwd: workspace }, undefined, undefined, () => true, { assistant: true });
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
    try {
      await this.trackReopen(record.id, async () => {
        if (sessionFile !== undefined) {
          if (!this.reopenTargetResolver) throw new InstanceNotReopenableError(record.id);
          await this.reopenTargetResolver.resolve(sessionFile);
        }
        if (!this.assistantRecoveryEnabled) return;
        await this.openRecord(operationId, record, { canonicalCwd: await canonicalDirectory(workspace), projectTrusted: false }, sessionFile,
          record.lifecycle === "host_lost" || record.lifecycle === "runtime_error" ? record.lifecycle : undefined);
      });
    } finally { release(); }
  }

  bindDockToolsMutationPort(port: DockToolsMutationPort): void {
    // Tests and preflight probes may construct a losing Host around the same
    // Registry. The first Host owns the application boundary; a later socket
    // contender must not replace it before admission decides which Host runs.
    this.dockToolsMutationPort ??= port;
  }

  /** Main's catalog chooses the one resident; an assistant flag on a Pi Work grants nothing. */
  isResidentAssistant(instanceId: string): boolean {
    if (this.assistantWorkspace === undefined) return false;
    const resident = this.catalog.current().instances.find((record) => record.assistant && record.parentId === undefined);
    if (resident?.id !== instanceId) return false;
    const snapshot = this.instances.get(instanceId)?.snapshot();
    return snapshot?.lifecycle === "active" && snapshot.parentId === undefined && snapshot.executor.kind === "dock-assistant";
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
    if (request.type === "speed" && request.target === undefined) return true;
    if (request.type !== "send" && request.type !== "interrupt" && request.type !== "stop" && request.type !== "speed") return false;
    return request.target !== undefined && this.workMessages.ownChild(source, request.target) !== undefined;
  }

  async noteSpawnedChild(sourceInstanceId: string, spawnOperationId: string, result: DockToolsResult): Promise<void> {
    if (result.type !== "spawn") return;
    const creation = childCreationOperation(spawnOperationId);
    const child = [...this.instances.values()].find((instance) => instance.parentId === sourceInstanceId && instance.creationOperationId === creation);
    if (!child) return;
    const mainIdentity = { child: result.instance.id, ...(result.instance.parentId === undefined ? {} : { parent: result.instance.parentId }) };
    await child.saveChildState({ mainIdentity }, "post_effect");
    this.workMessages.rememberMainIdentity(child.id, mainIdentity);
  }

  async invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    this.assertDockToolsSource(sourceInstanceId);
    const source = this.getSnapshot(sourceInstanceId);
    assertChildMayRequest(source, request, this.mayStartChildren(this.get(sourceInstanceId)));
    if (request.type === "unreported_stop") return this.workMessages.unreportedStop(source, request);
    const child = request.type === "send" || request.type === "interrupt" || request.type === "stop" ? this.ownChild(source, request.target) : undefined;
    if (request.type === "send" && (source.parentId !== undefined || child !== undefined)) {
      if (request.done !== undefined && request.target !== undefined) throw new Error("done marks a result for your parent; leave it out when messaging your child Work.");
      return this.workMessages.send(source, request, child === undefined ? undefined : await this.childForMessage(child, request.operationId));
    }
    if (request.type === "list" || request.type === "inspect" || request.type === "watch" || request.type === "cancel") {
      return this.observationService.observe(sourceInstanceId, request);
    }
    if (request.type === "machines") throw new Error("Machine discovery requires this work to be connected to Main.");
    if (request.type === "deliver") {
      return { type: "deliver", deliverable: await this.get(sourceInstanceId).registerDeliverable(request.path) };
    }
    const mutations = this.dockToolsMutationPort;
    if (!mutations) throw new Error("Dock tools are not connected to the Host mutation service");
    if (request.type === "speed") {
      const target = request.target === undefined ? source : this.ownChild(source, request.target) ?? this.controlTarget(source, request.target);
      if (!mutations.speed) throw new Error("这个 Host 尚不支持模型速度设置，请更新 Host。");
      return { type: "speed", setting: await mutations.speed(target.id, request.operationId, request.selection) };
    }
    if (request.type === "create" || request.type === "system") {
      if (request.machine !== undefined) throw new Error("Machine selection requires a connection to Main. No local fallback was used.");
      return request.type === "create" ? mutations.create(request) : mutations.system(request);
    }
    // The list belongs to this Host's machine, where the source's child Works run.
    if (request.type === "models") return { type: "models", ...await mutations.childModels() };
    if (request.type === "spawn") {
      const resident = this.isResidentAssistant(sourceInstanceId);
      if (request.machine !== undefined) {
        throw new Error(resident
          ? "Machine selection requires a connection to Main. No local fallback was used."
          : "A child Work runs on the Machine of the Work that starts it. Leave machine out, or use dock_create for a Work of its own on another Machine.");
      }
      return spawnDockWorker(source, request, { create: (input) => mutations.create(input), send: (input) => mutations.send(input) }, resident);
    }
    if (request.type === "interrupt" || request.type === "stop") {
      if (child) return this.takeBack(child, request, mutations);
      if (source.parentId !== undefined) throw new Error("You can interrupt or stop only your own child Works. Name one as dock_list shows it.");
      const target = this.controlTarget(source, request.target);
      return { type: request.type, instance: await mutations[request.type](target.id, request.operationId) };
    }
    if (request.type !== "send") throw new Error("Unknown Dock tool request");
    return sendDockMessage(source, request, {
      send: (input) => mutations.send(input),
      resolveTarget: (target) => this.controlTarget(source, target),
    });
  }

  /** The parent interrupts or stops its own child Work, taking back the work it handed out: nothing is owed for it any more. */
  private async takeBack(child: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "interrupt" | "stop" }>, mutations: DockToolsMutationPort): Promise<DockToolsResult> {
    const takeBack = this.workMessages.takeBack(child.id);
    const identity = this.workMessages.forParent(child);
    let succeeded = false;
    try {
      const updated = await mutations[request.type](child.id, request.operationId);
      succeeded = true;
      return { type: request.type, instance: { ...updated, id: identity.id, parentId: identity.parentId }, settlesThrough: takeBack.settlesThrough };
    } finally {
      // Refused, or not known to have happened: the child may still be at work on it.
      takeBack.answered(succeeded);
    }
  }

  /** On a SubHost: what the resident assistant asks of her own child Work here, through Main (card #676). */
  async actForMainParent(parent: WorkParent, childId: string, request: MainParentRequest): Promise<DockToolsResult> {
    this.assertCatalogReady();
    const record = this.catalog.current().instances.find((entry) => entry.id === childId);
    const live = this.instances.get(childId);
    if (!record || record.parentId !== parent.id || !(live ? this.mainParented.has(live) && !this.departed.has(live) : record.childGrant?.mainParent)) {
      throw new Error("That child Work is no longer running, so it cannot be reached. Check it with dock_list.");
    }
    const child = this.safeSnapshot(record);
    if (request.type === "send") {
      if (request.done !== undefined) throw new Error("done marks a child Work's result for its parent; leave it out when you message a child Work.");
      return this.workMessages.toChild(parent, request.message, await this.childForMessage(child, request.operationId));
    }
    const mutations = this.dockToolsMutationPort;
    if (!mutations) throw new Error("Dock tools are not connected to the Host mutation service");
    return this.takeBack(child, request, mutations);
  }

  /**
   * On a SubHost whose connection to Main is back: a child Work of the resident assistant that crashed
   * meanwhile owes her the notice that could not reach her then (card #676).
   */
  mainReconnected(): void {
    for (const instance of this.instances.values()) {
      if (this.mainParented.has(instance) && instance.snapshot().lifecycle === "runtime_error") this.workMessages.childLeaving(instance);
    }
  }

  /** A Work the source may control, by name or ID; one under its own child Work is that child Work's (card #674). */
  private controlTarget(source: InstanceSnapshot, target: string): InstanceSnapshot {
    const owned = controlledByOwnChild(source, this.list(), target);
    if (owned !== undefined) throw new Error(owned);
    return this.observationService.resolveTarget(source.id, target);
  }

  /** Reopen only for a new message, never to enumerate or stop an interrupted child. */
  private async childForMessage(child: InstanceSnapshot, operationId: string): Promise<ManagedInstance> {
    if (child.lifecycle !== "host_lost") return this.get(child.id);
    if (!child.reopenable) throw new Error("This child Work was interrupted and could not be continued. Check its saved session in dock_list with scope=all.");
    const reopening = this.reopenInFlight.get(child.id);
    if (reopening) { await reopening; return this.get(child.id); }
    return (await this.reopen({ instanceId: child.id, operationId })).instance;
  }

  private ownChild(source: InstanceSnapshot, target: string | undefined): InstanceSnapshot | undefined {
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
    if (this.assistantWorkspace !== undefined) instance.setAssistantDisplayName(this.assistantDisplayName);
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
    this.assertCatalogReady();
    if (!this.instances.has(instanceId)) {
      const record = this.catalogRecord(instanceId);
      if (record.parentId !== undefined && record.lifecycle === "host_lost") {
        const reopening = this.reopenInFlight.get(instanceId);
        if (reopening) await reopening.catch(() => {});
        if (!this.instances.has(instanceId)) {
          this.stoppingInterrupted.add(instanceId);
          try { return await this.stopInterruptedChild(instanceId, operationId); }
          finally { this.stoppingInterrupted.delete(instanceId); }
        }
      }
    }
    const instance = this.get(instanceId);
    // A crashed top-level Work offers Continue or Remove; only a crashed child is collected by Stop.
    if (instance.parentId === undefined && instance.lifecycle === "runtime_error") throw new InstanceNotActiveError(instanceId, "runtime_error");
    try {
      const receipt = await instance.stop(operationId);
      const snapshot = instance.snapshot();
      // A Work leaves the runtime list only once the Works below it are retired, so a Stop of a Work above
      // it still finds it and waits for them too (card #674).
      if (!snapshot.assistant) this.departed.add(instance);
      await this.childRetirements.get(instance);
      if (snapshot.assistant && this.assistantWorkspace !== undefined) {
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

  /** Interrupted children have no Worker to stop. Their sessions stay on disk. */
  private async stopInterruptedChild(instanceId: string, operationId: string): Promise<{ receipt: StopReceipt; instance: InstanceSnapshot }> {
    const removed = await this.catalog.removeWithInterruptedChildren(instanceId, { kind: "instance.stop", effect: "post_effect", instanceId, operationId }, (record) => {
      if (record.parentId === undefined || record.lifecycle !== "host_lost") throw new InstanceBusyError(instanceId, "stop");
    });
    const record = removed[0];
    if (!record) throw new InstanceNotFoundError(instanceId);
    const ids = removed.map((item) => item.id);
    this.notifyCatalogRemoval(ids);
    await this.cleanupObservationForForgottenTargets(ids);
    const instance = catalogSnapshotFromRecord(record, this.hostEpoch);
    instance.lifecycle = "stopped";
    instance.reopenable = false;
    instance.updatedAt = new Date().toISOString();
    delete instance.interruption;
    delete instance.lastError;
    return { instance, receipt: { instanceId, operationId, alreadyStopped: false, stopped: true } };
  }

  /** Never rejects: a child whose cleanup fails stays listed, and Stop can be retried on it. */
  private retireChildren(parent: ManagedInstance): Promise<void> {
    const pending = this.childRetirements.get(parent);
    if (pending) return pending;
    // Keep departed live children in this set too: a grandchild may still be stopping.
    const children = new Set([...this.instances.values()]
      .filter((child) => child.parentId === parent.id && !this.mainParented.has(child)).map((child) => child.id));
    for (const child of this.catalog.current().instances) {
      if (child.parentId === parent.id && !child.childGrant?.mainParent && child.lifecycle === "host_lost") children.add(child.id);
    }
    // A child still starting stops itself once it sees this parent gone; wait for that too,
    // so no child process outlives its parent's Stop.
    const starting = [...(this.childStarts.get(parent) ?? [])];
    // Main's resident assistant may have child Works on other Machines too (card #676).
    const elsewhere = this.remoteChildren?.retire(parent.id) ?? Promise.resolve();
    const stops = Array.from(children, (id) => this.stop(id, randomUUID()));
    const task = Promise.allSettled([...stops, ...starting, elsewhere]).then(() => {
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
    const snapshot = catalogSnapshotFromRecord(record, this.hostEpoch);
    if (this.assistantWorkspace !== undefined && record.assistant) snapshot.displayName = this.assistantDisplayName;
    return snapshot;
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
      const family = await this.catalog.removeWithInterruptedChildren(instanceId, {
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
      const removed = family[0];
      if (!removed) throw new InstanceNotFoundError(instanceId);
      // A crashed child Work's own child Works may still be retiring: until they are, a Stop of a Work above
      // it still finds it and waits for them (card #674). The record is gone at once either way.
      const instance = this.instances.get(instanceId);
      const retiring = instance === undefined ? undefined : this.childRetirements.get(instance);
      if (retiring === undefined) this.instances.delete(instanceId);
      else {
        this.departed.add(instance!);
        void retiring.then(() => { if (this.instances.get(instanceId) === instance) this.instances.delete(instanceId); });
      }
      const ids = family.map((item) => item.id);
      await this.cleanupObservationForForgottenTargets(ids);
      this.notifyCatalogRemoval(ids);
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
    // A clean Host shutdown also ends children not yet continued since an earlier crash.
    await this.catalog.removeWhere({ kind: "host.shutdown.children", effect: "post_effect" }, (record) => record.parentId !== undefined, Infinity);
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

/** True when it did not exist and was created here. */
async function createMissingWorkingDirectory(path: string): Promise<boolean> {
  // Don't turn another platform's absolute path into a new relative directory here.
  if (isPortableAbsoluteLocalPath(path) && !isNativeAbsoluteLocalPath(path)) return false;
  const lexical = resolve(path);
  try { await stat(lexical); }
  catch (error) {
    // Existing paths and all other stat failures keep the normal working-directory check.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    await mkdir(lexical, { recursive: true });
    return true;
  }
  return false;
}

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${MISSING_WORKING_DIRECTORY}: ${lexical}`);
  return realpath(lexical);
}
