<script setup lang="ts">
import { computed } from 'vue'
import { kilobytes, utf8Bytes } from '../lib/assistant'
import type { AssistantDocumentName } from '../lib/types'
import { useAssistantStore } from '../stores/assistant'

// One of her two documents. The draft is the store's, so leaving this section or the page keeps it.
const props = defineProps<{ document: AssistantDocumentName }>()
const assistant = useAssistantStore()
const editor = computed(() => assistant.editor(props.document))
const name = computed(() => props.document === 'persona' ? '人设' : '手写设定')
const text = computed(() => editor.value.draft ?? editor.value.base?.text ?? '')
const dirty = computed(() => editor.value.draft !== null)
const saving = computed(() => editor.value.save?.state === 'pending')
const bytes = computed(() => utf8Bytes(text.value))
const limit = computed(() => assistant.info?.maxDocumentBytes ?? 0)
const tooLarge = computed(() => limit.value > 0 && bytes.value > limit.value)
const status = computed(() => {
  const save = editor.value.save
  if (save && (save.state !== 'saved' || !dirty.value)) return save
  return dirty.value ? { state: 'draft' as const, message: '有改动还没有保存。离开这一页，草稿也会留着。' } : null
})

function input(event: Event) {
  assistant.editDocument(props.document, (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div v-if="editor.loading && !editor.base" class="assistant-status" role="status">正在读取{{ name }}…</div>
  <div v-else-if="editor.loadError && !editor.base" class="assistant-error" role="alert"><span>{{ editor.loadError }}</span><button type="button" class="button secondary" @click="assistant.loadDocument(document)">重试</button></div>
  <template v-else-if="editor.base">
    <p v-if="editor.loadError" class="assistant-note is-warning" role="status">{{ editor.loadError }}</p>
    <section v-if="editor.latest" class="assistant-conflict" :aria-label="`别处保存的${name}`">
      <p><strong>{{ name }}在别处被改过。</strong>下面是现在保存着的版本，你的草稿没有动。</p>
      <details>
        <summary>查看现在的版本</summary>
        <pre class="assistant-text-block">{{ editor.latest.text }}</pre>
      </details>
      <div class="assistant-conflict-actions">
        <button type="button" class="button secondary" :disabled="saving" @click="assistant.discardDocument(document)">改用现在的版本</button>
        <button type="button" class="button secondary" :disabled="saving" @click="assistant.keepDraftOverLatest(document)">保留我的草稿</button>
      </div>
    </section>
    <textarea
      class="assistant-document-input"
      :aria-label="name"
      :value="text"
      spellcheck="false"
      @input="input"
    />
    <div class="assistant-document-size" :class="{ 'is-over': tooLarge }">
      {{ kilobytes(bytes) }} KB<template v-if="limit"> / {{ kilobytes(limit) }} KB</template><template v-if="tooLarge">，超过上限，保存不会成功。请删短一些。</template>
    </div>
  </template>
  <footer v-if="editor.base" class="assistant-document-footer">
    <span class="assistant-document-status" :class="{ 'is-error': status?.state === 'failed' || status?.state === 'changed' }" :role="status?.state === 'failed' || status?.state === 'changed' ? 'alert' : 'status'">{{ status?.message }}</span>
    <button v-if="(editor.save?.state === 'changed' || editor.save?.state === 'unknown') && !editor.latest" type="button" class="button secondary" :disabled="editor.loading" @click="assistant.loadDocument(document)">{{ editor.loading ? '正在读取…' : '读取最新内容' }}</button>
    <button type="button" class="button secondary" :disabled="saving || !dirty" @click="assistant.discardDocument(document)">放弃改动</button>
    <button type="button" class="button primary" :disabled="saving || !dirty || !editor.base || !!editor.latest" @click="assistant.saveDocument(document)">{{ saving ? '正在保存…' : '保存' }}</button>
  </footer>
</template>

<style scoped>
.assistant-conflict { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid rgb(var(--alu-warning-rgb) / .35); border-radius: 9px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-conflict p { margin: 0; }
.assistant-conflict strong { color: var(--alu-warning); }
.assistant-conflict summary { cursor: pointer; color: var(--alu-accent); }
.assistant-conflict-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.assistant-document-input {
  min-height: 0;
  flex: 1 1 auto;
  width: 100%;
  padding: 12px 14px;
  resize: none;
  border: 1px solid var(--alu-border);
  border-radius: 10px;
  background: var(--alu-bg-raised);
  color: var(--alu-text);
  font: 14px/1.75 var(--font-reading);
}
.assistant-document-input:focus { outline: none; border-color: var(--alu-border-focus); }
.assistant-document-size { color: var(--alu-text-faint); font-size: var(--alu-micro-size); text-align: right; }
.assistant-document-size.is-over { color: var(--alu-danger); }
.assistant-document-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; padding-top: 4px; }
.assistant-document-status { flex: 1 1 220px; min-width: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.5; }
.assistant-document-status.is-error { color: var(--alu-danger); }
</style>
