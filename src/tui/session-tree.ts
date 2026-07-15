import type { TreeNodeDto } from "../core/instance-dto.js";

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface SessionTreePage {
  treeRevision: string;
  nodes: TreeNodeDto[];
  leafId?: string;
  total: number;
  truncated: boolean;
  nextAfterEntryId?: string;
}

export interface CollectedSessionTree {
  nodes: TreeNodeDto[];
  leafId?: string;
  total: number;
  revision: string;
  capped: boolean;
}

export interface TreeNavigationCommand {
  entryId: string;
  options: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
  };
}

/** Collect one stable revision without coupling the view state to DockClient. */
export async function collectSessionTree(
  fetchPage: (revision?: string, afterEntryId?: string, limit?: number) => Promise<SessionTreePage>,
  maxNodes = 5_000,
): Promise<CollectedSessionTree> {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error("Session tree collection cap must be a positive integer");
  const boundedMaxNodes = maxNodes;
  const first = await fetchPage(undefined, undefined, Math.min(200, boundedMaxNodes));
  const nodes = [...first.nodes];
  if (nodes.length > boundedMaxNodes || nodes.length > first.total) throw new Error("Host returned an oversized first session tree page");
  const seen = new Set(nodes.map((node) => node.entryId));
  if (seen.size !== nodes.length) throw new Error("Host returned duplicate entries in a session tree page");
  let page = first;
  while (page.truncated && nodes.length < boundedMaxNodes) {
    const cursor = page.nextAfterEntryId;
    if (!cursor) throw new Error("Host returned a truncated tree page without a cursor");
    page = await fetchPage(first.treeRevision, cursor, Math.min(200, boundedMaxNodes - nodes.length));
    if (page.treeRevision !== first.treeRevision || page.total !== first.total || page.leafId !== first.leafId) {
      throw new Error("Session tree changed during pagination");
    }
    if (page.nodes.some((node) => seen.has(node.entryId))) throw new Error("Host returned duplicate entries across tree pages");
    for (const node of page.nodes) seen.add(node.entryId);
    nodes.push(...page.nodes);
    if (nodes.length > first.total) throw new Error("Host returned more session tree entries than declared");
  }
  return {
    nodes,
    ...(first.leafId === undefined ? {} : { leafId: first.leafId }),
    total: first.total,
    revision: first.treeRevision,
    capped: nodes.length < first.total,
  };
}

export function filterSessionTree(nodes: TreeNodeDto[], mode: TreeFilterMode): TreeNodeDto[] {
  if (mode === "user-only") return nodes.filter((node) => node.kind === "message" && node.role === "user");
  if (mode === "labeled-only") return nodes.filter((node) => node.label !== undefined);
  if (mode === "all") return [...nodes];
  const hidden = new Set<TreeNodeDto["kind"]>(["label", "custom", "model_change", "thinking_level_change", "session_info"]);
  return nodes.filter((node) => !hidden.has(node.kind) && (mode !== "no-tools" || node.role !== "tool"));
}

export function treePickerItems(
  nodes: TreeNodeDto[],
  leafId?: string,
): Array<{ value: string; label: string; description: string }> {
  return nodes.map((node) => ({
    value: node.entryId,
    label: `${"  ".repeat(Math.min(node.depth, 20))}${node.entryId === leafId ? "●" : node.hasChildren ? "◆" : "•"} ${node.summary}`,
    description: `${node.kind}${node.role ? `/${node.role}` : ""}${node.label ? ` · ${node.label}` : ""} · ${node.entryId}`,
  }));
}

export function parseTreeNavigationCommand(target: string): TreeNavigationCommand | undefined {
  const [entryId, mode, ...rest] = target.split(/\s+/u);
  if (!entryId || (mode !== undefined && mode !== "--summary" && mode !== "--replace")) return undefined;
  if (mode === "--replace" && rest.length === 0) return undefined;
  return {
    entryId,
    options: mode === undefined ? {} : {
      summarize: true,
      ...(rest.length === 0 ? {} : { customInstructions: rest.join(" ") }),
      ...(mode === "--replace" ? { replaceInstructions: true } : {}),
    },
  };
}

export function isTreeFilterMode(value: unknown): value is TreeFilterMode {
  return value === "default" || value === "no-tools" || value === "user-only" || value === "labeled-only" || value === "all";
}
