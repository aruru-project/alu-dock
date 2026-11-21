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
 * as 0 (card #674). It owes a result while what its final results settled is behind what reached it, so a
 * parent message that crosses a final result for earlier work stays owed, in whatever order they arrive.
 */
interface Ledger {
  /** The next message's number. Numbers are never reused: a message that failed to arrive leaves a gap. */
  next: number;
  /** The latest message that reached it. */
  handed: number;
  /** The latest message its final results answered, or that its parent took back by interrupting or stopping it. */
  settled: number;
  /**
   * The parent interrupted it after sending messages through this number and took that work back: no stop is
   * reported until a newer message reaches it. A message sent before the interrupt does not undo it, even
   * if it arrives later.
   */
  interruptedAt?: number;
}

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
  childStarted(childId: string): void { this.ledgers.set(childId, { next: 1, handed: 0, settled: -1 }); }

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
      await this.deliver(parent, { type: "message", from: this.childSender(source), text: request.message, ...(done ? { done, settlesThrough } : {}) });
      if (done && ledger) ledger.settled = Math.max(ledger.settled, settlesThrough);
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
    if (ledger.interruptedAt !== undefined && number > ledger.interruptedAt) delete ledger.interruptedAt;
    return { type: "work_message", to: "child", target: this.forParent(child.snapshot()), acceptedAt: this.port.now(), number };
  }

  /**
   * A child Work's Worker saw a turn carry its parent's work and end without its last call reaching the
   * parent, so the parent hears of it. Only the Worker knows what that turn still owed, so the child Work
   * owes the result again whatever the Host settled.
   */
  async unreportedStop(source: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "unreported_stop" }>): Promise<Extract<DockToolsResult, { type: "unreported_stop" }>> {
    const parent = source.parentId === undefined ? undefined : this.port.get(source.parentId);
    if (!parent || parent.snapshot().lifecycle !== "active") return { type: "unreported_stop", notified: false };
    const ledger = this.ledgers.get(source.id);
    // The parent interrupted it and took the work back; nothing is owed until the parent sends more.
    if (ledger?.interruptedAt !== undefined) return { type: "unreported_stop", notified: false };
    if (ledger) ledger.settled = Math.min(ledger.settled, ledger.handed - 1);
    await this.deliver(parent, {
      type: "child_stopped", from: this.childSender(source), reason: request.reason,
      ...(request.error === undefined ? {} : { error: request.error }),
      ...(request.lastWords === undefined ? {} : { lastWords: request.lastWords }),
      settlesThrough: ledger?.handed ?? 0,
    });
    return { type: "unreported_stop", notified: true };
  }

  /**
   * The parent takes the work back by interrupting or stopping its child Work itself. The returned function
   * undoes this when that request fails: the child Work may still be at work, and its stops matter again.
   */
  release(childId: string, interrupted: boolean): () => void {
    const ledger = this.ledger(childId);
    const before = { settled: ledger.settled, interruptedAt: ledger.interruptedAt };
    // Everything sent so far is taken back, a message still on its way included.
    const sent = ledger.next - 1;
    ledger.settled = Math.max(ledger.settled, sent);
    if (interrupted) ledger.interruptedAt = sent;
    const after = { settled: ledger.settled, interruptedAt: ledger.interruptedAt };
    return () => {
      // A result or a newer parent message that came meanwhile stays as it set things.
      if (ledger.settled === after.settled) ledger.settled = before.settled;
      if (ledger.interruptedAt === after.interruptedAt) ledger.interruptedAt = before.interruptedAt;
    };
  }

  /** A child Work is stopping or crashed. Its parent hears of it once if a result was still owed, unless the parent is leaving too. */
  childLeaving(child: ManagedInstance): void {
    const ledger = this.ledgers.get(child.id);
    if (!ledger || ledger.settled >= ledger.handed) return;
    ledger.settled = ledger.handed;
    const snapshot = child.snapshot();
    const parent = snapshot.parentId === undefined ? undefined : this.port.get(snapshot.parentId);
    if (!parent || parent.snapshot().lifecycle !== "active") return;
    const crashed = snapshot.lifecycle === "runtime_error";
    const lastWords = child.lastAgentReply();
    void this.deliver(parent, {
      type: "child_stopped", from: this.childSender(snapshot), reason: crashed ? "crashed" : "stopped",
      ...(crashed && snapshot.lastError ? { error: shortenLastWords(snapshot.lastError) } : {}),
      ...(lastWords === undefined ? {} : { lastWords: shortenLastWords(lastWords) }),
      settlesThrough: ledger.handed,
    }).catch(() => { /* The parent's Worker is gone as well. */ });
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
    if (!ledger) this.ledgers.set(childId, ledger = { next: 1, handed: 0, settled: 0 });
    return ledger;
  }

  private childSender(child: InstanceSnapshot): WorkMessageSender {
    return { relation: "child", id: this.mainIdentities.get(child.id)?.child ?? child.id, name: child.displayName };
  }

  private deliver(recipient: ManagedInstance, message: WorkMessage): Promise<void> {
    const previous = this.deliveries.get(recipient.id) ?? Promise.resolve();
    const delivery = previous.then(() => recipient.deliverWorkMessage(message));
    const tail = delivery.then(() => undefined, () => undefined);
    this.deliveries.set(recipient.id, tail);
    void tail.finally(() => { if (this.deliveries.get(recipient.id) === tail) this.deliveries.delete(recipient.id); });
    return delivery;
  }
}
