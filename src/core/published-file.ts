export const MAX_PUBLISHED_FILE_REF_CHARS = 128;
export const MAX_PUBLISHED_FILE_NAME_CHARS = 1_024;
export const MAX_PUBLISHED_FILE_MEDIA_TYPE_CHARS = 256;
/** One file.read response stays comfortably below the Protocol V2 JSONL limit after base64 expansion. */
export const MAX_PUBLISHED_FILE_CHUNK_BYTES = 256 * 1_024;
export const MAX_PUBLISHED_FILE_BYTES = 512 * 1_024 * 1_024;
export const MAX_TRANSIENT_FILE_HANDLES = 1_024;

export interface PublishedFileDto {
  presentation: "image";
  fileRef: string;
  name: string;
  sizeBytes: number;
  mediaType?: string;
}

export interface PublishedFileReadPage {
  file: PublishedFileDto;
  offset: number;
  data: string;
  complete: boolean;
  nextOffset?: number;
}

export class PublishedFileUnavailableError extends Error {
  readonly code = "file_unavailable";
  constructor(message = "This published file is no longer available. Ask the Agent to publish it again.") {
    super(message);
    this.name = "PublishedFileUnavailableError";
  }
}

/** Strict shared shape check for private extension details before public projection. */
export function validatedPublishedFileDto(input: unknown): PublishedFileDto | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["presentation", "fileRef", "name", "sizeBytes", "mediaType"].includes(key))) return undefined;
  if (value.presentation !== "image"
    || typeof value.fileRef !== "string" || value.fileRef.length < 1 || value.fileRef.length > MAX_PUBLISHED_FILE_REF_CHARS
    || typeof value.name !== "string" || value.name.length < 1 || value.name.length > MAX_PUBLISHED_FILE_NAME_CHARS
    || typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_PUBLISHED_FILE_BYTES
    || (value.mediaType !== undefined && (typeof value.mediaType !== "string" || value.mediaType.length < 1 || value.mediaType.length > MAX_PUBLISHED_FILE_MEDIA_TYPE_CHARS))) return undefined;
  return {
    presentation: "image",
    fileRef: value.fileRef,
    name: value.name,
    sizeBytes: value.sizeBytes,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType as string }),
  };
}
