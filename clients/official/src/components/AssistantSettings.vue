<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { RefreshCw } from '@lucide/vue'
import { assistantTime, extractionStateLabel } from '../lib/assistant'
import { modelKey } from '../lib/modelLists'
import { modelSpeedOptions } from '../lib/settingLabels'
import type { ModelSpeedTier } from '../lib/types'
import { useAssistantStore } from '../stores/assistant'
import { useAssistantMemoryStore } from '../stores/assistant-memory'
import { useWorkActionsStore } from '../stores/work-actions'
import AluSelect from './AluSelect.vue'

// Main owns the saved settings; the assistant Work reports its own rolling hand-over status.
const assistant = useAssistantStore()
const memory = useAssistantMemoryStore()
const actions = useWorkActionsStore()
const { settings, restart } = memory
const { extraction, models, handoff, handoffValues, speedChoice } = storeToRefs(memory)
const handoffSaving = computed(() => handoff.value.save?.state === 'pending')
function editTokens(field: 'startTokens' | 'keepRecentTokens', event: Event) {
  const value = (event.target as HTMLInputElement).value
  memory.editHandoff({ [field]: value === '' ? null : Number(value) })
}

const NO_MODEL = ''
const NOT_READ = '\u0000'
const saving = computed(() => settings.save?.state === 'pending')
const speedSaving = computed(() => speedChoice.value?.state === 'pending')
const chosenSpeed = computed(() => speedSaving.value ? speedChoice.value!.tier : settings.current?.extractionSpeed)
function chooseSpeed(value: string) {
  if (value === chosenSpeed.value && speedChoice.value?.state !== 'failed') return
  void memory.chooseSpeed(value as ModelSpeedTier)
}
/** A choice being saved shows as chosen; otherwise what Main has. */
const chosen = computed(() => saving.value ? settings.save!.model : settings.current?.extractionModel ?? null)
// The models a new Work on Main offers: Main's models, less the hidden ones.
const modelList = computed(() => {
  const result = models.value?.result
  if (!result) return []
  const hidden = new Set(result.hidden.map(modelKey))
  return result.models.filter((model) => !hidden.has(modelKey(model)))
})
const memorySpeedTiers = computed(() => modelList.value.find(model => chosen.value && modelKey(model) === modelKey(chosen.value))?.speedTiers ?? [])
const memorySpeedAvailable = computed(() => memorySpeedTiers.value.some(tier => tier !== 'standard'))
const memorySpeedOptions = computed(() => modelSpeedOptions.filter(option => memorySpeedTiers.value.includes(option.value as ModelSpeedTier)))
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
/** The chosen model as the list names it. */
const chosenLabel = computed(() => options.value.find((option) => option.value === selected.value)?.label ?? '')
const placeholder = computed(() => settings.loading ? '正在读取…' : '没有读到现在的设置')
const refreshing = computed(() => assistant.current?.state === 'loading' || !!assistant.current?.refreshing)

function choose(value: string) {
  // The value shown is chosen again only after a save that failed or whose reply was lost: Main
  // may hold the other choice, and choosing the one shown is how the owner takes it back.
  if (value === selected.value && settings.save?.state !== 'failed') return
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
    <template v-if="settings.current?.extractionSpeed !== undefined && memorySpeedAvailable">
      <label class="assistant-handoff-field">整理记忆的速度
        <AluSelect :value="chosenSpeed ?? 'standard'" :options="memorySpeedOptions" label="整理记忆的速度" :disabled="speedSaving" @select="chooseSpeed" />
      </label>
      <p class="assistant-setting-text">仅用于记忆整理，与聊天速度分开；加速可能增加费用。</p>
    </template>
    <p v-if="speedChoice" class="assistant-setting-saved" :class="{ 'is-error': speedChoice.state === 'failed', 'is-pending': speedSaving }" :role="speedChoice.state === 'failed' ? 'alert' : 'status'">{{ speedChoice.message }}</p>
    <p v-if="models?.state === 'failed'" class="assistant-note">读不到 Main 的模型列表。改过模型或登录后，点右侧的刷新。</p>
    <p v-else-if="models?.state === 'loading' && !modelList.length" class="assistant-status" role="status">正在读取 Main 的模型…</p>
    <div v-if="settings.error" class="assistant-error" role="alert"><span>{{ settings.error }}</span><button type="button" class="button secondary" :disabled="settings.loading" @click="memory.loadSettings()">重试</button></div>
    <p v-if="settings.save" class="assistant-setting-saved" :class="{ 'is-error': settings.save.state === 'failed', 'is-pending': saving }" :role="settings.save.state === 'failed' ? 'alert' : 'status'">{{ settings.save.message }}</p>
    <p v-else-if="settings.current && !settings.current.extractionModel" class="assistant-note is-warning" role="status">还没选模型，她不会从对话里自动记东西。选一个模型就会开始。</p>
    <div v-if="settings.current?.extractionModel || restart.state !== 'idle'" class="assistant-restart">
      <div v-if="restart.state === 'confirming'" class="assistant-restart-confirm" role="alertdialog" aria-labelledby="assistant-restart-what">
        <p id="assistant-restart-what">她会用「{{ chosenLabel }}」把所有对话从头读一遍、重新整理：后台整理出的记忆挪进「已作废」，可以一条条恢复；后台写的时间线清掉。你写过或改过的，和她按你吩咐记下的，都留着。</p>
        <p>对话多的话要读一阵，读完之前她能查到的记忆还不全；用掉的额度大致和当初整理这些对话加起来差不多。</p>
        <div class="assistant-restart-actions">
          <button type="button" class="button primary" @click="memory.startOver()">从头整理</button>
          <button type="button" class="button secondary" @click="memory.cancelRestart()">取消</button>
        </div>
      </div>
      <button v-else type="button" class="button secondary" :disabled="saving || restart.state === 'pending' || !settings.current?.extractionModel" @click="memory.askRestart()">{{ restart.state === 'pending' ? '正在开始…' : '用这个模型从头整理' }}</button>
      <p v-if="restart.state === 'done' || restart.state === 'failed'" class="assistant-setting-saved" :class="{ 'is-error': restart.state === 'failed' }" :role="restart.state === 'failed' ? 'alert' : 'status'">{{ restart.message }}</p>
    </div>
  </section>

  <section class="assistant-setting" aria-labelledby="assistant-extraction-status">
    <div class="assistant-setting-head">
      <h4 id="assistant-extraction-status">记忆整理状态</h4>
      <button type="button" class="button secondary" :disabled="refreshing" @click="assistant.loadInfo()"><RefreshCw :size="14" :class="{ spinning: refreshing }" />{{ refreshing ? '正在读取…' : '刷新' }}</button>
    </div>
    <p v-if="assistant.current?.refreshError" class="assistant-note is-warning" role="status">{{ assistant.current.refreshError }}下面是之前读到的。</p>
    <template v-if="extraction">
      <dl class="assistant-setting-facts">
        <div><dt>现在</dt><dd :class="`is-${extraction.state}`">{{ extractionStateLabel(extraction) }}</dd></div>
        <div><dt>等着整理</dt><dd>{{ extraction.waitingSessions ? `${extraction.waitingSessions} 段对话有新内容还没整理` : '没有' }}</dd></div>
        <div><dt>上次整理</dt><dd>{{ extraction.lastRunAt ? assistantTime(extraction.lastRunAt) : '还没有整理过' }}</dd></div>
        <div v-if="extraction.retryAt"><dt>下次重试</dt><dd>{{ assistantTime(extraction.retryAt) }}</dd></div>
        <div v-if="extraction.skippedParts"><dt>没读成</dt><dd>{{ extraction.skippedParts }} 段对话先跳过了：模型的回答看不懂，或模型服务一再拒绝这一段。换一个模型或从头整理时会重新读。</dd></div>
      </dl>
      <p v-if="extraction.lastError" class="assistant-note is-warning" role="status">{{ extraction.lastError }}</p>
    </template>
    <p v-else-if="refreshing" class="assistant-status" role="status">正在读取整理状态…</p>
    <p v-else class="assistant-note" role="status">暂时读不到整理状态。请点刷新再试。</p>
  </section>

  <section class="assistant-setting" aria-labelledby="assistant-handoff-settings">
    <h4 id="assistant-handoff-settings">滚动整理对话</h4>
    <p class="assistant-setting-text">对话变长时，用聊天模型整理较早的内容，保留最近的原话。原始记录不会删除。</p>
    <details v-if="handoffValues && handoff.current" class="assistant-handoff-options">
      <summary>整理参数与提示词<span v-if="handoff.draft" class="assistant-handoff-dirty">未保存</span></summary>
      <div class="assistant-handoff-form">
        <div class="assistant-handoff-numbers">
          <label class="assistant-handoff-field">开始整理（token）
            <input type="number" aria-label="开始整理的 token 数" placeholder="自动" :value="handoffValues.startTokens ?? ''" @input="editTokens('startTokens', $event)" />
          </label>
          <label class="assistant-handoff-field">保留最近原话（约 token）
            <input type="number" aria-label="保留最近原话的 token 数" placeholder="自动" :value="handoffValues.keepRecentTokens ?? ''" @input="editTokens('keepRecentTokens', $event)" />
          </label>
        </div>
        <p class="assistant-setting-text">留空使用自动值。原话按整轮保留，实际数量会随当前模型容量调整。</p>
        <button type="button" class="alu-link-button assistant-handoff-auto" @click="memory.editHandoff({ startTokens: null, keepRecentTokens: null })">恢复自动值</button>
        <label class="assistant-handoff-field">交接记录提示词
          <textarea aria-label="交接记录提示词" rows="6" :value="handoffValues.prompt" @input="memory.editHandoff({ prompt: ($event.target as HTMLTextAreaElement).value })" />
        </label>
        <p class="assistant-setting-text">填写整理要求即可，原对话会自动提供。修改从下一次整理生效。</p>
        <button type="button" class="button primary assistant-handoff-save" :disabled="handoffSaving" @click="memory.saveHandoff()">{{ handoffSaving ? '正在保存…' : '保存整理设置' }}</button>
      </div>
    </details>
    <p v-else-if="settings.current" class="assistant-note">这台 Dock 尚不支持滚动整理设置。请更新 Main 后再编辑。</p>
    <p v-else class="assistant-status">{{ settings.loading ? '正在读取整理设置…' : '暂时没有读到整理设置，请重试读取助手设置。' }}</p>
    <p v-if="handoff.save" class="assistant-setting-saved" :class="{ 'is-error': handoff.save.state === 'failed', 'is-pending': handoffSaving }" :role="handoff.save.state === 'failed' ? 'alert' : 'status'">{{ handoff.save.message }}</p>
    <button type="button" class="alu-link-button assistant-handoff-auto" @click="actions.openAssistantStatus()">查看运行详情</button>
    <p v-if="actions.assistantStatusError" class="assistant-error" role="alert">{{ actions.assistantStatusError }}</p>
  </section>
</template>

<style scoped>
.assistant-setting { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--alu-border); border-radius: 12px; background: var(--alu-bg-raised); }
.assistant-setting h4 { margin: 0; color: var(--alu-text); font-size: var(--alu-control-size); font-weight: 650; }
.assistant-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.assistant-setting-text { max-width: 640px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.assistant-setting-row { display: flex; align-items: center; gap: 8px; max-width: 520px; }
.assistant-handoff-options { min-width: 0; }
.assistant-handoff-options > summary { padding: 5px 0; cursor: pointer; color: var(--alu-accent); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-handoff-dirty { margin-left: 8px; color: var(--alu-warning-text); font-size: var(--alu-micro-size); }
.assistant-handoff-form { display: grid; min-width: 0; gap: 10px; padding-top: 10px; }
.assistant-handoff-numbers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; max-width: 520px; }
.assistant-handoff-field { display: grid; min-width: 0; gap: 6px; font-size: var(--alu-meta-size); color: var(--alu-text-muted); }
.assistant-handoff-field input, .assistant-handoff-field textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid var(--alu-border-light); border-radius: 8px; background: var(--alu-bg); color: var(--alu-text); font: var(--alu-ui-size)/1.65 var(--font-reading); }
.assistant-handoff-field input:focus, .assistant-handoff-field textarea:focus { outline: none; box-shadow: var(--alu-focus-ring); }
.assistant-handoff-field textarea { min-height: 144px; resize: vertical; }
.assistant-handoff-auto, .assistant-handoff-save { justify-self: start; }
.assistant-setting-refresh { display: grid; width: 36px; height: 36px; flex: 0 0 auto; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.assistant-setting-refresh:hover:not(:disabled) { background: var(--alu-hover); color: var(--alu-text); }
.assistant-setting-saved { margin: 0; color: var(--alu-success-text); font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-setting-saved.is-error { color: var(--alu-danger); }
.assistant-setting-saved.is-pending { color: var(--alu-text-muted); }
.assistant-setting-facts { display: grid; gap: 6px; margin: 0; }
.assistant-setting-facts div { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; font-size: var(--alu-meta-size); line-height: 1.6; }
.assistant-setting-facts dt { color: var(--alu-text-muted); }
.assistant-setting-facts dd { margin: 0; color: var(--alu-text); }
.assistant-setting-facts dd.is-working { color: var(--alu-running); }
.assistant-setting-facts dd.is-off, .assistant-setting-facts dd.is-failed { color: var(--alu-warning-text); }
.assistant-setting .button { min-height: 32px; padding: 0 11px; font-size: var(--alu-meta-size); }
.assistant-restart { display: grid; gap: 8px; justify-items: start; }
.assistant-restart-confirm { display: grid; gap: 8px; max-width: 640px; padding: 12px; border: 1px solid var(--alu-border); border-left: 3px solid var(--alu-warning-line); border-radius: 10px; background: var(--alu-bg); }
.assistant-restart-confirm p { margin: 0; color: var(--alu-text); font-size: var(--alu-meta-size); line-height: 1.7; }
.assistant-restart-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 640px) {
  .assistant-setting { padding: 12px; }
  .assistant-setting-facts div { grid-template-columns: 72px minmax(0, 1fr); }
  .assistant-handoff-numbers { grid-template-columns: 1fr; gap: 10px; }
}
</style>
