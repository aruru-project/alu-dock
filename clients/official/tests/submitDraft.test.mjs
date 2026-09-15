import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createRenderer, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// 2026-09-07: a pending native send locked Work navigation. Opening navigation
// must not let its eventual receipt consume another Work's or a newer editor.
const root = fileURLToPath(new URL('../', import.meta.url))
const catalog = { revision: 1, activeTarget: { kind: 'host', hostId: 'host-a' }, selectionGeneration: 1, hosts: [] }
const attachment = (fileId) => ({ fileId, name: `${fileId}.txt`, mediaType: 'text/plain', sizeBytes: 1, sha256: 'a', storedAt: '2026-09-07' })
const works = ['A', 'B'].map(id => ({ id, lifecycle: 'active', runtimeGeneration: 1, ownerHostEpoch: 'epoch', updatedAt: '2026-09-07' }))
const storage = new Map()
let storageWrites = 0
globalThis.window = {
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storageWrites++; storage.set(key, value) }, removeItem: key => storage.delete(key) },
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
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' })
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
  app.selectWork('B')
  const beforeTyping = storageWrites
  app.setCurrentDraft('typing one'); app.setCurrentDraft('typing two')
  assert.equal(storageWrites, beforeTyping, 'keystrokes do not synchronously serialize every Work draft')
  app.flushLocalState()
  assert.equal(storageWrites, beforeTyping + 1, 'lifecycle flush writes the latest complete state once')
  assert.ok([...storage.values()].some(value => value.includes('typing two')))

  const frames = new Map()
  let frameId = 0, focusCount = 0, sizeReads = 0, flushes = 0
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = id => frames.delete(id)
  const textarea = () => ({ selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', style: {},
    get scrollHeight() { sizeReads++; return 80 }, focus() { focusCount++ },
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction },
  })
  const { useComposer } = await server.ssrLoadModule('/src/lib/composer.ts')
  let composer
  const renderer = createRenderer({ createElement: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setElementText() {}, patchProp() {}, parentNode() {}, nextSibling() {} })
  const mounted = renderer.createApp({ setup() {
    composer = useComposer({ read: () => app.currentDraft, write: value => app.setCurrentDraft(value), identity: () => app.selectedWorkId, flush: () => { flushes++; app.flushLocalState() }, canFocus: () => true })
    return () => h('div')
  } })
  mounted.mount({})
  composer.compact.value = textarea(); composer.expandedTextarea.value = textarea()
  composer.remember({ currentTarget: composer.compact.value })
  composer.composition({ type: 'compositionstart', currentTarget: composer.compact.value })
  assert.equal(composer.composing.value, true)
  composer.draft.value = '组词草稿'; composer.resize(); composer.resize()
  await nextTick(); await nextTick()
  for (const callback of frames.values()) callback()
  frames.clear()
  assert.equal(sizeReads, 1, 'one resize schedule owns changes from input and draft updates')
  assert.equal(focusCount, 0, 'editing/sizing never forces native focus')
  composer.composition({ type: 'compositionend', currentTarget: composer.compact.value })
  composer.expanded.value = true
  await nextTick(); await nextTick()
  assert.equal(composer.expandedTextarea.value.selectionStart, 2)
  assert.equal(composer.expandedTextarea.value.selectionEnd, 5)
  assert.equal(composer.expandedTextarea.value.selectionDirection, 'backward')
  assert.equal(composer.draft.value, app.currentDraft)
  assert.equal(focusCount, 1, 'only the explicit surface transition transfers focus')
  mounted.unmount()
  assert.ok(flushes > 0, 'unmount reliably flushes the latest draft')
  app.recordMutationUnknown({ connectionId: 'host-a', instanceId: 'A' }, 'sessions', { outcomeUnknown: true, operationId: 'old-operation' })
  assert.equal(app.unresolvedMutations.get(JSON.stringify(['host-a', 'A', 'sessions'])), 'old-operation')
  assert.equal(app.unresolvedMutations.has(JSON.stringify(['host-b', 'A', 'sessions'])), false, 'same Work id on another Host is not blocked')
  await app.switchHost('host-a')
  assert.equal(app.unresolvedMutations.get(JSON.stringify(['host-a', 'A', 'sessions'])), 'old-operation', 'returning to original Host still requires reconciliation, not blind replay')
  console.log('PASS: late send receipts preserve other Work/Host editors, changed/re-added drafts, replaced sessions and removed Works')
} finally {
  await server.close()
  delete globalThis.window
}
