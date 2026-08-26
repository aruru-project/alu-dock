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
console.log('live delta fold tests passed')
