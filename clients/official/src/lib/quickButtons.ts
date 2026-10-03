/**
 * The input card's quick buttons: the user's own shortcuts in the middle of the button row.
 * Stored on this device only and shared by every Host; they never reach the Protocol.
 * A button is just text. Pressing it is the same as typing that text, so a command the
 * current Work does not have gets the same answer from Pi as typing it by hand.
 */
export const QUICK_BUTTONS_KEY = 'aludock.quickButtons'
/** The row shows the first six on desktop and, by CSS, the first three on phones. */
export const QUICK_BUTTONS_IN_ROW = 6
export const MAX_QUICK_BUTTONS = 50
export const MAX_QUICK_BUTTON_NAME_CHARS = 32
export const MAX_QUICK_BUTTON_TEXT_CHARS = 10_000

/** `send` sends the text at once; `insert` puts it in front of the draft and waits. */
export type QuickButtonMode = 'send' | 'insert'
export interface QuickButton {
  id: string
  name: string
  text: string
  mode: QuickButtonMode
}
/** The editor form: no id while creating a new button. */
export interface QuickButtonDraft {
  id?: string
  name: string
  text: string
  mode: QuickButtonMode
}

export const DEFAULT_QUICK_BUTTONS: readonly QuickButton[] = Object.freeze([
  Object.freeze({ id: 'default-resume', name: '恢复', text: '/resume', mode: 'send' as const }),
  Object.freeze({ id: 'default-tree', name: 'Tree', text: '/tree', mode: 'send' as const }),
])

export interface QuickButtonStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A device without a saved list starts with the defaults; a saved empty list stays empty. */
export function readQuickButtons(storage: QuickButtonStorage | null): QuickButton[] {
  const defaults = () => DEFAULT_QUICK_BUTTONS.map((button) => ({ ...button }))
  try {
    const raw = storage?.getItem(QUICK_BUTTONS_KEY)
    if (raw === null || raw === undefined) return defaults()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return defaults()
    const seen = new Set<string>()
    return parsed.flatMap((value) => {
      const button = normalizeQuickButton(value)
      if (!button || seen.has(button.id)) return []
      seen.add(button.id)
      return [button]
    }).slice(0, MAX_QUICK_BUTTONS)
  } catch {
    // Unreadable storage must never take the input card away.
    return defaults()
  }
}

export function persistQuickButtons(storage: QuickButtonStorage | null, buttons: readonly QuickButton[]): boolean {
  try {
    if (!storage) return false
    storage.setItem(QUICK_BUTTONS_KEY, JSON.stringify(buttons))
    return true
  } catch {
    return false
  }
}

/** Two Chinese characters or four letters: such a name always stays whole in the row, longer ones give way first. */
export function quickButtonNameIsShort(name: string): boolean {
  let width = 0
  for (const char of name) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(char) ? 2 : 1
  return width <= 4
}

/** The form's draft as a stored button, or the reason it cannot be saved. */
export function quickButtonFromDraft(draft: QuickButtonDraft, id: string): QuickButton | string {
  if (!draft.text.trim()) return '请填写按下按钮时要发送或填入的文本。'
  if ([...draft.text].length > MAX_QUICK_BUTTON_TEXT_CHARS) return `文本最多 ${MAX_QUICK_BUTTON_TEXT_CHARS} 个字符。`
  // An empty name falls back to the text; the row shortens what does not fit.
  const name = [...(draft.name.trim() || draft.text.trim())].slice(0, MAX_QUICK_BUTTON_NAME_CHARS).join('')
  return { id, name, text: draft.text, mode: draft.mode }
}

function normalizeQuickButton(value: unknown): QuickButton | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id || record.id.length > 128
    || typeof record.name !== 'string' || typeof record.text !== 'string'
    || (record.mode !== 'send' && record.mode !== 'insert')) return null
  const button = quickButtonFromDraft({ name: record.name, text: record.text, mode: record.mode }, record.id)
  return typeof button === 'string' ? null : button
}
