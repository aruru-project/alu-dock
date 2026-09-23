<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { computed } from 'vue'
import { Settings, X } from '@lucide/vue'
import { isTauri } from '../lib/bridge'
import { workPresence } from '../lib/uiBoundaries'
import OperationResults from './OperationResults.vue'
import type { usePlatformLifecycle } from '../lib/platformLifecycle'
import type { useWorkDirectory } from '../lib/workDirectory'
import type { useWorkActions } from '../lib/workActions'
import type { useHostConnection } from '../lib/hostConnection'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import type { useWorkObservation } from '../lib/workObservation'
import type { useOperationResults } from '../lib/operationResults'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  directory: ReadonlyRefs<Pick<ReturnType<typeof useWorkDirectory>, 'contextTransitionBusy' | 'forgetFromList' | 'groupedWorks' | 'machineListError' | 'openDirectory' | 'refreshWorkDrawer' | 'reopenFromList' | 'selectWork' | 'workMachineTag'>>
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'directoryOpen'>>
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'openHostSettings'>>
  platform: ReadonlyRefs<Pick<ReturnType<typeof usePlatformLifecycle>, 'appSettings' | 'openAppSettings' | 'windowsAwayLabel'>>
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'mutationOutcomeUnknown' | 'workMutating'>>
  operations: ReadonlyRefs<Pick<ReturnType<typeof useOperationResults>, 'consumeNativeOperation' | 'listResults'>>
  observation: ReadonlyRefs<Pick<ReturnType<typeof useWorkObservation>, 'label'>>
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { machineListError, contextTransitionBusy, groupedWorks, workMachineTag, selectWork, reopenFromList, forgetFromList, refreshWorkDrawer, openDirectory } = props.directory
const { directoryOpen } = props.page
const { openHostSettings } = props.host
const { appSettings, windowsAwayLabel, openAppSettings } = props.platform
const { workMutating, mutationOutcomeUnknown } = props.actions
const { listResults, consumeNativeOperation } = props.operations

const connectionLabel = props.observation.label
</script>

<template>
  <button class="alu-sidebar-overlay" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :tabindex="app.workDrawerOpen ? 0 : -1" aria-label="关闭工作列表" @click="app.workDrawerOpen = false" />
  <aside class="alu-sidebar" :class="{ open: app.workDrawerOpen }" :aria-hidden="!app.workDrawerOpen" :inert="!app.workDrawerOpen || undefined" aria-label="工作列表">
    <div class="alu-sidebar-head">
      <img :src="dockIconUrl" class="alu-sidebar-avatar" alt="Alu Dock" />
      <div class="alu-sidebar-title">AluDock Client</div>
      <button class="alu-sidebar-refresh" title="刷新" :disabled="contextTransitionBusy" @click="refreshWorkDrawer">↻</button>
      <button class="alu-sidebar-close" aria-label="关闭工作列表" @click="app.workDrawerOpen = false"><X :size="18" /></button>
    </div>
    <div class="alu-sidebar-actions"><button class="alu-new-work-btn" :disabled="contextTransitionBusy" @click="openDirectory">＋ 新建工作</button></div>
    <div class="alu-instance-list">
      <OperationResults v-if="listResults.length && !directoryOpen" :operations="listResults" :acknowledge="consumeNativeOperation" />
      <div v-if="machineListError" class="alu-sidebar-error">{{ machineListError }}</div>
      <section v-for="group in (['current', 'continue', 'history'] as const)" :key="group" v-show="groupedWorks[group].length" class="alu-instance-group">
        <div class="alu-instance-group-title">{{ group === 'current' ? '当前工作' : group === 'continue' ? '可以继续' : '历史工作' }}<span>{{ groupedWorks[group].length }}</span></div>
        <div v-for="work in groupedWorks[group]" :key="work.id" class="alu-instance-row" :class="{ 'is-selected': work.id === selected?.id }">
          <button class="alu-instance-link" :disabled="contextTransitionBusy && work.id !== selected?.id" @click="selectWork(work.id)">
            <span class="alu-instance-state" :class="`is-${workPresence(work).tone}`" />
            <span class="alu-instance-copy"><span class="alu-instance-name">{{ work.displayName }}</span><span v-if="workMachineTag(work)" class="alu-instance-machine-tag">{{ workMachineTag(work) }}</span><span class="alu-instance-cwd">{{ work.cwd.split('/').filter(Boolean).slice(-2).join('/') }}</span></span>
            <span class="alu-instance-meta">{{ workPresence(work).label }}</span>
          </button>
          <button v-if="work.reopenable && work.lifecycle !== 'active'" class="alu-instance-action" :disabled="!isTauri || workMutating || mutationOutcomeUnknown" @click="reopenFromList(work)">{{ workMutating && selected?.id === work.id ? '正在继续…' : '继续' }}</button>
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
