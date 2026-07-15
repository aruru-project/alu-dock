import type { DockEvent, InstanceSnapshot } from "../core/managed-instance.js";

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
  animated: boolean;
}

const READY: RunActivityState = { phase: "idle", label: "ready", animated: false };

export function activityFromSnapshot(snapshot: InstanceSnapshot): RunActivityState {
  if (snapshot.lifecycle === "stopped") return { phase: "disconnected", label: "stopped", animated: false };
  if (snapshot.lifecycle === "host_lost") return { phase: "disconnected", label: "host lost", animated: false };
  if (snapshot.lifecycle === "runtime_error") return { phase: "error", label: "runtime error", animated: false };
  if (snapshot.execution === "running") return { phase: "waiting", label: "waiting for model", animated: true };
  if (snapshot.pending.total > 0) return queued(snapshot.pending.total);
  return READY;
}

export function submittingActivity(): RunActivityState {
  return { phase: "submitting", label: "submitting", animated: true };
}

export function abortingActivity(): RunActivityState {
  return { phase: "aborting", label: "aborting", animated: true };
}

export function disconnectedActivity(label = "host stream closed"): RunActivityState {
  return { phase: "disconnected", label, animated: false };
}

export function errorActivity(label = "error"): RunActivityState {
  return { phase: "error", label, animated: false };
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
      return event.data.queued
        ? queued(snapshot.pending.total || 1)
        : { phase: "waiting", label: "waiting for model", animated: true };

    case "command.handled":
      return snapshot.pending.total > 0 ? queued(snapshot.pending.total) : READY;

    case "command.rejected":
      return { phase: "error", label: "command rejected", animated: false };

    case "run.started":
      return { phase: "waiting", label: "waiting for model", animated: true };

    case "message.delta":
      return event.data.block === "thinking"
        ? { phase: "thinking", label: "thinking", animated: true }
        : { phase: "responding", label: "responding", animated: true };

    case "message.completed":
      if (current.phase === "tool") return current;
      return event.data.role === "assistant" && snapshot.execution === "running"
        ? { phase: "waiting", label: "waiting for model", animated: true }
        : current;

    case "tool.started":
    case "tool.args_updated":
    case "tool.output_updated": {
      const toolName = event.type === "tool.started" ? event.data.toolName : undefined;
      return {
        phase: "tool",
        label: toolName ? `tool ${toolName}` : current.phase === "tool" ? current.label : "tool running",
        animated: true,
      };
    }

    case "tool.completed":
      return snapshot.execution === "running"
        ? { phase: "waiting", label: "waiting for model", animated: true }
        : activityFromSnapshot(snapshot);

    case "run.retry_started":
      return {
        phase: "retry",
        label: `retry ${event.data.attempt}/${event.data.maxAttempts}`,
        animated: true,
      };

    case "run.retry_completed":
      return event.data.success
        ? { phase: "waiting", label: "waiting for model", animated: true }
        : { phase: "error", label: "retry failed", animated: false };

    case "compaction.started":
      return { phase: "compaction", label: "compacting context", animated: true };

    case "compaction.completed":
      if (event.data.error) return { phase: "error", label: "compaction failed", animated: false };
      if (event.data.willRetry || snapshot.execution === "running") {
        return { phase: "waiting", label: "waiting for model", animated: true };
      }
      return activityFromSnapshot(snapshot);

    case "queue.changed":
      if (snapshot.execution === "running") return current.phase === "idle" ? activityFromSnapshot(snapshot) : current;
      return event.data.total > 0 ? queued(event.data.total) : READY;

    case "queue.cleared":
      return snapshot.execution === "running" ? current : READY;

    case "interaction.requested":
      return { phase: "interaction", label: `waiting for ${event.data.method}`, animated: true };

    case "interaction.resolved":
    case "interaction.cancelled":
      return activityFromSnapshot(snapshot);

    case "run.settled":
      return snapshot.pending.total > 0 ? queued(snapshot.pending.total) : READY;

    case "session.replaced":
      return READY;

    case "instance.state_changed":
      if (event.data.execution === "running" && current.phase === "idle") {
        return { phase: "waiting", label: "waiting for model", animated: true };
      }
      if (event.data.execution !== "running" && event.data.pending.total === 0) return READY;
      return current;

    case "instance.stopped":
      return { phase: "disconnected", label: "stopped", animated: false };

    case "instance.runtime_error":
    case "instance.error":
    case "settings.write_failed":
      return { phase: "error", label: "error", animated: false };

    case "extension.error":
      return current;

    default:
      return current;
  }
}

function queued(total: number): RunActivityState {
  return { phase: "queued", label: `queued ${Math.max(1, total)}`, animated: true };
}
