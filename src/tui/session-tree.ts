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
  topology: readonly TreeNodeDto[] = nodes,
): Array<{ value: string; label: string; description: string }> {
  const byId = new Map(topology.map((node) => [node.entryId, node]));
  const childCount = new Map<string, number>();
  for (const node of topology) {
    if (node.parentId) childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
  }
  const activePath = new Set<string>();
  let cursor = leafId === undefined ? undefined : byId.get(leafId);
  while (cursor && !activePath.has(cursor.entryId)) {
    activePath.add(cursor.entryId);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }

  return nodes.map((node) => {
    const branchDepth = branchAncestorCount(node, byId, childCount);
    const isBranchPoint = (childCount.get(node.entryId) ?? 0) > 1;
    const isLeaf = !node.hasChildren || (childCount.get(node.entryId) ?? 0) === 0;
    const onActivePath = activePath.has(node.entryId);
    const marker = node.entryId === leafId
      ? "●"
      : isBranchPoint ? (onActivePath ? "╋" : "┼")
        : isLeaf ? (onActivePath ? "◆" : "○")
          : onActivePath ? "┃" : "·";
    const role = semanticTreeRole(node);
    const flags = [
      ...(node.entryId === leafId ? ["current leaf"] : []),
      ...(onActivePath && node.entryId !== leafId ? ["active path"] : []),
      ...(isBranchPoint ? [`branch point · ${childCount.get(node.entryId)} paths`] : []),
      ...(isLeaf && !onActivePath ? ["sibling branch leaf"] : []),
      ...(node.label ? [`label: ${node.label}`] : []),
    ];
    return {
      value: node.entryId,
      label: `${"│ ".repeat(Math.min(branchDepth, 8))}${marker} ${role} · ${node.summary}`,
      description: flags.join(" · ") || role.toLowerCase(),
    };
  });
}

function branchAncestorCount(
  node: TreeNodeDto,
  byId: ReadonlyMap<string, TreeNodeDto>,
  childCount: ReadonlyMap<string, number>,
): number {
  let count = 0;
  let parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
  const seen = new Set<string>();
  while (parent && !seen.has(parent.entryId)) {
    seen.add(parent.entryId);
    if ((childCount.get(parent.entryId) ?? 0) > 1) count += 1;
    parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId);
  }
  return count;
}

function semanticTreeRole(node: TreeNodeDto): string {
  if (node.kind === "message") {
    if (node.role === "user") return "You";
    if (node.role === "assistant") return "Alu";
    if (node.role === "tool") return "Tool";
    if (node.role === "system") return "System";
  }
  if (node.kind === "compaction") return "Context summary";
  if (node.kind === "branch_summary") return "Branch summary";
  return node.kind.replaceAll("_", " ");
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
