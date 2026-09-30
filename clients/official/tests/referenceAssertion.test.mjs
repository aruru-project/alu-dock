import assert from 'node:assert/strict'
import { assertSameReference } from './referenceAssertion.mjs'

// 2026-09-30: a missing-button assertion tried to print the real rendered App,
// grew to 66 GiB and caused a system OOM. Fail without inspecting that graph.
let inspected = 0
const button = {
  tagName: 'BUTTON',
  get parent() { inspected++; return button },
  get children() { inspected++; return [button] },
}
assertSameReference(button, button)
assertSameReference(undefined, undefined)
for (const expected of [undefined, { tagName: 'BUTTON' }]) {
  assert.throws(() => assertSameReference(button, expected, 'button identity or presence changed'), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION')
    assert.equal(error.actual, false)
    assert.equal(error.expected, true)
    assert.match(error.message, /button identity or presence changed/)
    return true
  })
}
assert.equal(inspected, 0, 'failure diagnostics never inspect rendered element links')
console.log('PASS: rendered-element failures report identity/presence without inspecting the App graph')
