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

// Reading intent survives a disposable view, while a user's new gesture and a
// genuine Session replacement win over a delayed content seed. Geometry is a
// DOM boundary fixture here; actual layout/interaction is checked in the browser.
const { readConversationPosition, saveConversationPosition } = await import('../src/lib/localState.ts')
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } as Storage
const events = new Map<string, EventListener>()
;(globalThis as any).window = { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, addEventListener() {}, removeEventListener() {} }
let loaded = false, top = 0, logicalTop = 1000
const entry = { dataset: { conversationId: 'stable-entry' }, isConnected: true, getBoundingClientRect: () => ({ top: logicalTop - top, bottom: logicalTop - top + 100 }) }
const scroller = {
  ownerDocument: {},
  get scrollTop() { return top }, set scrollTop(value: number) { top = Math.max(0, Math.min(3600, value)) }, scrollHeight: 4000, clientHeight: 400,
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 500, bottom: 400 }), contains: (value: unknown) => loaded && value === entry,
  querySelector: (selector: string) => loaded && selector.includes('data-conversation-id') ? entry : null,
  querySelectorAll: () => loaded ? [entry] : [],
  addEventListener: (name: string, fn: EventListener) => events.set(name, fn), removeEventListener: (name: string) => events.delete(name),
}
const scope = { connectionId: 'host', workId: 'A', hostEpoch: 'epoch', sessionId: 'session-A' }
const persistence = {
  read: (s: typeof scope) => readConversationPosition(storage, s.connectionId, s.workId),
  write: (s: typeof scope, position: Parameters<typeof saveConversationPosition>[3]) => saveConversationPosition(storage, s.connectionId, s.workId, position),
}
let reader: ReturnType<typeof useConversationViewport>
function mountReader() {
  const mounted = renderer.createApp({ setup() { reader = useConversationViewport(ref(scroller as unknown as HTMLElement), persistence); return () => null } })
  mounted.mount({}); return mounted
}
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 10)) }
saveConversationPosition(storage, 'host', 'A', { hostEpoch: 'epoch', sessionId: 'session-A', following: false, id: 'stable-entry', offset: -25, scrollTop: 1025 })
let mountedReader = mountReader()
reader!.bindScope(scope); await tick()
assert.equal(top, 0, 'a saved anchor waits for its own record, without a whole-history barrier')
loaded = true; reader!.layoutChanged(); await tick()
assert.equal(top, 1025, 'the stable entry restores before the rest of the seed finishes')
reader!.seeded(); await tick()
logicalTop += 90; reader!.layoutChanged(); await tick()
assert.equal(top, 1115, 'image/body layout above the reading entry preserves its offset')
reader!.savePosition(); mountedReader.unmount()
loaded = false; top = 0
mountedReader = mountReader(); reader!.bindScope(scope); loaded = true; reader!.seeded(); await tick()
assert.equal(top, 1115, 'a newly mounted viewport consumes the DOM-free saved entry/offset')
reader!.bindScope(null); reader!.bindScope({ ...scope, workId: 'B', sessionId: 'session-B' }); reader!.seeded(); await tick()
assert.equal(top, 3600)
reader!.bindScope(null); reader!.bindScope(scope); reader!.seeded(); await tick(); assert.equal(top, 1115)
reader!.bindScope(null); loaded = false; top = 0; reader!.bindScope(scope); await tick()
events.get('wheel')?.({ type: 'wheel' } as Event); top = 400; reader!.handleScroll()
loaded = true; reader!.seeded(); await tick(); assert.equal(top, 400, 'new scrolling cancels the pending old restoration')
reader!.bindScope({ ...scope, sessionId: 'new-session' }, true); reader!.seeded(); await tick()
assert.equal(top, 3600, 'a different actual Session starts at its own end, not the old reading offset')
const previous = [...values.entries()]
const failing = { getItem: storage.getItem, setItem() { throw new Error('storage unavailable') } } as unknown as Storage
assert.equal(saveConversationPosition(failing, 'host', 'A', { hostEpoch: 'epoch', sessionId: 'new-session', following: true, scrollTop: 3600 }), false)
assert.deepEqual([...values.entries()], previous)
mountedReader.unmount()
console.log('reading position restore / Work and view rebuild / progressive layout / user precedence / new Session / small storage failure passed')
