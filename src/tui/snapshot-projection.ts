import type { DockEvent, InstanceSnapshot } from "../core/instance-dto.js";
import type { ThinkingLevel } from "../core/agent-worker.js";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function projectSnapshot(snapshot: InstanceSnapshot, event: DockEvent): InstanceSnapshot {
  if (event.type === "git.branch_changed") {
    return { ...snapshot, gitBranch: event.data.branch, updatedAt: event.occurredAt, eventCursor: advanceCursor(snapshot, event) };
  }
  if (event.type === "session.metrics_changed") {
    return {
      ...snapshot,
      metrics: structuredClone(event.data.metrics),
      updatedAt: event.occurredAt,
      eventCursor: advanceCursor(snapshot, event),
    };
  }
  if (event.type === "extension.tools_expanded_changed") {
    return { ...snapshot, toolsExpanded: event.data.expanded, updatedAt: event.occurredAt, eventCursor: advanceCursor(snapshot, event) };
  }
  if (event.type === "extension.status_changed") {
    const extensionStatus = { ...snapshot.extensionStatus };
    if (event.data.text === undefined) delete extensionStatus[event.data.key];
    else extensionStatus[event.data.key] = event.data.text;
    return { ...snapshot, extensionStatus, updatedAt: event.occurredAt, eventCursor: advanceCursor(snapshot, event) };
  }
  if (event.type === "session.info_changed") {
    return { ...snapshot, name: event.data.name, updatedAt: event.occurredAt, eventCursor: advanceCursor(snapshot, event) };
  }
  if (event.type === "session.replaced") {
    return {
      ...snapshot,
      cwd: event.data.cwd,
      name: event.data.name,
      gitBranch: event.data.gitBranch,
      execution: "idle",
      compacting: false,
      lastRun: "never",
      pending: { steering: 0, followUp: 0, total: 0 },
      activeCommandId: undefined,
      lastError: undefined,
      extensionStatus: {},
      toolsExpanded: false,
      runtimeGeneration: event.data.runtimeGeneration,
      executor: { ...snapshot.executor, piSessionId: event.data.piSessionId, sessionFile: event.data.sessionFile },
      updatedAt: event.occurredAt,
      eventCursor: {
        ...snapshot.eventCursor,
        runtimeGeneration: event.data.runtimeGeneration,
        sequence: event.sequence,
      },
    };
  }
  if (event.type === "model.changed") {
    const provider = eventString(event, "provider");
    const id = eventString(event, "id");
    const thinkingLevel = thinkingData(event, "thinkingLevel") ?? snapshot.executor.thinkingLevel;
    return {
      ...snapshot,
      executor: {
        ...snapshot.executor,
        model: provider && id ? { provider, id } : snapshot.executor.model,
        thinkingLevel,
      },
      updatedAt: event.occurredAt,
      eventCursor: advanceCursor(snapshot, event),
    };
  }
  if (event.type === "thinking.changed") {
    return {
      ...snapshot,
      executor: { ...snapshot.executor, thinkingLevel: thinkingData(event, "thinkingLevel") ?? snapshot.executor.thinkingLevel },
      updatedAt: event.occurredAt,
      eventCursor: advanceCursor(snapshot, event),
    };
  }
  if (event.type !== "instance.state_changed") {
    if (event.type === "instance.stopped") {
      return { ...snapshot, lifecycle: "stopped", execution: "unavailable", compacting: false, ownerHostEpoch: undefined, updatedAt: event.occurredAt };
    }
    if (event.type === "compaction.started") {
      return { ...snapshot, execution: "running", compacting: true, updatedAt: event.occurredAt, eventCursor: advanceCursor(snapshot, event) };
    }
    if (event.type === "compaction.completed") {
      return {
        ...snapshot,
        execution: snapshot.activeCommandId === undefined && !event.data.willRetry ? "idle" : snapshot.execution,
        compacting: false,
        updatedAt: event.occurredAt,
        eventCursor: advanceCursor(snapshot, event),
      };
    }
    return { ...snapshot, eventCursor: advanceCursor(snapshot, event) };
  }

  return {
    ...snapshot,
    lifecycle: enumData(event, "lifecycle", ["active", "stopping", "stopped", "host_lost", "runtime_error"] as const) ?? snapshot.lifecycle,
    execution: enumData(event, "execution", ["idle", "running", "failed", "unavailable"] as const) ?? snapshot.execution,
    compacting: booleanData(event, "compacting") ?? snapshot.compacting,
    lastRun: enumData(event, "lastRun", ["never", "succeeded", "failed", "aborted", "interrupted"] as const) ?? snapshot.lastRun,
    pending: pendingData(event) ?? snapshot.pending,
    activeCommandId: eventString(event, "activeCommandId"),
    lastError: eventString(event, "lastError"),
    updatedAt: event.occurredAt,
    eventCursor: advanceCursor(snapshot, event),
  };
}

export function eventString(event: DockEvent, key: string): string | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function advanceCursor(snapshot: InstanceSnapshot, event: DockEvent): InstanceSnapshot["eventCursor"] {
  return { ...snapshot.eventCursor, sequence: Math.max(snapshot.eventCursor.sequence, event.sequence) };
}

function enumData<const T extends readonly string[]>(event: DockEvent, key: string, values: T): T[number] | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && values.includes(value) ? value as T[number] : undefined;
}

function pendingData(event: DockEvent): InstanceSnapshot["pending"] | undefined {
  const value = (event.data as unknown as Record<string, unknown>).pending;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pending = value as Record<string, unknown>;
  return typeof pending.steering === "number" && typeof pending.followUp === "number" && typeof pending.total === "number"
    ? { steering: pending.steering, followUp: pending.followUp, total: pending.total }
    : undefined;
}

function booleanData(event: DockEvent, key: string): boolean | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function thinkingData(event: DockEvent, key: string): ThinkingLevel | undefined {
  const value = (event.data as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : undefined;
}
