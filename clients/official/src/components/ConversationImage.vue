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

function requestWhenVisible() {
  stopObserving()
  if (!props.part.source || props.resource.state !== 'idle') return
  const element = surface.value
  if (!element || typeof IntersectionObserver === 'undefined') {
    emit('request', props.part)
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    stopObserving()
    emit('request', props.part)
  }, {
    root: element.closest('.alu-output'),
    rootMargin: '320px 0px',
  })
  observer.observe(element)
}

onMounted(requestWhenVisible)
onBeforeUnmount(stopObserving)
watch(() => [props.part.imageKey, props.resource.state] as const, async () => {
  await nextTick()
  requestWhenVisible()
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
      <button v-if="part.source" type="button" @click="emit('request', part)">重试</button>
    </div>
    <div v-else-if="!part.source" class="alu-conversation-image-state">
      <span>这张历史图片已不可用。</span>
    </div>
    <div v-else class="alu-conversation-image-state" role="status">等待读取图片…</div>
    <figcaption v-if="part.name">{{ part.name }}</figcaption>
  </figure>
</template>
