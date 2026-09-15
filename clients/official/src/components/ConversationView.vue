<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw } from '@lucide/vue'
import ConversationRow from './ConversationRow.vue'
import { conversationRows } from '../lib/conversationPresentation'
import type { ConversationImageResource, ConversationItem, ConversationProcessItem } from '../lib/types'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>

const props = defineProps<{
  items: ConversationItem[]
  switching: boolean
  streamingParts: Set<string>
  historyLoading: boolean
  historyHydrating: boolean
  historyTruncated: boolean
  historyCursor: string | null
  historyError: string | null
  attachmentPreviews: Record<string, { url: string; mediaType: string }>
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
}>()

const emit = defineEmits<{
  loadEarlier: []
  retryHistory: []
  toolToggle: [id: string, event: Event]
  imageRequest: [part: ImagePart]
  imagePreview: [part: ImagePart]
  imageFailed: [part: ImagePart]
  attachmentPreview: [fileId: string, name: string]
  openText: [title: string, text: string, markdown?: boolean]
}>()

const rows = computed((previous?: ReturnType<typeof conversationRows>) => {
  const prior = new Map(previous?.map((row) => [row.id, row]))
  return conversationRows(props.items).map((row) => {
    const old = prior.get(row.id)
    if (row.kind === 'assistant-group' && old?.kind === 'assistant-group' && row.time === old.time
      && row.parts.length === old.parts.length && row.parts.every((part, index) => part === old.parts[index])) return old
    return row
  })
})
</script>

<template>
  <div class="conversation-flow" data-conversation-flow :class="{ 'is-switching': switching }" role="log" aria-live="polite" aria-relevant="additions text">
    <div v-if="historyLoading || historyHydrating || historyTruncated || historyError" class="history-loader">
      <button v-if="historyTruncated" :disabled="historyLoading || !historyCursor" @click="emit('loadEarlier')"><RefreshCw :size="14" :class="{ spinning: historyLoading }" />{{ historyLoading ? '加载中…' : '加载更早记录' }}</button>
      <button v-if="historyError" :disabled="historyLoading" @click="emit('retryHistory')"><RefreshCw :size="14" />重试读取</button>
      <span v-if="historyHydrating">正在载入图片与较长内容…</span>
      <span v-if="historyError">{{ historyError }}</span>
    </div>
    <template v-for="row in rows" :key="row.id">
      <ConversationRow :row="row" :streaming-parts="streamingParts" :attachment-previews="attachmentPreviews" :tool-open="toolOpen" :image-resource="imageResource"
        @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)"
        @attachment-preview="(id, name) => emit('attachmentPreview', id, name)" @open-text="(title, text, markdown) => emit('openText', title, text, markdown)" />
    </template>
  </div>
</template>
