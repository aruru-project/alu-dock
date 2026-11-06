<script setup lang="ts">
import { ref } from 'vue'
import { Clock3, MonitorCog, Palette, X } from '@lucide/vue'
import { CLIENT_THEMES, DEFAULT_THEME, type ClientTheme } from '../lib/theme'
import type { ClientPreferences, WindowsAwayDelay } from '../lib/types'

defineProps<{
  /** Missing when this device's settings could not be read; the color theme does not need them. */
  preferences: ClientPreferences | null
  theme: ClientTheme
  themeError?: string
  buildIdentity?: string
  saving?: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  update: [delay: WindowsAwayDelay]
  theme: [theme: ClientTheme]
}>()

const section = ref<'theme' | 'windows-away'>('theme')

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
        <p>这台设备 · 版本 {{ buildIdentity || '—' }}</p>
      </div>
    </div>
    <button class="app-settings-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="app-settings-layout">
    <nav class="app-settings-nav" aria-label="设置分类">
      <span class="app-settings-nav-label">应用</span>
      <button type="button" :class="['app-settings-nav-item', { 'is-active': section === 'theme' }]" :aria-current="section === 'theme' ? 'page' : undefined" @click="section = 'theme'"><Palette :size="16" /><span>配色</span></button>
      <button v-if="preferences?.windowsAwaySupported" type="button" :class="['app-settings-nav-item', { 'is-active': section === 'windows-away' }]" :aria-current="section === 'windows-away' ? 'page' : undefined" @click="section = 'windows-away'"><Clock3 :size="16" /><span>Windows 暂离</span></button>
    </nav>

    <main v-if="section === 'theme'" class="app-settings-content">
      <div class="app-settings-intro">
        <span>外观</span>
        <h3>配色</h3>
        <p>点一下立即换上，下次打开客户端也是这套。</p>
      </div>

      <div class="app-settings-options" role="group" aria-label="配色">
        <button
          v-for="option in CLIENT_THEMES"
          :key="option.id"
          type="button"
          :aria-pressed="theme === option.id"
          :class="['app-settings-option', 'theme-option', { 'is-selected': theme === option.id }]"
          @click="emit('theme', option.id)"
        >
          <!-- A small window drawn in that theme's own colors. -->
          <span class="theme-preview" :data-theme="option.id" aria-hidden="true">
            <span class="theme-preview-bar"><i class="theme-preview-avatar" /><i class="theme-preview-control" /></span>
            <span class="theme-preview-body">
              <i class="theme-preview-user" />
              <i class="theme-preview-reply" />
              <span class="theme-preview-input"><i class="theme-preview-send" /></span>
            </span>
          </span>
          <span class="app-settings-option-copy"><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
          <span v-if="option.id === DEFAULT_THEME" class="app-settings-option-badge">默认</span>
        </button>
      </div>

      <p v-if="themeError" class="app-settings-error" role="alert">{{ themeError }}</p>
      <p v-else class="app-settings-footnote">设置保存在这台设备上，适用于所有 Host。</p>
    </main>

    <main v-else class="app-settings-content">
      <div class="app-settings-intro">
        <span>WINDOWS</span>
        <h3>暂离时间</h3>
        <p>切到其他窗口后，在所选时间内回来可以直接继续。超过后进入暂离；Work 会继续运行，完成时通知你。</p>
      </div>

      <div class="app-settings-options" role="group" aria-label="暂离时间">
        <button
          v-for="option in awayOptions"
          :key="option.value"
          type="button"
          :aria-pressed="preferences?.windowsAwayDelay === option.value"
          :class="['app-settings-option', { 'is-selected': preferences?.windowsAwayDelay === option.value }]"
          :disabled="saving"
          @click="emit('update', option.value)"
        >
          <span class="away-option-indicator" aria-hidden="true" />
          <span class="app-settings-option-copy"><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
          <span v-if="option.value === 'one_minute'" class="app-settings-option-badge">默认</span>
        </button>
      </div>

      <p v-if="error" class="app-settings-error" role="alert">{{ error }}</p>
      <p v-else class="app-settings-footnote">设置保存在这台设备上，适用于所有 Host。</p>
    </main>
  </div>
</template>

<style scoped>
.app-settings-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--alu-border); background: var(--alu-surface); }
.app-settings-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.app-settings-mark { display: grid; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-accent-border); border-radius: 10px; background: var(--alu-accent-bg); color: var(--alu-accent); place-items: center; }
.app-settings-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; }
.app-settings-heading p { margin: 3px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.app-settings-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.app-settings-close:hover { border-color: var(--alu-border); background: var(--alu-hover); color: var(--alu-text); }
.app-settings-layout { display: grid; min-height: 0; grid-template-columns: 190px minmax(0, 1fr); }
.app-settings-nav { display: flex; flex-direction: column; gap: 4px; padding: 20px 12px; border-right: 1px solid var(--alu-border); background: var(--alu-bg); }
.app-settings-nav-label { display: block; padding: 0 9px 6px; color: var(--alu-text-faint); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.app-settings-nav-item { display: flex; min-height: 42px; align-items: center; gap: 9px; padding: 0 10px; cursor: pointer; border: 1px solid transparent; border-radius: 9px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); text-align: left; }
.app-settings-nav-item:hover:not(.is-active) { background: var(--alu-hover); color: var(--alu-text); }
.app-settings-nav-item.is-active { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); color: var(--alu-highlight); }
.app-settings-content { min-width: 0; min-height: 0; padding: 28px 30px 34px; overflow-y: auto; }
.app-settings-intro { padding-bottom: 20px; border-bottom: 1px solid var(--alu-border); }
.app-settings-intro > span { color: var(--alu-accent); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .15em; }
.app-settings-intro h3 { margin: 6px 0 8px; color: var(--alu-text); font-size: 20px; font-weight: 650; }
.app-settings-intro p { max-width: 520px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.app-settings-options { display: grid; gap: 7px; margin-top: 20px; }
.app-settings-option { display: grid; min-height: 58px; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 11px; width: 100%; padding: 9px 12px; cursor: pointer; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); color: var(--alu-text); text-align: left; transition: border-color .14s ease, background .14s ease, transform .14s ease; }
.app-settings-option:hover { border-color: var(--alu-border-light); background: var(--alu-hover); transform: translateX(2px); }
.app-settings-option:disabled { cursor: wait; opacity: .62; transform: none; }
.app-settings-option.is-selected { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); }
.away-option-indicator { width: 13px; height: 13px; border: 1px solid var(--alu-text-faint); border-radius: 50%; box-shadow: 0 0 0 3px transparent inset; }
.app-settings-option.is-selected .away-option-indicator { border-color: var(--alu-highlight); background: var(--alu-highlight); box-shadow: 0 0 0 3px var(--alu-highlight-bg) inset; }
.app-settings-option-copy { display: grid; min-width: 0; gap: 3px; }
.app-settings-option-copy strong { font-size: var(--alu-meta-size); font-weight: 650; }
.app-settings-option-copy small { color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.app-settings-option-badge { padding: 3px 6px; border-radius: 999px; background: rgb(var(--alu-accent-rgb) / .1); color: var(--alu-accent); font-size: var(--alu-micro-size); }
.theme-option { min-height: 76px; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 14px; }
.theme-option.is-selected .theme-preview { box-shadow: 0 0 0 2px var(--alu-highlight); }
/* The preview reads its theme's variables through its own data-theme attribute. */
.theme-preview { display: grid; width: 76px; height: 52px; grid-template-rows: 13px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--alu-border-light); border-radius: 8px; background: var(--alu-bg); }
.theme-preview i { display: block; }
.theme-preview-bar { display: flex; align-items: center; gap: 4px; padding: 0 5px; border-bottom: 1px solid var(--alu-nav-border); background: var(--alu-nav-bg); }
.theme-preview-avatar { width: 7px; height: 7px; border: 1.5px solid var(--alu-brand-border); border-radius: 50%; background: var(--alu-surface); }
.theme-preview-control { width: 22px; height: 6px; margin-left: auto; border: 1px solid var(--alu-border-light); border-radius: 999px; background: var(--alu-control-bg); }
.theme-preview-body { display: grid; align-content: start; gap: 3px; padding: 4px 5px; }
.theme-preview-user { width: 26px; height: 7px; justify-self: end; border: 1px solid var(--alu-user-border); border-radius: 3px; background: var(--alu-user-bg); }
.theme-preview-reply { width: 44px; height: 9px; border: 1px solid var(--alu-bubble-border); border-left: 2px solid var(--alu-highlight); border-radius: 3px; background: var(--alu-bubble-bg); }
.theme-preview-input { display: flex; height: 9px; justify-content: flex-end; padding: 1px; border: 1px solid var(--alu-border-light); border-radius: 3px; background: var(--alu-surface); }
.theme-preview-send { width: 9px; height: 100%; border-radius: 2px; background: var(--alu-send-bg); }
.app-settings-footnote, .app-settings-error { margin: 16px 0 0; font-size: var(--alu-micro-size); }
.app-settings-footnote { color: var(--alu-text-faint); }
.app-settings-error { padding: 9px 10px; border: 1px solid var(--alu-danger-border); border-radius: 8px; background: var(--alu-danger-bg); color: var(--alu-danger); }
@media (max-width: 640px) {
  .app-settings-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .app-settings-nav { flex-direction: row; padding: 10px 14px; border-right: 0; border-bottom: 1px solid var(--alu-border); }
  .app-settings-nav-label { display: none; }
  .app-settings-nav-item { width: max-content; min-height: 36px; }
  .app-settings-content { padding: 22px 16px 28px; }
  .app-settings-option { min-height: 62px; }
  .theme-option { min-height: 76px; }
}
</style>
