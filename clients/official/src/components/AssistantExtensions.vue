<script setup lang="ts">
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RefreshCw } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useAssistantExtensionsStore } from '../stores/assistant-extensions'

const app = useAppStore()
const extensions = useAssistantExtensionsStore()
const { editor, values, work } = storeToRefs(extensions)
watch(() => app.activeConnectionId, () => { void extensions.load() }, { immediate: true })
watch(() => [app.activeConnectionId, work.value?.id, work.value?.runtimeGeneration], () => { void extensions.loadTools() }, { immediate: true })
async function refreshTools() {
  await Promise.all([app.refreshWorksQuietly(), extensions.loadTools()])
}
</script>

<template>
  <section class="assistant-extensions" aria-labelledby="assistant-extensions-title">
    <h4 id="assistant-extensions-title">助手工具扩展</h4>
    <p class="assistant-note">配置保存在 Main。模块是你信任的本机代码，拥有助手进程的权限，不是沙箱；只添加你了解的代码，不会自动安装或下载。配置可能包含密钥，不要复制到聊天里。</p>
    <p class="assistant-note">保存后在助手空闲时使用对话里的 Reload，让启停和配置生效。当前聊天和原有工具不受保存影响。</p>
    <p v-if="editor.loading" class="assistant-status" role="status">正在读取扩展设置…</p>
    <div v-if="editor.error" class="assistant-error" role="alert"><span>{{ editor.error }}</span><button type="button" class="button secondary" @click="extensions.load()">重试</button></div>
    <template v-if="editor.current">
      <div v-for="(item, index) in values" :key="index" class="assistant-extension-row">
        <div class="assistant-extension-head">
          <label class="assistant-extension-enabled"><input type="checkbox" :aria-label="`启用扩展 ${index + 1}`" :checked="item.enabled" @change="extensions.edit(index, { enabled: ($event.target as HTMLInputElement).checked })" />启用</label>
          <button type="button" class="button secondary" :aria-label="`移除扩展 ${index + 1}`" @click="extensions.remove(index)">移除</button>
        </div>
        <label>标识（字母、数字、下划线、短横线）<input :aria-label="`扩展标识 ${index + 1}`" :value="item.id" @input="extensions.edit(index, { id: ($event.target as HTMLInputElement).value })" /></label>
        <label>Main 上的模块路径或内置模块名<input :aria-label="`扩展模块 ${index + 1}`" placeholder="/absolute/path/my-tools.mjs 或 builtin:web" :value="item.module" @input="extensions.edit(index, { module: ($event.target as HTMLInputElement).value })" /></label>
        <details>
          <summary>本项 JSON 配置（可能含密钥）</summary>
          <textarea :aria-label="`扩展 JSON 配置 ${index + 1}`" rows="5" spellcheck="false" :value="item.configText" @input="extensions.edit(index, { configText: ($event.target as HTMLTextAreaElement).value })" />
        </details>
        <p class="assistant-note" role="status">{{ work?.extensionStatus[`扩展/${item.id}`] ?? '尚未读到这项扩展的加载状态；保存并 Reload 后可刷新查看。' }}</p>
      </div>
      <p v-if="!values.length" class="assistant-note">没有配置扩展，助手仍可聊天和使用原有工具。</p>
      <div class="assistant-extension-actions">
        <button type="button" class="button secondary" @click="extensions.add()">添加扩展</button>
        <button type="button" class="button primary" :disabled="editor.save?.state === 'pending'" @click="extensions.save()">{{ editor.save?.state === 'pending' ? '正在保存…' : '保存扩展设置' }}</button>
      </div>
    </template>
    <p v-if="editor.save" :class="editor.save.state === 'failed' ? 'assistant-error' : 'assistant-note'" :role="editor.save.state === 'failed' ? 'alert' : 'status'">{{ editor.save.message }}</p>
    <details class="assistant-actual-tools">
      <summary>{{ work?.displayName ?? '助手' }}当前注册的工具{{ editor.tools ? `（${editor.tools.total}）` : '' }}</summary>
      <button type="button" class="button secondary" :disabled="editor.toolsLoading" @click="refreshTools"><RefreshCw :size="14" />{{ editor.toolsLoading ? '正在读取…' : '刷新工具和加载状态' }}</button>
      <p v-if="editor.toolsError" class="assistant-error" role="alert">{{ editor.toolsError }}</p>
      <p v-else-if="!work" class="assistant-note">助手暂未运行，请先在工作列表重新打开。</p>
      <ul v-if="editor.tools">
        <li v-for="tool in editor.tools.tools" :key="tool.name"><strong>{{ tool.name }}</strong> <span>{{ tool.source?.kind === 'extension' ? `extension / ${tool.source.package}` : '内置' }} · {{ tool.active ? '可用' : '未开启' }}</span><p>{{ tool.description }}</p></li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.assistant-extensions { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--alu-border); border-radius: 12px; background: var(--alu-bg-raised); }
h4 { margin: 0; color: var(--alu-text); font-size: var(--alu-control-size); font-weight: 650; }
.assistant-extension-row { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--alu-border); border-radius: 8px; }
.assistant-extension-row label { display: grid; gap: 6px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.assistant-extension-row .assistant-extension-enabled { display: flex; align-items: center; }
.assistant-extension-row input:not([type='checkbox']), textarea { width: 100%; box-sizing: border-box; }
textarea { margin-top: 8px; resize: vertical; line-height: 1.6; }
.assistant-extension-head, .assistant-extension-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.assistant-extension-head { justify-content: space-between; align-items: center; }
summary { cursor: pointer; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.7; }
.assistant-actual-tools .button { margin-top: 8px; }
.assistant-actual-tools ul { padding-left: 18px; font-size: var(--alu-meta-size); overflow-wrap: anywhere; }
.assistant-actual-tools li { margin: 10px 0; }
.assistant-actual-tools li span, .assistant-actual-tools li p { color: var(--alu-text-muted); }
.assistant-actual-tools li p { margin: 4px 0; white-space: pre-wrap; }
.button { min-height: 32px; padding: 0 11px; font-size: var(--alu-meta-size); }
@media (max-width: 640px) { .assistant-extensions { padding: 12px; } }
</style>
