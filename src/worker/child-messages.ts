import type { DockToolsResult, WorkMessage } from "../core/dock-tools.js";

export const DEFAULT_WAIT_SECONDS = 1_800;
export const MAX_WAIT_SECONDS = 7_200;
/** How often dock_wait checks whether a message from the user is waiting for this Work. */
const WAIT_POLL_MS = 200;
/** Child Works that owe nothing are remembered this long, for a result that arrives before its call's receipt. */
const MAX_SETTLED_CHILDREN = 64;

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
 * What one child Work owes this Work, by the numbers the Host gives this Work's messages to it; its task
 * counts as 0 (card #674). Numbers make the order things arrive in irrelevant: a final result for earlier
 * work leaves a newer message owed, and one that arrives before its message's receipt still answers it.
 */
interface ChildLedger extends OwedChild {
  /** The latest work handed to it, by its receipt. */
  handed: number;
  /** The latest work its final results or Dock's stop notices settled, or this Work took back. */
  settled: number;
}

/**
 * Which child Works owe this Work a result, for dock_wait (card #666). A child owes one from the time it is
 * handed work until its final result for that work arrives or Dock says it stopped.
 */
export class ChildMessages {
  /** Oldest first, so the child Works that owe nothing longest are forgotten first. */
  private readonly ledgers = new Map<string, ChildLedger>();
  private waiter: { take(message: WorkMessage): void } | undefined;

  progress(id: string): Pick<ChildLedger, "handed" | "settled"> | undefined {
    const child = this.ledgers.get(id);
    return child && { handed: child.handed, settled: child.settled };
  }

  restore(children: readonly ChildLedger[]): void {
    for (const child of children) this.ledgers.set(child.id, { ...child });
    this.forgetSettled();
  }

  /** The child Works that still owe this Work a result. */
  get waiting(): OwedChild[] {
    return [...this.ledgers.values()].filter(owes).map(({ id, name }) => ({ id, name }));
  }

  noteWork(result: DockToolsResult): void {
    // Stopping or interrupting a child Work takes its work back; Dock tells nothing more about it.
    // Only what the Host took back by it: a message sent after it is still owed, whichever receipt comes first.
    if (result.type === "stop" || result.type === "interrupt") {
      const ledger = this.ledger(result.instance.id, result.instance.name ?? result.instance.id);
      ledger.settled = Math.max(ledger.settled, result.settlesThrough ?? ledger.handed);
      this.forgetSettled();
      return;
    }
    if (result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined) this.hand(result.instance, 0);
    else if (result.type === "work_message" && result.to === "child") this.hand(result.target, result.number);
  }

  /** A message to this Work. True when a running dock_wait took it as its result. */
  receive(message: WorkMessage): boolean {
    if (message.from.relation !== "child") return false;
    if (message.type === "child_stopped" || message.done === true) {
      const ledger = this.ledger(message.from.id, message.from.name);
      // Without a number, from an older Host: it settles everything.
      ledger.settled = Math.max(ledger.settled, message.settlesThrough ?? Number.MAX_SAFE_INTEGER);
      this.forgetSettled();
    }
    if (!this.waiter) return false;
    this.waiter.take(message);
    return true;
  }

  /** It still owes this Work the result of the latest work handed to it. */
  owes(id: string): boolean {
    const ledger = this.ledgers.get(id);
    return ledger !== undefined && owes(ledger);
  }

  private hand(child: { id: string; name?: string }, number: number): void {
    const ledger = this.ledger(child.id, child.name ?? child.id);
    ledger.handed = Math.max(ledger.handed, number);
    this.forgetSettled();
  }

  private ledger(id: string, name: string): ChildLedger {
    let ledger = this.ledgers.get(id);
    if (ledger) this.ledgers.delete(id);
    else ledger = { id, name, handed: -1, settled: -1 };
    ledger.name = name;
    this.ledgers.set(id, ledger);
    return ledger;
  }

  /**
   * A child Work whose last result and last receipt agree is remembered only so long. One whose result came
   * before its call's receipt is kept until the receipt pairs with it, or it would owe that work again.
   */
  private forgetSettled(): void {
    const settled = [...this.ledgers.values()].filter((ledger) => ledger.settled === ledger.handed);
    for (const ledger of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_CHILDREN))) this.ledgers.delete(ledger.id);
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
    const owed = this.waiting;
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
      // A question, a finding, or a final result for earlier work: answer it now. receive() counted it already.
      const final = message.type === "child_stopped" || message.done === true;
      if (!final || this.owes(message.from.id)) finish("received");
      else if (request.all === true ? chosen.every((child) => !this.owes(child.id)) : request.target === undefined || chosenIds.has(message.from.id)) finish("received");
    };
    for (const message of arrived) take(message);
    const result = (): ChildWaitResult => ({
      messages, waiting: this.waiting, ended: ended!,
      ...(ended === "timeout" ? { timeoutSeconds } : {}),
    });
    if (ended) return result();
    if (chosen.length === 0) return { messages, waiting: this.waiting, ended: messages.length > 0 ? "received" : "nothing_pending" };
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

function owes(ledger: ChildLedger): boolean { return ledger.settled < ledger.handed; }
