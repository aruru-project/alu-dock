<script setup lang="ts">
import { reactive } from 'vue'
import type { ConversationImageResource, ConversationProcessItem } from '../lib/types'
import { nestedCallRows, toolDetailText } from '../lib/conversation'
import ConversationImage from './ConversationImage.vue'
import MarkdownContent from './MarkdownContent.vue'

type ImagePart = Extract<ConversationProcessItem, { kind: 'image' }>
type ThinkingPart = Extract<ConversationProcessItem, { kind: 'thinking' }>

const props = defineProps<{
  part: ConversationProcessItem
  toolOpen: (id: string) => boolean
  imageResource: (part: ImagePart) => ConversationImageResource
  /** 正在流式增长的条目 id：这些条目按纯文本渲染，等 message.completed 后再做 markdown 排版，
   *  避免每个 token 都对全文跑一遍 marked + DOMPurify。 */
  streamingParts?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  toolToggle: [id: string, event: Event]
  imageRequest: [part: ImagePart]
  imagePreview: [part: ImagePart]
  imageFailed: [part: ImagePart]
}>()
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

    <details v-if="part.kind === 'thinking'" class="msg-thinking" :open="thinkingIsOpen(part)" :data-conversation-id="part.id" @toggle="rememberThinkingState(part, $event)">
      <summary @click="markThinkingInteraction(part)">thinking...</summary><div class="think-content">{{ part.text }}</div>
    </details>
    <div v-else-if="part.kind === 'assistant' && streamingParts?.has(part.id)" class="msg-assistant msg-text is-streaming" :data-conversation-id="part.id">{{ part.text }}</div>
    <MarkdownContent v-else-if="part.kind === 'assistant'" class="msg-assistant msg-text" :data-conversation-id="part.id" :source="part.text" />
    <div v-else-if="part.kind === 'tool'" class="msg-toolcall" :class="{ 'is-error': part.status === 'error' }" :data-conversation-id="part.id">
      <div class="tool-call-header">
        <span class="tool-name"><span aria-hidden="true">⚙</span>{{ part.name }}</span>
        <span class="tool-status" :data-status="part.status">{{ part.summary }}</span>
      </div>
      <div v-if="part.preview" class="tool-call-preview" :class="`is-${part.preview.variant}`">
        <div v-if="part.preview.title || part.preview.truncated" class="tool-call-preview-meta"><span v-if="part.preview.title" class="tool-call-preview-title">{{ part.preview.title }}</span><span v-if="part.preview.truncated" class="tool-call-preview-truncated">已省略</span></div>
        <pre v-if="part.preview.body" class="tool-call-preview-body">{{ part.preview.body }}</pre>
      </div>
      <ol v-if="part.nestedCalls?.calls.length" class="tool-nested-calls" aria-label="脚本调用的工具">
        <li v-if="nestedCallRows(part.nestedCalls).earlier" class="tool-nested-more">还有 {{ nestedCallRows(part.nestedCalls).earlier }} 个更早的调用，在「参数与结果」里查看</li>
        <li v-for="row in nestedCallRows(part.nestedCalls).rows" :key="row.key" class="tool-nested-call" :data-status="row.status">
          <span class="tool-nested-status" :title="row.label" :aria-label="row.label">{{ row.icon }}</span>
          <span class="tool-nested-name">{{ row.name }}</span>
          <span v-if="row.args" class="tool-nested-args">{{ row.args }}</span>
          <span v-if="row.duration" class="tool-nested-duration">{{ row.duration }}</span>
        </li>
        <li v-if="!part.nestedCalls.complete" class="tool-nested-more">有些调用或参数太大，没有保留。</li>
      </ol>
      <details :open="toolOpen(part.id)" @toggle="emit('toolToggle', part.id, $event)">
        <summary><span>参数与结果</span><span class="tool-disclosure" aria-hidden="true">›</span></summary>
        <pre v-if="toolOpen(part.id)" class="tool-output msg-tool-output">{{ toolDetailText(part) }}</pre>
      </details>
    </div>
    <ConversationImage v-else-if="part.kind === 'image'" :part="part" :resource="imageResource(part)" @request="emit('imageRequest', $event)" @preview="emit('imagePreview', $event)" @failed="emit('imageFailed', $event)" />
    <div v-else :class="part.tone === 'error' ? 'msg-error' : part.tone === 'warning' ? 'msg-warning' : 'msg-notice'" :data-conversation-id="part.id">{{ part.text }}</div>
</template>

<style scoped>
.msg-assistant {
  color: var(--alu-text);
  word-break: break-word;
  margin: 4px 0;
  font-size: 14px;
  line-height: 1.7;
}
/* ── Thinking 折叠 ── */
.msg-thinking {
  color: var(--alu-text-muted);
  font-style: italic;
  border-left: 2px solid var(--alu-blue-border);
  padding-left: 10px;
  margin: 4px 0;
  font-size: 12px;
}
.msg-thinking summary {
  cursor: pointer;
  color: var(--alu-text-muted);
  font-size: 11px;
}
.msg-thinking summary:hover { color: var(--alu-blue-dim); }
.think-content {
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 4px;
}
/* ── Tool calls ── */
.msg-toolcall {
  width: min(900px, 100%);
  margin: 5px 0;
  overflow: hidden;
  color: var(--alu-text-dim);
  font-size: 12px;
  background: color-mix(in srgb, var(--alu-amber) 4%, var(--alu-bg));
  border: 1px solid color-mix(in srgb, var(--alu-amber) 24%, var(--alu-border));
  border-radius: 8px;
}
.tool-call-header {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 10px;
}
.tool-name {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  overflow-wrap: anywhere;
  color: var(--alu-amber);
  font-weight: 600;
}
.tool-status {
  flex: 0 0 auto;
  color: var(--alu-text-muted);
  font-size: 10px;
}
.tool-status[data-status='running'] { color: var(--alu-blue); }
.tool-status[data-status='error'] { color: var(--alu-rose); }
.tool-call-preview {
  display: grid;
  gap: 5px;
  padding: 8px 10px 9px;
  border-top: 1px solid color-mix(in srgb, var(--alu-amber) 12%, var(--alu-border));
  background: color-mix(in srgb, var(--alu-amber) 3%, var(--alu-bg));
}
.tool-call-preview-meta { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 8px; }
.tool-call-preview-title {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--alu-text-dim);
  font: 600 10px/1.45 var(--font-mono);
}
.tool-call-preview-truncated { flex: 0 0 auto; color: var(--alu-text-faint); font-size: 9px; }
.tool-call-preview-body {
  margin: 0;
  overflow: hidden;
  color: color-mix(in srgb, var(--alu-text) 82%, var(--alu-text-muted));
  font: 10.5px/1.5 var(--font-mono);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.tool-nested-calls {
  margin: 0;
  padding: 7px 10px 8px;
  list-style: none;
  border-top: 1px solid color-mix(in srgb, var(--alu-amber) 12%, var(--alu-border));
  color: var(--alu-text-muted);
  font: 10.5px/1.6 var(--font-mono);
}
.tool-nested-call { display: flex; min-width: 0; align-items: baseline; gap: 6px; }
.tool-nested-status { flex: 0 0 auto; width: 1em; text-align: center; }
.tool-nested-call[data-status='ok'] .tool-nested-status { color: var(--alu-mint); }
.tool-nested-call[data-status='error'] .tool-nested-status { color: var(--alu-rose); }
.tool-nested-call[data-status='running'] .tool-nested-status { color: var(--alu-blue); }
.tool-nested-name { flex: 0 0 auto; color: var(--alu-text); }
.tool-nested-args { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-nested-duration { flex: 0 0 auto; color: var(--alu-text-faint); }
.tool-nested-more { color: var(--alu-text-faint); }
.tool-call-preview.is-diff .tool-call-preview-body { color: color-mix(in srgb, var(--alu-amber) 76%, var(--alu-text)); }
.tool-call-preview.is-path .tool-call-preview-body { color: var(--alu-text-muted); }
.msg-toolcall details { border-top: 1px solid color-mix(in srgb, var(--alu-amber) 14%, var(--alu-border)); }
.msg-toolcall details summary {
  display: flex;
  min-height: 27px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 10px;
  color: var(--alu-text-muted);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
}
.msg-toolcall details summary::-webkit-details-marker { display: none; }
.msg-toolcall details summary:hover { color: var(--alu-text); background: color-mix(in srgb, var(--alu-amber) 5%, transparent); }
.tool-disclosure { color: var(--alu-amber); font-size: 18px; line-height: 1; transition: transform .18s ease; }
.msg-toolcall details[open] .tool-disclosure { transform: rotate(90deg); }
.msg-toolcall.is-error { border-color: var(--alu-rose-border); }
.msg-tool-output {
  max-height: min(54vh, 520px);
  padding: 10px 12px;
  margin: 0;
  overflow: auto;
  color: var(--alu-text-muted);
  font-size: 11px;
  line-height: 1.58;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  background: color-mix(in srgb, var(--alu-bg) 92%, black);
  border: 0;
  border-top: 1px solid var(--alu-border);
  border-radius: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--alu-border-light) transparent;
}
@media (max-width: 1000px) {
  .alu-msg-assistant-body > .msg-assistant {
    margin: 0 0 7px;
    padding: 12px 14px;
    border: 1px solid #253050;
    border-radius: 3px 14px 14px 14px;
    background: rgba(20, 30, 52, .82);
  }
  .alu-msg-assistant-body > .msg-thinking {
    min-width: 0;
    margin: 0 0 6px;
    padding: 8px 11px;
    border: 1px solid var(--alu-border);
    border-left: 2px solid var(--alu-blue-border);
    border-radius: 3px 10px 10px 3px;
    background: color-mix(in srgb, var(--alu-bg-raised) 78%, transparent);
  }
  .alu-msg-assistant-body > .msg-toolcall {
    width: 100%;
    margin: 0 0 6px;
  }
  /* 对话区是窄屏唯一的纵向滚动容器。thinking 通过 details 折叠控制密度；
       展开后进入正常文档流，避免连续思考块形成嵌套滚动陷阱。 */
  .alu-msg-assistant-body .think-content {
    max-height: none;
    overflow: visible;
  }
  .msg-tool-output {
    max-height: min(34vh, 280px);
    max-height: min(34dvh, 280px);
    padding: 8px 10px;
    font-size: 10px;
    line-height: 1.55;
  }
}
@media (min-width: 1200px) {
  .msg-toolcall { font-size: var(--alu-meta-size); }
}
</style>
