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
