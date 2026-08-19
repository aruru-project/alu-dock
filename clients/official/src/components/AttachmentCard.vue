<script setup lang="ts">
import { AlertCircle, CheckCircle2, File, LoaderCircle, RotateCcw, X } from '@lucide/vue'

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

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MiB`
}
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
        <span>{{ bytes(sizeBytes) }}<template v-if="mediaType"> · {{ mediaType }}</template></span>
        <div v-if="['hashing', 'uploading', 'finalizing'].includes(state)" class="attachment-progress" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${name} ${stateText()}`">
          <i :style="{ width: `${Math.max(3, Math.min(100, progress * 100))}%` }" />
        </div>
        <small v-else-if="state === 'error'">{{ stateText() }}</small>
      </div>
    </component>
    <div v-if="retryable || cancellable || removable" class="attachment-actions">
      <button v-if="retryable" type="button" :aria-label="`重试上传 ${name}`" :title="`重试上传 ${name}`" @click="emit('retry')"><RotateCcw :size="15" /></button>
      <button v-if="cancellable" type="button" :aria-label="`取消上传 ${name}`" :title="`取消上传 ${name}`" @click="emit('cancel')"><X :size="15" /></button>
      <button v-else-if="removable" type="button" :aria-label="`移除附件 ${name}`" :title="`移除附件 ${name}`" @click="emit('remove')"><X :size="15" /></button>
    </div>
  </article>
</template>
