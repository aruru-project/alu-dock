import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostMachineConnection } from "../src/control/machine-transport.js";
import { AttachmentService } from "../src/control/attachment-service.js";
import { AttachmentStorageState } from "../src/control/attachment-storage-state.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { JsonLineDecoder, encodeJsonLine } from "../src/control/json-lines.js";
import { encodeFileRecord } from "../src/control/file-framing.js";

const realDelay = globalThis.setTimeout.bind(globalThis);
const turn = () => new Promise<void>(resolve => realDelay(resolve, 1));
async function until(predicate:()=>boolean) { for(let i=0;i<2000&&!predicate();i++)await turn();assert.ok(predicate(),"peer did not reach the expected wire boundary"); }
async function port() {const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const value=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;}

// Real TLS is forwarded unchanged. Pausing only between complete TLS records
// exposes a partial machine JSONL record, not unauthenticated cipher fragments.
function tlsGate(target:number) {
  let hold=false;const pending:Array<()=>void>=[];const sockets=new Set<Socket>();
  const server=createServer(socket=>{
    const upstream=createConnection(target,"127.0.0.1");sockets.add(socket);sockets.add(upstream);
    let buffered=Buffer.alloc(0);
    socket.on("error",()=>{});upstream.on("error",()=>{});
    upstream.pipe(socket);
    socket.on("data",bytes=>{
      buffered=Buffer.concat([buffered,bytes]);
      while(buffered.length>=5&&buffered.length>=5+buffered.readUInt16BE(3)){
        const record=buffered.subarray(0,5+buffered.readUInt16BE(3));buffered=buffered.subarray(record.length);
        const send=()=>upstream.write(record);if(hold)pending.push(send);else send();
      }
    });
    socket.on("close",()=>upstream.destroy());
  });
  return {server,hold:()=>{hold=true;},one:()=>pending.shift()?.(),release:()=>{hold=false;for(const send of pending.splice(0))send();},close:async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

class Peer {
  readonly frames:Array<Record<string,any>>=[];
  wire=0;
  constructor(readonly socket:Socket){const decoder=new JsonLineDecoder();socket.on("error",()=>{});socket.on("data",bytes=>{this.wire+=bytes.length;for(const line of decoder.push(bytes))this.frames.push(JSON.parse(line));});}
  send(record:unknown){this.socket.write(encodeJsonLine(record));}
  async next(kind:string){await until(()=>this.frames.some(frame=>frame.kind===kind)||this.socket.destroyed);const index=this.frames.findIndex(frame=>frame.kind===kind);assert.ok(index>=0,`connection ended before ${kind}`);return this.frames.splice(index,1)[0]!;}
}

test("routed files and instance records survive real half-frame progress while idle files close and quiet follow stays open", {timeout:20_000}, async context=>{
  const root=await mkdtemp(join(tmpdir(),"alu-file-route-"));
  const source=Buffer.alloc(300_000,0x61);await writeFile(join(root,"source.bin"),source);
  const storage=()=>new AttachmentService(new AttachmentStorageState(join(root,Math.random().toString(36)),join(root,Math.random().toString(36))));
  const subAttachments=storage(),mainAttachments=storage();
  const runtime=new DelayedAgentWorkerConnection("file-route");
  const registry=new DockRegistry(async input=>new ManagedInstance({...input,session:runtime}),undefined,{attachmentHostPort:subAttachments});
  await registry.create({operationId:"create",cwd:root});
  const sub=new DockHost({socketPath:join(root,"unused"),registry,attachmentService:subAttachments,listen:false});
  const mainState=new MainMachineState(join(root,"main"),"Main");await mainState.initialize();
  const subState=new SubHostMachineState(join(root,"sub"));await subState.prepare(await mainState.createJoin(),"Sub");
  const machinePort=await port();const settings=new MachineSettingsState(join(root,"settings"));await settings.writeMainConnections({enabled:true,port:machinePort});
  const mainRegistry=new DockRegistry(async()=>{throw new Error("local Worker not expected");});
  const controller=new MainMachineController({state:mainState,settingsState:settings,bindAddress:"127.0.0.1",mainHostEpoch:mainRegistry.hostEpoch,localSnapshots:()=>[]});
  const main=new DockHost({socketPath:join(root,"main.sock"),registry:mainRegistry,remoteInstances:controller,attachmentService:mainAttachments});
  const gate=tlsGate(machinePort);gate.server.listen(0,"127.0.0.1");await once(gate.server,"listening");
  let nativeTransit=0,recordTransit=0,recordNotices=0;
  const upstream=new SubHostMachineConnection({state:subState,address:"127.0.0.1",port:(gate.server.address() as {port:number}).port,hostEpoch:registry.hostEpoch,snapshots:()=>registry.list(),acceptProtocolSocket:socket=>{sub.acceptProtocolSocket(socket);const observed=new JsonLineDecoder();socket.on("data",bytes=>{for(const line of observed.push(bytes)){const frame=JSON.parse(line);if(frame.kind==="file_activity")nativeTransit=Math.max(nativeTransit,frame.inTransitBytes);if(frame.kind==="instance_record_activity"){recordTransit=Math.max(recordTransit,frame.inTransitBytes);recordNotices++;}}});}});
  const client=new DockClient({socketPath:main.socketPath});const peers:Peer[]=[];
  const open=async(type:string,params:Record<string,unknown>,cap:string)=>{
    const socket=createConnection(main.socketPath);await once(socket,"connect");const peer=new Peer(socket);peers.push(peer);
    peer.send({kind:"hello",requestId:"hello",versions:[2],client:{name:"route-test",version:"1",clientId:"test"},requiredCapabilities:["core.v2",cap,"file-transfer.v1"]});
    await peer.next("hello_ack");peer.send({kind:"request",version:2,requestId:"file",type,params});return peer;
  };
  try{
    await sub.start();await main.start();await upstream.start();await until(()=>upstream.connected());
    const work=(await client.list())[0]!;
    context.mock.timers.enable({apis:["setTimeout"]});
    const sha256="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const upload=await open("attachment.upload",{instanceId:work.id,operationId:"slow",name:"slow.txt",sizeBytes:3,sha256},"attachments.v1");
    await upload.next("file_ready");
    const line=encodeFileRecord({kind:"file_chunk",version:2,requestId:"file",hostEpoch:mainRegistry.hostEpoch,index:0,data:"YWJj"});
    const cut=line.indexOf('"YWJj"')+2;
    upload.socket.write(line.slice(0,cut));let arrival=await upload.next("file_activity");await until(()=>nativeTransit>=arrival.inTransitBytes);await turn();
    context.mock.timers.tick(59_000);upload.socket.write(line.slice(cut,cut+1));arrival=await upload.next("file_activity");await until(()=>nativeTransit>=arrival.inTransitBytes);await turn();
    context.mock.timers.tick(59_000);upload.socket.write(line.slice(cut+1)+"\n");
    await until(()=>upload.frames.some(f=>f.kind==="file_progress"&&f.consumedBytes===3));
    upload.send({kind:"file_complete",version:2,requestId:"file",hostEpoch:mainRegistry.hostEpoch,chunks:1,sizeBytes:3,sha256});
    assert.equal((await upload.next("response")).ok,true);upload.socket.destroy();

    nativeTransit=0;
    const idle=await open("attachment.upload",{instanceId:work.id,operationId:"idle",name:"idle.txt",sizeBytes:3,sha256},"attachments.v1");
    await idle.next("file_ready");const activity={kind:"file_activity",version:2,requestId:"file",hostEpoch:mainRegistry.hostEpoch,inTransitBytes:1};
    idle.send(activity);await until(()=>nativeTransit>=1);await client.status(work.id);context.mock.timers.tick(59_000);
    idle.send(activity);await client.status(work.id);context.mock.timers.tick(1_001);await until(()=>idle.socket.destroyed);

    nativeTransit=0;gate.hold();
    const download=await open("workspace.file.read",{instanceId:work.id,path:"source.bin"},"workspace.files.v1");
    for(let i=0;i<1000&&!download.frames.some(f=>f.kind==="file_ready");i++){gate.one();await turn();}
    await download.next("file_ready");
    let count=0,parts=0;
    for(let i=0;i<1000&&!download.frames.some(f=>f.kind==="file_chunk");i++){
      gate.one();await turn();await turn();
      if(download.frames.some(f=>f.kind==="file_activity")){
        const reported=Math.max(...download.frames.filter(f=>f.kind==="file_activity").map(f=>Number(f.inTransitBytes)));
        download.frames.splice(0,download.frames.length,...download.frames.filter(f=>f.kind!=="file_activity"));
        await until(()=>nativeTransit>=reported);await turn();
        context.mock.timers.tick(40_000);parts++;
      }
    }
    assert.ok(parts>=2,"a whole machine record must take longer than the former file deadline");
    gate.release();
    while(count<source.length){const chunk=await download.next("file_chunk");count+=Buffer.from(chunk.data,"base64").length;download.send({kind:"file_progress",version:2,requestId:"file",hostEpoch:mainRegistry.hostEpoch,receivedWireBytes:download.wire,consumedBytes:count});}
    assert.equal((await download.next("file_complete")).sizeBytes,300_000);assert.equal((await download.next("response")).ok,true);download.socket.destroy();
    // #325 must retain the file path's solved half-machine-frame liveness while
    // assembling/mapping logical items with independent upstream/downstream credit.
    const accepted=new Promise<void>(resolve=>{const unsubscribe=registry.get(registry.list()[0]!.id).subscribe(event=>{if(event.type==="message.completed"){unsubscribe();resolve();}});});
    runtime.emit({type:"dock_conversation_frame",frame:{type:"message.completed",data:{messageId:"slow-record",role:"assistant",content:[],stopReason:"error",error:"x".repeat(1_100_000)}}});
    await accepted;gate.hold();
    const delivery={};const reading=client.read(work.id,undefined,"conversation_bootstrap",delivery);
    let failed:unknown;void reading.catch(error=>{failed=error;});
    // Advance the fake clock only once the same actual partial-frame notice has
    // reached both endpoints, not on metadata ACKs or scheduler timing.
    let deliveredActivity=0;
    const readSocket=[...(client as unknown as {activeSockets:Set<Socket>}).activeSockets].at(-1)!;
    const observedRecords=new JsonLineDecoder();
    readSocket.on("data",bytes=>{for(const line of observedRecords.push(bytes)){const frame=JSON.parse(line);if(frame.kind==="instance_record_activity")deliveredActivity=Math.max(deliveredActivity,frame.inTransitBytes);}});
    let advanced=0,previous=0;
    for(let attempt=0;attempt<2000&&advanced<3&&!failed;attempt++){
      gate.one();await turn();await turn();
      if(deliveredActivity>previous){previous=deliveredActivity;await until(()=>recordTransit>=previous);await turn();context.mock.timers.tick(40_000);advanced++;}
    }
    assert.equal(failed,undefined);assert.equal(advanced,3);
    gate.release();const read=await reading;
    assert.equal((read.page.events.find(event=>event.type==="message.completed")!.data as {error:string}).error.length,1_100_000);
    // Reverse pressure at the public leg must also keep the paused upstream
    // leg alive: Main holds one mapped record, not a whole initial result.
    const slowSockets=new Set<Socket>();let holding=false,held="",released=false;
    const byteProxy=createServer(incoming=>{
      const outgoing=createConnection(main.socketPath);slowSockets.add(incoming);slowSockets.add(outgoing);
      incoming.on("error",()=>{});outgoing.on("error",()=>{});incoming.pipe(outgoing);
      const decoder=new JsonLineDecoder();
      outgoing.on("data",bytes=>{for(const line of decoder.push(bytes)){
        const frame=JSON.parse(line);
        if(!released&&frame.kind==="instance_record_fragment"&&frame.recordIndex===1)holding=true;
        if(holding)held+=line+"\n";else incoming.write(line+"\n");
      }});
      outgoing.on("end",()=>incoming.end());incoming.on("close",()=>outgoing.destroy());
    });
    byteProxy.listen(join(root,"slow.sock"));await once(byteProxy,"listening");
    const slowClient=new DockClient({socketPath:join(root,"slow.sock")});
    try {
      const slowRead=slowClient.read(work.id,undefined,"conversation_bootstrap",{});
      let slowError:unknown;void slowRead.catch(error=>{slowError=error;});
      await until(()=>held.length>=30_000);
      const incoming=[...slowSockets][0]!;
      for(let step=0;step<3;step++){
        const before=recordNotices;incoming.write(held.slice(0,10_000));held=held.slice(10_000);
        await until(()=>recordNotices>before);await turn();context.mock.timers.tick(40_000);
      }
      assert.equal(slowError,undefined);
      released=true;holding=false;incoming.write(held);held="";
      assert.equal((await slowRead).page.events.length,read.page.events.length);
    } finally {
      slowClient.closeActiveConnections();for(const socket of slowSockets)socket.destroy();await new Promise<void>(resolve=>byteProxy.close(()=>resolve()));
    }
    const follow=await client.follow(work.id,read.page.latest,{deliveryContext:delivery,onEvent:()=>{}});
    // Round-trip a separate real request after the ready ACK so all three hops
    // have completed initialization before advancing the artificial clock.
    await client.status(work.id);await turn();await turn();let ended=false;void follow.done.then(()=>{ended=true;},()=>{ended=true;});
    context.mock.timers.tick(120_000);await turn();assert.equal(ended,false,"quiescent live observation has no idle deadline");
    follow.close();await follow.done;
    const cancel=await open("workspace.file.read",{instanceId:work.id,path:"source.bin"},"workspace.files.v1");await cancel.next("file_ready");cancel.socket.destroy();
    assert.equal((await client.status(work.id)).id,work.id);
  }finally{context.mock.timers.reset();for(const peer of peers)peer.socket.destroy();client.closeActiveConnections();gate.release();await upstream.stop();await main.stop();await sub.stop();await gate.close();await rm(root,{recursive:true,force:true});}
});
