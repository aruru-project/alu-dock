<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { Settings, X } from '@lucide/vue'
import { isTauri } from '../lib/bridge'
import { workPresence } from '../lib/uiBoundaries'
import OperationResults from './OperationResults.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useHostStore } from '../stores/host'
import { useObservationStore } from '../stores/observation'
import { useOperationsStore } from '../stores/operations'
import { usePlatformStore } from '../stores/platform'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const workActions = useWorkActionsStore()
const { machineListError, groupedWorks, workMutating, globalOutcomeUnknown, globalReconciling, globalReconcileMessage } = storeToRefs(workActions)
const { workMachineTag, selectWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory, reconcileGlobalOutcome } = workActions
const { directoryOpen } = storeToRefs(useSurfacesStore())
const host = useHostStore()
const { pairingInProgress } = storeToRefs(host)
const { openHostSettings } = host
const platform = usePlatformStore()
const { appSettings, windowsAwayLabel } = storeToRefs(platform)
const { openAppSettings } = platform
const operations = useOperationsStore()
const { listResults } = storeToRefs(operations)
const { consumeNativeOperation } = operations
const { label: connectionLabel } = storeToRefs(useObservationStore())
</script>

<template>
  <button class="alu-sidebar-overlay" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :tabindex="app.workDrawerOpen ? 0 : -1" aria-label="关闭工作列表" @click="app.workDrawerOpen = false" />
  <aside class="alu-sidebar" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :inert="!app.workDrawerOpen || undefined" aria-label="工作列表">
    <div class="alu-sidebar-head">
      <img :src="dockIconUrl" class="alu-sidebar-avatar" alt="Alu Dock" />
      <div class="alu-sidebar-title">AluDock Client</div>
      <button class="alu-sidebar-refresh" title="刷新" @click="refreshWorkDrawer">↻</button>
      <button class="alu-sidebar-close" aria-label="关闭工作列表" @click="app.workDrawerOpen = false"><X :size="18" /></button>
    </div>
    <div class="alu-sidebar-actions"><button class="alu-new-work-btn" :disabled="pairingInProgress" @click="openDirectory">＋ 新建工作</button></div>
    <div class="alu-instance-list">
      <OperationResults v-if="listResults.length && !directoryOpen" :operations="listResults" :acknowledge="consumeNativeOperation" />
      <div v-if="globalOutcomeUnknown || globalReconcileMessage" class="alu-sidebar-notice" role="status">
        <span>{{ globalReconcileMessage || '上一次新建工作的结果还没有确认。刷新列表查看它是否已经出现，不要重复提交。' }}</span>
        <button v-if="globalOutcomeUnknown" :disabled="globalReconciling" @click="reconcileGlobalOutcome">{{ globalReconciling ? '正在刷新…' : '刷新确认' }}</button>
      </div>
      <div v-if="machineListError" class="alu-sidebar-error">{{ machineListError }}</div>
      <section v-for="group in (['current', 'continue', 'history'] as const)" :key="group" v-show="groupedWorks[group].length" class="alu-instance-group">
        <div class="alu-instance-group-title">{{ group === 'current' ? '当前工作' : group === 'continue' ? '可以继续' : '历史工作' }}<span>{{ groupedWorks[group].length }}</span></div>
        <div v-for="work in groupedWorks[group]" :key="work.id" class="alu-instance-row" :class="{ 'is-selected': work.id === selected?.id }">
          <button class="alu-instance-link" @click="selectWork(work.id)">
            <span class="alu-instance-state" :class="`is-${workPresence(work).tone}`" />
            <span class="alu-instance-copy"><span class="alu-instance-name">{{ work.displayName }}</span><span v-if="workMachineTag(work)" class="alu-instance-machine-tag">{{ workMachineTag(work) }}</span><span class="alu-instance-cwd">{{ work.cwd.split('/').filter(Boolean).slice(-2).join('/') }}</span></span>
            <span class="alu-instance-meta">{{ workPresence(work).label }}</span>
          </button>
          <button v-if="work.reopenable && work.lifecycle !== 'active'" class="alu-instance-action" :disabled="!isTauri || (work.id === selected?.id && workMutating)" @click="reopenFromList(work)">{{ workMutating && selected?.id === work.id ? '正在继续…' : '继续' }}</button>
          <button v-else-if="group === 'history'" class="alu-instance-action is-muted" :disabled="!isTauri" @click="forgetFromList(work)">移除</button>
        </div>
      </section>
      <div v-if="!app.works.length" class="alu-sidebar-empty">暂无工作</div>
    </div>
    <button v-if="appSettings?.windowsAwaySupported" class="alu-sidebar-settings-entry" aria-label="App 设置" @click="openAppSettings">
      <span class="alu-sidebar-settings-icon"><Settings :size="17" /></span>
      <span><strong>App 设置</strong><small>{{ windowsAwayLabel }}</small></span>
      <span aria-hidden="true">›</span>
    </button>
    <button class="alu-sidebar-settings-entry" aria-label="Host 与配对设置" @click="openHostSettings">
      <img :src="dockIconUrl" alt="" />
      <span><strong>{{ app.localSelected ? '本机 AluDock' : app.activeHost?.displayName || '连接 AluDock' }}</strong><small>{{ connectionLabel }}</small></span>
      <span aria-hidden="true">⚙</span>
    </button>
  </aside>

</template>

<style scoped>
.alu-sidebar-actions {
  padding: 10px 12px;
  border-bottom: 1px solid var(--alu-border);
}
.alu-new-work-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--alu-pink-border);
  border-radius: 9px;
  background: var(--alu-pink-bg);
  color: var(--alu-pink);
  font-size: 12px;
  font-weight: 650;
  transition: border-color 0.15s, background 0.15s;
}
.alu-new-work-btn:hover { border-color: var(--alu-pink); background: color-mix(in srgb, var(--alu-pink-bg) 72%, var(--alu-hover)); }
.alu-sidebar-refresh,
.alu-sidebar-close {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  place-items: center;
  color: var(--alu-text-muted);
  border-radius: 9px;
}
.alu-sidebar-refresh:hover,
.alu-sidebar-close:hover {
  color: var(--alu-text);
  background: var(--alu-hover);
}
.alu-instance-group { padding: 8px 7px 4px; }
.alu-instance-group-title {
  display: flex;
  justify-content: space-between;
  padding: 5px 7px;
  color: var(--alu-text-faint);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.alu-instance-group-title span { letter-spacing: 0; }
.alu-instance-row {
  position: relative;
  margin: 2px 0;
  border: 1px solid transparent;
  border-radius: 9px;
  overflow: hidden;
}
.alu-instance-row:hover { background: var(--alu-hover); }
.alu-instance-row.is-selected { background: var(--alu-pink-bg); border-color: var(--alu-pink-border); }
.alu-instance-link { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 9px 8px; padding-right: 48px; }
.alu-instance-state { width: 7px; height: 7px; border-radius: 50%; background: var(--alu-text-faint); flex-shrink: 0; }
/* idle 仅保留对齐占位；running 绿呼吸，其余待处理或异常状态保留语义色。 */
.alu-instance-state.is-running { background: var(--alu-mint); box-shadow: 0 0 6px rgba(52, 211, 153, 0.45); animation: aluInstancePulse 1.6s ease-in-out infinite; }
.alu-instance-state.is-idle { visibility: hidden; }
.alu-instance-state.is-waiting { background: var(--alu-pink); box-shadow: 0 0 6px var(--alu-pink-border); }
.alu-instance-state.is-compacting { background: var(--alu-amber); animation: aluInstancePulse 1.6s ease-in-out infinite; }
.alu-instance-state.is-stopping { background: var(--alu-amber); }
.alu-instance-state.is-failed,
.alu-instance-state.is-error {
  background: var(--alu-rose);
}
.alu-instance-state.is-lost { background: var(--alu-blue-dim); }
@media (prefers-reduced-motion: reduce) {
  .alu-instance-state.is-running,
  .alu-instance-state.is-compacting {
    animation: none;
  }
}
.alu-instance-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.alu-instance-name { color: var(--alu-text); font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-instance-machine-tag {
  display: block;
  max-width: 100%;
  align-self: flex-start;
  overflow: hidden;
  margin: 3px 0 1px;
  padding: 1px 6px;
  border: 1px solid var(--alu-border);
  border-radius: 5px;
  background: var(--alu-active);
  color: var(--alu-pink);
  font: 9px/1.45 var(--alu-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alu-instance-cwd { color: var(--alu-text-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-instance-meta { color: var(--alu-text-faint); font-size: 10px; }
.alu-instance-action {
  position: absolute;
  right: 7px;
  bottom: 7px;
  color: var(--alu-blue);
  font-size: 9px;
  padding: 2px 4px;
}
.alu-instance-action.is-muted { color: var(--alu-text-muted); }
.alu-instance-action:hover { color: var(--alu-text); }
.alu-sidebar-empty,
.alu-sidebar-error {
  padding: 24px 16px;
  color: var(--alu-text-muted);
  font-size: 11px;
}
.alu-sidebar-error { color: var(--alu-rose); }
.alu-sidebar-notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 12px 0; padding: 7px 10px; color: var(--alu-amber); border: 1px solid color-mix(in srgb, var(--alu-amber) 22%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--alu-amber) 7%, transparent); font-size: 10px; }
.alu-sidebar-notice button { flex: none; color: inherit; }
@media (max-width: 640px) {
  .alu-instance-link { padding-top: 10px; padding-bottom: 10px; }
}
.alu-sidebar { position: fixed; z-index: 50; inset: 0 auto 0 0; display: flex; width: 300px; max-width: 88vw; flex-direction: column; overflow: hidden; border-right: 1px solid var(--alu-border); background: var(--alu-bg); box-shadow: 4px 0 24px rgba(0, 0, 0, .5); transform: translateX(-100%); transition: transform .25s cubic-bezier(.4, 0, .2, 1); }
.alu-sidebar.open { transform: translateX(0); }
.alu-sidebar-overlay { position: fixed; z-index: 49; inset: 0; padding: 0; pointer-events: none; opacity: 0; border: 0; background: rgba(6, 8, 14, .82); transition: opacity .25s ease; }
.alu-sidebar-overlay.open { pointer-events: auto; opacity: 1; }
.alu-sidebar-head { display: flex; min-height: 70px; flex: 0 0 auto; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--alu-border); }
.alu-sidebar-avatar { width: 40px; height: 40px; flex: 0 0 auto; object-fit: cover; border: 2px solid var(--alu-pink-border); border-radius: 50%; }
.alu-sidebar-title { min-width: 0; flex: 1; overflow: hidden; color: var(--alu-text); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.alu-instance-list { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
.alu-instance-link { width: 100%; border: 0; background: transparent; text-align: left; }
.alu-sidebar-settings-entry { display: grid; min-height: 58px; flex: 0 0 auto; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; padding: 9px 14px; border: 0; border-top: 1px solid var(--alu-border); background: var(--alu-bg); color: var(--alu-text-muted); text-align: left; }
.alu-sidebar-settings-entry:last-child { padding-bottom: max(9px, env(safe-area-inset-bottom)); }
.alu-sidebar-settings-entry:hover { background: var(--alu-hover); color: var(--alu-text); }
.alu-sidebar-settings-icon, .alu-sidebar-settings-entry img { display: grid; width: 32px; height: 32px; object-fit: cover; border-radius: 8px; place-items: center; }
.alu-sidebar-settings-icon { border: 1px solid var(--alu-blue-border); background: var(--alu-blue-bg); color: var(--alu-blue); }
.alu-sidebar-settings-entry > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.alu-sidebar-settings-entry strong, .alu-sidebar-settings-entry small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-sidebar-settings-entry strong { color: var(--alu-text); font-size: 11px; }
.alu-sidebar-settings-entry small { color: var(--alu-text-muted); font-size: 9px; }
.alu-sidebar {
  top: var(--aludock-inset-top);
  bottom: max(var(--aludock-inset-bottom), var(--aludock-ime-bottom));
  left: var(--aludock-inset-left);
}
@media (max-width: 1000px) {
  .alu-sidebar {
    width: min(390px, 100%);
    max-width: 100%;
  }
}
</style>
