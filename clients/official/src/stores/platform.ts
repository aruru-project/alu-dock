import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getClientPreferences, getDesktopShellStatus, isTauri, setNativeAppearance, startDesktopHost, updateClientPreferences } from '../lib/bridge'
import { CLIENT_THEMES, readTheme, saveTheme, showTheme, type ClientTheme } from '../lib/theme'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ClientPreferences, DesktopShellStatus, WindowsAwayDelay } from '../lib/types'
import { useAppStore } from './app'
import { useExtensionUiStore } from './extension-ui'
import { useSurfacesStore } from './surfaces'

function deviceStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/** App settings, the color theme, the desktop shell and draft flushing on page lifecycle.
 * Window focus and the Windows away period decide when to observe; they live in the observation store. */
export const usePlatformStore = defineStore('platform', () => {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const surfaces = useSurfacesStore()
  const appSettings = ref<ClientPreferences | null>(null)
  const appSettingsSaving = ref(false)
  const appSettingsError = ref('')
  const theme = ref<ClientTheme>(readTheme(deviceStorage()))
  const themeSaveError = ref('')
  const themeSyncError = ref('')
  // The platform matches one theme at a time; see matchNativeAppearance.
  let nativeAppearanceBusy = false
  let nativeAppearanceNext: ClientTheme | null = null
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
  const themeName = (id: ClientTheme) => CLIENT_THEMES.find((option) => option.id === id)?.label ?? ''
  const themeLabel = computed(() => themeName(theme.value))

  /** The page cannot draw some parts of the window: Android's status bar, the window behind the page and
   * the next start's splash screen; the Windows title bar. The page tells the platform which theme to
   * match, one request at a time: requests sent together may arrive in any order, and an earlier choice
   * arriving last would win. A choice made meanwhile waits and replaces any choice still waiting, so the
   * platform ends on the last choice, and only that one's result is told in App settings. */
  function matchNativeAppearance(next: ClientTheme) {
    nativeAppearanceNext = next
    if (!nativeAppearanceBusy) void sendNativeAppearance()
  }

  async function sendNativeAppearance() {
    nativeAppearanceBusy = true
    try {
      // A store taken down without its page (a rebuilt App) leaves the platform to the new one.
      while (nativeAppearanceNext && !disposed) {
        const next = nativeAppearanceNext
        nativeAppearanceNext = null
        const failure = await setNativeAppearance(next).then(() => '', (cause) => {
          console.error('Failed to match the window to the color theme.', cause)
          return nativeAppearanceFailure(next, cause)
        })
        if (!nativeAppearanceNext && !disposed) themeSyncError.value = failure
      }
    } finally {
      nativeAppearanceBusy = false
    }
  }

  /** The page has switched either way; only say what did not follow, and how to retry. */
  function nativeAppearanceFailure(next: ClientTheme, cause: unknown) {
    const name = themeName(next)
    const told = new Map<unknown, string>([
      ['appearance_unavailable', `状态栏没能跟着换成「${name}」，上面的图标可能看不清。可以再点一下「${name}」重试，还不行就重新打开客户端。`],
      ['splash_theme_unavailable', `配色已经换好，只是下次打开客户端时，最先出现的启动画面可能还是原来的配色。可以再点一下「${name}」重试。`],
      ['title_bar_unavailable', `窗口标题栏没能跟着换成「${name}」的深浅。可以再点一下「${name}」重试。`],
      ['title_bar_next_start_unavailable', `配色已经换好，只是下次打开客户端时，窗口标题栏一开始可能还是原来的深浅。可以再点一下「${name}」重试。`],
    ])
    return told.get((cause as { code?: unknown } | null)?.code)
      ?? `窗口没能完全跟着换成「${name}」。可以再点一下「${name}」重试，还不行就重新打开客户端。`
  }

  /** Takes effect at once; saving only decides whether the next start opens in it.
   * Choosing the current theme again retries saving it and matching the system bars. */
  function chooseTheme(next: ClientTheme) {
    theme.value = next
    showTheme(next)
    themeSaveError.value = saveTheme(deviceStorage(), next) ? '' : `配色已经换好，但没能存到这台设备，下次打开客户端会换回原来的配色。可以再点一下「${themeName(next)}」重试。`
    matchNativeAppearance(next)
  }

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
    showTheme(theme.value)
    matchNativeAppearance(theme.value)
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
    nativeAppearanceNext = null
    app.flushLocalState()
    if (initialized) {
      window.removeEventListener('pagehide', flushDrafts)
      document.removeEventListener('visibilitychange', flushDrafts)
    }
    unlisteners.forEach((unlisten) => unlisten())
    void extensionUi.clear()
  })

  return { appSettings, appSettingsSaving, appSettingsError, theme, themeLabel, themeSaveError, themeSyncError, desktopShell, desktopShellBusy, windowsAwayLabel, retryDesktopHost, runDesktopShellAction, openAppSettings, chooseWindowsAwayDelay, chooseTheme, initialize }
})
