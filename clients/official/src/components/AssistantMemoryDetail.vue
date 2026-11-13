<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { assistantTime, MEMORY_DELETED_EFFECT, memoryAuthorLabel, memoryChangeLabel, memoryLength, memoryResidentLabel, memoryStateLabel, memoryTopics } from '../lib/assistant'
import type { AssistantMemoryTopic } from '../lib/types'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import AssistantConversation from './AssistantConversation.vue'

// One memory: its text, how it is used, what to do with it, where it was said and its changes.
const memory = useAssistantMemoryStore()
const { detail, source } = memory
const { rewrite, memoryLimit } = storeToRefs(memory)
const shown = computed(() => detail.memory)
const pending = computed(() => detail.change?.state === 'pending')
const rewriteLength = computed(() => memoryLength(rewrite.value ?? '', memoryLimit.value))
const rewriteSaveable = computed(() => !!rewrite.value?.trim() && rewrite.value.trim() !== shown.value?.text && !rewriteLength.value.over)
const actionsHint = computed(() => {
  const state = shown.value?.state
  if (state === 'active') return `作废：这件事已经不成立了，留作记录，她不再用它。删除：${MEMORY_DELETED_EFFECT}删除后可以在「已删除」里恢复，恢复后都会回来。`
  if (state === 'retired') return `这条已作废，她不再用它，记录还留着。恢复后她又会用。删除：${MEMORY_DELETED_EFFECT}删除后可以在「已删除」里恢复，恢复后都会回来。`
  if (state === 'forgotten') return `这条已删除：${MEMORY_DELETED_EFFECT}恢复后都会回来。`
  return ''
})

function setTopic(topic: AssistantMemoryTopic) {
  if (shown.value && topic !== shown.value.topic) void memory.changeMemory('topic', { topic })
}
// Choosing the option already shown still counts: from then on the background leaves it as chosen.
function setResident(resident: boolean) {
  if (shown.value) void memory.changeMemory('resident', { resident })
}
function saveRewrite() {
  if (rewriteSaveable.value) void memory.changeMemory('text', { text: rewrite.value!.trim() })
}
function input(event: Event) {
  memory.editRewrite((event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <AssistantConversation v-if="source.place" :reading="source" back-label="← 返回这条记忆" @back="memory.closeSource()" @more="memory.readSourceMore">
    <p v-if="shown" class="memory-quote">这条记忆：{{ shown.text }}</p>
  </AssistantConversation>
  <section v-else class="memory-detail" aria-label="这条记忆">
    <div class="memory-detail-head">
      <button type="button" class="button secondary" @click="memory.closeMemory()">← 返回列表</button>
      <span v-if="shown" class="memory-detail-state" :class="`is-${shown.state}`">{{ memoryStateLabel(shown.state) }}</span>
    </div>

    <div v-if="!shown && detail.error" class="assistant-error" role="alert"><span>{{ detail.error }}</span><button type="button" class="button secondary" :disabled="detail.loading" @click="memory.readMemory(detail.id!)">重试</button></div>
    <div v-else-if="!shown" class="assistant-status" role="status">正在读取这条记忆…</div>
    <template v-else>
      <div v-if="rewrite === null" class="memory-detail-text">{{ shown.text }}</div>
      <div v-else class="memory-rewrite">
        <p v-if="detail.change?.kind === 'text' && detail.change.state === 'failed'" class="memory-rewrite-now">现在的内容：{{ shown.text }}</p>
        <textarea class="memory-rewrite-input" :value="rewrite" aria-label="改写这条记忆" spellcheck="false" :disabled="pending" @input="input" />
        <p class="alu-counter" :class="{ 'is-over': rewriteLength.over }" :role="rewriteLength.over ? 'alert' : undefined">{{ rewriteLength.label }}</p>
        <div class="memory-rewrite-actions">
          <button type="button" class="button secondary" :disabled="pending" @click="memory.cancelRewrite()">不改了</button>
          <button type="button" class="button primary" :disabled="pending || !rewriteSaveable" @click="saveRewrite">{{ pending && detail.change?.kind === 'text' ? '正在保存…' : '保存改写' }}</button>
        </div>
      </div>
      <p class="memory-detail-meta">{{ [`#${shown.id}`, memoryAuthorLabel(shown), assistantTime(shown.updatedAt)].filter(Boolean).join(' · ') }}<template v-if="shown.revision > 1"> · 最早记于 {{ assistantTime(shown.createdAt) }}</template><template v-if="shown.saidAt !== shown.createdAt"> · 说起于 {{ assistantTime(shown.saidAt) }}</template></p>

      <p v-if="detail.change" class="memory-change" :class="`is-${detail.change.state}`" :role="detail.change.state === 'failed' ? 'alert' : 'status'">
        {{ detail.change.message }}
        <button v-if="detail.change.mergedInto" type="button" class="alu-link-button" @click="memory.openMemory(detail.change.mergedInto)">去看合并后的那一条</button>
      </p>

      <template v-if="shown.state === 'active'">
        <div class="memory-field">
          <span class="memory-field-label">分类</span>
          <div class="alu-chips" role="radiogroup" aria-label="分类">
            <button v-for="item in memoryTopics" :key="item.topic" type="button" role="radio" class="alu-chip" :class="{ 'is-active': shown.topic === item.topic }" :aria-checked="shown.topic === item.topic" :disabled="pending" @click="setTopic(item.topic)">{{ item.label }}</button>
          </div>
        </div>
        <div class="memory-field">
          <span class="memory-field-label">什么时候用</span>
          <div class="alu-switch" role="radiogroup" aria-label="什么时候用">
            <button type="button" role="radio" :class="{ 'is-active': shown.resident }" :aria-checked="shown.resident" :disabled="pending" @click="setResident(true)">{{ memoryResidentLabel(true) }}</button>
            <button type="button" role="radio" :class="{ 'is-active': !shown.resident }" :aria-checked="!shown.resident" :disabled="pending" @click="setResident(false)">{{ memoryResidentLabel(false) }}</button>
          </div>
        </div>
        <p class="memory-hint">「{{ memoryResidentLabel(true) }}」的会随人设一起读入；「{{ memoryResidentLabel(false) }}」的，她搜记忆时才会找到。在这里选过一次（点现在的选项也算），后台整理就不会再改这一项。到她的对话里点“刷新助手（Reload）”，就能让她重新读入改动。</p>
      </template>

      <div class="memory-actions">
        <template v-if="shown.state === 'active'">
          <button v-if="rewrite === null" type="button" class="button secondary" :disabled="pending" @click="memory.startRewrite()">改写</button>
          <button type="button" class="button secondary" :disabled="pending" @click="memory.changeMemory('retired', { state: 'retired' })">作废</button>
          <button type="button" class="button memory-forget" :disabled="pending" @click="memory.changeMemory('forgotten', { state: 'forgotten' })">删除</button>
        </template>
        <template v-else-if="shown.state === 'retired' || shown.state === 'forgotten'">
          <button type="button" class="button primary" :disabled="pending" @click="memory.changeMemory('active', { state: 'active' })">恢复</button>
          <button v-if="shown.state === 'retired'" type="button" class="button memory-forget" :disabled="pending" @click="memory.changeMemory('forgotten', { state: 'forgotten' })">删除</button>
        </template>
      </div>
      <p class="memory-hint">{{ actionsHint }}</p>
      <p v-if="shown.supersededBy" class="memory-hint">整理时它被合并进了 #{{ shown.supersededBy }}。<button type="button" class="alu-link-button" @click="memory.openMemory(shown.supersededBy)">看那一条</button></p>

      <section class="memory-section" aria-label="出处">
        <h4>在哪里说的</h4>
        <p v-if="!shown.sourceCount" class="memory-hint">没有记下出处（比如是你自己写的）。</p>
        <ul v-else class="memory-sources">
          <li v-for="item in shown.sources" :key="`${item.sessionId}:${item.entryId}`">
            <button type="button" class="memory-source" @click="memory.openSource(item)"><time>{{ assistantTime(item.at) }}</time><span>看原话</span></button>
          </li>
        </ul>
        <p v-if="shown.sourceCount > shown.sources.length" class="memory-hint">一共 {{ shown.sourceCount }} 处，这里列出最早的 {{ shown.sources.length }} 处。</p>
      </section>

      <section class="memory-section" aria-label="改动记录">
        <h4>改动记录</h4>
        <div v-if="detail.error" class="assistant-error" role="alert"><span>{{ detail.error }}</span><button type="button" class="button secondary" :disabled="detail.loading" @click="memory.readMemory(shown.id)">重试</button></div>
        <div v-else-if="detail.loading && !detail.history.length" class="assistant-status" role="status">正在读取改动记录…</div>
        <ol v-else class="memory-history">
          <li v-for="(change, index) in detail.history" :key="index">
            <span class="memory-history-head"><time>{{ assistantTime(change.at) }}</time><strong>{{ memoryChangeLabel(change) }}</strong></span>
            <span v-if="change.text" class="memory-history-text">{{ change.text }}</span>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>

<style scoped>
.memory-detail { display: flex; flex-direction: column; gap: 12px; }
.memory-quote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--alu-highlight-border); color: var(--alu-text-dim); font: var(--alu-meta-size)/1.6 var(--font-reading); overflow-wrap: anywhere; }
.memory-detail-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.memory-detail-state { padding: 2px 9px; border-radius: 999px; background: var(--alu-tag-bg); color: var(--alu-text-dim); font-size: var(--alu-micro-size); }
.memory-detail-state.is-active { background: rgb(var(--alu-success-rgb) / .08); color: var(--alu-success-text); }
.memory-detail-state.is-retired, .memory-detail-state.is-forgotten { background: rgb(var(--alu-warning-rgb) / .1); color: var(--alu-warning-text); }
.memory-detail-text { padding: 12px 14px; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); color: var(--alu-text); font: 15px/1.75 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
.memory-rewrite { display: grid; gap: 8px; }
.memory-rewrite-now { margin: 0; color: var(--alu-text-dim); font: var(--alu-meta-size)/1.6 var(--font-reading); overflow-wrap: anywhere; }
.memory-rewrite-input { min-height: 96px; width: 100%; padding: 10px 12px; resize: vertical; border: 1px solid var(--alu-border-focus); border-radius: 10px; background: var(--alu-bg-raised); color: var(--alu-text); font: 15px/1.75 var(--font-reading); }
.memory-rewrite-input:focus { outline: none; border-color: var(--alu-highlight-border); }
.memory-rewrite-actions, .memory-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.memory-rewrite-actions { justify-content: flex-end; }
.memory-detail-meta { margin: -4px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.memory-change { margin: 0; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); line-height: 1.6; }
.memory-change.is-done { border-color: var(--alu-success-border); color: var(--alu-success-text); }
.memory-change.is-failed { border-color: var(--alu-danger-border); background: var(--alu-danger-bg); color: var(--alu-danger); }
.memory-field { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: 10px; }
.memory-field-label { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.memory-hint { margin: 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); line-height: 1.6; }
.button.memory-forget { color: var(--alu-danger); background: var(--alu-danger-bg); border: 1px solid var(--alu-danger-border); }
.memory-section { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--alu-border); }
.memory-section h4 { margin: 0; color: var(--alu-text-dim); font-size: var(--alu-meta-size); font-weight: 650; }
.memory-sources { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.memory-source { display: inline-flex; min-height: 32px; align-items: center; gap: 8px; padding: 0 11px; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 8px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); }
.memory-source span { color: var(--alu-accent); }
.memory-source:hover { background: var(--alu-hover); color: var(--alu-text); }
.memory-history { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.memory-history li { display: grid; gap: 3px; padding-left: 10px; border-left: 2px solid var(--alu-border-light); }
.memory-history-head { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.memory-history-head strong { color: var(--alu-text-dim); font-weight: 600; }
.memory-history-text { color: var(--alu-text-dim); font: var(--alu-meta-size)/1.6 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 640px) {
  .memory-field { grid-template-columns: 1fr; gap: 6px; }
  .memory-actions .button { flex: 1 1 0; }
}
</style>
