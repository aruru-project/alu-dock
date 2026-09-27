import type { ReadonlyRefs } from './ownerView'
import { computed, nextTick, ref, watch } from 'vue'
import {
  abortRun, compactSession, forgetWork, getSettings, isTauri, listModels, listSessions, listTools, loadSessionTree, reopenWork, stopWork,
  type SessionContext
} from './bridge'
import { currentConnectionCall, requireConnectionContext } from './hostResult'
import { conversationBoundaryKey, stopCanStart, stopConfirmationText, stoppedResultIsCorrelated } from './uiBoundaries'
import { userErrorMessage as errorMessage } from './userError'
import type { ConnectionContext, ProjectedEvent } from './types'
import type { ControlMutationDomain } from '../components/ControlCenter.vue'
import type { usePageSurfaces } from './pageSurfaces'
import type { useWorkObservation } from './workObservation'
import { mutationScopeKey, useAppStore } from '../stores/app'
type MutationDomain = ControlMutationDomain | 'work'
export type ControlCenterHandle = {
  reconcileDomain: (domain: ControlMutationDomain) => Promise<boolean>
  applyLiveEvent: (event: ProjectedEvent) => void
}

/** Work buttons and their local feedback. Results are claimed by operationResults. */
export function useWorkActions(page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'askConfirm' | 'closeModal'>>, options: {
  observation(): ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'load' | 'active' | 'connected' | 'acceptWork'>>
  restoreQueue(): Promise<boolean>
  panel(): Pick<ControlCenterHandle, 'reconcileDomain'> | null
}) {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  let conversationSelectionRevision = 0
  watch(() => conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id), () => { conversationSelectionRevision++ }, { flush: 'sync' })
  const reconcilingReopenWorkId = ref('')

  const aborting = ref(false)
  const compactionWorkIds = ref<Set<string>>(new Set())
  const compactionErrors = ref<Record<string, { scope: FeedbackScope; message: string }>>({})

  const pendingWorkActions = ref(new Set<string>())
  const workMutating = computed(() => pendingWorkActions.value.has(feedbackIdentity.value))
  const feedbackIdentity = computed(() => JSON.stringify([app.activeConnectionId, app.connectionContext?.selectionGeneration,
    app.payload?.host.hostEpoch, selected.value?.id]))
  const sessionIdentity = computed(() => JSON.stringify([selected.value?.runtimeGeneration, selected.value?.executor.piSessionId]))
  let feedbackRevision = 0
  type FeedbackScope = Readonly<{ identity: string; revision: number; session?: string }>
  const feedback = ref<{ scope: FeedbackScope; message: string | null } | null>(null)
  function captureFeedback(session = true): FeedbackScope {
    return Object.freeze({ identity: feedbackIdentity.value, revision: feedbackRevision, session: session ? sessionIdentity.value : undefined })
  }
  function feedbackMatches(scope: FeedbackScope) {
    return scope.identity === feedbackIdentity.value && scope.revision === feedbackRevision
      && (scope.session === undefined || scope.session === sessionIdentity.value)
  }
  function reportAction(scope: FeedbackScope, message: string | null) {
    if (feedbackMatches(scope)) feedback.value = { scope, message }
  }
  const actionError = computed(() => feedback.value && feedbackMatches(feedback.value.scope) ? feedback.value.message : null)
  watch(feedbackIdentity, () => { feedbackRevision++; feedback.value = null; reconcilingReopenWorkId.value = '' }, { flush: 'sync' })
  const continuedUnknowns = ref(new Set<string>())
  const unresolvedMutations = computed(() => new Map([...app.unresolvedMutations].filter(([, id]) => !continuedUnknowns.value.has(id))))

  const mutationOutcomeUnknown = computed(() => unresolvedDomain.value !== null)
  const unresolvedDomain = computed<MutationDomain | null>(() => {
    const workId = selected.value?.id ?? 'global'
    for (const key of unresolvedMutations.value.keys()) {
      const [connectionId, keyWorkId, domain] = JSON.parse(key) as [string, string, MutationDomain]
      if (connectionId === (app.activeConnectionId ?? '') && (keyWorkId === workId || keyWorkId === 'global')) return domain
    }
    return null
  })
  const unresolvedControlDomain = computed<ControlMutationDomain | undefined>(() => {
    const domain = unresolvedDomain.value
    return domain && domain !== 'work' ? domain : undefined
  })

  const selectedCompactionPending = computed(() => !!selected.value && compactionWorkIds.value.has(selected.value.id))
  const currentCompactionError = computed(() => {
    const connectionId = app.activeConnectionId
    const workId = selected.value?.id
    const entry = connectionId && workId ? compactionErrors.value[compactionErrorKey(connectionId, workId)] : undefined
    return entry && feedbackMatches(entry.scope) ? entry.message : null
  })

  async function abortCurrentRun() {
    const work = selected.value
    if (!work || work.execution !== 'running' || aborting.value || workMutating.value) return
    const feedbackScope = captureFeedback()
    const capturedHost = requireConnectionContext(app)
    if (work.pending.total > 0 && !await options.restoreQueue()) return
    if (!feedbackMatches(feedbackScope)) return
    aborting.value = true
    reportAction(feedbackScope, null)
    try {
      await abortRun(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return
    } catch (cause) {

      reportAction(feedbackScope, errorMessage(cause))
    } finally {
      aborting.value = false
    }
  }

  async function stopSelectedWork(): Promise<boolean> {
    const work = selected.value
    const capturedHost = app.connectionContext
    if (!isTauri || !capturedHost || !stopCanStart(work, workMutating.value) || !work) return false
    const feedbackScope = captureFeedback(false)
    if (!await page.askConfirm('停止当前工作？', stopConfirmationText(work))) return false
    if (!feedbackMatches(feedbackScope) || !app.contextMatches(capturedHost) || selected.value?.id !== work.id || selected.value.lifecycle !== 'active') return false
    pendingWorkActions.value.add(feedbackScope.identity)
    reportAction(feedbackScope, null)
    try {
      const result = await stopWork(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return false
      if (!stoppedResultIsCorrelated(result, work.id)) throw { outcomeUnknown: true, message: '停止结果没有证明对应 Work 已停止。' }
      const cleanupErrors = result.receipt.cleanupErrors ?? []
      reportAction(feedbackScope, cleanupErrors.length
        ? 'Work 已停止，但相关内容可能仍在更新。请刷新后确认当前状态。'
        : null)
      return true
    } catch (cause) {

      reportAction(feedbackScope, errorMessage(cause))
      return false
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  async function reopenSelectedWork() {
    const work = selected.value
    if (!isTauri || !work || !work.reopenable || workMutating.value || mutationOutcomeUnknown.value) return
    const capturedHost = requireConnectionContext(app)
    const previousGeneration = work.runtimeGeneration
    const feedbackScope = captureFeedback(false)
    pendingWorkActions.value.add(feedbackScope.identity)
    reportAction(feedbackScope, null)
    try {
      await reopenWork(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return
      void options.observation().load(work.id, true)
    } catch (cause) {
      if (!feedbackMatches(feedbackScope)) return
      const failure = cause as { code?: string; message?: string; details?: Record<string, unknown>; operationId?: string; outcomeUnknown?: boolean }
      if (failure?.code === 'project_trust_required') {
        // TODO (#304): Reopen's project-trust confirmation UI was never wired up. Keep
        // the native known-failure result visible; never infer a trust decision.
        reportAction(feedbackScope, errorMessage(cause))
      } else if (failure?.outcomeUnknown === true) {

        reconcilingReopenWorkId.value = work.id
        reportAction(feedbackScope, 'Dock 已收到继续请求，正在确认 Work 的实际状态…')
        void reconcileReopenOutcome(work.id, previousGeneration, capturedHost, feedbackScope)
      } else {
        reportAction(feedbackScope, errorMessage(cause))
      }
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  async function reconcileReopenOutcome(workId: string, previousGeneration: number, context: ConnectionContext, feedbackScope: FeedbackScope) {
    if (!await app.refreshWorksQuietly() || !app.contextMatches(context)) {
      reportAction(feedbackScope, '暂时无法确认 Work 的实际状态；连接恢复后会继续以 Dock 状态为准。')
      return
    }
    if (!feedbackMatches(feedbackScope)) return
    const current = app.works.find((work) => work.id === workId)
    if (!current || current.lifecycle !== 'active' || current.runtimeGeneration <= previousGeneration) {
      reportAction(feedbackScope, '还无法确认 Work 是否已继续。请刷新状态后确认，不要重复操作。')
      return
    }
    reportAction(feedbackScope, '当前 Work 状态已更新，原操作结果仍待确认。请勿重复提交。')
    reconcilingReopenWorkId.value = ''
    options.observation().acceptWork(current, context)
    void options.observation().load(workId, true)
  }

  async function forgetSelectedWork() {
    const work = selected.value
    if (!isTauri || !work || !['stopped', 'host_lost', 'runtime_error'].includes(work.lifecycle) || workMutating.value) return
    const capturedHost = requireConnectionContext(app)
    const feedbackScope = captureFeedback(false)
    if (!await page.askConfirm('从列表移除这条历史记录？')) return
    if (!feedbackMatches(feedbackScope)) return
    pendingWorkActions.value.add(feedbackScope.identity)
    reportAction(feedbackScope, null)
    try {
      await forgetWork(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return
      void app.refreshWorksQuietly()
    } catch (cause) {

      reportAction(feedbackScope, errorMessage(cause))
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  function compactionErrorKey(connectionId: string, workId: string) {
    return JSON.stringify([connectionId, workId])
  }

  function setCompactionError(connectionId: string, workId: string, message?: string) {
    const key = compactionErrorKey(connectionId, workId)
    const next = { ...compactionErrors.value }
    if (message) next[key] = { scope: captureFeedback(), message }
    else delete next[key]
    compactionErrors.value = next
  }

  function setCompactionPending(workId: string, pending: boolean) {
    const next = new Set(compactionWorkIds.value)
    if (pending) next.add(workId)
    else next.delete(workId)
    compactionWorkIds.value = next
  }

  async function startCompaction(customInstructions?: string) {
    const work = selected.value
    if (!isTauri || !work || mutationOutcomeUnknown.value || compactionWorkIds.value.has(work.id) || work.compacting) return
    const capturedHost = requireConnectionContext(app)
    const scope: SessionContext = {
      ...capturedHost,
      instanceId: work.id,
      expectedHostEpoch: work.ownerHostEpoch ?? '',
      expectedRuntimeGeneration: work.runtimeGeneration,
    }
    const feedbackScope = captureFeedback()
    page.closeModal()
    setCompactionPending(work.id, true)
    setCompactionError(capturedHost.connectionId, work.id)
    reportAction(feedbackScope, null)
    try {
      await compactSession(app.captureOperationTarget(scope, work.id), customInstructions?.trim() || undefined, crypto.randomUUID())
    } catch (cause) {
      reportAction(feedbackScope, errorMessage(cause))
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
      const followed = options.observation().active.value
      const matchingFollow = options.observation().connected.value
        && followed?.connectionId === capturedHost.connectionId
        && followed.selectionGeneration === capturedHost.selectionGeneration
        && followed.instanceId === work.id
      const reportedByConversation = matchingFollow
        && ['compaction_cancelled', 'compaction_not_needed', 'compaction_failed'].includes(code)
      if (feedbackMatches(feedbackScope) && !reportedByConversation) setCompactionError(capturedHost.connectionId, work.id, errorMessage(cause))
    } finally {
      setCompactionPending(work.id, false)
    }
  }

  function handleNewWorkUnknown(cause: unknown) { reportAction(captureFeedback(), errorMessage(cause)) }
  function mutationKey(workId: string, domain: MutationDomain) {
    return mutationScopeKey(app.activeConnectionId ?? '', workId, domain)
  }
  function markControlUnknown(cause: unknown, _domain: ControlMutationDomain, scope: SessionContext) {
    if (app.contextMatches(scope) && scope.instanceId === selected.value?.id
      && scope.expectedHostEpoch === selected.value.ownerHostEpoch && scope.expectedRuntimeGeneration === selected.value.runtimeGeneration) {
      reportAction(captureFeedback(), errorMessage(cause))
    }
  }

  async function reconcileMutationOutcome(requestedDomain?: MutationDomain) {
    const workId = selected.value?.id ?? 'global'
    const context = app.connectionContext ? { ...app.connectionContext } : null
    const revision = conversationSelectionRevision
    const feedbackScope = captureFeedback()
    const isCurrent = () => !!context && app.contextMatches(context) && revision === conversationSelectionRevision && feedbackMatches(feedbackScope)
    const domain = requestedDomain ?? unresolvedDomain.value
    if (!domain) return
    const selectedKey = mutationKey(workId, domain)
    const globalKey = mutationKey('global', domain)
    const key = unresolvedMutations.value.has(selectedKey) ? selectedKey : globalKey
    const unknownId = unresolvedMutations.value.get(key)
    if (!unknownId) return
    try {
      let reconciled = false
      if (domain === 'conversation' && workId !== 'global') {
        reconciled = await options.observation().load(workId)
      } else if (domain === 'models' && workId !== 'global') {
        reconciled = await reconcileControlProjection('models', workId)
      } else if (domain === 'tools' && workId !== 'global') {
        reconciled = await reconcileControlProjection('tools', workId)
      } else if (domain === 'settings' && workId !== 'global') {
        reconciled = await reconcileControlProjection('settings', workId)
      } else if ((domain === 'sessions' || domain === 'tree') && workId !== 'global') {
        const refreshed = await app.loadActive()
        if (!isCurrent()) return
        if (!refreshed || app.error || selected.value?.id !== workId) throw new Error('暂时无法确认修改后的 Work 状态，请稍后重试。')
        if (domain === 'sessions' && selected.value?.compacting) throw new Error('上下文仍在压缩；完成后再刷新确认。')
        await nextTick()
        if (!isCurrent()) return
        const projection = await reconcileControlProjection(domain, workId)
        if (!isCurrent()) return
        const conversation = await options.observation().load(workId, true)
        reconciled = projection && conversation && !app.error
      } else if (domain === 'work') {
        reconciled = await app.loadActive()
        if (!isCurrent()) return
        reconciled = reconciled && !app.error
      }
      if (!isCurrent()) return
      if (!reconciled) throw new Error('还无法确认刚才的修改是否生效。请再次刷新确认，不要重复提交。')
      continuedUnknowns.value.add(unknownId)
      reportAction(feedbackScope, '当前状态已更新，可以开始新的操作。刚才的结果仍未确认，请勿重复提交原操作。')
      if (domain === 'sessions' && workId !== 'global' && app.activeConnectionId) setCompactionError(app.activeConnectionId, workId)
    } catch (cause) {
      if (!isCurrent()) return
      reportAction(feedbackScope, errorMessage(cause))
    }
  }

  async function reconcileControlProjection(domain: ControlMutationDomain, workId: string): Promise<boolean> {
    const panel = options.panel()
    if (panel && domain !== 'conversation') return panel.reconcileDomain(domain)
    if (domain === 'models') {
      const result = await currentConnectionCall(app, (context) => listModels(workId, context))
      options.observation().acceptWork(result.instance)
      return true
    }
    if (domain === 'tools') {
      const result = await currentConnectionCall(app, (context) => listTools(workId, context))
      options.observation().acceptWork(result.instance)
      return true
    }
    if (domain === 'settings') {
      await currentConnectionCall(app, (context) => getSettings(workId, context))
      return true
    }
    if (domain === 'sessions' || domain === 'tree') {
      const work = app.works.find((item) => item.id === workId)
      if (!work) return false
      const sessionContext = (context: ConnectionContext): SessionContext => ({
        ...context,
        instanceId: work.id,
        expectedHostEpoch: work.ownerHostEpoch ?? '',
        expectedRuntimeGeneration: work.runtimeGeneration,
      })
      if (domain === 'sessions') await currentConnectionCall(app, (context) => listSessions(sessionContext(context), 'cwd'))
      else await currentConnectionCall(app, (context) => loadSessionTree(sessionContext(context)))
      return true
    }
    return false
  }

  return { aborting, workMutating, actionError, mutationOutcomeUnknown, unresolvedControlDomain, selectedCompactionPending, currentCompactionError, reconcilingReopenWorkId, abortCurrentRun, stopSelectedWork, reopenSelectedWork, forgetSelectedWork, setCompactionError, startCompaction, handleNewWorkUnknown, markControlUnknown, reconcileMutationOutcome }
}
