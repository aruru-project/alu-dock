import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";
import { containsBinaryPayload, type InteractionResponse } from "../core/extension-ui-broker.js";
import type { DeliveryMode, DockEvent, EventCursor, InstanceSnapshot } from "../core/managed-instance.js";
import type { RuntimeThinkingLevel } from "../core/runtime-session.js";
import type { SettingUpdate } from "../core/config-projection.js";
import type { ProjectTrustChoice } from "./project-trust.js";
import { DOCK_VERSION } from "../version.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_INSTANCE_LIST_ITEMS,
  type Capability,
  type ClientHello,
  type ControlRequest,
  parseAbortResult,
  parseModelConfigurationResult,
  parseThinkingConfigurationResult,
  parseControlEventEnvelope,
  parseControlResponse,
  parseCreateResult,
  parseEventsResult,
  parseForgetResult,
  parseHelloReply,
  parseHostInfoResult,
  parseHistoryResult,
  parseInteractionRespondResult,
  requiredCapabilities,
  parseListResult,
  parseModelsResult,
  parsePromptResult,
  parsePruneResult,
  parseQueueDequeueResult,
  parseReopenResult,
  parseSessionsResult,
  parseSessionCompactionResult,
  parseSessionNameResult,
  parseSessionReloadResult,
  parseSessionReplacementResult,
  parseSessionTreeResult,
  parseSessionNavigateResult,
  parseSessionForkResult,
  parseSessionCloneResult,
  parseStatusResult,
  parseStopResult,
  parseToolsResult,
  parseSettingsResult,
  parseSettingUpdateResult,
  parseResourcesResult,
  parseCommandsResult,
  ProtocolValidationError,
  type AbortResult,
  type ModelConfigurationResult,
  type ThinkingConfigurationResult,
  type EventsResult,
  type ForgetResult,
  type HelloAck,
  type HostInfoResult,
  type HistoryResult,
  type InteractionRespondResult,
  type InstanceListCursor,
  type ListResult,
  type ModelsResult,
  type PingResult,
  type PromptResult,
  type PruneResult,
  type QueueDequeueResult,
  type ReopenResult,
  type SessionsResult,
  type SessionCompactionResult,
  type SessionNameResult,
  type SessionReloadResult,
  type SessionReplacementResult,
  type SessionTreeResult,
  type SessionNavigateResult,
  type SessionForkResult,
  type SessionCloneResult,
  type StopResult,
  type ToolsResult,
  type SettingsResult,
  type SettingUpdateResult,
  type ResourcesResult,
  type CommandsResult,
} from "./protocol.js";

type Params<T extends ControlRequest["type"]> = Extract<ControlRequest,{type:T}>["params"];
type Parser<T>=(input:unknown)=>T;
const MAX_PENDING_STREAM_EVENTS=1_000;

export interface EventSubscription { initial:EventsResult; close:()=>void; done:Promise<void> }
export interface DockClientOptions { socketPath:string; timeoutMs?:number; longMutationTimeoutMs?:number; requestId?:()=>string; clientId?:string }
export class ControlClientError extends Error {
  constructor(readonly code:string,message:string,readonly operationId?:string,readonly details?:import("../core/managed-instance.js").JsonObject){super(message);this.name="ControlClientError";}
}

export class DockClient {
  readonly socketPath:string;
  private readonly timeoutMs:number;
  private readonly longMutationTimeoutMs:number;
  private readonly createRequestId:()=>string;
  private readonly clientId:string;
  constructor(options:DockClientOptions){this.socketPath=resolve(options.socketPath);this.timeoutMs=options.timeoutMs??30_000;this.longMutationTimeoutMs=options.longMutationTimeoutMs??options.timeoutMs??600_000;this.createRequestId=options.requestId??randomUUID;this.clientId=options.clientId??randomUUID();}

  async hostInfo():Promise<HostInfoResult>{return this.request("host.info",{},"host.info",parseHostInfoResult);}
  async ping():Promise<PingResult>{let negotiated:string[]=[];const info=await this.request("host.info",{},"host.info",parseHostInfoResult,(ack)=>{negotiated=[...ack.capabilities];});return {pid:info.host.pid,protocolVersion:2,hostEpoch:info.host.hostEpoch,capabilities:negotiated};}
  async create(cwd:string,name?:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice}):Promise<InstanceSnapshot>{const result=await this.request("instance.create",{operationId,cwd,name,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"instance.catalog",parseCreateResult);return result.instance;}
  async list(selector: "actionable" | "all" = "all"): Promise<InstanceSnapshot[]> {
    const instances: InstanceSnapshot[] = [];
    let cursor: InstanceListCursor | undefined;
    let pageIdentity: { revision: number; total: number; hiddenStopped: number } | undefined;
    do {
      const result = await this.listPage(selector, cursor);
      const identity = {
        revision: result.page.revision,
        total: result.page.total,
        hiddenStopped: result.page.hiddenStopped,
      };
      if (pageIdentity && (
        identity.revision !== pageIdentity.revision
        || identity.total !== pageIdentity.total
        || identity.hiddenStopped !== pageIdentity.hiddenStopped
      )) throw new ControlClientError("invalid_response", "Instance list page identity changed within one revision-bound scan");
      pageIdentity ??= identity;
      instances.push(...result.instances);
      cursor = result.page.nextCursor;
    } while (cursor);
    if (pageIdentity && instances.length !== pageIdentity.total) {
      throw new ControlClientError("invalid_response", "Instance list scan does not match the declared total");
    }
    return instances;
  }
  listPage(selector: "actionable" | "all", cursor?: InstanceListCursor, limit = MAX_INSTANCE_LIST_ITEMS): Promise<ListResult> {
    return this.request("instance.list", { selector, cursor, limit }, "instance.catalog", parseListResult);
  }
  async status(instanceId:string):Promise<InstanceSnapshot>{return (await this.request("instance.get",{instanceId},"instance.catalog",parseStatusResult)).instance;}
  forget(instanceId:string,operationId=this.createRequestId()):Promise<ForgetResult>{return this.request("instance.forget",{operationId,instanceId},"catalog.maintenance.v1",parseForgetResult);}
  pruneStopped(operationId=this.createRequestId()):Promise<PruneResult>{return this.request("catalog.prune",{operationId,selector:"stopped"},"catalog.maintenance.v1",parsePruneResult);}
  reopen(instanceId:string,operationId=this.createRequestId(),sessionFile?:string,trust?:{challengeId:string;decision:ProjectTrustChoice}):Promise<ReopenResult>{return this.request("instance.reopen",{operationId,instanceId,sessionFile,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"session.reopen",parseReopenResult);}
  events(instanceId:string,since?:EventCursor):Promise<EventsResult>{return this.request("instance.attach",{instanceId,since,follow:false,controller:"observe"},"events.follow",parseEventsResult);}
  prompt(instanceId:string,message:string,delivery:DeliveryMode="auto",operationId=this.createRequestId()):Promise<PromptResult>{return this.request("command.submit",{operationId,instanceId,message,delivery},"session.core",parsePromptResult);}
  respondInteraction(instanceId:string,leaseToken:string,interactionId:string,response:InteractionResponse,operationId=this.createRequestId()):Promise<InteractionRespondResult>{if("value" in response){const limit=response.method==="select"?8_000:256_000;if(response.value.length>limit)return Promise.reject(new ControlClientError("invalid_request",`Interaction ${response.method} response exceeds ${limit} characters`,operationId));if(containsBinaryPayload(response.value))return Promise.reject(new ControlClientError("invalid_request","Interaction responses cannot contain binary, image, data URI, or raw base64 payloads",operationId));}return this.request("interaction.respond",{operationId,instanceId,leaseToken,interactionId,response},"extension_ui.v1",parseInteractionRespondResult);}
  abort(instanceId:string,operationId=this.createRequestId()):Promise<AbortResult>{return this.request("command.abort",{operationId,instanceId},"run.abort.v1",parseAbortResult,undefined,this.longMutationTimeoutMs);}
  dequeue(instanceId:string,operationId=this.createRequestId()):Promise<QueueDequeueResult>{return this.request("queue.dequeue",{operationId,instanceId},"queue.control.v1",parseQueueDequeueResult);}
  models(instanceId:string):Promise<ModelsResult>{return this.request("model.list",{instanceId},"models.v1",parseModelsResult);}
  setModel(instanceId:string,provider:string,modelId:string,operationId=this.createRequestId()):Promise<ModelConfigurationResult>{return this.request("model.set",{operationId,instanceId,provider,modelId},"models.v1",parseModelConfigurationResult);}
  setThinking(instanceId:string,level:RuntimeThinkingLevel,operationId=this.createRequestId()):Promise<ThinkingConfigurationResult>{return this.request("thinking.set",{operationId,instanceId,level},"models.v1",parseThinkingConfigurationResult);}
  tools(instanceId:string):Promise<ToolsResult>{return this.request("tool.list",{instanceId},"tools.v1",parseToolsResult);}
  setActiveTools(instanceId:string,names:string[],operationId=this.createRequestId()):Promise<ToolsResult>{return this.request("tool.set_active",{operationId,instanceId,names},"tools.v1",parseToolsResult);}
  settings(instanceId:string):Promise<SettingsResult>{return this.request("settings.get",{instanceId},"settings.v1",parseSettingsResult);}
  updateSetting(instanceId:string,update:SettingUpdate,operationId=this.createRequestId()):Promise<SettingUpdateResult>{return this.request("settings.update",{operationId,instanceId,update},"settings.v1",parseSettingUpdateResult);}
  resources(instanceId:string):Promise<ResourcesResult>{return this.request("resource.get",{instanceId},"resources.v1",parseResourcesResult);}
  commands(instanceId:string,prefix?:string):Promise<CommandsResult>{return this.request("command.catalog",{instanceId,prefix},"resources.v1",parseCommandsResult);}
  history(instanceId:string,beforeEntryId?:string,limit=200):Promise<HistoryResult>{return this.request("session.history",{instanceId,beforeEntryId,limit},"tui.projection.v1",parseHistoryResult);}
  sessions(instanceId:string,scope:"cwd"|"all"):Promise<SessionsResult>{return this.request("session.list",{instanceId,scope},"session.core",parseSessionsResult);}
  switchSession(instanceId:string,sessionFile:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice}):Promise<SessionReplacementResult>{return this.request("session.switch",{operationId,instanceId,sessionFile,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"session.commands.v1",parseSessionReplacementResult);}
  newSession(instanceId:string,parentSession?:string,operationId=this.createRequestId()):Promise<SessionReplacementResult>{return this.request("session.new",{operationId,instanceId,parentSession},"session.commands.v1",parseSessionReplacementResult);}
  nameSession(instanceId:string,name:string,operationId=this.createRequestId()):Promise<SessionNameResult>{return this.request("session.name",{operationId,instanceId,name},"session.commands.v1",parseSessionNameResult);}
  compactSession(instanceId:string,customInstructions?:string,operationId=this.createRequestId()):Promise<SessionCompactionResult>{return this.request("session.compact",{operationId,instanceId,customInstructions},"session.commands.v1",parseSessionCompactionResult,undefined,this.longMutationTimeoutMs);}
  reloadSession(instanceId:string,operationId=this.createRequestId()):Promise<SessionReloadResult>{return this.request("session.reload",{operationId,instanceId},"session.commands.v1",parseSessionReloadResult,undefined,this.longMutationTimeoutMs);}
  tree(instanceId:string,treeRevision?:string,afterEntryId?:string,limit=200):Promise<SessionTreeResult>{return this.request("session.tree",{instanceId,treeRevision,afterEntryId,limit},"session.tree.v1",parseSessionTreeResult);}
  navigateSession(instanceId:string,targetId:string,options:{summarize?:boolean;customInstructions?:string;replaceInstructions?:boolean;label?:string}={},operationId=this.createRequestId()):Promise<SessionNavigateResult>{return this.request("session.navigate",{operationId,instanceId,targetId,...options},"session.tree.v1",parseSessionNavigateResult);}
  forkSession(instanceId:string,entryId:string,operationId=this.createRequestId()):Promise<SessionForkResult>{return this.request("session.fork",{operationId,instanceId,entryId},"session.tree.v1",parseSessionForkResult);}
  cloneSession(instanceId:string,entryId:string,operationId=this.createRequestId()):Promise<SessionCloneResult>{return this.request("session.clone",{operationId,instanceId,entryId},"session.tree.v1",parseSessionCloneResult);}
  stop(instanceId:string,operationId=this.createRequestId()):Promise<StopResult>{return this.request("instance.stop",{operationId,instanceId},"instance.catalog",parseStopResult,undefined,this.longMutationTimeoutMs);}

  async streamEvents(instanceId:string,options:{since?:EventCursor;onEvent:(event:DockEvent)=>void;requireTuiProjection?:boolean;claimController?:boolean}):Promise<EventSubscription>{
    const since=options.since;const helloId=this.createRequestId(),requestId=this.createRequestId();
    const streamCapabilities:string[]=options.requireTuiProjection?["core.v2","events.follow","queue.control.v1","run.abort.v1","tui.projection.v1"]:requiredCapabilities("events.follow");
    if(options.claimController&&!streamCapabilities.includes("extension_ui.v1"))streamCapabilities.push("extension_ui.v1");
    const request:ControlRequest={kind:"request",version:2,requestId,type:"instance.attach",params:{instanceId,since,follow:true,controller:options.claimController?"claim":"observe"}};
    const socket=createConnection(this.socketPath),decoder=new JsonLineDecoder();let phase:"hello"|"response"|"events"="hello",hostEpoch="",initialSettled=false,doneSettled=false,closeRequested=false,callbacksReady=false,pending:DockEvent[]=[],runtimeGeneration:number|undefined,lastSequence=-1;
    let resolveInitial!:(x:EventSubscription)=>void,rejectInitial!:(e:unknown)=>void,resolveDone!:()=>void,rejectDone!:(e:unknown)=>void;
    const done=new Promise<void>((r,j)=>{resolveDone=r;rejectDone=j;});void done.catch(()=>{});const initial=new Promise<EventSubscription>((r,j)=>{resolveInitial=r;rejectInitial=j;});
    const settleDone=(e?:unknown)=>{if(doneSettled)return;doneSettled=true;e===undefined?resolveDone():rejectDone(e);};
    const fail=(e:unknown)=>{clearTimeout(timeout);const error=normalizeClientError(e);if(!initialSettled){initialSettled=true;rejectInitial(error);}pending=[];settleDone(error);socket.destroy();};
    const timeout=setTimeout(()=>fail(new ControlClientError("timeout",`Control request timed out after ${this.timeoutMs}ms`)),this.timeoutMs);
    const consume=(line:string)=>{if(!line)return;let raw:unknown;try{raw=JSON.parse(line);}catch{fail(new ControlClientError("invalid_response","Host returned invalid JSON"));return;}try{
      if(phase==="hello"){const ack=parseHelloReply(raw,helloId);hostEpoch=ack.host.hostEpoch;for(const required of streamCapabilities){if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);}phase="response";socket.write(encodeJsonLine(request));return;}
      if(phase==="response"){const response=parseControlResponse(raw,requestId,hostEpoch);if(!response.ok){fail(new ControlClientError(response.error.code,response.error.message));return;}const result=parseEventsResult(response.result);if(result.instance.id!==instanceId||result.page.earliest.hostEpoch!==hostEpoch||result.page.latest.hostEpoch!==hostEpoch||(result.instance.ownerHostEpoch!==undefined&&result.instance.ownerHostEpoch!==hostEpoch))throw new ProtocolValidationError("invalid_response","Attach result does not match negotiated cursor domain");runtimeGeneration=result.instance.runtimeGeneration;lastSequence=result.page.latest.sequence;phase="events";clearTimeout(timeout);initialSettled=true;resolveInitial({initial:result,close:()=>{closeRequested=true;pending=[];socket.destroy();},done});setImmediate(()=>{if(closeRequested||doneSettled)return;callbacksReady=true;const queued=pending;pending=[];for(const event of queued){try{options.onEvent(event);}catch(e){fail(e);return;}}});return;}
      const event=parseControlEventEnvelope(raw,requestId,hostEpoch).event;
      if(event.instanceId!==instanceId)throw new ProtocolValidationError("invalid_response","Live event cursor domain/order is invalid");
      if(event.runtimeGeneration!==runtimeGeneration){
        const nextGeneration=runtimeGeneration===undefined?undefined:runtimeGeneration+1;
        if(event.type!=="session.replaced"||event.runtimeGeneration!==nextGeneration||event.sequence!==1||event.data.runtimeGeneration!==event.runtimeGeneration)throw new ProtocolValidationError("invalid_response","Live event generation rollover is invalid");
        runtimeGeneration=event.runtimeGeneration;lastSequence=0;
      }
      if(event.sequence<=lastSequence)throw new ProtocolValidationError("invalid_response","Live event cursor domain/order is invalid");
      lastSequence=event.sequence;
      if(!callbacksReady){if(pending.length>=MAX_PENDING_STREAM_EVENTS)throw new ProtocolValidationError("invalid_response","Too many pending events");pending.push(event);}else options.onEvent(event);
    }catch(e){fail(e);}};
    socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,streamCapabilities))));socket.on("data",(chunk:Buffer)=>{try{for(const line of decoder.push(chunk))consume(line);}catch(e){fail(e);}});socket.once("end",()=>{try{decoder.finish();}catch(e){fail(e);}});socket.once("error",e=>fail(transportError(e)));socket.once("close",hadError=>{clearTimeout(timeout);if(!initialSettled){const e=new ControlClientError("connection_closed","Host closed before responding");initialSettled=true;rejectInitial(e);settleDone(e);}else if(!doneSettled){closeRequested?settleDone():settleDone(new ControlClientError("connection_closed",hadError?"Event stream closed after a transport error":"Host closed the event stream unexpectedly"));}});
    return initial;
  }

  private hello(requestId:string,capabilities:string[]):ClientHello{return {kind:"hello",requestId,versions:[2],client:{name:"alu-dock-client",version:DOCK_VERSION,clientId:this.clientId},requiredCapabilities:capabilities};}
  private request<TType extends ControlRequest["type"],T>(type:TType,params:Params<TType>,capability:Capability,parse:Parser<T>,onHello?:(ack:HelloAck)=>void,requestTimeoutMs=this.timeoutMs):Promise<T>{
    const helloId=this.createRequestId();
    const requestId=this.createRequestId();
    const request={kind:"request",version:2,requestId,type,params} as Extract<ControlRequest,{type:TType}>;
    const operationId = "operationId" in params && typeof params.operationId === "string" ? params.operationId : undefined;
    return new Promise<T>((resolveRequest,rejectRequest)=>{
      const socket=createConnection(this.socketPath);
      const decoder=new JsonLineDecoder();
      let phase:"hello"|"response"="hello";
      let hostEpoch="";
      let settled=false;
      let requestSent=false;
      const timeout=setTimeout(()=>{
        if(requestSent&&operationId) finish(new ControlClientError("effect_unknown",`Operation ${operationId} timed out after it was sent; query current state before retrying`,operationId));
        else finish(new ControlClientError("timeout",`Control request timed out after ${requestTimeoutMs}ms`));
      },requestTimeoutMs);
      const finish=(error?:unknown,result?:T):void=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        socket.destroy();
        if(error===undefined)resolveRequest(result as T);
        else rejectRequest(normalizeClientError(error));
      };
      const finishTransport=(error:ControlClientError):void=>{
        if(requestSent&&operationId){
          finish(new ControlClientError("effect_unknown",`Transport failed after operation ${operationId} was sent; query current state before retrying`,operationId));
        }else finish(error);
      };
      const consume=(line:string):void=>{
        if(!line)return;
        let raw:unknown;
        try{raw=JSON.parse(line);}catch{finish(new ControlClientError("invalid_response","Host returned invalid JSON"));return;}
        try{
          if(phase==="hello"){
            const ack=parseHelloReply(raw,helloId);
            hostEpoch=ack.host.hostEpoch;
            for(const required of requiredCapabilities(capability)){
              if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
            }
            onHello?.(ack);
            phase="response";
            socket.write(encodeJsonLine(request));
            requestSent=true;
            return;
          }
          const response=parseControlResponse(raw,requestId,hostEpoch);
          if(!response.ok)finish(new ControlClientError(response.error.code,response.error.message,operationId,response.error.details));
          else {
            const result=parse(response.result);
            validateRequestResult(type,params,result,hostEpoch);
            finish(undefined,result);
          }
        }catch(error){
          if(requestSent&&operationId)finish(new ControlClientError("effect_unknown",`Host returned an invalid response after operation ${operationId} was sent; query current state before retrying`,operationId));
          else finish(error);
        }
      };
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,requiredCapabilities(capability)))));
      socket.on("data",(chunk:Buffer)=>{try{for(const line of decoder.push(chunk))consume(line);}catch(error){finish(error);}});
      socket.once("end",()=>{try{decoder.finish();}catch(error){finish(error);}});
      socket.once("error",error=>finishTransport(transportError(error)));
      socket.once("close",()=>{if(!settled)finishTransport(new ControlClientError("connection_closed","Host closed before responding"));});
    });
  }
}
function validateRequestResult(type:ControlRequest["type"],params:ControlRequest["params"],result:unknown,hostEpoch:string):void{
  if(result===null||typeof result!=="object")return;
  const record=result as Record<string,unknown>;
  if(type==="host.info"){
    const host=(record.host??null) as Record<string,unknown>|null;
    if(!host||host.hostEpoch!==hostEpoch)throw new ProtocolValidationError("invalid_response","host.info identity does not match negotiated Host epoch");
  }
  const snapshots:InstanceSnapshot[]=[];
  if(record.instance&&typeof record.instance==="object")snapshots.push(record.instance as InstanceSnapshot);
  if(Array.isArray(record.instances))snapshots.push(...record.instances as InstanceSnapshot[]);
  for(const snapshot of snapshots){if((snapshot.lifecycle==="active"||snapshot.lifecycle==="stopping")&&snapshot.ownerHostEpoch!==hostEpoch)throw new ProtocolValidationError("invalid_response","Instance owner does not match negotiated Host epoch");}
  if("instanceId" in params&&typeof params.instanceId==="string"&&snapshots[0]&&snapshots[0].id!==params.instanceId)throw new ProtocolValidationError("invalid_response","Result instance does not match request instanceId");
  if(type==="instance.attach"){
    const page=record.page as {earliest?:EventCursor;latest?:EventCursor}|undefined;
    if(!page||page.earliest?.hostEpoch!==hostEpoch||page.latest?.hostEpoch!==hostEpoch)throw new ProtocolValidationError("invalid_response","Attach cursors do not match negotiated Host epoch");
  }
  if(type==="instance.list"){
    const requested=params as Extract<ControlRequest,{type:"instance.list"}>["params"];
    const page=record.page as ListResult["page"];
    const offset=requested.cursor?.offset??0;
    const expectedNext=offset+snapshots.length;
    if(requested.cursor&&page.revision!==requested.cursor.revision)throw new ProtocolValidationError("invalid_response","List page revision does not match its request cursor");
    if(snapshots.length>requested.limit)throw new ProtocolValidationError("invalid_response","List page exceeds the requested limit");
    if(page.nextCursor){
      if(snapshots.length===0||expectedNext<=offset||page.nextCursor.selector!==requested.selector||page.nextCursor.revision!==page.revision||page.nextCursor.offset!==expectedNext||expectedNext>=page.total)throw new ProtocolValidationError("invalid_response","List continuation cursor is inconsistent with the request");
    }else if(expectedNext!==page.total){
      throw new ProtocolValidationError("invalid_response","Final list page does not cover the declared total");
    }
    if(requested.selector==="all"&&page.hiddenStopped!==0)throw new ProtocolValidationError("invalid_response","All-record list must not report hidden stopped records");
  }
  if(type==="instance.forget"){
    const requested=(params as Extract<ControlRequest,{type:"instance.forget"}>["params"]);
    const receipt=record.receipt as {forgottenId?:unknown}|undefined;
    if(receipt?.forgottenId!==requested.instanceId)throw new ProtocolValidationError("invalid_response","Forget result does not match requested instanceId");
  }
  if(type==="interaction.respond"){
    const requested=(params as Extract<ControlRequest,{type:"interaction.respond"}>["params"]);
    if(record.interactionId!==requested.interactionId)throw new ProtocolValidationError("invalid_response","Interaction result does not match requested interactionId");
  }
  if(type==="tool.set_active"){
    const requested=new Set((params as Extract<ControlRequest,{type:"tool.set_active"}>["params"]).names);
    const tools=(record.tools??[]) as Array<{name:string;active:boolean}>;
    const actual=new Set(tools.filter((tool)=>tool.active).map((tool)=>tool.name));
    if(actual.size!==requested.size||[...requested].some((name)=>!actual.has(name)))throw new ProtocolValidationError("invalid_response","Active tool result does not match requested exact set");
  }
  if(type==="settings.update"){
    const requested=(params as Extract<ControlRequest,{type:"settings.update"}>["params"]).update;
    const setting=record.setting as {key?:unknown}|undefined;
    if(setting?.key!==requested.key)throw new ProtocolValidationError("invalid_response","Setting result does not match requested key");
  }
  if(type==="session.name"){
    const requested=(params as Extract<ControlRequest,{type:"session.name"}>["params"]).name.replace(/[\r\n]+/gu," ").trim()||undefined;
    if(snapshots[0]?.name!==requested)throw new ProtocolValidationError("invalid_response","Session name result does not match the requested normalized name");
  }
  if(type==="session.tree"){
    const requested=(params as Extract<ControlRequest,{type:"session.tree"}>["params"]);
    if(requested.treeRevision!==undefined&&record.treeRevision!==requested.treeRevision)throw new ProtocolValidationError("invalid_response","Tree continuation revision does not match the request");
  }
  if(type==="command.catalog"&&typeof (params as Extract<ControlRequest,{type:"command.catalog"}>["params"]).prefix==="string"){
    const prefix=(params as Extract<ControlRequest,{type:"command.catalog"}>["params"]).prefix as string;
    if(((record.commands??[]) as Array<{name:string}>).some((command)=>!command.name.startsWith(prefix)))throw new ProtocolValidationError("invalid_response","Command catalog does not match requested prefix");
  }
  if("operationId" in params&&typeof params.operationId==="string"){
    const receipt=record.receipt as {operationId?:unknown}|undefined;
    if(receipt&&receipt.operationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Receipt operationId does not match request operationId");
    if(type==="instance.create"&&snapshots[0]?.creationOperationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Created instance operationId does not match request operationId");
    if(type==="instance.reopen"&&record.operationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Reopen operationId does not match request operationId");
  }
}
function normalizeClientError(e:unknown):ControlClientError{if(e instanceof ControlClientError)return e;if(e instanceof ProtocolValidationError)return new ControlClientError(e.code==="unsupported_protocol"?"protocol_incompatible":e.code,e.message);if(e instanceof Error)return new ControlClientError("invalid_response",e.message);return new ControlClientError("invalid_response",String(e));}
function transportError(e:Error):ControlClientError{const code=(e as NodeJS.ErrnoException).code;return new ControlClientError("connection_error",`${code?`${code}: `:""}${e.message}`);}
