import type { ReadonlyRefs } from './ownerView'
import { useExtensionUiStore } from '../stores/extension-ui'
import { isTauri } from './bridge'
import { computed, nextTick, onScopeDispose, ref, shallowReactive, watch } from 'vue'
import type { ControlSection } from './localCommands'
import type { useComposer } from './composer'
import { useAppStore } from '../stores/app'
export type ImagePreview =
  | { kind: 'conversation'; imageKey: string; url: string; handle?: string; name: string }
  | { kind: 'attachment'; attachmentKey: string; url: string; handle?: string; name: string }
/** Page-only surfaces, history/back, wheel and focus. No native facts or receipts. */
export function usePageSurfaces(options: {
  composer(): ReadonlyRefs<Pick<ReturnType<typeof useComposer>, 'expanded' | 'composing' | 'collapse'>>
  extensionActive(): boolean
  directoryBusy(): boolean
  modelLabel(): string
}) {
  const app = useAppStore()
  const extensionUi = useExtensionUiStore()
  const selected = computed(() => app.selectedWork)
  watch(() => extensionUi.controller?.handle, (handle) => {
    if (!handle) restoreDocumentTitle()
  })
  watch(() => selected.value?.displayName, () => {
    if (!extensionUi.controller) restoreDocumentTitle()
  })

  function restoreDocumentTitle() { document.title = app.selectedWork ? `${app.selectedWork.displayName} · AluDock` : 'AluDock Client' }

  const directoryOpen = ref(false)
  const commandOpen = ref(false)
  const controlSection = ref<ControlSection>('commands')
  const controlTitleOverride = ref('')
  const controlBodyOverride = ref('')
  const controlSizeOverride = ref<'default' | 'wide' | 'tree' | ''>('')
  const confirmDialog = ref<{ title: string; body: string; resolve: (confirmed: boolean) => void } | null>(null)
  const appSettingsOpen = ref(false)

  const hostSettingsOpen = ref(false)

  const imagePreview = ref<ImagePreview | null>(null)
  const messageTextView = ref<{ title: string; text: string; markdown: boolean } | null>(null)
  const imageSaving = ref(false)
  const imageSaveStatus = ref<{ tone: 'success' | 'error'; text: string } | null>(null)

  const deliveryOpen = ref(false)
  const workspaceBrowserOpen = ref(false)

  const dockToolsTrigger = ref<HTMLButtonElement | null>(null)
  const dockToolsPopoverStyle = ref<Record<string, string>>({})
  type Surface = 'image' | 'text' | 'expanded' | 'control' | 'app-settings' | 'directory-host' | 'confirm'
  const surfaceElements = shallowReactive(new Map<Surface, HTMLElement>())
  const modalSurface = computed(() => {
    for (const key of ['confirm', 'directory-host', 'app-settings', 'control', 'expanded', 'text', 'image'] as const) {
      const element = surfaceElements.get(key)
      if (element) return element
    }
    return null
  })
  function bindSurface(key: Surface, element: unknown) {
    if (element) surfaceElements.set(key, element as HTMLElement)
    else surfaceElements.delete(key)
  }
  let modalTrigger: HTMLElement | null = null

  const modalOpen = computed(() => workspaceBrowserOpen.value || deliveryOpen.value || directoryOpen.value || commandOpen.value || appSettingsOpen.value || hostSettingsOpen.value || options.composer().expanded.value || !!confirmDialog.value || !!imagePreview.value || !!messageTextView.value)

  /* Android 返回键走 WebView 浏览历史（wry：canGoBack→goBack，否则退出 app）。
     浮层/抽屉打开时压入一个占位历史条目，返回键触发 popstate 时关闭最上层；
     通过 ×/Esc/背景手动关闭时用 history.back() 同步消费占位，避免下一次返回键落空。 */
  const dockToolsOpen = computed(() => commandOpen.value && controlSection.value === 'dock-tools')
  const backLayerOpen = computed(() => modalOpen.value || app.workDrawerOpen)
  let backLayerArmed = false
  let backLayerPopClosing = false
  let backLayerConsumingManualClose = false
  watch(backLayerOpen, (open, wasOpen) => {
    if (open && !wasOpen && !backLayerPopClosing) {
      window.history.pushState({ aluLayer: true }, '')
      backLayerArmed = true
    } else if (!open && wasOpen && backLayerArmed && !backLayerPopClosing) {
      backLayerArmed = false
      backLayerConsumingManualClose = true
      window.history.back()
    } else if (!open && wasOpen) {
      backLayerArmed = false
    }
  })

  function handlePopstate() {
    if (backLayerConsumingManualClose) {
      backLayerConsumingManualClose = false
      return
    }
    if (!backLayerOpen.value) return
    if (directoryOpen.value && options.directoryBusy()) {
      window.history.pushState({ aluLayer: true }, '')
      backLayerArmed = true
      return
    }
    backLayerPopClosing = true
    backLayerArmed = false
    if (confirmDialog.value) settleConfirm(false)
    else {
      closeModal()
      app.workDrawerOpen = false
    }
    void nextTick(() => { backLayerPopClosing = false })
  }

  watch(confirmDialog, async (dialog) => {
    if (!dialog) return
    await nextTick()
    if (confirmDialog.value !== dialog) return
    modalSurface.value?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled)')?.focus()
  })
  watch(controlSection, async (section) => {
    if (!commandOpen.value) return
    await nextTick()
    if (!commandOpen.value || controlSection.value !== section) return
    const surface = modalSurface.value
    const initial = surface?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled), [autofocus]:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
      ?? surface?.querySelector<HTMLElement>('button:not(:disabled)')
    if (initial) initial.focus()
    else surface?.focus()
  })
  let composerOwnsModalFocus = false
  watch(modalOpen, async (open, wasOpen) => {
    if (open && !wasOpen) {
      composerOwnsModalFocus = options.composer().expanded.value
      await nextTick()
      if (!modalOpen.value || options.composer().expanded.value) return
      const surface = modalSurface.value
      const initial = surface?.querySelector<HTMLElement>('[data-modal-initial]:not(:disabled), [autofocus]:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
        ?? surface?.querySelector<HTMLElement>('button:not(:disabled)')
      if (initial) initial.focus()
      else surface?.focus()
    } else if (!open && wasOpen) {
      const trigger = modalTrigger
      modalTrigger = null
      if (composerOwnsModalFocus) { composerOwnsModalFocus = false; return }
      await nextTick()
      window.requestAnimationFrame(() => {
        if (!modalOpen.value && !options.extensionActive() && trigger?.isConnected) trigger.focus({ preventScroll: true })
      })
    }
  })

  let confirmationTrigger: HTMLElement | null = null
  function askConfirm(title: string, body = ''): Promise<boolean> {
    confirmationTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return new Promise((resolve) => { confirmDialog.value = { title, body, resolve } })
  }

  function settleConfirm(confirmed: boolean) {
    const dialog = confirmDialog.value
    if (!dialog) return
    confirmDialog.value = null
    dialog.resolve(confirmed)
    const trigger = confirmationTrigger
    confirmationTrigger = null
    void nextTick(() => {
      if (!confirmDialog.value && trigger?.isConnected && (modalOpen.value || !options.extensionActive())) trigger.focus({ preventScroll: true })
    })
  }

  function rememberModalTrigger() {
    if (!modalOpen.value && document.activeElement instanceof HTMLElement) modalTrigger = document.activeElement
  }

  function closeModal() {
    if (directoryOpen.value && options.directoryBusy()) return
    workspaceBrowserOpen.value = false
    deliveryOpen.value = false
    directoryOpen.value = false
    commandOpen.value = false
    appSettingsOpen.value = false
    hostSettingsOpen.value = false
    options.composer().collapse()
    imagePreview.value = null
    messageTextView.value = null
    imageSaving.value = false
    imageSaveStatus.value = null
  }

  function handleGlobalModalKeydown(event: KeyboardEvent) {
    if (!modalOpen.value || event.key !== 'Escape' || event.isComposing || options.composer().composing.value) return
    event.preventDefault()
    event.stopPropagation()
    if (confirmDialog.value) settleConfirm(false)
    else closeModal()
  }

  function handleModalWheel(event: WheelEvent) {
    const surface = modalSurface.value
    if (!surface || event.ctrlKey) return
    event.preventDefault()
    event.stopPropagation()
    const isScrollable = (element: HTMLElement) => {
      const overflow = window.getComputedStyle(element).overflowY
      return ['auto', 'scroll', 'overlay'].includes(overflow) && element.scrollHeight > element.clientHeight + 1
    }
    let scroller = event.target instanceof HTMLElement ? event.target : null
    while (scroller && scroller !== surface && !isScrollable(scroller)) scroller = scroller.parentElement
    if (!scroller || !surface.contains(scroller) || !isScrollable(scroller)) {
      scroller = [...surface.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.offsetParent !== null && isScrollable(element))
        .sort((left, right) => right.clientHeight - left.clientHeight)[0] ?? null
    }
    if (!scroller) return
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scroller.clientHeight
        : 1
    scroller.scrollTop += event.deltaY * scale
  }

  /** 命令面板点背景不关闭（防止写一半的命令误点丢失），但给一个明确的"收到但不关"反馈。 */
  function pulseCommandPalette() {
    if (controlSection.value !== 'commands') return
    const box = modalSurface.value
    if (!box) return
    box.classList.remove('cmd-palette-attention')
    void box.offsetWidth
    box.classList.add('cmd-palette-attention')
  }

  function handleModalKeydown(event: KeyboardEvent) {
    if (event.isComposing || options.composer().composing.value) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeModal()
      return
    }
    if (event.key !== 'Tab' || !modalSurface.value) return
    const focusable = [...modalSurface.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null)
    if (!focusable.length) {
      event.preventDefault()
      modalSurface.value.focus()
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function controlDialogTitle(section: ControlSection) {
    return ({
      commands: '命令中心', 'dock-tools': 'Dock Tools', sessions: '恢复 Session', tree: 'Session Tree', 'new-session': 'New Session',
      'rename-session': '会话名称', 'compact-session': '压缩上下文', 'reload-session': 'Reload Session',
      models: '选择 Model', thinking: 'Thinking Level', tools: 'Active Tools', resources: '项目状态', settings: '设置',
    } as Record<ControlSection, string>)[section]
  }

  function controlDialogBody(section: ControlSection) {
    if (section === 'models') return `当前：${options.modelLabel()}`
    if (section === 'dock-tools') return '当前 Work 可以交给 Agent 使用的 Dock 能力'
    if (section === 'resources') return '当前 Work、Session、Git 与已加载能力'
    if (section === 'tree') {
      return '浏览、切换或分叉当前会话树'
    }
    if (section === 'sessions') return '从当前目录保存的 Session 继续'
    return ''
  }

  function setControlDialogTitle(title: string, body = '') {
    controlTitleOverride.value = title
    controlBodyOverride.value = body
  }

  function controlDialogClasses(section: ControlSection) {
    const size = controlSizeOverride.value || (section === 'tree' ? 'tree' : ['sessions', 'models', 'tools', 'resources', 'settings'].includes(section) ? 'wide' : 'default')
    return ['ui-dialog-box', size === 'tree' ? 'ui-dialog-size-tree' : size === 'wide' ? 'ui-dialog-size-wide' : '']
  }

  function openControlCenter(section: ControlSection) {
    if (!app.selectedWork) return
    rememberModalTrigger()
    controlTitleOverride.value = ''
    controlBodyOverride.value = ''
    controlSizeOverride.value = ''
    controlSection.value = section
    commandOpen.value = true
    directoryOpen.value = false
    appSettingsOpen.value = false
    hostSettingsOpen.value = false
    app.workDrawerOpen = false
  }

  function positionDockToolsPopover() {
    if (!dockToolsOpen.value && controlSection.value !== 'dock-tools') return
    const trigger = dockToolsTrigger.value
    if (!trigger) return
    const bounds = trigger.getBoundingClientRect()
    dockToolsPopoverStyle.value = {
      '--dock-tools-popover-top': `${Math.round(bounds.bottom + 8)}px`,
      '--dock-tools-popover-right': `${Math.max(12, Math.round(window.innerWidth - bounds.right))}px`,
    }
  }

  function openDockTools() {
    if (dockToolsOpen.value) {
      closeModal()
      return
    }
    openControlCenter('dock-tools')
    positionDockToolsPopover()
  }

  function openMessageText(title: string, text: string, markdown = false) {
    if (!text) return
    rememberModalTrigger()
    messageTextView.value = { title, text, markdown }
  }

  function showImagePreview(preview: ImagePreview) {
    rememberModalTrigger()
    imageSaving.value = false
    imageSaveStatus.value = null
    imagePreview.value = preview
  }

  let shortcuts: { abort(): Promise<void>; restoreQueue(): Promise<boolean> } | undefined
  function listenShortcuts(actions: NonNullable<typeof shortcuts>) {
    shortcuts = actions
    window.addEventListener('keydown', handleGlobalModalKeydown, true)
    window.addEventListener('keydown', handleDesktopShortcut)
    window.addEventListener('popstate', handlePopstate)
    window.addEventListener('resize', positionDockToolsPopover)
  }
  onScopeDispose(() => {
    window.removeEventListener('keydown', handleGlobalModalKeydown, true)
    window.removeEventListener('keydown', handleDesktopShortcut)
    window.removeEventListener('popstate', handlePopstate)
    window.removeEventListener('resize', positionDockToolsPopover)
  })
  function handleDesktopShortcut(event: KeyboardEvent) {
    if (!isTauri || event.defaultPrevented || event.isComposing || options.composer().composing.value || event.repeat || modalOpen.value) return
    const key = event.key.toLowerCase()
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (app.selectedWork?.execution !== 'running') return
      event.preventDefault()
      void shortcuts?.abort()
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'k') {
      if (!app.selectedWork) return
      event.preventDefault()
      openControlCenter('commands')
      return
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowUp') {
      if (!app.selectedWork || app.selectedWork.lifecycle !== 'active') return
      event.preventDefault()
      void shortcuts?.restoreQueue()
    }
  }

  function openWorkspaceBrowser() {
    if (app.selectedWork?.lifecycle !== 'active') return
    rememberModalTrigger(); deliveryOpen.value = false; app.workDrawerOpen = false; workspaceBrowserOpen.value = true
  }
  watch(() => JSON.stringify([app.activeConnectionId, app.selectedWorkId]), () => { messageTextView.value = null })
  function closeControl() { commandOpen.value = false }
  function closeDirectory() { directoryOpen.value = false }
  function openDirectory() { rememberModalTrigger(); directoryOpen.value = true; commandOpen.value = false }
  function openHostSettings() {
    rememberModalTrigger(); hostSettingsOpen.value = true; appSettingsOpen.value = false
    directoryOpen.value = false; commandOpen.value = false; app.workDrawerOpen = false
  }
  function openAppSettings() {
    rememberModalTrigger(); appSettingsOpen.value = true; hostSettingsOpen.value = false
    directoryOpen.value = false; commandOpen.value = false; app.workDrawerOpen = false
  }
  function openDeliveryTray() { rememberModalTrigger(); app.workDrawerOpen = false; deliveryOpen.value = true }
  function closeWorkPanels() { deliveryOpen.value = false; workspaceBrowserOpen.value = false }
  function retirePreview(kind: ImagePreview['kind'], key?: string) {
    const preview = imagePreview.value
    if (preview?.kind !== kind) return
    if (key && (preview.kind === 'conversation' ? preview.imageKey : preview.attachmentKey) !== key) return
    imagePreview.value = null
  }
  function moveAttachmentPreview(from: string, to: string) {
    const preview = imagePreview.value
    if (preview?.kind === 'attachment' && preview.attachmentKey === from) imagePreview.value = { ...preview, attachmentKey: to }
  }

  function returnFocusTo(element: HTMLElement | null) { modalTrigger = element }
  return { directoryOpen, commandOpen, controlSection, controlTitleOverride, controlBodyOverride, controlSizeOverride, confirmDialog, appSettingsOpen, hostSettingsOpen, imagePreview, messageTextView, imageSaving, imageSaveStatus, deliveryOpen, workspaceBrowserOpen, dockToolsTrigger, dockToolsPopoverStyle, modalOpen, dockToolsOpen, askConfirm, settleConfirm, rememberModalTrigger, closeModal, handleModalKeydown, handleModalWheel, controlDialogTitle, controlDialogBody, setControlDialogTitle, controlDialogClasses, openControlCenter, openDockTools, pulseCommandPalette, openMessageText, showImagePreview, returnFocusTo, listenShortcuts, openWorkspaceBrowser, bindSurface, closeControl, closeDirectory, openDirectory, openHostSettings, openAppSettings, openDeliveryTray, closeWorkPanels, retirePreview, moveAttachmentPreview }
}
