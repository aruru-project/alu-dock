import assert from 'node:assert/strict'
import { standardToolCallPreview } from '../src/lib/conversation.ts'
import { assistantMarkdownSource } from '../src/lib/conversationPresentation.ts'
import type { ConversationProcessItem } from '../src/lib/types.ts'

const parts: ConversationProcessItem[] = [
  { id: 'thinking', kind: 'thinking', groupId: 'group', title: '思考', text: '不要复制这段' },
  { id: 'text-1', kind: 'assistant', groupId: 'group', text: '第一段 **Markdown**', time: '' },
  { id: 'tool', kind: 'tool', groupId: 'group', name: 'bash', summary: '完成', status: 'done', detail: '工具内容' },
  { id: 'text-2', kind: 'assistant', groupId: 'group', text: '```ts\nconst answer = 42\n```', time: '' },
]
assert.equal(
  assistantMarkdownSource(parts),
  '第一段 **Markdown**\n\n```ts\nconst answer = 42\n```',
  '消息原文只拼接 Agent 可见正文并保留 Markdown',
)

assert.deepEqual(standardToolCallPreview('bash', { command: 'rg -n "uploadAttachment" src/', timeout: 30 }), {
  title: 'timeout 30s',
  body: 'rg -n "uploadAttachment" src/',
  variant: 'command',
  truncated: false,
})
assert.deepEqual(standardToolCallPreview('read', { path: 'src/App.vue', offset: 620, limit: 80 }), {
  title: 'src/App.vue',
  body: 'offset 620 · limit 80',
  variant: 'path',
  truncated: false,
})

const writePreview = standardToolCallPreview('write', {
  path: 'src/example.ts',
  content: ['export function example() {', '  const first = 1', '  const second = 2', '  return first + second', '}', 'ignored'].join('\n'),
})
assert.equal(writePreview?.title, 'src/example.ts')
assert.equal(writePreview?.body, 'export function example() {\n  const first = 1\n  const second = 2\n  return first + second…')
assert.equal(writePreview?.truncated, true)
assert.equal(writePreview?.body?.includes('写入'), false, 'write 收起态必须显示原文而不是规模描述')

const editPreview = standardToolCallPreview('edit', {
  path: 'src/App.vue',
  edits: [
    { oldText: 'const oldValue = input', newText: 'const newValue = normalize(input)' },
    { oldText: 'return oldValue', newText: 'return newValue' },
  ],
})
assert.equal(editPreview?.title, 'src/App.vue · 2 处')
assert.equal(editPreview?.body, '− const oldValue = input\n＋ const newValue = normalize(input)')
assert.equal(editPreview?.truncated, true)
assert.equal(standardToolCallPreview('show_image', { path: '/private/image.png' }), undefined)

console.log('conversation presentation tests passed')
