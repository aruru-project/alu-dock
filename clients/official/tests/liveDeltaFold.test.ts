// 流式 delta 折叠：同一消息的连续 delta 折叠进单个事件后，
// 整段重投影的结果必须与逐条回放完全一致（流式性能优化不改动用户可见内容）。
import { strict as assert } from 'node:assert'
import { foldLiveDelta, projectConversation } from '../src/lib/conversation.ts'
import type { ConversationBootstrap, ProjectedEvent, Work } from '../src/lib/types.ts'

function event(sequence: number, eventType: string, data: Record<string, unknown>): ProjectedEvent {
  return { sequence, runtimeGeneration: 1, occurredAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`, eventType, data }
}

function bootstrap(activeEvents: ProjectedEvent[]): ConversationBootstrap {
  return {
    instance: { id: 'work-1', execution: 'running' } as unknown as Work,
    records: [],
    activeEvents,
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
    queue: [],
    cursor: { hostEpoch: 'epoch-a', instanceId: 'work-1', runtimeGeneration: 1, sequence: 0 },
    historyRevision: 1,
    historyTruncated: false,
  }
}

// 一条长流：run.started + 500 个文本 delta + 300 个思考 delta + 一次工具事件插在中间
// 每条路径用独立的事件对象（生产里每个事件只到达一次；测试里复用对象会被折叠改写）
function makeStream(): ProjectedEvent[] {
  const stream: ProjectedEvent[] = [event(1, 'run.started', {})]
  let seq = 1
  for (let i = 0; i < 500; i++) stream.push(event(++seq, 'message.delta', { messageId: 'm1', block: 'text', delta: `词${i} ` }))
  for (let i = 0; i < 300; i++) stream.push(event(++seq, 'message.delta', { messageId: 'm1', block: 'thinking', delta: `想${i} ` }))
  stream.splice(100, 0, event(900, 'tool.started', { toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }))
  return stream
}

// 折叠版
const foldedEvents: ProjectedEvent[] = []
const foldMap = new Map<string, ProjectedEvent>()
for (const item of makeStream()) {
  if (item.eventType === 'message.delta') foldLiveDelta(foldedEvents, foldMap, item)
  else foldedEvents.push(item)
}
const expected = projectConversation(bootstrap(makeStream()))
const actual = projectConversation(bootstrap(foldedEvents))
assert.deepEqual(actual, expected, '折叠后与逐条回放的投影必须逐字段一致')

const activeThinking = projectConversation(bootstrap([
  event(1, 'message.delta', { messageId: 'm2', block: 'thinking', delta: '还在思考' }),
])).find((item) => item.kind === 'thinking')
assert.equal(activeThinking?.kind === 'thinking' && activeThinking.open, true, '正在生成的思考默认展开')

const completedThinking = projectConversation(bootstrap([
  event(1, 'message.delta', { messageId: 'm2', block: 'thinking', delta: '还在思考' }),
  event(2, 'message.completed', {
    messageId: 'm2',
    role: 'assistant',
    content: [
      { type: 'thinking', text: '思考完成' },
      { type: 'text', text: '最终回复' },
    ],
  }),
])).find((item) => item.kind === 'thinking')
assert.equal(completedThinking?.kind === 'thinking' && completedThinking.open, false, '未操作的思考在回复完成后折叠')
// 2026-09-07: independently produced text deltas blocked send receipts in the
// real App. Exercise the content owner with a held presentation frame so bursts,
// completion and intervening rebuilds retain exactly the text the user received.
const { createServer } = await import('vite')
const { fileURLToPath } = await import('node:url')
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false, server: { middlewareMode: true }, appType: 'custom',
})
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const previousWindow = globalThis.window
globalThis.window = {
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
  cancelAnimationFrame: (id: number) => { frames.delete(id) },
} as unknown as Window & typeof globalThis
try {
  const { useConversationContent } = await server.ssrLoadModule('/src/lib/conversationContent.ts')
  const content = useConversationContent({
    compact: { value: false }, native: false, getEpoch: () => 1,
    getContext: () => ({ connectionId: 'host', selectionGeneration: 1 }),
    isCurrent: () => true, reload: () => assert.fail('unexpected reload'),
    beforeLayoutChange: () => null, afterLayoutChange: async () => {},
    isFollowing: () => false, layoutChanged: () => {}, projected: () => {},
  })
  const flush = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  }
  const text = (kind = 'assistant') => content.items.value.find((item: { kind: string }) => item.kind === kind)?.text
  const send = (sequence: number, eventType: string, data: Record<string, unknown>) => {
    content.applyConversationEvent(content.state.value, event(sequence, eventType, data), true)
  }
  const delta = (sequence: number, value: string, block = 'text') => send(sequence, 'message.delta', { messageId: 'm', block, delta: value })
  const start = () => {
    content.publish(bootstrap([]))
    delta(1, 'Hello')
    delta(2, 'Think', 'thinking')
    flush()
  }

  start()
  delta(3, ' ')
  delta(4, 'world')
  delta(5, ' more', 'thinking')
  assert.equal(content.state.value.activeEvents[0].data.delta, 'Hello world', 'canonical text is current before paint')
  assert.equal(text(), 'Hello', 'a held frame leaves the previous text visible instead of repainting each token')
  flush()
  assert.equal(text(), 'Hello world')
  assert.equal(text('thinking'), 'Think more')
  assert.equal(content.streamingPartIds.value.has('live-m'), true)

  delta(6, '!')
  content.reproject(content.state.value)
  delta(7, '?')
  flush()
  assert.equal(text(), 'Hello world!?', 'a synchronous rebuild consumes queued text exactly once')
  delta(8, '.')
  send(9, 'tool.started', { toolCallId: 't', toolName: 'bash', args: { command: 'pwd' } })
  flush()
  assert.equal(text(), 'Hello world!?.', 'a shared full projection does not append pending text twice')
  delta(10, ' together')
  send(11, 'tool.output_updated', { toolCallId: 't', text: 'workdir' })
  flush()
  assert.equal(text(), 'Hello world!?. together', 'text and tool output share the same presentation frame')
  assert.equal(content.items.value.find((item: { kind: string }) => item.kind === 'tool')?.detailOutputText, 'workdir')
  delta(12, ' hydrated')
  await content.appendHistoricalRecords([{ recordId: 'earlier', entryId: 'earlier', kind: 'message', source: 'user', visibility: 'conversation', content: [{ type: 'text', text: 'Earlier' }] }])
  flush()
  assert.equal(text(), 'Hello world!?. together hydrated', 'history updates consume pending live text exactly once')

  delta(13, ' provisional')
  send(14, 'message.completed', { messageId: 'm', role: 'assistant', content: [{ type: 'text', text: '**Final**' }] })
  flush()
  assert.equal(text(), '**Final**', 'completion replaces provisional text before the Markdown transition')
  assert.equal(content.streamingPartIds.value.has('live-m'), false)
  assert.equal(content.streamingPartIds.value.has('live-m-thinking'), false)

  start()
  delta(3, ' retained')
  send(4, 'run.settled', { result: 'aborted' })
  flush()
  assert.equal(text(), 'Hello retained', 'settling before paint keeps the last received text')
  assert.equal(content.streamingPartIds.value.size, 0)

  start()
  delta(3, ' old generation')
  content.publish(bootstrap([event(1, 'message.delta', { messageId: 'm', block: 'text', delta: 'Reloaded' })]))
  flush()
  assert.equal(text(), 'Reloaded', 'reload replaces pending presentation from the previous conversation')
  delta(2, ' discarded')
  content.resetProjectionSchedule()
  flush()
  assert.equal(text(), 'Reloaded', 'switching away cancels the old presentation')
  content.reproject(content.state.value)
  assert.equal(text(), 'Reloaded discarded', 'cancelling paint does not discard canonical text')
  delta(3, ' cleared')
  content.clear()
  flush()
  assert.deepEqual(content.items.value, [], 'clearing a conversation does not allow a pending frame to resurrect it')
  content.dispose()
} finally {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else globalThis.window = previousWindow
  await server.close()
}
console.log('live delta fold and presentation lifecycle tests passed')
