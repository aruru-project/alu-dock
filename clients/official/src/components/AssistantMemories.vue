<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { PenLine, RefreshCw } from '@lucide/vue'
import { assistantTime, memoryAuthorLabel, memoryLength, memoryResidentLabel, memoryStateLabel, memoryTopicLabel, memoryTopics } from '../lib/assistant'
import { useAssistantMemoryStore, type MemoryView } from '../stores/assistant-memory'
import AssistantMemoryDetail from './AssistantMemoryDetail.vue'

// Her memories: the newest first, by topic, and those set aside, each opening to its own page.
const emit = defineEmits<{ settings: [] }>()
const memory = useAssistantMemoryStore()
const { list, detail, more } = memory
const { extraction, draft, memoryLimit } = storeToRefs(memory)

const views: Array<{ id: MemoryView; label: string }> = [
  { id: 'recent', label: '最近记住的' },
  { id: 'topics', label: '按分类' },
  { id: 'retired', label: '已作废' },
  { id: 'forgotten', label: '已删除' },
]
const saving = computed(() => draft.value?.save?.state === 'pending')
const draftLength = computed(() => memoryLength(draft.value?.text ?? '', memoryLimit.value))
// A memory changed here since the list was read says how it stands now.
const listState = computed(() => list.shown?.filter.state ?? 'active')

// Emptying the search box shows the whole list again.
watch(() => list.query, (query) => {
  if (!query.trim() && list.shown?.filter.query) void memory.loadMemories()
})

const emptyText = computed(() => {
  const shown = list.shown
  if (!shown) return ''
  if (shown.filter.query) return `没有找到包含「${shown.filter.query}」的记忆。可以换几个词。`
  if (shown.view === 'retired') return '没有作废的记忆。'
  if (shown.view === 'forgotten') return '没有删除的记忆。'
  if (shown.view === 'topics') return `「${memoryTopicLabel(shown.filter.topic ?? 'owner')}」里还没有记忆。`
  return extraction.value?.state === 'off'
    ? '还没有记忆。选好整理记忆的模型后，她会从对话里慢慢记下；你也可以自己写一条。'
    : '还没有记忆。一段对话停下一阵后，她会记下值得记住的事；你也可以自己写一条。'
})

function input(event: Event) {
  memory.editDraft({ text: (event.target as HTMLTextAreaElement).value })
}
</script>

<template>
  <AssistantMemoryDetail v-if="detail.id" />
  <template v-else>
    <div v-if="extraction?.state === 'failed'" class="assistant-note is-warning has-action" role="status">
      <span>上次整理记忆没有成功{{ extraction.retryAt ? `，${assistantTime(extraction.retryAt)} 会自动再试` : '' }}。</span>
      <button type="button" class="alu-link-button" @click="emit('settings')">看看原因</button>
    </div>

    <div class="memory-views" role="tablist" aria-label="记忆分组">
      <button v-for="item in views" :key="item.id" type="button" role="tab" class="memory-view" :class="{ 'is-active': list.view === item.id }" :aria-selected="list.view === item.id" @click="memory.showView(item.id)">{{ item.label }}</button>
    </div>
    <div v-if="list.view === 'topics'" class="alu-chips" role="radiogroup" aria-label="分类">
      <button v-for="item in memoryTopics" :key="item.topic" type="button" role="radio" class="alu-chip" :class="{ 'is-active': list.topic === item.topic }" :aria-checked="list.topic === item.topic" @click="memory.showTopic(item.topic)">{{ item.label }}</button>
    </div>

    <form class="memory-toolbar" role="search" @submit.prevent="memory.loadMemories()">
      <input v-model="list.query" class="ui-dialog-input ui-dialog-search" type="search" placeholder="在记忆里找，几个词用空格分开" aria-label="在记忆里找" spellcheck="false" />
      <button type="button" class="memory-icon-button" aria-label="刷新记忆" title="刷新记忆" :disabled="list.loading" @click="memory.loadMemories()"><RefreshCw :size="15" :class="{ spinning: list.loading }" /></button>
      <button v-if="!draft?.open" type="button" class="button secondary" @click="memory.startWriting()"><PenLine :size="15" />写一条</button>
    </form>

    <form v-if="draft?.open" class="memory-write" aria-label="写一条记忆" @submit.prevent="memory.writeMemory()">
      <textarea class="memory-write-input" :value="draft.text" aria-label="要她记住的事" placeholder="要她记住的一件事，比如：主人周末喜欢睡到自然醒。" spellcheck="false" :disabled="saving" @input="input" />
      <p class="alu-counter" :class="{ 'is-over': draftLength.over }" :role="draftLength.over ? 'alert' : undefined">{{ draftLength.label }}</p>
      <div class="memory-write-field">
        <span>分类</span>
        <div class="alu-chips" role="radiogroup" aria-label="这条的分类">
          <button v-for="item in memoryTopics" :key="item.topic" type="button" role="radio" class="alu-chip" :class="{ 'is-active': draft.topic === item.topic }" :aria-checked="draft.topic === item.topic" :disabled="saving" @click="memory.editDraft({ topic: item.topic })">{{ item.label }}</button>
        </div>
      </div>
      <div class="memory-write-field">
        <span>什么时候用</span>
        <div class="alu-switch" role="radiogroup" aria-label="这条什么时候用">
          <button type="button" role="radio" :class="{ 'is-active': !draft.resident }" :aria-checked="!draft.resident" :disabled="saving" @click="memory.editDraft({ resident: false })">{{ memoryResidentLabel(false) }}</button>
          <button type="button" role="radio" :class="{ 'is-active': draft.resident }" :aria-checked="draft.resident" :disabled="saving" @click="memory.editDraft({ resident: true })">{{ memoryResidentLabel(true) }}</button>
        </div>
      </div>
      <p v-if="draft.save" class="memory-write-status" :class="{ 'is-error': draft.save.state === 'failed' }" :role="draft.save.state === 'failed' ? 'alert' : 'status'">{{ draft.save.message }}</p>
      <div class="memory-write-actions">
        <button type="button" class="button secondary" :disabled="saving" @click="memory.dropDraft()">不写了</button>
        <button type="submit" class="button primary" :disabled="saving || !draft.text.trim() || draftLength.over > 0">{{ saving ? '正在保存…' : '记下' }}</button>
      </div>
    </form>

    <p v-if="list.notice" class="memory-notice" role="status">{{ list.notice }}</p>
    <div v-if="list.failure" class="assistant-error" role="alert"><span>{{ list.failure }}</span></div>
    <div v-if="list.error" class="assistant-error" role="alert"><span>{{ list.error }}</span><button type="button" class="button secondary" :disabled="list.loading" @click="memory.loadMemories()">重试</button></div>
    <div v-if="list.loading && !list.memories.length" class="assistant-status" role="status">正在读取她的记忆…</div>

    <ul v-if="list.memories.length" class="memory-list" aria-label="记忆列表">
      <li v-for="item in list.memories" :key="item.id">
        <button type="button" class="memory-row" :class="`is-${item.state}`" @click="memory.openMemory(item)">
          <span class="memory-row-text">{{ item.text }}</span>
          <span class="memory-row-meta">
            <span v-if="list.view !== 'topics'" class="memory-tag">{{ memoryTopicLabel(item.topic) }}</span>
            <span v-if="item.state !== listState" class="memory-tag" :class="`is-${item.state}`">{{ memoryStateLabel(item.state) }}</span>
            <span v-if="item.state === 'active' && item.resident" class="memory-tag is-resident">{{ memoryResidentLabel(true) }}</span>
            <span v-if="memory.hasRewrite(item.id)" class="memory-tag is-draft">改写还没保存</span>
            <span>{{ [memoryAuthorLabel(item), assistantTime(item.updatedAt), `#${item.id}`].filter(Boolean).join(' · ') }}</span>
          </span>
        </button>
      </li>
    </ul>
    <p v-else-if="list.shown && !list.loading && !list.error" class="assistant-empty">{{ emptyText }}</p>
    <div v-if="more.error" class="assistant-error" role="alert"><span>{{ more.error }}</span></div>
    <button v-if="list.nextCursor" type="button" class="assistant-more" :disabled="more.loading || list.loading" @click="memory.moreMemories()">{{ more.loading ? '正在读取…' : '更多' }}</button>
  </template>
</template>

<style scoped>
.memory-views { display: flex; flex: 0 0 auto; gap: 4px; overflow-x: auto; padding: 3px; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg); scrollbar-width: none; }
.memory-views::-webkit-scrollbar { display: none; }
.memory-view { flex: 1 0 auto; min-height: 32px; padding: 0 12px; cursor: pointer; border: 1px solid transparent; border-radius: 7px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); white-space: nowrap; }
.memory-view:hover:not(.is-active) { background: var(--alu-hover); color: var(--alu-text); }
.memory-view.is-active { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); color: var(--alu-highlight); }
.memory-toolbar { display: flex; align-items: center; gap: 8px; }
.memory-toolbar input { min-width: 0; flex: 1 1 auto; }
.memory-toolbar .button { flex: 0 0 auto; }
.memory-icon-button { display: grid; width: 36px; height: 36px; flex: 0 0 auto; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.memory-icon-button:hover:not(:disabled) { background: var(--alu-hover); color: var(--alu-text); }
.memory-write { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--alu-accent-border); border-radius: 10px; background: var(--alu-bg-raised); }
.memory-write-input { min-height: 88px; width: 100%; padding: 10px 12px; resize: vertical; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-bg); color: var(--alu-text); font: 13px/1.7 var(--font-reading); }
.memory-write-input:focus { outline: none; border-color: var(--alu-border-focus); }
.memory-write-field { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: 10px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.memory-write-status { margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.5; }
.memory-write-status.is-error { color: var(--alu-danger); }
.memory-write-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.memory-notice { margin: 0; color: var(--alu-success-text); font-size: var(--alu-meta-size); }
.memory-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.memory-row { display: grid; gap: 6px; width: 100%; padding: 10px 12px; cursor: pointer; border: 1px solid var(--alu-border); border-radius: 9px; background: var(--alu-bg-raised); text-align: left; }
.memory-row:hover { border-color: var(--alu-border-light); background: var(--alu-hover); }
/* A long memory shows its start here; its page shows all of it. */
.memory-row-text { display: -webkit-box; overflow: hidden; color: var(--alu-text); font: var(--alu-ui-size)/1.65 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.memory-row.is-retired .memory-row-text, .memory-row.is-forgotten .memory-row-text { color: var(--alu-text-dim); }
.memory-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.memory-tag { padding: 1px 7px; border-radius: 999px; background: var(--alu-tag-bg); color: var(--alu-text-dim); }
.memory-tag.is-resident { background: var(--alu-accent-bg); color: var(--alu-accent); }
.memory-tag.is-retired, .memory-tag.is-forgotten, .memory-tag.is-draft { background: rgb(var(--alu-warning-rgb) / .1); color: var(--alu-warning-text); }
.memory-tag.is-active { background: rgb(var(--alu-success-rgb) / .08); color: var(--alu-success-text); }
@media (max-width: 640px) {
  .memory-write-field { grid-template-columns: 1fr; gap: 6px; }
  .memory-toolbar { flex-wrap: wrap; }
  .memory-toolbar input { flex-basis: 100%; }
  .memory-toolbar .button { flex: 1 1 auto; }
}
</style>
