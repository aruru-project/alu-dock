import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

import { AgentConversationCursorError, type AgentConversationContentPage } from "../core/agent-worker.js";
import { MAX_CONVERSATION_CHUNK_CHARS, MAX_IMAGE_BYTES } from "../core/instance-dto.js";
import {
  MAX_PUBLISHED_FILE_BYTES,
  MAX_PUBLISHED_FILE_CHUNK_BYTES,
  MAX_PUBLISHED_FILE_NAME_CHARS,
  MAX_TRANSIENT_FILE_HANDLES,
  PublishedFileUnavailableError,
  type PublishedFileDto,
  type PublishedFileReadPage,
} from "../core/published-file.js";
import { assertUnchangedSource, inspectSourceFile, MAX_SOURCE_FILE_PATH_CHARS, openUnchangedSource, SourceFileError, type SourceFileIdentity } from "../core/source-file.js";

interface FileEntry { dto: PublishedFileDto; source: SourceFileIdentity }
export interface ConversationImageMetadata { contentRef: string; mimeType: string; sizeBytes: number; sha256: string }
interface ImageEntry extends ConversationImageMetadata { data: string }
interface ImageCursor { contentRef: string; offset: number }
interface FailureEntry { message: string }

/** Worker-local generation/session registry; Host never receives source paths. */
export class TransientFileRegistry {
  private readonly files = new Map<string, FileEntry>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly imageCursors = new Map<string, ImageCursor>();
  private readonly failures = new Map<string, FailureEntry>();

  async publish(path: string): Promise<PublishedFileDto> {
    try {
      const source = await inspectSourceFile(path, { maxPathChars: MAX_SOURCE_FILE_PATH_CHARS, maxBytes: MAX_PUBLISHED_FILE_BYTES });
      const mediaType = imageMediaType(source.path);
      if (mediaType === undefined) throw new PublishedFileUnavailableError("This image format cannot be published. Use PNG, JPEG, GIF, or WebP and try again.");
      if (source.size < 1) throw new PublishedFileUnavailableError("The image file cannot be published at this size. Create a smaller local image and try again.");
      const dto: PublishedFileDto = {
        presentation: "image",
        fileRef: `file-${randomUUID()}`,
        name: safeName(basename(source.path)),
        sizeBytes: source.size,
        mediaType,
      };
      this.files.set(dto.fileRef, { dto, source });
      trim(this.files);
      return structuredClone(dto);
    } catch (error) {
      if (error instanceof PublishedFileUnavailableError) throw error;
      if (error instanceof SourceFileError && error.reason === "invalid_path") throw new PublishedFileUnavailableError("The image path must be absolute. Create the image as a local PNG, JPEG, GIF, or WebP file and publish it again.");
      if (error instanceof SourceFileError && error.reason === "too_large") throw new PublishedFileUnavailableError("The image file cannot be published at this size. Create a smaller local image and try again.");
      throw new PublishedFileUnavailableError("The image file is missing or cannot be read. Create it again and publish the new file.");
    }
  }

  owns(file: PublishedFileDto): boolean {
    const dto = this.files.get(file.fileRef)?.dto;
    return dto !== undefined
      && dto.presentation === file.presentation
      && dto.name === file.name
      && dto.sizeBytes === file.sizeBytes
      && dto.mediaType === file.mediaType;
  }

  registerImage(data: string, mimeType: string): ConversationImageMetadata {
    const bytes = Buffer.from(data, "base64");
    if (data.length === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) {
      throw new PublishedFileUnavailableError("This conversation image is not valid bounded base64 data.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const entry = { contentRef: `image-${sha256}`, mimeType, data, sizeBytes: bytes.byteLength, sha256 };
    this.images.set(entry.contentRef, entry);
    trim(this.images);
    return { contentRef: entry.contentRef, mimeType, sizeBytes: entry.sizeBytes, sha256 };
  }

  image(contentRef: string): ImageEntry | undefined {
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
    const end = Math.min(image.data.length, offset + MAX_CONVERSATION_CHUNK_CHARS);
    if (end <= offset) throw new PublishedFileUnavailableError();
    const blockComplete = end === image.data.length;
    const chunks = [{
      blockIndex: 0, type: "image" as const, mimeType: image.mimeType, data: image.data.slice(offset, end), offset, blockComplete,
    }];
    if (blockComplete) return { revision: contentRef, contentRef, chunks, complete: true };
    const nextCursor = randomUUID();
    this.imageCursors.set(nextCursor, { contentRef, offset: end });
    trim(this.imageCursors);
    return { revision: contentRef, contentRef, chunks, complete: false, nextCursor };
  }

  async read(fileRef: string, offset = 0): Promise<PublishedFileReadPage> {
    const entry = this.files.get(fileRef);
    if (!entry || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.dto.sizeBytes) throw new PublishedFileUnavailableError();
    let handle: Awaited<ReturnType<typeof openUnchangedSource>> | undefined;
    try {
      handle = await openUnchangedSource(entry.source);
      const info = await handle.stat();
      const count = Math.min(MAX_PUBLISHED_FILE_CHUNK_BYTES, info.size - offset);
      const bytes = Buffer.allocUnsafe(count);
      let read = 0;
      while (read < count) {
        const result = await handle.read(bytes, read, count - read, offset + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read !== count || read === 0) throw new PublishedFileUnavailableError();
      assertUnchangedSource(entry.source, await handle.stat());
      const nextOffset = offset + read;
      const complete = nextOffset === info.size;
      return { file: structuredClone(entry.dto), offset, data: bytes.toString("base64"), complete, ...(complete ? {} : { nextOffset }) };
    } catch (error) {
      if (error instanceof PublishedFileUnavailableError) throw error;
      if (error instanceof SourceFileError && error.reason === "changed") {
        throw new PublishedFileUnavailableError("The published file has changed and is no longer available. Ask the Agent to publish it again.");
      }
      throw new PublishedFileUnavailableError();
    } finally { await handle?.close().catch(() => {}); }
  }

  clear(): void { this.files.clear(); this.images.clear(); this.imageCursors.clear(); this.failures.clear(); }
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
