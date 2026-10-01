import assert from 'node:assert/strict'
import { projectRecordGroups, createLiveConversationProjector, shellRunQuote, standardToolCallPreview, toolDetailText } from '../src/lib/conversation.ts'
import { assistantMarkdownSource, conversationRows, conversationSections, formatTurnDuration, reconcileTurnOverrides, turnDurationMs, turnHidingAnchor, turnToolCallsLabel } from '../src/lib/conversationPresentation.ts'
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
assert.equal(projector.snapshot()[0]?.kind, 'turn', 'a projector created while running opens the turn the read found in progress')
assert.equal(projector.snapshot()[1], liveTool, 'tool updates preserve the original part')
assert.equal(liveTool.preview?.body, `…${'文'.repeat(280)}`)
assert.equal(liveTool.detail, undefined, 'full detail is assembled only on explicit expansion')
assert.match(toolDetailText(liveTool), /"content": "文+/)
projector.apply(toolEvent(702, 'tool.completed', { toolCallId: 'write-1', text: '写入完成' }))
assert.equal(projector.snapshot()[1], liveTool, 'completion updates the same indexed tool')
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

// History has no run boundaries: a user message opens a turn that ends at the last
// message record before the next user message.
const record = (recordId: string, source: string, content: HistoryRecord['content'], extra: Partial<HistoryRecord> = {}): HistoryRecord =>
  ({ recordId, entryId: recordId, kind: 'message', source, visibility: 'conversation', content, ...extra }) as HistoryRecord
const historyItems = projectRecordGroups([
  record('u1', 'user', [{ type: 'text', text: '查一下' }], { timestamp: '2026-01-01T00:00:00Z' }),
  record('a1', 'assistant', [{ type: 'text', text: '好' }, { type: 'tool_call', toolCallId: 'c1', toolName: 'read', args: { path: 'a' } }], { timestamp: '2026-01-01T00:00:05Z', stopReason: 'toolUse' }),
  record('t1', 'tool', [{ type: 'tool_result', toolCallId: 'c1', toolName: 'read', text: 'ok', isError: false }], { timestamp: '2026-01-01T00:00:09Z', toolCallId: 'c1' }),
  record('a2', 'assistant', [{ type: 'text', text: '查完了。' }], { timestamp: '2026-01-01T00:04:13Z', stopReason: 'stop' }),
  { recordId: 's1', entryId: 's1', kind: 'compaction_summary', source: 'runtime', visibility: 'conversation', timestamp: '2026-01-01T00:05:00Z', content: [{ type: 'text', text: '摘要' }] } as HistoryRecord,
  record('u2', 'user', [{ type: 'text', text: '再来' }], { timestamp: '2026-01-01T00:06:00Z' }),
  record('a3', 'assistant', [{ type: 'text', text: '开始' }, { type: 'tool_call', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } }], { timestamp: '2026-01-01T00:06:03Z', stopReason: 'toolUse' }),
  record('t2', 'tool', [{ type: 'tool_result', toolCallId: 'c2', toolName: 'bash', text: 'aborted', isError: true }], { timestamp: '2026-01-01T00:06:20Z', toolCallId: 'c2' }),
])
const historyTurns = historyItems.filter((item) => item.kind === 'turn')
assert.equal(historyTurns.length, 2, '每条用户消息开启一轮')
assert.ok(historyTurns[0]?.kind === 'turn' && historyTurns[1]?.kind === 'turn')
assert.deepEqual([historyTurns[0].status, historyTurns[0].startedAt, historyTurns[0].endedAt], ['completed', '2026-01-01T00:00:00Z', '2026-01-01T00:04:13Z'], '历史轮用时 = 最后一条记录时间戳 − 用户消息时间戳')
assert.equal(historyItems.find((item) => item.id === 's1')?.turnId, undefined, '两轮之间的上下文摘要是独立行')
assert.equal(historyItems.find((item) => item.kind === 'tool' && item.toolCallId === 'c1')?.turnId, 'turn:u1')
assert.deepEqual([historyTurns[1].status, historyTurns[1].endedAt], ['interrupted', '2026-01-01T00:06:20Z'], '最后一轮停在工具调用上就是未完成')
const historySections = conversationSections(conversationRows(historyItems))
assert.deepEqual(historySections.map((section) => section.kind === 'turn' ? `turn:${section.id}` : `row:${section.id}`), ['turn:turn:u1', 'row:record:s1', 'turn:turn:u2'])
const firstSection = historySections[0]
assert.ok(firstSection?.kind === 'turn')
assert.equal(firstSection.toolCalls, 1)
assert.equal(firstSection.finalRowId, 'record:a2', '最终回复是这一轮最后一条 Agent 消息')

const failedHistoryItems = projectRecordGroups([
  record('u9', 'user', [{ type: 'text', text: '试试' }], { timestamp: '2026-01-01T01:00:00Z' }),
  record('a9', 'assistant', [], { timestamp: '2026-01-01T01:00:02Z', stopReason: 'error', error: 'model failed' }),
])
const failedHistory = failedHistoryItems.find((item) => item.kind === 'turn')
assert.ok(failedHistory?.kind === 'turn' && failedHistory.status === 'failed' && failedHistory.error === 'model failed', '失败的历史轮把错误带到摘要行')
assert.equal(failedHistoryItems.some((item) => item.kind === 'notice'), false, '摘要行已经显示的错误不再重复成一条提示')

// A read that finds the run in progress: the live segment continues the last history turn.
const liveRunning = createLiveConversationProjector({ instance: { id: 'work', execution: 'running' } } as ConversationBootstrap)
liveRunning.apply(toolEvent(30, 'message.delta', { messageId: 'reply', block: 'text', delta: '继续' }))
const midRunHistory = [...historyItems,
  { id: 'record:s2', kind: 'record' as const, title: '上下文摘要', panelClass: 'alu-record-summary', folded: true, parts: [] },
  { id: 'record:x1', kind: 'record' as const, title: '扩展消息', panelClass: 'alu-record-extension', folded: false, parts: [] },
]
const merged = conversationSections(conversationRows([...midRunHistory, ...liveRunning.snapshot()]))
assert.equal(merged.length, 3, '续上的实时段不会多出一轮')
const continued = merged[2]
assert.ok(continued?.kind === 'turn' && continued.status === 'running' && continued.startedAt === '2026-01-01T00:06:00Z' && continued.endedAt === undefined, '合并后用历史的开始时间和实时的运行状态')
assert.deepEqual(continued.body.map((row) => row.id), ['record:a3', 'record:s2', 'record:x1', 'live-message:reply'], '两段之间的摘要和扩展消息并入这轮时保持原来的顺序')
assert.equal(continued.finalRowId, 'live-message:reply')
liveRunning.apply(toolEvent(31, 'run.settled', { result: 'aborted' }))
const settled = conversationSections(conversationRows([...historyItems, ...liveRunning.snapshot()]))[2]
assert.ok(settled?.kind === 'turn' && settled.status === 'aborted' && settled.endedAt === '2026-08-25T00:00:00Z')

assert.equal(formatTurnDuration(253_000, false), '4m 13s')
assert.equal(formatTurnDuration(42_000, true), '0:42')
assert.equal(formatTurnDuration(3_725_000, true), '1:02:05')
assert.equal(formatTurnDuration(3_725_000, false), '1h 02m')
assert.equal(formatTurnDuration(9_000, false), '9s')
assert.equal(turnDurationMs({ status: 'running', startedAt: '2026-01-01T00:00:00Z' }, Date.parse('2026-01-01T00:00:42Z')), 42_000, '运行中的轮按当前时间计时')
assert.equal(turnDurationMs({ status: 'completed', endedAt: '2026-01-01T00:00:42Z' }, 0), undefined, '没有开始时间就不显示用时')
assert.equal(turnDurationMs({ status: 'interrupted', startedAt: '2026-01-01T00:00:00Z' }, Date.parse('2026-01-08T00:00:00Z')), undefined, '没有结束时间的历史轮不拿当前时间充数')

// The reader's own choice for a turn survives settlement and the live→history id change.
const overrides = new Map<string, boolean>([['live-turn-9', false]])
reconcileTurnOverrides(overrides, ['turn:u1', 'live-turn-9'], ['turn:u1', 'live-turn-9'], ['live-turn-9'], true)
assert.equal(overrides.get('live-turn-9'), false, '读者运行中手动收起的轮，结束时不会被强制展开')
overrides.set('live-turn-9', true)
reconcileTurnOverrides(overrides, ['turn:u1', 'live-turn-9'], ['turn:u1', 'live-turn-9'], ['live-turn-9'], false)
assert.equal(overrides.get('live-turn-9'), true, '读者手动展开的轮，在底部结束时不会被收起')
reconcileTurnOverrides(overrides, ['turn:u1', 'live-turn-9'], ['turn:u1', 'turn:u9'], [], false)
assert.deepEqual([...overrides], [['turn:u9', true]], '实时轮变成历史轮后，选择跟到同一位置的新 id')
const untouched = new Map<string, boolean>()
reconcileTurnOverrides(untouched, ['live-turn-10'], ['live-turn-10'], ['live-turn-10'], false)
assert.equal(untouched.size, 0, '没有选择过的轮在底部结束时按默认收起')
reconcileTurnOverrides(untouched, ['live-turn-10'], ['live-turn-10'], ['live-turn-10'], true)
assert.equal(untouched.get('live-turn-10'), true, '读者已离开底部时，结束的轮保持展开')
const handedOff = new Map<string, boolean>()
reconcileTurnOverrides(handedOff, ['turn:u1', 'live-turn-11'], ['turn:u1', 'turn:u11'], ['live-turn-11'], true)
assert.equal(handedOff.get('turn:u11'), true, '结束和实时转历史同时发生时，保持展开落到同一位置的新 id 上')

// A saved reading position inside a collapsed turn's process names the turn to open.
assert.equal(turnHidingAnchor(historySections, 'a1-1')?.id, 'turn:u1', '阅读位置落在折起的工具调用上时，需要展开那一轮')
assert.equal(turnHidingAnchor(historySections, 'a2-0'), undefined, '最终回复本来就可见，不用展开')
assert.equal(turnHidingAnchor(historySections, 'record:a1')?.id, 'turn:u1', '阅读位置落在被折起的中间回复行上时同样展开')
assert.equal(turnHidingAnchor(historySections, 'u1'), undefined, '用户消息不在折叠范围内')
assert.equal(turnHidingAnchor(historySections, undefined), undefined)
assert.equal(turnToolCallsLabel({ status: 'running', toolCalls: 2, failedToolCalls: 0 }), '已调用 2 个工具')
assert.equal(turnToolCallsLabel({ status: 'completed', toolCalls: 3, failedToolCalls: 1 }), '3 次工具调用（1 次失败）')

// Card #336: a user shell command (`!` / `!!`) is its own row beside the Agent's
// turn, streams output, and the same row later comes from its bash_execution record.
{
  const shell = createLiveConversationProjector({ instance: { id: 'work', execution: 'idle' } } as ConversationBootstrap)
  shell.apply(toolEvent(1, 'run.started', { operationId: 'reply' }))
  shell.apply(toolEvent(2, 'bash.started', { operationId: 'sh-1', command: 'git status', excludeFromContext: true }))
  shell.apply(toolEvent(3, 'bash.output', { operationId: 'sh-1', delta: 'On branch ' }))
  shell.apply(toolEvent(4, 'bash.output', { operationId: 'sh-1', delta: 'master\n' }))
  const running = shell.snapshot().find((item) => item.kind === 'shell')
  assert.ok(running?.kind === 'shell')
  assert.equal(running.status, 'running')
  assert.equal(running.output, 'On branch master\n')
  assert.equal(running.turnId, undefined, '命令行不归进正在运行的 Agent 轮')
  shell.apply(toolEvent(5, 'run.settled', { operationId: 'reply', result: 'succeeded' }))
  assert.equal(running.status, 'running', '回复结束不会把还在跑的命令标成结束')
  shell.apply(toolEvent(6, 'bash.completed', { operationId: 'sh-1', exitCode: 0, cancelled: false, truncated: true, fullOutputPath: '/tmp/pi-bash-1.log' }))
  assert.equal(running.status, 'done')
  assert.equal(running.fullOutputPath, '/tmp/pi-bash-1.log')
  const sections = conversationSections(conversationRows(shell.snapshot()))
  assert.deepEqual(sections.map((section) => section.kind), ['turn', 'row'], '命令行是独立行，不在轮里')
  assert.equal(shellRunQuote(running), 'Ran `git status`\n```\nOn branch master\n\n```\n[Output truncated. Full output: /tmp/pi-bash-1.log]', '引用文字与 Pi 给模型的正文同形，截断时带路径')
  shell.apply(toolEvent(7, 'bash.started', { operationId: 'sh-2', command: 'sleep 30', excludeFromContext: false }))
  shell.apply(toolEvent(8, 'bash.completed', { operationId: 'sh-2', cancelled: true, truncated: false }))
  const stopped = shell.snapshot().find((item) => item.kind === 'shell' && item.operationId === 'sh-2')
  assert.ok(stopped?.kind === 'shell')
  assert.equal(stopped.status, 'stopped')
  assert.equal(shellRunQuote(stopped), 'Ran `sleep 30`\n(no output)\n(command cancelled)')

  // Review follow-up: a client that opens the Work mid-command has not seen its output. It must
  // say so rather than show an empty result, while a rebuild keeps what this client did see.
  const late = createLiveConversationProjector({ instance: { id: 'work', execution: 'idle' } } as ConversationBootstrap)
  late.apply(toolEvent(30, 'bash.started', { operationId: 'sh-late', command: 'make', excludeFromContext: true }), true)
  const lateItem = late.snapshot().find((item) => item.kind === 'shell')
  assert.ok(lateItem?.kind === 'shell')
  assert.equal(lateItem.outputMissing, true, '回放的开始事件意味着之前的输出没有到达这里')
  late.apply(toolEvent(31, 'bash.completed', { operationId: 'sh-late', exitCode: 0, cancelled: false, truncated: false }))
  assert.equal(lateItem.outputMissing, true, '完成不会把缺失的输出变成「没有输出」')
  const rebuilt = createLiveConversationProjector({ instance: { id: 'work', execution: 'idle' } } as ConversationBootstrap)
  rebuilt.apply(toolEvent(32, 'bash.started', { operationId: 'sh-1', command: 'git status', excludeFromContext: true }), true)
  rebuilt.adoptShellOutput([{ ...running, status: 'running', output: 'seen so far\n' }])
  const adopted = rebuilt.snapshot().find((item) => item.kind === 'shell')
  assert.ok(adopted?.kind === 'shell')
  assert.equal(adopted.output, 'seen so far\n', '重建后保留这个客户端已经看到的输出')
  assert.equal(adopted.outputMissing, undefined)
  // A command that finished while the agent was replying: Pi holds its record until the reply ends, so
  // the completion-triggered rebuild still shows it as a live row. The output seen must survive that too.
  const heldBack = createLiveConversationProjector({ instance: { id: 'work', execution: 'running' } } as ConversationBootstrap)
  heldBack.apply(toolEvent(33, 'bash.started', { operationId: 'sh-1', command: 'git status', excludeFromContext: true }), true)
  heldBack.apply(toolEvent(34, 'bash.completed', { operationId: 'sh-1', exitCode: 0, cancelled: false, truncated: false }), true)
  heldBack.adoptShellOutput([{ ...running, status: 'done', exitCode: 0, output: 'all of it\n' }])
  const held = heldBack.snapshot().find((item) => item.kind === 'shell')
  assert.ok(held?.kind === 'shell')
  assert.deepEqual([held.status, held.output, held.outputMissing], ['done', 'all of it\n', undefined], '回复结束前记录还没写入，已经看到的完整输出和「发给 agent」不能消失')
  // Joined mid-command, then saw the rest: the part received stays, still marked incomplete.
  heldBack.adoptShellOutput([{ ...running, status: 'done', exitCode: 0, output: 'the rest\n', outputMissing: true }])
  assert.deepEqual([held.output, held.outputMissing], ['the rest\n', true], '中途进入后收到的部分保留，仍然标为不完整')

  const recorded = projectRecordGroups([{
    recordId: 'bash-1', entryId: 'bash-1', kind: 'bash_execution', source: 'runtime', visibility: 'conversation', timestamp: '2026-09-30T08:05:00Z',
    content: [{ type: 'text', text: '! false\nnothing here' }], command: 'false', exitCode: 1, cancelled: false, truncated: false, excludeFromContext: false,
  } as HistoryRecord])
  const record = recorded[0]
  assert.ok(record?.kind === 'shell', '历史里的 bash_execution 记录也是同一种命令行')
  assert.equal(record.command, 'false')
  assert.equal(record.output, 'nothing here', '记录正文里的命令前缀不当作输出')
  assert.equal(record.status, 'failed')
  assert.equal(record.exitCode, 1)
  assert.equal(record.excludeFromContext, false)
}

console.log('conversation presentation tests passed')
