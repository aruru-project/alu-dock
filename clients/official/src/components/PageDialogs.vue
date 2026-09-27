<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import type { useControlPanel } from '../lib/controlPanel'
import HostSettingsPanel from './HostSettingsPanel.vue'
import { computed } from 'vue'
import { isTauri } from '../lib/bridge'
import AppSettings from './AppSettings.vue'
import ControlCenter from './ControlCenter.vue'
import type { usePlatformLifecycle } from '../lib/platformLifecycle'
import type { useWorkDirectory } from '../lib/workDirectory'
import type { useInputEditor } from '../lib/inputEditor'
import type { useWorkActions } from '../lib/workActions'
import type { useHostConnection } from '../lib/hostConnection'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import type { useWorkObservation } from '../lib/workObservation'
import NewWorkDialog from './NewWorkDialog.vue'
import MessageTextDialog from './MessageTextDialog.vue'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'appSettingsOpen' | 'bindSurface' | 'closeModal' | 'commandOpen' | 'confirmDialog' | 'controlBodyOverride' | 'controlDialogBody' | 'controlDialogClasses' | 'controlDialogTitle' | 'controlTitleOverride' | 'directoryOpen' | 'dockToolsPopoverStyle' | 'handleModalKeydown' | 'handleModalWheel' | 'hostSettingsOpen' | 'messageTextView' | 'pulseCommandPalette' | 'setControlDialogTitle' | 'settleConfirm'>> & Pick<ReturnType<typeof usePageSurfaces>, 'controlSection' | 'controlSizeOverride'>
  editor: ReadonlyRefs<Pick<ReturnType<typeof useInputEditor>, 'draft' | 'prefillSlashCommand' | 'restoreQueue'>>
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'handleNewWorkUnknown' | 'markControlUnknown' | 'mutationOutcomeUnknown' | 'reconcileMutationOutcome' | 'selectedCompactionPending' | 'startCompaction' | 'stopSelectedWork' | 'unresolvedControlDomain'>>
  directory: ReadonlyRefs<Pick<ReturnType<typeof useWorkDirectory>, 'acceptCreatedWork' | 'hostMachines' | 'machineListError' | 'newWorkMachinesLoading'>> & Pick<ReturnType<typeof useWorkDirectory>, 'newWorkCompact' | 'newWorkMutationBusy'>
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'addHostEndpoint' | 'beginPairing' | 'chooseConnectionPolicy' | 'connectLocal' | 'discardRecoveredPairing' | 'endpointCanSaveDraft' | 'endpointError' | 'endpointFormOpen' | 'endpointKindLabel' | 'endpointMutatingId' | 'endpointSaving' | 'endpointStateLabel' | 'hostNameError' | 'hostNameSaved' | 'hostNameSaving' | 'moveEndpoint' | 'pairingError' | 'pairingInProgress' | 'pairingMessage' | 'pairingPin' | 'pairingStage' | 'pairingTransactionId' | 'recoverablePairings' | 'rememberPairDeviceName' | 'removeEndpoint' | 'removeSavedHost' | 'resumeRecoveredPairing' | 'saveEndpointDraft' | 'saveHostDisplayName' | 'showHostPairingForm' | 'stopPairing' | 'switchSavedHost' | 'testEndpoint' | 'testStatusLabel' | 'toggleEndpoint' | 'toggleEndpointForm' | 'updateLocalEndpoint'>> & Pick<ReturnType<typeof useHostConnection>, 'addingHost' | 'endpointHost' | 'endpointKind' | 'endpointLabel' | 'endpointPort' | 'hostDisplayName' | 'pairDeviceName' | 'pairHost' | 'pairPort'>
  platform: ReadonlyRefs<Pick<ReturnType<typeof usePlatformLifecycle>, 'appSettings' | 'appSettingsError' | 'appSettingsSaving' | 'chooseWindowsAwayDelay'>>
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'acceptWork'>>
  controlPanel: Pick<ReturnType<typeof useControlPanel>, 'handle'>
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { directoryOpen, commandOpen, controlSection, controlTitleOverride, controlBodyOverride, controlSizeOverride, confirmDialog, appSettingsOpen, hostSettingsOpen, messageTextView, dockToolsPopoverStyle, settleConfirm, closeModal, handleModalKeydown, handleModalWheel, controlDialogTitle, controlDialogBody, setControlDialogTitle, controlDialogClasses, pulseCommandPalette } = props.page
const { draft, restoreQueue, prefillSlashCommand } = props.editor
const { mutationOutcomeUnknown, unresolvedControlDomain, selectedCompactionPending, stopSelectedWork, startCompaction, handleNewWorkUnknown, markControlUnknown, reconcileMutationOutcome } = props.actions
const { hostMachines, machineListError, newWorkMachinesLoading, newWorkMutationBusy, newWorkCompact, acceptCreatedWork } = props.directory

const { appSettings, appSettingsSaving, appSettingsError, chooseWindowsAwayDelay } = props.platform

const appBuildIdentity = import.meta.env.VITE_ALUDOCK_BUILD_IDENTITY
const controlCenterRef = props.controlPanel.handle
const applyControlSnapshot = props.observation.acceptWork
</script>

<template>
  <Transition name="fade">
    <div v-if="messageTextView" class="ui-dialog-overlay message-text-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('text', element)" class="ui-dialog-box ui-dialog-size-wide message-text-dialog" role="dialog" aria-modal="true" aria-label="消息原文" tabindex="-1" @wheel="handleModalWheel">
        <MessageTextDialog :title="messageTextView.title" :text="messageTextView.text" :markdown="messageTextView.markdown" @close="closeModal" />
      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="commandOpen && selected" :class="controlSection === 'commands' ? 'cmd-palette-overlay' : controlSection === 'dock-tools' ? 'dock-tools-popover-layer' : 'ui-dialog-overlay'" :style="controlSection === 'dock-tools' ? dockToolsPopoverStyle : undefined" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop @click.self="controlSection === 'dock-tools' ? closeModal() : pulseCommandPalette()">
      <section :ref="element => props.page.bindSurface('control', element)" :class="controlSection === 'commands' ? 'cmd-palette-box' : controlSection === 'dock-tools' ? 'dock-tools-popover-surface' : controlDialogClasses(controlSection)" role="dialog" aria-modal="true" tabindex="-1" :aria-label="controlDialogTitle(controlSection)" @wheel="handleModalWheel">
        <template v-if="controlSection !== 'commands' && controlSection !== 'dock-tools'"><header class="ui-dialog-header"><div class="ui-dialog-title">{{ controlTitleOverride || controlDialogTitle(controlSection) }}</div><div v-if="controlBodyOverride || (!controlTitleOverride && controlDialogBody(controlSection))" class="ui-dialog-body">{{ controlBodyOverride || controlDialogBody(controlSection) }}</div></header><button class="ui-dialog-close" aria-label="关闭" @click="closeModal">×</button></template>
        <ControlCenter
          ref="controlCenterRef"
          :work="selected"
          :section="controlSection"
          :preview="!isTauri"
          :outcome-unknown="mutationOutcomeUnknown"
          :unknown-domain="unresolvedControlDomain"
          :has-draft="!!draft.trim()"
          :compaction-pending="selectedCompactionPending"
          @section="controlSection = $event"
          @prefill="prefillSlashCommand"
          @snapshot="applyControlSnapshot"
          @unknown="markControlUnknown"
          @reconcile="reconcileMutationOutcome"
          @compact="startCompaction"
          @close="closeModal"
          @stop="closeModal(); stopSelectedWork()"
          @restore-queue="closeModal(); restoreQueue()"
          @title="setControlDialogTitle"
          @size="controlSizeOverride = $event"
        />
      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="appSettingsOpen && appSettings" class="modal-layer" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('app-settings', element)" class="app-settings-surface" role="dialog" aria-modal="true" aria-labelledby="app-settings-title" tabindex="-1" @wheel="handleModalWheel">
        <AppSettings
          :preferences="appSettings"
          :build-identity="appBuildIdentity"
          :saving="appSettingsSaving"
          :error="appSettingsError"
          @close="closeModal"
          @update="chooseWindowsAwayDelay"
        />
      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="directoryOpen || hostSettingsOpen" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('directory-host', element)" :class="directoryOpen ? ['ui-dialog-box', 'ui-dialog-size-wide', { 'ui-dialog-size-auto': newWorkCompact }] : 'host-settings-surface'" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="directoryOpen ? 'directory-title' : 'host-settings-title'" @wheel="handleModalWheel">
        <NewWorkDialog
          v-if="directoryOpen"
          :machines="hostMachines"
          :machines-loading="newWorkMachinesLoading"
          :machine-error="machineListError"
          :preview="!isTauri"
          :outcome-unknown="mutationOutcomeUnknown"
          @close="closeModal"
          @created="acceptCreatedWork"
          @unknown="handleNewWorkUnknown"
          @busy="newWorkMutationBusy = $event"
          @view="newWorkCompact = $event === 'launcher'"
        />
        <HostSettingsPanel v-if="hostSettingsOpen" :host="props.host" :page="page" :busy="props.host.pairingInProgress.value" />

      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="confirmDialog" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => props.page.bindSurface('confirm', element)" class="ui-dialog-box ui-dialog-box-confirm" role="dialog" aria-modal="true" tabindex="-1" :aria-label="confirmDialog.title" @wheel="handleModalWheel">
        <header class="ui-dialog-header"><div class="ui-dialog-title">{{ confirmDialog.title }}</div><div v-if="confirmDialog.body" class="ui-dialog-body">{{ confirmDialog.body }}</div></header>
        <div class="ui-dialog-btn-row"><button class="ui-dialog-btn" @click="settleConfirm(false)">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" data-modal-initial @click="settleConfirm(true)">确认</button></div>
      </section>
    </div>
  </Transition>

</template>
