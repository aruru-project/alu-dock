<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'
import { Check, Copy, TextCursorInput, X } from '@lucide/vue'
import { copyPlainText } from '../lib/clipboard'
import MarkdownDocumentSurface from './MarkdownDocumentSurface.vue'

const props = withDefaults(defineProps<{ title: string; text: string; markdown?: boolean }>(), { markdown: false })
const emit = defineEmits<{ close: [] }>()
const textSurface = ref<HTMLTextAreaElement | null>(null)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let resetTimer = 0
onUnmounted(() => window.clearTimeout(resetTimer))

function selectAllText() {
  const surface = textSurface.value
  if (!surface) return
  surface.focus()
  surface.select()
}

async function copyAllText() {
  window.clearTimeout(resetTimer)
  try {
    await copyPlainText(props.text)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
    await nextTick()
    selectAllText()
  }
  resetTimer = window.setTimeout(() => { copyState.value = 'idle' }, 1800)
}
</script>

<template>
  <header class="message-text-header">
    <div>
      <span>消息原文</span>
      <strong>{{ title }}</strong>
    </div>
    <button type="button" class="message-text-close" aria-label="关闭消息原文" @click="emit('close')"><X :size="18" /></button>
  </header>
  <MarkdownDocumentSurface
    v-if="markdown"
    class="message-markdown-document"
    :source="text"
    :document-key="`${title}:${text.length}`"
    initial-mode="source"
    :aria-label="`${title} Markdown`"
  />
  <template v-else>
    <textarea ref="textSurface" class="message-text-source" :value="text" readonly spellcheck="false" aria-label="消息原文" />
    <footer class="message-text-footer">
      <span role="status">{{ copyState === 'copied' ? '已复制全文' : copyState === 'failed' ? '请长按文本选择需要的内容。' : '可以复制全文，也可以选择其中一段。' }}</span>
      <div>
        <button type="button" @click="selectAllText"><TextCursorInput :size="15" />全选</button>
        <button type="button" class="is-primary" data-modal-initial @click="copyAllText"><Check v-if="copyState === 'copied'" :size="15" /><Copy v-else :size="15" />{{ copyState === 'copied' ? '已复制' : '复制全文' }}</button>
      </div>
    </footer>
  </template>
</template>

<style scoped>
.message-markdown-document { min-height: 0; flex: 1 1 auto; }
.message-text-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--alu-border);
  background: color-mix(in srgb, var(--alu-bg-raised) 94%, var(--alu-blue) 6%);
}
.message-text-header > div { display: grid; gap: 3px; }
.message-text-header span { color: var(--alu-blue); font: 700 9px/1.2 var(--font-reading); letter-spacing: .14em; text-transform: uppercase; }
.message-text-header strong { color: var(--alu-text); font: 700 14px/1.35 var(--font-reading); }
.message-text-close {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  color: var(--alu-text-muted);
  border: 1px solid var(--alu-border);
  border-radius: 10px;
  cursor: pointer;
  place-items: center;
}
.message-text-close:hover { color: var(--alu-text); background: var(--alu-hover); }
.message-text-source {
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  padding: 18px;
  resize: none;
  overflow: auto;
  color: var(--alu-text);
  outline: none;
  background: color-mix(in srgb, var(--alu-bg) 96%, black);
  border: 0;
  border-radius: 0;
  font: 12px/1.7 var(--font-mono);
  overflow-wrap: normal;
  tab-size: 2;
  touch-action: auto;
  user-select: text;
  white-space: pre-wrap;
}
.message-text-source:focus { box-shadow: inset 0 0 0 1px var(--alu-blue-border); }
.message-text-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  border-top: 1px solid var(--alu-border);
  background: var(--alu-bg-raised);
}
.message-text-footer > span { min-width: 0; color: var(--alu-text-muted); font-size: 10px; line-height: 1.45; }
.message-text-footer > div { display: flex; flex: 0 0 auto; gap: 8px; }
.message-text-footer button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 6px;
  padding: 0 11px;
  color: var(--alu-text-dim);
  border: 1px solid var(--alu-border-light);
  border-radius: 9px;
  cursor: pointer;
}
.message-text-footer button.is-primary { color: var(--alu-bg); border-color: var(--alu-blue); background: var(--alu-blue); font-weight: 700; }
@media screen and (max-width: 600px) {
  .message-text-source { padding: 14px; font-size: 12px; }
  .message-text-footer { align-items: stretch; flex-direction: column; gap: 9px; }
  .message-text-footer > div { width: 100%; }
  .message-text-footer button { min-height: 44px; flex: 1; justify-content: center; }
}
</style>
