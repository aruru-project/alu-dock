<script setup lang="ts">
import { Clock3, MonitorCog, X } from '@lucide/vue'
import type { ClientPreferences, WindowsAwayDelay } from '../lib/types'

defineProps<{
  preferences: ClientPreferences
  buildIdentity?: string
  saving?: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  update: [delay: WindowsAwayDelay]
}>()

const awayOptions: { value: WindowsAwayDelay; label: string; detail: string }[] = [
  { value: 'immediate', label: '立即', detail: '切到其他窗口后立即进入暂离' },
  { value: 'one_minute', label: '1 分钟', detail: '适合临时切窗，推荐' },
  { value: 'five_minutes', label: '5 分钟', detail: '保留更长的返回时间' },
  { value: 'thirty_minutes', label: '30 分钟', detail: '适合较长的桌面任务切换' },
  { value: 'one_hour', label: '1 小时', detail: '长时间保留当前入口' },
  { value: 'never', label: '永不', detail: '切换窗口时始终保持当前入口' },
]
</script>

<template>
  <header class="app-settings-header">
    <div class="app-settings-heading">
      <span class="app-settings-mark"><MonitorCog :size="20" /></span>
      <div>
        <h2 id="app-settings-title">App 设置</h2>
        <p>这台 Windows 设备 · 版本 {{ buildIdentity || '—' }}</p>
      </div>
    </div>
    <button class="app-settings-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="app-settings-layout">
    <aside class="app-settings-nav" aria-label="设置分类">
      <span class="app-settings-nav-label">应用</span>
      <div class="app-settings-nav-item is-active"><Clock3 :size="16" /><span>Windows 暂离</span></div>
    </aside>

    <main class="app-settings-content">
      <div class="app-settings-intro">
        <span>WINDOWS</span>
        <h3>暂离时间</h3>
        <p>切到其他窗口后，在所选时间内回来可以直接继续。超过后进入暂离；Work 会继续运行，完成时通知你。</p>
      </div>

      <div class="away-options" role="group" aria-label="暂离时间">
        <button
          v-for="option in awayOptions"
          :key="option.value"
          type="button"
          :aria-pressed="preferences.windowsAwayDelay === option.value"
          :class="['away-option', { 'is-selected': preferences.windowsAwayDelay === option.value }]"
          :disabled="saving"
          @click="emit('update', option.value)"
        >
          <span class="away-option-indicator" aria-hidden="true" />
          <span class="away-option-copy"><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
          <span v-if="option.value === 'one_minute'" class="away-option-badge">默认</span>
        </button>
      </div>

      <p v-if="error" class="app-settings-error" role="alert">{{ error }}</p>
      <p v-else class="app-settings-footnote">设置保存在这台设备上，适用于所有 Host。</p>
    </main>
  </div>
</template>

<style scoped>
.app-settings-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--alu-border); background: #101725; }
.app-settings-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.app-settings-mark { display: grid; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-blue-border); border-radius: 10px; background: var(--alu-blue-bg); color: var(--alu-blue); place-items: center; }
.app-settings-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; }
.app-settings-heading p { margin: 3px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.app-settings-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.app-settings-close:hover { border-color: var(--alu-border); background: var(--alu-hover); color: var(--alu-text); }
.app-settings-layout { display: grid; min-height: 0; grid-template-columns: 190px minmax(0, 1fr); }
.app-settings-nav { padding: 20px 12px; border-right: 1px solid var(--alu-border); background: #080d17; }
.app-settings-nav-label { display: block; padding: 0 9px 10px; color: var(--alu-text-faint); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.app-settings-nav-item { display: flex; min-height: 42px; align-items: center; gap: 9px; padding: 0 10px; border: 1px solid transparent; border-radius: 9px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.app-settings-nav-item.is-active { border-color: var(--alu-blue-border); background: var(--alu-blue-bg); color: var(--alu-blue); }
.app-settings-content { min-width: 0; min-height: 0; padding: 28px 30px 34px; overflow-y: auto; }
.app-settings-intro { padding-bottom: 20px; border-bottom: 1px solid var(--alu-border); }
.app-settings-intro > span { color: var(--alu-blue); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .15em; }
.app-settings-intro h3 { margin: 6px 0 8px; color: var(--alu-text); font-size: 20px; font-weight: 650; }
.app-settings-intro p { max-width: 520px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.away-options { display: grid; gap: 7px; margin-top: 20px; }
.away-option { display: grid; min-height: 58px; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 11px; width: 100%; padding: 9px 12px; cursor: pointer; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); color: var(--alu-text); text-align: left; transition: border-color .14s ease, background .14s ease, transform .14s ease; }
.away-option:hover { border-color: var(--alu-border-light); background: var(--alu-hover); transform: translateX(2px); }
.away-option:disabled { cursor: wait; opacity: .62; transform: none; }
.away-option.is-selected { border-color: var(--alu-blue-border); background: var(--alu-blue-bg); }
.away-option-indicator { width: 13px; height: 13px; border: 1px solid var(--alu-text-faint); border-radius: 50%; box-shadow: 0 0 0 3px transparent inset; }
.away-option.is-selected .away-option-indicator { border-color: var(--alu-blue); background: var(--alu-blue); box-shadow: 0 0 0 3px #0d1725 inset; }
.away-option-copy { display: grid; min-width: 0; gap: 3px; }
.away-option-copy strong { font-size: var(--alu-meta-size); font-weight: 650; }
.away-option-copy small { color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.away-option-badge { padding: 3px 6px; border-radius: 999px; background: rgba(126, 200, 224, .1); color: var(--alu-blue); font-size: var(--alu-micro-size); }
.app-settings-footnote, .app-settings-error { margin: 16px 0 0; font-size: var(--alu-micro-size); }
.app-settings-footnote { color: var(--alu-text-faint); }
.app-settings-error { padding: 9px 10px; border: 1px solid var(--alu-rose-border); border-radius: 8px; background: var(--alu-rose-bg); color: var(--alu-rose); }
@media (max-width: 640px) {
  .app-settings-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .app-settings-nav { padding: 10px 14px; border-right: 0; border-bottom: 1px solid var(--alu-border); }
  .app-settings-nav-label { display: none; }
  .app-settings-nav-item { width: max-content; min-height: 36px; }
  .app-settings-content { padding: 22px 16px 28px; }
  .away-option { min-height: 62px; }
}
</style>
