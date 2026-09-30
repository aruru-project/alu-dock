<script setup lang="ts">
import { FileText } from '@lucide/vue'
import AttachmentCard from './AttachmentCard.vue'
import ConversationProcessParts from './ConversationProcessParts.vue'
import { assistantMarkdownSource, partVisibleWhenCollapsed, type ConversationRow } from '../lib/conversationPresentation'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
defineProps<{
  row: ConversationRow
  streamingParts: ReadonlySet<string>
  attachmentPreviews: Record<string, { url: string; mediaType: string }>
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
  /** Inside a collapsed turn only images, warnings/errors and the final reply remain. */
  collapsed?: boolean
  /** This row is the turn's final Agent message: its text stays when collapsed. */
  finalRow?: boolean
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
/** The final reply's row stays while its text is still being read, or when the run
 * ended before any text; say so instead of leaving an empty bubble. */
const finalReplyMissing = (parts: ConversationProcessItem[]) => !parts.some((part) => partVisibleWhenCollapsed(part, true))
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

      <article v-else-if="row.kind === 'assistant-group'" class="conversation-row alu-msg-assistant-row" :data-conversation-id="row.id" :aria-label="`Agent 回复 ${row.time}`">
        <img src="../assets/console_icon_small.png" alt="Agent" class="alu-msg-avatar" />
        <div class="alu-msg-assistant-content">
          <div class="alu-msg-assistant-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" :collapsed="collapsed" :final-row="finalRow" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /><div v-if="collapsed && finalRow && finalReplyMissing(row.parts)" class="msg-notice">回复正文未显示；点上方摘要行可查看这一轮的过程。</div></div>
          <div v-if="hasAssistant(row.parts) || row.time" class="msg-assistant-timestamp"><button v-if="hasAssistant(row.parts)" type="button" class="message-text-action" aria-label="查看 Agent 回复原文" @click="emit('openText', 'Agent 回复', assistantMarkdownSource(row.parts), true)"><FileText :size="12" />原文</button><span>{{ row.time }}</span></div>
        </div>
      </article>

      <details v-else-if="row.kind === 'record' && row.folded" class="conversation-row alu-record-panel" :class="row.panelClass" :data-conversation-id="row.id"><summary>{{ row.title }}</summary><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" :collapsed="collapsed" :final-row="finalRow" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div></details>

      <section v-else-if="row.kind === 'record'" class="conversation-row alu-record-panel" :class="row.panelClass" :data-conversation-id="row.id"><div class="alu-record-title">{{ row.title }}</div><div class="alu-record-body"><ConversationProcessParts :parts="row.parts" :streaming-parts="streamingParts" :tool-open="toolOpen" :image-resource="imageResource" :collapsed="collapsed" :final-row="finalRow" @tool-toggle="(id, event) => emit('toolToggle', id, event)" @image-request="emit('imageRequest', $event)" @image-preview="emit('imagePreview', $event)" @image-failed="emit('imageFailed', $event)" /></div></section>

      <div v-else-if="row.kind === 'notice'" class="conversation-row alu-live-notice-row" :data-conversation-id="row.id"><div :class="row.tone === 'error' ? 'msg-error' : row.tone === 'warning' ? 'msg-warning' : 'msg-notice'">{{ row.text }}</div></div>
</template>

<style scoped>
/* Assistant 消息行：头像 + 内容 */
.alu-msg-assistant-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin: 20px 0;
  max-width: 100%;
}
.alu-msg-avatar {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  margin-top: 0;
  border: 2px solid var(--alu-pink-border);
  box-shadow: 0 0 12px rgba(244, 114, 182, 0.35), 0 0 28px rgba(244, 114, 182, 0.10);
}
.alu-msg-assistant-content {
  flex: 1;
  min-width: 0;
}
.alu-msg-assistant-body {
  background: rgba(20, 30, 52, 0.82);
  border: 1px solid #253050;
  border-radius: 0 14px 14px 14px;
  padding: 14px 18px;
  font-size: 14px;
  line-height: 1.7;
}
/* 用户消息 — 右对齐卡片 */
.msg-user {
  display: flex;
  justify-content: flex-end;
  margin: 20px 0;
}
.msg-user-bubble {
  max-width: 72%;
  background: var(--alu-user-bg);
  border: 1px solid var(--alu-user-border);
  border-radius: 14px 14px 0 14px;
  padding: 14px 18px 10px;
  font-size: 14px;
  line-height: 1.7;
}
.msg-user-top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.msg-user-prefix {
  color: var(--alu-amber);
  font-weight: 600;
  opacity: 0.85;
  flex-shrink: 0;
  margin-top: 1px;
}
.msg-user-text {
  color: var(--alu-user-text);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}
.msg-timestamp {
  display: flex;
  justify-content: flex-end;
  margin-top: 5px;
  color: var(--alu-text-faint);
  font-size: 10px;
}
.msg-assistant-timestamp {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
  padding: 0 2px;
  color: var(--alu-text-faint);
  font-size: 10px;
}
.msg-timestamp,
.msg-assistant-timestamp {
  align-items: center;
  gap: 7px;
}
.msg-timestamp > span { opacity: .7; }
.msg-assistant-timestamp > span { opacity: .65; }
.message-text-action {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 4px;
  margin-right: auto;
  padding: 3px 7px;
  color: var(--alu-text-muted);
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}
@media (max-width: 640px) {
  .message-text-action { min-height: 36px; padding-inline: 8px; }
}
.message-text-action:hover,
.message-text-action:focus-visible {
  color: var(--alu-blue);
  border-color: var(--alu-blue-border);
  background: color-mix(in srgb, var(--alu-blue) 6%, transparent);
}
/* Runtime/status notices align with Assistant content instead of becoming
   full-width headless conversation rows. */
.alu-live-notice-row {
  display: flex;
  align-items: flex-start;
  margin: 6px 0 6px 68px;
  max-width: calc(100% - 68px);
}
.alu-live-notice-row > * {
  flex: 0 1 auto;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.alu-record-panel {
  margin: 6px 0;
  padding: 8px 10px;
  border-left: 2px solid var(--alu-border);
  color: var(--alu-text-dim);
  background: rgba(255, 255, 255, 0.015);
}
.alu-record-panel > summary {
  color: var(--alu-text-muted);
  cursor: pointer;
  font-size: 11px;
}
.alu-record-title {
  margin-bottom: 4px;
  color: var(--alu-text-muted);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.alu-record-body { min-width: 0; }
.alu-record-summary { border-left-color: var(--alu-blue-border); }
.alu-record-extension { border-left-color: var(--alu-pink); }
.alu-record-tool, .alu-record-shell { border-left-color: var(--alu-amber); }
.alu-msg-assistant-row, .msg-user {
  animation: msgSlideIn 0.22s ease-out;
}
/* 用户上传图（消息内联，简洁模式不隐藏） */
.msg-user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.message-attachments { display: grid; gap: 5px; margin-top: 9px; }
@media (max-width: 1000px) {
  .alu-msg-avatar { display: none; }
  .alu-msg-assistant-row {
    width: 100%;
    gap: 0;
    margin: 18px 0;
  }
  .alu-msg-assistant-content {
    width: 100%;
    max-width: none;
  }
  .alu-msg-assistant-body {
    width: 100%;
    max-width: none;
    padding: 0;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .msg-user { margin: 18px 0; }
  .msg-user-bubble {
    max-width: min(86%, 620px);
    padding: 11px 13px 8px;
    border-radius: 14px 14px 3px 14px;
  }
  .alu-live-notice-row,
  .alu-record-panel {
    max-width: 100%;
    margin-right: 0;
    margin-left: 0;
  }
}
@media (max-width: 640px) {
  .msg-user-bubble { max-width: 92%; }
}
@media (min-width: 1200px) {
  .alu-record-panel > summary,
  .alu-record-title {
    font-size: var(--alu-meta-size);
  }
  .msg-timestamp,
  .msg-assistant-timestamp {
    font-size: var(--alu-meta-size);
  }
}
</style>
