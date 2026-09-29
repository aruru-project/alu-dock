import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getClientPreferences, getDesktopShellStatus, isTauri, startDesktopHost, updateClientPreferences } from '../lib/bridge'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ClientPreferences, DesktopShellStatus, WindowsAwayDelay } from '../lib/types'
import { useAppStore } from './app'
import { useExtensionUiStore } from './extension-ui'
import { useSurfacesStore } from './surfaces'
/** App settings, the desktop shell and draft flushing on page lifecycle.
 * Window focus and the Windows away period decide when to observe; they live in the observation store. */
export const usePlatformStore = defineStore('platform', () => {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const surfaces = useSurfacesStore()
  const appSettings = ref<ClientPreferences | null>(null)
  const appSettingsSaving = ref(false)
  const appSettingsError = ref('')
  const desktopShell = ref<DesktopShellStatus | null>(null)
  const desktopShellBusy = ref(false)
  const unlisteners: UnlistenFn[] = []
  let initialized = false
  let disposed = false

  const windowsAwayLabel = computed(() => ({
    immediate: '立即暂离',
    one_minute: '1 分钟后暂离',
    five_minutes: '5 分钟后暂离',
    thirty_minutes: '30 分钟后暂离',
    one_hour: '1 小时后暂离',
    never: '切到其他窗口时不暂离',
  } as Record<WindowsAwayDelay, string>)[appSettings.value?.windowsAwayDelay ?? 'one_minute'])

  async function retryDesktopHost() {
    if (desktopShellBusy.value) return
    desktopShellBusy.value = true
    try {
      desktopShell.value = await startDesktopHost()
      if (desktopShell.value.hostReady && desktopShell.value.role === 'main') await app.load()
    } catch (cause) {
      desktopShell.value = {
        supported: true,
        hostReady: false,
        startupError: errorMessage(cause),
        loginStartEnabled: desktopShell.value?.loginStartEnabled ?? false,
        autoStartLocalHost: desktopShell.value?.autoStartLocalHost ?? true,
      }
    } finally {
      desktopShellBusy.value = false
    }
  }

  async function runDesktopShellAction(action: () => Promise<void>) {
    try {
      await action()
    } catch (cause) {
      if (desktopShell.value) desktopShell.value = { ...desktopShell.value, startupError: errorMessage(cause) }
    }
  }

  function openAppSettings() {
    if (!appSettings.value?.windowsAwaySupported) return
    appSettingsError.value = ''
    surfaces.openAppSettings()
  }

  async function chooseWindowsAwayDelay(delay: WindowsAwayDelay) {
    const current = appSettings.value
    if (!current || current.windowsAwayDelay === delay || appSettingsSaving.value) return
    appSettingsSaving.value = true
    appSettingsError.value = ''
    try {
      appSettings.value = await updateClientPreferences(current.revision, delay)
    } catch (cause) {
      appSettingsError.value = errorMessage(cause)
      try {
        appSettings.value = await getClientPreferences()
      } catch {
        // The visible save error remains the useful next action.
      }
    } finally {
      appSettingsSaving.value = false
    }
  }

  function flushDrafts() { app.flushLocalState() }

  async function initialize() {
    if (initialized) return
    initialized = true
    window.addEventListener('pagehide', flushDrafts)
    document.addEventListener('visibilitychange', flushDrafts)
    try {
      appSettings.value = await getClientPreferences()
    } catch (cause) {
      console.error('Failed to read App settings.', cause)
    }
    if (!isTauri) return
    let shellEventRevision = 0
    const release = await listen<DesktopShellStatus>('desktop-shell-changed', ({ payload }) => {
      shellEventRevision += 1
      const becameReady = payload.hostReady && !desktopShell.value?.hostReady
      desktopShell.value = payload
      if (becameReady && payload.role === 'main') void app.load()
    })
    if (disposed) { release(); return }
    unlisteners.push(release)
    const requestedRevision = shellEventRevision
    const initialShell = await getDesktopShellStatus()
    if (shellEventRevision === requestedRevision) desktopShell.value = initialShell
  }

  onScopeDispose(() => {
    disposed = true
    app.flushLocalState()
    if (initialized) {
      window.removeEventListener('pagehide', flushDrafts)
      document.removeEventListener('visibilitychange', flushDrafts)
    }
    unlisteners.forEach((unlisten) => unlisten())
    void extensionUi.clear()
  })

  return { appSettings, appSettingsSaving, appSettingsError, desktopShell, desktopShellBusy, windowsAwayLabel, retryDesktopHost, runDesktopShellAction, openAppSettings, chooseWindowsAwayDelay, initialize }
})
