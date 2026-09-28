import { constants as fsConstants, type Stats } from "node:fs";
import { access, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { noFollowFlag } from "../platform/private-state.js";

export const MAX_SOURCE_FILE_PATH_CHARS = 16_384;
/** Shared bound for Host source-file transfers (workspace reads and temporary deliveries). */
export const MAX_SOURCE_FILE_TRANSFER_BYTES = 104_857_600;
export const MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES = 512 * 1_024;

export interface SourceFileIdentity {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export type SourceFileFailureReason = "invalid_path" | "unavailable" | "not_regular" | "too_large" | "changed";

export class SourceFileError extends Error {
  constructor(readonly reason: SourceFileFailureReason, message: string) {
    super(message);
    this.name = "SourceFileError";
  }
}

export async function inspectSourceFile(path: string, options: { maxPathChars: number; maxBytes: number }): Promise<SourceFileIdentity> {
  if (typeof path !== "string" || path.length < 1 || path.length > options.maxPathChars || !isAbsolute(path)) {
    throw new SourceFileError("invalid_path", "Source file path must be absolute");
  }
  try {
    const canonical = await realpath(resolve(path));
    const info = await stat(canonical);
    if (!info.isFile()) throw new SourceFileError("not_regular", "Source must be a regular file");
    if (info.size > options.maxBytes) throw new SourceFileError("too_large", "Source file exceeds the supported size");
    await access(canonical, fsConstants.R_OK);
    return identity(canonical, info);
  } catch (error) {
    if (error instanceof SourceFileError) throw error;
    throw new SourceFileError("unavailable", "Source file is unavailable");
  }
}

export async function openUnchangedSource(source: SourceFileIdentity): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(source.path, fsConstants.O_RDONLY | noFollowFlag());
    assertUnchangedSource(source, await handle.stat());
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof SourceFileError) throw error;
    throw new SourceFileError("unavailable", "Source file is unavailable");
  }
}

export function assertUnchangedSource(source: SourceFileIdentity, info: Stats): void {
  if (!info.isFile() || info.dev !== source.dev || info.ino !== source.ino || info.size !== source.size
    || info.mtimeMs !== source.mtimeMs || info.ctimeMs !== source.ctimeMs) {
    throw new SourceFileError("changed", "Source file changed");
  }
}

function identity(path: string, info: Stats): SourceFileIdentity {
  return { path, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

/** Bounded disk producer, shared by continuous and legacy source readers. Does not close caller's handle. */
export async function* fileBytes(handle: FileHandle, options: { sizeBytes?: number; offset?: number; chunkBytes?: number; signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {
  let remaining = options.sizeBytes;
  let position = options.offset ?? 0;
  while (remaining === undefined || remaining > 0) {
    options.signal?.throwIfAborted();
    const bytes = Buffer.allocUnsafe(Math.min(options.chunkBytes ?? MAX_SOURCE_FILE_TRANSFER_CHUNK_BYTES, remaining ?? Infinity));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, position);
    if (bytesRead === 0) {
      if (remaining !== undefined && remaining > 0) throw new SourceFileError("changed", "File ended before its declared size");
      return;
    }
    position += bytesRead;
    if (remaining !== undefined) remaining -= bytesRead;
    yield bytes.subarray(0, bytesRead);
  }
}
