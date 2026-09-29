<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { computed } from 'vue'
import { FolderTree } from '@lucide/vue'
import { isTauri } from '../lib/bridge'
import ConnectionStatus from './ConnectionStatus.vue'
import type { useWorkActions } from '../lib/workActions'
import type { useHostConnection } from '../lib/hostConnection'
import type { useAttachmentUploads } from '../lib/attachmentUploads'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import type { useWorkObservation } from '../lib/workObservation'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'openControlCenter' | 'openWorkspaceBrowser' | 'workspaceBrowserOpen'>>
  uploads: ReadonlyRefs<Pick<ReturnType<typeof useAttachmentUploads>, 'attachmentPicking' | 'chooseAttachments' | 'draftAttachments' | 'maxMessageAttachments' | 'uploadDrafts'>>
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'abortCurrentRun' | 'aborting'>>
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'label' | 'refreshCurrent' | 'status'>>
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'openHostSettings'>>
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { workspaceBrowserOpen, openControlCenter } = props.page
const { draftAttachments, uploadDrafts, attachmentPicking, maxMessageAttachments, chooseAttachments } = props.uploads
const { aborting, abortCurrentRun } = props.actions
const { status: observationStatus } = props.observation
const { openHostSettings } = props.host
const commandShortcutLabel = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'
const detailMode = computed({ get: () => app.detailMode, set: (value: boolean) => app.setDetailMode(value) })
const connectionLabel = props.observation.label
const refreshCurrent = props.observation.refreshCurrent
const openWorkspaceBrowser = props.page.openWorkspaceBrowser
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
        <button class="alu-bar-btn" title="刷新" @click="refreshCurrent">↻<span class="sm-inline">刷新</span></button>
        <button class="alu-bar-btn" :class="{ 'alu-bar-btn-toggle-active': !detailMode }" title="切换显示模式" @click="detailMode = !detailMode"><span>▤</span><span>{{ detailMode ? '详细' : '简洁' }}</span></button>
        <button class="alu-bar-btn" :title="`打开命令中心（${commandShortcutLabel}）`" aria-keyshortcuts="Control+K Meta+K" @click="openControlCenter('commands')"><kbd>{{ commandShortcutLabel }}</kbd><span class="sm-inline">命令</span></button>
        <button class="alu-bar-btn alu-bar-btn-abort" :disabled="!isTauri || aborting || selected?.execution !== 'running'" @click="abortCurrentRun">⏹<span class="sm-inline">{{ aborting ? '中止中' : '中止' }}</span></button>
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
.alu-bar-btn-abort {
  color: var(--alu-rose-dim);
}
.alu-bar-btn-abort:hover {
  background: var(--alu-rose-bg);
  color: var(--alu-rose);
}
/* 显示模式切换按钮：激活（简洁模式）高亮 */
.alu-bar-btn-toggle-active {
  background: var(--alu-hover);
  color: var(--alu-blue);
}
.alu-bar-btn-toggle-active:hover {
  color: var(--alu-blue);
}
.alu-bar-sep {
  width: 1px;
  height: 16px;
  background: var(--alu-border);
  margin: 0 4px;
  flex-shrink: 0;
}
@media screen and (max-width: 1000px) {
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
  .alu-bar-btn-toggle-active { color: var(--alu-blue); }
  .alu-bar-sep { margin: 0 1px; }
}
@media screen and (max-width: 600px) {
  .alu-bottom-bar-right { gap: 0; }
}
</style>
