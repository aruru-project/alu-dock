import { randomUUID, X509Certificate } from "node:crypto";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { createServer, connect, type Server as TlsServer, type TLSSocket } from "node:tls";

import { MAX_CATALOG_INSTANCES } from "../core/catalog.js";
import type { InstanceSnapshot } from "../core/managed-instance.js";
import type { DockToolsHostPort, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import { parseDockToolsRequest, parseDockToolsResult } from "../core/dock-tools-codec.js";
import type { ObservationDeliverySink, ObservationNotification } from "../core/instance-observation.js";
import { MAX_CONTROL_LINE_BYTES, MAX_INSTANCE_LIST_RESULT_BYTES, type ControlError, type ControlRequest, type EnsureResult, type MachineDto, ProtocolValidationError } from "./protocol.js";
import { decodeResponseTransfer, parseControlResponse, parseEnsureResult, parseForgetResult, parseInstanceSnapshot, parseResponseTransferFrame } from "./protocol.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import { boundedInstanceListPage } from "./instance-list-page.js";
import { MainMachineState, SubHostMachineState, type MachineRouteRecord, type SubHostUpstreamRecord, type TrustedSubHostRecord } from "./machine-state.js";
import { recordForMainHost, requestForNativeHost, snapshotForMain, type MachineRouteIdentity } from "./machine-route-identity.js";
import { MAX_DOCK_TRANSFER_BYTES, MAX_RESPONSE_TRANSFER_CHUNK_BYTES, MAX_RESPONSE_TRANSFER_CHUNKS } from "../core/transport-bounds.js";
import { MAX_DURABLE_CATALOG_BYTES } from "./durable-catalog-store.js";

const MAX_MACHINE_LINE_BYTES = 2 * MAX_CONTROL_LINE_BYTES;
const MAX_MACHINE_STREAMS = 256;
export const MAX_MACHINE_CONNECTIONS = 64;
const MACHINE_TLS_HANDSHAKE_TIMEOUT_MS = 5_000;
const MACHINE_ADMISSION_TIMEOUT_MS = 10_000;
const MAX_MACHINE_QUEUED_BYTES = 8 * MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_INVENTORY_CHUNK_BYTES = Math.floor((MAX_MACHINE_LINE_BYTES - 1_024) * 3 / 4);
const INVENTORY_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 250;
const MACHINE_HEARTBEAT_TIMEOUT_MS = 5_000;

type MachineWireRecord =
  | { kind: "machine_hello"; machineId: string; machineName: string; joinToken?: string; hostEpoch: string }
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

export interface RoutedProtocolProxy {
  send(record: unknown): Promise<void>;
  close(): void;
}

export type RouteDecision =
  | { kind: "local" }
  | { kind: "result"; result: unknown }
  | { kind: "route"; proxy: RoutedProtocolProxy };

export interface MainRouteAuthority {
  route(request: ControlRequest, emit: (record: unknown) => void | Promise<void>, ended: () => void): Promise<RouteDecision>;
  getByKey(key: string): Promise<InstanceSnapshot | undefined>;
  ensureByKey(request: Extract<ControlRequest, { type: "instance.ensure" }>, ensureLocal: () => Promise<EnsureResult>): Promise<EnsureResult>;
  machines(): Promise<MachineDto[]>;
  listPage(local: InstanceSnapshot[], params: Extract<ControlRequest, { type: "instance.list" }>['params']): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

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

interface SubHostStream {
  streamId: string;
  socket: MachineVirtualSocket;
  acceptingInput: boolean;
  inputTail: Promise<void>;
  queuedInputBytes: number;
}

export class MainMachineController implements MainRouteAuthority {
  private server: TlsServer | undefined;
  private staleConnectionTimer: NodeJS.Timeout | undefined;
  private readonly connections = new Map<string, MainConnection>();
  private readonly acceptedSockets = new Map<string, AcceptedMachineSocket>();
  private authorityTail = Promise.resolve();
  private readonly keyReservations = new Map<string, KeyReservation>();
  private readonly latestInstalledCandidate = new Map<string, number>();
  private nextCandidateOrdinal = 0;
  private revision = 0;
  private listFingerprint = "";
  private readonly routeSnapshots = new Map<string, InstanceSnapshot>();
  private readonly snapshotListeners = new Map<string, Set<(snapshot: InstanceSnapshot) => void>>();
  private readonly disconnectListeners = new Set<(instanceIds: readonly string[]) => void>();
  private mainId = "";
  private mainName = "Main";
  private started = false;

  constructor(private readonly options: {
    state: MainMachineState;
    port?: number;
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
      const identity = await this.options.state.identity();
      const main = await this.options.state.main();
      this.mainId = main.id;
      this.mainName = main.name;
      this.revision = main.revision;
      for (const machine of await this.options.state.list()) await this.markOffline(machine.id);
      await this.refreshRouteSnapshotCache();
      if (this.options.port === undefined) return;
      const server = createServer({
        key: identity.privateKeyPem,
        cert: identity.certificatePem,
        requestCert: true,
        rejectUnauthorized: false,
      }, (socket) => this.acceptSecure(socket));
      server.on("connection", (socket) => this.acceptRaw(socket));
      server.on("tlsClientError", () => {});
      try {
        await listen(server, this.options.port, this.options.bindAddress ?? "::");
        this.server = server;
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      this.staleConnectionTimer = setInterval(() => {
        const now = Date.now();
        for (const connection of this.connections.values()) {
          if (now - connection.lastSeenAt >= MACHINE_HEARTBEAT_TIMEOUT_MS) connection.socket.destroy();
        }
      }, INVENTORY_INTERVAL_MS);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const server = this.server;
    this.server = undefined;
    if (this.staleConnectionTimer) clearInterval(this.staleConnectionTimer);
    this.staleConnectionTimer = undefined;
    const closePromise = server ? closeServer(server) : Promise.resolve();
    for (const connection of [...this.connections.values()]) this.disconnect(connection);
    this.connections.clear();
    for (const accepted of this.acceptedSockets.values()) {
      clearTimeout(accepted.deadline);
      accepted.tls?.destroy();
      accepted.raw.destroy();
    }
    await closePromise;
    for (const accepted of this.acceptedSockets.values()) clearTimeout(accepted.deadline);
    this.acceptedSockets.clear();
    await this.authorityTail;
  }

  remoteSnapshotsCurrent(): InstanceSnapshot[] { return [...this.routeSnapshots.values()].map((snapshot) => structuredClone(snapshot)); }
  subscribeSnapshot(instanceId: string, listener: (snapshot: InstanceSnapshot) => void): (() => void) | undefined {
    if (!this.routeSnapshots.has(instanceId)) return undefined;
    const listeners = this.snapshotListeners.get(instanceId) ?? new Set<(snapshot: InstanceSnapshot) => void>();
    listeners.add(listener); this.snapshotListeners.set(instanceId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.snapshotListeners.delete(instanceId); };
  }
  onMachineDisconnected(listener: (instanceIds: readonly string[]) => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }

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
        return parseEnsureResult(await this.requestRemote(request, decision.reservation));
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

  async requestRemote(request: ControlRequest, keyReservation?: KeyReservation): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let proxy: RoutedProtocolProxy | undefined;
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        proxy?.close();
        error ? reject(error) : resolve(result);
      };
      void this.routeWithReservation(request, (record) => {
        if (!record || typeof record !== "object" || (record as { kind?: unknown }).kind !== "response") return;
        try {
          const response = parseControlResponse(record, request.requestId, this.options.mainHostEpoch);
          if (response.ok) finish(undefined, response.result);
          else finish(new RoutedControlError(response.error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }, () => {
        if (settled) return;
        const operationId = requestOperationId(request);
        finish(operationId === undefined
          ? new Error("That machine disconnected before the request finished. Wait for it to reconnect and try again.")
          : new MachineMutationEffectUnknownError(operationId));
      }, keyReservation).then((decision) => {
        if (decision.kind !== "route") { finish(new Error("Dock request did not select a SubHost")); return; }
        proxy = decision.proxy;
        if (settled) proxy.close();
      }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  async machines(): Promise<MachineDto[]> {
    const records = await this.options.state.list();
    return [
      { hostId: this.mainId, name: this.mainName, kind: "main", available: true },
      ...records.map((machine) => ({ hostId: machine.id, name: machine.name, kind: "subhost" as const, available: this.connectionLive(this.connections.get(machine.id)) })),
    ];
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

  async route(request: ControlRequest, emit: (record: unknown) => void | Promise<void>, ended: () => void): Promise<RouteDecision> {
    return this.routeWithReservation(request, emit, ended);
  }

  private async routeWithReservation(request: ControlRequest, emit: (record: unknown) => void | Promise<void>, ended: () => void, keyReservation?: KeyReservation): Promise<RouteDecision> {
    if (request.type === "machine.list" || request.type === "instance.list" || request.type === "host.info" || request.type === "instance.get_by_key") return { kind: "local" };
    const machines = await this.options.state.list();
    const instanceId = "instanceId" in request.params && typeof request.params.instanceId === "string" ? request.params.instanceId : undefined;
    let machine: TrustedSubHostRecord | undefined;
    let route: MachineRouteRecord | undefined;
    if (instanceId) {
      for (const candidate of machines) {
        const found = candidate.routes.find((item) => item.mainInstanceId === instanceId);
        if (found) { machine = candidate; route = found; break; }
      }
      if (!route) return { kind: "local" };
    } else {
      const hostId = "hostId" in request.params && typeof request.params.hostId === "string" ? request.params.hostId : undefined;
      if (!hostId || hostId === this.mainId) return { kind: "local" };
      machine = machines.find((item) => item.id === hostId);
      if (!machine) throw new ProtocolValidationError("host_not_found", "That machine is not connected to this Dock");
    }
    const candidateConnection = machine ? this.connections.get(machine.id) : undefined;
    const connection = this.connectionLive(candidateConnection) ? candidateConnection : undefined;
    if (!connection) {
      if (request.type === "instance.stop" && route) {
        const result = offlineStopResult(request.params.operationId, route.snapshot);
        const stopped = (result as { instance: InstanceSnapshot }).instance;
        await this.serializeAuthority(async () => {
          await this.options.state.removeRoute(route.mainInstanceId);
          this.routeSnapshots.delete(route.mainInstanceId);
          this.revision += 1;
        });
        for (const listener of this.snapshotListeners.get(route.mainInstanceId) ?? []) listener(structuredClone(stopped));
        for (const listener of this.disconnectListeners) listener([route.mainInstanceId]);
        return { kind: "result", result };
      }
      throw new ProtocolValidationError("host_unavailable", "That machine is offline. Reconnect it and try again");
    }
    const identity: MachineRouteIdentity | undefined = route ? {
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
      machineId: machine!.id,
      connection,
      requestId: request.requestId,
      requestType: request.type,
      route: identity ?? {
        mainInstanceId: "",
        nativeInstanceId: "",
        mainHostEpoch: this.options.mainHostEpoch,
        nativeHostEpoch: connection.hostEpoch,
      },
      ...(keyReservation === undefined ? {} : { keyReservation }),
      emit,
      ended,
      helloSeen: false,
      acceptingInput: true,
      inputTail: Promise.resolve(),
      queuedInputBytes: 0,
    };
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
          requiredCapabilities: [],
        }),
      });
      const nativeRequest = requestForNativeHost(request, identity);
      await writeMachine(connection.socket, { kind: "machine_stream_data", streamId, data: JSON.stringify(nativeRequest) });
    } catch (error) {
      this.resetMainStream(connection, stream, diagnosticReason(error, "Could not open routed stream"));
      throw error;
    }
    return {
      kind: "route",
      proxy: {
        send: async (record) => {
          try { await writeMachine(connection.socket, { kind: "machine_stream_data", streamId, data: JSON.stringify(record) }); }
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
        for (const line of decoder.push(chunk)) {
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

  private disconnect(connection: MainConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connections.get(connection.machine.id) === connection) this.connections.delete(connection.machine.id);
    for (const stream of connection.streams.values()) stream.ended();
    connection.streams.clear();
    void this.markOfflineUnlessConnected(connection.machine.id);
  }

  private async completeInitialInventory(connection: MainConnection, hostEpoch: string, snapshots: InstanceSnapshot[]): Promise<void> {
    const projection = await this.serializeAuthority(async () => {
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
    let machine = await this.options.state.get(hello.machineId);
    if (!machine) {
      if (!hello.joinToken) throw new Error("SubHost is not joined");
      machine = await this.options.state.acceptJoin({
        token: hello.joinToken,
        machineId: hello.machineId,
        machineName: hello.machineName,
        certificatePem: certificate.toString(),
      });
    } else if (machine.fingerprint !== fingerprint) throw new Error("SubHost certificate does not match its trust record");
    this.nextCandidateOrdinal += 1;
    return { machine, socket, hostEpoch: hello.hostEpoch, streams: new Map(), lastSeenAt: Date.now(), candidateOrdinal: this.nextCandidateOrdinal, closed: false };
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
      this.closeMainStream(connection, record.streamId, false);
      return;
    }
    if (record.kind === "machine_stream_close") {
      const stream = connection.streams.get(record.streamId);
      if (stream) {
        stream.acceptingInput = false;
        this.enqueueMainStream(connection, stream, 0, async () => { this.closeMainStream(connection, stream.streamId, false); });
      }
      return;
    }
    if (record.kind !== "machine_stream_data") throw new Error("Unexpected SubHost machine record");
    const stream = connection.streams.get(record.streamId);
    if (!stream || !stream.acceptingInput) return;
    this.enqueueMainStream(connection, stream, Buffer.byteLength(record.data, "utf8"), async () => {
      const raw = JSON.parse(record.data) as unknown;
      if (!stream.helloSeen) {
        if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "hello_ack") throw new Error("SubHost stream did not negotiate Protocol V2");
        stream.helloSeen = true;
        return;
      }
      const mapped = await this.mapRemoteStreamRecord(stream, raw);
      await this.emitMappedStreamRecords(stream, mapped);
    });
  }

  private async emitMappedStreamRecords(stream: MainStream, records: readonly unknown[]): Promise<void> {
    for (const record of records) {
      this.assertStreamEmissionCurrent(stream);
      await stream.emit(record);
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
    if (stream.queuedInputBytes + bytes > MAX_MACHINE_QUEUED_BYTES) {
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
      mappedStopped = snapshotForMain(nativeStopped, stream.route.mainInstanceId, this.options.mainHostEpoch, stream.route.mainKey);
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
      this.routeSnapshots.delete(stream.route.mainInstanceId);
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
    this.routeSnapshots.set(mainInstanceId, structuredClone(mapped));
    this.revision += 1;
    return {
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
    connection.streams.delete(streamId);
    if (notify && !connection.socket.destroyed) void writeMachine(connection.socket, { kind: "machine_stream_close", streamId }).catch(() => {});
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
    await this.refreshRouteSnapshotCache();
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
    await this.refreshRouteSnapshotCache();
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
    return snapshotForMain(native, mainInstanceId, this.options.mainHostEpoch, ownsKey ? requestedKey : undefined);
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

  private connectionLive(connection: MainConnection | undefined): connection is MainConnection { return connection !== undefined && !connection.closed && !connection.socket.destroyed && Date.now() - connection.lastSeenAt < MACHINE_HEARTBEAT_TIMEOUT_MS; }

  private async refreshRouteSnapshotCache(): Promise<void> {
    this.routeSnapshots.clear();
    for (const machine of await this.options.state.list()) for (const route of machine.routes) this.routeSnapshots.set(route.mainInstanceId, structuredClone(route.snapshot));
  }
}

export class SubHostMachineConnection {
  private socket: TLSSocket | undefined;
  private ready = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private inventoryTimer: NodeJS.Timeout | undefined;
  private readonly streams = new Map<string, SubHostStream>();
  private readonly toolRequests = new Map<string, { resolve: (result: DockToolsResult) => void; reject: (error: Error) => void }>();
  private readonly sourceOffRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly observationSinks = new Map<string, ObservationDeliverySink>();
  private record: SubHostUpstreamRecord | undefined;
  private lastInventory = "";
  private lastMainRecordAt = 0;
  private maintenancePending = false;

  constructor(private readonly options: {
    state: SubHostMachineState;
    address: string;
    port: number;
    hostEpoch: string;
    snapshots: () => InstanceSnapshot[] | Promise<InstanceSnapshot[]>;
    acceptProtocolSocket: (socket: Socket) => void;
    onConnectionChanged?: (connected: boolean) => void | Promise<void>;
  }) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.record = await this.options.state.load();
    if (!this.record) throw new Error("SubHost has not been prepared with a join file");
    this.stopped = false;
    await this.notifyConnectionChanged(false);
    this.inventoryTimer = setInterval(() => {
      if (this.maintenancePending) return;
      this.maintenancePending = true;
      void this.maintainConnection().catch(() => {}).finally(() => { this.maintenancePending = false; });
    }, INVENTORY_INTERVAL_MS);
    void this.connectOnce().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.inventoryTimer) clearInterval(this.inventoryTimer);
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.ready = false;
    await this.notifyConnectionChanged(false);
    this.socket?.destroy();
    this.socket = undefined;
    for (const stream of this.streams.values()) stream.socket.remoteClose();
    this.streams.clear();
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
    const record = this.record as SubHostUpstreamRecord;
    const socket = connect({
      host: this.options.address,
      port: this.options.port,
      key: record.identity.privateKeyPem,
      cert: record.identity.certificatePem,
      rejectUnauthorized: false,
    });
    this.socket = socket;
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
        for (const line of decoder.push(chunk)) {
          const machineRecord = parseMachineRecord(line);
          if (!ready) {
            if (machineRecord.kind !== "machine_ready") throw new Error("Main did not accept the machine connection");
            ready = true;
            this.ready = true;
            this.lastMainRecordAt = Date.now();
            await this.notifyConnectionChanged(true);
            if (record.joinToken) {
              record.joinToken = undefined;
              await this.options.state.markJoined();
            }
            continue;
          }
          await this.consumeSubHostRecord(socket, machineRecord);
        }
      }).catch(() => { socket.destroy(); }).finally(() => { if (!socket.destroyed) socket.resume(); });
    });
    socket.once("error", () => {});
    socket.once("close", () => {
      if (this.socket === socket) { this.socket = undefined; this.ready = false; void this.notifyConnectionChanged(false); }
      for (const stream of this.streams.values()) stream.socket.remoteClose();
      this.streams.clear();
      for (const pending of this.toolRequests.values()) pending.reject(new Error("Main went offline before the Dock tool completed"));
      this.toolRequests.clear();
      for (const pending of this.sourceOffRequests.values()) pending.reject(new Error("Main went offline before Dock tools were disabled"));
      this.sourceOffRequests.clear();
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => { void this.connectOnce().catch(() => {}); }, RECONNECT_DELAY_MS);
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

  private async notifyConnectionChanged(connected: boolean): Promise<void> {
    await this.options.onConnectionChanged?.(connected);
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
    if (record.kind === "machine_stream_open") {
      if (this.streams.size >= MAX_MACHINE_STREAMS || this.streams.has(record.streamId)) {
        await writeMachine(socket, { kind: "machine_stream_reset", streamId: record.streamId, reason: "Stream could not be opened" });
        return;
      }
      let stream!: SubHostStream;
      const virtualSocket = new MachineVirtualSocket(
        (data) => writeMachine(socket, { kind: "machine_stream_data", streamId: record.streamId, data: data.toString("utf8").replace(/\n$/u, "") }),
        (reason) => {
          if (this.streams.get(record.streamId) !== stream) return;
          this.streams.delete(record.streamId);
          if (!socket.destroyed) void writeMachine(socket, reason
            ? { kind: "machine_stream_reset", streamId: record.streamId, reason: diagnosticReason(reason, "SubHost stream failed") }
            : { kind: "machine_stream_close", streamId: record.streamId }).catch(() => {});
        },
      );
      stream = { streamId: record.streamId, socket: virtualSocket, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0 };
      this.streams.set(record.streamId, stream);
      try { this.options.acceptProtocolSocket(virtualSocket as unknown as Socket); }
      catch (error) { this.resetSubHostStream(socket, stream, diagnosticReason(error, "SubHost stream was rejected")); }
      return;
    }
    if (record.kind === "machine_stream_data") {
      const stream = this.streams.get(record.streamId);
      if (stream?.acceptingInput) this.enqueueSubHostStream(socket, stream, Buffer.byteLength(record.data, "utf8"), () => stream.socket.receive(Buffer.from(`${record.data}\n`, "utf8")));
      return;
    }
    if (record.kind === "machine_stream_close") {
      const stream = this.streams.get(record.streamId);
      if (stream) {
        stream.acceptingInput = false;
        this.enqueueSubHostStream(socket, stream, 0, async () => {
          if (this.streams.get(stream.streamId) === stream) this.streams.delete(stream.streamId);
          stream.socket.remoteClose();
        });
      }
      return;
    }
    if (record.kind === "machine_stream_reset") {
      const stream = this.streams.get(record.streamId);
      if (stream) {
        stream.acceptingInput = false;
        this.streams.delete(record.streamId);
        stream.socket.remoteReset(new Error(record.reason));
      }
      return;
    }
    throw new Error("Unexpected Main machine record");
  }

  private enqueueSubHostStream(socket: TLSSocket, stream: SubHostStream, bytes: number, work: () => Promise<void>): void {
    if (stream.queuedInputBytes + bytes > MAX_MACHINE_QUEUED_BYTES) {
      this.resetSubHostStream(socket, stream, "Stream input queue exceeded its bound");
      return;
    }
    stream.queuedInputBytes += bytes;
    const queued = stream.inputTail.then(async () => {
      if (this.streams.get(stream.streamId) !== stream) return;
      await work();
    }).finally(() => { stream.queuedInputBytes -= bytes; });
    stream.inputTail = queued.catch((error) => {
      this.resetSubHostStream(socket, stream, diagnosticReason(error, "SubHost stream input failed"));
    });
  }

  private resetSubHostStream(socket: TLSSocket, stream: SubHostStream, reason: string): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    stream.acceptingInput = false;
    this.streams.delete(stream.streamId);
    stream.socket.localReset();
    if (!socket.destroyed) void writeMachine(socket, {
      kind: "machine_stream_reset",
      streamId: stream.streamId,
      reason: diagnosticReason(reason, "SubHost stream failed"),
    }).catch(() => {});
  }

  private async maintainConnection(): Promise<void> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return;
    if (Date.now() - this.lastMainRecordAt >= MACHINE_HEARTBEAT_TIMEOUT_MS) { socket.destroy(); return; }
    await writeMachine(socket, { kind: "machine_ping" });
    await this.sendInventoryIfChanged();
  }

  private async sendInventoryIfChanged(): Promise<void> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return;
    const serialized = serializeInventory(await this.options.snapshots());
    if (serialized === this.lastInventory) return;
    await sendInventory(socket, this.options.hostEpoch, serialized);
    this.lastInventory = serialized;
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

class MachineVirtualSocket extends Duplex {
  private closedByRemote = false;
  private closeSent = false;
  private failureReason: string | undefined;
  private readableDrain: (() => void) | undefined;
  constructor(private readonly sendData: (data: Buffer) => Promise<void>, private readonly sendClose: (reason?: string) => void) {
    super({ readableHighWaterMark: MAX_CONTROL_LINE_BYTES, writableHighWaterMark: MAX_CONTROL_LINE_BYTES });
    this.once("close", () => {
      this.resolveReadableDrain();
      if (!this.closedByRemote) this.notifyClose(this.failureReason ?? (this.writableFinished ? undefined : "SubHost protocol stream closed"));
    });
  }
  _read(): void { this.resolveReadableDrain(); }
  _write(chunk: Buffer | string | Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.sendData(Buffer.from(chunk)).then(() => callback(), (error) => {
      this.failureReason = diagnosticReason(error, "SubHost stream output failed");
      callback(error as Error);
    });
  }
  _final(callback: (error?: Error | null) => void): void { this.notifyClose(); callback(); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (error) this.failureReason = diagnosticReason(error, "SubHost protocol stream failed");
    this.resolveReadableDrain();
    callback(error);
  }
  receive(data: Buffer): Promise<void> {
    if (this.destroyed || this.push(data)) return Promise.resolve();
    return new Promise((resolve) => { this.readableDrain = resolve; });
  }
  remoteClose(): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) { this.push(null); this.destroy(); } }
  remoteReset(error: Error): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) this.destroy(error); }
  localReset(): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) this.destroy(); }
  private notifyClose(reason?: string): void { if (this.closeSent) return; this.closeSent = true; this.sendClose(reason); }
  private resolveReadableDrain(): void { const resume = this.readableDrain; this.readableDrain = undefined; resume?.(); }
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

function offlineStopResult(operationId: string, source: InstanceSnapshot): unknown {
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
    wireExact(value, ["kind", "machineId", "machineName", "joinToken", "hostEpoch"]);
    return { kind, machineId: wireText(value.machineId, "machine ID", 128), machineName: wireText(value.machineName, "machine name", 256), ...(value.joinToken === undefined ? {} : { joinToken: wireText(value.joinToken, "join token", 64) }), hostEpoch: wireText(value.hostEpoch, "Host identity", 128) };
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

function diagnosticReason(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const reason = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 256);
  return reason || fallback;
}

type MachineOutputLane =
  | { kind: "urgent" }
  | { kind: "control" }
  | { kind: "bulk" }
  | { kind: "stream"; streamId: string };

interface PendingMachineWrite {
  bytes: Buffer;
  lane: MachineOutputLane;
  resolve: () => void;
  reject: (error: Error) => void;
}

const MAX_MACHINE_STREAM_OUTPUT_BYTES = 2 * MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_BULK_OUTPUT_BYTES = 2 * MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_NON_PROTECTED_OUTPUT_BYTES = 5 * MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_CONTROL_OUTPUT_BYTES = 2 * MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_URGENT_OUTPUT_BYTES = MAX_MACHINE_LINE_BYTES;
const MAX_MACHINE_TOTAL_OUTPUT_BYTES = 8 * MAX_MACHINE_LINE_BYTES;

class MachineWriter {
  private readonly urgent: PendingMachineWrite[] = [];
  private readonly control: PendingMachineWrite[] = [];
  private readonly normal = new Map<string, PendingMachineWrite[]>();
  private readonly normalOrder: string[] = [];
  private readonly streamBytes = new Map<string, number>();
  private readonly failedStreams = new Set<string>();
  private readonly resetWrites = new Map<string, Promise<void>>();
  private urgentBytes = 0;
  private controlBytes = 0;
  private bulkBytes = 0;
  private nonProtectedBytes = 0;
  private totalBytes = 0;
  private draining = false;
  private failed: Error | undefined;

  constructor(private readonly socket: TLSSocket) {}

  write(record: MachineWireRecord): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (record.kind === "machine_stream_reset") {
      const existingReset = this.resetWrites.get(record.streamId);
      if (existingReset) return existingReset;
      this.failStreamLane(record.streamId, new Error(record.reason));
    }
    const bytes = Buffer.from(encodeJsonLine(record), "utf8");
    if (bytes.byteLength > MAX_MACHINE_LINE_BYTES) return Promise.reject(new Error("Machine link record exceeds its line bound"));
    const lane = outputLane(record);
    const overflow = this.overflow(lane, bytes.byteLength);
    if (overflow) {
      if (lane.kind === "stream") {
        this.failStreamLane(lane.streamId, overflow);
        void this.write({ kind: "machine_stream_reset", streamId: lane.streamId, reason: "Stream output queue exceeded its bound" }).catch(() => {});
      }
      return Promise.reject(overflow);
    }
    const write = new Promise<void>((resolve, reject) => {
      const pending = { bytes, lane, resolve, reject };
      this.reserve(pending);
      this.enqueue(pending);
      void this.drain();
    });
    if (record.kind === "machine_stream_reset") {
      this.resetWrites.set(record.streamId, write);
      const cleanup = (): void => {
        if (this.resetWrites.get(record.streamId) === write) this.resetWrites.delete(record.streamId);
        this.failedStreams.delete(record.streamId);
      };
      void write.then(cleanup, cleanup);
    }
    return write;
  }

  private overflow(lane: MachineOutputLane, bytes: number): Error | undefined {
    if (lane.kind === "stream" && this.failedStreams.has(lane.streamId)) return new Error("Machine stream output queue exceeded its bound");
    if (this.totalBytes + bytes > MAX_MACHINE_TOTAL_OUTPUT_BYTES) return new Error("Machine link aggregate output queue exceeded its bound");
    if (lane.kind === "urgent" && this.urgentBytes + bytes > MAX_MACHINE_URGENT_OUTPUT_BYTES) return new Error("Machine link urgent output queue exceeded its bound");
    if (lane.kind === "control" && this.controlBytes + bytes > MAX_MACHINE_CONTROL_OUTPUT_BYTES) return new Error("Machine link control output queue exceeded its bound");
    if (lane.kind === "bulk" && (this.bulkBytes + bytes > MAX_MACHINE_BULK_OUTPUT_BYTES || this.nonProtectedBytes + bytes > MAX_MACHINE_NON_PROTECTED_OUTPUT_BYTES)) return new Error("Machine link inventory output queue exceeded its bound");
    if (lane.kind === "stream" && ((this.streamBytes.get(lane.streamId) ?? 0) + bytes > MAX_MACHINE_STREAM_OUTPUT_BYTES || this.nonProtectedBytes + bytes > MAX_MACHINE_NON_PROTECTED_OUTPUT_BYTES)) return new Error("Machine stream output queue exceeded its bound");
    return undefined;
  }

  private reserve(pending: PendingMachineWrite): void {
    const bytes = pending.bytes.byteLength;
    this.totalBytes += bytes;
    if (pending.lane.kind === "urgent") this.urgentBytes += bytes;
    else if (pending.lane.kind === "control") this.controlBytes += bytes;
    else {
      this.nonProtectedBytes += bytes;
      if (pending.lane.kind === "bulk") this.bulkBytes += bytes;
      else this.streamBytes.set(pending.lane.streamId, (this.streamBytes.get(pending.lane.streamId) ?? 0) + bytes);
    }
  }

  private release(pending: PendingMachineWrite): void {
    const bytes = pending.bytes.byteLength;
    this.totalBytes -= bytes;
    if (pending.lane.kind === "urgent") this.urgentBytes -= bytes;
    else if (pending.lane.kind === "control") this.controlBytes -= bytes;
    else {
      this.nonProtectedBytes -= bytes;
      if (pending.lane.kind === "bulk") this.bulkBytes -= bytes;
      else {
        const remaining = (this.streamBytes.get(pending.lane.streamId) ?? bytes) - bytes;
        if (remaining === 0) this.streamBytes.delete(pending.lane.streamId);
        else this.streamBytes.set(pending.lane.streamId, remaining);
      }
    }
  }

  private enqueue(pending: PendingMachineWrite): void {
    if (pending.lane.kind === "urgent") { this.urgent.push(pending); return; }
    if (pending.lane.kind === "control") { this.control.push(pending); return; }
    const key = pending.lane.kind === "bulk" ? "bulk" : `stream:${pending.lane.streamId}`;
    const queue = this.normal.get(key);
    if (queue) queue.push(pending);
    else { this.normal.set(key, [pending]); this.normalOrder.push(key); }
  }

  private take(): PendingMachineWrite | undefined {
    const protectedWrite = this.urgent.shift() ?? this.control.shift();
    if (protectedWrite) return protectedWrite;
    const key = this.normalOrder.shift();
    if (!key) return undefined;
    const queue = this.normal.get(key) as PendingMachineWrite[];
    const pending = queue.shift() as PendingMachineWrite;
    if (queue.length === 0) this.normal.delete(key);
    else this.normalOrder.push(key);
    return pending;
  }

  private failStreamLane(streamId: string, error: Error): void {
    this.failedStreams.add(streamId);
    const key = `stream:${streamId}`;
    const queue = this.normal.get(key);
    if (!queue) return;
    this.normal.delete(key);
    const orderIndex = this.normalOrder.indexOf(key);
    if (orderIndex >= 0) this.normalOrder.splice(orderIndex, 1);
    for (const pending of queue) { this.release(pending); pending.reject(error); }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.failed) {
        const pending = this.take();
        if (!pending) return;
        try {
          await writeMachineBytes(this.socket, pending.bytes);
          pending.resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.failed = failure;
          pending.reject(failure);
          this.rejectQueued(failure);
        } finally {
          this.release(pending);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private rejectQueued(error: Error): void {
    const pending = [...this.urgent.splice(0), ...this.control.splice(0), ...[...this.normal.values()].flatMap((queue) => queue.splice(0))];
    this.normal.clear();
    this.normalOrder.splice(0);
    for (const item of pending) { this.release(item); item.reject(error); }
  }
}

function outputLane(record: MachineWireRecord): MachineOutputLane {
  if (record.kind === "machine_ping" || record.kind === "machine_pong" || record.kind === "machine_stream_reset") return { kind: "urgent" };
  if (record.kind === "machine_stream_data" || record.kind === "machine_stream_close") return { kind: "stream", streamId: record.streamId };
  if (record.kind === "machine_inventory_chunk") return { kind: "bulk" };
  return { kind: "control" };
}

async function writeMachineBytes(socket: TLSSocket, bytes: Buffer): Promise<void> {
  if (socket.destroyed || socket.writableEnded) throw new Error("Machine link is closed");
  if (socket.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { socket.off("drain", onDrain); socket.off("close", onClose); socket.off("error", onError); };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error("Machine link closed during backpressure")); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    socket.once("drain", onDrain); socket.once("close", onClose); socket.once("error", onError);
  });
}

const machineWriters = new WeakMap<TLSSocket, MachineWriter>();
export async function writeMachine(socket: TLSSocket, record: MachineWireRecord): Promise<void> {
  const writer = machineWriters.get(socket) ?? new MachineWriter(socket);
  machineWriters.set(socket, writer);
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
