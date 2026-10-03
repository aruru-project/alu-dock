<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { FolderTree } from '@lucide/vue'
import { isTauri } from '../lib/bridge'
import ConnectionStatus from './ConnectionStatus.vue'
import { useAppStore } from '../stores/app'
import { useAttachmentsStore } from '../stores/attachments'
import { useHostStore } from '../stores/host'
import { useObservationStore } from '../stores/observation'
import { useSurfacesStore } from '../stores/surfaces'

const app = useAppStore()
const surfaces = useSurfacesStore()
const { workspaceBrowserOpen } = storeToRefs(surfaces)
const { openControlCenter, openWorkspaceBrowser } = surfaces
const attachments = useAttachmentsStore()
const { draftAttachments, uploadDrafts, attachmentPicking, maxMessageAttachments } = storeToRefs(attachments)
const { chooseAttachments } = attachments
const observation = useObservationStore()
const { status: observationStatus, label: connectionLabel, refreshing } = storeToRefs(observation)
const { refreshCurrent } = observation
const { openHostSettings } = useHostStore()
const commandShortcutLabel = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'
</script>

<template>
    <div class="alu-bottom-bar">
      <div class="alu-bottom-bar-left">
        <button class="alu-bar-btn alu-bar-session-action" title="恢复 Session" aria-label="恢复 Session" @click="openControlCenter('sessions')">↪<span>恢复</span></button>
        <button class="alu-bar-btn alu-bar-session-action" title="打开 Session Tree" aria-label="打开 Session Tree" @click="openControlCenter('tree')">⑂<span>Tree</span></button>
        <button class="alu-bar-btn" title="浏览当前 Work 的工作区" aria-label="打开工作区" :aria-expanded="workspaceBrowserOpen" :disabled="!isTauri" @click="openWorkspaceBrowser"><FolderTree :size="15" /><span>工作区</span></button>
        <button class="alu-bar-btn" title="添加附件" :disabled="!isTauri || attachmentPicking || draftAttachments.length + uploadDrafts.length >= maxMessageAttachments" @click="chooseAttachments">📎<span class="sm-inline">附件</span></button>
      </div>
      <div class="alu-bottom-bar-right">
        <ConnectionStatus :state="observationStatus" :label="connectionLabel" @reconnect="refreshCurrent" @settings="openHostSettings" @works="app.workDrawerOpen = true" />
        <div class="alu-bar-sep" />
        <button class="alu-bar-btn" :title="refreshing ? '正在刷新' : '刷新'" :aria-label="refreshing ? '正在刷新' : '刷新'" :disabled="refreshing" @click="refreshCurrent">↻<span class="sm-inline">{{ refreshing ? '正在刷新…' : '刷新' }}</span></button>
        <button class="alu-bar-btn" :title="`打开命令中心（${commandShortcutLabel}）`" aria-keyshortcuts="Control+K Meta+K" @click="openControlCenter('commands')"><kbd>{{ commandShortcutLabel }}</kbd><span class="sm-inline">命令</span></button>
      </div>
    </div>

</template>

<style scoped>
/* ═══════════════════════════════════════════════════════
   底部工具栏
   ═══════════════════════════════════════════════════════ */
.alu-bottom-bar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  height: var(--alu-bar-height);
  border-top: 1px solid var(--alu-nav-border);
}
.alu-bottom-bar-left {
  display: flex;
  align-items: center;
  gap: 2px;
}
.alu-bottom-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.alu-bar-sep {
  width: 1px;
  height: 16px;
  background: var(--alu-border);
  margin: 0 4px;
  flex-shrink: 0;
}
@media (max-width: 1000px) {
  .alu-input-section > .alu-bottom-bar {
    width: min(100%, 760px);
    margin-inline: auto;
  }
  .alu-bar-session-action,
  .alu-bottom-bar kbd {
    display: none;
  }
  .alu-bottom-bar {
    height: var(--alu-bar-height);
    min-height: var(--alu-bar-height);
    flex-wrap: nowrap;
    gap: 4px;
    padding: 2px 0;
  }
  .alu-bottom-bar-left,
  .alu-bottom-bar-right {
    min-width: 0;
    flex-wrap: nowrap;
    gap: 2px;
  }
  .alu-bottom-bar-right { margin-left: auto; }
  .alu-bar-sep { margin: 0 1px; }
}
@media (max-width: 640px) {
  .alu-bottom-bar-right { gap: 0; }
}
</style>
