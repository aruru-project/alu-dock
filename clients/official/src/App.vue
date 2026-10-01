<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { getActivePinia } from 'pinia'
import { isTauri } from './lib/bridge'
import DeliveryTray from './components/DeliveryTray.vue'
import OperationResults from './components/OperationResults.vue'
import WorkspaceBrowser from './components/WorkspaceBrowser.vue'
import WorkTopbar from './components/WorkTopbar.vue'
import InputRegion from './components/InputRegion.vue'
import WorkToolbar from './components/WorkToolbar.vue'
import ConversationRegion from './components/ConversationRegion.vue'
import ConnectionLanding from './components/ConnectionLanding.vue'
import WorkSidebar from './components/WorkSidebar.vue'
import ImagePreviewDialog from './components/ImagePreviewDialog.vue'
import PageDialogs from './components/PageDialogs.vue'
import MachineSettingsResults from './components/MachineSettingsResults.vue'
import { useModelVisibilityStore } from './stores/model-visibility'
import { useAppStore } from './stores/app'
import { useAttachmentsStore } from './stores/attachments'
import { useControlPanelStore } from './stores/control-panel'
import { useConversationStore } from './stores/conversation'
import { useDeliveriesStore } from './stores/deliveries'
import { useHostStore } from './stores/host'
import { useInputStore } from './stores/input'
import { useObservationStore } from './stores/observation'
import { useOperationsStore } from './stores/operations'
import { usePlatformStore } from './stores/platform'
import { useSurfacesStore } from './stores/surfaces'
import { useWorkActionsStore } from './stores/work-actions'

// App lays out the page regions and starts the page-wide listeners once.
// Every region reads the stores it needs directly.
const app = useAppStore()
const surfaces = useSurfacesStore()
const platform = usePlatformStore()
const observation = useObservationStore()
const host = useHostStore()
const deliveries = useDeliveriesStore()
const attachments = useAttachmentsStore()
const operations = useOperationsStore()
const input = useInputStore()
const workActions = useWorkActionsStore()
const controlPanel = useControlPanelStore()
const conversation = useConversationStore()
const modelVisibility = useModelVisibilityStore()
const selected = computed(() => app.selectedWork)
const pinia = getActivePinia()

onMounted(async () => {
  surfaces.listenWindow()
  input.listenShortcuts()
  await platform.initialize()
  await observation.listenFocus()
  // Listen before the first read so no native event is missed.
  if (isTauri) {
    await host.listenNative()
    await deliveries.listenNative()
    await attachments.listenNative()
    await observation.listenNative()
    await operations.listenNative()
  }
  await app.load()
  await observation.afterLoad()
  await operations.initialize()
  await host.initializePairDeviceName()
  if (!app.needsPairing) app.workDrawerOpen = !app.selectedWork
})
// The page's stores stop their listeners and timers with the page; a later page starts from fresh state.
onUnmounted(() => {
  for (const store of [input, operations, attachments, workActions, controlPanel, conversation, deliveries, host, observation, platform, surfaces, modelVisibility]) {
    store.$dispose()
    if (pinia) delete pinia.state.value[store.$id]
  }
})
</script>

<template>
  <div class="alu-client-shell">
    <WorkTopbar />

    <ConversationRegion>
      <ConnectionLanding />
    </ConversationRegion>

    <div v-if="operations.workResults.length && !surfaces.commandOpen && !surfaces.directoryOpen && !surfaces.composerExpanded" class="alu-work-operation-results" aria-label="当前 Work 操作结果">
      <OperationResults :key="`${app.activeConnectionId}:${selected?.id}`" :operations="operations.workResults" :acknowledge="operations.consumeNativeOperation" />
    </div>

    <MachineSettingsResults />

    <InputRegion>
      <WorkToolbar />
    </InputRegion>

    <WorkspaceBrowser
      :open="surfaces.workspaceBrowserOpen"
      :work="selected || null"
      :context="app.connectionContext || null"
      :host-epoch="app.payload?.host.hostEpoch || ''"
      @close="surfaces.workspaceBrowserOpen = false"
    />

    <DeliveryTray />

    <WorkSidebar />

    <ImagePreviewDialog />

    <PageDialogs />
  </div>
</template>

<style scoped>
/* Existing Work operation results, not a connection/recovery banner. */
.alu-work-operation-results { width: min(calc(100% - 32px), 760px); margin: 6px auto; flex: none; }
.alu-client-shell { position: relative; z-index: 1; display: flex; width: 100%; height: 100%; height: 100dvh; flex-direction: column; color: var(--alu-text); }
.alu-client-shell {
  height: var(--aludock-base-viewport-height, 100dvh);
  max-height: var(--aludock-base-viewport-height, 100dvh);
  padding:
      var(--aludock-inset-top)
      var(--aludock-inset-right)
      max(var(--aludock-inset-bottom), var(--aludock-ime-bottom))
      var(--aludock-inset-left);
}
</style>
