<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import HostOnboarding from './HostOnboarding.vue'
import { computed } from 'vue'
import { FileText, Monitor, Plus, RefreshCw, Settings, Waypoints, WifiOff } from '@lucide/vue'
import { openDesktopHostLog, openDesktopTui } from '../lib/bridge'
import type { Work } from '../lib/types'
import type { usePlatformLifecycle } from '../lib/platformLifecycle'
import type { useWorkActions } from '../lib/workActions'
import type { useHostConnection } from '../lib/hostConnection'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'beginPairing' | 'connectLocal' | 'openHostSettings' | 'pairingMessage' | 'pairingPin' | 'pairingStage' | 'rememberPairDeviceName' | 'showHostPairingForm' | 'stopPairing' | 'updateLocalEndpoint'>> & Pick<ReturnType<typeof useHostConnection>, 'pairDeviceName' | 'pairHost' | 'pairPort' | 'pairingError'>
  platform: ReadonlyRefs<Pick<ReturnType<typeof usePlatformLifecycle>, 'desktopShell' | 'desktopShellBusy' | 'retryDesktopHost' | 'runDesktopShellAction'>>
  actions: ReadonlyRefs<Pick<ReturnType<typeof useWorkActions>, 'reopenSelectedWork' | 'workMutating'>>
  busy: boolean
}>()
const app = useAppStore()
const selected = computed(() => app.selectedWork)
const { pairingError, openHostSettings, showHostPairingForm } = props.host
const { desktopShell, desktopShellBusy, retryDesktopHost, runDesktopShellAction } = props.platform
const { workMutating, reopenSelectedWork } = props.actions
function inactiveState(work: Work) {
  if (work.lifecycle === 'host_lost') return { label: '连接已中断', message: '这个 Work 的运行进程已经离线。继续后会恢复同一个 Work。', action: '继续这个 Work' }
  if (work.lifecycle === 'runtime_error') return { label: '工作出现故障', message: '这个 Work 已停止运行，可以重新启动后继续。', action: '重新启动这个 Work' }
  if (work.lifecycle === 'stopping') return { label: '正在停止', message: 'Dock 正在结束这个 Work，请稍后刷新状态。', action: '' }
  if (work.lifecycle === 'stopped') return { label: 'Work 已停止', message: '这是一个已经结束的历史 Work。', action: '' }
  return { label: 'Work 当前不可用', message: '当前无法连接这个 Work。', action: '' }
}

</script>

<template>
    <div v-if="app.loading && !app.payload && !(desktopShell?.supported && desktopShell.autoStartLocalHost && !app.payload && (desktopShell.startupError || !desktopShell.hostReady))" class="center-state" aria-live="polite">
      <span class="alu-spinner" />
      <p>正在连接 AluDock…</p>
    </div>

    <div v-else-if="desktopShell?.supported && desktopShell.autoStartLocalHost && !app.payload && desktopShell.startupError" class="center-state error-state offline-host-state">
      <WifiOff :size="28" />
      <h1>Alu Dock 需要你的操作</h1>
      <p>{{ desktopShell.startupError }}</p>
      <div class="pairing-actions">
        <button class="button primary" :disabled="desktopShellBusy" @click="retryDesktopHost"><RefreshCw :size="16" />{{ desktopShellBusy ? '正在启动…' : '重新启动' }}</button>
        <button v-if="desktopShell.logsPath" class="button secondary" @click="runDesktopShellAction(openDesktopHostLog)"><FileText :size="16" />打开日志</button>
        <button class="button secondary" @click="runDesktopShellAction(openDesktopTui)"><Settings :size="16" />打开终端设置</button>
      </div>
    </div>

    <div v-else-if="desktopShell?.supported && desktopShell.autoStartLocalHost && !app.payload && desktopShell.role !== 'subhost' && !desktopShell.hostReady" class="center-state offline-host-state">
      <Monitor :size="28" />
      <h1>{{ desktopShell.hostPhase === 'starting' ? 'Alu Dock 正在启动' : desktopShell.hostPhase === 'stopping' ? 'Alu Dock 正在停止' : 'Alu Dock 已停止' }}</h1>
      <p>{{ desktopShell.hostPhase === 'starting' ? '窗口会在启动完成后自动连接。' : '启动后即可继续这台电脑上的 Work。' }}</p>
      <div class="pairing-actions">
        <button class="button primary" :disabled="desktopShellBusy" @click="retryDesktopHost"><RefreshCw :size="16" />{{ desktopShellBusy ? '正在启动…' : '启动 Alu Dock' }}</button>
        <button v-if="desktopShell.logsPath" class="button secondary" @click="runDesktopShellAction(openDesktopHostLog)"><FileText :size="16" />打开日志</button>
      </div>
    </div>

    <HostOnboarding v-else-if="app.needsPairing" :host="props.host" :busy="props.busy" />

    <div v-else-if="app.error && !app.payload" class="center-state error-state offline-host-state">
      <WifiOff :size="28" />
      <h1>无法连接“{{ app.localSelected ? '本机 AluDock' : app.activeHost?.displayName || 'Host' }}”</h1>
      <p>{{ app.error }}</p>
      <p v-if="app.hostUnreachable">{{ app.localSelected ? '当前本机连接地址已保留。' : '已保存的配对仍保留。' }}</p>
      <div v-if="pairingError" class="re-pair-error" role="alert">{{ pairingError }}</div>
      <div class="pairing-actions">
        <button class="button primary" @click="pairingError = ''; app.load()"><RefreshCw :size="16" />重新连接</button>
        <button class="button secondary" @click="openHostSettings"><Waypoints :size="16" />切换 Host</button>
        <button class="button secondary" @click="openHostSettings(); showHostPairingForm()"><Plus :size="16" />连接新的 AluDock</button>
        <button class="button secondary" @click="openHostSettings"><Settings :size="16" />Host 设置</button>
      </div>
    </div>

    <div v-else-if="!selected" class="alu-welcome">
      <img :src="dockIconUrl" alt="Alu Dock" />
      <div class="alu-welcome-text">{{ app.works.length ? '请从工作列表选择一个 Work' : '没有可用的 Work' }}</div>
    </div>

    <div v-else-if="selected.lifecycle !== 'active'" class="alu-work-state" :data-lifecycle="selected.lifecycle">
      <section class="alu-work-state-card" aria-labelledby="alu-work-state-title">
        <div class="alu-work-state-status"><span class="alu-work-state-signal" aria-hidden="true" /><span>{{ inactiveState(selected).label }}</span></div>
        <h1 id="alu-work-state-title">{{ selected.displayName }}</h1>
        <p class="alu-work-state-message">{{ inactiveState(selected).message }}</p>
        <dl class="alu-work-state-meta"><div><dt>Workspace</dt><dd>{{ selected.cwd }}</dd></div></dl>
        <div v-if="selected.lastError" class="alu-work-state-error">{{ selected.lastError }}</div>
        <div class="alu-work-state-actions">
          <button v-if="selected.reopenable" class="alu-work-state-primary" :disabled="workMutating" @click="reopenSelectedWork()">{{ workMutating ? '正在继续…' : inactiveState(selected).action }}</button>
          <button class="alu-work-state-secondary" @click="app.workDrawerOpen = true">查看工作列表</button>
          <button class="alu-work-state-secondary" @click="app.load">刷新状态</button>
        </div>
      </section>
    </div>

</template>
