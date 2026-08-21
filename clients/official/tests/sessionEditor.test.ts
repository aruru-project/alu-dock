import assert from 'node:assert/strict'
import { editorAfterSessionReplacement } from '../src/lib/sessionEditor.ts'

assert.deepEqual(editorAfterSessionReplacement(), {
  text: '',
  attachments: [],
  restoredImageCount: 0,
})
assert.deepEqual(editorAfterSessionReplacement('Host 返回的编辑内容'), {
  text: 'Host 返回的编辑内容',
  attachments: [],
  restoredImageCount: 0,
})
assert.equal(editorAfterSessionReplacement('').text, '', '显式空 editorText 也必须替换旧草稿')

console.log('session editor tests passed')
