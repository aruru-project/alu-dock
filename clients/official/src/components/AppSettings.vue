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
  { value: 'never', label: '永不', detail: '切到其他窗口不会进入暂离' },
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
