import { computed, ref, watch } from 'vue'
import type { ProjectedEvent } from './types'
import type { ControlCenterHandle } from './workActions'
import { useAppStore } from '../stores/app'
import { useCommandConsoleStore } from '../stores/command-console'
/** The open control panel's local query/display interface, not an operation owner. */
export function useControlPanel() {
  const app = useAppStore()
  const selected = computed(() => app.selectedWork)
  const commandConsole = useCommandConsoleStore()
  const handle = ref<ControlCenterHandle | null>(null)
  watch([
    () => app.activeConnectionId,
    () => app.connectionContext?.selectionGeneration,
    () => selected.value?.id,
    () => selected.value?.ownerHostEpoch,
    () => selected.value?.runtimeGeneration,
  ], () => {
    const context = app.connectionContext
    const work = selected.value
    if (context && work) commandConsole.bindContext(context.connectionId, context.selectionGeneration, work)
  }, { immediate: true })

  return { handle, acceptEvent: (event: ProjectedEvent) => handle.value?.applyLiveEvent(event) }
}
