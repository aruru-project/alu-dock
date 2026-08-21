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

const hydrated = mergeHydratedConversationRecords([preview], [completed])
const after = project(hydrated).find((item) => item.kind === 'user')
assert.deepEqual(
  after?.kind === 'user' ? after.images?.[0]?.source : undefined,
  { type: 'inline', data: '/9j/', mimeType: 'image/jpeg' },
  '完整历史载入后，同一条消息恢复可显示的图片内容',
)
console.log('conversation hydration tests passed')
