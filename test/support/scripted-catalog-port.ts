import type { CatalogCommitPort, CatalogMutationContext, CatalogProjection } from "../../src/core/catalog.js";

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.resolve = resolve; });
  }
}

export interface CatalogCommitCall {
  candidate: Readonly<CatalogProjection>;
  context: Readonly<CatalogMutationContext>;
}

export class ScriptedCatalogCommitPort implements CatalogCommitPort {
  readonly calls: CatalogCommitCall[] = [];
  readonly failCalls = new Set<number>();
  private readonly failureMessages = new Map<number, string>();
  activeCommits = 0;
  maxActiveCommits = 0;
  private readonly gates = new Map<number, { entered: Deferred; release: Deferred }>();

  failAt(callNumber: number, message?: string): void {
    this.failCalls.add(callNumber);
    if (message !== undefined) this.failureMessages.set(callNumber, message);
  }

  gateAt(callNumber: number): { entered: Promise<void>; release: () => void } {
    const gate = { entered: new Deferred(), release: new Deferred() };
    this.gates.set(callNumber, gate);
    return { entered: gate.entered.promise, release: () => gate.release.resolve() };
  }

  async commit(candidate: Readonly<CatalogProjection>, context: Readonly<CatalogMutationContext>): Promise<void> {
    const callNumber = this.calls.length + 1;
    this.calls.push({ candidate, context });
    this.activeCommits += 1;
    this.maxActiveCommits = Math.max(this.maxActiveCommits, this.activeCommits);
    try {
      const gate = this.gates.get(callNumber);
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (this.failCalls.has(callNumber)) throw new Error(this.failureMessages.get(callNumber) ?? `scripted catalog failure ${callNumber}`);
    } finally {
      this.activeCommits -= 1;
    }
  }
}
