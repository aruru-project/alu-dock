<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ state: string; label: string }>()
const emit = defineEmits<{ reconnect: []; settings: []; works: [] }>()
const attention = computed(() => ({
  identity_error: { short: '身份', message: '无法确认 Host 的身份或连接授权。请核对保存的地址与 Host 设置，不要直接覆盖原有配对。', action: 'Host 设置', target: 'settings' },
  host_changed: { short: 'Host', message: 'Host 状态已经变化。请刷新工作列表后继续；本地编辑内容仍保留。', action: '刷新状态', target: 'reconnect' },
  content_error: { short: '正文', message: '对话暂时无法显示。请重新读取；本地编辑内容仍保留。', action: '重新读取', target: 'reconnect' },
  unavailable: { short: 'Work', message: '这项工作当前不可用。请从工作列表查看最新状态。', action: '工作列表', target: 'works' },
} as Record<string, { short: string; message: string; action: string; target: 'reconnect' | 'settings' | 'works' }>)[props.state])
const description = computed(() => attention.value?.message ?? (props.state === 'connected'
  ? '已连接到当前工作。'
  : props.state === 'paused' ? '窗口已暂离，Work 不会因此停止；返回后继续接收消息。'
    : '连接暂时中断或正在恢复。客户端会自动重连，你可以继续编辑。'))
function act() {
  if (attention.value?.target === 'settings') emit('settings')
  else if (attention.value?.target === 'works') emit('works')
  else emit('reconnect')
}
</script>

<template>
  <details class="alu-connection-status" aria-label="连接状态">
    <summary class="alu-bar-btn" :aria-label="`${label}，查看原因和操作`" :title="`${label} · 查看状态`">
      <span class="alu-status-dot" :class="{ connecting: state === 'connecting' || state === 'paused', error: !!attention || state === 'disconnected' }" />
      <span v-if="attention" class="alu-status-attention">{{ attention.short }}</span>
      <span v-else class="alu-status-label sm-inline">{{ label }}</span>
    </summary>
    <div class="alu-status-details">
      <strong>{{ label }}</strong>
      <p>{{ description }}</p>
      <button type="button" class="button secondary" @click="act">{{ attention?.action ?? '重新连接' }}</button>
    </div>
  </details>
</template>

<style scoped>
/* 状态指示器 */
.alu-status-dot {
  width: 7px;
  height: 7px;
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
.alu-status-label {
  color: var(--alu-text-muted);
  font-size: 11px;
}
@media screen and (max-width: 1000px) {
  .alu-status-label {
    display: none;
  }
}
.alu-connection-status > summary { list-style: none; min-width: 24px; padding-inline: 2px; }
.alu-connection-status > summary::-webkit-details-marker { display: none; }
.alu-status-attention { font-size: 11px; color: var(--alu-rose); }
.alu-status-details { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 30; width: min(320px, calc(100vw - 24px)); padding: 12px; box-sizing: border-box; border: 1px solid var(--alu-border-light); border-radius: 8px; background: var(--alu-surface); color: var(--alu-text); font-size: 12px; }
.alu-status-details p { margin: 8px 0; line-height: 1.5; overflow-wrap: anywhere; }
</style>
