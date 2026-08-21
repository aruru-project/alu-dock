import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

import {
  MAX_SOURCE_FILE_TRANSFER_BYTES,
  MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES,
} from "../core/source-file.js";

export class SourceFileTransferError extends Error {
  constructor(readonly reason: "unavailable" | "too_large") {
    super(reason === "too_large" ? "Source file became too large" : "Source file could not be read");
    this.name = "SourceFileTransferError";
  }
}

export interface SourceFileTransferResult {
  chunks: number;
  sizeBytes: number;
  sha256: string;
}

/** Shared Host pump for source-backed reads. Callers retain their distinct wire semantics. */
export async function transferSourceFile(options: {
  handle: FileHandle;
  expectedSizeBytes?: number;
  verify?: () => Promise<void>;
  onChunk: (chunk: Buffer, index: number) => Promise<void>;
}): Promise<SourceFileTransferResult> {
  const hash = createHash("sha256");
  let chunks = 0;
  let sizeBytes = 0;
  try {
    if (options.expectedSizeBytes !== undefined) {
      while (sizeBytes < options.expectedSizeBytes) {
        const count = Math.min(MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES, options.expectedSizeBytes - sizeBytes);
        const chunk = await readExactly(options.handle, count);
        hash.update(chunk);
        await options.onChunk(chunk, chunks);
        sizeBytes += chunk.byteLength;
        chunks += 1;
      }
      await options.verify?.();
    } else {
      while (true) {
        if (sizeBytes === MAX_SOURCE_FILE_TRANSFER_BYTES) {
          const probe = Buffer.allocUnsafe(1);
          if ((await options.handle.read(probe, 0, 1, null)).bytesRead !== 0) throw new SourceFileTransferError("too_large");
          break;
        }
        const count = Math.min(MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES, MAX_SOURCE_FILE_TRANSFER_BYTES - sizeBytes);
        const buffer = Buffer.allocUnsafe(count);
        const { bytesRead } = await options.handle.read(buffer, 0, count, null);
        if (bytesRead === 0) break;
        const chunk = bytesRead === count ? buffer : buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await options.onChunk(chunk, chunks);
        sizeBytes += bytesRead;
        chunks += 1;
      }
    }
    return { chunks, sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof SourceFileTransferError) throw error;
    throw new SourceFileTransferError("unavailable");
  }
}

async function readExactly(handle: FileHandle, count: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(count);
  let offset = 0;
  while (offset < count) {
    const { bytesRead } = await handle.read(buffer, offset, count - offset, null);
    if (bytesRead === 0) throw new SourceFileTransferError("unavailable");
    offset += bytesRead;
  }
  return buffer;
}
