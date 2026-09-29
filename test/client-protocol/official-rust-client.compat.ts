import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

const SESSION_ID = "00000000-0000-4000-8000-000000002609";

/** Cross-runtime gate. Intentionally not named *.test.ts; ordinary npm test stays Node-only. */
test("official Rust client pages through saved sessions, newest conversation first with time and cost, for an explicitly selected Main", { timeout: 60_000 }, async (context) => {
  assert.equal(process.platform, "linux", "test:client-protocol requires Linux isolated Unix-socket process semantics");
  const root = await mkdtemp(join(tmpdir(), "alu-dock-client-protocol-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessions = join(agentDir, "sessions", "fixture");
  const state = join(root, "state", "catalog.json");
  const socket = join(root, "dock.sock");
  const identity = join(root, "client-identity");
  let host: ChildProcess | undefined;

  try {
    await Promise.all([
      mkdir(home),
      mkdir(workspace),
      mkdir(sessions, { recursive: true }),
      mkdir(join(root, "state"), { recursive: true, mode: 0o700 }),
      chmod(root, 0o700),
    ]);
    await writeFile(join(sessions, "saved.jsonl"), `${[
      { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-05T00:00:00.000Z", cwd: workspace },
      { type: "session_info", id: "info-1", parentId: null, timestamp: "2026-09-05T00:00:01.000Z", name: "Protocol gate saved session" },
      { type: "message", id: "message-1", parentId: "info-1", timestamp: "2026-09-05T00:00:02.000Z", message: { role: "user", content: "restore protocol gate", timestamp: 1 } },
      { type: "message", id: "message-2", parentId: "message-1", timestamp: "2026-09-05T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "restored" }], usage: { cost: { total: 0.42 } }, timestamp: Date.parse("2026-09-05T00:00:03.000Z") } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
    // Older sessions than one Host page holds, so the client has to continue.
    await Promise.all(Array.from({ length: 2_000 }, (_, index) => writeFile(
      join(sessions, `older-${index}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: `older-${index}`, timestamp: "2026-08-01T00:00:00.000Z", cwd: workspace })}\n`,
      { mode: 0o600 },
    )));

    const hostEnvironment = isolatedEnvironment(root, home, agentDir);
    host = spawn(process.execPath, ["dist/src/cli.js", "--socket", socket, "serve", "--dev", "--state", state], {
      cwd: process.cwd(), env: hostEnvironment, stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    host.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    await waitForReady(host, stderr);

    const targetDirectory = resolve(process.env.CARGO_TARGET_DIR || "clients/official/target");
    const reader = join(targetDirectory, "debug", "examples", "protocol_inventory");
    const result = await run(reader, [socket, identity, workspace, SESSION_ID], process.env, context.signal);
    assert.equal(result.code, 0, `official Rust client failed:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`decoded saved session ${SESSION_ID} last=2026-09-05T00:00:03.000Z cost=0.42 pages=2 sessions=2001`));
  } finally {
    await stopChild(host);
    await rm(root, { recursive: true, force: true });
  }
});

function isolatedEnvironment(root: string, home: string, agentDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ALU_DOCK_") || key === "STATE_DIRECTORY") delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    PI_CODING_AGENT_DIR: agentDir,
  };
}

async function waitForReady(child: ChildProcess, stderr: string[]): Promise<void> {
  assert.ok(child.stdout);
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line) as { kind?: unknown };
        if (value.kind === "host.ready") resolve();
      } catch { /* Non-JSON output cannot prove readiness. */ }
    });
    child.once("exit", (code, signal) => reject(new Error(`Host exited before ready (${String(code ?? signal)}):\n${stderr.join("")}`)));
  });
  let readyTimeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    readyTimeout = setTimeout(() => reject(new Error(`Host ready timeout:\n${stderr.join("")}`)), 10_000);
  });
  try {
    await Promise.race([ready, deadline]);
  } finally {
    if (readyTimeout) clearTimeout(readyTimeout);
    lines.close();
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let child: ChildProcess | undefined;
  try {
    return await new Promise((resolveRun, reject) => {
      child = spawn(command, args, { cwd: process.cwd(), env, signal, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
    });
  } finally {
    await stopChild(child);
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

// #325 independent transport evidence: the real official observation owner reads
// complete initial/live content through real Main/SubHost TLS, not a Rust fake peer.
test("official ConversationObservation receives complete routed initial and consecutive large live records", { timeout: 60_000 }, async (context) => {
  const {DockHost}=await import("../../src/control/dock-host.js");
  const {DockClient}=await import("../../src/control/dock-client.js");
  const {DockRegistry}=await import("../../src/control/dock-registry.js");
  const {ManagedInstance}=await import("../../src/core/managed-instance.js");
  const {DelayedAgentWorkerConnection}=await import("../support/delayed-agent-worker.js");
  const {MainMachineState,SubHostMachineState}=await import("../../src/control/machine-state.js");
  const {MachineSettingsState}=await import("../../src/control/machine-settings-state.js");
  const {MainMachineController,SubHostMachineConnection}=await import("../../src/control/machine-transport.js");
  const {parseConversationFrame}=await import("../../src/control/protocol.js");
  const {createServer,createConnection}=await import("node:net");
  const {JsonLineDecoder}=await import("../../src/control/json-lines.js");
  const root=await mkdtemp(join(tmpdir(),"alu-routed-records-"));
  const runtime=new DelayedAgentWorkerConnection("record-gate-session");
  const registry=new DockRegistry(async ({id,creationOperationId,hostEpoch,cwd})=>new ManagedInstance({id,creationOperationId,hostEpoch,cwd,session:runtime}));
  const sub=new DockHost({socketPath:join(root,"sub.sock"),registry});
  const subClient=new DockClient({socketPath:sub.socketPath});
  let main:InstanceType<typeof DockHost>|undefined,upstream:InstanceType<typeof SubHostMachineConnection>|undefined,reader:ChildProcess|undefined;
  context.after(async()=>{await stopChild(reader);subClient.closeActiveConnections();await upstream?.stop();await main?.stop();await sub.stop();await rm(root,{recursive:true,force:true});});
  await sub.start();const work=await subClient.create(root);
  const emit=(messageId:string,error:string)=>runtime.emit({type:"dock_conversation_frame",frame:parseConversationFrame({type:"message.completed",data:{messageId,role:"assistant",content:[],stopReason:"error",error}})});
  const accepted=new Promise<void>(resolve=>{const unsubscribe=registry.get(work.id).subscribe(event=>{if(event.type==="message.delta"&&event.data.messageId==="distinct-1000"){unsubscribe();resolve();}});});
  emit("initial-large",`${work.id}|${registry.hostEpoch}|${"雪".repeat(370000)}`);
  for(let index=0;index<1001;index++)runtime.emit({type:"dock_conversation_frame",frame:parseConversationFrame({type:"message.delta",data:{messageId:`distinct-${index}`,block:"text",delta:"x"}})});
  await accepted;
  const source=await registry.get(work.id).getAttachProjection(undefined,200,"conversation_bootstrap");
  const mainState=new MainMachineState(join(root,"main-state"),"Main");await mainState.initialize();
  const subState=new SubHostMachineState(join(root,"sub-state"));await subState.prepare(await mainState.createJoin(),"Records target");
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const settings=new MachineSettingsState(join(root,"settings"));await settings.writeMainConnections({enabled:true,port});
  const mainRegistry=new DockRegistry(async()=>{throw new Error("No local runtime in routed gate");});
  const controller=new MainMachineController({state:mainState,settingsState:settings,bindAddress:"127.0.0.1",mainHostEpoch:mainRegistry.hostEpoch,localSnapshots:()=>[]});
  main=new DockHost({socketPath:join(root,"main.sock"),registry:mainRegistry,remoteInstances:controller});
  upstream=new SubHostMachineConnection({state:subState,address:"127.0.0.1",port,hostEpoch:registry.hostEpoch,snapshots:()=>registry.list(),acceptProtocolSocket:socket=>sub.acceptProtocolSocket(socket)});
  await main.start();await upstream.start();
  const client=new DockClient({socketPath:main.socketPath});context.after(()=>client.closeActiveConnections());
  let routed:Awaited<ReturnType<typeof client.list>>[number]|undefined;
  for(let attempt=0;attempt<200;attempt++){routed=(await client.list())[0];if(routed)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(routed);assert.notEqual(routed.id,work.id);
  // Hold a real initial event halfway through its first physical fragment. The
  // Rust owner is replaced before readiness; late bytes must not publish a Read.
  let holdFirst=true,releaseOld=()=>{};
  const proxySockets=new Set<import("node:net").Socket>();
  const proxy=createServer(incoming=>{
    const outgoing=createConnection(main!.socketPath);proxySockets.add(incoming);proxySockets.add(outgoing);
    const requests=new JsonLineDecoder(),responses=new JsonLineDecoder();let candidate=false,holding=false;
    const held:string[]=[];
    incoming.on("error",()=>{});outgoing.on("error",()=>{});
    incoming.on("data",bytes=>{for(const line of requests.push(bytes)){const raw=JSON.parse(line);if(raw.type==="instance.read"&&holdFirst){candidate=true;holdFirst=false;}}outgoing.write(bytes);});
    outgoing.on("data",bytes=>{for(const line of responses.push(bytes)){
      const raw=JSON.parse(line);
      if(candidate&&!holding&&raw.kind==="instance_record_fragment"&&raw.recordIndex===1){
        holding=true;const cut=Math.floor(line.length/2);incoming.write(line.slice(0,cut));held.push(line.slice(cut)+"\n");
        releaseOld=()=>{for(const part of held.splice(0))if(!incoming.destroyed)incoming.write(part);};
        reader!.stdin!.write("replace\n");
      }else if(holding)held.push(line+"\n");else incoming.write(line+"\n");
    }});
    outgoing.on("end",()=>{if(!holding)incoming.end();});incoming.on("close",()=>{held.length=0;outgoing.destroy();});
  });
  const proxyPath=join(root,"observation.sock");await new Promise<void>(resolve=>proxy.listen(proxyPath,resolve));
  context.after(async()=>{for(const socket of proxySockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});
  const executable=join(resolve(process.env.CARGO_TARGET_DIR||"clients/official/target"),"debug","examples","protocol_records");
  reader=spawn(executable,[proxyPath,join(root,"identity"),join(root,"content"),routed.id,mainRegistry.hostEpoch,routed.hostId!,work.id,registry.hostEpoch,String(source.page.truncated),String(source.page.latest.sequence)],{env:process.env,stdio:["pipe","pipe","pipe"],signal:context.signal});
  let stderr="",stdout="";reader.stderr!.on("data",chunk=>{stderr+=String(chunk);});
  const lines=createInterface({input:reader.stdout!});
  lines.on("line",line=>{stdout+=line+"\n";const value=JSON.parse(line) as {kind:string};if(value.kind==="records.owner-replaced")releaseOld();if(value.kind==="records.initial")emit("live-0","a".repeat(5*1024*1024));if(value.kind==="records.first-live"){emit("live-1","b".repeat(5*1024*1024));emit("live-2","small tail");}});
  const code=await new Promise<number|null>((resolve,reject)=>{reader!.once("error",reject);reader!.once("exit",resolve);});
  assert.equal(code,0,stderr);assert.match(stdout,/records.pass/u);
});
