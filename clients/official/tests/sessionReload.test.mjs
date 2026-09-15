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
const directory = await mkdtemp(join(root, '.reload-check-'))
const stateKey = '__aluReloadCheck'
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, focus() {}, select() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] } })
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
const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await nextTick() }
let copied = ''
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value } } } })
globalThis.window = { clearTimeout, setTimeout, __TAURI_INTERNALS__: { invoke: (command, args) => globalThis[stateKey].invoke(command, args) } }
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
      resolveId(id) { if (id === '../stores/app') return '\0store-fixture' },
      load(id) { if (id === '\0store-fixture') return `export const useAppStore = () => globalThis.${stateKey}.store;` },
    }, vue()],
  })
  const { default: SessionManager } = await import(outfile)
  for (const scenario of ['event-before-reply', 'reply-before-event', 'different-work', 'different-connection', 'different-host', 'newer-runtime', 'failure']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, name: 'Original work' })
    const store = reactive({ activeConnectionId: 'connection-a', connectionContext: { connectionId: 'connection-a', selectionGeneration: 1 } })
    let resolveReply, rejectReply, requests = 0
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
    globalThis[stateKey] = { store, invoke: (command) => { assert.equal(command, 'reload_session'); requests++; return reply } }
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

  // The other replacement buttons share Reload's receipt rule. In each case
  // the real native-edge command is held until Follow has published its runtime.
  for (const operation of ['new', 'switch', 'navigate', 'fork', 'clone']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
    const store = reactive({ activeConnectionId: 'connection-a', connectionContext: { connectionId: 'connection-a', selectionGeneration: 1 } })
    const nodes = [
      { entryId: 'selected-user', kind: 'message', role: 'user', displayClass: 'content', summary: 'Selected user', hasChildren: true, depth: 0 },
      { entryId: 'current-leaf', parentId: 'selected-user', kind: 'message', role: 'assistant', displayClass: 'content', summary: 'Current reply', depth: 1 },
    ]
    let resolveReply
    const reply = new Promise(resolve => { resolveReply = resolve })
    const calls = [], resync = []
    globalThis[stateKey] = { store, invoke: async (command, args) => {
      if (command === 'list_sessions') return { sessions: [{ token: 'saved', name: 'Saved session', cwd: '/project' }], truncated: false, total: 1 }
      if (command === 'session_tree') return { nodes, leafId: 'current-leaf', instance: { ...work } }
      calls.push({ command, args }); return reply
    } }
    const container = node('root')
    const mounted = renderer.createApp({ render: () => h(SessionManager, {
      work, mode: operation === 'new' ? 'new-session' : operation === 'switch' ? 'sessions' : 'tree', preview: false, outcomeUnknown: false, hasDraft: true, compactionPending: false,
      onResync: (...args) => resync.push(args),
    }) })
    mounted.mount(container)
    await settle()
    if (operation === 'switch') find(container, hasClass('ui-dialog-option')).props.onClick()
    else if (operation !== 'new') {
      find(container, item => item.props['data-tree-node'] !== undefined && text(item).includes('Selected user')).props.onClick()
      await nextTick()
      const label = { navigate: '直接切换', fork: 'Fork', clone: 'Clone' }[operation]
      const button = find(container, item => item.type === 'button' && text(item) === label)
      assert.equal(button.props.disabled, false)
      button.props.onClick()
    }
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `${operation}_session`)
    assert.equal(calls[0].args.instanceId, 'work-a')
    if (['navigate', 'fork', 'clone'].includes(operation)) assert.equal(calls[0].args[operation === 'navigate' ? 'targetId' : 'entryId'], 'selected-user', 'selected node, not current leaf')
    work.runtimeGeneration = 5
    await nextTick()
    resolveReply({ cancelled: false, instance: { ...work }, editorText: 'navigation draft', selectedText: 'fork draft' })
    await settle()
    assert.equal(resync.length, 1, `${operation} accepts its own returned generation`)
    assert.equal(resync[0][0].id, 'work-a', 'replacement remains in the same Work')
    assert.equal(resync[0][1], operation === 'navigate' ? 'navigation draft' : operation === 'fork' ? 'fork draft' : undefined)
    assert.equal(find(container, hasClass('alu-dialog-error')), undefined)
    mounted.unmount()
    console.log(`PASS: ${operation} / event-before-reply / editor restoration`)
  }

  const store = reactive({ activeConnectionId: 'connection-a', connectionContext: { connectionId: 'connection-a', selectionGeneration: 1 } })
  const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
  const templates = { system: '系统全文\n' + '长内容'.repeat(1000), summarize: '首次摘要\n', update: '已有摘要更新\n', turnPrefix: '跨轮次片段\n' }
  let resolveTemplates
  const compactCalls = []
  globalThis[stateKey] = { store, invoke: (command, args) => {
    assert.equal(command, 'compaction_prompts')
    compactCalls.push(args)
    return new Promise(resolve => { resolveTemplates = resolve })
  } }
  const container = node('root')
  const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'compact-session', preview: false, outcomeUnknown: false, hasDraft: true, compactionPending: false }) })
  mounted.mount(container)
  await settle()
  assert.equal(compactCalls.length, 1)
  assert.deepEqual(compactCalls[0], { connectionId: 'connection-a', selectionGeneration: 1, instanceId: 'work-a', expectedHostEpoch: 'epoch-a', expectedRuntimeGeneration: 4 })
  resolveTemplates(templates)
  await settle()
  const sources = []
  const walk = item => { if (item.type === 'textarea' && item.props.readonly !== undefined) sources.push(item); item.children.forEach(walk) }
  walk(container)
  assert.deepEqual(sources.map(item => item.props.value), Object.values(templates), 'four complete read-only defaults, not the editable supplement')
  assert.ok(text(container).includes('不是本次发送给模型的完整内容'))
  await find(container, item => item.type === 'button' && text(item) === '复制全文').props.onClick()
  assert.equal(copied, templates.system, 'copy preserves the complete default text')
  work.id = 'work-b'
  await settle()
  const oldResolve = resolveTemplates
  work.id = 'work-c'
  await settle()
  oldResolve(templates)
  await settle()
  assert.equal(find(container, hasClass('markdown-document')), undefined, 'late templates cannot publish into another Work')
  mounted.unmount()
  resolveTemplates(templates)
  await settle()
  console.log('PASS: compaction defaults / native seam / complete read-only copy / late Work fencing')
} finally {
  delete globalThis[stateKey]
  delete globalThis.window
  await rm(directory, { recursive: true, force: true })
}
