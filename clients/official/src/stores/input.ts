import { defineStore, storeToRefs } from 'pinia'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useComposer } from '../lib/composer'
import { dequeueMessages, getCommandCompletions, isTauri, submitMessage, submitText } from '../lib/bridge'
import { attachmentUploadMatches, attachmentUploadTarget } from '../lib/attachmentDraft'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { conversationBoundaryKey } from '../lib/uiBoundaries'
import { applySlashArgumentCompletion, applySlashCompletion, catalogSourceLabel, filterCatalogCommands, prefixSlashCommand, slashArgumentContext, slashCommandQuery } from '../lib/commandSuggest'
import { filterLocalControlCommands, localControlCommands, submittedLocalControl, type LocalControlCommand } from '../lib/localCommands'
import { shellRunQuote } from '../lib/conversation'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { EditorCapture, NativeOperation } from '../lib/operationBinding'
import type { QuickButton } from '../lib/quickButtons'
import type { CommandArgumentCompletion, CommandInfo, ShellRunItem } from '../lib/types'
import { useAppStore } from './app'
import { useAttachmentsStore } from './attachments'
import { useCommandCatalogStore } from './command-catalog'
import { useConversationStore } from './conversation'
import { useExtensionUiStore } from './extension-ui'
import { useHostStore } from './host'
import { useObservationStore } from './observation'
import { useOperationsStore } from './operations'
import { useSurfacesStore } from './surfaces'
import { useWorkActionsStore } from './work-actions'
/** One editor for compact and expanded input, its send/Queue feedback and desktop shortcuts. */
export const useInputStore = defineStore('input', () => {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const extensionUi = useExtensionUiStore()
  const commandCatalogStore = useCommandCatalogStore()
  const surfaces = useSurfacesStore()
  const observation = useObservationStore()
  const host = useHostStore()
  const workActions = useWorkActionsStore()
  const attachments = useAttachmentsStore()
  const operations = useOperationsStore()
  const conversation = useConversationStore()
  const submissionError = ref<string | null>(null)

  const { composerExpanded, composerComposing } = storeToRefs(surfaces)
  const composer = useComposer({
    read: () => app.currentDraft, write: (value) => app.setCurrentDraft(value),
    identity: () => JSON.stringify([app.connectionContext, app.selectedWorkId]),
    flush: () => app.flushLocalState(),
    canFocus: () => !extensionUi.activeRequest && (!surfaces.modalOpen || composerExpanded.value),
    expanded: composerExpanded, composing: composerComposing,
  })
  const { draft, compact: composerTextarea, expandedTextarea, tall: composerTall } = composer

  let composerExpansionRevision = 0
  watch(composerExpanded, () => { composerExpansionRevision += 1 }, { flush: 'sync' })

  const pendingSubmits = ref(new Set<string>())
  const submitWorkKey = computed(() => JSON.stringify([app.activeConnectionId, selected.value?.id]))
  const acknowledgedSubmits = ref<Set<string>>(new Set())
  let submitAttemptSequence = 0
  let submitViewRevision = 0
  watch(() => JSON.stringify([
    conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id),
    selected.value?.ownerHostEpoch, selected.value?.runtimeGeneration, selected.value?.executor.piSessionId,
  ]), () => { submitViewRevision += 1 }, { flush: 'sync' })
  const selectedSubmitAttempt = computed(() => {
    const candidates = [...app.nativeOperations.values()].filter(operation => operation.kind === 'submit_message'
      && operation.connectionId === app.activeConnectionId && operation.instanceId === selected.value?.id
      && operation.hostEpoch === selected.value.ownerHostEpoch && operation.runtimeGeneration === selected.value.runtimeGeneration
      && operation.sessionId === selected.value.executor.piSessionId)
    return candidates.find(operation => operation.state === 'pending') ?? candidates.find(operation => operation.state === 'unknown')
  })
  const submitting = computed(() => pendingSubmits.value.has(submitWorkKey.value) || selectedSubmitAttempt.value?.state === 'pending')
  const submitOutcomeUnknown = computed(() => selectedSubmitAttempt.value?.state === 'unknown')
  const submitAcknowledged = computed(() => !!selectedSubmitAttempt.value && acknowledgedSubmits.value.has(selectedSubmitAttempt.value.operationId))
  const submitBlocked = computed(() => submitting.value || (submitOutcomeUnknown.value && !submitAcknowledged.value))
  const submitAttemptError = computed(() => submitOutcomeUnknown.value
    ? '还无法确认消息是否已进入 Queue，内容已保留。请刷新查看；再次发送可能重复。' : null)
  function allowAnotherSubmit() {
    if (selectedSubmitAttempt.value?.state === 'unknown') acknowledgedSubmits.value.add(selectedSubmitAttempt.value.operationId)
  }

  async function presentSubmitFailure(operation: NativeOperation, consumeNativeOperation: (operation: NativeOperation) => Promise<void>) {
    const revision = submitViewRevision
    const canPresent = () => submitViewRevision === revision && observation.windowFocused && document.visibilityState === 'visible'
      && operation.connectionId === app.activeConnectionId && operation.hostEpoch === app.payload?.host.hostEpoch
      && operation.instanceId === selected.value?.id && selected.value.lifecycle === 'active'
      && operation.runtimeGeneration === selected.value.runtimeGeneration && operation.sessionId === selected.value.executor.piSessionId
      && !app.workDrawerOpen && !surfaces.commandOpen && !surfaces.directoryOpen && !surfaces.hostSettingsOpen && !surfaces.appSettingsOpen && !surfaces.machineSettingsOpen
      && !surfaces.workspaceBrowserOpen && !surfaces.deliveryOpen && !surfaces.imagePreview && !surfaces.messageTextView && !surfaces.confirmDialog
      && !extensionUi.activeRequest
    if (!canPresent()) return
    const message = errorMessage(operation.error, '这次消息没有发送。当前编辑内容已保留，请检查原因后重试。')
    submissionError.value = message
    try {
      await nextTick()
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
      if (!canPresent() || visibleComposerError.value !== message) return
      // Only the still-visible inline handoff may consume this receipt. In
      // particular, do not await another native read before rechecking selection.
      await consumeNativeOperation(operation)
    } catch {
      // Failed acknowledgement leaves the same scoped result entry available.
    }
  }

  const pendingQueueRestores = ref(new Set<string>())
  const queueRestoring = computed(() => pendingQueueRestores.value.has(submitWorkKey.value))
  const queueNotice = ref('')
  let queueNoticeTimer = 0

  function clearQueueNotice() {
    window.clearTimeout(queueNoticeTimer)
    queueNoticeTimer = 0
    queueNotice.value = ''
  }

  function showQueueNotice(text: string) {
    clearQueueNotice()
    queueNotice.value = text
    queueNoticeTimer = window.setTimeout(() => {
      queueNotice.value = ''
      queueNoticeTimer = 0
    }, 3_500)
  }

  const queueItems = computed(() => observation.queue)

  const visibleComposerError = computed(() => submitAttemptError.value || submissionError.value || workActions.actionError || workActions.currentCompactionError)

  /* ── 输入框斜杠命令建议 ────────────────────────────────
   * pi 只展开位于消息最开头的 /command，因此建议仅在整段草稿
   * 就是一个未完成命令 token 时出现；补全后尾部空格进入参数输入。
   */
  type ComposerCommandSuggestion =
    | { kind: 'local'; name: string; description: string; sourceLabel: string }
    | { kind: 'catalog'; name: string; description?: string; argumentHint?: string; sourceLabel: string; command: CommandInfo }
    | { kind: 'argument'; name: string; description?: string; sourceLabel: string; value: string; commandName: string }

  const suggestIndex = ref(0)
  const suggestDismissedFor = ref('')
  const slashQuery = computed(() => slashCommandQuery(draft.value))
  const composerArgumentContext = computed(() => slashArgumentContext(draft.value))
  const composerArgumentCommand = computed(() => {
    const context = composerArgumentContext.value
    if (!context || localControlCommands.some((command) => command.name === context.name)) return null
    const matching = commandCatalogStore.commands.filter((command) => command.name === context.name)
    return matching.length === 1 && matching[0]?.argumentCompletions ? matching[0] : null
  })
  const composerArgumentItems = ref<CommandArgumentCompletion[]>([])
  const composerArgumentLoading = ref(false)
  let composerCompletionTimer = 0
  let composerCompletionEpoch = 0

  const commandSuggestItems = computed<ComposerCommandSuggestion[]>(() => {
    const query = slashQuery.value
    if (query === null) return []
    const local = filterLocalControlCommands(query).map((command) => ({
      kind: 'local' as const,
      name: command.name,
      description: command.description,
      sourceLabel: '客户端操作',
    }))
    const localNames = new Set(localControlCommands.map((command) => command.name))
    const catalog = filterCatalogCommands(commandCatalogStore.commands.filter((command) => !localNames.has(command.name)), query).map((command) => ({
      kind: 'catalog' as const,
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      sourceLabel: catalogSourceLabel(command.source.kind),
      command,
    }))
    return [...local, ...catalog].slice(0, 8)
  })
  const argumentSuggestItems = computed<ComposerCommandSuggestion[]>(() => {
    const context = composerArgumentContext.value
    if (!context || !composerArgumentCommand.value) return []
    return composerArgumentItems.value.slice(0, 8).map((item) => ({
      kind: 'argument' as const,
      name: item.label,
      description: item.description,
      sourceLabel: '参数',
      value: item.value,
      commandName: context.name,
    }))
  })
  const suggestItems = computed(() => slashQuery.value !== null ? commandSuggestItems.value : argumentSuggestItems.value)
  const suggestOpen = computed(() => !!selected.value
    && selected.value.lifecycle === 'active'

    && !composerExpanded.value
    && (slashQuery.value !== null || composerArgumentLoading.value || argumentSuggestItems.value.length > 0)
    && suggestDismissedFor.value !== draft.value)
  watch(slashQuery, (query) => {
    suggestIndex.value = 0
    if (query !== null) ensureCommandCatalog()
  })
  watch(composerArgumentContext, (context) => {
    suggestIndex.value = 0
    if (context) ensureCommandCatalog()
  })
  watch([composerArgumentContext, composerArgumentCommand], () => scheduleComposerArgumentCompletions())
  watch(suggestItems, (items) => {
    suggestIndex.value = Math.max(0, Math.min(suggestIndex.value, items.length - 1))
  })
  watch(suggestIndex, async () => {
    await nextTick()
    document.getElementById(`cmd-suggest-${suggestIndex.value}`)?.scrollIntoView({ block: 'nearest' })
  })

  function ensureCommandCatalog() {
    if (!selected.value) return
    try {
      void commandCatalogStore.ensure(selected.value, requireConnectionContext(app))
    } catch {
      // Host 上下文不可用时建议列表保持空，不打扰输入
    }
  }

  function completeSuggest(item?: ComposerCommandSuggestion) {
    const picked = item ?? suggestItems.value[suggestIndex.value]
    if (!picked) return
    draft.value = picked.kind === 'argument'
      ? applySlashArgumentCompletion(picked.commandName, picked.value)
      : applySlashCompletion(picked.name)
    if (picked.kind === 'argument') suggestDismissedFor.value = draft.value
    suggestIndex.value = 0
    void nextTick(() => {
      const textarea = composerTextarea.value
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }

  function scheduleComposerArgumentCompletions() {
    window.clearTimeout(composerCompletionTimer)
    const context = composerArgumentContext.value
    const command = composerArgumentCommand.value
    if (!context || !command) {
      composerCompletionEpoch += 1
      composerArgumentItems.value = []
      composerArgumentLoading.value = false
      return
    }
    const epoch = ++composerCompletionEpoch
    const prefix = context.prefix
    composerArgumentLoading.value = true
    composerCompletionTimer = window.setTimeout(async () => {
      const work = selected.value
      if (!work) return
      try {
        const result = await currentConnectionCall(app, (host) => getCommandCompletions(work.id, command.referenceId, prefix, host))
        const current = composerArgumentContext.value
        if (epoch !== composerCompletionEpoch || selected.value?.id !== work.id || composerArgumentCommand.value?.referenceId !== command.referenceId || current?.prefix !== prefix) return
        composerArgumentItems.value = result.referenceId === command.referenceId ? result.items ?? [] : []
      } catch {
        if (epoch === composerCompletionEpoch) composerArgumentItems.value = []
      } finally {
        if (epoch === composerCompletionEpoch) composerArgumentLoading.value = false
      }
    }, 160)
  }

  /** 命令面板里选中 prompt/skill 命令：它们本质是发一条消息，填回输入框交回对话。
   *  焦点走 modal 关闭时的 trigger 归位通道，避免和归位逻辑抢时序。 */
  function prefillSlashCommand(name: string) {
    draft.value = prefixSlashCommand(name, draft.value)
    focusComposerEnd()
  }

  /** Hands focus back to the compact editor with the cursor at the end, after an open palette closes. */
  function focusComposerEnd() {
    surfaces.returnFocusTo(composerTextarea.value)
    surfaces.closeControl()
    void nextTick(() => {
      const textarea = composerTextarea.value
      if (!textarea || extensionUi.activeRequest) return
      window.setTimeout(() => {
        if (extensionUi.activeRequest || surfaces.modalOpen) return
        textarea.focus()
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }, 0)
    })
  }

  async function restoreQueue(): Promise<boolean> {
    const work = selected.value
    if (!work || host.pairingInProgress || attachments.attachmentPicking || attachments.clearingRestoredImages || queueRestoring.value || submitting.value) return false
    const context = requireConnectionContext(app)
    const viewRevision = submitViewRevision
    const pendingKey = submitWorkKey.value
    pendingQueueRestores.value.add(pendingKey)
    submissionError.value = null
    clearQueueNotice()
    try {
      const result = await dequeueMessages(work.id, app.captureOperationTarget(context, work.id))
      if (!app.contextMatches(context) || submitViewRevision !== viewRevision || selected.value?.id !== work.id || result.receipt.instanceId !== work.id || result.instance.id !== work.id) return false
      showQueueNotice(result.receipt.restored.length
        ? `已取回 ${result.receipt.restored.length} 条消息。`
        : '没有可取回的消息。')
      return true
    } catch (cause) {

      if (app.contextMatches(context) && submitViewRevision === viewRevision) submissionError.value = errorMessage(cause)
      return false
    } finally {
      pendingQueueRestores.value.delete(pendingKey)
    }
  }

  const canSubmit = computed(() => {
    if (submittedLocalControl(draft.value)) return !!selected.value && selected.value.lifecycle === 'active'
    return app.operationResultsReady && ![...app.nativeOperations.values()].some(operation => operation.kind === 'submit_message' && operation.state === 'succeeded' && operation.connectionId === app.activeConnectionId && operation.instanceId === selected.value?.id)
      && !!selected.value && (!!draft.value.trim() || !!attachments.draftAttachments.length || !!attachments.restoredImageCount)
      && isTauri && !attachments.clearingRestoredImages && !submitBlocked.value
      && !queueRestoring.value && !attachments.attachmentPicking && !attachments.uploadDrafts.length
  })

  async function submit(): Promise<boolean> {
    const work = selected.value
    const captured = draft.value
    const capturedAttachments = attachments.draftAttachments.slice(0, attachments.maxMessageAttachments).map((item) => ({ ...item }))
    const localCommand = submittedLocalControl(captured)
    if (localCommand) return executeLocalControl(localCommand, captured)
    if (!work || !canSubmit.value) return false
    const currentHost = app.connectionContext
    if (!currentHost) return false
    const attachmentTarget = attachmentUploadTarget(work, currentHost)
    if (capturedAttachments.some((item) => item.localUpload && !attachmentUploadMatches(item.localUpload, attachmentTarget))) {
      submissionError.value = '附件不适用于当前工作，请移除后重新选择。'
      return false
    }
    const capturedHost = { ...requireConnectionContext(app) }
    const viewRevision = submitViewRevision
    submitAttemptSequence++
    const pendingKey = submitWorkKey.value
    pendingSubmits.value.add(pendingKey)
    submissionError.value = null
    try {
      const operation = app.captureOperation(capturedHost, work.id, capturedAttachments.map(item => item.fileId))
      const result = await submitMessage(work.id, captured, capturedAttachments.map(item => item.fileId), operation)
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) {
        if (!result.receipt.queued) conversation.showAgentActivity(work.id)
      }
      return true
    } catch (cause) {
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) submissionError.value = errorMessage(cause)
      return false
    } finally { pendingSubmits.value.delete(pendingKey) }
  }

  async function submitExpanded() {
    const viewRevision = submitViewRevision
    const expansionRevision = composerExpansionRevision
    const attemptSequence = submitAttemptSequence
    const originalDraft = draft.value
    const originalFiles = new Set(attachments.draftAttachments.map(item => item.fileId))
    const originalImageCount = attachments.restoredImageCount
    // The success reply can precede native draft cleanup. Close this surface without
    // claiming the draft ourselves, unless the user has already started another message.
    if (await submit() && submitViewRevision === viewRevision && composerExpansionRevision === expansionRevision
      && submitAttemptSequence <= attemptSequence + 1 && (!draft.value || draft.value === originalDraft)
      && attachments.draftAttachments.every(item => originalFiles.has(item.fileId))
      && attachments.restoredImageCount <= originalImageCount
      && !attachments.uploadDrafts.length) composerExpanded.value = false
  }

  /** `typed` is the editor text that asked for the control, cleared once it runs; a quick button passes null. */
  async function executeLocalControl(command: LocalControlCommand, typed: string | null): Promise<boolean> {
    if (!selected.value || selected.value.lifecycle !== 'active') return false
    const clearTyped = () => { if (typed !== null && draft.value === typed) draft.value = '' }
    if (command.section) {
      clearTyped()
      surfaces.openControlCenter(command.section)
      return true
    }
    if (command.action === 'restoreQueue') {
      clearTyped()
      return restoreQueue()
    }
    if (command.action === 'refresh') {
      clearTyped()
      await observation.refreshCurrent()
      return true
    }
    if (command.action === 'stop') {
      const context = requireConnectionContext(app)
      let original: EditorCapture | undefined
      if (typed !== null) {
        try { original = app.captureSubmitDraft(context.connectionId, selected.value.id, []) }
        catch { /* Stop must remain available; without a durable capture, keep the local command text. */ }
      }
      const stopped = await workActions.stopSelectedWork()
      if (stopped && original) app.completeSubmitDraft(original)
      return stopped
    }
    return false
  }

  function applyExtensionEditorText(text: string) {
    draft.value = text
  }

  /* ── 快捷按钮 ────────────────────────────────
   * 立即发送 = typing the text and pressing send, except the draft, its attachments and
   * retrieved images stay in the editor: the operation claims no editor and carries only
   * this text. Pending and unconfirmed sends gate it exactly like the send button.
   */
  const canSendText = computed(() => !!selected.value && selected.value.lifecycle === 'active' && isTauri
    && app.operationResultsReady && !submitBlocked.value)

  async function sendText(text: string): Promise<boolean> {
    const localCommand = submittedLocalControl(text)
    if (localCommand) return executeLocalControl(localCommand, null)
    const work = selected.value
    if (!work || !canSendText.value || !text.trim() || !app.connectionContext) return false
    const capturedHost = { ...requireConnectionContext(app) }
    const viewRevision = submitViewRevision
    const pendingKey = submitWorkKey.value
    pendingSubmits.value.add(pendingKey)
    submissionError.value = null
    try {
      const result = await submitText(work.id, text, work.executor.piSessionId, app.captureOperationTarget(capturedHost, work.id))
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) {
        if (!result.receipt.queued) conversation.showAgentActivity(work.id)
      }
      return true
    } catch (cause) {
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) submissionError.value = errorMessage(cause)
      return false
    } finally { pendingSubmits.value.delete(pendingKey) }
  }

  /** 填入: the text goes in front of the draft, the same as choosing a command in the palette. */
  function insertText(text: string) {
    if (!selected.value) return
    draft.value = `${text}${draft.value}`
    focusComposerEnd()
  }

  function quickButtonDisabled(button: QuickButton) {
    if (!selected.value || selected.value.lifecycle !== 'active') return true
    return button.mode === 'send' && !submittedLocalControl(button.text) && !canSendText.value
  }

  async function runQuickButton(button: QuickButton): Promise<boolean> {
    if (button.mode === 'insert') {
      insertText(button.text)
      return true
    }
    // A control that opens a panel switches an open palette to it; anything else closes the palette first.
    if (!submittedLocalControl(button.text)?.section) surfaces.closeControl()
    return sendText(button.text)
  }

  /** 「发给 agent」: the shell run is quoted into the draft after whatever is there; the reader still decides whether to send. */
  function appendShellQuote(item: ShellRunItem) {
    if (!selected.value) return
    draft.value = [draft.value, shellRunQuote(item)].filter(Boolean).join('\n\n')
    void nextTick(() => { if (!surfaces.modalOpen || composerExpanded.value) composer.compact.value?.focus({ preventScroll: true }) })
  }

  const resizeComposer = composer.resize

  function handleComposerKeydown(event: KeyboardEvent, expanded = false) {
    if (event.isComposing || composer.composing.value) return
    const textarea = event.currentTarget as HTMLTextAreaElement
    if (!expanded && suggestOpen.value) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        suggestIndex.value = Math.min(suggestIndex.value + 1, suggestItems.value.length - 1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        suggestIndex.value = Math.max(suggestIndex.value - 1, 0)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (suggestItems.value.length) {
          event.preventDefault()
          completeSuggest()
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        suggestDismissedFor.value = draft.value
        return
      }
    }
    if (isTauri && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === 'j' || event.code === 'KeyJ')) {
      event.preventDefault()
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? start
      textarea.setRangeText('\n', start, end, 'end')
      draft.value = textarea.value
      composer.remember(event)
      resizeComposer()
      return
    }
    if (!expanded && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      void submit()
    }
  }

  watch(() => JSON.stringify([app.activeConnectionId, selected.value?.id]), () => {
    clearQueueNotice()
    submissionError.value = null
    commandCatalogStore.invalidate()
  })
  /** Returned Queue images are removed only while no send or Queue retrieval is running. */
  function clearQueueImages() {
    if (submitting.value || queueRestoring.value) return
    void attachments.clearQueueImages()
  }

  // Desktop shortcuts: Esc aborts the reply, Ctrl/Cmd+K opens commands, Alt+↑ retrieves the Queue.
  function handleDesktopShortcut(event: KeyboardEvent) {
    if (!isTauri || event.defaultPrevented || event.isComposing || composerComposing.value || event.repeat || surfaces.modalOpen) return
    const key = event.key.toLowerCase()
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (app.selectedWork?.execution !== 'running') return
      event.preventDefault()
      void workActions.abortCurrentRun()
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'k') {
      if (!app.selectedWork) return
      event.preventDefault()
      surfaces.openControlCenter('commands')
      return
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowUp') {
      if (!app.selectedWork || app.selectedWork.lifecycle !== 'active') return
      event.preventDefault()
      void restoreQueue()
    }
  }
  let listeningShortcuts = false
  function listenShortcuts() {
    if (listeningShortcuts) return
    listeningShortcuts = true
    window.addEventListener('keydown', handleDesktopShortcut)
  }

  const offAttachmentError = attachments.onError((message) => { submissionError.value = message })
  const offFailurePresenter = operations.setFailurePresenter(presentSubmitFailure)
  onScopeDispose(() => {
    window.clearTimeout(composerCompletionTimer); clearQueueNotice()
    if (listeningShortcuts) window.removeEventListener('keydown', handleDesktopShortcut)
    offAttachmentError(); offFailurePresenter()
  })
  return {
    draft, composerTextarea, expandedTextarea, composerTall, queueRestoring, queueNotice, queueItems, submitting, submitOutcomeUnknown, submitAcknowledged, visibleComposerError, canSubmit,
    suggestIndex, slashQuery, suggestItems, suggestOpen, composerArgumentLoading,
    rememberSelection: composer.remember, trackComposition: composer.composition,
    submit, submitExpanded, restoreQueue, allowAnotherSubmit, prefillSlashCommand, applyExtensionEditorText, runQuickButton, quickButtonDisabled, appendShellQuote, completeSuggest, handleComposerKeydown, clearQueueImages, listenShortcuts,
  }
})
