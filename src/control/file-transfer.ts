import { createHash } from "node:crypto";
import {
  FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_WINDOW_BYTES,
  ProtocolValidationError, type FileTransferSummary,
} from "./protocol.js";

function invalid(message: string): never { throw new ProtocolValidationError("invalid_response", message); }

export class FileTransferSourceError extends Error {
  constructor(readonly reason: "too_large" | "changed") { super("File source changed during transfer"); }
}

async function* cancellableSource(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal!.reason); };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve(iterator.next()).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
      });
      if (next.done) { ended = true; return; }
      yield next.value;
    }
  } finally {
    if (!ended) void iterator.return?.().catch(() => {});
  }
}

/** One byte producer for disk reads and upload sources. The caller owns admission and commit. */
export async function sendFile(options: {
  source: AsyncIterable<Uint8Array>;
  maximumBytes: number;
  chunkBytes?: number;
  expected?: { sizeBytes: number; sha256?: string };
  signal?: AbortSignal;
  onChunk: (bytes: Buffer, index: number) => Promise<void>;
}): Promise<FileTransferSummary> {
  const hash = createHash("sha256");
  const chunkBytes = options.chunkBytes ?? FILE_TRANSFER_CHUNK_BYTES;
  let sizeBytes = 0, chunks = 0;
  for await (const raw of cancellableSource(options.source, options.signal)) {
    for (let offset = 0; offset < raw.byteLength; offset += chunkBytes) {
      options.signal?.throwIfAborted();
      const bytes = Buffer.from(raw.buffer, raw.byteOffset + offset, Math.min(chunkBytes, raw.byteLength - offset));
      sizeBytes += bytes.byteLength;
      if (sizeBytes > options.maximumBytes) throw new FileTransferSourceError("too_large");
      if (options.expected && sizeBytes > options.expected.sizeBytes) throw new FileTransferSourceError("changed");
      hash.update(bytes);
      await options.onChunk(bytes, chunks++);
    }
  }
  options.signal?.throwIfAborted();
  const sha256 = hash.digest("hex");
  if (options.expected && (sizeBytes !== options.expected.sizeBytes || (options.expected.sha256 !== undefined && sha256 !== options.expected.sha256))) throw new FileTransferSourceError("changed");
  return { chunks, sizeBytes, sha256 };
}

/** Serial receiver: consumption is acknowledged only after the sink has succeeded. */
export class FileReceiver {
  private readonly hash = createHash("sha256");
  private chunks = 0;
  private sizeBytes = 0;
  private complete = false;
  constructor(private readonly options: {
    maximumBytes: number;
    chunkBytes: number;
    sink: (bytes: Buffer) => void | Promise<void>;
    errorCode?: string;
    progress?: (consumedBytes: number) => Promise<void>;
  }) {}

  async chunk(index: number, data: string): Promise<void> {
    if (this.complete || index !== this.chunks) this.invalid("File chunks are out of order");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.byteLength || bytes.byteLength > this.options.chunkBytes || bytes.toString("base64") !== data) this.invalid("Invalid file chunk");
    if (this.sizeBytes + bytes.byteLength > this.options.maximumBytes) this.invalid("File exceeds the supported size");
    await this.options.sink(bytes);
    this.hash.update(bytes);
    this.sizeBytes += bytes.byteLength;
    this.chunks++;
    await this.options.progress?.(this.sizeBytes);
  }

  end(chunks: number): FileTransferSummary {
    if (this.complete || chunks !== this.chunks) this.invalid("File completion counts do not match");
    this.complete = true;
    return { chunks: this.chunks, sizeBytes: this.sizeBytes, sha256: this.hash.digest("hex") };
  }

  finish(summary: FileTransferSummary): FileTransferSummary {
    const actual = this.end(summary.chunks);
    if (summary.sizeBytes !== actual.sizeBytes || summary.sha256 !== actual.sha256) this.invalid("File completion does not match received bytes");
    return actual;
  }

  private invalid(message: string): never { throw new ProtocolValidationError(this.options.errorCode ?? "invalid_response", message); }
}

/** End-to-end byte window; forwarding never releases credit. One producer per request. */
export class FileSendWindow {
  private sent = 0;
  private consumed = 0;
  private receivedWire = 0;
  private wake?: () => void;
  constructor(private readonly signal: AbortSignal, private readonly windowBytes = FILE_TRANSFER_WINDOW_BYTES) {}

  progress(frame: {consumedBytes: number; receivedWireBytes: number}): boolean {
    if (frame.consumedBytes < this.consumed || frame.consumedBytes > this.sent || frame.receivedWireBytes < this.receivedWire) invalid("File progress is inconsistent");
    const advanced = frame.consumedBytes > this.consumed || frame.receivedWireBytes > this.receivedWire;
    this.consumed = frame.consumedBytes;
    this.receivedWire = frame.receivedWireBytes;
    this.wake?.();
    return advanced;
  }

  get pending(): boolean { return this.sent !== this.consumed; }

  async drained(): Promise<void> {
    // Reserving zero with a zero allowance waits for the last consumption ACK.
    await this.waitFor(() => this.sent === this.consumed);
  }

  private async waitFor(ready: () => boolean): Promise<void> {
    while (!ready()) {
      this.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.wake = undefined; this.signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(this.signal.reason); };
        this.wake = () => { cleanup(); resolve(); };
        this.signal.addEventListener("abort", abort, { once: true });
      });
    }
    this.signal.throwIfAborted();
  }

  async reserve(bytes: number): Promise<void> {
    if (bytes > this.windowBytes) invalid("File chunk exceeds its consumption window");
    await this.waitFor(() => this.sent + bytes - this.consumed <= this.windowBytes);
    this.sent += bytes;
  }
}
