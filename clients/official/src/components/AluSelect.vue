<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue'
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'

interface AluSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

const props = defineProps<{
  value: string
  options: AluSelectOption[]
  label: string
  placeholder?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ select: [value: string] }>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const menuId = `alu-select-${useId()}`
const selected = computed(() => props.options.find((option) => option.value === props.value))
const displayLabel = computed(() => selected.value?.label || props.placeholder || '请选择')

watch(open, async (isOpen) => {
  if (!isOpen) return
  activeIndex.value = selectableIndex(props.options.findIndex((option) => option.value === props.value), 1)
  await nextTick()
  optionButtons()[activeIndex.value]?.focus()
})

function optionButtons() {
  return menu.value ? Array.from(menu.value.querySelectorAll<HTMLButtonElement>('[data-alu-select-option]')) : []
}

function selectableIndex(start: number, direction: 1 | -1) {
  if (!props.options.length) return -1
  const initial = start >= 0 ? start : direction === 1 ? 0 : props.options.length - 1
  for (let offset = 0; offset < props.options.length; offset += 1) {
    const index = (initial + offset * direction + props.options.length) % props.options.length
    if (!props.options[index]?.disabled) return index
  }
  return -1
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function choose(option: AluSelectOption) {
  if (option.disabled) return
  emit('select', option.value)
  close(true)
}

function move(delta: 1 | -1) {
  if (activeIndex.value < 0) return
  const next = selectableIndex((activeIndex.value + delta + props.options.length) % props.options.length, delta)
  if (next < 0) return
  activeIndex.value = next
  optionButtons()[next]?.focus()
}

function handleTriggerKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  if (!open.value) open.value = true
}

function handleOptionKeydown(event: KeyboardEvent, index: number) {
  activeIndex.value = index
  if (event.key === 'ArrowDown') {
    event.preventDefault(); move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault(); move(-1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    const next = selectableIndex(0, 1)
    if (next >= 0) { activeIndex.value = next; optionButtons()[next]?.focus() }
  } else if (event.key === 'End') {
    event.preventDefault()
    const next = selectableIndex(props.options.length - 1, -1)
    if (next >= 0) { activeIndex.value = next; optionButtons()[next]?.focus() }
  } else if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); close(true)
  } else if (event.key === 'Tab') {
    close()
  }
}

function handleDocumentPointer(event: PointerEvent) {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) close()
}
document.addEventListener('pointerdown', handleDocumentPointer)
onUnmounted(() => document.removeEventListener('pointerdown', handleDocumentPointer))
</script>

<template>
  <div ref="root" class="alu-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
    <button
      ref="trigger"
      type="button"
      class="alu-select-trigger"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? menuId : undefined"
      @click="toggle"
      @keydown="handleTriggerKeydown"
    >
      <span>{{ displayLabel }}</span>
      <ChevronDown :size="15" aria-hidden="true" />
    </button>
    <div v-if="open" :id="menuId" ref="menu" class="alu-select-menu" role="listbox" :aria-label="label">
      <button
        v-for="(option, index) in options"
        :key="`${option.value}:${index}`"
        type="button"
        data-alu-select-option
        class="alu-select-option"
        :class="{ 'is-selected': option.value === value }"
        :disabled="option.disabled"
        role="option"
        :aria-selected="option.value === value"
        @click="choose(option)"
        @keydown="handleOptionKeydown($event, index)"
      >
        <span class="alu-select-check"><Check v-if="option.value === value" :size="13" /></span>
        <span class="alu-select-copy"><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.alu-select { position: relative; min-width: 0; flex: 1 1 auto; }
.alu-select.is-open { z-index: 50; }
.alu-select-trigger {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 11px;
  border: 1px solid var(--alu-border-light);
  border-radius: 8px;
  color: var(--alu-text);
  background: var(--alu-surface);
  font: inherit;
  text-align: left;
}
.alu-select-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alu-select-trigger svg { flex: 0 0 auto; color: var(--alu-text-muted); transition: transform 140ms ease; }
.is-open .alu-select-trigger { border-color: var(--alu-blue); box-shadow: 0 0 0 2px var(--alu-blue-bg); }
.is-open .alu-select-trigger svg { transform: rotate(180deg); }
.is-disabled .alu-select-trigger { color: var(--alu-text-faint); opacity: 0.72; }
.alu-select-menu {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  right: 0;
  left: 0;
  max-height: min(260px, 42vh);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--alu-border-light);
  border-radius: 9px;
  background: var(--alu-surface);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.48);
}
.alu-select-option {
  display: flex;
  width: 100%;
  min-height: 38px;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  color: var(--alu-text-dim);
  background: transparent;
  font: inherit;
  text-align: left;
}
.alu-select-option:hover:not(:disabled),
.alu-select-option:focus-visible { color: var(--alu-text); background: var(--alu-hover); outline: none; }
.alu-select-option.is-selected { color: var(--alu-pink); background: var(--alu-active); }
.alu-select-option:disabled { color: var(--alu-text-faint); opacity: 0.5; }
.alu-select-check { display: grid; width: 15px; flex: 0 0 15px; place-items: center; }
.alu-select-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.alu-select-copy strong { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.alu-select-copy small { overflow: hidden; color: var(--alu-text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) {
  .alu-select-trigger { min-height: 40px; }
  .alu-select-option { min-height: 44px; }
}
</style>
