<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { FolderOpen, History, RotateCcw } from '@lucide/vue'
import {
  adoptSession,
  createWork,
  isTauri,
  listSessionInventory,
  listWorkspace,
  type CreateWorkContinuation,
} from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import {
  defaultMachineHostId,
  machineDisplayLabel,
  machineSelectorVisible,
  machineWorkspaceRoots,
  machineWorkspaceRootSelectorVisible,
  machineWorkspaceStart,
  workspaceChildPath,
} from '../lib/machines'
import { treeNodeTime } from '../lib/sessionTree'
import type { MachineDto, SessionInventoryInfo, SessionInventoryResult, Work, WorkspacePage } from '../lib/types'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { useAppStore } from '../stores/app'
import AluSelect from './AluSelect.vue'

type View = 'launcher' | 'browse' | 'sessions'
type TrustAttempt = {
  kind: 'create' | 'adopt'
  operationId: string
  trustChallengeId: string
  machineHostId: string
  path?: string
  sessionToken?: string
}

const props = defineProps<{
  machines: MachineDto[]
  machinesLoading: boolean
  machineError?: string
  preview: boolean
  outcomeUnknown: boolean
}>()
const emit = defineEmits<{
  close: []
  created: [work: Work]
  unknown: [cause: unknown]
  busy: [busy: boolean]
  view: [view: View]
}>()
const app = useAppStore()

const view = ref<View>('launcher')
const machineHostId = ref('')
const workspace = ref<WorkspacePage | null>(null)
const workspacePath = ref('')
const workspaceSearch = ref('')
const workspaceLoading = ref(false)
const inventory = ref<SessionInventoryResult | null>(null)
const sessionSearch = ref('')
const inventoryLoading = ref(false)
const pending = ref<'create' | 'adopt' | ''>('')
const error = ref('')
const trust = ref<TrustAttempt | null>(null)
let workspaceEpoch = 0
let inventoryEpoch = 0

const machine = computed(() => props.machines.find((candidate) => candidate.hostId === machineHostId.value))
const machineOptions = computed(() => props.machines.map((candidate) => ({
  value: candidate.hostId,
  label: machineDisplayLabel(candidate),
  description: candidate.available ? candidate.homePath : '暂不可用',
  disabled: !candidate.available,
})))
const showMachineSelector = computed(() => machineSelectorVisible(props.machines))
const workspaceRoots = computed(() => machineWorkspaceRoots(machine.value))
const showWorkspaceRoots = computed(() => machineWorkspaceRootSelectorVisible(machine.value))
const workspaceRootOptions = computed(() => {
  const current = machine.value
  if (!current) return []
  const home = machineWorkspaceStart(current)
  return [
    { value: home, label: 'Home', description: home },
    ...workspaceRoots.value.map((root) => ({ value: root, label: root })),
  ]
})
const recentWorkspaces = computed(() => machineHostId.value ? app.recentWorkspaces(machineHostId.value) : [])
const filteredWorkspaceEntries = computed(() => {
  const query = workspaceSearch.value.trim().toLocaleLowerCase()
  return workspace.value?.entries.filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query)) ?? []
})
const filteredSessions = computed(() => {
  const query = sessionSearch.value.trim().toLocaleLowerCase()
  return inventory.value?.sessions.filter((session) => !query || sessionSearchText(session).includes(query)) ?? []
})
const title = computed(() => view.value === 'browse' ? '选择工作目录' : view.value === 'sessions' ? '恢复保存的 Pi Session' : '新建 Work')
const body = computed(() => {
  if (view.value === 'browse') {
    if (!workspace.value) return workspacePath.value
    return `${workspace.value.path}\n${workspace.value.truncated ? `显示前 ${workspace.value.entries.length} / ${workspace.value.total} 个目录` : `${workspace.value.total} 个子目录`}`
  }
  if (view.value === 'sessions' && inventory.value) {
    return inventory.value.truncated
      ? `当前显示 ${inventory.value.sessions.length} / ${inventory.value.total} 个 Session`
      : `${inventory.value.total} 个保存的 Session`
  }
  return machine.value?.homePath || ''
})
const actionBusy = computed(() => props.machinesLoading || !!pending.value || !!trust.value || props.outcomeUnknown)

watch(() => props.machines, (machines) => {
  if (machines.some((candidate) => candidate.hostId === machineHostId.value && candidate.available)) return
  machineHostId.value = defaultMachineHostId(machines)
}, { immediate: true })
watch(pending, (value) => emit('busy', !!value), { immediate: true })
watch(view, (value) => emit('view', value), { immediate: true })

onUnmounted(() => { ++workspaceEpoch; ++inventoryEpoch })

function sessionSearchText(session: SessionInventoryInfo) {
  return `${session.name ?? ''} ${session.firstUserMessage ?? ''} ${session.cwd}`.toLocaleLowerCase()
}

function sessionLabel(session: SessionInventoryInfo) {
  return session.name || session.firstUserMessage || '未命名 Session'
}

async function selectMachine(value: string) {
  if (actionBusy.value || value === machineHostId.value) return
  machineHostId.value = value
  error.value = ''
  workspace.value = null
  inventory.value = null
  if (view.value === 'browse') await startBrowsing()
  else if (view.value === 'sessions') await loadInventory()
}

function requestClose() {
  if (!pending.value) emit('close')
}

function backToLauncher() {
  if (actionBusy.value) return
  ++workspaceEpoch
  ++inventoryEpoch
  view.value = 'launcher'
  workspace.value = null
  inventory.value = null
  workspaceSearch.value = ''
  sessionSearch.value = ''
  error.value = ''
}

async function startBrowsing(path = machineWorkspaceStart(machine.value)) {
  if (!machine.value?.available || actionBusy.value) return
  view.value = 'browse'
  workspace.value = null
  workspacePath.value = path
  await browse(path)
}

async function browse(path: string) {
  const selectedMachine = machine.value
  if (!selectedMachine?.available) return
  const epoch = ++workspaceEpoch
  workspaceLoading.value = true
  workspaceSearch.value = ''
  error.value = ''
  try {
    const page = await currentConnectionCall(app, (context) => listWorkspace(path, context, selectedMachine.hostId))
    if (epoch !== workspaceEpoch || selectedMachine.hostId !== machineHostId.value) return
    workspace.value = page
    workspacePath.value = page.path
  } catch (cause) {
    if (epoch === workspaceEpoch) error.value = errorMessage(cause)
  } finally {
    if (epoch === workspaceEpoch) workspaceLoading.value = false
  }
}

async function loadInventory() {
  const selectedMachine = machine.value
  if (!selectedMachine?.available || actionBusy.value) return
  view.value = 'sessions'
  const epoch = ++inventoryEpoch
  inventoryLoading.value = true
  inventory.value = null
  sessionSearch.value = ''
  error.value = ''
  try {
    const context = requireConnectionContext(app)
    const result = await currentConnectionCall(app, () => listSessionInventory(context, selectedMachine.hostId, machineWorkspaceStart(selectedMachine)))
    if (epoch !== inventoryEpoch || selectedMachine.hostId !== machineHostId.value) return
    if (result.connectionId !== context.connectionId
      || result.selectionGeneration !== context.selectionGeneration
      || result.machineHostId !== selectedMachine.hostId
      || !result.hostEpoch) {
      throw new Error('Session 列表已经变化，请重新打开后再试。')
    }
    inventory.value = result
  } catch (cause) {
    if (epoch === inventoryEpoch) error.value = errorMessage(cause)
  } finally {
    if (epoch === inventoryEpoch) inventoryLoading.value = false
  }
}

async function createAt(path: string, machineId = machineHostId.value, continuation?: CreateWorkContinuation) {
  if (!isTauri || props.preview || !!pending.value || props.outcomeUnknown || (!!trust.value && !continuation)) return
  const selectedMachine = props.machines.find((candidate) => candidate.hostId === machineId)
  if (!selectedMachine?.available) return
  pending.value = 'create'
  error.value = ''
  try {
    const context = requireConnectionContext(app)
    const work = await createWork(path, context, undefined, continuation, machineId)
    if (!app.contextMatches(context)) return
    trust.value = null
    emit('created', work)
  } catch (cause) {
    handleMutationFailure(cause, { kind: 'create', machineHostId: machineId, path })
  } finally {
    pending.value = ''
  }
}

async function adoptSaved(sessionToken: string, machineId = machineHostId.value, continuation?: CreateWorkContinuation) {
  if (!isTauri || props.preview || !!pending.value || props.outcomeUnknown || (!!trust.value && !continuation)) return
  const selectedMachine = props.machines.find((candidate) => candidate.hostId === machineId)
  if (!selectedMachine?.available) return
  pending.value = 'adopt'
  error.value = ''
  try {
    const context = requireConnectionContext(app)
    const work = await adoptSession(sessionToken, context, machineId, undefined, continuation)
    if (!app.contextMatches(context)) return
    trust.value = null
    emit('created', work)
  } catch (cause) {
    handleMutationFailure(cause, { kind: 'adopt', machineHostId: machineId, sessionToken })
  } finally {
    pending.value = ''
  }
}

function handleMutationFailure(cause: unknown, attempt: Pick<TrustAttempt, 'kind' | 'machineHostId' | 'path' | 'sessionToken'>) {
  const failure = cause as { code?: string; details?: Record<string, unknown>; operationId?: string; outcomeUnknown?: boolean }
  if (failure?.code === 'project_trust_required') {
    const operationId = String(failure.details?.operationId || failure.operationId || '')
    const trustChallengeId = String(failure.details?.challengeId || '')
    if (operationId && trustChallengeId) {
      trust.value = { ...attempt, operationId, trustChallengeId }
      return
    }
    error.value = 'Dock 返回的信任确认与当前操作对不上。请重新选择后再试。'
    return
  }
  if (failure?.outcomeUnknown === true) emit('unknown', cause)
  error.value = errorMessage(cause)
}

function continueWithTrust(decision: CreateWorkContinuation['projectTrustDecision']) {
  const attempt = trust.value
  if (!attempt) return
  const continuation = {
    operationId: attempt.operationId,
    trustChallengeId: attempt.trustChallengeId,
    projectTrustDecision: decision,
  }
  if (attempt.kind === 'create' && attempt.path) void createAt(attempt.path, attempt.machineHostId, continuation)
  else if (attempt.kind === 'adopt' && attempt.sessionToken) void adoptSaved(attempt.sessionToken, attempt.machineHostId, continuation)
}
</script>

<template>
  <header class="ui-dialog-header new-work-header">
    <button v-if="view !== 'launcher'" type="button" class="new-work-back" aria-label="返回新建 Work" :disabled="actionBusy" @click="backToLauncher">←</button>
    <div><div id="directory-title" class="ui-dialog-title">{{ title }}</div><div v-if="body" class="ui-dialog-body">{{ body }}</div></div>
  </header>
  <button class="ui-dialog-close" aria-label="关闭" :disabled="!!pending" @click="requestClose">×</button>

  <div class="alu-directory-select new-work-dialog">
    <label v-if="showMachineSelector" class="alu-directory-machine">
      <span>创建位置</span>
      <AluSelect
        :value="machineHostId"
        :options="machineOptions"
        label="选择 Machine"
        placeholder="选择 Machine"
        :disabled="machinesLoading || actionBusy"
        @select="selectMachine"
      />
    </label>

    <div v-if="machinesLoading && !machines.length" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取可用机器…</div>
    <div v-else-if="machineError || (!machine && !machinesLoading)" class="alu-dialog-error">{{ machineError || '当前没有可用于创建 Work 的机器。' }}</div>
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="pending" class="alu-dialog-pending"><span class="alu-agent-activity-spinner" />{{ pending === 'adopt' ? '正在创建新的 Work…' : '正在创建 Work…' }}</div>

    <template v-if="machine">
      <section v-if="view === 'launcher'" class="new-work-launcher">
        <div v-if="recentWorkspaces.length" class="new-work-section-label">最近创建</div>
        <div v-if="recentWorkspaces.length" class="ui-dialog-options new-work-recent-options">
          <button v-for="path in recentWorkspaces" :key="path" type="button" class="ui-dialog-option" :disabled="preview || actionBusy || !machine.available" @click="createAt(path)">
            <span class="ui-dialog-option-marker">•</span>
            <span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ path.split(/[\\/]/u).filter(Boolean).at(-1) || path }}</span><span class="ui-dialog-option-detail"><span>{{ path }}</span></span></span>
          </button>
        </div>
        <div class="new-work-section-label">开始</div>
        <div class="ui-dialog-options new-work-action-options">
          <button type="button" class="ui-dialog-option" :disabled="actionBusy || !machine.available" @click="startBrowsing()">
            <span class="ui-dialog-option-marker"><FolderOpen :size="16" /></span>
            <span class="ui-dialog-option-content"><span class="ui-dialog-option-label">选择其他目录…</span><span class="ui-dialog-option-detail"><span>浏览这台机器上的目录</span></span></span>
          </button>
          <button type="button" class="ui-dialog-option" :disabled="actionBusy || !machine.available" @click="loadInventory">
            <span class="ui-dialog-option-marker"><RotateCcw :size="16" /></span>
            <span class="ui-dialog-option-content"><span class="ui-dialog-option-label">恢复保存的 Pi Session…</span><span class="ui-dialog-option-detail"><span>从已有 Session 创建新的 Work</span></span></span>
          </button>
        </div>
      </section>

      <template v-else-if="view === 'browse'">
        <label v-if="showWorkspaceRoots" class="alu-directory-machine">
          <span>快速前往</span>
          <AluSelect value="" :options="workspaceRootOptions" label="快速前往" placeholder="选择位置" :disabled="workspaceLoading || actionBusy || !machine.available" @select="startBrowsing" />
        </label>
        <div class="ui-dialog-search-wrap"><input v-model="workspaceSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索目录名称…" /></div>
        <div v-if="workspaceLoading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取目录…</div>
        <div v-else-if="workspace" class="ui-dialog-options" role="listbox">
          <button class="ui-dialog-option" :disabled="preview || actionBusy || !machine.available" @click="createAt(workspace.path)"><span class="ui-dialog-option-marker">✓</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">使用这个目录</span><span class="ui-dialog-option-badge">选择</span></span><span class="ui-dialog-option-detail"><span>{{ workspace.path }}</span></span></span></button>
          <button v-if="workspace.parent" class="ui-dialog-option" @click="browse(workspace.parent)"><span class="ui-dialog-option-marker">↑</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">..</span><span class="ui-dialog-option-detail"><span>返回上级目录</span></span></span></button>
          <button v-for="entry in filteredWorkspaceEntries" :key="entry.name" class="ui-dialog-option" @click="browse(workspaceChildPath(workspace.path, entry.name, machine.platform))"><span class="ui-dialog-option-marker">{{ entry.kind === 'symlink' ? '↗' : '▸' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ entry.name }}</span><span v-if="entry.kind === 'symlink'" class="ui-dialog-option-badge">链接</span></span><span class="ui-dialog-option-detail"><span>{{ entry.kind === 'symlink' ? '目录链接' : '目录' }}{{ entry.hidden ? ' · 隐藏' : '' }}</span></span></span></button>
          <div v-if="!filteredWorkspaceEntries.length && !workspace.parent" class="ui-dialog-empty">没有匹配项</div>
        </div>
      </template>

      <template v-else>
        <div class="ui-dialog-search-wrap"><input v-model="sessionSearch" type="search" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称或目录…" :disabled="inventoryLoading" /></div>
        <div v-if="inventoryLoading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取保存的 Session…</div>
        <div v-else-if="inventory" class="ui-dialog-options">
          <button v-for="session in filteredSessions" :key="session.token" type="button" class="ui-dialog-option" :disabled="preview || actionBusy" @click="adoptSaved(session.token)">
            <span class="ui-dialog-option-marker"><History :size="15" /></span>
            <span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ sessionLabel(session) }}</span><span class="ui-dialog-option-detail"><span>{{ session.cwd }}</span><span class="ui-dialog-option-meta">{{ treeNodeTime(session.updatedAt) }}</span></span></span>
          </button>
          <div v-if="!filteredSessions.length" class="ui-dialog-empty">{{ inventory.incomplete ? '部分 Session 暂时无法读取。请稍后重试。' : '这台机器上没有保存的 Pi Session。' }}</div>
        </div>
        <div v-if="inventory?.incomplete" class="cmd-palette-footer">部分 Session 暂时没有载入。请稍后重新打开。</div>
      </template>

      <div v-if="trust" class="session-trust"><strong>这个项目需要你的信任确认</strong><p>确认后会继续创建新的 Work。</p><div><button @click="trust = null">取消</button><button @click="continueWithTrust('trust_once')">仅本次信任</button><button class="session-primary" @click="continueWithTrust('trust_and_remember')">信任并创建</button></div></div>
    </template>
  </div>
</template>

<style scoped>
.new-work-header { display: flex; align-items: flex-start; gap: 10px; }
.new-work-header > div { min-width: 0; }
.new-work-back {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  margin-top: -2px;
  place-items: center;
  border: 1px solid var(--alu-border);
  border-radius: 7px;
  color: var(--alu-text-muted);
  background: transparent;
}
.new-work-back:hover:not(:disabled) { color: var(--alu-text); background: var(--alu-hover); }
.new-work-dialog { position: relative; }
.new-work-launcher { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow-y: auto; padding: 12px 16px 18px; }
.new-work-section-label { padding: 8px 4px 6px; color: var(--alu-text-faint); font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.new-work-recent-options,
.new-work-action-options { flex: 0 0 auto; overflow: visible; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg); }
.new-work-recent-options { max-height: 250px; overflow-y: auto; }
.new-work-recent-options + .new-work-section-label { margin-top: 7px; }
.new-work-recent-options .ui-dialog-option:last-child,
.new-work-action-options .ui-dialog-option:last-child { border-bottom: 0; }
@media (max-width: 700px) {
  .new-work-launcher { padding: 10px 12px 14px; }
}
</style>
