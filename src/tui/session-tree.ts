import type { TreeNodeDto } from "../core/instance-dto.js";

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface TreeNavigationCommand {
  entryId: string;
  options: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
  };
}

export interface VisibleTreeNode {
  node: TreeNodeDto;
  parentId?: string;
  childIds: readonly string[];
  prefix: string;
  activePath: boolean;
  currentLeaf: boolean;
  branchPoint: boolean;
  foldable: boolean;
  folded: boolean;
}

const FILTER_MODES: readonly TreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

export function filterSessionTree(nodes: TreeNodeDto[], mode: TreeFilterMode, leafId?: string): TreeNodeDto[] {
  return nodes.filter((node) => treeNodePassesFilter(node, mode, leafId));
}

function treeNodePassesFilter(node: TreeNodeDto, mode: TreeFilterMode, leafId?: string): boolean {
  if (mode === "labeled-only") return node.label !== undefined;
  if (mode === "user-only") return node.kind === "message" && node.role === "user";
  if (mode === "all") return true;
  if (node.displayClass === "structural") return node.entryId === leafId;
  if (mode === "no-tools") return node.displayClass === "content";
  return node.displayClass === "content" || node.displayClass === "tool";
}

/**
 * Client-local tree state. It consumes only the closed Dock DTO and keeps
 * filtering, active-first ordering, folds, search, and selection out of Host.
 */
export class SessionTreeModel {
  private readonly nodes: TreeNodeDto[];
  private readonly byId = new Map<string, TreeNodeDto>();
  private readonly parentById = new Map<string, string | undefined>();
  private readonly ordered: TreeNodeDto[];
  private readonly activePath = new Set<string>();
  private readonly foldedIds = new Set<string>();
  private filterModeValue: TreeFilterMode;
  private queryValue = "";
  private selectedIdValue: string | undefined;
  private visibleCache: VisibleTreeNode[] | undefined;

  constructor(
    nodes: readonly TreeNodeDto[],
    readonly leafId?: string,
    initialFilter: TreeFilterMode = "default",
    initialSelectedId?: string,
  ) {
    this.nodes = [...nodes];
    for (const node of this.nodes) {
      this.byId.set(node.entryId, node);
      this.parentById.set(node.entryId, node.parentId);
    }
    let cursor = leafId;
    while (cursor !== undefined && !this.activePath.has(cursor)) {
      this.activePath.add(cursor);
      cursor = this.parentById.get(cursor);
    }
    this.ordered = activeFirstPreorder(this.nodes, this.activePath);
    this.filterModeValue = initialFilter;
    this.selectedIdValue = initialSelectedId ?? leafId;
    this.reconcileSelection();
  }

  get filterMode(): TreeFilterMode { return this.filterModeValue; }
  get query(): string { return this.queryValue; }
  get selectedId(): string | undefined { return this.selectedIdValue; }
  get foldedCount(): number { return this.foldedIds.size; }

  visible(): readonly VisibleTreeNode[] {
    this.visibleCache ??= this.buildVisible();
    return this.visibleCache;
  }

  selected(): VisibleTreeNode | undefined {
    const visible = this.visible();
    return visible.find((item) => item.node.entryId === this.selectedIdValue) ?? visible[0];
  }

  setSelected(id: string | undefined): void {
    if (id !== undefined) this.selectedIdValue = id;
    this.reconcileSelection();
  }

  setQuery(query: string): void {
    if (query === this.queryValue) return;
    this.queryValue = query;
    this.foldedIds.clear();
    this.invalidate();
    this.reconcileSelection();
  }

  clearQueryAndFolds(): boolean {
    if (this.queryValue.length === 0 && this.foldedIds.size === 0) return false;
    this.queryValue = "";
    this.foldedIds.clear();
    this.invalidate();
    this.reconcileSelection();
    return true;
  }

  setFilter(mode: TreeFilterMode): void {
    if (mode === this.filterModeValue && this.foldedIds.size === 0) return;
    this.filterModeValue = mode;
    this.foldedIds.clear();
    this.invalidate();
    this.reconcileSelection();
  }

  toggleFilter(mode: Exclude<TreeFilterMode, "default">): void {
    this.setFilter(this.filterModeValue === mode ? "default" : mode);
  }

  cycleFilter(direction: -1 | 1): void {
    const index = FILTER_MODES.indexOf(this.filterModeValue);
    this.setFilter(FILTER_MODES[(index + direction + FILTER_MODES.length) % FILTER_MODES.length] as TreeFilterMode);
  }

  move(delta: number): void {
    const visible = this.visible();
    if (visible.length === 0) return;
    const current = Math.max(0, visible.findIndex((item) => item.node.entryId === this.selectedIdValue));
    this.selectedIdValue = visible[(current + delta % visible.length + visible.length) % visible.length]?.node.entryId;
  }

  movePage(direction: -1 | 1, pageSize: number): void {
    const visible = this.visible();
    if (visible.length === 0) return;
    const current = Math.max(0, visible.findIndex((item) => item.node.entryId === this.selectedIdValue));
    const next = Math.max(0, Math.min(visible.length - 1, current + direction * Math.max(1, pageSize)));
    this.selectedIdValue = visible[next]?.node.entryId;
  }

  foldOrJumpUp(): void {
    const current = this.selected();
    if (!current) return;
    if (current.foldable && !current.folded) {
      this.foldedIds.add(current.node.entryId);
      this.invalidate();
      this.reconcileSelection();
      return;
    }
    this.jumpSegment("up");
  }

  unfoldOrJumpDown(): void {
    const current = this.selected();
    if (!current) return;
    if (current.folded) {
      this.foldedIds.delete(current.node.entryId);
      this.invalidate();
      this.reconcileSelection();
      return;
    }
    this.jumpSegment("down");
  }

  private jumpSegment(direction: "up" | "down"): void {
    const visible = this.visible();
    const selected = this.selected();
    if (!selected) return;
    const indexById = new Map(visible.map((item, index) => [item.node.entryId, index]));
    const byVisibleId = new Map(visible.map((item) => [item.node.entryId, item]));
    let currentId = selected.node.entryId;
    if (direction === "down") {
      while (true) {
        const current = byVisibleId.get(currentId);
        const children = current?.childIds ?? [];
        if (children.length === 0) break;
        currentId = children[0] as string;
        if (children.length > 1) break;
      }
      this.selectedIdValue = currentId;
      return;
    }
    const selectedIndex = indexById.get(currentId) ?? 0;
    while (true) {
      const current = byVisibleId.get(currentId);
      const parentId = current?.parentId;
      if (parentId === undefined) break;
      const parent = byVisibleId.get(parentId);
      if ((parent?.childIds.length ?? 0) > 1) {
        const index = indexById.get(currentId) ?? selectedIndex;
        if (index < selectedIndex) break;
      }
      currentId = parentId;
    }
    this.selectedIdValue = currentId;
  }

  private buildVisible(): VisibleTreeNode[] {
    const tokens = this.queryValue.toLowerCase().split(/\s+/u).filter(Boolean);
    const candidates = new Set<string>();
    for (const node of this.ordered) {
      if (!treeNodePassesFilter(node, this.filterModeValue, this.leafId)) continue;
      if (tokens.length > 0) {
        const text = `${node.label ?? ""} ${node.kind} ${node.role ?? ""} ${node.summary}`.toLowerCase();
        if (!tokens.every((token) => text.includes(token))) continue;
      }
      candidates.add(node.entryId);
    }

    const candidateParent = visibleParentProjection(this.ordered, candidates);
    const candidateChildren = childProjection(this.ordered, candidates, candidateParent);
    const hiddenByFold = new Set<string>();
    const retained = new Set<string>();
    for (const node of this.ordered) {
      if (!candidates.has(node.entryId)) continue;
      const parentId = candidateParent.get(node.entryId);
      if (parentId !== undefined && (hiddenByFold.has(parentId) || this.foldedIds.has(parentId))) {
        hiddenByFold.add(node.entryId);
        continue;
      }
      retained.add(node.entryId);
    }

    const visibleParent = visibleParentProjection(this.ordered, retained);
    const visibleChildren = childProjection(this.ordered, retained, visibleParent);
    const foldable = new Set<string>();
    for (const id of retained) {
      const children = candidateChildren.get(id) ?? [];
      if (children.length === 0) continue;
      const parentId = candidateParent.get(id);
      if (parentId === undefined || (candidateChildren.get(parentId)?.length ?? 0) > 1) foldable.add(id);
    }
    const visual = visualProjection(this.ordered, retained, visibleParent, visibleChildren);
    return this.ordered.flatMap((node) => {
      if (!retained.has(node.entryId)) return [];
      const childIds = visibleChildren.get(node.entryId) ?? [];
      return [{
        node,
        ...(visibleParent.get(node.entryId) === undefined ? {} : { parentId: visibleParent.get(node.entryId) }),
        childIds,
        prefix: visual.get(node.entryId) ?? "",
        activePath: this.activePath.has(node.entryId),
        currentLeaf: node.entryId === this.leafId,
        branchPoint: childIds.length > 1,
        foldable: foldable.has(node.entryId),
        folded: this.foldedIds.has(node.entryId),
      } satisfies VisibleTreeNode];
    });
  }

  private reconcileSelection(): void {
    const visible = this.visible();
    if (visible.length === 0) {
      this.selectedIdValue = undefined;
      return;
    }
    const visibleIds = new Set(visible.map((item) => item.node.entryId));
    let cursor = this.selectedIdValue;
    while (cursor !== undefined) {
      if (visibleIds.has(cursor)) {
        this.selectedIdValue = cursor;
        return;
      }
      cursor = this.parentById.get(cursor);
    }
    this.selectedIdValue = visible.at(-1)?.node.entryId;
  }

  private invalidate(): void { this.visibleCache = undefined; }
}

function activeFirstPreorder(nodes: readonly TreeNodeDto[], activePath: ReadonlySet<string>): TreeNodeDto[] {
  const byId = new Map(nodes.map((node) => [node.entryId, node]));
  const children = new Map<string | undefined, TreeNodeDto[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const orderChildren = (items: readonly TreeNodeDto[]): TreeNodeDto[] => {
    const active = items.find((item) => activePath.has(item.entryId));
    return active === undefined ? [...items] : [active, ...items.filter((item) => item !== active)];
  };
  const roots = orderChildren(children.get(undefined) ?? []);
  const ordered: TreeNodeDto[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as TreeNodeDto;
    if (!byId.has(node.entryId)) continue;
    ordered.push(node);
    const childNodes = orderChildren(children.get(node.entryId) ?? []);
    for (let index = childNodes.length - 1; index >= 0; index -= 1) stack.push(childNodes[index] as TreeNodeDto);
  }
  return ordered;
}

function visibleParentProjection(nodes: readonly TreeNodeDto[], visible: ReadonlySet<string>): Map<string, string | undefined> {
  const nearest = new Map<string, string | undefined>();
  const parent = new Map<string, string | undefined>();
  for (const node of nodes) {
    const nearestParent = node.parentId === undefined ? undefined : nearest.get(node.parentId);
    if (visible.has(node.entryId)) {
      parent.set(node.entryId, nearestParent);
      nearest.set(node.entryId, node.entryId);
    } else nearest.set(node.entryId, nearestParent);
  }
  return parent;
}

function childProjection(
  nodes: readonly TreeNodeDto[],
  visible: ReadonlySet<string>,
  parent: ReadonlyMap<string, string | undefined>,
): Map<string | undefined, string[]> {
  const children = new Map<string | undefined, string[]>();
  for (const node of nodes) {
    if (!visible.has(node.entryId)) continue;
    const parentId = parent.get(node.entryId);
    const list = children.get(parentId) ?? [];
    list.push(node.entryId);
    children.set(parentId, list);
  }
  return children;
}

interface VisualState {
  id: string;
  indent: number;
  justBranched: boolean;
  showConnector: boolean;
  isLast: boolean;
  gutters: Array<{ position: number; show: boolean }>;
  virtualRootChild: boolean;
}

function visualProjection(
  nodes: readonly TreeNodeDto[],
  visible: ReadonlySet<string>,
  parent: ReadonlyMap<string, string | undefined>,
  children: ReadonlyMap<string | undefined, readonly string[]>,
): Map<string, string> {
  const result = new Map<string, string>();
  const roots = children.get(undefined) ?? [];
  const multipleRoots = roots.length > 1;
  const stack: VisualState[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ id: roots[index] as string, indent: multipleRoots ? 1 : 0, justBranched: multipleRoots, showConnector: multipleRoots, isLast: index === roots.length - 1, gutters: [], virtualRootChild: multipleRoots });
  }
  while (stack.length > 0) {
    const state = stack.pop() as VisualState;
    if (!visible.has(state.id)) continue;
    const displayIndent = multipleRoots ? Math.max(0, state.indent - 1) : state.indent;
    const connectorShown = state.showConnector && !state.virtualRootChild;
    const connectorPosition = Math.max(0, displayIndent - 1);
    const chars: string[] = [];
    for (let index = 0; index < displayIndent * 3; index += 1) {
      const level = Math.floor(index / 3);
      const offset = index % 3;
      const gutter = state.gutters.find((item) => item.position === level);
      if (gutter) chars.push(offset === 0 && gutter.show ? "│" : " ");
      else if (connectorShown && level === connectorPosition) chars.push(offset === 0 ? (state.isLast ? "└" : "├") : offset === 1 ? "─" : " ");
      else chars.push(" ");
    }
    result.set(state.id, chars.join(""));
    const childIds = children.get(state.id) ?? [];
    const multipleChildren = childIds.length > 1;
    const childIndent = multipleChildren ? state.indent + 1 : state.justBranched && state.indent > 0 ? state.indent + 1 : state.indent;
    const childGutters = connectorShown ? [...state.gutters, { position: connectorPosition, show: !state.isLast }] : state.gutters;
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ id: childIds[index] as string, indent: childIndent, justBranched: multipleChildren, showConnector: multipleChildren, isLast: index === childIds.length - 1, gutters: childGutters, virtualRootChild: false });
    }
  }
  void nodes;
  void parent;
  return result;
}

/** Legacy compact items retained for bounded fork/user pickers. */
export function treePickerItems(
  nodes: TreeNodeDto[],
  leafId?: string,
  topology: readonly TreeNodeDto[] = nodes,
): Array<{ value: string; label: string; description: string }> {
  const model = new SessionTreeModel(topology, leafId, "all");
  const projected = new Map(model.visible().map((item) => [item.node.entryId, item]));
  return nodes.map((node) => {
    const item = projected.get(node.entryId);
    const marker = node.entryId === leafId ? "●" : item?.branchPoint ? "╋" : node.hasChildren ? "·" : "○";
    const role = semanticTreeRole(node);
    const flags = [
      ...(node.entryId === leafId ? ["current leaf"] : []),
      ...(item?.activePath && node.entryId !== leafId ? ["active path"] : []),
      ...(item?.branchPoint ? [`branch point · ${item.childIds.length} paths`] : []),
      ...(!node.hasChildren && !item?.activePath ? ["sibling branch leaf"] : []),
      ...(node.label ? [`label: ${node.label}`] : []),
    ];
    return { value: node.entryId, label: `${item?.prefix ?? ""}${marker} ${role} · ${node.summary}`, description: flags.join(" · ") || role.toLowerCase() };
  });
}

export function semanticTreeRole(node: TreeNodeDto): string {
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
  return FILTER_MODES.includes(value as TreeFilterMode);
}
