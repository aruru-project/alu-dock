<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ state: string; label: string; busy: boolean }>()
const emit = defineEmits<{ reconnect: []; settings: []; works: [] }>()
const attention = computed(() => ({
  identity_error: { short: '身份', message: '无法确认 Host 的身份或连接授权。请在“连接与配对”中核对保存的地址，不要直接覆盖原有配对。', action: '连接与配对', target: 'settings' },
  host_changed: { short: 'Host', message: 'Host 状态已经变化。请刷新工作列表后继续；本地编辑内容仍保留。', action: '刷新状态', target: 'reconnect' },
  follow_failed: { short: '更新', message: '没有收到这个 Work 的最新更新，客户端不会自动重试。请重新连接；本地编辑内容仍保留。', action: '重新连接', target: 'reconnect' },
  content_error: { short: '正文', message: '对话暂时无法显示。请重新读取；本地编辑内容仍保留。', action: '重新读取', target: 'reconnect' },
  unavailable: { short: 'Work', message: '这项工作当前不可用。请从工作列表查看最新状态。', action: '工作列表', target: 'works' },
} as Record<string, { short: string; message: string; action: string; target: 'reconnect' | 'settings' | 'works' }>)[props.state])
const description = computed(() => attention.value?.message ?? (props.state === 'connected'
  ? '已连接到当前工作。'
  : props.state === 'paused' ? '窗口已暂离，Work 不会因此停止；返回后继续接收消息。'
    : '连接暂时中断或正在恢复。客户端会自动重连，你可以继续编辑。'))
// Without an attention state the action is the plain refresh: the same step the
// command palette's 刷新状态 runs, so a refresh in flight is shown and not repeated.
const refreshes = computed(() => !attention.value || attention.value.target === 'reconnect')
function act() {
  if (attention.value?.target === 'settings') emit('settings')
  else if (attention.value?.target === 'works') emit('works')
  else emit('reconnect')
}
</script>

<template>
  <details class="alu-connection-status" aria-label="连接状态">
    <summary :aria-label="`${label}，查看原因和操作`" :title="`${label} · 查看状态`">
      <span class="alu-status-dot" :class="{ connecting: state === 'connecting' || state === 'paused', error: !!attention || state === 'disconnected' }" />
      <span v-if="attention" class="alu-status-attention">{{ attention.short }}</span>
    </summary>
    <div class="alu-status-details">
      <strong>{{ label }}</strong>
      <p>{{ description }}</p>
      <button type="button" class="button secondary alu-status-action" :disabled="refreshes && busy" @click="act">{{ refreshes && busy ? '正在刷新…' : attention?.action ?? '刷新状态' }}</button>
    </div>
  </details>
</template>

<style scoped>
/* Sits in the top bar before the Work name; the popover opens downward from the dot. */
.alu-connection-status { position: relative; flex-shrink: 0; }
.alu-connection-status > summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 24px;
  min-height: 24px;
  padding: 0 4px;
  border-radius: 6px;
  list-style: none;
  cursor: pointer;
}
.alu-connection-status > summary::-webkit-details-marker { display: none; }
.alu-connection-status > summary:hover { background: var(--alu-hover); }
.alu-connection-status > summary:focus-visible { outline: 2px solid var(--alu-blue); outline-offset: 1px; }
.alu-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--alu-mint);
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.6);
  flex-shrink: 0;
}
.alu-status-dot.connecting {
  background: var(--alu-amber);
  box-shadow: 0 0 6px rgba(251, 191, 36, 0.6);
  animation: statusPulse 1.2s ease-in-out infinite;
}
.alu-status-dot.error {
  background: var(--alu-rose);
  box-shadow: 0 0 6px rgba(248, 113, 113, 0.6);
}
.alu-status-attention { font-size: var(--alu-meta-size); color: var(--alu-rose); white-space: nowrap; }
.alu-status-details { position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; width: min(320px, calc(100vw - 24px)); padding: 12px; box-sizing: border-box; border: 1px solid var(--alu-border-light); border-radius: 8px; background: var(--alu-surface); color: var(--alu-text); font-size: var(--alu-ui-size); box-shadow: 0 12px 36px rgba(2, 6, 18, .4); }
.alu-status-details p { margin: 8px 0; line-height: 1.5; overflow-wrap: anywhere; }
</style>
