<script setup lang="ts">
import type { OperationContext } from '../lib/operationBinding'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, BookOpen, ChevronRight } from '@lucide/vue'
import {
  compactionPrompts, cloneSession, forkSession, listSessions, loadSessionTree, nameSession,
  navigateSession, newSession, reloadSession, switchSession,
  type SessionContext, type SessionTrustContinuation,
} from '../lib/bridge'
import { captureConnectionResult, hostResultMatches } from '../lib/hostResult'
import {
  countTreeFilters, currentOrEndTreeWindowStart, nearestVisibleTreeNodeId,
  persistTreeFilter, projectSessionTree, readTreeFilter, TREE_FILTERS,
  treeNodeBadge, treeNodeIcon, treeNodeRoleLabel, treeNodeTime,
  type TreeFilter, type VisibleTreeItem,
} from '../lib/sessionTree'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { useSavedSessionPages } from '../lib/savedSessions'
import MarkdownDocumentSurface from './MarkdownDocumentSurface.vue'
import SavedSessionList from './SavedSessionList.vue'
import type { CompactionPromptTemplatesResult, SessionReloadResult, SavedSession, SessionTree, Work } from '../lib/types'
import { useAppStore } from '../stores/app'
import { useControlPanelStore } from '../stores/control-panel'

type SessionMode = 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session'
const props = defineProps<{ work: Work; mode: SessionMode; compactionPending: boolean }>()
const app = useAppStore()
const emit = defineEmits<{
  unknown: [cause: unknown, domain: 'sessions' | 'tree', scope: SessionContext]
  finished: []
  compact: [customInstructions?: string]
  title: [title: string, body?: string]
  close: []
}>()

const loading = ref(false)
const pending = ref('')
const error = ref('')
const status = ref('')
const sessionPages = useSavedSessionPages()
const renameDraft = ref('')
const compactDraft = ref('')
const promptTemplates = ref<CompactionPromptTemplatesResult | null>(null)
const promptLoading = ref(false)
const promptError = ref('')
const promptReaderOpen = ref(false)
const promptSection = ref<keyof CompactionPromptTemplatesResult>('summarize')
const promptLink = ref<HTMLButtonElement | null>(null)
const promptBack = ref<HTMLButtonElement | null>(null)
let promptEpoch = 0
let targetRevision = 0
const promptSections = [
  { key: 'summarize', label: '首次摘要', description: '没有历史摘要时，用这份说明整理对话。' },
  { key: 'update', label: '更新摘要', description: '已有摘要时，将新增对话整合进摘要。' },
  { key: 'system', label: '系统说明', description: '模型执行摘要任务时遵循的系统说明。' },
  { key: 'turnPrefix', label: '分段摘要', description: '需要拆分一轮对话时，用于总结前半段。' },
] as const
const selectedPromptSection = computed(() => promptSections.find(section => section.key === promptSection.value)!)
async function openPromptReader() {
  promptReaderOpen.value = true
  if (!promptTemplates.value && !promptLoading.value) void loadPromptTemplates()
  await nextTick()
  promptBack.value?.focus()
}
async function closePromptReader() {
  promptReaderOpen.value = false
  await nextTick()
  promptLink.value?.focus()
}
onUnmounted(() => { promptEpoch++; loadEpoch++; targetRevision++; sessionPages.reset() })
async function loadPromptTemplates() {
  const epoch = ++promptEpoch
  const scope = { ...context.value }
  promptTemplates.value = null; promptError.value = ''; promptLoading.value = true
  try {
    const result = await currentSessionCall(scope, () => compactionPrompts(scope))
    if (epoch === promptEpoch && props.mode === 'compact-session') promptTemplates.value = result
  } catch (cause) { if (epoch === promptEpoch) promptError.value = errorMessage(cause) }
  finally { if (epoch === promptEpoch) promptLoading.value = false }
}
const reloadSummary = ref<SessionReloadResult | null>(null)
const reloadScope = ref<SessionContext | null>(null)
const trust = ref<(SessionTrustContinuation & { token: string; capture: OperationContext }) | null>(null)
const tree = ref<SessionTree | null>(null)
const treeSearch = ref('')
const treeFilter = ref<TreeFilter>(readTreeFilter(typeof window === 'undefined' ? null : window.localStorage))
const selectedNodeId = ref('')
const foldedNodeIds = ref<Set<string>>(new Set())
const treeWindowStart = ref(0)
const treeOptions = ref<HTMLElement | null>(null)
let loadEpoch = 0

const context = computed<SessionContext>(() => ({
  connectionId: app.connectionContext?.connectionId ?? '',
  selectionGeneration: app.connectionContext?.selectionGeneration ?? 0,
  instanceId: props.work.id,
  expectedHostEpoch: props.work.ownerHostEpoch ?? '',
  expectedRuntimeGeneration: props.work.runtimeGeneration,
}))
watch(() => JSON.stringify([app.connectionContext, props.work.id, props.work.ownerHostEpoch]), () => { targetRevision++ }, { flush: 'sync' })
class SessionCallFailure extends Error {
  constructor(readonly original: unknown, readonly scope: SessionContext, readonly current: boolean) { super(errorMessage(original)) }
}
async function currentSessionCall<T>(scope: SessionContext, operation: () => Promise<T>, replacementGeneration?: (result: T) => number): Promise<T> {
  const revision = targetRevision
  const matches = (generation = scope.expectedRuntimeGeneration) => revision === targetRevision
    && hostResultMatches(captureConnectionResult(scope, null), app.connectionContext)
    && scope.instanceId === props.work.id && scope.expectedHostEpoch === props.work.ownerHostEpoch
    && (scope.expectedRuntimeGeneration === props.work.runtimeGeneration || generation === props.work.runtimeGeneration)
  let result: T
  try { result = await operation() }
  catch (cause) { throw new SessionCallFailure(cause, scope, matches()) }
  if (!matches(replacementGeneration?.(result))) {
    throw new SessionCallFailure(new Error('你已切换 Host 或 Work，请在当前页面重试。'), scope, false)
  }
  return result
}
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
  () => app.activeConnectionId,
  () => app.connectionContext?.selectionGeneration,
  () => props.work.id,
  () => props.work.ownerHostEpoch,
  () => props.work.runtimeGeneration,
  () => props.mode,
], () => {
  // Reload's reply/resync may advance this same Work after the success UI renders.
  // Keep that receipt, but discard it for an actual target change or newer runtime.
  if (props.mode === 'reload-session' && reloadScope.value && reloadSummary.value
    && hostResultMatches(captureConnectionResult(reloadScope.value, null), app.connectionContext)
    && reloadScope.value.instanceId === props.work.id
    && reloadScope.value.expectedHostEpoch === props.work.ownerHostEpoch
    && reloadSummary.value.instance.runtimeGeneration === props.work.runtimeGeneration) return
  promptEpoch++; promptTemplates.value = null; promptError.value = ''; promptLoading.value = false
  promptReaderOpen.value = false; promptSection.value = 'summarize'
  reloadScope.value = null
  error.value = ''; status.value = ''; trust.value = null
  if (props.mode !== 'sessions') sessionPages.reset()
  if (props.mode === 'sessions') void loadSessionList()
  else if (props.mode === 'tree') void loadTree()
  else if (props.mode === 'new-session') void createNew()
  else if (props.mode !== 'compact-session') {
    renameDraft.value = props.work.name ?? ''
    reloadSummary.value = null
  }
}, { immediate: true })

async function loadSessionList(): Promise<boolean> {
  const epoch = ++loadEpoch; const scope = { ...context.value }
  const place = { machineHostId: props.work.hostId, cwd: props.work.cwd }
  error.value = ''
  try {
    const loaded = await sessionPages.load((cursor) => currentSessionCall(scope, () => listSessions(scope, place, cursor)))
    if (!loaded || epoch !== loadEpoch || scope.instanceId !== props.work.id || scope.expectedRuntimeGeneration !== props.work.runtimeGeneration) return false
    emit('title', '恢复 Session', `${sessionPages.total.value} 个可恢复的 Session`)
    renameDraft.value = props.work.name ?? ''
    return true
  } catch (cause) { if (epoch === loadEpoch) error.value = errorMessage(cause); return false }
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
  if (pending.value) return
  pending.value = 'new'; error.value = ''; status.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => newSession(app.captureOperation(scope, scope.instanceId), operationId()), (reply) => reply.instance.runtimeGeneration); if (!result.cancelled) emit('finished'); else status.value = 'Extension 已取消新建 Session。' }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}

async function resumeSelected(selected: Pick<SavedSession, 'token' | 'current'>, continuation?: SessionTrustContinuation) {
  if (selected.current || pending.value) return
  const attempt = continuation ?? { operationId: operationId() }
  let captured: OperationContext | undefined
  pending.value = 'switch'; error.value = ''; status.value = ''
  try {
    const scope = continuation && trust.value?.operationId === continuation.operationId
      ? trust.value.capture : app.captureOperation(context.value, context.value.instanceId)
    captured = scope
    const result = await currentSessionCall(scope, () => switchSession(scope, selected.token, attempt), (reply) => reply.instance.runtimeGeneration)
    trust.value = null
    if (!result.cancelled) emit('finished'); else status.value = 'Extension 已取消切换。'
  } catch (cause) {
    if (cause instanceof SessionCallFailure && !cause.current) { mutationFailure(cause, 'sessions'); return }
    const failure = (cause instanceof SessionCallFailure ? cause.original : cause) as { code?: string; details?: Record<string, unknown> }
    if (failure.code === 'project_trust_required') {
      const challenge = String(failure.details?.challengeId ?? '')
      const reported = String(failure.details?.operationId ?? '')
      if (challenge && captured && reported === attempt.operationId) trust.value = { token: selected.token, operationId: attempt.operationId, trustChallengeId: challenge, capture: captured }
      else error.value = 'Dock 返回的信任确认与当前操作对不上。请重试；若反复出现，请检查客户端和 Dock 版本。'
    } else mutationFailure(cause, 'sessions')
  } finally { pending.value = '' }
}

async function rename() {
  if (pending.value) return
  pending.value = 'rename'; error.value = ''
  try { const scope = { ...context.value }; await currentSessionCall(scope, () => nameSession(app.captureOperationTarget(scope, scope.instanceId), renameDraft.value, operationId())); emit('finished'); status.value = 'Session 名称已更新。'; await loadSessionList() }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}
function compact() {
  if (pending.value || props.compactionPending || props.work.compacting) return
  emit('compact', compactDraft.value.trim() || undefined)
}
async function reload() {
  if (pending.value) return
  pending.value = 'reload'; error.value = ''; status.value = ''; reloadSummary.value = null; reloadScope.value = null
  try {
    const scope = { ...context.value }
    // Accept only the generation returned by this Reload, not arbitrary replacements.
    const result = await currentSessionCall(scope, () => reloadSession(app.captureOperation(scope, scope.instanceId), operationId()), (reply) => reply.instance.runtimeGeneration)
    reloadScope.value = scope
    reloadSummary.value = result
    status.value = `Reload 完成：${result.resourceTotal} 个资源，${result.diagnosticTotal} 条诊断。`
    emit('finished')
  }
  catch (cause) { mutationFailure(cause, 'sessions') } finally { pending.value = '' }
}

async function navigate(summarize: boolean) {
  const node = selectedNode.value
  if (!node || pending.value) return
  pending.value = summarize ? 'navigate-summary' : 'navigate'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => navigateSession(app.captureOperation(scope, scope.instanceId), node.entryId, summarize, operationId()), (reply) => reply.instance.runtimeGeneration); if (!result.cancelled) emit('finished'); else status.value = result.aborted ? '切换已中止。' : 'Extension 已取消切换。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}
async function fork() {
  const node = selectedNode.value
  if (!node || node.role !== 'user' || pending.value) return
  pending.value = 'fork'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => forkSession(app.captureOperation(scope, scope.instanceId), node.entryId, operationId()), (reply) => reply.instance.runtimeGeneration); if (!result.cancelled) emit('finished'); else status.value = 'Extension 已取消 Fork。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}
async function clone() {
  const node = selectedNode.value
  if (!node || pending.value) return
  pending.value = 'clone'; error.value = ''
  try { const scope = { ...context.value }; const result = await currentSessionCall(scope, () => cloneSession(app.captureOperation(scope, scope.instanceId), node.entryId, operationId()), (reply) => reply.instance.runtimeGeneration); if (!result.cancelled) emit('finished'); else status.value = 'Extension 已取消 Clone。' }
  catch (cause) { mutationFailure(cause, 'tree') } finally { pending.value = '' }
}

function mutationFailure(cause: unknown, domain: 'sessions' | 'tree') {
  if (cause instanceof SessionCallFailure) {
    // Native retains this result independently; a late dialog error must not publish to another target.
    if (!cause.current) return
    const scope = cause.scope
    cause = cause.original
    if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, domain, scope)
  }
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
  if (domain === 'tree' && code === 'invalid_tree_target') {
    selectedNodeId.value = ''
    void loadTree().then((refreshed) => {
      if (refreshed) status.value = '原节点已发生变化。Session Tree 已更新，请重新选择。'
    })
    return
  }
  error.value = errorMessage(cause)
}
// An unconfirmed Session change is checked by reading the list or Tree shown here.
onUnmounted(useControlPanelStore().setSessionReloader((domain) => {
  if (domain === 'sessions' && props.mode === 'sessions') return loadSessionList()
  if (domain === 'tree' && props.mode === 'tree') return loadTree()
  return null
}))
function time(value?: string | null) { return treeNodeTime(value) }
</script>

<template>
  <div class="session-manager">
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="status" class="alu-dialog-status">{{ status }}</div>
    <div v-if="pending" class="alu-dialog-pending"><span class="alu-agent-activity-spinner" />正在处理…</div>
    <div v-if="loading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取 {{ mode === 'tree' ? 'Session Tree' : 'Session 列表' }}…</div>

    <section v-if="mode === 'sessions'" class="alu-session-select">
      <SavedSessionList
        :key="work.id"
        :sessions="sessionPages.sessions.value"
        :total="sessionPages.total.value"
        :show-directory="false"
        :loaded="sessionPages.loaded.value"
        :loading="sessionPages.loading.value"
        :loading-more="sessionPages.loadingMore.value"
        :more-failed="sessionPages.moreFailed.value"
        :incomplete="sessionPages.incomplete.value"
        :disabled="!!pending"
        empty-text="当前目录没有可恢复的 Session。"
        @select="resumeSelected"
        @retry="sessionPages.retryMore()"
      />
      <div v-if="trust" class="session-trust"><strong>这个项目需要你的信任确认</strong><p>确认后会继续恢复所选 Session。</p><div><button @click="trust = null">取消</button><button @click="resumeSelected({ token: trust.token, current: false }, { ...trust, projectTrustDecision: 'trust_once' })">仅本次信任</button><button class="session-primary" @click="resumeSelected({ token: trust.token, current: false }, { ...trust, projectTrustDecision: 'trust_and_remember' })">信任并切换</button></div></div>
    </section>

    <section v-else-if="mode === 'new-session'" class="alu-session-action-state">
      <span v-if="pending" class="alu-agent-activity-spinner" /><p>{{ pending ? '正在新建会话…' : status || '正在准备新 Session…' }}</p>
    </section>

    <section v-else-if="mode === 'rename-session'" class="alu-session-form">
      <input v-model="renameDraft" class="ui-dialog-input" maxlength="256" />
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="!!pending" @click="rename">{{ pending === 'rename' ? '正在提交…' : '确认' }}</button></div>
    </section>

    <section v-else-if="mode === 'compact-session'" class="compaction-panel">
      <template v-if="!promptReaderOpen">
        <div class="compaction-body">
          <p class="compaction-intro">将较早的对话整理为摘要，为后续对话腾出空间。</p>
          <div class="compaction-field">
            <label for="compaction-instructions">补充说明 <span>可选</span></label>
            <textarea id="compaction-instructions" v-model="compactDraft" class="ui-dialog-editor" rows="4" placeholder="例如：保留关键决策、未完成事项和相关文件路径。" aria-describedby="compaction-hint" :disabled="compactionPending || work.compacting" />
            <p id="compaction-hint" class="compaction-hint">留空使用默认提示；填写后作为补充，不替换默认提示。</p>
          </div>
          <button ref="promptLink" type="button" class="compaction-prompt-link" @click="openPromptReader"><BookOpen :size="16" /><span>查看默认压缩提示</span><span class="compaction-readonly">只读</span><ChevronRight :size="15" /></button>
          <div v-if="compactionPending || work.compacting" class="compaction-progress" role="status"><span class="alu-agent-activity-spinner" />正在压缩，进度与结果会显示在对话中。</div>
        </div>
        <div class="ui-dialog-form-footer compaction-footer"><button type="button" class="ui-dialog-btn" @click="$emit('close')">取消</button><button type="button" class="ui-dialog-btn ui-dialog-btn-primary" data-modal-initial :disabled="!!pending || compactionPending || work.compacting" @click="compact">{{ compactionPending || work.compacting ? '压缩中…' : '开始压缩' }}</button></div>
      </template>
      <section v-else class="compaction-reader" aria-label="默认压缩提示">
        <div class="compaction-reader-header"><button ref="promptBack" type="button" class="compaction-reader-back" @click="closePromptReader"><ArrowLeft :size="15" />返回压缩</button><span class="compaction-readonly">默认提示 · 只读</span></div>
        <p class="compaction-reader-note">这里是默认说明，不包含本次对话或已有摘要。扩展可以接管压缩。</p>
        <div class="compaction-prompt-sections" role="group" aria-label="选择提示类型"><button v-for="section in promptSections" :key="section.key" type="button" :aria-pressed="promptSection === section.key" @click="promptSection = section.key">{{ section.label }}</button></div>
        <p class="compaction-section-description">{{ selectedPromptSection.description }}</p>
        <div v-if="promptLoading" class="compaction-reader-state" role="status"><span class="alu-agent-activity-spinner" />正在读取默认提示…</div>
        <div v-else-if="promptError" class="compaction-reader-state compaction-reader-error" role="alert"><p>{{ promptError }}</p><button type="button" class="ui-dialog-btn" @click="loadPromptTemplates">重新读取</button></div>
        <MarkdownDocumentSurface v-else-if="promptTemplates" initial-mode="reading" :source="promptTemplates[promptSection]" :document-key="`${work.id}:${work.runtimeGeneration}:${promptSection}`" :aria-label="selectedPromptSection.label" />
      </section>
    </section>

    <section v-else-if="mode === 'reload-session'" class="alu-session-action-state alu-confirm-state">
      <div class="ui-dialog-form-footer"><button class="ui-dialog-btn" @click="$emit('close')">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" data-modal-initial :disabled="!!pending" @click="reload">{{ pending === 'reload' ? '正在重新载入…' : '确认' }}</button></div>
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
        <button type="button" class="ui-dialog-btn ui-dialog-btn-primary ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || !!pending" title="不生成分支摘要，直接切换到这里" @click="navigate(false)">直接切换</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.entryId === tree?.leafId || !!pending" title="先总结放弃的分支，再切换到这里" @click="navigate(true)">摘要后切换</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="selectedNode.kind !== 'message' || selectedNode.role !== 'user' || !!pending" title="回到这条用户消息之前，并将消息放回输入框" @click="fork">Fork</button>
        <button type="button" class="ui-dialog-btn ui-dialog-action-btn" :disabled="!!pending" title="从这个节点克隆为新的 Session" @click="clone">Clone</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ui-dialog-filters {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  overflow-x: auto;
  padding: 9px 16px;
  border-bottom: 1px solid var(--alu-border);
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.ui-dialog-filters::-webkit-scrollbar { display: none; }
.ui-dialog-filter {
  display: inline-flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--alu-border);
  border-radius: 999px;
  color: var(--alu-text-muted);
  font-size: 10px;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}
.ui-dialog-filter:hover { background: var(--alu-hover); color: var(--alu-text); }
.ui-dialog-filter.is-active { background: var(--alu-blue-bg); border-color: var(--alu-blue-border); color: var(--alu-blue); }
.ui-dialog-filter-count { color: var(--alu-text-faint); font-size: 8px; font-variant-numeric: tabular-nums; }
.ui-dialog-filter.is-active .ui-dialog-filter-count { color: currentColor; opacity: 0.72; }
.alu-tree-guidance {
  display: flex;
  min-height: 34px;
  flex: 0 0 auto;
  align-items: center;
  gap: 14px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--alu-border);
  color: var(--alu-text-faint);
  font-size: 9px;
}
.alu-tree-guidance > span:first-child { color: var(--alu-text-muted); }
.alu-tree-guidance kbd {
  min-width: 17px;
  padding: 1px 4px;
  border: 1px solid var(--alu-border-light);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--alu-surface);
  color: var(--alu-text-dim);
  font: inherit;
  text-align: center;
}
.alu-tree-guidance button { margin-left: auto; color: var(--alu-blue); font-size: inherit; }
.alu-tree-guidance button:hover { color: var(--alu-text); }
.alu-tree-options { overflow: auto; }
.alu-tree-option { grid-template-columns: max-content minmax(0, 1fr); }
@media (min-width: 641px) {
  .alu-tree-option { padding-left: 12px; }
}
.alu-tree-option.is-active-path:not(.is-current) .alu-tree-path-marker { color: var(--alu-blue); }
.alu-tree-marker {
  display: inline-flex;
  min-width: 22px;
  align-items: flex-start;
  padding-top: 0;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  line-height: 17px;
  text-align: left;
  white-space: pre;
}
.alu-tree-prefix { color: color-mix(in srgb, var(--alu-text-faint) 72%, transparent); }
.alu-tree-disclosure,
.alu-tree-disclosure-placeholder {
  display: inline-block;
  width: 14px;
  flex: 0 0 14px;
  text-align: center;
}
.alu-tree-disclosure {
  border-radius: 3px;
  color: var(--alu-blue);
  cursor: pointer;
  pointer-events: auto;
}
.alu-tree-disclosure:hover { background: var(--alu-blue-bg); color: var(--alu-text); }
.alu-tree-path-marker { display: inline-block; width: 12px; flex: 0 0 12px; text-align: center; }
.ui-dialog-window-btn { display: block; width: 100%; padding: 9px 12px; color: var(--alu-blue); font-size: 10px; text-align: center; }
.ui-dialog-window-btn:hover { background: var(--alu-blue-bg); }
.ui-dialog-selection-summary { min-width: 0; flex: 1; overflow: hidden; color: var(--alu-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.alu-tree-actions .ui-dialog-selection-summary { display: flex; flex-direction: column; gap: 2px; }
.alu-tree-actions .ui-dialog-selection-summary span { color: var(--alu-text-faint); font-size: 8px; letter-spacing: 0.08em; }
.alu-tree-actions .ui-dialog-selection-summary strong { overflow: hidden; color: var(--alu-text-dim); font-weight: 500; text-overflow: ellipsis; }
@media (max-width: 640px) {
  .ui-dialog-filters { padding: 8px 10px; }
  .ui-dialog-filter { min-height: 38px; padding: 7px 11px; }
  .alu-tree-guidance { padding: 7px 10px; }
  .alu-tree-guidance > span:nth-child(2) { display: none; }
  .ui-dialog-selection-summary { flex: 1 0 100%; }
  .ui-dialog-action-btn {
    min-height: 44px;
    flex: 1 1 calc(50% - 4px);
    text-align: center;
  }
}
.session-manager { position: relative; display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.reload-summary { display: grid; gap: 4px; padding: 9px; color: var(--c-text-2); font: 9px/1.5 var(--font-reading); background: var(--c-space-850); border-radius: 7px; }
.reload-summary span[data-severity='error'] { color: var(--c-danger); }
.reload-summary span[data-severity='warning'] { color: var(--c-amber); }
@media (max-width: 640px) {
  .session-manager { min-height: 0; flex: 1; }
}
.alu-session-select, .alu-tree-select { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow: hidden; }
.alu-session-action-state { display: grid; min-height: 240px; flex: 1; align-content: center; justify-items: center; gap: 12px; padding: 24px; color: var(--alu-text-muted); text-align: center; }
.alu-session-action-state.alu-confirm-state { display: block; min-height: 0; padding: 0; }
.compaction-panel { display: flex; min-width: 0; min-height: 0; flex-direction: column; color: var(--alu-text-dim); }
.compaction-body { display: flex; min-height: 0; flex-direction: column; gap: 20px; overflow-y: auto; padding: 20px; }
.compaction-intro { margin: 0; color: var(--alu-text-dim); font-size: 13px; line-height: 1.7; }
.compaction-field { display: flex; min-width: 0; flex-direction: column; gap: 9px; }
.compaction-field > label { display: flex; align-items: baseline; gap: 8px; color: var(--alu-text); font-size: 12px; font-weight: 600; }
.compaction-field > label > span { color: var(--alu-text-muted); font-size: 11px; font-weight: 400; }
.compaction-field > .ui-dialog-editor { width: 100%; min-height: 120px; margin: 0; padding: 12px 14px; resize: vertical; font-size: 12px; line-height: 1.65; }
.compaction-field > .ui-dialog-editor::placeholder { color: var(--alu-text-muted); }
.compaction-hint { margin: 0; color: var(--alu-text-muted); font-size: 11px; line-height: 1.6; }
.compaction-prompt-link { display: flex; min-height: 46px; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-bg); color: var(--alu-text-dim); text-align: left; font: inherit; font-size: 12px; }
.compaction-prompt-link > svg:first-child { color: var(--alu-blue); }
.compaction-prompt-link > span:first-of-type { flex: 1; }
.compaction-prompt-link > svg:last-child { color: var(--alu-text-muted); }
.compaction-prompt-link:hover, .compaction-prompt-link:focus-visible { outline: none; border-color: var(--alu-blue-border); background: var(--alu-hover); color: var(--alu-text); }
.compaction-readonly { flex-shrink: 0; color: var(--alu-text-muted); font-size: 10px; }
.compaction-progress { display: flex; align-items: center; gap: 8px; color: var(--alu-mint); font-size: 12px; line-height: 1.6; }
.compaction-footer { border-top: 1px solid var(--alu-border); }
.compaction-reader { display: flex; min-height: 0; height: min(64dvh, 560px); flex-direction: column; overflow: auto; }
.compaction-reader-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px 0; }
.compaction-reader-back { display: inline-flex; min-height: 36px; align-items: center; gap: 7px; padding: 0 4px; border: 0; border-radius: 5px; color: var(--alu-text-dim); background: transparent; font: inherit; font-size: 12px; }
.compaction-reader-back:hover, .compaction-reader-back:focus-visible { outline: none; color: var(--alu-blue); background: var(--alu-hover); }
.compaction-reader-note { flex-shrink: 0; margin: 6px 20px 14px; color: var(--alu-text-muted); font-size: 11px; line-height: 1.7; }
.compaction-prompt-sections { display: grid; flex-shrink: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin: 0 16px; padding: 4px; border: 1px solid var(--alu-border); border-radius: 9px; background: var(--alu-bg); }
.compaction-prompt-sections > button { min-width: 0; min-height: 40px; padding: 6px 3px; border: 1px solid transparent; border-radius: 6px; color: var(--alu-text-muted); background: transparent; font: inherit; font-size: 11px; }
.compaction-prompt-sections > button[aria-pressed="true"] { border-color: var(--alu-blue-border); color: var(--alu-text); background: var(--alu-active); }
.compaction-prompt-sections > button:hover, .compaction-prompt-sections > button:focus-visible { outline: none; color: var(--alu-text); background: var(--alu-hover); }
.compaction-section-description { flex-shrink: 0; margin: 10px 20px 14px; color: var(--alu-text-dim); font-size: 11px; line-height: 1.6; }
.compaction-reader > .markdown-document { min-height: 160px; flex: 1 1 auto; border-top: 1px solid var(--alu-border); }
.compaction-reader-state { display: flex; min-height: 160px; flex: 1; align-items: center; justify-content: center; gap: 9px; padding: 20px; color: var(--alu-text-muted); font-size: 12px; }
.compaction-reader-error { flex-direction: column; color: var(--alu-rose); text-align: center; }
.compaction-reader-error > p { margin: 0; line-height: 1.7; }
</style>
