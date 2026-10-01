<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Eye, EyeOff, Server, X } from '@lucide/vue'
import { getModelVisibility, setModelVisibility } from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { defaultMachineHostId, machineDisplayLabel, machineSelectorVisible } from '../lib/machines'
import { hideModels, modelRowMatches, modelVisibilityChanges, modelVisibilityColumns, showModels, type ModelVisibilityRow } from '../lib/modelVisibility'
import type { MachineDto, ModelRef, ModelVisibilityResult } from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from '../stores/app'
import { useSurfacesStore } from '../stores/surfaces'
import AluSelect from './AluSelect.vue'

const props = defineProps<{
  machines: readonly MachineDto[]
  machinesLoading: boolean
  machineError?: string
  /** Opened from a Work: start on that Work's machine. */
  initialHostId?: string
}>()
const emit = defineEmits<{ close: []; dirty: [dirty: boolean]; busy: [busy: boolean] }>()
const app = useAppStore()
const surfaces = useSurfacesStore()

/** Empty when the Dock has no machine list: the connected Host itself. */
const hostId = ref('')
const result = ref<ModelVisibilityResult | null>(null)
const saved = ref<ModelRef[]>([])
const draft = ref<ModelRef[]>([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const notice = ref('')
const shownQuery = ref('')
const hiddenQuery = ref('')
let loadEpoch = 0

const machine = computed(() => props.machines.find((candidate) => candidate.hostId === hostId.value))
const showMachineSelector = computed(() => machineSelectorVisible(props.machines))
const machineOptions = computed(() => props.machines.map((candidate) => ({
  value: candidate.hostId,
  label: machineDisplayLabel(candidate),
  description: candidate.available ? undefined : '暂时连不上',
  disabled: !candidate.available,
})))
const columns = computed(() => modelVisibilityColumns(result.value?.models ?? [], draft.value))
const shownRows = computed(() => columns.value.shown.filter((row) => modelRowMatches(row, shownQuery.value)))
const hiddenRows = computed(() => columns.value.hidden.filter((row) => modelRowMatches(row, hiddenQuery.value)))
const changes = computed(() => modelVisibilityChanges(saved.value, draft.value))
const canSave = computed(() => !!result.value && !saving.value && (changes.value > 0 || !!result.value.fileProblem))
const status = computed(() => notice.value || (changes.value ? `已改动 ${changes.value} 项，尚未保存` : ''))

watch(changes, (value) => emit('dirty', value > 0), { immediate: true })
// A save already sent will change the Host either way; closing waits for its answer.
watch(saving, (value) => emit('busy', value), { immediate: true })
onUnmounted(() => { loadEpoch++ })

watch(() => props.machines, (machines) => {
  // Without a machine list, stay on the machine the page was opened for rather than
  // quietly editing the connected Host instead.
  if (!machines.length) { hostId.value = props.initialHostId ?? ''; return }
  if (machines.some((candidate) => candidate.hostId === hostId.value && candidate.available)) return
  const preferred = machines.find((candidate) => candidate.hostId === props.initialHostId && candidate.available)
  hostId.value = preferred?.hostId ?? defaultMachineHostId(machines)
}, { immediate: true })

watch([
  () => app.connectionContext?.connectionId,
  () => app.connectionContext?.selectionGeneration,
  hostId,
  () => props.machinesLoading,
], () => { if (!props.machinesLoading) void load() }, { immediate: true })

async function load() {
  const epoch = ++loadEpoch
  const target = hostId.value || undefined
  loading.value = true
  saving.value = false
  loadError.value = ''
  saveError.value = ''
  notice.value = ''
  result.value = null
  saved.value = []
  draft.value = []
  try {
    const value = await currentConnectionCall(app, (context) => getModelVisibility(context, target))
    if (epoch !== loadEpoch) return
    result.value = value
    saved.value = value.hidden
    draft.value = [...value.hidden]
  } catch (cause) {
    if (epoch === loadEpoch) loadError.value = userErrorMessage(cause, '暂时读不到这台机器上的模型。请稍后重试。')
  } finally {
    if (epoch === loadEpoch) loading.value = false
  }
}

async function chooseMachine(value: string) {
  if (value === hostId.value) return
  if (changes.value && !await surfaces.askConfirm('切换机器？', '这台机器的改动还没有保存，切换后会丢失。')) return
  hostId.value = value
}

async function save() {
  if (!canSave.value) return
  const epoch = loadEpoch
  const target = hostId.value || undefined
  const hidden = draft.value.map((model) => ({ provider: model.provider, id: model.id }))
  saving.value = true
  saveError.value = ''
  notice.value = ''
  try {
    const value = await currentConnectionCall(app, (context) => setModelVisibility(hidden, context, target))
    if (epoch !== loadEpoch) return
    saved.value = value.hidden
    draft.value = [...value.hidden]
    if (result.value) result.value = { ...result.value, hidden: value.hidden, fileProblem: undefined }
    notice.value = '已保存。下次打开模型选择时生效。'
  } catch (cause) {
    if (epoch !== loadEpoch) return
    const unknown = !!cause && typeof cause === 'object' && (('code' in cause && cause.code === 'effect_unknown') || ('outcomeUnknown' in cause && cause.outcomeUnknown === true))
    saveError.value = unknown
      ? '还无法确认是否已经保存。再点一次保存不会出问题；也可以关闭后重新打开，查看这台机器现在的设置。'
      : userErrorMessage(cause, '隐藏列表没有保存成功，原来的设置不变。请稍后重试。')
  } finally {
    if (epoch === loadEpoch) saving.value = false
  }
}

function edit(next: ModelRef[]) {
  draft.value = next
  notice.value = ''
  saveError.value = ''
}
function hide(rows: readonly ModelVisibilityRow[]) { edit(hideModels(draft.value, rows)) }
function show(rows: readonly ModelVisibilityRow[]) { edit(showModels(draft.value, rows)) }
function discard() { edit([...saved.value]) }
</script>

<template>
  <header class="machine-settings-header">
    <div class="machine-settings-heading">
      <span class="machine-settings-mark"><Server :size="20" /></span>
      <div>
        <h2 id="machine-settings-title">Host 设置</h2>
        <p>{{ machine ? machineDisplayLabel(machine) : hostId ? '当前 Work 所在的机器' : '当前连接的 AluDock' }}</p>
      </div>
    </div>
    <button class="machine-settings-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="machine-settings-layout">
    <aside class="machine-settings-nav" aria-label="设置分类">
      <span class="machine-settings-nav-label">Host</span>
      <div class="machine-settings-nav-item is-active"><EyeOff :size="16" /><span>模型显示</span></div>
    </aside>

    <main class="machine-settings-content">
      <div class="machine-settings-intro">
        <h3>模型显示</h3>
        <p>移到右边的模型不会出现在这台机器上任何 Work 的模型选择和搜索里，模型本身照常可用。每台机器分别设置。</p>
      </div>

      <label v-if="showMachineSelector" class="machine-settings-machine">
        <span>机器</span>
        <AluSelect :value="hostId" :options="machineOptions" label="选择机器" :disabled="saving || loading || machinesLoading" @select="chooseMachine" />
      </label>
      <p v-if="machineError" class="machine-settings-note is-warning" role="status">{{ machineError }}</p>

      <div v-if="machinesLoading || loading" class="machine-settings-status" role="status">正在读取这台机器上的模型…</div>
      <div v-else-if="loadError" class="machine-settings-error" role="alert"><span>{{ loadError }}</span><button type="button" class="button secondary" @click="load">重试</button></div>
      <template v-else-if="result">
        <p v-if="result.fileProblem" class="machine-settings-note is-warning" role="status">隐藏列表文件有问题：{{ result.fileProblem }}。现在这台机器没有隐藏任何模型。点保存会用这里的列表覆盖那个文件，文件里原来的内容不会保留。</p>
        <p v-if="result.truncated" class="machine-settings-note">这台机器的模型太多，这里只列出了 {{ result.models.length }}/{{ result.total }} 个。</p>
        <div class="model-columns">
          <section class="model-column" aria-label="显示中的模型">
            <header><strong>显示中</strong><span>{{ columns.shown.length }}</span></header>
            <input v-model="shownQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤显示中的模型" spellcheck="false" />
            <button v-if="shownQuery.trim() && shownRows.length" type="button" class="model-column-bulk" :disabled="saving" @click="hide(shownRows)">隐藏筛选出的 {{ shownRows.length }} 个</button>
            <div class="model-list">
              <button v-for="row in shownRows" :key="row.key" type="button" class="model-row" :title="`隐藏 ${row.provider}/${row.id}`" :disabled="saving" @click="hide([row])">
                <span class="model-row-copy"><strong>{{ row.name }}</strong><small>{{ row.provider }}/{{ row.id }}</small></span>
                <EyeOff :size="15" aria-hidden="true" />
              </button>
              <p v-if="!shownRows.length" class="model-list-empty">{{ columns.shown.length ? '没有匹配的模型' : '所有模型都已隐藏' }}</p>
            </div>
          </section>
          <section class="model-column is-hidden" aria-label="已隐藏的模型">
            <header><strong>已隐藏</strong><span>{{ columns.hidden.length }}</span></header>
            <input v-model="hiddenQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤已隐藏的模型" spellcheck="false" />
            <button v-if="hiddenQuery.trim() && hiddenRows.length" type="button" class="model-column-bulk" :disabled="saving" @click="show(hiddenRows)">恢复显示筛选出的 {{ hiddenRows.length }} 个</button>
            <div class="model-list">
              <button v-for="row in hiddenRows" :key="row.key" type="button" class="model-row" :title="`恢复显示 ${row.provider}/${row.id}`" :disabled="saving" @click="show([row])">
                <span class="model-row-copy"><strong>{{ row.name }}</strong><small>{{ row.provider }}/{{ row.id }}</small></span>
                <span v-if="row.unavailable" class="model-row-badge">当前不可用</span>
                <Eye :size="15" aria-hidden="true" />
              </button>
              <p v-if="!hiddenRows.length" class="model-list-empty">{{ columns.hidden.length ? '没有匹配的模型' : '点左边的模型把它移到这里' }}</p>
            </div>
          </section>
        </div>
      </template>
    </main>
  </div>

  <footer class="machine-settings-footer">
    <p v-if="saveError" class="machine-settings-error" role="alert">{{ saveError }}</p>
    <span v-else class="machine-settings-footer-status" role="status">{{ status }}</span>
    <button type="button" class="button secondary" :disabled="!changes || saving" @click="discard">放弃改动</button>
    <button type="button" class="button primary" :disabled="!canSave" @click="save">{{ saving ? '正在保存…' : '保存' }}</button>
  </footer>
</template>

<style scoped>
.machine-settings-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--alu-border); background: #101725; }
.machine-settings-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.machine-settings-mark { display: grid; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-pink-border); border-radius: 10px; background: var(--alu-pink-bg); color: var(--alu-pink); place-items: center; }
.machine-settings-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; }
.machine-settings-heading p { margin: 3px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.machine-settings-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.machine-settings-close:hover { border-color: var(--alu-border); background: var(--alu-hover); color: var(--alu-text); }
.machine-settings-layout { display: grid; min-height: 0; grid-template-columns: 170px minmax(0, 1fr); }
.machine-settings-nav { padding: 20px 12px; border-right: 1px solid var(--alu-border); background: #080d17; }
.machine-settings-nav-label { display: block; padding: 0 9px 10px; color: var(--alu-text-faint); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.machine-settings-nav-item { display: flex; min-height: 42px; align-items: center; gap: 9px; padding: 0 10px; border: 1px solid var(--alu-pink-border); border-radius: 9px; background: var(--alu-pink-bg); color: var(--alu-pink); font-size: var(--alu-meta-size); }
.machine-settings-content { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: 14px; padding: 22px 24px; overflow: hidden; }
.machine-settings-intro h3 { margin: 0 0 6px; color: var(--alu-text); font-size: 18px; font-weight: 650; }
.machine-settings-intro p { max-width: 620px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.machine-settings-machine { display: grid; max-width: 360px; gap: 6px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.machine-settings-status { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.machine-settings-note { margin: 0; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); line-height: 1.6; }
.machine-settings-note.is-warning { border-color: rgb(251 191 36 / .35); color: var(--alu-amber); }
.machine-settings-error { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; padding: 9px 10px; border: 1px solid var(--alu-rose-border); border-radius: 8px; background: var(--alu-rose-bg); color: var(--alu-rose); font-size: var(--alu-meta-size); }
.model-columns { display: grid; min-height: 0; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.model-column { display: flex; min-height: 0; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); }
.model-column.is-hidden { border-color: var(--alu-pink-border); }
.model-column > header { display: flex; align-items: baseline; justify-content: space-between; color: var(--alu-text); font-size: var(--alu-ui-size); }
.model-column > header span { color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.model-column-bulk { align-self: flex-start; padding: 4px 8px; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 7px; color: var(--alu-blue); font-size: var(--alu-micro-size); }
.model-column-bulk:hover { background: var(--alu-hover); }
.model-list { display: grid; min-height: 0; flex: 1 1 auto; align-content: start; gap: 4px; overflow-y: auto; }
.model-row { display: flex; min-width: 0; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); text-align: left; }
.model-row:disabled, .model-column-bulk:disabled { cursor: wait; opacity: .6; }
.model-row:hover:not(:disabled) { border-color: var(--alu-border-light); background: var(--alu-hover); color: var(--alu-text); }
.model-row-copy { display: grid; min-width: 0; flex: 1 1 auto; gap: 2px; }
.model-row-copy strong { overflow: hidden; color: var(--alu-text); font-size: var(--alu-ui-size); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.model-row-copy small { overflow: hidden; color: var(--alu-text-muted); font-size: var(--alu-micro-size); text-overflow: ellipsis; white-space: nowrap; }
.model-row-badge { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; background: rgb(251 191 36 / .12); color: var(--alu-amber); font-size: var(--alu-micro-size); }
.model-list-empty { margin: 8px 4px; color: var(--alu-text-faint); font-size: var(--alu-meta-size); }
.machine-settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--alu-border); background: #0d1322; }
.machine-settings-footer > .machine-settings-error, .machine-settings-footer-status { flex: 1 1 auto; min-width: 0; }
.machine-settings-footer-status { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
@media (max-width: 640px) {
  .machine-settings-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .machine-settings-nav { display: none; }
  .machine-settings-content { padding: 16px 14px; overflow-y: auto; }
  .model-columns { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 1fr) minmax(220px, 1fr); }
  .machine-settings-footer { flex-wrap: wrap; padding: 10px 14px; }
}
</style>
