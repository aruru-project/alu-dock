import type { DockToolsRequest, DockToolsResult, WorkMessage } from "../core/dock-tools.js";
import type { ObservationNotification, ObservedInstanceStatus } from "../core/instance-observation.js";
import { ChildMessages } from "../worker/child-messages.js";
import type { WorkerHost } from "../worker/worker-shell.js";
import { firstLine, type WorkNote } from "./status.js";

/** Kept with her conversation: which Works she handed something to or follows, so a restart does not lose track. */
export const WORKS_STATE_TYPE = "assistant-works";

interface KnownWork extends WorkNote { name: string }
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
  /** Child Works that owed her a result when this Worker last stopped; a restart ended them. */
  private lost: string[] = [];

  constructor(private readonly host: WorkerHost, private readonly save: (state: SavedWorks) => void) {}

  restore(saved: unknown): void {
    if (!saved || typeof saved !== "object") return;
    const { works, followed } = saved as Partial<SavedWorks>;
    for (const [id, work] of Object.entries(works ?? {})) {
      if (!work || typeof work.name !== "string") continue;
      // A child Work never outlives its parent's Worker: what it owed is lost with it.
      if (work.owes) this.lost.push(work.name);
      else this.works.set(id, { name: work.name, ...(typeof work.lastSaid === "string" ? { lastSaid: work.lastSaid } : {}) });
    }
    for (const id of Array.isArray(followed) ? followed : []) if (typeof id === "string") this.followed.add(id);
  }

  get notes(): ReadonlyMap<string, WorkNote> { return this.works; }
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
    const before = this.children.position;
    const result = await this.host.invokeDockTool(request);
    this.children.noteWork(result, before);
    if (result.type === "spawn" && result.taskStatus === "accepted" && result.error === undefined) this.know(result.instance);
    else if (result.type === "create") { this.know(result.instance); this.followed.add(result.instance.id); }
    else if (result.type === "watch") {
      const target = result.status === "watching" ? result.receipt.target : result.completion.target;
      this.know(target);
      if (result.status === "watching") this.followed.add(target.id);
    } else if (result.type === "work_message" && result.to === "child") this.know(result.target);
    else if (result.type === "stop") { this.works.delete(result.instance.id); this.followed.delete(result.instance.id); }
    this.syncOwed();
    return result;
  }

  /** A message from a child Work, or Dock's notice that one stopped. */
  heard(message: WorkMessage): void {
    this.children.receive(message);
    if (message.from.relation !== "child") return;
    const known = this.works.get(message.from.id) ?? { name: message.from.name };
    known.name = message.from.name;
    known.lastSaid = message.type === "message" ? firstLine(message.text) : "（没交结果就停下了）";
    this.works.set(message.from.id, known);
    this.syncOwed();
  }

  /** A watch of hers fired: the Work is no longer followed for it. */
  watched(notification: ObservationNotification): void {
    const { target } = notification;
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
    const owed = new Set(this.children.waiting.map((child) => child.id));
    for (const [id, work] of this.works) {
      if (owed.has(id)) work.owes = true; else delete work.owes;
    }
    this.persist();
  }

  private persist(): void {
    this.save({ works: Object.fromEntries(this.works), followed: [...this.followed] });
  }
}
