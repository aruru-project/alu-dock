<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BookUser, Brain, Eye, NotebookPen, RefreshCw, Search, Settings2, Sparkles, X } from '@lucide/vue'
import { assistantTime, memoryResidentLabel } from '../lib/assistant'
import { useAppStore } from '../stores/app'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import { useAssistantSearchStore } from '../stores/assistant-search'
import { useSurfacesStore, type AssistantSection } from '../stores/surfaces'
import AssistantDocumentEditor from './AssistantDocumentEditor.vue'
import AssistantMemories from './AssistantMemories.vue'
import AssistantSearch from './AssistantSearch.vue'
import AssistantSettings from './AssistantSettings.vue'

// Her settings and memories stay on Main; the conversation entry opens the listed Work, never a new one.
const emit = defineEmits<{ close: [] }>()
const app = useAppStore()
const assistant = useAssistantStore()
const memory = useAssistantMemoryStore()
const search = useAssistantSearchStore()
const { preview, info } = storeToRefs(assistant)
const surfaces = useSurfacesStore()
const { assistantSection: section } = storeToRefs(surfaces)
const assistantWork = computed(() => app.works.find(work => work.assistant))
function openConversation() {
  if (!assistantWork.value) return
  app.selectWork(assistantWork.value.id)
  emit('close')
}

const sections: Array<{ id: AssistantSection; label: string; icon: typeof Eye }> = [
  { id: 'preview', label: '她会读到什么', icon: Eye },
  { id: 'persona', label: '人设', icon: BookUser },
  { id: 'notes', label: '手写设定', icon: NotebookPen },
  { id: 'memories', label: '记忆', icon: Brain },
  { id: 'search', label: '搜索对话', icon: Search },
  { id: 'settings', label: '设置', icon: Settings2 },
]

// Each section reads the Host's current version the first time it is shown while the page is open.
// How her memories are being made is read when the page opens, whichever section that is: every
// section says when no model is chosen. It changes as she works, so the two sections about her
// memories read it again when they are first shown.
const readThisOpen = ref(new Set<AssistantSection>())
watch([section, () => app.connectionContext?.connectionId, () => app.connectionContext?.selectionGeneration], ([current], previous) => {
  if (previous && (previous[1] !== app.connectionContext?.connectionId || previous[2] !== app.connectionContext?.selectionGeneration)) readThisOpen.value = new Set()
  if (!app.connectionContext || readThisOpen.value.has(current)) return
  if (!readThisOpen.value.size || current === 'memories' || current === 'settings') void assistant.loadInfo()
  readThisOpen.value.add(current)
  if (current === 'preview') void assistant.loadPreview()
  else if (current === 'persona' || current === 'notes') void assistant.loadDocument(current)
  else if (current === 'memories') {
    void memory.loadMemories()
    if (memory.detail.id) void memory.readMemory(memory.detail.id)
  } else if (current === 'settings') {
    void memory.loadSettings()
    void memory.loadModels()
    void memory.refreshHandoffStatus()
  }
}, { immediate: true })

// Android Back steps back inside the page before it closes it, as each 「返回」 button does: where a
// memory was said → the memory → the list; a conversation around a search hit → the results.
onUnmounted(surfaces.onAssistantBack(() => {
  if (section.value === 'memories' && memory.source.place) memory.closeSource()
  else if (section.value === 'memories' && memory.detail.id) memory.closeMemory()
  else if (section.value === 'search' && search.reading.place) search.closeContext()
  else return false
  return true
}))
</script>

<template>
  <header class="assistant-header">
    <div class="assistant-heading">
      <span class="assistant-mark"><Sparkles :size="20" /></span>
      <div>
        <h2 id="assistant-title">助手</h2>
        <p>助手一直住在 Main，对话、人设和记忆都留在这里</p>
      </div>
    </div>
    <button class="assistant-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="assistant-layout">
    <nav class="assistant-nav" aria-label="助手分区">
      <button v-for="item in sections" :key="item.id" type="button" class="assistant-nav-item" :class="{ 'is-active': section === item.id }" :aria-current="section === item.id ? 'page' : undefined" @click="section = item.id">
        <component :is="item.icon" :size="16" /><span>{{ item.label }}</span>
        <span v-if="((item.id === 'persona' || item.id === 'notes') && assistant.editor(item.id).draft !== null) || (item.id === 'memories' && memory.hasDrafts) || (item.id === 'search' && search.hasDrafts)" class="assistant-nav-dot" aria-label="有未保存的改动" />
      </button>
    </nav>

    <main :key="section" class="assistant-content">
      <div v-if="assistantWork" class="assistant-toolbar">
        <button type="button" class="button secondary" @click="openConversation">打开{{ assistantWork.displayName || '助手' }}的对话</button>
      </div>
      <p v-if="info?.extraction?.state === 'off' && section !== 'settings'" class="assistant-note is-warning has-action" role="status">
        <span>还没选整理记忆的模型，她现在不会从对话里自动记东西。</span>
        <button type="button" class="alu-link-button" @click="section = 'settings'">去选模型</button>
      </p>

      <template v-if="section === 'preview'">
        <div class="assistant-intro">
          <h3>她会读到什么</h3>
          <p>下面是目前保存的人设、手写设定和记忆。到她的对话里点“刷新助手（Reload）”，她会重新读入这些内容，对话不会重来。</p>
        </div>
        <div class="assistant-toolbar">
          <span v-if="preview?.result" class="assistant-meta">生成于 {{ assistantTime(preview.result.loadedAt) }}</span>
          <button type="button" class="button secondary" :disabled="preview?.loading" @click="assistant.loadPreview()"><RefreshCw :size="15" :class="{ spinning: preview?.loading }" />{{ preview?.loading ? '正在读取…' : '刷新' }}</button>
        </div>
        <div v-if="preview?.error" class="assistant-error" role="alert"><span>{{ preview.error }}</span></div>
        <div v-if="preview?.loading && !preview.result" class="assistant-status" role="status">正在读取她会读到的内容…</div>
        <pre v-else-if="preview?.result" class="assistant-text-block assistant-preview-text">{{ preview.result.text || '（现在是空的）' }}</pre>
      </template>

      <template v-else-if="section === 'persona' || section === 'notes'">
        <div class="assistant-intro">
          <h3>{{ section === 'persona' ? '人设' : '手写设定' }}</h3>
          <p v-if="section === 'persona'">她是谁、怎么说话。保存后，到她的对话里点“刷新助手（Reload）”，她就会读到改动。</p>
          <p v-else>你写给她的设定和要记住的事。保存后，到她的对话里点“刷新助手（Reload）”，她就会读到改动。</p>
        </div>
        <AssistantDocumentEditor :document="section" />
      </template>

      <template v-else-if="section === 'memories'">
        <div v-if="!memory.detail.id" class="assistant-intro">
          <h3>记忆</h3>
          <p>她从对话里记住的事。「{{ memoryResidentLabel(true) }}」的会随人设一起读入，其余的她查的时候才用。你在这里改过的，后台整理不会再动。</p>
        </div>
        <AssistantMemories @settings="section = 'settings'" />
      </template>

      <template v-else-if="section === 'settings'">
        <div class="assistant-intro">
          <h3>设置</h3>
          <p>这些设置保存在 Main 上，哪台设备改的都是同一份。</p>
        </div>
        <AssistantSettings />
      </template>

      <template v-else>
        <div class="assistant-intro">
          <h3>搜索对话</h3>
          <p>在她经历过的对话里找。几个词用空格分开，要全部出现才算找到；只选日期不填词，就列出那几天的时间线和对话。时间线是后台按对话写的目录，一段一行，写那段时间你们在做什么；写错了可以改写或忘掉，你改过的行后台不再动。</p>
        </div>
        <AssistantSearch />
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
.assistant-preview-text { min-height: 0; flex: 1 1 auto; }
.assistant-footnote { margin: 0; padding: 8px 18px; overflow: hidden; border-top: 1px solid var(--alu-border); background: var(--alu-bg-raised); color: var(--alu-text-faint); font-size: var(--alu-micro-size); text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) {
  .assistant-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .assistant-nav { flex-direction: row; gap: 4px; overflow-x: auto; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--alu-border); scrollbar-width: none; }
  .assistant-nav::-webkit-scrollbar { display: none; }
  .assistant-nav-item { width: auto; min-height: 36px; flex: 0 0 auto; gap: 6px; padding: 0 8px; }
  .assistant-content { padding: 16px 14px; }
}
</style>
