import type { TreeNode } from './types'

export const TREE_FILTER_STORAGE_KEY = 'aludock.session-tree-filter'

export const TREE_FILTERS = [
  { value: 'default', label: '默认' },
  { value: 'no-tools', label: '无工具' },
  { value: 'user-only', label: '用户' },
  { value: 'labeled-only', label: '已标记' },
  { value: 'all', label: '全部' },
] as const

export type TreeFilter = typeof TREE_FILTERS[number]['value']
export type TreeFilterCounts = Record<TreeFilter, number>

type FilterStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readTreeFilter(storage: FilterStorage | null): TreeFilter {
  try {
    const saved = storage?.getItem(TREE_FILTER_STORAGE_KEY)
    if (TREE_FILTERS.some((filter) => filter.value === saved)) return saved as TreeFilter
  } catch {
    // A local preference must never prevent the Tree from opening.
  }
  return 'default'
}

export function persistTreeFilter(storage: FilterStorage | null, filter: TreeFilter): void {
  try {
    storage?.setItem(TREE_FILTER_STORAGE_KEY, filter)
  } catch {
    // Storage can be unavailable or full; the in-memory choice still works.
  }
}

export function treeNodeMatchesFilter(node: TreeNode, filter: TreeFilter, leafId?: string | null): boolean {
  if (filter === 'labeled-only') return node.label != null
  if (filter === 'user-only') return node.kind === 'message' && node.role === 'user'
  if (filter === 'all') return true
  if (node.displayClass === 'structural') return node.entryId === leafId
  if (filter === 'no-tools') return node.displayClass === 'content'
  return node.displayClass === 'content' || node.displayClass === 'tool'
}

export function countTreeFilters(nodes: TreeNode[], leafId?: string | null): TreeFilterCounts {
  return Object.fromEntries(TREE_FILTERS.map((filter) => [
    filter.value,
    nodes.filter((node) => treeNodeMatchesFilter(node, filter.value, leafId)).length,
  ])) as TreeFilterCounts
}

export interface VisibleTreeItem {
  node: TreeNode
  parentId?: string
  childIds: string[]
  prefix: string
  level: number
  positionInSet: number
  setSize: number
  activePath: boolean
  currentLeaf: boolean
  branchPoint: boolean
  foldable: boolean
  folded: boolean
}

export function activeFirstTreeNodes(nodes: TreeNode[], leafId?: string | null): TreeNode[] {
  const activePath = activeTreePath(nodes, leafId)
  const children = new Map<string | undefined, TreeNode[]>()
  for (const node of nodes) {
    const parentId = node.parentId ?? undefined
    const siblings = children.get(parentId) ?? []
    siblings.push(node)
    children.set(parentId, siblings)
  }
  const activeFirst = (siblings: TreeNode[]) => {
    const active = siblings.find((node) => activePath.has(node.entryId))
    return active ? [active, ...siblings.filter((node) => node !== active)] : siblings
  }
  const ordered: TreeNode[] = []
  const stack = [...activeFirst(children.get(undefined) ?? [])].reverse()
  while (stack.length) {
    const node = stack.pop()!
    ordered.push(node)
    const descendants = activeFirst(children.get(node.entryId) ?? [])
    for (let index = descendants.length - 1; index >= 0; index--) stack.push(descendants[index]!)
  }
  return ordered
}

export function projectSessionTree(
  nodes: TreeNode[],
  leafId: string | null | undefined,
  filter: TreeFilter,
  query: string,
  foldedIds: ReadonlySet<string>,
): VisibleTreeItem[] {
  const ordered = activeFirstTreeNodes(nodes, leafId)
  const activePath = activeTreePath(nodes, leafId)
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean)
  const candidates = new Set(ordered
    .filter((node) => treeNodeMatchesFilter(node, filter, leafId)
      && tokens.every((token) => treeNodeSearchText(node, leafId).includes(token)))
    .map((node) => node.entryId))
  const candidateParent = visibleParentProjection(ordered, candidates)
  const candidateChildren = childProjection(ordered, candidates, candidateParent)

  const hiddenByFold = new Set<string>()
  const retained = new Set<string>()
  for (const node of ordered) {
    if (!candidates.has(node.entryId)) continue
    const parentId = candidateParent.get(node.entryId)
    if (parentId && (hiddenByFold.has(parentId) || foldedIds.has(parentId))) hiddenByFold.add(node.entryId)
    else retained.add(node.entryId)
  }

  const visibleParent = visibleParentProjection(ordered, retained)
  const visibleChildren = childProjection(ordered, retained, visibleParent)
  const foldable = new Set<string>()
  for (const id of retained) {
    const children = candidateChildren.get(id) ?? []
    if (!children.length) continue
    const parentId = candidateParent.get(id)
    if (!parentId || children.length > 1 || (candidateChildren.get(parentId)?.length ?? 0) > 1) foldable.add(id)
  }
  const prefixes = visualTreePrefixes(retained, visibleChildren)
  const levels = new Map<string, number>()
  for (const node of ordered) {
    if (!retained.has(node.entryId)) continue
    const parentId = visibleParent.get(node.entryId)
    levels.set(node.entryId, parentId ? (levels.get(parentId) ?? 0) + 1 : 1)
  }
  return ordered.flatMap((node): VisibleTreeItem[] => {
    if (!retained.has(node.entryId)) return []
    const parentId = visibleParent.get(node.entryId)
    const childIds = visibleChildren.get(node.entryId) ?? []
    const siblings = visibleChildren.get(parentId) ?? []
    return [{
      node,
      ...(parentId ? { parentId } : {}),
      childIds,
      prefix: prefixes.get(node.entryId) ?? '',
      level: levels.get(node.entryId) ?? 1,
      positionInSet: siblings.indexOf(node.entryId) + 1,
      setSize: siblings.length,
      activePath: activePath.has(node.entryId),
      currentLeaf: node.entryId === leafId,
      branchPoint: childIds.length > 1,
      foldable: foldable.has(node.entryId),
      folded: foldedIds.has(node.entryId),
    }]
  })
}

export function nearestVisibleTreeNodeId(
  nodes: TreeNode[],
  visibleIds: ReadonlySet<string>,
  preferredId?: string | null,
): string | undefined {
  const byId = new Map(nodes.map((node) => [node.entryId, node]))
  const seen = new Set<string>()
  for (let cursor: string | undefined = preferredId ?? undefined; cursor && !seen.has(cursor); cursor = byId.get(cursor)?.parentId ?? undefined) {
    if (visibleIds.has(cursor)) return cursor
    seen.add(cursor)
  }
  return undefined
}

function activeTreePath(nodes: TreeNode[], leafId?: string | null): Set<string> {
  const path = new Set<string>()
  const byId = new Map(nodes.map((node) => [node.entryId, node]))
  for (let cursor: string | undefined = leafId ?? undefined; cursor && !path.has(cursor); cursor = byId.get(cursor)?.parentId ?? undefined) path.add(cursor)
  return path
}

function visibleParentProjection(nodes: TreeNode[], visible: ReadonlySet<string>): Map<string, string | undefined> {
  const nearest = new Map<string, string | undefined>()
  const parent = new Map<string, string | undefined>()
  for (const node of nodes) {
    const nearestParent = node.parentId ? nearest.get(node.parentId) : undefined
    if (visible.has(node.entryId)) {
      parent.set(node.entryId, nearestParent)
      nearest.set(node.entryId, node.entryId)
    } else nearest.set(node.entryId, nearestParent)
  }
  return parent
}

function childProjection(
  nodes: TreeNode[],
  visible: ReadonlySet<string>,
  parent: ReadonlyMap<string, string | undefined>,
): Map<string | undefined, string[]> {
  const children = new Map<string | undefined, string[]>()
  for (const node of nodes) {
    if (!visible.has(node.entryId)) continue
    const parentId = parent.get(node.entryId)
    const siblings = children.get(parentId) ?? []
    siblings.push(node.entryId)
    children.set(parentId, siblings)
  }
  return children
}

function visualTreePrefixes(
  visible: ReadonlySet<string>,
  children: ReadonlyMap<string | undefined, string[]>,
): Map<string, string> {
  interface VisualState {
    id: string
    indent: number
    branched: boolean
    connector: boolean
    last: boolean
    gutters: Array<{ position: number; show: boolean }>
    virtualRoot: boolean
  }
  const result = new Map<string, string>()
  const roots = children.get(undefined) ?? []
  const multipleRoots = roots.length > 1
  const stack: VisualState[] = []
  for (let index = roots.length - 1; index >= 0; index--) {
    stack.push({ id: roots[index]!, indent: multipleRoots ? 1 : 0, branched: multipleRoots, connector: multipleRoots, last: index === roots.length - 1, gutters: [], virtualRoot: multipleRoots })
  }
  while (stack.length) {
    const state = stack.pop()!
    if (!visible.has(state.id)) continue
    const displayIndent = multipleRoots ? Math.max(0, state.indent - 1) : state.indent
    const connectorShown = state.connector && !state.virtualRoot
    const connectorPosition = Math.max(0, displayIndent - 1)
    const characters: string[] = []
    for (let index = 0; index < displayIndent * 3; index++) {
      const level = Math.floor(index / 3)
      const offset = index % 3
      const gutter = state.gutters.find((item) => item.position === level)
      if (gutter) characters.push(offset === 0 && gutter.show ? '│' : ' ')
      else if (connectorShown && level === connectorPosition) characters.push(offset === 0 ? (state.last ? '└' : '├') : offset === 1 ? '─' : ' ')
      else characters.push(' ')
    }
    result.set(state.id, characters.join(''))
    const childIds = children.get(state.id) ?? []
    const multipleChildren = childIds.length > 1
    const childIndent = multipleChildren ? state.indent + 1 : state.branched && state.indent > 0 ? state.indent + 1 : state.indent
    const childGutters = connectorShown ? [...state.gutters, { position: connectorPosition, show: !state.last }] : state.gutters
    for (let index = childIds.length - 1; index >= 0; index--) {
      stack.push({ id: childIds[index]!, indent: childIndent, branched: multipleChildren, connector: multipleChildren, last: index === childIds.length - 1, gutters: childGutters, virtualRoot: false })
    }
  }
  return result
}

export function treeNodeTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function treeNodeBadge(node: TreeNode, leafId?: string | null): string {
  if (node.entryId === leafId) return '当前'
  if (node.state === 'error') return '错误'
  if (node.state === 'aborted') return '已中止'
  return ''
}

export function treeNodeIcon(node: TreeNode): string {
  if (node.state === 'error') return '×'
  if (node.state === 'aborted') return '■'
  if (node.role === 'user') return '›'
  if (node.role === 'assistant') return '◆'
  if (node.role === 'tool') return '·'
  if (node.role === 'system') return '◇'
  if (node.displayClass === 'metadata') return '·'
  if (node.displayClass === 'structural') return '┊'
  return '•'
}

export function treeNodeRoleLabel(node: TreeNode): string {
  if (node.role === 'user') return '用户'
  if (node.role === 'assistant') return 'Agent'
  if (node.role === 'tool') return '工具'
  if (node.role === 'system') return '系统'
  return node.kind
}

export function currentOrEndTreeWindowStart(
  nodes: TreeNode[],
  leafId: string | null | undefined,
  windowSize: number,
): number {
  const currentIndex = leafId ? nodes.findIndex((node) => node.entryId === leafId) : -1
  if (currentIndex < 0) return Math.max(0, nodes.length - windowSize)
  return Math.max(0, Math.min(
    currentIndex - Math.floor(windowSize * 0.7),
    nodes.length - windowSize,
  ))
}

export function treeNodeSearchText(node: TreeNode, leafId?: string | null): string {
  return [
    node.summary,
    node.label,
    node.entryId,
    node.parentId,
    node.role,
    node.kind,
    node.displayClass,
    node.state,
    treeNodeBadge(node, leafId),
    treeNodeTime(node.timestamp),
  ].filter(Boolean).join(' ').toLowerCase()
}
