import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'

// 2026-09-07: a pending native send locked Work navigation. Opening navigation
// must not let its eventual receipt consume another Work's or a newer editor.
const root = fileURLToPath(new URL('../', import.meta.url))
const catalog = { revision: 1, activeTarget: { kind: 'host', hostId: 'host-a' }, selectionGeneration: 1, hosts: [] }
const attachment = (fileId) => ({ fileId, name: `${fileId}.txt`, mediaType: 'text/plain', sizeBytes: 1, sha256: 'a', storedAt: '2026-09-07' })
const works = ['A', 'B'].map(id => ({ id, lifecycle: 'active', runtimeGeneration: 1, ownerHostEpoch: 'epoch', updatedAt: '2026-09-07' }))
const storage = new Map()
globalThis.window = {
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === 'get_host_catalog') return structuredClone(catalog)
    if (command === 'set_active_host') {
      catalog.activeTarget.hostId = args.hostId
      catalog.selectionGeneration++
      return structuredClone(catalog)
    }
    if (command === 'bootstrap') return { ...args, host: { hostEpoch: 'epoch' }, works: structuredClone(works), total: 2 }
    throw new Error(`Unexpected native call: ${command}`)
  } },
}
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { useAppStore } = await server.ssrLoadModule('/src/stores/app.ts')
  setActivePinia(createPinia())
  const app = useAppStore()
  await app.load()
  app.selectWork('A')
  app.setCurrentDraft('first')
  app.setCurrentAttachments([attachment('sent')])
  const first = app.captureSubmitDraft('host-a', 'A', app.currentAttachments)
  app.selectWork('B')
  app.setCurrentDraft('other Work')
  app.setCurrentAttachments([attachment('other')])
  app.completeSubmitDraft(first)
  assert.equal(app.selectedWorkId, 'B')
  assert.equal(app.currentDraft, 'other Work')
  assert.deepEqual(app.currentAttachments.map(item => item.fileId), ['other'])
  app.selectWork('A')
  assert.equal(app.currentDraft, '')
  assert.deepEqual(app.currentAttachments, [])

  app.setCurrentDraft('original')
  app.setCurrentAttachments([attachment('sent')])
  const edited = app.captureSubmitDraft('host-a', 'A', app.currentAttachments)
  app.setCurrentDraft('changed')
  app.setCurrentDraft('original') // same text is now a new draft
  app.setCurrentAttachments([])
  app.setCurrentAttachments([attachment('sent'), attachment('new')])
  app.completeSubmitDraft(edited)
  assert.equal(app.currentDraft, 'original')
  assert.deepEqual(app.currentAttachments.map(item => item.fileId), ['sent', 'new'])

  const beforeSwitch = app.captureSubmitDraft('host-a', 'A', app.currentAttachments)
  await app.switchHost('host-b')
  app.selectWork('A') // intentionally colliding Work identifier on another Host
  app.setCurrentDraft('another Host')
  app.setCurrentAttachments([attachment('sent')])
  app.completeSubmitDraft(beforeSwitch)
  assert.equal(app.currentDraft, 'another Host')
  assert.deepEqual(app.currentAttachments.map(item => item.fileId), ['sent'])
  await app.switchHost('host-a')
  app.selectWork('A')
  assert.equal(app.currentDraft, '')
  assert.deepEqual(app.currentAttachments, [])

  app.setCurrentDraft('session draft')
  app.setCurrentAttachments([attachment('session-file')])
  const beforeSession = app.captureSubmitDraft('host-a', 'A', app.currentAttachments)
  app.invalidateSubmitDraft('host-a', 'A')
  app.completeSubmitDraft(beforeSession)
  assert.equal(app.currentDraft, 'session draft')
  assert.equal(app.currentAttachments.length, 1)
  const beforeRemoval = app.captureSubmitDraft('host-a', 'A', app.currentAttachments)
  app.removeWorkSnapshot('A')
  app.completeSubmitDraft(beforeRemoval)
  assert.equal(app.selectedWorkId, null)
  assert.equal(app.works.some(work => work.id === 'A'), false)
  console.log('PASS: late send receipts preserve other Work/Host editors, changed/re-added drafts, replaced sessions and removed Works')
} finally {
  await server.close()
  delete globalThis.window
}
