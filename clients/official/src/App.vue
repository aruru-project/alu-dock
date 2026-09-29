<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { isTauri } from './lib/bridge'
import DeliveryTray from './components/DeliveryTray.vue'
import OperationResults from './components/OperationResults.vue'
import { useControlPanel } from './lib/controlPanel'
import { usePlatformLifecycle } from './lib/platformLifecycle'
import { useWorkDirectory } from './lib/workDirectory'
import { useDeliveries } from './lib/deliveries'
import { useConversationRegion } from './lib/conversationRegion'
import { useInputEditor } from './lib/inputEditor'
import { useWorkActions } from './lib/workActions'
import { useHostConnection } from './lib/hostConnection'
import { useAttachmentUploads } from './lib/attachmentUploads'
import { usePageSurfaces } from './lib/pageSurfaces'
import { useWorkObservation } from './lib/workObservation'
import { useOperationResults } from './lib/operationResults'
import WorkspaceBrowser from './components/WorkspaceBrowser.vue'
import { useAppStore } from './stores/app'
import { useExtensionUiStore } from './stores/extension-ui'
import WorkTopbar from './components/WorkTopbar.vue'
import InputRegion from './components/InputRegion.vue'
import WorkToolbar from './components/WorkToolbar.vue'
import ConversationRegion from './components/ConversationRegion.vue'
import ConnectionLanding from './components/ConnectionLanding.vue'
import WorkSidebar from './components/WorkSidebar.vue'
import ImagePreviewDialog from './components/ImagePreviewDialog.vue'
import PageDialogs from './components/PageDialogs.vue'

const app = useAppStore()
const extensionUi = useExtensionUiStore()
const input = useInputEditor({
  page: () => page, observation: () => observation, actions: () => workActions, attachments: () => attachments,
  focused: () => windowFocused.value, pairing: () => pairingInProgress.value, activity: (workId) => showAgentActivity(workId),
})
const { composer, composerExpanded, queueRestoring, submitting } = input
const page = usePageSurfaces({
  composer: () => composer,
  extensionActive: () => !!extensionUi.activeRequest,
  directoryBusy: () => newWorkMutationBusy.value,
  modelLabel: () => { const model = app.selectedWork?.executor.model; return model ? `${model.provider}/${model.id}` : '—' },
})
const { directoryOpen, commandOpen, deliveryOpen, workspaceBrowserOpen } = page
const workActions = useWorkActions(page, {
  observation: () => observation,
  panel: () => controlPanel.handle.value,
})
const { setCompactionError } = workActions
const hostConnection = useHostConnection(page, {
  busy: () => pairingInProgress.value,
  hasRestoredImages: () => hasRestoredImageDrafts.value,
})
const { pairingInProgress } = hostConnection
const attachments = useAttachmentUploads({
  page: () => page,
  pairing: () => pairingInProgress.value,
  sendingOrRestoring: () => submitting.value || queueRestoring.value,
  reportError: (message) => input.reportError(message),
})
const { hasRestoredImageDrafts, refreshRestoredImageCount } = attachments
const conversationRegion = useConversationRegion(page)
const { outputAwayFromBottom, showAgentActivity } = conversationRegion
const deliveries = useDeliveries(page)
const { deliveryTrayRef, deliveryLoading, deliveryError, currentDeliverableRows, olderDownloadHistory, openingDeliveryKey, refreshDeliverables, saveDeliverable, openDownloadedDeliverable, clearLocalDownloadHistory } = deliveries
const workDirectory = useWorkDirectory(page, {
  actions: () => workActions,
  pairing: () => pairingInProgress.value, acceptWork: (work) => observation.acceptWork(work),
})
const { newWorkMutationBusy } = workDirectory
const platform = usePlatformLifecycle(page, { observation: () => observation })
const { windowFocused } = platform
const detailMode = computed({ get: () => app.detailMode, set: (value: boolean) => app.setDetailMode(value) })
const selected = computed(() => app.selectedWork)
const operationResults = useOperationResults({
  presentFailure: (...args) => input.presentSubmitFailure(...args),
  acceptWork: (work) => observation.acceptWork(work),
  queueRetrieved: (operation, ids) => observation.queueRetrieved(operation, ids),
  refreshRestoredImages: refreshRestoredImageCount,
})
const { workResults, listResults, consumeNativeOperation } = operationResults
const controlPanel = useControlPanel()
const observation = useWorkObservation(conversationRegion.sink, {
  focused: () => windowFocused.value,
  configEvent: (event) => controlPanel.acceptEvent(event),
  compactionSettled: setCompactionError,
  replacement: () => { void refreshRestoredImageCount() },
})

onMounted(async () => {
  page.listenShortcuts({ abort: workActions.abortCurrentRun, restoreQueue: input.restoreQueue })
  await platform.initialize()
  if (isTauri) {
    await hostConnection.listenNative()
    await deliveries.listenNative()
    await attachments.listenNative()
    await observation.listenNative()
    await operationResults.listenNative()
  }
  await app.load()
  await platform.afterLoad()
  await operationResults.initialize()
  await hostConnection.initializePairDeviceName()
  if (!app.needsPairing) app.workDrawerOpen = !app.selectedWork
})

</script>

<template>
  <div class="alu-client-shell" :class="{ 'alu-compact-mode': !detailMode }">
    <WorkTopbar :page="page" :deliveries="deliveries" :failure-count="listResults.length" />

    <ConversationRegion :conversation-owner="conversationRegion" :observation="observation" :uploads="attachments" :page="page">
      <ConnectionLanding :host="hostConnection" :platform="platform" :actions="workActions" :busy="pairingInProgress" />
    </ConversationRegion>

    <div v-if="workResults.length && !commandOpen && !directoryOpen && !composerExpanded" class="alu-work-operation-results" aria-label="当前 Work 操作结果">
      <OperationResults :key="`${app.activeConnectionId}:${selected?.id}`" :operations="workResults" :acknowledge="consumeNativeOperation" />
    </div>

    <InputRegion :editor="input" :uploads="attachments" :page="page" :actions="workActions" :operations="operationResults" :observation="observation" :away="outputAwayFromBottom" @latest="conversationRegion.scrollOutputToBottom(true)">
      <WorkToolbar :page="page" :uploads="attachments" :actions="workActions" :observation="observation" :host="hostConnection" />
    </InputRegion>

    <WorkspaceBrowser
      :open="workspaceBrowserOpen"
      :work="selected || null"
      :context="app.connectionContext || null"
      :host-epoch="app.payload?.host.hostEpoch || ''"
      @close="workspaceBrowserOpen = false"
    />

    <DeliveryTray
      ref="deliveryTrayRef"
      :open="deliveryOpen"
      :loading="deliveryLoading"
      :error="deliveryError"
      :current-work-name="selected?.displayName || ''"
      :current="currentDeliverableRows"
      :history="olderDownloadHistory"
      :opening-key="openingDeliveryKey"
      @close="deliveryOpen = false"
      @refresh="refreshDeliverables"
      @download="saveDeliverable"
      @redownload="(deliverable) => saveDeliverable(deliverable, true)"
      @open-saved="openDownloadedDeliverable"
      @clear="clearLocalDownloadHistory"
    />

    <WorkSidebar :directory="workDirectory" :page="page" :host="hostConnection" :platform="platform" :actions="workActions" :operations="operationResults" :observation="observation" />

    <ImagePreviewDialog :page="page" :conversation-owner="conversationRegion" :uploads="attachments" />

    <PageDialogs :page="page" :editor="input" :actions="workActions" :directory="workDirectory" :host="hostConnection" :platform="platform" :observation="observation" :control-panel="controlPanel" />
  </div>
</template>
