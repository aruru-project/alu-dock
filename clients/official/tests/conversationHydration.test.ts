import { strict as assert } from 'node:assert'
import { mergeHydratedConversationRecords, projectConversation } from '../src/lib/conversation.ts'
import type { ConversationBootstrap, ConversationRecord, Work } from '../src/lib/types.ts'

const attachment = {
  fileId: '62cc3540-3cee-49bb-a41d-e0122d22afcc',
  name: 'Screenshot.jpg',
  sizeBytes: 640075,
  mediaType: 'image/jpeg',
  sha256: 'a'.repeat(64),
  storedAt: '2026-08-21T01:05:04.954Z',
}
const preview: ConversationRecord = {
  recordId: 'record-1',
  entryId: 'entry-1',
  kind: 'message',
  source: 'user',
  visibility: 'conversation',
  content: [{ type: 'image', mimeType: 'image/jpeg', fileId: attachment.fileId }],
  attachments: [attachment],
}
const completed: ConversationRecord = {
  ...preview,
  content: [{ type: 'image', mimeType: 'image/jpeg', fileId: attachment.fileId, data: '/9j/' }],
}

function project(records: ConversationRecord[]) {
  const bootstrap: ConversationBootstrap = {
    instance: { id: 'work-1', execution: 'idle' } as unknown as Work,
    records,
    activeEvents: [],
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
    queue: [],
    cursor: { hostEpoch: 'epoch-1', instanceId: 'work-1', runtimeGeneration: 1, sequence: 0 },
    historyRevision: 1,
    historyTruncated: false,
  }
  return projectConversation(bootstrap)
}

const before = project([preview]).find((item) => item.kind === 'user')
assert.equal(before?.kind === 'user' && before.images?.[0]?.source, undefined, '有界历史只有附件引用时还没有图片内容')
assert.equal(before?.kind === 'user' && before.images?.[0]?.name, 'Screenshot.jpg', '有界历史仍显示附件名称')
assert.equal(before?.kind === 'user' && before.images?.[0]?.historyEntryId, 'entry-1', '未读完的历史图片仍关联原会话记录以便重试')

const older: ConversationRecord = {
  recordId: 'record-0',
  entryId: 'entry-0',
  kind: 'message',
  source: 'user',
  visibility: 'conversation',
  content: [{ type: 'text', text: 'earlier' }],
}
const hydrated = mergeHydratedConversationRecords([older, preview], [completed])
const projected = project(hydrated)
const after = projected.find((item) => item.id === 'record-1')
assert.deepEqual(projected.map((item) => item.id), ['record-0', 'record-1'], '图片补全时保留用户已经载入的更早记录')
assert.deepEqual(
  after?.kind === 'user' ? after.images?.[0]?.source : undefined,
  { type: 'inline', data: '/9j/', mimeType: 'image/jpeg' },
  '清空本地预览后，正式历史内容仍恢复同一张图片',
)
// 2026-09-08: opening a Work left history permanently loading because the
// content owner compared Vue's stored proxy with the raw bootstrap from App.
const { createServer } = await import('vite')
const { fileURLToPath } = await import('node:url')
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom',
})
const previousWindow = globalThis.window
const replies: Array<unknown> = []
globalThis.window = {
  __TAURI_INTERNALS__: { invoke: async (command: string) => {
    assert.ok(command === 'conversation_history' || command === 'conversation_history_entry')
    assert.ok(replies.length, 'unexpected native history request')
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  } },
} as unknown as Window & typeof globalThis
try {
  const { useConversationContent } = await server.ssrLoadModule('/src/lib/conversationContent.ts')
  const context = { connectionId: 'local', selectionGeneration: 1 }
  let epoch = 1
  // Card #269: instance.read included 200 records, but the recent-history page
  // covered only the last 50. Loading it moved the final reply above older work.
  const bootstrapOnly: ConversationRecord = {
    recordId: 'record-boundary', entryId: 'entry-boundary', kind: 'message',
    source: 'assistant', visibility: 'conversation', timestamp: '2026-09-09T19:41:11.511Z',
    content: [{ type: 'text', text: 'Checking the last changes.' }],
  }
  const finalReply: ConversationRecord = {
    recordId: 'record-final', entryId: 'entry-final', kind: 'message',
    source: 'assistant', visibility: 'conversation', timestamp: '2026-09-09T19:56:35.204Z',
    content: [{ type: 'text', text: 'The work is complete and pushed.' }],
  }
  const initial = (): ConversationBootstrap => ({
    instance: { id: 'work-1', execution: 'idle', runtimeGeneration: 1 } as Work,
    records: [bootstrapOnly, preview, finalReply], activeEvents: [], queue: [],
    extensionUi: { status: {}, toolsExpanded: false, events: [] },
    cursor: { hostEpoch: 'epoch-1', instanceId: 'work-1', runtimeGeneration: 1, sequence: 0 },
    historyRevision: 1, historyTruncated: true,
  })
  const page = {
    records: [preview, finalReply], incompleteEntryIds: ['entry-1'], revision: 'history-1',
    hasEarlier: true, nextCursor: 'earlier', instance: initial().instance, hostEpoch: 'epoch-1',
  }
  const content = useConversationContent({
    compact: { value: false }, native: true, getEpoch: () => epoch, getContext: () => context,
    isCurrent: (_context: unknown, current: ConversationBootstrap, capturedEpoch: number) =>
      content.state.value === current && epoch === capturedEpoch,
    reload: () => assert.fail('unexpected conversation reload'),
    beforeLayoutChange: () => null, afterLayoutChange: async () => {},
    isFollowing: () => false, layoutChanged: () => {}, projected: () => {},
  })
  content.publish(initial())
  replies.push(new Error('connection failed'))
  await content.loadRecentHistory(context, epoch)
  assert.equal(content.historyLoading.value, false, 'failed initial history stops loading')
  assert.ok(content.historyError.value, 'failed initial history offers a retry instead of silently waiting')
  replies.push(page, { record: completed, revision: 'history-1', instance: initial().instance, hostEpoch: 'epoch-1' })
  content.retryHydration()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(content.historyLoading.value, false, 'successful history stops loading')
  assert.equal(content.historyError.value, null)
  assert.equal(content.historyCursor.value, 'earlier', 'the user can now request earlier messages')
  assert.equal(content.historyHydrating.value, false)
  assert.deepEqual(content.state.value.records, [bootstrapOnly, completed, finalReply],
    'loading the recent page keeps older records before the final reply while completing images')
  const visibleReplies = content.items.value.filter((item: { kind: string }) => item.kind === 'assistant')
  assert.equal(visibleReplies.at(-1)?.text, 'The work is complete and pushed.',
    'the final visible reply must still show that the work is complete')

  replies.push({ ...page, records: [older], incompleteEntryIds: [], hasEarlier: false, nextCursor: undefined })
  await content.loadEarlierHistory()
  assert.equal(content.historyLoading.value, false)
  assert.equal(content.historyTruncated.value, false)
  assert.deepEqual(content.state.value.records.map((record: ConversationRecord) => record.entryId),
    ['entry-0', 'entry-boundary', 'entry-1', 'entry-final'])

  // Card #278 (2026-09-11): switching back during a reply must not show
  // live user messages again when the history reader has already persisted them.
  // Two deliberate sends with identical text must both remain visible.
  const repeatedText = 'Please check this change.'
  const sent = ['send-1', 'send-2'].map((messageId, index) => ({
    sequence: index + 1, runtimeGeneration: 1, eventType: 'message.submitted', occurredAt: '2026-09-11T02:50:00Z',
    data: { messageId, text: repeatedText },
  }))
  const newlyPersisted = ['new-1', 'new-2'].map((entryId) => ({
    ...older, recordId: entryId, entryId, content: [{ type: 'text', text: repeatedText }],
  }))
  content.clear()
  content.publish({ ...initial(), activeEvents: sent })
  // Enough output may arrive between the initial read and the history request
  // that the newest page has no overlap at all. Keep paging to the opened history.
  replies.push(
    { ...page, records: newlyPersisted, incompleteEntryIds: [], nextCursor: 'before-new-sends' },
    { ...page, records: [preview, finalReply], incompleteEntryIds: [], nextCursor: 'earlier' },
  )
  await content.loadRecentHistory(context, epoch)
  assert.deepEqual(content.items.value.filter((item: { kind: string; text?: string }) =>
    item.kind === 'user' && item.text === repeatedText).map((item: { id: string }) => item.id),
  ['live-send-1', 'live-send-2'], 'switching back shows each deliberate send once, even with identical text')
  assert.equal(content.historyCursor.value, 'earlier', 'earlier history remains available after skipping newer output')
  replies.push({ ...page, records: [older], incompleteEntryIds: [], hasEarlier: false, nextCursor: undefined })
  await content.loadEarlierHistory()
  assert.equal(content.items.value[0]?.text, 'earlier', 'reading further back still loads the older message')

  // Before the first checkpoint there is only live output; fetching already
  // persisted messages must not import them into an otherwise empty history.
  content.clear()
  content.publish({ ...initial(), records: [], activeEvents: sent, historyTruncated: false })
  await content.loadRecentHistory(context, epoch)
  assert.deepEqual(content.items.value.filter((item: { kind: string }) => item.kind === 'user')
    .map((item: { id: string }) => item.id), ['live-send-1', 'live-send-2'])
  assert.equal(content.historyLoading.value, false)
  assert.equal(content.historyError.value, null)

  // A byte-limited bootstrap may be shorter than the preview page, but Host
  // trimming removes its oldest prefix, never its tail. Only fill the prefix.
  content.clear()
  content.publish({ ...initial(), records: [completed] })
  replies.push({ ...page, records: [older, preview, finalReply], incompleteEntryIds: [], hasEarlier: false, nextCursor: undefined })
  await content.loadRecentHistory(context, epoch)
  assert.deepEqual(content.state.value.records, [older, completed],
    'a larger recent page fills older history and preserves completed content without importing a newer reply')

  let finishOldRequest!: (value: unknown) => void
  replies.push(new Promise(resolve => { finishOldRequest = resolve }))
  const pending = content.loadRecentHistory(context, epoch)
  epoch++
  content.clear()
  content.publish({ ...initial(), records: [older] })
  finishOldRequest(page)
  await pending
  // App can finish restoring layout after a switch. That old load must not
  // put the replacement conversation into a loading state it cannot clear.
  await content.loadRecentHistory(context, epoch - 1)
  assert.equal(content.historyLoading.value, false)
  assert.deepEqual(content.state.value.records, [older], 'late old history cannot replace the newly opened conversation')
  content.dispose()
} finally {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else globalThis.window = previousWindow
  await server.close()
}
console.log('conversation hydration and history loading tests passed')
