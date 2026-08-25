<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import { copyPlainText } from '../lib/clipboard'
import { renderClientMarkdown } from '../lib/markdown'

const props = defineProps<{ source: string }>()
const rendered = computed(() => renderClientMarkdown(props.source))
let resetTimer = 0

onUnmounted(() => window.clearTimeout(resetTimer))

async function handleClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const action = target.closest<HTMLButtonElement>('.markdown-copy-action')
  if (!action) return

  const isLink = action.classList.contains('markdown-copy-link')
  const text = isLink
    ? action.dataset.copyTarget ?? ''
    : action.closest('.code-block-wrap')?.querySelector('code')?.textContent ?? ''
  if (!text) return

  window.clearTimeout(resetTimer)
  const feedback = isLink ? action.querySelector<HTMLElement>('.markdown-copy-hint') : action
  const idleLabel = isLink ? '复制链接' : '复制'
  try {
    await copyPlainText(text)
    if (feedback) feedback.textContent = '已复制'
  } catch {
    if (feedback) feedback.textContent = '复制失败'
  }
  resetTimer = window.setTimeout(() => {
    if (feedback?.isConnected) feedback.textContent = idleLabel
  }, 1800)
}
</script>

<template>
  <div class="markdown-content" @click="handleClick" v-html="rendered" />
</template>

<style scoped>
.markdown-content :deep(.markdown-copy-link) {
  display: inline;
  margin: 0;
  padding: 0;
  color: var(--alu-blue);
  border: 0;
  background: transparent;
  font: inherit;
  line-height: inherit;
  text-align: inherit;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
  cursor: copy;
}
.markdown-content :deep(.markdown-copy-link:hover),
.markdown-content :deep(.markdown-copy-link:focus-visible) {
  color: var(--alu-pink);
  outline: none;
  text-decoration-style: solid;
}
.markdown-content :deep(.markdown-copy-hint) {
  margin-inline-start: .35em;
  color: var(--alu-text-faint);
  font-size: .72em;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.markdown-content :deep(.markdown-image-placeholder) {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  padding: .1em .5em;
  overflow: hidden;
  color: var(--alu-text-muted);
  border: 1px solid var(--alu-border);
  border-radius: 5px;
  background: rgba(255, 255, 255, .025);
  font-size: .88em;
  text-overflow: ellipsis;
  vertical-align: baseline;
  white-space: nowrap;
}
</style>
