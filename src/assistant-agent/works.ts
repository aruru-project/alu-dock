import type { DockToolsRequest, DockToolsResult, WorkMessage } from "../core/dock-tools.js";
import type { ObservationNotification, ObservedInstanceStatus } from "../core/instance-observation.js";
import type { WorkRecovery } from "../core/work-progress.js";
import type { WorkMessageReceipts } from "../pi/work-message-receipts.js";
import { ChildMessages } from "../worker/child-messages.js";
import type { WorkerHost } from "../worker/worker-shell.js";
import { firstLine, type WorkNote } from "./status.js";

/** Kept with her conversation: which Works she handed something to or follows, so a restart does not lose track. */
export const WORKS_STATE_TYPE = "assistant-works";

interface KnownWork extends WorkNote { name: string; onNamedMachine?: boolean; handed?: number; settled?: number }
interface SavedWorks { works: Record<string, KnownWork>; followed: string[] }

/**
 * The Works she deals with: the child Works she handed work to, the Works she opened for her owner
 * and the ones she watches. Every Dock tool call of hers goes through here, so her status at the
 * start of a reply can say what each is doing without her asking.
 */
export class WorkDesk {
  private readonly children = new ChildMessages();
  private readonly works = new Map<string, KnownWork>();
  private readonly followed = new Set<string>();
  private readonly watchTargets = new Map<string, string>();
  /** Children actually retired with the previous run. A Host crash alone no longer ends them. */
  private lost: string[] = [];

  constructor(private readonly host: WorkerHost, private readonly save: (state: SavedWorks) => void) {}

  restore(saved: unknown, recovery?: WorkRecovery): void {
    const { works, followed } = (saved ?? {}) as Partial<SavedWorks>;
    const restored = new Map(recovery?.children.map((child) => [child.id, child]));
    this.children.restoreFromHost(recovery?.children ?? []);
    for (const [id, work] of Object.entries(works ?? {})) {
      if (!work || typeof work.name !== "string") continue;
      // A remote child's numbers live on its Machine, not in Main's catalog. On a Host crash
      // her own receipts suffice; as always, her status shows only children the Host lists.
      const remote = recovery?.afterHostCrash && work.onNamedMachine && Number.isSafeInteger(work.handed) && Number.isSafeInteger(work.settled);
      if (remote && !restored.has(id)) this.children.restore([{ id, name: work.name, handed: work.handed!, settled: work.settled! }]);
      if (work.owes && !restored.has(id) && !remote) this.lost.push(work.name);
      else this.works.set(id, { ...work, owes: this.children.owes(id) });
    }
    for (const child of restored.values()) if (!this.works.has(child.id)) this.works.set(child.id, { name: child.name, owes: this.children.owes(child.id) });
    for (const id of Array.isArray(followed) ? followed : []) if (typeof id === "string") this.followed.add(id);
  }

  restoreReceipts(recovery: WorkRecovery, receipts: WorkMessageReceipts, checkpoint?: string) {
    const { corrections } = receipts.restore(recovery, this.children, { checkpoint, note: (message) => this.noteMessage(message) });
    // These facts are already in the opened session. Keep the next status accurate, without
    // making a new assistant-works entry every time she is opened.
    this.updateOwed();
    return corrections;
  }

  get notes(): ReadonlyMap<string, WorkNote> { return this.works; }
  /** The child Work still owes her the result of the latest work she handed it. */
  owes(id: string): boolean { return this.children.owes(id); }
  get following(): ReadonlySet<string> { return this.followed; }

  /** Names of child Works a restart ended while they still owed her a result; told once. */
  takeLost(): string[] {
    const lost = this.lost;
    this.lost = [];
    if (lost.length > 0) this.persist();
    return lost;
  }

  /** Every Work she can see, or undefined when the Host does not answer. */
  async list(): Promise<ObservedInstanceStatus[] | undefined> {
    try {
      const result = await this.host.invokeDockTool({ type: "list" });
      return result.type === "list" ? result.result.instances : undefined;
    } catch {
      return undefined;
    }
  }

  /** One Dock tool call of hers. */
  async invoke(request: DockToolsRequest): Promise<DockToolsResult> {
    const result = await this.host.invokeDockTool(request);
    this.children.noteWork(result);
    if (result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined) {
      this.know(result.instance);
      if (request.type === "spawn" && request.machine !== undefined) this.works.get(result.instance.id)!.onNamedMachine = true;
    } else if (result.type === "create") { this.know(result.instance); this.followed.add(result.instance.id); }
    else if (result.type === "watch") {
      const target = result.status === "watching" ? result.receipt.target : result.completion.target;
      this.know(target);
      if (result.status === "watching") {
        this.watchTargets.set(result.receipt.watchId, target.id);
        this.followed.add(target.id);
      }
    } else if (result.type === "cancel") {
      for (const id of result.cancelledWatchIds) {
        const target = this.watchTargets.get(id);
        if (target !== undefined) this.followed.delete(target);
        this.watchTargets.delete(id);
      }
    } else if (result.type === "work_message" && result.to === "child") this.know(result.target);
    else if (result.type === "stop") { this.works.delete(result.instance.id); this.followed.delete(result.instance.id); }
    this.syncOwed();
    return result;
  }

  /** A message from a child Work, or Dock's notice that one stopped. */
  heard(message: WorkMessage): void {
    this.children.receive(message);
    if (message.from.relation !== "child") return;
    this.noteMessage(message);
    this.syncOwed();
  }

  private noteMessage(message: WorkMessage): void {
    const known = this.works.get(message.from.id) ?? { name: message.from.name };
    known.name = message.from.name;
    known.lastSaid = message.type === "message" ? firstLine(message.text) : "（没交结果就停下了）";
    this.works.set(message.from.id, known);
  }

  /** A watch of hers fired: the Work is no longer followed for it. */
  watched(notification: ObservationNotification): void {
    const { target } = notification;
    this.watchTargets.delete(notification.watchId);
    this.followed.delete(target.id);
    this.know(target);
    if (target.reply !== undefined) this.works.get(target.id)!.lastSaid = firstLine(target.reply);
    this.persist();
  }

  private know(status: ObservedInstanceStatus): void {
    const known = this.works.get(status.id);
    if (known) known.name = status.name ?? known.name;
    else this.works.set(status.id, { name: status.name ?? status.id });
  }

  private syncOwed(): void {
    this.updateOwed();
    this.persist();
  }

  private updateOwed(): void {
    const owed = new Set(this.children.waiting.map((child) => child.id));
    for (const [id, work] of this.works) {
      if (owed.has(id)) work.owes = true; else delete work.owes;
      if (work.onNamedMachine) Object.assign(work, this.children.progress(id));
    }
  }

  private persist(): void {
    this.save({ works: Object.fromEntries(this.works), followed: [...this.followed] });
  }
}
