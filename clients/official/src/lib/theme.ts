/**
 * The color theme of this device: classic, dusk or dawn. styles/tokens.css holds
 * each theme's colors under `[data-theme="…"]` on the page root. The choice is
 * kept in this device's storage only, like the quick buttons, and is shared by
 * every Host.
 *
 * index.html applies the saved theme before the first paint, so it reads
 * THEME_STORAGE_KEY itself; keep the two in step. Android keeps its own copy
 * for the window it shows before the page loads (MainActivity.applyAppearance).
 */
export const THEME_STORAGE_KEY = 'aludock.theme'

export type ClientTheme = 'classic' | 'dusk' | 'dawn'
export const DEFAULT_THEME: ClientTheme = 'classic'

export const CLIENT_THEMES: readonly { id: ClientTheme; label: string; detail: string }[] = Object.freeze([
  { id: 'classic', label: '经典', detail: '深蓝近黑的底色，粉色和冰蓝点缀' },
  { id: 'dusk', label: '暮色', detail: '柔和的暗色，文字不刺眼，适合长时间看' },
  { id: 'dawn', label: '晨光', detail: '浅色界面，适合白天和明亮的环境' },
])

export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isClientTheme(value: unknown): value is ClientTheme {
  return CLIENT_THEMES.some((theme) => theme.id === value)
}

/** A device that never chose, or whose storage cannot be read, uses the default. */
export function readTheme(storage: ThemeStorage | null): ClientTheme {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY)
    return isClientTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Returns false when this device could not keep the choice. */
export function saveTheme(storage: ThemeStorage | null, theme: ClientTheme): boolean {
  try {
    if (!storage) return false
    storage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}

/** Shows the theme on the page now and gives the browser bar the page's background. */
export function showTheme(theme: ClientTheme) {
  const root = document.documentElement
  root.dataset.theme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  const background = getComputedStyle(root).getPropertyValue('--alu-bg').trim()
  if (background) meta.content = background
}
