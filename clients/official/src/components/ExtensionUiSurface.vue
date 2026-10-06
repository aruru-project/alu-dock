<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { AlertTriangle, ChevronRight } from '@lucide/vue'
import {
  acquireExtensionControl,
  isTauri,
  releaseExtensionControl,
  reportExtensionViewport,
  respondExtensionInteraction,
} from '../lib/bridge'
import type { ExtensionControllerEmission, ExtensionControllerStatus, InteractionResponse, Work } from '../lib/types'
import { genericExtensionStatus } from '../lib/dockTools'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { requireConnectionContext } from '../lib/hostResult'
import { useExtensionUiStore, type ExtensionWidget } from '../stores/extension-ui'
import { useAppStore } from '../stores/app'

const props = defineProps<{ work: Work | null; focusSuspended?: boolean }>()
const emit = defineEmits<{ editorText: [text: string]; title: [title: string] }>()
const extension = useExtensionUiStore()
const app = useAppStore()
const root = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const acquiringError = ref('')
const responseError = ref('')
const phase = ref<'idle' | 'submitting'>('idle')
const answer = ref('')
const search = ref('')
const confirmation = ref<boolean | null>(null)
const now = ref(Date.now())
const widgetOpen = ref<Record<string, boolean>>({})
const unlisteners: UnlistenFn[] = []
let resizeObserver: ResizeObserver | null = null
let viewportTimer = 0
let countdownTimer = 0
let mounted = false
let acquisitionRevision = 0
let acquisitionInFlight = false
let attemptedAutomaticControlKey = ''
const pendingControllerEmissions = new Map<string, ExtensionControllerEmission[]>()

const request = computed(() => extension.activeRequest)
const automaticControlKey = computed(() => {
  const work = props.work
  if (!isTauri || !work || work.lifecycle !== 'active' || !work.ownerHostEpoch || !extension.isCurrent(work) || !extension.subscriptionId) return ''
  return `${extension.connectionId}:${extension.selectionGeneration}:${work.id}:${work.ownerHostEpoch}:${work.runtimeGeneration}:${extension.subscriptionId}`
})
const filteredOptions = computed(() => {
  if (request.value?.method !== 'select') return []
  const needle = search.value.trim().toLocaleLowerCase()
  return needle ? request.value.options.filter((option) => option.toLocaleLowerCase().includes(needle)) : request.value.options
})
const secondsRemaining = computed(() => {
  const expires = request.value?.expiresAt
  if (!expires) return null
  return Math.max(0, Math.ceil((Date.parse(expires) - now.value) / 1000))
})
const locked = computed(() => phase.value !== 'idle')
const visibleStatus = computed(() => genericExtensionStatus(extension.status))

// The typed answer belongs to its question. When the question goes away with the
// connection and the Host sends the same one again, the answer is still there.
let answerFor = ''
watch(() => request.value?.interactionId, async (id) => {
  if (!id) return
  if (id !== answerFor) {
    answerFor = id
    phase.value = 'idle'
    responseError.value = ''
    search.value = ''
    confirmation.value = null
    answer.value = request.value?.method === 'editor' ? request.value.prefill ?? '' : ''
  }
  await nextTick()
  if (request.value?.interactionId === id && !props.focusSuspended) focusDialog()
})
function focusDialog() { dialog.value?.querySelector<HTMLElement>('input, textarea, button')?.focus() }
watch(() => props.focusSuspended, async (suspended) => {
  if (suspended || !request.value) return
  const id = request.value.interactionId
  await nextTick()
  if (!props.focusSuspended && request.value?.interactionId === id) focusDialog()
})
watch(() => extension.controller?.handle, () => scheduleViewport())
watch(automaticControlKey, (key, previous) => {
  if (key !== previous) {
    acquisitionRevision++
    acquiringError.value = ''
    attemptedAutomaticControlKey = ''
  }
  tryAutomaticAcquire(key)
})
watch(() => extension.controllerState, () => tryAutomaticAcquire(automaticControlKey.value))
watch(() => extension.hasAttention, (hasAttention) => {
  if (!hasAttention) {
    acquiringError.value = ''
    return
  }
  if (!extension.controller) void acquire()
})

onMounted(async () => {
  if (isTauri) {
    unlisteners.push(
      await listen<ExtensionControllerEmission>('aludock://extension-controller-event', ({ payload }) => {
        if (!app.contextMatches(payload)) return
        if (!applyEmission(payload)
          && extension.controllerState === 'acquiring'
          && payload.instanceId === props.work?.id
          && payload.hostEpoch === props.work.ownerHostEpoch
          && payload.runtimeGeneration === props.work.runtimeGeneration) {
          pendingControllerEmissions.set(payload.handle, [...(pendingControllerEmissions.get(payload.handle) ?? []), payload])
        }
      }),
      await listen<ExtensionControllerStatus>('aludock://extension-controller-status', ({ payload }) => {
        if (!app.contextMatches(payload) || !extension.controllerEnded(payload.handle, 'disconnected')) return
        extension.hideControllerRequest()
        acquiringError.value = ''
      }),
    )
  }
  mounted = true
  tryAutomaticAcquire(automaticControlKey.value)
  resizeObserver = new ResizeObserver(scheduleViewport)
  const viewport = viewportElements()
  if (viewport) resizeObserver.observe(viewport.surface)
  countdownTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  mounted = false
  acquisitionRevision++
  const handle = extension.controller?.handle
  if (handle) void extension.releaseController(handle, 'detached')
  pendingControllerEmissions.clear()
  unlisteners.forEach((unlisten) => unlisten())
  resizeObserver?.disconnect()
  window.clearTimeout(viewportTimer)
  window.clearInterval(countdownTimer)
})

function tryAutomaticAcquire(key: string) {
  if (!key) {
    attemptedAutomaticControlKey = ''
    return
  }
  if (!mounted || acquisitionInFlight || key === attemptedAutomaticControlKey || extension.controller || extension.controllerState === 'acquiring') return
  attemptedAutomaticControlKey = key
  void acquire()
}

async function acquire() {
  const work = props.work
  const targetKey = automaticControlKey.value
  if (!isTauri || !targetKey || !work || work.lifecycle !== 'active' || !work.ownerHostEpoch || acquisitionInFlight || extension.controllerState === 'acquiring') return
  const revision = ++acquisitionRevision
  const target = {
    key: targetKey,
    instanceId: work.id,
    hostEpoch: work.ownerHostEpoch,
    runtimeGeneration: work.runtimeGeneration,
  }
  acquisitionInFlight = true
  attemptedAutomaticControlKey = targetKey
  const storeRevision = extension.beginAcquire()
  acquiringError.value = ''
  let stale = false
  try {
    const binding = await acquireExtensionControl(target.instanceId, target.hostEpoch, target.runtimeGeneration, requireConnectionContext(app))
    stale = revision !== acquisitionRevision
      || automaticControlKey.value !== target.key
      || !app.contextMatches(binding)
      || !props.work
      || props.work.id !== binding.instanceId
      || props.work.ownerHostEpoch !== binding.hostEpoch
      || props.work.runtimeGeneration !== binding.runtimeGeneration
    if (stale || !extension.attachController(binding, storeRevision)) {
      await releaseExtensionControl(binding.handle, binding)
      pendingControllerEmissions.delete(binding.handle)
      stale = true
      return
    }
    acquiringError.value = ''
    for (const emission of pendingControllerEmissions.get(binding.handle) ?? []) applyEmission(emission)
    pendingControllerEmissions.clear()
    await nextTick()
    scheduleViewport()
  } catch {
    stale = stale || revision !== acquisitionRevision || automaticControlKey.value !== target.key
    if (!stale && extension.failAcquire(storeRevision, 'disconnected')) {
      acquiringError.value = extension.hasAttention
        ? '暂时无法打开这项操作。它仍在等待处理，请重试打开。'
        : ''
    }
  } finally {
    acquisitionInFlight = false
    if (stale) extension.failAcquire(storeRevision, 'detached')
    tryAutomaticAcquire(automaticControlKey.value)
  }
}

function responseForRequest(): InteractionResponse | null {
  const current = request.value
  if (!current) return null
  if (current.method === 'confirm') return { method: 'confirm', confirmed: confirmation.value ?? false }
  return { method: current.method, value: answer.value }
}

async function respond(cancelled = false) {
  const current = request.value
  const handle = extension.controller?.handle
  const response = responseForRequest()
  if (!current || !handle || !response || locked.value) return
  // Reacquiring the same question changes its handle/object, not its interactionId.
  // While no question is shown, the reply still belongs to the answer kept for it.
  const isCurrent = () => (request.value?.interactionId ?? answerFor) === current.interactionId
  phase.value = 'submitting'
  responseError.value = ''
  try {
    const capturedHost = requireConnectionContext(app)
    await respondExtensionInteraction(handle, current.interactionId, response, cancelled, capturedHost)
    if (!app.contextMatches(capturedHost) || !isCurrent()) return
    extension.resolveLocally(current.interactionId)
    resetResponse()
  } catch (cause) {
    if (!isCurrent()) return
    // If a lost answer did arrive, the Agent closes this question and the dialog goes away.
    phase.value = 'idle'
    responseError.value = errorMessage(cause)
  }
}

/** Escape while an input method is composing only dismisses the candidates. */
function cancelByEscape(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  event.stopPropagation()
  void respond(true)
}

function applyEmission(payload: ExtensionControllerEmission): boolean {
  const directive = extension.applyControllerEvent(payload)
  if (directive === null) return false
  if (directive.editorText !== undefined) emit('editorText', directive.editorText)
  if (directive.title !== undefined) emit('title', directive.title)
  return true
}

function resetResponse() {
  phase.value = 'idle'
  responseError.value = ''
  answer.value = ''
  search.value = ''
  confirmation.value = null
}

function widgetIsOpen(widget: ExtensionWidget) {
  return widgetOpen.value[widget.key] ?? window.innerWidth >= 720
}
function rememberWidgetOpen(widget: ExtensionWidget, event: Event) {
  widgetOpen.value = { ...widgetOpen.value, [widget.key]: (event.currentTarget as HTMLDetailsElement).open }
}

function viewportElements() {
  const surface = root.value?.querySelector<HTMLElement>('.alu-input-wrap')
  const editor = surface?.querySelector<HTMLTextAreaElement>('textarea')
  return surface && editor ? { surface, editor } : null
}
function scheduleViewport() {
  window.clearTimeout(viewportTimer)
  viewportTimer = window.setTimeout(() => void sendViewport(), 180)
}
async function sendViewport() {
  const handle = extension.controller?.handle
  const viewport = viewportElements()
  if (!handle || !viewport || viewport.surface.clientWidth <= 0 || viewport.editor.clientHeight <= 0) return
  const { surface, editor } = viewport
  const style = getComputedStyle(editor)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return
  context.font = style.font
  const cellWidth = context.measureText('0').width
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (cellWidth <= 0 || !Number.isFinite(lineHeight) || lineHeight <= 0) return
  const width = Math.max(1, Math.min(10_000, Math.floor(surface.clientWidth / cellWidth)))
  const height = Math.max(1, Math.min(10_000, Math.floor(editor.clientHeight / lineHeight)))
  try { await reportExtensionViewport(handle, width, height, requireConnectionContext(app)) } catch { /* next resize/reacquire reports current truth */ }
}

function interactionMethodLabel(method: string) {
  return ({ select: '选择', confirm: '确认', input: '输入', editor: '编辑' } as Record<string, string>)[method] ?? '处理'
}
</script>

<template>
  <div ref="root" class="extension-ui-surface">
    <div v-if="extension.hasAttention && !extension.controller" class="extension-attention" role="status">
      <AlertTriangle :size="17" />
      <span>{{ acquiringError || (extension.controllerState === 'acquiring' ? '正在打开这项操作…' : '这个 Work 正在等待你的操作。') }}</span>
      <button :disabled="!isTauri || extension.controllerState === 'acquiring'" @click="acquire">{{ extension.controllerState === 'acquiring' ? '正在打开…' : acquiringError ? '重试打开' : '查看并处理' }}</button>
    </div>

    <div class="extension-widgets above">
      <details v-for="widget in extension.aboveWidgets" :key="widget.key" :open="widgetIsOpen(widget)" @toggle="rememberWidgetOpen(widget, $event)">
        <summary>{{ widget.key }}<ChevronRight :size="14" /></summary>
        <pre>{{ widget.lines.join('\n') }}</pre>
      </details>
    </div>

    <div v-if="Object.keys(visibleStatus).length" class="alu-extension-status" aria-label="Extension 状态">
      <span v-for="(text, key) in visibleStatus" :key="key">{{ key }}: {{ text }}</span>
    </div>

    <slot />

    <div class="extension-widgets below">
      <details v-for="widget in extension.belowWidgets" :key="widget.key" :open="widgetIsOpen(widget)" @toggle="rememberWidgetOpen(widget, $event)">
        <summary>{{ widget.key }}<ChevronRight :size="14" /></summary>
        <pre>{{ widget.lines.join('\n') }}</pre>
      </details>
    </div>

    <Teleport to="body">
      <div v-if="request" v-show="!focusSuspended" class="extension-dialog-layer" role="presentation">
        <section ref="dialog" class="extension-dialog" role="dialog" aria-modal="true" :aria-labelledby="`extension-dialog-${request.interactionId}`" @keydown.esc="cancelByEscape">
          <header><div><small>互动 · {{ interactionMethodLabel(request.method) }}</small><h2 :id="`extension-dialog-${request.interactionId}`">{{ request.title }}</h2></div><span v-if="secondsRemaining !== null">{{ secondsRemaining }}s</span></header>

          <template v-if="request.method === 'select'">
            <input v-model="search" type="search" placeholder="搜索全部选项" :disabled="locked" />
            <div class="extension-options" role="listbox" :aria-label="request.title">
              <button v-for="option in filteredOptions" :key="option" :class="{ selected: answer === option }" :disabled="locked" @click="answer = option">{{ option }}</button>
              <span v-if="!filteredOptions.length">没有匹配项</span>
            </div>
          </template>
          <p v-else-if="request.method === 'confirm'" class="extension-message">{{ request.message }}</p>
          <input v-else-if="request.method === 'input'" v-model="answer" :placeholder="request.placeholder || '输入回答'" :disabled="locked" maxlength="256000" />
          <textarea v-else v-model="answer" :disabled="locked" maxlength="256000" rows="9" />

          <div v-if="responseError" class="extension-dialog-error">{{ responseError }}</div>
          <footer>
            <button :disabled="locked" @click="respond(true)">取消</button>
            <template v-if="request.method === 'confirm'">
              <button :disabled="locked" @click="confirmation = false; respond(false)">否</button>
              <button class="primary" :disabled="locked" @click="confirmation = true; respond(false)">确认</button>
            </template>
            <button v-else class="primary" :disabled="locked || (request.method === 'select' && !answer)" @click="respond(false)">{{ phase === 'submitting' ? '正在提交…' : '提交' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@media (max-width: 1000px) {
  .alu-input-section .extension-ui-surface {
    width: min(100%, 760px);
    margin-inline: auto;
  }
}
/* Above the input card, never on the screen's bottom edge. */
.alu-extension-status {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 6px 4px 0;
  color: var(--alu-amber-dim);
  font-size: var(--alu-meta-size);
}
.alu-extension-status[hidden] { display: none; }
.alu-extension-status span { white-space: nowrap; }
.extension-ui-surface { width: 100%; min-width: 0; }
.alu-input-section .extension-ui-surface { min-width: 0; }
.extension-ui-surface { display: contents; }
.extension-attention { display: flex; min-height: 36px; align-items: center; gap: 8px; padding: 7px 10px; color: #f6cf79; font-size: var(--alu-meta-size); background: rgb(251 191 36 / .06); border: 1px solid rgb(251 191 36 / .22); border-radius: 8px; }
.extension-attention span { flex: 1; }
.extension-attention button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; color: var(--c-ice); cursor: pointer; background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 6px; }
.extension-widgets { display: grid; gap: 8px; }
.extension-widgets details { overflow: hidden; background: rgb(14 32 45 / .48); border: 1px solid rgb(126 200 224 / .17); border-radius: 10px; }
.extension-widgets summary { display: flex; min-height: 42px; align-items: center; justify-content: space-between; padding: 8px 12px; color: var(--c-ice); font-size: var(--alu-ui-size); cursor: pointer; list-style: none; }
.extension-widgets summary::-webkit-details-marker { display: none; }
.extension-widgets summary svg { transition: transform 160ms; }
.extension-widgets details[open] summary svg { transform: rotate(90deg); }
.extension-widgets pre { max-height: 42dvh; margin: 0; padding: 10px 12px 13px; overflow: auto; color: var(--c-text-1); font: var(--alu-ui-size)/1.65 ui-monospace, monospace; overflow-wrap: anywhere; white-space: pre-wrap; border-top: 1px solid rgb(126 200 224 / .1); }
.extension-dialog-layer { position: fixed; z-index: 80; inset: 0; display: grid; padding: 18px; background: rgb(3 6 13 / .7); backdrop-filter: blur(8px); place-items: center; }
.extension-dialog { display: grid; width: min(620px, 100%); max-height: min(82dvh, 760px); gap: 13px; padding: 18px; overflow: hidden; background: var(--c-space-925); border: 1px solid var(--c-line); border-radius: 15px; box-shadow: var(--shadow-panel); }
.extension-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.extension-dialog header small { color: var(--c-sakura); font-size: var(--alu-micro-size); letter-spacing: .14em; }
.extension-dialog h2 { margin: 4px 0 0; font: 600 17px/1.4 var(--font-reading); overflow-wrap: anywhere; }
.extension-dialog header > span { color: var(--c-amber); font-size: var(--alu-meta-size); }
.extension-dialog input, .extension-dialog textarea { width: 100%; padding: 10px 11px; color: var(--c-text-1); background: var(--c-space-950); border: 1px solid var(--c-line); border-radius: 8px; resize: vertical; }
.extension-dialog input:focus, .extension-dialog textarea:focus { outline: none; box-shadow: var(--focus-ring); }
.extension-options { display: grid; min-height: 70px; max-height: min(48dvh, 440px); gap: 5px; overflow-y: auto; }
.extension-options button { min-height: 42px; padding: 8px 10px; color: var(--c-text-1); text-align: left; overflow-wrap: anywhere; cursor: pointer; background: var(--c-space-850); border: 1px solid var(--c-line-soft); border-radius: 7px; }
.extension-options button.selected { color: var(--c-ice); border-color: var(--c-ice); background: var(--c-ice-soft); }
.extension-options > span { padding: 20px; color: var(--c-text-3); text-align: center; }
.extension-message { max-height: 40dvh; margin: 0; overflow-y: auto; color: var(--c-text-1); font: 14px/1.65 var(--font-reading); overflow-wrap: anywhere; white-space: pre-wrap; }
.extension-dialog-error { padding: 8px; color: #f8a0a0; font: var(--alu-meta-size)/1.5 var(--font-reading); background: rgb(248 113 113 / .06); border-radius: 7px; }
.extension-dialog footer { display: flex; justify-content: flex-end; gap: 7px; }
.extension-dialog footer button { display: inline-flex; min-height: 40px; align-items: center; gap: 5px; padding: 0 13px; color: var(--c-text-2); cursor: pointer; background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 8px; }
.extension-dialog footer button.primary { color: #190d16; font-weight: 700; background: var(--c-sakura); border-color: var(--c-sakura); }
@media (max-width: 640px) {
  .extension-dialog-layer { padding: 0; place-items: end stretch; }
  .extension-dialog { width: 100%; max-height: 88dvh; padding: 15px; border-width: 1px 0 0; border-radius: 16px 16px 0 0; }
  .extension-dialog footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .extension-dialog footer button { justify-content: center; }
}
</style>
