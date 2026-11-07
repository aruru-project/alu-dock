<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { assistantEntryLabel, assistantSessionLabel, assistantTime } from '../lib/assistant'
import type { ConversationReading } from '../lib/assistantReading'
import { useAppStore } from '../stores/app'
import { useSurfacesStore } from '../stores/surfaces'

// Her conversation around one entry: a search hit, or where a memory was said.
const props = defineProps<{ reading: ConversationReading; backLabel: string }>()
const emit = defineEmits<{ back: []; more: [direction: 'before' | 'after'] }>()
const app = useAppStore()
const surfaces = useSurfacesStore()

// The conversation opens on the entry asked about, which may sit below earlier entries.
const placeElement: { current: HTMLElement | null } = { current: null }
watch(() => props.reading.loading, async (loading, wasLoading) => {
  if (loading || !wasLoading) return
  await nextTick()
  placeElement.current?.scrollIntoView?.({ block: 'center' })
})

const openWorkId = computed(() => {
  const workId = props.reading.session?.workId
  return workId && app.works.some((work) => work.id === workId) ? workId : ''
})

function openWork() {
  if (!openWorkId.value) return
  app.selectWork(openWorkId.value)
  surfaces.closeModal()
}
</script>

<template>
  <section class="assistant-reading" aria-label="对话前后文">
    <div class="assistant-reading-head">
      <button type="button" class="button secondary" @click="emit('back')">{{ backLabel }}</button>
      <div v-if="reading.session" class="assistant-reading-place">
        <strong>{{ assistantSessionLabel(reading.session) }}</strong>
        <span>{{ [reading.session.machine, reading.session.cwd].filter(Boolean).join(' · ') }}</span>
        <span>{{ assistantTime(reading.session.startedAt) }} – {{ assistantTime(reading.session.lastAt) }}</span>
      </div>
      <button v-if="openWorkId" type="button" class="button primary" @click="openWork">打开这个 Work</button>
    </div>
    <slot />
    <div v-if="reading.error" class="assistant-error" role="alert"><span>{{ reading.error }}</span></div>
    <div v-if="reading.loading" class="assistant-status" role="status">正在读取这段对话…</div>
    <div v-else class="assistant-entries">
      <button v-if="reading.hasBefore" type="button" class="assistant-more" :disabled="reading.loadingBefore" @click="emit('more', 'before')">{{ reading.loadingBefore ? '正在读取…' : '往前再读' }}</button>
      <article v-for="entry in reading.entries" :key="entry.entryId" :ref="(element) => { if (entry.entryId === reading.place?.entryId) placeElement.current = element as HTMLElement | null }" class="assistant-entry" :class="[`is-${entry.kind}`, { 'is-hit': entry.entryId === reading.place?.entryId }]">
        <header><strong>{{ assistantEntryLabel(entry.kind, entry.toolName) }}</strong><time>{{ assistantTime(entry.at) }}</time></header>
        <div v-if="entry.text" class="assistant-entry-text">{{ entry.text }}</div>
        <details v-for="(call, index) in entry.toolCalls ?? []" :key="index" class="assistant-entry-call">
          <summary>调用 {{ call.name }}</summary>
          <pre>{{ call.arguments }}</pre>
        </details>
        <p v-if="entry.truncated" class="assistant-entry-cut">这一条太长，这里只显示前一部分。</p>
      </article>
      <button v-if="reading.hasAfter" type="button" class="assistant-more" :disabled="reading.loadingAfter" @click="emit('more', 'after')">{{ reading.loadingAfter ? '正在读取…' : '往后再读' }}</button>
    </div>
  </section>
</template>

<style scoped>
.assistant-reading { display: flex; min-height: 0; flex-direction: column; gap: 10px; }
.assistant-reading-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.assistant-reading-place { display: grid; min-width: 0; flex: 1 1 200px; gap: 2px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-reading-place strong { overflow: hidden; color: var(--alu-text); font-size: var(--alu-ui-size); text-overflow: ellipsis; white-space: nowrap; }
.assistant-entries { display: flex; flex-direction: column; gap: 8px; }
.assistant-entry { padding: 9px 12px; border: 1px solid var(--alu-border); border-radius: 9px; background: var(--alu-bg-raised); }
.assistant-entry.is-hit { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); }
.assistant-entry header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-entry header strong { color: var(--alu-text-dim); }
.assistant-entry header time { margin: 0; }
.assistant-entry-text { color: var(--alu-text); font: var(--alu-meta-size)/1.7 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
.assistant-entry-call { margin-top: 6px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-entry-call summary { cursor: pointer; }
.assistant-entry-call pre { margin: 4px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant-entry-cut { margin: 6px 0 0; color: var(--alu-text-faint); font-size: var(--alu-micro-size); }
</style>
