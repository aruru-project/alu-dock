import { createHash } from "node:crypto";

import type {
  RuntimeNavigateResult,
  RuntimeTreeNode,
  RuntimeTreeSnapshot,
} from "./runtime-session.js";
import type { TreeNodeDto } from "./instance-dto.js";

export const MAX_PROJECTED_SESSION_TREE_NODES = 100_000;

export interface ProjectedSessionTree {
  treeRevision: string;
  nodes: TreeNodeDto[];
  leafId?: string;
}

const TREE_KINDS = [
  "message", "thinking_level_change", "model_change", "compaction", "branch_summary",
  "custom", "custom_message", "label", "session_info",
] as const;
const TREE_ROLES = ["user", "assistant", "tool", "system"] as const;
const DATA_URI = /data:[^,]*;base64,/i;
const BASE64_PAYLOAD = /^(?=.{128,}$)(?=.*(?:[0-9+/]|={1,2}$))(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Validate, sanitize, and revision a Pi-agnostic runtime tree projection. */
export function projectRuntimeTree(
  runtimeTree: RuntimeTreeSnapshot,
  runtimeGeneration: number,
): ProjectedSessionTree {
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) throw new Error("Runtime tree generation must be positive");
  if (runtimeTree === null || typeof runtimeTree !== "object" || !Array.isArray(runtimeTree.nodes) || runtimeTree.nodes.length > MAX_PROJECTED_SESSION_TREE_NODES) {
    throw new Error(`Runtime session tree is invalid or exceeds ${MAX_PROJECTED_SESSION_TREE_NODES} entries`);
  }
  const ids = new Set<string>();
  const ancestors: string[] = [];
  const nodes: TreeNodeDto[] = [];
  const revisionNodes: RuntimeTreeNode[] = [];
  for (const node of runtimeTree.nodes) {
    const projected = projectRuntimeTreeNode(node);
    if (ids.has(projected.entryId)) throw new Error(`Runtime session tree contains duplicate entry ID: ${projected.entryId}`);
    if (projected.parentId === undefined) {
      if (projected.depth !== 0) throw new Error("Runtime session tree root must have depth zero");
    } else if (projected.depth < 1 || ancestors[projected.depth - 1] !== projected.parentId) {
      throw new Error("Runtime session tree is not stable depth-first pre-order");
    }
    ancestors.length = projected.depth;
    ancestors.push(projected.entryId);
    ids.add(projected.entryId);
    nodes.push(projected);
    revisionNodes.push({
      ...projected,
      ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: canonicalRuntimeTimestamp(node.labelTimestamp) }),
    });
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as TreeNodeDto;
    const next = nodes[index + 1];
    const expectedChildren = next !== undefined && next.depth === node.depth + 1 && next.parentId === node.entryId;
    if (node.hasChildren !== expectedChildren) throw new Error("Runtime session tree child projection is inconsistent");
  }
  const leafId = runtimeTree.leafId === undefined ? undefined : boundedRuntimeId(runtimeTree.leafId, "Runtime tree leaf ID");
  if (leafId !== undefined && !ids.has(leafId)) throw new Error("Runtime session tree leaf does not belong to the projected tree");
  const digest = createHash("sha256").update(JSON.stringify({
    runtimeGeneration,
    leafId: leafId ?? null,
    nodes: revisionNodes,
  })).digest("hex");
  return {
    treeRevision: `g${runtimeGeneration}-${digest}`,
    nodes,
    ...(leafId === undefined ? {} : { leafId }),
  };
}

export function projectRuntimeNavigateResult(result: RuntimeNavigateResult): RuntimeNavigateResult {
  if (result === null || typeof result !== "object" || typeof result.cancelled !== "boolean" || typeof result.summaryCreated !== "boolean") {
    throw new Error("Runtime returned an invalid tree navigation result");
  }
  if (result.aborted !== undefined && typeof result.aborted !== "boolean") throw new Error("Runtime returned an invalid navigation abort state");
  if (result.aborted === true && !result.cancelled) throw new Error("Aborted tree navigation must be cancelled");
  if (result.editorText !== undefined && (typeof result.editorText !== "string" || result.editorText.length > 256_000)) {
    throw new Error("Runtime returned invalid or oversized navigation editor text");
  }
  const editorText = result.editorText === undefined ? undefined : safeTreeText(result.editorText, 256_000, undefined);
  if (result.cancelled && editorText !== undefined) throw new Error("Cancelled tree navigation cannot return editor text");
  return {
    cancelled: result.cancelled,
    ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    ...(editorText === undefined ? {} : { editorText }),
    summaryCreated: result.summaryCreated,
  };
}

function projectRuntimeTreeNode(node: RuntimeTreeNode): TreeNodeDto {
  if (node === null || typeof node !== "object") throw new Error("Runtime tree node must be an object");
  const kind = enumRuntimeValue(node.kind, TREE_KINDS, "Runtime tree node kind");
  const role = node.role === undefined ? undefined : enumRuntimeValue(node.role, TREE_ROLES, "Runtime tree node role");
  if ((kind === "message") !== (role !== undefined)) throw new Error("Runtime tree message role invariant failed");
  if (!Number.isSafeInteger(node.depth) || node.depth < 0 || node.depth > 100_000) throw new Error("Runtime tree node depth is invalid");
  if (typeof node.hasChildren !== "boolean") throw new Error("Runtime tree node hasChildren must be boolean");
  const entryId = boundedRuntimeId(node.entryId, "Runtime tree entry ID");
  const parentId = node.parentId === undefined ? undefined : boundedRuntimeId(node.parentId, "Runtime tree parent ID");
  const label = node.label === undefined ? undefined : safeTreeText(node.label, 256, undefined);
  const timestamp = node.timestamp === undefined ? undefined : canonicalRuntimeTimestamp(node.timestamp);
  return {
    entryId,
    ...(parentId === undefined ? {} : { parentId }),
    depth: node.depth,
    kind,
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(timestamp === undefined ? {} : { timestamp }),
    summary: safeTreeText(node.summary, 2_048, "Session entry details omitted") ?? "Session entry details omitted",
    hasChildren: node.hasChildren,
  };
}

function boundedRuntimeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a bounded terminal-safe string`);
  }
  return value;
}

function canonicalRuntimeTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("Runtime tree timestamp must be a canonical timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("Runtime tree timestamp must be canonical ISO-8601 UTC");
  return value;
}

function safeTreeText(value: unknown, limit: number, fallback: string | undefined): string | undefined {
  if (typeof value !== "string" || isBinaryText(value)) return fallback;
  const sanitized = value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
  if (sanitized.length === 0) return fallback;
  return truncate(sanitized, limit) ?? fallback;
}

function enumRuntimeValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return limit < 1 ? "" : `${value.slice(0, limit - 1)}…`;
}

function isBinaryText(value: string): boolean {
  if (DATA_URI.test(value) || BASE64_PAYLOAD.test(value.replace(/\s+/gu, ""))) return true;
  return value.split(/[^A-Za-z0-9+/=]+/gu).some((part) => BASE64_PAYLOAD.test(part));
}
