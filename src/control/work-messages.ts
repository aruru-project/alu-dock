import { shortenLastWords, type DockToolsRequest, type DockToolsResult, type WorkMessage, type WorkMessageSender } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import type { ObservedInstanceStatus } from "../core/instance-observation.js";
import type { ManagedInstance } from "../core/managed-instance.js";
import { observationStatus } from "./instance-observation-service.js";

interface WorkMessagesPort {
  /** Every Work this Host runs, including a crashed child Work that waits to be stopped. */
  live(): Iterable<ManagedInstance>;
  get(instanceId: string): ManagedInstance | undefined;
  now(): string;
}

/** The IDs Main gave a child Work created on this SubHost and its parent; the parent names them by these. */
interface MainIdentity { child: string; parent?: string }

const MAX_MAIN_IDENTITIES = 1_024;

type SendRequest = Extract<DockToolsRequest, { type: "send" }>;
type WorkMessageResult = Extract<DockToolsResult, { type: "work_message" }>;

/**
 * What a child Work owes its parent, counted by the numbers of the parent's messages to it; its task counts
 * as 0 (card #674). It owes a result while what is settled is behind what reached it, so a parent message
 * that crosses a final result for earlier work stays owed, in whatever order they arrive. Each fact is kept
 * apart, so none undoes another.
 */
interface Ledger {
  /** The next message's number. Numbers are never reused: a message that failed to arrive leaves a gap. */
  next: number;
  /** The latest message that reached it. */
  handed: number;
  /** The latest message its delivered final results answered. */
  answered: number;
  /** The latest message the parent took back by an interrupt or stop that went through, or was told the child left with. */
  closed: number;
  /** The parent's interrupts and stops of it still under way. */
  takingBack: number;
  /**
   * Stop reports that came meanwhile, decided once those answer: dropped if the work was taken back. Each
   * keeps this ledger, which a Stop that went through may already have forgotten.
   */
  held: Array<() => void>;
}

const owes = (ledger: Ledger): boolean => Math.max(ledger.answered, ledger.closed) < ledger.handed;

/**
 * Messages between a Work and its own child Works on the Host that runs both, and whether each child
 * Work still owes its parent a result (card #666). They reach the recipient as Work messages, never
 * through the user's input.
 */
export class WorkMessages {
  /** Per child Work, for the stops and crashes this Host sees itself. */
  private readonly ledgers = new Map<string, Ledger>();
  /** Per recipient, so the messages between one pair arrive in the order they were sent. */
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly mainIdentities = new Map<string, MainIdentity>();

  constructor(private readonly port: WorkMessagesPort) {}

  /** A child Work starts owing its parent the result of the task it was created for. */
  childStarted(childId: string): void { this.ledgers.set(childId, newLedger(-1)); }

  /** The source's own child Work that `target` names, by ID, Main's ID, key, name or ID prefix. */
  ownChild(source: InstanceSnapshot, target: string): ManagedInstance | "ambiguous" | undefined {
    const children = [...this.port.live()].filter((instance) => instance.parentId === source.id);
    const mainId = (child: ManagedInstance) => this.mainIdentities.get(child.id)?.child;
    const exact = children.find((child) => child.id === target || mainId(child) === target) ?? children.find((child) => child.key === target);
    if (exact) return exact;
    const matches = children.filter((child) => child.snapshot().name === target || child.id.startsWith(target) || mainId(child)?.startsWith(target) === true);
    return matches.length > 1 ? "ambiguous" : matches[0];
  }

  /** A child Work's message to its parent, or a parent's message to its own child Work. */
  async send(source: InstanceSnapshot, request: SendRequest, child: ManagedInstance | undefined): Promise<WorkMessageResult> {
    // A lead child Work names one of its own child Works; without a target it messages its parent.
    if (source.parentId !== undefined && request.target === undefined) {
      const parent = this.port.get(source.parentId);
      if (!parent || parent.snapshot().lifecycle !== "active") throw new Error("The Work that created you is no longer running, so nothing can reach it.");
      const ledger = this.ledgers.get(source.id);
      // What this result answers: the parent messages the child had read when it sent it.
      const settlesThrough = request.readThrough ?? ledger?.handed ?? 0;
      const done = request.done === true;
      await this.deliver(parent, { type: "message", from: this.childSender(source), text: request.message, ...(done ? { done, settlesThrough } : {}) }, () => {
        // Before anything queued after it is decided, such as Dock's notice that this child left.
        if (done && ledger) ledger.answered = Math.max(ledger.answered, settlesThrough);
      });
      return { type: "work_message", to: "parent", acceptedAt: this.port.now(), ...(done ? { done } : {}) };
    }
    if (request.done !== undefined) throw new Error("done marks a child Work's result for its parent; leave it out when you message a child Work.");
    if (!child) throw new Error(source.parentId === undefined ? "Name one of your child Works with target." : "Name one of your own child Works with target, or leave target out to message the Work that created you.");
    if (child.snapshot().lifecycle !== "active") throw new Error("That child Work is no longer running, so it cannot receive messages. Check it with dock_list.");
    const ledger = this.ledger(child.id);
    const number = ledger.next++;
    await this.deliver(child, { type: "message", from: { relation: "parent", id: source.id, name: source.displayName }, text: request.message, number });
    // It owes a reply to this message as well, even if it already finished its earlier work.
    ledger.handed = Math.max(ledger.handed, number);
    return { type: "work_message", to: "child", target: this.forParent(child.snapshot()), acceptedAt: this.port.now(), number };
  }

  /**
   * A child Work's Worker saw a turn carry its parent's work and end without its last call reaching the
   * parent, so the parent hears of it, for the parent messages that turn had read. It stays owed: a crash
   * later is reported too.
   */
  unreportedStop(source: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "unreported_stop" }>): Promise<Extract<DockToolsResult, { type: "unreported_stop" }>> {
    return this.reportUnreported(source, request, this.ledgers.get(source.id));
  }

  /**
   * The parent takes the work back by interrupting or stopping its child Work itself: every message sent so
   * far, through `settlesThrough`, a message still on its way included; the parent's own view settles that
   * too. Nothing changes until `answered` says whether the request went through; stop reports that come
   * meanwhile are decided then.
   */
  takeBack(childId: string): { settlesThrough: number; answered(succeeded: boolean): void } {
    const ledger = this.ledger(childId);
    const through = ledger.next - 1;
    ledger.takingBack += 1;
    return {
      settlesThrough: through,
      answered: (succeeded) => {
        ledger.takingBack -= 1;
        if (succeeded) ledger.closed = Math.max(ledger.closed, through);
        if (ledger.takingBack > 0) return;
        for (const report of ledger.held.splice(0)) report();
      },
    };
  }

  /** A child Work is stopping or crashed. Its parent hears of it once if a result was still owed, unless the parent is leaving too. */
  childLeaving(child: ManagedInstance): void {
    const ledger = this.ledgers.get(child.id);
    if (ledger) this.leaving(child, ledger);
  }

  private leaving(child: ManagedInstance, ledger: Ledger): void {
    if (ledger.takingBack > 0) {
      ledger.held.push(() => this.leaving(child, ledger));
      return;
    }
    if (!owes(ledger)) return;
    const snapshot = child.snapshot();
    const parent = snapshot.parentId === undefined ? undefined : this.port.get(snapshot.parentId);
    if (!parent || parent.snapshot().lifecycle !== "active") return;
    const crashed = snapshot.lifecycle === "runtime_error";
    const lastWords = child.lastAgentReply();
    // Decided when its turn comes: a final result queued before it may settle everything yet. Nothing follows,
    // so everything that reached it is settled once the notice arrives; one that failed to arrive is sent
    // again when the child is seen leaving next, as it is for stopping and then stopped.
    let through = ledger.handed;
    void this.deliver(parent, () => {
      if (!owes(ledger)) return undefined;
      through = ledger.handed;
      return {
        type: "child_stopped", from: this.childSender(snapshot), reason: crashed ? "crashed" : "stopped",
        ...(crashed && snapshot.lastError ? { error: shortenLastWords(snapshot.lastError) } : {}),
        ...(lastWords === undefined ? {} : { lastWords: shortenLastWords(lastWords) }),
        settlesThrough: through,
      };
    }, () => { ledger.closed = Math.max(ledger.closed, through); }).catch(() => { /* The parent's Worker is gone as well. */ });
  }

  private async reportUnreported(source: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "unreported_stop" }>, ledger: Ledger | undefined): Promise<Extract<DockToolsResult, { type: "unreported_stop" }>> {
    const parent = source.parentId === undefined ? undefined : this.port.get(source.parentId);
    if (!parent || parent.snapshot().lifecycle !== "active") return { type: "unreported_stop", notified: false };
    // While the parent is taking the work back, whether to tell it waits for that to answer.
    if (ledger && ledger.takingBack > 0) {
      ledger.held.push(() => { void this.reportUnreported(source, request, ledger).catch(() => { /* The parent's Worker is gone. */ }); });
      return { type: "unreported_stop", notified: false };
    }
    const readThrough = request.readThrough ?? ledger?.handed ?? 0;
    // The parent took back all that turn carried; a newer message that reaches it is owed a report again.
    if (ledger && readThrough <= ledger.closed) return { type: "unreported_stop", notified: false };
    await this.deliver(parent, {
      type: "child_stopped", from: this.childSender(source), reason: request.reason,
      ...(request.error === undefined ? {} : { error: request.error }),
      ...(request.lastWords === undefined ? {} : { lastWords: request.lastWords }),
      settlesThrough: readThrough,
    });
    return { type: "unreported_stop", notified: true };
  }

  /** What Main calls a child Work created here through Main, and its parent. */
  rememberMainIdentity(childId: string, identity: MainIdentity): void {
    this.mainIdentities.delete(childId);
    this.mainIdentities.set(childId, identity);
    while (this.mainIdentities.size > MAX_MAIN_IDENTITIES) this.mainIdentities.delete(this.mainIdentities.keys().next().value!);
  }

  /** A child Work's status as its parent knows it, under the IDs Main gave them. */
  forParent(child: InstanceSnapshot): ObservedInstanceStatus {
    const status = observationStatus(child);
    const main = this.mainIdentities.get(child.id);
    return main === undefined ? status : { ...status, id: main.child, ...(main.parent === undefined ? {} : { parentId: main.parent }) };
  }

  forget(instanceIds: readonly string[]): void {
    for (const id of instanceIds) {
      this.ledgers.delete(id);
      this.mainIdentities.delete(id);
    }
  }

  private ledger(childId: string): Ledger {
    let ledger = this.ledgers.get(childId);
    if (!ledger) this.ledgers.set(childId, ledger = newLedger(0));
    return ledger;
  }

  private childSender(child: InstanceSnapshot): WorkMessageSender {
    return { relation: "child", id: this.mainIdentities.get(child.id)?.child ?? child.id, name: child.displayName };
  }

  /**
   * After what is already on its way to the same recipient. `message` may be decided only when its turn comes,
   * and `delivered` runs as soon as it arrived, before the next one is decided.
   */
  private deliver(recipient: ManagedInstance, message: WorkMessage | (() => WorkMessage | undefined), delivered?: () => void): Promise<void> {
    const previous = this.deliveries.get(recipient.id) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      const decided = typeof message === "function" ? message() : message;
      if (decided === undefined) return;
      await recipient.deliverWorkMessage(decided);
      delivered?.();
    });
    const tail = delivery.then(() => undefined, () => undefined);
    this.deliveries.set(recipient.id, tail);
    void tail.finally(() => { if (this.deliveries.get(recipient.id) === tail) this.deliveries.delete(recipient.id); });
    return delivery;
  }
}

/** A child Work's ledger: its task, number 0, reached it; `answered` says whether that is settled. */
function newLedger(answered: number): Ledger {
  return { next: 1, handed: 0, answered, closed: -1, takingBack: 0, held: [] };
}
