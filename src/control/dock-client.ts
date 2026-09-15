import { SYSTEM_TEMPLATES_CAPABILITY, parseSystemCatalogResult, parseSystemDefaultSetResult, type SystemCatalogCursor, type SystemCatalogResult, type SystemDefaultSetResult } from "./protocol.js";
import { MAX_SYSTEM_CATALOG_ITEMS } from "./system-service.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, resolve } from "node:path";
import type { InteractionResponse } from "../core/extension-ui-broker.js";
import type { DeliverableDto } from "../core/instance-deliverables.js";
import { resolvePortableAbsoluteLocalPath } from "../core/local-path.js";
import { MAX_SOURCE_FILE_TRANSFER_BYTES } from "../core/source-file.js";
import type { DeliveryMode, DockEvent, EventCursor, ImagePathDto, InstanceSnapshot } from "../core/managed-instance.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CHUNK_BYTES, type AttachmentUploadResult } from "../core/instance-attachments.js";
import type { ThinkingLevel } from "../core/agent-worker.js";
import type { CommandReferenceDto, SettingUpdate } from "../core/config-projection.js";
import type { JsonObject } from "../core/json-value.js";
import type { ProjectTrustChoice } from "./project-trust.js";
import { DOCK_VERSION } from "../version.js";
import { encodeJsonLine, JsonLineDecoder, JsonLineError } from "./json-lines.js";
import { normalizeLocalEndpoint } from "./local-endpoint.js";
import {
  ATTACHMENTS_CAPABILITY,
  MACHINES_CAPABILITY,
  WORKER_CONFIG_CAPABILITY,
  CONTROL_PROTOCOL_VERSION,
  MAX_INSTANCE_LIST_ITEMS,
  GIT_BRANCH_CAPABILITY,
  TOOL_RESULT_PRESENTATION_CAPABILITY,
  TOOLS_EXPANDED_CAPABILITY,
  EXTENSION_WIDGET_CAPABILITY,
  PERSISTENT_INTERACTIONS_CAPABILITY,
  INSTANCE_READ_CAPABILITY,
  EVENTS_FOLLOW_CAPABILITY,
  EXTENSION_UI_CONTROL_CAPABILITY,
  IMAGE_INPUT_CAPABILITY,
  INSTANCE_KEYS_CAPABILITY,
  INSTANCE_DISPLAY_NAME_CAPABILITY,
  CONVERSATION_CONTENT_CAPABILITY,
  CONVERSATION_IMAGES_CAPABILITY,
  COMMAND_DISCOVERY_CAPABILITY,
  COMPACTION_PROMPTS_CAPABILITY,
  parseCompactionPromptTemplatesResult,
  type CompactionPromptTemplatesResult,
  PUBLISHED_FILES_CAPABILITY,
  INSTANCE_DELIVERABLES_CAPABILITY,
  WORKSPACE_LIST_CAPABILITY,
  WORKSPACE_FILES_CAPABILITY,
  MAX_WORKSPACE_LIST_ITEMS,
  type Capability,
  type ClientHello,
  type ControlRequest,
  parseAbortResult,
  parseAttachmentUploadReady,
  parseAttachmentUploadResult,
  parseDeliverableDownloadFrame,
  parseDeliverableListResult,
  parseWorkspaceEntryListResult,
  parseWorkspaceEntryGetResult,
  parseWorkspaceFileReadFrame,
  normalizeWorkspaceRelativePath,
  parseModelConfigurationResult,
  parseThinkingConfigurationResult,
  parseControlEventEnvelope,
  parseControlResponse,
  parseResponseTransferFrame,
  decodeResponseTransfer,
  parseCreateResult,
  parseEnsureResult,
  parseInstanceReadResult,
  parseFollowResult,
  parseExtensionUiControlResult,
  parseForgetResult,
  parseHelloReply,
  parseHostInfoResult,
  parseMachinesResult,
  parseMachineRemovalResult,
  parseHistoryResult,
  parseConversationHistoryResult,
  parseConversationContentResult,
  parseConversationImageFrame,
  parseFileReadResult,
  parseInteractionRespondResult,
  parseKeyLookupResult,
  parseWidgetViewportResult,
  requiredCapabilities,
  parseListResult,
  parseModelsResult,
  parsePromptResult,
  parsePruneResult,
  parseQueueDequeueResult,
  parseReopenResult,
  parseSessionsResult,
  parseSessionCompactionResult,
  parseSessionInventoryResult,
  parseSessionNameResult,
  parseSessionReloadResult,
  parseSessionReplacementResult,
  parseSessionTreeResult,
  parseSessionNavigateResult,
  parseSessionForkResult,
  parseSessionCloneResult,
  parseStatusResult,
  parseStopResult,
  parseWorkspaceListResult,
  parseToolsResult,
  parseSettingsResult,
  parseSettingUpdateResult,
  parseResourcesResult,
  parseResourceContentResult,
  RESOURCE_CONTENT_CAPABILITY,
  type ResourceContentResult,
  parseCommandsResult,
  parseCommandContentResult,
  parseCommandCompletionsResult,
  ProtocolValidationError,
  type AbortResult,
  type AdoptResult,
  type ModelConfigurationResult,
  type ThinkingConfigurationResult,
  type EnsureResult,
  type InstanceReadResult,
  type FollowResult,
  type ExtensionUiControlResult,
  type ForgetResult,
  type HelloAck,
  type HostInfoResult,
  type MachinesResult,
  type MachineRemovalResult,
  type HistoryResult,
  type ConversationHistoryResult,
  type ConversationContentResult,
  type FileReadResult,
  type InteractionRespondResult,
  type WidgetViewportResult,
  type InstanceListCursor,
  type WorkspaceListCursor,
  type WorkspaceListResult,
  type WorkspaceEntryDto,
  type WorkspaceEntryListResult,
  type WorkspaceFileReadResult,
  type KeyLookupResult,
  type ListResult,
  type ModelsResult,
  type PingResult,
  type PromptResult,
  type PruneResult,
  type QueueDequeueResult,
  type ReopenResult,
  type SessionsResult,
  type SessionCompactionResult,
  type SessionInventoryResult,
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
  type CommandContentResult,
  type CommandCompletionsResult,
} from "./protocol.js";

type Params<T extends ControlRequest["type"]> = Extract<ControlRequest,{type:T}>["params"];
type Parser<T>=(input:unknown)=>T;
const MAX_PENDING_STREAM_EVENTS=1_000;
const LONG_MUTATION_TYPES = new Set<ControlRequest["type"]>([
  "instance.create", "instance.ensure", "instance.adopt", "instance.reopen", "instance.stop",
  "command.abort", "session.switch", "session.new", "session.compact", "session.reload",
  "session.navigate", "session.fork", "session.clone",
]);

export interface EventSubscription { initial:InstanceReadResult; close:()=>void; done:Promise<void> }
export interface FollowSubscription { initial:FollowResult; close:()=>void; done:Promise<void> }
export interface OperationSubscription { initial:ExtensionUiControlResult; close:()=>void; done:Promise<void> }
export interface DockClientOptions { socketPath:string; timeoutMs?:number; longMutationTimeoutMs?:number; requestId?:()=>string; clientId?:string }
export interface ConversationImageReadResult {
  mimeType: string;
  chunks: number;
  sizeBytes: number;
  sha256: string;
}
export interface DeliverableDownloadResult {
  deliverable: DeliverableDto;
  chunks: number;
  sizeBytes: number;
  sha256: string;
}
export interface AttachmentUploadSource {
  name: string;
  sizeBytes: number;
  sha256: string;
  mediaType?: string;
  open(): AsyncIterable<Uint8Array>;
}
export class ControlClientError extends Error {
  constructor(readonly code:string,message:string,readonly operationId?:string,readonly details?:import("../core/json-value.js").JsonObject){super(message);this.name="ControlClientError";}
}

export class DockClient {
  readonly socketPath:string;
  private readonly timeoutMs:number;
  private readonly longMutationTimeoutMs:number;
  private readonly createRequestId:()=>string;
  private readonly clientId:string;
  private readonly activeSockets=new Set<Socket>();
  constructor(options:DockClientOptions){this.socketPath=normalizeLocalEndpoint(options.socketPath);this.timeoutMs=options.timeoutMs??30_000;this.longMutationTimeoutMs=options.longMutationTimeoutMs??options.timeoutMs??600_000;this.createRequestId=options.requestId??randomUUID;this.clientId=options.clientId??randomUUID();}

  /** Close this client's transport scope. Sent Host mutations remain Host-owned and are never retried. */
  closeActiveConnections():void{for(const socket of this.activeSockets)socket.destroy();this.activeSockets.clear();}

  async hostInfo():Promise<HostInfoResult>{return this.request("host.info",{},"host.info",parseHostInfoResult);}
  async machines():Promise<MachinesResult>{return this.request("machine.list",{},MACHINES_CAPABILITY,parseMachinesResult);}
  async removeMachine(hostId:string,operationId=this.createRequestId()):Promise<MachineRemovalResult>{return this.request("machine.remove",{operationId,hostId},MACHINES_CAPABILITY,parseMachineRemovalResult);}
  async ping():Promise<PingResult>{let negotiated:string[]=[];const info=await this.request("host.info",{},"host.info",parseHostInfoResult,(ack)=>{negotiated=[...ack.capabilities];});return {pid:info.host.pid,protocolVersion:2,hostEpoch:info.host.hostEpoch,capabilities:negotiated};}

  async uploadFile(path:string,mediaType?:string,operationId=this.createRequestId(),instanceId?:string):Promise<AttachmentUploadResult>{
    const absolute=resolve(path);
    const details=await stat(absolute);
    if(!details.isFile())throw new ControlClientError("invalid_attachment_source","Attachment source must be a regular file",operationId);
    if(details.size>MAX_ATTACHMENT_BYTES)throw new ControlClientError("attachment_too_large",`Attachment source exceeds ${MAX_ATTACHMENT_BYTES} bytes`,operationId);
    const hash=createHash("sha256");
    for await(const chunk of createReadStream(absolute))hash.update(chunk as Buffer);
    return this.uploadAttachment({
      name:basename(absolute),
      sizeBytes:details.size,
      sha256:hash.digest("hex"),
      ...(mediaType===undefined?{}:{mediaType}),
      open:()=>createReadStream(absolute),
    },operationId,instanceId);
  }

  uploadAttachment(source:AttachmentUploadSource,operationId=this.createRequestId(),instanceId?:string):Promise<AttachmentUploadResult>{
    const helloId=this.createRequestId();
    const requestId=this.createRequestId();
    const capabilities=requiredCapabilities(ATTACHMENTS_CAPABILITY);
    const request:Extract<ControlRequest,{type:"attachment.upload"}>={
      kind:"request",version:2,requestId,type:"attachment.upload",
      params:{operationId,...(instanceId===undefined?{}:{instanceId}),name:source.name,sizeBytes:source.sizeBytes,...(source.mediaType===undefined?{}:{mediaType:source.mediaType}),sha256:source.sha256},
    };
    return new Promise<AttachmentUploadResult>((resolveUpload,rejectUpload)=>{
      const socket=this.openSocket();
      const decoder=new JsonLineDecoder();
      let phase:"hello"|"ready"|"response"="hello";
      let hostEpoch="";
      let settled=false;
      let requestSent=false;
      let completionSent=false;
      let bodyStarted=false;
      let timeout:NodeJS.Timeout;
      const armTimeout=():void=>{
        clearTimeout(timeout);
        timeout=setTimeout(()=>{
          const message=completionSent
            ? `Attachment operation ${operationId} timed out after completion; re-upload the same bytes to recover the durable receipt`
            : `Attachment upload timed out after ${this.longMutationTimeoutMs}ms without progress`;
          finish(new ControlClientError(completionSent?"effect_unknown":"timeout",message,operationId));
        },this.longMutationTimeoutMs);
      };
      const finish=(error?:unknown,result?:AttachmentUploadResult):void=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        socket.destroy();
        if(error===undefined)resolveUpload(result as AttachmentUploadResult);
        else rejectUpload(normalizeClientError(error));
      };
      const writeLine=async(value:unknown):Promise<void>=>{
        if(settled)throw new ControlClientError("connection_closed","Attachment upload connection is closed",operationId);
        if(!socket.write(encodeJsonLine(value)))await waitForUploadDrain(socket,operationId);
        armTimeout();
      };
      const sendBody=async(maxChunkBytes:number):Promise<void>=>{
        const chunkLimit=Math.min(maxChunkBytes,MAX_ATTACHMENT_CHUNK_BYTES);
        const hash=createHash("sha256");
        let size=0,index=0;
        for await(const raw of source.open()){
          if(settled)return;
          const buffer=Buffer.from(raw);
          for(let offset=0;offset<buffer.byteLength;offset+=chunkLimit){
            const chunk=buffer.subarray(offset,Math.min(buffer.byteLength,offset+chunkLimit));
            size+=chunk.byteLength;
            if(size>source.sizeBytes)throw new ControlClientError("attachment_source_changed","Attachment source exceeds its declared size",operationId);
            hash.update(chunk);
            await writeLine({kind:"attachment_chunk",version:2,requestId,index,data:chunk.toString("base64")});
            index+=1;
          }
        }
        const digest=hash.digest("hex");
        if(size!==source.sizeBytes||digest!==source.sha256)throw new ControlClientError("attachment_source_changed","Attachment source changed after its size or SHA-256 was declared",operationId);
        completionSent=true;
        await writeLine({kind:"attachment_complete",version:2,requestId,chunks:index});
        armTimeout();
      };
      const consumeResponse=(raw:unknown):void=>{
        const response=parseControlResponse(raw,requestId,hostEpoch);
        if(!response.ok){finish(new ControlClientError(response.error.code,response.error.message,operationId,response.error.details));return;}
        const result=parseAttachmentUploadResult(response.result);
        if(result.attachment.sha256!==source.sha256||result.attachment.sizeBytes!==source.sizeBytes)throw new ProtocolValidationError("invalid_response","Attachment upload receipt does not match the declared content");
        finish(undefined,result);
      };
      const consume=(line:string):void=>{
        if(!line||settled)return;
        let raw:unknown;
        try{raw=JSON.parse(line);}catch{finish(new ControlClientError("invalid_response","Host returned invalid JSON during attachment upload",operationId));return;}
        try{
          if(phase==="hello"){
            const ack=parseHelloReply(raw,helloId);
            hostEpoch=ack.host.hostEpoch;
            for(const required of capabilities)if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
            phase="ready";
            socket.write(encodeJsonLine(request));
            requestSent=true;
            armTimeout();
            return;
          }
          if(phase==="ready"){
            if(raw!==null&&typeof raw==="object"&&!Array.isArray(raw)&&(raw as {kind?:unknown}).kind==="response"){
              consumeResponse(raw);
              return;
            }
            const ready=parseAttachmentUploadReady(raw,requestId,hostEpoch);
            if(bodyStarted)throw new ProtocolValidationError("invalid_response","Host repeated attachment upload readiness");
            bodyStarted=true;
            phase="response";
            armTimeout();
            void sendBody(ready.maxChunkBytes).catch((error)=>finish(error));
            return;
          }
          consumeResponse(raw);
        }catch(error){finish(error);}
      };
      armTimeout();
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,capabilities))));
      socket.on("data",(chunk:Buffer)=>{try{for(const line of decoder.push(chunk))consume(line);}catch(error){finish(error);}});
      socket.once("end",()=>{try{decoder.finish();}catch(error){finish(error);}});
      socket.once("error",(error)=>{
        const normalized=transportError(error);
        finish(completionSent
          ? new ControlClientError("effect_unknown",`Transport failed after attachment operation ${operationId} completed; re-upload the same bytes to recover`,operationId)
          : normalized);
      });
      socket.once("close",()=>{
        if(settled)return;
        if(completionSent)finish(new ControlClientError("effect_unknown",`Host closed after attachment operation ${operationId} completed; re-upload the same bytes to recover`,operationId));
        else if(requestSent)finish(new ControlClientError("connection_closed","Host closed before the attachment upload completed",operationId));
        else finish(new ControlClientError("connection_closed","Host closed before responding"));
      });
    });
  }

  async create(cwd:string,name?:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice},hostId?:string,workerConfig?:JsonObject):Promise<InstanceSnapshot>{const result=await this.request("instance.create",{operationId,cwd,name,hostId,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision,workerConfig},workerConfig===undefined?"instance.catalog":WORKER_CONFIG_CAPABILITY,parseCreateResult);return result.instance;}
  ensure(key:string,cwd:string,name?:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice},hostId?:string):Promise<EnsureResult>{return this.request("instance.ensure",{operationId,key,cwd,name,hostId,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},INSTANCE_KEYS_CAPABILITY,parseEnsureResult);}
  async getByKey(key:string):Promise<InstanceSnapshot|undefined>{const result:KeyLookupResult=await this.request("instance.get_by_key",{key},INSTANCE_KEYS_CAPABILITY,parseKeyLookupResult);return result.instance??undefined;}
  adopt(sessionFile:string,name?:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice},hostId?:string):Promise<AdoptResult>{return this.request("instance.adopt",{operationId,sessionFile,name,hostId,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"session.adopt.v1",parseCreateResult);}
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
  async listPage(selector: "actionable" | "all", cursor?: InstanceListCursor, limit = MAX_INSTANCE_LIST_ITEMS): Promise<ListResult> {
    return this.request("instance.list", { selector, cursor, limit }, "instance.catalog", parseListResult);
  }
  async status(instanceId:string):Promise<InstanceSnapshot>{return (await this.request("instance.get",{instanceId},["instance.catalog",PERSISTENT_INTERACTIONS_CAPABILITY],parseStatusResult)).instance;}
  forget(instanceId:string,operationId=this.createRequestId()):Promise<ForgetResult>{return this.request("instance.forget",{operationId,instanceId},"catalog.maintenance.v1",parseForgetResult);}
  pruneStopped(operationId=this.createRequestId()):Promise<PruneResult>{return this.request("catalog.prune",{operationId,selector:"stopped"},"catalog.maintenance.v1",parsePruneResult);}
  reopen(instanceId:string,operationId=this.createRequestId(),sessionFile?:string,trust?:{challengeId:string;decision:ProjectTrustChoice}):Promise<ReopenResult>{return this.request("instance.reopen",{operationId,instanceId,sessionFile,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"session.reopen",parseReopenResult);}
  read(instanceId:string,since?:EventCursor,replay:"event_log"|"conversation_bootstrap"="event_log"):Promise<InstanceReadResult>{return this.request("instance.read",{instanceId,since,replay},[INSTANCE_READ_CAPABILITY,IMAGE_INPUT_CAPABILITY,PERSISTENT_INTERACTIONS_CAPABILITY],parseInstanceReadResult);}
  prompt(instanceId:string,message:string,delivery:DeliveryMode="auto",operationId=this.createRequestId(),images?:ImagePathDto[],attachments?:string[]):Promise<PromptResult>{return this.request("command.submit",{operationId,instanceId,message,...(images===undefined?{}:{images}),...(attachments===undefined?{}:{attachments}),delivery},["session.core",...(images===undefined?[]:[IMAGE_INPUT_CAPABILITY]),...(attachments===undefined?[]:[ATTACHMENTS_CAPABILITY])],parsePromptResult);}
  respondInteraction(instanceId:string,leaseToken:string,interactionId:string,response:InteractionResponse,operationId=this.createRequestId()):Promise<InteractionRespondResult>{if("value" in response){const limit=response.method==="select"?8_000:256_000;if(response.value.length>limit)return Promise.reject(new ControlClientError("invalid_request",`Interaction ${response.method} response exceeds ${limit} characters`,operationId));}return this.request("interaction.respond",{operationId,instanceId,leaseToken,interactionId,response},["extension_ui.v1",PERSISTENT_INTERACTIONS_CAPABILITY],parseInteractionRespondResult);}
  setToolsExpanded(instanceId:string,expectedRuntimeGeneration:number,expanded:boolean,operationId=this.createRequestId()):Promise<{instance:InstanceSnapshot}>{return this.request("extension.tools_expanded.set",{operationId,instanceId,expectedRuntimeGeneration,expanded},TOOLS_EXPANDED_CAPABILITY,parseStatusResult);}
  setExtensionWidgetViewport(instanceId:string,leaseToken:string,expectedRuntimeGeneration:number,width:number,height:number):Promise<WidgetViewportResult>{return this.request("extension.widget_viewport.set",{instanceId,leaseToken,expectedRuntimeGeneration,width,height},EXTENSION_WIDGET_CAPABILITY,parseWidgetViewportResult);}
  abort(instanceId:string,operationId=this.createRequestId()):Promise<AbortResult>{return this.request("command.abort",{operationId,instanceId},"run.abort.v1",parseAbortResult,undefined,this.longMutationTimeoutMs);}
  dequeue(instanceId:string,operationId=this.createRequestId()):Promise<QueueDequeueResult>{return this.request("queue.dequeue",{operationId,instanceId},["queue.control.v1",IMAGE_INPUT_CAPABILITY],parseQueueDequeueResult);}
  models(instanceId:string):Promise<ModelsResult>{return this.request("model.list",{instanceId},["models.v1","projection.completeness.v1"],parseModelsResult);}
  setModel(instanceId:string,provider:string,modelId:string,operationId=this.createRequestId()):Promise<ModelConfigurationResult>{return this.request("model.set",{operationId,instanceId,provider,modelId},"models.v1",parseModelConfigurationResult);}
  setThinking(instanceId:string,level:ThinkingLevel,operationId=this.createRequestId()):Promise<ThinkingConfigurationResult>{return this.request("thinking.set",{operationId,instanceId,level},"models.v1",parseThinkingConfigurationResult);}
  tools(instanceId:string):Promise<ToolsResult>{return this.request("tool.list",{instanceId},["tools.v1","projection.completeness.v1"],parseToolsResult);}
  setActiveTools(instanceId:string,names:string[],operationId=this.createRequestId()):Promise<ToolsResult>{return this.request("tool.set_active",{operationId,instanceId,names},["tools.v1","projection.completeness.v1"],parseToolsResult);}
  settings(instanceId:string):Promise<SettingsResult>{return this.request("settings.get",{instanceId},"settings.v1",parseSettingsResult);}
  updateSetting(instanceId:string,update:SettingUpdate,operationId=this.createRequestId()):Promise<SettingUpdateResult>{return this.request("settings.update",{operationId,instanceId,update},"settings.v1",parseSettingUpdateResult);}
  resourceContent(instanceId:string,contentRef:string,offset?:number,revision?:string):Promise<ResourceContentResult>{return this.request("resource.content",{instanceId,contentRef,offset,revision},RESOURCE_CONTENT_CAPABILITY,parseResourceContentResult);}
  resources(instanceId:string):Promise<ResourcesResult>{return this.request("resource.get",{instanceId},["resources.v1","projection.completeness.v1"],parseResourcesResult);}
  commands(instanceId:string,prefix?:string):Promise<CommandsResult>{return this.request("command.catalog",{instanceId,prefix},["resources.v1","projection.completeness.v1"],parseCommandsResult);}
  commandContent(instanceId:string,command:CommandReferenceDto,cursor?:string):Promise<CommandContentResult>{return this.request("command.content",{instanceId,command,cursor},COMMAND_DISCOVERY_CAPABILITY,parseCommandContentResult);}
  commandCompletions(instanceId:string,command:CommandReferenceDto,argumentPrefix:string):Promise<CommandCompletionsResult>{return this.request("command.complete",{instanceId,command,argumentPrefix},COMMAND_DISCOVERY_CAPABILITY,parseCommandCompletionsResult);}
  history(instanceId:string,beforeEntryId?:string,limit=200):Promise<HistoryResult>{return this.request("session.history",{instanceId,beforeEntryId,limit},["tui.projection.v1",IMAGE_INPUT_CAPABILITY],parseHistoryResult);}
  async conversationHistory(instanceId:string,cursor?:string,limit=50):Promise<ConversationHistoryResult>{const result=await this.request("conversation.history",{instanceId,cursor,limit},CONVERSATION_CONTENT_CAPABILITY,parseConversationHistoryResult);if(result.instance.id!==instanceId)throw new ControlClientError("invalid_response","Conversation history result belongs to another instance");return result;}
  async conversationContent(instanceId:string,contentRef:string,cursor?:string):Promise<ConversationContentResult>{const result=await this.request("conversation.content",{instanceId,contentRef,cursor},CONVERSATION_CONTENT_CAPABILITY,parseConversationContentResult);if(result.instanceId!==instanceId||result.contentRef!==contentRef)throw new ControlClientError("invalid_response","Conversation content result belongs to another request");return result;}

  readConversationImage(instanceId:string,contentRef:string,onChunk:(chunk:Uint8Array)=>void|Promise<void>):Promise<ConversationImageReadResult>{
    const helloId=this.createRequestId(),requestId=this.createRequestId();
    const capabilities=requiredCapabilities(CONVERSATION_IMAGES_CAPABILITY);
    const request:Extract<ControlRequest,{type:"conversation.image"}>={kind:"request",version:2,requestId,type:"conversation.image",params:{instanceId,contentRef}};
    return new Promise<ConversationImageReadResult>((resolveRead,rejectRead)=>{
      const socket=this.openSocket(),decoder=new JsonLineDecoder();
      let phase:"hello"|"ready"|"stream"|"complete"="hello",hostEpoch="",settled=false,requestSent=false;
      let mimeType:string|undefined,expectedSize:number|undefined,expectedSha:string|undefined,index=0,sizeBytes=0,completion:ConversationImageReadResult|undefined;
      const hash=createHash("sha256");let timeout:NodeJS.Timeout;
      const finish=(error?:unknown,result?:ConversationImageReadResult):void=>{if(settled)return;settled=true;clearTimeout(timeout);socket.destroy();error===undefined?resolveRead(result as ConversationImageReadResult):rejectRead(normalizeClientError(error));};
      const resetTimeout=():void=>{clearTimeout(timeout);timeout=setTimeout(()=>finish(new ControlClientError("timeout",`Conversation image read timed out after ${this.longMutationTimeoutMs}ms`)),this.longMutationTimeoutMs);};
      const identity=()=>({requestId,hostEpoch,instanceId,contentRef});
      const consume=async(line:string):Promise<void>=>{
        if(!line||settled)return;let raw:unknown;
        try{raw=JSON.parse(line);}catch{throw new ControlClientError("invalid_response","Host returned invalid JSON during conversation image read");}
        if(phase==="hello"){
          const ack=parseHelloReply(raw,helloId);hostEpoch=ack.host.hostEpoch;
          for(const required of capabilities)if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
          phase="ready";requestSent=true;socket.write(encodeJsonLine(request));resetTimeout();return;
        }
        if(phase==="complete")throw new ProtocolValidationError("invalid_response","Conversation image sent data after completion");
        if(phase==="ready"&&raw!==null&&typeof raw==="object"&&(raw as {kind?:unknown}).kind==="response"){
          const response=parseControlResponse(raw,requestId,hostEpoch);
          if(!response.ok)throw new ControlClientError(response.error.code,response.error.message,undefined,response.error.details);
          throw new ProtocolValidationError("invalid_response","Conversation image returned an ordinary success response");
        }
        const frame=parseConversationImageFrame(raw,identity());resetTimeout();
        if(phase==="ready"){
          if(frame.kind!=="conversation_image_ready")throw new ProtocolValidationError("invalid_response","Conversation image did not begin with readiness");
          mimeType=frame.mimeType;expectedSize=frame.sizeBytes;expectedSha=frame.sha256;phase="stream";return;
        }
        if(frame.kind==="conversation_image_error")throw new ControlClientError(frame.error.code,frame.error.message);
        if(frame.kind==="conversation_image_ready")throw new ProtocolValidationError("invalid_response","Host repeated conversation image readiness");
        if(frame.kind==="conversation_image_chunk"){
          if(frame.index!==index)throw new ProtocolValidationError("invalid_response","Conversation image chunks arrived out of order");
          const bytes=Buffer.from(frame.data,"base64");
          if(expectedSize===undefined||sizeBytes+bytes.byteLength>expectedSize)throw new ProtocolValidationError("invalid_response","Conversation image bytes exceed the declared size");
          hash.update(bytes);await onChunk(bytes);sizeBytes+=bytes.byteLength;index+=1;return;
        }
        const digest=hash.digest("hex");
        if(mimeType===undefined||expectedSize===undefined||expectedSha===undefined||frame.chunks!==index||frame.sizeBytes!==sizeBytes||sizeBytes!==expectedSize||frame.sha256!==digest||digest!==expectedSha)throw new ProtocolValidationError("invalid_response","Conversation image completion does not match received bytes");
        completion={mimeType,chunks:index,sizeBytes,sha256:digest};phase="complete";
      };
      let processing=Promise.resolve();resetTimeout();
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,capabilities))));
      socket.on("data",(chunk:Buffer)=>{socket.pause();processing=processing.then(async()=>{for(const line of decoder.push(chunk))await consume(line);}).catch(finish).finally(()=>{if(!settled&&!socket.destroyed)socket.resume();});});
      socket.once("end",()=>{processing=processing.then(()=>{decoder.finish();if(!completion)throw new ControlClientError("connection_closed","Host ended before the conversation image completed");finish(undefined,completion);}).catch(finish);});
      socket.once("error",error=>finish(transportError(error)));
      socket.once("close",()=>{void processing.then(()=>{if(!settled)finish(new ControlClientError("connection_closed",requestSent?"Host closed before the conversation image completed":"Host closed before responding"));});});
    });
  }

  async readFile(instanceId:string,fileRef:string,offset?:number):Promise<FileReadResult>{const requestedOffset=offset??0;const result=await this.request("file.read",{instanceId,fileRef,offset},PUBLISHED_FILES_CAPABILITY,(input)=>parseFileReadResult(input,requestedOffset));if(result.instanceId!==instanceId||result.file.fileRef!==fileRef||result.offset!==requestedOffset)throw new ControlClientError("invalid_response","Published file result belongs to another request");return result;}
  async listDeliverables(instanceId:string):Promise<DeliverableDto[]>{const result=await this.request("deliverable.list",{instanceId},INSTANCE_DELIVERABLES_CAPABILITY,parseDeliverableListResult);if(result.instanceId!==instanceId)throw new ControlClientError("invalid_response","Temporary file list belongs to another work");return result.deliverables;}

  downloadDeliverable(instanceId:string,deliveryRef:string,onChunk:(chunk:Uint8Array)=>void|Promise<void>):Promise<DeliverableDownloadResult>{
    const helloId=this.createRequestId(),requestId=this.createRequestId();
    const capabilities=requiredCapabilities(INSTANCE_DELIVERABLES_CAPABILITY);
    const request:Extract<ControlRequest,{type:"deliverable.download"}>={kind:"request",version:2,requestId,type:"deliverable.download",params:{instanceId,deliveryRef}};
    return new Promise<DeliverableDownloadResult>((resolveDownload,rejectDownload)=>{
      const socket=this.openSocket(),decoder=new JsonLineDecoder();
      let phase:"hello"|"ready"|"stream"|"complete"="hello",hostEpoch="",settled=false,requestSent=false;
      let deliverable:DeliverableDto|undefined,index=0,sizeBytes=0,completion:DeliverableDownloadResult|undefined;
      const hash=createHash("sha256");
      let timeout:NodeJS.Timeout;
      const finish=(error?:unknown,result?:DeliverableDownloadResult):void=>{if(settled)return;settled=true;clearTimeout(timeout);socket.destroy();error===undefined?resolveDownload(result as DeliverableDownloadResult):rejectDownload(normalizeClientError(error));};
      const resetTimeout=():void=>{clearTimeout(timeout);timeout=setTimeout(()=>finish(new ControlClientError("timeout",`Temporary file download timed out after ${this.longMutationTimeoutMs}ms`)),this.longMutationTimeoutMs);};
      const identity=()=>({requestId,hostEpoch,instanceId,deliveryRef});
      const consume=async(line:string):Promise<void>=>{
        if(!line||settled)return;
        let raw:unknown;try{raw=JSON.parse(line);}catch{throw new ControlClientError("invalid_response","Host returned invalid JSON during temporary file download");}
        if(phase==="hello"){
          const ack=parseHelloReply(raw,helloId);hostEpoch=ack.host.hostEpoch;
          for(const required of capabilities)if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
          phase="ready";requestSent=true;socket.write(encodeJsonLine(request));resetTimeout();return;
        }
        if(phase==="complete")throw new ProtocolValidationError("invalid_response","Temporary file download sent data after completion");
        if(phase==="ready"&&raw!==null&&typeof raw==="object"&&(raw as {kind?:unknown}).kind==="response"){
          const response=parseControlResponse(raw,requestId,hostEpoch);
          if(!response.ok)throw new ControlClientError(response.error.code,response.error.message,undefined,response.error.details);
          throw new ProtocolValidationError("invalid_response","Temporary file download returned an ordinary success response");
        }
        const frame=parseDeliverableDownloadFrame(raw,identity());resetTimeout();
        if(phase==="ready"){
          if(frame.kind!=="deliverable_download_ready")throw new ProtocolValidationError("invalid_response","Temporary file download did not begin with readiness");
          deliverable=frame.deliverable;phase="stream";return;
        }
        if(frame.kind==="deliverable_download_error")throw new ControlClientError(frame.error.code,frame.error.message);
        if(frame.kind==="deliverable_download_ready")throw new ProtocolValidationError("invalid_response","Host repeated temporary file download readiness");
        if(frame.kind==="deliverable_download_chunk"){
          if(frame.index!==index)throw new ProtocolValidationError("invalid_response","Temporary file chunks arrived out of order");
          const bytes=Buffer.from(frame.data,"base64");
          if(!deliverable||sizeBytes+bytes.byteLength>deliverable.sizeBytes)throw new ProtocolValidationError("invalid_response","Temporary file bytes exceed the declared size");
          hash.update(bytes);await onChunk(bytes);sizeBytes+=bytes.byteLength;index+=1;return;
        }
        if(!deliverable||frame.chunks!==index||frame.sizeBytes!==sizeBytes||sizeBytes!==deliverable.sizeBytes)throw new ProtocolValidationError("invalid_response","Temporary file completion counts do not match received bytes");
        const digest=hash.digest("hex");
        if(frame.sha256!==digest)throw new ProtocolValidationError("invalid_response","Temporary file SHA-256 verification failed");
        completion={deliverable,chunks:index,sizeBytes,sha256:digest};phase="complete";
      };
      let processing=Promise.resolve();resetTimeout();
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,capabilities))));
      socket.on("data",(chunk:Buffer)=>{socket.pause();processing=processing.then(async()=>{for(const line of decoder.push(chunk))await consume(line);}).catch(finish).finally(()=>{if(!settled&&!socket.destroyed)socket.resume();});});
      socket.once("end",()=>{processing=processing.then(()=>{
        decoder.finish();
        if(!completion)throw new ControlClientError("connection_closed","Host ended before the temporary file download completed");
        finish(undefined,completion);
      }).catch(finish);});
      socket.once("error",error=>finish(transportError(error)));
      socket.once("close",()=>{void processing.then(()=>{if(!settled)finish(new ControlClientError("connection_closed",requestSent?"Host closed before the temporary file download completed":"Host closed before responding"));});});
    });
  }
  async listWorkspaceEntries(instanceId:string,path:string,cursor?:WorkspaceListCursor,limit=MAX_WORKSPACE_LIST_ITEMS):Promise<WorkspaceEntryListResult>{const normalizedPath=workspaceRequestPath(path);const result=await this.request("workspace.entry.list",{instanceId,path:normalizedPath,cursor,limit},WORKSPACE_FILES_CAPABILITY,parseWorkspaceEntryListResult);if(result.instanceId!==instanceId||result.path!==normalizedPath)throw new ControlClientError("invalid_response","Workspace entries belong to another request");return result;}
  async getWorkspaceEntry(instanceId:string,path:string):Promise<WorkspaceEntryDto>{const normalizedPath=workspaceRequestPath(path);const result=await this.request("workspace.entry.get",{instanceId,path:normalizedPath},WORKSPACE_FILES_CAPABILITY,parseWorkspaceEntryGetResult);if(result.instanceId!==instanceId||result.entry.path!==normalizedPath)throw new ControlClientError("invalid_response","Workspace entry belongs to another request");return result.entry;}

  readWorkspaceFile(instanceId:string,path:string,onChunk:(chunk:Uint8Array)=>void|Promise<void>,signal?:AbortSignal):Promise<WorkspaceFileReadResult>{
    const helloId=this.createRequestId(),requestId=this.createRequestId();
    const capabilities=requiredCapabilities(WORKSPACE_FILES_CAPABILITY);
    return new Promise<WorkspaceFileReadResult>((resolveRead,rejectRead)=>{
      let normalizedPath:string;
      try{normalizedPath=normalizeWorkspaceRelativePath(path);}catch(error){rejectRead(normalizeClientError(error));return;}
      const request:Extract<ControlRequest,{type:"workspace.file.read"}>={kind:"request",version:2,requestId,type:"workspace.file.read",params:{instanceId,path:normalizedPath}};
      if(signal?.aborted){rejectRead(new ControlClientError("aborted","Workspace file read was cancelled"));return;}
      const socket=this.openSocket(),decoder=new JsonLineDecoder();
      let phase:"hello"|"ready"|"stream"|"complete"="hello",hostEpoch="",settled=false,requestSent=false;
      let entry:WorkspaceEntryDto|undefined,index=0,sizeBytes=0,completion:WorkspaceFileReadResult|undefined;
      const hash=createHash("sha256");
      let timeout:NodeJS.Timeout;
      const onAbort=():void=>finish(new ControlClientError("aborted","Workspace file read was cancelled"));
      const finish=(error?:unknown,result?:WorkspaceFileReadResult):void=>{if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener("abort",onAbort);socket.destroy();error===undefined?resolveRead(result as WorkspaceFileReadResult):rejectRead(normalizeClientError(error));};
      const resetTimeout=():void=>{clearTimeout(timeout);timeout=setTimeout(()=>finish(new ControlClientError("timeout",`Workspace file read timed out after ${this.longMutationTimeoutMs}ms`)),this.longMutationTimeoutMs);};
      const identity=()=>({requestId,hostEpoch,instanceId,path:normalizedPath});
      const consume=async(line:string):Promise<void>=>{
        if(!line||settled)return;
        let raw:unknown;try{raw=JSON.parse(line);}catch{throw new ControlClientError("invalid_response","Host returned invalid JSON during workspace file read");}
        if(phase==="hello"){
          const ack=parseHelloReply(raw,helloId);hostEpoch=ack.host.hostEpoch;
          for(const required of capabilities)if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
          phase="ready";requestSent=true;socket.write(encodeJsonLine(request));resetTimeout();return;
        }
        if(phase==="complete")throw new ProtocolValidationError("invalid_response","Workspace file read sent data after completion");
        if(phase==="ready"&&raw!==null&&typeof raw==="object"&&(raw as {kind?:unknown}).kind==="response"){
          const response=parseControlResponse(raw,requestId,hostEpoch);
          if(!response.ok)throw new ControlClientError(response.error.code,response.error.message,undefined,response.error.details);
          throw new ProtocolValidationError("invalid_response","Workspace file read returned an ordinary success response");
        }
        const frame=parseWorkspaceFileReadFrame(raw,identity());resetTimeout();
        if(phase==="ready"){
          if(frame.kind!=="workspace_file_read_ready")throw new ProtocolValidationError("invalid_response","Workspace file read did not begin with metadata");
          entry=frame.entry;phase="stream";return;
        }
        if(frame.kind==="workspace_file_read_error")throw new ControlClientError(frame.error.code,frame.error.message);
        if(frame.kind==="workspace_file_read_ready")throw new ProtocolValidationError("invalid_response","Host repeated workspace file metadata");
        if(frame.kind==="workspace_file_read_chunk"){
          if(frame.index!==index)throw new ProtocolValidationError("invalid_response","Workspace file chunks arrived out of order");
          const bytes=Buffer.from(frame.data,"base64");
          if(sizeBytes+bytes.byteLength>MAX_SOURCE_FILE_TRANSFER_BYTES)throw new ProtocolValidationError("invalid_response","Workspace file bytes exceed the supported size");
          hash.update(bytes);await onChunk(bytes);sizeBytes+=bytes.byteLength;index+=1;return;
        }
        if(!entry||frame.chunks!==index||frame.sizeBytes!==sizeBytes)throw new ProtocolValidationError("invalid_response","Workspace file completion counts do not match received bytes");
        const digest=hash.digest("hex");
        if(frame.sha256!==digest)throw new ProtocolValidationError("invalid_response","Workspace file SHA-256 verification failed");
        completion={entry,chunks:index,sizeBytes,sha256:digest};phase="complete";
      };
      let processing=Promise.resolve();resetTimeout();signal?.addEventListener("abort",onAbort,{once:true});
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,capabilities))));
      socket.on("data",(chunk:Buffer)=>{socket.pause();processing=processing.then(async()=>{for(const line of decoder.push(chunk))await consume(line);}).catch(finish).finally(()=>{if(!settled&&!socket.destroyed)socket.resume();});});
      socket.once("end",()=>{processing=processing.then(()=>{decoder.finish();if(!completion)throw new ControlClientError("connection_closed","Host ended before the workspace file read completed");finish(undefined,completion);}).catch(finish);});
      socket.once("error",error=>finish(transportError(error)));
      socket.once("close",()=>{void processing.then(()=>{if(!settled)finish(new ControlClientError("connection_closed",requestSent?"Host closed before the workspace file read completed":"Host closed before responding"));});});
    });
  }

  systemCatalog(cwd:string,hostId?:string,cursor?:SystemCatalogCursor,limit=MAX_SYSTEM_CATALOG_ITEMS):Promise<SystemCatalogResult>{return this.request("system.catalog",{cwd,hostId,cursor,limit},SYSTEM_TEMPLATES_CAPABILITY,parseSystemCatalogResult);}
  systemContent(cwd:string,id:string,hostId?:string,offset?:number,revision?:string):Promise<ResourceContentResult>{return this.request("system.content",{cwd,id,hostId,offset,revision},SYSTEM_TEMPLATES_CAPABILITY,parseResourceContentResult);}
  setSystemDefault(cwd:string,id:string,hostId?:string,operationId=this.createRequestId()):Promise<SystemDefaultSetResult>{return this.request("system.default.set",{cwd,id,hostId,operationId},SYSTEM_TEMPLATES_CAPABILITY,parseSystemDefaultSetResult);}
  sessionInventory(cwd:string,scope:"cwd"|"all"="cwd",hostId?:string):Promise<SessionInventoryResult>{return this.request("session.inventory",{cwd,scope,hostId},["session.inventory.v1","session.inventory-diagnostics.v1"],parseSessionInventoryResult);}
  workspaceList(path:string,cursor?:WorkspaceListCursor,limit=MAX_WORKSPACE_LIST_ITEMS,hostId?:string):Promise<WorkspaceListResult>{return this.request("workspace.list",{path,cursor,limit,hostId},WORKSPACE_LIST_CAPABILITY,parseWorkspaceListResult);}
  sessions(instanceId:string,scope:"cwd"|"all"):Promise<SessionsResult>{return this.request("session.list",{instanceId,scope},["session.core","projection.completeness.v1"],parseSessionsResult);}
  switchSession(instanceId:string,sessionFile:string,operationId=this.createRequestId(),trust?:{challengeId:string;decision:ProjectTrustChoice}):Promise<SessionReplacementResult>{return this.request("session.switch",{operationId,instanceId,sessionFile,trustChallengeId:trust?.challengeId,projectTrustDecision:trust?.decision},"session.commands.v1",parseSessionReplacementResult);}
  newSession(instanceId:string,parentSession?:string,operationId=this.createRequestId()):Promise<SessionReplacementResult>{return this.request("session.new",{operationId,instanceId,parentSession},"session.commands.v1",parseSessionReplacementResult);}
  nameSession(instanceId:string,name:string,operationId=this.createRequestId()):Promise<SessionNameResult>{return this.request("session.name",{operationId,instanceId,name},"session.commands.v1",parseSessionNameResult);}
  compactionPrompts(instanceId:string):Promise<CompactionPromptTemplatesResult>{return this.request("session.compaction.prompts",{instanceId},COMPACTION_PROMPTS_CAPABILITY,parseCompactionPromptTemplatesResult);}
  compactSession(instanceId:string,customInstructions?:string,operationId=this.createRequestId()):Promise<SessionCompactionResult>{return this.request("session.compact",{operationId,instanceId,customInstructions},"session.commands.v1",parseSessionCompactionResult,undefined,this.longMutationTimeoutMs);}
  reloadSession(instanceId:string,operationId=this.createRequestId()):Promise<SessionReloadResult>{return this.request("session.reload",{operationId,instanceId},["session.commands.v1","projection.completeness.v1"],parseSessionReloadResult,undefined,this.longMutationTimeoutMs);}
  tree(instanceId:string):Promise<SessionTreeResult>{return this.request("session.tree",{instanceId},"session.tree.v2",parseSessionTreeResult);}
  navigateSession(instanceId:string,targetId:string,options:{summarize?:boolean;customInstructions?:string;replaceInstructions?:boolean;label?:string}={},operationId=this.createRequestId()):Promise<SessionNavigateResult>{return this.request("session.navigate",{operationId,instanceId,targetId,...options},"session.tree.v2",parseSessionNavigateResult);}
  forkSession(instanceId:string,entryId:string,operationId=this.createRequestId()):Promise<SessionForkResult>{return this.request("session.fork",{operationId,instanceId,entryId},"session.tree.v2",parseSessionForkResult);}
  cloneSession(instanceId:string,entryId:string,operationId=this.createRequestId()):Promise<SessionCloneResult>{return this.request("session.clone",{operationId,instanceId,entryId},"session.tree.v2",parseSessionCloneResult);}
  stop(instanceId:string,operationId=this.createRequestId()):Promise<StopResult>{return this.request("instance.stop",{operationId,instanceId},"instance.catalog",parseStopResult,undefined,this.longMutationTimeoutMs);}

  async streamEvents(instanceId:string,options:{since?:EventCursor;onEvent:(event:DockEvent)=>void;requireTuiProjection?:boolean;conversationBootstrap?:boolean}):Promise<EventSubscription>{
    const replay=options.conversationBootstrap?"conversation_bootstrap":"event_log";
    const initial=await this.read(instanceId,options.since,replay);
    const requested=options.since;
    const followSince=requested
      && !initial.page.epochChanged
      && !initial.page.generationChanged
      && requested.instanceId===initial.page.latest.instanceId
      && requested.runtimeGeneration===initial.page.latest.runtimeGeneration
      && requested.hostEpoch===initial.page.latest.hostEpoch
      && requested.sequence>initial.page.latest.sequence
      ? requested
      : initial.page.latest;
    const follow=await this.follow(instanceId,followSince,{onEvent:options.onEvent,requireTuiProjection:options.requireTuiProjection});
    return {initial,close:follow.close,done:follow.done};
  }

  follow(instanceId:string,since:EventCursor,options:{onEvent:(event:DockEvent)=>void;requireTuiProjection?:boolean}):Promise<FollowSubscription>{
    const capabilities:Capability[]=options.requireTuiProjection
      ? [EVENTS_FOLLOW_CAPABILITY,TOOLS_EXPANDED_CAPABILITY,EXTENSION_WIDGET_CAPABILITY,GIT_BRANCH_CAPABILITY,INSTANCE_KEYS_CAPABILITY,TOOL_RESULT_PRESENTATION_CAPABILITY,IMAGE_INPUT_CAPABILITY,PERSISTENT_INTERACTIONS_CAPABILITY,"queue.control.v1","run.abort.v1","tui.projection.v1"]
      : [EVENTS_FOLLOW_CAPABILITY,IMAGE_INPUT_CAPABILITY,PERSISTENT_INTERACTIONS_CAPABILITY];
    return this.openEventStream({
      request:{kind:"request",version:2,requestId:this.createRequestId(),type:"instance.follow",params:{instanceId,since}},
      capabilities,
      parseInitial:parseFollowResult,
      initialCursor:(result)=>result.page.latest,
      initialEvents:(result)=>result.page.events,
      onEvent:options.onEvent,
      cleanEnd:false,
      validateInitial:(result,hostEpoch)=>{
        if(result.page.earliest.hostEpoch!==hostEpoch||result.page.latest.hostEpoch!==hostEpoch||result.page.latest.instanceId!==instanceId)throw new ProtocolValidationError("invalid_response","Live updates do not match this work");
      },
    });
  }

  controlExtensionUi(instanceId:string,onEvent:(event:Extract<DockEvent,{type:"interaction.requested"|"extension.title_set"|"extension.editor_text_set"}>)=>void):Promise<OperationSubscription>{
    type OperationEvent=Extract<DockEvent,{type:"interaction.requested"|"extension.title_set"|"extension.editor_text_set"}>;
    return this.openEventStream({
      request:{kind:"request",version:2,requestId:this.createRequestId(),type:"interaction.control",params:{instanceId}},
      capabilities:[EXTENSION_UI_CONTROL_CAPABILITY,"extension_ui.v1",PERSISTENT_INTERACTIONS_CAPABILITY],
      parseInitial:parseExtensionUiControlResult,
      initialCursor:(result)=>({hostEpoch:"",instanceId:result.instanceId,runtimeGeneration:result.runtimeGeneration,sequence:0}),
      initialEvents:()=>[],
      onEvent:(event)=>{
        if(!isOperationEvent(event))throw new ProtocolValidationError("invalid_response","Extension UI operation stream received an untargeted event");
        onEvent(event as OperationEvent);
      },
      cleanEnd:true,
      validateInitial:(result)=>{if(result.instanceId!==instanceId)throw new ProtocolValidationError("invalid_response","Extension UI operation result belongs to another instance");},
    });
  }

  private openEventStream<T>(options:{
    request:Extract<ControlRequest,{type:"instance.follow"|"interaction.control"}>;
    capabilities:readonly Capability[];
    parseInitial:Parser<T>;
    initialCursor:(result:T)=>EventCursor;
    initialEvents:(result:T)=>DockEvent[];
    onEvent:(event:DockEvent)=>void;
    validateInitial:(result:T,hostEpoch:string)=>void;
    cleanEnd:boolean;
  }):Promise<{initial:T;close:()=>void;done:Promise<void>}>{
    const helloId=this.createRequestId(),requestId=options.request.requestId;
    const streamCapabilities=[...new Set(options.capabilities.flatMap((item)=>requiredCapabilities(item)))];
    const socket=this.openSocket(),decoder=new JsonLineDecoder();let phase:"hello"|"response"|"events"="hello",hostEpoch="",initialSettled=false,doneSettled=false,closeRequested=false,callbacksReady=false,pending:DockEvent[]=[],runtimeGeneration:number|undefined,lastSequence=-1;
    let resolveInitial!:(x:{initial:T;close:()=>void;done:Promise<void>})=>void,rejectInitial!:(e:unknown)=>void,resolveDone!:()=>void,rejectDone!:(e:unknown)=>void;
    const done=new Promise<void>((r,j)=>{resolveDone=r;rejectDone=j;});void done.catch(()=>{});const initial=new Promise<{initial:T;close:()=>void;done:Promise<void>}>((r,j)=>{resolveInitial=r;rejectInitial=j;});
    const settleDone=(e?:unknown)=>{if(doneSettled)return;doneSettled=true;e===undefined?resolveDone():rejectDone(e);};
    const fail=(e:unknown)=>{clearTimeout(timeout);const error=normalizeClientError(e);if(!initialSettled){initialSettled=true;rejectInitial(error);}pending=[];settleDone(error);socket.destroy();};
    const timeout=setTimeout(()=>fail(new ControlClientError("timeout",`Control request timed out after ${this.timeoutMs}ms`)),this.timeoutMs);
    const dispatchQueued=()=>{if(closeRequested||doneSettled)return;callbacksReady=true;const queued=pending;pending=[];for(const event of queued){try{options.onEvent(event);}catch(e){fail(e);return;}}};
    const consume=(line:string)=>{if(!line)return;let raw:unknown;try{raw=JSON.parse(line);}catch{fail(new ControlClientError("invalid_response","Host returned invalid JSON"));return;}try{
      if(phase==="hello"){const ack=parseHelloReply(raw,helloId);hostEpoch=ack.host.hostEpoch;for(const required of streamCapabilities){if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);}phase="response";socket.write(encodeJsonLine(options.request));return;}
      if(phase==="response"){const response=parseControlResponse(raw,requestId,hostEpoch);if(!response.ok){fail(new ControlClientError(response.error.code,response.error.message));return;}const result=options.parseInitial(response.result);options.validateInitial(result,hostEpoch);const cursor=options.initialCursor(result);runtimeGeneration=cursor.runtimeGeneration;lastSequence=cursor.sequence;phase="events";clearTimeout(timeout);pending.push(...options.initialEvents(result));initialSettled=true;resolveInitial({initial:result,close:()=>{closeRequested=true;pending=[];socket.destroy();},done});setImmediate(dispatchQueued);return;}
      const event=parseControlEventEnvelope(raw,requestId,hostEpoch).event;
      if(event.instanceId!==options.request.params.instanceId)throw new ProtocolValidationError("invalid_response","Live event belongs to another instance");
      if(event.runtimeGeneration!==runtimeGeneration){
        if(options.request.type==="instance.follow"){const nextGeneration=runtimeGeneration===undefined?undefined:runtimeGeneration+1;if(event.type!=="session.replaced"||event.runtimeGeneration!==nextGeneration||event.sequence!==1||event.data.runtimeGeneration!==event.runtimeGeneration)throw new ProtocolValidationError("invalid_response","Live updates changed unexpectedly");}
        runtimeGeneration=event.runtimeGeneration;lastSequence=0;
      }
      if(event.sequence<=lastSequence)throw new ProtocolValidationError("invalid_response","Live updates arrived out of order");
      lastSequence=event.sequence;
      if(!callbacksReady){if(pending.length>=MAX_PENDING_STREAM_EVENTS)throw new ControlClientError("event_handoff_overflow","More than 1000 events arrived during stream handoff; reconnect from the last accepted update position");pending.push(event);}else options.onEvent(event);
    }catch(e){fail(e);}};
    socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,streamCapabilities))));socket.on("data",(chunk:Buffer)=>{try{for(const line of decoder.push(chunk))consume(line);}catch(e){fail(e);}});socket.once("end",()=>{try{decoder.finish();}catch(e){fail(e);}});socket.once("error",e=>fail(transportError(e)));socket.once("close",hadError=>{clearTimeout(timeout);if(!initialSettled){const e=new ControlClientError("connection_closed","Host closed before responding");initialSettled=true;rejectInitial(e);settleDone(e);}else if(!doneSettled){if(closeRequested||options.cleanEnd&&!hadError)settleDone();else settleDone(new ControlClientError("connection_closed",hadError?"Stream closed after a transport error":"Host closed the stream unexpectedly"));}});
    return initial;
  }

  private openSocket():Socket{const socket=createConnection(this.socketPath);this.activeSockets.add(socket);socket.once("close",()=>this.activeSockets.delete(socket));return socket;}
  private timeoutFor(type:ControlRequest["type"]):number{return LONG_MUTATION_TYPES.has(type)?this.longMutationTimeoutMs:this.timeoutMs;}
  private hello(requestId:string,capabilities:string[]):ClientHello{return {kind:"hello",requestId,versions:[2],client:{name:"alu-dock-client",version:DOCK_VERSION,clientId:this.clientId},requiredCapabilities:capabilities};}
  private request<TType extends ControlRequest["type"],T>(type:TType,params:Params<TType>,capability:Capability|readonly Capability[],parse:Parser<T>,onHello?:(ack:HelloAck)=>void,requestTimeoutMs=this.timeoutFor(type)):Promise<T>{
    const helloId=this.createRequestId();
    const requestCapabilities=[...new Set((Array.isArray(capability)?capability:[capability]).flatMap((item)=>requiredCapabilities(item)))];
    const requestId=this.createRequestId();
    const request={kind:"request",version:2,requestId,type,params} as Extract<ControlRequest,{type:TType}>;
    const operationId = "operationId" in params && typeof params.operationId === "string" ? params.operationId : undefined;
    return new Promise<T>((resolveRequest,rejectRequest)=>{
      const socket=this.openSocket();
      const decoder=new JsonLineDecoder();
      let phase:"hello"|"response"="hello";
      let hostEpoch="";
      let settled=false;
      let requestSent=false;
      let responseTransfer:{count:number;chunks:string[]}|undefined;
      let timeout:NodeJS.Timeout;
      const onTimeout=():void=>{
        if(requestSent&&operationId) finish(new ControlClientError("effect_unknown",`Operation ${operationId} timed out after it was sent; query current state before retrying`,operationId));
        else finish(new ControlClientError("timeout",`Control request timed out after ${requestTimeoutMs}ms`));
      };
      const resetTimeout=():void=>{clearTimeout(timeout);timeout=setTimeout(onTimeout,requestTimeoutMs);};
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
      timeout=setTimeout(onTimeout,requestTimeoutMs);
      const consume=(line:string):void=>{
        if(!line)return;
        let raw:unknown;
        try{raw=JSON.parse(line);}catch{finish(new ControlClientError("invalid_response","Host returned invalid JSON"));return;}
        try{
          if(phase==="hello"){
            const ack=parseHelloReply(raw,helloId);
            hostEpoch=ack.host.hostEpoch;
            for(const required of requestCapabilities){
              if(!ack.capabilities.includes(required))throw new ProtocolValidationError("protocol_incompatible",`Host lacks ${required}`);
            }
            onHello?.(ack);
            phase="response";
            socket.write(encodeJsonLine(request));
            requestSent=true;
            return;
          }
          if(raw!==null&&typeof raw==="object"&&(raw as {kind?:unknown}).kind==="response_transfer"){
            if(type!=="session.tree")throw new ProtocolValidationError("invalid_response","This request cannot use response transfer framing");
            const frame=parseResponseTransferFrame(raw,requestId,hostEpoch);
            resetTimeout();
            if(responseTransfer===undefined){
              if(frame.index!==0)throw new ProtocolValidationError("invalid_response","Response transfer did not begin with chunk zero");
              responseTransfer={count:frame.count,chunks:[]};
            }
            if(frame.count!==responseTransfer.count||frame.index!==responseTransfer.chunks.length)throw new ProtocolValidationError("invalid_response","Response transfer chunks are inconsistent or out of order");
            responseTransfer.chunks.push(frame.data);
            if(responseTransfer.chunks.length<responseTransfer.count)return;
            raw=decodeResponseTransfer(responseTransfer.chunks);
          }else if(responseTransfer!==undefined){
            throw new ProtocolValidationError("invalid_response","Response transfer ended before all chunks arrived");
          }
          const response=parseControlResponse(raw,requestId,hostEpoch);
          if(responseTransfer!==undefined&&!response.ok)throw new ProtocolValidationError("invalid_response","Transferred responses must be successful");
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
      socket.once("connect",()=>socket.write(encodeJsonLine(this.hello(helloId,requestCapabilities))));
      socket.on("data",(chunk:Buffer)=>{try{for(const line of decoder.push(chunk))consume(line);}catch(error){finish(error);}});
      socket.once("end",()=>{try{decoder.finish();}catch(error){
        if(error instanceof JsonLineError&&error.code==="incomplete_record")finishTransport(normalizeClientError(error));
        else finish(error);
      }});
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
  if(type==="instance.ensure"||type==="instance.get_by_key"){
    const requested=params as Extract<ControlRequest,{type:"instance.ensure"|"instance.get_by_key"}>["params"];
    if(snapshots[0]&&snapshots[0].key!==requested.key)throw new ProtocolValidationError("invalid_response","Result does not match requested instance key");
  }
  if(type==="instance.read"||type==="instance.follow"){
    const page=record.page as {earliest?:EventCursor;latest?:EventCursor}|undefined;
    if(!page||page.earliest?.hostEpoch!==hostEpoch||page.latest?.hostEpoch!==hostEpoch)throw new ProtocolValidationError("invalid_response","Update positions do not match this connection");
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
  if(type==="session.inventory"){
    const requested=(params as Extract<ControlRequest,{type:"session.inventory"}>["params"]);
    const inventory=record as unknown as SessionInventoryResult;
    if(inventory.query.cwd!==requested.cwd||inventory.query.scope!==requested.scope)throw new ProtocolValidationError("invalid_response","Session inventory query does not match the request");
  }
  if(type==="command.catalog"&&typeof (params as Extract<ControlRequest,{type:"command.catalog"}>["params"]).prefix==="string"){
    const prefix=(params as Extract<ControlRequest,{type:"command.catalog"}>["params"]).prefix as string;
    if(((record.commands??[]) as Array<{name:string}>).some((command)=>!command.name.startsWith(prefix)))throw new ProtocolValidationError("invalid_response","Command catalog does not match requested prefix");
  }
  if("operationId" in params&&typeof params.operationId==="string"){
    const receipt=record.receipt as {operationId?:unknown}|undefined;
    if(receipt&&receipt.operationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Receipt operationId does not match request operationId");
    if((type==="instance.create"||type==="instance.adopt")&&snapshots[0]?.creationOperationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Created instance operationId does not match request operationId");
    if(type==="instance.adopt"&&snapshots[0]?.executor.sessionFile!==resolvePortableAbsoluteLocalPath((params as Extract<ControlRequest,{type:"instance.adopt"}>["params"]).sessionFile))throw new ProtocolValidationError("invalid_response","Adopted instance session file does not match the request");
    if(type==="instance.reopen"&&record.operationId!==params.operationId)throw new ProtocolValidationError("invalid_response","Reopen operationId does not match request operationId");
  }
}
function isOperationEvent(event:DockEvent):event is Extract<DockEvent,{type:"interaction.requested"|"extension.title_set"|"extension.editor_text_set"}>{return event.type==="interaction.requested"||event.type==="extension.title_set"||event.type==="extension.editor_text_set";}
function waitForUploadDrain(socket:Socket,operationId:string):Promise<void>{if(socket.destroyed||socket.writableEnded)return Promise.reject(new ControlClientError("connection_closed","Attachment upload connection closed during backpressure",operationId));return new Promise((resolveDrain,rejectDrain)=>{const cleanup=():void=>{socket.off("drain",onDrain);socket.off("close",onClose);socket.off("error",onError);};const onDrain=():void=>{cleanup();resolveDrain();};const onClose=():void=>{cleanup();rejectDrain(new ControlClientError("connection_closed","Attachment upload connection closed during backpressure",operationId));};const onError=(error:Error):void=>{cleanup();rejectDrain(transportError(error));};socket.once("drain",onDrain);socket.once("close",onClose);socket.once("error",onError);});}
function normalizeClientError(e:unknown):ControlClientError{if(e instanceof ControlClientError)return e;if(e instanceof JsonLineError&&e.code==="incomplete_record")return new ControlClientError("connection_closed","Host connection closed during a control response; reconnect to recover current state");if(e instanceof ProtocolValidationError)return new ControlClientError(e.code==="unsupported_protocol"?"protocol_incompatible":e.code,e.message);if(e instanceof Error)return new ControlClientError("invalid_response",e.message);return new ControlClientError("invalid_response",String(e));}
function workspaceRequestPath(path:string):string{try{return normalizeWorkspaceRelativePath(path);}catch(error){throw normalizeClientError(error);}}
function transportError(e:Error):ControlClientError{const code=(e as NodeJS.ErrnoException).code;return new ControlClientError("connection_error",`${code?`${code}: `:""}${e.message}`);}
