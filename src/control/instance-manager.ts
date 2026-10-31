import type { AttachmentService } from "./attachment-service.js";
import type { ProjectTrustChoice } from "./project-trust.js";
import type { ImagePathDto } from "../core/instance-dto.js";
import type { JsonObject } from "../core/json-value.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { MachineDto } from "../core/machine-dto.js";
import { InstanceNotFoundError, type DockRegistry } from "./dock-registry.js";
import type { OperationLedger } from "./operation-ledger.js";
import {
  classifyControlRequest,
  type ControlRequest,
  type EnsureResult,
  MAX_INSTANCE_LIST_RESULT_BYTES,
  ProtocolValidationError,
} from "./protocol.js";

export interface RoutedProtocolProxy {
  send(record: unknown): Promise<void>;
  close(): void;
}

export type RemoteEndpointDecision =
  | { kind: "result"; result: unknown }
  | { kind: "remote"; proxy: RoutedProtocolProxy };

export type InstanceLocationDecision =
  | { kind: "local" }
  | RemoteEndpointDecision;

export interface RemoteProtocolEndpoint {
  dispatch(request: ControlRequest, emit: (record: unknown) => void | Promise<void>, ended: () => void, fileMode?: boolean): Promise<RemoteEndpointDecision>;
}

/** Persistent remote-location backend used only by the global InstanceManager profile. */
export interface RemoteInstanceDirectory {
  resolveInstance(instanceId: string): Promise<RemoteProtocolEndpoint | undefined>;
  resolveHost(hostId: string): Promise<RemoteProtocolEndpoint | undefined>;
  currentSnapshot(instanceId: string): InstanceSnapshot | undefined;
  currentSnapshots(): InstanceSnapshot[];
  subscribeSnapshot(instanceId: string, listener: (snapshot: InstanceSnapshot) => void): (() => void) | undefined;
  getByKey(key: string): Promise<InstanceSnapshot | undefined>;
  ensureByKey(request: Extract<ControlRequest, { type: "instance.ensure" }>, ensureLocal: () => Promise<EnsureResult>): Promise<EnsureResult>;
  mainHostId(): string;
  machines(): Promise<MachineDto[]>;
  removeMachine(hostId: string): Promise<{ hostId: string; removed: boolean }>;
  listPage(local: InstanceSnapshot[], params: Extract<ControlRequest, { type: "instance.list" }>["params"]): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateInstanceMutation {
  /** Persistent Dock parent; children remain independently visible and controllable. */
  parentId?: string;
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
  workerConfig?: JsonObject;
}

export interface SubmitCommandMutation {
  operationId: string;
  instanceId: string;
  message: string;
  images?: ImagePathDto[];
  attachments?: string[];
  delivery: "auto" | "prompt" | "steer" | "followUp";
}

/**
 * The sole Host application authority for Instance identity and location.
 * Local and SubHost profiles share this entry; only Main supplies a remote directory.
 */
export class InstanceManager {
  constructor(
    private readonly registry: DockRegistry,
    private readonly operationLedger: OperationLedger,
    private readonly attachmentService?: AttachmentService,
    private readonly remote?: RemoteInstanceDirectory,
  ) {}

  hasRemoteDirectory(): boolean { return this.remote !== undefined; }
  mainHostId(): string | undefined { return this.remote?.mainHostId(); }
  start(): Promise<void> { return this.remote?.start() ?? Promise.resolve(); }
  stop(): Promise<void> { return this.remote?.stop() ?? Promise.resolve(); }

  snapshots(): InstanceSnapshot[] {
    return [...this.registry.list(), ...(this.remote?.currentSnapshots() ?? [])];
  }

  snapshot(instanceId: string): InstanceSnapshot | undefined {
    try {
      return this.registry.getSnapshot(instanceId);
    } catch (error) {
      if (!(error instanceof InstanceNotFoundError)) throw error;
      return this.remote?.currentSnapshot(instanceId);
    }
  }

  subscribeSnapshot(instanceId: string, listener: (snapshot: InstanceSnapshot) => void): (() => void) | undefined {
    const remoteSubscription = this.remote?.subscribeSnapshot(instanceId, listener);
    if (remoteSubscription) return remoteSubscription;
    try {
      const instance = this.registry.get(instanceId);
      return instance.subscribe(() => listener(instance.snapshot()));
    } catch {
      return undefined;
    }
  }

  async locate(
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    fileMode = false,
  ): Promise<InstanceLocationDecision> {
    const classification = classifyControlRequest(request);
    if (classification.target === "dock") return { kind: "local" };

    if (request.type === "instance.get_by_key") {
      const instance = this.remote
        ? await this.remote.getByKey(request.params.key)
        : this.registry.getSnapshotByKey(request.params.key);
      return { kind: "result", result: { instance: instance ?? null } };
    }

    if (request.type === "instance.ensure") {
      const ensureLocal = () => this.registry.ensure({
        operationId: request.params.operationId,
        key: request.params.key,
        cwd: request.params.cwd,
        name: request.params.name,
        trustChallengeId: request.params.trustChallengeId,
        projectTrustDecision: request.params.projectTrustDecision,
      });
      const result = await this.operationLedger.run(
        request.params.operationId,
        request.type,
        request.params,
        () => this.remote ? this.remote.ensureByKey(request, ensureLocal) : ensureLocal(),
      );
      return { kind: "result", result };
    }

    if (request.type === "instance.list") {
      const result = this.remote
        ? await this.remote.listPage(this.registry.list(), request.params)
        : this.registry.listPage({ ...request.params, maxBytes: MAX_INSTANCE_LIST_RESULT_BYTES });
      return { kind: "result", result };
    }

    if (!this.remote) return { kind: "local" };
    if (classification.target === "instance") {
      const instanceId = "instanceId" in request.params ? request.params.instanceId : undefined;
      if (typeof instanceId !== "string") throw new Error(`Instance request ${request.type} has no instance identity`);
      const endpoint = await this.remote.resolveInstance(instanceId);
      return endpoint ? endpoint.dispatch(request, emit, ended, fileMode) : { kind: "local" };
    }

    const hostId = "hostId" in request.params ? request.params.hostId : undefined;
    if (typeof hostId !== "string" || hostId === this.remote.mainHostId()) return { kind: "local" };
    const endpoint = await this.remote.resolveHost(hostId);
    if (!endpoint) throw new ProtocolValidationError("host_not_found", "That machine is not connected to this Dock");
    return endpoint.dispatch(request, emit, ended, fileMode);
  }

  machines(): Promise<MachineDto[]> {
    if (!this.remote) throw new ProtocolValidationError("capability_missing", "Machine routing is unavailable");
    return this.remote.machines();
  }

  removeMachine(hostId: string): Promise<{ hostId: string; removed: boolean }> {
    if (!this.remote) throw new ProtocolValidationError("capability_missing", "Machine routing is unavailable");
    return this.remote.removeMachine(hostId);
  }

  create(input: CreateInstanceMutation) {
    return this.operationLedger.run(input.operationId, "instance.create", input, async () => {
      const instance = await this.registry.create(input);
      return { instance: instance.snapshot() };
    });
  }

  submit(input: SubmitCommandMutation) {
    return this.operationLedger.run(input.operationId, "command.submit", input, async () => {
      const instance = this.registry.get(input.instanceId);
      const attachments = input.attachments === undefined
        ? undefined
        : await this.attachmentService?.getMany(input.attachments);
      if (input.attachments !== undefined && attachments === undefined) {
        throw new ProtocolValidationError("capability_missing", "Attachment storage is unavailable");
      }
      const receipt = await instance.submit(input.message, input.delivery, input.operationId, input.images, attachments);
      return { receipt, instance: instance.snapshot() };
    });
  }
}
