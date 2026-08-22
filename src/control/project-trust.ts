import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { isNativeAbsoluteLocalPath, isPortableAbsoluteLocalPath } from "../core/local-path.js";

export const PROJECT_TRUST_CHOICES = [
  "trust_once",
  "trust_and_remember",
  "deny_once",
  "deny_and_remember",
] as const;
export type ProjectTrustChoice = typeof PROJECT_TRUST_CHOICES[number];
export type ProjectTrustOperationType = "instance.create" | "instance.adopt" | "instance.reopen" | "session.switch";

export interface ProjectTrustRequest {
  operationType: ProjectTrustOperationType;
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
}

export interface ProjectTrustResolution {
  canonicalCwd: string;
  projectTrusted: boolean;
}

export interface ProjectTrustDependencies {
  requiresTrust(canonicalCwd: string): boolean;
  savedDecision(canonicalCwd: string): boolean | null;
  defaultDecision(canonicalCwd: string): "ask" | "always" | "never";
  remember(canonicalCwd: string, trusted: boolean): void;
}

interface PendingChallenge {
  challengeId: string;
  operationType: ProjectTrustOperationType;
  operationId: string;
  canonicalCwd: string;
  targetKey: string;
  expiresAtMs: number;
}

interface ChallengeTombstone {
  status: "consumed" | "expired";
  operationType: ProjectTrustOperationType;
  operationId: string;
  targetKey: string;
  challengeId: string;
}

export class ProjectTrustRequiredError extends Error {
  readonly code = "project_trust_required";
  readonly retryable = false;

  constructor(readonly details: {
    challengeId: string;
    operationId: string;
    cwd: string;
    choices: ProjectTrustChoice[];
    expiresAt: string;
  }) {
    super("Project trust decision required");
    this.name = "ProjectTrustRequiredError";
  }
}

export class ProjectTrustChallengeError extends Error {
  readonly code = "invalid_project_trust_challenge";
  constructor(message: string) {
    super(message);
    this.name = "ProjectTrustChallengeError";
  }
}

/**
 * Host-serialized, operation-bound trust gate.
 *
 * Pending challenges and consumed/expired tombstones are distinct from ordinary
 * mutation receipts. Tombstones never return authorization: an exact duplicate
 * is served by OperationLedger while its receipt exists, otherwise it fails
 * closed instead of re-entering candidate construction.
 */
export class ProjectTrustCoordinator {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly tombstones = new Map<string, ChallengeTombstone>();
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: ProjectTrustDependencies,
    private readonly options: {
      ttlMs?: number;
      now?: () => number;
      createId?: () => string;
      bindingCapacity?: number;
    } = {},
  ) {}

  resolve(request: ProjectTrustRequest): Promise<ProjectTrustResolution> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolveSerial) => { release = resolveSerial; });
    return previous.then(() => this.resolveSerialized(request)).finally(release);
  }

  private async resolveSerialized(request: ProjectTrustRequest): Promise<ProjectTrustResolution> {
    if ((request.trustChallengeId === undefined) !== (request.projectTrustDecision === undefined)) {
      throw new ProjectTrustChallengeError("trustChallengeId and projectTrustDecision must be supplied together");
    }

    const canonicalCwd = await canonicalDirectory(request.cwd);
    const targetKey = createTargetKey(request.operationType, canonicalCwd, request.name);
    const tombstone = this.tombstones.get(request.operationId);
    if (tombstone) {
      const changed = tombstone.operationType !== request.operationType || tombstone.targetKey !== targetKey;
      const suffix = changed ? " and cannot be rebound to another target" : "";
      throw new ProjectTrustChallengeError(`Project trust challenge has ${tombstone.status}${suffix}`);
    }

    const now = this.now();
    const existing = this.pending.get(request.operationId);
    if (existing) {
      if (existing.operationType !== request.operationType || existing.targetKey !== targetKey) {
        throw new ProjectTrustChallengeError("Operation ID is already bound to another project trust target");
      }
      if (now >= existing.expiresAtMs) {
        this.expire(request.operationId, existing);
        throw new ProjectTrustChallengeError("Project trust challenge expired");
      }
      if (request.trustChallengeId === undefined) throw this.required(existing);
    }

    const requiresTrust = this.dependencies.requiresTrust(canonicalCwd);
    if (!requiresTrust) {
      if (request.trustChallengeId !== undefined) {
        throw new ProjectTrustChallengeError("Project trust decision was supplied for a target that does not require trust");
      }
      return { canonicalCwd, projectTrusted: true };
    }

    if (request.trustChallengeId !== undefined && request.projectTrustDecision !== undefined) {
      const challenge = existing;
      if (!challenge || challenge.challengeId !== request.trustChallengeId) {
        throw new ProjectTrustChallengeError("Project trust challenge is unknown");
      }
      if (challenge.operationType !== request.operationType || challenge.targetKey !== targetKey) {
        throw new ProjectTrustChallengeError("Project trust challenge target changed");
      }
      if (now >= challenge.expiresAtMs) {
        this.expire(request.operationId, challenge);
        throw new ProjectTrustChallengeError("Project trust challenge expired");
      }

      this.pending.delete(request.operationId);
      this.addTombstone({
        status: "consumed",
        operationType: challenge.operationType,
        operationId: challenge.operationId,
        targetKey: challenge.targetKey,
        challengeId: challenge.challengeId,
      });
      const trusted = request.projectTrustDecision === "trust_once"
        || request.projectTrustDecision === "trust_and_remember";
      if (request.projectTrustDecision === "trust_and_remember" || request.projectTrustDecision === "deny_and_remember") {
        this.dependencies.remember(canonicalCwd, trusted);
      }
      return { canonicalCwd, projectTrusted: trusted };
    }

    const saved = this.dependencies.savedDecision(canonicalCwd);
    if (saved !== null) return { canonicalCwd, projectTrusted: saved };
    const defaultDecision = this.dependencies.defaultDecision(canonicalCwd);
    if (defaultDecision !== "ask") {
      return { canonicalCwd, projectTrusted: defaultDecision === "always" };
    }

    this.pruneExpiredPending(now);
    const bindingCapacity = boundedCapacity(this.options.bindingCapacity, 10_000);
    if (this.pending.size + this.tombstones.size >= bindingCapacity) {
      throw new ProjectTrustChallengeError("Project trust operation binding capacity is exhausted");
    }
    const challenge: PendingChallenge = {
      challengeId: this.options.createId?.() ?? randomUUID(),
      operationType: request.operationType,
      operationId: request.operationId,
      canonicalCwd,
      targetKey,
      expiresAtMs: now + boundedTtl(this.options.ttlMs),
    };
    this.pending.set(request.operationId, challenge);
    throw this.required(challenge);
  }

  private expire(operationId: string, challenge: PendingChallenge): void {
    this.pending.delete(operationId);
    this.addTombstone({
      status: "expired",
      operationType: challenge.operationType,
      operationId: challenge.operationId,
      targetKey: challenge.targetKey,
      challengeId: challenge.challengeId,
    });
  }

  private addTombstone(tombstone: ChallengeTombstone): void {
    // A challenge reserves one bounded binding slot when it is issued. Moving
    // that slot to a tombstone never frees or evicts the operation identity
    // during this Host epoch; capacity pressure therefore fails closed.
    this.tombstones.set(tombstone.operationId, tombstone);
  }

  private pruneExpiredPending(now: number): void {
    for (const [operationId, challenge] of this.pending) {
      if (now >= challenge.expiresAtMs) this.expire(operationId, challenge);
    }
  }

  private required(challenge: PendingChallenge): ProjectTrustRequiredError {
    return new ProjectTrustRequiredError({
      challengeId: challenge.challengeId,
      operationId: challenge.operationId,
      cwd: challenge.canonicalCwd,
      choices: [...PROJECT_TRUST_CHOICES],
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
    });
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (isPortableAbsoluteLocalPath(path) && !isNativeAbsoluteLocalPath(path)) {
    throw new Error("Working directory is not an absolute path on this Host");
  }
  const lexical = resolve(path);
  const info = await stat(lexical).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${lexical}`);
  return realpath(lexical);
}

function createTargetKey(
  operationType: ProjectTrustOperationType,
  canonicalCwd: string,
  name: string | undefined,
): string {
  return JSON.stringify({ operationType, canonicalCwd, name: name ?? null });
}

function boundedTtl(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 1 && value <= 10 * 60_000
    ? value
    : 60_000;
}

function boundedCapacity(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 1 ? value : fallback;
}
