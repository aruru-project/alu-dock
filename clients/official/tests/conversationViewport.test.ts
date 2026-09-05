import assert from 'node:assert/strict'
import {
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

console.log('conversation viewport tests passed')
