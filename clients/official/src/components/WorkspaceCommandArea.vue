<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronDown, ChevronUp, Play, Square, Terminal } from '@lucide/vue'
import ShellRunRow from './ShellRunRow.vue'
import { useConversationStore } from '../stores/conversation'
import { useInputStore } from '../stores/input'
import { useWorkActionsStore } from '../stores/work-actions'
import type { ShellRunItem, Work } from '../lib/types'

/** The workspace command area: Pi's `!` / `!!` in the Work's directory on its machine.
 * Runs are conversation rows fed by bash.* events, so closing this panel changes nothing
 * about them; the panel only shows the rows and takes new commands. */
const props = defineProps<{
  work: Work | null
  /** The browser can talk to this Work right now. */
  ready: boolean
  mobile: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const workActions = useWorkActionsStore()
const { shellStarting, shellAborting, shellError, hostMachines } = storeToRefs(workActions)
const { conversation } = storeToRefs(useConversationStore())
const { appendShellQuote } = useInputStore()

const open = ref(true)
const commandText = ref('')
const quiet = ref(true)
const input = ref<HTMLTextAreaElement | null>(null)
const list = ref<HTMLElement | null>(null)

const runs = computed(() => conversation.value.filter((item): item is ShellRunItem => item.kind === 'shell'))
const running = computed(() => runs.value.some((item) => item.status === 'running'))
const machineName = computed(() => hostMachines.value.find((machine) => machine.hostId === props.work?.hostId)?.name ?? '')
const place = computed(() => {
  const cwd = props.work?.cwd ?? ''
  return machineName.value ? `在 ${machineName.value} 的 ${cwd} 执行` : `在 Work 所在机器的 ${cwd} 执行`
})
const canRun = computed(() => props.ready && commandText.value.trim().length > 0 && !shellStarting.value)
const expanded = computed(() => open.value || props.mobile)

function showLatest() {
  const element = list.value
  if (element) element.scrollTop = element.scrollHeight
}

async function run() {
  const command = commandText.value.trim()
  if (!canRun.value || !command) return
  const started = await workActions.runShell(command, quiet.value)
  if (started && commandText.value.trim() === command) commandText.value = ''
  await nextTick()
  // The row for a command started here is what the reader wants to see next.
  showLatest()
  input.value?.focus({ preventScroll: true })
}

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    void run()
  }
}

function quote(item: ShellRunItem) {
  appendShellQuote(item)
  emit('close')
}

// The newest run is at the bottom; keep it in view unless the reader scrolled up.
watch(() => runs.value.length, async () => {
  const element = list.value
  if (!element) return
  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  await nextTick()
  if (atBottom) showLatest()
})
watch(expanded, (value) => { if (value) void nextTick(showLatest) })
// Typed text belongs to the Work it was typed for.
watch(() => props.work?.id, () => { commandText.value = '' })
onMounted(() => {
  showLatest()
  if (props.mobile) input.value?.focus({ preventScroll: true })
})
</script>

<template>
  <section class="workspace-command" :class="{ collapsed: !expanded }" aria-label="命令">
    <div class="workspace-command-bar">
      <button v-if="!mobile" type="button" class="workspace-command-collapse" :aria-expanded="open" :title="open ? '收起命令区' : '展开命令区'" @click="open = !open">
        <Terminal :size="14" /><span>命令</span><i v-if="running" class="workspace-command-dot" aria-label="有命令正在运行" /><ChevronDown v-if="open" :size="14" /><ChevronUp v-else :size="14" />
      </button>
      <span class="workspace-command-place" :title="place">{{ place }}</span>
    </div>
    <template v-if="expanded">
      <div ref="list" class="workspace-shell-list">
        <p v-if="!runs.length" class="workspace-shell-empty">在下面输入一条命令。跑完后可以把输出引用给 agent，它也会作为「运行记录」留在对话里。</p>
        <ShellRunRow v-for="item in runs" :key="item.id" :item="item" :machine-name="machineName" can-stop :stopping="shellAborting" @quote="quote" @stop="workActions.abortShell()" />
      </div>
      <p v-if="shellError" class="workspace-shell-feedback" :class="shellError.tone" :role="shellError.tone === 'error' ? 'alert' : 'status'">{{ shellError.message }}</p>
      <form class="workspace-command-input" @submit.prevent="run">
        <div class="workspace-command-mode" role="radiogroup" aria-label="输出是否给 Pi 看">
          <button type="button" role="radio" :aria-checked="quiet" :class="{ selected: quiet }" title="!! 命令：记进 Session，不进入 Pi 的上下文" @click="quiet = true">!! 仅记录</button>
          <button type="button" role="radio" :aria-checked="!quiet" :class="{ selected: !quiet }" title="! 命令：Pi 下一轮能看到这段输出" @click="quiet = false">! Pi 可见</button>
        </div>
        <textarea ref="input" v-model="commandText" class="workspace-command-text" rows="1" placeholder="输入 shell 命令，Enter 运行" aria-label="shell 命令" spellcheck="false" autocapitalize="off" autocomplete="off" :disabled="!ready" @keydown="handleKeydown" />
        <button type="submit" class="workspace-primary-button workspace-command-run" :disabled="!canRun"><Play :size="14" />{{ shellStarting ? '启动中…' : '运行' }}</button>
        <button v-if="running" type="button" class="workspace-secondary-button workspace-command-stop" :disabled="shellAborting" title="停止这个 Work 正在运行的全部命令" @click="workActions.abortShell()"><Square :size="14" />{{ shellAborting ? '停止中…' : '停止全部' }}</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.workspace-command {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-column: 1 / -1;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  border-top: 1px solid var(--alu-border);
  background: rgba(9, 14, 25, 0.98);
}
.workspace-command.collapsed { grid-template-rows: auto; }
.workspace-command-bar { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 4px 12px; }
.workspace-command-collapse {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--alu-text-muted);
  font-size: var(--alu-meta-size);
  font-weight: 600;
}
.workspace-command-collapse:hover { color: var(--alu-text); background: var(--alu-hover); }
.workspace-command-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--alu-blue); box-shadow: 0 0 6px var(--alu-blue); }
.workspace-command-place { min-width: 0; overflow: hidden; color: var(--alu-text-faint); font-size: var(--alu-micro-size); text-overflow: ellipsis; white-space: nowrap; }
.workspace-shell-list { min-height: 0; overflow: auto; padding: 0 12px; scrollbar-color: var(--alu-border) transparent; }
.workspace-shell-empty { margin: 8px 0; color: var(--alu-text-faint); font-family: var(--font-reading); font-size: var(--alu-meta-size); line-height: 1.6; }
.workspace-shell-feedback { margin: 0; padding: 6px 12px 0; font-size: var(--alu-meta-size); }
.workspace-shell-feedback.error { color: var(--alu-rose); }
.workspace-shell-feedback.notice { color: var(--alu-amber); }
.workspace-command-input { display: flex; align-items: flex-end; gap: 8px; padding: 8px 12px 10px; }
.workspace-command-mode,
.workspace-command-run,
.workspace-command-stop {
  display: inline-flex;
  flex: none;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--alu-border);
  border-radius: 8px;
  background: rgba(18, 28, 45, 0.8);
  color: var(--alu-text-muted);
  font-size: var(--alu-meta-size);
}
.workspace-command-mode { gap: 0; overflow: hidden; padding: 0; }
.workspace-command-mode button {
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--alu-text-muted);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: var(--alu-meta-size);
  white-space: nowrap;
}
.workspace-command-mode button + button { border-left: 1px solid var(--alu-border); }
.workspace-command-mode button.selected { color: var(--alu-text); background: var(--alu-hover); }
.workspace-command-mode button:hover:not(.selected) { color: var(--alu-text); }
.workspace-command-run { color: #07121b; border-color: var(--alu-blue); background: var(--alu-blue); font-weight: 700; }
.workspace-command-run:hover:not(:disabled) { background: #a5e7f5; }
.workspace-command-run:disabled { opacity: 0.55; }
.workspace-command-stop { color: var(--alu-rose); }
.workspace-command-stop:hover:not(:disabled) { border-color: var(--alu-rose-border); background: var(--alu-rose-bg); }
.workspace-command-text {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 38px;
  max-height: 120px;
  padding: 9px 10px;
  border: 1px solid var(--alu-border);
  border-radius: 8px;
  background: #04070d;
  color: var(--alu-text);
  font: var(--alu-meta-size)/1.4 'JetBrains Mono', ui-monospace, monospace;
  resize: none;
}
.workspace-command-text:focus { outline: none; border-color: var(--alu-blue-border); }
.workspace-command-text:disabled { opacity: 0.6; }
@media (max-width: 720px) {
  .workspace-command { width: 100%; height: 100%; border: 0; }
  .workspace-command-bar { padding: 8px 12px 0; }
  .workspace-command-input { flex-wrap: wrap; }
  .workspace-command-text { flex-basis: 100%; }
  .workspace-command-mode,
  .workspace-command-run,
  .workspace-command-stop { min-height: 44px; }
  .workspace-command-mode button { min-height: 42px; }
}
</style>
