/**
 * Calls a tool made to other tools while it ran, for example from a codemode script. They never
 * reach the model as tool calls, so they are shown inside the calling tool instead of on their own.
 *
 * The bounds are those of Pi's session record (documented in Pi's extensions guide), and they are
 * the only ones applied: a Work watched live and one reopened from its saved conversation show the
 * same list, and arguments are either kept whole or left out, never shortened.
 */
export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_TOOL_CALL_ARGS_BYTES = 8 * 1_024;
export const MAX_NESTED_TOOL_CALLS_ARGS_BYTES = 32 * 1_024;
export const MAX_NESTED_TOOL_CALL_ERROR_CHARS = 500;

/** `running` only appears live; `unfinished` means the call was still running when its caller ended. */
export type NestedToolCallStatus = "running" | "ok" | "error" | "unfinished";

export interface NestedToolCallDto {
  toolName: string;
  /** The call's arguments as JSON text, exactly as Pi keeps them. Absent when over the bounds; the list is then not complete. */
  argumentsJson?: string;
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

/** The list once its caller has ended: calls still running never will finish, as in Pi's record. */
export function settledNestedToolCalls(nested: NestedToolCallsDto): NestedToolCallsDto {
  if (!nested.calls.some((call) => call.status === "running")) return nested;
  return {
    calls: nested.calls.map((call) => call.status === "running" ? { ...call, status: "unfinished" } : call),
    complete: false,
  };
}
