<script setup lang="ts">
import { ref } from 'vue'
import type { NativeOperation } from '../lib/operationBinding'
import { userErrorMessage } from '../lib/userError'

const props = defineProps<{
  operations: readonly NativeOperation[]
  acknowledge: (operation: NativeOperation) => Promise<void>
}>()
const pending = ref(new Set<string>())
const errors = ref<Record<string, string>>({})
const labels: Record<string, string> = {
  submit_message: '发送消息', new_session: '新建 Session', switch_session: '切换 Session', reload_session: 'Reload', navigate_session: '切换分支',
  fork_session: 'Fork', clone_session: 'Clone', name_session: '重命名', compact_session: '压缩上下文',
  set_model: '切换模型', set_thinking: '修改 Thinking', set_active_tools: '修改工具', update_setting: '修改设置',
  run_catalog_command: '运行命令', dequeue_messages: '取回 Queue',
  stop_work: '停止 Work', abort_run: '中止运行', reopen_work: '继续 Work', forget_work: '移除 Work',
  create_work: '新建 Work', adopt_session: '恢复 Work', set_system_default: '保存目录默认',
}
function label(operation: NativeOperation) { return labels[operation.kind] ?? '操作' }
async function acknowledge(operation: NativeOperation) {
  if (pending.value.has(operation.operationId)) return
  pending.value.add(operation.operationId)
  delete errors.value[operation.operationId]
  try { await props.acknowledge(operation) }
  catch { errors.value[operation.operationId] = '提示暂时无法关闭，请稍后重试。' }
  finally { pending.value.delete(operation.operationId) }
}
</script>

<template>
  <details class="alu-operation-results" aria-label="操作结果">
    <summary>{{ operations[0] ? label(operations[0]) : '操作' }}{{ operations[0]?.state === 'succeeded' ? '已完成，提示尚未关闭' : '未完成' }}<span v-if="operations.length > 1"> · 共 {{ operations.length }} 项</span><span class="alu-operation-results-link">查看结果</span></summary>
    <article v-for="operation in operations" :key="operation.operationId">
      <strong>{{ label(operation) }}{{ operation.state === 'succeeded' ? '已完成' : '没有完成' }}</strong>
      <p v-if="operation.state === 'succeeded'">操作已完成，本机保存或确认尚未完成。请检查本机存储后重试；{{ operation.kind === 'submit_message' ? '会保存已发送内容的清理结果，不会再次发送。' : '会保存尚未接纳的返回内容，不会再次执行操作。' }}</p>
      <p v-else>{{ userErrorMessage(operation.error, '操作没有完成。请检查当前状态后，从原入口重新操作。') }}</p>
      <p v-if="errors[operation.operationId]" role="alert">{{ errors[operation.operationId] }}</p>
      <button type="button" class="button secondary" :disabled="pending.has(operation.operationId)" @click="acknowledge(operation)">{{ pending.has(operation.operationId) ? '正在关闭…' : operation.state === 'succeeded' ? '重试关闭' : '知道了' }}</button>
    </article>
  </details>
</template>

<style scoped>
.alu-operation-results { color: var(--alu-text-dim); border: 1px solid var(--alu-rose-border); border-radius: 8px; font-size: 11px; }
summary { cursor: pointer; padding: 8px 10px; color: var(--alu-rose); }
.alu-operation-results-link { margin-left: 10px; text-decoration: underline; }
article { padding: 8px 10px; border-top: 1px solid var(--alu-border); }
article p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
