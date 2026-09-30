<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Copy, Send, Square } from '@lucide/vue'
import { copyPlainText } from '../lib/clipboard'
import type { ShellRunItem } from '../lib/types'

/** One user shell command (Pi `!` / `!!`): live output while it runs, then its result.
 * Used both in the conversation timeline and in the workspace command area. */
const props = defineProps<{
  item: ShellRunItem
  /** Where the command ran, so a copied full-output path is read on that machine. */
  machineName?: string
  /** Pi is told to stop every running command of the Work, not just this row. */
  canStop?: boolean
  stopping?: boolean
}>()
const emit = defineEmits<{ quote: [item: ShellRunItem]; stop: [] }>()

const output = ref<HTMLElement | null>(null)
const copyStatus = ref('')
let copyTimer = 0

const statusLabel = computed(() => {
  const item = props.item
  if (item.status === 'running') return '运行中'
  if (item.status === 'stopped') return '已停止'
  if (item.error) return '无法运行'
  if (item.status === 'failed') return item.exitCode === undefined ? '失败' : `退出码 ${item.exitCode}`
  return '完成'
})
const modeLabel = computed(() => props.item.excludeFromContext ? '仅记录' : 'Pi 可见')
const modeTitle = computed(() => props.item.excludeFromContext
  ? '!! 命令：记进 Session，不进入 Pi 的上下文'
  : '! 命令：Pi 下一轮能看到这段输出')

// A running command scrolls like a terminal; once the reader scrolls up, it stays put.
watch(() => props.item.output, async () => {
  const element = output.value
  if (!element || props.item.status !== 'running') return
  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  await nextTick()
  if (atBottom) element.scrollTop = element.scrollHeight
})

async function copyPath() {
  const path = props.item.fullOutputPath
  if (!path) return
  window.clearTimeout(copyTimer)
  try {
    await copyPlainText(path)
    copyStatus.value = '已复制路径'
  } catch {
    copyStatus.value = '没有复制成功，请手动选择路径'
  }
  copyTimer = window.setTimeout(() => { copyStatus.value = '' }, 2200)
}
</script>

<template>
  <article class="shell-run" :class="`shell-run-${item.status}`" :data-conversation-id="item.id" :aria-label="`命令 ${item.command}`">
    <header class="shell-run-header">
      <span class="shell-run-prompt" :class="{ quiet: item.excludeFromContext }" :title="modeTitle">{{ item.excludeFromContext ? '!!' : '!' }}</span>
      <code class="shell-run-command">{{ item.command }}</code>
      <span class="shell-run-status" :class="`is-${item.status}`" role="status">{{ statusLabel }}</span>
      <span v-if="item.time" class="shell-run-time">{{ item.time }}</span>
    </header>
    <pre v-if="item.output" ref="output" class="shell-run-output" tabindex="0"><code>{{ item.output }}</code></pre>
    <p v-else-if="item.status === 'running'" class="shell-run-note">正在运行，还没有输出。</p>
    <p v-else-if="!item.error" class="shell-run-note">没有输出。</p>
    <p v-if="item.error" class="shell-run-note shell-run-error">{{ item.error }}</p>
    <div v-if="item.truncated" class="shell-run-note shell-run-truncated">
      <span>这里只保留了输出的末尾。{{ item.fullOutputPath ? `完整输出在${machineName ? ` ${machineName} 上` : ' Work 所在机器的'}：` : '' }}</span>
      <code v-if="item.fullOutputPath" class="shell-run-path">{{ item.fullOutputPath }}</code>
      <button v-if="item.fullOutputPath" type="button" class="shell-run-action" title="复制完整输出的路径" @click="copyPath"><Copy :size="13" />复制路径</button>
      <span v-if="copyStatus" role="status">{{ copyStatus }}</span>
    </div>
    <footer class="shell-run-actions">
      <span class="shell-run-mode" :title="modeTitle">{{ modeLabel }}</span>
      <button v-if="item.status === 'running' && canStop" type="button" class="shell-run-action shell-run-stop" :disabled="stopping" title="停止这个 Work 正在运行的全部命令" @click="emit('stop')"><Square :size="13" />{{ stopping ? '正在停止…' : '停止全部命令' }}</button>
      <button v-else-if="item.status !== 'running'" type="button" class="shell-run-action shell-run-quote" title="把命令和输出引用进输入框，由你决定是否发送" @click="emit('quote', item)"><Send :size="13" />发给 agent</button>
    </footer>
  </article>
</template>

<style scoped>
.shell-run {
  display: grid;
  gap: 6px;
  min-width: 0;
  margin: 8px 0;
  padding: 9px 12px 8px;
  border: 1px solid var(--alu-border);
  border-left: 2px solid var(--alu-amber);
  border-radius: 8px;
  background: rgba(7, 11, 19, 0.9);
  color: var(--alu-text-dim);
  font-size: var(--alu-meta-size);
}
.shell-run-running { border-left-color: var(--alu-blue); }
.shell-run-failed { border-left-color: var(--alu-rose); }
.shell-run-stopped { border-left-color: var(--alu-text-faint); }
.shell-run-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.shell-run-prompt {
  flex: none;
  color: var(--alu-amber);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 700;
}
.shell-run-prompt.quiet { color: var(--alu-text-muted); }
.shell-run-command {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--alu-text);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.shell-run-status {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--alu-border);
  color: var(--alu-text-muted);
  font-size: var(--alu-micro-size);
  white-space: nowrap;
}
.shell-run-status.is-running { color: var(--alu-blue); border-color: var(--alu-blue-border); background: var(--alu-blue-bg); }
.shell-run-status.is-failed { color: var(--alu-rose); border-color: var(--alu-rose-border); background: var(--alu-rose-bg); }
.shell-run-time { flex: none; color: var(--alu-text-faint); font-size: var(--alu-micro-size); }
.shell-run-output {
  max-height: 320px;
  min-width: 0;
  margin: 0;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: #04070d;
  color: #d4e3ee;
  font: var(--alu-meta-size)/1.55 'JetBrains Mono', 'Noto Sans SC', ui-monospace, monospace;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-color: var(--alu-border) transparent;
}
.shell-run-note { margin: 0; color: var(--alu-text-muted); font-size: var(--alu-micro-size); }
.shell-run-error { color: var(--alu-rose); white-space: pre-wrap; overflow-wrap: anywhere; }
.shell-run-truncated { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--alu-amber-dim); }
.shell-run-path { overflow-wrap: anywhere; color: var(--alu-text); font-family: 'JetBrains Mono', ui-monospace, monospace; user-select: all; }
.shell-run-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.shell-run-mode { margin-right: auto; color: var(--alu-text-faint); font-size: var(--alu-micro-size); }
.shell-run-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--alu-border);
  border-radius: 6px;
  background: rgba(18, 28, 45, 0.8);
  color: var(--alu-text-muted);
  font-size: var(--alu-micro-size);
}
.shell-run-action:hover:not(:disabled),
.shell-run-action:focus-visible { color: var(--alu-text); border-color: var(--alu-blue-border); background: var(--alu-hover); }
.shell-run-action:disabled { opacity: 0.6; }
.shell-run-quote { color: var(--alu-blue); }
.shell-run-stop { color: var(--alu-rose); }
@media (max-width: 720px) {
  .shell-run-output { max-height: 240px; }
  .shell-run-action { min-height: 36px; }
}
</style>
