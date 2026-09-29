import { parseInstanceRecordFrame, parseFileTransferFrame, MAX_CONTROL_REQUEST_ID_CHARS, MAX_INSTANCE_ID_CHARS, type FileTransferIdentity } from "./protocol.js";

/** One encoder for common file frames. Consumers remain JSON field-order independent. */
export function encodeFileRecord(record: Record<string, unknown>): string {
  const { kind, version, requestId, hostEpoch, ...body } = record;
  return JSON.stringify({ kind, version, requestId, hostEpoch, ...body });
}
export function encodeRoutedRecord(record: unknown): string {
  return record && typeof record === "object" && typeof (record as {kind?:unknown}).kind === "string" && /^(file_|instance_record_)/u.test(String((record as {kind:string}).kind))
    ? encodeFileRecord(record as Record<string,unknown>) : JSON.stringify(record);
}
const PREFIX_CHARS = 128 + 12 * (MAX_CONTROL_REQUEST_ID_CHARS + MAX_INSTANCE_ID_CHARS);
const TOKEN = '"(?:[^"\\\\]|\\\\.)*"';
const chunkHeader = new RegExp('^\\{"kind":"file_chunk","version":2,"requestId":(' + TOKEN + '),"hostEpoch":(' + TOKEN + '),');
const linkHeaders = new Map<string, RegExp>();
function linkHeader(dataKind: string): RegExp {
  let header = linkHeaders.get(dataKind);
  if (!header) { header = new RegExp('^\\{"kind":' + JSON.stringify(dataKind) + ',"streamId":(' + TOKEN + '),"data":'); linkHeaders.set(dataKind, header); }
  return header;
}
export function instanceRecordHeader(prefix: string): {requestId:string;hostEpoch:string}|undefined {
  return fileChunkHeader(prefix.replace(/^\{"kind":"instance_record_fragment"/, '{"kind":"file_chunk"'));
}
export function fileChunkHeader(prefix: string): {requestId:string;hostEpoch:string}|undefined {
  const match=chunkHeader.exec(prefix.slice(0,PREFIX_CHARS));
  if(!match)return;
  try {return {requestId:JSON.parse(match[1]!),hostEpoch:JSON.parse(match[2]!)};} catch {return;}
}
export function machineFileChunkHeader(prefix: string, records = false): {streamId:string;requestId:string;hostEpoch:string}|undefined {
  return linkFileChunkHeader("machine_stream_data", prefix, records);
}
/** The stream and file identity of a partially received link data record wrapping a file chunk or instance record fragment. */
export function linkFileChunkHeader(dataKind: string, prefix: string, records = false): {streamId:string;requestId:string;hostEpoch:string}|undefined {
  const match=linkHeader(dataKind).exec(prefix.slice(0,PREFIX_CHARS));
  if(!match)return;
  // Decode only the bounded JSON string envelope prefix, never base64 file data.
  const text=prefix.slice(match[0].length,match[0].length+PREFIX_CHARS);
  if(text[0]!== '"')return;
  let end=1;
  while(end<text.length) {
    if(text[end]==='"')break;
    if(text[end]==='\\') {
      const length=text[end+1]==='u'?6:2;
      if(end+length>text.length)break;
      end+=length;
    } else end++;
  }
  try {
    const header=(records?instanceRecordHeader:fileChunkHeader)(JSON.parse(text.slice(0,end)+'"'));
    if(header)return {streamId:JSON.parse(match[1]!),...header};
  } catch { /* Incomplete or noncanonical header: do not manufacture progress. */ }
  return;
}

/** Normal producer plus one coalesced activity slot; never a queue of partial-byte notices. */
export class FileRecordWriter {
  private tail=Promise.resolve();
  private pending?:unknown;
  private reporting=false;
  private closed=false;
  constructor(private readonly output:(record:unknown)=>Promise<void>,private readonly failed:(error:unknown)=>void){}
  write(record:unknown):Promise<void> {
    if(this.pending!==undefined){const activity=this.pending;this.pending=undefined;void this.enqueue(activity).catch(error=>this.failed(error));}
    return this.enqueue(record);
  }
  private enqueue(record:unknown):Promise<void> {
    const task=this.tail.then(()=>{if(this.closed)throw new Error("File stream closed");return this.output(record);});
    this.tail=task.catch(()=>{});return task;
  }
  activity(record:unknown):void {
    if(this.closed)return;
    this.pending=record;
    if(this.reporting)return;
    this.reporting=true;
    void (async()=>{while(this.pending!==undefined&&!this.closed){const record=this.pending;this.pending=undefined;await this.enqueue(record);}})()
      .catch(error=>this.failed(error)).finally(()=>{this.reporting=false;});
  }
  stopActivity():void {this.pending=undefined;}
  close():void {this.closed=true;this.pending=undefined;}
}

/** Two exits of byte transit. Activities carry real progress, never consumption credit. */
export class ByteTransitRelay {
  private own=0;
  private readonly incoming=[0,0];
  private stopped=false;
  private sequence=-1;
  private observed=0;
  private progressWire=0;
  private progressConsumed=0;
  readonly outputs:[FileRecordWriter,FileRecordWriter];
  constructor(private readonly identity:[FileTransferIdentity,FileTransferIdentity],outputs:[(record:unknown)=>Promise<void>,(record:unknown)=>Promise<void>],failed:(error:unknown)=>void, private readonly family: "file" | "instance_record" = "file"){
    this.outputs=[new FileRecordWriter(outputs[0],failed),new FileRecordWriter(outputs[1],failed)];
  }
  private frame(exit:0|1):unknown {
    const inTransitBytes=this.own+this.incoming[1-exit]!;
    if(!Number.isSafeInteger(inTransitBytes))throw new Error("File activity count overflow");
    return {...this.identity[exit],kind:`${this.family}_activity`,inTransitBytes};
  }
  observe(sequence:number,bytes:number):void {
    if(this.stopped)return;
    if(sequence!==this.sequence){this.sequence=sequence;this.observed=0;}
    if(bytes<=this.observed)return;
    this.own+=bytes-this.observed;this.observed=bytes;
    this.outputs[0].activity(this.frame(0));this.outputs[1].activity(this.frame(1));
  }
  /** A mapping hop can be blocked on its downstream window while upstream has
   * queued its next window. Forward genuine downstream progress upstream only. */
  downstreamProgress(wire:number,consumed:number):void {
    const advanced=Math.max(wire-this.progressWire,consumed-this.progressConsumed);
    this.progressWire=wire;this.progressConsumed=consumed;
    if(this.stopped||advanced<=0)return;
    this.own+=advanced;
    this.outputs[1].activity(this.frame(1));
  }
  map(from:0|1,raw:unknown):unknown {
    if(!raw||typeof raw!=="object")return raw;
    const record=raw as {kind?:unknown;inTransitBytes?:unknown};
    if(this.family==="file" && (record.kind==="file_complete"||record.kind==="response")){this.stopped=true;this.outputs.forEach(writer=>writer.stopActivity());}
    if(record.kind!==`${this.family}_activity`)return raw;
    const identity=this.identity[from];
    if(this.family==="file")parseFileTransferFrame(raw,identity.requestId,identity.hostEpoch,from===0?"invalid_request":"invalid_response");
    else parseInstanceRecordFrame(raw,identity.requestId,identity.hostEpoch);
    const value=record.inTransitBytes;
    if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new Error("Invalid file activity");
    this.incoming[from]=Math.max(this.incoming[from]!,value);
    return this.frame((1-from) as 0|1);
  }
  close():void {this.stopped=true;this.outputs.forEach(writer=>writer.close());}
}
