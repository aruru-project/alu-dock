<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RotateCcw, ZoomIn, ZoomOut } from '@lucide/vue'

const props = defineProps<{ url: string; name: string }>()
const emit = defineEmits<{ failed: [] }>()

const stage = ref<HTMLElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const pointers = new Map<number, { x: number; y: number }>()
const pointerStarts = new Map<number, { x: number; y: number; time: number; moved: boolean }>()
let panStart: { pointerX: number; pointerY: number; x: number; y: number } | null = null
let pinchStart: { distance: number; scale: number; worldX: number; worldY: number } | null = null
let pinchUsed = false
let lastTap: { x: number; y: number; time: number } | null = null

const zoomLabel = computed(() => `${Math.round(scale.value * 100)}%`)
const transformStyle = computed(() => ({
  transform: `translate3d(${translateX.value}px, ${translateY.value}px, 0) scale(${scale.value})`,
}))

function point(event: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect()
  return rect
    ? { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
    : { x: 0, y: 0 }
}

function fittedImageSize() {
  const surface = stage.value
  const element = image.value
  if (!surface || !element?.naturalWidth || !element.naturalHeight) return { width: 0, height: 0 }
  const ratio = Math.min(surface.clientWidth / element.naturalWidth, surface.clientHeight / element.naturalHeight)
  return { width: element.naturalWidth * ratio, height: element.naturalHeight * ratio }
}

function clampTranslation(nextScale: number, x: number, y: number) {
  const surface = stage.value
  const fitted = fittedImageSize()
  if (!surface || !fitted.width || !fitted.height) return { x: 0, y: 0 }
  const limitX = Math.max(0, (fitted.width * nextScale - surface.clientWidth) / 2)
  const limitY = Math.max(0, (fitted.height * nextScale - surface.clientHeight) / 2)
  return {
    x: Math.max(-limitX, Math.min(limitX, x)),
    y: Math.max(-limitY, Math.min(limitY, y)),
  }
}

function setTransform(nextScale: number, x: number, y: number) {
  const boundedScale = Math.max(1, Math.min(5, nextScale))
  const bounded = clampTranslation(boundedScale, x, y)
  scale.value = boundedScale
  translateX.value = bounded.x
  translateY.value = bounded.y
}

function zoomAt(nextScale: number, x: number, y: number) {
  const worldX = (x - translateX.value) / scale.value
  const worldY = (y - translateY.value) / scale.value
  setTransform(nextScale, x - worldX * nextScale, y - worldY * nextScale)
}

function resetZoom() {
  setTransform(1, 0, 0)
}

function zoomBy(delta: number) {
  zoomAt(scale.value + delta, 0, 0)
}

function beginPanFromRemainingPointer() {
  const remaining = pointers.values().next().value as { x: number; y: number } | undefined
  panStart = remaining
    ? { pointerX: remaining.x, pointerY: remaining.y, x: translateX.value, y: translateY.value }
    : null
}

function beginPinch() {
  const [first, second] = [...pointers.values()]
  if (!first || !second) return
  const x = (first.x + second.x) / 2
  const y = (first.y + second.y) / 2
  pinchStart = {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    scale: scale.value,
    worldX: (x - translateX.value) / scale.value,
    worldY: (y - translateY.value) / scale.value,
  }
  pinchUsed = true
  panStart = null
}

function handlePointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const next = point(event)
  pointers.set(event.pointerId, next)
  pointerStarts.set(event.pointerId, { ...next, time: performance.now(), moved: false })
  stage.value?.setPointerCapture(event.pointerId)
  if (pointers.size === 2) beginPinch()
  else if (pointers.size === 1) beginPanFromRemainingPointer()
}

function handlePointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const next = point(event)
  pointers.set(event.pointerId, next)
  const start = pointerStarts.get(event.pointerId)
  if (start && Math.hypot(next.x - start.x, next.y - start.y) > 8) start.moved = true
  if (pointers.size >= 2 && pinchStart) {
    const [first, second] = [...pointers.values()]
    if (!first || !second) return
    const x = (first.x + second.x) / 2
    const y = (first.y + second.y) / 2
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
    const nextScale = pinchStart.scale * distance / pinchStart.distance
    setTransform(nextScale, x - pinchStart.worldX * nextScale, y - pinchStart.worldY * nextScale)
  } else if (pointers.size === 1 && panStart && scale.value > 1) {
    setTransform(scale.value, panStart.x + next.x - panStart.pointerX, panStart.y + next.y - panStart.pointerY)
  }
}

function handleDoubleTap(tap: { x: number; y: number; time: number }) {
  const previous = lastTap
  lastTap = tap
  if (!previous || tap.time - previous.time > 320 || Math.hypot(tap.x - previous.x, tap.y - previous.y) > 28) return
  lastTap = null
  if (scale.value > 1.05) resetZoom()
  else zoomAt(2.5, tap.x, tap.y)
}

function finishPointer(event: PointerEvent) {
  const start = pointerStarts.get(event.pointerId)
  const released = pointers.get(event.pointerId)
  pointers.delete(event.pointerId)
  pointerStarts.delete(event.pointerId)
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  const wasPinch = pinchUsed
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 1) beginPanFromRemainingPointer()
  else if (pointers.size === 0) {
    panStart = null
    pinchUsed = false
    if (!wasPinch && start && released && !start.moved && performance.now() - start.time < 350) {
      handleDoubleTap({ ...released, time: performance.now() })
    }
  }
}

function handleResize() {
  setTransform(scale.value, translateX.value, translateY.value)
}

watch(() => props.url, resetZoom)
window.addEventListener('resize', handleResize)
onBeforeUnmount(() => window.removeEventListener('resize', handleResize))
</script>

<template>
  <div
    ref="stage"
    class="alu-image-zoom-stage"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="finishPointer"
    @pointercancel="finishPointer"
  >
    <img ref="image" class="alu-image-zoom-image" :src="url" :alt="name" :style="transformStyle" draggable="false" @load="resetZoom" @error="emit('failed')" />
    <div class="alu-image-zoom-controls" aria-label="图片缩放" @pointerdown.stop @pointermove.stop @pointerup.stop>
      <button type="button" aria-label="缩小图片" :disabled="scale <= 1" @click.stop="zoomBy(-.5)"><ZoomOut :size="17" /></button>
      <span aria-live="polite">{{ zoomLabel }}</span>
      <button type="button" aria-label="放大图片" :disabled="scale >= 5" @click.stop="zoomBy(.5)"><ZoomIn :size="17" /></button>
      <button type="button" aria-label="还原图片大小" :disabled="scale === 1" @click.stop="resetZoom"><RotateCcw :size="16" /></button>
    </div>
  </div>
</template>
