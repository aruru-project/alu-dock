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
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'abortCurrentRun' | 'aborting' | 'mutationOutcomeUnknown' | 'workMutating'>>
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'label' | 'refreshCurrent' | 'status'>>
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'openHostSettings'>>
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { workspaceBrowserOpen, openControlCenter } = props.page
const { draftAttachments, uploadDrafts, attachmentPicking, maxMessageAttachments, chooseAttachments } = props.uploads
const { aborting, workMutating, mutationOutcomeUnknown, abortCurrentRun } = props.actions
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
        <button class="alu-bar-btn alu-bar-btn-abort" :disabled="!isTauri || aborting || workMutating || mutationOutcomeUnknown || selected?.execution !== 'running'" @click="abortCurrentRun">⏹<span class="sm-inline">{{ aborting ? '中止中' : '中止' }}</span></button>
      </div>
    </div>

</template>
