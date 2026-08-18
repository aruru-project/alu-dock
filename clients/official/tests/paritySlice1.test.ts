import { strict as assert } from 'node:assert'
import { computed, nextTick, ref, watch } from 'vue'
import { projectConversation } from '../src/lib/conversation.ts'
import { reduceLiveEvent, type LiveProjectionState } from '../src/lib/liveReducer.ts'
import { conversationBoundaryKey, conversationSwapIsCorrelated, draftAfterSubmit, FollowActivationCoordinator, formatContextUsage, formatTokenCount, outputIsNearBottom, stopCanStart, stopConfirmationText, stoppedResultIsCorrelated } from '../src/lib/uiBoundaries.ts'
import { userErrorMessage } from '../src/lib/userError.ts'
import type { ConversationBootstrap, ProjectedEvent, Work } from '../src/lib/types.ts'

const work = makeWork()
let state: LiveProjectionState = { hostId: 'host-a', selectionGeneration: 4, hostEpoch: 'epoch-a', instance: work, queue: [], sequence: 0 }

state = applied(state, event(1, 'run.started', {}))
assert.equal(state.instance.execution, 'running', 'run.started enables Abort-facing running state')
state = applied(state, event(2, 'tool.started', { toolCallId: 'tool-1', toolName: 'bash', args: {} }))
state = applied(state, event(3, 'run.settled', { result: 'failed', error: 'model failed' }))
assert.equal(state.instance.execution, 'failed')
assert.equal(state.instance.lastRun, 'failed')
assert.equal(state.instance.lastError, 'model failed')

const failedProjection = projectConversation(bootstrap(state, [
  event(2, 'tool.started', { toolCallId: 'tool-1', toolName: 'bash', args: {} }),
  event(3, 'run.settled', { result: 'failed', error: 'model failed' }),
]))
assert.equal(failedProjection.find((item) => item.kind === 'tool')?.kind, 'tool')
assert.equal(failedProjection.find((item) => item.kind === 'tool' && item.id === 'live-tool-tool-1')?.status, 'error', 'settlement terminalizes unfinished tools')
assert.equal(failedProjection.some((item) => item.kind === 'notice' && item.tone === 'error' && item.text === 'model failed'), true)
const runningProjectionState = { ...state, instance: { ...state.instance, execution: 'running' as const } }
const waitingProjection = projectConversation(bootstrap(runningProjectionState, [event(1, 'run.started', {})]))
assert.equal(waitingProjection.some((item) => item.kind === 'activity'), true, 'an accepted run shows the WebConsole Assistant activity row')
const respondingProjection = projectConversation(bootstrap(runningProjectionState, [event(1, 'run.started', {}), event(2, 'message.delta', { messageId: 'reply', block: 'text', delta: '开始回复' })]))
assert.equal(respondingProjection.some((item) => item.kind === 'activity'), false, 'the spinner yields to the first visible Assistant output')

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
assert.match(callTool.detail || '', /参数[\s\S]*结果/)
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

const stale = reduceLiveEvent(queueState, { hostId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: event(10, 'run.started', {}, 0) })
assert.equal(stale.kind, 'ignored', 'older generation cannot enter current projection')
const replacement = reduceLiveEvent(queueState, { hostId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: event(1, 'session.replaced', { runtimeGeneration: 2 }, 2) })
assert.equal(replacement.kind, 'rebuild', 'replacement generation triggers correlated rebuild rather than merge')

const aborted = projectConversation(bootstrap(state, [event(8, 'run.settled', { result: 'aborted' })]))
assert.equal(aborted.some((item) => item.kind === 'notice' && item.tone === 'warning' && item.text.includes('中止')), true)

let compactionState = applied(state, event(4, 'compaction.started', {}))
compactionState = applied(compactionState, event(5, 'run.settled', { result: 'succeeded' }))
assert.equal(compactionState.instance.compacting, true, 'older run settlement preserves a newer compaction boundary')
assert.equal(compactionState.instance.execution, 'running', 'older run settlement preserves compaction execution')

for (const terminalState of ['disconnected', 'resync_required'] as const) {
  const coordinator = new FollowActivationCoordinator()
  const subscriptionId = `follow-${terminalState}`
  const connected = coordinator.prepare(subscriptionId)
  assert.equal(coordinator.handleStatus(subscriptionId, { state: 'connected' }), true)
  await connected
  assert.equal(coordinator.handleStatus(subscriptionId, { state: terminalState, message: terminalState }), true)
  assert.deepEqual(
    coordinator.activate(subscriptionId),
    { state: terminalState, message: terminalState },
    `${terminalState} is retained between waiter resolution and active publication`,
  )
}

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

assert.equal(formatTokenCount(6_200_000), '6.2M')
assert.equal(formatTokenCount(561_999), '561k')
assert.equal(formatTokenCount(999), '999')
assert.equal(formatTokenCount(null), '—')
assert.equal(formatContextUsage({ tokens: 245_000, contextWindow: 372_000, percent: 65.9 }), '245k/372k (65.9%)', 'navbar metrics preserve WebConsole density and precision')
assert.equal(outputIsNearBottom(1_000, 701, 300), true, 'new output follows while the reader remains near the bottom')
assert.equal(outputIsNearBottom(1_000, 500, 300), false, 'intentional history scrolling is not stolen by new output')
assert.doesNotMatch(userErrorMessage({ code: 'protocol_error', message: 'generation 4 cursor 8 failed' }), /generation|cursor|4|8/, 'protocol bookkeeping never becomes user-facing error text')
assert.doesNotMatch(userErrorMessage({ code: 'instance_host_lost', message: 'Instance 123e4567-e89b is host_lost' }), /123e4567|host_lost/)

assert.equal(draftAfterSubmit('original', 'original', false), 'original', 'failed/effect-unknown admission preserves draft')
assert.equal(draftAfterSubmit('typed while sending', 'original', true), 'typed while sending', 'successful admission preserves concurrent typing')
assert.equal(draftAfterSubmit('original', 'original', true), '')
const candidate = bootstrap(state, [])
assert.equal(conversationSwapIsCorrelated({ hostId: 'host-a', selectionGeneration: 4 }, 'work-1', candidate, false), false, 'delayed follow keeps old projection')
assert.equal(conversationSwapIsCorrelated({ hostId: 'host-a', selectionGeneration: 4 }, 'work-1', candidate, true), true)
const wrongGeneration = bootstrap({ ...state, instance: { ...state.instance, runtimeGeneration: 2 } }, [])
wrongGeneration.cursor.runtimeGeneration = 1
assert.equal(conversationSwapIsCorrelated({ hostId: 'host-a', selectionGeneration: 4 }, 'work-1', wrongGeneration, true), false)

assert.equal(stopCanStart(work, false, false), true)
assert.equal(stopCanStart(work, true, false), false, 'pending mutation locks Stop')
assert.equal(stopCanStart(work, false, true), false, 'EffectUnknown locks Stop without replay')
const confirmation = stopConfirmationText(work)
assert.match(confirmation, /共享 Work/)
assert.match(confirmation, /当前运行/)
assert.match(confirmation, /Queue/)
assert.match(confirmation, /本地草稿会保留/)
const stopped = { ...work, lifecycle: 'stopped' as const, execution: 'unavailable' as const, ownerHostEpoch: undefined }
assert.equal(stoppedResultIsCorrelated({ receipt: { operationId: 'op', alreadyStopped: false, cleanupErrors: ['cleanup'] }, instance: stopped }, work.id), true)
assert.equal(draftAfterSubmit('local draft', 'not a submit', false), 'local draft', 'Stop/reopen boundaries do not alter drafts')

function applied(current: LiveProjectionState, projected: ProjectedEvent): LiveProjectionState {
  const result = reduceLiveEvent(current, { hostId: 'host-a', selectionGeneration: 4, instanceId: 'work-1', event: projected })
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
