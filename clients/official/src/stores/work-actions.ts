import { defineStore } from 'pinia'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import {
  abortRun, abortShellCommands, compactSession, forgetWork, isTauri, listMachines, reopenWork, runShellCommand, sessionContext, stopWork,
  type SessionContext
} from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { subhostMachineName } from '../lib/machines'
import { conversationBoundaryKey, stopCanStart, stopConfirmationText, stoppedResultIsCorrelated } from '../lib/uiBoundaries'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ConnectionContext, MachineDto, Work } from '../lib/types'
import { mutationScopeKey, useAppStore } from './app'
import { useControlPanelStore, type ControlMutationDomain } from './control-panel'
import { useHostStore } from './host'
import { useObservationStore } from './observation'
import { useSurfacesStore } from './surfaces'
type MutationDomain = ControlMutationDomain | 'work'

/** Work buttons, the Work list and New Work, with their local feedback. Results are claimed by the operations store. */
export const useWorkActionsStore = defineStore('work-actions', () => {
  const app = useAppStore()
  const page = useSurfacesStore()
  const observation = useObservationStore()
  const panel = useControlPanelStore()
  const host = useHostStore()
  const selected = computed(() => app.selectedWork)
  let conversationSelectionRevision = 0
  watch(() => conversationBoundaryKey(app.activeConnectionId, app.connectionContext?.selectionGeneration, selected.value?.id), () => { conversationSelectionRevision++ }, { flush: 'sync' })
  const reconcilingReopenWorkId = ref('')

  const compactionWorkIds = ref<Set<string>>(new Set())
  const compactionErrors = ref<Record<string, { scope: FeedbackScope; message: string }>>({})

  const pendingWorkActions = ref(new Set<string>())
  const workMutating = computed(() => pendingWorkActions.value.has(feedbackIdentity.value))
  const pendingAborts = ref(new Set<string>())
  const aborting = computed(() => pendingAborts.value.has(feedbackIdentity.value))
  const feedbackIdentity = computed(() => JSON.stringify([app.activeConnectionId, app.connectionContext?.selectionGeneration,
    app.payload?.host.hostEpoch, selected.value?.id]))
  const sessionIdentity = computed(() => JSON.stringify([selected.value?.runtimeGeneration, selected.value?.executor.piSessionId]))
  let feedbackRevision = 0
  type FeedbackScope = Readonly<{ identity: string; revision: number; session?: string }>
  // A notice reports a state (waiting, unconfirmed, partly done); an error reports a failed action.
  type FeedbackTone = 'error' | 'notice'
  const feedback = ref<{ scope: FeedbackScope; message: string | null; tone: FeedbackTone } | null>(null)
  function captureFeedback(session = true): FeedbackScope {
    return Object.freeze({ identity: feedbackIdentity.value, revision: feedbackRevision, session: session ? sessionIdentity.value : undefined })
  }
  function feedbackMatches(scope: FeedbackScope) {
    return scope.identity === feedbackIdentity.value && scope.revision === feedbackRevision
      && (scope.session === undefined || scope.session === sessionIdentity.value)
  }
  function reportAction(scope: FeedbackScope, message: string | null, tone: FeedbackTone = 'error') {
    if (feedbackMatches(scope)) feedback.value = { scope, message, tone }
  }
  function outcomeUnknown(cause: unknown) {
    return !!cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true
  }
  // A result that may still have happened is not shown as a failure.
  function reportFailure(scope: FeedbackScope, cause: unknown) {
    reportAction(scope, errorMessage(cause), outcomeUnknown(cause) ? 'notice' : 'error')
  }
  const currentFeedback = computed(() => feedback.value && feedbackMatches(feedback.value.scope) ? feedback.value : null)
  const actionError = computed(() => currentFeedback.value?.tone === 'error' ? currentFeedback.value.message : null)
  const actionNotice = computed(() => currentFeedback.value?.tone === 'notice' ? currentFeedback.value.message : null)
  watch(feedbackIdentity, () => { feedbackRevision++; feedback.value = null; reconcilingReopenWorkId.value = '' }, { flush: 'sync' })
  const continuedUnknowns = ref(new Set<string>())
  const unresolvedMutations = computed(() => new Map([...app.unresolvedMutations].filter(([, id]) => !continuedUnknowns.value.has(id))))

  // An unconfirmed result is reported and can be refreshed; it does not lock other actions.
  // It is shown where it belongs: a Work's own results on that Work; New Work,
  // saved-Session adoption and directory defaults ('global') in the Work list
  // and the New Work dialog, not on every Work of the Host.
  function unresolvedDomainsFor(workId: string) {
    const domains = new Set<MutationDomain>()
    for (const key of unresolvedMutations.value.keys()) {
      const [connectionId, keyWorkId, domain] = JSON.parse(key) as [string, string, MutationDomain]
      if (connectionId === (app.activeConnectionId ?? '') && keyWorkId === workId) domains.add(domain)
    }
    return domains
  }
  const unresolvedDomains = computed(() => unresolvedDomainsFor(selected.value?.id ?? 'global'))
  const unresolvedDomain = computed<MutationDomain | null>(() => unresolvedDomains.value.values().next().value ?? null)
  const mutationOutcomeUnknown = computed(() => unresolvedDomain.value !== null)
  const globalOutcomeUnknown = computed(() => unresolvedDomainsFor('global').has('work'))
  const unresolvedControlDomain = computed<ControlMutationDomain | undefined>(() =>
    [...unresolvedDomains.value].find((domain): domain is ControlMutationDomain => domain !== 'work'))
  const globalReconcileMessage = ref('')
  const globalReconciling = ref(false)

  const selectedCompactionPending = computed(() => !!selected.value && compactionWorkIds.value.has(selected.value.id))
  const currentCompactionError = computed(() => {
    const connectionId = app.activeConnectionId
    const workId = selected.value?.id
    const entry = connectionId && workId ? compactionErrors.value[compactionErrorKey(connectionId, workId)] : undefined
    return entry && feedbackMatches(entry.scope) ? entry.message : null
  })

  /** One Host step stops the reply and returns the waiting Queue to the editor. */
  async function abortCurrentRun() {
    const work = selected.value
    if (!work || work.execution !== 'running' || aborting.value) return
    const feedbackScope = captureFeedback()
    const capturedHost = requireConnectionContext(app)
    pendingAborts.value.add(feedbackScope.identity)
    reportAction(feedbackScope, null)
    try {
      const result = await abortRun(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return
      const returned = result.receipt.restored.length
      const kept = result.receipt.inFlight.length
      if (kept) {
        reportAction(feedbackScope, `已中止。${returned ? `${returned} 条排队消息已放回输入框；` : ''}另有 ${kept} 条已经交给 Agent，会留在对话里。`, 'notice')
      } else if (returned) {
        reportAction(feedbackScope, `已中止，${returned} 条排队消息已放回输入框。`, 'notice')
      }
    } catch (cause) {
      reportFailure(feedbackScope, cause)
    } finally {
      pendingAborts.value.delete(feedbackScope.identity)
    }
  }

  // ── Workspace shell commands (Pi `!` / `!!`) ──
  // The receipt only says the command started; its output and completion are
  // conversation events, so the rows live in the conversation projection and
  // survive closing the workspace panel.
  const pendingShellStarts = ref(new Set<string>())
  const shellStarting = computed(() => pendingShellStarts.value.has(feedbackIdentity.value))
  const pendingShellAborts = ref(new Set<string>())
  const shellAborting = computed(() => pendingShellAborts.value.has(feedbackIdentity.value))
  const shellFeedback = ref<{ scope: FeedbackScope; message: string; tone: FeedbackTone } | null>(null)
  const shellError = computed(() => shellFeedback.value && feedbackMatches(shellFeedback.value.scope) ? shellFeedback.value : null)
  function reportShell(scope: FeedbackScope, message: string | null, tone: FeedbackTone = 'error') {
    if (feedbackMatches(scope)) shellFeedback.value = message === null ? null : { scope, message, tone }
  }

  /** Returns true once the Host says the command started. */
  async function runShell(command: string, excludeFromContext: boolean): Promise<boolean> {
    const work = selected.value
    if (!work || work.lifecycle !== 'active' || shellStarting.value || !command.trim()) return false
    const feedbackScope = captureFeedback()
    const capturedHost = requireConnectionContext(app)
    pendingShellStarts.value.add(feedbackScope.identity)
    reportShell(feedbackScope, null)
    try {
      await runShellCommand(work.id, command, excludeFromContext, app.captureOperationTarget(capturedHost, work.id))
      return app.contextMatches(capturedHost)
    } catch (cause) {
      if (app.contextMatches(capturedHost)) {
        reportShell(feedbackScope, outcomeUnknown(cause)
          ? '还无法确认命令是否已经开始执行。等一下看对话里有没有它的运行行；再次运行可能会执行两次。'
          : errorMessage(cause, '命令没有开始执行。请检查连接后重试。'), outcomeUnknown(cause) ? 'notice' : 'error')
      }
      return false
    } finally {
      pendingShellStarts.value.delete(feedbackScope.identity)
    }
  }

  /** Pi stops every running shell command of the Work at once; each one then reports its own end. */
  async function abortShell() {
    const work = selected.value
    if (!work || work.lifecycle !== 'active' || shellAborting.value) return
    const feedbackScope = captureFeedback()
    const capturedHost = requireConnectionContext(app)
    pendingShellAborts.value.add(feedbackScope.identity)
    reportShell(feedbackScope, null)
    try {
      await abortShellCommands(work.id, app.captureOperationTarget(capturedHost, work.id))
    } catch (cause) {
      if (app.contextMatches(capturedHost)) {
        reportShell(feedbackScope, outcomeUnknown(cause)
          ? '还无法确认停止请求是否送到。看对话里的运行行是否已结束；必要时再点一次。'
          : errorMessage(cause, '没有停下正在运行的命令。请重试。'), outcomeUnknown(cause) ? 'notice' : 'error')
      }
    } finally {
      pendingShellAborts.value.delete(feedbackScope.identity)
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
        : null, 'notice')
      return true
    } catch (cause) {

      reportFailure(feedbackScope, cause)
      return false
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  async function reopenSelectedWork() {
    const work = selected.value
    if (!isTauri || !work || !work.reopenable || workMutating.value) return
    const capturedHost = requireConnectionContext(app)
    const previousGeneration = work.runtimeGeneration
    const feedbackScope = captureFeedback(false)
    pendingWorkActions.value.add(feedbackScope.identity)
    reportAction(feedbackScope, null)
    try {
      await reopenWork(work.id, app.captureOperationTarget(capturedHost, work.id))
      if (!app.contextMatches(capturedHost)) return
      void observation.load(work.id, true)
    } catch (cause) {
      if (!feedbackMatches(feedbackScope)) return
      const failure = cause as { code?: string; message?: string; details?: Record<string, unknown>; operationId?: string; outcomeUnknown?: boolean }
      if (failure?.code === 'project_trust_required') {
        // TODO (#304): Reopen's project-trust confirmation UI was never wired up. Keep
        // the native known-failure result visible; never infer a trust decision.
        reportFailure(feedbackScope, cause)
      } else if (failure?.outcomeUnknown === true) {

        reconcilingReopenWorkId.value = work.id
        reportAction(feedbackScope, 'Dock 已收到继续请求，正在确认 Work 的实际状态…', 'notice')
        void reconcileReopenOutcome(work.id, previousGeneration, capturedHost, feedbackScope)
      } else {
        reportFailure(feedbackScope, cause)
      }
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  async function reconcileReopenOutcome(workId: string, previousGeneration: number, context: ConnectionContext, feedbackScope: FeedbackScope) {
    if (!await app.refreshWorksQuietly() || !app.contextMatches(context)) {
      reportAction(feedbackScope, '暂时无法确认 Work 的实际状态；连接恢复后会继续以 Dock 状态为准。', 'notice')
      return
    }
    if (!feedbackMatches(feedbackScope)) return
    const current = app.works.find((work) => work.id === workId)
    if (!current || current.lifecycle !== 'active' || current.runtimeGeneration <= previousGeneration) {
      reportAction(feedbackScope, '还无法确认 Work 是否已继续。请刷新状态后确认，不要重复操作。', 'notice')
      return
    }
    reportAction(feedbackScope, '当前 Work 状态已更新，原操作结果仍待确认。请勿重复提交。', 'notice')
    reconcilingReopenWorkId.value = ''
    observation.acceptWork(current, context)
    void observation.load(workId, true)
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

      reportFailure(feedbackScope, cause)
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
    if (!isTauri || !work || compactionWorkIds.value.has(work.id) || work.compacting) return
    const capturedHost = requireConnectionContext(app)
    const scope = sessionContext(capturedHost, work)
    const feedbackScope = captureFeedback()
    page.closeModal()
    setCompactionPending(work.id, true)
    setCompactionError(capturedHost.connectionId, work.id)
    reportAction(feedbackScope, null)
    try {
      await compactSession(app.captureOperationTarget(scope, work.id), customInstructions?.trim() || undefined, crypto.randomUUID())
    } catch (cause) {
      reportFailure(feedbackScope, cause)
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
      const followed = observation.active
      const matchingFollow = observation.connected
        && followed?.connectionId === capturedHost.connectionId
        && followed.selectionGeneration === capturedHost.selectionGeneration
        && followed.instanceId === work.id
      const reportedByConversation = matchingFollow
        && ['compaction_cancelled', 'compaction_not_needed', 'compaction_failed'].includes(code)
      if (feedbackMatches(feedbackScope) && !reportedByConversation && !outcomeUnknown(cause)) setCompactionError(capturedHost.connectionId, work.id, errorMessage(cause))
    } finally {
      setCompactionPending(work.id, false)
    }
  }

  function handleNewWorkUnknown(cause: unknown) { reportAction(captureFeedback(), errorMessage(cause), 'notice') }
  function mutationKey(workId: string, domain: MutationDomain) {
    return mutationScopeKey(app.activeConnectionId ?? '', workId, domain)
  }
  function markControlUnknown(cause: unknown, _domain: ControlMutationDomain, scope: SessionContext) {
    if (app.contextMatches(scope) && scope.instanceId === selected.value?.id
      && scope.expectedHostEpoch === selected.value.ownerHostEpoch && scope.expectedRuntimeGeneration === selected.value.runtimeGeneration) {
      reportAction(captureFeedback(), errorMessage(cause), 'notice')
    }
  }

  /** The Work list's check of an unconfirmed New Work: refresh the list and report there. */
  async function reconcileGlobalOutcome() {
    const unknownId = unresolvedMutations.value.get(mutationKey('global', 'work'))
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!unknownId || !context || globalReconciling.value) return
    globalReconciling.value = true
    globalReconcileMessage.value = ''
    try {
      const refreshed = await app.loadActive()
      if (!app.contextMatches(context)) return
      if (!refreshed || app.error) {
        globalReconcileMessage.value = '暂时无法刷新工作列表。请稍后再试，不要重复创建。'
        return
      }
      continuedUnknowns.value.add(unknownId)
      globalReconcileMessage.value = '工作列表已刷新。如果新建的 Work 没有出现，它的结果仍未确认，不要重复创建。'
    } finally {
      globalReconciling.value = false
    }
  }
  watch([() => app.activeConnectionId, () => app.workDrawerOpen], () => { globalReconcileMessage.value = '' })

  async function reconcileMutationOutcome(requestedDomain?: MutationDomain) {
    const workId = selected.value?.id ?? 'global'
    const context = app.connectionContext ? { ...app.connectionContext } : null
    const revision = conversationSelectionRevision
    const feedbackScope = captureFeedback()
    const isCurrent = () => !!context && app.contextMatches(context) && revision === conversationSelectionRevision && feedbackMatches(feedbackScope)
    const domain = requestedDomain ?? unresolvedDomain.value
    if (!domain) return
    const unknownId = unresolvedMutations.value.get(mutationKey(workId, domain))
    if (!unknownId) return
    try {
      let reconciled = false
      if (domain === 'conversation' && workId !== 'global') {
        reconciled = await observation.load(workId)
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
        const conversation = await observation.load(workId, true)
        reconciled = projection && conversation && !app.error
      } else if (domain === 'work') {
        reconciled = await app.loadActive()
        if (!isCurrent()) return
        reconciled = reconciled && !app.error
      }
      if (!isCurrent()) return
      if (!reconciled) throw new Error('还无法确认刚才的修改是否生效。请再次刷新确认，不要重复提交。')
      continuedUnknowns.value.add(unknownId)
      reportAction(feedbackScope, '当前状态已刷新。刚才那次操作的结果仍未确认，不要重复提交它。', 'notice')
      if (domain === 'sessions' && workId !== 'global' && app.activeConnectionId) setCompactionError(app.activeConnectionId, workId)
    } catch (cause) {
      if (!isCurrent()) return
      reportAction(feedbackScope, errorMessage(cause), 'notice')
    }
  }

  function reconcileControlProjection(domain: ControlMutationDomain, workId: string): Promise<boolean> {
    return selected.value?.id === workId ? panel.reconcileDomain(domain) : Promise.resolve(false)
  }

  // A compaction event reported by the conversation replaces this button's earlier failure.
  onScopeDispose(observation.onCompactionSettled((connectionId, instanceId) => setCompactionError(connectionId, instanceId)))

  // ── Work list and New Work ───────────────────────────────────────────
  const hostMachines = ref<MachineDto[]>([])
  const machineListError = ref('')
  const newWorkMachinesLoading = ref(false)
  const machineSettingsLoading = ref(false)
  const newWorkCompact = ref(true)
  let machineLoadEpoch = 0

  watch(() => Boolean(app.payload && !app.needsPairing && !selected.value), (showList) => {
    if (showList) app.workDrawerOpen = true
  })
  watch(() => app.workDrawerOpen, (open, wasOpen) => {
    if (open) {
      page.closeWorkPanels()
    }
    if (open && !wasOpen) {
      void app.refreshWorksQuietly()
      void refreshHostMachinesQuietly()
    }
  })
  watch(
    () => [app.activeConnectionId, app.connectionContext?.selectionGeneration] as const,
    () => {
      ++machineLoadEpoch
      hostMachines.value = []
      page.closeDirectory()
      machineListError.value = ''
      if (app.workDrawerOpen) void refreshHostMachinesQuietly()
    },
  )

  function workGroup(work: Work) {
    // A lifecycle only a newer Host knows is not history: it stays visible, without a 移除 that cannot act (#356).
    if (work.lifecycle === 'active' || work.lifecycle === 'stopping' || work.lifecycle === 'unrecognized') return 'current'
    if (work.reopenable) return 'continue'
    return 'history'
  }

  const groupedWorks = computed(() => ({
    current: app.works.filter((work) => workGroup(work) === 'current'),
    continue: app.works.filter((work) => workGroup(work) === 'continue'),
    history: app.works.filter((work) => workGroup(work) === 'history'),
  }))

  function workMachineTag(work: Work) {
    return subhostMachineName(hostMachines.value, work.hostId)
  }

  function selectWork(workId: string) {
    if (workId === selected.value?.id) {
      app.workDrawerOpen = false
      return
    }
    app.selectWork(workId)
  }

  async function reopenFromList(work: Work) {
    app.selectWork(work.id)
    await reopenSelectedWork()
  }

  async function forgetFromList(work: Work) {
    app.selectWork(work.id)
    await forgetSelectedWork()
  }

  async function loadHostMachines() {
    const epoch = ++machineLoadEpoch
    const machines = await currentConnectionCall(app, (context) => listMachines(context))
    if (epoch === machineLoadEpoch) {
      hostMachines.value = machines
      machineListError.value = ''
    }
    return machines
  }

  async function refreshHostMachinesQuietly() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    try {
      await loadHostMachines()
    } catch {
      if (context && app.contextMatches(context)) machineListError.value = '机器信息暂时没有载入。刷新后重试。'
    }
  }

  async function refreshWorkDrawer() {
    await app.load()
    await refreshHostMachinesQuietly()
  }

  async function openDirectory() {
    if (host.pairingInProgress) return
    page.openDirectory()
    newWorkMachinesLoading.value = true
    page.directoryBusy = false
    newWorkCompact.value = true
    machineListError.value = ''
    try {
      await loadHostMachines()
    } catch (cause) {
      if (page.directoryOpen) machineListError.value = errorMessage(cause, '无法读取可用机器，请检查连接后重试。')
    } finally {
      newWorkMachinesLoading.value = false
    }
  }

  /** Host 设置 lists the Dock's machines; without a machine list it manages the connected Host itself. */
  async function openMachineSettings(hostId?: string) {
    if (host.pairingInProgress) return
    page.openMachineSettings(hostId)
    machineSettingsLoading.value = true
    machineListError.value = ''
    try {
      await loadHostMachines()
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : ''
      if (page.machineSettingsOpen && code !== 'capability_missing') machineListError.value = errorMessage(cause, '无法读取可用机器，请检查连接后重试。')
    } finally {
      machineSettingsLoading.value = false
    }
  }

  function acceptCreatedWork(work: Work) {
    page.directoryBusy = false
    const machine = work.hostId ? hostMachines.value.find((candidate) => candidate.hostId === work.hostId) : undefined
    if (machine && work.hostId) app.rememberCreatedWorkspace(work.hostId, work.cwd, machine.platform)
    observation.acceptWork(work)
    app.selectWork(work.id)
    void app.refreshWorksQuietly()
    page.closeDirectory()
  }

  return {
    aborting, workMutating, actionError, actionNotice, mutationOutcomeUnknown, globalOutcomeUnknown, globalReconciling, globalReconcileMessage, reconcileGlobalOutcome, unresolvedControlDomain, selectedCompactionPending, currentCompactionError, reconcilingReopenWorkId,
    abortCurrentRun, stopSelectedWork, reopenSelectedWork, forgetSelectedWork, setCompactionError, startCompaction, handleNewWorkUnknown, markControlUnknown, reconcileMutationOutcome,
    shellStarting, shellAborting, shellError, runShell, abortShell,
    hostMachines, machineListError, newWorkMachinesLoading, machineSettingsLoading, newWorkCompact, groupedWorks, workMachineTag, selectWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory, openMachineSettings, acceptCreatedWork,
  }
})
