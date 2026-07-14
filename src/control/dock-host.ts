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
  CatalogEffectUnknownError,
  CatalogWriteError,
  MutationFaultedError,
} from "../core/catalog.js";
import {
  InstanceAdmissionPendingError,
  InstanceBusyError,
  InstanceNotActiveError,
  InvalidDeliveryModeError,
  type DockEvent,
  type EventCursor,
  type EventPage,
  type JsonObject,
  type ManagedInstance,
} from "../core/managed-instance.js";
import { RuntimeInvalidSettingValueError, RuntimeModelNotFoundError, RuntimeSettingsWriteError, RuntimeUnknownToolError } from "../core/runtime-session.js";
import { DockRegistry, InstanceNotFoundError } from "./dock-registry.js";
import { OperationConflictError, OperationLedger } from "./operation-ledger.js";
import { ProjectTrustChallengeError, ProjectTrustRequiredError } from "./project-trust.js";
import { encodeJsonLine, JsonLineDecoder, JsonLineError } from "./json-lines.js";
import {
  capabilityForRequest,
  CONTROL_PROTOCOL_VERSION,
  createHelloAck,
  defaultHostIdentity,
  implementedCapabilities,
  MAX_CONTROL_LINE_BYTES,
  MAX_REPLAY_EVENTS,
  type ControlEventEnvelope,
  type ControlRequest,
  type ControlResponse,
  type EventsResult,
  type HelloError,
  parseClientHello,
  parseControlRequest,
  ProtocolValidationError,
} from "./protocol.js";

const MAX_SOCKET_WRITE_BUFFER = MAX_CONTROL_LINE_BYTES;
const MAX_INITIAL_EVENT_QUEUE = 1_000;
const BACKPRESSURE_CLOSE_TIMEOUT_MS = 1_000;

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
  private readonly inFlightDispatches = new Set<Promise<void>>();
  private readonly operationLedger = new OperationLedger();
  private readonly faultDrainTimeoutMs: number;
  private faultDrainPromise: Promise<void> | undefined;
  private unsubscribeMutationFault: (() => void) | undefined;
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
    this.faultDrainTimeoutMs = Math.max(1, options.faultDrainTimeoutMs ?? 5_000);
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
      if (this.state === "starting") {
        this.state = "running";
        this.unsubscribeMutationFault = this.registry.onMutationFault((fault) => this.enterMutationFault(fault.error));
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
        const disposal = this.registry.disposeAllForHostDrain();
        await Promise.race([disposal, this.faultStartedPromise]);
        if (this.faultDrainPromise) await this.faultDrainPromise;
        else await disposal;
      }
      if (this.socketIdentity) {
        await removeSocketIfOwned(this.socketPath, this.socketIdentity);
      }
    } finally {
      this.unsubscribeMutationFault?.();
      this.unsubscribeMutationFault = undefined;
      this.socketIdentity = undefined;
      this.state = "stopped";
    }
  }

  private enterMutationFault(error: CatalogEffectUnknownError): void {
    if ((this.state !== "running" && this.state !== "mutation_faulted" && this.state !== "stopping") || this.faultDrainPromise) return;
    if (this.state === "running") this.state = "mutation_faulted";
    this.registry.beginMutationDrain();
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
    let requestSeen = false;
    let terminal = false;
    let eventUnsubscribe: (() => void) | undefined;
    const cleanup = (): void => { eventUnsubscribe?.(); eventUnsubscribe = undefined; this.connections.delete(socket); };
    socket.once("close", cleanup);
    socket.once("error", () => {});

    const consumeLine = (line: string): void => {
      if (terminal || line.length === 0) return;
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; }
      catch {
        terminal = true;
        if (helloSeen) this.sendErrorAndEnd(socket, "invalid_envelope", "Request is not valid JSON", "unknown");
        else this.sendHelloError(socket, "unknown", "invalid_hello", "Hello is not valid JSON");
        return;
      }

      if (!helloSeen) {
        let hello;
        try { hello = parseClientHello(raw); }
        catch (error) { const mapped = mapControlError(error); terminal = true; this.sendHelloError(socket, extractRequestId(line), "invalid_hello", mapped.message); return; }
        helloSeen = true;
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
        const available = new Set(implementedCapabilities());
        const missing = hello.requiredCapabilities.filter((capability) => !available.has(capability));
        if (missing.length > 0) {
          terminal = true;
          this.sendHelloError(socket, hello.requestId, "capability_missing", "Required capabilities are unavailable", { missing: [...missing].sort() });
          return;
        }
        const outcome = writeEnvelope(socket, createHelloAck(hello.requestId, defaultHostIdentity(this.hostEpoch, this.startedAt)));
        if (outcome !== "written") socket.destroy();
        return;
      }

      if (requestSeen) { terminal = true; this.sendErrorAndEnd(socket, "multiple_requests", "Only one request is allowed after hello", "unknown"); return; }
      requestSeen = true;
      let request: ControlRequest;
      try { request = parseControlRequest(raw); }
      catch (error) { const mapped = mapControlError(error); terminal = true; this.sendErrorAndEnd(socket, mapped.code, mapped.message, extractRequestId(line)); return; }
      if (this.state !== "running" && this.state !== "mutation_faulted") { terminal = true; this.sendErrorAndEnd(socket, "host_draining", "Alu Dock host is not accepting requests", request.requestId); return; }
      if (this.state === "mutation_faulted" && isMutationRequest(request.type)) { terminal = true; this.sendErrorAndEnd(socket, "mutation_faulted", "Alu Dock catalog is mutation-faulted; query state and wait for Host restart", request.requestId); return; }
      if (!implementedCapabilities().includes(capabilityForRequest(request.type))) {
        terminal = true; this.sendErrorAndEnd(socket, "capability_missing", `Capability ${capabilityForRequest(request.type)} is unavailable`, request.requestId); return;
      }
      let task!: Promise<void>;
      task = this.dispatch(request, socket, (unsubscribe) => { eventUnsubscribe = unsubscribe; })
        .catch((error: unknown) => {
          const operationId = mutationOperationId(request);
          const normalized = operationId !== undefined
            && this.registry.catalogHealth() !== "healthy"
            && !(error instanceof CatalogEffectUnknownError)
            ? new CatalogEffectUnknownError({ kind: request.type, effect: "post_effect", operationId }, error)
            : error;
          const mapped = mapControlError(normalized);
          this.sendErrorAndEnd(socket, mapped.code, mapped.message, request.requestId, mapped.details, mapped.retryable);
        })
        .finally(() => this.inFlightDispatches.delete(task));
      this.inFlightDispatches.add(task);
    };
    socket.on("data", (chunk: Buffer) => { try { for (const line of decoder.push(chunk)) { consumeLine(line); if (terminal) break; } } catch (error) { const mapped=mapControlError(error); terminal=true; if(helloSeen)this.sendErrorAndEnd(socket,mapped.code,mapped.message,"unknown");else this.sendHelloError(socket,"unknown","invalid_hello",mapped.message); } });
    socket.on("end", () => { try { decoder.finish(); } catch (error) { const mapped=mapControlError(error); this.sendErrorAndEnd(socket,mapped.code,mapped.message,"unknown"); } });
  }

  private async dispatch(request: ControlRequest, socket: Socket, setEventUnsubscribe: (unsubscribe: () => void) => void): Promise<void> {
    switch (request.type) {
      case "host.info": {
        const health = this.registry.catalogHealth();
        this.sendSuccessAndEnd(socket, request.requestId, {
          state: health === "healthy" ? "ready" : health,
          host: defaultHostIdentity(this.hostEpoch, this.startedAt),
          catalog: { schemaVersion: 1, revision: this.registry.catalogRevision(), lastReconciledAt: this.startedAt },
          paths: { socket: this.socketPath, state: this.statePath },
          diagnostics: health === "healthy"
            ? [{ severity: "info", message: "Development registry is in-memory and non-durable", source: "registry" }]
            : [{ severity: "error", message: "Catalog mutation failed after a runtime effect; Host is draining read-only", source: "registry" }],
        }); return;
      }
      case "instance.create": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=await this.registry.create({operationId:request.params.operationId,cwd:request.params.cwd,name:request.params.name,trustChallengeId:request.params.trustChallengeId,projectTrustDecision:request.params.projectTrustDecision});return {instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "instance.list": this.sendSuccessAndEnd(socket,request.requestId,{instances:this.registry.list().filter(i=>request.params.includeTerminal!==false||i.lifecycle==="active"||i.lifecycle==="stopping")}); return;
      case "instance.get": this.sendSuccessAndEnd(socket,request.requestId,{instance:this.registry.get(request.params.instanceId).snapshot()}); return;
      case "instance.attach": this.attachEventStream(request,socket,setEventUnsubscribe); return;
      case "instance.stop": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const receipt=await instance.stop(request.params.operationId);return {receipt:{operationId:receipt.operationId,alreadyStopped:receipt.alreadyStopped,cleanupErrors:receipt.cleanupErrors},instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "command.submit": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const receipt=await instance.submit(request.params.message,request.params.delivery,request.params.operationId);return {receipt,instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "model.list": { const instance=this.registry.get(request.params.instanceId); const result=await instance.listModels(); this.sendSuccessAndEnd(socket,request.requestId,{models:result.models,availableThinkingLevels:result.state.availableThinkingLevels,instance:instance.snapshot()}); return; }
      case "model.set": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);await instance.selectModel(request.params.provider,request.params.modelId,request.params.operationId);return {instance:instance.snapshot(),settingsWrite:{persisted:true as const}};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "thinking.set": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const state=await instance.setThinkingLevel(request.params.level,request.params.operationId);return {actualLevel:state.thinkingLevel,availableThinkingLevels:state.availableThinkingLevels,instance:instance.snapshot(),settingsWrite:{persisted:true as const}};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "tool.list": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,{tools:await instance.listTools(),instance:instance.snapshot()}); return; }
      case "tool.set_active": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const tools=await instance.setActiveTools(request.params.names,request.params.operationId);return {tools,instance:instance.snapshot()};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "settings.get": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,{settings:await instance.getSettings()}); return; }
      case "settings.update": {
        const result=await this.operationLedger.run(request.params.operationId,request.type,request.params,async()=>{const instance=this.registry.get(request.params.instanceId);const setting=await instance.updateSetting(request.params.update,request.params.operationId);return {setting,instance:instance.snapshot(),reloadRequired:setting.reloadRequired,hostRestartRequired:setting.hostRestartRequired};});
        this.sendSuccessAndEnd(socket,request.requestId,result); return;
      }
      case "resource.get": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,await instance.getResources()); return; }
      case "command.catalog": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,{commands:await instance.getCommands(request.params.prefix)}); return; }
      case "session.list": { const instance=this.registry.get(request.params.instanceId); this.sendSuccessAndEnd(socket,request.requestId,{sessions:await instance.listSessions(request.params.scope)}); return; }
    }
  }

  private attachEventStream(request: Extract<ControlRequest,{type:"instance.attach"}>,socket:Socket,setEventUnsubscribe:(unsubscribe:()=>void)=>void):void {
    const instance=this.registry.get(request.params.instanceId);
    const cursor=request.params.since;
    if(cursor && cursor.instanceId!==instance.id) throw new ProtocolValidationError("invalid_cursor","Cursor belongs to another instance");
    const epochChanged=cursor!==undefined&&cursor.hostEpoch!==this.hostEpoch;
    const generationChanged=cursor!==undefined&&cursor.runtimeGeneration!==instance.runtimeGeneration;
    const replaySince=epochChanged||generationChanged?0:(cursor?.sequence??0);
    const follow=request.params.follow;
    let initializing=true,pending:DockEvent[]=[]; let lastSent=replaySince; let unsubscribe=()=>{};
    const closeAfterBackpressure=():void=>{unsubscribe();if(!socket.writableNeedDrain){socket.end();return;}const timeout=setTimeout(()=>socket.destroy(),BACKPRESSURE_CLOSE_TIMEOUT_MS);socket.once("drain",()=>{clearTimeout(timeout);if(!socket.destroyed)socket.end();});socket.once("close",()=>clearTimeout(timeout));};
    const sendLiveEvent=(event:DockEvent):boolean=>{if(event.sequence<=lastSent)return true;const outcome=writeEvent(socket,request.requestId,this.hostEpoch,event);if(outcome==="written"||outcome==="backpressured")lastSent=event.sequence;if(outcome==="written")return true;if(outcome==="backpressured")closeAfterBackpressure();else{unsubscribe();socket.destroy();}return false;};
    unsubscribe=instance.subscribe(event=>{if(initializing){pending.push(event);if(pending.length>MAX_INITIAL_EVENT_QUEUE){pending=[];unsubscribe();socket.destroy();}return;}sendLiveEvent(event);});setEventUnsubscribe(unsubscribe);
    const result=createBoundedEventsResult(instance,replaySince,follow,request.requestId,epochChanged,generationChanged,request.params.controller === "claim" ? "unavailable" : "observing");
    const responseOutcome=writeEnvelope(socket,successResponse(request.requestId,this.hostEpoch,result));
    if(responseOutcome!=="written"){initializing=false;pending=[];if(responseOutcome==="backpressured")closeAfterBackpressure();else if(responseOutcome==="too_large"){unsubscribe();this.sendErrorAndEnd(socket,"response_too_large","Attach response exceeds the JSONL record limit",request.requestId);}else unsubscribe();return;}
    lastSent=Math.max(replaySince,result.page.latest.sequence);initializing=false;pending.sort((a,b)=>a.sequence-b.sequence);for(const event of pending){if(!sendLiveEvent(event))return;}pending=[];if(!follow){unsubscribe();socket.end();}
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
    && type !== "instance.get"
    && type !== "instance.attach"
    && type !== "model.list"
    && type !== "tool.list"
    && type !== "settings.get"
    && type !== "resource.get"
    && type !== "command.catalog"
    && type !== "session.list";
}

function successResponse(requestId:string,hostEpoch:string,result:unknown):ControlResponse { return {kind:"response",version:2,requestId,hostEpoch,ok:true,result}; }
function createBoundedEventsResult(instance:ManagedInstance,since:number,following:boolean,requestId:string,epochChanged:boolean,generationChanged:boolean,controllerStatus:"observing"|"unavailable"):EventsResult {
  const source=instance.eventsSince(since);
  let events=source.events;
  let truncated=source.truncated;
  if(events.length>MAX_REPLAY_EVENTS){events=events.slice(-MAX_REPLAY_EVENTS);truncated=true;}
  let earliest=events.length>0&&truncated?{...source.earliest,sequence:events[0]!.sequence}:source.earliest;
  while(true){
    const page={events,earliest,latest:source.latest,truncated,epochChanged,generationChanged};
    const result:EventsResult={instance:instance.snapshot(),page,recentHistory:[],historyTruncated:true,controller:{status:controllerStatus},following};
    if(encodedSize(successResponse(requestId,instance.hostEpoch,result))<=MAX_CONTROL_LINE_BYTES||events.length===0)return result;
    events=events.slice(1);
    truncated=true;
    earliest={...source.latest,sequence:events[0]?.sequence??source.latest.sequence};
  }
}
function writeEvent(socket:Socket,requestId:string,hostEpoch:string,event:DockEvent):WriteOutcome { const envelope:ControlEventEnvelope={kind:"event",version:2,requestId,hostEpoch,event};return writeEnvelope(socket,envelope); }

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
  if (socket.writableLength + bytes > MAX_SOCKET_WRITE_BUFFER) {
    socket.destroy();
    return "failed";
  }
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
  if (socket.writableLength + bytes > MAX_SOCKET_WRITE_BUFFER) {
    socket.destroy();
    return "failed";
  }
  try {
    socket.end(encoded);
    return "written";
  } catch {
    socket.destroy();
    return "failed";
  }
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
  if (error instanceof CatalogWriteError) return { code: "catalog_write_failed", message: error.message };
  if (error instanceof MutationFaultedError) return { code: "mutation_faulted", message: error.message };
  if (error instanceof ProjectTrustRequiredError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  if (error instanceof ProjectTrustChallengeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ProtocolValidationError) return { code: error.code, message: error.message };
  if (error instanceof InstanceNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof InstanceNotActiveError) return { code: "instance_not_active", message: error.message };
  if (error instanceof InvalidDeliveryModeError) return { code: "invalid_delivery", message: error.message };
  if (error instanceof InstanceAdmissionPendingError) return { code: "admission_pending", message: error.message };
  if (error instanceof InstanceBusyError) return { code: "instance_busy", message: error.message };
  if (error instanceof RuntimeModelNotFoundError) return { code: "model_not_found", message: error.message };
  if (error instanceof RuntimeUnknownToolError) return { code: "unknown_tool", message: error.message };
  if (error instanceof RuntimeInvalidSettingValueError) return { code: "settings_invalid", message: error.message };
  if (error instanceof RuntimeSettingsWriteError) return { code: "settings_write_failed", message: error.message };
  if (error instanceof OperationConflictError) return { code: "operation_conflict", message: error.message };
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
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
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
