import type { ReadonlyRefs } from './ownerView'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useComposer } from './composer'
import { dequeueMessages, getCommandCompletions, isTauri, submitMessage } from './bridge'
import { attachmentUploadMatches, attachmentUploadTarget } from './attachmentDraft'
import { currentConnectionCall, requireConnectionContext } from './hostResult'
import { conversationBoundaryKey } from './uiBoundaries'
import { applySlashArgumentCompletion, applySlashCompletion, catalogSourceLabel, filterCatalogCommands, prefixSlashCommand, slashArgumentContext, slashCommandQuery } from './commandSuggest'
import { filterLocalControlCommands, localControlCommands, submittedLocalControl, type LocalControlCommand } from './localCommands'
import { userErrorMessage as errorMessage } from './userError'
import type { EditorCapture, NativeOperation } from './operationBinding'
import type { CommandArgumentCompletion, CommandInfo, QueueItem } from './types'
import type { usePageSurfaces } from './pageSurfaces'
import type { useWorkObservation } from './workObservation'
import type { useWorkActions } from './workActions'
import type { useAttachmentUploads } from './attachmentUploads'
import { useAppStore } from '../stores/app'
import { useExtensionUiStore } from '../stores/extension-ui'
import { useCommandCatalogStore } from '../stores/command-catalog'
/** One editor owner for compact and expanded input; no display state access. */
export function useInputEditor(options: {
  page(): ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'appSettingsOpen' | 'closeControl' | 'commandOpen' | 'confirmDialog' | 'deliveryOpen' | 'directoryOpen' | 'hostSettingsOpen' | 'imagePreview' | 'messageTextView' | 'modalOpen' | 'openControlCenter' | 'returnFocusTo' | 'workspaceBrowserOpen'>>
  observation(): ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'queue' | 'connected' | 'loading'>>
  actions(): ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'actionError' | 'currentCompactionError' | 'nativeMutationPending' | 'workMutating' | 'mutationOutcomeUnknown' | 'stopSelectedWork'>>
  attachments(): ReadonlyRefs<Pick<ReturnType<typeof useAttachmentUploads>, 'draftAttachments' | 'maxMessageAttachments' | 'restoredImageCount' | 'clearingRestoredImages' | 'attachmentPicking' | 'uploadDrafts' | 'verifyForSubmit'>>
  focused(): boolean
  pairing(): boolean
  activity(workId: string): void
}) {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const extensionUi = useExtensionUiStore()
  const commandCatalogStore = useCommandCatalogStore()
  const submissionError = ref<string | null>(null)

  const composer = useComposer({
    read: () => app.currentDraft, write: (value) => app.setCurrentDraft(value),
    identity: () => JSON.stringify([app.connectionContext, app.selectedWorkId]),
    flush: () => app.flushLocalState(),
    canFocus: () => !extensionUi.activeRequest && (!options.page().modalOpen.value || composerExpanded.value),
  })
  const { draft, compact: composerTextarea, expandedTextarea, expanded: composerExpanded } = composer

  let composerExpansionRevision = 0
  watch(composerExpanded, () => { composerExpansionRevision += 1 }, { flush: 'sync' })

  const submitRequestPending = ref(false)
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
  const submitting = computed(() => submitRequestPending.value || selectedSubmitAttempt.value?.state === 'pending')
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
    const canPresent = () => submitViewRevision === revision && options.focused() && document.visibilityState === 'visible'
      && operation.connectionId === app.activeConnectionId && operation.hostEpoch === app.payload?.host.hostEpoch
      && operation.instanceId === selected.value?.id && selected.value.lifecycle === 'active'
      && operation.runtimeGeneration === selected.value.runtimeGeneration && operation.sessionId === selected.value.executor.piSessionId
      && !app.workDrawerOpen && !options.page().commandOpen.value && !options.page().directoryOpen.value && !options.page().hostSettingsOpen.value && !options.page().appSettingsOpen.value
      && !options.page().workspaceBrowserOpen.value && !options.page().deliveryOpen.value && !options.page().imagePreview.value && !options.page().messageTextView.value && !options.page().confirmDialog.value
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

  const queueRestoring = ref(false)
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

  const previewQueue: QueueItem[] = [{
    queueItemId: 'preview-queue-1',
    delivery: 'followUp',
    text: '请在确认桌面布局后，再检查窄屏 Queue 与附件操作。',
    attachments: [{ fileId: 'd729a77f-69f0-4f12-ac4c-2badf5750220', name: '窄屏验收清单.txt', sizeBytes: 1864, mediaType: 'text/plain', sha256: 'b'.repeat(64), storedAt: '2026-08-17T08:02:00.000Z' }],
    imageCount: 1,
    acceptedAt: '2026-08-17T08:02:00.000Z',
  }]

  const queueItems = computed(() => isTauri ? options.observation().queue.value : previewQueue)

  const visibleComposerError = computed(() => submitAttemptError.value || submissionError.value || options.actions().actionError.value || options.actions().currentCompactionError.value
    || (options.actions().nativeMutationPending.value ? '正在等待操作结果，本地编辑仍可继续。' : null))

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
    options.page().returnFocusTo(composerTextarea.value)
    options.page().closeControl()
    void nextTick(() => {
      const textarea = composerTextarea.value
      if (!textarea || extensionUi.activeRequest) return
      window.setTimeout(() => {
        if (extensionUi.activeRequest || options.page().modalOpen.value) return
        textarea.focus()
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }, 0)
    })
  }

  async function restoreQueue(): Promise<boolean> {
    const work = selected.value
    if (!work || options.pairing() || options.attachments().attachmentPicking.value || options.attachments().clearingRestoredImages.value || queueRestoring.value || submitting.value) return false
    const context = requireConnectionContext(app)
    const viewRevision = submitViewRevision
    queueRestoring.value = true
    submissionError.value = null
    clearQueueNotice()
    try {
      const result = await dequeueMessages(work.id, app.captureOperation(context, work.id))
      if (!app.contextMatches(context) || submitViewRevision !== viewRevision || selected.value?.id !== work.id || result.receipt.instanceId !== work.id || result.instance.id !== work.id) return false
      showQueueNotice(result.receipt.restored.length
        ? `已取回 ${result.receipt.restored.length} 条消息。`
        : '没有可取回的消息。')
      return true
    } catch (cause) {

      if (app.contextMatches(context) && submitViewRevision === viewRevision) submissionError.value = errorMessage(cause)
      return false
    } finally {
      queueRestoring.value = false
    }
  }

  const canSubmit = computed(() => {
    if (submittedLocalControl(draft.value)) return !!selected.value && selected.value.lifecycle === 'active'
    return app.operationResultsReady && ![...app.nativeOperations.values()].some(operation => operation.kind === 'submit_message' && operation.state === 'succeeded' && operation.connectionId === app.activeConnectionId && operation.instanceId === selected.value?.id)
      && !!selected.value && !options.observation().loading.value && options.observation().connected.value
      && !options.actions().workMutating.value && (!!draft.value.trim() || !!options.attachments().draftAttachments.value.length || !!options.attachments().restoredImageCount.value)
      && isTauri && !options.pairing() && !options.attachments().clearingRestoredImages.value && !submitBlocked.value
      && !options.actions().mutationOutcomeUnknown.value && !options.actions().nativeMutationPending.value && !queueRestoring.value && !options.attachments().attachmentPicking.value && !options.attachments().uploadDrafts.value.length
  })

  async function submit(): Promise<boolean> {
    const work = selected.value
    const captured = draft.value
    const capturedAttachments = options.attachments().draftAttachments.value.slice(0, options.attachments().maxMessageAttachments.value).map((item) => ({ ...item }))
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
    submitRequestPending.value = true
    submissionError.value = null
    try {
      const operation = app.captureOperation(capturedHost, work.id, capturedAttachments.map(item => item.fileId))
      if (!await options.attachments().verifyForSubmit(capturedAttachments)) {
        submissionError.value = '附件在当前连接中不可用，请移除后重新选择。'
        return false
      }
      if (!app.contextMatches(capturedHost) || selected.value?.id !== work.id || submitViewRevision !== viewRevision) return false
      const result = await submitMessage(work.id, captured, capturedAttachments.map(item => item.fileId), operation)
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) {
        if (!result.receipt.queued) options.activity(work.id)
      }
      return true
    } catch (cause) {
      if (app.contextMatches(capturedHost) && selected.value?.id === work.id && submitViewRevision === viewRevision) submissionError.value = errorMessage(cause)
      return false
    } finally { submitRequestPending.value = false }
  }

  async function submitExpanded() {
    const viewRevision = submitViewRevision
    const expansionRevision = composerExpansionRevision
    const attemptSequence = submitAttemptSequence
    if (await submit() && submitViewRevision === viewRevision && composerExpansionRevision === expansionRevision
      && submitAttemptSequence <= attemptSequence + 1 && !draft.value && !options.attachments().draftAttachments.value.length && !options.attachments().restoredImageCount.value) composerExpanded.value = false
  }

  async function executeLocalControl(command: LocalControlCommand, captured: string): Promise<boolean> {
    if (!selected.value || selected.value.lifecycle !== 'active') return false
    if (command.section) {
      if (draft.value === captured) draft.value = ''
      options.page().openControlCenter(command.section)
      return true
    }
    if (command.action === 'restoreQueue') {
      if (draft.value === captured) draft.value = ''
      const context = requireConnectionContext(app)
      const emptyDraft = app.captureSubmitDraft(context.connectionId, selected.value.id, [])
      const restored = await restoreQueue()
      if (!restored) app.applyReturnedDraft(emptyDraft, captured)
      return restored
    }
    if (command.action === 'stop') {
      const context = requireConnectionContext(app)
      let original: EditorCapture | undefined
      try { original = app.captureSubmitDraft(context.connectionId, selected.value.id, []) }
      catch { /* Stop must remain available; without a durable capture, keep the local command text. */ }
      const stopped = await options.actions().stopSelectedWork()
      if (stopped && original) app.completeSubmitDraft(original)
      return stopped
    }
    return false
  }

  function applyExtensionEditorText(text: string) {
    draft.value = text
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
  onScopeDispose(() => { window.clearTimeout(composerCompletionTimer); clearQueueNotice() })
  function reportError(message: string | null) { submissionError.value = message }
  return { composer, draft, composerTextarea, expandedTextarea, composerExpanded, queueRestoring, queueNotice, queueItems, submitting, submitOutcomeUnknown, submitAcknowledged, visibleComposerError, canSubmit, suggestIndex, slashQuery, suggestItems, suggestOpen, composerArgumentLoading, submit, submitExpanded, restoreQueue, allowAnotherSubmit, presentSubmitFailure, prefillSlashCommand, applyExtensionEditorText, completeSuggest, handleComposerKeydown, reportError }
}
