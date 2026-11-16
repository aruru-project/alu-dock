<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Work } from '../lib/types'
import { workPresence } from '../lib/uiBoundaries'

const props = defineProps<{ work: Work }>()
const presence = computed(() => workPresence(props.work))
const expanded = ref(false)
const symbol = computed(() => ({ idle: '', running: '', waiting: '?', compacting: '↻', stopping: '−', stopped: '■', lost: '×', error: '!', failed: '!' })[presence.value.tone])
</script>

<template>
  <div class="work-presence" @keydown.esc.stop="expanded = false" @focusout="expanded = false">
    <button type="button" class="work-presence-trigger" :aria-label="`${work.displayName}：${presence.label}，查看状态`" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="work-presence-mark" :class="`is-${presence.tone}`" aria-hidden="true">{{ symbol }}</span>
    </button>
    <div v-if="expanded" class="work-presence-note" role="status">{{ work.displayName }} · {{ presence.label }}<template v-if="work.executor.model"><br />{{ work.executor.model.provider }}/{{ work.executor.model.id }}</template></div>
  </div>
</template>

<style scoped>
.work-presence { flex: none; width: 24px; height: 28px; }
.work-presence-trigger { display: grid; width: 24px; height: 28px; padding: 0; place-items: center; border: 0; border-radius: 6px; color: var(--alu-text-muted); background: transparent; }
.work-presence-trigger:hover, .work-presence-trigger:focus-visible { background: var(--alu-hover); }
.work-presence-mark { display: grid; width: 8px; height: 8px; border-radius: 50%; background: var(--alu-text-faint); place-items: center; font-size: 11px; font-weight: 800; line-height: 1; }
.work-presence-mark.is-idle { background: transparent; border: 2px solid var(--alu-success); opacity: .65; }
.work-presence-mark.is-running { background: var(--alu-running); box-shadow: 0 0 6px var(--alu-running-glow); animation: aluInstancePulse 1.6s ease-in-out infinite; }
.work-presence-mark.is-waiting, .work-presence-mark.is-compacting, .work-presence-mark.is-stopping, .work-presence-mark.is-stopped, .work-presence-mark.is-lost, .work-presence-mark.is-failed, .work-presence-mark.is-error { width: 14px; height: 14px; background: transparent; }
.work-presence-mark.is-waiting { color: var(--alu-waiting); }
.work-presence-mark.is-compacting, .work-presence-mark.is-stopping { color: var(--alu-warning); }
.work-presence-mark.is-lost { color: var(--alu-text-muted); }
.work-presence-mark.is-error, .work-presence-mark.is-failed { color: var(--alu-danger); }
.work-presence-note { position: absolute; z-index: 2; top: 100%; left: 8px; right: 8px; padding: 8px 10px; border: 1px solid var(--alu-border); border-radius: 8px; background: var(--alu-bg); color: var(--alu-text); box-shadow: var(--alu-sidebar-shadow); font-size: var(--alu-meta-size); line-height: 1.5; overflow-wrap: anywhere; max-height: min(300px, 50vh); overflow-y: auto; }
@media (prefers-reduced-motion: reduce) { .work-presence-mark.is-running { animation: none; } }
</style>
