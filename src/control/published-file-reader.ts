import {
  MAX_PUBLISHED_FILE_CHUNK_BYTES,
  PublishedFileUnavailableError,
  type PublishedFileDto,
  type PublishedFileReadPage,
} from "../core/published-file.js";
import { assertUnchangedSource, openUnchangedSource, SourceFileError, type SourceFileIdentity } from "../core/source-file.js";

/** Host reader for the existing public page API. Registration stays with the source owner. */
export async function readPublishedFilePage(file: PublishedFileDto, source: SourceFileIdentity, offset = 0): Promise<PublishedFileReadPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.sizeBytes || file.sizeBytes !== source.size) {
    throw new PublishedFileUnavailableError();
  }
  let handle: Awaited<ReturnType<typeof openUnchangedSource>> | undefined;
  try {
    handle = await openUnchangedSource(source);
    const count = Math.min(MAX_PUBLISHED_FILE_CHUNK_BYTES, source.size - offset);
    const bytes = Buffer.allocUnsafe(count);
    let read = 0;
    while (read < count) {
      const result = await handle.read(bytes, read, count - read, offset + read);
      if (result.bytesRead === 0) throw new PublishedFileUnavailableError();
      read += result.bytesRead;
    }
    assertUnchangedSource(source, await handle.stat());
    const nextOffset = offset + read;
    const complete = nextOffset === source.size;
    return { file: structuredClone(file), offset, data: bytes.toString("base64"), complete, ...(complete ? {} : { nextOffset }) };
  } catch (error) {
    if (error instanceof PublishedFileUnavailableError) throw error;
    if (error instanceof SourceFileError && error.reason === "changed") {
      throw new PublishedFileUnavailableError("The published file has changed and is no longer available. Ask the Agent to publish it again.");
    }
    throw new PublishedFileUnavailableError();
  } finally { await handle?.close().catch(() => {}); }
}
