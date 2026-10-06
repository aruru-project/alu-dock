import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import {
  abortRun, abortShellCommands, compactSession, forgetWork, isTauri, listMachines, reopenWork, runShellCommand, sessionContext, stopWork,
} from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { subhostMachineName } from '../lib/machines'
import { stopCanStart, stopConfirmationText, stoppedResultIsCorrelated } from '../lib/uiBoundaries'
import { userErrorMessage as errorMessage } from '../lib/userError'
import type { ConnectionContext, MachineDto, Work } from '../lib/types'
import { useAppStore } from './app'
import { useHostStore } from './host'
import { useObservationStore } from './observation'
import { useSurfacesStore } from './surfaces'

/** Work buttons, the Work list and New Work, with their local feedback. Results are claimed by the operations store. */
export const useWorkActionsStore = defineStore('work-actions', () => {
  const app = useAppStore()
  const page = useSurfacesStore()
  const observation = useObservationStore()
  const host = useHostStore()
  const selected = computed(() => app.selectedWork)

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
  // A notice reports a state (waiting, partly done); an error reports a failed action.
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
  // A lost reply is reported once like any failure; the conversation and Work state show what happened.
  function reportFailure(scope: FeedbackScope, cause: unknown) {
    reportAction(scope, errorMessage(cause))
  }
  const currentFeedback = computed(() => feedback.value && feedbackMatches(feedback.value.scope) ? feedback.value : null)
  const actionError = computed(() => currentFeedback.value?.tone === 'error' ? currentFeedback.value.message : null)
  const actionNotice = computed(() => currentFeedback.value?.tone === 'notice' ? currentFeedback.value.message : null)
  watch(feedbackIdentity, () => { feedbackRevision++; feedback.value = null }, { flush: 'sync' })

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
      if (app.contextMatches(capturedHost)) reportShell(feedbackScope, errorMessage(cause, '命令没有开始执行。请检查连接后重试。'))
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
      if (app.contextMatches(capturedHost)) reportShell(feedbackScope, errorMessage(cause, '没有停下正在运行的命令。请重试。'))
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
      if (!stoppedResultIsCorrelated(result, work.id)) throw new Error('停止结果和这个 Work 对不上，请看一下它现在的状态。')
      const cleanupErrors = result.receipt.cleanupErrors ?? []
      reportAction(feedbackScope, cleanupErrors.length
        ? 'Work 已停止，有些收尾清理没有完成。'
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
      // TODO (#304): Reopen's project-trust confirmation UI was never wired up. Keep
      // the native known-failure result visible; never infer a trust decision.
      reportFailure(feedbackScope, cause)
      if (outcomeUnknown(cause)) void followReopenedWork(work.id, previousGeneration, capturedHost, feedbackScope)
    } finally {
      pendingWorkActions.value.delete(feedbackScope.identity)
    }
  }

  /** If the lost Continue did take effect, show the continued Work without another message. */
  async function followReopenedWork(workId: string, previousGeneration: number, context: ConnectionContext, feedbackScope: FeedbackScope) {
    if (!await app.refreshWorksQuietly() || !app.contextMatches(context) || !feedbackMatches(feedbackScope)) return
    const current = app.works.find((work) => work.id === workId)
    if (!current || current.lifecycle !== 'active' || current.runtimeGeneration <= previousGeneration) return
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
    aborting, workMutating, actionError, actionNotice, selectedCompactionPending, currentCompactionError,
    abortCurrentRun, stopSelectedWork, reopenSelectedWork, forgetSelectedWork, setCompactionError, startCompaction,
    shellStarting, shellAborting, shellError, runShell, abortShell,
    hostMachines, machineListError, newWorkMachinesLoading, machineSettingsLoading, newWorkCompact, groupedWorks, workMachineTag, selectWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory, openMachineSettings, acceptCreatedWork,
  }
})
