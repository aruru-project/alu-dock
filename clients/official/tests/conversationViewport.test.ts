import assert from 'node:assert/strict'
import { createRenderer, ref } from 'vue'
import {
  useConversationViewport,
  conversationBottomGap,
  conversationFollowAfterScroll,
  conversationIsAtBottom,
} from '../src/lib/conversationViewport.ts'

const clampedAfterShrink = { scrollHeight: 49_047, scrollTop: 48_347, clientHeight: 700 }
assert.equal(conversationIsAtBottom(clampedAfterShrink), true)
assert.equal(conversationBottomGap(clampedAfterShrink), 0)
assert.equal(
  conversationFollowAfterScroll(true, 48_432, clampedAfterShrink.scrollTop, 0),
  true,
  'a layout shrink clamped at the real end keeps follow intent instead of showing a stale bottom action',
)

assert.equal(
  conversationFollowAfterScroll(true, 48_347, 48_167, 180),
  false,
  'a small upward reading gesture takes ownership from automatic following',
)
assert.equal(
  conversationFollowAfterScroll(false, 48_167, 48_345, 2),
  true,
  'reaching the actual end resumes following and hides the bottom action',
)
assert.equal(
  conversationFollowAfterScroll(false, 10_106, 10_106, 112),
  false,
  'the scroll event after restoring a reading anchor must not resume follow merely because it is near the end',
)
assert.equal(conversationIsAtBottom({ scrollHeight: 9_769, scrollTop: 8_887, clientHeight: 700 }), false)

let scans = 0
const reading = { dataset: { conversationId: 'reading' }, isConnected: true, getBoundingClientRect: () => ({ top: -50, bottom: 150 }) }
const later = { dataset: { conversationId: 'later' }, isConnected: true, getBoundingClientRect: () => ({ top: 500, bottom: 800 }) }
const surface = {
  scrollTop: 1000, scrollHeight: 4000, clientHeight: 700,
  getBoundingClientRect: () => ({ top: 0, left: 0 }), contains: () => true,
  querySelector: (selector: string) => selector.includes('later') ? later : reading,
  querySelectorAll: () => { scans++; return [reading, later] },
}
let viewport: ReturnType<typeof useConversationViewport>
const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} } as any)
const app = renderer.createApp({ setup() { viewport = useConversationViewport(ref(surface as unknown as HTMLElement)); return () => null } })
app.mount({})
assert.equal(viewport!.captureAnchor(false, new Set(['later'])), null, 'later output needs no reading anchor')
assert.equal(viewport!.captureAnchor(false, new Set()), null, 'appending a new live row needs no historical DOM scan')
assert.equal(scans, 0)
const anchor = viewport!.captureAnchor(false, new Set(['reading']))
assert.ok(anchor)
const beforeRestore = scans
await viewport!.restoreAnchor(anchor, false)
assert.equal(scans, beforeRestore, 'an unchanged reading element is restored directly')
app.unmount()

console.log('conversation viewport tests passed')
