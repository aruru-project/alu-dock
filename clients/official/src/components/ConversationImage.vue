<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>

const props = defineProps<{
  part: ImagePart
  resource: ConversationImageResource
}>()
const emit = defineEmits<{
  request: [part: ImagePart]
  preview: [part: ImagePart]
  failed: [part: ImagePart]
}>()

const surface = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
const label = computed(() => props.part.name || '图片结果')

function stopObserving() {
  observer?.disconnect()
  observer = null
}

function observeVisibility() {
  stopObserving()
  if (!props.part.source || props.resource.state !== 'idle') return
  const element = surface.value
  if (!element || typeof IntersectionObserver === 'undefined') {
    emit('request', props.part)
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || props.resource.state !== 'idle') return
    stopObserving()
    emit('request', props.part)
  }, {
    root: element.closest('.alu-output'),
    rootMargin: '320px 0px',
  })
  observer.observe(element)
}

onMounted(observeVisibility)
onBeforeUnmount(stopObserving)
watch(() => [props.part.imageKey, props.part.source, props.resource.state] as const, async () => {
  await nextTick()
  observeVisibility()
})
</script>

<template>
  <figure ref="surface" class="alu-conversation-image" :class="`is-${resource.state}`" :data-conversation-id="part.id">
    <button v-if="resource.state === 'ready' && resource.url" type="button" class="alu-conversation-image-open" :aria-label="`预览${label}`" @click="emit('preview', part)">
      <img :src="resource.url" :alt="label" loading="lazy" decoding="async" @error="emit('failed', part)" />
    </button>
    <div v-else-if="resource.state === 'loading'" class="alu-conversation-image-state" role="status">
      <span class="alu-spinner" aria-hidden="true" />
      <span>正在读取图片…</span>
    </div>
    <div v-else-if="resource.state === 'error'" class="alu-conversation-image-state is-error" role="status">
      <strong>图片暂时无法显示</strong>
      <span>{{ resource.message || '请稍后重试。' }}</span>
      <button v-if="part.source || part.historyEntryId" type="button" @click="emit('request', part)">重试</button>
    </div>
    <div v-else-if="!part.source" class="alu-conversation-image-state" role="status">
      <span>等待读取图片…</span>
    </div>
    <div v-else class="alu-conversation-image-state" role="status">等待读取图片…</div>
    <figcaption v-if="part.name">{{ part.name }}</figcaption>
  </figure>
</template>

<style scoped>
/* Protocol V2 portable conversation images */
.alu-conversation-image {
  width: min(680px, 100%);
  margin: 10px 0 4px;
  overflow: hidden;
  border: 1px solid var(--alu-border-light);
  border-radius: 12px;
  background: color-mix(in srgb, var(--alu-bg-raised) 90%, black);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
}
.alu-conversation-image-open {
  display: block;
  width: 100%;
  padding: 0;
  cursor: zoom-in;
  border: 0;
  background: #090b12;
}
.alu-conversation-image-open img {
  display: block;
  width: 100%;
  max-height: min(66dvh, 720px);
  object-fit: contain;
}
.alu-conversation-image-state {
  display: flex;
  min-height: 132px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 20px;
  color: var(--alu-text-muted);
  font-size: 10px;
  text-align: center;
}
.alu-conversation-image-state.is-error strong { color: var(--alu-text); font-size: 11px; }
.alu-conversation-image-state.is-error button {
  min-height: 28px;
  padding: 0 11px;
  cursor: pointer;
  border: 1px solid var(--alu-border-light);
  border-radius: 7px;
  color: var(--alu-blue);
  background: var(--alu-bg);
  font: inherit;
}
.alu-conversation-image figcaption {
  overflow: hidden;
  padding: 8px 11px;
  border-top: 1px solid var(--alu-border);
  color: var(--alu-text-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-user-images .alu-conversation-image {
  width: min(320px, 100%);
  margin: 0;
  border-color: var(--alu-user-border);
  box-shadow: none;
}
.msg-user-images .alu-conversation-image-open img { max-height: 320px; }
@media (max-width: 680px) {
  .alu-conversation-image { border-radius: 9px; }
  .alu-conversation-image-open img { max-height: 56vh; max-height: 56dvh; }
}
</style>
