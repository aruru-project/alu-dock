// #275: exercise the real Reload confirmation button with event/reply reordering.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, reactive, nextTick } from 'vue'

const root = fileURLToPath(new URL('../', import.meta.url))
const filename = join(root, 'src/components/SessionManager.vue')
const directory = await mkdtemp(join(root, 'node_modules/.reload-check-'))
const stateKey = '__aluReloadCheck'
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
const detach = (item) => {
  if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
}
const insert = (item, parent, anchor) => {
  detach(item); item.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
}
// A tiny in-memory rendering target; Vue still owns setup, updates and button events.
const renderer = createRenderer({
  createElement: (tag) => node(tag), createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text), insert, remove: detach,
  setText: (item, text) => { item.text = text },
  setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  parentNode: (item) => item.parent,
  nextSibling: (item) => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
  setScopeId() {},
  insertStaticContent: (text, parent, anchor) => {
    const item = node('#static', text); insert(item, parent, anchor); return [item, item]
  },
})
const find = (item, predicate) => predicate(item) ? item : item.children.map((child) => find(child, predicate)).find(Boolean)
const hasClass = (name) => (item) => String(item.props.class ?? '').split(' ').includes(name)

try {
  const outfile = join(directory, 'component.mjs')
  await build({
    root, configFile: false, logLevel: 'silent',
    build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry: filename, formats: ['es'], fileName: () => 'component.mjs' },
      rolldownOptions: { external: ['vue'] },
    },
    plugins: [{ name: 'static-transport-fixture', enforce: 'pre',
      resolveId(id) { if (/^\.\.\/(lib\/bridge|stores\/app)$/.test(id)) return '\0fixture:'+id },
      load(id) {
        if (!id.startsWith('\0fixture:')) return
        return id.endsWith('/app')
          ? `export const useAppStore = () => globalThis.${stateKey}.store;`
          : `export const reloadSession = (...args) => globalThis.${stateKey}.reload(...args);
             const unused = () => { throw new Error('Unexpected session operation') };
             export { unused as cloneSession, unused as forkSession, unused as listSessions,
               unused as loadSessionTree, unused as nameSession, unused as navigateSession,
               unused as newSession, unused as switchSession };`
      },
    }, vue()],
  })
  const { default: SessionManager } = await import(outfile)
  for (const scenario of ['event-before-reply', 'reply-before-event', 'different-work', 'different-connection', 'different-host', 'newer-runtime', 'failure']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, name: 'Original work' })
    const store = reactive({ activeConnectionId: 'connection-a', connectionContext: { connectionId: 'connection-a', selectionGeneration: 1 } })
    let resolveReply, rejectReply, requests = 0
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
    globalThis[stateKey] = { store, reload: () => { requests++; return reply } }
    const resync = []
    const container = node('root')
    const app = renderer.createApp({ render: () => h(SessionManager, {
      work, mode: 'reload-session', preview: false, outcomeUnknown: false, hasDraft: false, compactionPending: false,
      onResync: (result) => { resync.push(result); Object.assign(work, result) },
    }) })
    app.mount(container)
    const confirm = find(container, (item) => item.type === 'button' && 'data-modal-initial' in item.props)
    assert.ok(confirm, 'The real Reload confirmation button must render')
    const pending = confirm.props.onClick()
    await nextTick()
    assert.equal(requests, 1)
    assert.equal(confirm.props.disabled, true, 'Pending Reload cannot be submitted twice')
    const result = { instance: { ...work, runtimeGeneration: 5 }, resources: [], diagnostics: [], resourceTotal: 3, diagnosticTotal: 0, resourcesTruncated: false, diagnosticsTruncated: false }
    if (scenario === 'event-before-reply') work.runtimeGeneration = 5
    if (scenario === 'different-work') work.id = 'work-b'
    if (scenario === 'different-connection') store.connectionContext.selectionGeneration = 2
    if (scenario === 'different-host') work.ownerHostEpoch = 'epoch-b'
    if (scenario === 'newer-runtime') work.runtimeGeneration = 6
    await nextTick()
    if (scenario === 'failure') rejectReply(new Error('Reload failed'))
    else resolveReply(result)
    await pending
    await nextTick()
    if (scenario === 'event-before-reply' || scenario === 'reply-before-event') {
      assert.equal(resync.length, 1, `${scenario}: successful Reload must resync the same Work`)
      assert.ok(find(container, hasClass('reload-summary')), `${scenario}: completion remains visible after resync`)
      assert.equal(find(container, hasClass('alu-dialog-error')), undefined, `${scenario}: no false target-switch error`)
    } else {
      assert.equal(resync.length, 0, `${scenario}: do not apply an old or failed result`)
      assert.equal(find(container, hasClass('reload-summary')), undefined)
      assert.ok(find(container, hasClass('alu-dialog-error')))
    }
    app.unmount()
    console.log(`PASS: Reload confirmation / ${scenario}`)
  }
} finally {
  delete globalThis[stateKey]
  await rm(directory, { recursive: true, force: true })
}
