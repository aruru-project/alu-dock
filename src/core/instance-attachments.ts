export const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 1_024;
export const MAX_ATTACHMENT_MEDIA_TYPE_CHARS = 512;
export const MAX_ATTACHMENT_IDS_PER_COMMAND = 32;
export const MAX_ATTACHMENT_LIST_ITEMS = 200;
export const MAX_ATTACHMENT_FILE_ID_CHARS = 128;

/** Canonical path-free attachment projection used by Protocol V2 and conversations. */
export interface AttachmentDto {
  fileId: string;
  name: string;
  sizeBytes: number;
  mediaType?: string;
  sha256: string;
  storedAt: string;
}

export interface AttachmentUploadResult {
  attachment: AttachmentDto;
  status: "stored" | "reused";
}

export type AttachmentAccessRequest =
  | { type: "list" }
  | { type: "resolve"; fileId: string };

export type AttachmentAccessResult =
  | { type: "list"; attachments: AttachmentDto[]; total: number; truncated: boolean }
  | { type: "resolve"; attachment: AttachmentDto; path: string };

/** Host authority exposed to one authenticated Worker connection. */
export interface InstanceAttachmentHostPort {
  accessAttachments(sourceInstanceId: string, request: AttachmentAccessRequest): Promise<AttachmentAccessResult>;
}
