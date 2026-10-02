<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { formatTurnDuration, turnDurationMs, turnStatusLabel, turnToolCallsLabel, type ConversationTurnSection } from '../lib/conversationPresentation'
import { formatTurnSpeed } from '../lib/turnSpeed'
import { useTurnSpeedStore } from '../stores/turn-speed'

const props = defineProps<{
  section: ConversationTurnSection
  open: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()

// A running turn keeps its own clock; settled turns are fixed spans.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
watch(() => props.section.status === 'running', (running) => {
  if (ticker) clearInterval(ticker)
  ticker = undefined
  if (!running) return
  now.value = Date.now()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onScopeDispose(() => { if (ticker) clearInterval(ticker) })

const running = computed(() => props.section.status === 'running')
const duration = computed(() => {
  const elapsed = turnDurationMs(props.section, now.value)
  if (elapsed === undefined) return ''
  const text = formatTurnDuration(elapsed, running.value)
  return running.value ? text : `用时 ${text}`
})
const turnSpeed = useTurnSpeedStore()
const speed = computed(() => {
  const value = turnSpeed.speedOf(props.section.id)
  return value === undefined ? '' : formatTurnSpeed(value)
})
const segments = computed(() => [turnStatusLabel(props.section.status), duration.value, speed.value, turnToolCallsLabel(props.section)].filter(Boolean))
const label = computed(() => `${segments.value.join('，')}${props.section.error ? `，${props.section.error}` : ''}。${props.open ? '收起过程' : '展开过程'}`)
</script>

<template>
  <div class="conversation-row alu-turn-summary" :class="[`is-${section.status}`, { 'is-open': open }]" :data-conversation-id="section.id">
    <button type="button" class="alu-turn-summary-line" :aria-expanded="open" :aria-label="label" @click="emit('toggle')">
      <span v-if="running" class="alu-agent-activity-spinner" aria-hidden="true" />
      <span class="alu-turn-summary-text">
        <template v-for="(segment, index) in segments" :key="index"><span v-if="index" class="alu-turn-summary-sep" aria-hidden="true">·</span><span>{{ segment }}</span></template>
      </span>
      <span class="alu-turn-summary-disclosure" aria-hidden="true">›</span>
    </button>
    <div v-if="section.error" class="alu-turn-summary-error msg-error">{{ section.error }}</div>
  </div>
</template>

<style scoped>
.alu-turn-summary {
  margin: 4px 0 6px 68px;
  max-width: calc(100% - 68px);
}
.alu-turn-summary-line {
  display: inline-flex;
  min-height: 30px;
  max-width: 100%;
  align-items: center;
  gap: 8px;
  padding: 3px 10px 3px 8px;
  color: var(--alu-text-muted);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
}
.alu-turn-summary-line:hover,
.alu-turn-summary-line:focus-visible {
  color: var(--alu-text);
  border-color: var(--alu-border);
  background: color-mix(in srgb, var(--alu-bg-raised) 70%, transparent);
}
.alu-turn-summary-text {
  display: inline-flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  overflow-wrap: anywhere;
}
.alu-turn-summary-sep { opacity: .55; }
.alu-turn-summary-disclosure {
  color: var(--alu-text-faint);
  font-size: 18px;
  line-height: 1;
  transition: transform .18s ease;
}
.alu-turn-summary.is-open .alu-turn-summary-disclosure { transform: rotate(90deg); }
.alu-turn-summary.is-running .alu-turn-summary-line { color: var(--alu-blue); }
.alu-turn-summary.is-running .alu-turn-summary-line:hover { color: var(--alu-blue); }
.alu-turn-summary.is-failed .alu-turn-summary-line { color: var(--alu-rose); }
.alu-turn-summary.is-aborted .alu-turn-summary-line,
.alu-turn-summary.is-interrupted .alu-turn-summary-line { color: #f6c56f; }
.alu-turn-summary-error {
  margin: 2px 0 0 8px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
@media (max-width: 1000px) {
  .alu-turn-summary {
    max-width: 100%;
    margin-right: 0;
    margin-left: 0;
  }
  .alu-turn-summary-line { min-height: 36px; }
}
@media (min-width: 1200px) {
  .alu-turn-summary-line { font-size: var(--alu-meta-size); }
}
</style>
