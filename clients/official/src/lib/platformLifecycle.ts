import type { ReadonlyRefs } from './ownerView'
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { beginWindowsAway, cancelWindowsAway, getClientPreferences, getDesktopShellStatus, isTauri, reselectHostRoute, startDesktopHost, updateClientPreferences } from './bridge'
import { initialWindowFocused } from './uiBoundaries'
import { userErrorMessage as errorMessage } from './userError'
import type { ClientPreferences, DesktopShellStatus, WindowsAwayDelay } from './types'
import type { usePageSurfaces } from './pageSurfaces'
import type { useWorkObservation } from './workObservation'
import { useAppStore } from '../stores/app'
import { useExtensionUiStore } from '../stores/extension-ui'
/** Platform lifecycle only. Away/background follows the existing native policy. */
export function usePlatformLifecycle(page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'openAppSettings'>>, options: { observation(): ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'canContinue' | 'detach' | 'load' | 'loading' | 'reportRouteError'>> }) {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const extensionUi = useExtensionUiStore()
  const isAndroidWebView = /Android/i.test(navigator.userAgent)
  const appSettings = ref<ClientPreferences | null>(null)
  const appSettingsSaving = ref(false)
  const appSettingsError = ref('')
  const desktopShell = ref<DesktopShellStatus | null>(null)
  const desktopShellBusy = ref(false)

  const windowFocused = ref(!isTauri)
  let windowFocusEpoch = 0
  let windowsAwayId: string | null = null
  const elapsedWindowsAwayIds = new Set<string>()
  const unlisteners: UnlistenFn[] = []

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
    page.openAppSettings()
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

  function runningWorkIdsForAway() {
    return app.works.filter((work) => work.execution === 'running').map((work) => work.id)
  }

  function flushDrafts() { app.flushLocalState() }

  function handleWebViewFocus() {
    void handleWindowFocusChanged(true)
  }

  function handleAndroidNetworkChanged() {
    const context = app.connectionContext
    if (context && !app.localSelected) void reselectHostRoute({ ...context }).catch(cause => {
      if (app.contextMatches(context)) options.observation().reportRouteError(cause)
    })
  }

  async function handleWindowFocusChanged(focused: boolean) {
    if (focused === windowFocused.value) {
      const work = selected.value
      if (focused && work?.lifecycle === 'active' && !options.observation().loading.value && !options.observation().canContinue(work.id)) {
        await options.observation().load(work.id)
      }
      return
    }
    const epoch = ++windowFocusEpoch
    windowFocused.value = focused
    if (!focused) {
      app.flushLocalState()
      if (!appSettings.value?.windowsAwaySupported) {
        await options.observation().detach()
        return
      }
      try {
        const awayId = await beginWindowsAway(runningWorkIdsForAway())
        if (epoch !== windowFocusEpoch || windowFocused.value) {
          if (awayId) await cancelWindowsAway(awayId)
          return
        }
        windowsAwayId = awayId
        if (awayId && elapsedWindowsAwayIds.delete(awayId)) await options.observation().detach()
      } catch (cause) {
        console.error('Failed to begin Windows away period.', cause)
        if (epoch === windowFocusEpoch && !windowFocused.value) await options.observation().detach()
      }
      return
    }

    const awayId = windowsAwayId
    windowsAwayId = null
    elapsedWindowsAwayIds.clear()
    if (appSettings.value?.windowsAwaySupported) {
      try {
        await cancelWindowsAway(awayId)
      } catch (cause) {
        console.error('Failed to finish Windows away period.', cause)
      }
    }
    void app.refreshWorksQuietly()
    if (epoch !== windowFocusEpoch || !windowFocused.value) return
    const work = selected.value
    if (work?.lifecycle === 'active' && !options.observation().canContinue(work.id)) {
      await options.observation().load(work.id)
    }
  }

  async function initialize() {

    window.addEventListener('pagehide', flushDrafts)
    document.addEventListener('visibilitychange', flushDrafts)
    window.addEventListener('focus', handleWebViewFocus)
    if (isAndroidWebView) {
      window.addEventListener('aludock:network-changed', handleAndroidNetworkChanged)
      document.documentElement.dataset.aludockNetworkReady = 'true'
    }
    try {
      appSettings.value = await getClientPreferences()
    } catch (cause) {
      console.error('Failed to read App settings.', cause)
    }
    if (isTauri) {
      const appWindow = getCurrentWindow()
      let shellEventRevision = 0
      unlisteners.push(
        await listen<DesktopShellStatus>('desktop-shell-changed', ({ payload }) => {
          shellEventRevision += 1
          const becameReady = payload.hostReady && !desktopShell.value?.hostReady
          desktopShell.value = payload
          if (becameReady && payload.role === 'main') void app.load()
        }),
        await appWindow.onFocusChanged(({ payload }) => { void handleWindowFocusChanged(payload) }),
      )
      const requestedRevision = shellEventRevision
      const initialShell = await getDesktopShellStatus()
      if (shellEventRevision === requestedRevision) desktopShell.value = initialShell
      windowFocused.value = initialWindowFocused(
        await appWindow.isFocused(),
        document.hasFocus(),
        isAndroidWebView && document.visibilityState === 'visible',
      )
      unlisteners.push(
        await listen<{ awayId: string }>('aludock://windows-away-elapsed', ({ payload }) => {
          if (windowFocused.value) return
          if (payload.awayId === windowsAwayId) void options.observation().detach()
          else elapsedWindowsAwayIds.add(payload.awayId)
        }),

      )
      if (!windowFocused.value && appSettings.value?.windowsAwaySupported) {
        try {
          windowsAwayId = await beginWindowsAway(runningWorkIdsForAway())
          if (windowsAwayId && elapsedWindowsAwayIds.delete(windowsAwayId)) await options.observation().detach()
        } catch (cause) {
          console.error('Failed to begin initial Windows away period.', cause)
        }
      }
    }
  }
  async function afterLoad() {

    await nextTick()
    if (isTauri) {
      const focusedAfterLoad = initialWindowFocused(
        await getCurrentWindow().isFocused(),
        document.hasFocus(),
        isAndroidWebView && document.visibilityState === 'visible',
      )
      if (focusedAfterLoad) await handleWindowFocusChanged(true)
    }

  }
  onUnmounted(() => {
    app.flushLocalState()
    window.removeEventListener('pagehide', flushDrafts)
    document.removeEventListener('visibilitychange', flushDrafts)
    window.removeEventListener('focus', handleWebViewFocus)
    if (isAndroidWebView) {
      window.removeEventListener('aludock:network-changed', handleAndroidNetworkChanged)
      delete document.documentElement.dataset.aludockNetworkReady
    }
    unlisteners.forEach((unlisten) => unlisten())
    elapsedWindowsAwayIds.clear()
    if (appSettings.value?.windowsAwaySupported) void cancelWindowsAway(windowsAwayId)
    void extensionUi.clear()
  })

  return { appSettings, appSettingsSaving, appSettingsError, desktopShell, desktopShellBusy, windowFocused, windowsAwayLabel, retryDesktopHost, runDesktopShellAction, openAppSettings, chooseWindowsAwayDelay, initialize, afterLoad }
}
