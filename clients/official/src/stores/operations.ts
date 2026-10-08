import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { pendingOperations, consumeOperation } from '../lib/bridge'
import { operationWork, type NativeOperation } from '../lib/operationBinding'
import { useAppStore } from './app'
import { useAttachmentsStore } from './attachments'
import { useObservationStore } from './observation'

type FailurePresenter = (operation: NativeOperation, consume: (operation: NativeOperation) => Promise<void>) => Promise<void>

/** Sole native result claimant. Awaiting a button call is only surface feedback. */
export const useOperationsStore = defineStore('operations', () => {
  const app = useAppStore()
  const observation = useObservationStore()
  const attachments = useAttachmentsStore()
  // The editor shows a failed send inline when it is still on screen; otherwise
  // the failure stays in its Work/list result entry.
  let presentFailure: FailurePresenter | null = null
  function setFailurePresenter(presenter: FailurePresenter) {
    presentFailure = presenter
    return () => { if (presentFailure === presenter) presentFailure = null }
  }
  const selected = computed(() => app.selectedWork)
  // Local application and an in-flight acknowledgement are different facts.
  // Durable editor claims cover only the pending native acknowledgement window.
  const appliedOperations = ref(new Set<string>())
  const returnedContentErrors = ref<Record<string, string>>({})
  const acknowledging = new Map<string, Promise<void>>()
  const acknowledgementErrors = ref(new Set<string>())
  const inlineFailureClaims = ref(new Set<string>())
  let operationsReady = false
  const bufferedOperations = new Map<string, NativeOperation>()
  const returnedOperations = computed(() => [...app.nativeOperations.values()].filter(operation => operation.state === 'succeeded'
    && operation.connectionId === app.activeConnectionId && operation.instanceId === selected.value?.id && operation.editor
    && !appliedOperations.value.has(operation.operationId) && hasReturnedContent(operation)))
  const visibleResults = computed(() => [...app.nativeOperations.values()].filter(operation => (operation.state === 'failed' || operation.state === 'unknown'
    || (operation.state === 'succeeded' && acknowledgementErrors.value.has(operation.operationId)))
    && !inlineFailureClaims.value.has(operation.operationId) && operation.connectionId === app.activeConnectionId
    && (!operation.hostEpoch || operation.hostEpoch === app.payload?.host.hostEpoch)))
  const workResults = computed(() => visibleResults.value.filter(operation => operation.instanceId === selected.value?.id))
  const listResults = computed(() => visibleResults.value.filter(operation => operation.instanceId === 'global'
    || !app.works.some(work => work.id === operation.instanceId)))
  // Abort takes the waiting Queue back in the same Host step as Queue retrieval.
  function returnsQueue(operation: NativeOperation) {
    return operation.kind === 'dequeue_messages' || operation.kind === 'abort_run'
  }
  function hasReturnedContent(operation: NativeOperation) {
    const result = operation.result
    if (!result) return false
    return !!('editorText' in result ? result.editorText : 'selectedText' in result ? result.selectedText : undefined)
  }
  function acknowledge(operation: NativeOperation, refreshImages = false): Promise<void> {
    const pending = acknowledging.get(operation.operationId)
    if (pending) return pending
    const attempt = (async () => {
      try {
        if (refreshImages) await attachments.refreshRestoredImageCount()
        await consumeOperation(operation.operationId)
        appliedOperations.value.add(operation.operationId)
        app.confirmAppliedOperation(operation.operationId)
        app.forgetNativeOperation(operation.operationId, operation.state)
        acknowledgementErrors.value.delete(operation.operationId)
      } catch (cause) {
        acknowledgementErrors.value.add(operation.operationId)
        throw cause
      }
    })().finally(() => { acknowledging.delete(operation.operationId) })
    acknowledging.set(operation.operationId, attempt)
    return attempt
  }
  const consumeNativeOperation = async (operation: NativeOperation) => {
    if (operation.state === 'succeeded' && !appliedOperations.value.has(operation.operationId)
      && (operation.kind === 'submit_message' || returnsQueue(operation) || returnedContentErrors.value[operation.operationId])) {
      await acceptNativeOperation(operation)
      return
    }
    await acknowledge(operation)
  }
  async function acknowledgeApplied(operation: NativeOperation) {
    try { await acknowledge(operation, true) }
    catch { /* The scoped result entry offers acknowledgement-only retry. */ }
  }
  async function acceptNativeOperation(operation: NativeOperation) {
    if (!operationsReady) { bufferedOperations.set(operation.operationId, operation); return }
    if (appliedOperations.value.has(operation.operationId)) return
    app.bindNativeOperation(operation)
    if (operation.state === 'pending') return
    if (operation.state === 'succeeded' && app.operationWasApplied(operation.operationId)) {
      appliedOperations.value.add(operation.operationId)
      await acknowledgeApplied(operation)
      return
    }
    // A terminal failure is not a UI acknowledgement. Keep it in native state
    // until the corresponding Work/list result entry is explicitly acknowledged.
    // A lost reply is the same kind of failure: nothing is checked or retried, it
    // is only told once — inline if its send is on screen, otherwise in the entry.
    if (operation.state === 'failed' || operation.state === 'unknown') {
      const presenter = presentFailure
      if (operation.kind === 'submit_message' && presenter && !inlineFailureClaims.value.has(operation.operationId)) {
        inlineFailureClaims.value.add(operation.operationId)
        try { await presenter(operation, consumeNativeOperation) }
        finally { inlineFailureClaims.value.delete(operation.operationId) }
      }
      return
    }
    const result = operation.result
    const snapshot = operationWork(operation)
    if (operation.state === 'succeeded') {
      const current = app.activeConnectionId === operation.connectionId ? app.works.find(work => work.id === operation.instanceId) : undefined
      const newerDomain = (app.activeConnectionId === operation.connectionId && !!operation.hostEpoch && app.payload?.host.hostEpoch !== operation.hostEpoch)
        || (current && snapshot && current.runtimeGeneration > snapshot.runtimeGeneration)
      if (operation.kind === 'submit_message' && operation.editor) {
        if (!newerDomain && (!current || current.executor.piSessionId === operation.sessionId)
          && app.completeSubmitDraft(operation.editor) === null) {
          acknowledgementErrors.value.add(operation.operationId)
          return
        }
      } else if (returnsQueue(operation) && result && 'receipt' in result && result.receipt && 'restored' in result.receipt) {
        observation.queueRetrieved({ ...operation, sessionId: result.instance.executor.piSessionId ?? '' }, result.receipt.restored.map(item => item.queueItemId))
        if (result.receipt.restored.length && !app.restoreOperationQueue(operation.connectionId, operation.instanceId, result.receipt.restored, operation.operationId)) {
          acknowledgementErrors.value.add(operation.operationId)
          return
        }
      } else if (result && 'instance' in result && (!('cancelled' in result) || !result.cancelled)
        && ['new_session', 'switch_session', 'reload_session', 'navigate_session', 'fork_session', 'clone_session'].includes(operation.kind) && operation.editor) {
        const returned = 'editorText' in result ? result.editorText : 'selectedText' in result ? result.selectedText : undefined
        const applied = !newerDomain && acceptEditorResult(operation, app.applyReturnedDraft(operation.editor, returned, operation.operationId))
        // Returned text stays natively claimable when later editing prevents
        // automatic restoration. Content replacement has already committed.
        if (!applied && (returned || returnedContentErrors.value[operation.operationId])) return
      }
      // A result reports this operation only. Work state comes from the Host's
      // list and from the current Work's read and live events; the Work copy in
      // a result may be older than events already shown, or outlive the Work.
      if (app.activeConnectionId === operation.connectionId && operation.kind === 'forget_work') app.removeWorkSnapshot(operation.instanceId)
    }
    appliedOperations.value.add(operation.operationId)
    await acknowledgeApplied(operation)
  }
  function acceptEditorResult(operation: NativeOperation, result: boolean | null) {
    if (result === null) {
      returnedContentErrors.value[operation.operationId] = '返回内容尚未保存。请检查本机存储后重试追加；内容仍已保留。'
      if (!hasReturnedContent(operation)) acknowledgementErrors.value.add(operation.operationId)
    }
    else delete returnedContentErrors.value[operation.operationId]
    return result === true
  }
  async function restoreReturnedOperation(operation: NativeOperation) {
    const result = operation.result
    if (!result || !operation.editor || !app.nativeOperations.has(operation.operationId)) return
    if (appliedOperations.value.has(operation.operationId)) {
      try { await consumeNativeOperation(operation) } catch { /* Keep the retry entry visible. */ }
      return
    }
    const text = 'editorText' in result ? result.editorText : 'selectedText' in result ? result.selectedText : undefined
    if (!text || !acceptEditorResult(operation, app.appendOperationText(operation.editor, text, operation.operationId))) return
    appliedOperations.value.add(operation.operationId)
    await acknowledgeApplied(operation)
  }
  async function initialize() {
    const retained = await pendingOperations()
    for (const operation of retained) if (!bufferedOperations.has(operation.operationId)) bufferedOperations.set(operation.operationId, operation)
    app.retainAppliedOperations([...bufferedOperations.keys()])
    operationsReady = true
    for (const operation of bufferedOperations.values()) await acceptNativeOperation(operation)
    bufferedOperations.clear()
    app.operationResultsReady = true
  }
  let unlisten: UnlistenFn | undefined
  let disposed = false
  async function listenNative() {
    if (unlisten) return
    const release = await listen<NativeOperation>('aludock://operation', ({ payload }) => { void acceptNativeOperation(payload) })
    if (disposed) release(); else unlisten = release
  }
  onScopeDispose(() => { disposed = true; unlisten?.() })
  return { returnedContentErrors, returnedOperations, workResults, listResults, initialize, listenNative, consumeNativeOperation, restoreReturnedOperation, setFailurePresenter }
})
