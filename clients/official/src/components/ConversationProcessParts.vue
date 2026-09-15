<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
import ConversationProcessPart from './ConversationProcessPart.vue'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>

const props = defineProps<{
  parts: ConversationProcessItem[]
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
  /** 正在流式增长的条目 id：这些条目按纯文本渲染，等 message.completed 后再做 markdown 排版，
   *  避免每个 token 都对全文跑一遍 marked + DOMPurify。 */
  streamingParts?: Set<string>
}>()
const emit = defineEmits<{
  toolToggle: [id: string, event: Event]
  imageRequest: [part: ImagePart]
  imagePreview: [part: ImagePart]
  imageFailed: [part: ImagePart]
}>()
const orderedParts = computed(() => [
  ...props.parts.filter((part) => part.kind === 'thinking'),
  ...props.parts.filter((part) => part.kind !== 'thinking'),
])
</script>

<template>
  <ConversationProcessPart v-for="part in orderedParts" :key="part.id" :part="part" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource"
    @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" />
</template>
