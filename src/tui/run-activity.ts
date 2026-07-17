import type { DockEvent, InstanceSnapshot } from "../core/managed-instance.js";
import { knownCompactionFeedback } from "./compaction-feedback.js";

export type RunActivityPhase =
  | "idle"
  | "submitting"
  | "waiting"
  | "thinking"
  | "responding"
  | "tool"
  | "retry"
  | "compaction"
  | "queued"
  | "interaction"
  | "aborting"
  | "disconnected"
  | "error";

export interface RunActivityState {
  phase: RunActivityPhase;
  label: string;
}

const READY: RunActivityState = { phase: "idle", label: "ready" };

export function activityFromSnapshot(snapshot: InstanceSnapshot): RunActivityState {
  if (snapshot.lifecycle === "stopped") return { phase: "disconnected", label: "stopped" };
  if (snapshot.lifecycle === "host_lost") return { phase: "disconnected", label: "host lost" };
  if (snapshot.lifecycle === "runtime_error") return { phase: "error", label: "runtime error" };
  if (snapshot.execution === "running") return { phase: "waiting", label: "waiting for model" };
  if (snapshot.pending.total > 0) return queued(snapshot.pending.total);
  return READY;
}

export function submittingActivity(): RunActivityState {
  return { phase: "submitting", label: "submitting" };
}

export function abortingActivity(): RunActivityState {
  return { phase: "aborting", label: "aborting" };
}

export function disconnectedActivity(label = "host stream closed"): RunActivityState {
  return { phase: "disconnected", label };
}

export function errorActivity(label = "error"): RunActivityState {
  return { phase: "error", label };
}

/** Recover the most specific current phase when attaching to an already-running instance. */
export function activityFromReplay(
  snapshot: InstanceSnapshot,
  events: readonly DockEvent[],
): RunActivityState {
  let activity = activityFromSnapshot(snapshot);
  if (snapshot.lifecycle !== "active" || snapshot.execution !== "running") return activity;
  for (const event of events) {
    if (event.runtimeGeneration !== snapshot.runtimeGeneration) continue;
    activity = reduceRunActivity(activity, event, snapshot);
  }
  return activity.phase === "idle" ? activityFromSnapshot(snapshot) : activity;
}

/** Reduce typed Host events into one honest, promptly-cleared activity indicator. */
export function reduceRunActivity(
  current: RunActivityState,
  event: DockEvent,
  snapshot: InstanceSnapshot,
): RunActivityState {
  if (snapshot.lifecycle !== "active") return activityFromSnapshot(snapshot);

  switch (event.type) {
    case "command.accepted":
      if (event.data.queued) return queued(snapshot.pending.total || 1);
      if (snapshot.execution === "running" && snapshot.activeCommandId !== undefined && snapshot.activeCommandId !== event.data.operationId) {
        return current.phase === "idle" ? activityFromSnapshot(snapshot) : current;
      }
      return { phase: "waiting", label: "waiting for model" };

    case "command.handled":
      if (snapshot.execution === "running") return current.phase === "idle" ? activityFromSnapshot(snapshot) : current;
      if (snapshot.pending.total > 0) return queued(snapshot.pending.total);
      return current.phase === "idle" && current.label !== READY.label ? current : READY;

    case "command.rejected":
      return { phase: "error", label: "command rejected" };

    case "run.started":
    case "message.submitted":
      return { phase: "waiting", label: "waiting for model" };

    case "message.delta":
      return event.data.block === "thinking"
        ? { phase: "thinking", label: "thinking" }
        : { phase: "responding", label: "responding" };

    case "message.completed":
      if (current.phase === "tool") return current;
      return event.data.role === "assistant" && snapshot.execution === "running"
        ? { phase: "waiting", label: "waiting for model" }
        : current;

    case "tool.started":
    case "tool.args_updated":
    case "tool.output_updated": {
      const toolName = event.type === "tool.started" ? event.data.toolName : undefined;
      return {
        phase: "tool",
        label: toolName ? `tool ${toolName}` : current.phase === "tool" ? current.label : "tool running",
      };
    }

    case "tool.completed":
      return snapshot.execution === "running"
        ? { phase: "waiting", label: "waiting for model" }
        : activityFromSnapshot(snapshot);

    case "run.retry_started":
      return {
        phase: "retry",
        label: `retry ${event.data.attempt}/${event.data.maxAttempts}`,
      };

    case "run.retry_completed":
      return event.data.success
        ? { phase: "waiting", label: "waiting for model" }
        : { phase: "error", label: "retry failed" };

    case "compaction.started":
      return { phase: "compaction", label: "compacting context" };

    case "compaction.completed":
      if (event.data.aborted) return { phase: "idle", label: "compaction cancelled" };
      const known = knownCompactionFeedback(event.data.error);
      if (known) return { phase: "idle", label: known === "already_compacted" ? "already compacted" : "nothing to compact" };
      if (event.data.error) return { phase: "error", label: "compaction failed" };
      return { phase: "idle", label: "compacted" };

    case "queue.changed":
      if (snapshot.execution === "running") return current.phase === "idle" ? activityFromSnapshot(snapshot) : current;
      return event.data.total > 0 ? queued(event.data.total) : READY;

    case "queue.cleared":
      return snapshot.execution === "running" ? current : READY;

    case "interaction.requested":
      return { phase: "interaction", label: `waiting for ${event.data.method}` };

    case "interaction.resolved":
    case "interaction.cancelled":
      return activityFromSnapshot(snapshot);

    case "run.settled":
      return snapshot.pending.total > 0 ? queued(snapshot.pending.total) : READY;

    case "session.replaced":
      return READY;

    case "instance.state_changed":
      if (event.data.execution === "running" && current.phase === "idle") {
        if (event.data.reason === "compaction_completed" && [
          "compacted", "nothing to compact", "already compacted", "compaction cancelled",
        ].includes(current.label)) return current;
        return { phase: "waiting", label: "waiting for model" };
      }
      if (event.data.execution !== "running" && event.data.pending.total === 0) {
        return current.phase === "idle" && current.label !== READY.label ? current : READY;
      }
      return current;

    case "instance.stopped":
      return { phase: "disconnected", label: "stopped" };

    case "instance.runtime_error":
    case "instance.error":
    case "settings.write_failed":
      return { phase: "error", label: "error" };

    case "extension.notification":
      return event.data.level === "info"
        ? { phase: "idle", label: event.data.message }
        : current;

    case "extension.error":
      return current;

    default:
      return current;
  }
}

function queued(total: number): RunActivityState {
  return { phase: "queued", label: `queued ${Math.max(1, total)}` };
}
