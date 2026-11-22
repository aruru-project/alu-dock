<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, Check, RotateCw } from '@lucide/vue'
import { setWorkSystem, systemCatalog } from '../lib/bridge'
import { requireConnectionContext } from '../lib/hostResult'
import { errorCode, userErrorMessage } from '../lib/userError'
import type { SystemCandidate, SystemCatalogCursor, Work } from '../lib/types'
import { useAppStore } from '../stores/app'
import { useControlPanelStore } from '../stores/control-panel'
import ResourceDocument from './ResourceDocument.vue'

const props = defineProps<{ work: Work; currentSystem?: string; fromStatus: boolean }>()
const emit = defineEmits<{ leave: [] }>()
const app = useAppStore()
const panel = useControlPanelStore()
const candidates = ref<SystemCandidate[]>([])
const draft = ref<string | null>() // undefined follows the current choice until the user selects one.
const source = computed(() => panel.resources?.systemSource)
const current = computed(() => {
  if (source.value?.explicit !== true) return null
  const loaded = source.value
  if (loaded.kind === 'project-system' && loaded.otherDirectory) return undefined
  return candidates.value.find(c => c.kind === loaded.kind && (loaded.kind !== 'dock-template' || c.name === loaded.name))?.id
})
const selected = computed(() => draft.value === undefined ? current.value : draft.value)
const reading = ref<SystemCandidate | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const readFailed = ref(false)
const failedDocument = ref<SystemCandidate | null>(null)
const busy = computed(() => props.work.execution === 'running' || props.work.compacting || props.work.pending.total > 0)
const canSave = computed(() => !busy.value && !saving.value && !loading.value && !readFailed.value && !panel.loading.has('system')
  && selected.value !== current.value && (selected.value === null || candidates.value.some(c => c.id === selected.value && !c.warning)))
const autoDescription = '按项目 .pi/SYSTEM.md、全局 SYSTEM.md、Pi 内置默认顺序自动选用'
function label(c: SystemCandidate) {
  return c.kind === 'dock-template' ? `Dock 模板 · ${c.name}` : c.kind === 'global-system' ? '全局 SYSTEM.md' : '项目 .pi/SYSTEM.md'
}
function problem(cause: unknown) {
  return errorCode(cause) === 'capability_missing' ? '这台机器的 Dock 还不支持切换当前 Work 的 system。请更新这台机器的 Dock。' : userErrorMessage(cause)
}
let readVersion = 0
let targetVersion = 0
watch([() => app.connectionContext?.connectionId, () => app.connectionContext?.selectionGeneration, () => props.work.id, () => props.work.ownerHostEpoch, () => props.work.cwd], () => {
  targetVersion++
  draft.value = undefined; reading.value = null; saving.value = false
  void load()
}, { immediate: true, flush: 'sync' })
onUnmounted(() => { readVersion++; targetVersion++ })
async function load() {
  const version = ++readVersion
  const { cwd, hostId } = props.work
  loading.value = true; error.value = ''; readFailed.value = false; failedDocument.value = null
  try {
    const context = requireConnectionContext(app)
    const items: SystemCandidate[] = []
    let cursor: SystemCatalogCursor | undefined
    do {
      const page = await systemCatalog(cwd, context, hostId ?? '', cursor)
      if (version !== readVersion) return
      items.push(...page.candidates); cursor = page.nextCursor
    } while (cursor)
    candidates.value = items
  } catch (cause) {
    if (version === readVersion) { readFailed.value = true; error.value = problem(cause) }
  } finally { if (version === readVersion) loading.value = false }
}
async function save() {
  const id = selected.value
  if (!canSave.value || id === undefined) return
  const version = targetVersion, generation = props.work.runtimeGeneration
  saving.value = true; error.value = ''; failedDocument.value = null
  try {
    const target = app.captureOperationTarget(requireConnectionContext(app), props.work.id)
    const result = await setWorkSystem(target, id)
    if (version !== targetVersion || (props.work.runtimeGeneration !== generation && props.work.runtimeGeneration !== result.instance.runtimeGeneration)) return
    const { instance: _, ...resources } = result
    panel.resources = resources
    emit('leave')
  } catch (cause) {
    if (version === targetVersion) { reading.value = null; error.value = problem(cause); app.failureShown(cause) }
  } finally { if (version === targetVersion) saving.value = false }
}
const readButtons = ref<HTMLButtonElement[]>([])
async function closeDocument() {
  const id = reading.value?.id
  reading.value = null
  await nextTick()
  readButtons.value.find(button => button.getAttribute('id') === `read-system-${id}`)?.focus()
}
function readDocument(candidate: SystemCandidate) { failedDocument.value = null; error.value = ''; reading.value = candidate }
function documentFailed(cause: unknown) { failedDocument.value = reading.value; reading.value = null; error.value = problem(cause) }
function reread() { void panel.loadSection('system', true); void load() }
</script>

<template>
  <ResourceDocument v-if="reading" :work="work" :system="{ cwd: work.cwd, hostId: work.hostId ?? '', candidate: reading }" @back="closeDocument" @failed="documentFailed" />
  <section v-else class="system-picker" aria-label="可用 system">
    <div class="system-list">
      <button v-if="fromStatus" type="button" class="back" @click="emit('leave')"><ArrowLeft :size="14" />返回项目状态</button>
      <p v-if="busy" class="notice" role="status">当前正在回复或有排队消息，等这一轮结束或先中止后即可切换。</p>
      <div v-if="error" class="alu-dialog-error" role="alert">{{ error }} <button v-if="readFailed || failedDocument" type="button" class="ui-dialog-btn" @click="failedDocument ? readDocument(failedDocument) : load()">重试</button></div>
      <p v-if="loading" class="notice" role="status">正在读取可用 system…</p>
      <button type="button" class="choice" :aria-pressed="selected === null" @click="draft = null">
        <span class="marker"><Check v-if="selected === null" :size="14" /></span>
        <span class="copy"><strong>不指定（由 Pi 决定） <small v-if="current === null">CURRENT</small></strong><span>{{ autoDescription }}{{ current === null && currentSystem ? ` · 当前实际载入：${currentSystem}` : '' }}</span></span>
      </button>
      <div v-for="c in candidates" :key="c.id" class="file-row">
        <button type="button" class="choice" :disabled="!!c.warning" :aria-pressed="selected === c.id" @click="draft = c.id">
          <span class="marker"><Check v-if="selected === c.id" :size="14" /></span>
          <span class="copy"><strong>{{ label(c) }} <small v-if="current === c.id">CURRENT</small></strong><span>{{ c.path }}</span><span v-if="c.warning" class="warning">{{ c.warning }} 请修复后重新读取。</span></span>
        </button>
        <button ref="readButtons" :id="`read-system-${c.id}`" type="button" class="ui-dialog-btn read" :aria-label="`阅读 ${label(c)}`" @click="readDocument(c)">阅读</button>
      </div>
    </div>
    <footer><button type="button" class="ui-dialog-btn refresh" :disabled="loading || saving" @click="reread"><RotateCw :size="13" />重新读取</button>
      <button type="button" class="ui-dialog-btn" @click="emit('leave')">取消</button>
      <button type="button" class="ui-dialog-btn ui-dialog-btn-primary" :disabled="!canSave" @click="save">{{ saving ? '正在重新加载…' : '确认并重新加载' }}</button>
    </footer>
  </section>
</template>

<style scoped>
.system-picker { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.system-list { display: grid; flex: 1 1 auto; align-content: start; gap: 7px; padding: 14px 16px; overflow-y: auto; min-width: 0; }
.back { justify-self: start; display: inline-flex; align-items: center; gap: 6px; padding: 4px 0 8px; color: var(--alu-text-muted); background: transparent; border: 0; }
.notice { margin: 0 0 4px; font-size: 12px; line-height: 1.5; color: var(--alu-text-muted); }
.file-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.choice { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 12px; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-bg); color: var(--alu-text); text-align: left; }
.choice:disabled { opacity: 0.55; cursor: not-allowed; }
.choice:hover:not(:disabled), .back:hover { background: var(--alu-hover); }
.choice[aria-pressed="true"] { border-color: var(--alu-highlight-border); background: rgb(var(--alu-highlight-rgb) / .08); }
.marker { display: grid; place-items: center; flex: 0 0 16px; height: 16px; border: 1px solid var(--alu-border); border-radius: 50%; }
.choice[aria-pressed="true"] .marker { color: var(--alu-highlight); border-color: var(--alu-highlight); }
.copy { min-width: 0; display: grid; gap: 5px; overflow-wrap: anywhere; }
.copy strong { color: var(--alu-text); font-size: 13px; }
.copy small { color: var(--alu-highlight); font-size: 9px; letter-spacing: .06em; }
.copy span { font-size: 11px; line-height: 1.45; color: var(--alu-text-muted); }
.copy .warning { color: var(--alu-danger); }
.read, footer button { white-space: nowrap; }
footer { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--alu-border); }
.refresh { display: inline-flex; gap: 5px; align-items: center; margin-right: auto; }
@media (max-width: 480px) { .system-list { padding: 10px; } .choice { padding: 10px 8px; gap: 7px; } footer { padding: 10px; gap: 5px; } footer button { padding-inline: 8px; } }
</style>
