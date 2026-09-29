import { InstanceRecordChannel } from "./instance-record-delivery.js";
import { usesInstanceRecords, INSTANCE_RECORDS_CAPABILITY } from "./protocol.js";
import { ByteTransitRelay, machineFileChunkHeader, encodeRoutedRecord } from "./file-framing.js";
import { FILE_TRANSFER_CAPABILITY } from "./protocol.js";
import { LinkWriter, MACHINE_LINK_DIALECT, MAX_LINK_LINE_BYTES, MAX_LINK_QUEUED_INPUT_BYTES, MAX_LINK_STREAMS, StreamAcceptor, diagnosticReason, encodeLinkRecord, type LinkOutputLane, type LinkRecord } from "./stream-link.js";
import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { Socket } from "node:net";
import { createServer, connect, type Server as TlsServer, type TLSSocket } from "node:tls";

import { MAX_CATALOG_INSTANCES } from "../core/catalog.js";
import { isNativeAbsoluteLocalPath, isPortableAbsoluteLocalPath, isPortableLocalRootPath } from "../core/local-path.js";
import { StaleRuntimeGenerationError, type InstanceSnapshot } from "../core/managed-instance.js";
import type { DockToolsHostPort, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import { parseDockToolsRequest, parseDockToolsResult } from "../core/dock-tools-codec.js";
import type { ObservationDeliverySink, ObservationNotification } from "../core/instance-observation.js";
import { MACHINE_PLATFORMS, MAX_CONTROL_CWD_CHARS, MAX_CONTROL_LINE_BYTES, MAX_INSTANCE_LIST_RESULT_BYTES, type ControlError, type ControlRequest, type EnsureResult, type MachineDto, type MachinePlatform, ProtocolValidationError } from "./protocol.js";
import { requestOptionCapabilities, capabilityForRequest, decodeResponseTransfer, parseControlResponse, parseEnsureResult, parseForgetResult, parseHelloReply, parseInstanceSnapshot, parseResponseTransferFrame, ProtocolHelloRejectedError, requiredCapabilities } from "./protocol.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import { boundedInstanceListPage } from "./instance-list-page.js";
import { MainMachineState, SubHostMachineState, type MachineRouteRecord, type SubHostUpstreamRecord, type TrustedSubHostRecord } from "./machine-state.js";
import { MachineSettingsState, machineListenerConfiguration, sameMachineListenerConfiguration, type MachineListenerConfiguration, type MachineSettings } from "./machine-settings-state.js";
import { recordForMainHost, requestForNativeHost, snapshotForMain, type MachineRouteIdentity } from "./machine-route-identity.js";
import { type RemoteEndpointDecision, type RemoteInstanceDirectory, type RemoteProtocolEndpoint, type RoutedProtocolProxy } from "./instance-manager.js";
import { MAX_DOCK_TRANSFER_BYTES, MAX_RESPONSE_TRANSFER_CHUNK_BYTES, MAX_RESPONSE_TRANSFER_CHUNKS } from "../core/transport-bounds.js";
import { MAX_DURABLE_CATALOG_BYTES } from "./durable-catalog-store.js";

const MAX_MACHINE_LINE_BYTES = MAX_LINK_LINE_BYTES;
const MAX_MACHINE_STREAMS = MAX_LINK_STREAMS;
const MAX_WORKSPACE_ROOTS = 26;
export const MAX_MACHINE_CONNECTIONS = 64;
const MACHINE_TLS_HANDSHAKE_TIMEOUT_MS = 5_000;
const MACHINE_ADMISSION_TIMEOUT_MS = 10_000;
const MAX_MACHINE_INVENTORY_CHUNK_BYTES = Math.floor((MAX_MACHINE_LINE_BYTES - 1_024) * 3 / 4);
const INVENTORY_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 250;
const MACHINE_HEARTBEAT_TIMEOUT_MS = 5_000;
const MACHINE_LISTENER_RETRY_MS = 1_000;

type MachineWireRecord =
  | { kind: "machine_hello"; machineId: string; machineName: string; platform: MachinePlatform; homePath: string; workspaceRoots: string[]; joinToken?: string; hostEpoch: string }
  | { kind: "machine_ready"; mainHostEpoch: string }
  | { kind: "machine_inventory_chunk"; inventoryId: string; hostEpoch: string; index: number; count: number; data: string }
  | { kind: "machine_stream_open"; streamId: string }
  | { kind: "machine_stream_data"; streamId: string; data: string }
  | { kind: "machine_stream_close"; streamId: string }
  | { kind: "machine_stream_reset"; streamId: string; reason: string }
  | { kind: "machine_tool_request"; requestId: string; sourceNativeId: string; request: DockToolsRequest }
  | { kind: "machine_tool_response"; requestId: string; ok: true; result: DockToolsResult }
  | { kind: "machine_tool_response"; requestId: string; ok: false; error: string }
  | { kind: "machine_tool_notification"; sourceNativeId: string; notification: ObservationNotification }
  | { kind: "machine_tool_source_off"; requestId: string; sourceNativeId: string }
  | { kind: "machine_tool_source_off_ack"; requestId: string }
  | { kind: "machine_ping" }
  | { kind: "machine_pong" };

export class MachineMutationEffectUnknownError extends Error {
  readonly queryHint = "Wait for that machine to reconnect and refresh the relevant work before any retry";

  constructor(readonly operationId: string) {
    super("The connection ended while the change was in progress, so the result is not confirmed. Wait for that machine to reconnect and refresh before trying again.");
    this.name = "MachineMutationEffectUnknownError";
  }
}

export class RoutedControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: ControlError["details"];

  constructor(error: ControlError) {
    super(error.message);
    this.name = "RoutedControlError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

interface MainStream {
  streamId: string;
  machineId: string;
  connection: MainConnection;
  requestId: string;
  requestType: ControlRequest["type"];
  route: MachineRouteIdentity;
  keyReservation?: KeyReservation;
  emit: (record: unknown) => void | Promise<void>;
  ended: () => void;
  helloSeen: boolean;
  nativeRequest: ControlRequest;
  fileTransit?: ByteTransitRelay;
  recordTransit?: ByteTransitRelay;
  recordInput?: InstanceRecordChannel;
  recordOutput?: InstanceRecordChannel;
  recordsReady?: boolean;
  requiredCapabilities: readonly string[];
  acceptingInput: boolean;
  inputTail: Promise<void>;
  queuedInputBytes: number;
  routeRetired?: boolean;
  transfer?: { count: number; chunks: string[]; requestId: string };
}

interface KeyReservation {
  key: string;
  token: string;
  released: Promise<void>;
  release: () => void;
}

interface RouteReconciliation {
  routes: MachineRouteRecord[];
  disconnectedMainIds: string[];
}

interface RemoteInstanceBinding {
  machineId: string;
  route: MachineRouteRecord;
}

interface InventoryTransfer {
  inventoryId: string;
  hostEpoch: string;
  count: number;
  nextIndex: number;
  chunks: Buffer[];
  bytes: number;
}

interface AcceptedMachineSocket {
  key: string;
  raw: Socket;
  tls?: TLSSocket;
  phase: "handshake" | "admission" | "ready";
  deadline: NodeJS.Timeout;
}

interface MainConnection {
  machine: TrustedSubHostRecord;
  socket: TLSSocket;
  hostEpoch: string;
  streams: Map<string, MainStream>;
  lastSeenAt: number;
  candidateOrdinal: number;
  closed: boolean;
  inventory?: InventoryTransfer;
}

/** Connection-fed remote directory/transport backend; InstanceManager remains the client request authority. */
export class MainMachineController implements RemoteInstanceDirectory {
  private server: TlsServer | undefined;
  private activePort: number | undefined;
  private listenerIdentity: { privateKeyPem: string; certificatePem: string } | undefined;
  private staleConnectionTimer: NodeJS.Timeout | undefined;
  private listenerPollTimer: NodeJS.Timeout | undefined;
  private listenerPollPromise: Promise<unknown | undefined> | undefined;
  private lastAttemptedListenerConfiguration: MachineListenerConfiguration | undefined;
  private appliedListenerConfiguration: MachineListenerConfiguration | undefined;
  private nextListenerAttemptAt = 0;
  private readonly connections = new Map<string, MainConnection>();
  private readonly acceptedSockets = new Map<string, AcceptedMachineSocket>();
  private authorityTail = Promise.resolve();
  private readonly keyReservations = new Map<string, KeyReservation>();
  private readonly latestInstalledCandidate = new Map<string, number>();
  private readonly removedMachineIds = new Set<string>();
  private nextCandidateOrdinal = 0;
  private revision = 0;
  private listFingerprint = "";
  private readonly instanceBindings = new Map<string, RemoteInstanceBinding>();
  private readonly snapshotListeners = new Map<string, Set<(snapshot: InstanceSnapshot) => void>>();
  private readonly disconnectListeners = new Set<(instanceIds: readonly string[]) => void>();
  private mainId = "";
  private mainName = "Main";
  private readonly localMachineFacts = currentMachineFacts();
  private started = false;

  constructor(private readonly options: {
    state: MainMachineState;
    settingsState?: MachineSettingsState;
    requiredInitialPort?: number;
    mainHostEpoch: string;
    bindAddress?: string;
    invokeDockTool?: (sourceMainId: string, sourceMachineId: string, request: DockToolsRequest) => Promise<DockToolsResult>;
    dockToolsSourceOff?: (sourceMainId: string) => Promise<void>;
    localSnapshots: () => InstanceSnapshot[];
  }) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.options.state.initialize();
      this.listenerIdentity = await this.options.state.identity();
      const main = await this.options.state.main();
      this.mainId = main.id;
      this.mainName = main.name;
      this.revision = main.revision;
      for (const machine of await this.options.state.list()) await this.markOffline(machine.id);
      await this.refreshInstanceBindings();
      this.staleConnectionTimer = setInterval(() => {
        const now = Date.now();
        for (const connection of this.connections.values()) {
          if (now - connection.lastSeenAt >= MACHINE_HEARTBEAT_TIMEOUT_MS) connection.socket.destroy();
        }
      }, INVENTORY_INTERVAL_MS);
      this.staleConnectionTimer.unref?.();
      if (this.options.settingsState) {
        const listenerError = await this.triggerListenerPoll();
        if (this.options.requiredInitialPort !== undefined && (listenerError !== undefined || this.activePort !== this.options.requiredInitialPort)) {
          throw listenerError ?? new Error(`Could not listen on port ${this.options.requiredInitialPort}`);
        }
        this.listenerPollTimer = setInterval(() => { void this.triggerListenerPoll(); }, INVENTORY_INTERVAL_MS);
        this.listenerPollTimer.unref?.();
      }
    } catch (error) {
      this.started = false;
      if (this.staleConnectionTimer) clearInterval(this.staleConnectionTimer);
      this.staleConnectionTimer = undefined;
      await this.closeListener().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.listenerPollTimer) clearInterval(this.listenerPollTimer);
    this.listenerPollTimer = undefined;
    await this.listenerPollPromise?.catch(() => {});
    if (this.staleConnectionTimer) clearInterval(this.staleConnectionTimer);
    this.staleConnectionTimer = undefined;
    await this.closeListener();
    await this.authorityTail;
  }

  private triggerListenerPoll(): Promise<unknown | undefined> {
    if (!this.started || !this.options.settingsState) return Promise.resolve(undefined);
    if (this.listenerPollPromise) return this.listenerPollPromise;
    const current = this.pollListenerSettings().finally(() => {
      if (this.listenerPollPromise === current) this.listenerPollPromise = undefined;
    });
    this.listenerPollPromise = current;
    return current;
  }

  private async pollListenerSettings(): Promise<unknown | undefined> {
    const state = this.options.settingsState as MachineSettingsState;
    try {
      const settings = await state.read();
      const configuration = machineListenerConfiguration(settings);
      if (!sameMachineListenerConfiguration(this.lastAttemptedListenerConfiguration, configuration)) this.nextListenerAttemptAt = 0;
      if (sameMachineListenerConfiguration(this.appliedListenerConfiguration, configuration) || Date.now() < this.nextListenerAttemptAt) return undefined;
      this.lastAttemptedListenerConfiguration = configuration;
      this.appliedListenerConfiguration = undefined;
      try {
        await this.applyListenerSettings(settings);
        this.appliedListenerConfiguration = configuration;
        this.nextListenerAttemptAt = 0;
        return undefined;
      } catch (error) {
        this.nextListenerAttemptAt = Date.now() + MACHINE_LISTENER_RETRY_MS;
        await this.recordListenerError(settings);
        return error;
      }
    } catch (error) {
      return error;
    }
  }

  private async applyListenerSettings(settings: MachineSettings): Promise<void> {
    const state = this.options.settingsState as MachineSettingsState;
    if (!settings.main.connectionsEnabled) {
      await this.closeListener();
      await state.writeMainListenerStatus({
        schemaVersion: 1,
        ...machineListenerConfiguration(settings),
        state: "disabled",
      });
      return;
    }
    if (!this.server || this.activePort !== settings.main.port) {
      await this.closeListener();
      await this.openListener(settings.main.port);
    }
    await state.writeMainListenerStatus({
      schemaVersion: 1,
      ...machineListenerConfiguration(settings),
      state: "listening",
    });
  }

  private async recordListenerError(settings: MachineSettings): Promise<void> {
    const state = this.options.settingsState;
    if (!state) return;
    await state.writeMainListenerStatus({
      schemaVersion: 1,
      ...machineListenerConfiguration(settings),
      state: "error",
    }).catch(() => {});
  }

  private async openListener(port: number): Promise<void> {
    const identity = this.listenerIdentity;
    if (!identity) throw new Error("Machine identity is unavailable");
    const server = createServer({
      key: identity.privateKeyPem,
      cert: identity.certificatePem,
      requestCert: true,
      rejectUnauthorized: false,
    }, (socket) => this.acceptSecure(socket));
    server.on("connection", (socket) => this.acceptRaw(socket));
    server.on("tlsClientError", () => {});
    try {
      await listen(server, port, this.options.bindAddress ?? "::");
      if (!this.started) {
        await closeServer(server);
        return;
      }
      this.server = server;
      this.activePort = port;
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  }

  private async closeListener(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    for (const connection of [...this.connections.values()]) {
      this.disconnect(connection);
      connection.socket.destroy();
    }
    this.connections.clear();
    for (const accepted of this.acceptedSockets.values()) {
      clearTimeout(accepted.deadline);
      accepted.tls?.destroy();
      accepted.raw.destroy();
    }
    this.acceptedSockets.clear();
    if (server) await closeServer(server);
  }

  currentSnapshot(instanceId: string): InstanceSnapshot | undefined {
    const binding = this.instanceBindings.get(instanceId);
    return binding ? structuredClone(binding.route.snapshot) : undefined;
  }
  currentSnapshots(): InstanceSnapshot[] { return [...this.instanceBindings.values()].map(({ route }) => structuredClone(route.snapshot)); }
  subscribeSnapshot(instanceId: string, listener: (snapshot: InstanceSnapshot) => void): (() => void) | undefined {
    if (!this.instanceBindings.has(instanceId)) return undefined;
    const listeners = this.snapshotListeners.get(instanceId) ?? new Set<(snapshot: InstanceSnapshot) => void>();
    listeners.add(listener); this.snapshotListeners.set(instanceId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.snapshotListeners.delete(instanceId); };
  }
  onInstancesDisconnected(listener: (instanceIds: readonly string[]) => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }

  async deliverDockToolNotification(sourceMachineId: string, sourceMainId: string, notification: ObservationNotification): Promise<void> {
    const machine = await this.options.state.get(sourceMachineId);
    const route = machine?.routes.find((item) => item.mainInstanceId === sourceMainId);
    const connection = this.connections.get(sourceMachineId);
    if (!route || !connection) return;
    await writeMachine(connection.socket, { kind: "machine_tool_notification", sourceNativeId: route.nativeInstanceId, notification });
  }

  async getByKey(key: string): Promise<InstanceSnapshot | undefined> {
    return this.serializeAuthority(async () => {
      const owner = await this.globalKeyOwner(key);
      return owner === undefined ? undefined : structuredClone(owner);
    });
  }

  async ensureByKey(request: Extract<ControlRequest, { type: "instance.ensure" }>, ensureLocal: () => Promise<EnsureResult>): Promise<EnsureResult> {
    for (;;) {
      const decision = await this.serializeAuthority(async () => {
        const owner = await this.globalKeyOwner(request.params.key);
        if (owner) return { kind: "owner" as const, owner: structuredClone(owner) };
        const existing = this.keyReservations.get(request.params.key);
        if (existing) return { kind: "wait" as const, released: existing.released };
        let release!: () => void;
        const reservation: KeyReservation = {
          key: request.params.key,
          token: randomUUID(),
          released: new Promise<void>((resolve) => { release = resolve; }),
          release: () => release(),
        };
        this.keyReservations.set(request.params.key, reservation);
        return { kind: "reserved" as const, reservation };
      });
      if (decision.kind === "owner") return { created: false, instance: decision.owner };
      if (decision.kind === "wait") { await decision.released; continue; }
      try {
        const selectedHost = request.params.hostId;
        if (selectedHost === undefined || selectedHost === this.mainId) return await ensureLocal();
        return parseEnsureResult(await this.requestRemoteHost(selectedHost, request, decision.reservation));
      } finally {
        await this.serializeAuthority(async () => {
          if (this.keyReservations.get(request.params.key) === decision.reservation) {
            this.keyReservations.delete(request.params.key);
            decision.reservation.release();
          }
        });
      }
    }
  }

  private async requestRemoteHost(hostId: string, request: ControlRequest, keyReservation?: KeyReservation): Promise<unknown> {
    const machine = await this.options.state.get(hostId);
    if (!machine) throw new ProtocolValidationError("host_not_found", "That machine is not connected to this Dock");
    return this.awaitRemoteResponse(request, (emit, ended) => this.dispatchResolvedHost(machine, request, emit, ended, keyReservation));
  }

  private awaitRemoteResponse(
    request: ControlRequest,
    dispatch: (emit: (record: unknown) => void, ended: () => void) => Promise<RemoteEndpointDecision>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let proxy: RoutedProtocolProxy | undefined;
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        proxy?.close();
        error ? reject(error) : resolve(result);
      };
      const emit = (record: unknown): void => {
        if (!record || typeof record !== "object" || (record as { kind?: unknown }).kind !== "response") return;
        try {
          const response = parseControlResponse(record, request.requestId, this.options.mainHostEpoch);
          if (response.ok) finish(undefined, response.result);
          else finish(new RoutedControlError(response.error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const ended = (): void => {
        if (settled) return;
        const operationId = requestOperationId(request);
        finish(operationId === undefined
          ? new Error("That machine disconnected before the request finished. Wait for it to reconnect and try again.")
          : new MachineMutationEffectUnknownError(operationId));
      };
      void dispatch(emit, ended).then((decision) => {
        if (decision.kind === "result") { finish(undefined, decision.result); return; }
        proxy = decision.proxy;
        if (settled) proxy.close();
      }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  mainHostId(): string { return this.mainId; }

  async machines(): Promise<MachineDto[]> {
    const records = await this.options.state.list();
    return [
      { hostId: this.mainId, name: this.mainName, kind: "main", available: true, ...this.localMachineFacts },
      ...records.map((machine) => ({
        hostId: machine.id,
        name: machine.name,
        kind: "subhost" as const,
        available: this.connectionLive(this.connections.get(machine.id)),
        ...(machine.platform === undefined ? {} : { platform: machine.platform }),
        ...(machine.homePath === undefined ? {} : { homePath: machine.homePath }),
        ...(machine.workspaceRoots === undefined ? {} : { workspaceRoots: machine.workspaceRoots }),
      })),
    ];
  }

  async removeMachine(hostId: string): Promise<{ hostId: string; removed: boolean }> {
    if (hostId === this.mainId) throw new ProtocolValidationError("invalid_request", "Main cannot remove itself from Machines");
    return this.serializeAuthority(async () => {
      this.removedMachineIds.add(hostId);
      try {
        const machine = await this.options.state.get(hostId);
        const removed = await this.options.state.removeMachine(hostId);
        if (!removed) {
          this.removedMachineIds.delete(hostId);
          return { hostId, removed: false };
        }
        const connection = this.connections.get(hostId);
        if (connection) {
          this.disconnect(connection, false);
          connection.socket.destroy();
        }
        const instanceIds = machine?.routes.map((route) => route.mainInstanceId) ?? [];
        for (const instanceId of instanceIds) this.instanceBindings.delete(instanceId);
        this.revision += 1;
        if (instanceIds.length > 0) for (const listener of this.disconnectListeners) listener(instanceIds);
        return { hostId, removed: true };
      } catch (error) {
        this.removedMachineIds.delete(hostId);
        throw error;
      }
    });
  }

  async listPage(local: InstanceSnapshot[], params: Extract<ControlRequest, { type: "instance.list" }>['params']): Promise<unknown> {
    const remote = (await this.options.state.list()).flatMap((machine) => machine.routes.map((route) => route.snapshot));
    const all = [...local, ...remote].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const fingerprint = all.map((item) => `${item.id}:${item.updatedAt}:${item.lifecycle}:${item.eventCursor.sequence}`).join("|");
    if (this.listFingerprint && fingerprint !== this.listFingerprint) this.revision += 1;
    this.listFingerprint = fingerprint;
    const selected = params.selector === "all" ? all : all.filter((item) => item.lifecycle !== "stopped");
    const hiddenStopped = params.selector === "all" ? 0 : all.length - selected.length;
    if (params.cursor && (params.cursor.revision !== this.revision || params.cursor.selector !== params.selector)) throw new ProtocolValidationError("stale_cursor", "The work list changed; refresh it and try again");
    const offset = params.cursor?.offset ?? 0;
    if (offset > selected.length) throw new ProtocolValidationError("stale_cursor", "The work list changed; refresh it and try again");
    return boundedInstanceListPage({
      selected,
      selector: params.selector,
      revision: this.revision,
      offset,
      limit: params.limit,
      hiddenStopped,
      maxBytes: MAX_INSTANCE_LIST_RESULT_BYTES,
    });
  }

  async resolveInstance(instanceId: string): Promise<RemoteProtocolEndpoint | undefined> {
    const binding = this.instanceBindings.get(instanceId);
    return binding ? new MachineRemoteInstance(this, structuredClone(binding)) : undefined;
  }

  async resolveHost(hostId: string): Promise<RemoteProtocolEndpoint | undefined> {
    if (hostId === this.mainId) return undefined;
    const machine = await this.options.state.get(hostId);
    return machine ? new MachineRemoteHost(this, structuredClone(machine)) : undefined;
  }

  async dispatchResolvedInstance(
    binding: RemoteInstanceBinding,
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    fileMode = false,
  ): Promise<RemoteEndpointDecision> {
    const current = this.instanceBindings.get(binding.route.mainInstanceId);
    if (!current) {
      if (request.type === "instance.stop" && !this.liveConnection(binding.machineId)) {
        return { kind: "result", result: offlineStopResult(request.params.operationId, binding.route.snapshot) };
      }
      throw new ProtocolValidationError("not_found", "That work is no longer available");
    }
    if (current.machineId !== binding.machineId || current.route.nativeInstanceId !== binding.route.nativeInstanceId) {
      throw new ProtocolValidationError("not_found", "That work is no longer available");
    }
    const expectedGeneration = binding.route.snapshot.runtimeGeneration;
    const actualGeneration = current.route.snapshot.runtimeGeneration;
    if (actualGeneration !== expectedGeneration) throw new StaleRuntimeGenerationError(expectedGeneration, actualGeneration);
    const route = current.route;
    const connection = this.liveConnection(current.machineId);
    if (!connection) {
      if (request.type !== "instance.stop") throw new ProtocolValidationError("host_unavailable", "That machine is offline. Reconnect it and try again");
      const result = offlineStopResult(request.params.operationId, route.snapshot);
      const stopped = (result as { instance: InstanceSnapshot }).instance;
      let retired = false;
      await this.serializeAuthority(async () => {
        const latest = this.instanceBindings.get(route.mainInstanceId);
        if (!latest) return;
        if (latest.machineId !== current.machineId || latest.route.nativeInstanceId !== route.nativeInstanceId) {
          throw new ProtocolValidationError("not_found", "That work is no longer available");
        }
        const latestGeneration = latest.route.snapshot.runtimeGeneration;
        if (latestGeneration !== expectedGeneration) throw new StaleRuntimeGenerationError(expectedGeneration, latestGeneration);
        await this.options.state.removeRoute(route.mainInstanceId);
        this.instanceBindings.delete(route.mainInstanceId);
        this.revision += 1;
        retired = true;
      });
      if (retired) {
        for (const listener of this.snapshotListeners.get(route.mainInstanceId) ?? []) listener(structuredClone(stopped));
        for (const listener of this.disconnectListeners) listener([route.mainInstanceId]);
      }
      return { kind: "result", result };
    }
    return this.openRemoteStream(connection.machine, connection, request, emit, ended, route, undefined, fileMode);
  }

  async dispatchResolvedHost(
    machine: TrustedSubHostRecord,
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    keyReservation?: KeyReservation,
    fileMode = false,
  ): Promise<RemoteEndpointDecision> {
    const connection = this.liveConnection(machine.id);
    if (!connection) throw new ProtocolValidationError("host_unavailable", "That machine is offline. Reconnect it and try again");
    return this.openRemoteStream(connection.machine, connection, request, emit, ended, undefined, keyReservation, fileMode);
  }

  private async openRemoteStream(
    machine: TrustedSubHostRecord,
    connection: MainConnection,
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    route?: MachineRouteRecord,
    keyReservation?: KeyReservation,
    fileMode = false,
  ): Promise<RemoteEndpointDecision> {
    const identity: MachineRouteIdentity | undefined = route ? {
      hostId: machine.id,
      mainInstanceId: route.mainInstanceId,
      nativeInstanceId: route.nativeInstanceId,
      mainHostEpoch: this.options.mainHostEpoch,
      nativeHostEpoch: connection.hostEpoch,
      ...(route.snapshot.key === undefined ? {} : { mainKey: route.snapshot.key }),
    } : undefined;
    const streamId = randomUUID();
    if (connection.streams.size >= MAX_MACHINE_STREAMS) throw new ProtocolValidationError("host_busy", "That machine is busy right now. Try again shortly.");
    const stream: MainStream = {
      streamId,
      machineId: machine.id,
      connection,
      requestId: request.requestId,
      requestType: request.type,
      route: identity ?? {
        hostId: machine.id,
        mainInstanceId: "",
        nativeInstanceId: "",
        mainHostEpoch: this.options.mainHostEpoch,
        nativeHostEpoch: connection.hostEpoch,
      },
      ...(keyReservation === undefined ? {} : { keyReservation }),
      emit,
      ended,
      helloSeen: false,
      nativeRequest: requestForNativeHost(request, identity),
      requiredCapabilities: [...new Set([...requiredCapabilities(capabilityForRequest(request.type)), ...requestOptionCapabilities(request), ...(fileMode ? [FILE_TRANSFER_CAPABILITY] : [])])],
      acceptingInput: true,
      inputTail: Promise.resolve(),
      queuedInputBytes: 0,
    };
    if(fileMode)stream.fileTransit=new ByteTransitRelay([
      {version:2,requestId:request.requestId,hostEpoch:this.options.mainHostEpoch},
      {version:2,requestId:request.requestId,hostEpoch:connection.hostEpoch},
    ],[async record=>{this.assertStreamEmissionCurrent(stream);await emit(record);},async record=>{await writeMachine(connection.socket,{kind:"machine_stream_data",streamId,data:encodeRoutedRecord(record)});}],error=>this.resetMainStream(connection,stream,diagnosticReason(error,"File activity failed")));
    if(usesInstanceRecords(request)) {
      const failed=(error:unknown)=>this.resetMainStream(connection,stream,diagnosticReason(error,"Instance record delivery failed"));
      stream.recordTransit=new ByteTransitRelay([
        {version:2,requestId:request.requestId,hostEpoch:this.options.mainHostEpoch},
        {version:2,requestId:request.requestId,hostEpoch:connection.hostEpoch},
      ],[async record=>{this.assertStreamEmissionCurrent(stream);await emit(record);},async record=>{await writeMachine(connection.socket,{kind:"machine_stream_data",streamId,data:encodeRoutedRecord(record)});}],failed,"instance_record");
      stream.recordInput=new InstanceRecordChannel(request.requestId,connection.hostEpoch,"receive",frame=>stream.recordTransit!.outputs[1].write(frame),failed);
      stream.recordOutput=new InstanceRecordChannel(request.requestId,this.options.mainHostEpoch,"send",frame=>stream.recordTransit!.outputs[0].write(frame),failed,(wire,consumed)=>{stream.recordInput!.activity();stream.recordTransit!.downstreamProgress(wire,consumed);});
    }
    connection.streams.set(streamId, stream);
    try {
      await writeMachine(connection.socket, { kind: "machine_stream_open", streamId });
      await writeMachine(connection.socket, {
        kind: "machine_stream_data",
        streamId,
        data: JSON.stringify({
          kind: "hello",
          requestId: `machine-${streamId}`,
          versions: [2],
          client: { name: "alu-dock-main", version: "0.2.0", clientId: this.mainId },
          requiredCapabilities: stream.requiredCapabilities,
        }),
      });
    } catch (error) {
      this.resetMainStream(connection, stream, diagnosticReason(error, "Could not open routed stream"));
      throw error;
    }
    return {
      kind: "remote",
      proxy: {
        send: async (record) => {
          try {
            if(stream.recordOutput){await stream.recordOutput.consume(record);return;}
            if (fileMode) {
              // Endpoints own file parsing; routers only translate envelope identity,
              // never decode/re-encode the opaque base64 payload.
              if (!record || typeof record !== "object" || (record as { requestId?: unknown }).requestId !== request.requestId
                || (record as { hostEpoch?: unknown }).hostEpoch !== this.options.mainHostEpoch) throw new Error("Routed file input identity changed");
              record = { ...record, hostEpoch: stream.route.nativeHostEpoch };
            }
            if(stream.fileTransit) {
              // Activity from the public-side relay is a separate incoming cumulative source.
              const mapped=stream.fileTransit.map(0,{...(record as object),hostEpoch:this.options.mainHostEpoch});
              await stream.fileTransit.outputs[1].write({...mapped as object,hostEpoch:stream.route.nativeHostEpoch});
            } else await writeMachine(connection.socket, { kind: "machine_stream_data", streamId, data: JSON.stringify(record) });
          }
          catch (error) { this.resetMainStream(connection, stream, diagnosticReason(error, "Routed stream output failed")); throw error; }
        },
        close: () => this.closeMainStream(connection, streamId, true),
      },
    };
  }

  private acceptRaw(socket: Socket): void {
    const key = machineSocketKey(socket);
    if (!key) { socket.destroy(); return; }
    if (this.acceptedSockets.size >= MAX_MACHINE_CONNECTIONS) {
      const victim = [...this.acceptedSockets.values()].find((candidate) => candidate.phase !== "ready");
      if (!victim) { socket.destroy(); return; }
      this.expireAcceptedSocket(victim, victim.phase);
    }
    const accepted: AcceptedMachineSocket = {
      key,
      raw: socket,
      phase: "handshake",
      deadline: setTimeout(() => this.expireAcceptedSocket(accepted, "handshake"), MACHINE_TLS_HANDSHAKE_TIMEOUT_MS),
    };
    this.acceptedSockets.set(key, accepted);
    socket.once("close", () => this.forgetAcceptedSocket(accepted));
  }

  private acceptSecure(socket: TLSSocket): void {
    const key = machineSocketKey(socket);
    const accepted = key ? this.acceptedSockets.get(key) : undefined;
    if (!accepted || accepted.phase !== "handshake") { socket.destroy(); return; }
    clearTimeout(accepted.deadline);
    accepted.tls = socket;
    accepted.phase = "admission";
    accepted.deadline = setTimeout(() => this.expireAcceptedSocket(accepted, "admission"), MACHINE_ADMISSION_TIMEOUT_MS);
    this.accept(socket);
  }

  private accept(socket: TLSSocket): void {
    const decoder = new JsonLineDecoder(MAX_MACHINE_LINE_BYTES);
    let connection: MainConnection | undefined;
    let initialInventoryPending = true;
    let processing = Promise.resolve();
    const close = (): void => {
      if (connection) this.disconnect(connection);
    };
    socket.once("close", close);
    socket.once("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      processing = processing.then(async () => {
        const lines=decoder.push(chunk);
        const partial=machineFileChunkHeader(decoder.partialRecord);
        const fileStream=partial&&connection?.streams.get(partial.streamId);
        if(partial&&fileStream?.helloSeen&&fileStream.fileTransit&&partial.requestId===fileStream.requestId&&partial.hostEpoch===fileStream.route.nativeHostEpoch){
          connection!.lastSeenAt=Date.now();
          fileStream.fileTransit.observe(decoder.recordSequence,Buffer.byteLength(decoder.partialRecord));
        }
        const recordPartial=machineFileChunkHeader(decoder.partialRecord,true);
        const recordStream=recordPartial&&connection?.streams.get(recordPartial.streamId);
        if(recordPartial&&recordStream?.helloSeen&&recordStream.recordTransit&&recordPartial.requestId===recordStream.requestId&&recordPartial.hostEpoch===recordStream.route.nativeHostEpoch){
          connection!.lastSeenAt=Date.now();recordStream.recordInput!.waiting();recordStream.recordOutput!.activity();
          recordStream.recordTransit.observe(decoder.recordSequence,Buffer.byteLength(decoder.partialRecord));
        }
        for (const line of lines) {
          const record = parseMachineRecord(line);
          if (connection?.closed) throw new Error("SubHost machine connection closed during record processing");
          if (!connection) {
            if (record.kind !== "machine_hello") throw new Error("SubHost did not begin with machine hello");
            connection = await this.acceptHello(socket, record);
            if (socket.destroyed) { close(); throw new Error("SubHost machine connection closed during hello"); }
            continue;
          }
          if (initialInventoryPending) {
            if (record.kind !== "machine_inventory_chunk") throw new Error("SubHost did not send its initial inventory");
            if (record.hostEpoch !== connection.hostEpoch) throw new Error("SubHost inventory Host identity does not match its hello");
            const snapshots = consumeInventoryChunk(connection, record);
            if (!snapshots) continue;
            await this.completeInitialInventory(connection, record.hostEpoch, snapshots);
            initialInventoryPending = false;
            await writeMachine(socket, { kind: "machine_ready", mainHostEpoch: this.options.mainHostEpoch });
            this.markAcceptedSocketReady(socket);
            continue;
          }
          await this.consumeMainRecord(connection, record);
        }
      }).catch(() => { socket.destroy(); }).finally(() => { if (!socket.destroyed) socket.resume(); });
    });
    socket.once("end", () => { try { decoder.finish(); } catch { socket.destroy(); } });
  }

  private expireAcceptedSocket(accepted: AcceptedMachineSocket, expectedPhase: AcceptedMachineSocket["phase"]): void {
    if (this.acceptedSockets.get(accepted.key) !== accepted || accepted.phase !== expectedPhase) return;
    this.acceptedSockets.delete(accepted.key);
    clearTimeout(accepted.deadline);
    accepted.tls?.destroy();
    accepted.raw.destroy();
  }

  private forgetAcceptedSocket(accepted: AcceptedMachineSocket): void {
    if (this.acceptedSockets.get(accepted.key) === accepted) this.acceptedSockets.delete(accepted.key);
    clearTimeout(accepted.deadline);
  }

  private markAcceptedSocketReady(socket: TLSSocket): void {
    const key = machineSocketKey(socket);
    const accepted = key ? this.acceptedSockets.get(key) : undefined;
    if (!accepted || accepted.tls !== socket || accepted.phase !== "admission") throw new Error("Machine admission state disappeared before ready");
    clearTimeout(accepted.deadline);
    accepted.phase = "ready";
  }

  private disconnect(connection: MainConnection, markRoutesOffline = true): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connections.get(connection.machine.id) === connection) this.connections.delete(connection.machine.id);
    for (const stream of connection.streams.values()) { stream.fileTransit?.close(); stream.recordTransit?.close();stream.recordInput?.cancel();stream.recordOutput?.cancel(); stream.ended(); }
    connection.streams.clear();
    if (markRoutesOffline) void this.markOfflineUnlessConnected(connection.machine.id);
  }

  private async completeInitialInventory(connection: MainConnection, hostEpoch: string, snapshots: InstanceSnapshot[]): Promise<void> {
    const projection = await this.serializeAuthority(async () => {
      if (this.removedMachineIds.has(connection.machine.id)) throw new Error("SubHost is no longer joined");
      if (connection.closed || connection.socket.destroyed) throw new Error("SubHost machine connection closed before initial inventory");
      const latestInstalled = this.latestInstalledCandidate.get(connection.machine.id) ?? 0;
      if (connection.candidateOrdinal < latestInstalled) throw new Error("A newer machine connection became ready before this candidate");
      const reconciled = await this.reconcileInventoryCurrentRoutes(connection.machine.id, snapshots);
      if (connection.closed || connection.socket.destroyed) throw new Error("SubHost machine connection closed during initial inventory");
      connection.hostEpoch = hostEpoch;
      const previous = this.connections.get(connection.machine.id);
      if (!previous && this.connections.size >= MAX_MACHINE_CONNECTIONS - 1) throw new Error("Machine connection capacity is full");
      this.connections.set(connection.machine.id, connection);
      this.latestInstalledCandidate.set(connection.machine.id, connection.candidateOrdinal);
      previous?.socket.destroy();
      return reconciled;
    });
    this.publishRouteReconciliation(projection);
  }

  private async acceptHello(socket: TLSSocket, hello: Extract<MachineWireRecord, { kind: "machine_hello" }>): Promise<MainConnection> {
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw) throw new Error("SubHost certificate is missing");
    const certificate = new X509Certificate(peer.raw);
    const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    const admitted = await this.serializeAuthority(async () => {
      let machine = await this.options.state.get(hello.machineId);
      if (!machine) {
        if (!hello.joinToken) throw new Error("SubHost is not joined");
        machine = await this.options.state.acceptJoin({
          token: hello.joinToken,
          machineId: hello.machineId,
          machineName: hello.machineName,
          platform: hello.platform,
          homePath: hello.homePath,
          workspaceRoots: hello.workspaceRoots,
          certificatePem: certificate.toString(),
        });
      } else {
        if (machine.fingerprint !== fingerprint) throw new Error("SubHost certificate does not match its trust record");
        if (machine.name !== hello.machineName || machine.platform !== hello.platform || machine.homePath !== hello.homePath || !sameStrings(machine.workspaceRoots, hello.workspaceRoots)) {
          machine = await this.options.state.updateMachine(machine.id, (candidate) => {
            candidate.name = hello.machineName;
            candidate.platform = hello.platform;
            candidate.homePath = hello.homePath;
            candidate.workspaceRoots = hello.workspaceRoots;
          });
        }
      }
      this.removedMachineIds.delete(machine.id);
      this.nextCandidateOrdinal += 1;
      return { machine, candidateOrdinal: this.nextCandidateOrdinal };
    });
    return { machine: admitted.machine, socket, hostEpoch: hello.hostEpoch, streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: admitted.candidateOrdinal, closed: false };
  }

  private async consumeMainRecord(connection: MainConnection, record: MachineWireRecord): Promise<void> {
    connection.lastSeenAt = Date.now();
    if (record.kind === "machine_ping") { await writeMachine(connection.socket, { kind: "machine_pong" }); return; }
    if (record.kind === "machine_tool_source_off") {
      const currentMachine = await this.options.state.get(connection.machine.id);
      const source = currentMachine?.routes.find((route) => route.nativeInstanceId === record.sourceNativeId);
      if (source) await this.options.dockToolsSourceOff?.(source.mainInstanceId);
      await writeMachine(connection.socket, { kind: "machine_tool_source_off_ack", requestId: record.requestId });
      return;
    }
    if (record.kind === "machine_tool_request") {
      const currentMachine = await this.options.state.get(connection.machine.id);
      const source = currentMachine?.routes.find((route) => route.nativeInstanceId === record.sourceNativeId);
      if (!source || !this.options.invokeDockTool) {
        await writeMachine(connection.socket, { kind: "machine_tool_response", requestId: record.requestId, ok: false, error: "Dock tools require the Main connection" });
        return;
      }
      const invokeDockTool = this.options.invokeDockTool;
      void (async () => {
        try {
          const result = await invokeDockTool(source.mainInstanceId, connection.machine.id, record.request);
          await writeMachine(connection.socket, { kind: "machine_tool_response", requestId: record.requestId, ok: true, result });
        } catch (error) {
          await writeMachine(connection.socket, { kind: "machine_tool_response", requestId: record.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        }
      })();
      return;
    }
    if (record.kind === "machine_inventory_chunk") {
      const snapshots = consumeInventoryChunk(connection, record);
      if (snapshots) {
        await this.reconcileInventoryFromConnection(connection, snapshots);
        if (this.currentConnection(connection)) connection.hostEpoch = record.hostEpoch;
      }
      return;
    }
    if (record.kind === "machine_stream_reset") {
      machineWriters.get(connection.socket)?.cancelStream(record.streamId, new Error(record.reason));
      this.closeMainStream(connection, record.streamId, false);
      return;
    }
    if (record.kind === "machine_stream_close") {
      const stream = connection.streams.get(record.streamId);
      if (stream) {
        stream.acceptingInput = false;
        this.enqueueMainStream(connection, stream, 0, async () => {
          // Normal EOF is a delivery boundary; resets still cancel immediately.
          await stream.recordOutput?.drained();
          this.closeMainStream(connection, stream.streamId, false);
        });
      }
      return;
    }
    if (record.kind !== "machine_stream_data") throw new Error("Unexpected SubHost machine record");
    const stream = connection.streams.get(record.streamId);
    if (!stream || !stream.acceptingInput) return;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(record.data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid stream record");
      raw = parsed as Record<string, unknown>;
    } catch(error) {
      this.resetMainStream(connection, stream, diagnosticReason(error, "Invalid stream record"));
      return;
    }
    if(stream.recordInput && raw.kind==="instance_record_activity") {
      try {
        await stream.recordInput.consume(raw);
        await stream.recordOutput!.consume({...raw,hostEpoch:this.options.mainHostEpoch});
        // Never block the machine input loop behind a slow public writer.
        stream.recordTransit!.outputs[0].activity(stream.recordTransit!.map(1,raw));
      } catch(error) {this.resetMainStream(connection,stream,diagnosticReason(error,"Invalid instance record activity"));}
      return;
    }
    this.enqueueMainStream(connection, stream, Buffer.byteLength(record.data, "utf8"), async () => {
      if (!stream.helloSeen) {
        try {
          const hello = parseHelloReply(raw, `machine-${stream.streamId}`);
          if (hello.host.hostEpoch !== stream.route.nativeHostEpoch
            || stream.requiredCapabilities.some((capability) => !hello.capabilities.includes(capability))) {
            throw new Error("SubHost hello did not match the routed Host or required capabilities");
          }
        } catch (error) {
          if (!(error instanceof ProtocolHelloRejectedError)) throw error;
          const { code, message, ...details } = error.rejection;
          await this.emitMappedStreamRecords(stream, [{
            kind: "response", version: 2, requestId: stream.requestId, hostEpoch: this.options.mainHostEpoch, ok: false,
            error: { code, message, retryable: code === "host_starting" || code === "host_draining",
              ...(Object.keys(details).length ? { details } : {}) },
          }]);
          this.closeMainStream(connection, stream.streamId, true);
          return;
        }
        stream.helloSeen = true;
        if(stream.fileTransit)await stream.fileTransit.outputs[1].write(stream.nativeRequest);
        else await writeMachine(connection.socket, { kind: "machine_stream_data", streamId: stream.streamId, data: JSON.stringify(stream.nativeRequest) });
        return;
      }
      if(stream.recordInput && stream.recordOutput) {
        if((raw as {kind?:unknown})?.kind==="response" && !stream.recordInput.started){
          const response=parseControlResponse(raw,stream.requestId,stream.route.nativeHostEpoch);
          if(response.ok)throw new Error("Expected instance record delivery");
          await this.emitMappedStreamRecords(stream,await this.mapRemoteStreamRecord(stream,raw));return;
        }
        const logical=await stream.recordInput.consume(raw);
        if(logical===undefined)return;
        stream.recordInput.quiescent();
        const mapped=recordForMainHost(logical,stream.route);
        await stream.recordOutput.send(mapped);
        if((logical as {kind?:unknown})?.kind==="instance_ready") {
          await stream.recordOutput.drained();
          stream.recordsReady=true;
        }
        if(stream.recordsReady){stream.recordInput.quiescent();stream.recordOutput.quiescent();}
        else stream.recordInput.waiting();
        return;
      }
      const mapped = await this.mapRemoteStreamRecord(stream, stream.fileTransit?.map(1,raw)??raw);
      await this.emitMappedStreamRecords(stream, mapped);
    });
  }

  private async emitMappedStreamRecords(stream: MainStream, records: readonly unknown[]): Promise<void> {
    for (const record of records) {
      this.assertStreamEmissionCurrent(stream);
      if(stream.fileTransit)await stream.fileTransit.outputs[0].write(record);else await stream.emit(record);
    }
  }

  private assertStreamEmissionCurrent(stream: MainStream): void {
    if (!this.currentConnection(stream.connection) || stream.connection.streams.get(stream.streamId) !== stream) {
      const reason = "Machine connection was replaced before its routed response could be delivered";
      this.resetMainStream(stream.connection, stream, reason);
      throw new Error(reason);
    }
  }

  private enqueueMainStream(connection: MainConnection, stream: MainStream, bytes: number, work: () => Promise<void>): void {
    if (stream.queuedInputBytes + bytes > MAX_LINK_QUEUED_INPUT_BYTES) {
      this.resetMainStream(connection, stream, "Stream input queue exceeded its bound");
      return;
    }
    stream.queuedInputBytes += bytes;
    const queued = stream.inputTail.then(async () => {
      if (connection.streams.get(stream.streamId) !== stream) return;
      await work();
    }).finally(() => { stream.queuedInputBytes -= bytes; });
    stream.inputTail = queued.catch((error) => {
      this.resetMainStream(connection, stream, diagnosticReason(error, "Routed stream failed"));
    });
  }

  private resetMainStream(connection: MainConnection, stream: MainStream, reason: string): void {
    if (connection.streams.get(stream.streamId) !== stream) return;
    stream.acceptingInput = false;
    stream.fileTransit?.close();
    stream.recordTransit?.close();stream.recordInput?.cancel();stream.recordOutput?.cancel();
    connection.streams.delete(stream.streamId);
    if (!connection.socket.destroyed) void writeMachine(connection.socket, {
      kind: "machine_stream_reset",
      streamId: stream.streamId,
      reason: diagnosticReason(reason, "Routed stream failed"),
    }).catch(() => {});
    setImmediate(stream.ended);
  }

  private async mapRemoteStreamRecord(stream: MainStream, raw: unknown): Promise<unknown[]> {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    if (record?.kind === "response_transfer") {
      const frame = parseResponseTransferFrame(record, stream.requestId, stream.route.nativeHostEpoch);
      stream.transfer ??= { count: frame.count, chunks: [], requestId: frame.requestId };
      if (stream.transfer.count !== frame.count || stream.transfer.chunks.length !== frame.index) throw new Error("Routed response transfer is out of order");
      stream.transfer.chunks.push(frame.data);
      if (stream.transfer.chunks.length < stream.transfer.count) return [];
      const decoded = decodeResponseTransfer(stream.transfer.chunks);
      await this.assignRouteFromResponse(stream, decoded);
      await this.retireSuccessfulRouteMutation(stream, decoded);
      const response = recordForMainHost(decoded, stream.route) as Record<string, unknown>;
      response.hostEpoch = this.options.mainHostEpoch;
      const bytes = Buffer.from(JSON.stringify(response), "utf8");
      if (bytes.byteLength > MAX_DOCK_TRANSFER_BYTES) throw new ProtocolValidationError("response_too_large", "Routed response exceeds the transport safety bound");
      const chunks = Math.max(1, Math.ceil(bytes.byteLength / MAX_RESPONSE_TRANSFER_CHUNK_BYTES));
      if (chunks > MAX_RESPONSE_TRANSFER_CHUNKS) throw new ProtocolValidationError("response_too_large", "Routed response exceeds the response-transfer chunk bound");
      return Array.from({ length: chunks }, (_, transferIndex) => ({
        kind: "response_transfer", version: 2, requestId: stream.transfer!.requestId,
        hostEpoch: this.options.mainHostEpoch, index: transferIndex, count: chunks,
        data: bytes.subarray(transferIndex * MAX_RESPONSE_TRANSFER_CHUNK_BYTES, Math.min(bytes.byteLength, (transferIndex + 1) * MAX_RESPONSE_TRANSFER_CHUNK_BYTES)).toString("base64"),
      }));
    }
    await this.assignRouteFromResponse(stream, raw);
    await this.retireSuccessfulRouteMutation(stream, raw);
    const mapped = recordForMainHost(raw, stream.route) as Record<string, unknown>;
    if (mapped && typeof mapped === "object" && "hostEpoch" in mapped) mapped.hostEpoch = this.options.mainHostEpoch;
    return [mapped];
  }

  private async retireSuccessfulRouteMutation(stream: MainStream, raw: unknown): Promise<void> {
    if (stream.routeRetired || (stream.requestType !== "instance.stop" && stream.requestType !== "instance.forget") || !stream.route.mainInstanceId) return;
    if (!raw || typeof raw !== "object") return;
    const envelope = raw as Record<string, unknown>;
    if (envelope.kind !== "response" || envelope.ok !== true) return;
    let stopGeneration: number | undefined;
    let mappedStopped: InstanceSnapshot | undefined;
    if (stream.requestType === "instance.stop") {
      const result = envelope.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Successful online stop response is missing its instance snapshot");
      const nativeStopped = parseInstanceSnapshot((result as Record<string, unknown>).instance, "online stop response instance");
      if (nativeStopped.id !== stream.route.nativeInstanceId || nativeStopped.lifecycle !== "stopped") throw new Error("Successful online stop response has an invalid instance snapshot");
      stopGeneration = nativeStopped.runtimeGeneration;
      mappedStopped = snapshotForMain(nativeStopped, stream.route.hostId, stream.route.mainInstanceId, this.options.mainHostEpoch, stream.route.mainKey);
    } else {
      const forgotten = parseForgetResult(envelope.result);
      if (forgotten.receipt.forgottenId !== stream.route.nativeInstanceId) throw new Error("Successful online forget response has an invalid native identity");
    }
    await this.serializeAuthority(async () => {
      if (!this.currentConnection(stream.connection)) return;
      const stored = (await this.options.state.get(stream.machineId))?.routes.find((route) => route.mainInstanceId === stream.route.mainInstanceId);
      if (!stored) throw new Error("Successful routed retirement has no current Main route");
      const retired = await this.options.state.retireRoute(stream.route.mainInstanceId, stopGeneration ?? stored.snapshot.runtimeGeneration);
      if (!retired || retired.nativeInstanceId !== stream.route.nativeInstanceId) throw new Error("Successful routed retirement did not match its native identity");
      stream.routeRetired = true;
      this.instanceBindings.delete(stream.route.mainInstanceId);
      this.revision += 1;
    });
    if (!stream.routeRetired) return;
    if (mappedStopped) for (const listener of this.snapshotListeners.get(stream.route.mainInstanceId) ?? []) listener(structuredClone(mappedStopped));
    for (const listener of this.disconnectListeners) listener([stream.route.mainInstanceId]);
  }

  private async assignRouteFromResponse(stream: MainStream, raw: unknown): Promise<void> {
    if (stream.route.nativeInstanceId) return;
    if (!raw || typeof raw !== "object") return;
    const envelope = raw as Record<string, unknown>;
    if (envelope.kind !== "response" || envelope.ok !== true || !envelope.result || typeof envelope.result !== "object") return;
    const result = envelope.result as Record<string, unknown>;
    const snapshot = result.instance;
    if (!isSnapshot(snapshot)) return;
    const reservation = stream.keyReservation && this.keyReservations.get(stream.keyReservation.key) === stream.keyReservation
      ? stream.keyReservation
      : undefined;
    stream.route = await this.ensureRoute(stream.connection, snapshot, stream.route.nativeHostEpoch, reservation);
  }

  private ensureRoute(connection: MainConnection, snapshot: InstanceSnapshot, nativeHostEpoch: string, reservation?: KeyReservation): Promise<MachineRouteIdentity> {
    return this.serializeAuthority(async () => {
      if (!this.currentConnection(connection)) throw new Error("Machine connection was replaced before its route could be assigned");
      return this.ensureRouteCurrentRoutes(connection.machine.id, snapshot, nativeHostEpoch, reservation);
    });
  }

  private async ensureRouteCurrentRoutes(machineId: string, snapshot: InstanceSnapshot, nativeHostEpoch: string, reservation?: KeyReservation): Promise<MachineRouteIdentity> {
    const machines = await this.options.state.list();
    const claims = this.keyClaims(machines);
    let mainInstanceId = "";
    let mapped!: InstanceSnapshot;
    await this.options.state.updateMachine(machineId, (machine, { usedMainInstanceIds }) => {
      const existing = machine.routes.find((route) => route.nativeInstanceId === snapshot.id);
      mainInstanceId = existing?.mainInstanceId ?? uniqueMainInstanceId(usedMainInstanceIds);
      mapped = this.normalizeRouteSnapshot(snapshot, machineId, mainInstanceId, claims, reservation?.key, reservation);
      machine.routes = [
        ...machine.routes.filter((route) => route.nativeInstanceId !== snapshot.id),
        { mainInstanceId, nativeInstanceId: snapshot.id, snapshot: mapped },
      ];
    });
    this.instanceBindings.set(mainInstanceId, {
      machineId,
      route: { mainInstanceId, nativeInstanceId: snapshot.id, snapshot: structuredClone(mapped) },
    });
    this.revision += 1;
    return {
      hostId: machineId,
      mainInstanceId,
      nativeInstanceId: snapshot.id,
      mainHostEpoch: this.options.mainHostEpoch,
      nativeHostEpoch,
      ...(mapped.key === undefined ? {} : { mainKey: mapped.key }),
    };
  }

  private closeMainStream(connection: MainConnection, streamId: string, notify: boolean): void {
    const stream = connection.streams.get(streamId);
    if (!stream) return;
    stream.acceptingInput = false;
    stream.fileTransit?.close();
    stream.recordTransit?.close();stream.recordInput?.cancel();stream.recordOutput?.cancel();
    connection.streams.delete(streamId);
    if (notify && !connection.socket.destroyed) void writeMachine(connection.socket, stream.requiredCapabilities.includes(FILE_TRANSFER_CAPABILITY)
      ? { kind: "machine_stream_reset", streamId, reason: "File client disconnected" }
      : { kind: "machine_stream_close", streamId }).catch(() => {});
    setImmediate(stream.ended);
  }

  private async reconcileInventoryFromConnection(connection: MainConnection, snapshots: InstanceSnapshot[]): Promise<void> {
    const projection = await this.serializeAuthority(async () => {
      if (!this.currentConnection(connection)) return undefined;
      return this.reconcileInventoryCurrentRoutes(connection.machine.id, snapshots);
    });
    if (projection) this.publishRouteReconciliation(projection);
  }

  private async reconcileInventoryCurrentRoutes(machineId: string, snapshots: InstanceSnapshot[]): Promise<RouteReconciliation> {
    assertUniqueNativeSnapshotIds(snapshots);
    const machines = await this.options.state.list();
    const current = machines.find((machine) => machine.id === machineId);
    const reportedByNative = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const survivingNativeIds = new Set((current?.routes ?? []).filter((route) => {
      const reported = reportedByNative.get(route.nativeInstanceId);
      const retirement = current?.retiredRoutes.find((item) => item.nativeInstanceId === route.nativeInstanceId);
      return reported !== undefined && (!retirement || reported.runtimeGeneration > retirement.runtimeGeneration);
    }).map((route) => route.nativeInstanceId));
    const claims = this.keyClaims(machines, (candidateMachineId, route) => candidateMachineId !== machineId || survivingNativeIds.has(route.nativeInstanceId));
    let previousMainIds = new Set<string>();
    let routes: MachineRouteRecord[] = [];
    await this.options.state.updateMachine(machineId, (machine, { usedMainInstanceIds }) => {
      previousMainIds = new Set(machine.routes.map((route) => route.mainInstanceId));
      const byNative = new Map(machine.routes.map((route) => [route.nativeInstanceId, route]));
      const usedMainIds = new Set(usedMainInstanceIds);
      const retiredByNative = new Map(machine.retiredRoutes.map((retirement) => [retirement.nativeInstanceId, retirement]));
      const retiredRoutes = machine.retiredRoutes.filter((retirement) => {
        const reported = reportedByNative.get(retirement.nativeInstanceId);
        return !reported || reported.runtimeGeneration <= retirement.runtimeGeneration;
      });
      routes = snapshots.filter((snapshot) => {
        const retirement = retiredByNative.get(snapshot.id);
        return !retirement || snapshot.runtimeGeneration > retirement.runtimeGeneration;
      }).map((snapshot) => {
        const existing = byNative.get(snapshot.id);
        const mainInstanceId = existing?.mainInstanceId ?? uniqueMainInstanceId(usedMainIds);
        usedMainIds.add(mainInstanceId);
        return {
          mainInstanceId,
          nativeInstanceId: snapshot.id,
          snapshot: this.normalizeRouteSnapshot(snapshot, machineId, mainInstanceId, claims),
        };
      });
      machine.routes = routes;
      machine.retiredRoutes = retiredRoutes;
    });
    await this.refreshInstanceBindings();
    for (const route of routes) previousMainIds.delete(route.mainInstanceId);
    this.revision += 1;
    return { routes, disconnectedMainIds: [...previousMainIds] };
  }

  private publishRouteReconciliation(projection: RouteReconciliation): void {
    for (const route of projection.routes) for (const listener of this.snapshotListeners.get(route.mainInstanceId) ?? []) listener(structuredClone(route.snapshot));
    if (projection.disconnectedMainIds.length) for (const listener of this.disconnectListeners) listener(projection.disconnectedMainIds);
  }

  private async markOffline(machineId: string): Promise<void> {
    const routes = await this.serializeAuthority(() => this.markOfflineCurrentRoutes(machineId));
    this.publishOfflineRoutes(routes);
  }

  private async markOfflineUnlessConnected(machineId: string): Promise<void> {
    const routes = await this.serializeAuthority(async () => {
      if (this.removedMachineIds.has(machineId)) return undefined;
      const current = this.connections.get(machineId);
      if (current && !current.closed && !current.socket.destroyed) return undefined;
      return this.markOfflineCurrentRoutes(machineId);
    });
    if (routes) this.publishOfflineRoutes(routes);
  }

  private async markOfflineCurrentRoutes(machineId: string): Promise<MachineRouteRecord[]> {
    const now = new Date().toISOString();
    let routes: MachineRouteRecord[] = [];
    await this.options.state.updateMachine(machineId, (machine) => {
      routes = machine.routes.map((route) => ({ ...route, snapshot: offlineSnapshot(route.snapshot, now) }));
      machine.routes = routes;
    });
    await this.refreshInstanceBindings();
    this.revision += 1;
    return routes;
  }

  private publishOfflineRoutes(routes: readonly MachineRouteRecord[]): void {
    for (const route of routes) for (const listener of this.snapshotListeners.get(route.mainInstanceId) ?? []) listener(structuredClone(route.snapshot));
    const ids = routes.map((route) => route.mainInstanceId);
    for (const listener of this.disconnectListeners) listener(ids);
  }

  private async globalKeyOwner(key: string): Promise<InstanceSnapshot | undefined> {
    for (const snapshot of this.options.localSnapshots()) if (snapshot.key === key) return snapshot;
    for (const machine of await this.options.state.list()) {
      const route = machine.routes.find((candidate) => candidate.snapshot.key === key);
      if (route) return route.snapshot;
    }
    return undefined;
  }

  private keyClaims(
    machines: readonly TrustedSubHostRecord[],
    includeRoute: (machineId: string, route: MachineRouteRecord) => boolean = () => true,
  ): Map<string, string> {
    const claims = new Map<string, string>();
    for (const snapshot of this.options.localSnapshots()) if (snapshot.key !== undefined && !claims.has(snapshot.key)) claims.set(snapshot.key, `local:${snapshot.id}`);
    for (const machine of machines) for (const route of machine.routes) {
      if (route.snapshot.key !== undefined && includeRoute(machine.id, route) && !claims.has(route.snapshot.key)) claims.set(route.snapshot.key, routeClaim(machine.id, route.mainInstanceId));
    }
    for (const reservation of this.keyReservations.values()) if (!claims.has(reservation.key)) claims.set(reservation.key, reservationClaim(reservation));
    return claims;
  }

  private normalizeRouteSnapshot(
    native: InstanceSnapshot,
    machineId: string,
    mainInstanceId: string,
    claims: Map<string, string>,
    requestedKey = native.key,
    reservation?: KeyReservation,
  ): InstanceSnapshot {
    const claim = routeClaim(machineId, mainInstanceId);
    const owner = requestedKey === undefined ? undefined : claims.get(requestedKey);
    const ownsKey = requestedKey !== undefined && (
      owner === undefined
      || owner === claim
      || (reservation !== undefined && owner === reservationClaim(reservation) && this.keyReservations.get(reservation.key) === reservation)
    );
    if (ownsKey) claims.set(requestedKey, claim);
    return snapshotForMain(native, machineId, mainInstanceId, this.options.mainHostEpoch, ownsKey ? requestedKey : undefined);
  }

  private async serializeAuthority<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.authorityTail;
    let release!: () => void;
    this.authorityTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  private currentConnection(connection: MainConnection): boolean {
    return this.connections.get(connection.machine.id) === connection && this.connectionLive(connection);
  }

  private liveConnection(machineId: string): MainConnection | undefined {
    const connection = this.connections.get(machineId);
    return this.connectionLive(connection) ? connection : undefined;
  }

  private connectionLive(connection: MainConnection | undefined): connection is MainConnection { return connection !== undefined && !connection.closed && !connection.socket.destroyed && Date.now() - connection.lastSeenAt < MACHINE_HEARTBEAT_TIMEOUT_MS; }

  private async refreshInstanceBindings(): Promise<void> {
    this.instanceBindings.clear();
    for (const machine of await this.options.state.list()) for (const route of machine.routes) {
      this.instanceBindings.set(route.mainInstanceId, { machineId: machine.id, route: structuredClone(route) });
    }
  }
}

class MachineRemoteInstance implements RemoteProtocolEndpoint {
  constructor(private readonly controller: MainMachineController, private readonly binding: RemoteInstanceBinding) {}

  dispatch(
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    fileMode = false,
  ): Promise<RemoteEndpointDecision> {
    return this.controller.dispatchResolvedInstance(this.binding, request, emit, ended, fileMode);
  }
}

class MachineRemoteHost implements RemoteProtocolEndpoint {
  constructor(private readonly controller: MainMachineController, private readonly machine: TrustedSubHostRecord) {}

  dispatch(
    request: ControlRequest,
    emit: (record: unknown) => void | Promise<void>,
    ended: () => void,
    fileMode = false,
  ): Promise<RemoteEndpointDecision> {
    return this.controller.dispatchResolvedHost(this.machine, request, emit, ended, undefined, fileMode);
  }
}

export class SubHostMachineConnection {
  private socket: TLSSocket | undefined;
  private ready = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private inventoryTimer: NodeJS.Timeout | undefined;
  private streams: StreamAcceptor | undefined;
  private readonly toolRequests = new Map<string, { resolve: (result: DockToolsResult) => void; reject: (error: Error) => void }>();
  private readonly sourceOffRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly observationSinks = new Map<string, ObservationDeliverySink>();
  private record: SubHostUpstreamRecord | undefined;
  private lastInventory = "";
  private initialRecovery: Promise<void> | undefined;
  private lastMainRecordAt = 0;
  private connecting = false;
  private maintenanceSocket: TLSSocket | undefined;

  constructor(private readonly options: {
    state: SubHostMachineState;
    address: string;
    port: number;
    hostEpoch: string;
    snapshots: () => InstanceSnapshot[] | Promise<InstanceSnapshot[]>;
    acceptProtocolSocket: (socket: Socket) => void;
    onConnectionChanged?: (connected: boolean) => void | Promise<void>;
  }) {}

  async start(initialRecovery?: Promise<void>): Promise<void> {
    if (!this.stopped) return;
    this.record = await this.options.state.load();
    if (!this.record) throw new Error("SubHost has not been prepared with a join file");
    this.stopped = false;
    this.initialRecovery = initialRecovery;
    if (initialRecovery) {
      const release = (): void => {
        if (this.initialRecovery !== initialRecovery) return;
        this.initialRecovery = undefined;
        this.maintenanceTick();
      };
      void initialRecovery.then(release, release);
    }
    this.notifyConnectionChanged(false);
    this.inventoryTimer = setInterval(() => this.maintenanceTick(), INVENTORY_INTERVAL_MS);
    void this.connectOnce().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.initialRecovery = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.inventoryTimer) clearInterval(this.inventoryTimer);
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.maintenanceSocket = undefined;
    this.ready = false;
    this.notifyConnectionChanged(false);
    this.socket?.destroy();
    this.socket = undefined;
    this.streams?.closeAll();
    this.streams = undefined;
  }

  connected(): boolean { return this.ready && this.socket !== undefined && !this.socket.destroyed; }

  invokeDockTool(sourceNativeId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return Promise.reject(new Error("Main is offline. Reconnect it before using Dock tools."));
    const requestId = randomUUID();
    return new Promise<DockToolsResult>((resolve, reject) => {
      this.toolRequests.set(requestId, { resolve, reject });
      void writeMachine(socket, { kind: "machine_tool_request", requestId, sourceNativeId, request }).catch((error) => { this.toolRequests.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  disableDockToolsSource(sourceNativeId: string): Promise<void> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return Promise.resolve();
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.sourceOffRequests.set(requestId, { resolve, reject });
      void writeMachine(socket, { kind: "machine_tool_source_off", requestId, sourceNativeId }).catch((error) => { this.sourceOffRequests.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  attachObservationSink(sourceNativeId: string, sink: ObservationDeliverySink): () => void {
    this.observationSinks.set(sourceNativeId, sink);
    return () => { if (this.observationSinks.get(sourceNativeId) === sink) this.observationSinks.delete(sourceNativeId); };
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.connecting || this.connected()) return;
    this.connecting = true;
    try {
      await this.openConnection();
    } finally {
      this.connecting = false;
    }
  }

  private async openConnection(): Promise<void> {
    const record = this.record as SubHostUpstreamRecord;
    const socket = connect({
      host: this.options.address,
      port: this.options.port,
      key: record.identity.privateKeyPem,
      cert: record.identity.certificatePem,
      rejectUnauthorized: false,
    });
    this.socket = socket;
    const streams = new StreamAcceptor({
      hostEpoch: this.options.hostEpoch,
      write: (record) => writeMachine(socket, machineLinkRecord(record)),
      accept: (virtualSocket) => this.options.acceptProtocolSocket(virtualSocket),
      linkOpen: () => !socket.destroyed,
      failureLabel: "SubHost",
    });
    this.streams = streams;
    const decoder = new JsonLineDecoder(MAX_MACHINE_LINE_BYTES);
    let ready = false;
    let processing = Promise.resolve();
    socket.once("secureConnect", async () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer.raw) throw new Error("Main certificate is missing");
        const fingerprint = new X509Certificate(peer.raw).fingerprint256.replaceAll(":", "").toLowerCase();
        if (fingerprint !== record.mainFingerprint) throw new Error("Main certificate does not match the join file");
        const serialized = serializeInventory(await this.options.snapshots());
        await writeMachine(socket, {
          kind: "machine_hello",
          machineId: record.machineId,
          machineName: record.machineName,
          ...currentMachineFacts(),
          ...(record.joinToken ? { joinToken: record.joinToken } : {}),
          hostEpoch: this.options.hostEpoch,
        });
        await sendInventory(socket, this.options.hostEpoch, serialized);
        this.lastInventory = serialized;
      } catch { socket.destroy(); }
    });
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      processing = processing.then(async () => {
        const lines=decoder.push(chunk);
        if(ready&&streams.observePartial(MACHINE_LINK_DIALECT,decoder.partialRecord,decoder.recordSequence))this.lastMainRecordAt=Date.now();
        for (const line of lines) {
          const machineRecord = parseMachineRecord(line);
          if (!ready) {
            if (machineRecord.kind !== "machine_ready") throw new Error("Main did not accept the machine connection");
            ready = true;
            this.ready = true;
            this.lastMainRecordAt = Date.now();
            this.notifyConnectionChanged(true);
            if (record.joinToken) {
              record.joinToken = undefined;
              await this.options.state.markJoined();
            }
            // A recovery batch can settle while the initial inventory is in flight.
            this.maintenanceTick();
            continue;
          }
          await this.consumeSubHostRecord(socket, machineRecord);
        }
      }).catch(() => { socket.destroy(); }).finally(() => { if (!socket.destroyed) socket.resume(); });
    });
    socket.once("error", () => {});
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      if (this.maintenanceSocket === socket) this.maintenanceSocket = undefined;
      this.notifyConnectionChanged(false);
      streams.closeAll();
      if (this.streams === streams) this.streams = undefined;
      for (const pending of this.toolRequests.values()) pending.reject(new Error("Main went offline before the Dock tool completed"));
      this.toolRequests.clear();
      for (const pending of this.sourceOffRequests.values()) pending.reject(new Error("Main went offline before Dock tools were disabled"));
      this.sourceOffRequests.clear();
      if (!this.stopped) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connectOnce().catch(() => {});
        }, RECONNECT_DELAY_MS);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error("Timed out connecting to Main")); }, 5_000);
      const cleanup = (): void => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
      const onData = (): void => { if (ready) { cleanup(); resolve(); } else setImmediate(onData); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onClose = (): void => { cleanup(); reject(new Error("Main connection closed before it became ready")); };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  private notifyConnectionChanged(connected: boolean): void {
    try { void Promise.resolve(this.options.onConnectionChanged?.(connected)).catch(() => {}); }
    catch {}
  }

  private async consumeSubHostRecord(socket: TLSSocket, record: MachineWireRecord): Promise<void> {
    this.lastMainRecordAt = Date.now();
    if (record.kind === "machine_pong") return;
    if (record.kind === "machine_tool_source_off_ack") {
      const pending = this.sourceOffRequests.get(record.requestId);
      if (pending) { this.sourceOffRequests.delete(record.requestId); pending.resolve(); }
      return;
    }
    if (record.kind === "machine_tool_response") {
      const pending = this.toolRequests.get(record.requestId);
      if (!pending) return;
      this.toolRequests.delete(record.requestId);
      if (record.ok) pending.resolve(record.result);
      else pending.reject(new Error(record.error));
      return;
    }
    if (record.kind === "machine_tool_notification") {
      const sink = this.observationSinks.get(record.sourceNativeId);
      if (sink) void sink(record.notification).catch(() => {});
      return;
    }
    const stream = machineStreamRecord(record);
    if (stream) {
      if (stream.kind === "reset") machineWriters.get(socket)?.cancelStream(stream.streamId, new Error(stream.reason));
      await this.streams?.handle(stream);
      return;
    }
    throw new Error("Unexpected Main machine record");
  }


  private maintenanceTick(): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return;
    // Sleep can leave an earlier write or inventory read pending forever. Liveness
    // must still retire that half-open link so the normal reconnect path can run.
    if (Date.now() - this.lastMainRecordAt >= MACHINE_HEARTBEAT_TIMEOUT_MS) {
      socket.destroy();
      return;
    }
    if (this.maintenanceSocket === socket) return;
    this.maintenanceSocket = socket;
    void this.maintainConnection(socket).catch(() => { socket.destroy(); }).finally(() => {
      if (this.maintenanceSocket === socket) this.maintenanceSocket = undefined;
    });
  }

  private async maintainConnection(socket: TLSSocket): Promise<void> {
    await writeMachine(socket, { kind: "machine_ping" });
    await this.sendInventoryIfChanged(socket);
  }

  private async sendInventoryIfChanged(socket: TLSSocket): Promise<void> {
    // Initial handshake and heartbeats stay live; publish recovery results as one batch.
    if (this.initialRecovery) return;
    if (!this.ready || this.socket !== socket || socket.destroyed) return;
    const serialized = serializeInventory(await this.options.snapshots());
    if (!this.ready || this.socket !== socket || socket.destroyed || serialized === this.lastInventory) return;
    await sendInventory(socket, this.options.hostEpoch, serialized);
    if (this.ready && this.socket === socket && !socket.destroyed) this.lastInventory = serialized;
  }
}

export class SubHostDockToolsPort implements DockToolsHostPort {
  constructor(private readonly options: {
    upstream: SubHostMachineConnection;
    local: () => DockToolsHostPort;
  }) {}

  dockToolsEnabled(sourceInstanceId: string): boolean { return this.options.local().dockToolsEnabled(sourceInstanceId); }
  async configureDockTools(sourceInstanceId: string, enabled: boolean, operationId: string): Promise<{ enabled: boolean }> {
    const result = await this.options.local().configureDockTools(sourceInstanceId, enabled, operationId);
    if (!result.enabled) await this.options.upstream.disableDockToolsSource(sourceInstanceId);
    return result;
  }
  invokeDockTool(sourceInstanceId: string, request: DockToolsRequest): Promise<DockToolsResult> {
    if (request.type === "deliver") return this.options.local().invokeDockTool(sourceInstanceId, request);
    if (!this.dockToolsEnabled(sourceInstanceId)) return Promise.reject(new Error("Dock tools are off for this instance. Use /dock-tools on first."));
    return this.options.upstream.invokeDockTool(sourceInstanceId, request);
  }
  attachObservationSink(sourceInstanceId: string, sink: ObservationDeliverySink): () => void {
    return this.options.upstream.attachObservationSink(sourceInstanceId, sink);
  }
}

function isSnapshot(value: unknown): value is InstanceSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.creationOperationId === "string" && typeof record.runtimeGeneration === "number" && typeof record.lifecycle === "string";
}

function offlineSnapshot(snapshot: InstanceSnapshot, at: string): InstanceSnapshot {
  if (snapshot.lifecycle === "stopped") return snapshot;
  return {
    ...snapshot,
    lifecycle: "host_lost",
    execution: "unavailable",
    compacting: false,
    lastRun: snapshot.execution === "running" ? "interrupted" : snapshot.lastRun,
    reopenable: true,
    ownerHostEpoch: undefined,
    activeCommandId: undefined,
    activeInteraction: undefined,
    pending: { steering: 0, followUp: 0, total: 0 },
    interruption: { reason: "host_crash", at },
    updatedAt: at,
    executionChangedAt: at,
    runStartedAt: undefined,
  };
}

function offlineStopResult(operationId: string, source: InstanceSnapshot): { receipt: { operationId: string; alreadyStopped: boolean; cleanupErrors: string[] }; instance: InstanceSnapshot } {
  const at = new Date().toISOString();
  const instance: InstanceSnapshot = {
    ...source,
    lifecycle: "stopped",
    execution: "unavailable",
    compacting: false,
    reopenable: false,
    ownerHostEpoch: undefined,
    activeCommandId: undefined,
    activeInteraction: undefined,
    pending: { steering: 0, followUp: 0, total: 0 },
    interruption: undefined,
    updatedAt: at,
    executionChangedAt: at,
    runStartedAt: undefined,
  };
  return { receipt: { operationId, alreadyStopped: false, cleanupErrors: [] }, instance };
}

function parseMachineRecord(line: string): MachineWireRecord {
  const value = wireObject(JSON.parse(line) as unknown, "machine record");
  const kind = wireText(value.kind, "machine record kind", 64);
  const streamId = (): string => wireText(value.streamId, "machine stream ID", 128);
  if (kind === "machine_hello") {
    wireExact(value, ["kind", "machineId", "machineName", "platform", "homePath", "workspaceRoots", "joinToken", "hostEpoch"]);
    const platform = wireMachinePlatform(value.platform);
    const homePath = wireText(value.homePath, "machine Home path", MAX_CONTROL_CWD_CHARS);
    if (!isPortableAbsoluteLocalPath(homePath)) throw new Error("machine Home path must be absolute");
    const workspaceRoots = wireWorkspaceRoots(value.workspaceRoots, platform);
    return { kind, machineId: wireText(value.machineId, "machine ID", 128), machineName: wireText(value.machineName, "machine name", 256), platform, homePath, workspaceRoots, ...(value.joinToken === undefined ? {} : { joinToken: wireText(value.joinToken, "join token", 64) }), hostEpoch: wireText(value.hostEpoch, "Host identity", 128) };
  }
  if (kind === "machine_ready") { wireExact(value, ["kind", "mainHostEpoch"]); return { kind, mainHostEpoch: wireText(value.mainHostEpoch, "Main Host identity", 128) }; }
  if (kind === "machine_inventory_chunk") {
    wireExact(value, ["kind", "inventoryId", "hostEpoch", "index", "count", "data"]);
    const data = wireBase64(value.data, "machine inventory chunk", MAX_MACHINE_INVENTORY_CHUNK_BYTES);
    return { kind, inventoryId: wireText(value.inventoryId, "inventory ID", 128), hostEpoch: wireText(value.hostEpoch, "Host identity", 128), index: wireUnsigned(value.index, "inventory chunk index"), count: wirePositive(value.count, "inventory chunk count"), data };
  }
  if (kind === "machine_stream_open" || kind === "machine_stream_close") { wireExact(value, ["kind", "streamId"]); return { kind, streamId: streamId() }; }
  if (kind === "machine_stream_reset") { wireExact(value, ["kind", "streamId", "reason"]); return { kind, streamId: streamId(), reason: wireText(value.reason, "machine stream reset reason", 256) }; }
  if (kind === "machine_stream_data") { wireExact(value, ["kind", "streamId", "data"]); return { kind, streamId: streamId(), data: wirePayload(value.data, "machine stream data", MAX_CONTROL_LINE_BYTES) }; }
  if (kind === "machine_tool_request") {
    wireExact(value, ["kind", "requestId", "sourceNativeId", "request"]);
    return { kind, requestId: wireText(value.requestId, "tool request ID", 128), sourceNativeId: wireText(value.sourceNativeId, "tool source ID", 128), request: parseDockToolsRequest(value.request) };
  }
  if (kind === "machine_tool_response") {
    wireExact(value, ["kind", "requestId", "ok", "result", "error"]);
    const requestId = wireText(value.requestId, "tool request ID", 128);
    if (value.ok === true) { if (value.error !== undefined) throw new Error("Successful tool response carries an error"); parseDockToolsResult(value.result); return { kind, requestId, ok: true, result: structuredClone(value.result) as DockToolsResult }; }
    if (value.ok === false) { if (value.result !== undefined) throw new Error("Failed tool response carries a result"); return { kind, requestId, ok: false, error: wireText(value.error, "tool error", 2_048) }; }
    throw new Error("Tool response outcome is invalid");
  }
  if (kind === "machine_tool_notification") {
    wireExact(value, ["kind", "sourceNativeId", "notification"]);
    parseDockToolsResult({ type: "watch", status: "completed", completion: value.notification });
    return { kind, sourceNativeId: wireText(value.sourceNativeId, "tool source ID", 128), notification: structuredClone(value.notification) as ObservationNotification };
  }
  if (kind === "machine_tool_source_off") { wireExact(value, ["kind", "requestId", "sourceNativeId"]); return { kind, requestId: wireText(value.requestId, "tool request ID", 128), sourceNativeId: wireText(value.sourceNativeId, "tool source ID", 128) }; }
  if (kind === "machine_tool_source_off_ack") { wireExact(value, ["kind", "requestId"]); return { kind, requestId: wireText(value.requestId, "tool request ID", 128) }; }
  if (kind === "machine_ping" || kind === "machine_pong") { wireExact(value, ["kind"]); return { kind }; }
  throw new Error("Machine record kind is invalid");
}

function currentMachineFacts(): { platform: MachinePlatform; homePath: string; workspaceRoots: string[] } {
  const platform = process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : undefined;
  if (platform === undefined) throw new Error(`This Dock build does not support ${process.platform} as a Machine platform`);
  const homePath = homedir();
  if (!isNativeAbsoluteLocalPath(homePath)) throw new Error("This Host does not have an absolute user Home path");
  return { platform, homePath, workspaceRoots: platform === "windows" ? windowsWorkspaceRoots(homePath) : ["/"] };
}

function windowsWorkspaceRoots(homePath: string): string[] {
  const roots: string[] = [];
  for (let index = 0; index < MAX_WORKSPACE_ROOTS; index += 1) {
    const root = `${String.fromCharCode("A".charCodeAt(0) + index)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  const parsedHomeRoot = win32.parse(homePath).root;
  const homeRoot = `${parsedHomeRoot.slice(0, 1).toUpperCase()}${parsedHomeRoot.slice(1)}`;
  if (!isPortableLocalRootPath(homeRoot, "windows")) throw new Error("This Host does not have a Windows drive Home path");
  if (!roots.includes(homeRoot)) roots.push(homeRoot);
  return roots.sort();
}

function wireMachinePlatform(value: unknown): MachinePlatform {
  if (typeof value !== "string" || !MACHINE_PLATFORMS.includes(value as MachinePlatform)) throw new Error("machine platform is invalid");
  return value as MachinePlatform;
}

function wireWorkspaceRoots(value: unknown, platform: MachinePlatform): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORKSPACE_ROOTS) throw new Error("machine workspace roots are invalid");
  const roots = value.map((root) => wireText(root, "machine workspace root", MAX_CONTROL_CWD_CHARS));
  if (roots.some((root) => !isPortableLocalRootPath(root, platform))) throw new Error("machine workspace roots must be native filesystem roots");
  return roots;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function wirePayload(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) throw new Error(`${label} is invalid`); return value; }
function wireBase64(value: unknown, label: string, maxDecodedBytes: number): string {
  if (typeof value !== "string" || value.length < 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > maxDecodedBytes || decoded.toString("base64") !== value) throw new Error(`${label} is invalid`);
  return value;
}
function wireObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function wireText(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${label} is invalid`); return value; }
function wireUnsigned(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`); return value as number; }
function requestOperationId(request: ControlRequest): string | undefined {
  const operationId = (request.params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" ? operationId : undefined;
}

function wirePositive(value: unknown, label: string): number { const result = wireUnsigned(value, label); if (result < 1) throw new Error(`${label} is invalid`); return result; }
function wireExact(value: Record<string, unknown>, keys: readonly string[]): void { const allowed = new Set(keys); if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Machine record has unexpected fields"); }

function serializeInventory(snapshots: InstanceSnapshot[]): string {
  if (!Array.isArray(snapshots) || snapshots.length > MAX_CATALOG_INSTANCES) throw new Error("Machine inventory is invalid");
  assertUniqueNativeSnapshotIds(snapshots);
  const serialized = JSON.stringify(snapshots);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DURABLE_CATALOG_BYTES) throw new Error("Machine inventory exceeds the durable catalog boundary");
  return serialized;
}

async function sendInventory(socket: TLSSocket, hostEpoch: string, serialized: string): Promise<void> {
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DURABLE_CATALOG_BYTES) throw new Error("Machine inventory exceeds the durable catalog boundary");
  const inventoryId = randomUUID();
  const count = Math.ceil(bytes.byteLength / MAX_MACHINE_INVENTORY_CHUNK_BYTES);
  for (let index = 0; index < count; index += 1) {
    await writeMachine(socket, {
      kind: "machine_inventory_chunk",
      inventoryId,
      hostEpoch,
      index,
      count,
      data: bytes.subarray(index * MAX_MACHINE_INVENTORY_CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * MAX_MACHINE_INVENTORY_CHUNK_BYTES)).toString("base64"),
    });
  }
}

function consumeInventoryChunk(connection: MainConnection, record: Extract<MachineWireRecord, { kind: "machine_inventory_chunk" }>): InstanceSnapshot[] | undefined {
  const decoded = Buffer.from(record.data, "base64");
  const maxCount = Math.ceil(MAX_DURABLE_CATALOG_BYTES / MAX_MACHINE_INVENTORY_CHUNK_BYTES);
  if (record.count > maxCount || record.index >= record.count) throw new Error("Machine inventory chunk count is invalid");
  if (record.index < record.count - 1 && decoded.byteLength !== MAX_MACHINE_INVENTORY_CHUNK_BYTES) throw new Error("Machine inventory chunk boundary is invalid");
  if (!connection.inventory) {
    if (record.index !== 0) throw new Error("Machine inventory did not begin with its first chunk");
    connection.inventory = { inventoryId: record.inventoryId, hostEpoch: record.hostEpoch, count: record.count, nextIndex: 0, chunks: [], bytes: 0 };
  }
  const transfer = connection.inventory;
  if (transfer.inventoryId !== record.inventoryId || transfer.hostEpoch !== record.hostEpoch || transfer.count !== record.count || transfer.nextIndex !== record.index) throw new Error("Machine inventory chunks are out of order");
  if (transfer.bytes + decoded.byteLength > MAX_DURABLE_CATALOG_BYTES) throw new Error("Machine inventory exceeds the durable catalog boundary");
  transfer.chunks.push(decoded);
  transfer.bytes += decoded.byteLength;
  transfer.nextIndex += 1;
  if (transfer.nextIndex < transfer.count) return undefined;
  connection.inventory = undefined;
  return parseCompletedMachineInventory(Buffer.concat(transfer.chunks, transfer.bytes).toString("utf8"));
}

export function parseCompletedMachineInventory(serialized: string): InstanceSnapshot[] {
  const raw = JSON.parse(serialized) as unknown;
  if (!Array.isArray(raw) || raw.length > MAX_CATALOG_INSTANCES) throw new Error("Machine inventory is invalid");
  const snapshots = raw.map((snapshot, index) => parseInstanceSnapshot(snapshot, `machine snapshots[${index}]`));
  assertUniqueNativeSnapshotIds(snapshots);
  return snapshots;
}

function assertUniqueNativeSnapshotIds(snapshots: readonly InstanceSnapshot[]): void {
  const nativeIds = snapshots.map((snapshot) => snapshot.id);
  if (new Set(nativeIds).size !== nativeIds.length) throw new Error("Machine inventory contains duplicate native instance IDs");
}

function routeClaim(machineId: string, mainInstanceId: string): string { return `route:${machineId}:${mainInstanceId}`; }
function reservationClaim(reservation: KeyReservation): string { return `reservation:${reservation.token}`; }

function uniqueMainInstanceId(used: ReadonlySet<string>): string {
  let candidate = randomUUID();
  while (used.has(candidate)) candidate = randomUUID();
  return candidate;
}


type MachineOutputLane = LinkOutputLane;

function machineStreamRecord(record: MachineWireRecord): Exclude<LinkRecord, { kind: "ping" | "pong" }> | undefined {
  if (record.kind === "machine_stream_open") return { kind: "open", streamId: record.streamId };
  if (record.kind === "machine_stream_data") return { kind: "data", streamId: record.streamId, data: record.data };
  if (record.kind === "machine_stream_close") return { kind: "close", streamId: record.streamId };
  if (record.kind === "machine_stream_reset") return { kind: "reset", streamId: record.streamId, reason: record.reason };
  return undefined;
}

function machineLinkRecord(record: LinkRecord): MachineWireRecord {
  return encodeLinkRecord(MACHINE_LINK_DIALECT, record) as MachineWireRecord;
}

function outputLane(record: MachineWireRecord): MachineOutputLane {
  if (record.kind === "machine_ping" || record.kind === "machine_pong" || record.kind === "machine_stream_reset") return { kind: "urgent" };
  if (record.kind === "machine_stream_data" || record.kind === "machine_stream_close") return { kind: "stream", streamId: record.streamId };
  if (record.kind === "machine_inventory_chunk") return { kind: "bulk" };
  return { kind: "control" };
}

const machineWriters = new WeakMap<TLSSocket, LinkWriter<MachineWireRecord>>();
export async function writeMachine(socket: TLSSocket, record: MachineWireRecord): Promise<void> {
  let writer = machineWriters.get(socket);
  if (!writer) {
    writer = new LinkWriter<MachineWireRecord>(socket, {
      laneOf: outputLane,
      resetOf: (item) => item.kind === "machine_stream_reset" ? { streamId: item.streamId, reason: item.reason } : undefined,
      makeReset: (streamId, reason) => ({ kind: "machine_stream_reset", streamId, reason }),
    });
    machineWriters.set(socket, writer);
  }
  await writer.write(record);
}

function machineSocketKey(socket: Socket): string | undefined {
  if (!socket.remoteAddress || socket.remotePort === undefined || !socket.localAddress || socket.localPort === undefined) return undefined;
  return `${socket.remoteAddress}:${socket.remotePort}->${socket.localAddress}:${socket.localPort}`;
}

function listen(server: TlsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: TlsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
