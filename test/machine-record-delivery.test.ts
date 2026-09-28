import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockHost } from "../src/control/dock-host.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { MainMachineState, SubHostMachineState } from "../src/control/machine-state.js";
import { MachineSettingsState } from "../src/control/machine-settings-state.js";
import { MainMachineController, SubHostMachineConnection, writeMachine } from "../src/control/machine-transport.js";
import { InstanceRecordChannel, InstanceRecordInitial } from "../src/control/instance-record-delivery.js";
import { JsonLineDecoder, encodeJsonLine } from "../src/control/json-lines.js";
import { ManagedInstance, type EventCursor } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), "wire boundary was not reached");
}
class Peer {
  readonly frames: Array<Record<string, any>> = [];
  constructor(readonly socket: Socket) {
    const decoder = new JsonLineDecoder();
    socket.on("error", () => {});
    socket.on("data", bytes => { for (const line of decoder.push(bytes)) this.frames.push(JSON.parse(line)); });
  }
  send(value: unknown): void { this.socket.write(encodeJsonLine(value)); }
  async next(kind: string): Promise<Record<string, any>> {
    await until(() => this.frames.some(frame => frame.kind === kind) || this.socket.destroyed);
    const index = this.frames.findIndex(frame => frame.kind === kind);
    assert.ok(index >= 0, `closed before ${kind}`);
    return this.frames.splice(index, 1)[0]!;
  }
}

// #325 review regressions: preserve one machine link when a stream is malformed,
// and use the byte window rather than one network roundtrip per logical item.
test("routed records pipeline within their window and isolate malformed streams", { timeout: 25_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-record-route-"));
  const runtime = new DelayedAgentWorkerConnection("records-route");
  const registry = new DockRegistry(async input => new ManagedInstance({ ...input, session: runtime }));
  await registry.create({ operationId: "create", cwd: root });
  const native = registry.list()[0]!;
  const sub = new DockHost({ socketPath: join(root, "sub.sock"), registry });
  const state = new MainMachineState(join(root, "main"), "Main"); await state.initialize();
  const subState = new SubHostMachineState(join(root, "sub")); await subState.prepare(await state.createJoin(), "Sub");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const settings = new MachineSettingsState(join(root, "settings")); await settings.writeMainConnections({ enabled: true, port });
  const mainRegistry = new DockRegistry(async () => { throw new Error("No local Worker"); });
  const controller = new MainMachineController({ state, settingsState: settings, bindAddress: "127.0.0.1", mainHostEpoch: mainRegistry.hostEpoch, localSnapshots: () => [] });
  const main = new DockHost({ socketPath: join(root, "main.sock"), registry: mainRegistry, remoteInstances: controller });
  const nativeFragments: Array<{ recordIndex: number; bytes: number }> = [];
  const upstream = new SubHostMachineConnection({ state: subState, address: "127.0.0.1", port, hostEpoch: registry.hostEpoch, snapshots: () => registry.list(), acceptProtocolSocket: socket => {
    // Observe the production SubHost's emitted fragments, without changing them.
    const write = socket.write.bind(socket);
    socket.write = ((chunk: string | Buffer, ...args: any[]) => {
      const frame = JSON.parse(chunk.toString());
      if (frame.kind === "instance_record_fragment" && frame.requestId === "pipeline") nativeFragments.push({ recordIndex: frame.recordIndex, bytes: Buffer.from(frame.data, "base64").length });
      return (write as Function)(chunk, ...args);
    }) as typeof socket.write;
    sub.acceptProtocolSocket(socket);
  } });
  const client = new DockClient({ socketPath: main.socketPath });
  const peers: Peer[] = [];
  context.after(async () => { for (const peer of peers) peer.socket.destroy(); client.closeActiveConnections(); await upstream.stop(); await main.stop(); await sub.stop(); await rm(root, { recursive: true, force: true }); });
  await sub.start(); await main.start(); await upstream.start(); await until(() => upstream.connected());
  const work = (await client.list())[0]!;
  const open = async (requestId: string, since?: EventCursor, local = false): Promise<Peer> => {
    const socket = createConnection(local ? sub.socketPath : main.socketPath); await once(socket, "connect");
    const peer = new Peer(socket); peers.push(peer);
    peer.send({ kind: "hello", requestId: "hello", versions: [2], client: { name: "records-test", version: "1", clientId: "test" }, requiredCapabilities: ["core.v2", "instance.records.v1", since ? "events.follow.v2" : "instance.read.v1"] });
    await peer.next("hello_ack");
    peer.send({ kind: "request", version: 2, requestId, type: since ? "instance.follow" : "instance.read", params: { instanceId: local ? native.id : work.id, delivery: "records", ...(since ? { since } : { replay: "conversation_bootstrap" }) } });
    return peer;
  };
  const emit = (id: string, large = false) => runtime.emit({ type: "dock_conversation_frame", frame: large
    ? { type: "message.completed", data: { messageId: id, role: "assistant", content: [], stopReason: "error", error: "x".repeat(1_100_000) } }
    : { type: "message.delta", data: { messageId: id, block: "text", delta: "x" } } });
  const accepted = (id: string) => new Promise<void>(resolve => { const off = registry.get(native.id).subscribe(event => { if ((event.type === "message.delta" || event.type === "message.completed") && event.data.messageId === id) { off(); resolve(); } }); });
  const staged = accepted("tail");
  for (let i = 0; i < 20; i++) emit(`initial-${i}`);
  emit("large-1", true); emit("large-2", true); emit("tail"); await staged;

  const peer = await open("pipeline");
  // Deliberately withhold ALL public ACKs. Small initial items must pipeline;
  // a large item then exhausts that same window and bounds upstream production.
  await until(() => peer.frames.filter(frame => frame.kind === "instance_record_fragment").some(frame => frame.recordIndex === 21));
  await until(() => nativeFragments.filter(frame => frame.recordIndex === 22).length === 4);
  const fragments = peer.frames.filter(frame => frame.kind === "instance_record_fragment");
  assert.deepEqual([...new Set(fragments.filter(frame => frame.recordIndex < 21).map(frame => frame.recordIndex))], Array.from({ length: 21 }, (_, i) => i));
  const received = fragments.reduce((sum, frame) => sum + Buffer.from(frame.data, "base64").length, 0);
  assert.ok(received > 65_536 && received <= 262_144, "all unacknowledged public bytes stay inside one window");
  assert.equal(nativeFragments.filter(frame => frame.recordIndex === 22).reduce((sum, frame) => sum + frame.bytes, 0), 262_144);
  assert.ok(nativeFragments.every(frame => frame.recordIndex <= 22), "the blocked mapping hop cannot consume unlimited next records");
  const consumeInitial = async (target: Peer, requestId: string, read: boolean) => {
    const receiver = new InstanceRecordChannel(requestId, mainRegistry.hostEpoch, "receive", async frame => target.send(frame), error => target.socket.destroy(error as Error));
    const initial = new InstanceRecordInitial(read, requestId, mainRegistry.hostEpoch);
    let result;
    while (!result) { const logical = await receiver.consume(await target.next("instance_record_fragment")); if (logical !== undefined) result = initial.consume(logical); }
    receiver.quiescent(); receiver.cancel(); return result;
  };
  const initial = await consumeInitial(peer, "pipeline", true);
  assert.equal(initial.page.events.length, 23);
  await until(() => peer.socket.destroyed);

  const live = await open("live", initial.page.latest);
  await consumeInitial(live, "live", false);
  await client.status(work.id);
  const liveAccepted = accepted("live-19"); for (let i = 0; i < 20; i++) emit(`live-${i}`); await liveAccepted;
  await until(() => live.frames.filter(frame => frame.kind === "instance_record_fragment").length === 20);
  assert.deepEqual(live.frames.filter(frame => frame.kind === "instance_record_fragment").map(frame => frame.recordIndex), Array.from({ length: 20 }, (_, i) => i + 2));
  live.socket.destroy();

  const link = (upstream as unknown as { socket: TLSSocket }).socket;
  let pongs = 0; const linkDecoder = new JsonLineDecoder();
  link.on("data", bytes => { for (const line of linkDecoder.push(bytes)) if (JSON.parse(line).kind === "machine_pong") pongs++; });
  for (const [index, data] of ["{", "null"].entries()) {
    const requestId = `malformed-${index}`; const bad = await open(requestId); await bad.next("instance_record_fragment");
    const streams = (upstream as unknown as { streams: Map<string, { requestId?: string }> }).streams;
    const streamId = [...streams].find(([, stream]) => stream.requestId === requestId)![0];
    await writeMachine(link, { kind: "machine_stream_data", streamId, data });
    await until(() => bad.socket.destroyed);
    const before = pongs; await writeMachine(link, { kind: "machine_ping" }); await until(() => pongs > before);
    assert.equal((upstream as unknown as { socket: TLSSocket }).socket, link);
    assert.equal((await client.status(work.id)).id, work.id);
  }
  const beforeContent = await open("bad-cursor", { hostEpoch: registry.hostEpoch, instanceId: "another-work", runtimeGeneration: 1, sequence: 0 }, true);
  const refusal = await beforeContent.next("response");
  assert.equal(refusal.ok, false); assert.equal(refusal.error.code, "invalid_cursor");
  assert.ok(beforeContent.frames.every(frame => frame.kind !== "instance_record_fragment"));
  // Both Host input exits must preserve records framing after data starts.
  // #325 review found that Main had no local recordChannel to mark this phase.
  for (const local of [true, false]) for (const failure of ["ack", "json"]) {
    const requestId = `bad-${local ? "local" : "routed"}-${failure}`;
    const bad = await open(requestId, undefined, local); await bad.next("instance_record_fragment");
    if (failure === "ack") bad.send({ kind: "instance_record_progress", version: 2, requestId, hostEpoch: local ? registry.hostEpoch : mainRegistry.hostEpoch, receivedWireBytes: 1, consumedBytes: Number.MAX_SAFE_INTEGER });
    else bad.socket.write("{\n");
    await until(() => bad.socket.destroyed);
    assert.ok(bad.frames.every(frame => frame.kind !== "response"), `${requestId} mixed an ordinary response into records`);
    assert.equal((await client.status(work.id)).id, work.id);
  }
});
