export class OperationConflictError extends Error {
  readonly code = "operation_conflict";

  constructor(readonly operationId: string) {
    super(`Operation ID ${operationId} was already used for a different mutation`);
    this.name = "OperationConflictError";
  }
}

interface LedgerEntry<T = unknown> {
  fingerprint: string;
  promise: Promise<T>;
  settled: boolean;
}

/**
 * Same-Host mutation receipt ledger. Live operations are never evicted; only
 * the oldest settled receipts are removed when the configured bound is passed.
 */
export class OperationLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly settledOrder: string[] = [];
  private readonly settledCapacity: number;

  constructor(settledCapacity = 1_000) {
    this.settledCapacity = Number.isSafeInteger(settledCapacity) && settledCapacity >= 1
      ? settledCapacity
      : 1_000;
  }

  run<T>(operationId: string, mutationType: string, params: unknown, execute: () => Promise<T> | T): Promise<T> {
    const fingerprint = stableFingerprint(mutationType, params);
    const existing = this.entries.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new OperationConflictError(operationId));
      }
      return existing.promise as Promise<T>;
    }

    // The continuation starts on a microtask, after the entry is visible to a
    // concurrent duplicate, including requests decoded from the same I/O turn.
    const promise = Promise.resolve().then(execute);
    const entry: LedgerEntry<T> = { fingerprint, promise, settled: false };
    this.entries.set(operationId, entry);
    void promise.then(
      () => this.markSettled(operationId, entry),
      () => this.markSettled(operationId, entry),
    );
    return promise;
  }

  private markSettled(operationId: string, entry: LedgerEntry): void {
    if (entry.settled || this.entries.get(operationId) !== entry) return;
    entry.settled = true;
    this.settledOrder.push(operationId);
    while (this.settledOrder.length > this.settledCapacity) {
      const oldest = this.settledOrder.shift();
      if (oldest === undefined) break;
      const candidate = this.entries.get(oldest);
      if (candidate?.settled) this.entries.delete(oldest);
    }
  }
}

function stableFingerprint(mutationType: string, params: unknown): string {
  return `${mutationType}:${stableSerialize(params)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}
