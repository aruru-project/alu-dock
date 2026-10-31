import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(root, '.collaboration-check-'))
const calls = []
let submit
const work = (id, parentId) => ({ id, parentId, displayName: id, lifecycle: 'active', runtimeGeneration: 1, ownerHostEpoch: 'epoch', executor: { piSessionId: `session-${id}` } })
const works = [work('coordinator'), work('reviewer', 'coordinator'), work('implementer', 'coordinator')]
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
  calls.push({ command, args })
  if (command === 'get_host_catalog') return { revision: 1, selectionGeneration: 1, hosts: [], activeTarget: { kind: 'host', hostId: 'connection' } }
  if (command === 'bootstrap') return { connectionId: 'connection', selectionGeneration: 1, host: { hostEpoch: 'epoch' }, works, total: works.length }
  if (command === 'submit_message') return submit(args)
  if (command === 'list_works') return { works, total: works.length }
  throw new Error(`Unexpected native call ${command}`)
} } }
try {
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `export { useCollaborationStore } from '../src/stores/collaboration'; export { useAppStore } from '../src/stores/app';`)
  await build({ root, configFile: false, logLevel: 'silent', build: { outDir: directory, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'store.mjs' }, rolldownOptions: { external: ['vue', 'pinia'] } } })
  const { useAppStore, useCollaborationStore } = await import(join(directory, 'store.mjs'))
  setActivePinia(createPinia())
  const app = useAppStore(); await app.load(); app.selectWork('coordinator')
  const collaboration = useCollaborationStore()
  assert.deepEqual(collaboration.children.map(child => child.id), ['reviewer', 'implementer'])
  collaboration.draft.targetId = 'reviewer'; collaboration.draft.text = 'Review the change independently.'
  let resolve
  submit = args => new Promise(done => { resolve = done })
  const sending = collaboration.send()
  await collaboration.send()
  assert.equal(calls.filter(call => call.command === 'submit_message').length, 1, 'double click cannot send twice')
  const args = calls.find(call => call.command === 'submit_message').args
  assert.equal(args.instanceId, 'reviewer'); assert.equal(args.sessionId, 'session-reviewer')
  assert.equal(args.followUp, true); assert.equal(args.textOnly, true); assert.equal(args.operationEditor, null)
  assert.deepEqual(args.attachmentFileIds, [])
  app.selectWork('implementer')
  assert.equal(collaboration.draft.text, '')
  collaboration.draft.text = 'Separate draft'
  resolve({ receipt: { queued: true }, instance: works[1] }); await sending
  assert.equal(collaboration.draft.text, 'Separate draft', 'late send cannot erase another task draft')
  app.selectWork('coordinator'); assert.equal(collaboration.draft.text, '')
  assert.match(collaboration.draft.feedback, /后续队列/)
  collaboration.draft.text = 'Retain on failure'
  submit = async () => { throw { code: 'effect_unknown', outcomeUnknown: true, operationId: 'unknown' } }
  await collaboration.send()
  assert.equal(collaboration.draft.text, 'Retain on failure')
  assert.equal(collaboration.draft.pending, false)
  const count = calls.filter(call => call.command === 'submit_message').length
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call.command === 'submit_message').length, count, 'uncertain send never replays itself')
  app.selectWork('reviewer'); assert.equal(collaboration.parent.id, 'coordinator')
  console.log('PASS: collaboration relationships, text-only follow-up IPC, duplicate click, scoped drafts, delayed result, uncertain outcome without replay')
} finally { await rm(directory, { recursive: true, force: true }) }
