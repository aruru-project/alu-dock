import type { ReadonlyRefs } from './ownerView'
import { computed, ref, watch } from 'vue'
import { listMachines } from './bridge'
import { currentConnectionCall } from './hostResult'
import { subhostMachineName } from './machines'
import { userErrorMessage as errorMessage } from './userError'
import type { MachineDto, Work } from './types'
import type { usePageSurfaces } from './pageSurfaces'
import type { useWorkActions } from './workActions'
import { useAppStore } from '../stores/app'
export function useWorkDirectory(page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'closeDirectory' | 'closeWorkPanels' | 'directoryOpen' | 'openDirectory'>>, options: {
  actions(): ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'reopenSelectedWork' | 'forgetSelectedWork'>>
  pairing(): boolean
  acceptWork(work: Work): void
}) {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const hostMachines = ref<MachineDto[]>([])
  const machineListError = ref('')
  const newWorkMachinesLoading = ref(false)
  const newWorkMutationBusy = ref(false)
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
    if (work.lifecycle === 'active' || work.lifecycle === 'stopping') return 'current'
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
    await options.actions().reopenSelectedWork()
  }

  async function forgetFromList(work: Work) {
    app.selectWork(work.id)
    await options.actions().forgetSelectedWork()
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
    if (options.pairing()) return
    page.openDirectory()
    newWorkMachinesLoading.value = true
    newWorkMutationBusy.value = false
    newWorkCompact.value = true
    machineListError.value = ''
    try {
      await loadHostMachines()
    } catch (cause) {
      if (page.directoryOpen.value) machineListError.value = errorMessage(cause, '无法读取可用机器，请检查连接后重试。')
    } finally {
      newWorkMachinesLoading.value = false
    }
  }

  function acceptCreatedWork(work: Work) {
    newWorkMutationBusy.value = false
    const machine = work.hostId ? hostMachines.value.find((candidate) => candidate.hostId === work.hostId) : undefined
    if (machine && work.hostId) app.rememberCreatedWorkspace(work.hostId, work.cwd, machine.platform)
    options.acceptWork(work)
    app.selectWork(work.id)
    void app.refreshWorksQuietly()
    page.closeDirectory()
  }

  return { hostMachines, machineListError, newWorkMachinesLoading, newWorkMutationBusy, newWorkCompact, groupedWorks, workMachineTag, selectWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory, acceptCreatedWork }
}
