<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Eye, EyeOff, ListChecks, Plus, Server, X } from '@lucide/vue'
import { getChildModels } from '../lib/bridge'
import { currentConnectionCall, requireConnectionContext } from '../lib/hostResult'
import { useModelListEditor } from '../lib/modelListEditor'
import { addModels, childModelColumns, modelRowMatches, modelVisibilityColumns, orderedListChanges, removeModels, type ModelListRow } from '../lib/modelLists'
import { useAppStore } from '../stores/app'
import { useSurfacesStore, type MachineSettingsSection } from '../stores/surfaces'
import { useModelCatalogStore } from '../stores/model-catalog'
import { useModelListsStore } from '../stores/model-lists'
import MachineSettingsResults from './MachineSettingsResults.vue'

// Both lists exist only on Main (card #303); every machine shares them, so no machine is chosen.
const emit = defineEmits<{ close: []; dirty: [dirty: boolean] }>()
const app = useAppStore()
const surfaces = useSurfacesStore()
const submissions = useModelListsStore()
const catalog = useModelCatalogStore()

const section = ref<MachineSettingsSection>(surfaces.machineSettingsSection)
const shownQuery = ref('')
const hiddenQuery = ref('')
const availableQuery = ref('')
const listedQuery = ref('')

const hidden = reactive(useModelListEditor({
  submission: () => submissions.forHidden(app.activeConnectionId ?? ''),
  // This page always reads the current settings; the shared catalog follows that read.
  read: () => currentConnectionCall(app, (context) => catalog.read(context, undefined, true)),
  listOf: (result) => result.hidden,
  confirmed: (result, list) => ({ ...result, hidden: list, fileProblem: undefined }),
  shown: () => surfaces.machineSettingsOpen && section.value === 'hidden',
  markSuccessSeen: submissions.markSuccessSeen,
  discardSubmission: submissions.discard,
  loadFailure: '暂时读不到 Main 上的模型。请稍后重试。',
}))
const children = reactive(useModelListEditor({
  submission: () => submissions.forChildren(app.activeConnectionId ?? ''),
  read: () => currentConnectionCall(app, getChildModels),
  listOf: (result) => result.listed,
  confirmed: (result, list) => ({ ...result, listed: list, fileProblem: undefined }),
  // The list keeps its order (dock_models shows it so), so reordering is a change to save.
  changes: orderedListChanges,
  shown: () => surfaces.machineSettingsOpen && section.value === 'children',
  markSuccessSeen: submissions.markSuccessSeen,
  discardSubmission: submissions.discard,
  loadFailure: '暂时读不到 Main 上的模型。请稍后重试。',
}))
const active = computed(() => section.value === 'hidden' ? hidden : children)

const columns = computed(() => modelVisibilityColumns(hidden.result?.models ?? [], hidden.draft))
const shownRows = computed(() => columns.value.shown.filter((row) => modelRowMatches(row, shownQuery.value)))
const hiddenRows = computed(() => columns.value.hidden.filter((row) => modelRowMatches(row, hiddenQuery.value)))
const childColumns = computed(() => childModelColumns(children.result?.models ?? [], children.draft))
const availableRows = computed(() => childColumns.value.available.filter((row) => modelRowMatches(row, availableQuery.value)))
const listedRows = computed(() => childColumns.value.listed.filter((row) => modelRowMatches(row, listedQuery.value)))
const childLimit = computed(() => children.result?.limit ?? 0)
const childListFull = computed(() => !!children.result && children.draft.length >= childLimit.value)

watch(() => hidden.dirty || children.dirty, (value) => emit('dirty', value), { immediate: true, flush: 'sync' })

watch([
  () => app.connectionContext?.connectionId,
  () => app.connectionContext?.selectionGeneration,
], () => { void hidden.load() }, { immediate: true })

// Main's child Work list is read the first time its section opens, and again after the connection changes.
let childrenReadFor = ''
watch([
  () => app.connectionContext?.connectionId,
  () => app.connectionContext?.selectionGeneration,
  section,
], ([connectionId, generation, current]) => {
  const reading = JSON.stringify([connectionId ?? null, generation ?? null])
  if (current !== 'children' || reading === childrenReadFor) return
  childrenReadFor = reading
  void children.load()
}, { immediate: true })

// A hidden model leaves the child Work choices too; the draft and its section stay as they are.
watch(() => submissions.hiddenSaved.get(app.activeConnectionId ?? ''), () => { void children.refreshChoices() })

function save() {
  if (!active.value.canSave) return
  const connection = requireConnectionContext(app)
  const hostName = app.activeHost?.displayName ?? '本机'
  if (section.value === 'children') void submissions.saveChildren(connection, `${hostName} · 子 Work 模型名单`, children.draft)
  else void submissions.saveHidden(connection, `${hostName} · 隐藏模型`, hidden.draft)
}

function hide(rows: readonly ModelListRow[]) { hidden.edit(addModels(hidden.draft, rows)) }
function show(rows: readonly ModelListRow[]) { hidden.edit(removeModels(hidden.draft, rows)) }
function addChild(row: ModelListRow) { children.edit(addModels(children.draft, [row])) }
function removeChild(row: ModelListRow) { children.edit(removeModels(children.draft, [row])) }
</script>

<template>
  <header class="machine-settings-header">
    <div class="machine-settings-heading">
      <span class="machine-settings-mark"><Server :size="20" /></span>
      <div>
        <h2 id="machine-settings-title">Host 设置</h2>
        <p>所有机器共用 Main 上的设置</p>
      </div>
    </div>
    <button class="machine-settings-close" data-modal-initial aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>

  <div class="machine-settings-layout">
    <nav class="machine-settings-nav" aria-label="设置分类">
      <span class="machine-settings-nav-label">Host</span>
      <button type="button" class="machine-settings-nav-item" :class="{ 'is-active': section === 'hidden' }" :aria-current="section === 'hidden' ? 'page' : undefined" @click="section = 'hidden'"><EyeOff :size="16" /><span>模型显示</span></button>
      <button type="button" class="machine-settings-nav-item" :class="{ 'is-active': section === 'children' }" :aria-current="section === 'children' ? 'page' : undefined" @click="section = 'children'"><ListChecks :size="16" /><span>子 Work 模型</span></button>
    </nav>

    <main v-if="section === 'hidden'" class="machine-settings-content">
      <div class="machine-settings-intro">
        <h3>模型显示</h3>
        <p>移到右边的模型不会出现在任何机器上任何 Work 的模型选择和搜索里，模型本身照常可用。所有机器共用 Main 上这一份。</p>
      </div>
      <MachineSettingsResults embedded :exclude-key="hidden.submission?.key" />

      <div v-if="hidden.loading" class="machine-settings-status" role="status">正在读取 Main 上的模型…</div>
      <div v-else-if="hidden.loadError" class="machine-settings-error" role="alert"><span>{{ hidden.loadError }}</span><button type="button" class="button secondary" @click="hidden.load">重试</button></div>
      <template v-else-if="hidden.result">
        <p v-if="hidden.result.fileProblem" class="machine-settings-note is-warning" role="status">隐藏列表文件有问题：{{ hidden.result.fileProblem }}。现在没有隐藏任何模型。点保存会用这里的列表覆盖那个文件，文件里原来的内容不会保留。</p>
        <p v-if="hidden.result.truncated" class="machine-settings-note">Main 的模型太多，这里只列出了 {{ hidden.result.models.length }}/{{ hidden.result.total }} 个。</p>
        <div class="model-columns">
          <section class="model-column" aria-label="显示中的模型">
            <header><strong>显示中</strong><span>{{ columns.shown.length }}</span></header>
            <input v-model="shownQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤显示中的模型" spellcheck="false" />
            <button v-if="shownQuery.trim() && shownRows.length" type="button" class="model-column-bulk" :disabled="hidden.saving" @click="hide(shownRows)">隐藏筛选出的 {{ shownRows.length }} 个</button>
            <div class="model-list">
              <button v-for="row in shownRows" :key="row.key" type="button" class="model-row" :title="`隐藏 ${row.provider}/${row.id}`" :disabled="hidden.saving" @click="hide([row])">
                <span class="model-row-copy"><strong>{{ row.name }}</strong><small>{{ row.provider }}/{{ row.id }}</small></span>
                <EyeOff :size="15" aria-hidden="true" />
              </button>
              <p v-if="!shownRows.length" class="model-list-empty">{{ columns.shown.length ? '没有匹配的模型' : '所有模型都已隐藏' }}</p>
            </div>
          </section>
          <section class="model-column is-chosen" aria-label="已隐藏的模型">
            <header><strong>已隐藏</strong><span>{{ columns.hidden.length }}</span></header>
            <input v-model="hiddenQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤已隐藏的模型" spellcheck="false" />
            <button v-if="hiddenQuery.trim() && hiddenRows.length" type="button" class="model-column-bulk" :disabled="hidden.saving" @click="show(hiddenRows)">恢复显示筛选出的 {{ hiddenRows.length }} 个</button>
            <div class="model-list">
              <button v-for="row in hiddenRows" :key="row.key" type="button" class="model-row" :title="`恢复显示 ${row.provider}/${row.id}`" :disabled="hidden.saving" @click="show([row])">
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

    <main v-else class="machine-settings-content">
      <div class="machine-settings-intro">
        <h3>子 Work 模型</h3>
        <p>你让 Agent 给子 Work 换模型时，它在这份名单里找准确的模型名。名单不限制子 Work 能用哪个模型。所有机器共用 Main 上这一份，最多 {{ childLimit }} 个。</p>
      </div>
      <MachineSettingsResults embedded :exclude-key="children.submission?.key" />

      <div v-if="children.loading" class="machine-settings-status" role="status">正在读取 Main 上的模型…</div>
      <div v-else-if="children.loadError" class="machine-settings-error" role="alert"><span>{{ children.loadError }}</span><button type="button" class="button secondary" @click="children.load">重试</button></div>
      <template v-else-if="children.result">
        <p v-if="children.result.fileProblem" class="machine-settings-note is-warning" role="status">名单文件有问题：{{ children.result.fileProblem }}。现在 Agent 看不到名单。点保存会用这里的名单覆盖那个文件，文件里原来的内容不会保留。</p>
        <p v-if="children.result.truncated" class="machine-settings-note">Main 的模型太多，这里只列出了 {{ children.result.models.length }}/{{ children.result.total }} 个。</p>
        <div class="model-columns">
          <section class="model-column" aria-label="可以加入的模型">
            <header><strong>可以加入</strong><span>{{ childColumns.available.length }}</span></header>
            <input v-model="availableQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤可以加入的模型" spellcheck="false" />
            <p v-if="childListFull" class="model-column-note">名单已满 {{ childLimit }} 个，先从右边移出一些。</p>
            <div class="model-list">
              <button v-for="row in availableRows" :key="row.key" type="button" class="model-row" :title="`加入名单 ${row.provider}/${row.id}`" :disabled="children.saving || childListFull" @click="addChild(row)">
                <span class="model-row-copy"><strong>{{ row.name }}</strong><small>{{ row.provider }}/{{ row.id }}</small></span>
                <Plus :size="15" aria-hidden="true" />
              </button>
              <p v-if="!availableRows.length" class="model-list-empty">{{ childColumns.available.length ? '没有匹配的模型' : 'Main 上的模型都已在名单里' }}</p>
            </div>
          </section>
          <section class="model-column is-chosen" aria-label="子 Work 模型名单">
            <header><strong>名单</strong><span>{{ childColumns.listed.length }}/{{ childLimit }}</span></header>
            <input v-model="listedQuery" class="ui-dialog-input ui-dialog-search" placeholder="按名称过滤…" aria-label="过滤名单里的模型" spellcheck="false" />
            <div class="model-list">
              <button v-for="row in listedRows" :key="row.key" type="button" class="model-row" :title="`移出名单 ${row.provider}/${row.id}`" :disabled="children.saving" @click="removeChild(row)">
                <span class="model-row-copy"><strong>{{ row.name }}</strong><small>{{ row.provider }}/{{ row.id }}</small></span>
                <span v-if="row.unavailable" class="model-row-badge">已隐藏或不可用</span>
                <X :size="15" aria-hidden="true" />
              </button>
              <p v-if="!listedRows.length" class="model-list-empty">{{ childColumns.listed.length ? '没有匹配的模型' : '点左边的模型把它加进来' }}</p>
            </div>
          </section>
        </div>
      </template>
    </main>
  </div>

  <footer class="machine-settings-footer">
    <span class="machine-settings-footer-status" :class="{ 'machine-settings-error': active.submission?.state === 'failed' && !active.dirty }" :role="active.submission?.state === 'failed' && !active.dirty ? 'alert' : 'status'">{{ active.status }}</span>
    <button type="button" class="button secondary" :disabled="active.saving || (!active.changes && active.submission?.state !== 'failed' && active.submission?.state !== 'unknown')" @click="active.discard">放弃改动</button>
    <button type="button" class="button primary" :disabled="!active.canSave" @click="save">{{ active.saving ? '正在保存…' : '保存' }}</button>
  </footer>
</template>

<style scoped>
.machine-settings-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--alu-border); background: var(--alu-surface); }
.machine-settings-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.machine-settings-mark { display: grid; width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--alu-brand-border); border-radius: 10px; background: var(--alu-brand-bg); color: var(--alu-brand); place-items: center; }
.machine-settings-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; }
.machine-settings-heading p { margin: 3px 0 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.machine-settings-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); place-items: center; }
.machine-settings-close:hover { border-color: var(--alu-border); background: var(--alu-hover); color: var(--alu-text); }
.machine-settings-layout { display: grid; min-height: 0; grid-template-columns: 170px minmax(0, 1fr); }
.machine-settings-nav { display: flex; flex-direction: column; gap: 6px; padding: 20px 12px; border-right: 1px solid var(--alu-border); background: var(--alu-bg); }
.machine-settings-nav-label { display: block; padding: 0 9px 10px; color: var(--alu-text-faint); font-size: var(--alu-micro-size); font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.machine-settings-nav-item { display: flex; width: 100%; min-height: 42px; align-items: center; gap: 9px; padding: 0 10px; cursor: pointer; border: 1px solid transparent; border-radius: 9px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); text-align: left; }
.machine-settings-nav-item:hover:not(.is-active) { background: var(--alu-hover); color: var(--alu-text); }
.machine-settings-nav-item.is-active { border-color: var(--alu-highlight-border); background: var(--alu-highlight-bg); color: var(--alu-highlight); }
.machine-settings-content { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: 14px; padding: 22px 24px; overflow: hidden; }
.machine-settings-intro h3 { margin: 0 0 6px; color: var(--alu-text); font-size: 18px; font-weight: 650; }
.machine-settings-intro p { max-width: 620px; margin: 0; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.machine-settings-status { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.machine-settings-note { margin: 0; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; color: var(--alu-text-dim); font-size: var(--alu-meta-size); line-height: 1.6; }
.machine-settings-note.is-warning { border-color: rgb(var(--alu-warning-rgb) / .35); color: var(--alu-warning); }
.machine-settings-error { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; padding: 9px 10px; border: 1px solid var(--alu-danger-border); border-radius: 8px; background: var(--alu-danger-bg); color: var(--alu-danger); font-size: var(--alu-meta-size); }
.model-columns { display: grid; min-height: 0; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.model-column { display: flex; min-height: 0; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); }
.model-column.is-chosen { border-color: var(--alu-highlight-border); }
.model-column-note { margin: 0; color: var(--alu-warning); font-size: var(--alu-micro-size); }
.model-column > header { display: flex; align-items: baseline; justify-content: space-between; color: var(--alu-text); font-size: var(--alu-ui-size); }
.model-column > header span { color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.model-column-bulk { align-self: flex-start; padding: 4px 8px; cursor: pointer; border: 1px solid var(--alu-border-light); border-radius: 7px; color: var(--alu-accent); font-size: var(--alu-micro-size); }
.model-column-bulk:hover { background: var(--alu-hover); }
.model-list { display: grid; min-height: 0; flex: 1 1 auto; align-content: start; gap: 4px; overflow-y: auto; }
.model-row { display: flex; min-width: 0; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; cursor: pointer; border: 1px solid transparent; border-radius: 8px; color: var(--alu-text-muted); text-align: left; }
.model-row:disabled, .model-column-bulk:disabled { cursor: wait; opacity: .6; }
.model-row:hover:not(:disabled) { border-color: var(--alu-border-light); background: var(--alu-hover); color: var(--alu-text); }
.model-row-copy { display: grid; min-width: 0; flex: 1 1 auto; gap: 2px; }
.model-row-copy strong { overflow: hidden; color: var(--alu-text); font-size: var(--alu-ui-size); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.model-row-copy small { overflow: hidden; color: var(--alu-text-muted); font-size: var(--alu-micro-size); text-overflow: ellipsis; white-space: nowrap; }
.model-row-badge { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; background: rgb(var(--alu-warning-rgb) / .12); color: var(--alu-warning); font-size: var(--alu-micro-size); }
.model-list-empty { margin: 8px 4px; color: var(--alu-text-faint); font-size: var(--alu-meta-size); }
.machine-settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--alu-border); background: var(--alu-bg-raised); }
.machine-settings-footer > .machine-settings-error, .machine-settings-footer-status { flex: 1 1 auto; min-width: 0; }
.machine-settings-footer-status { color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
@media (max-width: 640px) {
  .machine-settings-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .machine-settings-nav { flex-direction: row; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--alu-border); }
  .machine-settings-nav-label { display: none; }
  .machine-settings-nav-item { width: auto; min-height: 36px; }
  .machine-settings-content { padding: 16px 14px; overflow-y: auto; }
  .model-columns { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 1fr) minmax(220px, 1fr); }
  .machine-settings-footer { flex-wrap: wrap; padding: 10px 14px; }
}
</style>
