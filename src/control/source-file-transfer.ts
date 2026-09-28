import type { FileHandle } from "node:fs/promises";
import { fileBytes, MAX_SOURCE_FILE_TRANSFER_BYTES, MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES } from "../core/source-file.js";
import { sendFile, FileTransferSourceError } from "./file-transfer.js";
import type { FileTransferSummary } from "./protocol.js";

export class SourceFileTransferError extends Error {
  constructor(readonly reason: "unavailable" | "too_large") {
    super(reason === "too_large" ? "Source file became too large" : "Source file could not be read");
    this.name = "SourceFileTransferError";
  }
}
export type SourceFileTransferResult = FileTransferSummary;

/** Legacy and negotiated readers use the same producer. Business owners supply their size bounds. */
export async function transferSourceFile(options: {
  handle: FileHandle;
  expectedSizeBytes?: number;
  maximumBytes?: number;
  chunkBytes?: number;
  signal?: AbortSignal;
  verify?: () => Promise<void>;
  onChunk: (chunk: Buffer, index: number) => Promise<void>;
}): Promise<SourceFileTransferResult> {
  const maximumBytes = options.maximumBytes ?? MAX_SOURCE_FILE_TRANSFER_BYTES;
  const chunkBytes = options.chunkBytes ?? MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES;
  try {
    const result = await sendFile({
      source: fileBytes(options.handle, { sizeBytes: options.expectedSizeBytes, chunkBytes, signal: options.signal }),
      maximumBytes,
      chunkBytes,
      signal: options.signal,
      ...(options.expectedSizeBytes === undefined ? {} : { expected: { sizeBytes: options.expectedSizeBytes } }),
      onChunk: options.onChunk,
    });
    await options.verify?.();
    return result;
  } catch (error) {
    if (error instanceof SourceFileTransferError) throw error;
    if (error instanceof FileTransferSourceError && error.reason === "too_large") throw new SourceFileTransferError("too_large");
    throw new SourceFileTransferError("unavailable");
  }
}
