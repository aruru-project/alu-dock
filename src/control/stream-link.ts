// One authenticated connection carrying many Protocol V2 streams.
//
// A stream is an ordinary Protocol V2 connection (hello, one request, its
// response or follow) tunnelled as `data` records. The accepting side hands
// each stream to the same connection handler that serves a raw socket, so
// request semantics, forwarding and file framing are unchanged.
//
// Two links use this framing: the client link (`stream_*`, `ping`, `pong`,
// negotiated by `transport.multiplex.v1`) and the Main↔SubHost machine link,
// which keeps its `machine_*` record names so already-deployed SubHosts and
// Mains keep talking.
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

import { MAX_CONTROL_LINE_BYTES, FILE_TRANSFER_CAPABILITY, INSTANCE_RECORDS_CAPABILITY } from "./protocol.js";
import { ByteTransitRelay, encodeRoutedRecord, linkFileChunkHeader } from "./file-framing.js";
import { encodeJsonLine } from "./json-lines.js";

/** A link record wraps one Protocol V2 line, so it may be up to twice that line. */
export const MAX_LINK_LINE_BYTES = 2 * MAX_CONTROL_LINE_BYTES;
export const MAX_LINK_STREAMS = 256;
export const MAX_LINK_QUEUED_INPUT_BYTES = 8 * MAX_LINK_LINE_BYTES;
const MAX_LINK_STREAM_ID_CHARS = 128;
const MAX_LINK_RESET_REASON_CHARS = 256;

export interface LinkDialect {
  readonly open: string;
  readonly data: string;
  readonly close: string;
  readonly reset: string;
  readonly ping: string;
  readonly pong: string;
}

export const CLIENT_LINK_DIALECT: LinkDialect = { open: "stream_open", data: "stream_data", close: "stream_close", reset: "stream_reset", ping: "ping", pong: "pong" };
export const MACHINE_LINK_DIALECT: LinkDialect = { open: "machine_stream_open", data: "machine_stream_data", close: "machine_stream_close", reset: "machine_stream_reset", ping: "machine_ping", pong: "machine_pong" };

export type LinkRecord =
  | { kind: "open"; streamId: string }
  | { kind: "data"; streamId: string; data: string }
  | { kind: "close"; streamId: string }
  | { kind: "reset"; streamId: string; reason: string }
  | { kind: "ping" }
  | { kind: "pong" };

/** Returns undefined when the record kind is not a link record of this dialect. */
export function parseLinkRecord(dialect: LinkDialect, value: Record<string, unknown>): LinkRecord | undefined {
  const kind = value.kind;
  if (typeof kind !== "string") throw new Error("Link record kind is invalid");
  const streamId = (): string => wireText(value.streamId, "stream ID", MAX_LINK_STREAM_ID_CHARS);
  if (kind === dialect.open) { exact(value, ["kind", "streamId"]); return { kind: "open", streamId: streamId() }; }
  if (kind === dialect.close) { exact(value, ["kind", "streamId"]); return { kind: "close", streamId: streamId() }; }
  if (kind === dialect.reset) { exact(value, ["kind", "streamId", "reason"]); return { kind: "reset", streamId: streamId(), reason: wireText(value.reason, "stream reset reason", MAX_LINK_RESET_REASON_CHARS) }; }
  if (kind === dialect.data) { exact(value, ["kind", "streamId", "data"]); return { kind: "data", streamId: streamId(), data: wirePayload(value.data, "stream data", MAX_CONTROL_LINE_BYTES) }; }
  if (kind === dialect.ping) { exact(value, ["kind"]); return { kind: "ping" }; }
  if (kind === dialect.pong) { exact(value, ["kind"]); return { kind: "pong" }; }
  return undefined;
}

export function encodeLinkRecord(dialect: LinkDialect, record: LinkRecord): Record<string, unknown> {
  switch (record.kind) {
    case "open": return { kind: dialect.open, streamId: record.streamId };
    case "data": return { kind: dialect.data, streamId: record.streamId, data: record.data };
    case "close": return { kind: dialect.close, streamId: record.streamId };
    case "reset": return { kind: dialect.reset, streamId: record.streamId, reason: record.reason };
    case "ping": return { kind: dialect.ping };
    case "pong": return { kind: dialect.pong };
  }
}

function wireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function wirePayload(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) throw new Error(`${label} is invalid`);
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Link record has unexpected fields");
}

/** A reset reason the peer's parser accepts: no control characters, bounded, never empty. */
export function diagnosticReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  const chosen = text.length > 0 ? text : fallback;
  return chosen.length > MAX_LINK_RESET_REASON_CHARS ? `${chosen.slice(0, MAX_LINK_RESET_REASON_CHARS - 1)}…` : chosen;
}

/** The accepting side's view of one stream: a socket for the protocol handler. */
export class VirtualProtocolSocket extends Duplex {
  private closedByRemote = false;
  private closeSent = false;
  private failureReason: string | undefined;
  private readableDrain: (() => void) | undefined;
  constructor(private readonly sendData: (data: Buffer) => Promise<void>, private readonly sendClose: (reason?: string) => void) {
    super({ readableHighWaterMark: MAX_CONTROL_LINE_BYTES, writableHighWaterMark: MAX_CONTROL_LINE_BYTES });
    this.once("close", () => {
      this.resolveReadableDrain();
      if (!this.closedByRemote) this.notifyClose(this.failureReason ?? (this.writableFinished ? undefined : "Protocol stream closed"));
    });
  }
  _read(): void { this.resolveReadableDrain(); }
  _write(chunk: Buffer | string | Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.sendData(Buffer.from(chunk)).then(() => callback(), (error) => {
      this.failureReason = diagnosticReason(error, "Protocol stream output failed");
      callback(error as Error);
    });
  }
  /** Ending the writable side is a full close for the peer, so it is one here too: the
   * handler's `close` cleanup must run even though the peer will not answer with its own close. */
  _final(callback: (error?: Error | null) => void): void { this.notifyClose(); callback(); this.localReset(); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (error) this.failureReason = diagnosticReason(error, "Protocol stream failed");
    this.resolveReadableDrain();
    callback(error);
  }
  receive(data: Buffer): Promise<void> {
    if (this.destroyed || this.push(data)) return Promise.resolve();
    return new Promise((resolve) => { this.readableDrain = resolve; });
  }
  remoteClose(): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) { this.push(null); this.destroy(); } }
  remoteReset(error: Error): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) this.destroy(error); }
  localReset(): void { this.closedByRemote = true; this.resolveReadableDrain(); if (!this.destroyed) this.destroy(); }
  private notifyClose(reason?: string): void { if (this.closeSent) return; this.closeSent = true; this.sendClose(reason); }
  private resolveReadableDrain(): void { const resume = this.readableDrain; this.readableDrain = undefined; resume?.(); }
}

interface AcceptedStream {
  streamId: string;
  socket: VirtualProtocolSocket;
  acceptingInput: boolean;
  inputTail: Promise<void>;
  queuedInputBytes: number;
  fileMode?: boolean;
  recordsMode?: boolean;
  requestId?: string;
  fileTransit?: ByteTransitRelay;
}

/**
 * Accepts streams opened by the peer and serves each through the protocol
 * handler. Byte-stream requests get the same in-transit activity mapping a
 * raw socket gets from partial records, so slow large chunks stay live.
 */
export class StreamAcceptor {
  private readonly streams = new Map<string, AcceptedStream>();
  constructor(private readonly options: {
    hostEpoch: string;
    write: (record: LinkRecord) => Promise<void>;
    accept: (socket: Socket) => void;
    linkOpen: () => boolean;
    failureLabel: string;
  }) {}

  get size(): number { return this.streams.size; }
  /** Test seam: the stream currently serving a byte-stream request. */
  streamIdForRequest(requestId: string): string | undefined {
    for (const stream of this.streams.values()) if (stream.requestId === requestId) return stream.streamId;
    return undefined;
  }

  /** Feed the link's partial record so a stream's byte activity is observed before the record completes. */
  observePartial(dialect: LinkDialect, partialRecord: string, recordSequence: number): boolean {
    const partial = linkFileChunkHeader(dialect.data, partialRecord) ?? linkFileChunkHeader(dialect.data, partialRecord, true);
    const stream = partial && this.streams.get(partial.streamId);
    if (!partial || !stream?.fileTransit || partial.requestId !== stream.requestId || partial.hostEpoch !== this.options.hostEpoch) return false;
    stream.fileTransit.observe(recordSequence, Buffer.byteLength(partialRecord));
    return true;
  }

  async handle(record: Exclude<LinkRecord, { kind: "ping" | "pong" }>): Promise<void> {
    if (record.kind === "open") {
      if (this.streams.size >= MAX_LINK_STREAMS || this.streams.has(record.streamId)) {
        await this.options.write({ kind: "reset", streamId: record.streamId, reason: "Stream could not be opened" });
        return;
      }
      let stream!: AcceptedStream;
      const socket = new VirtualProtocolSocket(
        async (data) => {
          if (stream.fileTransit) { const raw = JSON.parse(data.toString("utf8")); await stream.fileTransit.outputs[0].write(stream.fileTransit.map(1, raw)); }
          else await this.options.write({ kind: "data", streamId: record.streamId, data: data.toString("utf8").replace(/\n$/u, "") });
        },
        (reason) => {
          if (this.streams.get(record.streamId) !== stream) return;
          stream.fileTransit?.close();
          this.streams.delete(record.streamId);
          if (this.options.linkOpen()) void this.options.write(reason
            ? { kind: "reset", streamId: record.streamId, reason: diagnosticReason(reason, `${this.options.failureLabel} stream failed`) }
            : { kind: "close", streamId: record.streamId }).catch(() => {});
        },
      );
      stream = { streamId: record.streamId, socket, acceptingInput: true, inputTail: Promise.resolve(), queuedInputBytes: 0 };
      this.streams.set(record.streamId, stream);
      try { this.options.accept(socket as unknown as Socket); }
      catch (error) { this.reset(stream, diagnosticReason(error, `${this.options.failureLabel} stream was rejected`)); }
      return;
    }
    if (record.kind === "data") {
      const stream = this.streams.get(record.streamId);
      if (stream?.acceptingInput) this.enqueue(stream, Buffer.byteLength(record.data, "utf8"), async () => {
        const raw = JSON.parse(record.data) as Record<string, unknown>;
        if (raw.kind === "hello") {
          stream.fileMode = Array.isArray(raw.requiredCapabilities) && raw.requiredCapabilities.includes(FILE_TRANSFER_CAPABILITY);
          stream.recordsMode = Array.isArray(raw.requiredCapabilities) && raw.requiredCapabilities.includes(INSTANCE_RECORDS_CAPABILITY);
        }
        if ((stream.fileMode || stream.recordsMode) && raw.kind === "request" && typeof raw.requestId === "string") {
          stream.requestId = raw.requestId;
          const identity = { version: 2 as const, requestId: raw.requestId, hostEpoch: this.options.hostEpoch };
          stream.fileTransit = new ByteTransitRelay(
            [identity, identity],
            [async (frame) => { await this.options.write({ kind: "data", streamId: stream.streamId, data: encodeRoutedRecord(frame) }); }, (frame) => stream.socket.receive(Buffer.from(encodeRoutedRecord(frame) + "\n"))],
            (error) => this.reset(stream, diagnosticReason(error, "Byte activity failed")),
            stream.recordsMode ? "instance_record" : "file",
          );
        }
        if (stream.fileTransit) await stream.fileTransit.outputs[1].write(stream.fileTransit.map(0, raw));
        else await stream.socket.receive(Buffer.from(`${record.data}\n`, "utf8"));
      });
      return;
    }
    if (record.kind === "close") {
      const stream = this.streams.get(record.streamId);
      if (!stream) return;
      stream.acceptingInput = false;
      this.enqueue(stream, 0, async () => {
        stream.fileTransit?.close();
        if (this.streams.get(stream.streamId) === stream) this.streams.delete(stream.streamId);
        stream.socket.remoteClose();
      });
      return;
    }
    const stream = this.streams.get(record.streamId);
    if (!stream) return;
    stream.acceptingInput = false;
    stream.fileTransit?.close();
    this.streams.delete(record.streamId);
    stream.socket.remoteReset(new Error(record.reason));
  }

  /** The link ended: every stream ends with it, without link writes. */
  closeAll(): void {
    for (const stream of this.streams.values()) { stream.fileTransit?.close(); stream.socket.remoteClose(); }
    this.streams.clear();
  }

  private enqueue(stream: AcceptedStream, bytes: number, work: () => Promise<void>): void {
    if (stream.queuedInputBytes + bytes > MAX_LINK_QUEUED_INPUT_BYTES) {
      this.reset(stream, "Stream input queue exceeded its bound");
      return;
    }
    stream.queuedInputBytes += bytes;
    const queued = stream.inputTail.then(async () => {
      if (this.streams.get(stream.streamId) !== stream) return;
      await work();
    }).finally(() => { stream.queuedInputBytes -= bytes; });
    stream.inputTail = queued.catch((error) => {
      this.reset(stream, diagnosticReason(error, `${this.options.failureLabel} stream input failed`));
    });
  }

  private reset(stream: AcceptedStream, reason: string): void {
    if (this.streams.get(stream.streamId) !== stream) return;
    stream.acceptingInput = false;
    stream.fileTransit?.close();
    this.streams.delete(stream.streamId);
    stream.socket.localReset();
    if (this.options.linkOpen()) void this.options.write({ kind: "reset", streamId: stream.streamId, reason: diagnosticReason(reason, `${this.options.failureLabel} stream failed`) }).catch(() => {});
  }
}

// ── Link output: lanes and bounds ────────────────────────────────────────
//
// Urgent (ping/pong/reset) and control records go ahead of stream data; stream
// data is served round-robin per stream so one bulk producer cannot starve the
// others. Each lane has a byte bound; a stream lane that overflows is reset,
// never the whole link.

export type LinkOutputLane =
  | { kind: "urgent" }
  | { kind: "control" }
  | { kind: "bulk" }
  | { kind: "stream"; streamId: string };

interface PendingLinkWrite {
  bytes: Buffer;
  lane: LinkOutputLane;
  resolve: () => void;
  reject: (error: Error) => void;
}

const MAX_LINK_STREAM_OUTPUT_BYTES = 2 * MAX_LINK_LINE_BYTES;
const MAX_LINK_BULK_OUTPUT_BYTES = 2 * MAX_LINK_LINE_BYTES;
const MAX_LINK_NON_PROTECTED_OUTPUT_BYTES = 5 * MAX_LINK_LINE_BYTES;
const MAX_LINK_CONTROL_OUTPUT_BYTES = 2 * MAX_LINK_LINE_BYTES;
const MAX_LINK_URGENT_OUTPUT_BYTES = MAX_LINK_LINE_BYTES;
const MAX_LINK_TOTAL_OUTPUT_BYTES = 8 * MAX_LINK_LINE_BYTES;

export interface LinkWriterRecords<R> {
  laneOf: (record: R) => LinkOutputLane;
  resetOf: (record: R) => { streamId: string; reason: string } | undefined;
  makeReset: (streamId: string, reason: string) => R;
  /** Wire shape of a record; identity when the record already is its wire shape. */
  encode?: (record: R) => unknown;
}

export class LinkWriter<R> {
  private readonly urgent: PendingLinkWrite[] = [];
  private readonly capacityWaiters: PendingLinkWrite[] = [];
  private readonly control: PendingLinkWrite[] = [];
  private readonly normal = new Map<string, PendingLinkWrite[]>();
  private readonly normalOrder: string[] = [];
  private readonly streamBytes = new Map<string, number>();
  private readonly failedStreams = new Set<string>();
  private readonly resetWrites = new Map<string, Promise<void>>();
  private urgentBytes = 0;
  private controlBytes = 0;
  private bulkBytes = 0;
  private nonProtectedBytes = 0;
  private totalBytes = 0;
  private draining = false;
  private failed: Error | undefined;

  constructor(private readonly socket: Socket, private readonly records: LinkWriterRecords<R>) {
    socket.once("close", () => {
      this.failed ??= new Error("Link closed");
      this.rejectQueued(this.failed);
    });
  }

  write(record: R): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    const reset = this.records.resetOf(record);
    if (reset) {
      const existingReset = this.resetWrites.get(reset.streamId);
      if (existingReset) return existingReset;
      this.failStreamLane(reset.streamId, new Error(reset.reason));
    }
    const bytes = Buffer.from(encodeJsonLine(this.records.encode ? this.records.encode(record) : record), "utf8");
    if (bytes.byteLength > MAX_LINK_LINE_BYTES) return Promise.reject(new Error("Link record exceeds its line bound"));
    const lane = this.records.laneOf(record);
    // Each routed producer awaits its write. Keep at most one capacity waiter per
    // stream; normal cross-stream congestion must not reset healthy transfers.
    if (lane.kind === "stream" && !this.failedStreams.has(lane.streamId)
      && (this.capacityWaiters.length > 0 || this.overflow(lane, bytes.byteLength))) {
      if (this.capacityWaiters.some((item) => item.lane.kind === "stream" && item.lane.streamId === lane.streamId)
        || (this.streamBytes.get(lane.streamId) ?? 0) + bytes.byteLength > MAX_LINK_STREAM_OUTPUT_BYTES
        || this.capacityWaiters.length >= MAX_LINK_STREAMS) {
        const error = new Error("Stream producer exceeded its bound");
        this.failStreamLane(lane.streamId, error);
        void this.write(this.records.makeReset(lane.streamId, "Stream producer exceeded its bound")).catch(() => {});
        return Promise.reject(error);
      }
      return new Promise<void>((resolve, reject) => {
        this.capacityWaiters.push({ bytes, lane, resolve, reject });
        this.admitCapacityWaiters();
        void this.drain();
      });
    }
    const overflow = this.overflow(lane, bytes.byteLength);
    if (overflow) {
      if (lane.kind === "stream") {
        this.failStreamLane(lane.streamId, overflow);
        void this.write(this.records.makeReset(lane.streamId, "Stream output queue exceeded its bound")).catch(() => {});
      }
      return Promise.reject(overflow);
    }
    const write = new Promise<void>((resolve, reject) => {
      const pending = { bytes, lane, resolve, reject };
      this.reserve(pending);
      this.enqueue(pending);
      void this.drain();
    });
    if (reset) {
      this.resetWrites.set(reset.streamId, write);
      const cleanup = (): void => {
        if (this.resetWrites.get(reset.streamId) === write) this.resetWrites.delete(reset.streamId);
        this.failedStreams.delete(reset.streamId);
      };
      void write.then(cleanup, cleanup);
    }
    return write;
  }

  cancelStream(streamId: string, error: Error): void { this.failStreamLane(streamId, error); this.failedStreams.delete(streamId); this.admitCapacityWaiters(); }

  private admitCapacityWaiters(): void {
    if (this.failed) return;
    while (this.capacityWaiters.length) {
      const pending = this.capacityWaiters[0]!;
      if (this.overflow(pending.lane, pending.bytes.byteLength)) return;
      this.capacityWaiters.shift();
      this.reserve(pending);
      this.enqueue(pending);
    }
  }

  private overflow(lane: LinkOutputLane, bytes: number): Error | undefined {
    if (lane.kind === "stream" && this.failedStreams.has(lane.streamId)) return new Error("Stream output queue exceeded its bound");
    if (this.totalBytes + bytes > MAX_LINK_TOTAL_OUTPUT_BYTES) return new Error("Link aggregate output queue exceeded its bound");
    if (lane.kind === "urgent" && this.urgentBytes + bytes > MAX_LINK_URGENT_OUTPUT_BYTES) return new Error("Link urgent output queue exceeded its bound");
    if (lane.kind === "control" && this.controlBytes + bytes > MAX_LINK_CONTROL_OUTPUT_BYTES) return new Error("Link control output queue exceeded its bound");
    if (lane.kind === "bulk" && (this.bulkBytes + bytes > MAX_LINK_BULK_OUTPUT_BYTES || this.nonProtectedBytes + bytes > MAX_LINK_NON_PROTECTED_OUTPUT_BYTES)) return new Error("Link bulk output queue exceeded its bound");
    if (lane.kind === "stream" && ((this.streamBytes.get(lane.streamId) ?? 0) + bytes > MAX_LINK_STREAM_OUTPUT_BYTES || this.nonProtectedBytes + bytes > MAX_LINK_NON_PROTECTED_OUTPUT_BYTES)) return new Error("Stream output queue exceeded its bound");
    return undefined;
  }

  private reserve(pending: PendingLinkWrite): void {
    const bytes = pending.bytes.byteLength;
    this.totalBytes += bytes;
    if (pending.lane.kind === "urgent") this.urgentBytes += bytes;
    else if (pending.lane.kind === "control") this.controlBytes += bytes;
    else {
      this.nonProtectedBytes += bytes;
      if (pending.lane.kind === "bulk") this.bulkBytes += bytes;
      else this.streamBytes.set(pending.lane.streamId, (this.streamBytes.get(pending.lane.streamId) ?? 0) + bytes);
    }
  }

  private release(pending: PendingLinkWrite): void {
    const bytes = pending.bytes.byteLength;
    this.totalBytes -= bytes;
    if (pending.lane.kind === "urgent") this.urgentBytes -= bytes;
    else if (pending.lane.kind === "control") this.controlBytes -= bytes;
    else {
      this.nonProtectedBytes -= bytes;
      if (pending.lane.kind === "bulk") this.bulkBytes -= bytes;
      else {
        const remaining = (this.streamBytes.get(pending.lane.streamId) ?? bytes) - bytes;
        if (remaining === 0) this.streamBytes.delete(pending.lane.streamId);
        else this.streamBytes.set(pending.lane.streamId, remaining);
      }
    }
    this.admitCapacityWaiters();
  }

  private enqueue(pending: PendingLinkWrite): void {
    if (pending.lane.kind === "urgent") { this.urgent.push(pending); return; }
    if (pending.lane.kind === "control") { this.control.push(pending); return; }
    const key = pending.lane.kind === "bulk" ? "bulk" : `stream:${pending.lane.streamId}`;
    const queue = this.normal.get(key);
    if (queue) queue.push(pending);
    else { this.normal.set(key, [pending]); this.normalOrder.push(key); }
  }

  private take(): PendingLinkWrite | undefined {
    const protectedWrite = this.urgent.shift() ?? this.control.shift();
    if (protectedWrite) return protectedWrite;
    const key = this.normalOrder.shift();
    if (!key) return undefined;
    const queue = this.normal.get(key) as PendingLinkWrite[];
    const pending = queue.shift() as PendingLinkWrite;
    if (queue.length === 0) this.normal.delete(key);
    else this.normalOrder.push(key);
    return pending;
  }

  private failStreamLane(streamId: string, error: Error): void {
    this.failedStreams.add(streamId);
    for (let index = this.capacityWaiters.length - 1; index >= 0; index--) {
      const waiter = this.capacityWaiters[index]!;
      if (waiter.lane.kind === "stream" && waiter.lane.streamId === streamId) { this.capacityWaiters.splice(index, 1); waiter.reject(error); }
    }
    const key = `stream:${streamId}`;
    const queue = this.normal.get(key);
    if (!queue) return;
    this.normal.delete(key);
    const orderIndex = this.normalOrder.indexOf(key);
    if (orderIndex >= 0) this.normalOrder.splice(orderIndex, 1);
    for (const pending of queue) { this.release(pending); pending.reject(error); }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.failed) {
        const pending = this.take();
        if (!pending) return;
        try {
          await writeLinkBytes(this.socket, pending.bytes);
          pending.resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.failed = failure;
          pending.reject(failure);
          this.rejectQueued(failure);
        } finally {
          this.release(pending);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private rejectQueued(error: Error): void {
    for (const waiter of this.capacityWaiters.splice(0)) waiter.reject(error);
    const pending = [...this.urgent.splice(0), ...this.control.splice(0), ...[...this.normal.values()].flatMap((queue) => queue.splice(0))];
    this.normal.clear();
    this.normalOrder.splice(0);
    for (const item of pending) { this.release(item); item.reject(error); }
  }
}

async function writeLinkBytes(socket: Socket, bytes: Buffer): Promise<void> {
  if (socket.destroyed || socket.writableEnded) throw new Error("Link is closed");
  if (socket.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { socket.off("drain", onDrain); socket.off("close", onClose); socket.off("error", onError); };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error("Link closed during backpressure")); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    socket.once("drain", onDrain); socket.once("close", onClose); socket.once("error", onError);
  });
}

/** Lane assignment for a link that only carries stream records (the client link). */
export function linkRecordLane(record: LinkRecord): LinkOutputLane {
  if (record.kind === "ping" || record.kind === "pong" || record.kind === "reset") return { kind: "urgent" };
  if (record.kind === "data" || record.kind === "close") return { kind: "stream", streamId: record.streamId };
  return { kind: "control" };
}

/** A client that stops sending anything (its pings included) for this long has gone; clients ping well within it. */
export const CLIENT_LINK_IDLE_TIMEOUT_MS = 60_000;

/**
 * The Host side of a client link: one hello negotiated `transport.multiplex.v1`,
 * every later record is a link record. The client pings; the Host answers and
 * drops a silent link. Streams are served by the ordinary connection handler.
 */
export class ClientLink {
  private readonly writer: LinkWriter<LinkRecord>;
  private readonly streams: StreamAcceptor;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly socket: Socket, options: { hostEpoch: string; accept: (socket: Socket) => void }) {
    this.writer = new LinkWriter<LinkRecord>(socket, {
      laneOf: linkRecordLane,
      resetOf: (record) => record.kind === "reset" ? { streamId: record.streamId, reason: record.reason } : undefined,
      makeReset: (streamId, reason) => ({ kind: "reset", streamId, reason }),
      encode: (record) => encodeLinkRecord(CLIENT_LINK_DIALECT, record),
    });
    this.streams = new StreamAcceptor({
      hostEpoch: options.hostEpoch,
      write: (record) => this.writer.write(record),
      accept: options.accept,
      linkOpen: () => !this.closed && !socket.destroyed,
      failureLabel: "Client",
    });
    socket.once("close", () => this.dispose());
    this.armIdleTimer();
  }

  get streamCount(): number { return this.streams.size; }

  async consume(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Link record must be an object");
    const record = parseLinkRecord(CLIENT_LINK_DIALECT, raw as Record<string, unknown>);
    if (!record) throw new Error("Only link records are accepted after multiplex negotiation");
    this.armIdleTimer();
    if (record.kind === "pong") return;
    if (record.kind === "ping") { await this.writer.write({ kind: "pong" }); return; }
    if (record.kind === "reset") this.writer.cancelStream(record.streamId, new Error(record.reason));
    await this.streams.handle(record);
  }

  /** Any bytes from the client keep the link alive; a file chunk in transit also keeps its stream live. */
  observeInput(partialRecord: string, recordSequence: number): void {
    this.armIdleTimer();
    this.streams.observePartial(CLIENT_LINK_DIALECT, partialRecord, recordSequence);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.streams.closeAll();
  }

  private armIdleTimer(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.socket.destroyed) this.socket.destroy(); }, CLIENT_LINK_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }
}
