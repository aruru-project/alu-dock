import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, resolve } from "node:path";

import {
  CatalogCorruptError,
  CatalogEffectUnknownError,
  CatalogWriteError,
  MutationFaultedError,
} from "../core/catalog.js";
import {
  InteractionExpiredError,
  InteractionInvalidResponseError,
  InteractionNotFoundError,
  InteractionWrongLeaseError,
  type ControllerClaim,
} from "../core/extension-ui-broker.js";
import {
  InstanceAdmissionPendingError,
  InstanceBusyError,
  InstanceNotActiveError,
  InvalidHistoryCursorError,
  InvalidTreeCursorError,
  InvalidDeliveryModeError,
  QueueCapacityError,
  RuntimeEffectUnknownError,
  StaleRuntimeGenerationError,
  type AttachProjection,
  type DockEvent,
  type JsonObject,
} from "../core/managed-instance.js";
import { AgentCompactionKnownFailureError, AgentConversationCursorError, AgentInvalidSettingValueError, AgentModelNotFoundError, AgentSettingsWriteError, AgentUnavailableBeforeEffectError, AgentUnknownToolError } from "../core/agent-worker.js";
import { MAX_ATTACHMENT_CHUNK_BYTES, type AttachmentUploadResult } from "../core/instance-attachments.js";
import { dropOldestSemanticHistoryRange, slimSemanticHistoryEntry } from "../core/history-pagination.js";
import type { SessionInventory } from "../core/session-inventory.js";
import {
  CatalogListCursorStaleError,
  CatalogOperationRecordedError,
  DockRegistry,
  InstanceForgetRejectedError,
  InstanceNotFoundError,
  InstanceNotReopenableError,
  InstanceUnavailableError,
} from "./dock-registry.js";
import { OperationConflictError, OperationLedger, OperationReceiptExpiredError, type DeferredOperation } from "./operation-ledger.js";
import { ProjectTrustChallengeError, ProjectTrustRequiredError } from "./project-trust.js";
import { RemoteAccessServer } from "./remote-access-server.js";
import type { RemoteAccessState } from "./remote-access-state.js";
import { encodeJsonLine, JsonLineDecoder, JsonLineError } from "./json-lines.js";
import {
  FileSystemWorkspaceBrowser,
  WorkspaceBrowseError,
  type WorkspaceBrowser,
} from "./workspace-browser.js";
import { executeSessionCommand, isSessionCommandRequest } from "./session-command-service.js";
import {
  AttachmentIntegrityError,
  AttachmentNotFoundError,
  AttachmentUnavailableError,
  type AttachmentService,
  type AttachmentUploadSink,
} from "./attachment-service.js";
import {
  ATTACHMENTS_CAPABILITY,
  capabilityForRequest,
  CONTROL_PROTOCOL_VERSION,
  createHelloAck,
  defaultHostIdentity,
  implementedCapabilities,
  MAX_CATALOG_PRUNE_ITEMS,
  MAX_CONTROL_LINE_BYTES,
  MAX_HISTORY_ITEMS,
  MAX_INSTANCE_LIST_RESULT_BYTES,
  MAX_REPLAY_EVENTS,
  type ControlEventEnvelope,
  type ControlRequest,
  type ControlResponse,
  type FollowResult,
  type InstanceReadResult,
  type HelloError,
  type HistoryResult,
  parseAttachmentUploadFrame,
  parseClientHello,
  parseControlRequest,
  ProtocolValidationError,
} from "./protocol.js";

const MAX_SOCKET_WRITE_BUFFER = MAX_CONTROL_LINE_BYTES;
const MAX_SESSION_INVENTORY_RESULT_BYTES = 512 * 1_024;
const MAX_SESSION_INVENTORY_DIAGNOSTIC_BYTES = 64 * 1_024;
const MAX_SESSION_INVENTORY_ITEMS = 2_000;
const MAX_ATTACH_EVENT_QUEUE = 1_000;
const MAX_ATTACH_EVENT_QUEUE_BYTES = 4 * MAX_CONTROL_LINE_BYTES;
const ATTACH_DRAIN_TIMEOUT_MS = 5_000;
const ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS = 60_000;
const ATTACH_INITIAL_OVERFLOW_MESSAGE = "Too many updates arrived while opening this work; open it again to refresh the view";

type HostState = "new" | "starting" | "running" | "mutation_faulted" | "draining" | "stopping" | "stopped";
type WriteOutcome = "written" | "backpressured" | "failed" | "too_large";
type SocketProbe = "active" | "stale" | "indeterminate";

interface SocketIdentity {
  dev: number;
  ino: number;
}

export interface HostFatalCompletion {
  exitCode: 1;
  code: "mutation_faulted";
  message: string;
  drainTimedOut: boolean;
}

export interface DockHostOptions {
  socketPath: string;
  registry: DockRegistry;
  statePath?: string;
  faultDrainTimeoutMs?: number;
  operationReceiptCapacity?: number;
  initialize?: () => Promise<void>;
  sessionInventory?: SessionInventory;
  workspaceBrowser?: WorkspaceBrowser;
  remoteAccessState?: RemoteAccessState;
  attachmentService?: AttachmentService;
}

export class DockHost {
  readonly socketPath: string;
  readonly statePath: string;
  readonly registry: DockRegistry;
  readonly hostEpoch: string;
  readonly startedAt: string;

  private state: HostState = "new";
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly connections = new Set<Socket>();
  private readonly connectionRequirements = new WeakMap<Socket, ReadonlySet<string>>();
  private readonly attachConnections = new Map<string, Set<Socket>>();
  private readonly interactionConnections = new Map<string, Socket>();
  private readonly attachBackpressureStats = { blocked: 0, drained: 0, overflow: 0, timeout: 0 };
  private readonly inFlightDispatches = new Set<Promise<void>>();
  private readonly operationLedger: OperationLedger;
  private readonly faultDrainTimeoutMs: number;
  private readonly initialize: (() => Promise<void>) | undefined;
  private readonly sessionInventory: SessionInventory;
  private readonly workspaceBrowser: WorkspaceBrowser;
  private readonly remoteAccess: RemoteAccessServer | undefined;
  private readonly attachmentService: AttachmentService | undefined;
  private readonly capabilities: ReadonlySet<string>;
  private faultDrainPromise: Promise<void> | undefined;
  private unsubscribeMutationFault: (() => void) | undefined;
  private unsubscribeRuntimeReopened: (() => void) | undefined;
  private unsubscribeCatalogRemoval: (() => void) | undefined;
  private readonly faultStartedPromise: Promise<void>;
  private resolveFaultStarted!: () => void;
  private readonly fatalPromise: Promise<HostFatalCompletion>;
  private fatalCompletionValue: HostFatalCompletion | undefined;
  private resolveFatal!: (completion: HostFatalCompletion) => void;

  constructor(options: DockHostOptions) {
    this.socketPath = resolve(options.socketPath);
    this.statePath = options.statePath ?? `memory:${this.socketPath}`;
    this.registry = options.registry;
    this.hostEpoch = options.registry.hostEpoch;
    this.startedAt = options.registry.startedAt;
    this.operationLedger = new OperationLedger(options.operationReceiptCapacity);
    this.faultDrainTimeoutMs = Math.max(1, options.faultDrainTimeoutMs ?? 5_000);
    this.initialize = options.initialize;
    this.sessionInventory = options.sessionInventory ?? { list: async () => ({ sessions: [], incomplete: false, diagnostics: [] }) };
    this.workspaceBrowser = options.workspaceBrowser ?? new FileSystemWorkspaceBrowser();
    this.attachmentService = options.attachmentService;
    const capabilities = new Set(implementedCapabilities());
    if (this.attachmentService === undefined) capabilities.delete(ATTACHMENTS_CAPABILITY);
    this.capabilities = capabilities;
    this.remoteAccess = options.remoteAccessState
      ? new RemoteAccessServer({
        state: options.remoteAccessState,
        acceptProtocolSocket: (socket) => this.handleConnection(socket),
      })
      : undefined;
    this.faultStartedPromise = new Promise((resolveFaultStarted) => { this.resolveFaultStarted = resolveFaultStarted; });
    this.fatalPromise = new Promise((resolveFatal) => { this.resolveFatal = resolveFatal; });
  }

  waitForFatalCompletion(): Promise<HostFatalCompletion> { return this.fatalPromise; }
  fatalCompletion(): HostFatalCompletion | undefined { return this.fatalCompletionValue; }

  start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting") return this.startPromise as Promise<void>;
    if (this.state === "mutation_faulted" || this.state === "draining" || this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new Error(`Cannot start a host that is ${this.state}`));
    }

    this.state = "starting";
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.state === "stopped") return Promise.resolve();
    if (this.state === "stopping") return this.stopPromise as Promise<void>;

    this.state = "stopping";
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStart(): Promise<void> {
    let server: Server | undefined;
    let boundIdentity: SocketIdentity | undefined;
    try {
      await ensurePrivateSocketDirectory(this.socketPath);
      await prepareSocketPath(this.socketPath);
      if (this.state !== "starting") throw new Error("Host start was cancelled by shutdown");

      server = createServer(
        { allowHalfOpen: false, highWaterMark: MAX_SOCKET_WRITE_BUFFER },
        (socket) => this.handleConnection(socket),
      );
      this.server = server;
      await listen(server, this.socketPath);
      boundIdentity = await readSocketIdentity(this.socketPath);
      this.socketIdentity = boundIdentity;
      await chmod(this.socketPath, 0o600);
      await assertPrivateSocket(this.socketPath, boundIdentity);
      await this.initialize?.();
      if (this.state === "starting") {
        this.state = "running";
        this.unsubscribeMutationFault = this.registry.onMutationFault((fault) => this.enterMutationFault(fault.error));
        this.unsubscribeRuntimeReopened = this.registry.onRuntimeReopened((instanceId) => this.closeStaleAttachStreams(instanceId));
        this.unsubscribeCatalogRemoval = this.registry.onCatalogRecordsRemoved((instanceIds) => {
          for (const instanceId of instanceIds) this.closeStaleAttachStreams(instanceId);
        });
        await this.remoteAccess?.start();
      }
    } catch (error) {
      if (server) await closeServer(server);
      if (boundIdentity) await removeSocketIfOwned(this.socketPath, boundIdentity);
      if (this.server === server) this.server = undefined;
      if (this.state === "starting") this.state = "new";
      this.startPromise = undefined;
      throw error;
    }
  }

  private async performStop(): Promise<void> {
    try {
      if (this.startPromise) await this.startPromise.catch(() => {});

      const server = this.server;
      this.server = undefined;
      const closePromise = server ? closeServer(server) : Promise.resolve();
      await this.remoteAccess?.stop();
      await this.registry.cancelInteractionsForHostDrain();
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      await closePromise;

      // A client disconnect does not cancel admitted work. Shutdown waits for
      // it, then performs non-catalog runtime disposal without inventing an
      // explicit instance.stop transaction.
      if (this.inFlightDispatches.size > 0 && !this.faultDrainPromise) {
        await Promise.race([
          Promise.allSettled([...this.inFlightDispatches]).then(() => {}),
          this.faultStartedPromise,
        ]);
      }
      if (this.faultDrainPromise) await this.faultDrainPromise;
      else {
        const disposal = this.registry.isDurable()
          ? this.registry.shutdownAllForHostDrain()
          : this.registry.disposeAllForHostDrain();
        await Promise.race([disposal, this.faultStartedPromise]);
        if (this.faultDrainPromise) await this.faultDrainPromise;
        else await disposal;
      }
    } finally {
      if (this.socketIdentity) await removeSocketIfOwned(this.socketPath, this.socketIdentity).catch(() => {});
      this.unsubscribeMutationFault?.();
      this.unsubscribeMutationFault = undefined;
      this.unsubscribeRuntimeReopened?.();
      this.unsubscribeRuntimeReopened = undefined;
      this.unsubscribeCatalogRemoval?.();
      this.unsubscribeCatalogRemoval = undefined;
      this.attachConnections.clear();
      this.interactionConnections.clear();
      this.socketIdentity = undefined;
      this.state = "stopped";
    }
  }

  private enterMutationFault(error: CatalogEffectUnknownError): void {
    if ((this.state !== "running" && this.state !== "mutation_faulted" && this.state !== "stopping") || this.faultDrainPromise) return;
    if (this.state === "running") this.state = "mutation_faulted";
    this.registry.beginMutationDrain();
    void this.registry.cancelInteractionsForHostDrain();
    this.resolveFaultStarted();
    const admitted = [...this.inFlightDispatches];
    this.faultDrainPromise = (async () => {
      let deadlineReached = false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolveDeadline) => {
        timer = setTimeout(() => { deadlineReached = true; resolveDeadline(); }, this.faultDrainTimeoutMs);
      });
      const waitWithinDeadline = async (work: Promise<unknown>): Promise<boolean> => {
        let completed = false;
        await Promise.race([
          work.then(() => { completed = true; }, () => { completed = true; }),
          deadline,
        ]);
        return completed;
      };

      const admittedSettled = await waitWithinDeadline(Promise.allSettled(admitted));
      let cleanupSettled = false;
      if (admittedSettled) cleanupSettled = await waitWithinDeadline(this.registry.disposeAllForHostDrain());
      else void this.registry.disposeAllForHostDrain();
      const drainTimedOut = deadlineReached || !admittedSettled || !cleanupSettled;
      if (timer) clearTimeout(timer);
      if (this.state === "mutation_faulted") this.state = "draining";
      const completion: HostFatalCompletion = {
        exitCode: 1,
        code: "mutation_faulted",
        message: error.message,
        drainTimedOut,
      };
      this.fatalCompletionValue = completion;
      this.resolveFatal(completion);
    })();
    void this.faultDrainPromise.catch(() => {});
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    const decoder = new JsonLineDecoder();
    let helloSeen = false;
    let clientRequirements = new Set<string>();
    let requestSeen = false;
    let attachmentRequest = false;
    let currentRequestId = "unknown";
    let terminal = false;
    let eventUnsubscribe: (() => void) | undefined;
    let upload: {
      request: Extract<ControlRequest, { type: "attachment.upload" }>;
      sink: AttachmentUploadSink;
      operation: Extract<DeferredOperation<AttachmentUploadResult>, { admitted: true }>;
      nextIndex: number;
    } | undefined;
    let uploadCompleting = false;
    let uploadAbortPromise: Promise<void> | undefined;
    let finishUploadTracking: (() => void) | undefined;
    let uploadIdleTimer: NodeJS.Timeout | undefined;
    let processing = Promise.resolve();

    const finishUpload = (): void => {
      if (uploadIdleTimer) clearTimeout(uploadIdleTimer);
      uploadIdleTimer = undefined;
      const finish = finishUploadTracking;
      finishUploadTracking = undefined;
      finish?.();
    };
    const abortUpload = (reason: unknown = new Error("Attachment upload ended before completion")): Promise<void> => {
      if (uploadCompleting) return Promise.resolve();
      if (uploadAbortPromise) return uploadAbortPromise;
      const active = upload;
      upload = undefined;
      uploadAbortPromise = (async () => {
        if (active) {
          await active.sink.abort().catch(() => {});
          active.operation.abandon(reason);
          void active.operation.promise.catch(() => {});
        }
        finishUpload();
      })();
      return uploadAbortPromise;
    };
    const cleanup = (): void => {
      eventUnsubscribe?.();
      eventUnsubscribe = undefined;
      this.connectionRequirements.delete(socket);
      this.connections.delete(socket);
      void abortUpload();
    };
    socket.once("close", cleanup);
    socket.once("error", () => {});

    const armUploadIdleTimer = (): void => {
      if (uploadIdleTimer) clearTimeout(uploadIdleTimer);
      uploadIdleTimer = setTimeout(() => { void fail(new ProtocolValidationError("attachment_timeout", "Attachment upload was idle for too long")); }, ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
      uploadIdleTimer.unref();
    };
    const fail = async (error: unknown, requestId = upload?.request.requestId ?? currentRequestId): Promise<void> => {
      if (terminal) return;
      terminal = true;
      await abortUpload(error);
      const mapped = mapControlError(error);
      const safe: { code: string; message: string; retryable?: boolean; details?: JsonObject } = attachmentRequest && mapped.code === "request_failed"
        ? { code: "attachment_upload_failed", message: "Attachment storage could not complete the upload", retryable: false }
        : mapped;
      if (helloSeen) this.sendErrorAndEnd(socket, safe.code, safe.message, requestId, safe.details, safe.retryable);
      else this.sendHelloError(socket, requestId, "invalid_hello", mapped.message);
    };

    const consumeLine = async (line: string): Promise<void> => {
      if (terminal || line.length === 0) return;
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; }
      catch { await fail(new ProtocolValidationError("invalid_envelope", helloSeen ? "Request is not valid JSON" : "Hello is not valid JSON"), helloSeen ? upload?.request.requestId ?? "unknown" : "unknown"); return; }

      if (!helloSeen) {
        let hello;
        try { hello = parseClientHello(raw); }
        catch (error) {
          terminal = true;
          const mapped = mapControlError(error);
          this.sendHelloError(socket, extractRequestId(line), "invalid_hello", mapped.message);
          return;
        }
        helloSeen = true;
        clientRequirements = new Set(hello.requiredCapabilities);
        this.connectionRequirements.set(socket, clientRequirements);
        if (this.state !== "running" && this.state !== "mutation_faulted") {
          terminal = true;
          this.sendHelloError(socket, hello.requestId, this.state === "draining" || this.state === "stopping" || this.state === "stopped" ? "host_draining" : "host_starting", "Alu Dock host is not ready");
          return;
        }
        if (!hello.versions.includes(CONTROL_PROTOCOL_VERSION)) {
          terminal = true;
          this.sendHelloError(socket, hello.requestId, "unsupported_protocol", "No supported protocol version overlap", { hostVersions: [2] });
          return;
        }
        const missing = hello.requiredCapabilities.filter((capability) => !this.capabilities.has(capability));
        if (missing.length > 0) {
          terminal = true;
          this.sendHelloError(socket, hello.requestId, "capability_missing", "Required capabilities are unavailable", { missing: [...missing].sort() });
          return;
        }
        const outcome = writeEnvelope(socket, createHelloAck(hello.requestId, defaultHostIdentity(this.hostEpoch, this.startedAt), [...this.capabilities]));
        if (outcome !== "written") socket.destroy();
        return;
      }

      if (upload) {
        const frame = parseAttachmentUploadFrame(raw, upload.request.requestId);
        if (frame.kind === "attachment_chunk") {
          if (frame.index !== upload.nextIndex) throw new ProtocolValidationError("invalid_request", `Attachment chunk index ${frame.index} is out of order`);
          await upload.sink.write(Buffer.from(frame.data, "base64"));
          upload.nextIndex += 1;
          armUploadIdleTimer();
          return;
        }
        if (frame.chunks !== upload.nextIndex) throw new ProtocolValidationError("invalid_request", "Attachment completion chunk count is inconsistent");
        const active = upload;
        upload = undefined;
        uploadCompleting = true;
        if (uploadIdleTimer) clearTimeout(uploadIdleTimer);
        uploadIdleTimer = undefined;
        try {
          const result = await active.sink.complete();
          active.operation.resolve(result);
          terminal = true;
          this.sendSuccessAndEnd(socket, active.request.requestId, await active.operation.promise);
        } catch (error) {
          active.operation.abandon(error);
          await active.operation.promise.catch(() => {});
          throw error;
        } finally {
          uploadCompleting = false;
          finishUpload();
        }
        return;
      }

      if (requestSeen) throw new ProtocolValidationError("multiple_requests", "Only one request is allowed after hello");
      requestSeen = true;
      currentRequestId = extractRequestId(line);
      const request = parseControlRequest(raw);
      currentRequestId = request.requestId;
      if (this.state !== "running" && this.state !== "mutation_faulted") throw new ProtocolValidationError("host_draining", "Alu Dock host is not accepting requests");
      if (this.state === "mutation_faulted" && isMutationRequest(request.type)) throw new ProtocolValidationError("mutation_faulted", "Alu Dock catalog is mutation-faulted; query state and wait for Host restart");
      if (!this.capabilities.has(capabilityForRequest(request.type))) throw new ProtocolValidationError("capability_missing", `Capability ${capabilityForRequest(request.type)} is unavailable`);

      if (request.type === "attachment.upload") {
        attachmentRequest = true;
        if (!this.attachmentService) throw new ProtocolValidationError("capability_missing", "Attachment upload is unavailable");
        const operation = this.operationLedger.defer<AttachmentUploadResult>(request.params.operationId, request.type, request.params);
        if (!operation.admitted) {
          const result = await operation.promise;
          terminal = true;
          this.sendSuccessAndEnd(socket, request.requestId, result);
          return;
        }
        let sink: AttachmentUploadSink;
        try {
          sink = await this.attachmentService.beginUpload(request.params);
        } catch (error) {
          operation.abandon(error);
          await operation.promise.catch(() => {});
          throw error;
        }
        upload = { request, sink, operation, nextIndex: 0 };
        let resolveUpload!: () => void;
        const tracked = new Promise<void>((resolve) => { resolveUpload = resolve; });
        finishUploadTracking = () => {
          this.inFlightDispatches.delete(tracked);
          resolveUpload();
        };
        this.inFlightDispatches.add(tracked);
        const outcome = writeEnvelope(socket, {
          kind: "attachment_upload_ready",
          version: 2,
          requestId: request.requestId,
          hostEpoch: this.hostEpoch,
          maxChunkBytes: MAX_ATTACHMENT_CHUNK_BYTES,
        });
        if (outcome !== "written") throw new Error("Attachment upload readiness could not be delivered");
        armUploadIdleTimer();
        return;
      }

      let task!: Promise<void>;
      task = this.dispatch(request, socket, (unsubscribe) => { eventUnsubscribe = unsubscribe; }, clientRequirements)
        .catch((error: unknown) => {
          const operationId = mutationOperationId(request);
          const normalized = operationId !== undefined
            && request.type !== "interaction.respond"
            && this.registry.catalogHealth() !== "healthy"
            && !(error instanceof CatalogEffectUnknownError)
            ? new CatalogEffectUnknownError({ kind: request.type, effect: "post_effect", operationId }, error)
            : error;
          const mapped = mapControlError(normalized);
          this.sendErrorAndEnd(socket, mapped.code, mapped.message, request.requestId, mapped.details, mapped.retryable);
        })
        .finally(() => this.inFlightDispatches.delete(task));
      this.inFlightDispatches.add(task);
      await task;
    };

    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      processing = processing.then(async () => {
        for (const line of decoder.push(chunk)) {
          await consumeLine(line);
          if (terminal) break;
        }
      }).catch((error) => fail(error)).finally(() => { if (!terminal && !socket.destroyed) socket.resume(); });
    });
    socket.on("end", () => {
      processing = processing.then(async () => {
        decoder.finish();
        if (upload) throw new ProtocolValidationError("incomplete_record", "Attachment upload ended before completion");
      }).catch((error) => fail(error));
    });
  }

  private async dispatch(
    request: ControlRequest,
    socket: Socket,
    setEventUnsubscribe: (unsubscribe: () => void) => void,
    clientRequirements: ReadonlySet<string>,
  ): Promise<void> {
    if (isSessionCommandRequest(request)) {
      const result = await executeSessionCommand(request, this.registry, this.operationLedger);
      this.sendSuccessAndEnd(socket, request.requestId, result);
      return;
    }
    switch (request.type) {
      case "host.info": {
        const health = this.registry.catalogHealth();
        this.sendSuccessAndEnd(socket, request.requestId, {
          state: health === "healthy" ? "ready" : health,
          host: defaultHostIdentity(this.hostEpoch, this.startedAt),
          catalog: { schemaVersion: 1, revision: this.registry.catalogRevision(), lastReconciledAt: this.registry.lastReconciledAt() },
          paths: { socket: this.socketPath, state: this.statePath },
          diagnostics: health === "healthy"
            ? this.registry.isDurable()
              ? [{ severity: "info", message: `Durable catalog ready; normalized ${this.registry.startupNormalizedCount()} prior live record(s)`, source: "registry" }]
              : [{ severity: "info", message: "Development registry is in-memory and non-durable", source: "registry" }]
            : [{ severity: "error", message: "Catalog mutation failed after a runtime effect; Host is draining read-only", source: "registry" }],
        }); return;
      }
      case "instance.create": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=await this.registry.create({operationId:request.params.operationId,cwd:request.params.cwd,name:request.params.name,trustChallengeId:request.params.trustChallengeId,projectTrustDecision:request.params.projectTrustDecision});return {instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "instance.ensure": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, () => this.registry.ensure({
          operationId: request.params.operationId,
          key: request.params.key,
          cwd: request.params.cwd,
          name: request.params.name,
          trustChallengeId: request.params.trustChallengeId,
          projectTrustDecision: request.params.projectTrustDecision,
        }));
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "instance.adopt": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=await this.registry.adopt({operationId:request.params.operationId,sessionFile:request.params.sessionFile,name:request.params.name,trustChallengeId:request.params.trustChallengeId,projectTrustDecision:request.params.projectTrustDecision});return {instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "instance.list": this.sendSuccessAndEnd(socket, request.requestId, this.registry.listPage({
        ...request.params,
        maxBytes: MAX_INSTANCE_LIST_RESULT_BYTES,
      })); return;
      case "instance.get_by_key": this.sendSuccessAndEnd(socket,request.requestId,{instance:this.registry.getSnapshotByKey(request.params.key)??null}); return;
      case "instance.get": this.sendSuccessAndEnd(socket,request.requestId,{instance:this.registry.getSnapshot(request.params.instanceId)}); return;
      case "instance.read": {
        const instance=this.registry.get(request.params.instanceId);
        if(request.params.since&&request.params.since.instanceId!==instance.id)throw new ProtocolValidationError("invalid_cursor","The saved update position belongs to another work");
        const projection=await instance.getAttachProjection(request.params.since,MAX_HISTORY_ITEMS,request.params.replay);
        this.sendSuccessAndEnd(socket,request.requestId,createBoundedReadResult(projection,request.requestId)); return;
      }
      case "instance.follow": await this.followEventStream(request,socket,setEventUnsubscribe); return;
      case "interaction.control": await this.controlExtensionUi(request,socket,setEventUnsubscribe); return;
      case "instance.forget": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const forgotten = await this.registry.forget(request.params.operationId, request.params.instanceId);
          return { receipt: { operationId: request.params.operationId, ...forgotten, piSessionFilesDeleted: 0 as const } };
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "catalog.prune": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const pruned = await this.registry.pruneStopped(request.params.operationId, MAX_CATALOG_PRUNE_ITEMS);
          return { receipt: {
            operationId: request.params.operationId,
            selector: request.params.selector,
            forgottenIds: pruned.forgottenIds,
            forgottenCount: pruned.forgottenIds.length,
            hasMore: pruned.hasMore,
            piSessionFilesDeleted: 0 as const,
          } };
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "instance.reopen": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const reopened = await this.registry.reopen({
            operationId: request.params.operationId,
            instanceId: request.params.instanceId,
            sessionFile: request.params.sessionFile,
            trustChallengeId: request.params.trustChallengeId,
            projectTrustDecision: request.params.projectTrustDecision,
          });
          return {
            operationId: request.params.operationId,
            previousLifecycle: reopened.previousLifecycle,
            instance: reopened.instance.snapshot(),
          };
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "interaction.respond": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const instance = this.registry.get(request.params.instanceId);
          return instance.respondInteraction(request.params.leaseToken, request.params.interactionId, request.params.response);
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "extension.tools_expanded.set": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const instance = this.registry.get(request.params.instanceId);
          return { instance: instance.setToolsExpanded(request.params.expanded, request.params.expectedRuntimeGeneration) };
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "extension.widget_viewport.set": {
        const instance = this.registry.get(request.params.instanceId);
        instance.setExtensionWidgetViewport(
          request.params.leaseToken,
          request.params.expectedRuntimeGeneration,
          { width: request.params.width, height: request.params.height },
        );
        this.sendSuccessAndEnd(socket, request.requestId, { accepted: true }); return;
      }
      case "instance.stop": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const stopped=await this.registry.stop(request.params.instanceId,request.params.operationId);return {receipt:{operationId:stopped.receipt.operationId,alreadyStopped:stopped.receipt.alreadyStopped,cleanupErrors:stopped.receipt.cleanupErrors},instance:stopped.instance};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "command.submit": {
        const result = await this.operationLedger.run(request.params.operationId, request.type, request.params, async () => {
          const instance = this.registry.get(request.params.instanceId);
          const attachments = request.params.attachments === undefined
            ? undefined
            : await this.attachmentService?.getMany(request.params.attachments);
          if (request.params.attachments !== undefined && attachments === undefined) throw new ProtocolValidationError("capability_missing", "Attachment storage is unavailable");
          const receipt = await instance.submit(request.params.message, request.params.delivery, request.params.operationId, request.params.images, attachments);
          return { receipt, instance: instance.snapshot() };
        });
        this.sendSuccessAndEnd(socket, request.requestId, result); return;
      }
      case "command.abort": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);await instance.abort(request.params.operationId);return {instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "queue.dequeue": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const receipt=await instance.dequeue(request.params.operationId);return {receipt,instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "model.list": { const instance=this.registry.get(request.params.instanceId); const result=await instance.listModels(); this.sendSuccessAndEnd(socket,request.requestId,{...result,instance:instance.snapshot()}); return; }
      case "model.set": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);await instance.selectModel(request.params.provider,request.params.modelId,request.params.operationId);return {instance:instance.snapshot(),settingsWrite:{persisted:true as const}};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "thinking.set": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const state=await instance.setThinkingLevel(request.params.level,request.params.operationId);return {actualLevel:state.thinkingLevel,availableThinkingLevels:state.availableThinkingLevels,instance:instance.snapshot(),settingsWrite:{persisted:true as const}};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "tool.list": { const instance=this.registry.get(request.params.instanceId); const result=await instance.listTools(); this.sendSuccessAndEnd(socket,request.requestId,{...result,instance:instance.snapshot()}); return; }
      case "tool.set_active": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const tools=await instance.setActiveTools(request.params.names,request.params.operationId);return {...tools,instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "settings.get": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,{settings:await instance.getSettings()}); return; }
      case "settings.update": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const setting=await instance.updateSetting(request.params.update,request.params.operationId);return {setting,instance:instance.snapshot(),reloadRequired:setting.reloadRequired,hostRestartRequired:setting.hostRestartRequired};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "resource.get": { const instance=this.registry.get(request.params.instanceId); const result=await instance.getResources(); this.sendSuccessAndEnd(socket,request.requestId,result); return; }
      case "command.catalog": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,await instance.getCommands(request.params.prefix)); return; }
      case "session.history": { const instance=this.registry.get(request.params.instanceId); const page=await instance.getHistoryPage(request.params.beforeEntryId,request.params.limit); this.sendSuccessAndEnd(socket,request.requestId,createBoundedHistoryResult(page,request.requestId,this.hostEpoch)); return; }
      case "conversation.history": { const instance=this.registry.get(request.params.instanceId); const page=await instance.getConversationHistory(request.params.cursor,request.params.limit); this.sendSuccessAndEnd(socket,request.requestId,page); return; }
      case "conversation.content": { const instance=this.registry.get(request.params.instanceId); const page=await instance.getConversationContent(request.params.contentRef,request.params.cursor); this.sendSuccessAndEnd(socket,request.requestId,page); return; }
      case "session.inventory": {
        const inventory = await this.sessionInventory.list(request.params.cwd, request.params.scope);
        this.sendSuccessAndEnd(socket, request.requestId, boundedSessionInventory(inventory, request.params));
        return;
      }
      case "session.list": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,await instance.listSessions(request.params.scope)); return; }
      case "session.tree": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,await instance.getTreePage(request.params.treeRevision,request.params.afterEntryId,request.params.limit)); return; }
      case "workspace.list": {
        this.sendSuccessAndEnd(socket, request.requestId, await this.workspaceBrowser.list(request.params));
        return;
      }
    }
  }

  private async followEventStream(request: Extract<ControlRequest,{type:"instance.follow"}>,socket:Socket,setEventUnsubscribe:(unsubscribe:()=>void)=>void):Promise<void> {
    const instance=this.registry.get(request.params.instanceId);
    this.trackAttachStream(instance.id, socket);
    const cursor=request.params.since;
    if(cursor.instanceId!==instance.id) throw new ProtocolValidationError("invalid_cursor","The saved update position belongs to another work");
    type QueuedEvent = { event: DockEvent; bytes: number };
    let initializing=true,pending:QueuedEvent[]=[]; let pendingBytes=0,initializationOverflow=false;
    let lastGeneration=instance.runtimeGeneration,lastAccepted=0; let unsubscribe=()=>{};
    let liveQueue:QueuedEvent[]=[]; let liveQueueBytes=0,waitingForDrain=false;
    let subscriptionClosed=false;
    const clearQueues=():void=>{pending=[];pendingBytes=0;liveQueue=[];liveQueueBytes=0;};
    const closeSubscription=():void=>{if(subscriptionClosed)return;subscriptionClosed=true;unsubscribe();clearQueues();};
    const abortBackpressuredStream=():void=>{closeSubscription();if(!socket.destroyed)socket.destroy();};
    const boundedEvent=(event:DockEvent):QueuedEvent|undefined=>{
      const bytes=eventFrameSize(request.requestId,this.hostEpoch,event,undefined);
      if(bytes===0)return undefined;
      if(!Number.isFinite(bytes)||bytes>MAX_CONTROL_LINE_BYTES){closeSubscription();socket.destroy();return undefined;}
      return {event,bytes};
    };
    const appendBounded=(queue:QueuedEvent[],queued:QueuedEvent,currentBytes:number):number|undefined=>{
      if(queue.length>=MAX_ATTACH_EVENT_QUEUE||currentBytes+queued.bytes>MAX_ATTACH_EVENT_QUEUE_BYTES)return undefined;
      queue.push(queued);return currentBytes+queued.bytes;
    };
    const flushLiveQueue=():void=>{
      if(subscriptionClosed||waitingForDrain)return;
      while(liveQueue.length>0){
        const queued=liveQueue.shift() as QueuedEvent;liveQueueBytes-=queued.bytes;
        const outcome=writeEvent(socket,request.requestId,this.hostEpoch,queued.event,undefined);
        if(outcome==="written")continue;
        if(outcome==="backpressured"){
          this.attachBackpressureStats.blocked+=1;waitingForDrain=true;
          void waitForSocketDrain(socket,ATTACH_DRAIN_TIMEOUT_MS).then((drained)=>{
            if(subscriptionClosed)return;
            if(!drained){this.attachBackpressureStats.timeout+=1;abortBackpressuredStream();return;}
            this.attachBackpressureStats.drained+=1;waitingForDrain=false;flushLiveQueue();
          });return;
        }
        closeSubscription();socket.destroy();return;
      }
    };
    const sendLiveEvent=(event:DockEvent):boolean=>{
      if(event.runtimeGeneration<lastGeneration)return true;
      if(event.runtimeGeneration>lastGeneration){
        if(event.runtimeGeneration!==lastGeneration+1||event.type!=="session.replaced"||event.sequence!==1){closeSubscription();socket.destroy();return false;}
        lastGeneration=event.runtimeGeneration;lastAccepted=0;
      }
      if(event.sequence<=lastAccepted)return true;
      const queued=boundedEvent(event);if(subscriptionClosed)return false;lastAccepted=event.sequence;if(!queued)return true;
      if(waitingForDrain||liveQueue.length>0){const nextBytes=appendBounded(liveQueue,queued,liveQueueBytes);if(nextBytes===undefined){this.attachBackpressureStats.overflow+=1;abortBackpressuredStream();return false;}liveQueueBytes=nextBytes;return true;}
      const outcome=writeEvent(socket,request.requestId,this.hostEpoch,event,undefined);
      if(outcome==="written")return true;
      if(outcome==="backpressured"){
        this.attachBackpressureStats.blocked+=1;waitingForDrain=true;
        void waitForSocketDrain(socket,ATTACH_DRAIN_TIMEOUT_MS).then((drained)=>{if(subscriptionClosed)return;if(!drained){this.attachBackpressureStats.timeout+=1;abortBackpressuredStream();return;}this.attachBackpressureStats.drained+=1;waitingForDrain=false;flushLiveQueue();});return true;
      }
      closeSubscription();socket.destroy();return false;
    };
    unsubscribe=instance.subscribe(event=>{
      if(initializing){const queued=boundedEvent(event);if(subscriptionClosed||!queued)return;const nextBytes=appendBounded(pending,queued,pendingBytes);if(nextBytes===undefined){this.attachBackpressureStats.overflow+=1;initializationOverflow=true;void instance.reportControlDegradation(ATTACH_INITIAL_OVERFLOW_MESSAGE).catch(()=>{});closeSubscription();return;}pendingBytes=nextBytes;return;}
      sendLiveEvent(event);
    });
    if(subscriptionClosed)unsubscribe();setEventUnsubscribe(closeSubscription);
    let projection!:AttachProjection;
    try{projection=await instance.getAttachProjection(cursor,1,"event_log");}
    catch(error){initializing=false;clearQueues();closeSubscription();throw error;}
    if(subscriptionClosed){
      initializing=false;clearQueues();
      if(initializationOverflow&&!socket.destroyed)this.sendErrorAndEnd(socket,"follow_initial_overflow",ATTACH_INITIAL_OVERFLOW_MESSAGE,request.requestId);
      return;
    }
    if(socket.destroyed){closeSubscription();return;}
    const result=createBoundedFollowResult(projection,request.requestId);
    const responseOutcome=writeEnvelope(socket,successResponse(request.requestId,this.hostEpoch,result));
    if(responseOutcome==="backpressured"){
      this.attachBackpressureStats.blocked+=1;const drained=await waitForSocketDrain(socket,ATTACH_DRAIN_TIMEOUT_MS);
      if(!drained){this.attachBackpressureStats.timeout+=1;initializing=false;clearQueues();abortBackpressuredStream();return;}
      this.attachBackpressureStats.drained+=1;
    }else if(responseOutcome!=="written"){initializing=false;clearQueues();closeSubscription();return;}
    lastGeneration=result.page.latest.runtimeGeneration;lastAccepted=Math.max(projection.replaySince,result.page.latest.sequence);
    initializing=false;
    const handoff=pending.sort((a,b)=>a.event.runtimeGeneration-b.event.runtimeGeneration||a.event.sequence-b.event.sequence);pending=[];pendingBytes=0;
    for(const queued of handoff){if(!sendLiveEvent(queued.event))return;}
  }

  private async controlExtensionUi(request: Extract<ControlRequest,{type:"interaction.control"}>,socket:Socket,setEventUnsubscribe:(unsubscribe:()=>void)=>void):Promise<void> {
    const instance=this.registry.get(request.params.instanceId);
        let closed=false,unsubscribe=()=>{};let claim:ControllerClaim|undefined;let ready=false;const pending:DockEvent[]=[];
    const close=():void=>{
      if(closed)return;closed=true;unsubscribe();
      const current=this.interactionConnections.get(instance.id);if(current===socket)this.interactionConnections.delete(instance.id);
      if(claim)void instance.releaseInteractionController(claim.leaseToken,"detach");
      pending.length=0;
    };
    setEventUnsubscribe(close);
    unsubscribe=instance.subscribe((event)=>{
      if(event.type==="session.replaced"||event.type==="instance.stopped"||event.type==="instance.runtime_error"){close();if(!socket.destroyed)socket.end();return;}
      if(!isControllerTargetedEvent(event))return;
      if(!claim){if(pending.length<MAX_ATTACH_EVENT_QUEUE)pending.push(event);else{close();socket.destroy();}return;}
      if(event.data.controllerId!==claim.controllerId)return;
      if(!ready){if(pending.length<MAX_ATTACH_EVENT_QUEUE)pending.push(event);else{close();socket.destroy();}return;}
      const outcome=writeEvent(socket,request.requestId,this.hostEpoch,event,claim.controllerId);
      if(outcome!=="written"){close();socket.destroy();}
    });
    try{claim=await instance.claimInteractionController();}
    catch(error){close();throw error;}
    if(closed||socket.destroyed){close();return;}
    const controlGeneration=instance.runtimeGeneration;
    if(!instance.isInteractionControllerCurrent(claim.leaseToken,controlGeneration)){
      close();
      throw new ProtocolValidationError("interaction_unavailable","Extension UI is changing; try again");
    }
    const previous=this.interactionConnections.get(instance.id);
    this.interactionConnections.set(instance.id,socket);
    if(previous&&!previous.destroyed)previous.end();
    const result={instanceId:instance.id,runtimeGeneration:controlGeneration,leaseToken:claim.leaseToken,controllerId:claim.controllerId};
    const outcome=writeEnvelope(socket,successResponse(request.requestId,this.hostEpoch,result));
    if(outcome!=="written"){close();socket.destroy();return;}
    ready=true;
    for(const event of pending.splice(0)){
      if(!isControllerTargetedEvent(event)||event.data.controllerId!==claim.controllerId)continue;
      const written=writeEvent(socket,request.requestId,this.hostEpoch,event,claim.controllerId);
      if(written!=="written"){close();socket.destroy();return;}
    }
  }

  private trackAttachStream(instanceId: string, socket: Socket): void {
    const streams = this.attachConnections.get(instanceId) ?? new Set<Socket>();
    streams.add(socket);
    this.attachConnections.set(instanceId, streams);
    socket.once("close", () => {
      streams.delete(socket);
      if (streams.size === 0 && this.attachConnections.get(instanceId) === streams) this.attachConnections.delete(instanceId);
    });
  }

  private closeStaleAttachStreams(instanceId: string): void {
    const streams = this.attachConnections.get(instanceId);
    if (!streams) return;
    this.attachConnections.delete(instanceId);
    for (const socket of streams) socket.destroy();
  }

  private sendSuccessAndEnd(socket:Socket,requestId:string,result:unknown):void { if(socket.destroyed||socket.writableEnded)return;const outcome=endEnvelope(socket,successResponse(requestId,this.hostEpoch,result));if(outcome==="too_large")this.sendErrorAndEnd(socket,"response_too_large","Control response exceeds the JSONL record limit",requestId); }
  private sendErrorAndEnd(socket:Socket,code:string,message:string,requestId:string,details?:JsonObject,retryable=false):void { if(socket.destroyed||socket.writableEnded)return;const response:ControlResponse={kind:"response",version:2,requestId,hostEpoch:this.hostEpoch,ok:false,error:{code,message:truncateMessage(message),retryable,...(details===undefined?{}:{details})}};if(endEnvelope(socket,response)==="too_large")socket.destroy(); }
  private sendHelloError(socket:Socket,requestId:string,code:HelloError["error"]["code"],message:string,details:{hostVersions?:number[];missing?:string[];retryAfterMs?:number}={}):void { if(socket.destroyed||socket.writableEnded)return;const envelope:HelloError={kind:"hello_error",requestId,error:{code,message:truncateMessage(message),...details}};try{socket.end(encodeJsonLine(envelope));}catch{socket.destroy();} }
}

function mutationOperationId(request: ControlRequest): string | undefined {
  if (!isMutationRequest(request.type)) return undefined;
  return (request.params as { operationId: string }).operationId;
}

function isMutationRequest(type: ControlRequest["type"]): boolean {
  return type !== "host.info"
    && type !== "instance.list"
    && type !== "instance.get_by_key"
    && type !== "instance.get"
    && type !== "instance.read"
    && type !== "instance.follow"
    && type !== "interaction.control"
    && type !== "extension.widget_viewport.set"
    && type !== "model.list"
    && type !== "tool.list"
    && type !== "settings.get"
    && type !== "resource.get"
    && type !== "command.catalog"
    && type !== "session.history"
    && type !== "conversation.history"
    && type !== "conversation.content"
    && type !== "session.inventory"
    && type !== "session.list"
    && type !== "session.tree"
    && type !== "workspace.list";
}

function boundedSessionInventory(
  source: Awaited<ReturnType<SessionInventory["list"]>>,
  query: { cwd: string; scope: "cwd" | "all" },
): {
  sessions: Awaited<ReturnType<SessionInventory["list"]>>["sessions"];
  query: { cwd: string; scope: "cwd" | "all" };
  total: number;
  truncated: boolean;
  incomplete?: boolean;
  diagnostics?: Awaited<ReturnType<SessionInventory["list"]>>["diagnostics"];
  diagnosticsTruncated?: boolean;
} {
  const diagnostics: Awaited<ReturnType<SessionInventory["list"]>>["diagnostics"] = [];
  let diagnosticBytes = 0;
  for (const diagnostic of source.diagnostics) {
    const itemBytes = Buffer.byteLength(JSON.stringify(diagnostic), "utf8") + 1;
    if (diagnosticBytes + itemBytes > MAX_SESSION_INVENTORY_DIAGNOSTIC_BYTES) break;
    diagnostics.push(diagnostic);
    diagnosticBytes += itemBytes;
  }
  const sessions: Awaited<ReturnType<SessionInventory["list"]>>["sessions"] = [];
  let bytes = 256 + diagnosticBytes;
  for (const session of source.sessions.slice(0, MAX_SESSION_INVENTORY_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(session), "utf8") + 1;
    if (bytes + itemBytes > MAX_SESSION_INVENTORY_RESULT_BYTES) break;
    sessions.push(session);
    bytes += itemBytes;
  }
  return {
    sessions,
    query: { ...query },
    total: source.sessions.length,
    truncated: sessions.length < source.sessions.length,
    incomplete: source.incomplete,
    diagnostics,
    diagnosticsTruncated: source.diagnosticsTruncated === true || diagnostics.length < source.diagnostics.length,
  };
}

function successResponse(requestId:string,hostEpoch:string,result:unknown):ControlResponse { return {kind:"response",version:2,requestId,hostEpoch,ok:true,result}; }
function createBoundedHistoryResult(source:HistoryResult,requestId:string,hostEpoch:string):HistoryResult {
  let entries=source.entries;
  let slimmed=false;
  while(entries.length>0){
    const hasEarlier=source.hasEarlier||entries.length<source.entries.length;
    const candidate:HistoryResult={historyRevision:source.historyRevision,entries,hasEarlier,...(hasEarlier&&entries[0]?{nextBeforeEntryId:entries[0].entryId}:{}),instance:source.instance};
    if(encodedSize(successResponse(requestId,hostEpoch,candidate))<=MAX_CONTROL_LINE_BYTES)return candidate;
    const reduced=dropOldestSemanticHistoryRange(entries);
    if(reduced.length>0){entries=reduced;continue;}
    if(!slimmed){entries=entries.map(slimSemanticHistoryEntry);slimmed=true;continue;}
    throw new Error("A complete conversation section is too large to return in one history page");
  }
  return {historyRevision:source.historyRevision,entries:[],hasEarlier:false,instance:source.instance};
}
function createBoundedReadResult(projection:AttachProjection,requestId:string):InstanceReadResult {
  const source=projection.page;
  // Controller-targeted events are delivered on the Extension UI operation stream only.
  let events=source.events.filter((event)=>!eventHiddenFromStream(event,undefined));
  let truncated=source.truncated;
  let history=projection.recentHistory;
  let historyTruncated=projection.historyTruncated;
  let historySlimmed=false;
  if(events.length>MAX_REPLAY_EVENTS){events=events.slice(-MAX_REPLAY_EVENTS);truncated=true;}
  let earliest=events.length>0&&truncated?{...source.earliest,sequence:events[0]!.sequence}:source.earliest;
  while(true){
    const page={events,earliest,latest:source.latest,truncated,epochChanged:projection.epochChanged,generationChanged:projection.generationChanged};
    const result:InstanceReadResult={instance:projection.instance,page,recentHistory:history,historyRevision:projection.historyRevision,historyTruncated,pendingMessages:projection.pendingMessages};
    const hostEpoch=projection.instance.ownerHostEpoch??source.latest.hostEpoch;
    if(encodedSize(successResponse(requestId,hostEpoch,result))<=MAX_CONTROL_LINE_BYTES)return result;
    if(history.length>0){
      const reduced=dropOldestSemanticHistoryRange(history);
      if(reduced.length>0){history=reduced;historyTruncated=true;continue;}
      if(!historySlimmed){history=history.map(slimSemanticHistoryEntry);historyTruncated=true;historySlimmed=true;continue;}
      history=[];historyTruncated=true;continue;
    }
    if(events.length>0){events=events.slice(1);truncated=true;earliest={...source.latest,sequence:events[0]?.sequence??source.latest.sequence};continue;}
    return result;
  }
}
function createBoundedFollowResult(projection:AttachProjection,requestId:string):FollowResult {
  const source=projection.page;
  // Controller-targeted events are delivered on the Extension UI operation stream only.
  let events=source.events.filter((event)=>!eventHiddenFromStream(event,undefined));
  let truncated=source.truncated;
  if(events.length>MAX_REPLAY_EVENTS){events=events.slice(-MAX_REPLAY_EVENTS);truncated=true;}
  let earliest=events.length>0&&truncated?{...source.earliest,sequence:events[0]!.sequence}:source.earliest;
  while(true){
    const result:FollowResult={page:{events,earliest,latest:source.latest,truncated,epochChanged:projection.epochChanged,generationChanged:projection.generationChanged}};
    if(encodedSize(successResponse(requestId,source.latest.hostEpoch,result))<=MAX_CONTROL_LINE_BYTES)return result;
    if(events.length===0)return result;
    events=events.slice(1);truncated=true;earliest={...source.latest,sequence:events[0]?.sequence??source.latest.sequence};
  }
}
function isControllerDirective(value: unknown): value is Extract<DockEvent, { type: "extension.title_set" | "extension.editor_text_set" }> {
  if (value === null || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "extension.title_set" || type === "extension.editor_text_set";
}

function isControllerTargetedEvent(value: unknown): value is Extract<DockEvent, { type: "interaction.requested" | "extension.title_set" | "extension.editor_text_set" }> {
  if (value === null || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "interaction.requested" || isControllerDirective(value);
}

/**
 * Controller-targeted events (pending interactions and controller directives) are routed
 * only to the connection holding the matching Extension UI controller claim. This is Host
 * routing authority, not a capability projection: every other event reaches every stream.
 */
function eventHiddenFromStream(event: DockEvent, controllerId: string | undefined): boolean {
  if (!isControllerTargetedEvent(event)) return false;
  return controllerId === undefined || event.data.controllerId !== controllerId;
}

function controlEventEnvelope(requestId:string,hostEpoch:string,event:DockEvent,controllerId:string|undefined):ControlEventEnvelope|undefined {
  if (eventHiddenFromStream(event, controllerId)) return undefined;
  return {kind:"event",version:2,requestId,hostEpoch,event};
}

function eventFrameSize(requestId:string,hostEpoch:string,event:DockEvent,controllerId:string|undefined):number {
  const envelope=controlEventEnvelope(requestId,hostEpoch,event,controllerId);
  return envelope===undefined?0:encodedSize(envelope);
}

function writeEvent(socket:Socket,requestId:string,hostEpoch:string,event:DockEvent,controllerId:string|undefined):WriteOutcome {
  const envelope=controlEventEnvelope(requestId,hostEpoch,event,controllerId);
  return envelope===undefined?"written":writeEnvelope(socket,envelope);
}

function writeEnvelope(socket: Socket, envelope: unknown): WriteOutcome {
  if (socket.destroyed || socket.writableEnded) return "failed";
  let encoded: string;
  try {
    encoded = encodeJsonLine(envelope);
  } catch {
    socket.destroy();
    return "failed";
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_CONTROL_LINE_BYTES) return "too_large";
  try {
    return socket.write(encoded) ? "written" : "backpressured";
  } catch {
    socket.destroy();
    return "failed";
  }
}

function endEnvelope(socket: Socket, envelope: ControlResponse): WriteOutcome {
  if (socket.destroyed || socket.writableEnded) return "failed";
  let encoded: string;
  try {
    encoded = encodeJsonLine(envelope);
  } catch {
    socket.destroy();
    return "failed";
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_CONTROL_LINE_BYTES) return "too_large";
  try {
    socket.end(encoded);
    return "written";
  } catch {
    socket.destroy();
    return "failed";
  }
}

function waitForSocketDrain(socket: Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded) return Promise.resolve(false);
  if (!socket.writableNeedDrain) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(drained);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onClose);
  });
}

function encodedSize(value: unknown): number {
  try {
    return Buffer.byteLength(encodeJsonLine(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function mapControlError(error: unknown): { code: string; message: string; retryable?: boolean; details?: JsonObject } {
  if (error instanceof CatalogEffectUnknownError) {
    return { code: "effect_unknown", message: error.message, details: { operationId: error.context.operationId ?? "runtime-internal", queryHint: error.queryHint } };
  }
  if (error instanceof RuntimeEffectUnknownError) {
    return { code: "effect_unknown", message: error.message, details: { operationId: error.operationId, queryHint: error.queryHint } };
  }
  if (error instanceof AgentUnavailableBeforeEffectError) {
    return { code: "runtime_unavailable", message: error.message };
  }
  if (error instanceof AgentCompactionKnownFailureError) {
    const code = error.reason === "nothing_to_compact" || error.reason === "already_compacted"
      ? "compaction_not_needed"
      : error.reason === "cancelled" ? "compaction_cancelled" : "compaction_failed";
    return { code, message: error.message };
  }
  if (error instanceof CatalogWriteError) return { code: "catalog_write_failed", message: error.message };
  if (error instanceof CatalogCorruptError) return { code: "catalog_corrupt", message: error.message, details: { scope: "catalog", path: error.path } };
  if (error instanceof MutationFaultedError) return { code: "mutation_faulted", message: error.message };
  if (error instanceof ProjectTrustRequiredError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  if (error instanceof ProjectTrustChallengeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AttachmentNotFoundError) return { code: error.code, message: error.message };
  if (error instanceof AttachmentIntegrityError) return { code: error.code, message: error.message };
  if (error instanceof AttachmentUnavailableError) return { code: error.code, message: error.message };
  if (error instanceof ProtocolValidationError) return { code: error.code, message: error.message };
  if (error instanceof WorkspaceBrowseError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof CatalogListCursorStaleError) return { code: "cursor_stale", message: error.message, retryable: true };
  if (error instanceof InstanceNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof InstanceForgetRejectedError) return { code: "instance_not_terminal", message: error.message };
  if (error instanceof InstanceNotReopenableError) return { code: "instance_not_reopenable", message: error.message };
  if (error instanceof InstanceUnavailableError) {
    const code = error.lifecycle === "host_lost" ? "instance_host_lost"
      : error.lifecycle === "runtime_error" ? "instance_runtime_error"
        : "instance_not_active";
    return { code, message: error.message };
  }
  if (error instanceof CatalogOperationRecordedError) return { code: "operation_conflict", message: error.message };
  if (error instanceof InvalidHistoryCursorError) return { code: "invalid_cursor", message: error.message };
  if (error instanceof AgentConversationCursorError) return { code: "invalid_cursor", message: error.message };
  if (error instanceof StaleRuntimeGenerationError) return { code: "stale_runtime_generation", message: error.message, details: { expectedRuntimeGeneration: error.expected, actualRuntimeGeneration: error.actual } };
  if (error instanceof InvalidTreeCursorError) return { code: "invalid_cursor", message: error.message };
  if (error instanceof InteractionNotFoundError) return { code: error.code, message: error.message };
  if (error instanceof InteractionExpiredError) return { code: error.code, message: error.message };
  if (error instanceof InteractionWrongLeaseError) return { code: error.code, message: error.message };
  if (error instanceof InteractionInvalidResponseError) return { code: error.code, message: error.message };
  if (error instanceof InstanceNotActiveError) return { code: "instance_not_active", message: error.message };
  if (error instanceof InvalidDeliveryModeError) return { code: "invalid_delivery", message: error.message };
  if (error instanceof QueueCapacityError) return { code: "queue_capacity", message: error.message };
  if (error instanceof InstanceAdmissionPendingError) return { code: "admission_pending", message: error.message };
  if (error instanceof InstanceBusyError) return { code: "instance_busy", message: error.message };
  if (error instanceof AgentModelNotFoundError) return { code: "model_not_found", message: error.message };
  if (error instanceof AgentUnknownToolError) return { code: "unknown_tool", message: error.message };
  if (error instanceof AgentInvalidSettingValueError) return { code: "settings_invalid", message: error.message };
  if (error instanceof AgentSettingsWriteError) return { code: "settings_write_failed", message: error.message };
  if (error instanceof OperationConflictError) return { code: "operation_conflict", message: error.message };
  if (error instanceof OperationReceiptExpiredError) {
    return { code: "operation_receipt_expired", message: error.message, details: { operationId: error.operationId, queryHint: "Query current state; do not retry this operation ID" } };
  }
  if (error instanceof SyntaxError) return { code: "invalid_json", message: "Request is not valid JSON" };
  if (error instanceof JsonLineError) {
    return {
      code: error.code === "record_too_large" ? "request_too_large" : "invalid_jsonl",
      message: error.message,
    };
  }
  return {
    code: "request_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function extractRequestId(line: string): string {
  try {
    const value = JSON.parse(line) as { requestId?: unknown };
    return typeof value.requestId === "string" ? value.requestId : "unknown";
  } catch {
    return "unknown";
  }
}

function truncateMessage(message: string): string {
  const sanitized = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return sanitized.length <= 2_000 ? sanitized : `${sanitized.slice(0, 2_000)}…`;
}

async function ensurePrivateSocketDirectory(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error(`Socket parent is not a directory: ${directory}`);
  const getuid = process.getuid;
  if (typeof getuid !== "function") throw new Error("Unix socket host requires a platform with user IDs");
  if (info.uid !== getuid()) throw new Error(`Socket parent is not owned by the current user: ${directory}`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Socket parent must not grant group/other access: ${directory}`);
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const info = await lstatIfPresent(socketPath);
  if (!info) return;
  if (!info.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  const identity = identityOf(info);
  const probe = await probeSocket(socketPath);
  if (probe === "active") throw new Error(`Alu Dock host is already listening: ${socketPath}`);
  if (probe === "indeterminate") throw new Error(`Cannot safely determine whether socket is stale: ${socketPath}`);

  const current = await lstatIfPresent(socketPath);
  if (!current) return;
  if (!sameIdentity(identity, identityOf(current))) {
    throw new Error(`Socket path changed while checking staleness: ${socketPath}`);
  }
  await unlink(socketPath);
}

async function probeSocket(socketPath: string): Promise<SocketProbe> {
  return new Promise<SocketProbe>((resolveProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: SocketProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(result);
    };
    const timeout = setTimeout(() => finish("indeterminate"), 250);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "indeterminate");
    });
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveStart, rejectStart) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectStart(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveStart();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

async function assertPrivateSocket(socketPath: string, expected: SocketIdentity): Promise<void> {
  const info = await lstat(socketPath);
  if (!info.isSocket() || !sameIdentity(expected, identityOf(info))) {
    throw new Error(`Socket path changed during startup: ${socketPath}`);
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`Socket permissions are not private: ${socketPath}`);
  }
}

async function readSocketIdentity(socketPath: string): Promise<SocketIdentity> {
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error(`Listening path is not a socket: ${socketPath}`);
  return identityOf(info);
}

async function removeSocketIfOwned(socketPath: string, expected: SocketIdentity): Promise<void> {
  const info = await lstatIfPresent(socketPath);
  if (!info || !sameIdentity(expected, identityOf(info))) return;
  await unlink(socketPath);
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function identityOf(info: Stats): SocketIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
