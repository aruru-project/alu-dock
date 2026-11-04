import type { DockToolsResult } from "../core/dock-tools.js";
import {
  MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE,
  type ObservationNotification,
  type ObservedInstanceStatus,
} from "../core/instance-observation.js";
import type { ChildWaitResult } from "./dock-tools-client.js";

export const DEFAULT_WAIT_SECONDS = 1_800;
export const MAX_WAIT_SECONDS = 7_200;
/** How often dock_wait checks whether a message is waiting for this Work. */
const WAIT_POLL_MS = 200;

/**
 * Which child Works owe this Work a reply, for dock_wait. A child owes one from the time it
 * is handed work until its reply arrives or it is stopped. Cancelling every watch or turning
 * Dock tools off cancels the Host watches that bring replies back, so nothing is owed then.
 */
export class ChildReplies {
  private readonly awaited = new Map<string, ObservedInstanceStatus>();
  /** When each Work's reply last arrived, on a counter that orders replies and calls. */
  private readonly lastReplies = new Map<string, number>();
  private replyCount = 0;
  private waiter: { ids: ReadonlySet<string>; all: boolean; replies: ObservationNotification[]; finish(ended: ChildWaitResult["ended"]): void } | undefined;

  /** Read before a Dock call, so a reply that arrives before the call returns is not awaited again. */
  get position(): number { return this.replyCount; }

  noteWork(result: DockToolsResult, before: number): void {
    if (result.type === "stop") {
      this.awaited.delete(result.instance.id);
      return;
    }
    const child = result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined ? result.instance
      : result.type === "send" && result.target.parentId !== undefined && result.error === undefined ? result.target
        : undefined;
    // A child that failed or finished at once may have replied before this call returned.
    if (child && (this.lastReplies.get(child.id) ?? 0) <= before) this.awaited.set(child.id, child);
  }

  noteReply(notification: ObservationNotification): void {
    const id = notification.target.id;
    this.awaited.delete(id);
    this.lastReplies.delete(id);
    this.lastReplies.set(id, ++this.replyCount);
    if (this.lastReplies.size > MAX_OBSERVATION_ACTIVE_WATCHES_PER_SOURCE) this.lastReplies.delete(this.lastReplies.keys().next().value!);
  }

  /** Hands a reply to a running dock_wait that waits for it; false leaves it to be delivered as a message. */
  take(notification: ObservationNotification): boolean {
    const waiter = this.waiter;
    if (!waiter?.ids.has(notification.target.id)) return false;
    this.noteReply(notification);
    waiter.replies.push(notification);
    if (!waiter.all || waiter.replies.length === waiter.ids.size) waiter.finish("replied");
    return true;
  }

  cancelAll(): void {
    this.awaited.clear();
    this.waiter?.finish("cancelled");
  }

  /**
   * Waits in the current turn until awaited children reply, a message reaches this Work, the
   * user cancels, or time runs out. Replies it takes are returned instead of sent separately.
   */
  async wait(
    request: { target?: string; all?: boolean; timeoutSeconds?: number },
    signal: AbortSignal | undefined,
    hasPendingMessages: () => boolean,
  ): Promise<ChildWaitResult> {
    if (this.waiter) throw new Error("dock_wait is already waiting in another call.");
    const awaited = [...this.awaited.values()];
    const chosen = request.target === undefined ? awaited : awaited.filter((status) => status.id === request.target || status.name === request.target);
    if (chosen.length > 1 && request.target !== undefined) throw new Error(`More than one child Work is named ${request.target}; use its id.`);
    if (chosen.length === 0) return { replies: [], waiting: [], ended: "nothing_pending" };
    const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
    let ended: ChildWaitResult["ended"] | undefined;
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const waiter = {
      ids: new Set(chosen.map((status) => status.id)), all: request.all === true, replies: [] as ObservationNotification[],
      finish: (reason: ChildWaitResult["ended"]) => { ended ??= reason; wake(); },
    };
    this.waiter = waiter;
    const timer = setTimeout(() => waiter.finish("timeout"), timeoutSeconds * 1_000);
    const poll = setInterval(() => { if (hasPendingMessages()) waiter.finish("message"); }, WAIT_POLL_MS);
    const cancel = (): void => waiter.finish("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (hasPendingMessages()) waiter.finish("message");
    try {
      await woken;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", cancel);
      if (this.waiter === waiter) this.waiter = undefined;
    }
    return {
      replies: waiter.replies,
      waiting: chosen.filter((status) => this.awaited.has(status.id)),
      ended: ended!,
      ...(ended === "timeout" ? { timeoutSeconds } : {}),
    };
  }
}
