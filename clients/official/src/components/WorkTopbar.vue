<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { FileDown, Wrench } from '@lucide/vue'
import { dockToolsState } from '../lib/dockTools'
import { formatCacheHitRate, formatContextUsage, formatTokenCount } from '../lib/uiBoundaries'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useDeliveriesStore } from '../stores/deliveries'
import { useOperationsStore } from '../stores/operations'
import { useSurfacesStore } from '../stores/surfaces'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const surfaces = useSurfacesStore()
const { deliveryOpen, dockToolsTrigger, dockToolsOpen } = storeToRefs(surfaces)
const { openControlCenter, openDockTools } = surfaces
const deliveries = useDeliveriesStore()
const { pendingDeliverableCount } = storeToRefs(deliveries)
const { openDeliveryTray } = deliveries
const operations = useOperationsStore()
const failureCount = computed(() => operations.listResults.length)
const selectedDockTools = computed(() => selected.value ? dockToolsState(selected.value.extensionStatus) : 'off')
const selectedDockToolsLabel = computed(() => selectedDockTools.value === 'on' ? 'ON' : selectedDockTools.value === 'unavailable' ? 'N/A' : 'OFF')
const modelLabel = computed(() => {
  const model = selected.value?.executor.model
  return model ? `${model.provider}/${model.id}` : '—'
})
const contextPercent = computed(() => selected.value?.metrics?.context?.percent)
const cacheHitRate = computed(() => formatCacheHitRate(selected.value?.metrics?.tokens))
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
      <div class="alu-nav-model-controls">
        <button class="alu-nav-selector alu-nav-selector-model" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('models')">
          <span class="alu-nav-selector-icon">◉</span>
          <span class="alu-nav-selector-label">model:</span>
          <span class="alu-nav-selector-value" :title="modelLabel"><span v-if="selected?.executor.model" class="alu-nav-model-provider">{{ selected.executor.model.provider }}/</span>{{ selected?.executor.model?.id || '—' }}</span>
          <span class="alu-nav-selector-arrow">▾</span>
        </button>
        <button class="alu-nav-selector alu-nav-selector-thinking" :disabled="!selected || selected.lifecycle !== 'active'" @click="openControlCenter('thinking')">
          <span class="alu-nav-selector-icon">⌁</span>
          <span class="alu-nav-selector-label">thinking:</span>
          <span class="alu-nav-selector-value">{{ selected?.executor.thinkingLevel || '—' }}</span>
          <span class="alu-nav-selector-arrow">▾</span>
        </button>
      </div>
      <button ref="dockToolsTrigger" class="alu-nav-dock-tools" :class="{ active: selectedDockTools === 'on', open: dockToolsOpen }" :disabled="!selected || selected.lifecycle !== 'active'" :aria-label="`Dock Tools ${selectedDockTools === 'on' ? '已开启' : selectedDockTools === 'unavailable' ? '当前不可用' : '已关闭'}`" aria-haspopup="dialog" :aria-expanded="dockToolsOpen" @click="openDockTools">
        <Wrench :size="13" />
        <span class="alu-nav-dock-tools-label">Dock Tools</span>
        <b>{{ selectedDockToolsLabel }}</b>
        <span class="alu-nav-dock-tools-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="alu-nav-stats">
        <span class="alu-nav-stat-pill alu-nav-stat-tokens">↑<span>{{ formatTokenCount(selected?.metrics?.tokens?.input || 0) }}</span></span>
        <span class="alu-nav-stat-pill alu-nav-stat-tokens">↓<span>{{ formatTokenCount(selected?.metrics?.tokens?.output || 0) }}</span></span>
        <span class="alu-nav-stat-pill" :class="{ 'text-token-warn': contextPercent != null && contextPercent > 70 && contextPercent <= 90, 'text-token-danger': contextPercent != null && contextPercent > 90 }"><span>{{ formatContextUsage(selected?.metrics?.context) }}</span></span>
        <span class="alu-nav-stat-pill alu-nav-stat-cache" title="当前 Session 缓存命中率" :aria-label="`缓存命中率 ${cacheHitRate}`">c<span>{{ cacheHitRate }}</span></span>
        <span class="alu-nav-stat-pill alu-nav-stat-cost"><span>${{ Number(selected?.metrics?.cost || 0).toFixed(2) }}</span></span>
      </div>
      <button type="button" class="alu-nav-files" aria-label="打开文件列表" :aria-expanded="deliveryOpen" @click="openDeliveryTray">
        <FileDown :size="17" />
        <span v-if="pendingDeliverableCount" class="alu-nav-files-badge">{{ pendingDeliverableCount > 99 ? '99+' : pendingDeliverableCount }}</span>
      </button>
      <button class="alu-nav-hamburger" :aria-label="failureCount ? `打开工作列表，有 ${failureCount} 项操作结果` : '打开工作列表'" @click="app.workDrawerOpen = true">☰<span v-if="failureCount" class="alu-operation-count">{{ failureCount }}</span></button>
    </div>
  </nav>

</template>

<style scoped>
/* ── 语义工具类 ── */
.text-token-danger { color: var(--alu-rose) !important; }
.text-token-warn { color: var(--alu-amber) !important; }
/* ═══════════════════════════════════════════════════════
   导航栏 (顶部)
   ═══════════════════════════════════════════════════════ */
.alu-navbar {
  height: var(--alu-nav-height);
  background: var(--alu-nav-bg);
  border-bottom: 1px solid var(--alu-nav-border);
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 12px;
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}
.alu-navbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  flex: 1;
}
.alu-navbar-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  border: 2px solid var(--alu-pink-border);
  box-shadow: 0 0 12px rgba(244, 114, 182, 0.45), 0 0 32px rgba(244, 114, 182, 0.14);
  transition: box-shadow 0.3s;
}
.alu-navbar-avatar:hover {
  box-shadow: 0 0 20px rgba(244, 114, 182, 0.65), 0 0 48px rgba(244, 114, 182, 0.22);
}
.alu-navbar-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 9px;
  margin-left: -9px;
  border: 1px solid transparent;
  border-radius: 9px;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.alu-navbar-breadcrumb:hover,
.alu-navbar-breadcrumb:focus-visible {
  outline: none;
  background: var(--alu-hover);
  border-color: var(--alu-border);
}
.alu-navbar-breadcrumb:disabled { cursor: default; }
.alu-navbar-breadcrumb:disabled:hover { background: transparent; border-color: transparent; }
.alu-nav-workspace {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--alu-text-dim);
  font-size: 15px;
  font-weight: 500;
  white-space: nowrap;
}
.alu-nav-sep {
  color: var(--alu-text-faint);
  font-size: 15px;
}
.alu-nav-session {
  color: var(--alu-text);
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}
.alu-nav-git-branch {
  max-width: 180px;
  overflow: hidden;
  padding: 3px 7px;
  border: 1px solid var(--alu-blue-border);
  border-radius: 999px;
  color: var(--alu-blue);
  font-size: 10px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alu-nav-git-branch[hidden] { display: none; }
.alu-navbar-breadcrumb-arrow { color: var(--alu-text-faint); font-size: 9px; }
.alu-navbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.alu-nav-model-controls {
  display: flex;
  align-items: center;
  gap: inherit;
  min-width: 0;
}
.alu-nav-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
}
.alu-nav-stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 5px 8px;
  border-radius: 999px;
  border: 1px solid var(--alu-border-light);
  background: rgba(16, 22, 35, 0.8);
  color: var(--alu-text-dim);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.alu-nav-selector {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 16px 7px 12px;
  border-radius: 999px;
  border: 1.5px solid var(--alu-border-light);
  background: rgba(20, 28, 46, 0.8);
  color: var(--alu-text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  min-width: 140px;
}
.alu-nav-selector:hover {
  border-color: var(--alu-pink-border);
  color: var(--alu-pink);
  background: var(--alu-pink-bg);
  box-shadow: 0 0 10px rgba(244, 114, 182, 0.18);
}
.alu-nav-selector-icon {
  opacity: 0.75;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.alu-nav-selector-label {
  color: var(--alu-text-muted);
  font-size: 12px;
}
.alu-nav-selector-value {
  color: var(--alu-text);
  font-weight: 600;
  flex: 1;
}
.alu-nav-selector:hover .alu-nav-selector-label,
.alu-nav-selector:hover .alu-nav-selector-value {
  color: var(--alu-pink);
}
.alu-nav-selector-arrow {
  color: var(--alu-text-muted);
  font-size: 11px;
  margin-left: 2px;
}
.alu-nav-dock-tools {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 9px;
  border: 1px solid var(--alu-border-light);
  border-radius: 999px;
  color: var(--alu-text-muted);
  background: rgba(20, 28, 46, .8);
  font-size: 10px;
  white-space: nowrap;
  transition: color .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease;
}
.alu-nav-dock-tools:hover,
.alu-nav-dock-tools.open {
  color: var(--alu-text);
  border-color: var(--alu-blue-border);
  background: var(--alu-blue-bg);
}
.alu-nav-dock-tools.open { box-shadow: 0 0 0 3px color-mix(in srgb, var(--alu-blue) 10%, transparent); }
.alu-nav-dock-tools b { min-width: 20px; color: var(--alu-text-faint); font-size: 8px; letter-spacing: .08em; text-align: center; }
.alu-nav-dock-tools.active { color: var(--alu-mint); border-color: color-mix(in srgb, var(--alu-mint) 32%, var(--alu-border)); background: color-mix(in srgb, var(--alu-mint) 7%, transparent); }
.alu-nav-dock-tools.active b { color: var(--alu-mint); }
.alu-nav-dock-tools-chevron { color: var(--alu-text-faint); font-size: 9px; transition: transform .14s ease; }
.alu-nav-dock-tools.open .alu-nav-dock-tools-chevron { transform: rotate(180deg); }
.alu-nav-hamburger {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1.5px solid var(--alu-border-light);
  background: rgba(20, 28, 46, 0.8);
  color: var(--alu-text-dim);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
}
.alu-nav-hamburger:hover {
  background: var(--alu-hover);
  border-color: var(--alu-border-focus);
  color: var(--alu-text);
}
/* ── 状态栏头像（用于旧版兼容）── */
.session-dot {
  box-shadow: 0 0 8px rgba(244, 114, 182, 0.45);
}
@media (max-width: 1399px) {
  .alu-navbar {
    height: var(--alu-nav-height);
    min-height: var(--alu-nav-height);
    flex-wrap: nowrap;
    gap: 6px;
    padding: 0 clamp(10px, 2.4vw, 20px);
  }
  .alu-navbar-left {
    width: auto;
    min-width: 0;
    flex: 1 1 auto;
    padding: 0;
  }
  .alu-navbar-avatar,
  .alu-nav-workspace,
  .alu-nav-sep,
  .alu-nav-git-branch,
  .alu-navbar-breadcrumb-arrow {
    display: none;
  }
  .alu-navbar-breadcrumb {
    width: 100%;
    min-width: 0;
    height: 44px;
    margin: 0;
    padding: 0 4px;
  }
  .alu-nav-session {
    display: block;
    min-width: 0;
    max-width: none;
    overflow: hidden;
    color: var(--alu-text);
    font: 650 14px/1.2 var(--font-reading);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .alu-navbar-right {
    width: auto;
    min-width: 0;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: 4px;
    padding: 0;
  }
  .alu-nav-hamburger {
    position: relative;
    top: auto;
    right: auto;
    width: 44px;
    height: 44px;
    border-radius: 11px;
  }
  /* 窄屏收缩但保留运行身份与统计（对齐 WebConsole 紧凑策略）：选择器去 label，
       模型值与统计胶囊收紧；更窄档位继续收敛。 */
  .alu-nav-selector { min-width: 0; padding: 5px 8px 5px 7px; gap: 4px; font-size: 11px; }
  .alu-nav-selector-label { display: none; }
  .alu-nav-selector-value { max-width: 64px; overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .alu-nav-selector-arrow { font-size: 9px; }
  .alu-nav-stats { display: inline-flex; gap: 4px; margin-left: 0; }
  .alu-nav-stat-pill { padding: 4px 6px; font-size: 10px; }
}
@media (max-width: 840px) {
  .alu-nav-dock-tools { min-width: 40px; justify-content: center; padding-inline: 7px; }
  .alu-nav-dock-tools-label,
  .alu-nav-dock-tools-chevron {
    display: none;
  }
  .alu-navbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    grid-template-areas: "work tools files menu" "models models models models" "stats stats stats stats";
    height: auto;
    min-height: 0;
    padding: 4px 10px 8px;
    gap: 0 6px;
  }
  .alu-navbar-left { grid-area: work; width: auto; padding: 0; }
  .alu-navbar-right { display: contents; }
  .alu-nav-session { max-width: none; }
  /* 手机上第二、三行合成一张状态卡：一圈边框，上半是模型｜思考等级两个整块可点的分段，
     下半是用量文字。桌面横排的胶囊样式不受影响。 */
  .alu-navbar::before {
    content: '';
    grid-row: models / stats;
    grid-column: 1 / -1;
    align-self: stretch;
    margin-top: 6px;
    border: 1px solid var(--alu-border-light);
    border-radius: 12px;
    background: rgba(20, 28, 46, 0.8);
  }
  .alu-nav-model-controls { grid-area: models; z-index: 1; min-height: 42px; margin-top: 6px; gap: 0; }
  .alu-nav-model-controls .alu-nav-selector {
    min-height: 42px;
    padding: 0 12px;
    gap: 7px;
    border: 0;
    border-radius: 12px 12px 0 0;
    background: transparent;
    font-size: 12px;
  }
  .alu-nav-model-controls .alu-nav-selector:hover { box-shadow: none; }
  .alu-nav-model-controls .alu-nav-selector-value { max-width: none; font-size: 12px; text-align: left; }
  .alu-nav-selector-model { flex: 1 1 0; min-width: 0; }
  .alu-nav-model-provider { color: var(--alu-text-dim); font-weight: 500; }
  .alu-nav-selector-thinking { flex: 0 0 auto; border-left: 1px solid var(--alu-border-light); }
  .alu-nav-stats {
    grid-area: stats;
    z-index: 1;
    min-width: 0;
    min-height: 30px;
    padding: 0 12px;
    gap: 12px;
    border-top: 1px solid var(--alu-border-light);
  }
  .alu-nav-stat-pill { padding: 0; border: 0; border-radius: 0; background: transparent; font-size: 11px; }
  .alu-nav-stat-tokens { display: none; }
  .alu-nav-stat-cache { gap: 3px; color: var(--alu-text-muted); }
  .alu-nav-stat-cost { margin-left: auto; color: var(--alu-text); }
  .alu-navbar .alu-nav-dock-tools { grid-area: tools; width: 53px; min-height: 40px; }
  .alu-navbar .alu-nav-files { grid-area: files; }
  .alu-navbar .alu-nav-hamburger { grid-area: menu; }
  .alu-navbar .alu-nav-files,
  .alu-nav-hamburger {
    width: 40px;
    height: 40px;
    border-radius: 9px;
  }
}
@media (max-width: 640px) {
  .alu-nav-session { font-size: 13px; }
}
.alu-nav-selector:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
@media (min-width: 1400px) {
  .alu-nav-workspace,
  .alu-nav-sep,
  .alu-nav-session,
  .alu-nav-selector {
    font-size: var(--alu-control-size);
  }
  .alu-nav-selector-model { min-width: 260px; }
  .alu-nav-selector-value { min-width: 0; }
  .alu-nav-selector-label,
  .alu-nav-stat-pill {
    font-size: var(--alu-meta-size);
  }
}
.alu-operation-count { margin-left: 3px; color: var(--alu-rose); font-size: 10px; }
.alu-nav-files { position: relative; display: inline-grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; padding: 0; color: var(--alu-text-muted); border: 1px solid transparent; border-radius: 8px; background: transparent; cursor: pointer; }
.alu-nav-files:hover, .alu-nav-files[aria-expanded="true"] { color: var(--alu-blue); border-color: var(--alu-blue-border); background: color-mix(in srgb, var(--alu-blue) 7%, transparent); }
.alu-nav-files:focus-visible { outline: 2px solid var(--alu-blue); outline-offset: 2px; }
@media (max-width: 1399px) {
  .alu-nav-files { width: 44px; height: 44px; border-radius: 11px; }
}
.alu-nav-files-badge { position: absolute; top: -4px; right: -5px; display: grid; min-width: 17px; height: 17px; place-items: center; padding: 0 4px; color: #07101d; border: 2px solid var(--alu-bg); border-radius: 999px; background: var(--alu-mint); font: 800 8px/1 var(--font-code); }
</style>
