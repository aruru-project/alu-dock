import assert from 'node:assert/strict'
import { appendRestoredQueue, attachmentUploadMatches, attachmentUploadTarget, attachmentsAfterSubmit, bindLocalAttachment, moveAttachmentPreviewResource } from '../src/lib/attachmentDraft.ts'
import { projectConversation } from '../src/lib/conversation.ts'
import { draftAfterSubmit } from '../src/lib/uiBoundaries.ts'
import { decodeLocalUiState, persistLocalUiState } from '../src/lib/localState.ts'
import { persistDeviceNamePreference, readDeviceNamePreference, resolveDeviceName } from '../src/lib/deviceName.ts'
import type { AttachmentDto, ConversationBootstrap, QueueItem, Work } from '../src/lib/types.ts'

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
  assert.equal(migrated?.schemaVersion, 4)
  assert.equal(migrated?.connections['host-a']?.drafts['work-a'], 'still here')
  assert.equal(Object.keys(migrated?.connections['host-a']?.attachments ?? {}).length, 0)
}

{
  const restored = decodeLocalUiState(JSON.stringify({
    schemaVersion: 2,
    activeHostId: 'host-a',
    hosts: { 'host-a': { selectedWorkId: 'work-a', drafts: {}, attachments: { 'work-a': [attachment] }, detailMode: true } },
  }))
  assert.deepEqual(restored?.connections['host-a']?.attachments['work-a'], [attachment])
}

{
  const work = { id: 'remote-work', hostId: 'subhost-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 7 } as Work
  const target = attachmentUploadTarget(work, { connectionId: 'main-host', selectionGeneration: 3 })
  const bound = bindLocalAttachment(attachment, 'native-token', target)
  assert.equal(attachmentUploadMatches(bound.localUpload, target), true)
  for (const changed of [
    { ...target, instanceId: 'other-work' },
    { ...target, machineHostId: 'subhost-b' },
    { ...target, runtimeGeneration: 8 },
  ]) assert.equal(attachmentUploadMatches(bound.localUpload, changed), false)

  const restored = decodeLocalUiState(JSON.stringify({
    schemaVersion: 3,
    activeHostId: 'main-host',
    hosts: { 'main-host': { selectedWorkId: 'remote-work', drafts: {}, attachments: { 'remote-work': [bound] }, recentWorkspaces: {}, detailMode: true } },
  }))
  assert.deepEqual(restored?.connections['main-host']?.attachments['remote-work']?.[0]?.localUpload, { ...target, jobId: 'native-token' })
  assert.equal(Object.hasOwn(restored!.connections['main-host']!.attachments['remote-work']![0]!.localUpload!, 'sourceToken'), false, 'only the job association survives storage; native query must verify the current run')

  let serialized = ''
  assert.equal(persistLocalUiState({ setItem: (_key: string, value: string) => { serialized = value } } as Storage, {
    schemaVersion: 4,
    activeConnectionId: 'main-host',
    connections: { 'main-host': { selectedWorkId: 'remote-work', drafts: {}, attachments: { 'remote-work': [bound] }, recentWorkspaces: {}, detailMode: true } },
  }), true)
  assert.equal(serialized.includes('sourceToken'), false)
  assert.equal(JSON.parse(serialized).connections['main-host'].attachments['remote-work'][0].localUpload.jobId, 'native-token')
}

{
  const queueSizedDraft = Array.from({ length: 33 }, (_, index) => ({ ...attachment, fileId: `file-${index}` }))
  const restored = decodeLocalUiState(JSON.stringify({
    schemaVersion: 2,
    activeHostId: 'host-a',
    hosts: { 'host-a': { selectedWorkId: 'work-a', drafts: {}, attachments: { 'work-a': queueSizedDraft }, detailMode: true } },
  }))
  assert.equal(restored?.connections['host-a']?.attachments['work-a']?.length, 33)
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
  const result = appendRestoredQueue('new typing', [], [restoredItem])
  assert.equal(result.text, 'new typing\n\nqueued text')
  assert.deepEqual(result.attachments, [attachment])
  assert.equal(result.restoredImageCount, 2)
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
  const localPreview = { url: 'http://aludock-media.localhost/local', mediaType: 'image/png' }
  const migrated = moveAttachmentPreviewResource({ 'local-token': localPreview }, 'local-token', attachment.fileId)
  assert.equal(migrated.moved, localPreview)
  assert.deepEqual(migrated.resources, { [attachment.fileId]: localPreview })

  const oldRemotePreview = { url: 'http://aludock-media.localhost/old', mediaType: 'image/png' }
  const replaced = moveAttachmentPreviewResource({ 'local-token': localPreview, [attachment.fileId]: oldRemotePreview }, 'local-token', attachment.fileId)
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
