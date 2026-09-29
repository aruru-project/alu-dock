<script setup lang="ts">
import { ref, watch } from 'vue'
import { Monitor, Settings, X } from '@lucide/vue'

const props = defineProps<{
  connected: boolean
  effectiveEndpoint?: string
  endpointOverride?: string
  busy: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  connect: []
  save: [endpoint?: string]
}>()

const editing = ref(false)
const draft = ref('')
const saving = ref(false)

function openEditor() {
  draft.value = props.endpointOverride ?? ''
  saving.value = false
  editing.value = true
}

function save() {
  saving.value = true
  emit('save', draft.value.trim() || undefined)
}

function restoreDefault() {
  draft.value = ''
  save()
}

watch(() => [props.busy, props.error] as const, ([busy, error]) => {
  if (saving.value && !busy) {
    saving.value = false
    if (!error) editing.value = false
  }
})
</script>

<template>
  <section class="local-connection-card" :class="{ connected }">
    <span class="local-connection-icon"><Monitor :size="19" /></span>
    <div class="local-connection-copy">
      <strong>本机 AluDock</strong>
      <small>{{ connected ? '当前连接' : '连接这台设备上运行的 AluDock' }}</small>
      <code :title="effectiveEndpoint">{{ endpointOverride ? effectiveEndpoint : '平台默认地址' }}</code>
    </div>
    <div class="local-connection-actions">
      <button type="button" class="button primary" :disabled="connected || busy" @click="emit('connect')">
        {{ connected ? '已连接' : busy ? '正在连接…' : '连接' }}
      </button>
      <button type="button" class="local-connection-config" :aria-expanded="editing" aria-label="配置本机连接地址" :disabled="busy" @click="editing ? editing = false : openEditor()">
        <X v-if="editing" :size="15" /><Settings v-else :size="15" />
      </button>
    </div>

    <div v-if="editing" class="local-endpoint-editor">
      <label>
        <span>本机连接地址</span>
        <input v-model="draft" autocomplete="off" spellcheck="false" :placeholder="effectiveEndpoint || '平台默认地址'" :disabled="busy" @keydown.enter.prevent="save" />
      </label>
      <p>留空时使用当前平台的默认地址。</p>
      <div v-if="error" class="directory-error">{{ error }}</div>
      <footer>
        <button type="button" class="button secondary" :disabled="busy || !endpointOverride" @click="restoreDefault">恢复默认</button>
        <button type="button" class="button primary" :disabled="busy" @click="save">{{ saving || busy ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.local-connection-card { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px; border: 1px solid color-mix(in srgb, var(--alu-mint) 28%, var(--c-line)); border-radius: 10px; background: color-mix(in srgb, var(--alu-mint) 5%, transparent); }
.local-connection-card.connected { border-color: color-mix(in srgb, var(--alu-mint) 48%, var(--c-line)); }
.local-connection-icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; color: var(--alu-mint); background: color-mix(in srgb, var(--alu-mint) 10%, transparent); }
.local-connection-copy { display: grid; min-width: 0; gap: 3px; }
.local-connection-copy strong { color: var(--c-text-1); font-size: 11px; }
.local-connection-copy small { color: var(--c-text-3); font: 9px/1.4 var(--font-reading); }
.local-connection-copy code { overflow: hidden; color: color-mix(in srgb, var(--alu-mint) 75%, var(--c-text-3)); font: 8px/1.4 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.local-connection-actions { display: flex; align-items: center; gap: 6px; }
.local-connection-config { display: grid; width: 34px; height: 34px; cursor: pointer; border: 1px solid var(--c-line); border-radius: 8px; color: var(--c-text-2); place-items: center; }
.local-connection-config:hover { color: var(--alu-mint); border-color: color-mix(in srgb, var(--alu-mint) 38%, var(--c-line)); }
.local-connection-config:disabled { cursor: default; opacity: .45; }
.local-endpoint-editor { display: grid; grid-column: 1 / -1; gap: 8px; padding-top: 10px; border-top: 1px solid var(--c-line-soft); }
.local-endpoint-editor label { display: grid; gap: 5px; color: var(--c-text-2); font-size: 9px; }
.local-endpoint-editor input { width: 100%; height: 36px; padding: 0 10px; color: var(--c-text-1); font: 10px var(--font-mono); background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 8px; outline: none; }
.local-endpoint-editor input:focus { border-color: var(--alu-mint); box-shadow: 0 0 0 2px color-mix(in srgb, var(--alu-mint) 10%, transparent); }
.local-endpoint-editor p { margin: 0; color: var(--c-text-3); font: 8px/1.5 var(--font-reading); }
.local-endpoint-editor footer { display: flex; justify-content: flex-end; gap: 7px; }
.host-catalog-section > .local-connection-card { margin-bottom: 14px; border-color: color-mix(in srgb, var(--alu-mint) 24%, var(--alu-border)); background: var(--alu-bg-raised); }
.host-catalog-section .local-connection-card { grid-template-columns: 32px minmax(0, 1fr); }
.host-catalog-section .local-connection-actions { grid-column: 1 / -1; }
.host-catalog-section .local-connection-actions .button { flex: 1; }
@media screen and (max-width: 1000px) {
  .local-connection-card { grid-template-columns: 34px minmax(0, 1fr); }
  .local-connection-actions { grid-column: 1 / -1; }
  .local-connection-actions .button { flex: 1; }
}
</style>
