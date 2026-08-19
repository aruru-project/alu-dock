<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  commandCatalog,
  getResources,
  getSettings,
  listModels,
  listTools,
  runCatalogCommand,
  setActiveTools,
  setModel,
  setThinking,
  updateSetting,
} from '../lib/bridge'
import { captureHostResult, hostResultMatches } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import SessionManager from './SessionManager.vue'
import { useAppStore } from '../stores/app'
import { useCommandConsoleStore } from '../stores/command-console'
import type {
  CommandsResult,
  HostContext,
  ModelInfo,
  ModelsResult,
  ProjectedEvent,
  ResourcesResult,
  SettingInfo,
  SettingKey,
  SettingValue,
  SettingsResult,
  ThinkingLevel,
  ToolInfo,
  ToolsResult,
  Work,
} from '../lib/types'

export type ControlSection = 'commands' | 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session' | 'models' | 'thinking' | 'tools' | 'resources' | 'settings'
export type ControlMutationDomain = 'conversation' | 'sessions' | 'tree' | 'models' | 'tools' | 'settings'

const props = defineProps<{ work: Work; section: ControlSection; preview: boolean; outcomeUnknown: boolean; unknownDomain?: ControlMutationDomain; hasDraft: boolean; compactionPending: boolean }>()
const app = useAppStore()
const commandConsole = useCommandConsoleStore()
function hostContext() {
  if (!app.hostContext) throw new Error('当前没有选择 Host。')
  return { ...app.hostContext }
}
async function currentHostCall<T>(operation: (context: HostContext) => Promise<T>): Promise<T> {
  const context = hostContext()
  const correlated = captureHostResult(context, await operation(context))
  if (!hostResultMatches(correlated, app.hostContext)) throw new Error('Host 选择已改变；旧结果已丢弃。')
  return correlated.result
}
const emit = defineEmits<{
  snapshot: [work: Work]
  unknown: [cause: unknown, domain: ControlMutationDomain]
  reconcile: [domain: ControlMutationDomain]
  section: [section: ControlSection]
  resync: [work: Work, draftText?: string]
  compact: [customInstructions?: string]
  close: []
  stop: []
  restoreQueue: []
  title: [title: string, body?: string]
  size: [size: 'default' | 'wide' | 'tree']
}>()

const sessionManager = ref<InstanceType<typeof SessionManager> | null>(null)

const staticCommands = [
  { id: 'session_new', glyph: '+', label: 'New Session', description: '开始一段全新的上下文', section: 'new-session' },
  { id: 'stop', glyph: '■', label: 'Stop Work', description: '停止整个 Work；执行前需要确认', action: 'stop' },
  { id: 'resume', glyph: '↪', label: 'Resume Session', description: '从保存的 Session 继续', section: 'sessions' },
  { id: 'tree', glyph: '⑂', label: 'Session Tree', description: '浏览、切换或分叉当前会话树', section: 'tree' },
  { id: 'model', glyph: '◈', label: 'Set Model', description: '切换当前模型', section: 'models' },
  { id: 'thinking', glyph: '◇', label: 'Set Thinking', description: '调整思考等级', section: 'thinking' },
  { id: 'name', glyph: '✎', label: 'Rename Session', description: '修改当前 Session 名称', section: 'rename-session' },
  { id: 'compact', glyph: '⚡', label: 'Compact Context', description: '手动压缩当前上下文', section: 'compact-session' },
  { id: 'reload', glyph: '↻', label: 'Reload Session', description: '重新载入 Pi 资源与 Session', section: 'reload-session' },
  { id: 'dequeue', glyph: '↩', label: 'Restore Queue', description: '把尚未执行的消息取回输入框', action: 'restoreQueue' },
  { id: 'tools', glyph: '⚙', label: 'Active Tools', description: '查看或切换可用工具', section: 'tools' },
  { id: 'settings', glyph: '⌘', label: 'Settings', description: '查看或修改 Pi 设置', section: 'settings' },
  { id: 'state', glyph: 'ℹ', label: 'Project Status', description: '查看 Work、Git、Session 与已加载能力', section: 'resources' },
  { id: 'resources', glyph: '▤', label: 'Loaded Resources', description: '打开 Project Status 的资源与诊断', section: 'resources' },
] as const

const commandSearch = ref('')
const modelSearch = ref('')
const toolSearch = ref('')
const resourceSearch = ref('')
const settingsSearch = ref('')
const selectedSettingKey = ref<SettingKey | ''>('')
const settingDraft = ref('')
const selectedCommandName = ref('')
const commandRunnerOpen = ref(false)
const commandArguments = ref('')
const commandSelectedIndex = ref(0)
const commands = ref<CommandsResult | null>(null)
const commandCatalogState = ref<'loading' | 'ready' | 'truncated' | 'failed'>('loading')
const models = ref<ModelsResult | null>(null)
const tools = ref<ToolsResult | null>(null)
const resources = ref<ResourcesResult | null>(null)
const settings = ref<SettingsResult | null>(null)
const loading = ref<ControlSection | null>(null)
const pending = ref('')
const error = ref('')
let loadEpoch = 0

const selectedCommand = computed(() => commands.value?.commands.find((item) => item.name === selectedCommandName.value) ?? null)
const selectedSetting = computed(() => settings.value?.settings.find((item) => item.key === selectedSettingKey.value) ?? null)
const sessionMode = computed(() => props.section as 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session')
const filteredStaticCommands = computed(() => {
  const query = commandSearch.value.trim().toLowerCase()
  return staticCommands.filter((item) => !query || `${item.id} ${item.label} ${item.description}`.toLowerCase().includes(query))
})
const filteredCommands = computed(() => {
  const query = commandSearch.value.trim().toLowerCase()
  return (commands.value?.commands ?? [])
    .filter((item) => !['stop', 'resume', 'tree'].includes(item.name))
    .filter((item) => !query || `${item.name} ${item.description ?? ''} ${item.source.kind} ${item.source.package ?? ''}`.toLowerCase().includes(query))
})
const commandSelections = computed(() => [
  ...filteredStaticCommands.value.map((item) => ({ kind: 'static' as const, item })),
  ...filteredCommands.value.map((item) => ({ kind: 'catalog' as const, item })),
])
const commandFooter = computed(() => {
  const count = (commands.value?.commands ?? []).filter((item) => !['stop', 'resume', 'tree'].includes(item.name)).length
  if (commandCatalogState.value === 'loading') return '正在同步当前 Session 的 Extension、Skill 和 Prompt 命令…'
  if (commandCatalogState.value === 'truncated') return `显示 ${count} 个 Pi 命令（目录未完整返回）`
  if (commandCatalogState.value === 'failed') return 'Pi 命令目录暂时不可用 · WebConsole 命令仍可使用'
  return `${count} 个 Pi 命令 · 点击选择 · ↑↓ 移动`
})
const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  return (models.value?.models ?? []).filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
})
const filteredTools = computed(() => {
  const query = toolSearch.value.trim().toLowerCase()
  return (tools.value?.tools ?? []).filter((tool) => !query || `${tool.name} ${tool.description} ${tool.source?.kind ?? ''} ${tool.source?.package ?? ''}`.toLowerCase().includes(query))
})
const filteredResources = computed(() => {
  const query = resourceSearch.value.trim().toLowerCase()
  return (resources.value?.resources ?? []).filter((resource) => !query || `${resource.kind} ${resource.name} ${resource.source?.kind ?? ''} ${resource.source?.package ?? ''}`.toLowerCase().includes(query))
})
const resourceGroups = computed(() => ([
  { kind: 'extension' as const, label: 'Extensions' },
  { kind: 'skill' as const, label: '已加载 Skills' },
  { kind: 'prompt' as const, label: 'Prompts' },
  { kind: 'context' as const, label: 'Project Context' },
].map((group) => ({ ...group, items: filteredResources.value.filter((resource) => resource.kind === group.kind) }))))
const filteredDiagnostics = computed(() => {
  const query = resourceSearch.value.trim().toLowerCase()
  return (resources.value?.diagnostics ?? []).filter((diagnostic) => !query || `${diagnostic.severity} ${diagnostic.message}`.toLowerCase().includes(query))
})
const filteredSettings = computed(() => {
  const query = settingsSearch.value.trim().toLowerCase()
  return (settings.value?.settings ?? []).filter((setting) => !query || `${setting.key} ${JSON.stringify(setting.value)} ${setting.source}`.toLowerCase().includes(query))
})

watch(commandSearch, () => { commandSelectedIndex.value = 0 })
watch(commandSelections, (items) => {
  commandSelectedIndex.value = Math.max(0, Math.min(commandSelectedIndex.value, items.length - 1))
})

watch([
  () => app.activeHostId,
  () => app.hostContext?.selectionGeneration,
  () => props.work.id,
  () => props.work.ownerHostEpoch,
  () => props.work.runtimeGeneration,
], () => {
  if (app.hostContext) commandConsole.bindContext(app.hostContext.hostId, app.hostContext.selectionGeneration, props.work)
  commands.value = null
  commandCatalogState.value = 'loading'
  models.value = null
  tools.value = null
  resources.value = null
  settings.value = null
  selectedCommandName.value = ''
  error.value = ''
  void loadSection(props.section)
}, { immediate: true })
watch(() => props.section, (section) => {
  selectedSettingKey.value = ''
  void loadSection(section)
}, { immediate: true })

function reconcileControl() {
  emit('reconcile', props.unknownDomain ?? sectionDomain(props.section))
}

function forwardSessionUnknown(cause: unknown, domain: 'sessions' | 'tree') {
  emit('unknown', cause, domain)
}

function forwardSessionTitle(title: string, body?: string) {
  emit('title', title, body)
}

function forwardSessionSnapshot(work: Work) {
  emit('snapshot', work)
  emit('close')
}

function forwardSessionResync(work: Work, draftText?: string) {
  emit('resync', work, draftText)
  emit('close')
}

function forwardSessionCompact(customInstructions?: string) {
  emit('compact', customInstructions)
}

function activateStatic(item: typeof staticCommands[number]) {
  if ('section' in item) emit('section', item.section)
  else if (item.action === 'stop') emit('stop')
  else emit('restoreQueue')
}

function activateCommandIndex(index = commandSelectedIndex.value) {
  const selected = commandSelections.value[index]
  if (!selected) return
  if (selected.kind === 'static') activateStatic(selected.item)
  else openCommandRunner(selected.item.name)
}

function handleCommandKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    commandSelectedIndex.value = Math.min(commandSelectedIndex.value + 1, commandSelections.value.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    commandSelectedIndex.value = Math.max(commandSelectedIndex.value - 1, 0)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateCommandIndex()
  }
}

function openCommandRunner(name: string) {
  selectedCommandName.value = name
  commandArguments.value = ''
  commandRunnerOpen.value = true
}

async function reconcileDomain(domain: ControlMutationDomain): Promise<boolean> {
  if (domain === 'conversation') return false
  if (domain === 'sessions' || domain === 'tree') return sessionManager.value?.reconcileDomain(domain) ?? false
  return loadSection(domain === 'models' ? 'models' : domain, true)
}

function applyLiveEvent(event: ProjectedEvent) {
  const data = event.data
  if (event.eventType === 'settings.changed' && settings.value && typeof data.key === 'string') {
    const setting = settings.value.settings.find((item) => item.key === data.key)
    if (setting && 'value' in data) {
      setting.value = data.value as SettingValue
      if (typeof data.reloadRequired === 'boolean') setting.reloadRequired = data.reloadRequired
      if (typeof data.hostRestartRequired === 'boolean') setting.hostRestartRequired = data.hostRestartRequired
    }
  } else if (event.eventType === 'settings.write_failed' && typeof data.error === 'string') {
    error.value = data.error
  } else if (event.eventType === 'resources.reloaded') {
    resources.value = null
    tools.value = null
    if (props.section === 'resources' || props.section === 'tools') void loadSection(props.section, true)
  } else if ((event.eventType === 'model.changed' || event.eventType === 'thinking.changed') && models.value) {
    models.value.instance = props.work
  }
}

defineExpose({ reconcileDomain, applyLiveEvent })

async function loadSection(section: ControlSection, force = false): Promise<boolean> {
  if (['sessions', 'tree', 'new-session', 'rename-session', 'compact-session', 'reload-session'].includes(section)) return true
  const dataExists = section === 'commands'
    ? commands.value
    : section === 'models' || section === 'thinking'
      ? models.value
      : section === 'tools'
        ? tools.value
        : section === 'resources'
          ? resources.value
          : settings.value
  if (dataExists && !force) return true
  const epoch = ++loadEpoch
  const workId = props.work.id
  loading.value = section === 'commands' ? null : section
  error.value = ''
  try {
    if (section === 'commands') {
      const result = await currentHostCall((context) => commandCatalog(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      commands.value = result
      commandCatalogState.value = result.truncated ? 'truncated' : 'ready'
    } else if (section === 'models' || section === 'thinking') {
      const result = await currentHostCall((context) => listModels(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      models.value = result
      emit('snapshot', result.instance)
      if (section === 'models') {
        const current = result.instance.executor.model
        const currentLabel = current ? `${current.provider}/${current.id}` : '—'
        emit('title', '选择 Model', [`当前：${currentLabel}`, result.truncated ? `显示 ${result.models.length}/${result.total} 项` : ''].filter(Boolean).join('\n'))
      }
    } else if (section === 'tools') {
      const result = await currentHostCall((context) => listTools(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      tools.value = result
      emit('snapshot', result.instance)
    } else if (section === 'resources') {
      const [resourceResult, toolResult] = await Promise.all([
        currentHostCall((context) => getResources(workId, context)),
        currentHostCall((context) => listTools(workId, context)),
      ])
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      resources.value = resourceResult
      tools.value = toolResult
      emit('snapshot', toolResult.instance)
    } else {
      const result = await currentHostCall((context) => getSettings(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      settings.value = result
    }
    return true
  } catch (cause) {
    if (epoch === loadEpoch && props.work.id === workId) {
      if (section === 'commands') {
        commands.value = { commands: [], total: 0, truncated: false }
        commandCatalogState.value = 'failed'
      } else error.value = errorMessage(cause)
    }
    return false
  } finally {
    if (epoch === loadEpoch) loading.value = null
  }
}

async function runSelectedCommand() {
  const command = selectedCommand.value
  if (!command || props.preview || pending.value || props.outcomeUnknown || commandConsole.hasActiveOperation) return
  const operationId = crypto.randomUUID()
  pending.value = `command:${command.name}`
  error.value = ''
  commandConsole.beginOperation(operationId, command.name, commandArguments.value)
  try {
    const result = await currentHostCall((context) => runCatalogCommand(props.work.id, command.name, commandArguments.value, operationId, context))
    emit('snapshot', result.instance)
    commandConsole.receiveReceipt(operationId, result.receipt)
  } catch (cause) {
    commandConsole.failOperation(operationId, errorMessage(cause))
    if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, 'conversation')
  } finally {
    pending.value = ''
  }
}

async function chooseModel(model: ModelInfo) {
  if (props.preview || pending.value || props.outcomeUnknown || isCurrentModel(model)) return
  pending.value = `model:${model.provider}/${model.id}`
  error.value = ''
  try {
    const snapshot = await currentHostCall((context) => setModel(props.work.id, model.provider, model.id, context))
    emit('snapshot', snapshot)
    if (models.value) models.value.instance = snapshot
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'models')
  } finally {
    pending.value = ''
  }
}

async function chooseThinking(level: ThinkingLevel) {
  if (props.preview || pending.value || props.outcomeUnknown || props.work.executor.thinkingLevel === level) return
  pending.value = `thinking:${level}`
  error.value = ''
  try {
    const snapshot = await currentHostCall((context) => setThinking(props.work.id, level, context))
    emit('snapshot', snapshot)
    if (models.value) models.value.instance = snapshot
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'models')
  } finally {
    pending.value = ''
  }
}

async function toggleTool(tool: ToolInfo) {
  if (!tools.value || tools.value.truncated || props.preview || pending.value || props.outcomeUnknown) return
  const names = tools.value.tools.filter((item) => item.name === tool.name ? !tool.active : item.active).map((item) => item.name)
  pending.value = `tool:${tool.name}`
  error.value = ''
  try {
    const result = await currentHostCall((context) => setActiveTools(props.work.id, names, context))
    tools.value = result
    emit('snapshot', result.instance)
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'tools')
  } finally {
    pending.value = ''
  }
}

function settingValueDescription(setting: SettingInfo) {
  try { return JSON.stringify(setting.value) }
  catch { return String(setting.value) }
}

function openSetting(setting: SettingInfo) {
  if (!setting.writable) {
    emit('close')
    return
  }
  selectedSettingKey.value = setting.key
  settingDraft.value = setting.valueType === 'object' ? JSON.stringify(setting.value, null, 2) : String(setting.value ?? '')
  emit('title', setting.key)
  emit('size', 'default')
}

function saveSettingDraft(setting: SettingInfo) {
  let value: SettingValue
  if (setting.valueType === 'integer') {
    const raw = settingDraft.value.trim()
    if (!/^-?\d+$/.test(raw)) { error.value = `${setting.key}: 需要整数`; return }
    const number = Number(raw)
    if (!Number.isSafeInteger(number)) { error.value = `${setting.key}: 整数超出范围`; return }
    if (setting.min != null && number < setting.min) { error.value = `${setting.key}: 最小值为 ${setting.min}`; return }
    if (setting.max != null && number > setting.max) { error.value = `${setting.key}: 最大值为 ${setting.max}`; return }
    value = number
  } else if (setting.valueType === 'object') {
    try { value = JSON.parse(settingDraft.value) as SettingValue }
    catch { error.value = `${setting.key}: JSON 格式无效`; return }
  } else {
    value = settingDraft.value
  }
  void saveSetting(setting, value)
}

async function saveSetting(setting: SettingInfo, value: SettingValue) {
  if (!settings.value || !setting.writable || props.preview || pending.value || props.outcomeUnknown) return
  pending.value = `setting:${setting.key}`
  error.value = ''
  try {
    const result = await currentHostCall((context) => updateSetting(props.work.id, setting.key, value, context))
    const index = settings.value.settings.findIndex((item) => item.key === result.setting.key)
    if (index >= 0) settings.value.settings[index] = result.setting
    emit('snapshot', result.instance)
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'settings')
  } finally {
    pending.value = ''
  }
}

function mutationFailure(cause: unknown, domain: ControlMutationDomain) {
  error.value = errorMessage(cause)
  if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, domain)
}

function sectionDomain(section: ControlSection): ControlMutationDomain {
  if (section === 'commands') return 'conversation'
  if (section === 'models' || section === 'thinking') return 'models'
  if (section === 'resources') return 'conversation'
  if (['sessions', 'new-session', 'rename-session', 'compact-session', 'reload-session'].includes(section)) return 'sessions'
  return section as ControlMutationDomain
}

function formatProjectTokens(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const number = Number(value)
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${Math.floor(number / 1_000)}k`
  return String(number)
}
function contextLabel(work: Work) {
  const context = work.metrics?.context
  if (!context?.contextWindow) return '—'
  return `${formatProjectTokens(context.tokens)}/${formatProjectTokens(context.contextWindow)} · ${context.percent == null ? '—' : `${context.percent.toFixed(1)}%`}`
}

function lifecycleLabel(value: Work['lifecycle']) {
  return ({ active: '运行中', stopping: '正在停止', stopped: '已停止', host_lost: '连接已中断', runtime_error: '运行故障' } as Record<Work['lifecycle'], string>)[value]
}
function executionLabel(value: Work['execution']) {
  return ({ idle: '空闲', running: '运行中', failed: '运行失败', unavailable: '已停止' } as Record<Work['execution'], string>)[value]
}
function runLabel(value: string) {
  return ({ never: '尚未运行', succeeded: '已完成', failed: '失败', aborted: '已中止', interrupted: '已打断' } as Record<string, string>)[value] ?? '状态已更新'
}

function isCurrentModel(model: ModelInfo) {
  const current = props.work.executor.model
  return current?.provider === model.provider && current.id === model.id
}

function sourceLabel(kind: string) {
  return ({ 'built-in': 'WebConsole', extension: 'Extension', skill: 'Skill', prompt: 'Prompt' } as Record<string, string>)[kind] ?? kind
}

</script>

<template>
  <div class="control-center-port">
    <div v-if="outcomeUnknown" class="alu-dialog-error"><span>上一次修改的结果还没有确认，请先刷新当前状态。</span><button @click="reconcileControl">刷新确认</button></div>
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="loading === section" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取…</div>

    <template v-if="section === 'commands'">
      <template v-if="!commandRunnerOpen">
        <div class="cmd-palette-search-wrap">
          <span class="cmd-palette-search-icon">⌙</span>
          <input v-model="commandSearch" class="cmd-palette-input" placeholder="搜索 WebConsole、Extension、Skill 和 Prompt 命令…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cmd-palette-list" autofocus @keydown="handleCommandKeydown" />
          <kbd class="cmd-palette-kbd">ESC</kbd>
          <button class="cmd-palette-close" aria-label="关闭" @click="$emit('close')">×</button>
        </div>
        <div id="cmd-palette-list" class="cmd-palette-list" role="listbox">
          <div v-if="filteredStaticCommands.length" class="cmd-palette-group">WebConsole</div>
          <button v-for="(item, index) in filteredStaticCommands" :key="item.id" class="cmd-palette-item" :class="{ selected: commandSelectedIndex === index }" role="option" :aria-selected="commandSelectedIndex === index" @mouseenter="commandSelectedIndex = index" @click="activateStatic(item)">
            <span class="cmd-palette-item-icon">{{ item.glyph }}</span>
            <span class="cmd-palette-item-copy"><span class="cmd-palette-item-top"><span class="cmd-palette-item-label">{{ item.label }}</span></span><span class="cmd-palette-item-desc">{{ item.description }}</span></span>
          </button>
          <template v-if="filteredCommands.length">
            <div class="cmd-palette-group">Pi Commands</div>
            <button v-for="(item, index) in filteredCommands" :key="`${item.source.kind}:${item.name}`" class="cmd-palette-item" :class="{ selected: commandSelectedIndex === filteredStaticCommands.length + index }" role="option" :aria-selected="commandSelectedIndex === filteredStaticCommands.length + index" @mouseenter="commandSelectedIndex = filteredStaticCommands.length + index" @click="openCommandRunner(item.name)">
              <span class="cmd-palette-item-icon">›</span>
              <span class="cmd-palette-item-copy"><span class="cmd-palette-item-top"><span class="cmd-palette-item-label">/{{ item.name }}</span><span class="cmd-palette-item-hint">{{ sourceLabel(item.source.kind) }}</span></span><span class="cmd-palette-item-desc">{{ item.description || 'Dock 未提供说明' }}</span></span>
            </button>
          </template>
          <div v-if="!filteredStaticCommands.length && !filteredCommands.length" class="cmd-palette-empty">{{ commandCatalogState === 'loading' ? '正在读取命令…' : '无匹配命令' }}</div>
        </div>
        <div class="cmd-palette-footer">{{ commandFooter }}</div>
      </template>

      <template v-else-if="selectedCommand">
        <div class="cmd-center-header"><button class="cmd-center-back" aria-label="返回命令列表" :disabled="!!pending || commandConsole.hasActiveOperation" @click="commandRunnerOpen = false">←</button><div class="cmd-center-identity"><strong>/{{ selectedCommand.name }}</strong><span>{{ sourceLabel(selectedCommand.source.kind) }}</span></div><button class="cmd-palette-close" aria-label="关闭" @click="$emit('close')">×</button></div>
        <div class="cmd-center-description">{{ selectedCommand.description || 'Dock 未提供此命令的说明。' }}</div>
        <form class="cmd-center-command-form" @submit.prevent="runSelectedCommand"><span class="cmd-center-command-prefix">/{{ selectedCommand.name }}</span><input v-model="commandArguments" class="cmd-center-args" placeholder="参数（可留空）" autocomplete="off" spellcheck="false" /><button class="cmd-center-run" :disabled="preview || !!pending || outcomeUnknown || commandConsole.hasActiveOperation">{{ pending || commandConsole.hasActiveOperation ? '运行中…' : '运行' }}</button></form>
        <div class="cmd-center-output" role="log" aria-live="polite">
          <div v-for="entry in commandConsole.entries" :key="entry.id" class="cmd-center-entry" :class="[`cmd-center-entry-${entry.kind}`, entry.level ? `is-${entry.level}` : '']"><span class="cmd-center-entry-marker">{{ entry.kind === 'command' ? '›' : entry.kind === 'status' ? '·' : entry.level === 'error' ? '!' : entry.level === 'warning' ? '△' : '│' }}</span><div class="cmd-center-entry-text">{{ entry.text }}</div></div>
          <div v-if="!commandConsole.entries.length" class="cmd-center-output-empty">命令结果会显示在这里，不会进入主要对话。</div>
        </div>
        <div class="cmd-palette-footer cmd-center-footer">{{ pending || commandConsole.hasActiveOperation ? '命令正在执行；关闭面板不会取消。' : 'Enter 运行 · Tab 保持网页焦点导航 · Esc 关闭' }}</div>
      </template>
    </template>

    <SessionManager
      v-else-if="['sessions', 'tree', 'new-session', 'rename-session', 'compact-session', 'reload-session'].includes(section)"
      ref="sessionManager"
      :work="work"
      :mode="sessionMode"
      :preview="preview"
      :outcome-unknown="outcomeUnknown"
      :has-draft="hasDraft"
      :compaction-pending="compactionPending"
      @snapshot="forwardSessionSnapshot"
      @unknown="forwardSessionUnknown"
      @resync="forwardSessionResync"
      @compact="forwardSessionCompact"
      @title="forwardSessionTitle"
      @close="$emit('close')"
    />

    <section v-else-if="section === 'models'" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="modelSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
      <div class="ui-dialog-options">
        <button v-for="model in filteredModels" :key="`${model.provider}/${model.id}`" class="ui-dialog-option" :class="{ 'is-current': isCurrentModel(model) }" :disabled="preview || !!pending || outcomeUnknown" @click="chooseModel(model)"><span class="ui-dialog-option-marker">{{ isCurrentModel(model) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ model.provider }}/{{ model.id }}</span><span v-if="isCurrentModel(model)" class="ui-dialog-option-badge">CURRENT</span></span><span v-if="model.name && model.name !== model.id" class="ui-dialog-option-detail"><span>{{ model.name }}</span></span></span></button>
        <div v-if="models && !filteredModels.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
    </section>

    <section v-else-if="section === 'thinking'" class="alu-select-panel"><div class="ui-dialog-options"><button v-for="level in models?.availableThinkingLevels ?? []" :key="level" class="ui-dialog-option" :class="{ 'is-current': work.executor.thinkingLevel === level }" :disabled="preview || !!pending || outcomeUnknown" @click="chooseThinking(level)"><span class="ui-dialog-option-marker">{{ work.executor.thinkingLevel === level ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ level }}</span><span v-if="work.executor.thinkingLevel === level" class="ui-dialog-option-badge">CURRENT</span></span></span></button></div></section>

    <section v-else-if="section === 'tools'" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="toolSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
      <div v-if="tools?.truncated" class="alu-project-status-note">工具列表未完整返回，暂时不能切换工具。</div>
      <div class="ui-dialog-options"><button v-for="tool in filteredTools" :key="tool.name" class="ui-dialog-option" :class="{ 'is-current': tool.active }" :disabled="preview || !!pending || outcomeUnknown || !!tools?.truncated" @click="toggleTool(tool)"><span class="ui-dialog-option-marker">{{ tool.active ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ tool.name }}</span><span v-if="tool.active" class="ui-dialog-option-badge">ACTIVE</span></span><span class="ui-dialog-option-detail"><span>{{ tool.description }}</span></span></span></button></div>
    </section>

    <section v-else-if="section === 'resources'" class="alu-project-status">
      <section class="alu-project-status-identity">
        <span class="alu-project-status-signal" :class="`is-${work.lifecycle}`" />
        <div class="alu-project-status-identity-copy"><strong>{{ work.name || work.key || '未命名 Work' }}</strong><span>{{ work.cwd || '—' }}</span></div>
        <div class="alu-project-status-badges"><span class="alu-project-status-badge">{{ lifecycleLabel(work.lifecycle) }}</span><span class="alu-project-status-badge" :class="{ 'is-running': work.execution === 'running' }">{{ executionLabel(work.execution) }}</span><span v-if="work.gitBranch" class="alu-project-status-badge is-branch"> {{ work.gitBranch }}</span></div>
      </section>
      <section class="alu-project-status-section">
        <h3>Session</h3>
        <dl class="alu-project-status-grid"><div class="alu-project-status-metric"><dt>Model</dt><dd>{{ work.executor.model ? `${work.executor.model.provider}/${work.executor.model.id}` : '—' }}</dd></div><div class="alu-project-status-metric"><dt>Thinking</dt><dd>{{ work.executor.thinkingLevel || '—' }}</dd></div><div class="alu-project-status-metric"><dt>Context</dt><dd>{{ contextLabel(work) }}</dd></div><div class="alu-project-status-metric"><dt>Cost</dt><dd>{{ work.metrics?.cost == null ? '—' : `$${Number(work.metrics.cost).toFixed(2)}` }}</dd></div><div class="alu-project-status-metric"><dt>Queue</dt><dd>{{ Number(work.pending.total) || 0 }}</dd></div><div class="alu-project-status-metric"><dt>Last run</dt><dd>{{ runLabel(work.lastRun) }}</dd></div></dl>
        <div v-if="work.lastError" class="alu-project-status-error">{{ work.lastError }}</div>
      </section>
      <section class="alu-project-status-section">
        <h3>Active Tools <span class="alu-project-status-count">{{ tools?.tools.filter(item => item.active).length || 0 }}/{{ tools?.total ?? tools?.tools.length ?? 0 }}</span></h3>
        <div class="alu-project-status-chips"><span v-for="tool in tools?.tools.filter(item => item.active) ?? []" :key="tool.name" class="alu-project-status-chip">{{ tool.name }}</span><span v-if="!tools?.tools.some(item => item.active)" class="alu-project-status-empty">当前没有启用工具</span></div>
        <div v-if="tools?.truncated" class="alu-project-status-note">工具列表未完整返回</div>
      </section>
      <section class="alu-project-status-section">
        <h3>Loaded Resources</h3>
        <div v-for="group in resourceGroups" :key="group.kind" class="alu-project-status-resource-group"><h4>{{ group.label }} <span class="alu-project-status-count">{{ group.items.length }}</span></h4><div class="alu-project-status-chips"><span v-for="resource in group.items" :key="`${resource.kind}:${resource.name}`" class="alu-project-status-chip">{{ resource.name }}</span><span v-if="!group.items.length" class="alu-project-status-empty">—</span></div></div>
        <div v-if="filteredDiagnostics.length" class="alu-project-status-resource-group"><h4>Diagnostics <span class="alu-project-status-count">{{ resources?.diagnosticTotal ?? filteredDiagnostics.length }}</span></h4><div v-for="(diagnostic, index) in filteredDiagnostics" :key="index" class="alu-project-status-diagnostic" :class="`is-${diagnostic.severity}`">{{ diagnostic.message }}</div></div>
        <div v-if="resources?.resourcesTruncated || resources?.diagnosticsTruncated" class="alu-project-status-note">资源或诊断列表未完整返回</div>
      </section>
    </section>

    <section v-else-if="!selectedSetting" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="settingsSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" /></div>
      <div class="ui-dialog-options">
        <button v-for="setting in filteredSettings" :key="setting.key" class="ui-dialog-option" @click="openSetting(setting)">
          <span class="ui-dialog-option-marker">•</span>
          <span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ setting.key }}</span><span class="ui-dialog-option-badge">{{ setting.writable ? 'EDITABLE' : 'READ ONLY' }}</span></span><span class="ui-dialog-option-detail"><span>{{ settingValueDescription(setting) }}</span></span></span>
        </button>
        <div v-if="settings && !filteredSettings.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
    </section>

    <section v-else class="alu-session-form alu-setting-editor">
      <div v-if="selectedSetting.valueType === 'boolean'" class="ui-dialog-options">
        <button class="ui-dialog-option" :disabled="preview || !!pending || outcomeUnknown" @click="saveSetting(selectedSetting, true)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === true ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">开启</span></span></button>
        <button class="ui-dialog-option" :disabled="preview || !!pending || outcomeUnknown" @click="saveSetting(selectedSetting, false)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === false ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">关闭</span></span></button>
      </div>
      <div v-else-if="selectedSetting.valueType === 'enum'" class="ui-dialog-options">
        <button v-for="value in selectedSetting.allowedValues" :key="String(value)" class="ui-dialog-option" :disabled="preview || !!pending || outcomeUnknown" @click="saveSetting(selectedSetting, value)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === value ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ value }}</span></span></button>
      </div>
      <template v-else>
        <textarea v-if="selectedSetting.valueType === 'object'" v-model="settingDraft" class="ui-dialog-editor" rows="8" />
        <input v-else v-model="settingDraft" class="ui-dialog-input" :inputmode="selectedSetting.valueType === 'integer' ? 'numeric' : 'text'" />
        <div class="ui-dialog-form-footer"><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending || outcomeUnknown" @click="saveSettingDraft(selectedSetting)">确认</button></div>
      </template>
    </section>
  </div>
</template>
