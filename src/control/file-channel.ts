import type { Socket } from "node:net";
import { FileReceiver, FileSendWindow, sendFile } from "./file-transfer.js";
import { encodeFileRecord, fileChunkHeader } from "./file-framing.js";
import {
  FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_IDLE_MS, FILE_TRANSFER_WINDOW_BYTES,
  parseFileTransferFrame, ProtocolValidationError,
  type FileTransferFrame, type FileTransferSummary,
} from "./protocol.js";

/** The byte phase is idle only when neither real traffic nor peer progress advances. */
export class FileIdleTimer {
  private timer?: NodeJS.Timeout;
  constructor(private readonly expired: () => void) {}
  activity(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.expired, FILE_TRANSFER_IDLE_MS);
    this.timer.unref();
  }
  dispose(): void { clearTimeout(this.timer); }
}

/** A relay observes liveness, not payload or credit. It never assembles/decodes file data. */
export class FileRelayActivity {
  private readonly idle: FileIdleTimer;
  private direction?: "upload" | "download";
  private receivedWireBytes = 0;
  private consumedBytes = 0;
  private inTransitBytes = 0;
  private awaitingResult = false;
  private terminal = false;
  private readonly onClose = () => this.dispose();
  constructor(private readonly socket: Socket, private readonly requestId: string, private readonly hostEpoch: string) {
    this.idle = new FileIdleTimer(() => socket.destroy());
    socket.once("close", this.onClose);
  }
  incomingBytes(): void {
    if (this.direction === "upload" && !this.awaitingResult && !this.terminal) this.idle.activity();
  }
  record(raw: unknown): void {
    if (this.terminal || !raw || typeof raw !== "object") return;
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === "response") { this.terminal = true; this.idle.activity(); return; }
    if (kind === "file_complete") { this.awaitingResult = true; this.idle.dispose(); return; }
    if (this.awaitingResult) return;
    if (kind === "file_ready") {
      const frame = parseFileTransferFrame(raw, this.requestId, this.hostEpoch);
      if (frame.kind === "file_ready") this.direction = frame.direction;
      this.idle.activity();
    } else if (kind === "file_chunk") this.idle.activity();
    else if (kind === "file_activity") {
      const frame=parseFileTransferFrame(raw,this.requestId,this.hostEpoch);
      if(frame.kind==="file_activity"&&frame.inTransitBytes>this.inTransitBytes){this.inTransitBytes=frame.inTransitBytes;this.idle.activity();}
    }
    else if (kind === "file_progress") {
      const frame = parseFileTransferFrame(raw, this.requestId, this.hostEpoch);
      if (frame.kind !== "file_progress") return;
      if (frame.receivedWireBytes < this.receivedWireBytes || frame.consumedBytes < this.consumedBytes) throw new ProtocolValidationError("invalid_response", "File progress moved backwards");
      if (frame.receivedWireBytes > this.receivedWireBytes || frame.consumedBytes > this.consumedBytes) this.idle.activity();
      this.receivedWireBytes = frame.receivedWireBytes;
      this.consumedBytes = frame.consumedBytes;
    }
  }
  end(): void {
    if (!this.terminal) this.socket.destroy();
    else if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
  }
  dispose(): void { this.idle.dispose(); this.socket.removeListener("close", this.onClose); }
}

/** A dedicated negotiated file connection. Authentication and terminal business responses stay outside. */
export class FileChannel {
  readonly abort = new AbortController();
  private window = new FileSendWindow(this.abort.signal);
  private chunkBytes = FILE_TRANSFER_CHUNK_BYTES;
  private readonly idle: FileIdleTimer;
  private receiver?: FileReceiver;
  private receivedWireBytes = 0;
  private consumedBytes = 0;
  private inTransitBytes = 0;
  private reportedWireBytes = 0;
  private reportedConsumedBytes = 0;
  private progressWrite?: Promise<void>;
  private progressScheduled = false;
  private complete = false;
  private disposed = false;
  private readonly onClose = () => this.cancel(new Error("File connection closed"));
  constructor(private readonly socket: Socket, readonly requestId: string, readonly hostEpoch: string, private readonly inputCode: "invalid_request" | "invalid_response" = "invalid_response") {
    this.idle = new FileIdleTimer(() => { this.cancel(new Error("File transfer was idle for too long")); socket.destroy(); });
    socket.once("close", this.onClose);
    if (socket.destroyed || socket.writableEnded) this.cancel(new Error("File connection closed"));
    else this.activity();
  }
  configure(ready: Extract<FileTransferFrame, { kind: "file_ready" }>): void {
    this.chunkBytes = ready.maxChunkBytes;
    this.window = new FileSendWindow(this.abort.signal, ready.windowBytes);
  }
  observeWire(bytes: number, partial?: string): void {
    this.receivedWireBytes += bytes;
    const header=partial===undefined?undefined:fileChunkHeader(partial);
    if (this.receiver && !this.complete && header?.requestId===this.requestId && header.hostEpoch===this.hostEpoch) {
      this.activity();
      // Report actual partial-line reception, coalescing behind current parsing
      // so terminal records do not start unnecessary reverse writes.
      if (!this.progressScheduled) {
        this.progressScheduled = true;
        setImmediate(() => {
          this.progressScheduled = false;
          if (!this.complete && !this.abort.signal.aborted) void this.reportProgress().catch((error) => { this.cancel(error); this.socket.destroy(); });
        });
      }
    }
  }
  private reportProgress(): Promise<void> {
    if (this.progressWrite) return this.progressWrite;
    this.progressWrite = (async () => {
      while (!this.complete && (this.reportedWireBytes < this.receivedWireBytes || this.reportedConsumedBytes < this.consumedBytes)) {
        const receivedWireBytes = this.receivedWireBytes, consumedBytes = this.consumedBytes;
        await this.write({ kind: "file_progress", receivedWireBytes, consumedBytes });
        this.reportedWireBytes = receivedWireBytes;
        this.reportedConsumedBytes = consumedBytes;
      }
    })().finally(() => { this.progressWrite = undefined; });
    return this.progressWrite;
  }
  activity(): void {
    if (this.abort.signal.aborted || this.complete || this.disposed) return;
    this.idle.activity();
  }
  cancel(error: unknown): void { this.abort.abort(error); this.dispose(); }
  dispose(): void { this.disposed=true; this.idle.dispose(); this.socket.removeListener("close", this.onClose); }
  async write(frame: Omit<FileTransferFrame, "version" | "requestId" | "hostEpoch"> | Record<string, unknown>): Promise<void> {
    this.abort.signal.throwIfAborted();
    const line = encodeFileRecord({ ...frame, version: 2, requestId: this.requestId, hostEpoch: this.hostEpoch })+"\n";
    await writeTransferBytes(this.socket, line, this.abort.signal);
    // Progress records may repeat; only data writes count as outgoing activity.
    if (frame.kind !== "file_progress" && frame.kind !== "file_activity") this.activity();
  }
  ready(direction: "upload" | "download", metadata?: Record<string, unknown>): Promise<void> {
    return this.write({ kind: "file_ready", direction, maxChunkBytes: FILE_TRANSFER_CHUNK_BYTES, windowBytes: FILE_TRANSFER_WINDOW_BYTES, ...(metadata === undefined ? {} : { metadata }) });
  }
  receive(maximumBytes: number, sink: (bytes: Buffer) => void | Promise<void>): void {
    this.receiver = new FileReceiver({ maximumBytes, chunkBytes: this.chunkBytes, sink, errorCode: this.inputCode,
      progress: async (consumedBytes) => {
        this.activity();
        this.consumedBytes = consumedBytes;
        await this.reportProgress();
      },
    });
  }
  async consume(raw: unknown): Promise<FileTransferSummary | undefined> {
    const frame = parseFileTransferFrame(raw, this.requestId, this.hostEpoch, this.inputCode);
    if (frame.kind === "file_activity") {
      if(frame.inTransitBytes>this.inTransitBytes){this.inTransitBytes=frame.inTransitBytes;this.activity();}
      return;
    }
    if (frame.kind === "file_progress") {
      if (this.receiver) throw new ProtocolValidationError(this.inputCode, "Unexpected sender progress");
      if (this.window.progress(frame)) this.activity();
      return;
    }
    if (!this.receiver) throw new ProtocolValidationError("invalid_request", "Unexpected file input");
    if (frame.kind === "file_chunk") {
      this.activity();
      await this.receiver.chunk(frame.index, frame.data);
      return;
    }
    if (frame.kind !== "file_complete") throw new ProtocolValidationError("invalid_request", "Unexpected file input");
    const result = this.receiver.finish(frame);
    this.complete = true;
    this.dispose();
    return result;
  }
  async send(options: Omit<Parameters<typeof sendFile>[0], "onChunk" | "signal" | "chunkBytes">): Promise<FileTransferSummary> {
    const result = await sendFile({ ...options, chunkBytes: this.chunkBytes, signal: this.abort.signal,
      onChunk: async (bytes, index) => {
        await this.window.reserve(bytes.byteLength);
        await this.write({ kind: "file_chunk", index, data: bytes.toString("base64") });
      },
    });
    await this.window.drained();
    return result;
  }
}

/** Cancellation-aware socket write shared by finite files and logical records. */
export function writeTransferBytes(socket: Socket, bytes: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener("abort",abort);
    const abort=()=>{cleanup();reject(signal.reason);};
    signal.addEventListener("abort",abort,{once:true});
    socket.write(bytes,error=>{cleanup();error?reject(error):resolve();});
  });
}
