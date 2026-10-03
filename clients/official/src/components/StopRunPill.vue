<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { isTauri } from '../lib/bridge'
import { formatTurnDuration, turnDurationMs } from '../lib/conversationPresentation'
import type { ConversationTurnItem } from '../lib/types'
import { useAppStore } from '../stores/app'
import { useConversationStore } from '../stores/conversation'
import { useWorkActionsStore } from '../stores/work-actions'

// Shown only while the selected Work is running; it is the "Agent is working"
// indicator and the one place to abort the current reply. Stopping the whole
// Work stays in the command center with its own confirmation and look.
const app = useAppStore()
const running = computed(() => app.selectedWork?.execution === 'running')
const workActions = useWorkActionsStore()
const { aborting } = storeToRefs(workActions)
const { abortCurrentRun } = workActions
const conversation = useConversationStore()

// The clock follows the running turn of the conversation, the same source the
// turn summary line uses. A run joined midway has no start time and shows none.
const runningTurn = computed<ConversationTurnItem | undefined>(() => {
  const items = conversation.conversation
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind === 'turn') return item.status === 'running' ? item : undefined
  }
  return undefined
})
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
watch(running, (active) => {
  if (ticker) clearInterval(ticker)
  ticker = undefined
  if (!active) return
  now.value = Date.now()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onScopeDispose(() => { if (ticker) clearInterval(ticker) })
const elapsed = computed(() => {
  const turn = runningTurn.value
  if (!turn) return ''
  const milliseconds = turnDurationMs(turn, now.value)
  return milliseconds === undefined ? '' : formatTurnDuration(milliseconds, true)
})
const label = computed(() => `${aborting.value ? '正在中止当前回复' : '中止当前回复'}${elapsed.value ? `，已运行 ${elapsed.value}` : ''}`)
</script>

<template>
  <button v-if="running" type="button" class="alu-stop-run" :class="{ 'is-pending': aborting }" :title="label" :aria-label="label" :disabled="!isTauri || aborting" @click="abortCurrentRun">
    <span class="alu-stop-run-icon" aria-hidden="true" />
    <span>{{ aborting ? '中止中' : '中止' }}</span>
    <span v-if="elapsed" class="alu-stop-run-time" aria-hidden="true">{{ elapsed }}</span>
  </button>
</template>

<style scoped>
/* Placed by the input region's floating row (right cell); the row is click-through, the pill is not. */
.alu-stop-run {
  pointer-events: auto;
  display: inline-flex;
  white-space: nowrap;
  min-height: 32px;
  align-items: center;
  gap: 7px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--alu-rose-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--alu-bg-raised) 92%, transparent);
  box-shadow: 0 8px 24px rgba(2, 6, 18, .34);
  color: var(--alu-rose);
  font-size: var(--alu-meta-size);
  font-weight: 650;
  cursor: pointer;
  backdrop-filter: blur(10px);
  transition: border-color 0.15s, background 0.15s, transform 0.15s;
}
.alu-stop-run-icon {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: currentColor;
  flex-shrink: 0;
}
.alu-stop-run-time {
  color: var(--alu-text-dim);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.alu-stop-run-time::before { content: '·'; margin-right: 7px; color: var(--alu-text-faint); }
.alu-stop-run:hover { border-color: var(--alu-rose); background: var(--alu-rose-bg); transform: translateY(-1px); }
.alu-stop-run:focus-visible { outline: 2px solid var(--alu-rose); outline-offset: 2px; box-shadow: var(--focus-ring); }
.alu-stop-run:disabled { cursor: default; transform: none; }
.alu-stop-run.is-pending { color: var(--alu-rose-dim); }
@media (max-width: 640px) {
  .alu-stop-run { min-height: 30px; padding: 0 10px 0 9px; }
}
</style>
