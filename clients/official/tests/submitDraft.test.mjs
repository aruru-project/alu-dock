import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createRenderer, h, nextTick, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// 2026-09-07: a pending native send locked Work navigation. Opening navigation
// must not let its eventual receipt consume another Work's or a newer editor.
const root = fileURLToPath(new URL('../', import.meta.url))
const catalog = { revision: 1, activeTarget: { kind: 'host', hostId: 'host-a' }, selectionGeneration: 1, hosts: [] }
const attachment = (fileId) => ({ fileId, name: `${fileId}.txt`, mediaType: 'text/plain', sizeBytes: 1, sha256: 'a', storedAt: '2026-09-07' })
const works = ['A', 'B'].map(id => ({ id, lifecycle: 'active', runtimeGeneration: 1, ownerHostEpoch: 'epoch', executor: { piSessionId: 'session' }, updatedAt: '2026-09-07' }))
const storage = new Map()
let storageWrites = 0, storageFails = false, consumeFails = false, stops = 0
const retainedOperations = new Map()
globalThis.window = {
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageFails) throw Error("fixture storage failure"); storageWrites++; storage.set(key, value) }, removeItem: key => storage.delete(key) },
  __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === 'pending_operations') return [...retainedOperations.values()]
    if (command === 'consume_operation') { if (consumeFails) throw Error('fixture ACK failure'); retainedOperations.delete(args.operationId); return }
    if (command === 'attachment_snapshot') return { revision: 1, jobs: [] }
    if (command === 'restored_image_count') return 0
    if (command === 'stop_work') { stops++; return { instance: { ...works.find(w => w.id === args.instanceId), lifecycle: 'stopped', execution: 'unavailable' }, receipt: { operationId: args.operationId } } }
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
  app.bindNativeOperation({ connectionId: 'host-a', instanceId: 'A', kind: 'new_session', state: 'unknown', operationId: 'old-operation' })
  assert.equal(app.unresolvedMutations.get(JSON.stringify(['host-a', 'A', 'sessions'])), 'old-operation')
  assert.equal(app.unresolvedMutations.has(JSON.stringify(['host-b', 'A', 'sessions'])), false, 'same Work id on another Host is not blocked')
  await app.switchHost('host-a')
  assert.equal(app.unresolvedMutations.get(JSON.stringify(['host-a', 'A', 'sessions'])), 'old-operation', 'returning to original Host still requires reconciliation, not blind replay')
  app.selectWork('B')
  app.setCurrentDraft('before WebView rebuild')
  const acrossView = app.captureSubmitDraft('host-a', 'B', [])
  app.flushLocalState()
  setActivePinia(createPinia())
  const rebuilt = useAppStore()
  await rebuilt.load()
  rebuilt.selectWork('B')
  rebuilt.setCurrentDraft('after WebView rebuild')
  rebuilt.completeSubmitDraft(acrossView)
  assert.equal(rebuilt.currentDraft, 'after WebView rebuild')
  assert.equal(rebuilt.applyReturnedDraft(acrossView, 'late returned text'), false)
  // Master-side review: failed returned-content storage used to consume the
  // only native receipt; successful append + failed ACK duplicated after F5.
  const { useOperationResults } = await server.ssrLoadModule('/src/lib/operationResults.ts')
  const { useWorkActions } = await server.ssrLoadModule('/src/lib/workActions.ts')
  const { useAttachmentUploads } = await server.ssrLoadModule('/src/lib/attachmentUploads.ts')
  const { attachmentUploadTarget } = await server.ssrLoadModule('/src/lib/attachmentDraft.ts')
  const scopes = []
  async function rebuild() {
    setActivePinia(createPinia())
    const store = useAppStore(); await store.load(); store.selectWork('B')
    const scope = effectScope(); scopes.push(scope)
    const results = scope.run(() => useOperationResults({ presentFailure: async () => {}, acceptWork: w => store.applyWorkSnapshot(w), queueRetrieved() {}, refreshRestoredImages: async () => {} }))
    return { store, results, scope }
  }
  storage.clear()
  let view = await rebuild()
  view.store.setCurrentDraft('original')
  view.store.flushLocalState()
  const operation = (id, kind, result, editor = view.store.captureSubmitDraft('host-a', 'B', [])) => ({ operationId: id, kind, state: 'succeeded', connectionId: 'host-a', instanceId: 'B', hostEpoch: 'epoch', runtimeGeneration: 1, sessionId: editor?.sessionId ?? '', editor, result })
  const queue = operation('queue', 'dequeue_messages', { instance: works[1], receipt: { restored: [{ queueItemId: 'q', text: 'returned Queue', attachments: [attachment('returned')], imageCount: 0 }] } }, null)
  retainedOperations.set(queue.operationId, queue)
  const saved = storage.get('aludock.uiState')
  storageFails = true
  await view.results.initialize()
  assert.equal(view.store.currentDraft, 'original')
  assert.equal(storage.get('aludock.uiState'), saved)
  assert.equal(view.store.captureOperationTarget(view.store.connectionContext, 'B').instanceId, 'B')
  assert.equal(retainedOperations.has('queue'), true)
  assert.deepEqual(view.results.workResults.value.map(item => item.operationId), ['queue'], 'save failure is available through the operation result retry')
  assert.equal(view.results.returnedOperations.value.length, 0, 'Queue does not offer a second append action')
  storageFails = false; consumeFails = true
  // Applying the retained result inserts before the current editor, without a capture.
  view.scope.stop(); view = await rebuild(); await view.results.initialize()
  assert.equal(view.store.currentDraft, 'returned Queue\n\noriginal')
  assert.deepEqual(view.store.currentAttachments.map(a => a.fileId), ['returned'])
  assert.equal(view.store.operationWasApplied('queue'), true)
  assert.equal(view.results.returnedOperations.value.length, 0)
  view.scope.stop(); view = await rebuild(); await view.results.initialize()
  assert.equal(view.store.currentDraft, 'returned Queue\n\noriginal')
  assert.equal(view.results.returnedOperations.value.length, 0, 'F5 offers ACK only, not insertion again')
  consumeFails = false
  await view.results.consumeNativeOperation(queue)
  assert.equal(retainedOperations.size, 0)
  assert.equal(view.store.operationWasApplied('queue'), false, 'confirmed claims are reclaimed, not a permanent ledger')

  // Fork auto-claim and explicit text append share the same atomic editor save.
  const fork = operation('fork', 'fork_session', { instance: works[1], selectedText: 'returned Fork' })
  retainedOperations.set(fork.operationId, fork)
  view.scope.stop(); view = await rebuild()
  const beforeFork = view.store.currentDraft
  storageFails = true; await view.results.initialize()
  assert.equal(view.store.currentDraft, beforeFork)
  assert.equal(retainedOperations.has('fork'), true)
  storageFails = false; view.store.setCurrentDraft('later draft'); view.store.flushLocalState()
  view.scope.stop(); view = await rebuild(); await view.results.initialize()
  storageFails = true; await view.results.restoreReturnedOperation(fork)
  assert.equal(view.store.currentDraft, 'later draft')
  assert.equal(retainedOperations.has('fork'), true)
  storageFails = false; consumeFails = true
  await view.results.restoreReturnedOperation(fork)
  assert.equal(view.store.currentDraft, 'later draft\n\nreturned Fork')
  view.scope.stop(); view = await rebuild(); await view.results.initialize()
  assert.equal(view.results.returnedOperations.value.length, 0)
  assert.equal(view.store.currentDraft, 'later draft\n\nreturned Fork')
  consumeFails = false; await view.results.consumeNativeOperation(fork)
  assert.deepEqual(JSON.parse(storage.get('aludock.uiState')).appliedOperationIds, [])
  console.log('PASS: Queue/Fork/explicit return save failure preserves receipt and editor; ACK failure + F5 applies once and reclaims confirmed marker')

  // A new Stop is independent from the old unknown model intent. Refresh and
  // explicit confirmation unlock new controls without rewriting that receipt.
  view.store.bindNativeOperation({ ...fork, operationId: 'unknown-model', kind: 'set_model', state: 'unknown', editor: null, result: null })
  const actions = view.scope.run(() => useWorkActions({ askConfirm: async () => true, closeModal() {} }, {
    observation: () => ({ load: async () => true, acceptWork() {} }), transitionBusy: () => false,
    restoreQueue: async () => true, panel: () => ({ reconcileDomain: async () => true }),
  }))
  await view.store.load()
  assert.equal(actions.mutationOutcomeUnknown.value, true)
  assert.equal(await actions.stopSelectedWork(), true)
  assert.equal(stops, 1)
  assert.equal(view.store.nativeOperations.get('unknown-model').state, 'unknown')
  await actions.reconcileMutationOutcome()
  assert.equal(actions.mutationOutcomeUnknown.value, false)
  assert.equal(view.store.nativeOperations.get('unknown-model').state, 'unknown')
  console.log('PASS: unknown model + refresh still permits confirmed Stop; manual continuation leaves original unknown intact')

  // App exit/legacy drafts lose upload jobs but not their permanent Host fileId.
  const uploads = view.scope.run(() => useAttachmentUploads({ page: () => ({ retirePreview() {}, moveAttachmentPreview() {} }), pairing: () => false, sendingOrRestoring: () => false, reportError() {} }))
  const target = attachmentUploadTarget(view.store.selectedWork, view.store.connectionContext)
  const persisted = { ...attachment('permanent'), localUpload: { ...target, jobId: 'previous-process-job' } }
  assert.equal(view.store.setCurrentAttachments([persisted]), true)
  view.scope.stop(); view = await rebuild()
  const restoredUploads = view.scope.run(() => useAttachmentUploads({ page: () => ({ retirePreview() {}, moveAttachmentPreview() {} }), pairing: () => false, sendingOrRestoring: () => false, reportError() {} }))
  await nextTick()
  assert.equal(await restoredUploads.verifyForSubmit(view.store.currentAttachments), true)
  assert.equal(await restoredUploads.verifyForSubmit([{ ...persisted, localUpload: { ...target } }]), true, 'legacy receipt needs no run job id')
  assert.equal(await restoredUploads.verifyForSubmit([{ ...persisted, localUpload: { ...target, ownerHostEpoch: 'other' } }]), false)
  assert.equal(view.store.setPendingAttachments([{ jobId: 'missing-source', revision: 'selection', sessionId: 'session' }]), true)
  assert.equal(restoredUploads.uploadDrafts.value[0].retryable, false, 'pending selection still requires a live source job')
  for (const scope of scopes) scope.stop()
  console.log('PASS: permanent fileId outlives source jobs; target epoch and pending-source boundaries remain')
  console.log('PASS: late send receipts preserve other Work/Host editors, changed/re-added drafts, replaced sessions and removed Works')
} finally {
  await server.close()
  delete globalThis.window
}
