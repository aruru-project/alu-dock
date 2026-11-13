import type { DockToolsResult, WorkMessage } from "../core/dock-tools.js";

export const DEFAULT_WAIT_SECONDS = 1_800;
export const MAX_WAIT_SECONDS = 7_200;
/** How often dock_wait checks whether a message from the user is waiting for this Work. */
const WAIT_POLL_MS = 200;
/** Child Works whose last finish is remembered, to tell a finish that came before its call's result. */
const MAX_REMEMBERED_FINISHES = 64;

/** A child Work this Work handed work to. */
export interface OwedChild { id: string; name: string }

/** What dock_wait saw: the messages from child Works it took, and why it stopped waiting. */
export interface ChildWaitResult {
  messages: WorkMessage[];
  /** Child Works that still owe a result. */
  waiting: OwedChild[];
  ended: "received" | "nothing_pending" | "message" | "timeout" | "cancelled";
  timeoutSeconds?: number;
}

/**
 * Which child Works owe this Work a result, for dock_wait (card #666). A child owes one from the time it is
 * handed work until its final result arrives or Dock says it stopped.
 */
export class ChildMessages {
  private readonly owed = new Map<string, OwedChild>();
  /** When each child Work last finished, on a counter that orders finishes and calls. */
  private readonly finishes = new Map<string, number>();
  private count = 0;
  private waiter: { take(message: WorkMessage): void } | undefined;

  /** Read before a Dock call, so a finish that arrives before the call returns is not awaited again. */
  get position(): number { return this.count; }

  noteWork(result: DockToolsResult, before: number): void {
    // Stopping or interrupting a child Work takes its work back; Dock tells nothing more about it.
    if (result.type === "stop" || result.type === "interrupt") {
      this.owed.delete(result.instance.id);
      return;
    }
    const child = result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined ? result.instance
      : result.type === "work_message" && result.to === "child" ? result.target
        : undefined;
    // A child that failed or finished at once may have reported before this call returned.
    if (child && (this.finishes.get(child.id) ?? 0) <= before) this.owed.set(child.id, { id: child.id, name: child.name ?? child.id });
  }

  /** A message to this Work. True when a running dock_wait took it as its result. */
  receive(message: WorkMessage): boolean {
    if (message.from.relation !== "child") return false;
    if (finished(message)) {
      const id = message.from.id;
      this.owed.delete(id);
      this.finishes.delete(id);
      this.finishes.set(id, ++this.count);
      if (this.finishes.size > MAX_REMEMBERED_FINISHES) this.finishes.delete(this.finishes.keys().next().value!);
    }
    if (!this.waiter) return false;
    this.waiter.take(message);
    return true;
  }

  /**
   * Waits in the current turn for child Works. Messages that arrive meanwhile, and those that already
   * arrived in this step, are its result instead of separate messages. A message that is not a final
   * result may be a question, so it ends the wait at once.
   */
  async wait(
    request: { target?: string; all?: boolean; timeoutSeconds?: number },
    signal: AbortSignal | undefined,
    hasPendingMessages: () => boolean,
    arrived: readonly WorkMessage[],
  ): Promise<ChildWaitResult> {
    if (this.waiter) throw new Error("dock_wait is already waiting in another call.");
    const owed = [...this.owed.values()];
    const named = (child: { id: string; name: string }) => child.id === request.target || child.name === request.target;
    const chosen = request.target === undefined ? owed : owed.filter(named);
    if (chosen.length > 1 && request.target !== undefined) throw new Error(`More than one child Work is named ${request.target}; use its id.`);
    // Messages name their sender by ID and display name, which may differ from the name asked for.
    const chosenIds = new Set(chosen.map((child) => child.id));
    const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
    const messages: WorkMessage[] = [];
    let ended: ChildWaitResult["ended"] | undefined;
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const finish = (reason: ChildWaitResult["ended"]): void => { ended ??= reason; wake(); };
    const take = (message: WorkMessage): void => {
      messages.push(message);
      if (!finished(message)) finish("received");
      else if (request.all === true ? chosen.every((child) => !this.owed.has(child.id)) : request.target === undefined || chosenIds.has(message.from.id)) finish("received");
    };
    for (const message of arrived) take(message);
    const result = (): ChildWaitResult => ({
      messages, waiting: [...this.owed.values()], ended: ended!,
      ...(ended === "timeout" ? { timeoutSeconds } : {}),
    });
    if (ended) return result();
    if (chosen.length === 0) return { messages, waiting: [...this.owed.values()], ended: messages.length > 0 ? "received" : "nothing_pending" };
    const waiter = { take };
    this.waiter = waiter;
    const timer = setTimeout(() => finish("timeout"), timeoutSeconds * 1_000);
    const poll = setInterval(() => { if (hasPendingMessages()) finish("message"); }, WAIT_POLL_MS);
    const cancel = (): void => finish("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (hasPendingMessages()) finish("message");
    try {
      await woken;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", cancel);
      if (this.waiter === waiter) this.waiter = undefined;
    }
    return result();
  }
}

/** A child Work's final result, or Dock's notice that it stopped without one. */
function finished(message: WorkMessage): boolean {
  return message.type === "child_stopped" || message.done === true;
}
