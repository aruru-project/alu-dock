<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../stores/app'
import { useAssistantStore } from '../stores/assistant'

const app = useAppStore()
const assistant = useAssistantStore()
const { identity, identityValue } = storeToRefs(assistant)
const saving = computed(() => identity.value.save?.state === 'pending')
watch(() => app.connectionContext, () => { void assistant.loadIdentity() }, { immediate: true })
</script>

<template>
  <section v-if="!identity.read || identity.current !== null" class="assistant-identity" aria-labelledby="assistant-display-name">
    <h4 id="assistant-display-name">显示名字</h4>
    <p class="assistant-status">这个名字保存在 Main，所有客户端共用。</p>
    <form v-if="identity.current !== null" @submit.prevent="assistant.saveIdentity()">
      <label for="assistant-name-input">名字</label>
      <div class="assistant-identity-field">
        <input id="assistant-name-input" :value="identityValue" autocomplete="off" @input="assistant.editIdentity(($event.target as HTMLInputElement).value)" />
        <button class="button secondary" :disabled="saving || !identityValue.trim() || (identityValue.trim() === identity.current.trim() && identity.save?.state !== 'failed')">{{ saving ? '正在保存…' : '保存名字' }}</button>
      </div>
    </form>
    <p v-else-if="identity.loading" class="assistant-status" role="status">正在读取名字…</p>
    <p v-if="identity.save" :class="identity.save.state === 'failed' ? 'assistant-error' : 'assistant-note'" :role="identity.save.state === 'failed' ? 'alert' : 'status'">{{ identity.save.message }}</p>
    <div v-if="identity.error" class="assistant-error" role="alert"><span>{{ identity.error }}</span><button class="button secondary" :disabled="identity.loading" @click="assistant.loadIdentity()">重试</button></div>
  </section>
</template>

<style scoped>
.assistant-identity { padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--alu-border); }
.assistant-identity h4 { margin: 0 0 10px; color: var(--alu-text); }
.assistant-identity label { display: block; margin: 12px 0 6px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-identity-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.assistant-identity-field input { min-width: 0; flex: 1 1 160px; padding: 9px 10px; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-control-bg); color: var(--alu-text); font: inherit; }
.assistant-identity-field input:focus { outline: none; box-shadow: var(--alu-focus-ring); }
.assistant-identity-field .button { min-height: 40px; }
</style>
