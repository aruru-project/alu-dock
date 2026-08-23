import { randomUUID } from "node:crypto";

import type { DockToolsHostPort, DockToolsRequest, DockToolsResult, ObservationDeliverySink } from "../core/dock-tools.js";
import { dockMessageText } from "../core/dock-tools.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { ObservationNotification } from "../core/instance-observation.js";
import { requireHumanTarget } from "../human-target.js";
import { DockClient } from "./dock-client.js";
import { InstanceObservationService } from "./instance-observation-service.js";
import { observationStatus } from "./instance-observation-service.js";
import type { MainMachineController } from "./machine-transport.js";
import type { ControlRequest, InstanceReadResult, MachineDto } from "./protocol.js";

/** Main-owned global Dock-tool authority; observation semantics stay in InstanceObservationService. */
export class MainMachineDockToolsAuthority {
  private readonly observation: InstanceObservationService;
  private readonly authorizedSources = new Set<string>();
  private readonly sourceMachines = new Map<string, string>();
  private readonly sourceCleanup = new Map<string, () => void>();

  constructor(private readonly options: {
    controller: () => MainMachineController;
    localClient: DockClient;
    localSnapshots: () => InstanceSnapshot[];
    subscribeLocal: (instanceId: string, listener: (snapshot: InstanceSnapshot) => void) => (() => void) | undefined;
    deliverLocalNotification: (sourceMainId: string, notification: ObservationNotification) => Promise<void>;
  }) {
    const snapshots = (): InstanceSnapshot[] => [...options.localSnapshots(), ...options.controller().remoteSnapshotsCurrent()];
    const get = (instanceId: string): InstanceSnapshot => {
      const found = snapshots().find((snapshot) => snapshot.id === instanceId);
      if (!found) throw new Error("This work is no longer available. Run dock_list and choose current work.");
      return found;
    };
    this.observation = new InstanceObservationService({
      listSnapshots: snapshots,
      getSnapshot: get,
      readConversationBootstrap: async (instanceId, historyLimit) => {
        const read = await this.read(instanceId, "conversation_bootstrap") as InstanceReadResult;
        void historyLimit;
        return { instance: read.instance, recentHistory: read.recentHistory, historyRevision: read.historyRevision, historyTruncated: read.historyTruncated, liveEvents: read.page.events };
      },
      readHistoryPage: async (instanceId, beforeEntryId, limit) => {
        const remote = options.controller().remoteSnapshotsCurrent().some((snapshot) => snapshot.id === instanceId);
        return remote
          ? await options.controller().requestRemote(requestEnvelope("session.history", { instanceId, beforeEntryId, limit })) as Awaited<ReturnType<DockClient["history"]>>
          : await options.localClient.history(instanceId, beforeEntryId, limit);
      },
      subscribe: (instanceId, listener) => options.controller().subscribeSnapshot(instanceId, listener) ?? options.subscribeLocal(instanceId, listener),
      sourceAuthorized: (instanceId) => this.authorizedSources.has(instanceId) && (() => { try { return get(instanceId).lifecycle === "active"; } catch { return false; } })(),
    });
    options.controller().onMachineDisconnected((instanceIds) => { void this.forgetInstances(instanceIds); });
  }

  async invoke(sourceMainId: string, sourceMachineId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    const snapshots = [...this.options.localSnapshots(), ...this.options.controller().remoteSnapshotsCurrent()];
    const source = snapshots.find((item) => item.id === sourceMainId);
    if (!source) throw new Error("This work has ended, so Dock tools cannot continue here. Open active work to use them.");
    if ((request.type === "create" || request.type === "send") && source.lifecycle !== "active") throw new Error("This work is no longer active, so it cannot create or message other work. Open active work and try again.");
    this.ensureSource(sourceMainId, sourceMachineId);
    if (request.type === "list" || request.type === "inspect" || request.type === "watch" || request.type === "cancel") return this.observation.observe(sourceMainId, request);
    if (request.type === "machines") return { type: "machines", machines: await this.options.controller().machines() };
    if (request.type === "create") {
      const targetMachine = resolveCreateMachine(await this.options.controller().machines(), sourceMachineId, request.machine);
      if (!targetMachine.available) throw new Error(`Machine ${JSON.stringify(targetMachine.name)} is offline. Reconnect it and try again.`);
      const instance = await this.options.localClient.create(request.cwd, request.name, request.operationId, undefined, targetMachine.hostId);
      return { type: "create", instance: observationStatus(instance) };
    }
    if (request.type === "send") {
      const target = requireHumanTarget(snapshots.filter((item) => item.id !== sourceMainId), request.target);
      const message = dockMessageText(source.displayName, request.message);
      const remote = this.options.controller().remoteSnapshotsCurrent().some((item) => item.id === target.id);
      const result = remote
        ? await this.options.controller().requestRemote(requestEnvelope("command.submit", { operationId: request.operationId, instanceId: target.id, message, delivery: "auto" })) as { receipt: { delivery: "prompt" | "steer" | "followUp"; queued: boolean; acceptedAt: string } }
        : await this.options.localClient.prompt(target.id, message, "auto", request.operationId);
      return { type: "send", target: observationStatus(target), receipt: { delivery: result.receipt.delivery, queued: result.receipt.queued, acceptedAt: result.receipt.acceptedAt } };
    }
    throw new Error("File delivery is owned by the source Host");
  }

  async cancelSource(sourceMainId: string): Promise<void> {
    this.cleanSourceMaps(sourceMainId);
    await this.observation.cancelSource(sourceMainId);
  }

  private async forgetInstances(instanceIds: readonly string[]): Promise<void> {
    for (const instanceId of instanceIds) this.cleanSourceMaps(instanceId);
    await this.observation.forgetInstances(instanceIds);
  }

  private cleanSourceMaps(sourceMainId: string): void {
    this.authorizedSources.delete(sourceMainId);
    this.sourceMachines.delete(sourceMainId);
    this.sourceCleanup.get(sourceMainId)?.();
    this.sourceCleanup.delete(sourceMainId);
  }

  private ensureSource(sourceMainId: string, sourceMachineId: string): void {
    this.authorizedSources.add(sourceMainId);
    this.sourceMachines.set(sourceMainId, sourceMachineId);
    if (this.sourceCleanup.has(sourceMainId)) return;
    const mainIdPromise = this.options.controller().machines().then((machines) => machines.find((machine) => machine.kind === "main")?.hostId);
    const detachSink = this.observation.attachSink(sourceMainId, async (notification) => {
      const mainId = await mainIdPromise;
      if (this.sourceMachines.get(sourceMainId) === mainId) await this.options.deliverLocalNotification(sourceMainId, notification);
      else await this.options.controller().deliverDockToolNotification(sourceMachineId, sourceMainId, notification);
    });
    const detachSource = this.options.controller().subscribeSnapshot(sourceMainId, (snapshot) => {
      if (snapshot.lifecycle !== "active") void this.cancelSource(sourceMainId);
    }) ?? this.options.subscribeLocal(sourceMainId, (snapshot) => { if (snapshot.lifecycle !== "active") void this.cancelSource(sourceMainId); });
    this.sourceCleanup.set(sourceMainId, () => { detachSink(); detachSource?.(); });
  }

  private async read(instanceId: string, replay: "event_log" | "conversation_bootstrap"): Promise<InstanceReadResult> {
    return this.options.controller().remoteSnapshotsCurrent().some((snapshot) => snapshot.id === instanceId)
      ? await this.options.controller().requestRemote(requestEnvelope("instance.read", { instanceId, replay })) as InstanceReadResult
      : await this.options.localClient.read(instanceId, undefined, replay);
  }
}

export class MainMachineDockToolsPort implements DockToolsHostPort {
  constructor(private readonly options: { local: () => DockToolsHostPort; authority: () => MainMachineDockToolsAuthority; mainHostId: () => Promise<string> }) {}
  dockToolsEnabled(sourceInstanceId: string): boolean { return this.options.local().dockToolsEnabled(sourceInstanceId); }
  async configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }> {
    const result = await this.options.local().configureDockTools(sourceInstanceId, enabled, operationId);
    if (!result.enabled) await this.options.authority().cancelSource(sourceInstanceId);
    return result;
  }
  invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    if (request.type === "deliver") return this.options.local().invokeDockTool(sourceInstanceId, request);
    if (!this.dockToolsEnabled(sourceInstanceId)) return Promise.reject(new Error("Dock tools are off for this instance. Use /dock-tools on first."));
    return this.options.mainHostId().then((hostId) => this.options.authority().invoke(sourceInstanceId, hostId, request));
  }
  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void { return this.options.local().attachObservationSink(sourceInstanceId, sink); }
}

function resolveCreateMachine(machines: readonly MachineDto[], sourceMachineId: string, requestedName: string | undefined): MachineDto {
  if (requestedName === undefined) {
    const source = machines.find((machine) => machine.hostId === sourceMachineId);
    if (!source) throw new Error("This work's Machine is no longer available. Reconnect it and try again.");
    return source;
  }
  const matches = machines.filter((machine) => machine.name === requestedName);
  if (matches.length === 0) throw new Error(`No Machine named ${JSON.stringify(requestedName)} was found. Check the Machine name and try again.`);
  if (matches.length > 1) throw new Error(`Several Machines are named ${JSON.stringify(requestedName)}. Use a unique Machine name and try again.`);
  return matches[0] as MachineDto;
}

function requestEnvelope<T extends ControlRequest["type"]>(type: T, params: Extract<ControlRequest, { type: T }>["params"]): Extract<ControlRequest, { type: T }> {
  return { kind: "request", version: 2, requestId: randomUUID(), type, params } as Extract<ControlRequest, { type: T }>;
}
