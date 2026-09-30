import assert from 'node:assert/strict'

// 2026-09-30 OOM: Node's failure diff recursively inspected a rendered button's
// parent/children/Vue graph. Compare identity first; only booleans reach the diff.
export function assertSameReference(actual, expected, message) {
  assert.equal(Object.is(actual, expected), true, message)
}
