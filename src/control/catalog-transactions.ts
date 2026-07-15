import {
  CatalogEffectUnknownError,
  type CatalogCommitPort,
  type CatalogInstanceRecord,
  type CatalogMutationContext,
  type CatalogProjection,
  CatalogWriteError,
  type InstanceCatalogMutationPort,
  MutationFaultedError,
  validateCatalogProjection,
  validateCatalogRecord,
} from "../core/catalog.js";

export type CatalogHealth = "healthy" | "mutation_faulted" | "draining";

export interface CatalogFault {
  context: CatalogMutationContext;
  error: CatalogEffectUnknownError;
}

const IN_MEMORY_COMMIT_PORT: CatalogCommitPort = { commit: async () => {} };

export class CatalogTransactionCoordinator {
  private projection: CatalogProjection;
  private tail: Promise<void> = Promise.resolve();
  private healthValue: CatalogHealth = "healthy";
  private faultValue: CatalogFault | undefined;
  private initialized = false;
  private readonly faultListeners = new Set<(fault: CatalogFault) => void>();

  constructor(
    private readonly port: CatalogCommitPort = IN_MEMORY_COMMIT_PORT,
    lastHostEpoch = "host-epoch",
  ) {
    this.projection = { schemaVersion: 1, revision: 0, lastHostEpoch, instances: [] };
  }

  get health(): CatalogHealth { return this.healthValue; }
  get fault(): CatalogFault | undefined { return this.faultValue; }
  get revision(): number { return this.projection.revision; }

  current(): CatalogProjection {
    return structuredClone(this.projection);
  }

  initialize(projection: CatalogProjection): void {
    if (this.initialized || this.projection.revision !== 0 || this.projection.instances.length > 0 || this.healthValue !== "healthy") {
      throw new Error("Catalog coordinator is already initialized");
    }
    validateCatalogProjection(projection);
    this.projection = structuredClone(projection);
    this.initialized = true;
  }

  assertWritable(): void {
    if (this.healthValue !== "healthy") throw new MutationFaultedError();
  }

  onFault(listener: (fault: CatalogFault) => void): () => void {
    this.faultListeners.add(listener);
    if (this.faultValue) listener(this.faultValue);
    return () => this.faultListeners.delete(listener);
  }

  beginDraining(): void {
    if (this.healthValue === "mutation_faulted") this.healthValue = "draining";
  }

  forInstance(instanceId: string): InstanceCatalogMutationPort {
    return {
      assertWritable: () => this.assertWritable(),
      commit: (record, context) => {
        if (record.id !== instanceId) return Promise.reject(new Error("Instance catalog port identity mismatch"));
        return this.replace(record, { ...context, instanceId });
      },
    };
  }

  create(record: CatalogInstanceRecord, context: CatalogMutationContext): Promise<void> {
    return this.enqueue(record, { ...context, instanceId: record.id }, "create");
  }

  private replace(record: CatalogInstanceRecord, context: CatalogMutationContext): Promise<void> {
    return this.enqueue(record, context, "replace");
  }

  private enqueue(record: CatalogInstanceRecord, context: CatalogMutationContext, mode: "create" | "replace"): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.healthValue !== "healthy") {
        if (context.effect === "post_effect") throw new CatalogEffectUnknownError(context, this.faultValue?.error);
        throw new MutationFaultedError();
      }
      try {
        validateCatalogRecord(record);
        const records = new Map(this.projection.instances.map((item) => [item.id, item]));
        if (mode === "create" && records.has(record.id)) throw new Error(`Catalog instance already exists: ${record.id}`);
        if (mode === "replace" && !records.has(record.id)) throw new Error(`Catalog instance is not committed: ${record.id}`);
        records.set(record.id, structuredClone(record));
        const candidate: CatalogProjection = {
          schemaVersion: 1,
          revision: this.projection.revision + 1,
          lastHostEpoch: this.projection.lastHostEpoch,
          instances: [...records.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
        };
        validateCatalogProjection(candidate);
        const immutableCandidate = deepFreeze(structuredClone(candidate));
        const immutableContext = deepFreeze(structuredClone(context));
        await this.port.commit(immutableCandidate, immutableContext);
        this.projection = candidate;
      } catch (cause) {
        if (context.effect === "post_effect") {
          const error = new CatalogEffectUnknownError(context, cause);
          this.tripFault({ context: structuredClone(context), error });
          throw error;
        }
        throw new CatalogWriteError(context, cause);
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  private tripFault(fault: CatalogFault): void {
    if (this.healthValue !== "healthy") return;
    this.healthValue = "mutation_faulted";
    this.faultValue = fault;
    for (const listener of this.faultListeners) {
      try { listener(fault); } catch { /* Fault notification cannot revive writes. */ }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
