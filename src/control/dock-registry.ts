import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { CatalogCommitPort } from "../core/catalog.js";
import type { ManagedInstance, InstanceSnapshot } from "../core/managed-instance.js";
import { CatalogTransactionCoordinator, type CatalogFault, type CatalogHealth } from "./catalog-transactions.js";
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
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
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

export class DockRegistry {
  readonly hostEpoch: string;
  readonly startedAt: string;
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly catalog: CatalogTransactionCoordinator;

  constructor(
    private readonly factory: InstanceFactory,
    private readonly createId: () => string = randomUUID,
    options: { hostEpoch?: string; startedAt?: string; trustPreflight?: CreateTrustPreflight; catalogCommitPort?: CatalogCommitPort } = {},
  ) {
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.trustPreflight = options.trustPreflight;
    this.catalog = new CatalogTransactionCoordinator(options.catalogCommitPort);
  }

  private readonly trustPreflight: CreateTrustPreflight | undefined;

  async create(input: CreateRegistryInstanceInput): Promise<ManagedInstance> {
    this.catalog.assertWritable();
    const resolution = this.trustPreflight
      ? await this.trustPreflight.resolve({
          operationType: "instance.create",
          operationId: input.operationId,
          cwd: input.cwd,
          name: input.name,
          trustChallengeId: input.trustChallengeId,
          projectTrustDecision: input.projectTrustDecision,
        })
      : { canonicalCwd: await canonicalDirectory(input.cwd), projectTrusted: true };
    const cwd = resolution.canonicalCwd;

    const id = this.createId();
    if (this.instances.has(id)) throw new Error(`Generated duplicate instance identity: ${id}`);
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

  get(instanceId: string): ManagedInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    return instance;
  }

  list(): InstanceSnapshot[] {
    return [...this.instances.values()]
      .map((instance) => instance.snapshot())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  catalogRevision(): number {
    return this.catalog.revision;
  }

  catalogHealth(): CatalogHealth { return this.catalog.health; }
  catalogFault(): CatalogFault | undefined { return this.catalog.fault; }
  assertMutationAllowed(): void { this.catalog.assertWritable(); }
  onMutationFault(listener: (fault: CatalogFault) => void): () => void { return this.catalog.onFault(listener); }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.stop()));
  }

  beginMutationDrain(): void { this.catalog.beginDraining(); }

  async disposeAllForHostDrain(): Promise<void> {
    this.beginMutationDrain();
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.disposeForHostDrain()));
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${lexical}`);
  return realpath(lexical);
}
