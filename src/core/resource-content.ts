import { createHash } from "node:crypto";
import type { ResourceContentResult } from "../control/protocol.js";
import { assertUnchangedSource, inspectSourceFile, MAX_SOURCE_FILE_PATH_CHARS, openUnchangedSource, SourceFileError } from "./source-file.js";

/** Leaves room for JSON escaping within a normal Protocol V2 response. */
export const MAX_RESOURCE_CONTENT_PAGE_BYTES = 48 * 1_024;

export class ResourceContentError extends Error {
  constructor(message = "无法读取这份资源。请检查文件是否存在及读取权限后重新打开。") {
    super(message);
    this.name = "ResourceContentError";
  }
}

/** The caller resolves a currently registered resource, never an arbitrary client path. */
export async function readResourceContent(path: string, offset = 0, revision?: string): Promise<ResourceContentResult> {
  let handle: Awaited<ReturnType<typeof openUnchangedSource>> | undefined;
  try {
    const source = await inspectSourceFile(path, { maxPathChars: MAX_SOURCE_FILE_PATH_CHARS, maxBytes: Number.MAX_SAFE_INTEGER });
    const currentRevision = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.size
      || (offset > 0 && revision === undefined) || (revision !== undefined && revision !== currentRevision)) {
      throw new ResourceContentError("资源文件已变化。请重新打开查看最新正文。");
    }
    handle = await openUnchangedSource(source);
    // One byte of lookahead lets us end a page before, not inside, a UTF-8 character.
    const count = Math.min(MAX_RESOURCE_CONTENT_PAGE_BYTES + 1, source.size - offset);
    const bytes = Buffer.allocUnsafe(count);
    let read = 0;
    while (read < count) {
      const result = await handle.read(bytes, read, count - read, offset + read);
      if (result.bytesRead === 0) throw new ResourceContentError("资源文件已变化。请重新打开查看最新正文。");
      read += result.bytesRead;
    }
    let end = Math.min(read, MAX_RESOURCE_CONTENT_PAGE_BYTES);
    if (end < read) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)); }
    catch { throw new ResourceContentError("这份资源不是 UTF-8 文本。请检查文件编码后重新打开。"); }
    assertUnchangedSource(source, await handle.stat());
    const nextOffset = offset + end;
    return { text, revision: currentRevision, ...(nextOffset < source.size ? { nextOffset } : {}) };
  } catch (error) {
    if (error instanceof ResourceContentError) throw error;
    if (error instanceof SourceFileError && error.reason === "changed") {
      throw new ResourceContentError("资源文件已变化。请重新打开查看最新正文。");
    }
    throw new ResourceContentError();
  } finally { await handle?.close(); }
}
