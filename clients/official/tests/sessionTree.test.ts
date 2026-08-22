import { strict as assert } from 'node:assert'
import {
  activeFirstTreeNodes, countTreeFilters, currentOrEndTreeWindowStart, nearestVisibleTreeNodeId,
  persistTreeFilter, projectSessionTree, readTreeFilter,
  treeNodeBadge, treeNodeIcon, treeNodeMatchesFilter, treeNodeSearchText, treeNodeTime,
} from '../src/lib/sessionTree.ts'
import type { TreeNode } from '../src/lib/types.ts'

const nodes: TreeNode[] = [
  node('user', { role: 'user', kind: 'message', displayClass: 'content' }),
  node('assistant', { role: 'assistant', kind: 'message', displayClass: 'content' }),
  node('tool', { role: 'tool', kind: 'message', displayClass: 'tool' }),
  node('custom-content', { kind: 'custom', displayClass: 'content' }),
  node('model-change', { kind: 'model_change', displayClass: 'metadata', label: 'checkpoint' }),
  node('current-structural', { kind: 'session_info', displayClass: 'structural', label: null }),
]
const leafId = 'current-structural'

const counts = countTreeFilters(nodes, leafId)
assert.deepEqual(counts, {
  default: 5,
  'no-tools': 4,
  'user-only': 1,
  'labeled-only': 1,
  all: 6,
}, 'each Tree filter count describes exactly the nodes shown by that filter')
assert.equal(treeNodeMatchesFilter(nodes[4], 'default', leafId), false, 'metadata such as model changes stays out of the default Tree view')
assert.equal(treeNodeMatchesFilter(nodes[4], 'all', leafId), true, 'the complete protocol topology remains available in the all-nodes view')

const branchTree = [
  node('root', { hasChildren: true }),
  node('older-branch', { parentId: 'root', depth: 1, hasChildren: true }),
  node('older-leaf', { parentId: 'older-branch', depth: 2 }),
  node('active-branch', { parentId: 'root', depth: 1, hasChildren: true }),
  node('current-leaf', { parentId: 'active-branch', depth: 2 }),
]
assert.deepEqual(
  activeFirstTreeNodes(branchTree, 'current-leaf').map((item) => item.entryId),
  ['root', 'active-branch', 'current-leaf', 'older-branch', 'older-leaf'],
  'the current branch is ordered before sibling branches without changing the protocol snapshot',
)

const projectedTopology: TreeNode[] = [
  node('root', { parentId: null, role: 'user', kind: 'message', displayClass: 'content', hasChildren: true }),
  node('wrapper-a', { parentId: 'root', depth: 1, role: 'assistant', kind: 'message', displayClass: 'structural', hasChildren: true }),
  node('tool-a', { parentId: 'wrapper-a', depth: 2, role: 'tool', kind: 'message', displayClass: 'tool', hasChildren: true }),
  node('leaf-a', { parentId: 'tool-a', depth: 3, role: 'assistant', kind: 'message', displayClass: 'content' }),
  node('user-b', { parentId: 'root', depth: 1, role: 'user', kind: 'message', displayClass: 'content', hasChildren: true }),
  node('error-b', { parentId: 'user-b', depth: 2, role: 'assistant', kind: 'message', displayClass: 'content', state: 'error' }),
]
const projection = projectSessionTree(projectedTopology, 'error-b', 'default', '', new Set())
assert.deepEqual(
  projection.map((item) => item.node.entryId),
  ['root', 'user-b', 'error-b', 'tool-a', 'leaf-a'],
  'the graphical Tree uses the TUI projection: active branch first and hidden structural wrappers reattached',
)
const projectedTool = projection.find((item) => item.node.entryId === 'tool-a')!
assert.equal(projectedTool.parentId, 'root')
assert.deepEqual(
  { level: projectedTool.level, positionInSet: projectedTool.positionInSet, setSize: projectedTool.setSize },
  { level: 2, positionInSet: 2, setSize: 2 },
  'the flat DOM projection retains complete tree hierarchy for assistive technology',
)
assert.equal(projection.find((item) => item.node.entryId === 'root')?.branchPoint, true, 'the projected parent exposes a real selectable branch point')
assert.match(projection.find((item) => item.node.entryId === 'user-b')?.prefix ?? '', /├|└/, 'branch rows receive visible connector geometry')
const folded = projectSessionTree(projectedTopology, 'error-b', 'default', '', new Set(['user-b']))
assert.deepEqual(folded.map((item) => item.node.entryId), ['root', 'user-b', 'tool-a', 'leaf-a'], 'folding retains the selected branch node and hides only its descendants')
const nestedBranch = [
  node('linear-root', { kind: 'message', role: 'user', displayClass: 'content', hasChildren: true }),
  node('branch-point', { parentId: 'linear-root', depth: 1, kind: 'message', role: 'assistant', displayClass: 'content', hasChildren: true }),
  node('branch-current', { parentId: 'branch-point', depth: 2, kind: 'message', role: 'user', displayClass: 'content' }),
  node('branch-other', { parentId: 'branch-point', depth: 2, kind: 'message', role: 'user', displayClass: 'content' }),
]
assert.equal(
  projectSessionTree(nestedBranch, 'branch-current', 'default', '', new Set()).find((item) => item.node.entryId === 'branch-point')?.foldable,
  true,
  'a nested branch point can be collapsed directly in the graphical client',
)
const userOnly = projectSessionTree(projectedTopology, 'error-b', 'user-only', '', new Set())
assert.equal(
  nearestVisibleTreeNodeId(projectedTopology, new Set(userOnly.map((item) => item.node.entryId)), 'error-b'),
  'user-b',
  'a filter change selects the nearest still-visible ancestor instead of losing the branch context',
)

const failed = node('failed', {
  role: 'assistant', kind: 'message', displayClass: 'content', state: 'error',
  timestamp: '2026-08-18T16:39:54Z', summary: '模型调用失败',
})
assert.equal(treeNodeIcon(failed), '×', 'failed nodes remain visually distinguishable from ordinary Agent messages')
assert.equal(treeNodeBadge(failed), '错误')
assert.equal(treeNodeBadge(failed, failed.entryId), '当前', 'the current-branch marker takes precedence over a state badge')
assert.match(treeNodeSearchText(failed), /error/, 'a visible state badge is searchable')
assert.equal(treeNodeTime('not-a-date'), 'not-a-date', 'an unusual Dock timestamp cannot crash Tree rendering')

const longTree = Array.from({ length: 500 }, (_, index) => node(`node-${index}`, {}))
assert.equal(currentOrEndTreeWindowStart(longTree, 'node-350', 240), 182, 'opening Tree puts the current branch inside the first visible window')
assert.equal(currentOrEndTreeWindowStart(longTree, undefined, 240), 260, 'without a current marker Tree opens at its newest available window')

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
}
persistTreeFilter(storage, 'user-only')
assert.equal(readTreeFilter(storage), 'user-only', 'the chosen Tree filter survives reopening the dialog')
values.set('aludock.session-tree-filter', 'removed-filter')
assert.equal(readTreeFilter(storage), 'default', 'an obsolete saved filter falls back to the useful default view')

function node(entryId: string, overrides: Partial<TreeNode>): TreeNode {
  return {
    entryId,
    depth: 0,
    kind: 'custom',
    displayClass: 'structural',
    summary: entryId,
    hasChildren: false,
    ...overrides,
  }
}
