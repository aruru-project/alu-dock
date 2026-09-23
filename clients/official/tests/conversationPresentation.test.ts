import assert from 'node:assert/strict'
import { projectRecordGroups, createLiveConversationProjector, standardToolCallPreview, toolDetailText } from '../src/lib/conversation.ts'
import { assistantMarkdownSource } from '../src/lib/conversationPresentation.ts'
import type { HistoryRecord, ConversationBootstrap, ConversationProcessItem, ProjectedEvent } from '../src/lib/types.ts'

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
assert.equal(writePreview?.body, '…  const second = 2\n  return first + second\n}\nignored')
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

const projector = createLiveConversationProjector({ instance: { id: 'work', execution: 'running' } } as ConversationBootstrap)
projector.apply(toolEvent(1, 'tool.started', { toolCallId: 'write-1', toolName: 'write', args: { path: 'tmp/result.md', content: '' } }))
const liveTool = projector.snapshot().find((part) => part.kind === 'tool') as Extract<ConversationProcessItem, { kind: 'tool' }>
for (let index = 1; index <= 500; index++) projector.apply(toolEvent(index + 1, 'tool.args_updated', { toolCallId: 'write-1', args: { path: 'tmp/result.md', content: '文'.repeat(index * 10) } }))
for (let index = 1; index <= 200; index++) projector.apply(toolEvent(index + 501, 'tool.output_updated', { toolCallId: 'write-1', text: `output-${index}` }))
assert.equal(projector.snapshot()[0], liveTool, 'tool updates preserve the original part')
assert.equal(liveTool.preview?.body, `…${'文'.repeat(280)}`)
assert.equal(liveTool.detail, undefined, 'full detail is assembled only on explicit expansion')
assert.match(toolDetailText(liveTool), /"content": "文+/)
projector.apply(toolEvent(702, 'tool.completed', { toolCallId: 'write-1', text: '写入完成' }))
assert.equal(projector.snapshot()[0], liveTool, 'completion updates the same indexed tool')
assert.equal(liveTool.status, 'done')
assert.match(toolDetailText(liveTool), /结果\n写入完成/)
assert.match(toolDetailText(liveTool), /参数\n\{/)

function toolEvent(sequence: number, eventType: string, data: Record<string, unknown>): ProjectedEvent {
  return { sequence, runtimeGeneration: 1, occurredAt: '2026-08-25T00:00:00Z', eventType, data }
}

// Master-side review: hydration upgraded the source and retired an open image
// by changing its display key, despite identical occurrence/ref identity.
const imageRecord = { entryId: 'entry', recordId: 'entry', kind: 'message', source: 'user', visibility: 'conversation', content: [{ type: 'image', mimeType: 'image/png', contentRef: 'opaque-ref' }] } as HistoryRecord
const imageParts = (record: HistoryRecord) => projectRecordGroups([record]).flatMap(item => item.kind === 'user' ? item.images ?? [] : [])
const beforeImage = imageParts(imageRecord)[0]!
const afterImage = imageParts({ ...imageRecord, content: [{ ...imageRecord.content[0]!, nativeMedia: { handle: 'verified', mimeType: 'image/png', sizeBytes: 10, sha256: 'digest' } }] } as HistoryRecord)[0]!
assert.equal(afterImage.imageKey, beforeImage.imageKey)
assert.equal(afterImage.id, beforeImage.id)
assert.equal(afterImage.source?.type, 'native', 'resource source can improve without retiring the displayed image')

console.log('conversation presentation tests passed')
