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
