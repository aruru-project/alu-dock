import { performance } from "node:perf_hooks";

import {
  MAX_NESTED_TOOL_CALL_ARGS_BYTES,
  MAX_NESTED_TOOL_CALL_ERROR_CHARS,
  MAX_NESTED_TOOL_CALLS,
  MAX_NESTED_TOOL_CALLS_ARGS_BYTES,
  settledNestedToolCalls,
  type NestedToolCallDto,
  type NestedToolCallsDto,
} from "../core/nested-tool-calls.js";

/**
 * A nested call's arguments as Pi keeps them in its record: the JSON text when it fits Pi's
 * per-call bound, otherwise nothing. Read from Pi's own event, before any other Dock projection.
 */
export function nestedCallArgumentsJson(args: unknown): string | undefined {
  let json: string;
  try { json = JSON.stringify(args ?? {}); } catch { return undefined; }
  return Buffer.byteLength(json, "utf8") <= MAX_NESTED_TOOL_CALL_ARGS_BYTES ? json : undefined;
}

/** Pi's saved `nestedCalls` record of a tool result, as Dock's list. */
export function projectPiNestedToolCalls(record: unknown): NestedToolCallsDto | undefined {
  if (!isRecord(record) || !Array.isArray(record.calls)) return undefined;
  let complete = record.complete === true && record.calls.length <= MAX_NESTED_TOOL_CALLS;
  let argsBytes = 0;
  const calls = record.calls.slice(0, MAX_NESTED_TOOL_CALLS).flatMap((item): NestedToolCallDto[] => {
    if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) { complete = false; return []; }
    const status = item.status === "ok" || item.status === "error" || item.status === "unfinished" ? item.status : undefined;
    if (status === undefined) { complete = false; return []; }
    // Pi leaves out arguments over its bounds and then marks the record incomplete itself.
    const args = item.arguments === undefined ? undefined : withinTotal(nestedCallArgumentsJson(item.arguments), argsBytes);
    if (args !== undefined) argsBytes += args.bytes;
    else complete = false;
    return [{
      toolName: item.name.slice(0, 256),
      ...(args === undefined ? {} : { argumentsJson: args.json }),
      status,
      ...(Number.isSafeInteger(item.durationMs) && (item.durationMs as number) >= 0 ? { durationMs: item.durationMs as number } : {}),
      ...(typeof item.error === "string" ? { error: item.error.slice(0, MAX_NESTED_TOOL_CALL_ERROR_CHARS) } : {}),
    }];
  });
  return calls.length === 0 && complete ? undefined : { calls, complete };
}

interface LiveCall { call: NestedToolCallDto; startedAt: number }
interface Scope { calls: LiveCall[]; byId: Map<string, LiveCall>; complete: boolean; argsBytes: number }

/**
 * The calls each model-issued tool call is making, built from Pi's nested `tool_execution_*`
 * events the same way Pi builds its saved record: calls of nested calls belong to the same list.
 */
export class LiveNestedToolCalls {
  private readonly scopes = new Map<string, Scope>();
  /** Nested call id -> the model-issued call it belongs to, including calls left out of the list. */
  private readonly roots = new Map<string, string>();

  /** Returns the model-issued call whose list changed. `argumentsJson` is from {@link nestedCallArgumentsJson}. */
  start(toolCallId: string, parentToolCallId: string, toolName: string, argumentsJson: string | undefined): string {
    const root = this.roots.get(parentToolCallId) ?? parentToolCallId;
    this.roots.set(toolCallId, root);
    let scope = this.scopes.get(root);
    if (scope === undefined) {
      scope = { calls: [], byId: new Map(), complete: true, argsBytes: 0 };
      this.scopes.set(root, scope);
    }
    if (scope.calls.length >= MAX_NESTED_TOOL_CALLS) {
      scope.complete = false;
      return root;
    }
    const bounded = withinTotal(argumentsJson, scope.argsBytes);
    if (bounded === undefined) scope.complete = false; else scope.argsBytes += bounded.bytes;
    const live: LiveCall = {
      call: { toolName: toolName.slice(0, 256), ...(bounded === undefined ? {} : { argumentsJson: bounded.json }), status: "running" },
      startedAt: performance.now(),
    };
    scope.calls.push(live);
    scope.byId.set(toolCallId, live);
    return root;
  }

  /** Returns the model-issued call whose list changed, if the call is known. `resultContent` is the content of Pi's result. */
  end(toolCallId: string, isError: boolean, resultContent: unknown): string | undefined {
    const root = this.roots.get(toolCallId);
    const live = root === undefined ? undefined : this.scopes.get(root)?.byId.get(toolCallId);
    if (live === undefined) return root;
    live.call.status = isError ? "error" : "ok";
    live.call.durationMs = Math.round(performance.now() - live.startedAt);
    const errorText = isError ? recordedErrorText(resultContent) : "";
    if (errorText) live.call.error = errorText.slice(0, MAX_NESTED_TOOL_CALL_ERROR_CHARS);
    return root;
  }

  snapshot(root: string): NestedToolCallsDto | undefined {
    const scope = this.scopes.get(root);
    if (scope === undefined) return undefined;
    return { calls: scope.calls.map(({ call }) => structuredClone(call)), complete: scope.complete };
  }

  /** The final list once the model-issued call ends; calls still running become unfinished. */
  finish(root: string): NestedToolCallsDto | undefined {
    const scope = this.scopes.get(root);
    if (scope === undefined) return undefined;
    this.scopes.delete(root);
    for (const [id, owner] of this.roots) if (owner === root) this.roots.delete(id);
    return settledNestedToolCalls({ calls: scope.calls.map(({ call }) => call), complete: scope.complete });
  }

  clear(): void {
    this.scopes.clear();
    this.roots.clear();
  }
}

/** A failed call's error text as Pi records it: the result's text blocks, one per line. */
function recordedErrorText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Pi's bound on the arguments of all calls in one list, counted in the order the calls started. */
function withinTotal(json: string | undefined, usedBytes: number): { json: string; bytes: number } | undefined {
  if (json === undefined) return undefined;
  const bytes = Buffer.byteLength(json, "utf8");
  return usedBytes + bytes > MAX_NESTED_TOOL_CALLS_ARGS_BYTES ? undefined : { json, bytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
