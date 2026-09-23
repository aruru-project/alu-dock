<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { computed } from 'vue'
import { FileDown, Wrench } from '@lucide/vue'
import { dockToolsState } from '../lib/dockTools'
import { formatContextUsage, formatTokenCount } from '../lib/uiBoundaries'
import type { useDeliveries } from '../lib/deliveries'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'deliveryOpen' | 'dockToolsOpen' | 'openControlCenter' | 'openDockTools'>> & Pick<ReturnType<typeof usePageSurfaces>, 'dockToolsTrigger'>
  deliveries: ReadonlyRefs<Pick<ReturnType<typeof useDeliveries>, 'openDeliveryTray' | 'pendingDeliverableCount'>>
  failureCount: number
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { deliveryOpen, dockToolsTrigger, dockToolsOpen, openControlCenter, openDockTools } = props.page
const { pendingDeliverableCount, openDeliveryTray } = props.deliveries
const selectedDockTools = computed(() => selected.value ? dockToolsState(selected.value.extensionStatus) : 'off')
const selectedDockToolsLabel = computed(() => selectedDockTools.value === 'on' ? 'ON' : selectedDockTools.value === 'unavailable' ? 'N/A' : 'OFF')
const modelLabel = computed(() => {
  const model = selected.value?.executor.model
  return model ? `${model.provider}/${model.id}` : '—'
})
const contextPercent = computed(() => selected.value?.metrics?.context?.percent)
</script>

<template>
  <nav class="alu-navbar select-none">
    <div class="alu-navbar-left">
      <img :src="dockIconUrl" class="alu-navbar-avatar session-dot" alt="Alu Dock" />
      <button type="button" class="alu-navbar-breadcrumb" title="查看项目状态" aria-label="查看项目状态" :disabled="!selected" @click="openControlCenter('resources')">
        <span v-if="!app.needsPairing" class="alu-nav-workspace">{{ selected ? selected.cwd.split('/').filter(Boolean).slice(-2).join('/') : 'AluDock' }}</span>
        <span v-if="!app.needsPairing" class="alu-nav-sep">/</span>
        <span class="alu-nav-session">{{ app.needsPairing ? 'AluDock' : selected?.name || selected?.displayName || '选择 Work' }}</span>
        <span v-if="selected?.gitBranch" class="alu-nav-git-branch"> {{ selected.gitBranch }}</span>
        <span class="alu-navbar-breadcrumb-arrow" aria-hidden="true">▾</span>
      </button>
    </div>

    <div v-if="!app.needsPairing" class="alu-navbar-right">
      <button class="alu-nav-selector alu-nav-selector-model" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('models')">
        <span class="alu-nav-selector-icon">◉</span>
        <span class="alu-nav-selector-label">model:</span>
        <span class="alu-nav-selector-value" :data-provider="selected?.executor.model?.provider || '—'" :title="modelLabel">{{ modelLabel }}</span>
        <span class="alu-nav-selector-arrow">▾</span>
      </button>
      <button class="alu-nav-selector" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('thinking')">
        <span class="alu-nav-selector-icon">⌁</span>
        <span class="alu-nav-selector-label">thinking:</span>
        <span class="alu-nav-selector-value">{{ selected?.executor.thinkingLevel || '—' }}</span>
        <span class="alu-nav-selector-arrow">▾</span>
      </button>
      <button ref="dockToolsTrigger" class="alu-nav-dock-tools" :class="{ active: selectedDockTools === 'on', open: dockToolsOpen }" :disabled="!selected || selected.lifecycle !== 'active'" :aria-label="`Dock Tools ${selectedDockTools === 'on' ? '已开启' : selectedDockTools === 'unavailable' ? '当前不可用' : '已关闭'}`" aria-haspopup="dialog" :aria-expanded="dockToolsOpen" @click="openDockTools">
        <Wrench :size="13" />
        <span class="alu-nav-dock-tools-label">Dock Tools</span>
        <b>{{ selectedDockToolsLabel }}</b>
        <span class="alu-nav-dock-tools-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="alu-nav-stats">
        <span class="alu-nav-stat-pill">↑<span>{{ formatTokenCount(selected?.metrics?.tokens?.input || 0) }}</span></span>
        <span class="alu-nav-stat-pill">↓<span>{{ formatTokenCount(selected?.metrics?.tokens?.output || 0) }}</span></span>
        <span class="alu-nav-stat-pill" :class="{ 'text-token-warn': contextPercent != null && contextPercent > 70 && contextPercent <= 90, 'text-token-danger': contextPercent != null && contextPercent > 90 }"><span>{{ formatContextUsage(selected?.metrics?.context) }}</span></span>
        <span class="alu-nav-stat-pill"><span>${{ Number(selected?.metrics?.cost || 0).toFixed(2) }}</span></span>
      </div>
      <button type="button" class="alu-nav-files" aria-label="打开文件列表" :aria-expanded="deliveryOpen" @click="openDeliveryTray">
        <FileDown :size="17" />
        <span v-if="pendingDeliverableCount" class="alu-nav-files-badge">{{ pendingDeliverableCount > 99 ? '99+' : pendingDeliverableCount }}</span>
      </button>
      <button class="alu-nav-hamburger" :aria-label="props.failureCount ? `打开工作列表，有 ${props.failureCount} 项操作结果` : '打开工作列表'" @click="app.workDrawerOpen = true">☰<span v-if="props.failureCount" class="alu-operation-count">{{ props.failureCount }}</span></button>
    </div>
  </nav>

</template>
