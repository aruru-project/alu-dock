import type { DockEvent, InstanceSnapshot } from "../core/managed-instance.js";

export type RunActivityPhase =
  | "idle"
  | "submitting"
  | "waiting"
  | "thinking"
  | "responding"
  | "retry"
  | "compaction"
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
  if (snapshot.lifecycle === "host_lost") return { phase: "disconnected", label: "agent lost" };
  if (snapshot.lifecycle === "runtime_error") return { phase: "error", label: "agent crashed" };
  if (snapshot.compacting) return { phase: "compaction", label: "compacting context" };
  if (snapshot.execution === "running") return { phase: "waiting", label: "waiting for model" };
  if (snapshot.execution === "failed") return { phase: "error", label: "run failed" };
  return READY;
}

export function submittingActivity(): RunActivityState {
  return { phase: "submitting", label: "submitting" };
}

export function abortingActivity(): RunActivityState {
  return { phase: "aborting", label: "aborting" };
}

export function disconnectedActivity(label = "connection interrupted"): RunActivityState {
  return { phase: "disconnected", label };
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

/**
 * Project one authoritative top-level runtime phase. Queue state belongs to the
 * pending tray and tool execution belongs to conversation surfaces; neither is
 * allowed to replace model activity.
 */
export function reduceRunActivity(
  current: RunActivityState,
  event: DockEvent,
  snapshot: InstanceSnapshot,
): RunActivityState {
  if (snapshot.lifecycle !== "active") return activityFromSnapshot(snapshot);

  // Compaction is a newer explicit boundary and outranks stale run/tool/queue
  // events until its own completion arrives.
  if (snapshot.compacting && event.type !== "compaction.completed") {
    return { phase: "compaction", label: "compacting context" };
  }

  switch (event.type) {
    case "command.accepted":
      // Admission reserves Host state before Pi proves a model run. Only the
      // later run.started boundary may turn a local submission into waiting.
      return current;

    case "command.handled":
    case "command.rejected":
      // The outcome event precedes its authoritative state snapshot. Keep a
      // hidden/local submit phase across that brief stale-running window.
      if (current.phase === "submitting" && snapshot.execution === "running") return current;
      return snapshot.execution === "running" ? preserveActiveModelPhase(current, snapshot) : activityFromSnapshot(snapshot);

    case "run.started":
      return hasOperationBoundary(current)
        ? current
        : { phase: "waiting", label: "waiting for model" };

    case "message.delta":
      if (hasOperationBoundary(current)) return current;
      return event.data.block === "thinking"
        ? { phase: "thinking", label: "thinking" }
        : { phase: "responding", label: "responding" };

    case "message.submitted":
      return current;

    case "message.completed":
      if (hasOperationBoundary(current)) return current;
      return event.data.role === "assistant" && snapshot.execution === "running"
        ? { phase: "waiting", label: "waiting for model" }
        : current;

    case "tool.started":
    case "tool.args_updated":
    case "tool.output_updated":
    case "tool.completed":
    case "message.queued":
    case "queue.changed":
    case "queue.cleared":
      return preserveActiveModelPhase(current, snapshot);

    case "run.retry_started":
      return { phase: "retry", label: `retry ${event.data.attempt}/${event.data.maxAttempts}` };

    case "run.retry_completed":
      return event.data.success
        ? activityFromSnapshot(snapshot)
        : { phase: "error", label: "retry stopped · review the conversation" };

    case "compaction.started":
      return { phase: "compaction", label: "compacting context" };

    case "compaction.completed":
      return activityFromSnapshot(snapshot);

    case "interaction.requested":
      return { phase: "interaction", label: "waiting for your answer" };

    case "interaction.resolved":
    case "interaction.cancelled":
      return current.phase === "interaction" ? activityFromSnapshot(snapshot) : current;

    case "run.settled":
      // Pi may publish an older run settlement after an extension has already
      // opened compaction or an interaction boundary.
      if (current.phase === "compaction" || current.phase === "interaction") return current;
      return activityFromSnapshot(snapshot);

    case "session.replaced":
      return READY;

    case "instance.state_changed":
      if (snapshot.compacting) return { phase: "compaction", label: "compacting context" };
      if (snapshot.execution === "running") return current.phase === "submitting" ? current : preserveActiveModelPhase(current, snapshot);
      return activityFromSnapshot(snapshot);

    case "instance.stopped":
      return { phase: "disconnected", label: "stopped" };

    case "instance.runtime_error":
      return { phase: "error", label: "agent crashed" };

    case "instance.error":
    case "settings.write_failed":
    case "extension.notification":
    case "extension.error":
      return preserveActiveModelPhase(current, snapshot);

    default:
      return current;
  }
}

function preserveActiveModelPhase(current: RunActivityState, snapshot: InstanceSnapshot): RunActivityState {
  if (hasOperationBoundary(current) || isModelPhase(current.phase)) return current;
  return activityFromSnapshot(snapshot);
}

function isModelPhase(phase: RunActivityPhase): boolean {
  return phase === "waiting" || phase === "thinking" || phase === "responding";
}

function hasOperationBoundary(current: RunActivityState): boolean {
  return current.phase === "compaction"
    || current.phase === "retry"
    || current.phase === "interaction"
    || current.phase === "aborting";
}
