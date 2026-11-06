import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { CLIENT_THEMES, THEME_STORAGE_KEY } from '../src/lib/theme.ts'

// #665: a color a theme does not define silently shows the classic value there
// (a dark classic panel inside dawn), so every theme defines every color.
const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
function declarations(selector: string) {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `tokens.css has a block for ${selector}`)
  const body = css.slice(start, css.indexOf('\n}\n', start))
  return new Map([...body.matchAll(/^\s*(--[a-z0-9-]+|color-scheme):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]))
}
const classic = declarations(':root,\n[data-theme="classic"]')
const rgbOf = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(' ')

for (const { id } of CLIENT_THEMES) {
  const theme = id === 'classic' ? classic : declarations(`[data-theme="${id}"]`)
  assert.deepEqual([...theme.keys()].sort(), [...classic.keys()].sort(), `${id} defines exactly the colors classic defines`)
  // Translucent uses read the -rgb partner, so it must be the same color.
  for (const [name, value] of theme) {
    const color = theme.get(name.replace(/-rgb$/, ''))
    if (name.endsWith('-rgb') && color && /^#[0-9a-f]{6}$/i.test(color)) assert.equal(value, rgbOf(color), `${id}: ${name} is ${color}`)
  }
}

// The first paint already shows the saved theme: index.html reads the key the App saves under.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const firstPaint = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
assert.ok(firstPaint, 'index.html applies the theme before the module script')
for (const saved of ['dawn', null]) {
  const attributes = new Map<string, string>()
  runInNewContext(firstPaint, {
    localStorage: { getItem: (key: string) => (key === THEME_STORAGE_KEY ? saved : null) },
    document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
  })
  assert.equal(attributes.get('data-theme'), saved ?? 'classic', `a device that saved ${saved ?? 'nothing'} opens in ${saved ?? 'classic'}`)
}
console.log('PASS: every theme defines every color, and the first paint uses the saved theme')
