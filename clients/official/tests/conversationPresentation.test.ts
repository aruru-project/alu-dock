import assert from 'node:assert/strict'
import { createLiveConversationProjector, standardToolCallPreview, toolDetailText } from '../src/lib/conversation.ts'
import { BinaryChunkCollector } from '../src/lib/binaryChunkCollector.ts'
import { assistantMarkdownSource } from '../src/lib/conversationPresentation.ts'
import type { ConversationBootstrap, ConversationProcessItem, ProjectedEvent } from '../src/lib/types.ts'

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

const largeImage = new Uint8Array(6 * 1024 * 1024 + 17)
for (let index = 0; index < largeImage.byteLength; index += 1) largeImage[index] = index % 251
const receivedBeforeCommandResult = new BinaryChunkCollector()
for (let offset = 0; offset < largeImage.byteLength; offset += 256 * 1024) {
  receivedBeforeCommandResult.push(largeImage.subarray(offset, Math.min(offset + 256 * 1024, largeImage.byteLength)))
}
const reconstructedLargeImage = await receivedBeforeCommandResult.finish(largeImage.byteLength)
assert.equal(Buffer.compare(Buffer.from(reconstructedLargeImage), Buffer.from(largeImage)), 0, 'images larger than the former failing range survive chunk reassembly')

const commandResultBeforeLastChunk = new BinaryChunkCollector()
const pendingImage = commandResultBeforeLastChunk.finish(5)
commandResultBeforeLastChunk.push(Uint8Array.from([1, 2]))
commandResultBeforeLastChunk.push(Uint8Array.from([3, 4, 5]))
assert.deepEqual(Array.from(await pendingImage), [1, 2, 3, 4, 5], 'channel chunks may finish after the invoke result')

const oversizedTransfer = new BinaryChunkCollector()
oversizedTransfer.push(Uint8Array.from([1, 2, 3]))
await assert.rejects(oversizedTransfer.finish(2), /超出预期大小/, 'a transfer cannot exceed the command-declared byte count')

function toolEvent(sequence: number, eventType: string, data: Record<string, unknown>): ProjectedEvent {
  return { sequence, runtimeGeneration: 1, occurredAt: '2026-08-25T00:00:00Z', eventType, data }
}

console.log('conversation presentation tests passed')
