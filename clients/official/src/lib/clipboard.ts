export async function copyPlainText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the selection-based WebView fallback.
    }
  }

  const surface = document.createElement('textarea')
  surface.value = text
  surface.readOnly = true
  surface.style.position = 'fixed'
  surface.style.inset = '-10000px auto auto -10000px'
  document.body.appendChild(surface)
  surface.select()
  const copied = document.execCommand('copy')
  surface.remove()
  if (!copied) throw new Error('copy unavailable')
}
