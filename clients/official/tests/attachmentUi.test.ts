import assert from 'node:assert/strict'
import { appendRestoredQueue, attachmentsAfterSubmit, moveAttachmentPreviewResource } from '../src/lib/attachmentDraft.ts'
import { projectConversation } from '../src/lib/conversation.ts'
import { draftAfterSubmit } from '../src/lib/uiBoundaries.ts'
import { decodeLocalUiState } from '../src/lib/localState.ts'
import { persistDeviceNamePreference, readDeviceNamePreference, resolveDeviceName } from '../src/lib/deviceName.ts'
import type { AttachmentDto, ConversationBootstrap, QueueItem } from '../src/lib/types.ts'

const attachment: AttachmentDto = {
  fileId: '45c6f7e8-9462-4fde-8ab9-1829dff71234',
  name: 'report.pdf',
  sizeBytes: 42,
  mediaType: 'application/pdf',
  sha256: 'a'.repeat(64),
  storedAt: '2026-08-17T00:00:00.000Z',
}

{
  const migrated = decodeLocalUiState(JSON.stringify({
    schemaVersion: 1,
    activeHostId: 'host-a',
    hosts: { 'host-a': { selectedWorkId: 'work-a', drafts: { 'work-a': 'still here' }, detailMode: false } },
  }))
  assert.equal(migrated?.schemaVersion, 2)
  assert.equal(migrated?.hosts['host-a']?.drafts['work-a'], 'still here')
  assert.equal(Object.keys(migrated?.hosts['host-a']?.attachments ?? {}).length, 0)
}

{
  const restored = decodeLocalUiState(JSON.stringify({
    schemaVersion: 2,
    activeHostId: 'host-a',
    hosts: { 'host-a': { selectedWorkId: 'work-a', drafts: {}, attachments: { 'work-a': [attachment] }, detailMode: true } },
  }))
  assert.deepEqual(restored?.hosts['host-a']?.attachments['work-a'], [attachment])
}

{
  const queueSizedDraft = Array.from({ length: 33 }, (_, index) => ({ ...attachment, fileId: `file-${index}` }))
  const restored = decodeLocalUiState(JSON.stringify({
    schemaVersion: 2,
    activeHostId: 'host-a',
    hosts: { 'host-a': { selectedWorkId: 'work-a', drafts: {}, attachments: { 'work-a': queueSizedDraft }, detailMode: true } },
  }))
  assert.equal(restored?.hosts['host-a']?.attachments['work-a']?.length, 33)
  assert.deepEqual(attachmentsAfterSubmit(queueSizedDraft, queueSizedDraft.slice(0, 32).map((item) => item.fileId), true), [queueSizedDraft[32]])
}

{
  const addedDuringAwait = { ...attachment, fileId: 'f1bd252c-cbd6-44d6-b617-62f5f2946610', name: 'new.txt' }
  assert.equal(draftAfterSubmit('captured plus newer typing', 'captured', true), 'captured plus newer typing')
  assert.deepEqual(attachmentsAfterSubmit([attachment, addedDuringAwait], [attachment.fileId], true), [addedDuringAwait])
  assert.deepEqual(attachmentsAfterSubmit([attachment], [attachment.fileId], false), [attachment])
}

{
  const restoredItem: QueueItem = { queueItemId: 'q1', delivery: 'followUp', text: 'queued text', attachments: [attachment], imageCount: 2, acceptedAt: '2026-08-17T00:00:00.000Z' }
  const inFlight: QueueItem = { queueItemId: 'q2', delivery: 'steer', text: 'must not return', attachments: [{ ...attachment, fileId: '7aa2aed0-d5d4-4ee3-acaf-223ef2043374' }], imageCount: 1, acceptedAt: '2026-08-17T00:00:01.000Z' }
  const result = appendRestoredQueue('new typing', [], [restoredItem], [inFlight])
  assert.equal(result.text, 'new typing\n\nqueued text')
  assert.deepEqual(result.attachments, [attachment])
  assert.equal(result.restoredImageCount, 2)
  assert.equal(result.inFlightCount, 1)
  assert.ok(!result.text.includes('must not return'))
}

{
  const bootstrap = {
    instance: { id: 'work', execution: 'idle' },
    records: [{ recordId: 'record', entryId: 'entry', kind: 'message', source: 'user', visibility: 'conversation', content: [], attachments: [attachment] }],
    activeEvents: [{ sequence: 1, runtimeGeneration: 1, occurredAt: '2026-08-17T00:00:00.000Z', eventType: 'message.submitted', data: { messageId: 'live', text: '', attachments: [attachment] } }],
  } as unknown as ConversationBootstrap
  const projected = projectConversation(bootstrap).filter((item) => item.kind === 'user')
  assert.equal(projected.length, 2)
  assert.deepEqual(projected.map((item) => item.kind === 'user' ? item.attachments : undefined), [[attachment], [attachment]])
}

{
  const localPreview = { url: 'blob:local', mediaType: 'image/png' }
  const migrated = moveAttachmentPreviewResource({ 'local-token': localPreview }, 'local-token', attachment.fileId)
  assert.equal(migrated.moved, localPreview)
  assert.equal(migrated.replaced, undefined, 'a successful first upload has no destination preview to dereference')
  assert.deepEqual(migrated.resources, { [attachment.fileId]: localPreview })

  const oldRemotePreview = { url: 'blob:old', mediaType: 'image/png' }
  const replaced = moveAttachmentPreviewResource({ 'local-token': localPreview, [attachment.fileId]: oldRemotePreview }, 'local-token', attachment.fileId)
  assert.equal(replaced.replaced, oldRemotePreview, 'only a real replaced preview is returned for URL revocation')
  assert.deepEqual(replaced.resources, { [attachment.fileId]: localPreview })
}

{
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  assert.equal(persistDeviceNamePreference(storage, 'NUC14'), true)
  const restoredAfterAuthorizationWasRevoked = readDeviceNamePreference(storage)
  assert.equal(resolveDeviceName(restoredAfterAuthorizationWasRevoked, 'AluDock Client', 'system-hostname'), 'NUC14')
  assert.equal(resolveDeviceName(null, 'host-b-name', 'stale-host-a-name'), 'host-b-name')
}

console.log('attachment UI state tests passed')
