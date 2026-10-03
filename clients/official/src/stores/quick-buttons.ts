import { defineStore } from 'pinia'
import { ref } from 'vue'
import { MAX_QUICK_BUTTONS, persistQuickButtons, quickButtonFromDraft, readQuickButtons, type QuickButton, type QuickButtonDraft, type QuickButtonStorage } from '../lib/quickButtons'

function deviceStorage(): QuickButtonStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

/** The quick button list of this device and the one form that edits it. Running a button belongs to the input store. */
export const useQuickButtonsStore = defineStore('quick-buttons', () => {
  const buttons = ref<QuickButton[]>(readQuickButtons(deviceStorage()))
  /** Shown in the editor; set when this device could not keep the latest change. */
  const saveError = ref('')
  const editing = ref<QuickButtonDraft | null>(null)
  const formError = ref('')

  function commit(next: QuickButton[]) {
    buttons.value = next
    saveError.value = persistQuickButtons(deviceStorage(), next) ? '' : '这次修改已生效，但没能保存到本机；重启客户端后会丢失。'
  }

  /** Opens the form: an existing button by id, or a new one prefilled by the caller (a pinned command). */
  function edit(draft: QuickButtonDraft) {
    editing.value = { ...draft }
    formError.value = ''
  }
  function cancelEdit() {
    editing.value = null
    formError.value = ''
  }
  function save(): boolean {
    const draft = editing.value
    if (!draft) return false
    if (!draft.id && buttons.value.length >= MAX_QUICK_BUTTONS) {
      formError.value = `最多 ${MAX_QUICK_BUTTONS} 个快捷按钮，请先删除不用的。`
      return false
    }
    const button = quickButtonFromDraft(draft, draft.id ?? crypto.randomUUID())
    if (typeof button === 'string') {
      formError.value = button
      return false
    }
    commit(draft.id && buttons.value.some((item) => item.id === draft.id)
      ? buttons.value.map((item) => item.id === draft.id ? button : item)
      : [...buttons.value, button])
    cancelEdit()
    return true
  }
  function remove(id: string) {
    commit(buttons.value.filter((item) => item.id !== id))
  }
  /** Moves a button one place up (-1) or down (1); the order decides which ones fit in the row. */
  function move(id: string, offset: -1 | 1) {
    const from = buttons.value.findIndex((item) => item.id === id)
    const to = from + offset
    if (from < 0 || to < 0 || to >= buttons.value.length) return
    const next = [...buttons.value]
    const [button] = next.splice(from, 1)
    next.splice(to, 0, button!)
    commit(next)
  }

  return { buttons, saveError, editing, formError, edit, cancelEdit, save, remove, move }
})
