import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { DockClient } from "../src/control/dock-client.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";
import { encodeJsonLine, JsonLineDecoder } from "../src/control/json-lines.js";
import { FileRelayActivity } from "../src/control/file-channel.js";
import { parseFileTransferFrame } from "../src/control/protocol.js";

// Frozen file-transfer.v1 integrity and unbounded-memory boundaries, not a business size policy.
test("file frame parser rejects noncanonical bytes and windows beyond the negotiated safety budget", () => {
  const identity = { version: 2, requestId: "file", hostEpoch: "host" };
  assert.deepEqual(parseFileTransferFrame({ ...identity, kind: "file_chunk", index: 0, data: "YQ==" }, "file", "host"), { ...identity, kind: "file_chunk", index: 0, data: "YQ==" });
  assert.throws(() => parseFileTransferFrame({ ...identity, kind: "file_chunk", index: 0, data: "YR==" }, "file", "host"));
  assert.throws(() => parseFileTransferFrame({ ...identity, kind: "file_ready", direction: "download", maxChunkBytes: 65536, windowBytes: 262145 }, "file", "host"));
});

// A real Host entry protects the agreed finite buffering/true-idle cleanup contract.
// Only time is accelerated; hello, source open, writes, progress and close are real sockets.
test("a file client that stops consuming cannot grow the send queue or keep a truly idle file open with repeated progress", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-file-window-"));
  await writeFile(join(root, "large.bin"), Buffer.alloc(900_000));
  const registry = new DockRegistry(async (input) => new ManagedInstance({ ...input, session: new DelayedAgentWorkerConnection("window-worker") }));
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  const client = new DockClient({ socketPath: host.socketPath });
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    await host.start();
    const instance = await client.create(root);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    socket = createConnection(host.socketPath);
    await once(socket, "connect");
    const decoder = new JsonLineDecoder();
    const frames: Record<string, unknown>[] = [];
    let resolveWindow!: () => void;
    const windowFull = new Promise<void>((resolve) => { resolveWindow = resolve; });
    socket.on("data", (bytes: Buffer) => {
      for (const line of decoder.push(bytes)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame.kind === "hello_ack") socket!.write(encodeJsonLine({ kind: "request", version: 2, requestId: "file", type: "workspace.file.read", params: { instanceId: instance.id, path: "large.bin" } }));
        if (frames.filter((item) => item.kind === "file_chunk").length === 4) resolveWindow();
      }
    });
    socket.write(encodeJsonLine({ kind: "hello", requestId: "hello", versions: [2], client: { name: "window-test", version: "1", clientId: "window" }, requiredCapabilities: ["core.v2", "workspace.files.v1", "file-transfer.v1"] }));
    await windowFull;
    assert.equal((await client.status(instance.id)).id, instance.id);
    assert.equal(frames.filter((item) => item.kind === "file_chunk").reduce((sum, item) => sum + Buffer.from(item.data as string, "base64").length, 0), 262144);
    assert.equal(frames.some((item) => item.kind === "file_complete"), false);
    context.mock.timers.tick(30_000);
    socket.write(encodeJsonLine({ kind: "file_progress", version: 2, requestId: "file", hostEpoch: registry.hostEpoch, consumedBytes: 0, receivedWireBytes: 0 }));
    // A separate real request lets the socket input queue run; this is not timer progress.
    await client.status(instance.id);
    const closed = once(socket, "close");
    context.mock.timers.tick(30_000);
    await closed;
    assert.equal(frames.filter((item) => item.kind === "file_chunk").length, 4);
  } finally {
    context.mock.timers.reset(); socket?.destroy(); client.closeActiveConnections(); await host.stop(); await rm(root, { recursive: true, force: true });
  }
});

// A slow wire can take longer than the idle deadline to finish one JSONL chunk.
// Actual arriving bytes, not synthetic heartbeats, must keep that upload alive.
test("an upload reports real partial-record reception while waiting for the rest of a slow chunk", async (context) => {
  const { AttachmentService } = await import("../src/control/attachment-service.js");
  const { AttachmentStorageState } = await import("../src/control/attachment-storage-state.js");
  const root = await mkdtemp(join(tmpdir(), "alu-file-partial-"));
  const attachments = new AttachmentService(new AttachmentStorageState(join(root, "state"), join(root, "files")));
  const registry = new DockRegistry(async () => { throw new Error("No Worker needed"); }, undefined, { attachmentHostPort: attachments });
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry, attachmentService: attachments });
  let socket: ReturnType<typeof createConnection> | undefined;
  const frames: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  const next = async (kind: string, consumed?: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.kind === kind && (consumed === undefined || frame.consumedBytes === consumed));
      if (index >= 0) return frames.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  };
  try {
    await host.start();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    socket = createConnection(host.socketPath);
    await once(socket, "connect");
    const decoder = new JsonLineDecoder();
    socket.on("data", (bytes: Buffer) => { for (const line of decoder.push(bytes)) frames.push(JSON.parse(line)); wake?.(); wake = undefined; });
    socket.write(encodeJsonLine({ kind: "hello", requestId: "hello", versions: [2], client: { name: "partial-test", version: "1", clientId: "partial" }, requiredCapabilities: ["core.v2", "attachments.v1", "file-transfer.v1"] }));
    await next("hello_ack");
    const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    socket.write(encodeJsonLine({ kind: "request", version: 2, requestId: "file", type: "attachment.upload", params: { operationId: "partial", name: "slow.txt", sizeBytes: 3, sha256 } }));
    await next("file_ready");
    socket.write(`{"kind":"file_chunk","version":2,"requestId":"file","hostEpoch":${JSON.stringify(registry.hostEpoch)},"index":0,"data":"Y`);
    const first = await next("file_progress", 0);
    context.mock.timers.tick(59_000);
    socket.write("WJ");
    const second = await next("file_progress", 0);
    assert.ok(Number(second.receivedWireBytes) > Number(first.receivedWireBytes));
    context.mock.timers.tick(59_000);
    socket.write('j"}\n');
    await next("file_progress", 3);
    socket.write(encodeJsonLine({ kind: "file_complete", version: 2, requestId: "file", hostEpoch: registry.hostEpoch, chunks: 1, sizeBytes: 3, sha256 }));
    const response = await next("response");
    assert.equal(response.ok, true);
  } finally { context.mock.timers.reset(); socket?.destroy(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});

// The machine transport admits many simultaneous logical streams. Output budget
// exhaustion from those legitimate producers must wait, not lose a user's file.
test("concurrent file producers wait for machine output capacity and leave heartbeat priority intact", async () => {
  const { EventEmitter } = await import("node:events");
  const { writeMachine } = await import("../src/control/machine-transport.js");
  const records: Array<{ kind: string }> = [];
  let blocked = true;
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    write(bytes: Buffer) { records.push(JSON.parse(bytes.toString())); return !blocked; },
  });
  const data = JSON.stringify({ kind: "file_chunk", version: 2, requestId: "file", hostEpoch: "host", index: 0, data: Buffer.alloc(65_536).toString("base64") });
  const writes = Array.from({ length: 160 }, (_, index) => writeMachine(socket as unknown as import("node:tls").TLSSocket, { kind: "machine_stream_data", streamId: `file-${index}`, data }));
  writes.push(writeMachine(socket as unknown as import("node:tls").TLSSocket, { kind: "machine_ping" }));
  blocked = false; socket.emit("drain");
  await Promise.all(writes);
  assert.equal(records[1]?.kind, "machine_ping");
  assert.equal(records.filter((record) => record.kind === "machine_stream_data").length, 160);
  assert.equal(records.some((record) => record.kind === "machine_stream_reset"), false);
  socket.emit("close");
});

test("forwarding waits while receiver progress advances, but repeated progress cannot extend an idle connection", (context) => {
  const peer = new EventEmitter();
  let closed = false;
  const socket = Object.assign(peer, { destroyed: false, writableEnded: false, destroy() { closed = true; peer.emit("close"); }, end() { peer.emit("close"); } });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const relay = new FileRelayActivity(socket as unknown as import("node:net").Socket, "file", "host");
  const identity = { version: 2, requestId: "file", hostEpoch: "host" };
  try {
    relay.record({ kind: "file_ready", ...identity, direction: "download", maxChunkBytes: 65_536, windowBytes: 262_144 });
    context.mock.timers.tick(59_000);
    const progress = { kind: "file_progress", ...identity, receivedWireBytes: 100, consumedBytes: 0 };
    relay.record(progress);
    context.mock.timers.tick(59_000);
    assert.equal(closed, false);
    relay.record(progress);
    context.mock.timers.tick(1_000);
    assert.equal(closed, true);
  } finally { relay.dispose(); context.mock.timers.reset(); }
});

test("a negotiated upload uses file idle, not a shorter business timeout, between source chunks", async context=>{
  const { AttachmentService } = await import("../src/control/attachment-service.js");
  const { AttachmentStorageState } = await import("../src/control/attachment-storage-state.js");
  const {createHash}=await import("node:crypto");
  const root=await mkdtemp(join(tmpdir(),"alu-file-timer-"));
  const service=new AttachmentService(new AttachmentStorageState(join(root,"state"),join(root,"files")));
  const registry=new DockRegistry(async()=>{throw new Error("No Worker needed");},undefined,{attachmentHostPort:service});
  const host=new DockHost({socketPath:join(root,"dock.sock"),registry,attachmentService:service});
  const client=new DockClient({socketPath:host.socketPath,timeoutMs:3000});
  let release!:()=>void,started!:()=>void;
  const waiting=new Promise<void>(resolve=>{started=resolve;});
  try {
    await host.start();context.mock.timers.enable({apis:["setTimeout"]});
    const upload=client.uploadAttachment({name:"source",sizeBytes:6,sha256:createHash("sha256").update("abcabc").digest("hex"),async *open(){yield Buffer.from("abc");await new Promise<void>(resolve=>{release=resolve;started();});yield Buffer.from("abc");}});
    await waiting;context.mock.timers.tick(4000);release();
    assert.equal((await upload).attachment.sizeBytes,6);
  } finally {context.mock.timers.reset();client.closeActiveConnections();await host.stop();await rm(root,{recursive:true,force:true});}
});
