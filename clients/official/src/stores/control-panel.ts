import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { getResources, getSettings, listModels, listTools } from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import type { ControlSection } from '../lib/localCommands'
import { createSignal } from '../lib/signal'
import { errorCode, userErrorMessage as errorMessage } from '../lib/userError'
import type { ModelsResult, ProjectedEvent, ResourcesResult, SettingsResult, SettingInfo, SettingValue, ToolsResult } from '../lib/types'
import { useAppStore } from './app'
import { useCommandCatalogStore } from './command-catalog'
import { useCommandConsoleStore } from './command-console'
import { useObservationStore } from './observation'
import { useSurfacesStore } from './surfaces'

/** The control panel's query results for the selected Work. Opening the panel
 * starts from a fresh read; live config events update the same data. */
export const useControlPanelStore = defineStore('control-panel', () => {
  const app = useAppStore()
  const catalog = useCommandCatalogStore()
  const commandConsole = useCommandConsoleStore()
  const observation = useObservationStore()
  const surfaces = useSurfacesStore()
  const selected = computed(() => app.selectedWork)
  const models = ref<ModelsResult | null>(null)
  const tools = ref<ToolsResult | null>(null)
  const resources = ref<ResourcesResult | null>(null)
  const settings = ref<SettingsResult | null>(null)
  const speedSetting = ref<SettingInfo | null>(null)
  const speedSupport = ref<'unknown' | 'supported' | 'unsupported'>('unknown')
  const speedAvailable = computed(() => selected.value?.lifecycle === 'active' && speedSupport.value !== 'unsupported')
  const speedLoading = ref(false)
  const speedError = ref('')
  let speedRead = 0
  let speedValueRevision = 0
  const speedTarget = computed(() => JSON.stringify([app.activeConnectionId, app.connectionContext?.selectionGeneration,
    selected.value?.id, selected.value?.ownerHostEpoch, selected.value?.runtimeGeneration]))
  const speedIdentity = computed(() => JSON.stringify([speedTarget.value, selected.value?.executor.model?.provider, selected.value?.executor.model?.id]))
  const loading = ref(new Set<ControlSection>())
  const loadErrors = ref<Partial<Record<ControlSection, string>>>({})
  const writeFailed = createSignal<[message: string]>()
  let loadEpoch = 0

  watch([
    () => app.activeConnectionId,
    () => app.connectionContext?.selectionGeneration,
    () => selected.value?.id,
    () => selected.value?.ownerHostEpoch,
    () => selected.value?.runtimeGeneration,
  ], () => {
    const context = app.connectionContext
    const work = selected.value
    if (context && work) commandConsole.bindContext(context.connectionId, context.selectionGeneration, work)
  }, { immediate: true })

  watch([speedTarget, () => selected.value?.executor.model?.provider, () => selected.value?.executor.model?.id, () => selected.value?.lifecycle], (_value, previous) => {
    if (!previous || previous[0] !== speedTarget.value) {
      speedSetting.value = null
      speedSupport.value = 'unknown'
      speedError.value = ''
    } else if (previous[1] !== selected.value?.executor.model?.provider || previous[2] !== selected.value?.executor.model?.id) {
      // A different model has not yet reported its support. Keep known values, not an old rejection.
      speedSupport.value = 'unknown'
    }
    void refreshSpeed()
  }, { immediate: true })

  function acceptSpeedSetting(setting: SettingInfo | null) {
    speedSetting.value = setting
    speedSupport.value = setting?.allowedValues?.some(tier => tier !== 'standard') ? 'supported' : 'unsupported'
  }

  // Only the optional speed control is refreshed. Model changes do not reset an open Pi panel.
  async function refreshSpeed(): Promise<boolean> {
    const read = ++speedRead
    const identity = speedIdentity.value
    const valueRevision = speedValueRevision
    const work = selected.value
    speedLoading.value = false
    if (!app.connectionContext || work?.lifecycle !== 'active') return false
    const current = () => read === speedRead && identity === speedIdentity.value
    speedLoading.value = true
    speedError.value = ''
    try {
      const result = await currentConnectionCall(app, context => getSettings(work.id, context))
      if (!current()) return false
      const setting = result.settings.find(item => item.key === 'modelSpeed') ?? null
      // A live speed change received during this read is newer than its copied value.
      if (setting && speedSetting.value && valueRevision !== speedValueRevision) setting.value = speedSetting.value.value
      acceptSpeedSetting(setting)
      return true
    } catch (cause) {
      if (current()) {
        if (errorCode(cause) === 'capability_missing') acceptSpeedSetting(null)
        else speedError.value = errorMessage(cause)
      }
      return false
    } finally {
      if (current()) speedLoading.value = false
    }
  }

  /** Drops earlier results; the open panel reads again. */
  function reset() {
    loadEpoch += 1
    models.value = null
    tools.value = null
    resources.value = null
    settings.value = null
    loading.value.clear()
    loadErrors.value = {}
  }

  async function loadSection(section: ControlSection, force = false): Promise<boolean> {
    if (section === 'speed') return refreshSpeed()
    if (['sessions', 'tree', 'new-session', 'rename-session', 'compact-session', 'reload-session', 'quick-buttons'].includes(section)) return true
    const work = selected.value
    if (!work) return false
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
    const speedScope = speedIdentity.value
    const speedVersion = speedRead
    const workId = work.id
    const current = () => epoch === loadEpoch && selected.value?.id === workId
    loading.value.add(section)
    delete loadErrors.value[section]
    try {
      if (section === 'commands' || section === 'dock-tools') {
        return await catalog.ensure(work, requireConnectionContext(app), force)
      } else if (section === 'models' || section === 'thinking') {
        const result = await currentConnectionCall(app, (context) => listModels(workId, context))
        if (!current()) return false
        models.value = result
        if (section === 'models' && surfaces.commandOpen && surfaces.controlSection === 'models') {
          const model = result.instance.executor.model
          const currentLabel = model ? `${model.provider}/${model.id}` : '—'
          surfaces.setControlDialogTitle('选择 Model', [`当前：${currentLabel}`, result.truncated ? `显示 ${result.models.length}/${result.total} 项` : ''].filter(Boolean).join('\n'))
        }
      } else if (section === 'tools') {
        const result = await currentConnectionCall(app, (context) => listTools(workId, context))
        if (!current()) return false
        tools.value = result
      } else if (section === 'resources') {
        const result = await currentConnectionCall(app, (context) => getResources(workId, context))
        if (!current()) return false
        resources.value = result
      } else {
        const result = await currentConnectionCall(app, (context) => getSettings(workId, context))
        if (!current()) return false
        settings.value = result
        if (speedScope === speedIdentity.value && speedVersion === speedRead) acceptSpeedSetting(result.settings.find(item => item.key === 'modelSpeed') ?? null)
      }
      return true
    } catch (cause) {
      if (current()) loadErrors.value[section] = errorMessage(cause)
      return false
    } finally {
      if (epoch === loadEpoch) loading.value.delete(section)
    }
  }

  function applyConfigEvent(event: ProjectedEvent) {
    const data = event.data
    if (event.eventType === 'settings.changed' && data.key === 'modelSpeed' && 'value' in data) {
      speedValueRevision++
      if (speedSetting.value) speedSetting.value = { ...speedSetting.value, value: data.value as SettingValue }
    }
    if (event.eventType === 'settings.changed' && settings.value && typeof data.key === 'string') {
      const setting = settings.value.settings.find((item) => item.key === data.key)
      if (setting && 'value' in data) {
        setting.value = data.value as SettingValue
        if (typeof data.reloadRequired === 'boolean') setting.reloadRequired = data.reloadRequired
        if (typeof data.hostRestartRequired === 'boolean') setting.hostRestartRequired = data.hostRestartRequired
      }
    } else if (event.eventType === 'settings.write_failed' && typeof data.error === 'string') {
      writeFailed.emit(data.error)
    } else if (event.eventType === 'resources.reloaded') {
      resources.value = null
      tools.value = null
      const section = surfaces.controlSection
      if (surfaces.commandOpen && (section === 'resources' || section === 'tools')) void loadSection(section, true)
    } else if ((event.eventType === 'model.changed' || event.eventType === 'thinking.changed') && models.value && selected.value) {
      models.value.instance = selected.value
    }
  }
  onScopeDispose(observation.onConfigChanged(applyConfigEvent))

  return { models, tools, resources, settings, speedSetting, speedAvailable, speedTarget, speedIdentity, speedLoading, speedError, refreshSpeed, acceptSpeedSetting, loading, loadErrors, reset, loadSection, onWriteFailed: writeFailed.on }
})
