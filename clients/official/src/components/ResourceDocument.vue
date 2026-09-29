<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, RotateCw } from '@lucide/vue'
import { getResourceContent, systemContent } from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { userErrorMessage } from '../lib/userError'
import type { ResourceInfo, SystemCandidate, Work } from '../lib/types'
import { useAppStore } from '../stores/app'
import MarkdownDocumentSurface from './MarkdownDocumentSurface.vue'

const props = defineProps<{
  work?: Work
  resource?: ResourceInfo
  system?: { cwd: string; hostId: string; candidate: SystemCandidate }
}>()
const emit = defineEmits<{ back: []; failed: [cause: unknown] }>()
const app = useAppStore()
const name = computed(() => props.system?.candidate.name ?? props.resource?.name ?? '')
const sourceKey = computed(() => props.system
  ? `${props.system.hostId}:${props.system.cwd}:${props.system.candidate.id}`
  : `${props.work?.id}:${props.resource?.contentRef}`)
const backButton = ref<HTMLButtonElement | null>(null)
onMounted(() => backButton.value?.focus())
const loading = ref(false)
const error = ref('')
const text = ref('')
const revision = ref('')
let readEpoch = 0

watch([
  () => app.connectionContext?.connectionId,
  () => app.connectionContext?.selectionGeneration,
  () => props.work?.id,
  () => props.work?.ownerHostEpoch,
  () => props.work?.runtimeGeneration,
  () => props.resource?.contentRef,
  () => sourceKey.value,
], () => { void load() }, { immediate: true, flush: 'sync' })
onUnmounted(() => { readEpoch += 1 })

async function load() {
  const epoch = ++readEpoch
  const instanceId = props.work?.id
  const contentRef = props.resource?.contentRef
  text.value = ''
  revision.value = ''
  error.value = ''
  loading.value = true
  try {
    if (!props.system && (!contentRef || !instanceId)) throw new Error('这份资源没有可读取的正文。请返回项目状态重新选择。')
    const system = props.system
    const content = await currentConnectionCall(app, (context) => system
      ? systemContent(system.cwd, system.candidate.id, context, system.hostId)
      : getResourceContent(instanceId!, contentRef!, context))
    if (epoch !== readEpoch) return
    text.value = content.text
    revision.value = content.revision
  } catch (cause) {
    if (epoch === readEpoch) {
      if (props.system) emit('failed', cause)
      else error.value = userErrorMessage(cause, '资源正文读取失败。请返回列表后重新打开，或重试。')
    }
  } finally {
    if (epoch === readEpoch) loading.value = false
  }
}
</script>

<template>
  <section class="resource-document" aria-label="资源正文">
    <header class="resource-document-header">
      <button ref="backButton" type="button" class="resource-document-back" :aria-label="system ? '返回 system 选择' : '返回资源列表'" @click="emit('back')"><ArrowLeft :size="17" /></button>
      <div class="resource-document-title"><strong>{{ name }}</strong><span>{{ system ? '文件当前正文 · 阅读不会创建 Work' : '文件当前正文 · 阅读不会重新加载资源' }}</span></div>
    </header>
    <div v-if="loading" class="resource-document-status" role="status"><span class="alu-agent-activity-spinner" />正在读取正文…</div>
    <div v-else-if="error" class="resource-document-status resource-document-error" role="alert"><p>{{ error }}</p><button type="button" class="ui-dialog-btn" @click="load"><RotateCw :size="14" />重试</button></div>
    <template v-else>
      <span v-if="text === ''" class="resource-document-empty">文件为空。</span>
      <MarkdownDocumentSurface :source="text" :document-key="`${sourceKey}:${revision}`" :initial-mode="system?.candidate.kind === 'dock-template' ? 'source' : 'reading'" :aria-label="name" />
    </template>
  </section>
</template>

<style scoped>
.resource-document { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); height: min(62dvh, 640px); min-height: 240px; min-width: 0; }
.resource-document-header { display: flex; align-items: center; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--alu-border); }
.resource-document-back { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-border); border-radius: 8px; color: var(--alu-text-muted); background: transparent; }
.resource-document-back:hover { color: var(--alu-text); background: var(--alu-hover); }
.resource-document-title { display: grid; gap: 5px; min-width: 0; }
.resource-document-title strong { overflow-wrap: anywhere; color: var(--alu-text); font-size: 13px; }
.resource-document-title span { color: var(--alu-text-muted); font-size: 10px; }
.resource-document-status { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: var(--alu-text-muted); font-size: 12px; }
.resource-document-error { flex-direction: column; color: var(--alu-rose); text-align: center; }
.resource-document-error .ui-dialog-btn { display: inline-flex; align-items: center; gap: 6px; }
.resource-document-empty { position: absolute; right: 16px; bottom: 16px; z-index: 1; color: var(--alu-text-muted); font-size: 12px; }
@media (max-width: 720px) { .resource-document { height: 65dvh; } .resource-document-header { padding: 10px; gap: 8px; } }
</style>
