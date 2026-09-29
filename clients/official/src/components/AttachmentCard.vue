<script setup lang="ts">
import { AlertCircle, CheckCircle2, File, LoaderCircle, RotateCcw, X } from '@lucide/vue'
import { formatFileSize } from '../lib/fileSize'

const props = withDefaults(defineProps<{
  name: string
  sizeBytes: number
  mediaType?: string
  state?: 'ready' | 'hashing' | 'uploading' | 'finalizing' | 'error' | 'queued'
  progress?: number
  message?: string
  removable?: boolean
  retryable?: boolean
  cancellable?: boolean
  compact?: boolean
  previewUrl?: string
}>(), { state: 'ready', progress: 0, removable: false, retryable: false, cancellable: false, compact: false })
const emit = defineEmits<{ remove: []; retry: []; cancel: []; preview: [] }>()

function stateText() {
  if (props.message) return props.message
  if (props.state === 'hashing') return '正在准备'
  if (props.state === 'uploading') return '正在上传'
  if (props.state === 'finalizing') return '正在确认'
  if (props.state === 'error') return '上传失败'
  if (props.state === 'queued') return '排队中'
  return '已就绪'
}
</script>

<template>
  <article class="attachment-card" :class="[`is-${state}`, { compact, 'is-previewable': previewUrl }]" :aria-label="`附件 ${name}，${stateText()}`">
    <component
      :is="previewUrl ? 'button' : 'div'"
      class="attachment-preview-trigger"
      :type="previewUrl ? 'button' : undefined"
      :aria-label="previewUrl ? `预览图片附件 ${name}` : undefined"
      :title="previewUrl ? `点击预览 ${name}` : undefined"
      @click="previewUrl && emit('preview')"
    >
      <div class="attachment-icon" :class="{ 'has-thumbnail': previewUrl }" aria-hidden="true">
        <img v-if="previewUrl" class="attachment-thumbnail" :src="previewUrl" alt="" />
        <LoaderCircle v-else-if="['hashing', 'uploading', 'finalizing'].includes(state)" :size="17" class="spinning" />
        <AlertCircle v-else-if="state === 'error'" :size="17" />
        <CheckCircle2 v-else-if="state === 'ready'" :size="17" />
        <File v-else :size="17" />
      </div>
      <div class="attachment-copy">
        <strong :title="name">{{ name }}</strong>
        <span>{{ formatFileSize(sizeBytes) }}<template v-if="mediaType"> · {{ mediaType }}</template></span>
        <div v-if="['hashing', 'uploading', 'finalizing'].includes(state)" class="attachment-progress" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${name} ${stateText()}`">
          <i :style="{ width: `${Math.max(3, Math.min(100, progress * 100))}%` }" />
        </div>
        <small v-else-if="state === 'error'">{{ stateText() }}</small>
      </div>
    </component>
    <div v-if="retryable || cancellable || removable" class="attachment-actions">
      <button v-if="retryable" type="button" :aria-label="`重试处理 ${name}`" :title="`重试处理 ${name}`" @click="emit('retry')"><RotateCcw :size="15" /></button>
      <button v-if="cancellable" type="button" :aria-label="`取消上传 ${name}`" :title="`取消上传 ${name}`" @click="emit('cancel')"><X :size="15" /></button>
      <button v-else-if="removable" type="button" :aria-label="`移除附件 ${name}`" :title="`移除附件 ${name}`" @click="emit('remove')"><X :size="15" /></button>
    </div>
  </article>
</template>

<style scoped>
.attachment-card { display: flex; min-width: 0; min-height: 58px; align-items: center; gap: 9px; padding: 8px 9px; color: var(--c-text-1); font-family: var(--font-reading); background: linear-gradient(135deg, rgb(23 48 63 / .46), rgb(17 24 40 / .88)); border: 1px solid rgb(126 200 224 / .2); border-radius: 10px; }
.attachment-card.compact { min-height: 48px; padding: 6px 8px; background: rgb(8 12 24 / .42); }
.attachment-card.is-error { background: rgb(63 25 31 / .45); border-color: rgb(248 113 113 / .28); }
.attachment-card.is-queued { border-color: rgb(251 191 36 / .18); }
.attachment-preview-trigger { display: flex; min-width: 0; flex: 1; align-items: center; gap: 9px; color: inherit; font: inherit; text-align: left; }
button.attachment-preview-trigger { margin: -4px; padding: 4px; cursor: zoom-in; background: transparent; border: 0; border-radius: 8px; }
button.attachment-preview-trigger:hover { background: rgb(126 200 224 / .07); }
button.attachment-preview-trigger:focus-visible { outline: 2px solid var(--c-ice); outline-offset: 1px; }
.attachment-icon { display: grid; width: 32px; height: 32px; flex: 0 0 auto; color: var(--c-ice); background: var(--c-ice-soft); border-radius: 9px; place-items: center; }
.attachment-icon.has-thumbnail { width: 42px; height: 42px; overflow: hidden; background: #090b12; }
.attachment-card.compact .attachment-icon.has-thumbnail { width: 36px; height: 36px; }
.attachment-thumbnail { display: block; width: 100%; height: 100%; object-fit: cover; }
.attachment-card.is-error .attachment-icon { color: var(--c-danger); background: rgb(248 113 113 / .08); }
.attachment-copy { min-width: 0; flex: 1; }
.attachment-copy strong { display: block; overflow: hidden; font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.attachment-copy span, .attachment-copy small { display: block; margin-top: 3px; overflow: hidden; color: var(--c-text-3); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.attachment-copy small { color: #f4a2a2; }
.attachment-actions { display: flex; flex: 0 0 auto; gap: 2px; }
.attachment-actions button { display: grid; width: 34px; height: 34px; padding: 0; color: var(--c-text-2); cursor: pointer; background: transparent; border: 0; border-radius: 8px; place-items: center; }
.attachment-actions button:hover { color: var(--c-text-1); background: var(--c-space-800); }
@media (max-width: 640px) {
  .attachment-actions button { min-height: 44px; height: 44px; }
}
.alu-native-attachments .attachment-card.is-previewable { min-height: 82px; }
.alu-native-attachments .attachment-card.is-previewable .attachment-icon.has-thumbnail { width: 96px; height: 66px; border-radius: 8px; }
</style>
