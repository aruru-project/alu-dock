<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { AlertTriangle, ChevronRight, RefreshCw } from '@lucide/vue'
import {
  acquireExtensionControl,
  isTauri,
  releaseExtensionControl,
  reportExtensionViewport,
  respondExtensionInteraction,
} from '../lib/bridge'
import type { ExtensionControllerEmission, ExtensionControllerStatus, InteractionResponse, Work } from '../lib/types'
import { userErrorMessage as errorMessage } from '../lib/userError'
import { requireHostContext } from '../lib/hostResult'
import { useExtensionUiStore, type ExtensionWidget } from '../stores/extension-ui'
import { useAppStore } from '../stores/app'

const props = defineProps<{ work: Work | null; reconcileInteraction: () => Promise<boolean> }>()
const emit = defineEmits<{ editorText: [text: string]; title: [title: string] }>()
const extension = useExtensionUiStore()
const app = useAppStore()
const root = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const acquiringError = ref('')
const responseError = ref('')
const phase = ref<'idle' | 'submitting' | 'unknown' | 'reconciling'>('idle')
const answer = ref('')
const search = ref('')
const confirmation = ref<boolean | null>(null)
const now = ref(Date.now())
const widgetOpen = ref<Record<string, boolean>>({})
const unlisteners: UnlistenFn[] = []
let resizeObserver: ResizeObserver | null = null
let viewportTimer = 0
let countdownTimer = 0
let unknownInteractionId = ''
const pendingControllerEmissions = new Map<string, ExtensionControllerEmission[]>()

const request = computed(() => extension.activeRequest)
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

watch(() => request.value?.interactionId, async (id) => {
  if (!id) {
    if (unknownInteractionId) {
      extension.clearInteractionUnknown(unknownInteractionId)
      unknownInteractionId = ''
    }
    resetResponse()
    return
  }
  if (unknownInteractionId === id) return
  phase.value = 'idle'
  responseError.value = ''
  search.value = ''
  confirmation.value = null
  answer.value = request.value?.method === 'editor' ? request.value.prefill ?? '' : ''
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('input, textarea, button')?.focus()
})
watch(() => extension.controller?.handle, () => scheduleViewport())

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
        if (!unknownInteractionId) extension.hideControllerRequest()
        acquiringError.value = payload.message ?? '操作连接已结束。'
      }),
    )
  }
  resizeObserver = new ResizeObserver(scheduleViewport)
  if (root.value) resizeObserver.observe(root.value)
  countdownTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  const handle = extension.controller?.handle
  if (handle) void extension.releaseController(handle, 'detached')
  pendingControllerEmissions.clear()
  unlisteners.forEach((unlisten) => unlisten())
  resizeObserver?.disconnect()
  window.clearTimeout(viewportTimer)
  window.clearInterval(countdownTimer)
})

async function acquire() {
  const work = props.work
  if (!isTauri || !work || work.lifecycle !== 'active' || !work.ownerHostEpoch || extension.controllerState === 'acquiring') return
  extension.beginAcquire()
  acquiringError.value = ''
  try {
    const binding = await acquireExtensionControl(work.id, work.ownerHostEpoch, work.runtimeGeneration, requireHostContext(app))
    if (!app.contextMatches(binding) || !props.work || props.work.id !== binding.instanceId || props.work.ownerHostEpoch !== binding.hostEpoch || props.work.runtimeGeneration !== binding.runtimeGeneration) {
      await releaseExtensionControl(binding.handle, binding)
      pendingControllerEmissions.delete(binding.handle)
      extension.failAcquire('detached')
      return
    }
    if (!extension.attachController(binding)) {
      await releaseExtensionControl(binding.handle, binding)
      pendingControllerEmissions.delete(binding.handle)
      extension.failAcquire('detached')
      return
    }
    for (const emission of pendingControllerEmissions.get(binding.handle) ?? []) applyEmission(emission)
    pendingControllerEmissions.clear()
    await nextTick()
    scheduleViewport()
  } catch (cause) {
    extension.failAcquire('disconnected')
    acquiringError.value = errorMessage(cause)
  }
}

async function release() {
  const handle = extension.controller?.handle
  if (!handle) return
  acquiringError.value = ''
  if (!await extension.releaseController(handle, 'detached')) {
    acquiringError.value = '暂时无法退出操作面板，请重试。'
    return
  }
  if (!unknownInteractionId) {
    extension.hideControllerRequest()
    resetResponse()
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
  phase.value = 'submitting'
  responseError.value = ''
  try {
    const capturedHost = requireHostContext(app)
    await respondExtensionInteraction(handle, current.interactionId, response, cancelled, capturedHost)
    if (!app.contextMatches(capturedHost)) return
    extension.resolveLocally(current.interactionId)
    resetResponse()
  } catch (cause) {
    if (isUnknown(cause)) {
      phase.value = 'unknown'
      unknownInteractionId = current.interactionId
      extension.markInteractionUnknown(current.interactionId)
      responseError.value = '还无法确认这次回答是否送达。请刷新确认，不要重复提交。'
    } else {
      phase.value = 'idle'
      responseError.value = errorMessage(cause)
    }
  }
}

async function reconcile() {
  const handle = extension.controller?.handle
  const interactionId = unknownInteractionId
  if (!interactionId || phase.value !== 'unknown') return
  phase.value = 'reconciling'
  responseError.value = '正在确认这次回答的结果…'
  const refreshed = await props.reconcileInteraction()
  if (!refreshed) {
    phase.value = 'unknown'
    responseError.value = '暂时无法确认这次回答的结果。请刷新确认，不要重复提交。'
    return
  }
  if (extension.activeSummary?.id !== interactionId) {
    extension.clearInteractionUnknown(interactionId)
    unknownInteractionId = ''
    resetResponse()
    return
  }
  responseError.value = '这项操作仍在等待，正在重新连接…'
  if (handle && !await extension.releaseController(handle, 'detached')) {
    phase.value = 'unknown'
    return
  }
  await acquire()
  if (unknownInteractionId) {
    phase.value = 'unknown'
    responseError.value = '还没有重新收到这项操作。请稍后再次刷新确认，不要重复提交。'
  }
}

function applyEmission(payload: ExtensionControllerEmission): boolean {
  const directive = extension.applyControllerEvent(payload)
  if (directive === null) return false
  if (directive.editorText !== undefined) emit('editorText', directive.editorText)
  if (directive.title !== undefined) emit('title', directive.title)
  if (payload.event.eventType === 'interaction.requested'
    && unknownInteractionId
    && payload.event.data.interactionId === unknownInteractionId
    && extension.activeRequest?.interactionId === unknownInteractionId) {
    extension.clearInteractionUnknown(unknownInteractionId)
    unknownInteractionId = ''
    resetResponse()
  }
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

function scheduleViewport() {
  window.clearTimeout(viewportTimer)
  viewportTimer = window.setTimeout(() => void sendViewport(), 180)
}
async function sendViewport() {
  const handle = extension.controller?.handle
  const surface = root.value
  if (!handle || !surface) return
  const style = getComputedStyle(surface)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return
  context.font = style.font
  const cellWidth = Math.max(1, context.measureText('0').width)
  const editor = surface.querySelector<HTMLTextAreaElement>('.composer textarea')
  const lineHeight = editor ? Number.parseFloat(getComputedStyle(editor).lineHeight) || 18 : 18
  const width = Math.max(1, Math.min(10_000, Math.floor(surface.clientWidth / cellWidth)))
  const height = Math.max(1, Math.min(10_000, Math.floor((editor?.clientHeight ?? lineHeight) / lineHeight)))
  try { await reportExtensionViewport(handle, width, height, requireHostContext(app)) } catch { /* next resize/reacquire reports current truth */ }
}

function isUnknown(cause: unknown) { return !!cause && typeof cause === 'object' && 'outcomeUnknown' in cause && cause.outcomeUnknown === true }
</script>

<template>
  <div ref="root" class="extension-ui-surface">
    <div v-if="extension.hasAttention && !extension.controller" class="extension-attention" role="status">
      <AlertTriangle :size="17" />
      <span>这个 Work 正在等待你的操作。</span>
      <button :disabled="!isTauri || extension.controllerState === 'acquiring'" @click="acquire">{{ extension.controllerState === 'acquiring' ? '正在打开…' : '查看并处理' }}</button>
    </div>
    <div v-else-if="extension.controller" class="extension-control-strip">
      <span>操作面板已打开</span>
      <button @click="release">退出</button>
    </div>
    <div v-if="acquiringError" class="extension-inline-error">{{ acquiringError }} <button @click="acquire">重试</button></div>

    <div class="extension-widgets above">
      <details v-for="widget in extension.aboveWidgets" :key="widget.key" :open="widgetIsOpen(widget)" @toggle="rememberWidgetOpen(widget, $event)">
        <summary>{{ widget.key }}<ChevronRight :size="14" /></summary>
        <pre>{{ widget.lines.join('\n') }}</pre>
      </details>
    </div>

    <slot />

    <div v-if="Object.keys(extension.status).length" class="alu-extension-status" aria-label="Extension 状态">
      <span v-for="(text, key) in extension.status" :key="key">{{ key }}: {{ text }}</span>
    </div>

    <div class="extension-widgets below">
      <details v-for="widget in extension.belowWidgets" :key="widget.key" :open="widgetIsOpen(widget)" @toggle="rememberWidgetOpen(widget, $event)">
        <summary>{{ widget.key }}<ChevronRight :size="14" /></summary>
        <pre>{{ widget.lines.join('\n') }}</pre>
      </details>
    </div>

    <Teleport to="body">
      <div v-if="request" class="extension-dialog-layer" role="presentation">
        <section ref="dialog" class="extension-dialog" role="dialog" aria-modal="true" :aria-labelledby="`extension-dialog-${request.interactionId}`" @keydown.esc.prevent="respond(true)">
          <header><div><small>EXTENSION · {{ request.method.toUpperCase() }}</small><h2 :id="`extension-dialog-${request.interactionId}`">{{ request.title }}</h2></div><span v-if="secondsRemaining !== null">{{ secondsRemaining }}s</span></header>

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
            <button v-if="phase === 'unknown'" class="primary" @click="reconcile"><RefreshCw :size="14" />刷新确认</button>
            <template v-else-if="request.method === 'confirm'">
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
