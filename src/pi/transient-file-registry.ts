import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";

import { AgentConversationCursorError, type AgentConversationContentPage } from "../core/agent-worker.js";
import {
  MAX_PUBLISHED_FILE_BYTES,
  MAX_PUBLISHED_FILE_CHUNK_BYTES,
  MAX_PUBLISHED_FILE_NAME_CHARS,
  MAX_TRANSIENT_FILE_HANDLES,
  PublishedFileUnavailableError,
  type PublishedFileDto,
  type PublishedFileReadPage,
} from "../core/published-file.js";

interface FileEntry { dto: PublishedFileDto; path: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
interface ImageEntry { mimeType: string; data: string }
interface ImageCursor { contentRef: string; offset: number }
interface FailureEntry { message: string }

/** Worker-local generation/session registry; Host never receives source paths. */
export class TransientFileRegistry {
  private readonly files = new Map<string, FileEntry>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly imageCursors = new Map<string, ImageCursor>();
  private readonly failures = new Map<string, FailureEntry>();

  async publish(path: string): Promise<PublishedFileDto> {
    if (typeof path !== "string" || path.length < 1 || path.length > 16_384 || !isAbsolute(path)) {
      throw new PublishedFileUnavailableError("The image path must be absolute. Create the image as a local PNG, JPEG, GIF, or WebP file and publish it again.");
    }
    try {
      const canonical = await realpath(resolve(path));
      const mediaType = imageMediaType(canonical);
      if (mediaType === undefined) throw new PublishedFileUnavailableError("This image format cannot be published. Use PNG, JPEG, GIF, or WebP and try again.");
      const info = await stat(canonical);
      if (!info.isFile() || info.size < 1 || info.size > MAX_PUBLISHED_FILE_BYTES) {
        throw new PublishedFileUnavailableError("The image file cannot be published at this size. Create a smaller local image and try again.");
      }
      const dto: PublishedFileDto = {
        presentation: "image",
        fileRef: `file-${randomUUID()}`,
        name: safeName(basename(canonical)),
        sizeBytes: info.size,
        mediaType,
      };
      this.files.set(dto.fileRef, { dto, path: canonical, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      trim(this.files);
      return structuredClone(dto);
    } catch (error) {
      if (error instanceof PublishedFileUnavailableError) throw error;
      throw new PublishedFileUnavailableError("The image file is missing or cannot be read. Create it again and publish the new file.");
    }
  }

  owns(file: PublishedFileDto): boolean {
    const entry = this.files.get(file.fileRef);
    return entry !== undefined && JSON.stringify(entry.dto) === JSON.stringify(file);
  }

  registerImage(data: string, mimeType: string): string {
    const contentRef = `image-${randomUUID()}`;
    this.images.set(contentRef, { mimeType, data });
    trim(this.images);
    return contentRef;
  }

  image(contentRef: string): { mimeType: string; data: string } | undefined {
    const entry = this.images.get(contentRef);
    return entry === undefined ? undefined : { ...entry };
  }

  registerFailure(message: string): string {
    const failureRef = `failure-${randomUUID()}`;
    this.failures.set(failureRef, { message });
    trim(this.failures);
    return failureRef;
  }

  failure(failureRef: string): string | undefined { return this.failures.get(failureRef)?.message; }

  readImageContent(contentRef: string, cursor?: string): AgentConversationContentPage | undefined {
    const image = this.images.get(contentRef);
    if (image === undefined) return undefined;
    let offset = 0;
    if (cursor !== undefined) {
      const continuation = this.imageCursors.get(cursor);
      if (!continuation || continuation.contentRef !== contentRef) throw new AgentConversationCursorError("This image continuation has expired. Reload the conversation and try again.");
      offset = continuation.offset;
    }
    const end = Math.min(image.data.length, offset + 32_000);
    if (end <= offset) throw new PublishedFileUnavailableError();
    const blockComplete = end === image.data.length;
    const chunks = [{ blockIndex: 0, type: "image" as const, mimeType: image.mimeType, data: image.data.slice(offset, end), offset, blockComplete }];
    if (blockComplete) return { revision: contentRef, contentRef, chunks, complete: true };
    const nextCursor = randomUUID();
    this.imageCursors.set(nextCursor, { contentRef, offset: end });
    trim(this.imageCursors);
    return { revision: contentRef, contentRef, chunks, complete: false, nextCursor };
  }

  async read(fileRef: string, offset = 0): Promise<PublishedFileReadPage> {
    const entry = this.files.get(fileRef);
    if (!entry || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.dto.sizeBytes) throw new PublishedFileUnavailableError();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      assertUnchanged(entry, info);
      const count = Math.min(MAX_PUBLISHED_FILE_CHUNK_BYTES, info.size - offset);
      const bytes = Buffer.allocUnsafe(count);
      let read = 0;
      while (read < count) {
        const result = await handle.read(bytes, read, count - read, offset + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read !== count || read === 0) throw new PublishedFileUnavailableError();
      assertUnchanged(entry, await handle.stat());
      assertUnchanged(entry, await stat(entry.path));
      const nextOffset = offset + read;
      const complete = nextOffset === info.size;
      return { file: structuredClone(entry.dto), offset, data: bytes.toString("base64"), complete, ...(complete ? {} : { nextOffset }) };
    } catch (error) {
      if (error instanceof PublishedFileUnavailableError) throw error;
      throw new PublishedFileUnavailableError();
    } finally { await handle?.close().catch(() => {}); }
  }

  clear(): void { this.files.clear(); this.images.clear(); this.imageCursors.clear(); this.failures.clear(); }
}

function assertUnchanged(entry: FileEntry, info: Awaited<ReturnType<typeof stat>>): void {
  if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.size !== entry.dto.sizeBytes
    || info.mtimeMs !== entry.mtimeMs || info.ctimeMs !== entry.ctimeMs) {
    throw new PublishedFileUnavailableError("The published file has changed and is no longer available. Ask the Agent to publish it again.");
  }
}
function trim<T>(entries: Map<string, T>): void { while (entries.size > MAX_TRANSIENT_FILE_HANDLES) entries.delete(entries.keys().next().value as string); }
function safeName(value: string): string { const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim(); return (cleaned || "published-file").slice(0, MAX_PUBLISHED_FILE_NAME_CHARS); }
function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}
