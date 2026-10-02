import { performance } from "node:perf_hooks";

import { projectJsonObject, type JsonObject } from "../core/json-value.js";
import {
  MAX_NESTED_TOOL_CALL_ARGS_BYTES,
  MAX_NESTED_TOOL_CALL_ERROR_CHARS,
  MAX_NESTED_TOOL_CALLS,
  MAX_NESTED_TOOL_CALLS_ARGS_BYTES,
  type NestedToolCallDto,
  type NestedToolCallsDto,
} from "../core/nested-tool-calls.js";

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
    const args = item.arguments === undefined ? undefined : boundedArgs(item.arguments, argsBytes);
    if (args !== undefined) argsBytes += args.bytes;
    else if (item.arguments !== undefined) complete = false;
    return [{
      toolName: item.name.slice(0, 256),
      ...(args === undefined ? {} : { args: args.value }),
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

  /** Returns the model-issued call whose list changed. */
  start(toolCallId: string, parentToolCallId: string, toolName: string, args: unknown): string {
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
    const bounded = boundedArgs(args, scope.argsBytes);
    if (bounded === undefined) scope.complete = false; else scope.argsBytes += bounded.bytes;
    const live: LiveCall = {
      call: { toolName: toolName.slice(0, 256), ...(bounded === undefined ? {} : { args: bounded.value }), status: "running" },
      startedAt: performance.now(),
    };
    scope.calls.push(live);
    scope.byId.set(toolCallId, live);
    return root;
  }

  /** Returns the model-issued call whose list changed, if the call is known. */
  end(toolCallId: string, isError: boolean, errorText: string): string | undefined {
    const root = this.roots.get(toolCallId);
    const live = root === undefined ? undefined : this.scopes.get(root)?.byId.get(toolCallId);
    if (live === undefined) return root;
    live.call.status = isError ? "error" : "ok";
    live.call.durationMs = Math.round(performance.now() - live.startedAt);
    if (isError && errorText) live.call.error = errorText.slice(0, MAX_NESTED_TOOL_CALL_ERROR_CHARS);
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
    let complete = scope.complete;
    const calls = scope.calls.map(({ call }) => {
      if (call.status !== "running") return call;
      complete = false;
      return { ...call, status: "unfinished" as const };
    });
    return { calls, complete };
  }

  clear(): void {
    this.scopes.clear();
    this.roots.clear();
  }
}

function boundedArgs(input: unknown, usedBytes: number): { value: JsonObject; bytes: number } | undefined {
  const projected = projectJsonObject(input ?? {});
  if (projected.omittedFields.length > 0) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(projected.value), "utf8");
  if (bytes > MAX_NESTED_TOOL_CALL_ARGS_BYTES || usedBytes + bytes > MAX_NESTED_TOOL_CALLS_ARGS_BYTES) return undefined;
  return { value: projected.value, bytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
