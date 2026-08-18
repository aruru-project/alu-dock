<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
import ConversationImage from './ConversationImage.vue'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>

const props = defineProps<{
  parts: ConversationProcessItem[]
  renderMarkdown: (text: string) => string
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
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
  <template v-for="part in orderedParts" :key="part.id">
    <details v-if="part.kind === 'thinking'" class="msg-thinking alu-hideable" :open="part.open" :data-conversation-id="part.id">
      <summary>thinking...</summary><div class="think-content">{{ part.text }}</div>
    </details>
    <div v-else-if="part.kind === 'assistant'" class="msg-assistant msg-text" :data-conversation-id="part.id" v-html="renderMarkdown(part.text)" />
    <div v-else-if="part.kind === 'tool'" class="msg-toolcall alu-hideable" :class="{ 'is-error': part.status === 'error' }" :data-conversation-id="part.id">
      <span class="tool-name">⚙ {{ part.name }}</span>
      <details :open="toolOpen(part.id)" @toggle="emit('toolToggle', part.id, $event)">
        <summary>{{ part.status === 'error' ? '失败' : '结果' }}</summary>
        <pre class="tool-output msg-tool-output">{{ part.detail }}</pre>
      </details>
    </div>
    <ConversationImage v-else-if="part.kind === 'image'" :part="part" :resource="imageResource(part)" @request="emit('imageRequest', $event)" @preview="emit('imagePreview', $event)" @failed="emit('imageFailed', $event)" />
    <div v-else :class="[part.tone === 'error' ? 'msg-error' : part.tone === 'warning' ? 'msg-warning' : 'msg-notice', { 'alu-hideable': part.tone === 'info' }]" :data-conversation-id="part.id">{{ part.text }}</div>
  </template>
</template>
