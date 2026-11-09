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
 * Messages between a Work and its own child Works on the Host that runs both, and whether each child
 * Work still owes its parent a result (card #666). They reach the recipient as Work messages, never
 * through the user's input.
 */
export class WorkMessages {
  /** Child Works that owe their parent a result: from their task, and again after each parent message, until a final message. */
  private readonly owing = new Set<string>();
  /** Per recipient, so the messages between one pair arrive in the order they were sent. */
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly mainIdentities = new Map<string, MainIdentity>();

  constructor(private readonly port: WorkMessagesPort) {}

  /** A child Work starts owing its parent the result of the task it was created for. */
  childStarted(childId: string): void { this.owing.add(childId); }

  /** The source's own child Work that `target` names, by ID, Main's ID, key, name or ID prefix. */
  ownChild(source: InstanceSnapshot, target: string): ManagedInstance | "ambiguous" | undefined {
    if (source.parentId !== undefined) return undefined;
    const children = [...this.port.live()].filter((instance) => instance.parentId === source.id);
    const mainId = (child: ManagedInstance) => this.mainIdentities.get(child.id)?.child;
    const exact = children.find((child) => child.id === target || mainId(child) === target) ?? children.find((child) => child.key === target);
    if (exact) return exact;
    const matches = children.filter((child) => child.snapshot().name === target || child.id.startsWith(target) || mainId(child)?.startsWith(target) === true);
    return matches.length > 1 ? "ambiguous" : matches[0];
  }

  /** A child Work's message to its parent, or a parent's message to its own child Work. */
  async send(source: InstanceSnapshot, request: SendRequest, child: ManagedInstance | undefined): Promise<WorkMessageResult> {
    if (source.parentId !== undefined) {
      const parent = this.port.get(source.parentId);
      if (!parent || parent.snapshot().lifecycle !== "active") throw new Error("The Work that created you is no longer running, so nothing can reach it.");
      const done = request.done === true;
      await this.deliver(parent, { type: "message", from: this.childSender(source), text: request.message, ...(done ? { done } : {}) });
      if (done) this.owing.delete(source.id);
      return { type: "work_message", to: "parent", target: observationStatus(parent.snapshot()), acceptedAt: this.port.now(), ...(done ? { done } : {}) };
    }
    if (request.done !== undefined) throw new Error("done marks a child Work's result for its parent; leave it out when you message a child Work.");
    if (!child) throw new Error("Name one of your child Works with target.");
    if (child.snapshot().lifecycle !== "active") throw new Error("That child Work is no longer running, so it cannot receive messages. Check it with dock_list.");
    // It owes a reply to this message as well, even if it already finished its earlier work.
    const owedBefore = this.owing.has(child.id);
    this.owing.add(child.id);
    try {
      await this.deliver(child, { type: "message", from: { relation: "parent", id: source.id, name: source.displayName }, text: request.message });
    } catch (error) {
      if (!owedBefore) this.owing.delete(child.id);
      throw error;
    }
    return { type: "work_message", to: "child", target: this.forParent(child.snapshot()), acceptedAt: this.port.now() };
  }

  /** A child Work's turn ended without its last call reaching its parent; the parent hears of it if a result is still owed. */
  async unreportedStop(source: InstanceSnapshot, request: Extract<DockToolsRequest, { type: "unreported_stop" }>): Promise<Extract<DockToolsResult, { type: "unreported_stop" }>> {
    const parent = source.parentId === undefined ? undefined : this.port.get(source.parentId);
    if (!this.owing.has(source.id) || !parent || parent.snapshot().lifecycle !== "active") return { type: "unreported_stop", notified: false };
    await this.deliver(parent, {
      type: "child_stopped", from: this.childSender(source), reason: request.reason,
      ...(request.error === undefined ? {} : { error: request.error }),
      ...(request.lastWords === undefined ? {} : { lastWords: request.lastWords }),
    });
    return { type: "unreported_stop", notified: true };
  }

  /** The parent took the work back by interrupting or stopping its child Work itself. */
  release(childId: string): void { this.owing.delete(childId); }

  /** A child Work is stopping or crashed. Its parent hears of it if a result was still owed, unless the parent is leaving too. */
  childLeaving(child: ManagedInstance): void {
    if (!this.owing.delete(child.id)) return;
    const snapshot = child.snapshot();
    const parent = snapshot.parentId === undefined ? undefined : this.port.get(snapshot.parentId);
    if (!parent || parent.snapshot().lifecycle !== "active") return;
    const crashed = snapshot.lifecycle === "runtime_error";
    const lastWords = child.lastAgentReply();
    void this.deliver(parent, {
      type: "child_stopped", from: this.childSender(snapshot), reason: crashed ? "crashed" : "stopped",
      ...(crashed && snapshot.lastError ? { error: shortenLastWords(snapshot.lastError) } : {}),
      ...(lastWords === undefined ? {} : { lastWords: shortenLastWords(lastWords) }),
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
      this.owing.delete(id);
      this.mainIdentities.delete(id);
    }
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
