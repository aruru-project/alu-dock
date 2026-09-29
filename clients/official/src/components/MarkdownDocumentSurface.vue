<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { Check, Copy, TextCursorInput } from '@lucide/vue'
import { copyPlainText } from '../lib/clipboard'
import MarkdownContent from './MarkdownContent.vue'

export type MarkdownViewMode = 'reading' | 'source'

const props = withDefaults(defineProps<{
  source: string
  documentKey: string
  initialMode?: MarkdownViewMode
  ariaLabel?: string
}>(), {
  initialMode: 'reading',
  ariaLabel: 'Markdown 文档',
})

const mode = ref<MarkdownViewMode>(props.initialMode)
const sourceSurface = ref<HTMLTextAreaElement | null>(null)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let resetTimer = 0

watch(() => props.documentKey, () => {
  mode.value = props.initialMode
  copyState.value = 'idle'
})

onUnmounted(() => window.clearTimeout(resetTimer))

function selectAllSource() {
  mode.value = 'source'
  requestAnimationFrame(() => {
    sourceSurface.value?.focus()
    sourceSurface.value?.select()
  })
}

async function copySource() {
  window.clearTimeout(resetTimer)
  try {
    await copyPlainText(props.source)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
    selectAllSource()
  }
  resetTimer = window.setTimeout(() => { copyState.value = 'idle' }, 1800)
}
</script>

<template>
  <section class="markdown-document" :aria-label="ariaLabel">
    <div class="markdown-document-toolbar">
      <div class="markdown-mode-switch" role="group" aria-label="显示方式">
        <button type="button" :class="{ active: mode === 'reading' }" :aria-pressed="mode === 'reading'" :data-modal-initial="mode === 'reading' ? '' : undefined" @click="mode = 'reading'">阅读</button>
        <button type="button" :class="{ active: mode === 'source' }" :aria-pressed="mode === 'source'" :data-modal-initial="mode === 'source' ? '' : undefined" @click="mode = 'source'">原文</button>
      </div>
      <div class="markdown-document-actions">
        <button v-if="mode === 'source'" type="button" @click="selectAllSource"><TextCursorInput :size="14" />全选</button>
        <button type="button" @click="copySource"><Check v-if="copyState === 'copied'" :size="14" /><Copy v-else :size="14" />{{ copyState === 'copied' ? '已复制' : '复制全文' }}</button>
      </div>
    </div>

    <div v-if="mode === 'reading'" class="markdown-document-scroll">
      <MarkdownContent class="markdown-document-reading msg-text" :source="source" />
    </div>
    <textarea v-else ref="sourceSurface" class="markdown-document-source" :value="source" readonly spellcheck="false" aria-label="文档原文" />
    <span v-if="copyState === 'failed'" class="markdown-document-error" role="status">自动复制失败，已选中原文。</span>
  </section>
</template>

<style scoped>
.markdown-document {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  color: var(--alu-text);
  background: #080d17;
}
.markdown-document-toolbar {
  display: flex;
  min-width: 0;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--alu-border);
  background: rgba(12, 19, 32, .96);
}
.markdown-mode-switch,
.markdown-document-actions { display: flex; align-items: center; gap: 5px; }
.markdown-mode-switch {
  padding: 3px;
  border: 1px solid var(--alu-border);
  border-radius: 8px;
  background: rgba(5, 9, 17, .72);
}
.markdown-mode-switch button,
.markdown-document-actions button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 10px;
  color: var(--alu-text-muted);
  border: 0;
  border-radius: 6px;
  background: transparent;
  font: inherit;
  font-size: 10px;
}
.markdown-mode-switch button.active {
  color: var(--alu-text);
  background: var(--alu-active);
  box-shadow: inset 0 0 0 1px var(--alu-blue-border);
}
.markdown-document-actions button {
  border: 1px solid var(--alu-border);
  background: rgba(18, 28, 45, .8);
}
.markdown-mode-switch button:hover,
.markdown-document-actions button:hover { color: var(--alu-text); background: var(--alu-hover); }
.markdown-document-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.markdown-document-reading {
  width: min(820px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: 30px clamp(22px, 5vw, 54px) 70px;
  color: var(--alu-text-dim);
  font-family: var(--font-reading);
  font-size: 14px;
  line-height: 1.78;
}
.markdown-document-reading :deep(> :first-child) { margin-top: 0; }
.markdown-document-reading :deep(h1) { font-size: 1.65em; }
.markdown-document-reading :deep(h2) { margin-top: 1.45em; font-size: 1.35em; }
.markdown-document-reading :deep(h3) { margin-top: 1.25em; font-size: 1.15em; }
.markdown-document-reading :deep(p),
.markdown-document-reading :deep(li) { max-width: 76ch; }
.markdown-document-reading :deep(table) { display: block; overflow-x: auto; }
.markdown-document-source {
  width: 100%;
  min-width: 0;
  min-height: 0;
  resize: none;
  padding: 20px 22px 70px;
  overflow: auto;
  color: #c9d8f0;
  border: 0;
  outline: none;
  background: #070b13;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  tab-size: 2;
  white-space: pre;
}
.markdown-document-error {
  position: absolute;
  right: 12px;
  bottom: 12px;
  max-width: calc(100% - 24px);
  padding: 7px 10px;
  color: var(--alu-rose);
  border: 1px solid rgba(255, 100, 127, .28);
  border-radius: 7px;
  background: rgba(40, 12, 22, .94);
  font-size: 9px;
}
@media (max-width: 720px) {
  .markdown-document-toolbar { align-items: stretch; gap: 7px; padding: 7px 9px; }
  .markdown-mode-switch { flex: 1; }
  .markdown-mode-switch button { flex: 1; }
  .markdown-document-actions button { padding: 0 8px; }
  .markdown-document-reading { padding: 22px 17px 58px; font-size: 13px; }
  .markdown-document-source { padding: 15px 14px 58px; font-size: 11px; }
}
</style>
