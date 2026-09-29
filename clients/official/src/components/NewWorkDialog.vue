<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { FolderOpen, RotateCcw } from '@lucide/vue'
import {
  adoptSession,
  createWork,
  isTauri,
  listSessionInventory,
  listWorkspace,
  systemCatalog,
  setSystemDefault,
  type CreateWorkContinuation,
} from '../lib/bridge'
import { copyPlainText } from '../lib/clipboard'
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
import { useSavedSessionPages } from '../lib/savedSessions'
import type { DirectoryPage } from '../lib/workspaceBrowser'
import type { MachineDto, SystemCandidate, SystemCatalogCursor, Work, WorkspaceCursor } from '../lib/types'
import { userErrorPresentation, type UserErrorPresentation } from '../lib/userError'
import { useAppStore } from '../stores/app'
import AluSelect from './AluSelect.vue'
import DirectoryBrowser from './DirectoryBrowser.vue'
import ResourceDocument from './ResourceDocument.vue'
import SavedSessionList from './SavedSessionList.vue'

type View = 'launcher' | 'browse' | 'sessions' | 'systems' | 'system-content'
type DialogError = UserErrorPresentation & { copyState?: 'copied' | 'failed' }
type TrustAttempt = {
  kind: 'create' | 'adopt'
  operationId: string
  trustChallengeId: string
  machineHostId: string
  workerConfig?: Record<string, unknown>
  path?: string
  sessionToken?: string
}

const props = defineProps<{
  machines: readonly MachineDto[]
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
const browseStartPath = ref('')
const browseVersion = ref(0)
const workspacePath = ref('')
const sessionPages = useSavedSessionPages()
const pending = ref<'create' | 'adopt' | 'save' | ''>('')
const error = ref<DialogError | null>(null)
const trust = ref<TrustAttempt | null>(null)
const systemPath = ref('')
const systemCandidates = ref<SystemCandidate[]>([])
const systemWarnings = ref<string[]>([])
const systemSelection = ref<SystemCandidate | null>(null)
const systemPreview = ref<SystemCandidate | null>(null)
const systemLoading = ref(false)
const systemCatalogState = ref<'idle' | 'ready' | 'unsupported' | 'failed'>('idle')
const saveDefault = ref(false)
const savedDefaultId = ref('')
const saveFailed = ref(false)
let systemEpoch = 0
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
const title = computed(() => view.value === 'systems' ? '选择 system' : view.value === 'system-content' ? '阅读 system' : view.value === 'browse' ? '选择工作目录' : view.value === 'sessions' ? '恢复保存的 Pi Session' : '新建 Work')
const body = computed(() => {
  if (view.value === 'systems' || view.value === 'system-content') return systemPath.value
  if (view.value === 'browse') return workspacePath.value
  if (view.value === 'sessions' && sessionPages.loaded.value) return `${sessionPages.total.value} 个保存的 Session`
  return machine.value?.homePath || ''
})
const actionBusy = computed(() => props.machinesLoading || !!pending.value || !!trust.value)

watch(() => props.machines, (machines) => {
  if (machines.some((candidate) => candidate.hostId === machineHostId.value && candidate.available)) return
  const nextMachineHostId = defaultMachineHostId(machines)
  if (nextMachineHostId !== machineHostId.value) clearError()
  machineHostId.value = nextMachineHostId
}, { immediate: true })
watch(pending, (value) => emit('busy', !!value), { immediate: true })
watch(view, (value) => emit('view', value), { immediate: true })

watch([
  () => app.connectionContext?.connectionId,
  () => app.connectionContext?.selectionGeneration,
  () => machineHostId.value,
], () => {
  resetSystems()
  ++inventoryEpoch
  sessionPages.reset()
  trust.value = null
  view.value = 'launcher'
  clearError()
}, { flush: 'sync' })

onUnmounted(() => { ++inventoryEpoch; ++systemEpoch; sessionPages.reset() })

function resetSystems() {
  ++systemEpoch
  systemLoading.value = false
  systemCatalogState.value = 'idle'
  systemCandidates.value = []
  systemWarnings.value = []
  systemSelection.value = null
  systemPreview.value = null
  systemPath.value = ''
  saveDefault.value = false
  savedDefaultId.value = ''
  saveFailed.value = false
}

async function chooseDirectory(path: string, refresh = false) {
  if (!isTauri || props.preview || actionBusy.value || !machine.value?.available) return
  const selectedId = refresh ? systemSelection.value?.id : undefined
  const shouldSave = refresh && saveDefault.value
  const previouslySaved = refresh ? savedDefaultId.value : ''
  resetSystems()
  saveDefault.value = shouldSave
  const epoch = systemEpoch
  const hostId = machineHostId.value
  systemPath.value = path
  systemLoading.value = true
  view.value = 'systems'
  clearError()
  let receivedCatalog = false
  try {
    const candidates: SystemCandidate[] = []
    const warnings: string[] = []
    let cursor: SystemCatalogCursor | undefined
    let defaultSelection: SystemCandidate | undefined
    do {
      const page = await currentConnectionCall(app, (context) => systemCatalog(path, context, hostId, cursor))
      if (epoch !== systemEpoch) return
      receivedCatalog = true
      candidates.push(...page.candidates)
      for (const warning of page.warnings) if (!warnings.includes(warning)) warnings.push(warning)
      defaultSelection ??= page.defaultSelection
      cursor = page.nextCursor
    } while (cursor)
    systemCatalogState.value = 'ready'
    systemCandidates.value = candidates
    systemWarnings.value = warnings
    savedDefaultId.value = defaultSelection?.id === previouslySaved ? previouslySaved : ''
    systemSelection.value = candidates.find(candidate => candidate.id === selectedId) ?? null
    if (!refresh && defaultSelection && !defaultSelection.warning) {
      systemSelection.value = defaultSelection
      await createAt(path, hostId)
    }
  } catch (cause) {
    if (epoch !== systemEpoch) return
    const failure = cause as { code?: string; details?: { missing?: unknown } }
    const missing = failure?.details?.missing
    const unsupported = failure?.code === 'capability_missing' && Array.isArray(missing)
      && missing.length === 1 && missing[0] === 'system.templates.v1'
    systemCatalogState.value = unsupported ? 'unsupported' : 'failed'
    // This is the original directory-create intent, not a retry after an effect.
    // Refresh, partial discovery and an explicit choice never become implicit creation.
    if (unsupported && !refresh && !receivedCatalog) {
      view.value = 'launcher'
      await createAt(path, hostId)
    } else setError(cause, '读取这个目录的 system 列表', 'system_catalog')
  } finally {
    if (epoch === systemEpoch) systemLoading.value = false
  }
}

function selectSystem(candidate: SystemCandidate) {
  if (actionBusy.value) return
  systemSelection.value = candidate
  saveFailed.value = false
  clearError()
}

function back() {
  if (actionBusy.value) return
  if (view.value === 'system-content') {
    systemPreview.value = null
    view.value = 'systems'
  } else backToLauncher()
}

function systemReadFailed(cause: unknown) {
  systemPreview.value = null
  view.value = 'systems'
  setError(cause, '读取所选 system 正文；请重新读取列表或选择其他文件', 'system_content')
}

async function confirmSystem() {
  const selection = systemSelection.value
  if (!selection || selection.warning || systemLoading.value || actionBusy.value) return
  const epoch = systemEpoch
  const path = systemPath.value
  const hostId = machineHostId.value
  // A fresh confirmation is a fresh save intent; another Client may have changed
  // the default. Trust continuation calls createAt directly and does not save again.
  if (saveDefault.value) {
    pending.value = 'save'
    clearError()
    saveFailed.value = false
    try {
      await currentConnectionCall(app, (context) => setSystemDefault(path, selection.id, app.captureHostOperation(context), hostId))
      if (epoch !== systemEpoch) return
      savedDefaultId.value = selection.id
    } catch (cause) {
      if (epoch !== systemEpoch) return
      saveFailed.value = true
      if ((cause as { outcomeUnknown?: boolean })?.outcomeUnknown) emit('unknown', cause)
      setError(cause, '保存此目录的默认 system', 'set_system_default')
      return
    } finally {
      pending.value = ''
    }
  }
  if (epoch === systemEpoch) await createAt(path, hostId, undefined, selection.workerConfig)
}

function clearError() {
  error.value = null
}

function setError(cause: unknown, action?: string, request?: string) {
  error.value = userErrorPresentation(cause, undefined, action && request ? { action, request } : undefined)
}

async function copyErrorDiagnostic() {
  const current = error.value
  if (!current?.diagnostic) return
  try {
    await copyPlainText(current.diagnostic)
    if (error.value === current) current.copyState = 'copied'
  } catch {
    if (error.value === current) current.copyState = 'failed'
  }
}

async function selectMachine(value: string) {
  if (actionBusy.value || value === machineHostId.value) return
  const previousView = view.value
  machineHostId.value = value
  clearError()
  sessionPages.reset()
  if (previousView === 'browse') startBrowsing()
  else if (previousView === 'sessions') await loadInventory()
}

function requestClose() {
  if (!pending.value) { ++systemEpoch; ++inventoryEpoch; sessionPages.reset(); emit('close') }
}

function backToLauncher() {
  if (actionBusy.value) return
  resetSystems()
  ++inventoryEpoch
  view.value = 'launcher'
  sessionPages.reset()
  clearError()
}

function startBrowsing(path = machineWorkspaceStart(machine.value)) {
  if (!machine.value?.available || actionBusy.value) return
  clearError()
  browseStartPath.value = path
  ++browseVersion.value
  workspacePath.value = path
  view.value = 'browse'
}

function describeDirectoryError(cause: unknown, path: string): UserErrorPresentation {
  return userErrorPresentation(cause, undefined, {
    action: `读取这台机器的目录 ${path}`,
    request: 'list_workspace',
  })
}

async function readDirectoryPage(path: string, cursor?: WorkspaceCursor): Promise<DirectoryPage> {
  const selectedMachine = machine.value
  if (!selectedMachine?.available) throw new Error('这台机器暂不可用。请选择其他机器或稍后重试。')
  const page = await currentConnectionCall(app, context => listWorkspace(path, context, selectedMachine.hostId, cursor))
  return {
    ...page,
    entries: page.entries.map(entry => ({
      ...entry,
      path: workspaceChildPath(path, entry.name, selectedMachine.platform),
      ...(entry.kind === 'symlink' ? { targetKind: 'directory' as const } : {}),
    })),
  }
}

async function loadInventory() {
  const selectedMachine = machine.value
  if (!selectedMachine?.available || actionBusy.value) return
  view.value = 'sessions'
  const epoch = ++inventoryEpoch
  clearError()
  try {
    const context = requireConnectionContext(app)
    await sessionPages.load(async (cursor) => {
      const page = await currentConnectionCall(app, () => listSessionInventory(context, selectedMachine.hostId, machineWorkspaceStart(selectedMachine), cursor))
      if (page.connectionId !== context.connectionId
        || page.selectionGeneration !== context.selectionGeneration
        || page.machineHostId !== selectedMachine.hostId
        || !page.hostEpoch) {
        throw new Error('Session 列表已经变化，请重新打开后再试。')
      }
      return page
    })
  } catch (cause) {
    const action = selectedMachine.kind === 'main'
      ? '读取 Main 上保存的 Session 列表'
      : '读取所选机器上保存的 Session 列表'
    if (epoch === inventoryEpoch) setError(cause, action, 'session_inventory')
  }
}

async function createAt(path: string, machineId = machineHostId.value, continuation?: CreateWorkContinuation, workerConfig?: Record<string, unknown>) {
  if (!isTauri || props.preview || !!pending.value || (!!trust.value && !continuation)) return
  const selectedMachine = props.machines.find((candidate) => candidate.hostId === machineId)
  if (!selectedMachine?.available) return
  const epoch = systemEpoch
  pending.value = 'create'
  clearError()
  try {
    const context = requireConnectionContext(app)
    const work = await createWork(path, app.captureHostOperation(context), undefined, continuation, machineId, workerConfig)
    if (!app.contextMatches(context) || epoch !== systemEpoch) return
    trust.value = null
    emit('created', work)
  } catch (cause) {
    if (epoch === systemEpoch) {
      if (systemCatalogState.value !== 'unsupported') view.value = 'systems'
      handleMutationFailure(cause, { kind: 'create', machineHostId: machineId, path, workerConfig })
    }
  } finally {
    pending.value = ''
  }
}

async function adoptSaved(sessionToken: string, machineId = machineHostId.value, continuation?: CreateWorkContinuation) {
  if (!isTauri || props.preview || !!pending.value || (!!trust.value && !continuation)) return
  const selectedMachine = props.machines.find((candidate) => candidate.hostId === machineId)
  if (!selectedMachine?.available) return
  pending.value = 'adopt'
  clearError()
  try {
    const context = requireConnectionContext(app)
    const work = await adoptSession(sessionToken, app.captureHostOperation(context), machineId, undefined, continuation)
    if (!app.contextMatches(context)) return
    trust.value = null
    emit('created', work)
  } catch (cause) {
    handleMutationFailure(cause, { kind: 'adopt', machineHostId: machineId, sessionToken })
  } finally {
    pending.value = ''
  }
}

function handleMutationFailure(cause: unknown, attempt: Pick<TrustAttempt, 'kind' | 'machineHostId' | 'path' | 'sessionToken' | 'workerConfig'>) {
  const failure = cause as { code?: string; details?: Record<string, unknown>; operationId?: string; outcomeUnknown?: boolean }
  if (failure?.code === 'project_trust_required') {
    const operationId = String(failure.details?.operationId || failure.operationId || '')
    const trustChallengeId = String(failure.details?.challengeId || '')
    if (operationId && trustChallengeId) {
      trust.value = { ...attempt, operationId, trustChallengeId }
      return
    }
    error.value = { message: 'Dock 返回的信任确认与当前操作对不上。请重新选择后再试。' }
    return
  }
  if (failure?.outcomeUnknown === true) emit('unknown', cause)
  setError(
    cause,
    attempt.kind === 'create' ? '创建 Work' : '从保存的 Session 创建 Work',
    attempt.kind === 'create' ? 'create_work' : 'adopt_session',
  )
}

function continueWithTrust(decision: CreateWorkContinuation['projectTrustDecision']) {
  const attempt = trust.value
  if (!attempt) return
  const continuation = {
    operationId: attempt.operationId,
    trustChallengeId: attempt.trustChallengeId,
    projectTrustDecision: decision,
  }
  if (attempt.kind === 'create' && attempt.path) void createAt(attempt.path, attempt.machineHostId, continuation, attempt.workerConfig)
  else if (attempt.kind === 'adopt' && attempt.sessionToken) void adoptSaved(attempt.sessionToken, attempt.machineHostId, continuation)
}
</script>

<template>
  <header class="ui-dialog-header new-work-header">
    <button v-if="view !== 'launcher' && view !== 'system-content'" type="button" class="new-work-back" aria-label="返回新建 Work" :disabled="actionBusy" @click="back">←</button>
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
    <div v-if="error" class="alu-dialog-error">
      <span>{{ error.message }}</span>
      <button v-if="error.diagnostic" type="button" @click="copyErrorDiagnostic">
        {{ error.copyState === 'copied' ? '诊断信息已复制' : error.copyState === 'failed' ? '复制失败，请重试' : '复制诊断信息' }}
      </button>
    </div>
    <div v-if="pending" class="alu-dialog-pending"><span class="alu-agent-activity-spinner" />{{ pending === 'save' ? '正在保存目录默认…' : '正在创建 Work…' }}</div>

    <template v-if="machine">
      <section v-if="view === 'launcher'" class="new-work-launcher">
        <div v-if="recentWorkspaces.length" class="new-work-section-label">最近创建</div>
        <div v-if="recentWorkspaces.length" class="ui-dialog-options new-work-recent-options">
          <button v-for="path in recentWorkspaces" :key="path" type="button" class="ui-dialog-option" :disabled="preview || actionBusy || !machine.available" @click="chooseDirectory(path)">
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
          <AluSelect value="" :options="workspaceRootOptions" label="快速前往" placeholder="选择位置" :disabled="actionBusy || !machine.available" @select="startBrowsing" />
        </label>
        <DirectoryBrowser
          :key="browseVersion"
          :start-path="browseStartPath"
          :load-page="readDirectoryPage"
          :describe-error="describeDirectoryError"
          :disabled="actionBusy || !machine.available"
          picker
          @directory="workspacePath = $event"
        />
        <footer class="directory-confirm">
          <span :title="workspacePath">{{ workspacePath }}</span>
          <button type="button" class="ui-dialog-btn session-primary" :disabled="preview || actionBusy || !machine.available" @click="chooseDirectory(workspacePath)">使用这个目录</button>
        </footer>
      </template>

      <template v-else-if="view === 'systems'">
        <div v-if="systemLoading" class="alu-dialog-loading" role="status"><span class="alu-agent-activity-spinner" />正在读取这个目录的 system…</div>
        <template v-else>
          <div v-if="systemWarnings.length" class="alu-dialog-error" role="alert"><span v-for="warning in systemWarnings" :key="warning">{{ warning }}</span><span>请修复文件后重新读取，或选择其他可用 system。</span></div>
          <div v-if="savedDefaultId" class="cmd-palette-footer" role="status">目录默认已保存。{{ outcomeUnknown ? 'Work 是否创建成功尚不确定；请先刷新核对，不要再次创建。' : error ? 'Work 尚未创建；请检查错误后再确认创建。' : '创建 Work 是另一步操作。' }}</div>
          <div v-if="saveFailed" class="alu-dialog-error">目录默认未确认保存，尚未创建 Work。可取消勾选，仅用于本次；若结果尚不确定，请先检查目录默认。</div>
          <div class="ui-dialog-options" role="group" aria-label="可用 system">
            <div v-for="candidate in systemCandidates" :key="candidate.id" class="system-option">
              <button type="button" class="ui-dialog-option" :aria-pressed="systemSelection?.id === candidate.id" :disabled="actionBusy || !!candidate.warning" @click="selectSystem(candidate)">
                <span class="ui-dialog-option-marker">{{ systemSelection?.id === candidate.id ? '✓' : '•' }}</span>
                <span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ candidate.name }}</span><span class="ui-dialog-option-detail"><span>{{ candidate.path }}</span><span v-if="candidate.warning">{{ candidate.warning }} 请修复后重新读取。</span></span></span>
              </button>
              <button type="button" class="ui-dialog-btn" :aria-label="`阅读 ${candidate.name}`" :disabled="actionBusy" @click="systemPreview = candidate; view = 'system-content'">阅读</button>
            </div>
            <div v-if="systemCatalogState === 'ready' && !systemCandidates.length" class="ui-dialog-empty">没有可用的 system。请检查这台机器的 SYSTEM 文件或 Dock 模板后重新读取。</div>
          </div>
          <footer class="system-confirm">
            <button type="button" class="ui-dialog-btn" :disabled="actionBusy" @click="chooseDirectory(systemPath, true)">重新读取</button>
            <label><input v-model="saveDefault" type="checkbox" :disabled="actionBusy" />设为此目录默认</label>
            <button type="button" class="ui-dialog-btn session-primary" :disabled="actionBusy || !systemSelection || !!systemSelection.warning" @click="confirmSystem">确认并创建</button>
          </footer>
        </template>
      </template>

      <ResourceDocument v-else-if="view === 'system-content' && systemPreview" :system="{ cwd: systemPath, hostId: machineHostId, candidate: systemPreview }" @back="back" @failed="systemReadFailed" />

      <SavedSessionList
        v-else-if="view === 'sessions'"
        :key="machineHostId"
        :sessions="sessionPages.sessions.value"
        :total="sessionPages.total.value"
        :show-directory="true"
        :loaded="sessionPages.loaded.value"
        :loading="sessionPages.loading.value"
        :loading-more="sessionPages.loadingMore.value"
        :more-failed="sessionPages.moreFailed.value"
        :incomplete="sessionPages.incomplete.value"
        :disabled="preview || actionBusy"
        :empty-text="sessionPages.incomplete.value ? '部分 Session 暂时无法读取。请稍后重试。' : '这台机器上没有保存的 Pi Session。'"
        @select="adoptSaved($event.token)"
        @retry="sessionPages.retryMore()"
      />

      <div v-if="trust" class="session-trust"><strong>这个项目需要你的信任确认</strong><p>确认后会继续创建新的 Work。</p><div><button :disabled="!!pending" @click="trust = null">取消</button><button :disabled="!!pending" @click="continueWithTrust('trust_once')">仅本次信任</button><button class="session-primary" :disabled="!!pending" @click="continueWithTrust('trust_and_remember')">信任并创建</button></div></div>
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
.directory-confirm { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; padding: 12px; border-top: 1px solid var(--alu-border); }
.directory-confirm > span { min-width: 0; flex: 1; overflow: hidden; color: var(--alu-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.directory-confirm > button { flex-shrink: 0; min-height: 40px; }
.system-option { display: flex; align-items: center; gap: 8px; padding-right: 12px; border-bottom: 1px solid var(--alu-border); }
.system-option .ui-dialog-option { flex: 1; min-width: 0; border-bottom: 0; }
.system-option .ui-dialog-option[aria-pressed="true"] { background: var(--alu-active); }
.system-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; padding: 12px; border-top: 1px solid var(--alu-border); }
.system-confirm label { display: flex; align-items: center; gap: 6px; color: var(--alu-text-muted); font-size: 12px; }
.system-confirm input { accent-color: var(--alu-blue); }
.new-work-dialog > .resource-document { flex: 1; min-height: 0; }
.alu-dialog-error > span { display: block; }
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
