<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import HostSettingsPanel from './HostSettingsPanel.vue'
import AppSettings from './AppSettings.vue'
import ControlCenter from './ControlCenter.vue'
import NewWorkDialog from './NewWorkDialog.vue'
import MessageTextDialog from './MessageTextDialog.vue'
import { useAppStore } from '../stores/app'
import { useInputStore } from '../stores/input'
import { usePlatformStore } from '../stores/platform'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const surfaces = useSurfacesStore()
const { directoryOpen, commandOpen, controlSection, controlTitleOverride, controlBodyOverride, controlSizeOverride, confirmDialog, appSettingsOpen, hostSettingsOpen, messageTextView, dockToolsPopoverStyle, directoryBusy } = storeToRefs(surfaces)
const { settleConfirm, closeModal, handleModalKeydown, handleModalWheel, controlDialogTitle, controlDialogBody, setControlDialogTitle, controlDialogClasses, pulseCommandPalette, bindSurface } = surfaces
const { restoreQueue, prefillSlashCommand } = useInputStore()
const workActions = useWorkActionsStore()
const { mutationOutcomeUnknown, globalOutcomeUnknown, unresolvedControlDomain, selectedCompactionPending, hostMachines, machineListError, newWorkMachinesLoading, newWorkCompact } = storeToRefs(workActions)
const { stopSelectedWork, startCompaction, handleNewWorkUnknown, markControlUnknown, reconcileMutationOutcome, acceptCreatedWork } = workActions
const platform = usePlatformStore()
const { appSettings, appSettingsSaving, appSettingsError } = storeToRefs(platform)
const { chooseWindowsAwayDelay } = platform
const appBuildIdentity = import.meta.env.VITE_ALUDOCK_BUILD_IDENTITY
</script>

<template>
  <Transition name="fade">
    <div v-if="messageTextView" class="ui-dialog-overlay message-text-overlay" role="presentation" @click.self="closeModal" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => bindSurface('text', element)" class="ui-dialog-box ui-dialog-size-wide message-text-dialog" role="dialog" aria-modal="true" aria-label="消息原文" tabindex="-1" @wheel="handleModalWheel">
        <MessageTextDialog :title="messageTextView.title" :text="messageTextView.text" :markdown="messageTextView.markdown" @close="closeModal" />
      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="commandOpen && selected" :class="controlSection === 'commands' ? 'cmd-palette-overlay' : controlSection === 'dock-tools' ? 'dock-tools-popover-layer' : 'ui-dialog-overlay'" :style="controlSection === 'dock-tools' ? dockToolsPopoverStyle : undefined" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop @click.self="controlSection === 'dock-tools' ? closeModal() : pulseCommandPalette()">
      <section :ref="element => bindSurface('control', element)" :class="controlSection === 'commands' ? 'cmd-palette-box' : controlSection === 'dock-tools' ? 'dock-tools-popover-surface' : controlDialogClasses(controlSection)" role="dialog" aria-modal="true" tabindex="-1" :aria-label="controlDialogTitle(controlSection)" @wheel="handleModalWheel">
        <template v-if="controlSection !== 'commands' && controlSection !== 'dock-tools'"><header class="ui-dialog-header"><div class="ui-dialog-title">{{ controlTitleOverride || controlDialogTitle(controlSection) }}</div><div v-if="controlBodyOverride || (!controlTitleOverride && controlDialogBody(controlSection))" class="ui-dialog-body">{{ controlBodyOverride || controlDialogBody(controlSection) }}</div></header><button class="ui-dialog-close" aria-label="关闭" @click="closeModal">×</button></template>
        <ControlCenter
          :work="selected"
          :section="controlSection"
          :outcome-unknown="mutationOutcomeUnknown"
          :unknown-domain="unresolvedControlDomain"
          :compaction-pending="selectedCompactionPending"
          @section="controlSection = $event"
          @prefill="prefillSlashCommand"
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
      <section :ref="element => bindSurface('app-settings', element)" class="app-settings-surface" role="dialog" aria-modal="true" aria-labelledby="app-settings-title" tabindex="-1" @wheel="handleModalWheel">
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
      <section :ref="element => bindSurface('directory-host', element)" :class="directoryOpen ? ['ui-dialog-box', 'ui-dialog-size-wide', { 'ui-dialog-size-auto': newWorkCompact }] : 'host-settings-surface'" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="directoryOpen ? 'directory-title' : 'host-settings-title'" @wheel="handleModalWheel">
        <NewWorkDialog
          v-if="directoryOpen"
          :machines="hostMachines"
          :machines-loading="newWorkMachinesLoading"
          :machine-error="machineListError"
          :outcome-unknown="globalOutcomeUnknown"
          @close="closeModal"
          @created="acceptCreatedWork"
          @unknown="handleNewWorkUnknown"
          @busy="directoryBusy = $event"
          @view="newWorkCompact = $event === 'launcher'"
        />
        <HostSettingsPanel v-if="hostSettingsOpen" />

      </section>
    </div>
  </Transition>

  <Transition name="fade">
    <div v-if="confirmDialog" class="ui-dialog-overlay" role="presentation" @keydown="handleModalKeydown" @wheel.prevent.stop>
      <section :ref="element => bindSurface('confirm', element)" class="ui-dialog-box ui-dialog-box-confirm" role="dialog" aria-modal="true" tabindex="-1" :aria-label="confirmDialog.title" @wheel="handleModalWheel">
        <header class="ui-dialog-header"><div class="ui-dialog-title">{{ confirmDialog.title }}</div><div v-if="confirmDialog.body" class="ui-dialog-body">{{ confirmDialog.body }}</div></header>
        <div class="ui-dialog-btn-row"><button class="ui-dialog-btn" @click="settleConfirm(false)">取消</button><button class="ui-dialog-btn ui-dialog-btn-primary" data-modal-initial @click="settleConfirm(true)">确认</button></div>
      </section>
    </div>
  </Transition>

</template>

<style scoped>
/* Narrower screens use the shared wide-dialog height from styles/dialog.css. */
@media (min-width: 1001px) {
  .message-text-dialog { height: min(78vh, 720px); height: min(78dvh, 720px); }
}
.ui-dialog-btn-row { display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 8px; padding: 14px 16px; }
.dock-tools-popover-surface {
  position: absolute;
  top: var(--dock-tools-popover-top, 72px);
  right: var(--dock-tools-popover-right, 20px);
  display: flex;
  width: min(380px, calc(100vw - 24px));
  max-height: calc(100dvh - var(--dock-tools-popover-top, 72px) - 12px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--alu-blue) 28%, var(--alu-border-light));
  border-radius: 15px;
  background: color-mix(in srgb, var(--alu-bg-raised) 96%, var(--alu-blue-bg));
  box-shadow: 0 24px 72px rgba(0, 0, 0, .66), 0 0 0 1px rgba(115, 183, 255, .05);
  transform-origin: 88% 0;
  animation: dockToolsPopoverIn .16s cubic-bezier(.2, .8, .2, 1);
}
@media (max-width: 640px) {
  .dock-tools-popover-surface { top: auto; right: 0; bottom: 0; left: 0; width: 100%; max-height: min(76dvh, 560px); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 18px 18px 0 0; transform-origin: 50% 100%; animation-name: dockToolsSheetIn; }
}
.modal-layer { position: fixed; z-index: 30; inset: 0; display: grid; padding: 24px; background: rgb(2 5 12 / .72); backdrop-filter: blur(5px); place-items: center; }
@media (max-width: 640px) {
  .modal-layer { padding: 0; align-items: end; }
}
/* App settings is a quiet device-level surface, distinct from Host administration. */
.app-settings-surface { position: relative; display: grid; width: min(760px, calc(100vw - 48px)); height: min(620px, calc(100vh - 48px)); min-height: 480px; grid-template-rows: 68px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--alu-border); border-radius: 16px; background: #0b101c; box-shadow: 0 28px 80px rgba(0, 0, 0, .5); }
.app-settings-surface::before { position: absolute; z-index: 2; top: 0; right: 0; left: 0; height: 1px; background: linear-gradient(90deg, transparent 4%, var(--alu-blue) 30%, var(--alu-pink) 75%, transparent 96%); content: ''; opacity: .64; pointer-events: none; }
@media (max-width: 640px) {
  .app-settings-surface { width: 100%; height: min(92vh, 760px); min-height: 0; border-right: 0; border-bottom: 0; border-left: 0; border-radius: 18px 18px 0 0; }
}
/* Host settings is a task surface, not a wall of equally weighted forms. */
.host-settings-surface {
  position: relative;
  display: grid;
  width: min(940px, 100%);
  /* Fit the inset-aware overlay, including WebViews without dynamic viewport units. */
  height: min(720px, 100%);
  min-height: 0;
  max-height: 100%;
  grid-template-rows: 68px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--alu-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--alu-bg) 94%, #11192a);
  box-shadow: 0 28px 80px rgba(0, 0, 0, .48), 0 0 0 1px rgba(255, 255, 255, .018) inset;
}
.host-settings-surface::before {
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  left: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 4%, var(--alu-pink) 23%, var(--alu-blue) 70%, transparent 96%);
  content: '';
  opacity: .56;
  pointer-events: none;
}
@media (max-width: 720px) {
  .host-settings-surface { width: 100%; height: min(92%, 820px); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 18px 18px 0 0; }
}
</style>
