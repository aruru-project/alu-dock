import type { JsonObject } from "./json-value.js";

/**
 * Calls a tool made to other tools while it ran, for example from a codemode script. They never
 * reach the model as tool calls, so they are shown inside the calling tool instead of on their own.
 *
 * The bounds equal those of Pi's session record (documented in Pi's extensions guide), so a Work
 * watched live and one reopened from its saved conversation show the same list.
 */
export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_TOOL_CALL_ARGS_BYTES = 8 * 1_024;
export const MAX_NESTED_TOOL_CALLS_ARGS_BYTES = 32 * 1_024;
export const MAX_NESTED_TOOL_CALL_ERROR_CHARS = 500;

/** `running` only appears live; `unfinished` means the call was still running when its caller finished. */
export type NestedToolCallStatus = "running" | "ok" | "error" | "unfinished";

export interface NestedToolCallDto {
  toolName: string;
  /** Absent when over the size bounds; the list is then not complete. */
  args?: JsonObject;
  status: NestedToolCallStatus;
  durationMs?: number;
  /** Shortened error text of a failed call. */
  error?: string;
}

export interface NestedToolCallsDto {
  calls: NestedToolCallDto[];
  /** False when calls were left out, arguments omitted, or calls had not finished. */
  complete: boolean;
}
