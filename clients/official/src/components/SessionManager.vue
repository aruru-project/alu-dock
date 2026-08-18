<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  cloneSession, compactSession, forkSession, listSessions, loadSessionTree, nameSession,
  navigateSession, newSession, reloadSession, switchSession,
  type SessionContext, type SessionTrustContinuation,
} from '../lib/bridge'
import { captureHostResult, hostResultMatches } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ResourcesResult, SessionInfo, SessionTreePage, TreeNode, Work } from '../lib/types'
import { useAppStore } from '../stores/app'

type SessionMode = 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session'
const props = defineProps<{ work: Work; mode: SessionMode; preview: boolean; outcomeUnknown: boolean; hasDraft: boolean }>()
const app = useAppStore()
const emit = defineEmits<{
  snapshot: [work: Work]
  unknown: [cause: unknown, domain: 'sessions' | 'tree']
  resync: [work: Work, draftText?: string]
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
const tree = ref<SessionTreePage | null>(null)
const treeSearch = ref('')
const treeFilter = ref<'all' | 'conversation' | 'user' | 'agent' | 'no-tools' | 'labeled'>('all')
const selectedNodeId = ref('')
const treeWindowStart = ref(0)
const summaryInstructions = ref('')
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
    throw new Error('Host 或 Work 选择已改变；旧结果已丢弃。')
  }
  return correlated.result
}
const selectedSession = computed(() => sessions.value.find((item) => item.token === selectedToken.value) ?? null)
const filteredSessions = computed(() => {
  const query = sessionSearch.value.trim().toLowerCase()
  return sessions.value.filter((item) => !query || `${item.name ?? ''} ${item.cwd} ${item.identity}`.toLowerCase().includes(query))
})
const selectedNode = computed(() => tree.value?.nodes.find((node) => node.entryId === selectedNodeId.value) ?? null)
const filterCounts = computed(() => {
  const nodes = tree.value?.nodes ?? []
  return {
    all: nodes.length,
    conversation: nodes.filter((node) => node.displayClass === 'content').length,
    user: nodes.filter((node) => node.role === 'user').length,
    agent: nodes.filter((node) => node.role === 'assistant').length,
    'no-tools': nodes.filter((node) => node.role !== 'tool').length,
    labeled: nodes.filter((node) => !!node.label).length,
  }
})
const filteredTreeNodes = computed(() => {
  const query = treeSearch.value.trim().toLowerCase()
  return (tree.value?.nodes ?? []).filter((node) => {
    const filter = treeFilter.value
    const passes = filter === 'all'
      || (filter === 'conversation' && node.kind === 'message' && (node.role === 'user' || node.role === 'assistant'))
      || (filter === 'user' && node.kind === 'message' && node.role === 'user')
      || (filter === 'agent' && node.kind === 'message' && node.role === 'assistant')
      || (filter === 'no-tools' && node.displayClass === 'content')
      || (filter === 'labeled' && !!node.label)
    return passes && (!query || `${node.summary} ${node.label ?? ''} ${node.entryId} ${node.parentId ?? ''} ${node.role} ${node.kind}`.toLowerCase().includes(query))
  })
})
const treeWindowSize = 240
const treeWindowEnd = computed(() => Math.min(filteredTreeNodes.value.length, treeWindowStart.value + treeWindowSize))
const windowedTreeNodes = computed(() => filteredTreeNodes.value.slice(treeWindowStart.value, treeWindowEnd.value))
const treeDepths = computed(() => projectTreeDepths(filteredTreeNodes.value, tree.value?.nodes ?? []))

watch(() => [app.activeHostId, props.work.id, props.work.runtimeGeneration, props.mode] as const, () => {
  error.value = ''; status.value = ''; trust.value = null
  if (props.mode === 'sessions') void loadSessionList()
  else if (props.mode === 'tree') void loadTree(true)
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

async function loadTree(reset: boolean): Promise<boolean> {
  const epoch = ++loadEpoch; const scope = { ...context.value }
  loading.value = true; error.value = ''
  try {
    const current = reset ? null : tree.value
    const page = await currentSessionCall(scope, () => loadSessionTree(scope, current?.treeRevision, current?.nextAfterEntryId))
    if (epoch !== loadEpoch || scope.instanceId !== props.work.id || scope.expectedRuntimeGeneration !== props.work.runtimeGeneration) return false
    if (reset) {
      tree.value = page
      emit('title', 'Session Tree', page.truncated ? `当前显示 ${page.nodes.length} / ${page.total} 个节点` : `${page.nodes.length} 个节点 · 当前分支已标记`)
      selectedNodeId.value = page.leafId ?? ''
      const currentIndex = page.nodes.findIndex((node) => node.entryId === page.leafId)
      treeWindowStart.value = Math.max(0, currentIndex - Math.floor(treeWindowSize * 0.7))
    } else if (current && page.treeRevision === current.treeRevision) {
      const ids = new Set(current.nodes.map((node) => node.entryId))
      if (page.nodes.some((node) => ids.has(node.entryId))) throw new Error('Dock 返回了重复的 Tree 节点。')
      tree.value = { ...page, nodes: [...current.nodes, ...page.nodes] }
    }
    return true
  } catch (cause) { if (epoch === loadEpoch) error.value = errorMessage(cause); return false }
  finally { if (epoch === loadEpoch) loading.value = false }
}

watch([treeSearch, treeFilter], () => { treeWindowStart.value = 0 })

function locateLeaf() {
  if (!tree.value?.leafId) return
  selectedNodeId.value = tree.value.leafId
  const index = filteredTreeNodes.value.findIndex((node) => node.entryId === tree.value?.leafId)
  if (index >= 0) treeWindowStart.value = Math.max(0, index - Math.floor(treeWindowSize * 0.7))
}
function showPreviousTreeWindow() { treeWindowStart.value = Math.max(0, treeWindowStart.value - treeWindowSize) }
function showNextTreeWindow() { treeWindowStart.value = treeWindowEnd.value }
function operationId() { return crypto.randomUUID() }

async function createNew() {
  if (props.preview) { status.value = '浏览器预览不会创建 Session。'; return }
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
      else error.value = 'Dock 的信任继续信息与当前操作不匹配。'
    } else mutationFailure(cause, 'sessions')
  } finally { pending.value = '' }
}

async function rename() {
  if (props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'rename'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => nameSession(scope, renameDraft.value, operationId())); emit('snapshot', result.instance); status.value = 'Session 名称已更新。'; await loadSessionList() }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}
async function compact() {
  if (props.preview || pending.value || props.outcomeUnknown) return
  pending.value = 'compact'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => compactSession(scope, compactDraft.value.trim() || undefined, operationId())); emit('snapshot', result.instance); status.value = `已压缩：${result.result.summary} · 压缩前 ${result.result.tokensBefore.toLocaleString()} tokens`; compactDraft.value = ''; emit('resync', result.instance) }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
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
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => navigateSession(scope, node.entryId, summarize, summarize ? summaryInstructions.value.trim() || undefined : undefined, operationId())); if (!result.cancelled) emit('resync', result.instance, result.editorText); else status.value = result.aborted ? '切换已中止。' : 'Extension 已取消切换。' }
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

function mutationFailure(cause: unknown, domain: 'sessions' | 'tree') { error.value = errorMessage(cause); if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, domain) }
async function reconcileDomain(domain: 'sessions' | 'tree') { return domain === 'sessions' ? loadSessionList() : loadTree(true) }
defineExpose({ reconcileDomain })
function roleLabel(node: TreeNode) { return node.role === 'user' ? '用户' : node.role === 'assistant' ? 'Agent' : node.role === 'tool' ? '工具' : node.kind }
function treeIcon(node: TreeNode) { return node.entryId === tree.value?.leafId ? '●' : node.depth > 0 ? '└' : '•' }
function time(value?: string) { return value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '' }

function projectTreeDepths(visibleNodes: TreeNode[], allNodes: TreeNode[]) {
  const allById = new Map(allNodes.map((node) => [node.entryId, node]))
  const visibleById = new Map(visibleNodes.map((node) => [node.entryId, node]))
  const parentById = new Map<string, string | undefined>()
  const childCount = new Map<string, number>()
  const nearestVisibleAncestor = new Map<string, string | undefined>()
  const visibleAncestorFor = (startId?: string): string | undefined => {
    if (!startId) return undefined
    if (visibleById.has(startId)) return startId
    const path: string[] = []
    const seen = new Set<string>()
    let cursor: string | undefined = startId
    while (cursor && !visibleById.has(cursor) && !nearestVisibleAncestor.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); path.push(cursor); cursor = allById.get(cursor)?.parentId
    }
    const result = cursor && visibleById.has(cursor) ? cursor : cursor ? nearestVisibleAncestor.get(cursor) : undefined
    for (const id of path) nearestVisibleAncestor.set(id, result)
    return result
  }
  for (const node of visibleNodes) {
    const parent = visibleAncestorFor(node.parentId)
    parentById.set(node.entryId, parent)
    if (parent) childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
  }
  const depthById = new Map<string, number>()
  const depthFor = (entryId: string) => {
    if (depthById.has(entryId)) return depthById.get(entryId) ?? 0
    const path: string[] = []
    const seen = new Set<string>()
    let cursor: string | undefined = entryId
    while (cursor && !depthById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); path.push(cursor); cursor = parentById.get(cursor)
    }
    while (path.length) {
      const id = path.pop()!
      const parent = parentById.get(id)
      const parentDepth = parent ? depthById.get(parent) ?? 0 : 0
      depthById.set(id, Math.min(parentDepth + (parent && (childCount.get(parent) ?? 0) > 1 ? 1 : 0), 12))
    }
    return depthById.get(entryId) ?? 0
  }
  return new Map(visibleNodes.map((node) => [node.entryId, depthFor(node.entryId)]))
}
</script>

<template>
  <div class="session-manager">
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="status" class="alu-dialog-status">{{ status }}</div>
    <div v-if="pending" class="alu-dialog-pending"><span class="alu-agent-activity-spinner" />正在处理…</div>
    <div v-if="loading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取 {{ mode === 'tree' ? 'Session Tree' : 'Session 列表' }}…</div>

    <section v-if="mode === 'sessions'" class="alu-session-select">
      <div class="ui-dialog-search-wrap"><input v-model="sessionSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
      <div class="ui-dialog-options">
        <button v-for="item in filteredSessions" :key="item.token" class="ui-dialog-option" :class="{ 'is-current': item.current }" :disabled="item.current || preview || !!pending || outcomeUnknown" @click="selectedToken = item.token; resumeSelected()">
          <span class="ui-dialog-option-marker">{{ item.current ? '●' : '•' }}</span>
          <span class="ui-dialog-option-content">
            <span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ item.name || item.identity }}</span><span v-if="item.current" class="ui-dialog-option-badge">CURRENT</span></span>
            <span class="ui-dialog-option-detail"><span>{{ item.cwd }}</span><span class="ui-dialog-option-meta">{{ time(item.updatedAt) }} · {{ item.identity }}</span></span>
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
      <textarea v-model="compactDraft" class="ui-dialog-editor" rows="6" placeholder="自定义说明（可选）" />
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown" @click="compact">{{ pending === 'compact' ? '正在提交…' : '确认' }}</button></div>
    </section>

    <section v-else-if="mode === 'reload-session'" class="alu-session-action-state alu-confirm-state">
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown" @click="reload">{{ pending === 'reload' ? '正在重新载入…' : '确认' }}</button></div>
      <div v-if="reloadSummary" class="reload-summary"><strong>{{ reloadSummary.resourceTotal }} 个资源 · {{ reloadSummary.diagnosticTotal }} 条诊断</strong><span v-for="diagnostic in reloadSummary.diagnostics" :key="diagnostic.message" :data-severity="diagnostic.severity">{{ diagnostic.message }}</span></div>
    </section>

    <section v-else class="alu-tree-select">
      <div class="ui-dialog-search-wrap"><input v-model="treeSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
      <div class="ui-dialog-filters" aria-label="Tree 筛选">
        <button v-for="filter in (['all','conversation','user','agent','no-tools','labeled'] as const)" :key="filter" class="ui-dialog-filter" :class="{ 'is-active': treeFilter === filter }" @click="treeFilter = filter">{{ ({ all: '全部', conversation: '对话', user: '用户', agent: 'Agent', 'no-tools': '无工具', labeled: '已标记' } as const)[filter] }}<span class="ui-dialog-filter-count">{{ filterCounts[filter] }}</span></button>
      </div>
      <div class="ui-dialog-options">
        <button v-if="treeWindowStart > 0" class="ui-dialog-window-btn" @click="showPreviousTreeWindow">显示前面的 {{ Math.min(treeWindowSize, treeWindowStart) }} 项</button>
        <button v-for="node in windowedTreeNodes" :key="node.entryId" class="ui-dialog-option" :class="{ 'is-current': node.entryId === tree?.leafId, 'is-selected': selectedNodeId === node.entryId }" :style="{ '--option-indent': `${(treeDepths.get(node.entryId) ?? 0) * 16}px` }" @click="selectedNodeId = node.entryId">
          <span class="ui-dialog-option-marker">{{ treeIcon(node) }}</span>
          <span class="ui-dialog-option-content">
            <span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ node.summary || node.label || node.kind }}</span><span v-if="node.entryId === tree?.leafId" class="ui-dialog-option-badge">CURRENT</span></span>
            <span class="ui-dialog-option-detail"><span>{{ [node.label ? `[${node.label}]` : '', roleLabel(node), node.entryId].filter(Boolean).join(' · ') }}</span><span class="ui-dialog-option-meta">{{ time(node.timestamp) }}</span></span>
          </span>
        </button>
        <button v-if="treeWindowEnd < filteredTreeNodes.length" class="ui-dialog-window-btn" @click="showNextTreeWindow">显示后面的 {{ Math.min(treeWindowSize, filteredTreeNodes.length - treeWindowEnd) }} 项</button>
        <button v-else-if="tree?.truncated" class="ui-dialog-window-btn" :disabled="loading" @click="loadTree(false)">加载更多节点</button>
        <div v-if="tree && !filteredTreeNodes.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
      <div v-if="selectedNode" class="ui-dialog-actions">
        <div class="ui-dialog-selection-summary">{{ selectedNode.summary || selectedNode.label || selectedNode.kind }}</div>
        <button class="ui-dialog-btn ui-dialog-btn-primary ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || preview || !!pending || outcomeUnknown" title="不生成分支摘要，直接切换到这里" @click="navigate(false)">直接切换</button>
        <button class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || preview || !!pending || outcomeUnknown" title="先总结放弃的分支，再切换到这里" @click="navigate(true)">摘要后切换</button>
        <button class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.kind !== 'message' || selectedNode.role !== 'user' || preview || !!pending || outcomeUnknown" title="回到这条用户消息之前，并将消息放回输入框" @click="fork">Fork</button>
        <button class="ui-dialog-btn ui-dialog-action-btn" :disabled="preview || !!pending || outcomeUnknown" title="从这个节点克隆为新的 Session" @click="clone">Clone</button>
      </div>
    </section>
  </div>
</template>
