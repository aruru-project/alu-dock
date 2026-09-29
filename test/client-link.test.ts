import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { JsonLineDecoder, encodeJsonLine } from "../src/control/json-lines.js";
import { ManagedInstance } from "../src/core/managed-instance.js";
import { DelayedAgentWorkerConnection } from "./support/delayed-agent-worker.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), "wire boundary was not reached");
}

/** One raw link connection; stream contents are decoded per stream. */
class Link {
  readonly records: Array<Record<string, any>> = [];
  readonly streams = new Map<string, Array<Record<string, any>>>();
  constructor(readonly socket: Socket) {
    const decoder = new JsonLineDecoder(2 * 1024 * 1024);
    socket.on("error", () => {});
    socket.on("data", bytes => {
      for (const line of decoder.push(bytes)) {
        const record = JSON.parse(line);
        if (record.kind === "stream_data") this.lines(record.streamId).push(JSON.parse(record.data));
        else this.records.push(record);
      }
    });
  }
  lines(streamId: string): Array<Record<string, any>> {
    let lines = this.streams.get(streamId);
    if (!lines) { lines = []; this.streams.set(streamId, lines); }
    return lines;
  }
  send(value: unknown): void { this.socket.write(encodeJsonLine(value)); }
  open(streamId: string, ...lines: unknown[]): void {
    this.send({ kind: "stream_open", streamId });
    for (const line of lines) this.send({ kind: "stream_data", streamId, data: JSON.stringify(line) });
  }
  async record(predicate: (record: Record<string, any>) => boolean): Promise<Record<string, any>> {
    await until(() => this.records.some(predicate) || this.socket.destroyed);
    const index = this.records.findIndex(predicate);
    assert.ok(index >= 0, "link closed before the expected record");
    return this.records.splice(index, 1)[0]!;
  }
  async streamLine(streamId: string, kind: string): Promise<Record<string, any>> {
    await until(() => this.lines(streamId).some(line => line.kind === kind) || this.socket.destroyed);
    const lines = this.lines(streamId);
    const index = lines.findIndex(line => line.kind === kind);
    assert.ok(index >= 0, `link closed before ${kind} on ${streamId}`);
    return lines.splice(index, 1)[0]!;
  }
}

const hello = (requestId: string, capabilities: string[]) => ({ kind: "hello", requestId, versions: [2], client: { name: "test", version: "0", clientId: "link-test" }, requiredCapabilities: capabilities });

test("one client link serves concurrent requests, a live follow, and a failed stream without ending the others", { timeout: 20_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-client-link-"));
  const runtime = new DelayedAgentWorkerConnection("client-link");
  const registry = new DockRegistry(async input => new ManagedInstance({ ...input, session: runtime }));
  const created = await registry.create({ operationId: "create", cwd: root });
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  await host.start();
  context.after(async () => { await host.stop(); await rm(root, { recursive: true, force: true }); });

  const socket = createConnection(join(root, "dock.sock"));
  await new Promise<void>(resolve => socket.once("connect", resolve));
  const link = new Link(socket);
  link.send(hello("link", ["transport.multiplex.v1"]));
  const ack = await link.record(record => record.kind === "hello_ack");
  assert.equal(ack.requestId, "link");
  assert.ok(ack.capabilities.includes("transport.multiplex.v1"));

  // Requests on separate streams answer independently; the stream hello is pipelined with its request.
  link.open("a", hello("a-hello", ["host.info"]), { kind: "request", version: 2, requestId: "a-req", type: "host.info", params: {} });
  link.open("b", hello("b-hello", ["instance.catalog"]), { kind: "request", version: 2, requestId: "b-req", type: "instance.get", params: { instanceId: created.id } });
  const [a, b] = await Promise.all([link.streamLine("a", "response"), link.streamLine("b", "response")]);
  assert.equal(a.requestId, "a-req"); assert.equal(a.ok, true);
  assert.equal(b.requestId, "b-req"); assert.equal(b.ok, true); assert.equal(b.result.instance.id, created.id);
  assert.equal((await link.streamLine("a", "hello_ack")).requestId, "a-hello");
  await link.record(record => record.kind === "stream_close" && record.streamId === "a");
  await link.record(record => record.kind === "stream_close" && record.streamId === "b");

  // A follow stays open on the same link while unary requests come and go.
  link.open("follow", hello("f-hello", ["events.follow.v2"]), { kind: "request", version: 2, requestId: "f-req", type: "instance.follow", params: { instanceId: created.id, since: { hostEpoch: registry.hostEpoch, instanceId: created.id, runtimeGeneration: 1, sequence: 0 } } });
  const initial = await link.streamLine("follow", "response");
  assert.equal(initial.ok, true);
  link.open("c", hello("c-hello", ["host.info"]), { kind: "request", version: 2, requestId: "c-req", type: "host.info", params: {} });
  assert.equal((await link.streamLine("c", "response")).ok, true);

  // A stream whose request is malformed is reset alone; ping still answers and the follow is still live.
  link.open("bad", hello("bad-hello", []));
  link.send({ kind: "stream_data", streamId: "bad", data: "{" });
  await link.record(record => record.kind === "stream_reset" && record.streamId === "bad");
  link.send({ kind: "ping" });
  await link.record(record => record.kind === "pong");
  assert.equal(link.records.some(record => record.kind === "stream_close" && record.streamId === "follow"), false);
  assert.equal(socket.destroyed, false);

  // Closing the follow from the client side ends only that stream.
  link.send({ kind: "stream_close", streamId: "follow" });
  link.open("d", hello("d-hello", ["host.info"]), { kind: "request", version: 2, requestId: "d-req", type: "host.info", params: {} });
  assert.equal((await link.streamLine("d", "response")).ok, true);

  // A hello error on a stream is answered on that stream.
  link.open("missing", hello("m-hello", ["no.such.capability"]));
  const helloError = await link.streamLine("missing", "hello_error");
  assert.equal(helloError.error.code, "capability_missing");

  // Anything but a link record after negotiation ends the link.
  link.send({ kind: "request", version: 2, requestId: "raw", type: "host.info", params: {} });
  await until(() => socket.destroyed);
});

test("a connection without the multiplex capability keeps the one-request contract", async context => {
  const root = await mkdtemp(join(tmpdir(), "alu-client-plain-"));
  const registry = new DockRegistry(async () => { throw new Error("No Worker"); });
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry });
  await host.start();
  context.after(async () => { await host.stop(); await rm(root, { recursive: true, force: true }); });
  const socket = createConnection(join(root, "dock.sock"));
  await new Promise<void>(resolve => socket.once("connect", resolve));
  const link = new Link(socket);
  link.send(hello("plain", ["host.info"]));
  await link.record(record => record.kind === "hello_ack");
  link.send({ kind: "stream_open", streamId: "x" });
  const error = await link.record(record => record.kind === "response" && record.ok === false);
  assert.equal(error.error.code, "invalid_request");
});
