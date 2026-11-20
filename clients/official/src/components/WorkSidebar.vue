<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { Server, Settings, Sparkles, X } from '@lucide/vue'
import { isTauri } from '../lib/bridge'
import { childNeedsStop, isResidentAssistant, workPresence } from '../lib/uiBoundaries'
import OperationResults from './OperationResults.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import { useAssistantSearchStore } from '../stores/assistant-search'
import { useHostStore } from '../stores/host'
import { useObservationStore } from '../stores/observation'
import { useOperationsStore } from '../stores/operations'
import { usePlatformStore } from '../stores/platform'
import { useSurfacesStore } from '../stores/surfaces'
import { useWorkActionsStore } from '../stores/work-actions'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const workActions = useWorkActionsStore()
const { machineListError, groupedWorks, workMutating } = storeToRefs(workActions)
const { workMachineTag, selectWork, stopSelectedWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory, openMachineSettings, openAssistant } = workActions
const assistant = useAssistantStore()
const assistantMemory = useAssistantMemoryStore()
const assistantSearch = useAssistantSearchStore()
const resident = computed(() => app.works.find(isResidentAssistant))
const listedWorkCount = computed(() => Object.values(groupedWorks.value).reduce((total, works) => total + works.length, 0))
function groupTitle(group: keyof typeof groupedWorks.value) {
  return group === 'assistant' ? `${resident.value?.displayName || '助手'}的子工作`
    : group === 'current' ? '当前工作' : group === 'continue' ? '可以继续' : '历史工作'
}
function openResident() {
  if (resident.value) selectWork(resident.value.id)
  else openAssistant()
}
const { directoryOpen } = storeToRefs(useSurfacesStore())
const host = useHostStore()
const { pairingInProgress } = storeToRefs(host)
const { openHostSettings } = host
const platform = usePlatformStore()
const { appSettings, themeLabel, windowsAwayLabel } = storeToRefs(platform)
const { openAppSettings } = platform
const appSettingsSummary = computed(() => [`配色：${themeLabel.value}`, ...(appSettings.value?.windowsAwaySupported ? [windowsAwayLabel.value] : [])].join(' · '))
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
      <button class="alu-sidebar-refresh" :class="{ spinning: app.loading }" :title="app.loading ? '正在刷新工作列表' : '刷新工作列表'" :aria-label="app.loading ? '正在刷新工作列表' : '刷新工作列表'" :disabled="app.loading" @click="refreshWorkDrawer">↻</button>
      <button class="alu-sidebar-close" aria-label="关闭工作列表" @click="app.workDrawerOpen = false"><X :size="18" /></button>
    </div>
    <button v-if="resident || (app.connectionContext && assistant.available)" type="button" class="alu-assistant-identity" :class="{ 'is-selected': resident && resident.id === selected?.id }" :aria-label="resident ? `打开${resident.displayName}的对话` : '助手'" :aria-current="resident && resident.id === selected?.id ? 'page' : undefined" @click="openResident">
      <span class="alu-assistant-icon" aria-hidden="true"><Sparkles :size="22" /></span>
      <span class="alu-assistant-heading">
        <span class="alu-assistant-name">{{ resident?.displayName || assistant.identity.current || 'alu' }}</span>
        <span v-if="resident" class="alu-instance-state" :class="`is-${workPresence(resident).tone}`" aria-hidden="true" />
      </span>
      <span class="alu-assistant-model"><template v-if="resident?.executor.model">{{ resident.executor.model.provider }}/<wbr><span>{{ resident.executor.model.id }}</span></template><template v-else>{{ resident ? '未选择模型' : '正在读取…' }}</template></span>
    </button>
    <div class="alu-sidebar-actions"><button class="alu-new-work-btn" :disabled="pairingInProgress" @click="openDirectory">＋ 新建工作</button></div>
    <div class="alu-instance-list">
      <div v-if="app.error && app.works.length" class="alu-sidebar-refresh-error" role="alert">
        <span>工作列表没有刷新，下面可能不是最新状态。{{ app.error }}</span>
        <button :disabled="app.loading" @click="refreshWorkDrawer">{{ app.loading ? '正在刷新…' : '重试' }}</button>
      </div>
      <OperationResults v-if="listResults.length && !directoryOpen" :operations="listResults" :acknowledge="consumeNativeOperation" />
      <div v-if="machineListError" class="alu-sidebar-error">{{ machineListError }}</div>
      <section v-for="group in (['assistant', 'current', 'continue', 'history'] as const)" :key="group" v-show="groupedWorks[group].length" class="alu-instance-group" :aria-label="groupTitle(group)">
        <div class="alu-instance-group-title">{{ groupTitle(group) }}<span>{{ groupedWorks[group].length }}</span></div>
        <div v-for="work in groupedWorks[group]" :key="work.id" class="alu-instance-row" :class="{ 'is-selected': work.id === selected?.id, 'is-child': !!work.parentId }">
          <button class="alu-instance-link" :aria-label="`${work.displayName}，${workPresence(work).label}`" @click="selectWork(work.id)">
            <span class="alu-instance-state" :class="`is-${workPresence(work).tone}`" />
            <span class="alu-instance-copy"><span class="alu-instance-name"><span v-if="work.assistant" class="alu-instance-assistant-tag">助手</span>{{ work.displayName }}</span><span v-if="work.parentId && !app.works.some(parent => parent.id === work.parentId)" class="alu-instance-note">父 Work 已不在列表中，仍可查看或停止这个子 Work</span><span v-if="workMachineTag(work)" class="alu-instance-machine-tag">{{ workMachineTag(work) }}</span><span class="alu-instance-cwd">{{ work.cwd.split('/').filter(Boolean).slice(-2).join('/') }}</span><span class="alu-instance-model"><template v-if="work.executor.model">{{ work.executor.model.provider }}/<wbr><span class="alu-instance-model-id">{{ work.executor.model.id }}</span></template><template v-else>未选择模型</template></span></span>
          </button>
          <button v-if="childNeedsStop(work)" class="alu-instance-action" :disabled="!isTauri || workMutating" @click="selectWork(work.id); stopSelectedWork()">停止</button>
          <button v-else-if="work.reopenable && work.lifecycle !== 'active'" class="alu-instance-action" :disabled="!isTauri || (work.id === selected?.id && workMutating)" @click="reopenFromList(work)">{{ workMutating && selected?.id === work.id ? '正在继续…' : '继续' }}</button>
          <button v-else-if="group === 'history'" class="alu-instance-action is-muted" :disabled="!isTauri" @click="forgetFromList(work)">移除</button>
        </div>
      </section>
      <template v-if="!listedWorkCount">
        <div v-if="app.loading" class="alu-sidebar-empty" role="status">正在读取工作列表…</div>
        <div v-else-if="app.error" class="alu-sidebar-offline" role="alert">
          <strong>无法读取工作列表</strong>
          <span>{{ app.error }}</span>
          <div><button @click="refreshWorkDrawer">重新连接</button><button @click="openHostSettings">连接与配对</button></div>
        </div>
        <div v-else class="alu-sidebar-empty">暂无工作</div>
      </template>
    </div>
    <button class="alu-sidebar-settings-entry" aria-label="App 设置" @click="openAppSettings">
      <span class="alu-sidebar-settings-icon"><Settings :size="17" /></span>
      <span><strong>App 设置</strong><small>{{ appSettingsSummary }}</small></span>
      <span aria-hidden="true">›</span>
    </button>
    <button v-if="app.connectionContext && assistant.available" class="alu-sidebar-settings-entry" aria-label="助手" @click="openAssistant()">
      <span class="alu-sidebar-settings-icon"><Sparkles :size="17" /></span>
      <span><strong>助手</strong><small>{{ assistant.hasDrafts || assistantMemory.hasDrafts || assistantMemory.hasSettingsDrafts || assistantSearch.hasDrafts ? '有改动还没有保存' : '人设、记忆和过去的对话' }}</small></span>
      <span aria-hidden="true">›</span>
    </button>
    <button v-if="app.connectionContext" class="alu-sidebar-settings-entry" aria-label="Host 设置" @click="openMachineSettings()">
      <span class="alu-sidebar-settings-icon"><Server :size="17" /></span>
      <span><strong>Host 设置</strong><small>模型显示和子 Work 模型</small></span>
      <span aria-hidden="true">›</span>
    </button>
    <button class="alu-sidebar-settings-entry" aria-label="连接与配对" @click="openHostSettings">
      <img :src="dockIconUrl" alt="" />
      <span><strong>{{ app.localSelected ? '本机 AluDock' : app.activeHost?.displayName || '连接 AluDock' }}</strong><small>{{ connectionLabel }}</small></span>
      <span aria-hidden="true">⚙</span>
    </button>
  </aside>

</template>

<style scoped>
.alu-assistant-identity { position: relative; display: grid; flex: none; grid-template-columns: 40px minmax(0, 1fr); column-gap: 12px; width: 100%; padding: 10px 16px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; }
.alu-assistant-identity:hover { background: var(--alu-hover); }
.alu-assistant-identity.is-selected { background: var(--alu-nav-bg); }
.alu-assistant-identity.is-selected::before { content: ''; position: absolute; top: 14px; bottom: 14px; left: 0; width: 2px; background: var(--alu-highlight); border-radius: 0 2px 2px 0; }
.alu-assistant-icon { grid-row: 1 / 3; display: grid; place-items: center; color: var(--alu-accent); }
.alu-assistant-heading { display: flex; min-width: 0; align-items: center; }
.alu-assistant-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-width: 0; padding: 2px 0; color: var(--alu-text); font-size: 14px; font-weight: 650; line-height: 1.5; text-align: left; overflow-wrap: anywhere; }
.alu-assistant-model { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; grid-column: 2; min-width: 0; padding: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.5; text-align: left; overflow-wrap: anywhere; }
.alu-assistant-model span { color: var(--alu-model-name); }
.alu-sidebar-actions {
  padding: 10px 12px;
  border-bottom: 1px solid var(--alu-border);
}
.alu-new-work-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--alu-highlight-border);
  border-radius: 9px;
  background: var(--alu-highlight-bg);
  color: var(--alu-highlight);
  font-size: var(--alu-ui-size);
  font-weight: 650;
  transition: border-color 0.15s, background 0.15s;
}
.alu-new-work-btn:hover:where(:not(:disabled)) { color: var(--alu-highlight-hover-text); border-color: var(--alu-highlight-hover-border); background: var(--alu-highlight-hover-bg); }
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
  gap: 8px;
  overflow-wrap: anywhere;
  padding: 5px 7px;
  color: var(--alu-text-faint);
  font-size: var(--alu-meta-size);
  font-weight: 800;
  letter-spacing: 0.14em;
}
.alu-instance-group-title span { flex: none; letter-spacing: 0; }
.alu-instance-row {
  position: relative;
  margin: 2px 0;
  border: 1px solid transparent;
  border-radius: 9px;
  overflow: hidden;
}
.alu-instance-row.is-child { margin-left: 18px; }
.alu-instance-row:hover { background: var(--alu-hover); }
.alu-instance-row.is-selected { background: var(--alu-highlight-bg); border-color: var(--alu-highlight-border); }
.alu-instance-link { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 9px 8px; padding-right: 48px; }
.alu-instance-state { width: 7px; height: 7px; border-radius: 50%; background: var(--alu-text-faint); flex-shrink: 0; }
/* idle 仅保留对齐占位；running 绿呼吸，其余待处理或异常状态保留语义色。 */
.alu-instance-state.is-running { background: var(--alu-running); box-shadow: 0 0 6px var(--alu-running-glow); animation: aluInstancePulse 1.6s ease-in-out infinite; }
.alu-instance-state.is-idle { visibility: hidden; }
.alu-instance-state.is-waiting { background: var(--alu-waiting); box-shadow: 0 0 6px var(--alu-waiting-glow); }
.alu-instance-state.is-compacting { background: var(--alu-warning); animation: aluInstancePulse 1.6s ease-in-out infinite; }
.alu-instance-state.is-stopping { background: var(--alu-warning); }
.alu-instance-state.is-failed,
.alu-instance-state.is-error {
  background: var(--alu-danger);
}
.alu-instance-state.is-lost { background: var(--alu-accent-dim); }
@media (prefers-reduced-motion: reduce) {
  .alu-instance-state.is-running,
  .alu-instance-state.is-compacting {
    animation: none;
  }
}
.alu-instance-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.alu-instance-name { color: var(--alu-text); font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.alu-instance-assistant-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border: 1px solid var(--alu-accent-border);
  border-radius: 5px;
  color: var(--alu-accent);
  font-size: var(--alu-micro-size);
  font-weight: 600;
  line-height: 1.5;
  vertical-align: 1px;
}
.alu-instance-machine-tag {
  display: block;
  max-width: 100%;
  align-self: flex-start;
  overflow: hidden;
  margin: 3px 0 1px;
  padding: 1px 6px;
  border: 1px solid var(--alu-border);
  border-radius: 5px;
  background: var(--alu-tag-bg);
  color: var(--alu-highlight);
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alu-instance-cwd, .alu-instance-note { color: var(--alu-text-muted); font-size: var(--alu-meta-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 模型名总是完整显示：provider 说明走哪家的钱，同一家的模型常常只差尾号。provider 保持灰色，模型名用冰蓝和目录区分。 */
.alu-instance-model { color: var(--alu-text-muted); font-size: var(--alu-meta-size); overflow-wrap: anywhere; }
.alu-instance-model-id { color: var(--alu-model-name); }
.alu-instance-action {
  position: absolute;
  right: 7px;
  bottom: 7px;
  color: var(--alu-accent);
  font-size: var(--alu-micro-size);
  padding: 2px 4px;
}
.alu-instance-action.is-muted { color: var(--alu-text-muted); }
.alu-instance-action:hover { color: var(--alu-text); }
.alu-sidebar-empty,
.alu-sidebar-error {
  padding: 24px 16px;
  color: var(--alu-text-muted);
  font-size: var(--alu-meta-size);
}
.alu-sidebar-error { color: var(--alu-danger); }
.alu-sidebar-refresh:disabled { cursor: default; opacity: .6; }
.alu-sidebar-refresh.spinning { animation: aluSidebarSpin 1s linear infinite; }
@keyframes aluSidebarSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .alu-sidebar-refresh.spinning { animation: none; } }
.alu-sidebar-refresh-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 12px 0; padding: 7px 10px; color: var(--alu-danger); border: 1px solid var(--alu-danger-border); border-radius: 8px; background: var(--alu-danger-bg); font-size: var(--alu-meta-size); }
.alu-sidebar-refresh-error button { flex: none; color: inherit; }
.alu-sidebar-offline { display: flex; flex-direction: column; gap: 6px; margin: 12px; padding: 12px; color: var(--alu-text-muted); border: 1px solid var(--alu-danger-border); border-radius: 9px; background: var(--alu-danger-bg); font-size: var(--alu-meta-size); line-height: 1.5; }
.alu-sidebar-offline strong { color: var(--alu-danger); font-size: var(--alu-ui-size); }
.alu-sidebar-offline div { display: flex; gap: 12px; margin-top: 2px; }
.alu-sidebar-offline button { color: var(--alu-accent); font-size: var(--alu-meta-size); }
@media (max-width: 640px) {
  .alu-instance-link { padding-top: 10px; padding-bottom: 10px; }
}
.alu-sidebar { position: fixed; z-index: 50; inset: 0 auto 0 0; display: flex; width: 300px; max-width: 88vw; flex-direction: column; overflow: hidden; border-right: 1px solid var(--alu-border); background: var(--alu-bg); box-shadow: var(--alu-sidebar-shadow); transform: translateX(-100%); transition: transform .25s cubic-bezier(.4, 0, .2, 1); }
.alu-sidebar.open { transform: translateX(0); }
.alu-sidebar-overlay { position: fixed; z-index: 49; inset: 0; padding: 0; pointer-events: none; opacity: 0; border: 0; background: var(--alu-scrim); transition: opacity .25s ease; }
.alu-sidebar-overlay.open { pointer-events: auto; opacity: 1; }
.alu-sidebar-head { display: flex; min-height: 70px; flex: 0 0 auto; align-items: center; gap: 6px; padding: 14px 16px; border-bottom: 1px solid var(--alu-border); }
.alu-sidebar-avatar { width: 40px; height: 40px; flex: 0 0 auto; object-fit: cover; border: 2px solid var(--alu-avatar-ring); border-radius: 50%; }
.alu-sidebar-title { min-width: 0; flex: 1; overflow: hidden; color: var(--alu-text); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.alu-instance-list { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
.alu-instance-link { width: 100%; border: 0; background: transparent; text-align: left; }
.alu-sidebar-settings-entry { display: grid; min-height: 58px; flex: 0 0 auto; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; padding: 9px 14px; border: 0; border-top: 1px solid var(--alu-border); background: var(--alu-bg); color: var(--alu-text-muted); text-align: left; }
.alu-sidebar-settings-entry:last-child { padding-bottom: max(9px, env(safe-area-inset-bottom)); }
.alu-sidebar-settings-entry:hover { background: var(--alu-hover); color: var(--alu-text); }
.alu-sidebar-settings-icon, .alu-sidebar-settings-entry img { display: grid; width: 32px; height: 32px; object-fit: cover; border-radius: 8px; place-items: center; }
.alu-sidebar-settings-icon { border: 1px solid var(--alu-accent-border); background: var(--alu-accent-bg); color: var(--alu-accent); }
.alu-sidebar-settings-entry > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.alu-sidebar-settings-entry strong, .alu-sidebar-settings-entry small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-sidebar-settings-entry strong { color: var(--alu-text); font-size: var(--alu-meta-size); }
.alu-sidebar-settings-entry small { color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
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
