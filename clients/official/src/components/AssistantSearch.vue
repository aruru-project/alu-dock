<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { assistantEntryLabel, assistantPlace, assistantSpan, assistantTime } from '../lib/assistant'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantSearchStore } from '../stores/assistant-search'
import AssistantConversation from './AssistantConversation.vue'

// Searching her conversations: the timeline lines of the words and days asked for, what was said,
// and one conversation read around a hit or a line.
const store = useAssistantSearchStore()
const { search, timeline, reading, moreHits, moreLines } = store
const { canSearch, unlistedRewrites, lineNotices } = storeToRefs(store)
const { info } = storeToRefs(useAssistantStore())

// Each line with the rewrite being typed for it (shown under the line as it reads now), the change on its way and what became of the last one.
const lines = computed(() => timeline.episodes.map((line) => ({
  line, rewrite: store.rewriteOf(line.id), pending: store.linePending(line.id), outcome: store.lineOutcome(line.id),
})))
const noLines = computed(() => timeline.view === 'forgotten'
  ? search.shown?.query ? '没有提到这几个词的已忘掉的行。' : '这段时间没有忘掉的行。'
  : search.shown?.query ? '时间线里没有提到这几个词的行。' : '这段时间还没有时间线：后台读过对话后才会写上。')

function rewriteInput(id: string, event: Event) {
  store.editLine(id, (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <form class="assistant-search" @submit.prevent="store.runSearch()">
    <input v-model="search.query" class="ui-dialog-input ui-dialog-search" type="search" placeholder="要找的词（选了日期可以不填）" aria-label="要找的词" spellcheck="false" />
    <label><span>从</span><input v-model="search.from" class="ui-dialog-input ui-dialog-search" type="date" aria-label="从哪天开始" /></label>
    <label><span>到</span><input v-model="search.to" class="ui-dialog-input ui-dialog-search" type="date" aria-label="到哪天为止" /></label>
    <button type="submit" class="button primary" :disabled="search.loading || !canSearch">{{ search.loading ? '正在搜索…' : '搜索' }}</button>
  </form>
  <div v-if="search.error" class="assistant-error" role="alert"><span>{{ search.error }}</span></div>
  <p v-for="(notice, index) in lineNotices" :key="index" class="assistant-timeline-notice" :class="{ 'is-failed': notice.state === 'failed' }" :role="notice.state === 'failed' ? 'alert' : 'status'">{{ notice.message }}</p>

  <AssistantConversation v-if="reading.place" :reading="reading" back-label="← 返回结果" @back="store.closeContext()" @more="store.readMore" />

  <template v-else-if="search.shown">
    <section class="assistant-timeline" aria-label="时间线">
      <div class="assistant-timeline-head">
        <h4>时间线</h4>
        <div class="alu-switch" role="radiogroup" aria-label="列出哪些行">
          <button type="button" role="radio" :class="{ 'is-active': timeline.view === 'active' }" :aria-checked="timeline.view === 'active'" @click="store.showLineView('active')">在用的</button>
          <button type="button" role="radio" :class="{ 'is-active': timeline.view === 'forgotten' }" :aria-checked="timeline.view === 'forgotten'" @click="store.showLineView('forgotten')">已忘掉的</button>
        </div>
      </div>
      <p v-if="unlistedRewrites.length && !timeline.loading" class="assistant-note" role="status">
        还有 {{ unlistedRewrites.length }} 行的改写没有保存，不在现在列出的行里；再列出这些行就能接着改。
        <button type="button" class="alu-link-button" @click="store.dropUnlistedRewrites()">不改了</button>
      </p>
      <div v-if="timeline.loading" class="assistant-status" role="status">正在读取时间线…</div>
      <div v-else-if="timeline.error" class="assistant-error" role="alert"><span>{{ timeline.error }}</span></div>
      <ul v-else-if="lines.length" class="assistant-timeline-list">
        <li v-for="{ line, rewrite, pending, outcome } in lines" :key="line.id" class="assistant-timeline-line" :class="{ 'is-forgotten': line.state === 'forgotten' }">
          <span class="assistant-timeline-meta"><span>{{ assistantSpan(line.fromAt, line.toAt) }}</span><span>{{ assistantPlace(line.session) }}</span><span v-if="line.author === 'owner'">你改过</span><span v-if="line.state === 'forgotten'">已忘掉</span></span>
          <span class="assistant-timeline-text">{{ line.text }}</span>
          <template v-if="rewrite !== undefined">
            <textarea class="assistant-timeline-editor" rows="2" :value="rewrite" :maxlength="info?.maxEpisodeChars" aria-label="改写这一行" spellcheck="false" @input="rewriteInput(line.id, $event)" />
            <span class="assistant-timeline-actions">
              <button type="button" class="button primary" :disabled="pending || !rewrite.trim()" @click="store.saveLineEdit(line)">{{ pending ? '正在保存…' : '保存' }}</button>
              <button type="button" class="button secondary" :disabled="pending" @click="store.cancelLineEdit(line.id)">取消</button>
            </span>
          </template>
          <span v-else class="assistant-timeline-actions">
            <button type="button" class="assistant-timeline-action" @click="store.openLine(line)">看原话</button>
            <button v-if="line.state === 'forgotten'" type="button" class="assistant-timeline-action" :disabled="pending" @click="store.restoreLine(line)">{{ pending ? '正在恢复…' : '恢复' }}</button>
            <template v-else>
              <button type="button" class="assistant-timeline-action" :disabled="pending" @click="store.startLineEdit(line)">改写</button>
              <button type="button" class="assistant-timeline-action" :disabled="pending" @click="store.forgetLine(line)">{{ pending ? '正在忘掉…' : '忘掉' }}</button>
            </template>
          </span>
          <p v-if="outcome" class="assistant-timeline-outcome" :class="{ 'is-failed': outcome.state === 'failed' }" :role="outcome.state === 'failed' ? 'alert' : 'status'">{{ outcome.message }}</p>
        </li>
      </ul>
      <p v-else class="assistant-empty">{{ noLines }}</p>
      <div v-if="moreLines.error" class="assistant-error" role="alert"><span>{{ moreLines.error }}</span></div>
      <button v-if="timeline.nextCursor" type="button" class="assistant-more" :disabled="moreLines.loading || search.loading" @click="store.timelineMore()">{{ moreLines.loading ? '正在读取…' : '更早的时间线' }}</button>
      <h4>对话</h4>
    </section>
    <div class="assistant-results" role="list" aria-label="搜索结果">
      <button v-for="hit in search.hits" :key="`${hit.session.sessionId}:${hit.entryId}`" type="button" role="listitem" class="assistant-hit" @click="store.openContext(hit)">
        <span class="assistant-hit-meta"><span>{{ assistantTime(hit.at) }}</span><span>{{ assistantPlace(hit.session) }}</span><span>{{ assistantEntryLabel(hit.kind) }}</span></span>
        <span class="assistant-hit-snippet">{{ hit.snippet }}</span>
      </button>
      <p v-if="!search.hits.length" class="assistant-empty">{{ search.shown.query ? `没有找到包含「${search.shown.query}」的对话。可以换几个词，或放宽时间范围。` : '这段时间里没有对话。可以放宽时间范围。' }}</p>
    </div>
    <div v-if="moreHits.error" class="assistant-error" role="alert"><span>{{ moreHits.error }}</span></div>
    <button v-if="search.nextCursor" type="button" class="assistant-more" :disabled="moreHits.loading || search.loading" @click="store.searchMore()">{{ moreHits.loading ? '正在读取…' : '更多结果' }}</button>
  </template>
</template>

<style scoped>
.assistant-search { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.assistant-search > input { min-width: 180px; flex: 1 1 220px; }
.assistant-search label { display: flex; align-items: center; gap: 6px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-search label input { width: 150px; }
.assistant-timeline { display: grid; gap: 8px; }
.assistant-timeline h4 { margin: 4px 0 0; color: var(--alu-text-dim); font-size: var(--alu-meta-size); font-weight: 650; }
.assistant-timeline-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.assistant-timeline-notice { margin: 0; padding: 8px 10px; border: 1px solid var(--alu-success-border); border-radius: 8px; color: var(--alu-success-text); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-timeline-notice.is-failed { border-color: var(--alu-danger-border); background: var(--alu-danger-bg); color: var(--alu-danger); }
.assistant-timeline-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.assistant-timeline-line { display: grid; gap: 5px; padding: 9px 11px; border: 1px solid var(--alu-border); border-left: 3px solid var(--alu-accent-border); border-radius: 9px; background: var(--alu-bg-raised); }
.assistant-timeline-line.is-forgotten { border-left-color: var(--alu-border); opacity: .7; }
.assistant-timeline-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-timeline-text { color: var(--alu-text); font: var(--alu-meta-size)/1.6 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
.assistant-timeline-line.is-forgotten .assistant-timeline-text { text-decoration: line-through; }
.assistant-timeline-editor { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--alu-border-light); border-radius: 7px; background: var(--alu-bg); color: var(--alu-text); font: var(--alu-meta-size)/1.6 var(--font-reading); resize: vertical; }
.assistant-timeline-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.assistant-timeline-action { padding: 2px 6px; cursor: pointer; border: 0; border-radius: 6px; background: transparent; color: var(--alu-accent); font-size: var(--alu-micro-size); }
.assistant-timeline-action:hover:not(:disabled) { background: var(--alu-hover); }
.assistant-timeline-action:disabled { cursor: default; opacity: .6; }
.assistant-timeline-outcome { margin: 0; color: var(--alu-text-dim); font-size: var(--alu-micro-size); }
.assistant-timeline-outcome.is-failed { color: var(--alu-danger); }
.assistant-results { display: grid; gap: 6px; }
.assistant-hit { display: grid; gap: 4px; width: 100%; padding: 9px 11px; cursor: pointer; border: 1px solid var(--alu-border); border-radius: 9px; background: var(--alu-bg-raised); text-align: left; }
.assistant-hit:hover { border-color: var(--alu-border-light); background: var(--alu-hover); }
.assistant-hit-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-hit-snippet { color: var(--alu-text); font: var(--alu-meta-size)/1.6 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 640px) {
  .assistant-search label input { width: 132px; }
}
</style>
