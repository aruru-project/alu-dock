import { strict as assert } from 'node:assert'
import { computed, nextTick, ref, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { nestedCallRows, projectConversation, toolDetailText } from '../src/lib/conversation.ts'
import { conversationRows, conversationSections, partVisibleWhenCollapsed, rowVisibleWhenCollapsed } from '../src/lib/conversationPresentation.ts'
import { reduceLiveEvent, type LiveProjectionState } from '../src/lib/liveReducer.ts'
import { conversationBoundaryKey, conversationReadMatches, draftAfterSubmit, formatCacheHitRate, formatContextUsage, formatTokenCount, initialWindowFocused, stopCanStart, stopConfirmationText, stoppedResultIsCorrelated } from '../src/lib/uiBoundaries.ts'
import { dockToolsState, genericExtensionStatus } from '../src/lib/dockTools.ts'
import { userErrorMessage } from '../src/lib/userError.ts'
import type { ConversationBootstrap, ProjectedEvent, Work } from '../src/lib/types.ts'
import { useCommandConsoleStore } from '../src/stores/command-console.ts'

const work = makeWork()
let state: LiveProjectionState = { connectionId: 'host-a', selectionGeneration: 4, hostEpoch: 'epoch-a', instance: work, queue: [], sequence: 0 }

setActivePinia(createPinia())
const commandConsole = useCommandConsoleStore()
commandConsole.bindContext('host-a', 4, work)
commandConsole.beginOperation('command-operation', 'dock-tools', 'summary')
assert.equal(commandConsole.handleDockEvent(event(1, 'extension.notification', { operationId: 'ordinary-operation', message: 'not this command' })).matched, false)
assert.equal(commandConsole.handleDockEvent(event(2, 'extension.notification', { operationId: 'command-operation', message: '完整命令输出，不进入主要对话。' })).matched, true)
commandConsole.handleDockEvent(event(3, 'command.handled', { operationId: 'command-operation' }))
assert.equal(commandConsole.hasActiveOperation, false)
assert.deepEqual(commandConsole.entries.map((entry) => entry.text), ['/dock-tools summary', '完整命令输出，不进入主要对话。'])
commandConsole.bindContext('host-a', 4, work)
assert.equal(commandConsole.entries.length, 2, 'closing and reopening Command Center in the same Work preserves command history')
commandConsole.bindContext('host-a', 5, work)
assert.equal(commandConsole.entries.length, 0, 'a Host-selection boundary cannot inherit another conversation command history')
assert.equal(commandConsole.handleDockEvent(event(4, 'command.handled', { operationId: 'command-operation' })).matched, false, 'a Host-selection boundary also forgets earlier command success correlation')

commandConsole.beginOperation('reload-success', 'dock-tools', 'on')
commandConsole.handleDockEvent(event(4, 'command.handled', { operationId: 'reload-success' }))
assert.equal(commandConsole.failOperation('reload-success', '操作没有完成'), false, 'observed command success wins over a late transport failure')
assert.equal(commandConsole.entries.some((entry) => entry.level === 'error'), false)
commandConsole.beginOperation('command-failure', 'dock-tools', 'off')
assert.equal(commandConsole.failOperation('command-failure', '命令执行失败。'), true)
assert.equal(commandConsole.failOperation('command-failure', '重复失败。'), false)
assert.equal(commandConsole.entries.filter((entry) => entry.level === 'error').length, 1)

assert.equal(dockToolsState({ 'Dock tools': 'on' }), 'on')
assert.equal(dockToolsState({}), 'off')
assert.deepEqual(genericExtensionStatus({ 'Dock tools': 'on', Branch: 'main' }), { Branch: 'main' })
assert.equal(initialWindowFocused(false, true, false), true, 'a focused Windows WebView restores the selected Work even when the native focus snapshot races reload')
assert.equal(initialWindowFocused(false, false, false), false, 'an actually unfocused desktop window keeps its conversation Follow detached')

state = applied(state, event(1, 'run.started', {}))
assert.equal(state.instance.execution, 'running', 'run.started enables Abort-facing running state')
state = applied(state, event(2, 'tool.started', { toolCallId: 'tool-1', toolName: 'bash', args: { command: 'rg runtime src/' } }))
state = applied(state, event(3, 'run.settled', { result: 'failed', error: 'model failed' }))
assert.equal(state.instance.execution, 'failed')
assert.equal(state.instance.lastRun, 'failed')
assert.equal(state.instance.lastError, 'model failed')

const failedProjection = projectConversation(bootstrap(state, [
  event(1, 'run.started', {}),
  event(2, 'tool.started', { toolCallId: 'tool-1', toolName: 'bash', args: { command: 'rg runtime src/' } }),
  event(3, 'tool.args_updated', { toolCallId: 'tool-1', toolName: 'bash', args: { command: 'rg -n "runtimeGeneration" src/' } }),
  event(4, 'run.settled', { result: 'failed', error: 'model failed' }),
]))
assert.equal(failedProjection.find((item) => item.kind === 'tool')?.kind, 'tool')
assert.equal(failedProjection.find((item) => item.kind === 'tool' && item.id === 'live-tool-tool-1')?.status, 'error', 'settlement terminalizes unfinished tools')
assert.equal(failedProjection.find((item) => item.kind === 'tool' && item.id === 'live-tool-tool-1')?.preview?.body, 'rg -n "runtimeGeneration" src/', 'updated live standard tool arguments replace the earlier collapsed preview')
assert.equal(failedProjection.some((item) => item.kind === 'notice' && item.text === 'model failed'), false, 'the turn summary owns the run outcome; no separate notice repeats it')
const failedTurn = failedProjection.find((item) => item.kind === 'turn')
assert.ok(failedTurn?.kind === 'turn')
assert.equal(failedTurn.status, 'failed')
assert.equal(failedTurn.error, 'model failed')
assert.equal(failedTurn.endedAt, '2026-01-01T00:00:04Z', 'run.settled closes the live turn at its own time')
assert.equal(failedProjection.find((item) => item.kind === 'tool')?.turnId, 'live-turn-1', 'tool calls belong to the turn that ran them')
// A rebuilt replay can carry the settle of a run that was in progress when the
// read began, with the Work already idle: that segment still belongs to the run.
const settledInReplay = projectConversation(bootstrap(state, [event(2, 'message.delta', { messageId: 'tail', block: 'text', delta: '收尾' }), event(3, 'run.settled', { result: 'aborted' })]))
const replayTurn = settledInReplay.find((item) => item.kind === 'turn')
assert.ok(replayTurn?.kind === 'turn' && replayTurn.continuation === true && replayTurn.status === 'aborted', 'a replay whose first run boundary is a settle continues the run it settles')
assert.equal(settledInReplay.find((item) => item.kind === 'assistant')?.turnId, 'live-turn-continuation', 'its output stays inside that turn')
const idleNotices = projectConversation(bootstrap(state, [event(2, 'extension.notification', { level: 'info', message: '空闲通知' })]))
assert.equal(idleNotices.some((item) => item.kind === 'turn'), false, 'an idle segment with no run boundary has no turn')
assert.equal(idleNotices.find((item) => item.kind === 'notice')?.turnId, undefined, 'notices between runs belong to no turn')
const runningProjectionState = { ...state, instance: { ...state.instance, execution: 'running' as const } }
const waitingProjection = projectConversation(bootstrap(runningProjectionState, [event(1, 'run.started', {})]))
const waitingTurn = waitingProjection.find((item) => item.kind === 'turn')
assert.ok(waitingTurn?.kind === 'turn' && waitingTurn.status === 'running', 'an accepted run shows as a running turn before any output')
assert.equal(waitingTurn.startedAt, '2026-01-01T00:00:01Z')
assert.equal(waitingTurn.continuation, false, 'a replayed run.started makes the bootstrap continuation an exact turn')
assert.equal(waitingProjection.filter((item) => item.kind === 'turn').length, 1)
const respondingProjection = projectConversation(bootstrap(runningProjectionState, [event(1, 'run.started', {}), event(2, 'message.delta', { messageId: 'reply', block: 'text', delta: '开始回复' })]))
assert.equal(respondingProjection.find((item) => item.kind === 'assistant')?.turnId, 'live-turn-1', 'streamed output belongs to the running turn')
const continuedProjection = projectConversation(bootstrap(runningProjectionState, [event(2, 'message.delta', { messageId: 'reply', block: 'thinking', delta: '检查图片内容' })]))
const continuedTurn = continuedProjection.find((item) => item.kind === 'turn')
assert.ok(continuedTurn?.kind === 'turn' && continuedTurn.continuation === true && continuedTurn.status === 'running', 'a read that finds the run in progress continues the turn already in history')
const freshPromptProjection = projectConversation(bootstrap(runningProjectionState, [event(3, 'message.submitted', { messageId: 'user-3', text: '新的一轮', delivery: 'prompt' })]))
const freshTurn = freshPromptProjection.find((item) => item.kind === 'turn')
assert.ok(freshTurn?.kind === 'turn' && freshTurn.continuation === false && freshTurn.id === 'live-turn-3', 'a prompt seen without run.started opens its own turn instead of continuing the previous one')
const steerProjection = projectConversation(bootstrap(runningProjectionState, [event(3, 'message.submitted', { messageId: 'user-3', text: '补充', delivery: 'steer' })]))
assert.equal(steerProjection.find((item) => item.kind === 'turn')?.continuation, true, 'a steer message stays inside the running turn')
assert.equal(steerProjection.find((item) => item.kind === 'user')?.turnId, 'live-turn-continuation')

// Collapsed turns keep the reader's messages, images, warnings and the final reply; process folds behind the summary.
const collapsedRows = conversationRows([
  { id: 'turn-a', kind: 'turn', turnId: 'turn-a', status: 'completed', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:04:13Z' },
  { id: 'ask', kind: 'user', text: '请查一下', time: '10:00', turnId: 'turn-a' },
  { id: 'thinking-only', kind: 'thinking', groupId: 'process-only', title: '思考过程', text: '检查中', turnId: 'turn-a' },
  { id: 'tool-only', kind: 'tool', groupId: 'process-only', name: 'read', summary: '完成', status: 'error', turnId: 'turn-a' },
  { id: 'info-only', kind: 'notice', groupId: 'process-only', tone: 'info', text: '资源已载入', turnId: 'turn-a' },
  { id: 'image', kind: 'image', groupId: 'image', imageKey: 'image', mimeType: 'image/png', turnId: 'turn-a' },
  { id: 'warning', kind: 'notice', groupId: 'warning', tone: 'warning', text: '需要确认', turnId: 'turn-a' },
  { id: 'reply-thinking', kind: 'thinking', groupId: 'reply', title: '思考过程', text: '总结', turnId: 'turn-a' },
  { id: 'reply-1', kind: 'assistant', groupId: 'reply', text: '第一段', time: '10:04', turnId: 'turn-a' },
  { id: 'reply-2', kind: 'assistant', groupId: 'reply', text: '第二段', time: '10:04', turnId: 'turn-a' },
  { id: 'after', kind: 'notice', tone: 'info', text: '资源已重新加载（2）' },
])
const [turnSection, afterSection] = conversationSections(collapsedRows)
assert.ok(turnSection?.kind === 'turn' && afterSection?.kind === 'row', 'a notice after the turn stands on its own row')
assert.deepEqual(turnSection.openers.map((row) => row.id), ['ask'], 'the user message that opened the turn sits above its summary line')
assert.equal(turnSection.finalRowId, 'reply', 'the final reply is the last Agent message, not one text block')
assert.equal(turnSection.toolCalls, 1)
assert.equal(turnSection.failedToolCalls, 1, 'a failed tool call is counted in the summary rather than hidden')
assert.deepEqual(turnSection.body.filter((row) => rowVisibleWhenCollapsed(row, turnSection.finalRowId)).map((row) => row.id), ['image', 'warning', 'reply'], '收起后只保留图片、警告和最终回复')
const finalRow = turnSection.body.find((row) => row.id === 'reply')
assert.ok(finalRow?.kind === 'assistant-group')
assert.deepEqual(finalRow.parts.filter((part) => partVisibleWhenCollapsed(part, true)).map((part) => part.id), ['reply-1', 'reply-2'], '最终回复的每一段正文都保留，只折起它的思考')
// A long thinking block can use up the history preview budget, leaving the final
// message with no text until its full body is read. The row must still render so
// that reading interest reaches it while the turn is collapsed.
const previewOnlySection = conversationSections(conversationRows([
  { id: 'turn-b', kind: 'turn', turnId: 'turn-b', status: 'completed', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:30Z' },
  { id: 'ask-b', kind: 'user', text: '问', time: '10:00', turnId: 'turn-b' },
  { id: 'final-thinking', kind: 'thinking', groupId: 'final', title: '思考过程', text: '很长的思考', turnId: 'turn-b', sourceEntryIds: ['entry-final'] },
]))[0]
assert.ok(previewOnlySection?.kind === 'turn' && previewOnlySection.finalRowId === 'final')
assert.deepEqual(previewOnlySection.body.filter((row) => rowVisibleWhenCollapsed(row, previewOnlySection.finalRowId)).map((row) => row.id), ['final'], '只有思考预览的最终回复在收起时仍占一行，才能被读取补全')

const groupedBootstrap = bootstrap(state, [])
groupedBootstrap.records = [
  {
    recordId: 'assistant-call', entryId: 'entry-call', kind: 'message', source: 'assistant', visibility: 'conversation', timestamp: '2026-01-01T00:00:10Z',
    content: [{ type: 'text', text: '先检查。' }, { type: 'tool_call', toolCallId: 'call-1', toolName: 'read', args: { path: 'README.md' } }],
  },
  {
    recordId: 'tool-result', entryId: 'entry-result', kind: 'message', source: 'tool', visibility: 'conversation', toolCallId: 'call-1',
    content: [{ type: 'tool_result', toolCallId: 'call-1', toolName: 'read', text: 'ok', isError: false }],
  },
  {
    recordId: 'assistant-after', entryId: 'entry-after', kind: 'message', source: 'assistant', visibility: 'conversation', timestamp: '2026-01-01T00:00:11Z',
    content: [{ type: 'text', text: '检查完成。' }],
  },
]
const groupedProjection = projectConversation(groupedBootstrap)
const callText = groupedProjection.find((item) => item.kind === 'assistant' && item.text === '先检查。')
const callTool = groupedProjection.find((item) => item.kind === 'tool' && item.name === 'read')
const afterText = groupedProjection.find((item) => item.kind === 'assistant' && item.text === '检查完成。')
assert.ok(callText?.kind === 'assistant' && callTool?.kind === 'tool' && afterText?.kind === 'assistant')
assert.equal(callText.groupId, callTool.groupId, 'a tool result stays inside the assistant record that formally owns its toolCallId')
assert.notEqual(callText.groupId, afterText.groupId, 'a later assistant record keeps its own WebConsole message row')
assert.match(toolDetailText(callTool), /参数[\s\S]*结果/)
assert.deepEqual(callTool.preview, { title: 'README.md', body: undefined, variant: 'path', truncated: false }, '标准工具主要参数进入收起态投影')

// Card #350: a codemode card shows its script and the tools the script called, live and after reopening.
const harborCode = "const echoed = await tools.mcp__harbor__echo({ text: 'lantern' });\nreturn echoed;"
const harborCalls = { calls: [
  { toolName: 'mcp__harbor__echo', args: { text: 'lantern' }, status: 'ok', durationMs: 12 },
  { toolName: 'mcp__harbor__fail', args: {}, status: 'error', durationMs: 1500, error: 'harbor is closed' },
], complete: true }
const runningCodemode = projectConversation(bootstrap(state, [
  event(1, 'run.started', {}),
  event(2, 'tool.started', { toolCallId: 'script', toolName: 'codemode', args: { code: harborCode } }),
  event(3, 'tool.output_updated', { toolCallId: 'script', text: '', nestedCalls: { calls: [{ toolName: 'mcp__harbor__echo', args: { text: 'lantern' }, status: 'running' }], complete: true } }),
])).find((item) => item.kind === 'tool')
assert.ok(runningCodemode?.kind === 'tool' && runningCodemode.nestedCalls)
assert.deepEqual(nestedCallRows(runningCodemode.nestedCalls).rows.map((row) => [row.icon, row.name]), [['…', 'mcp__harbor__echo']], 'a call the script waits for shows as running')
const finishedCodemode = projectConversation(bootstrap(state, [
  event(1, 'run.started', {}),
  event(2, 'tool.started', { toolCallId: 'script', toolName: 'codemode', args: { code: harborCode } }),
  event(3, 'tool.completed', { toolCallId: 'script', toolName: 'codemode', isError: false, text: 'Script completed\nOutput:\nharbor echoed lantern', nestedCalls: harborCalls }),
])).find((item) => item.kind === 'tool')
const reopenedCodemodeBootstrap = bootstrap(state, [])
reopenedCodemodeBootstrap.records = [
  { recordId: 'codemode-call', entryId: 'entry-codemode-call', kind: 'message', source: 'assistant', visibility: 'conversation', content: [{ type: 'tool_call', toolCallId: 'script', toolName: 'codemode', args: { code: harborCode } }] },
  { recordId: 'codemode-result', entryId: 'entry-codemode-result', kind: 'message', source: 'tool', visibility: 'conversation', toolCallId: 'script', content: [{ type: 'tool_result', toolCallId: 'script', toolName: 'codemode', text: 'Script completed\nOutput:\nharbor echoed lantern', isError: false, nestedCalls: harborCalls }] },
]
const reopenedCodemode = projectConversation(reopenedCodemodeBootstrap).find((item) => item.kind === 'tool')
for (const tool of [finishedCodemode, reopenedCodemode]) {
  assert.ok(tool?.kind === 'tool' && tool.nestedCalls)
  assert.deepEqual(tool.preview, { title: '脚本', body: harborCode, variant: 'command', truncated: false })
  assert.deepEqual(nestedCallRows(tool.nestedCalls).rows.map(({ icon, name, args, duration }) => [icon, name, args, duration]), [
    ['✓', 'mcp__harbor__echo', '{"text":"lantern"}', '12ms'],
    ['✗', 'mcp__harbor__fail', '{}', '1.5s'],
  ])
  assert.match(toolDetailText(tool), /调用\n[^\n]*mcp__harbor__echo[\s\S]*harbor is closed[\s\S]*结果\nScript completed/)
}

const publishedFile = { presentation: 'image' as const, fileRef: 'file-1', name: 'result.png', sizeBytes: 5, mediaType: 'image/png' }
const linkedImageAttachment = { fileId: 'attachment-image-1', name: '课堂截图.png', sizeBytes: 2048, mediaType: 'image/png', sha256: 'a'.repeat(64), storedAt: '2026-08-19T04:55:43Z' }
const textAttachment = { fileId: 'attachment-text-1', name: '说明.txt', sizeBytes: 32, mediaType: 'text/plain', sha256: 'b'.repeat(64), storedAt: '2026-08-19T04:55:43Z' }
const historicalUserText = '请看这张图\n--\n[img:#496|path=/host/private/image.png]\n--\n[2026-08-19 12:55:43 周三]'
const liveUserImageText = '[img:#497|path=/host/private/live.png]\n--\n[2026-08-19 13:01:02 周三]'
const imageBootstrap = bootstrap(state, [])
imageBootstrap.records = [
  {
    recordId: 'native-user-image', entryId: 'entry-native-user-image', kind: 'message', source: 'user', visibility: 'conversation', timestamp: '2026-08-19T04:55:43Z',
    content: [
      { type: 'text', text: historicalUserText },
      { type: 'image', mimeType: 'image/png', contentRef: 'user-image-1', fileId: linkedImageAttachment.fileId },
    ],
    attachments: [linkedImageAttachment, textAttachment],
  },
  {
    recordId: 'assistant-image-call', entryId: 'entry-image-call', kind: 'message', source: 'assistant', visibility: 'conversation',
    content: [{ type: 'tool_call', toolCallId: 'show-1', toolName: 'show_image', args: { path: '/private/generated/result.png' } }],
  },
  {
    recordId: 'published-image-result', entryId: 'entry-image-result', kind: 'message', source: 'tool', visibility: 'conversation', toolCallId: 'show-1',
    content: [{ type: 'tool_result', toolCallId: 'show-1', toolName: 'show_image', text: 'Published /private/generated/result.png', isError: false, publishedFile }],
  },
  {
    recordId: 'native-image', entryId: 'entry-native-image', kind: 'message', source: 'assistant', visibility: 'conversation',
    content: [{ type: 'image', mimeType: 'image/png', contentRef: 'image-1' }],
  },
]
const imageProjection = projectConversation(imageBootstrap)
const publishedImage = imageProjection.find((item) => item.kind === 'image' && item.source?.type === 'published')
const nativeImage = imageProjection.find((item) => item.kind === 'image' && item.source?.type === 'conversation')
const showImageTool = imageProjection.find((item) => item.kind === 'tool' && item.name === 'show_image')
assert.ok(publishedImage?.kind === 'image' && publishedImage.source?.type === 'published' && showImageTool?.kind === 'tool')
assert.deepEqual(publishedImage.source.file, publishedFile, 'path-free published metadata reaches the image renderer unchanged')
assert.equal(publishedImage.groupId, showImageTool.groupId, 'show_image remains in its formally owned Assistant group')
assert.doesNotMatch(toolDetailText(showImageTool), /private|generated|result\.png/, 'the Host-local show_image source path is not displayed')
assert.ok(nativeImage?.kind === 'image' && nativeImage.source?.type === 'conversation' && nativeImage.source.contentRef === 'image-1')
const historicalUserImage = imageProjection.find((item) => item.kind === 'user')
assert.ok(historicalUserImage?.kind === 'user')
assert.equal(historicalUserImage.text, historicalUserText, '通用客户端原样显示 Dock 记录的用户消息')
assert.equal(historicalUserImage.images?.[0]?.source?.type, 'conversation', '重新打开对话仍显示用户发送的图片')
assert.equal(historicalUserImage.images?.[0]?.name, '课堂截图.png')
assert.deepEqual(historicalUserImage.attachments?.map((attachment) => attachment.fileId), [textAttachment.fileId], '已显示的图片不再重复显示为附件卡')

const liveUserImage = projectConversation(bootstrap(state, [
  event(8, 'message.submitted', {
    messageId: 'user-live-image',
    text: liveUserImageText,
    attachments: [linkedImageAttachment],
  }),
  event(9, 'message.completed', {
    messageId: 'user-live-image', role: 'user',
    content: [
      { type: 'text', text: liveUserImageText },
      { type: 'image', mimeType: 'image/png', contentRef: 'user-image-live', fileId: linkedImageAttachment.fileId },
    ],
    attachments: [linkedImageAttachment],
  }),
])).find((item) => item.kind === 'user')
assert.ok(liveUserImage?.kind === 'user')
assert.equal(liveUserImage.text, liveUserImageText, '实时消息同样保留 Dock 的完整正文')
assert.equal(liveUserImage.images?.[0]?.source?.type, 'conversation', '发送完成后立即显示图片，不必刷新对话')
assert.equal(liveUserImage.attachments, undefined, '实时消息不会把同一张图片再显示成附件卡')

const livePublished = projectConversation(bootstrap(state, [
  event(10, 'tool.output_updated', { toolCallId: 'show-live', text: 'published', publishedFile }),
  event(11, 'tool.completed', { toolCallId: 'show-live', toolName: 'show_image', text: 'published', isError: false, publishedFile }),
]))
assert.equal(livePublished.filter((item) => item.kind === 'image' && item.source?.type === 'published').length, 1, 'live updates do not duplicate the same published image')

const genericTimestampBootstrap = bootstrap(state, [])
genericTimestampBootstrap.records = [{
  recordId: 'user-with-timestamp', entryId: 'entry-user', kind: 'message', source: 'user', visibility: 'conversation', timestamp: '2026-08-18T02:19:06Z',
  content: [{ type: 'text', text: '通用客户端只发送正文' }],
}]
const genericUser = projectConversation(genericTimestampBootstrap).find((item) => item.kind === 'user')
assert.equal(genericUser?.kind === 'user' ? genericUser.text : '', '通用客户端只发送正文', 'message content is not decorated with a client-generated time tail')
assert.match(genericUser?.kind === 'user' ? genericUser.time : '', /^\d{2}:\d{2}$/, 'the record timestamp still supplies the visible message time')

let queueState: LiveProjectionState = { ...state, instance: { ...state.instance, pending: { steering: 0, followUp: 0, total: 0 } }, queue: [], sequence: 3 }
queueState = applied(queueState, event(4, 'message.queued', { queueItemId: 'q1', delivery: 'followUp', text: 'first' }))
queueState = applied(queueState, event(5, 'message.queued', { queueItemId: 'q2', delivery: 'followUp', text: 'second' }))
assert.equal(queueState.instance.pending.total, 2)
queueState = applied(queueState, event(6, 'queue.changed', { steering: 0, followUp: 1, total: 1 }))
queueState = applied(queueState, event(7, 'message.submitted', { queueItemId: 'q1', messageId: 'm1', text: 'first', delivery: 'followUp' }))
assert.deepEqual(queueState.queue.map((item) => item.queueItemId), ['q2'])
assert.equal(queueState.instance.pending.total, 1, 'message.submitted does not double-decrement the authoritative queue.changed count')
queueState = applied(queueState, event(8, 'instance.state_changed', {
  lifecycle: 'active', execution: 'running', compacting: false,
  pending: { steering: 1, followUp: 0, total: 1 },
}))
assert.deepEqual(queueState.instance.pending, { steering: 1, followUp: 0, total: 1 }, 'state correction reads nested pending')
queueState = applied(queueState, event(9, 'queue.cleared', { queueItemIds: ['q2'], steering: 4, followUp: 4, total: 8, reason: 'stop' }))
assert.deepEqual(queueState.instance.pending, { steering: 0, followUp: 0, total: 0 }, 'queue removal counts cannot underflow')
assert.equal(queueState.queue.length, 0)

const stale = reduceLiveEvent(queueState, { connectionId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: event(10, 'run.started', {}, 0) })
assert.equal(stale.kind, 'ignored', 'older generation cannot enter current projection')
const replacement = reduceLiveEvent(queueState, { connectionId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: event(1, 'session.replaced', { runtimeGeneration: 2 }, 2) })
assert.equal(replacement.kind, 'rebuild', 'replacement generation triggers correlated rebuild rather than merge')

const liveNotices = projectConversation(bootstrap(state, [
  event(6, 'extension.notification', { level: 'info', message: '这是一条完整且不可手动关闭的 Extension 通知。' }),
  event(7, 'resources.reloaded', { resources: [{ uri: 'one' }, { uri: 'two' }], diagnostics: [] }),
]))
assert.equal(liveNotices.some((item) => item.kind === 'notice' && item.text === '这是一条完整且不可手动关闭的 Extension 通知。'), true)
assert.equal(liveNotices.some((item) => item.kind === 'notice' && item.text === '资源已重新加载（2）'), true)

const aborted = projectConversation(bootstrap(state, [event(7, 'run.started', {}), event(8, 'run.settled', { result: 'aborted' })]))
assert.equal(aborted.find((item) => item.kind === 'turn')?.status, 'aborted', 'the turn summary reports an abort')
assert.equal(aborted.some((item) => item.kind === 'notice'), false)

let compactionState = applied(state, event(4, 'compaction.started', {}))
compactionState = applied(compactionState, event(5, 'run.settled', { result: 'succeeded' }))
assert.equal(compactionState.instance.compacting, true, 'older run settlement preserves a newer compaction boundary')
assert.equal(compactionState.instance.execution, 'running', 'older run settlement preserves compaction execution')
const cancelledCompaction = projectConversation(bootstrap(state, [
  event(6, 'compaction.started', { reason: 'manual' }),
  event(7, 'compaction.completed', { reason: 'manual', aborted: true, willRetry: false }),
]))
assert.equal(cancelledCompaction.some((item) => item.kind === 'notice' && item.tone === 'warning' && item.text.includes('取消')), true, '用户中止上下文压缩后显示终止结果')

const watchedHostId = ref<string | null>('host-a')
const watchedGeneration = ref<number | null>(4)
const watchedWorks = ref<Work[]>([work])
const watchedSelection = computed(() => watchedWorks.value[0])
let conversationReloads = 0
const stopWatchingBoundary = watch(
  () => conversationBoundaryKey(watchedHostId.value, watchedGeneration.value, watchedSelection.value?.id),
  () => { conversationReloads++ },
)
watchedWorks.value = [{ ...work, updatedAt: '2026-01-01T00:01:00Z' }]
await nextTick()
assert.equal(conversationReloads, 0, 'refreshing the same Work snapshot keeps the visible conversation loaded')
watchedWorks.value = [{ ...work, id: 'work-2' }]
await nextTick()
assert.equal(conversationReloads, 1, 'selecting another Work loads its conversation')
stopWatchingBoundary()

// The Work TUI's session cache rate excludes output tokens and includes cache writes.
assert.equal(formatCacheHitRate({ input: 100, cacheRead: 800, cacheWrite: 100, output: 50, total: 1050 }), '80%')
assert.equal(formatCacheHitRate({ input: 1, cacheRead: 2, cacheWrite: 0 }), '67%')
assert.equal(formatCacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 100 }), '0%')
assert.equal(formatCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), '—')
assert.equal(formatCacheHitRate({ input: 100 }), '—')
assert.equal(formatCacheHitRate(), '—')
assert.equal(formatTokenCount(6_200_000), '6.2M')
assert.equal(formatTokenCount(561_999), '561k')
assert.equal(formatTokenCount(999), '999')
assert.equal(formatTokenCount(null), '—')
assert.equal(formatContextUsage({ tokens: 245_000, contextWindow: 372_000, percent: 65.9 }), '245k/372k (65.9%)', 'navbar metrics preserve WebConsole density and precision')
assert.doesNotMatch(userErrorMessage({ code: 'protocol_error', message: 'generation 4 cursor 8 failed' }), /generation|cursor|4|8/, 'protocol bookkeeping never becomes user-facing error text')
assert.doesNotMatch(userErrorMessage({ code: 'instance_host_lost', message: 'Instance 123e4567-e89b is host_lost' }), /123e4567|host_lost/)
assert.match(userErrorMessage({ code: 'invalid_tree_target', message: 'Entry abc no longer exists' }), /重新打开 Session Tree/, 'a stale Tree choice tells the user how to recover without exposing the missing entry')
assert.equal(userErrorMessage({ code: 'attachment_source_unavailable', message: '无法读取所选附件。' }), '无法读取所选附件。', 'attachment picker failures keep their actionable native message')

assert.equal(draftAfterSubmit('original', 'original', false), 'original', 'failed/effect-unknown admission preserves draft')
assert.equal(draftAfterSubmit('typed while sending', 'original', true), 'typed while sending', 'successful admission preserves concurrent typing')
assert.equal(draftAfterSubmit('original', 'original', true), '')
const candidate = bootstrap(state, [])
assert.equal(conversationReadMatches({ connectionId: 'host-a', selectionGeneration: 4 }, 'work-1', candidate), true)
const wrongGeneration = bootstrap({ ...state, instance: { ...state.instance, runtimeGeneration: 2 } }, [])
wrongGeneration.cursor.runtimeGeneration = 1
assert.equal(conversationReadMatches({ connectionId: 'host-a', selectionGeneration: 4 }, 'work-1', wrongGeneration), false)

assert.equal(stopCanStart(work, false), true)
assert.equal(stopCanStart(work, true), false, 'pending mutation locks Stop')
// master-side review: unrelated unknown controls must not permanently block a new Stop intent.
assert.equal(stopCanStart({ ...work, lifecycle: 'stopping' }, false), false, 'a Work already stopping cannot start Stop again')
const confirmation = stopConfirmationText(work)
assert.match(confirmation, /共享 Work/)
assert.match(confirmation, /当前运行/)
assert.match(confirmation, /Queue/)
assert.match(confirmation, /本地草稿会保留/)
const stopped = { ...work, lifecycle: 'stopped' as const, execution: 'unavailable' as const, ownerHostEpoch: undefined }
assert.equal(stoppedResultIsCorrelated({ receipt: { operationId: 'op', alreadyStopped: false, cleanupErrors: ['cleanup'] }, instance: stopped }, work.id), true)
assert.equal(draftAfterSubmit('local draft', 'not a submit', false), 'local draft', 'Stop/reopen boundaries do not alter drafts')

function applied(current: LiveProjectionState, projected: ProjectedEvent): LiveProjectionState {
  const result = reduceLiveEvent(current, { connectionId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: projected })
  assert.equal(result.kind, 'applied')
  if (result.kind !== 'applied') throw new Error('event was not applied')
  return result.state
}
function event(sequence: number, eventType: string, data: Record<string, unknown>, runtimeGeneration = 1): ProjectedEvent {
  return { sequence, runtimeGeneration, occurredAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`, eventType, data }
}
function bootstrap(current: LiveProjectionState, activeEvents: ProjectedEvent[]): ConversationBootstrap {
  return {
    instance: current.instance,
    records: [],
    activeEvents,
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
    queue: current.queue,
    cursor: { hostEpoch: current.hostEpoch, instanceId: current.instance.id, runtimeGeneration: current.instance.runtimeGeneration, sequence: current.sequence },
    historyRevision: 1,
    historyTruncated: false,
  }
}
function makeWork(): Work {
  return {
    id: 'work-1', displayName: 'Shared Work', cwd: '/work', lifecycle: 'active', execution: 'idle', compacting: false,
    lastRun: 'never', reopenable: false, runtimeGeneration: 1, ownerHostEpoch: 'epoch-a', pending: { steering: 0, followUp: 0, total: 0 },
    executor: { kind: 'pi', piSessionId: 'session', model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' },
    extensionStatus: {}, toolsExpanded: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
}
