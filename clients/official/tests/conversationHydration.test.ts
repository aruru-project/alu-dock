import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ref } from 'vue'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { projectConversation } from '../src/lib/conversation.ts'
import type { ConversationBootstrap, ConversationRecord, Work } from '../src/lib/types.ts'

const attachment = { fileId: '62cc3540-3cee-49bb-a41d-e0122d22afcc', name: 'Screenshot.jpg', sizeBytes: 640075, mediaType: 'image/jpeg', sha256: 'a'.repeat(64), storedAt: '2026-08-21T01:05:04.954Z' }
const preview: ConversationRecord = { recordId: 'record-1', entryId: 'entry-1', kind: 'message', source: 'user', visibility: 'conversation', content: [{ type: 'image', mimeType: 'image/jpeg', fileId: attachment.fileId }], attachments: [attachment] }
const older: ConversationRecord = { recordId: 'record-0', entryId: 'entry-0', kind: 'message', source: 'user', visibility: 'conversation', content: [{ type: 'text', text: 'earlier' }] }
const initial = (records = [preview]): ConversationBootstrap => ({
  instance: { id: 'work-1', execution: 'idle', runtimeGeneration: 1 } as Work,
  records, activeEvents: [], queue: [], extensionUi: { status: {}, toolsExpanded: false, events: [] },
  cursor: { hostEpoch: 'epoch-1', instanceId: 'work-1', runtimeGeneration: 1, sequence: 4 }, historyRevision: 1, historyTruncated: true,
})
const before = projectConversation(initial()).find(item => item.kind === 'user')
assert.equal(before?.kind === 'user' && before.images?.[0]?.source, undefined)
assert.equal(before?.kind === 'user' && before.images?.[0]?.name, 'Screenshot.jpg')
assert.equal(before?.kind === 'user' && before.images?.[0]?.historyEntryId, 'entry-1')

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
const previousWindow = globalThis.window
const frames = new Map<number, FrameRequestCallback>()
let frame = 0
const requests: Array<{ command: string; args: Record<string, unknown> }> = []
globalThis.window = {
  requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++frame, callback); return frame },
  cancelAnimationFrame(id: number) { frames.delete(id) },
  __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => { requests.push({ command, args }) } },
} as unknown as Window & typeof globalThis
function paint() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0) }
try {
  const { useConversationContent } = await server.ssrLoadModule('/src/lib/conversationContent.ts')
  const { useConversationSession } = await server.ssrLoadModule('/src/lib/conversationSession.ts')
  const content = useConversationContent({ compact: { value: false }, beforeLayoutChange: () => null,
    afterLayoutChange: async () => {}, isFollowing: () => false, layoutChanged: () => {}, projected: () => {} })
  content.publish(initial())
  const scope = ref({ connectionId: 'local', selectionGeneration: 1, instanceId: 'work-1', hostEpoch: 'epoch-1' })
  const session = useConversationSession(scope, content)
  session.bind('native-content', true)
  const deliver = (record: ConversationRecord, beforeEntryId?: string) => session.accept('native-content', {
    kind: 'record_chunk', entryId: record.entryId, text: JSON.stringify(record), first: true, complete: true, beforeEntryId,
  })
  await session.loadEarlier()
  assert.deepEqual(requests.shift(), { command: 'read_conversation_content', args: { ...scope.value, expectedHostEpoch: 'epoch-1', token: 'native-content', intent: 'earlier', entryIds: [] } }, 'the region sends a local intent, not a guessed history cursor or a global refresh')
  deliver(older, 'entry-1'); paint()
  assert.deepEqual(content.state.value.records.map((record: ConversationRecord) => record.entryId), ['entry-0', 'entry-1'])
  session.accept('native-content', { kind: 'entry_state', entryId: 'slow-entry', loading: true })
  const completed = { ...preview, content: [{ type: 'text', text: 'Complete text before the image.' }, { type: 'image', mimeType: 'image/jpeg', fileId: attachment.fileId, nativeMedia: { handle: 'verified-local-image', mimeType: 'image/jpeg', sizeBytes: 640075, sha256: 'a'.repeat(64) } }] }
  deliver(completed as ConversationRecord); paint()
  const ready = content.items.value.find((item: { id: string }) => item.id === 'record-1')
  assert.equal(ready.text, 'Complete text before the image.')
  assert.equal(ready.images[0].source.type, 'native', 'a completed body uses the retained native image handle')
  assert.equal(ready.images[0].fileId, attachment.fileId)
  assert.equal(content.historyHydrating.value, true, 'an unrelated slow entry does not delay this completed record')
  await session.retry('slow-entry')
  assert.equal(requests.at(-1)?.args.intent, 'retry')
  assert.deepEqual(requests.at(-1)?.args.entryIds, ['slow-entry'])

  // Phase two: authoritative sequence coverage, not text/live-ID guesses. Keep
  // the old rendered surface through the handoff, then retain only post-cut raw.
  const baseline = initial([older])
  baseline.activeEvents = [2, 4].map(sequence => ({ instanceId: 'work-1', runtimeGeneration: 1, sequence,
    eventType: 'message.completed', occurredAt: 'now', data: { messageId: `private-live-${sequence}`, role: 'assistant', content: [{ type: 'text', text: sequence === 2 ? 'same reply' : 'late reply' }] } }))
  content.publish(baseline)
  const oldItems = content.items.value
  const checkpoint = initial([]); checkpoint.cursor.sequence = 3
  content.acceptReadCut(3)
  session.accept('native-content', { kind: 'checkpoint_begin', bootstrap: checkpoint })
  deliver({ ...older, recordId: 'authoritative', entryId: 'authoritative', source: 'assistant', content: [{ type: 'text', text: 'same reply' }] })
  paint()
  assert.equal(content.items.value, oldItems, 'no half-published coverage retires the prior raw surface')
  session.accept('native-content', { kind: 'checkpoint_end' })
  assert.deepEqual(content.state.value.activeEvents.map((event: { sequence: number }) => event.sequence), [4])
  const texts = content.items.value.filter((item: { kind: string }) => item.kind === 'assistant').map((item: { text: string }) => item.text)
  assert.deepEqual(texts, ['same reply', 'late reply'])
  const retained = content.state.value.records[0]
  content.acceptReadCut(4)
  session.accept('native-content', { kind: 'checkpoint_begin', bootstrap: { ...checkpoint, cursor: { ...checkpoint.cursor, sequence: 4 } } })
  deliver(retained)
  session.accept('native-content', { kind: 'entry_state', entryId: 'authoritative', loading: false, error: '这部分内容暂时无法读取，请重试。' })
  deliver(older)
  session.accept('native-content', { kind: 'checkpoint_end' })
  assert.deepEqual(content.state.value.records.find((record: ConversationRecord) => record.entryId === 'authoritative'), retained, 'a network body failure retains accepted content')
  assert.ok(content.hydrationErrors.value.authoritative)
  assert.ok(content.items.value.some((item: { id: string }) => item.id === 'record-0'), 'other records still seed after one body failure')
  deliver({ ...retained, content: [{ type: 'text', text: 'Re-read complete content' }] }); paint()
  session.accept('native-content', { kind: 'entry_state', entryId: 'authoritative', loading: false })
  assert.equal(content.hydrationErrors.value.authoritative, undefined)
  session.bind('new-branch', false)
  deliver(preview)
  assert.equal(content.state.value.records.length, 2, 'a late old-domain body cannot enter a new binding')
  content.dispose()

  const makeView = () => useConversationContent({ compact: { value: false }, beforeLayoutChange: () => null,
    afterLayoutChange: async () => {}, isFollowing: () => false, layoutChanged: () => {}, projected: () => {} })
  function chunks(view: ReturnType<typeof makeView>, record: ConversationRecord, beforeEntryId?: string) {
    const bytes = Buffer.from(JSON.stringify(record)), decoder = new TextDecoder()
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const complete = offset + 32768 >= bytes.length
      view.applyContent({ kind: 'record_chunk', entryId: record.entryId, first: offset === 0, complete, beforeEntryId,
        text: decoder.decode(bytes.subarray(offset, offset + 32768), { stream: !complete }) })
      paint()
    }
  }
  await test('long UTF-8 records retain native order across a batched seed', () => {
    const view = makeView(); view.publish(initial([]))
    const records = view.state.value.records
    const message = (id: string): ConversationRecord => ({ ...older, recordId: id, entryId: id, content: [{ type: 'text', text: '中文🦉'.repeat(15000) }] })
    view.applyContent({ kind: 'checkpoint_begin', bootstrap: initial([]), replay: true })
    chunks(view, message('oldest'))
    chunks(view, message('middle'))
    chunks(view, message('newest'))
    view.applyContent({ kind: 'checkpoint_end' })
    assert.equal(view.state.value.records, records)
    assert.deepEqual(records.map((record: ConversationRecord) => record.entryId), ['oldest', 'middle', 'newest'])
    assert.deepEqual(view.items.value.filter((item: { kind: string }) => item.kind === 'user').map((item: { id: string }) => item.id), ['oldest', 'middle', 'newest'])
    assert.ok(records.every((record: ConversationRecord) => record.content[0]?.type === 'text' && record.content[0].text === '中文🦉'.repeat(15000)))
    view.dispose()
  })
  await test('a seeded tool caller and result stay grouped in the sole records array', () => {
    const view = makeView(); view.publish(initial([]))
    const caller: ConversationRecord = { ...older, recordId: 'caller', entryId: 'caller', source: 'assistant', content: [{ type: 'tool_call', toolCallId: 'call-1', toolName: 'read', args: { path: 'saved' } }] }
    const result: ConversationRecord = { ...older, recordId: 'result', entryId: 'result', source: 'tool', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'tool_result', toolCallId: 'call-1', toolName: 'read', text: 'saved output', isError: false }] }
    view.applyContent({ kind: 'checkpoint_begin', bootstrap: initial([]), replay: true })
    chunks(view, caller)
    chunks(view, result); chunks(view, { ...older, recordId: 'newest', entryId: 'newest' })
    view.applyContent({ kind: 'checkpoint_end' })
    assert.deepEqual(view.state.value.records.map((record: ConversationRecord) => record.entryId), ['caller', 'result', 'newest'])
    const tools = view.items.value.filter((item: { kind: string }) => item.kind === 'tool')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].groupId, 'record:caller')
    assert.equal(tools[0].detailOutputText, 'saved output')
    view.dispose()
  })
  await test('current read-to-start facts survive seed End instead of reverting to the old read window', () => {
    const view = makeView(), region = useConversationSession(scope, view)
    view.publish(initial([]))
    view.applyContent({ kind: 'checkpoint_begin', bootstrap: initial([]), replay: true })
    chunks(view, older); view.applyContent({ kind: 'checkpoint_end' })
    assert.equal(view.historyTruncated.value, true, 'initial loading without a State retains its initial read fact')
    region.bind('retained', false)
    view.applyContent({ kind: 'checkpoint_begin', bootstrap: initial([]), replay: true })
    view.applyContent({ kind: 'state', canLoadEarlier: false, loading: false })
    chunks(view, older); view.applyContent({ kind: 'checkpoint_end' })
    assert.equal(view.historyTruncated.value, false, 'End cannot replace a current State with an old historyTruncated flag')
    assert.equal(view.state.value.historyTruncated, false)
    region.bind('retained', false)
    view.applyContent({ kind: 'checkpoint_begin', bootstrap: initial([]), replay: true })
    chunks(view, older); view.applyContent({ kind: 'checkpoint_end' })
    assert.equal(view.historyTruncated.value, false, 'the current native header is sufficient even without a further State')
    view.dispose()
  })
} finally {
  globalThis.window = previousWindow
  await server.close()
}
console.log('conversation content: local intents, independent publication, image metadata and authoritative raw-tail handoff passed')
