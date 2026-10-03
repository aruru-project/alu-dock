<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from '@lucide/vue'
import { MAX_QUICK_BUTTON_NAME_CHARS, MAX_QUICK_BUTTON_TEXT_CHARS, type QuickButtonMode } from '../lib/quickButtons'
import { useQuickButtonsStore } from '../stores/quick-buttons'

// 命令面板里的「管理快捷按钮」：一张列表和一个表单，表单也是钉住命令时打开的那个。
const quickButtons = useQuickButtonsStore()
const { buttons, editing, formError, saveError } = storeToRefs(quickButtons)
const { edit, cancelEdit, save, remove, move } = quickButtons
const textInput = ref<HTMLTextAreaElement | null>(null)

// The form opens with the cursor after the prefilled text, ready for an argument.
watch(() => editing.value !== null, async (open) => {
  if (!open) return
  await nextTick()
  const input = textInput.value
  if (!input) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}, { immediate: true })
// Leaving the section or closing the palette drops an unsaved form.
onUnmounted(cancelEdit)

function modeLabel(mode: QuickButtonMode) {
  return mode === 'send' ? '立即发送' : '填入输入框'
}
</script>

<template>
  <section class="quick-buttons-editor">
    <div v-if="saveError" class="alu-dialog-error" role="status">{{ saveError }}</div>
    <form v-if="editing" class="quick-button-form" @submit.prevent="save">
      <label class="quick-button-field">
        <span class="quick-button-field-label">名称</span>
        <input v-model="editing.name" class="ui-dialog-input" :maxlength="MAX_QUICK_BUTTON_NAME_CHARS" placeholder="留空则用文本" />
        <small>显示在按钮上。手机上放得下 4 个汉字或 8 个字母左右，更长会截断。</small>
      </label>
      <label class="quick-button-field">
        <span class="quick-button-field-label">文本</span>
        <textarea ref="textInput" v-model="editing.text" class="ui-dialog-input" rows="3" :maxlength="MAX_QUICK_BUTTON_TEXT_CHARS" placeholder="例如 /codex-fast all" />
        <small>按下按钮时发送或填入的内容，和在输入框里手打一样；命令可以带参数。</small>
      </label>
      <fieldset class="quick-button-modes">
        <legend class="quick-button-field-label">按下时</legend>
        <label><input v-model="editing.mode" type="radio" value="send" />立即发送</label>
        <label><input v-model="editing.mode" type="radio" value="insert" />填入输入框，不发送</label>
      </fieldset>
      <div v-if="formError" class="alu-dialog-error">{{ formError }}</div>
      <div class="ui-dialog-form-footer">
        <button type="button" class="ui-dialog-btn" @click="cancelEdit">取消</button>
        <button type="submit" class="ui-dialog-btn ui-dialog-btn-primary">保存</button>
      </div>
    </form>
    <template v-else>
      <div class="quick-buttons-toolbar">
        <button type="button" class="ui-dialog-btn" @click="edit({ name: '', text: '', mode: 'send' })"><Plus :size="14" />新建快捷按钮</button>
      </div>
      <ol v-if="buttons.length" class="quick-buttons-list" aria-label="快捷按钮">
        <li v-for="(button, index) in buttons" :key="button.id" class="quick-buttons-item">
          <div class="quick-buttons-item-copy">
            <span class="quick-buttons-item-top"><strong>{{ button.name }}</strong><span class="quick-buttons-item-mode">{{ modeLabel(button.mode) }}</span></span>
            <code>{{ button.text }}</code>
          </div>
          <div class="quick-buttons-item-actions">
            <button type="button" :aria-label="`上移「${button.name}」`" title="上移" :disabled="index === 0" @click="move(button.id, -1)"><ArrowUp :size="14" /></button>
            <button type="button" :aria-label="`下移「${button.name}」`" title="下移" :disabled="index === buttons.length - 1" @click="move(button.id, 1)"><ArrowDown :size="14" /></button>
            <button type="button" :aria-label="`修改「${button.name}」`" title="修改" @click="edit(button)"><Pencil :size="14" /></button>
            <button type="button" :aria-label="`删除「${button.name}」`" title="删除" @click="remove(button.id)"><Trash2 :size="14" /></button>
          </div>
        </li>
      </ol>
      <p v-else class="ui-dialog-empty">还没有快捷按钮。在命令面板里点命令右边的图钉，或在这里新建。</p>
      <p class="quick-buttons-note">输入框下方显示排在前面的几个：手机 3 个，桌面 6 个。其余在命令面板的「快捷按钮」组里。</p>
    </template>
  </section>
</template>

<style scoped>
.quick-buttons-editor { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow-y: auto; padding-bottom: 6px; }
.quick-button-form { display: flex; flex-direction: column; padding-top: 6px; }
.quick-button-field { display: flex; flex-direction: column; }
.quick-button-field .ui-dialog-input { margin: 4px 16px 0; font: inherit; font-size: var(--alu-ui-size); }
.quick-button-field textarea.ui-dialog-input { resize: vertical; min-height: 72px; line-height: 1.5; }
.quick-button-field small { margin: 4px 16px 10px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); }
.quick-button-field-label { margin: 6px 16px 0; padding: 0; color: var(--alu-text-dim); font-size: var(--alu-ui-size); font-weight: 650; }
.quick-button-modes { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0 16px 10px; border: 0; }
.quick-button-modes legend { width: 100%; margin: 6px 0 6px; }
.quick-button-modes label { display: inline-flex; min-height: 32px; align-items: center; gap: 7px; color: var(--alu-text); font-size: var(--alu-ui-size); cursor: pointer; }
.quick-button-modes input { accent-color: var(--alu-pink); }
.quick-buttons-toolbar { display: flex; padding: 12px 16px 4px; }
.quick-buttons-toolbar .ui-dialog-btn { display: inline-flex; align-items: center; gap: 6px; }
.quick-buttons-list { display: grid; gap: 4px; margin: 6px 0 0; padding: 0 10px; list-style: none; }
.quick-buttons-item { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 10px; border: 1px solid var(--alu-border); border-radius: 9px; background: var(--alu-bg-raised); }
.quick-buttons-item-copy { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; gap: 3px; }
.quick-buttons-item-top { display: flex; min-width: 0; align-items: baseline; gap: 8px; }
.quick-buttons-item-top strong { overflow: hidden; color: var(--alu-text); font-size: var(--alu-ui-size); text-overflow: ellipsis; white-space: nowrap; }
.quick-buttons-item-mode { flex: 0 0 auto; color: var(--alu-text-faint); font-size: var(--alu-micro-size); }
.quick-buttons-item code { overflow: hidden; color: var(--alu-amber); font-size: var(--alu-meta-size); text-overflow: ellipsis; white-space: nowrap; }
.quick-buttons-item-actions { display: flex; flex: 0 0 auto; gap: 2px; }
.quick-buttons-item-actions button { display: inline-grid; width: 32px; height: 32px; place-items: center; border-radius: 7px; color: var(--alu-text-muted); }
.quick-buttons-item-actions button:hover:not(:disabled) { background: var(--alu-hover); color: var(--alu-text); }
.quick-buttons-item-actions button:disabled { opacity: 0.3; cursor: default; }
.quick-buttons-note { margin: 12px 16px 4px; color: var(--alu-text-muted); font-size: var(--alu-meta-size); line-height: 1.5; }
@media (max-width: 640px) {
  .quick-buttons-item-actions button { width: 40px; height: 40px; }
}
</style>
