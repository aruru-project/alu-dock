<script setup lang="ts">
import { computed, ref } from 'vue'
import { History } from '@lucide/vue'
import { savedSessionCost, savedSessionSearchText, savedSessionTime, savedSessionTitle } from '../lib/savedSessions'
import type { SavedSession } from '../lib/types'

// Resume and "new Work from a saved Session" differ only in their data, whether
// the directory is worth showing, and what choosing a row does.
const props = defineProps<{
  sessions: readonly SavedSession[]
  total: number
  showDirectory: boolean
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  moreFailed: string
  incomplete: boolean
  disabled: boolean
  emptyText: string
}>()
defineEmits<{ select: [session: SavedSession]; retry: [] }>()

const search = ref('')
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return query ? props.sessions.filter((session) => savedSessionSearchText(session).includes(query)) : props.sessions
})
</script>

<template>
  <section class="saved-session-list">
    <div class="ui-dialog-search-wrap"><input v-model="search" type="search" class="ui-dialog-input ui-dialog-search" placeholder="搜索名称、首句或目录…" :disabled="!loaded" /></div>
    <div v-if="loading" class="alu-dialog-loading"><span class="alu-agent-activity-spinner" />正在读取保存的 Session…</div>
    <div v-else-if="loaded" class="ui-dialog-options">
      <button
        v-for="session in filtered"
        :key="session.token"
        type="button"
        class="ui-dialog-option saved-session-option"
        :class="{ 'is-current': session.current }"
        :disabled="disabled || session.current"
        @click="$emit('select', session)"
      >
        <span class="ui-dialog-option-marker"><History :size="15" /></span>
        <span class="ui-dialog-option-content">
          <span class="ui-dialog-option-top">
            <span class="ui-dialog-option-label saved-session-title">{{ savedSessionTitle(session) }}</span>
            <span v-if="session.current" class="ui-dialog-option-badge">当前</span>
          </span>
          <span class="saved-session-meta">
            <span v-if="showDirectory" class="saved-session-cwd" :title="session.cwd">{{ session.cwd }}</span>
            <span v-if="savedSessionTime(session.lastActivityAt)">{{ savedSessionTime(session.lastActivityAt) }}</span>
            <span>{{ savedSessionCost(session.costTotal) }}</span>
          </span>
        </span>
      </button>
      <div v-if="!filtered.length && !loadingMore" class="ui-dialog-empty">{{ search.trim() ? '没有匹配的 Session。' : emptyText }}</div>
    </div>
    <div v-if="loadingMore" class="cmd-palette-footer" role="status">正在读取更多 Session…（{{ sessions.length }} / {{ total }}）</div>
    <div v-else-if="moreFailed" class="cmd-palette-footer saved-session-more-failed" role="alert">
      <span>后面的 Session 没有读完：{{ moreFailed }}</span>
      <button type="button" @click="$emit('retry')">重新读取</button>
    </div>
    <div v-if="incomplete" class="cmd-palette-footer">部分 Session 暂时没有载入。请稍后重新打开。</div>
  </section>
</template>

<style scoped>
.saved-session-list { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; }
.saved-session-title { font-size: 13px; font-weight: 600; }
.saved-session-meta { display: flex; min-width: 0; align-items: baseline; color: var(--alu-text-muted); font-size: 10px; line-height: 1.4; white-space: nowrap; }
.saved-session-meta > span { flex: 0 0 auto; }
.saved-session-meta > span + span::before { content: '·'; margin: 0 6px; color: var(--alu-text-faint); }
.saved-session-meta > .saved-session-cwd { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.saved-session-more-failed { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--alu-rose); }
.saved-session-more-failed > button { flex-shrink: 0; color: var(--alu-blue); }
@media (min-width: 1200px) {
  .saved-session-title { font-size: calc(var(--alu-control-size) + 1px); }
  .saved-session-meta { font-size: var(--alu-meta-size); }
}
</style>
