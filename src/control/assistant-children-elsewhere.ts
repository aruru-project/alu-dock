import type { WorkMessage } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { ModelSpeedTier } from "../core/model-speed.js";
import type { RemoteChildrenPort } from "./dock-registry.js";
import type { MachineRouteRecord } from "./machine-state.js";
import type { MainRemoteChildren } from "./machine-transport.js";

/** A child Work of the resident assistant on another Machine: which run of her started it, and where. */
interface ChildElsewhere {
  machineId: string;
  parentId: string;
  parentGeneration: number;
  /** Main is still asking that Machine to create it. */
  starting: boolean;
  /**
   * That Machine has reported it. A report sent before it existed may still arrive after Main had the
   * Machine's answer; only once it was reported does a later report without it mean it left.
   */
  reported: boolean;
}

const PARENT_GONE = "The Work that created you is no longer running, so nothing can reach it.";
const STOP_RETRIES = 5;
const STOP_RETRY_MS = 1_000;

/**
 * Card #676: the resident assistant's child Works on other Machines than Main. Main remembers which run of
 * her started each, by its creation operation, and only that run hears from it. One whose run has ended
 * stops: at once when its Machine is connected, otherwise when the Machine reconnects, since a child Work
 * cut off from Main cannot use models meanwhile. Kept in memory only: once Main restarts she runs anew,
 * and none of them is hers.
 */
export class AssistantChildrenElsewhere implements MainRemoteChildren, RemoteChildrenPort {
  /** By the child Work's creation operation, which Main chooses before the Machine names the Work. */
  private readonly children = new Map<string, ChildElsewhere>();
  private readonly stopping = new Set<string>();

  constructor(private readonly port: {
    /** A Work Main itself runs. */
    local(instanceId: string): InstanceSnapshot | undefined;
    /** Every Work Main knows, on every Machine, under Main's IDs. */
    snapshots(): InstanceSnapshot[];
    isResidentAssistant(instanceId: string): boolean;
    machineAvailable(machineId: string): Promise<boolean>;
    /** Into her conversation, as Work messages from her own child Works here are. */
    deliver(parentId: string, message: WorkMessage): Promise<void>;
    stop(instanceId: string): Promise<void>;
    /** The speed she passes to her child Works now. */
    speedOf(parentId: string): ModelSpeedTier;
    /** Tells that Machine, if it is connected, which speed her child Works there follow. */
    sendSpeed(machineId: string, parentId: string, tier: ModelSpeedTier): Promise<void>;
  }) {}

  /** Main is about to ask that Machine to create her child Work; only this lets it name a parent there. */
  starting(machineId: string, creationOperationId: string, parent: InstanceSnapshot): void {
    this.children.set(creationOperationId, { machineId, parentId: parent.id, parentGeneration: parent.runtimeGeneration, starting: true, reported: false });
    // Ahead of the creation on the same connection, so the child Work starts at the speed she passes down.
    this.sendSpeed(machineId, parent.id);
  }

  /** Main has the Machine's answer. One not known to exist is forgotten, and stopped if it turns up. */
  started(creationOperationId: string, created: boolean): void {
    const child = this.children.get(creationOperationId);
    if (!child) return;
    if (created) child.starting = false;
    else this.children.delete(creationOperationId);
  }

  expected(machineId: string, creationOperationId: string, parentId: string): boolean {
    const child = this.children.get(creationOperationId);
    return child?.starting === true && child.machineId === machineId && this.hers(child, parentId);
  }

  async deliver(machineId: string, route: MachineRouteRecord, parentId: string, message: WorkMessage): Promise<void> {
    const child = this.children.get(route.snapshot.creationOperationId);
    if (child?.machineId !== machineId || route.snapshot.parentId !== parentId || !this.hers(child, parentId)) throw new Error(PARENT_GONE);
    // She knows it by Main's ID, from her dock_spawn result and dock_list.
    await this.port.deliver(parentId, { ...message, from: { ...message.from, id: route.mainInstanceId } });
  }

  reconciled(machineId: string, routes: readonly MachineRouteRecord[], connected: boolean): void {
    const listed = new Set<string>();
    const parents = new Set<string>();
    for (const route of routes) {
      const { parentId, lifecycle, creationOperationId } = route.snapshot;
      if (parentId === undefined || this.port.local(parentId) === undefined) continue;
      listed.add(creationOperationId);
      if (lifecycle !== "active" && lifecycle !== "runtime_error") continue;
      const child = this.children.get(creationOperationId);
      if (child?.machineId === machineId && this.hers(child, parentId)) {
        child.reported = true;
        parents.add(parentId);
      } else this.stopOnce(route.mainInstanceId);
    }
    // Her speed may have changed while that Machine was away.
    if (connected) for (const parentId of parents) this.sendSpeed(machineId, parentId);
    // Forget the ones that left that Machine.
    for (const [operation, child] of this.children) {
      if (child.machineId === machineId && child.reported && !listed.has(operation)) this.children.delete(operation);
    }
  }

  /** Her run ended: its child Works elsewhere stop too. */
  async retire(parentId: string): Promise<void> {
    for (const [operation, child] of this.children) if (child.parentId === parentId) this.children.delete(operation);
    const elsewhere = this.port.snapshots().filter((work) => work.parentId === parentId && work.hostId !== undefined
      && this.port.local(work.id) === undefined && (work.lifecycle === "active" || work.lifecycle === "runtime_error"));
    await Promise.allSettled(elsewhere.map(async (work) => {
      // An offline Machine keeps it until it reconnects and Main finds its parent gone.
      if (await this.port.machineAvailable(work.hostId!)) await this.port.stop(work.id);
    }));
  }

  async passSpeed(parentId: string, tier: ModelSpeedTier): Promise<void> {
    const machines = new Set(this.port.snapshots().filter((work) => work.parentId === parentId && work.hostId !== undefined
      && work.lifecycle === "active" && this.port.local(work.id) === undefined).map((work) => work.hostId!));
    await Promise.allSettled([...machines].map((machineId) => this.port.sendSpeed(machineId, parentId, tier)));
  }

  private sendSpeed(machineId: string, parentId: string): void {
    let tier: ModelSpeedTier;
    try { tier = this.port.speedOf(parentId); } catch { return; }
    void this.port.sendSpeed(machineId, parentId, tier).catch(() => { /* Sent again when that Machine reconnects. */ });
  }

  /** The run of her that started it is the one running now. */
  private hers(child: ChildElsewhere, parentId: string): boolean {
    if (child.parentId !== parentId) return false;
    const parent = this.port.local(parentId);
    return parent?.lifecycle === "active" && parent.runtimeGeneration === child.parentGeneration && this.port.isResidentAssistant(parentId);
  }

  /** Its run of her has ended, so it never becomes hers again: a failed Stop is tried again a few times. */
  private stopOnce(instanceId: string, attempt = 0): void {
    if (attempt === 0 && this.stopping.has(instanceId)) return;
    this.stopping.add(instanceId);
    void this.port.stop(instanceId).then(() => { this.stopping.delete(instanceId); }, () => {
      // As when Main is still starting after a restart; later its Machine may report it again too.
      if (attempt >= STOP_RETRIES) { this.stopping.delete(instanceId); return; }
      setTimeout(() => this.stopOnce(instanceId, attempt + 1), STOP_RETRY_MS * 2 ** attempt).unref();
    });
  }
}
