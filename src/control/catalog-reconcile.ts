import {
  type CatalogInstanceRecord,
  type CatalogProjection,
  validateCatalogProjection,
} from "../core/catalog.js";
import { projectInstanceDisplayName } from "../core/instance-display-name.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import { PI_SDK_VERSION } from "../version.js";

export interface CatalogReconcileResult {
  projection: CatalogProjection;
  normalizedCount: number;
}

/** Normalize prior-epoch live facts without constructing any runtime. */
export function reconcileCatalogProjection(
  loaded: CatalogProjection | undefined,
  hostEpoch: string,
  now = new Date(),
): CatalogReconcileResult {
  const timestamp = now.toISOString();
  if (!loaded) {
    const projection: CatalogProjection = {
      schemaVersion: 1,
      revision: 0,
      lastHostEpoch: hostEpoch,
      instances: [],
    };
    validateCatalogProjection(projection);
    return { projection, normalizedCount: 0 };
  }

  validateCatalogProjection(loaded);
  let normalizedCount = 0;
  const instances = loaded.instances.map((record) => {
    if (record.lifecycle === "active" || record.lifecycle === "stopping") {
      normalizedCount += 1;
      return normalizePriorLiveRecord(record, timestamp);
    }
    if (record.lifecycle === "host_lost" || record.lifecycle === "runtime_error") {
      const recoverySessionFile = record.recoverySessionFile ?? record.sessionFile;
      const normalized: CatalogInstanceRecord = {
        ...structuredClone(record),
        lifecycle: record.lifecycle,
        execution: "unavailable",
        executionChangedAt: record.execution === "unavailable" ? (record.executionChangedAt ?? record.createdAt) : timestamp,
        lastRun: record.lastRun,
        admissionPending: false,
        pendingCount: 0,
        ...(recoverySessionFile === undefined ? {} : { recoverySessionFile }),
      };
      delete normalized.ownerHostEpoch;
      delete normalized.activeCommandId;
      delete normalized.admissionOperationId;
      delete normalized.replacement;
      delete normalized.stopRequestedAt;
      delete normalized.shutdownRequestedAt;
      delete normalized.runStartedAt;
      if (record.lifecycle === "runtime_error" && normalized.interruption === undefined) {
        normalized.interruption = { reason: "replacement_failed", at: record.updatedAt };
      }
      return normalized;
    }
    const stopped: CatalogInstanceRecord = {
      ...structuredClone(record),
      lifecycle: "stopped",
      execution: "unavailable",
      executionChangedAt: record.execution === "unavailable" ? (record.executionChangedAt ?? record.createdAt) : timestamp,
      admissionPending: false,
      pendingCount: 0,
    };
    delete stopped.ownerHostEpoch;
    delete stopped.activeCommandId;
    delete stopped.admissionOperationId;
    delete stopped.replacement;
    delete stopped.recoverySessionFile;
    delete stopped.lastKnown;
    delete stopped.interruption;
    delete stopped.stopRequestedAt;
    delete stopped.shutdownRequestedAt;
    delete stopped.runStartedAt;
    return stopped;
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  const projection: CatalogProjection = {
    schemaVersion: 1,
    revision: loaded.revision + 1,
    lastHostEpoch: hostEpoch,
    instances,
  };
  validateCatalogProjection(projection);
  return { projection, normalizedCount };
}

export function catalogSnapshotFromRecord(
  record: CatalogInstanceRecord,
  currentHostEpoch: string,
): InstanceSnapshot {
  const reopenable = catalogReopenSessionFile(record) !== undefined
    && (record.lifecycle === "host_lost" || record.lifecycle === "runtime_error");
  return {
    id: record.id,
    creationOperationId: record.creationOperationId,
    ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
    ...(record.key === undefined ? {} : { key: record.key }),
    ...(record.name === undefined ? {} : { name: record.name }),
    displayName: projectInstanceDisplayName(record),
    cwd: record.cwd,
    lifecycle: record.lifecycle,
    execution: record.execution,
    compacting: false,
    lastRun: record.lastRun,
    reopenable,
    runtimeGeneration: record.runtimeGeneration,
    ...(record.ownerHostEpoch === undefined ? {} : { ownerHostEpoch: record.ownerHostEpoch }),
    ...(record.interruption === undefined ? {} : { interruption: structuredClone(record.interruption) }),
    pending: { steering: 0, followUp: 0, total: record.pendingCount },
    executor: {
      kind: "pi-sdk",
      version: PI_SDK_VERSION,
      piSessionId: record.piSessionId,
      ...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
      ...(record.model === undefined ? {} : { model: { ...record.model } }),
      ...(record.thinkingLevel === undefined ? {} : { thinkingLevel: record.thinkingLevel }),
    },
    extensionStatus: {},
    toolsExpanded: false,
    ...(record.activeCommandId === undefined ? {} : { activeCommandId: record.activeCommandId }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executionChangedAt: record.executionChangedAt ?? record.createdAt,
    ...(record.runStartedAt === undefined ? {} : { runStartedAt: record.runStartedAt }),
    eventCursor: {
      hostEpoch: record.ownerHostEpoch ?? currentHostEpoch,
      instanceId: record.id,
      runtimeGeneration: record.runtimeGeneration,
      sequence: 0,
    },
  };
}

export function catalogReopenSessionFile(record: CatalogInstanceRecord): string | undefined {
  if (record.lifecycle !== "host_lost" && record.lifecycle !== "runtime_error") return undefined;
  if (record.ownerReleaseUnconfirmed) return undefined;
  return record.recoverySessionFile ?? record.sessionFile;
}

function normalizePriorLiveRecord(
  record: CatalogInstanceRecord,
  timestamp: string,
): CatalogInstanceRecord {
  if ((record.lifecycle !== "active" && record.lifecycle !== "stopping") || record.execution === "unavailable") {
    throw new Error("Prior live catalog record violates lifecycle invariants");
  }
  const liveLifecycle = record.lifecycle;
  const liveExecution = record.execution;
  const updatedAt = timestamp < record.updatedAt ? record.updatedAt : timestamp;
  const busy = record.lifecycle === "stopping"
    || record.execution === "running"
    || record.activeCommandId !== undefined
    || record.admissionPending
    || record.pendingCount > 0
    || record.replacement !== undefined;
  const recoverySessionFile = record.replacement?.previousSessionFile
    ?? record.recoverySessionFile
    ?? record.sessionFile;
  const ownerReleaseUnconfirmed = record.stopRequestedAt !== undefined || record.shutdownRequestedAt !== undefined;
  const normalized: CatalogInstanceRecord = {
    ...structuredClone(record),
    lifecycle: ownerReleaseUnconfirmed ? "runtime_error" : "host_lost",
    execution: "unavailable",
    executionChangedAt: updatedAt,
    lastRun: busy ? "interrupted" : record.lastRun,
    admissionPending: false,
    pendingCount: 0,
    lastKnown: {
      lifecycle: liveLifecycle,
      execution: liveExecution,
      ...(record.activeCommandId === undefined ? {} : { activeCommandId: record.activeCommandId }),
      pendingCount: record.pendingCount,
    },
    interruption: {
      reason: ownerReleaseUnconfirmed ? "replacement_failed" : "host_crash",
      at: updatedAt,
    },
    ...(recoverySessionFile === undefined ? {} : { recoverySessionFile }),
    ...(ownerReleaseUnconfirmed ? { ownerReleaseUnconfirmed: true as const } : {}),
    lastError: ownerReleaseUnconfirmed
      ? "Previous runtime owner release was not confirmed; this instance cannot be reopened"
      : "Previous Alu Dock Host ended; explicitly reopen to continue this session context",
    updatedAt,
  };
  delete normalized.ownerHostEpoch;
  delete normalized.activeCommandId;
  delete normalized.admissionOperationId;
  delete normalized.replacement;
  delete normalized.stopRequestedAt;
  delete normalized.shutdownRequestedAt;
  delete normalized.runStartedAt;
  return normalized;
}
