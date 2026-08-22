<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  cloneSession, forkSession, listSessions, loadSessionTree, nameSession,
  navigateSession, newSession, reloadSession, switchSession,
  type SessionContext, type SessionTrustContinuation,
} from '../lib/bridge'
import { captureHostResult, hostResultMatches } from '../lib/hostResult'
import {
  countTreeFilters, currentOrEndTreeWindowStart, nearestVisibleTreeNodeId,
  persistTreeFilter, projectSessionTree, readTreeFilter, TREE_FILTERS,
  treeNodeBadge, treeNodeIcon, treeNodeRoleLabel, treeNodeTime,
  type TreeFilter, type VisibleTreeItem,
} from '../lib/sessionTree'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ResourcesResult, SessionInfo, SessionTree, Work } from '../lib/types'
import { useAppStore } from '../stores/app'

type SessionMode = 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session'
const props = defineProps<{ work: Work; mode: SessionMode; preview: boolean; outcomeUnknown: boolean; hasDraft: boolean; compactionPending: boolean }>()
const app = useAppStore()
const emit = defineEmits<{
  snapshot: [work: Work]
  unknown: [cause: unknown, domain: 'sessions' | 'tree']
  resync: [work: Work, draftText?: string]
  compact: [customInstructions?: string]
  title: [title: string, body?: string]
  close: []
}>()

const loading = ref(false)
const pending = ref('')
const error = ref('')
const status = ref('')
const sessionSearch = ref('')
const sessionScope = ref<'cwd' | 'all'>('cwd')
const sessions = ref<SessionInfo[]>([])
const sessionsTruncated = ref(false)
const selectedToken = ref('')
const renameDraft = ref('')
const compactDraft = ref('')
const reloadSummary = ref<ResourcesResult | null>(null)
const trust = ref<(SessionTrustContinuation & { token: string }) | null>(null)
const tree = ref<SessionTree | null>(null)
const treeSearch = ref('')
const treeFilter = ref<TreeFilter>(readTreeFilter(typeof window === 'undefined' ? null : window.localStorage))
const selectedNodeId = ref('')
const foldedNodeIds = ref<Set<string>>(new Set())
const treeWindowStart = ref(0)
const treeOptions = ref<HTMLElement | null>(null)
let loadEpoch = 0

const context = computed<SessionContext>(() => ({
  hostId: app.hostContext?.hostId ?? '',
  selectionGeneration: app.hostContext?.selectionGeneration ?? 0,
  instanceId: props.work.id,
  expectedHostEpoch: props.work.ownerHostEpoch ?? '',
  expectedRuntimeGeneration: props.work.runtimeGeneration,
}))
async function currentSessionCall<T>(scope: SessionContext, operation: () => Promise<T>): Promise<T> {
  const correlated = captureHostResult(scope, await operation())
  if (!hostResultMatches(correlated, app.hostContext)
    || scope.instanceId !== props.work.id
    || scope.expectedHostEpoch !== props.work.ownerHostEpoch
    || scope.expectedRuntimeGeneration !== props.work.runtimeGeneration) {
    throw new Error('你已切换 Host 或 Work，请在当前页面重试。')
  }
  return correlated.result
}
const selectedSession = computed(() => sessions.value.find((item) => item.token === selectedToken.value) ?? null)
const filteredSessions = computed(() => {
  const query = sessionSearch.value.trim().toLowerCase()
  return sessions.value.filter((item) => !query || `${item.name ?? ''} ${item.cwd}`.toLowerCase().includes(query))
})
const filterCounts = computed(() => countTreeFilters(tree.value?.nodes ?? [], tree.value?.leafId))
const visibleTreeItems = computed(() => projectSessionTree(
  tree.value?.nodes ?? [],
  tree.value?.leafId,
  treeFilter.value,
  treeSearch.value,
  foldedNodeIds.value,
))
const visibleTreeItemById = computed(() => new Map(visibleTreeItems.value.map((item) => [item.node.entryId, item])))
const filteredTreeNodes = computed(() => visibleTreeItems.value.map((item) => item.node))
const selectedNode = computed(() => visibleTreeItemById.value.get(selectedNodeId.value)?.node ?? null)
const treeWindowSize = 240
const treeWindowEnd = computed(() => Math.min(visibleTreeItems.value.length, treeWindowStart.value + treeWindowSize))
const windowedTreeItems = computed(() => visibleTreeItems.value.slice(treeWindowStart.value, treeWindowEnd.value))
const treeTabStopId = computed(() => windowedTreeItems.value.some((item) => item.node.entryId === selectedNodeId.value)
  ? selectedNodeId.value
  : windowedTreeItems.value[0]?.node.entryId ?? '')

watch([
  () => app.activeHostId,
  () => props.work.id,
  () => props.work.runtimeGeneration,
  () => props.mode,
], () => {
  error.value = ''; status.value = ''; trust.value = null
  if (props.mode === 'sessions') void loadSessionList()
  else if (props.mode === 'tree') void loadTree()
  else if (props.mode === 'new-session') void createNew()
  else {
    renameDraft.value = props.work.name ?? ''
    reloadSummary.value = null
  }
}, { immediate: true })

async function loadSessionList(): Promise<boolean> {
  const epoch = ++loadEpoch; const scope = { ...context.value }
  loading.value = true; error.value = ''
  try {
    const result = await currentSessionCall(scope, () => listSessions(scope, sessionScope.value))
    if (epoch !== loadEpoch || scope.instanceId !== props.work.id || scope.expectedRuntimeGeneration !== props.work.runtimeGeneration) return false
    sessions.value = result.sessions; sessionsTruncated.value = result.truncated
    emit('title', '恢复 Session', result.truncated ? `当前显示 ${result.sessions.length} / ${result.total} 个 Session` : `${result.sessions.length} 个可恢复的 Session`)
    if (!sessions.value.some((item) => item.token === selectedToken.value)) selectedToken.value = sessions.value.find((item) => !item.current)?.token ?? sessions.value[0]?.token ?? ''
    renameDraft.value = props.work.name ?? ''
    return true
  } catch (cause) { if (epoch === loadEpoch) error.value = errorMessage(cause); return false }
  finally { if (epoch === loadEpoch) loading.value = false }
}

async function loadTree(): Promise<boolean> {
  const epoch = ++loadEpoch; const scope = { ...context.value }
  loading.value = true; error.value = ''
  try {
    const snapshot = await currentSessionCall(scope, () => loadSessionTree(scope))
    if (epoch !== loadEpoch || scope.instanceId !== props.work.id || scope.expectedRuntimeGeneration !== props.work.runtimeGeneration) return false
    tree.value = snapshot
    foldedNodeIds.value = new Set()
    selectedNodeId.value = snapshot.leafId ?? ''
    reconcileTreeSelection()
    updateTreeTitle()
    await positionTreeAtCurrentOrEnd()
    return true
  } catch (cause) { if (epoch === loadEpoch) error.value = errorMessage(cause); return false }
  finally { if (epoch === loadEpoch) loading.value = false }
}

watch(treeFilter, (filter) => persistTreeFilter(typeof window === 'undefined' ? null : window.localStorage, filter))
watch([treeSearch, treeFilter], () => {
  foldedNodeIds.value = new Set()
  reconcileTreeSelection()
  updateTreeTitle()
  if (treeSearch.value.trim()) void positionTreeAtStart()
  else void positionTreeAtCurrentOrEnd()
})

function updateTreeTitle() {
  if (!tree.value) return
  const filteredTotal = filterCounts.value[treeFilter.value]
  const visibleTotal = filteredTreeNodes.value.length
  const result = treeSearch.value.trim()
    ? `找到 ${visibleTotal} 个节点`
    : foldedNodeIds.value.size
      ? `显示 ${visibleTotal} / ${filteredTotal} 个节点`
      : `${visibleTotal} 个节点`
  const currentVisible = visibleTreeItems.value.some((item) => item.currentLeaf)
  const current = tree.value.leafId ? currentVisible ? ' · 当前分支已标记' : ' · 当前分支未显示' : ''
  emit('title', 'Session Tree', `${result}${current}`)
}
async function positionTreeAtStart() {
  treeWindowStart.value = 0
  await nextTick()
  if (treeOptions.value) treeOptions.value.scrollTop = 0
}
async function positionTreeAtCurrentOrEnd() {
  treeWindowStart.value = currentOrEndTreeWindowStart(
    filteredTreeNodes.value,
    selectedNodeId.value || tree.value?.leafId,
    treeWindowSize,
  )
  await nextTick()
  const options = treeOptions.value
  if (!options) return
  const current = options.querySelector<HTMLElement>('.ui-dialog-option.is-current')
  if (current) options.scrollTop = Math.max(0, current.offsetTop - (options.clientHeight - current.offsetHeight) / 2)
  else options.scrollTop = options.scrollHeight
}
function reconcileTreeSelection() {
  const visibleIds = new Set(visibleTreeItems.value.map((item) => item.node.entryId))
  const preferred = selectedNodeId.value || tree.value?.leafId
  selectedNodeId.value = nearestVisibleTreeNodeId(tree.value?.nodes ?? [], visibleIds, preferred)
    ?? visibleTreeItems.value.at(-1)?.node.entryId
    ?? ''
}
async function showPreviousTreeWindow() {
  treeWindowStart.value = Math.max(0, treeWindowStart.value - treeWindowSize)
  await nextTick()
  treeOptions.value?.scrollTo({ top: 0 })
}
async function showNextTreeWindow() {
  treeWindowStart.value = treeWindowEnd.value
  await nextTick()
  treeOptions.value?.scrollTo({ top: 0 })
}
function expandAllTreeBranches() {
  if (!foldedNodeIds.value.size) return
  foldedNodeIds.value = new Set()
  reconcileTreeSelection()
  updateTreeTitle()
}
function toggleTreeFold(item: VisibleTreeItem) {
  if (!item.foldable) return
  selectedNodeId.value = item.node.entryId
  const next = new Set(foldedNodeIds.value)
  if (next.has(item.node.entryId)) next.delete(item.node.entryId)
  else next.add(item.node.entryId)
  foldedNodeIds.value = next
  treeWindowStart.value = Math.min(treeWindowStart.value, Math.max(0, visibleTreeItems.value.length - treeWindowSize))
  updateTreeTitle()
}
async function selectAndRevealTreeNode(entryId: string) {
  const index = visibleTreeItems.value.findIndex((item) => item.node.entryId === entryId)
  if (index < 0) return
  selectedNodeId.value = entryId
  if (index < treeWindowStart.value || index >= treeWindowEnd.value) {
    treeWindowStart.value = Math.max(0, Math.min(index - Math.floor(treeWindowSize / 2), visibleTreeItems.value.length - treeWindowSize))
  }
  await nextTick()
  treeNodeButtons()[index - treeWindowStart.value]?.focus()
}
function treeNodeButtons(): HTMLButtonElement[] {
  return treeOptions.value ? Array.from(treeOptions.value.querySelectorAll<HTMLButtonElement>('button[data-tree-node]')) : []
}
function handleTreeSearchKeydown(event: KeyboardEvent) {
  const buttons = treeNodeButtons()
  if (event.key === 'ArrowDown' && buttons.length) {
    event.preventDefault(); buttons[0].focus()
  } else if (event.key === 'ArrowUp' && buttons.length) {
    event.preventDefault(); buttons[buttons.length - 1].focus()
  } else if (event.key === 'Enter' && filteredTreeNodes.value.length === 1 && buttons.length === 1) {
    event.preventDefault(); buttons[0].click(); buttons[0].focus()
  } else if (event.key === 'Escape') {
    event.preventDefault(); emit('close')
  }
}
function branchSegmentTarget(item: VisibleTreeItem, direction: 'up' | 'down'): string | undefined {
  const items = visibleTreeItems.value
  const byId = visibleTreeItemById.value
  let currentId = item.node.entryId
  if (direction === 'down') {
    while (true) {
      const children = byId.get(currentId)?.childIds ?? []
      if (!children.length) break
      currentId = children[0]!
      if (children.length > 1) break
    }
    return currentId
  }
  const selectedIndex = items.findIndex((candidate) => candidate.node.entryId === currentId)
  while (true) {
    const parentId = byId.get(currentId)?.parentId
    if (!parentId) break
    const parent = byId.get(parentId)
    if ((parent?.childIds.length ?? 0) > 1) {
      const currentIndex = items.findIndex((candidate) => candidate.node.entryId === currentId)
      if (currentIndex < selectedIndex) break
    }
    currentId = parentId
  }
  return currentId
}
function handleTreeNodeKeydown(event: KeyboardEvent) {
  const buttons = treeNodeButtons()
  const index = buttons.indexOf(event.currentTarget as HTMLButtonElement)
  const item = visibleTreeItemById.value.get(selectedNodeId.value)
  if (index < 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    const globalIndex = visibleTreeItems.value.findIndex((candidate) => candidate.node.entryId === selectedNodeId.value)
    const target = visibleTreeItems.value[(globalIndex + 1) % visibleTreeItems.value.length]
    if (target) void selectAndRevealTreeNode(target.node.entryId)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    const globalIndex = visibleTreeItems.value.findIndex((candidate) => candidate.node.entryId === selectedNodeId.value)
    const target = visibleTreeItems.value[(globalIndex - 1 + visibleTreeItems.value.length) % visibleTreeItems.value.length]
    if (target) void selectAndRevealTreeNode(target.node.entryId)
  } else if (event.key === 'ArrowLeft' && item) {
    event.preventDefault()
    if (event.ctrlKey || event.altKey) {
      const target = branchSegmentTarget(item, 'up')
      if (target) void selectAndRevealTreeNode(target)
    } else if (item.foldable && !item.folded) toggleTreeFold(item)
    else if (item.parentId) void selectAndRevealTreeNode(item.parentId)
  } else if (event.key === 'ArrowRight' && item) {
    event.preventDefault()
    if (event.ctrlKey || event.altKey) {
      const target = branchSegmentTarget(item, 'down')
      if (target) void selectAndRevealTreeNode(target)
    } else if (item.folded) toggleTreeFold(item)
    else if (item.childIds[0]) void selectAndRevealTreeNode(item.childIds[0])
  } else if (event.key === 'Home' && visibleTreeItems.value[0]) {
    event.preventDefault(); void selectAndRevealTreeNode(visibleTreeItems.value[0].node.entryId)
  } else if (event.key === 'End' && visibleTreeItems.value.at(-1)) {
    event.preventDefault(); void selectAndRevealTreeNode(visibleTreeItems.value.at(-1)!.node.entryId)
  } else if (event.key === 'Escape') {
    event.preventDefault(); emit('close')
  }
}
function operationId() { return crypto.randomUUID() }

async function createNew() {
  if (props.preview) { status.value = '浏览器预览仅作演示。'; return }
  if (pending.value || props.outcomeUnknown) return
  pending.value = 'new'; error.value = ''; status.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => newSession(scope, operationId())); if (!result.cancelled) emit('resync', result.instance); else status.value = 'Extension 已取消新建 Session。' }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}

async function resumeSelected(continuation?: SessionTrustContinuation) {
  const selected = selectedSession.value
  if (!selected || selected.current || props.preview || pending.value || props.outcomeUnknown) return
  const attempt = continuation ?? { operationId: operationId() }
  pending.value = 'switch'; error.value = ''; status.value = ''
  try {
    const scope = { ...context.value }
    const result = await currentSessionCall(scope, () => switchSession(scope, selected.token, attempt))
    trust.value = null
    if (!result.cancelled) emit('resync', result.instance); else status.value = 'Extension 已取消切换。'
  } catch (cause) {
    const failure = cause as { code?: string; details?: Record<string, unknown> }
    if (failure.code === 'project_trust_required') {
      const challenge = String(failure.details?.challengeId ?? '')
      const reported = String(failure.details?.operationId ?? '')
      if (challenge && reported === attempt.operationId) trust.value = { token: selected.token, operationId: attempt.operationId, trustChallengeId: challenge }
      else error.value = 'Dock 返回的信任确认与当前操作对不上。请重试；若反复出现，请检查客户端和 Dock 版本。'
    } else mutationFailure(cause, 'sessions')
  } finally { pending.value = '' }
}

async function rename() {
  if (props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'rename'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => nameSession(scope, renameDraft.value, operationId())); emit('snapshot', result.instance); status.value = 'Session 名称已更新。'; await loadSessionList() }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}
function compact() {
  if (props.preview || pending.value || props.outcomeUnknown || props.compactionPending || props.work.compacting) return
  emit('compact', compactDraft.value.trim() || undefined)
}
async function reload() {
  if (props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'reload'; error.value = ''; reloadSummary.value = null
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => reloadSession(scope, operationId())); reloadSummary.value = result; status.value = `Reload 完成：${result.resourceTotal} 个资源，${result.diagnosticTotal} 条诊断。`; emit('resync', result.instance) }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}

async function navigate(summarize: boolean) {
  const node = selectedNode.value
  if (!node || props.preview || pending.value || props.outcomeUnknown) return
  pending.value = summarize ? 'navigate-summary' : 'navigate'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => navigateSession(scope, node.entryId, summarize, operationId())); if (!result.cancelled) emit('resync', result.instance, result.editorText); else status.value = result.aborted ? '切换已中止。' : 'Extension 已取消切换。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}
async function fork() {
  const node = selectedNode.value
  if (!node || node.role !== 'user' || props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'fork'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => forkSession(scope, node.entryId, operationId())); if (!result.cancelled) emit('resync', result.instance, result.selectedText); else status.value = 'Extension 已取消 Fork。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}
async function clone() {
  const node = selectedNode.value
  if (!node || props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'clone'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => cloneSession(scope, node.entryId, operationId())); if (!result.cancelled) emit('resync', result.instance); else status.value = 'Extension 已取消 Clone。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}

function mutationFailure(cause: unknown, domain: 'sessions' | 'tree') {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
  if (domain === 'tree' && code === 'invalid_tree_target') {
    selectedNodeId.value = ''
    void loadTree().then((refreshed) => {
      if (refreshed) status.value = '原节点已发生变化。Session Tree 已更新，请重新选择。'
    })
    return
  }
  error.value = errorMessage(cause)
  if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, domain)
}
async function reconcileDomain(domain: 'sessions' | 'tree') { return domain === 'sessions' ? loadSessionList() : loadTree() }
defineExpose({ reconcileDomain })
function time(value?: string | null) { return treeNodeTime(value) }
</script>

<template>
  <div class="session-manager">
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="status" class="alu-dialog-status">{{ status }}</div>
    <div v-if="pending" class="alu-dialog-pending"><span class="alu-agent-activity-spinner" />正在处理…</div>
    <div v-if="loading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取 {{ mode === 'tree' ? 'Session Tree' : 'Session 列表' }}…</div>

    <section v-if="mode === 'sessions'" class="alu-session-select">
      <div class="ui-dialog-search-wrap"><input v-model="sessionSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称或目录…" /></div>
      <div class="ui-dialog-options">
        <button v-for="item in filteredSessions" :key="item.token" class="ui-dialog-option" :class="{ 'is-current': item.current }" :disabled="item.current || preview || !!pending || outcomeUnknown" @click="selectedToken = item.token; resumeSelected()">
          <span class="ui-dialog-option-marker">{{ item.current ? '●' : '•' }}</span>
          <span class="ui-dialog-option-content">
            <span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ item.name || '未命名 Session' }}</span><span v-if="item.current" class="ui-dialog-option-badge">当前</span></span>
            <span class="ui-dialog-option-detail"><span>{{ item.cwd }}</span><span class="ui-dialog-option-meta">{{ time(item.updatedAt) }}</span></span>
          </span>
        </button>
        <div v-if="!filteredSessions.length" class="ui-dialog-empty">当前目录没有可恢复的 session。</div>
      </div>
      <div v-if="sessionsTruncated" class="cmd-palette-footer">当前显示 {{ sessions.length }} 个 Session</div>
      <div v-if="trust" class="session-trust"><strong>这个项目需要你的信任确认</strong><p>确认后会继续恢复所选 Session。</p><div><button @click="trust = null">取消</button><button @click="resumeSelected({ ...trust, projectTrustDecision: 'trust_once' })">仅本次信任</button><button class="session-primary" @click="resumeSelected({ ...trust, projectTrustDecision: 'trust_and_remember' })">信任并切换</button></div></div>
    </section>

    <section v-else-if="mode === 'new-session'" class="alu-session-action-state">
      <span v-if="pending" class="alu-agent-activity-spinner" /><p>{{ pending ? '正在新建会话…' : status || '正在准备新 Session…' }}</p>
    </section>

    <section v-else-if="mode === 'rename-session'" class="alu-session-form">
      <input v-model="renameDraft" class="ui-dialog-input" maxlength="256" />
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown" @click="rename">{{ pending === 'rename' ? '正在提交…' : '确认' }}</button></div>
    </section>

    <section v-else-if="mode === 'compact-session'" class="alu-session-form">
      <div v-if="compactionPending || work.compacting" class="alu-dialog-status">上下文正在压缩；进度与结果会显示在对话中。</div>
      <textarea v-model="compactDraft" class="ui-dialog-editor" rows="6" placeholder="自定义说明（可选）" :disabled="compactionPending || work.compacting" />
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown || compactionPending || work.compacting" @click="compact">{{ compactionPending || work.compacting ? '压缩中…' : '开始压缩' }}</button></div>
    </section>

    <section v-else-if="mode === 'reload-session'" class="alu-session-action-state alu-confirm-state">
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown" @click="reload">{{ pending === 'reload' ? '正在重新载入…' : '确认' }}</button></div>
      <div v-if="reloadSummary" class="reload-summary"><strong>{{ reloadSummary.resourceTotal }} 个资源 · {{ reloadSummary.diagnosticTotal }} 条诊断</strong><span v-for="diagnostic in reloadSummary.diagnostics" :key="diagnostic.message" :data-severity="diagnostic.severity">{{ diagnostic.message }}</span></div>
    </section>

    <section v-else class="alu-tree-select">
      <div class="ui-dialog-filters" aria-label="Tree 筛选">
        <button
          v-for="filter in TREE_FILTERS"
          :key="filter.value"
          type="button"
          class="ui-dialog-filter"
          :class="{ 'is-active': treeFilter === filter.value }"
          :aria-pressed="treeFilter === filter.value"
          @click="treeFilter = filter.value"
        >{{ filter.label }}<span class="ui-dialog-filter-count">{{ filterCounts[filter.value] }}</span></button>
      </div>
      <div class="ui-dialog-search-wrap">
        <input
          v-model="treeSearch"
          type="search"
          autocomplete="off"
          class="ui-dialog-input ui-dialog-search"
          placeholder="搜索内容或标签…"
          aria-label="搜索 Session Tree"
          @keydown="handleTreeSearchKeydown"
        />
      </div>
      <div class="alu-tree-guidance">
        <span>单击节点进行选择，再从底部确认操作</span>
        <span><kbd>←</kbd><kbd>→</kbd> 父子节点 · <kbd>Ctrl/Alt</kbd> + <kbd>←</kbd><kbd>→</kbd> 分支段</span>
        <button v-if="foldedNodeIds.size" type="button" @click="expandAllTreeBranches">展开全部（{{ foldedNodeIds.size }}）</button>
      </div>
      <div ref="treeOptions" class="ui-dialog-options alu-tree-options" role="tree" aria-label="Session Tree 节点">
        <button v-if="treeWindowStart > 0" type="button" class="ui-dialog-window-btn" @click="showPreviousTreeWindow">显示前面的 {{ Math.min(treeWindowSize, treeWindowStart) }} 项</button>
        <button
          v-for="item in windowedTreeItems"
          :key="item.node.entryId"
          type="button"
          role="treeitem"
          data-tree-node
          class="ui-dialog-option alu-tree-option"
          :class="{ 'is-current': item.currentLeaf, 'is-active-path': item.activePath, 'is-selected': selectedNodeId === item.node.entryId }"
          :tabindex="treeTabStopId === item.node.entryId ? 0 : -1"
          :aria-current="item.currentLeaf ? 'true' : undefined"
          :aria-selected="selectedNodeId === item.node.entryId"
          :aria-expanded="item.foldable ? !item.folded : undefined"
          :aria-level="item.level"
          :aria-posinset="item.positionInSet"
          :aria-setsize="item.setSize"
          @focus="selectedNodeId = item.node.entryId"
          @click="selectedNodeId = item.node.entryId"
          @keydown="handleTreeNodeKeydown"
        >
          <span class="ui-dialog-option-marker alu-tree-marker" aria-hidden="true">
            <span class="alu-tree-prefix">{{ item.prefix }}</span>
            <span
              v-if="item.foldable"
              class="alu-tree-disclosure"
              :title="item.folded ? '展开这个分支段' : '折叠这个分支段'"
              @click.stop="toggleTreeFold(item)"
            >{{ item.folded ? '▸' : '▾' }}</span>
            <span v-else class="alu-tree-disclosure-placeholder" />
            <span class="alu-tree-path-marker">{{ item.currentLeaf ? '●' : item.activePath ? '•' : treeNodeIcon(item.node) }}</span>
          </span>
          <span class="ui-dialog-option-content">
            <span class="ui-dialog-option-top">
              <span class="ui-dialog-option-label">{{ item.node.summary || item.node.label || item.node.kind }}</span>
              <span v-if="item.branchPoint" class="ui-dialog-option-badge alu-tree-branch-badge">分叉 · {{ item.childIds.length }}</span>
              <span v-if="treeNodeBadge(item.node, tree?.leafId)" class="ui-dialog-option-badge" :data-state="item.currentLeaf ? 'current' : item.node.state">{{ treeNodeBadge(item.node, tree?.leafId) }}</span>
            </span>
            <span class="ui-dialog-option-detail">
              <span>{{ [item.node.label ? `[${item.node.label}]` : '', treeNodeRoleLabel(item.node)].filter(Boolean).join(' · ') }}</span>
              <span v-if="time(item.node.timestamp)" class="ui-dialog-option-meta">{{ time(item.node.timestamp) }}</span>
            </span>
          </span>
        </button>
        <button v-if="treeWindowEnd < filteredTreeNodes.length" type="button" class="ui-dialog-window-btn" @click="showNextTreeWindow">显示后面的 {{ Math.min(treeWindowSize, filteredTreeNodes.length - treeWindowEnd) }} 项</button>
        <div v-if="tree && tree.nodes.length === 0" class="ui-dialog-empty">当前 Session Tree 为空。</div>
        <div v-else-if="tree && !filteredTreeNodes.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
      <div v-if="selectedNode" class="ui-dialog-actions alu-tree-actions">
        <div class="ui-dialog-selection-summary"><span>已选择</span><strong>{{ selectedNode.summary || selectedNode.label || selectedNode.kind }}</strong></div>
        <button type="button" class="ui-dialog-btn ui-dialog-btn-primary ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || preview || !!pending || outcomeUnknown" title="不生成分支摘要，直接切换到这里" @click="navigate(false)">直接切换</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || preview || !!pending || outcomeUnknown" title="先总结放弃的分支，再切换到这里" @click="navigate(true)">摘要后切换</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.kind !== 'message' || selectedNode.role !== 'user' || preview || !!pending || outcomeUnknown" title="回到这条用户消息之前，并将消息放回输入框" @click="fork">Fork</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="preview || !!pending || outcomeUnknown" title="从这个节点克隆为新的 Session" @click="clone">Clone</button>
      </div>
    </section>
  </div>
</template>
