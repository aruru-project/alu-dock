<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationProcessItem } from '../lib/types'

const props = defineProps<{
  parts: ConversationProcessItem[]
  renderMarkdown: (text: string) => string
  toolOpen: (id: string) => boolean
}>()
const emit = defineEmits<{ toolToggle: [id: string, event: Event] }>()
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
    <div v-else-if="part.kind === 'image'" class="msg-user-image-missing" :data-conversation-id="part.id">[附件 · {{ part.mimeType }}]</div>
    <div v-else :class="[part.tone === 'error' ? 'msg-error' : part.tone === 'warning' ? 'msg-warning' : 'msg-notice', { 'alu-hideable': part.tone === 'info' }]" :data-conversation-id="part.id">{{ part.text }}</div>
  </template>
</template>
