<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
import ConversationImage from './ConversationImage.vue'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
type ThinkingPart = Extract<ConversationProcessItem, { kind: 'thinking' }>

const props = defineProps<{
  parts: ConversationProcessItem[]
  renderMarkdown: (text: string) => string
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
const thinkingOpen = reactive(new Map<string, boolean>())
const thinkingTouched = new Set<string>()

function thinkingIsOpen(part: ThinkingPart) {
  return thinkingOpen.get(part.id) ?? Boolean(part.open || props.streamingParts?.has(part.id))
}

function markThinkingInteraction(part: ThinkingPart) {
  thinkingTouched.add(part.id)
}

function rememberThinkingState(part: ThinkingPart, event: Event) {
  if (!thinkingTouched.has(part.id)) return
  thinkingOpen.set(part.id, (event.currentTarget as HTMLDetailsElement).open)
}
</script>

<template>
  <template v-for="part in orderedParts" :key="part.id">
    <details v-if="part.kind === 'thinking'" class="msg-thinking alu-hideable" :open="thinkingIsOpen(part)" :data-conversation-id="part.id" @toggle="rememberThinkingState(part, $event)">
      <summary @click="markThinkingInteraction(part)">thinking...</summary><div class="think-content">{{ part.text }}</div>
    </details>
    <div v-else-if="part.kind === 'assistant' && streamingParts?.has(part.id)" class="msg-assistant msg-text is-streaming" :data-conversation-id="part.id">{{ part.text }}</div>
    <div v-else-if="part.kind === 'assistant'" class="msg-assistant msg-text" :data-conversation-id="part.id" v-html="renderMarkdown(part.text)" />
    <div v-else-if="part.kind === 'tool'" class="msg-toolcall alu-hideable" :class="{ 'is-error': part.status === 'error' }" :data-conversation-id="part.id">
      <div class="tool-call-header">
        <span class="tool-name"><span aria-hidden="true">⚙</span>{{ part.name }}</span>
        <span class="tool-status" :data-status="part.status">{{ part.summary }}</span>
      </div>
      <div v-if="part.preview" class="tool-call-preview" :class="`is-${part.preview.variant}`">
        <div v-if="part.preview.title || part.preview.truncated" class="tool-call-preview-meta"><span v-if="part.preview.title" class="tool-call-preview-title">{{ part.preview.title }}</span><span v-if="part.preview.truncated" class="tool-call-preview-truncated">已省略</span></div>
        <pre v-if="part.preview.body" class="tool-call-preview-body">{{ part.preview.body }}</pre>
      </div>
      <details :open="toolOpen(part.id)" @toggle="emit('toolToggle', part.id, $event)">
        <summary><span>参数与结果</span><span class="tool-disclosure" aria-hidden="true">›</span></summary>
        <pre v-if="toolOpen(part.id)" class="tool-output msg-tool-output">{{ part.detail }}</pre>
      </details>
    </div>
    <ConversationImage v-else-if="part.kind === 'image'" :part="part" :resource="imageResource(part)" @request="emit('imageRequest', $event)" @preview="emit('imagePreview', $event)" @failed="emit('imageFailed', $event)" />
    <div v-else :class="[part.tone === 'error' ? 'msg-error' : part.tone === 'warning' ? 'msg-warning' : 'msg-notice', { 'alu-hideable': part.tone === 'info' }]" :data-conversation-id="part.id">{{ part.text }}</div>
  </template>
</template>
