import { INITIAL_WORK_PROGRESS, type WorkProgress } from "../core/work-progress.js";
import { shortenLastWords, type DockToolsRequest, type DockToolsResult, type WorkMessage, type WorkMessageSender } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/instance-dto.js";
import type { ObservedInstanceStatus } from "../core/instance-observation.js";
import type { ManagedInstance } from "../core/managed-instance.js";
import { observationStatus } from "./instance-observation-service.js";

/** Who receives a Work message: a Work this Host runs, or the parent on Main of a child Work here. */
export interface WorkMessageRecipient {
  readonly id: string;
  deliverWorkMessage(message: WorkMessage): Promise<void>;
}

/** The Work that hands a child Work its work, as the child Work knows it. */
export interface WorkParent { id: string; name: string }

interface WorkMessagesPort {
  /** A parent's direct children, including interrupted Works with no running process. */
  children(parentId: string): InstanceSnapshot[];
  /** A child Work's parent while it can take messages: one running here, or the resident assistant on Main. */
  parent(child: InstanceSnapshot): WorkMessageRecipient | undefined;
  save?(childId: string, progress: WorkProgress, effect: "pre_effect" | "post_effect"): Promise<void>;
  now(): string;
}

/** The IDs Main gave a child Work created on this SubHost and its parent; the parent names them by these. */
interface MainIdentity { child: string; parent?: string }

type SendRequest = Extract<DockToolsRequest, { type: "send" }>;
type WorkMessageResult = Extract<DockToolsResult, { type: "work_message" }>;

/**
 * What a child Work owes its parent, counted by the numbers of the parent's messages to it; its task counts
 * as 0 (card #674). It owes a result while what is settled is behind what reached it, so a parent message
 * that crosses a final result for earlier work stays owed, in whatever order they arrive. Each fact is kept
 * apart, so none undoes another.
 */
interface Ledger extends WorkProgress {
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
 * Messages between a Work and its own child Works on the Host that runs the child Work, and whether each
 * child Work still owes its parent a result (card #666). The parent runs here too, except the resident
 * assistant on Main, whose messages pass through Main (card #676). They reach the recipient as Work
 * messages, never through the user's input.
 */
export class WorkMessages {
  /** Per child Work, for the stops and crashes this Host sees itself. */
  private readonly ledgers = new Map<string, Ledger>();
  /** Per recipient, so the messages between one pair arrive in the order they were sent. */
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly mainIdentities = new Map<string, MainIdentity>();

  constructor(private readonly port: WorkMessagesPort) {}

  /** Creation alone hands the child no task. */
  childStarted(childId: string, progress: WorkProgress = INITIAL_WORK_PROGRESS): void {
    this.ledgers.set(childId, { ...progress, takingBack: 0, held: [] });
  }

  async issueFirstTask(id: string): Promise<void> {
    const ledger = this.ledger(id);
    if (ledger.next !== 0) return;
    ledger.next = 1;
    await this.save(id, ledger, "pre_effect");
  }

  restoreInbox(id: string, progress: WorkProgress): void {
    const ledger = this.ledger(id);
    ledger.handed = Math.max(ledger.handed, progress.handed);
    if (progress.checkedThrough !== undefined) ledger.checkedThrough = Math.max(ledger.checkedThrough ?? -1, progress.checkedThrough);
  }

  async receivedFirstTask(id: string): Promise<void> {
    const ledger = this.ledger(id);
    if (ledger.handed >= 0) return;
    ledger.handed = 0;
    await this.save(id, ledger);
  }

  /** The source's own child Work that `target` names, by ID, Main's ID, key, name or ID prefix. */
  ownChild(source: InstanceSnapshot, target: string): InstanceSnapshot | "ambiguous" | undefined {
    const children = this.port.children(source.id);
    const mainId = (child: InstanceSnapshot) => this.mainIdentities.get(child.id)?.child;
    const exact = children.find((child) => child.id === target || mainId(child) === target) ?? children.find((child) => child.key === target);
    if (exact) return exact;
    const matches = children.filter((child) => child.name === target || child.id.startsWith(target) || mainId(child)?.startsWith(target) === true);
    return matches.length > 1 ? "ambiguous" : matches[0];
  }

  /** A child Work's message to its parent, or a parent's message to its own child Work. */
  async send(source: InstanceSnapshot, request: SendRequest, child: ManagedInstance | undefined): Promise<WorkMessageResult> {
    // A lead child Work names one of its own child Works; without a target it messages its parent.
    if (source.parentId !== undefined && request.target === undefined) {
      const parent = this.port.parent(source);
      if (!parent) throw new Error("The Work that created you is no longer running, so nothing can reach it.");
      const ledger = this.ledgers.get(source.id);
      // What this result answers: the parent messages the child had read when it sent it.
      const settlesThrough = Math.min(request.readThrough ?? ledger?.handed ?? 0, ledger ? ledger.next - 1 : Number.MAX_SAFE_INTEGER);
      const done = request.done === true;
      await this.deliver(parent, { type: "message", from: this.childSender(source), text: request.message, ...(done ? { done, settlesThrough } : {}) }, () => {
        // Before anything queued after it is decided, such as Dock's notice that this child left.
        if (done && ledger && settlesThrough > ledger.answered) {
          ledger.answered = Math.max(ledger.answered, settlesThrough);
          return this.save(source.id, ledger);
        }
      });
      return { type: "work_message", to: "parent", acceptedAt: this.port.now(), ...(done ? { done } : {}) };
    }
    if (request.done !== undefined) throw new Error("done marks a child Work's result for its parent; leave it out when you message a child Work.");
    if (!child) throw new Error(source.parentId === undefined ? "Name one of your child Works with target." : "Name one of your own child Works with target, or leave target out to message the Work that created you.");
    return this.toChild({ id: source.id, name: source.displayName }, request.message, child);
  }

  /** A parent's message to its own child Work; a parent on Main sends it through Main. */
  async toChild(parent: WorkParent, text: string, child: ManagedInstance): Promise<WorkMessageResult> {
    if (child.snapshot().lifecycle !== "active") throw new Error("That child Work is no longer running, so it cannot receive messages. Check it with dock_list.");
    const ledger = this.ledger(child.id);
    const number = Math.max(1, ledger.next); // 0 belongs only to the initial spawn prompt.
    ledger.next = number + 1;
    await this.deliver(child, async () => {
      // Never send a number another Host run could reuse.
      await this.save(child.id, ledger, "pre_effect");
      return { type: "message", from: { relation: "parent", id: parent.id, name: parent.name }, text, number };
    }, () => {
      ledger.handed = Math.max(ledger.handed, number);
      return this.save(child.id, ledger);
    });
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
  takeBack(childId: string): { settlesThrough: number; answered(succeeded: boolean): Promise<void> } {
    const ledger = this.ledger(childId);
    const through = ledger.next - 1;
    ledger.takingBack += 1;
    return {
      settlesThrough: through,
      answered: async (succeeded) => {
        ledger.takingBack -= 1;
        if (succeeded) {
          ledger.closed = Math.max(ledger.closed, through);
          await this.save(childId, ledger);
        }
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
    const parent = snapshot.parentId === undefined ? undefined : this.port.parent(snapshot);
    if (!parent) return;
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
    }, () => { ledger.closed = Math.max(ledger.closed, through); return this.save(child.id, ledger); }).catch(() => { /* The parent's Worker is gone as well. */ });
  }

  private async reportUnreported(source: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "unreported_stop" }>, ledger: Ledger | undefined): Promise<Extract<DockToolsResult, { type: "unreported_stop" }>> {
    const parent = source.parentId === undefined ? undefined : this.port.parent(source);
    if (!parent) return { type: "unreported_stop", notified: false };
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
    this.mainIdentities.set(childId, identity); // forgotten with the catalog record, never while still reachable
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
    if (!ledger) this.ledgers.set(childId, ledger = { ...INITIAL_WORK_PROGRESS, takingBack: 0, held: [] });
    return ledger;
  }

  private save(id: string, { held: _held, takingBack: _takingBack, ...progress }: Ledger, effect: "pre_effect" | "post_effect" = "post_effect"): Promise<void> | undefined {
    return this.port.save?.(id, progress, effect);
  }

  private childSender(child: InstanceSnapshot): WorkMessageSender {
    return { relation: "child", id: this.mainIdentities.get(child.id)?.child ?? child.id, name: child.displayName };
  }

  /**
   * After what is already on its way to the same recipient. `message` may be decided only when its turn comes,
   * and `delivered` runs as soon as it arrived, before the next one is decided.
   */
  private deliver(recipient: WorkMessageRecipient, message: WorkMessage | (() => WorkMessage | undefined | Promise<WorkMessage>), delivered?: () => void | Promise<void>): Promise<void> {
    const previous = this.deliveries.get(recipient.id) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      const decided = typeof message === "function" ? await message() : message;
      if (decided === undefined) return;
      await recipient.deliverWorkMessage(decided);
      await delivered?.();
    });
    const tail = delivery.then(() => undefined, () => undefined);
    this.deliveries.set(recipient.id, tail);
    void tail.finally(() => { if (this.deliveries.get(recipient.id) === tail) this.deliveries.delete(recipient.id); });
    return delivery;
  }
}
