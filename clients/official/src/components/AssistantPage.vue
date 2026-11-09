<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BookUser, Brain, Eye, NotebookPen, RefreshCw, Search, Settings2, Sparkles, X } from '@lucide/vue'
import { assistantEntryLabel, assistantSessionLabel, assistantSpan, assistantTime } from '../lib/assistant'
import type { AssistantEpisode, AssistantSearchHit } from '../lib/types'
import { useAppStore } from '../stores/app'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import { useSurfacesStore, type AssistantSection } from '../stores/surfaces'
import AssistantConversation from './AssistantConversation.vue'
import AssistantDocumentEditor from './AssistantDocumentEditor.vue'
import AssistantMemories from './AssistantMemories.vue'
import AssistantSettings from './AssistantSettings.vue'

// The assistant kept on Main (card #295). Her persona can be the user's own assistant, so the page says 「助手」, never a name.
const emit = defineEmits<{ close: [] }>()
const app = useAppStore()
const assistant = useAssistantStore()
const memory = useAssistantMemoryStore()
const { search, reading, lineEdit } = assistant
const { preview, info, canSearch } = storeToRefs(assistant)
const surfaces = useSurfacesStore()
const { assistantSection: section } = storeToRefs(surfaces)

const sections: Array<{ id: AssistantSection; label: string; icon: typeof Eye }> = [
  { id: 'preview', label: '她会读到什么', icon: Eye },
  { id: 'persona', label: '人设', icon: BookUser },
  { id: 'notes', label: '手写设定', icon: NotebookPen },
  { id: 'memories', label: '记忆', icon: Brain },
  { id: 'search', label: '搜索对话', icon: Search },
  { id: 'settings', label: '设置', icon: Settings2 },
]

// Each section reads the Host's current version the first time it is shown while the page is open.
// How her memories are being made changes as she works, so both of their sections read it again.
const readThisOpen = ref(new Set<AssistantSection>())
watch([section, () => app.connectionContext?.connectionId, () => app.connectionContext?.selectionGeneration], ([current], previous) => {
  if (previous && (previous[1] !== app.connectionContext?.connectionId || previous[2] !== app.connectionContext?.selectionGeneration)) readThisOpen.value = new Set()
  if (!app.connectionContext || readThisOpen.value.has(current)) return
  readThisOpen.value.add(current)
  if (current === 'preview') void assistant.loadPreview()
  else if (current === 'persona' || current === 'notes') void assistant.loadDocument(current)
  else if (current === 'memories') {
    void memory.loadMemories()
    if (memory.detail.id) void memory.readMemory(memory.detail.id)
    void assistant.loadInfo()
  } else if (current === 'settings') {
    void memory.loadSettings()
    void memory.loadModels()
    void assistant.loadInfo()
  }
}, { immediate: true })

// Android Back steps back inside the page before it closes it, as each 「返回」 button does: where a
// memory was said → the memory → the list; a conversation around a search hit → the results.
onUnmounted(surfaces.onAssistantBack(() => {
  if (section.value === 'memories' && memory.source.place) memory.closeSource()
  else if (section.value === 'memories' && memory.detail.id) memory.closeMemory()
  else if (section.value === 'search' && reading.place) assistant.closeContext()
  else return false
  return true
}))

function hitPlace(hit: AssistantSearchHit) {
  return [assistantSessionLabel(hit.session), hit.session.machine].filter(Boolean).join(' · ')
}
function linePlace(line: AssistantEpisode) {
  return [assistantSessionLabel(line.session), line.session.machine].filter(Boolean).join(' · ')
}
</script>

<template>
  <header class="assistant-header">
    <div class="assistant-heading">
      <span class="assistant-mark"><Sparkles :size="20" /></span>
      <div>
        <h2 id="assistant-title">助手</h2>
        <p>她的人设、你写的设定、她记住的事和经历过的对话，都保存在 Main 上</p>
      </div>
    </div>
    <button class="assistant-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="assistant-layout">
    <nav class="assistant-nav" aria-label="助手分区">
      <button v-for="item in sections" :key="item.id" type="button" class="assistant-nav-item" :class="{ 'is-active': section === item.id }" :aria-current="section === item.id ? 'page' : undefined" @click="section = item.id">
        <component :is="item.icon" :size="16" /><span>{{ item.label }}</span>
        <span v-if="((item.id === 'persona' || item.id === 'notes') && assistant.editor(item.id).draft !== null) || (item.id === 'memories' && memory.hasDrafts)" class="assistant-nav-dot" aria-label="有未保存的改动" />
      </button>
    </nav>

    <main v-if="section === 'preview'" class="assistant-content">
      <div class="assistant-intro">
        <h3>她会读到什么</h3>
        <p>现在新开一个助手会话，她会先读到下面的全文。</p>
      </div>
      <div class="assistant-toolbar">
        <span v-if="preview?.result" class="assistant-meta">生成于 {{ assistantTime(preview.result.loadedAt) }}</span>
        <button type="button" class="button secondary" :disabled="preview?.loading" @click="assistant.loadPreview()"><RefreshCw :size="15" :class="{ spinning: preview?.loading }" />{{ preview?.loading ? '正在读取…' : '刷新' }}</button>
      </div>
      <div v-if="preview?.error" class="assistant-error" role="alert"><span>{{ preview.error }}</span></div>
      <div v-if="preview?.loading && !preview.result" class="assistant-status" role="status">正在读取她会读到的内容…</div>
      <pre v-else-if="preview?.result" class="assistant-text-block assistant-preview-text">{{ preview.result.text || '（现在是空的）' }}</pre>
    </main>

    <main v-else-if="section === 'persona' || section === 'notes'" :key="section" class="assistant-content">
      <div class="assistant-intro">
        <h3>{{ section === 'persona' ? '人设' : '手写设定' }}</h3>
        <p v-if="section === 'persona'">她是谁、怎么说话。保存后，新开的助手会话会读到。</p>
        <p v-else>你写给她的设定和要记住的事。保存后，新开的助手会话会读到。</p>
      </div>
      <AssistantDocumentEditor :document="section" />
    </main>

    <main v-else-if="section === 'memories'" class="assistant-content">
      <div v-if="!memory.detail.id" class="assistant-intro">
        <h3>记忆</h3>
        <p>她从对话里记住的事。「每次都带上」的会写进每个新开的助手会话，其余的她查的时候才用。你在这里改过的，后台整理不会再动。</p>
      </div>
      <AssistantMemories @settings="section = 'settings'" />
    </main>

    <main v-else-if="section === 'settings'" class="assistant-content">
      <div class="assistant-intro">
        <h3>设置</h3>
        <p>这些设置保存在 Main 上，哪台设备改的都是同一份。</p>
      </div>
      <AssistantSettings />
    </main>

    <main v-else class="assistant-content">
      <div class="assistant-intro">
        <h3>搜索对话</h3>
        <p>在她经历过的对话里找。几个词用空格分开，要全部出现才算找到；只选日期不填词，就列出那几天的时间线和对话。时间线是后台按对话写的目录，一段一行，写那段时间你们在做什么；写错了可以改写或忘掉，你改过的行后台不再动。</p>
      </div>
      <form class="assistant-search" @submit.prevent="assistant.runSearch()">
        <input v-model="search.query" class="ui-dialog-input ui-dialog-search" type="search" placeholder="要找的词（选了日期可以不填）" aria-label="要找的词" spellcheck="false" />
        <label><span>从</span><input v-model="search.from" class="ui-dialog-input ui-dialog-search" type="date" aria-label="从哪天开始" /></label>
        <label><span>到</span><input v-model="search.to" class="ui-dialog-input ui-dialog-search" type="date" aria-label="到哪天为止" /></label>
        <button type="submit" class="button primary" :disabled="search.loading || !canSearch">{{ search.loading ? '正在搜索…' : '搜索' }}</button>
      </form>
      <div v-if="search.error" class="assistant-error" role="alert"><span>{{ search.error }}</span></div>

      <AssistantConversation v-if="reading.place" :reading="reading" back-label="← 返回结果" @back="assistant.closeContext()" @more="assistant.readMore" />

      <template v-else-if="search.shown">
        <section class="assistant-timeline" aria-label="时间线">
          <h4>时间线</h4>
          <div v-if="search.timelineError && !search.episodes.length" class="assistant-error" role="alert"><span>{{ search.timelineError }}</span></div>
          <ul v-else-if="search.episodes.length" class="assistant-timeline-list">
            <li v-for="line in search.episodes" :key="line.id" class="assistant-timeline-line" :class="{ 'is-forgotten': line.state === 'forgotten' }">
              <span class="assistant-timeline-meta"><span>{{ assistantSpan(line.fromAt, line.toAt) }}</span><span>{{ linePlace(line) }}</span><span v-if="line.author === 'owner'">你改过</span><span v-if="line.state === 'forgotten'">已忘掉</span></span>
              <template v-if="lineEdit.id === line.id">
                <textarea v-model="lineEdit.text" class="assistant-timeline-editor" rows="2" :maxlength="info?.maxEpisodeChars" aria-label="改写这一行" spellcheck="false" />
                <span class="assistant-timeline-actions">
                  <button type="button" class="button primary" :disabled="!!lineEdit.pending || !lineEdit.text.trim()" @click="assistant.saveLineEdit()">{{ lineEdit.pending === line.id ? '正在保存…' : '保存' }}</button>
                  <button type="button" class="button secondary" :disabled="!!lineEdit.pending" @click="assistant.cancelLineEdit()">取消</button>
                </span>
              </template>
              <template v-else>
                <span class="assistant-timeline-text">{{ line.text }}</span>
                <span class="assistant-timeline-actions">
                  <button type="button" class="assistant-timeline-action" @click="assistant.openLine(line)">看原话</button>
                  <button v-if="line.state === 'forgotten'" type="button" class="assistant-timeline-action" :disabled="!!lineEdit.pending" @click="assistant.restoreLine(line)">{{ lineEdit.pending === line.id ? '正在恢复…' : '恢复' }}</button>
                  <template v-else>
                    <button type="button" class="assistant-timeline-action" :disabled="!!lineEdit.pending" @click="assistant.startLineEdit(line)">改写</button>
                    <button type="button" class="assistant-timeline-action" :disabled="!!lineEdit.pending" @click="assistant.forgetLine(line)">{{ lineEdit.pending === line.id ? '正在忘掉…' : '忘掉' }}</button>
                  </template>
                </span>
              </template>
              <p v-if="lineEdit.outcome?.id === line.id" class="assistant-timeline-outcome" :class="{ 'is-failed': lineEdit.outcome.state === 'failed' }" role="status">{{ lineEdit.outcome.message }}</p>
            </li>
          </ul>
          <p v-else class="assistant-empty">{{ search.shown.query ? '时间线里没有提到这几个词的行。' : '这段时间还没有时间线：后台读过对话后才会写上。' }}</p>
          <div v-if="search.timelineError && search.episodes.length" class="assistant-error" role="alert"><span>{{ search.timelineError }}</span></div>
          <button v-if="search.episodesCursor" type="button" class="assistant-more" :disabled="search.loadingMoreEpisodes" @click="assistant.timelineMore()">{{ search.loadingMoreEpisodes ? '正在读取…' : '更早的时间线' }}</button>
          <h4>对话</h4>
        </section>
        <div class="assistant-results" role="list" aria-label="搜索结果">
          <button v-for="hit in search.hits" :key="`${hit.session.sessionId}:${hit.entryId}`" type="button" role="listitem" class="assistant-hit" @click="assistant.openContext(hit)">
            <span class="assistant-hit-meta"><span>{{ assistantTime(hit.at) }}</span><span>{{ hitPlace(hit) }}</span><span>{{ assistantEntryLabel(hit.kind) }}</span></span>
            <span class="assistant-hit-snippet">{{ hit.snippet }}</span>
          </button>
          <p v-if="!search.hits.length" class="assistant-empty">{{ search.shown.query ? `没有找到包含「${search.shown.query}」的对话。可以换几个词，或放宽时间范围。` : '这段时间里没有对话。可以放宽时间范围。' }}</p>
        </div>
        <div v-if="search.moreError" class="assistant-error" role="alert"><span>{{ search.moreError }}</span></div>
        <button v-if="search.nextCursor" type="button" class="assistant-more" :disabled="search.loadingMore" @click="assistant.searchMore()">{{ search.loadingMore ? '正在读取…' : '更多结果' }}</button>
      </template>
    </main>
  </div>
  <p v-if="info" class="assistant-footnote">她的工作区：{{ info.workspacePath }}（Main）</p>
</template>

<style scoped>
.assistant-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--alu-border); background: var(--alu-surface); }
.assistant-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.assistant-mark { display: grid; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-accent-border); border-radius: 10px; background: var(--alu-accent-bg); color: var(--alu-accent); place-items: center; }
.assistant-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; }
.assistant-heading p { margin: 3px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.assistant-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.assistant-close:hover { border-color: var(--alu-border); background: var(--alu-hover); color: var(--alu-text); }
.assistant-layout { display: grid; min-height: 0; grid-template-columns: 170px minmax(0, 1fr); }
.assistant-nav { display: flex; flex-direction: column; gap: 6px; padding: 20px 12px; border-right: 1px solid var(--alu-border); background: var(--alu-bg); }
.assistant-nav-item { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 0 10px; cursor: pointer; border: 1px solid transparent; border-radius: 9px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); text-align: left; }
.assistant-nav-item:hover:not(.is-active) { background: var(--alu-hover); color: var(--alu-text); }
.assistant-nav-item.is-active { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); color: var(--alu-highlight); }
.assistant-nav-dot { width: 7px; height: 7px; margin-left: auto; border-radius: 50%; background: var(--alu-warning); }
.assistant-content { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: 12px; padding: 20px 24px 16px; overflow-y: auto; }
.assistant-intro h3 { margin: 0 0 6px; color: var(--alu-text); font-size: 18px; font-weight: 650; }
.assistant-intro p { max-width: 640px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.assistant-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.assistant-meta { flex: 1 1 auto; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-content :deep(.assistant-status) { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-content :deep(.assistant-note) { margin: 0; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-content :deep(.assistant-note.is-warning) { border-color: rgb(var(--alu-warning-rgb) / .35); color: var(--alu-warning); }
.assistant-content :deep(.assistant-error) { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; padding: 9px 10px; border: 1px solid var(--alu-danger-border); border-radius: 8px; background: var(--alu-danger-bg); color: var(--alu-danger); font-size: var(--alu-meta-size); }
.assistant-content :deep(.assistant-text-block) { margin: 0; padding: 12px 14px; overflow: auto; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); color: var(--alu-text); font: 13px/1.75 var(--font-reading); white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant-preview-text { min-height: 0; flex: 1 1 auto; }
.assistant-search { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.assistant-search > input { min-width: 180px; flex: 1 1 220px; }
.assistant-search label { display: flex; align-items: center; gap: 6px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-search label input { width: 150px; }
.assistant-timeline { display: grid; gap: 8px; }
.assistant-timeline h4 { margin: 4px 0 0; color: var(--alu-text-dim); font-size: var(--alu-meta-size); font-weight: 650; }
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
.assistant-content :deep(.assistant-empty) { margin: 8px 2px; color: var(--alu-text-faint); font-size: var(--alu-meta-size); }
.assistant-content :deep(.assistant-more) { align-self: center; padding: 6px 12px; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 8px; color: var(--alu-accent); font-size: var(--alu-meta-size); }
.assistant-content :deep(.assistant-more:hover:not(:disabled)) { background: var(--alu-hover); }
.assistant-content :deep(.assistant-more:disabled) { cursor: wait; opacity: .6; }
.assistant-footnote { margin: 0; padding: 8px 18px; overflow: hidden; border-top: 1px solid var(--alu-border); background: var(--alu-bg-raised); color: var(--alu-text-faint); font-size: var(--alu-micro-size); text-overflow: ellipsis; white-space: nowrap; }
.spinning { animation: assistantSpin 1s linear infinite; }
@keyframes assistantSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
@media (max-width: 640px) {
  .assistant-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .assistant-nav { flex-direction: row; gap: 4px; overflow-x: auto; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--alu-border); scrollbar-width: none; }
  .assistant-nav::-webkit-scrollbar { display: none; }
  .assistant-nav-item { width: auto; min-height: 36px; flex: 0 0 auto; gap: 6px; padding: 0 8px; }
  .assistant-content { padding: 16px 14px; }
  .assistant-search label input { width: 132px; }
}
</style>
