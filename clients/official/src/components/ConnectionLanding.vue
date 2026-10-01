<script setup lang="ts">
import HostOnboarding from './HostOnboarding.vue'
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { FileText, Monitor, Plus, RefreshCw, Settings, Waypoints, WifiOff } from '@lucide/vue'
import { openDesktopHostLog, openDesktopTui } from '../lib/bridge'
import { copyPlainText } from '../lib/clipboard'
import type { Work } from '../lib/types'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useHostStore } from '../stores/host'
import { usePlatformStore } from '../stores/platform'
import { useWorkActionsStore } from '../stores/work-actions'

const app = useAppStore()
const selected = computed(() => app.selectedWork)
const hostStore = useHostStore()
const { pairingError } = storeToRefs(hostStore)
const { openHostSettings, showHostPairingForm } = hostStore
const platform = usePlatformStore()
const { desktopShell, desktopShellBusy } = storeToRefs(platform)
const { retryDesktopHost, runDesktopShellAction } = platform
const workActions = useWorkActionsStore()
const { workMutating } = storeToRefs(workActions)
const { reopenSelectedWork } = workActions
function inactiveState(work: Work) {
  if (work.lifecycle === 'host_lost') return { label: '连接已中断', message: '这个 Work 的运行进程已经离线。继续后会恢复同一个 Work。', action: '继续这个 Work' }
  if (work.lifecycle === 'runtime_error') return { label: '工作出现故障', message: '这个 Work 已停止运行，可以重新启动后继续。', action: '重新启动这个 Work' }
  if (work.lifecycle === 'stopping') return { label: '正在停止', message: 'Dock 正在结束这个 Work，请稍后刷新状态。', action: '' }
  if (work.lifecycle === 'stopped') return { label: 'Work 已停止', message: '这是一个已经结束的历史 Work。', action: '' }
  return { label: 'Work 当前不可用', message: '当前无法连接这个 Work。', action: '' }
}

/** Raw diagnostics (Host or shell wording, often English) stay behind “查看详情”;
 * the sentence the user reads first is always ours. */
const diagnosticCopyState = ref<{ text: string; state: 'copied' | 'failed' } | null>(null)
function diagnosticCopyLabel(text: string) {
  const current = diagnosticCopyState.value
  if (current?.text !== text) return '复制诊断信息'
  return current.state === 'copied' ? '诊断信息已复制' : '复制失败，请重试'
}
async function copyDiagnostic(text: string) {
  try {
    await copyPlainText(text)
    diagnosticCopyState.value = { text, state: 'copied' }
  } catch {
    diagnosticCopyState.value = { text, state: 'failed' }
  }
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
      <p>本机 Alu Dock 没有启动成功。可以重新启动，或打开日志查看原因。</p>
      <details class="alu-diagnostic">
        <summary>查看详情</summary>
        <pre>{{ desktopShell.startupError }}</pre>
        <button type="button" @click="copyDiagnostic(desktopShell.startupError)">{{ diagnosticCopyLabel(desktopShell.startupError) }}</button>
      </details>
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

    <HostOnboarding v-else-if="app.needsPairing" />

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
        <button class="button secondary" @click="openHostSettings"><Settings :size="16" />连接与配对</button>
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
        <details v-if="selected.lastError" class="alu-diagnostic alu-work-state-diagnostic">
          <summary>查看详情</summary>
          <pre>{{ selected.lastError }}</pre>
          <button type="button" @click="copyDiagnostic(selected.lastError)">{{ diagnosticCopyLabel(selected.lastError) }}</button>
        </details>
        <div v-if="app.error" class="alu-work-state-error" role="alert">状态没有刷新，下面可能不是最新情况。{{ app.error }}</div>
        <div class="alu-work-state-actions">
          <button v-if="selected.reopenable" class="alu-work-state-primary" :disabled="workMutating" @click="reopenSelectedWork()">{{ workMutating ? '正在继续…' : inactiveState(selected).action }}</button>
          <button class="alu-work-state-secondary" @click="app.workDrawerOpen = true">查看工作列表</button>
          <button class="alu-work-state-secondary" :disabled="app.loading" @click="app.load">{{ app.loading ? '正在刷新…' : '刷新状态' }}</button>
        </div>
      </section>
    </div>

</template>

<style scoped>
/* ═══════════════════════════════════════════════════════
   非活跃 Work 状态面
   ═══════════════════════════════════════════════════════ */
.alu-work-state {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: clamp(28px, 6vh, 72px) 0;
}
.alu-work-state-card {
  width: min(720px, 100%);
  position: relative;
  overflow: hidden;
  padding: clamp(24px, 4vw, 40px);
  border: 1px solid var(--alu-border-light);
  border-top-color: var(--alu-amber);
  border-radius: 2px 18px 18px 18px;
  background: linear-gradient(145deg, rgba(20, 30, 52, 0.94), rgba(10, 16, 30, 0.96));
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28), inset 3px 0 0 rgba(245, 158, 11, 0.75);
}
.alu-work-state-card::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 120px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--alu-amber));
  opacity: 0.75;
}
.alu-work-state-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f6c56f;
  font-size: var(--alu-meta-size);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.alu-work-state-signal {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--alu-amber);
  box-shadow: 0 0 14px rgba(245, 158, 11, 0.7);
}
.alu-work-state-card h1 {
  margin: 18px 0 8px;
  color: var(--alu-text);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 750;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.alu-work-state-message {
  max-width: 580px;
  margin: 0;
  color: var(--alu-text-dim);
  font-size: 14px;
  line-height: 1.75;
}
.alu-work-state-meta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  margin: 26px 0 0;
}
.alu-work-state-meta > div {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--alu-border);
  border-radius: 8px;
  background: rgba(5, 10, 20, 0.42);
}
.alu-work-state-meta dt {
  margin-bottom: 5px;
  color: var(--alu-text-muted);
  font-size: var(--alu-micro-size);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.alu-work-state-meta dd {
  margin: 0;
  color: var(--alu-text-dim);
  font-family: inherit;
  font-size: var(--alu-meta-size);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.alu-work-state-error {
  margin-top: 12px;
  padding: 8px 10px;
  border-left: 2px solid var(--alu-rose);
  background: rgba(248, 113, 113, 0.06);
  color: var(--alu-rose);
  font-size: var(--alu-meta-size);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.alu-diagnostic {
  margin-top: 12px;
  font-size: var(--alu-meta-size);
  line-height: 1.6;
  text-align: left;
}
.alu-diagnostic > summary {
  color: var(--alu-text-muted);
  cursor: pointer;
}
.alu-diagnostic > pre {
  margin: 6px 0;
  padding: 8px 10px;
  border-left: 2px solid var(--alu-rose);
  background: rgba(248, 113, 113, 0.06);
  color: var(--alu-rose);
  font: var(--alu-meta-size)/1.6 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.alu-diagnostic > button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--alu-blue);
  font: inherit;
  cursor: pointer;
}
.center-state .alu-diagnostic {
  width: min(560px, calc(100vw - 32px));
  margin: -8px 0 16px;
}
.alu-work-state-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  margin-top: 28px;
}
.alu-work-state-primary,
.alu-work-state-secondary {
  min-height: 38px;
  border-radius: 9px;
  padding: 8px 14px;
  font-family: inherit;
  font-size: var(--alu-ui-size);
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s, transform 0.15s;
}
.alu-work-state-primary {
  border: 1px solid #d08a1f;
  background: rgba(245, 158, 11, 0.13);
  color: #ffd78d;
  box-shadow: 0 0 24px rgba(245, 158, 11, 0.08);
}
.alu-work-state-primary:focus-visible { box-shadow: var(--focus-ring); }
.alu-work-state-primary:disabled { cursor: not-allowed; }
.alu-work-state-primary:hover {
  background: rgba(245, 158, 11, 0.21);
  transform: translateY(-1px);
}
.alu-work-state-secondary {
  border: 1px solid var(--alu-border-light);
  background: rgba(20, 30, 52, 0.58);
  color: var(--alu-text-dim);
}
.alu-work-state-secondary:hover {
  border-color: var(--alu-border-focus);
  color: var(--alu-text);
}
.alu-work-state[data-lifecycle='runtime_error'] .alu-work-state-card {
  border-top-color: var(--alu-rose);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28), inset 3px 0 0 rgba(248, 113, 113, 0.68);
}
.alu-work-state[data-lifecycle='runtime_error'] .alu-work-state-card::after {
  background: linear-gradient(90deg, transparent, var(--alu-rose));
}
.alu-work-state[data-lifecycle='runtime_error'] .alu-work-state-status {
  color: var(--alu-rose);
}
.alu-work-state[data-lifecycle='runtime_error'] .alu-work-state-signal {
  background: var(--alu-rose);
  box-shadow: 0 0 14px rgba(248, 113, 113, 0.7);
}
.alu-work-state[data-lifecycle='stopped'] .alu-work-state-card,
.alu-work-state[data-lifecycle='stopping'] .alu-work-state-card {
  border-top-color: var(--alu-border-light);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.24), inset 3px 0 0 var(--alu-border-light);
}
.alu-work-state[data-lifecycle='stopped'] .alu-work-state-card::after,
.alu-work-state[data-lifecycle='stopping'] .alu-work-state-card::after {
  background: linear-gradient(90deg, transparent, var(--alu-border-light));
}
.alu-work-state[data-lifecycle='stopped'] .alu-work-state-status,
.alu-work-state[data-lifecycle='stopping'] .alu-work-state-status {
  color: var(--alu-text-muted);
}
.alu-work-state[data-lifecycle='stopped'] .alu-work-state-signal,
.alu-work-state[data-lifecycle='stopping'] .alu-work-state-signal {
  background: var(--alu-text-muted);
  box-shadow: none;
}
@media (max-width: 640px) {
  .alu-work-state {
    place-items: start stretch;
    padding: 18px 0 28px;
  }
  .alu-work-state-card {
    padding: 22px 18px;
    border-radius: 2px 14px 14px 14px;
  }
  .alu-work-state-meta {
    grid-template-columns: 1fr;
    margin-top: 20px;
  }
  .alu-work-state-actions {
    align-items: stretch;
    margin-top: 22px;
  }
  .alu-work-state-primary { flex: 1 0 100%; }
  .alu-work-state-secondary { flex: 1 1 0; }
}
.center-state { min-height: 100%; }
.center-state { display: grid; place-content: center; justify-items: center; color: var(--c-text-2); text-align: center; }
.center-state h1 { margin: 12px 0 4px; color: var(--c-text-1); font-size: 19px; }
.center-state p { max-width: 560px; margin: 8px 0 20px; font: 14px/1.6 var(--font-reading); }
.error-state > svg { color: var(--c-danger); }
.re-pair-error { width: min(620px, calc(100vw - 32px)); margin: -5px 0 12px; padding: 8px 10px; color: #f8a0a0; font: var(--alu-meta-size)/1.5 var(--font-reading); text-align: left; background: rgb(248 113 113 / .07); border: 1px solid rgb(248 113 113 / .18); border-radius: 9px; }
@media (max-width: 1000px) {
  .alu-work-state {
    width: min(100%, 760px);
    margin-inline: auto;
  }
}
</style>
