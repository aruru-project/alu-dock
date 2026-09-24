<script setup lang="ts">
import { FileText } from '@lucide/vue'
import AttachmentCard from './AttachmentCard.vue'
import ConversationProcessParts from './ConversationProcessParts.vue'
import { hasCompactConversationContent } from '../lib/conversation'
import { assistantMarkdownSource, type ConversationRow } from '../lib/conversationPresentation'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
defineProps<{
  row: ConversationRow
  streamingParts: ReadonlySet<string>
  attachmentPreviews: Record<string, { url: string; mediaType: string }>
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
}>()
const emit = defineEmits<{
  toolToggle: [id: string, event: Event]
  imageRequest: [part: ImagePart]
  imagePreview: [part: ImagePart]
  imageFailed: [part: ImagePart]
  attachmentPreview: [fileId: string, name: string]
  openText: [title: string, text: string, markdown?: boolean]
}>()
const hasAssistant = (parts: ConversationProcessItem[]) => parts.some((part) => part.kind === 'assistant')
</script>

<template>
      <article v-if="row.kind === 'user'" class="conversation-row msg-user" :data-conversation-id="row.id" :aria-label="`你的消息 ${row.time}`">
        <div class="msg-user-bubble">
          <div class="msg-user-top"><span class="msg-user-prefix">&gt;</span><span v-if="row.text" class="msg-user-text">{{ row.text }}</span></div>
          <div v-if="row.images?.length" class="msg-user-images"><ConversationProcessParts :parts="row.images" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div>
          <div v-if="row.attachments?.length" class="message-attachments"><AttachmentCard v-for="attachment in row.attachments" :key="attachment.fileId" compact :name="attachment.name" :size-bytes="attachment.sizeBytes" :media-type="attachment.mediaType" :preview-url="attachmentPreviews[attachment.fileId]?.url" @preview="emit('attachmentPreview', attachment.fileId, attachment.name)" /></div>
          <div v-if="row.text || row.time" class="msg-timestamp"><button v-if="row.text" type="button" class="message-text-action" aria-label="查看你的消息原文" @click="emit('openText', '你的消息', row.text)"><FileText :size="12" />原文</button><span>{{ row.time }}</span></div>
        </div>
      </article>

      <article v-else-if="row.kind === 'assistant-group'" class="conversation-row alu-msg-assistant-row" :class="{ 'is-compact-empty': !hasCompactConversationContent(row.parts) }" :data-conversation-id="row.id" :aria-label="`Agent 回复 ${row.time}`">
        <img src="../assets/console_icon_small.png" alt="Agent" class="alu-msg-avatar" />
        <div class="alu-msg-assistant-content">
          <div class="alu-msg-assistant-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div>
          <div v-if="hasAssistant(row.parts) || row.time" class="msg-assistant-timestamp"><button v-if="hasAssistant(row.parts)" type="button" class="message-text-action" aria-label="查看 Agent 回复原文" @click="emit('openText', 'Agent 回复', assistantMarkdownSource(row.parts), true)"><FileText :size="12" />原文</button><span>{{ row.time }}</span></div>
        </div>
      </article>

      <article v-else-if="row.kind === 'activity'" class="conversation-row alu-msg-assistant-row is-agent-active" :data-conversation-id="row.id">
        <img src="../assets/console_icon_small.png" alt="Agent" class="alu-msg-avatar" />
        <div class="alu-msg-assistant-content"><div class="alu-msg-assistant-body"><div class="alu-agent-activity" role="status" aria-label="正在处理" title="正在处理"><span class="alu-agent-activity-spinner" aria-hidden="true" /></div></div></div>
      </article>

      <details v-else-if="row.kind === 'record' && row.folded" class="conversation-row alu-record-panel alu-hideable" :class="row.panelClass" :data-conversation-id="row.id"><summary>{{ row.title }}</summary><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div></details>

      <section v-else-if="row.kind === 'record'" class="conversation-row alu-record-panel" :class="[row.panelClass, { 'is-compact-empty': !hasCompactConversationContent(row.parts) }]" :data-conversation-id="row.id"><div class="alu-record-title alu-hideable">{{ row.title }}</div><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div></section>

      <div v-else class="conversation-row alu-live-notice-row" :class="{ 'alu-hideable': row.tone === 'info' }" :data-conversation-id="row.id"><div :class="row.tone === 'error' ? 'msg-error' : row.tone === 'warning' ? 'msg-warning' : 'msg-notice'">{{ row.text }}</div></div>
</template>
