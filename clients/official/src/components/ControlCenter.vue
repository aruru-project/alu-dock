<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Brain, ChevronRight, Cpu, GitFork, History, Info, LayoutList, Pencil, Plus, RotateCw, Search, Settings, Square, Undo2, Wrench, Zap } from '@lucide/vue'
import {
  getCommandCompletions,
  getCommandContent,
  getResources,
  getSettings,
  listModels,
  listTools,
  runCatalogCommand,
  setActiveTools,
  setModel,
  setThinking,
  updateSetting,
  type SessionContext,
} from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { catalogSourceLabel, commandGoesToComposer, filterCatalogCommands, filterCommandPaletteItems } from '../lib/commandSuggest'
import { dockToolsState } from '../lib/dockTools'
import { localControlCommands, type ControlSection, type LocalControlCommand } from '../lib/localCommands'
import { settingDescription, settingLabel, settingOptionLabel, settingValueLabel } from '../lib/settingLabels'
import { workPresence } from '../lib/uiBoundaries'
import SessionManager from './SessionManager.vue'
import ResourceDocument from './ResourceDocument.vue'
import { useAppStore } from '../stores/app'
import { useCommandCatalogStore } from '../stores/command-catalog'
import { useCommandConsoleStore } from '../stores/command-console'
import type {
  CommandArgumentCompletion,
  CommandInfo,
  ModelInfo,
  ModelsResult,
  ProjectedEvent,
  ResourcesResult,
  ResourceInfo,
  SettingInfo,
  SettingKey,
  SettingValue,
  SettingsResult,
  ThinkingLevel,
  ToolInfo,
  ToolsResult,
  Work,
} from '../lib/types'

export type ControlMutationDomain = 'conversation' | 'sessions' | 'tree' | 'models' | 'tools' | 'settings'

const props = defineProps<{ work: Work; section: ControlSection; preview: boolean; outcomeUnknown: boolean; unknownDomain?: ControlMutationDomain; compactionPending: boolean }>()
const app = useAppStore()
const catalog = useCommandCatalogStore()
const commandConsole = useCommandConsoleStore()
const presence = computed(() => workPresence(props.work))
const emit = defineEmits<{
  snapshot: [work: Work]
  unknown: [cause: unknown, domain: ControlMutationDomain, scope: SessionContext]
  reconcile: [domain: ControlMutationDomain]
  section: [section: ControlSection]
  prefill: [name: string]
  compact: [customInstructions?: string]
  close: []
  stop: []
  restoreQueue: []
  title: [title: string, body?: string]
  size: [size: 'default' | 'wide' | 'tree']
}>()

const sessionManager = ref<InstanceType<typeof SessionManager> | null>(null)

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
const models = ref<ModelsResult | null>(null)
const tools = ref<ToolsResult | null>(null)
const resources = ref<ResourcesResult | null>(null)
const selectedResource = ref<ResourceInfo | null>(null)
const settings = ref<SettingsResult | null>(null)
const loading = ref(new Set<ControlSection>())
const loadErrors = ref<Partial<Record<ControlSection, string>>>({})
const pending = ref('')
const error = ref('')
const dockToolsOperationId = ref('')
let loadEpoch = 0

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
  if (app.connectionContext) commandConsole.bindContext(app.connectionContext.connectionId, app.connectionContext.selectionGeneration, props.work)
  loadEpoch += 1
  models.value = null
  tools.value = null
  resources.value = null
  selectedResource.value = null
  settings.value = null
  loading.value.clear()
  loadErrors.value = {}
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
  emit('reconcile', props.unknownDomain ?? sectionDomain(props.section))
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
  if (props.preview || commandDetailMode.value !== 'runner' || !command?.argumentCompletions) {
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
    selectedResource.value = null
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
  if (section === 'resources') void loadSection('tools', force)
  if (loading.value.has(section)) return false
  const dataExists = section === 'commands' || section === 'dock-tools'
    ? null
    : section === 'models' || section === 'thinking'
      ? models.value
      : section === 'tools'
        ? tools.value
        : section === 'resources'
          ? resources.value
          : settings.value
  if (dataExists && !force) return true
  const epoch = loadEpoch
  const workId = props.work.id
  loading.value.add(section)
  delete loadErrors.value[section]
  try {
    if (section === 'commands' || section === 'dock-tools') {
      return await catalog.ensure(props.work, requireConnectionContext(app), force)
    } else if (section === 'models' || section === 'thinking') {
      const result = await currentConnectionCall(app, (context) => listModels(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      models.value = result
      emit('snapshot', result.instance)
      if (section === 'models') {
        const current = result.instance.executor.model
        const currentLabel = current ? `${current.provider}/${current.id}` : '—'
        emit('title', '选择 Model', [`当前：${currentLabel}`, result.truncated ? `显示 ${result.models.length}/${result.total} 项` : ''].filter(Boolean).join('\n'))
      }
    } else if (section === 'tools') {
      const result = await currentConnectionCall(app, (context) => listTools(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      tools.value = result
      emit('snapshot', result.instance)
    } else if (section === 'resources') {
      const result = await currentConnectionCall(app, (context) => getResources(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      resources.value = result
    } else {
      const result = await currentConnectionCall(app, (context) => getSettings(workId, context))
      if (epoch !== loadEpoch || props.work.id !== workId) return false
      settings.value = result
    }
    return true
  } catch (cause) {
    if (epoch === loadEpoch && props.work.id === workId) {
      loadErrors.value[section] = errorMessage(cause)
    }
    return false
  } finally {
    if (epoch === loadEpoch) loading.value.delete(section)
  }
}

async function executeCatalogCommand(command: CommandInfo, argumentsText: string): Promise<boolean> {
  if (props.preview || pending.value) return false
  const operationId = crypto.randomUUID()
  pending.value = `command:${command.name}`
  error.value = ''
  commandConsole.beginOperation(operationId, command.name, argumentsText)
  if (command.name === 'dock-tools') dockToolsOperationId.value = operationId
  const scope: SessionContext = Object.freeze({ ...(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }), instanceId: props.work.id,
    expectedHostEpoch: props.work.ownerHostEpoch ?? '', expectedRuntimeGeneration: props.work.runtimeGeneration })
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
  if (props.preview || pending.value || isCurrentModel(model)) return
  pending.value = `model:${model.provider}/${model.id}`
  error.value = ''
  const scope: SessionContext = Object.freeze({ ...(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }), instanceId: props.work.id,
    expectedHostEpoch: props.work.ownerHostEpoch ?? '', expectedRuntimeGeneration: props.work.runtimeGeneration })
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
  if (props.preview || pending.value || props.work.executor.thinkingLevel === level) return
  pending.value = `thinking:${level}`
  error.value = ''
  const scope: SessionContext = Object.freeze({ ...(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }), instanceId: props.work.id,
    expectedHostEpoch: props.work.ownerHostEpoch ?? '', expectedRuntimeGeneration: props.work.runtimeGeneration })
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
  if (!tools.value || tools.value.truncated || props.preview || pending.value) return
  const names = tools.value.tools.filter((item) => item.name === tool.name ? !tool.active : item.active).map((item) => item.name)
  pending.value = `tool:${tool.name}`
  error.value = ''
  const scope: SessionContext = Object.freeze({ ...(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }), instanceId: props.work.id,
    expectedHostEpoch: props.work.ownerHostEpoch ?? '', expectedRuntimeGeneration: props.work.runtimeGeneration })
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
  if (!settings.value || !setting.writable || props.preview || pending.value) return
  pending.value = `setting:${setting.key}`
  error.value = ''
  const scope: SessionContext = Object.freeze({ ...(app.connectionContext ?? { connectionId: '', selectionGeneration: 0 }), instanceId: props.work.id,
    expectedHostEpoch: props.work.ownerHostEpoch ?? '', expectedRuntimeGeneration: props.work.runtimeGeneration })
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

function sectionDomain(section: ControlSection): ControlMutationDomain {
  if (section === 'commands' || section === 'dock-tools') return 'conversation'
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
        <form class="cmd-center-command-form" @submit.prevent="runSelectedCommand"><span class="cmd-center-command-prefix">/{{ selectedCommand.name }}</span><input ref="commandArgsInput" v-model="commandArguments" class="cmd-center-args" :placeholder="selectedCommand.argumentHint || '参数（可留空）'" autocomplete="off" spellcheck="false" /><button class="cmd-center-run" :disabled="preview || !!pending">{{ pending ? '运行中…' : '运行' }}</button></form>
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
      <button v-else type="button" class="dock-tools-toggle" :class="{ active: dockTools === 'on', pending: dockToolsBusy }" :aria-label="dockTools === 'on' ? '关闭当前 Work 的 Dock Tools' : '开启当前 Work 的 Dock Tools'" :aria-pressed="dockTools === 'on'" :disabled="preview || dockToolsBusy" data-modal-initial @click="toggleDockTools">
        <span class="dock-tools-toggle-copy"><strong>{{ dockToolsBusy ? '正在更新…' : '允许当前 Work 使用 Dock Tools' }}</strong><small>{{ dockToolsBusy ? '等待当前 Work 确认' : dockTools === 'on' ? '已开启' : '已关闭' }}</small></span>
        <span class="dock-tools-switch" aria-hidden="true"><i /></span>
      </button>
      <div v-if="dockToolsEntries.some((entry) => entry.level === 'error')" class="cmd-center-output dock-tools-output" role="log" aria-live="polite">
        <div v-for="entry in dockToolsEntries.filter((item) => item.level === 'error')" :key="entry.id" class="cmd-center-entry is-error"><span class="cmd-center-entry-marker">!</span><div class="cmd-center-entry-text">{{ entry.text }}</div></div>
      </div>
    </section>

    <SessionManager
      v-else-if="['sessions', 'tree', 'new-session', 'rename-session', 'compact-session', 'reload-session'].includes(section)"
      ref="sessionManager"
      :work="work"
      :mode="sessionMode"
      :preview="preview"
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
        <button v-for="(model, index) in filteredModels" :key="`${model.provider}/${model.id}`" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': isCurrentModel(model), 'is-cursor': optionCursor === index }" :disabled="preview || !!pending" @click="chooseModel(model)"><span class="ui-dialog-option-marker">{{ isCurrentModel(model) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ model.provider }}/{{ model.id }}</span><span v-if="isCurrentModel(model)" class="ui-dialog-option-badge">CURRENT</span></span><span v-if="model.name && model.name !== model.id" class="ui-dialog-option-detail"><span>{{ model.name }}</span></span></span></button>
        <div v-if="models && !filteredModels.length" class="ui-dialog-empty">没有匹配项</div>
      </div>
    </section>

    <section v-else-if="section === 'thinking'" ref="thinkingPanel" class="alu-select-panel" tabindex="-1" @keydown="handleOptionKeydown($event, models?.availableThinkingLevels ?? [], chooseThinking)"><p v-if="work.compacting" class="alu-dialog-status">上下文正在压缩。更改 Model 或 Thinking 仅用于后续调用，不会取消或重跑本次压缩。</p><div class="ui-dialog-options"><button v-for="(level, index) in models?.availableThinkingLevels ?? []" :key="level" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': work.executor.thinkingLevel === level, 'is-cursor': optionCursor === index }" :disabled="preview || !!pending" @click="chooseThinking(level)"><span class="ui-dialog-option-marker">{{ work.executor.thinkingLevel === level ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ level }}</span><span v-if="work.executor.thinkingLevel === level" class="ui-dialog-option-badge">CURRENT</span></span></span></button></div></section>

    <section v-else-if="section === 'tools'" class="alu-select-panel">
      <div class="ui-dialog-search-wrap"><input v-model="toolSearch" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、内容或 ID…" @keydown="handleOptionKeydown($event, filteredTools, toggleTool)" /></div>
      <div v-if="tools?.truncated" class="alu-project-status-note">工具列表未完整返回，暂时不能切换工具。</div>
      <div class="ui-dialog-options"><button v-for="(tool, index) in filteredTools" :key="tool.name" :id="`cc-opt-${index}`" class="ui-dialog-option" :class="{ 'is-current': tool.active, 'is-cursor': optionCursor === index }" :disabled="preview || !!pending || !!tools?.truncated" @click="toggleTool(tool)"><span class="ui-dialog-option-marker">{{ tool.active ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-top"><span class="ui-dialog-option-label">{{ tool.name }}</span><span v-if="tool.active" class="ui-dialog-option-badge">ACTIVE</span></span><span class="ui-dialog-option-detail"><span>{{ tool.description }}</span></span></span></button></div>
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
        <dl class="alu-project-status-grid"><div class="alu-project-status-metric"><dt>Model</dt><dd>{{ work.executor.model ? `${work.executor.model.provider}/${work.executor.model.id}` : '—' }}</dd></div><div class="alu-project-status-metric"><dt>Thinking</dt><dd>{{ work.executor.thinkingLevel || '—' }}</dd></div><div class="alu-project-status-metric"><dt>Context</dt><dd>{{ contextLabel(work) }}</dd></div><div class="alu-project-status-metric"><dt>费用</dt><dd>{{ work.metrics?.cost == null ? '—' : `$${Number(work.metrics.cost).toFixed(2)}` }}</dd></div><div class="alu-project-status-metric"><dt>Queue</dt><dd>{{ Number(work.pending.total) || 0 }}</dd></div><div class="alu-project-status-metric"><dt>上次运行</dt><dd>{{ runLabel(work.lastRun) }}</dd></div></dl>
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
        <div v-for="group in resourceGroups" :key="group.kind" class="alu-project-status-resource-group"><h4>{{ group.label }} <span class="alu-project-status-count">{{ group.items.length }}</span></h4><div class="alu-project-status-chips"><template v-for="(resource, index) in group.items" :key="resource.contentRef || `${resource.kind}:${resource.name}:${index}`"><button v-if="resource.contentRef" type="button" class="alu-project-status-chip resource-read-button" :disabled="preview" :id="`resource-${resource.contentRef}`" :aria-label="`阅读 ${resource.name}`" @click="selectedResource = resource">{{ resource.name }} <ChevronRight :size="11" /></button><span v-else class="alu-project-status-chip">{{ resource.name }}</span></template><span v-if="!group.items.length" class="alu-project-status-empty">—</span></div></div>
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
        <button class="ui-dialog-option" :disabled="preview || !!pending" @click="saveSetting(selectedSetting, { anthropicExtraUsage: true })"><span class="ui-dialog-option-marker">{{ anthropicExtraUsageWarning(selectedSetting) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">开启 Anthropic 额外用量提醒</span></span></button>
        <button class="ui-dialog-option" :disabled="preview || !!pending" @click="saveSetting(selectedSetting, { anthropicExtraUsage: false })"><span class="ui-dialog-option-marker">{{ !anthropicExtraUsageWarning(selectedSetting) ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">关闭 Anthropic 额外用量提醒</span></span></button>
      </div>
      <div v-else-if="selectedSetting.valueType === 'boolean'" class="ui-dialog-options">
        <button class="ui-dialog-option" :disabled="preview || !!pending" @click="saveSetting(selectedSetting, true)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === true ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">开启</span></span></button>
        <button class="ui-dialog-option" :disabled="preview || !!pending" @click="saveSetting(selectedSetting, false)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === false ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">关闭</span></span></button>
      </div>
      <div v-else-if="selectedSetting.valueType === 'enum'" class="ui-dialog-options">
        <button v-for="value in selectedSetting.allowedValues" :key="String(value)" class="ui-dialog-option" :disabled="preview || !!pending" @click="saveSetting(selectedSetting, value)"><span class="ui-dialog-option-marker">{{ selectedSetting.value === value ? '●' : '•' }}</span><span class="ui-dialog-option-content"><span class="ui-dialog-option-label">{{ settingOptionLabel(selectedSetting.key, value) }}</span></span></button>
      </div>
      <template v-else>
        <textarea v-if="selectedSetting.valueType === 'object'" v-model="settingDraft" class="ui-dialog-editor" rows="8" />
        <input v-else v-model="settingDraft" class="ui-dialog-input" :inputmode="selectedSetting.valueType === 'integer' ? 'numeric' : 'text'" />
        <div class="ui-dialog-form-footer"><button class="ui-dialog-btn ui-dialog-btn-primary" :disabled="preview || !!pending" @click="saveSettingDraft(selectedSetting)">确认</button></div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.resource-read-button { display: inline-flex; align-items: center; gap: 4px; font-family: inherit; cursor: pointer; }
.resource-read-button:hover, .resource-read-button:focus-visible { color: var(--alu-text); border-color: var(--alu-blue-border); background: var(--alu-hover); }
.resource-read-button:disabled { cursor: default; opacity: .55; }
</style>
