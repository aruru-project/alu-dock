<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { RefreshCw } from '@lucide/vue'
import { assistantTime, extractionStateLabel } from '../lib/assistant'
import { modelKey } from '../lib/modelLists'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import AluSelect from './AluSelect.vue'

// Her settings on Main: the model that makes her memories, and how making them goes.
const assistant = useAssistantStore()
const memory = useAssistantMemoryStore()
const { settings } = memory
const { extraction, models } = storeToRefs(memory)

const NO_MODEL = ''
const NOT_READ = '\u0000'
const saving = computed(() => settings.save?.state === 'pending')
/** A choice being saved shows as chosen; otherwise what Main has. */
const chosen = computed(() => saving.value ? settings.save!.model : settings.current?.extractionModel ?? null)
// The models a new Work on Main offers: Main's models, less the hidden ones.
const modelList = computed(() => {
  const result = models.value?.result
  if (!result) return []
  const hidden = new Set(result.hidden.map(modelKey))
  return result.models.filter((model) => !hidden.has(modelKey(model)))
})
const options = computed(() => {
  const current = chosen.value
  const named = (model: { provider: string; id: string; name: string }) => model.name && model.name !== model.id ? model.name : ''
  // The same model offered by several providers is told apart where it is shown as the choice.
  const shared = new Set(modelList.value.map(named).filter((name, index, names) => name && names.indexOf(name) !== index))
  // A chosen model Main does not offer now (signed out, removed or hidden) still shows as the choice.
  const missing = current && !modelList.value.some((model) => modelKey(model) === modelKey(current))
    ? [{ value: modelKey(current), label: `${current.provider}/${current.id}`, ...(models.value?.state === 'ready' ? { description: '现在不在 Main 的模型列表里' } : {}) }]
    : []
  return [
    { value: NO_MODEL, label: '不整理', description: '不从对话里自动记东西' },
    ...missing,
    ...modelList.value.map((model) => ({
      value: modelKey(model),
      label: !named(model) ? `${model.provider}/${model.id}` : shared.has(named(model)) ? `${named(model)} · ${model.provider}` : named(model),
      description: `${model.provider}/${model.id}`,
    })),
  ]
})
const selected = computed(() => !settings.current && !saving.value ? NOT_READ : chosen.value ? modelKey(chosen.value) : NO_MODEL)
const placeholder = computed(() => settings.loading ? '正在读取…' : '没有读到现在的设置')
const refreshing = computed(() => assistant.current?.state === 'loading' || !!assistant.current?.refreshing)

function choose(value: string) {
  if (value === selected.value) return
  if (value === NO_MODEL) {
    void memory.chooseModel(null)
    return
  }
  const model = [...modelList.value, ...(chosen.value ? [chosen.value] : [])].find((item) => modelKey(item) === value)
  if (model) void memory.chooseModel({ provider: model.provider, id: model.id })
}
</script>

<template>
  <section class="assistant-setting" aria-labelledby="assistant-extraction-model">
    <h4 id="assistant-extraction-model">整理记忆的模型</h4>
    <p class="assistant-setting-text">一段对话停下一阵后，她会用这个模型把值得记住的事记下来；空闲时再对照原话，把记下的整理一遍。没选模型就不整理。</p>
    <div class="assistant-setting-row">
      <AluSelect :value="selected" :options="options" label="整理记忆的模型" :placeholder="placeholder" :disabled="saving || !settings.current" @select="choose" />
      <button type="button" class="assistant-setting-refresh" aria-label="刷新模型列表" title="刷新模型列表" :disabled="models?.state === 'loading'" @click="memory.loadModels(true)"><RefreshCw :size="15" :class="{ spinning: models?.state === 'loading' }" /></button>
    </div>
    <p v-if="models?.state === 'failed'" class="assistant-note">读不到 Main 的模型列表。改过模型或登录后，点右侧的刷新。</p>
    <p v-else-if="models?.state === 'loading' && !modelList.length" class="assistant-status" role="status">正在读取 Main 的模型…</p>
    <div v-if="settings.error" class="assistant-error" role="alert"><span>{{ settings.error }}</span><button type="button" class="button secondary" :disabled="settings.loading" @click="memory.loadSettings()">重试</button></div>
    <p v-if="settings.save && settings.save.state !== 'pending'" class="assistant-setting-saved" :class="{ 'is-error': settings.save.state === 'failed' }" :role="settings.save.state === 'failed' ? 'alert' : 'status'">{{ settings.save.message }}</p>
    <p v-else-if="settings.current && !settings.current.extractionModel && !saving" class="assistant-note is-warning" role="status">还没选模型，她不会从对话里自动记东西。选一个模型就会开始。</p>
  </section>

  <section class="assistant-setting" aria-labelledby="assistant-extraction-status">
    <div class="assistant-setting-head">
      <h4 id="assistant-extraction-status">整理状态</h4>
      <button type="button" class="button secondary" :disabled="refreshing" @click="assistant.loadInfo()"><RefreshCw :size="14" :class="{ spinning: refreshing }" />{{ refreshing ? '正在读取…' : '刷新' }}</button>
    </div>
    <p v-if="assistant.current?.refreshError" class="assistant-note is-warning" role="status">{{ assistant.current.refreshError }}下面是之前读到的。</p>
    <template v-if="extraction">
      <dl class="assistant-setting-facts">
        <div><dt>现在</dt><dd :class="`is-${extraction.state}`">{{ extractionStateLabel(extraction) }}</dd></div>
        <div><dt>等着整理</dt><dd>{{ extraction.waitingSessions ? `${extraction.waitingSessions} 段对话有新内容还没整理` : '没有' }}</dd></div>
        <div><dt>上次整理</dt><dd>{{ extraction.lastRunAt ? assistantTime(extraction.lastRunAt) : '还没有整理过' }}</dd></div>
        <div v-if="extraction.retryAt"><dt>下次重试</dt><dd>{{ assistantTime(extraction.retryAt) }}</dd></div>
      </dl>
      <p v-if="extraction.lastError" class="assistant-note is-warning" role="status">{{ extraction.lastError }}</p>
    </template>
    <p v-else-if="refreshing" class="assistant-status" role="status">正在读取整理状态…</p>
    <p v-else class="assistant-note" role="status">暂时读不到整理状态。请点刷新再试。</p>
  </section>
</template>

<style scoped>
.assistant-setting { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--alu-border); border-radius: 12px; background: var(--alu-bg-raised); }
.assistant-setting h4 { margin: 0; color: var(--alu-text); font-size: var(--alu-control-size); font-weight: 650; }
.assistant-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.assistant-setting-text { max-width: 640px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.assistant-setting-row { display: flex; align-items: center; gap: 8px; max-width: 520px; }
.assistant-setting-refresh { display: grid; width: 36px; height: 36px; flex: 0 0 auto; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.assistant-setting-refresh:hover:not(:disabled) { background: var(--alu-hover); color: var(--alu-text); }
.assistant-setting-saved { margin: 0; color: var(--alu-success-text); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-setting-saved.is-error { color: var(--alu-danger); }
.assistant-setting-facts { display: grid; gap: 6px; margin: 0; }
.assistant-setting-facts div { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-setting-facts dt { color: var(--alu-text-muted); }
.assistant-setting-facts dd { margin: 0; color: var(--alu-text); }
.assistant-setting-facts dd.is-working { color: var(--alu-running); }
.assistant-setting-facts dd.is-off, .assistant-setting-facts dd.is-failed { color: var(--alu-warning-text); }
.assistant-setting .button { min-height: 32px; padding: 0 11px; font-size: var(--alu-meta-size); }
@media (max-width: 640px) {
  .assistant-setting { padding: 12px; }
  .assistant-setting-facts div { grid-template-columns: 72px minmax(0, 1fr); }
}
</style>
