/** Aggregate bound shared by private Worker envelopes and framed public responses. */
export const MAX_DOCK_TRANSFER_BYTES = 256 * 1024 * 1024;

/** Decoded payload keeps a canonical-base64 control JSONL record below 1 MiB. */
export const MAX_CONTROL_BASE64_CHUNK_BYTES = 512 * 1024;
export const MAX_RESPONSE_TRANSFER_CHUNK_BYTES = MAX_CONTROL_BASE64_CHUNK_BYTES;
export const MAX_RESPONSE_TRANSFER_CHUNKS = Math.ceil(MAX_DOCK_TRANSFER_BYTES / MAX_RESPONSE_TRANSFER_CHUNK_BYTES);
