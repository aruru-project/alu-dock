<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Brain, ChevronRight, Cpu, GitFork, History, Info, LayoutList, Pencil, Plus, RotateCw, Search, Settings, Square, Undo2, Wrench, Zap } from '@lucide/vue'
import {
  getCommandCompletions,
  getCommandContent,
  runCatalogCommand,
  setActiveTools,
  setModel,
  setThinking,
  updateSetting,
  sessionContext,
  type SessionContext,
} from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { catalogSourceLabel, commandGoesToComposer, filterCatalogCommands, filterCommandPaletteItems } from '../lib/commandSuggest'
import { dockToolsState } from '../lib/dockTools'
import { localControlCommands, type ControlSection, type LocalControlCommand } from '../lib/localCommands'
import { settingDescription, settingLabel, settingOptionLabel, settingValueLabel } from '../lib/settingLabels'
import { formatContextUsage, workPresence } from '../lib/uiBoundaries'
import SessionManager from './SessionManager.vue'
import ResourceDocument from './ResourceDocument.vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../stores/app'
import { useCommandCatalogStore } from '../stores/command-catalog'
import { useCommandConsoleStore } from '../stores/command-console'
import { useControlPanelStore, type ControlMutationDomain } from '../stores/control-panel'
import type {
  CommandArgumentCompletion,
  CommandInfo,
  ModelInfo,
  ResourceInfo,
  SettingInfo,
  SettingKey,
  SettingValue,
  ThinkingLevel,
  ToolInfo,
  Work,
} from '../lib/types'

const props = defineProps<{ work: Work; section: ControlSection; outcomeUnknown: boolean; unknownDomain?: ControlMutationDomain; compactionPending: boolean }>()
const app = useAppStore()
const panel = useControlPanelStore()
const { models, tools, resources, settings, loading, loadErrors } = storeToRefs(panel)
const { loadSection } = panel
const catalog = useCommandCatalogStore()
const commandConsole = useCommandConsoleStore()
const presence = computed(() => workPresence(props.work))
const emit = defineEmits<{
  unknown: [cause: unknown, domain: ControlMutationDomain, scope: SessionContext]
  reconcile: [domain?: ControlMutationDomain]
  section: [section: ControlSection]
  prefill: [name: string]
  compact: [customInstructions?: string]
  close: []
  stop: []
  restoreQueue: []
  title: [title: string, body?: string]
  size: [size: 'default' | 'wide' | 'tree']
}>()

const localControlIcons = {
  session_new: Plus,
  stop: Square,
  resume: History,
  tree: GitFork,
  model: Cpu,
  thinking: Brain,
  name: Pencil,
  compact: Zap,
  reload: RotateCw,
  dequeue: Undo2,
  tools: Wrench,
  settings: Settings,
  state: Info,
  resources: LayoutList,
} as const
const staticCommands = localControlCommands.map((command) => ({ ...command, icon: localControlIcons[command.id as keyof typeof localControlIcons] }))

const commandSearch = ref('')
const modelSearch = ref('')
const toolSearch = ref('')
const resourceSearch = ref('')
const settingsSearch = ref('')
const selectedSettingKey = ref<SettingKey | ''>('')
const settingDraft = ref('')
const selectedCommandReferenceId = ref('')
const commandDetailMode = ref<'runner' | 'content' | ''>('')
const commandArguments = ref('')
const argumentCompletions = ref<CommandArgumentCompletion[]>([])
const argumentCompletionsLoading = ref(false)
const commandContentText = ref('')
const commandContentLoading = ref(false)
let commandCompletionTimer = 0
let commandCompletionEpoch = 0
let commandContentEpoch = 0
const MAX_VISIBLE_COMMAND_CONTENT_CHARS = 4_000_000
const commandSelectedIndex = ref(0)
const commandSearchInput = ref<HTMLInputElement | null>(null)
const commandArgsInput = ref<HTMLInputElement | null>(null)
const selectedResource = ref<ResourceInfo | null>(null)
const pending = ref('')
const error = ref('')
const dockToolsOperationId = ref('')
// A settings write that fails after the reply is reported by the live event.
onUnmounted(panel.onWriteFailed((message) => { error.value = message }))
// Resources reloaded by the Agent close the open resource document.
watch(resources, (value) => { if (!value) selectedResource.value = null })

const selectedCommand = computed(() => catalog.commands.find((item) => item.referenceId === selectedCommandReferenceId.value) ?? null)
const dockToolsCommand = computed(() => catalog.commands.find((item) => item.name === 'dock-tools') ?? null)
const dockTools = computed(() => dockToolsState(props.work.extensionStatus))
const dockToolsLabel = computed(() => dockTools.value === 'on' ? '已开启' : dockTools.value === 'unavailable' ? '当前不可用' : '已关闭')
const dockToolsBusy = computed(() => pending.value === 'command:dock-tools' || (!!dockToolsOperationId.value && commandConsole.isActive(dockToolsOperationId.value)))
const dockToolsEntries = computed(() => dockToolsOperationId.value
  ? commandConsole.entries.filter((entry) => entry.operationId === dockToolsOperationId.value)
  : [])
const selectedSetting = computed(() => settings.value?.settings.find((item) => item.key === selectedSettingKey.value) ?? null)
const sessionMode = computed(() => props.section as 'sessions' | 'tree' | 'new-session' | 'rename-session' | 'compact-session' | 'reload-session')
const filteredStaticCommands = computed(() => filterCommandPaletteItems(staticCommands, commandSearch.value))
const catalogCommands = computed(() => {
  const localNames = new Set(localControlCommands.map((command) => command.name))
  return catalog.commands.filter((item) => !localNames.has(item.name))
})
const filteredCommands = computed(() => filterCatalogCommands(catalogCommands.value, commandSearch.value))
const commandSelections = computed(() => [
  ...filteredStaticCommands.value.map((item) => ({ kind: 'static' as const, item })),
  ...filteredCommands.value.map((item) => ({ kind: 'catalog' as const, item })),
])
const commandFooter = computed(() => {
  const count = catalogCommands.value.length
  if (catalog.state === 'idle' || catalog.state === 'loading') return '正在同步当前 Session 的 Extension、Skill 和 Prompt 命令…'
  if (catalog.state === 'truncated') return `显示 ${count} 个 Pi 命令（目录未完整返回）`
  if (catalog.state === 'failed') return 'Pi 命令目录暂时不可用 · Work 操作仍可使用'
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
  return (settings.value?.settings ?? []).filter((setting) => !query || `${settingLabel(setting.key)} ${settingDescription(setting.key)} ${settingValueLabel(setting.key, setting.value)} ${setting.key}`.toLowerCase().includes(query))
})

watch(commandSearch, () => { commandSelectedIndex.value = 0 })
watch([commandArguments, selectedCommand], () => scheduleArgumentCompletions())
onUnmounted(() => window.clearTimeout(commandCompletionTimer))
watch(commandSelections, (items) => {
  commandSelectedIndex.value = Math.max(0, Math.min(commandSelectedIndex.value, items.length - 1))
})
watch(commandSelectedIndex, async () => {
  await nextTick()
  document.getElementById(`cmd-opt-${commandSelectedIndex.value}`)?.scrollIntoView({ block: 'nearest' })
})

/** 子面板（Model/Thinking/Tools/Settings）共用一组键盘游标：方向键移动、Enter 激活、跟随滚动。 */
const optionCursor = ref(0)
const thinkingPanel = ref<HTMLElement | null>(null)
watch([filteredModels, filteredTools, filteredSettings], () => { optionCursor.value = 0 })
watch(optionCursor, async () => {
  await nextTick()
  document.getElementById(`cc-opt-${optionCursor.value}`)?.scrollIntoView({ block: 'nearest' })
})

watch([
  () => app.activeConnectionId,
  () => app.connectionContext?.selectionGeneration,
  () => props.work.id,
  () => props.work.hostId,
  () => props.work.ownerHostEpoch,
  () => props.work.runtimeGeneration,
], () => {
  panel.reset()
  selectedResource.value = null
  selectedCommandReferenceId.value = ''
  commandDetailMode.value = ''
  argumentCompletions.value = []
  commandContentText.value = ''
  dockToolsOperationId.value = ''
  error.value = ''
  void loadSection(props.section)
}, { immediate: true })
watch(() => props.section, (section) => {
  selectedResource.value = null
  selectedSettingKey.value = ''
  optionCursor.value = 0
  error.value = ''
  void loadSection(section)
  if (section === 'thinking') void nextTick(() => thinkingPanel.value?.focus())
})

async function closeResource() {
  const contentRef = selectedResource.value?.contentRef
  selectedResource.value = null
  await nextTick()
  if (contentRef) document.getElementById(`resource-${contentRef}`)?.focus()
}

function reconcileControl() {
  // Without an unconfirmed setting, the Work's own unconfirmed result (Stop, Continue) is refreshed.
  emit('reconcile', props.unknownDomain)
}

function forwardSessionUnknown(cause: unknown, domain: 'sessions' | 'tree', scope: SessionContext) {
  emit('unknown', cause, domain, scope)
}

function forwardSessionTitle(title: string, body?: string) {
  emit('title', title, body)
}

function sessionActionFinished() { emit('close') }

function forwardSessionCompact(customInstructions?: string) {
  emit('compact', customInstructions)
}

function activateStatic(item: LocalControlCommand) {
  if (item.section) emit('section', item.section)
  else if (item.action === 'stop') emit('stop')
  else emit('restoreQueue')
}

function activateCommandIndex(index = commandSelectedIndex.value) {
  const selected = commandSelections.value[index]
  if (!selected) return
  if (selected.kind === 'static') activateStatic(selected.item)
  else activateCatalogCommand(selected.item)
}

/** prompt/skill 命令的本质是发一条消息：草稿空着时直接填进输入框交回对话；
 *  草稿有内容时不覆盖用户文本，留在面板走运行表单。extension 命令有独立输出，始终走运行表单。 */
function activateCatalogCommand(item: CommandInfo) {
  if (commandGoesToComposer(item)) {
    emit('prefill', item.name)
    return
  }
  openCommandRunner(item)
}

/** 子面板键盘处理：方向键移动游标、Enter 激活当前项。 */
function handleOptionKeydown<T>(event: KeyboardEvent, items: readonly T[], activate: (item: T) => void) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    optionCursor.value = Math.min(optionCursor.value + 1, items.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    optionCursor.value = Math.max(optionCursor.value - 1, 0)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = items[optionCursor.value]
    if (item) activate(item)
  }
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

function openCommandRunner(command: CommandInfo) {
  selectedCommandReferenceId.value = command.referenceId
  commandArguments.value = ''
  argumentCompletions.value = []
  commandDetailMode.value = 'runner'
  void nextTick(() => commandArgsInput.value?.focus())
}

function backToCatalog() {
  commandCompletionEpoch += 1
  commandContentEpoch += 1
  window.clearTimeout(commandCompletionTimer)
  commandDetailMode.value = ''
  argumentCompletions.value = []
  void nextTick(() => commandSearchInput.value?.focus())
}

function scheduleArgumentCompletions() {
  window.clearTimeout(commandCompletionTimer)
  const command = selectedCommand.value
  if (commandDetailMode.value !== 'runner' || !command?.argumentCompletions) {
    commandCompletionEpoch += 1
    argumentCompletions.value = []
    argumentCompletionsLoading.value = false
    return
  }
  const prefix = commandArguments.value
  const epoch = ++commandCompletionEpoch
  argumentCompletionsLoading.value = true
  commandCompletionTimer = window.setTimeout(() => void loadArgumentCompletions(command, prefix, epoch), 160)
}

async function loadArgumentCompletions(command: CommandInfo, prefix: string, epoch: number) {
  try {
    const result = await currentConnectionCall(app, (context) => getCommandCompletions(props.work.id, command.referenceId, prefix, context))
    if (epoch !== commandCompletionEpoch || selectedCommand.value?.referenceId !== command.referenceId || commandArguments.value !== prefix) return
    argumentCompletions.value = result.referenceId === command.referenceId ? result.items ?? [] : []
  } catch (cause) {
    if (epoch === commandCompletionEpoch) {
      argumentCompletions.value = []
      error.value = errorMessage(cause)
    }
  } finally {
    if (epoch === commandCompletionEpoch) argumentCompletionsLoading.value = false
  }
}

function chooseArgumentCompletion(item: CommandArgumentCompletion) {
  commandArguments.value = item.value
  void nextTick(() => commandArgsInput.value?.focus())
}

async function openCommandContent(command: CommandInfo) {
  selectedCommandReferenceId.value = command.referenceId
  commandDetailMode.value = 'content'
  commandContentText.value = ''
  commandContentLoading.value = true
  error.value = ''
  const epoch = ++commandContentEpoch
  try {
    const context = app.connectionContext
    if (!context) return
    let cursor: string | undefined
    let revision = ''
    const seenCursors = new Set<string>()
    let pageCount = 0
    do {
      pageCount += 1
      if (pageCount > 128) throw new Error('Prompt 内容过长，当前客户端无法完整显示。')
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('Prompt 内容没有完整读出，请重新打开。')
        seenCursors.add(cursor)
      }
      const page = await currentConnectionCall(app, (captured) => getCommandContent(props.work.id, command.referenceId, cursor, captured))
      if (epoch !== commandContentEpoch || selectedCommand.value?.referenceId !== command.referenceId || commandDetailMode.value !== 'content') return
      if (page.referenceId !== command.referenceId || !page.available) {
        error.value = '这条 Prompt 当前没有可读取的内容。'
        return
      }
      if (revision && page.revision !== revision) throw new Error('Prompt 内容已更新，请重新打开。')
      revision = page.revision
      if (commandContentText.value.length + page.text.length > MAX_VISIBLE_COMMAND_CONTENT_CHARS) {
        throw new Error('Prompt 内容过长，当前客户端无法完整显示。')
      }
      commandContentText.value += page.text
      cursor = page.complete ? undefined : page.nextCursor
      if (page.complete) break
    } while (cursor)
  } catch (cause) {
    if (epoch === commandContentEpoch) {
      commandContentText.value = ''
      error.value = errorMessage(cause)
    }
  } finally {
    if (epoch === commandContentEpoch) commandContentLoading.value = false
  }
}

async function executeCatalogCommand(command: CommandInfo, argumentsText: string): Promise<boolean> {
  if (pending.value) return false
  const operationId = crypto.randomUUID()
  pending.value = `command:${command.name}`
  error.value = ''
  commandConsole.beginOperation(operationId, command.name, argumentsText)
  if (command.name === 'dock-tools') dockToolsOperationId.value = operationId
  const scope: SessionContext = Object.freeze(sessionContext(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }, props.work))
  try {
    const result = await currentConnectionCall(app, (context) => runCatalogCommand(props.work.id, command.name, argumentsText, operationId, app.captureOperationTarget(context, props.work.id)))
    commandConsole.receiveReceipt(operationId, result.receipt)
    return true
  } catch (cause) {
    if (commandConsole.operationSucceeded(operationId)) return true
    commandConsole.failOperation(operationId, errorMessage(cause))
    if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, 'conversation', scope)
    return false
  } finally {
    pending.value = ''
  }
}

async function runSelectedCommand() {
  const command = selectedCommand.value
  if (!command) return
  if (await executeCatalogCommand(command, commandArguments.value)) commandArguments.value = ''
}

async function toggleDockTools() {
  const command = dockToolsCommand.value
  if (!command || dockTools.value === 'unavailable') return
  await executeCatalogCommand(command, dockTools.value === 'on' ? 'off' : 'on')
}

async function chooseModel(model: ModelInfo) {
  if (pending.value || isCurrentModel(model)) return
  pending.value = `model:${model.provider}/${model.id}`
  error.value = ''
  const scope: SessionContext = Object.freeze(sessionContext(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }, props.work))
  try {
    const snapshot = await currentConnectionCall(app, (context) => setModel(props.work.id, model.provider, model.id, app.captureOperationTarget(context, props.work.id)))
    if (models.value) models.value.instance = snapshot
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'models', scope)
  } finally {
    pending.value = ''
  }
}

async function chooseThinking(level: ThinkingLevel) {
  if (pending.value || props.work.executor.thinkingLevel === level) return
  pending.value = `thinking:${level}`
  error.value = ''
  const scope: SessionContext = Object.freeze(sessionContext(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }, props.work))
  try {
    const snapshot = await currentConnectionCall(app, (context) => setThinking(props.work.id, level, app.captureOperationTarget(context, props.work.id)))
    if (models.value) models.value.instance = snapshot
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'models', scope)
  } finally {
    pending.value = ''
  }
}

async function toggleTool(tool: ToolInfo) {
  if (!tools.value || tools.value.truncated || pending.value) return
  const names = tools.value.tools.filter((item) => item.name === tool.name ? !tool.active : item.active).map((item) => item.name)
  pending.value = `tool:${tool.name}`
  error.value = ''
  const scope: SessionContext = Object.freeze(sessionContext(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }, props.work))
  try {
    const result = await currentConnectionCall(app, (context) => setActiveTools(props.work.id, names, app.captureOperationTarget(context, props.work.id)))
    tools.value = result
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'tools', scope)
  } finally {
    pending.value = ''
  }
}

function settingValueDescription(setting: SettingInfo) {
  return settingValueLabel(setting.key, setting.value)
}

function anthropicExtraUsageWarning(setting: SettingInfo) {
  return typeof setting.value === 'object' && setting.value.anthropicExtraUsage !== false
}

function openSetting(setting: SettingInfo) {
  if (!setting.writable) {
    emit('close')
    return
  }
  selectedSettingKey.value = setting.key
  settingDraft.value = setting.valueType === 'object' ? JSON.stringify(setting.value, null, 2) : String(setting.value ?? '')
  emit('title', settingLabel(setting.key))
  emit('size', 'default')
}

function saveSettingDraft(setting: SettingInfo) {
  let value: SettingValue
  if (setting.valueType === 'integer') {
    const raw = settingDraft.value.trim()
    const label = settingLabel(setting.key)
    if (!/^-?\d+$/.test(raw)) { error.value = `${label}需要填写整数`; return }
    const number = Number(raw)
    if (!Number.isSafeInteger(number)) { error.value = `${label}超出可填写的范围`; return }
    if (setting.min != null && number < setting.min) { error.value = `${label}不能小于 ${setting.min}`; return }
    if (setting.max != null && number > setting.max) { error.value = `${label}不能大于 ${setting.max}`; return }
    value = number
  } else if (setting.valueType === 'object') {
    try { value = JSON.parse(settingDraft.value) as SettingValue }
    catch { error.value = `${settingLabel(setting.key)}的内容格式有误`; return }
  } else {
    value = settingDraft.value
  }
  void saveSetting(setting, value)
}

async function saveSetting(setting: SettingInfo, value: SettingValue) {
  if (!settings.value || !setting.writable || pending.value) return
  pending.value = `setting:${setting.key}`
  error.value = ''
  const scope: SessionContext = Object.freeze(sessionContext(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }, props.work))
  try {
    const result = await currentConnectionCall(app, (context) => updateSetting(props.work.id, setting.key, value, app.captureOperationTarget(context, props.work.id)))
    const index = settings.value.settings.findIndex((item) => item.key === result.setting.key)
    if (index >= 0) settings.value.settings[index] = result.setting
    emit('close')
  } catch (cause) {
    mutationFailure(cause, 'settings', scope)
  } finally {
    pending.value = ''
  }
}

function mutationFailure(cause: unknown, domain: ControlMutationDomain, scope: SessionContext) {
  error.value = errorMessage(cause)
  if (cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true) emit('unknown', cause, domain, scope)
}

function runLabel(value: string) {
  return ({ never: '尚未运行', succeeded: '已完成', failed: '失败', aborted: '已中止', interrupted: '已打断' } as Record<string, string>)[value] ?? '状态已更新'
}

function isCurrentModel(model: ModelInfo) {
  const current = props.work.executor.model
  return current?.provider === model.provider && current.id === model.id
}

</script>

<template>
  <div class="control-center-port">
    <div v-if="outcomeUnknown" class="alu-dialog-pending" role="status"><span>上一次修改的结果还没有确认。可以刷新查看，也可以直接继续操作。</span><button @click="reconcileControl">刷新确认</button></div>
    <div v-if="error" class="alu-dialog-error">{{ error }}</div>
    <div v-if="section !== 'resources' && loadErrors[section]" class="alu-dialog-error">{{ loadErrors[section] }}<button type="button" @click="loadSection(section, true)">重试</button></div>
    <div v-if="!['commands', 'dock-tools', 'resources'].includes(section) && loading.has(section)" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取当前工作状态…</div>

    <template v-else-if="section === 'commands'">
      <template v-if="!commandDetailMode">
        <div class="cmd-palette-search-wrap">
          <span class="cmd-palette-search-icon"><Search :size="15" /></span>
          <input ref="commandSearchInput" v-model="commandSearch" class="cmd-palette-input" placeholder="搜索 Work 操作、Extension、Skill 和 Prompt…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cmd-palette-list" :aria-activedescendant="commandSelections.length ? `cmd-opt-${commandSelectedIndex}` : undefined" autofocus @keydown="handleCommandKeydown" />
          <kbd class="cmd-palette-kbd">ESC</kbd>
          <button class="cmd-palette-close" aria-label="关闭" @click="$emit('close')">×</button>
        </div>
        <div id="cmd-palette-list" class="cmd-palette-list" role="listbox">
          <div v-if="filteredStaticCommands.length" class="cmd-palette-group">Work 操作</div>
          <button v-for="(item, index) in filteredStaticCommands" :key="item.id" :id="`cmd-opt-${index}`" class="cmd-palette-item" :class="{ selected: commandSelectedIndex === index, 'is-important': item.id === 'stop' }" role="option" :aria-selected="commandSelectedIndex === index" @mouseenter="commandSelectedIndex = index" @click="activateStatic(item)">
            <span class="cmd-palette-item-icon"><component :is="item.icon" :size="13" /></span>
            <span class="cmd-palette-item-copy"><span class="cmd-palette-item-top"><span class="cmd-palette-item-label">{{ item.label }}</span></span><span class="cmd-palette-item-desc">{{ item.description }}</span></span>
          </button>
          <template v-if="filteredCommands.length">
            <div class="cmd-palette-group">Pi Commands</div>
            <div v-for="(item, index) in filteredCommands" :key="item.referenceId" class="cmd-palette-item-row">
              <button :id="`cmd-opt-${filteredStaticCommands.length + index}`" class="cmd-palette-item" :class="{ selected: commandSelectedIndex === filteredStaticCommands.length + index }" role="option" :aria-selected="commandSelectedIndex === filteredStaticCommands.length + index" @mouseenter="commandSelectedIndex = filteredStaticCommands.length + index" @click="activateCatalogCommand(item)">
                <span class="cmd-palette-item-icon"><ChevronRight :size="13" /></span>
                <span class="cmd-palette-item-copy"><span class="cmd-palette-item-top"><span class="cmd-palette-item-label">/{{ item.name }}<span v-if="item.argumentHint" class="cmd-palette-item-argument"> {{ item.argumentHint }}</span></span><span class="cmd-palette-item-hint">{{ catalogSourceLabel(item.source.kind) }}</span></span><span class="cmd-palette-item-desc">{{ item.description || 'Dock 未提供说明' }}</span></span>
              </button>
              <button v-if="item.contentAvailable" type="button" class="cmd-palette-content-btn" :aria-label="`查看 /${item.name} 的 Prompt 内容`" @click="openCommandContent(item)">内容</button>
            </div>
          </template>
          <div v-if="!filteredStaticCommands.length && !filteredCommands.length" class="cmd-palette-empty">{{ catalog.state === 'idle' || catalog.state === 'loading' ? '正在读取命令…' : '无匹配命令' }}</div>
        </div>
        <div class="cmd-palette-footer">{{ commandFooter }}<button v-if="catalog.state === 'failed'" type="button" @click="loadSection('commands', true)">重试读取命令</button></div>
      </template>

      <template v-else-if="selectedCommand && commandDetailMode === 'runner'">
        <div class="cmd-center-header"><button class="cmd-center-back" aria-label="返回命令列表" :disabled="!!pending" @click="backToCatalog">←</button><div class="cmd-center-identity"><strong>/{{ selectedCommand.name }}</strong><span>{{ catalogSourceLabel(selectedCommand.source.kind) }}</span></div><button class="cmd-palette-close" aria-label="关闭" @click="$emit('close')">×</button></div>
        <div class="cmd-center-description">{{ selectedCommand.description || 'Dock 未提供此命令的说明。' }}</div>
        <form class="cmd-center-command-form" @submit.prevent="runSelectedCommand"><span class="cmd-center-command-prefix">/{{ selectedCommand.name }}</span><input ref="commandArgsInput" v-model="commandArguments" class="cmd-center-args" :placeholder="selectedCommand.argumentHint || '参数（可留空）'" autocomplete="off" spellcheck="false" /><button class="cmd-center-run" :disabled="!!pending">{{ pending ? '运行中…' : '运行' }}</button></form>
        <div v-if="argumentCompletionsLoading || argumentCompletions.length" class="cmd-center-completions" role="listbox" aria-label="参数候选">
          <button v-for="(item, index) in argumentCompletions" :key="`${item.value}:${index}`" type="button" class="cmd-center-completion" @click="chooseArgumentCompletion(item)"><strong>{{ item.label }}</strong><span v-if="item.description">{{ item.description }}</span></button>
          <div v-if="argumentCompletionsLoading && !argumentCompletions.length" class="cmd-center-completion-loading">正在读取参数候选…</div>
        </div>
        <div class="cmd-center-output" role="log" aria-live="polite">
          <div v-for="entry in commandConsole.entries" :key="entry.id" class="cmd-center-entry" :class="[`cmd-center-entry-${entry.kind}`, entry.level ? `is-${entry.level}` : '']"><span class="cmd-center-entry-marker">{{ entry.kind === 'command' ? '›' : entry.kind === 'status' ? '·' : entry.level === 'error' ? '!' : entry.level === 'warning' ? '△' : '│' }}</span><div class="cmd-center-entry-text">{{ entry.text }}</div></div>
          <div v-if="!commandConsole.entries.length" class="cmd-center-output-empty">命令结果只显示在这里。</div>
        </div>
        <div class="cmd-palette-footer cmd-center-footer">{{ pending || commandConsole.hasActiveOperation ? '命令正在执行，关闭面板后仍继续运行。' : 'Enter 运行 · Esc 关闭' }}</div>
      </template>

      <template v-else-if="selectedCommand && commandDetailMode === 'content'">
        <div class="cmd-center-header"><button class="cmd-center-back" aria-label="返回命令列表" @click="backToCatalog">←</button><div class="cmd-center-identity"><strong>/{{ selectedCommand.name }}</strong><span>Prompt 内容</span></div><button class="cmd-palette-close" aria-label="关闭" @click="$emit('close')">×</button></div>
        <div v-if="commandContentLoading && !commandContentText" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取 Prompt…</div>
        <pre v-else class="cmd-center-content">{{ commandContentText }}</pre>
        <div class="cmd-palette-footer cmd-center-footer">内容仅供查看 · 选择命令后仍会回到输入框确认发送</div>
      </template>
    </template>

    <section v-else-if="section === 'dock-tools'" class="dock-tools-panel">
      <header class="dock-tools-header">
        <span class="dock-tools-mark"><Wrench :size="18" /></span>
        <div><h3>Dock Tools</h3><p>当前 Work</p></div>
        <span class="dock-tools-state" :data-state="dockTools">{{ dockToolsLabel }}</span>
        <button type="button" class="dock-tools-close" aria-label="关闭 Dock Tools" @click="$emit('close')">×</button>
      </header>
      <div class="dock-tools-explanation">
        <strong>{{ dockTools === 'on' ? 'Agent 可以使用 Dock 能力' : 'Agent 目前不能使用 Dock 能力' }}</strong>
        <p>包括交付文件、联系其他 Work，以及创建新的 Work。</p>
      </div>
      <div v-if="dockTools === 'unavailable'" class="alu-dialog-error">当前 Work 没有提供 Dock Tools。</div>
      <div v-else-if="!dockToolsCommand && (catalog.state === 'idle' || catalog.state === 'loading')" class="dock-tools-loading"><span class="alu-agent-activity-spinner" />正在读取当前 Work 的可用命令…</div>
      <div v-else-if="catalog.state === 'failed'" class="alu-dialog-error">命令暂时没有读到。<button type="button" @click="loadSection('dock-tools', true)">重试读取</button></div>
      <div v-else-if="!dockToolsCommand" class="alu-dialog-error">当前 Work 没有提供 Dock Tools 开关。</div>
      <button v-else type="button" class="dock-tools-toggle" :class="{ active: dockTools === 'on', pending: dockToolsBusy }" :aria-label="dockTools === 'on' ? '关闭当前 Work 的 Dock Tools' : '开启当前 Work 的 Dock Tools'" :aria-pressed="dockTools === 'on'" :disabled="dockToolsBusy" data-modal-initial @click="toggleDockTools">
        <span class="dock-tools-toggle-copy"><strong>{{ dockToolsBusy ? '正在更新…' : '允许当前 Work 使用 Dock Tools' }}</strong><small>{{ dockToolsBusy ? '等待当前 Work 确认' : dockTools === 'on' ? '已开启' : '已关闭' }}</small></span>
        <span class="dock-tools-switch" aria-hidden="true"><i /></span>
      </button>
      <div v-if="dockToolsEntries.some((entry) => entry.level === 'error')" class="cmd-center-output dock-tools-output" role="log" aria-live="polite">
        <div v-for="entry in dockToolsEntries.filter((item) => item.level === 'error')" :key="entry.id" class="cmd-center-entry is-error"><span class="cmd-center-entry-marker">!</span><div class="cmd-center-entry-text">{{ entry.text }}</div></div>
      </div>
    </section>

    <SessionManager
      v-else-if="['sessions', 'tree', 'new-session', 'rename-session', 'compact-session', 'reload-session'].includes(section)"
      :work="work"
      :mode="sessionMode"
      :compaction-pending="compactionPending"
      @unknown="forwardSessionUnknown"
      @finished="sessionActionFinished"
      @compact="forwardSessionCompact"
      @title="forwardSessionTitle"
      @close="$emit('close')"
    />

    <section v-else-if="section === 'models'" class="alu-select-panel">
      <p v-if="work.compacting" class="alu-dialog-status">上下文正在压缩。更改 Model 或 Thinking 仅用于后续调用，不会取消或重跑本次压缩。</p>
      <div class="ui-dialog-search-wrap"><input v-model="modelSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" @keydown="handleOptionKeydown($event, filteredModels, chooseModel)" /></div>
      <div class="ui-dialog-options">
        <button v-for="(model, index) in filteredModels" :key="`${model.provider}/${model.id}`" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': isCurrentModel(model), 'is-cursor': optionCursor === index }" :disabled="!!pending" @click="chooseModel(model)"><span class="ui-dialog-option-marker">{{ isCurrentModel(model) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ model.provider }}/{{ model.id }}</span><span v-if="isCurrentModel(model)" class="ui-dialog-option-badge">CURRENT</span></span><span v-if="model.name && model.name !== model.id" class="ui-dialog-option-detail"><span>{{ model.name }}</span></span></span></button>
        <div v-if="models && !filteredModels.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
    </section>

    <section v-else-if="section === 'thinking'" ref="thinkingPanel" class="alu-select-panel" tabindex="-1" @keydown="handleOptionKeydown($event, models?.availableThinkingLevels ?? [], chooseThinking)"><p v-if="work.compacting" class="alu-dialog-status">上下文正在压缩。更改 Model 或 Thinking 仅用于后续调用，不会取消或重跑本次压缩。</p><div class="ui-dialog-options"><button v-for="(level, index) in models?.availableThinkingLevels ?? []" :key="level" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': work.executor.thinkingLevel === level, 'is-cursor': optionCursor === index }" :disabled="!!pending" @click="chooseThinking(level)"><span class="ui-dialog-option-marker">{{ work.executor.thinkingLevel === level ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ level }}</span><span v-if="work.executor.thinkingLevel === level" class="ui-dialog-option-badge">CURRENT</span></span></span></button></div></section>

    <section v-else-if="section === 'tools'" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="toolSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" @keydown="handleOptionKeydown($event, filteredTools, toggleTool)" /></div>
      <div v-if="tools?.truncated" class="alu-project-status-note">工具列表未完整返回，暂时不能切换工具。</div>
      <div class="ui-dialog-options"><button v-for="(tool, index) in filteredTools" :key="tool.name" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': tool.active, 'is-cursor': optionCursor === index }" :disabled="!!pending || !!tools?.truncated" @click="toggleTool(tool)"><span class="ui-dialog-option-marker">{{ tool.active ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ tool.name }}</span><span v-if="tool.active" class="ui-dialog-option-badge">ACTIVE</span></span><span class="ui-dialog-option-detail"><span>{{ tool.description }}</span></span></span></button></div>
    </section>

    <ResourceDocument v-else-if="section === 'resources' && selectedResource" :work="work" :resource="selectedResource" @back="closeResource" />

    <section v-else-if="section === 'resources'" class="alu-project-status">
      <section class="alu-project-status-identity">
        <span class="alu-project-status-signal" :class="`is-${presence.tone}`" />
        <div class="alu-project-status-identity-copy"><strong>{{ work.name || work.key || '未命名 Work' }}</strong><span>{{ work.cwd || '—' }}</span></div>
        <div class="alu-project-status-badges"><span class="alu-project-status-badge" :class="{ 'is-running': presence.tone === 'running' }">{{ presence.label }}</span><span v-if="work.gitBranch" class="alu-project-status-badge is-branch"> {{ work.gitBranch }}</span></div>
      </section>
      <section class="alu-project-status-section">
        <h3>Session</h3>
        <dl class="alu-project-status-grid"><div class="alu-project-status-metric"><dt>Model</dt><dd>{{ work.executor.model ? `${work.executor.model.provider}/${work.executor.model.id}` : '—' }}</dd></div><div class="alu-project-status-metric"><dt>Thinking</dt><dd>{{ work.executor.thinkingLevel || '—' }}</dd></div><div class="alu-project-status-metric"><dt>Context</dt><dd>{{ formatContextUsage(work.metrics?.context, 'status') }}</dd></div><div class="alu-project-status-metric"><dt>费用</dt><dd>{{ work.metrics?.cost == null ? '—' : `$${Number(work.metrics.cost).toFixed(2)}` }}</dd></div><div class="alu-project-status-metric"><dt>Queue</dt><dd>{{ Number(work.pending.total) || 0 }}</dd></div><div class="alu-project-status-metric"><dt>上次运行</dt><dd>{{ runLabel(work.lastRun) }}</dd></div></dl>
        <div v-if="work.lastError" class="alu-project-status-error">{{ work.lastError }}</div>
      </section>
      <section class="alu-project-status-section">
        <h3>Active Tools <span v-if="tools" class="alu-project-status-count">{{ tools?.tools.filter(item => item.active).length || 0 }}/{{ tools?.total ?? tools?.tools.length ?? 0 }}</span></h3>
        <div v-if="loadErrors.tools" class="alu-dialog-error">{{ loadErrors.tools }}<button type="button" @click="loadSection('tools', true)">重试读取工具</button></div>
        <div v-else-if="!tools" class="alu-dialog-loading">正在读取工具…</div>
        <div v-if="tools" class="alu-project-status-chips"><span v-for="tool in tools.tools.filter(item => item.active)" :key="tool.name" class="alu-project-status-chip">{{ tool.name }}</span><span v-if="!tools?.tools.some(item => item.active)" class="alu-project-status-empty">当前没有启用工具</span></div>
        <div v-if="tools?.truncated" class="alu-project-status-note">工具列表未完整返回</div>
      </section>
      <section class="alu-project-status-section">
        <h3>Loaded Resources</h3>
        <div v-if="loadErrors.resources" class="alu-dialog-error">{{ loadErrors.resources }}<button type="button" @click="loadSection('resources', true)">重试读取资源</button></div>
        <div v-else-if="!resources" class="alu-dialog-loading">正在读取资源…</div>
        <template v-if="resources">
        <div v-for="group in resourceGroups" :key="group.kind" class="alu-project-status-resource-group"><h4>{{ group.label }} <span class="alu-project-status-count">{{ group.items.length }}</span></h4><div class="alu-project-status-chips"><template v-for="(resource, index) in group.items" :key="resource.contentRef || `${resource.kind}:${resource.name}:${index}`"><button v-if="resource.contentRef" type="button" class="alu-project-status-chip resource-read-button" :id="`resource-${resource.contentRef}`" :aria-label="`阅读 ${resource.name}`" @click="selectedResource = resource">{{ resource.name }} <ChevronRight :size="11" /></button><span v-else class="alu-project-status-chip">{{ resource.name }}</span></template><span v-if="!group.items.length" class="alu-project-status-empty">—</span></div></div>
        <div v-if="filteredDiagnostics.length" class="alu-project-status-resource-group"><h4>Diagnostics <span class="alu-project-status-count">{{ resources?.diagnosticTotal ?? filteredDiagnostics.length }}</span></h4><div v-for="(diagnostic, index) in filteredDiagnostics" :key="index" class="alu-project-status-diagnostic" :class="`is-${diagnostic.severity}`">{{ diagnostic.message }}</div></div>
        <div v-if="resources.resourcesTruncated || resources.diagnosticsTruncated" class="alu-project-status-note">资源或诊断列表未完整返回</div>
        </template>
      </section>
    </section>

    <section v-else-if="!selectedSetting" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="settingsSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索设置名称或值…" @keydown="handleOptionKeydown($event, filteredSettings, openSetting)" /></div>
      <div class="ui-dialog-options">
        <button v-for="(setting, index) in filteredSettings" :key="setting.key" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-cursor': optionCursor === index }" @click="openSetting(setting)">
          <span class="ui-dialog-option-marker">•</span>
          <span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ settingLabel(setting.key) }}</span><span class="ui-dialog-option-badge">{{ setting.writable ? '可修改' : '只读' }}</span></span><span class="ui-dialog-option-detail"><span>{{ settingDescription(setting.key) }}</span><span class="ui-dialog-option-meta">{{ settingValueDescription(setting) }}</span></span></span>
        </button>
        <div v-if="settings && !filteredSettings.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
    </section>

    <section v-else class="alu-session-form alu-setting-editor">
      <div v-if="selectedSetting.key === 'warnings'" class="ui-dialog-options">
        <button class="ui-dialog-option" :disabled="!!pending" @click="saveSetting(selectedSetting, { anthropicExtraUsage: true })"><span class="ui-dialog-option-marker">{{ anthropicExtraUsageWarning(selectedSetting) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">开启 Anthropic 额外用量提醒</span></span></button>
        <button class="ui-dialog-option" :disabled="!!pending" @click="saveSetting(selectedSetting, { anthropicExtraUsage: false })"><span class="ui-dialog-option-marker">{{ !anthropicExtraUsageWarning(selectedSetting) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">关闭 Anthropic 额外用量提醒</span></span></button>
      </div>
      <div v-else-if="selectedSetting.valueType === 'boolean'" class="ui-dialog-options">
        <button class="ui-dialog-option" :disabled="!!pending" @click="saveSetting(selectedSetting, true)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === true ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">开启</span></span></button>
        <button class="ui-dialog-option" :disabled="!!pending" @click="saveSetting(selectedSetting, false)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === false ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">关闭</span></span></button>
      </div>
      <div v-else-if="selectedSetting.valueType === 'enum'" class="ui-dialog-options">
        <button v-for="value in selectedSetting.allowedValues" :key="String(value)" class="ui-dialog-option" :disabled="!!pending" @click="saveSetting(selectedSetting, value)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === value ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ settingOptionLabel(selectedSetting.key, value) }}</span></span></button>
      </div>
      <template v-else>
        <textarea v-if="selectedSetting.valueType === 'object'" v-model="settingDraft" class="ui-dialog-editor" rows="8" />
        <input v-else v-model="settingDraft" class="ui-dialog-input" :inputmode="selectedSetting.valueType === 'integer' ? 'numeric' : 'text'" />
        <div class="ui-dialog-form-footer"><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="!!pending" @click="saveSettingDraft(selectedSetting)">确认</button></div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.alu-project-status { display: grid; gap: 10px; padding: 14px; }
.alu-project-status-identity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--alu-border-light);
  border-radius: 11px;
  background: color-mix(in srgb, var(--alu-surface) 88%, var(--alu-blue-bg));
}
.alu-project-status-signal { width: 9px; height: 9px; border-radius: 50%; background: var(--alu-text-faint); }
.alu-project-status-signal.is-running { background: var(--alu-mint); box-shadow: 0 0 9px rgba(52, 211, 153, 0.45); }
.alu-project-status-signal.is-idle { background: color-mix(in srgb, var(--alu-mint) 45%, transparent); }
.alu-project-status-signal.is-waiting { background: var(--alu-pink); }
.alu-project-status-signal.is-compacting,
.alu-project-status-signal.is-stopping {
  background: var(--alu-amber);
}
.alu-project-status-signal.is-failed,
.alu-project-status-signal.is-error {
  background: var(--alu-rose);
}
.alu-project-status-signal.is-lost { background: var(--alu-blue-dim); }
.alu-project-status-identity-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.alu-project-status-identity-copy strong { overflow: hidden; color: var(--alu-text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.alu-project-status-identity-copy span { overflow: hidden; color: var(--alu-text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.alu-project-status-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.alu-project-status-badge,
.alu-project-status-count {
  padding: 2px 6px;
  border: 1px solid var(--alu-border);
  border-radius: 999px;
  color: var(--alu-text-muted);
  font-size: 9px;
  line-height: 1.3;
}
.alu-project-status-badge.is-running { border-color: var(--alu-pink-border); color: var(--alu-pink); }
.alu-project-status-badge.is-branch { border-color: var(--alu-blue-border); color: var(--alu-blue); }
.alu-project-status-section {
  padding: 12px 14px;
  border: 1px solid var(--alu-border);
  border-radius: 10px;
  background: rgba(14, 19, 32, 0.72);
}
.alu-project-status-section h3,
.alu-project-status-resource-group h4 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 9px;
  color: var(--alu-text);
  font-size: 11px;
  letter-spacing: 0.03em;
}
.alu-project-status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin: 0; }
.alu-project-status-metric { min-width: 0; padding: 8px 9px; border-radius: 7px; background: var(--alu-bg); }
.alu-project-status-metric dt { color: var(--alu-text-faint); font-size: 8px; text-transform: uppercase; }
.alu-project-status-metric dd { overflow: hidden; margin: 3px 0 0; color: var(--alu-text-dim); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.alu-project-status-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.alu-project-status-chip { padding: 3px 7px; border: 1px solid var(--alu-border); border-radius: 6px; color: var(--alu-text-dim); background: var(--alu-bg); font-size: 9px; }
.alu-project-status-resource-group + .alu-project-status-resource-group { margin-top: 12px; }
.alu-project-status-empty,
.alu-project-status-note {
  color: var(--alu-text-muted);
  font-size: 10px;
}
.alu-project-status-note { margin-top: 10px; color: var(--alu-amber-dim); }
.alu-project-status-error,
.alu-project-status-diagnostic {
  margin-top: 7px;
  padding: 6px 8px;
  border-left: 2px solid var(--alu-rose);
  color: var(--alu-rose);
  background: var(--alu-rose-bg);
  font-size: 10px;
}
.alu-project-status-diagnostic.is-info { border-left-color: var(--alu-blue); color: var(--alu-blue); background: var(--alu-blue-bg); }
.alu-project-status-diagnostic.is-warning { border-left-color: var(--alu-amber); color: var(--alu-amber); background: rgba(245, 158, 11, 0.07); }
.cmd-palette-search-wrap {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--alu-border);
}
.cmd-palette-search-icon { flex: 0 0 auto; color: var(--alu-pink); font-size: 15px; opacity: 0.85; }
.cmd-palette-input {
  min-width: 0;
  flex: 1;
  outline: none;
  border: none;
  background: transparent;
  color: var(--alu-text);
  font: inherit;
  font-size: 14px;
}
.cmd-palette-input::placeholder { color: var(--alu-text-muted); }
.cmd-palette-kbd {
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 1px solid var(--alu-border-light);
  border-radius: 4px;
  color: var(--alu-text-muted);
  font-size: 9px;
}
.cmd-palette-close {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--alu-text-muted);
  font-size: 18px;
}
.cmd-palette-close:hover { background: var(--alu-hover); color: var(--alu-text); }
.cmd-palette-list { min-height: 0; flex: 1 1 auto; overflow-y: auto; padding: 5px; overscroll-behavior: contain; }
.cmd-palette-group { padding: 9px 10px 4px; color: var(--alu-text-faint); font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.cmd-palette-item {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  min-height: 50px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: background 0.08s, border-color 0.08s;
}
.cmd-palette-item-row { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 3px; }
.cmd-palette-item.selected { background: var(--alu-hover); border-color: var(--alu-border); }
.cmd-palette-item.is-important .cmd-palette-item-icon, .cmd-palette-item.is-important .cmd-palette-item-label { color: color-mix(in srgb, var(--alu-red) 78%, var(--alu-text)); }
.cmd-palette-content-btn {
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--alu-border);
  border-radius: 7px;
  color: var(--alu-text-muted);
  font-size: 9px;
}
.cmd-palette-content-btn:hover { background: var(--alu-hover); color: var(--alu-text); }
.cmd-palette-item-icon { padding-top: 2px; color: var(--alu-text-muted); font-size: 12px; text-align: center; }
.cmd-palette-item-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.cmd-palette-item-top { display: flex; min-width: 0; align-items: baseline; gap: 8px; }
.cmd-palette-item-label { overflow: hidden; color: var(--alu-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.cmd-palette-item-argument { color: var(--alu-text-muted); font-weight: 400; }
.cmd-palette-item-desc { overflow: hidden; color: var(--alu-text-dim); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.cmd-palette-item-hint { flex: 0 0 auto; padding: 1px 5px; border: 1px solid var(--alu-border); border-radius: 999px; color: var(--alu-text-faint); font-size: 8px; }
.cmd-palette-empty { padding: 44px 14px; color: var(--alu-text-muted); font-size: 12px; text-align: center; }
.cmd-center-header {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--alu-border);
}
.cmd-center-back {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 8px;
  color: var(--alu-text-muted);
  font-size: 17px;
}
.cmd-center-back:hover { background: var(--alu-hover); color: var(--alu-text); }
.cmd-center-back:disabled { cursor: not-allowed; opacity: 0.35; }
.cmd-center-identity { display: flex; min-width: 0; align-items: baseline; gap: 9px; }
.cmd-center-identity strong { overflow: hidden; color: var(--alu-text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.cmd-center-identity span {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--alu-border);
  border-radius: 999px;
  color: var(--alu-text-faint);
  font-size: 8px;
  text-transform: uppercase;
}
.cmd-center-description {
  flex: 0 0 auto;
  padding: 10px 14px 0;
  color: var(--alu-text-dim);
  font-size: 10px;
  line-height: 1.5;
}
.cmd-center-command-form {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  flex: 0 0 auto;
  align-items: center;
  gap: 0;
  margin: 10px 14px 12px;
  overflow: hidden;
  border: 1px solid var(--alu-border-light);
  border-radius: 9px;
  background: var(--alu-bg);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.01);
}
.cmd-center-command-form:focus-within { border-color: var(--alu-pink-border); box-shadow: 0 0 0 2px rgba(244,114,182,0.09); }
.cmd-center-command-prefix {
  align-self: stretch;
  display: flex;
  align-items: center;
  max-width: 260px;
  overflow: hidden;
  padding: 0 10px;
  border-right: 1px solid var(--alu-border);
  color: var(--alu-pink);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-center-args {
  min-width: 0;
  min-height: 42px;
  padding: 9px 11px;
  outline: none;
  border: 0;
  background: transparent;
  color: var(--alu-text);
  font: inherit;
  font-size: 12px;
}
.cmd-center-args::placeholder { color: var(--alu-text-faint); }
.cmd-center-run {
  min-height: 34px;
  margin-right: 4px;
  padding: 6px 13px;
  border: 1px solid var(--alu-pink-border);
  border-radius: 7px;
  background: var(--alu-pink-bg);
  color: var(--alu-pink);
  font-size: 10px;
  font-weight: 700;
}
.cmd-center-run:hover:not(:disabled) { background: #261a26; border-color: #4a2a38; }
.cmd-center-run:disabled { cursor: wait; opacity: 0.55; }
.cmd-center-completions {
  max-height: 170px;
  flex: 0 0 auto;
  overflow-y: auto;
  margin: -5px 14px 12px;
  padding: 4px;
  border: 1px solid var(--alu-border);
  border-radius: 9px;
  background: var(--alu-bg-raised);
}
.cmd-center-completion { display: flex; width: 100%; flex-direction: column; gap: 2px; padding: 7px 9px; border-radius: 6px; text-align: left; }
.cmd-center-completion:hover { background: var(--alu-hover); }
.cmd-center-completion strong { color: var(--alu-text); font-size: 11px; font-weight: 600; }
.cmd-center-completion span, .cmd-center-completion-loading { color: var(--alu-text-muted); font-size: 9px; }
.cmd-center-completion-loading { padding: 8px 9px; }
.cmd-center-content {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  margin: 12px 14px;
  padding: 14px;
  border: 1px solid var(--alu-border);
  border-radius: 9px;
  background: rgba(2, 5, 12, 0.52);
  color: var(--alu-text-muted);
  font: 11px/1.6 var(--alu-font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cmd-center-output {
  min-height: 240px;
  flex: 1 1 auto;
  overflow-y: auto;
  margin: 0 14px 12px;
  padding: 7px 0;
  border: 1px solid var(--alu-border);
  border-radius: 9px;
  background: rgba(2, 5, 12, 0.52);
  overscroll-behavior: contain;
}
.cmd-center-output-empty { padding: 46px 16px; color: var(--alu-text-faint); font-size: 10px; text-align: center; }
.cmd-center-entry {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 5px;
  padding: 5px 11px;
  color: var(--alu-text-muted);
  font-size: 10px;
  line-height: 1.55;
}
.cmd-center-entry-marker { color: var(--alu-text-faint); text-align: center; user-select: none; }
.cmd-center-entry-text { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.cmd-center-entry-command .cmd-center-entry-marker { color: var(--alu-pink); }
.cmd-center-entry.is-warning { color: #f6c56f; }
.cmd-center-entry.is-warning .cmd-center-entry-marker { color: #f59e0b; }
.cmd-center-entry.is-error { color: #f69aae; }
.cmd-center-entry.is-error .cmd-center-entry-marker { color: var(--alu-red); }
.cmd-center-footer { min-height: 31px; }
.dock-tools-popover-surface > .control-center-port { overflow-y: auto; }
.dock-tools-panel { display: grid; gap: 14px; padding: 16px; }
.dock-tools-header { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto 28px; align-items: center; gap: 10px; }
.dock-tools-mark { display: grid; width: 36px; height: 36px; place-items: center; border: 1px solid var(--alu-blue-border); border-radius: 10px; color: var(--alu-blue); background: var(--alu-blue-bg); }
.dock-tools-header > div { display: grid; gap: 1px; }
.dock-tools-header h3 { margin: 0; color: var(--alu-text); font-size: 14px; letter-spacing: .01em; }
.dock-tools-header p { margin: 0; color: var(--alu-text-faint); font: 9px/1.35 var(--font-reading); }
.dock-tools-state { padding: 4px 7px; border: 1px solid var(--alu-border); border-radius: 999px; color: var(--alu-text-faint); font-size: 8px; font-weight: 750; letter-spacing: .04em; white-space: nowrap; }
.dock-tools-state[data-state="on"] { color: var(--alu-mint); border-color: color-mix(in srgb, var(--alu-mint) 30%, var(--alu-border)); background: color-mix(in srgb, var(--alu-mint) 7%, transparent); }
.dock-tools-state[data-state="unavailable"] { color: var(--alu-text-muted); }
.dock-tools-close { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 8px; color: var(--alu-text-muted); background: transparent; font-size: 18px; }
.dock-tools-close:hover { color: var(--alu-text); background: var(--alu-surface-hover); }
.dock-tools-explanation { display: grid; gap: 5px; padding: 12px 13px; border: 1px solid var(--alu-border); border-radius: 11px; background: rgba(2, 5, 12, .38); }
.dock-tools-explanation strong { color: var(--alu-text); font-size: 11px; }
.dock-tools-explanation p { margin: 0; color: var(--alu-text-muted); font: 9px/1.55 var(--font-reading); }
.dock-tools-loading { display: flex; min-height: 48px; align-items: center; gap: 9px; padding: 0 12px; border: 1px solid var(--alu-border); border-radius: 11px; color: var(--alu-text-muted); font-size: 9px; }
.dock-tools-toggle { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 13px; border: 1px solid var(--alu-border-light); border-radius: 12px; color: var(--alu-text); background: var(--alu-bg-soft); text-align: left; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dock-tools-toggle:hover:not(:disabled) { border-color: var(--alu-blue-border); background: var(--alu-blue-bg); }
.dock-tools-toggle:focus-visible { outline: none; border-color: var(--alu-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--alu-blue) 14%, transparent); }
.dock-tools-toggle.active { border-color: color-mix(in srgb, var(--alu-mint) 32%, var(--alu-border)); background: color-mix(in srgb, var(--alu-mint) 6%, var(--alu-bg-soft)); }
.dock-tools-toggle.pending { cursor: wait; }
.dock-tools-toggle-copy { display: grid; gap: 3px; }
.dock-tools-toggle-copy strong { color: var(--alu-text); font-size: 11px; font-weight: 680; }
.dock-tools-toggle-copy small { color: var(--alu-text-faint); font-size: 8px; }
.dock-tools-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; border: 1px solid var(--alu-border-light); border-radius: 999px; background: rgba(5, 9, 18, .72); transition: border-color .18s ease, background .18s ease; }
.dock-tools-switch i { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--alu-text-faint); box-shadow: 0 2px 5px rgba(0, 0, 0, .4); transition: transform .18s cubic-bezier(.2, .85, .2, 1), background .18s ease; }
.dock-tools-toggle.active .dock-tools-switch { border-color: color-mix(in srgb, var(--alu-mint) 42%, var(--alu-border)); background: color-mix(in srgb, var(--alu-mint) 18%, rgba(5, 9, 18, .72)); }
.dock-tools-toggle.active .dock-tools-switch i { background: var(--alu-mint); transform: translateX(16px); }
.dock-tools-toggle.pending .dock-tools-switch i { animation: dockToolsSwitchPending .7s ease-in-out infinite alternate; }
.dock-tools-output { max-height: 120px; margin: 0; }
@media (max-width: 640px) {
  .dock-tools-panel { padding: 18px max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
  .alu-project-status { padding: 10px; }
  .alu-project-status-identity { grid-template-columns: auto minmax(0, 1fr); padding: 12px; }
  .alu-project-status-badges { grid-column: 2; justify-content: flex-start; }
  .alu-project-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cmd-palette-search-wrap { min-height: 56px; padding: 8px 10px 8px 12px; }
  .cmd-palette-kbd { display: none; }
  .cmd-palette-close { width: 40px; height: 40px; }
  .cmd-palette-item { min-height: 56px; }
  .cmd-palette-content-btn { min-width: 44px; min-height: 44px; }
  .cmd-center-header { min-height: 58px; padding: 8px 10px; }
  .cmd-center-back { width: 40px; height: 40px; }
  .cmd-center-description { padding: 9px 12px 0; }
  .cmd-center-command-form { margin: 9px 10px 10px; }
  .cmd-center-command-prefix { max-width: 132px; padding: 0 8px; font-size: 10px; }
  .cmd-center-args { min-height: 48px; padding: 9px; }
  .cmd-center-run { min-height: 40px; padding: 7px 11px; }
  .cmd-center-completion { min-height: 44px; padding: 8px 10px; }
  .cmd-center-output { min-height: 220px; margin: 0 10px 10px; }
  .cmd-center-entry { padding: 7px 9px; font-size: 11px; }
}
@media (min-width: 1200px) {
  .cmd-palette-item-label {
    font-size: var(--alu-control-size);
  }
  .cmd-palette-item-desc {
    font-size: var(--alu-meta-size);
  }
}
.control-center-port { position: relative; display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow: hidden; }
.cmd-palette-box > .control-center-port { max-height: min(78dvh, 760px); }
.alu-select-panel { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow: hidden; }
.alu-project-status { min-height: 0; overflow-y: auto; }
.alu-project-status-section h3 .alu-project-status-count { margin-left: auto; }
.alu-setting-editor { padding-top: 12px; }
@media (max-width: 640px) {
  .control-center-port { min-height: 0; }
  .cmd-palette-box > .control-center-port { max-height: 92dvh; }
}
.resource-read-button { display: inline-flex; align-items: center; gap: 4px; font-family: inherit; cursor: pointer; }
.resource-read-button:hover, .resource-read-button:focus-visible { color: var(--alu-text); border-color: var(--alu-blue-border); background: var(--alu-hover); }
.resource-read-button:disabled { cursor: default; opacity: .55; }
</style>
