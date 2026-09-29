// #275: exercise the real Reload confirmation button with event/reply reordering.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, reactive, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(process.env.ALUDOCK_TEST_ARTIFACT_DIR ?? root, '.reload-check-'))
const stateKey = '__aluReloadCheck'
const previousDocument = globalThis.Document, previousShadowRoot = globalThis.ShadowRoot
globalThis.Document ??= class Document {}
globalThis.ShadowRoot ??= class ShadowRoot {}
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, focus() {}, select() {}, getRootNode() { return { activeElement: null } }, addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] } })
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
const storage = new Map()
let failStorage = false
globalThis.window = { clearTimeout, setTimeout, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (failStorage) throw new Error('fixture storage full'); storage.set(key, value) }, removeItem: key => storage.delete(key) }, __TAURI_INTERNALS__: { invoke: (command, args) => globalThis[stateKey].invoke(command, args) } }
const hasClass = (name) => (item) => String(item.props.class ?? '').split(' ').includes(name)

try {
  const outfile = join(directory, 'component.mjs')
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `export { default } from '${root}src/components/SessionManager.vue'; export { useAppStore } from '${root}src/stores/app';`)
  await build({
    root, configFile: false, logLevel: 'silent',
    build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'component.mjs' },
      rolldownOptions: { external: ['vue', 'pinia'] },
    },
    plugins: [{ name: 'static-transport-fixture', enforce: 'pre',
      resolveId(id) {
        if (id === './MarkdownContent.vue') return '\0browser-markdown'
      },
      load(id) {
        // This renderer has no HTML document. Only the browser-rendered leaf is
        // replaced; sanitization/visual layout are not claimed by this test.
        if (id === '\0browser-markdown') return `import { h } from 'vue'; export default { props: ['source'], render() { return h('div', this.source) } };`
      },
    }, vue()],
  })
  const { default: SessionManager, useAppStore } = await import(outfile)
  async function createStore(work) {
    storage.clear(); failStorage = false
    work.executor ??= { kind: 'pi', piSessionId: 'original-session' }
    setActivePinia(createPinia())
    const store = useAppStore()
    globalThis[stateKey] = { invoke: async (command) => {
      if (command === 'get_host_catalog') return { revision: 1, selectionGeneration: 1, hosts: [], activeTarget: { kind: 'host', hostId: 'connection-a' } }
      if (command === 'bootstrap') return { connectionId: 'connection-a', selectionGeneration: 1, host: { hostEpoch: 'epoch-a' }, works: [work], total: 1 }
      throw new Error(`Unexpected native setup call: ${command}`)
    } }
    await store.load(); store.selectWork(work.id)
    return store
  }
  // Upload-state review P1: rename needs only the target; Reload still owns
  // a potential editor handoff, so it must retain its durable capture gate.
  for (const mode of ['rename-session', 'reload-session']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, name: 'Original name' })
    const store = await createStore(work)
    store.setCurrentDraft('original editor'); store.flushLocalState()
    const calls = []
    globalThis[stateKey] = { invoke: async (command, args) => {
      if (command === 'list_sessions') return { sessions: [], total: 0, incomplete: false }
      calls.push({ command, args })
      assert.equal(command, 'name_session')
      return { instance: { ...work, name: 'Renamed' } }
    } }
    const container = node('storage-session')
    const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode, compactionPending: false }) })
    mounted.mount(container); await settle()
    failStorage = true
    const rename = find(container, item => item.type === 'input')
    if (rename) rename.props['onUpdate:modelValue']('Renamed')
    await find(container, item => item.type === 'button' && text(item) === '确认').props.onClick(); await settle()
    if (mode === 'rename-session') {
      assert.equal(calls.length, 1)
      assert.deepEqual({ ...calls[0].args, operationId: 'generated' }, { connectionId: 'connection-a', selectionGeneration: 1, instanceId: 'work-a',
        expectedHostEpoch: 'epoch-a', expectedRuntimeGeneration: 4, operationEditor: null, name: 'Renamed', operationId: 'generated' })
    } else {
      assert.equal(calls.length, 0, 'returning/replacing the editor still needs a saved original capture')
      assert.ok(find(container, hasClass('alu-dialog-error')))
    }
    assert.equal(store.currentDraft, 'original editor')
    mounted.unmount(); failStorage = false
  }
  console.log('PASS: storage failure permits Session rename but gates Reload/editor handoff; original input remains unchanged')
  // #326: a compaction still running or with an unconfirmed result is not a reason to ignore a rename click.
  for (const state of ['pending', 'unknown']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, name: 'Original name', compacting: state === 'pending' })
    const store = await createStore(work)
    store.bindNativeOperation({ operationId: `compact-${state}`, kind: 'compact_session', connectionId: 'connection-a', instanceId: 'work-a', hostEpoch: 'epoch-a',
      runtimeGeneration: 4, sessionId: 'original-session', editor: null, state, ...(state === 'unknown' ? { error: { message: '压缩结果尚未确认。', outcomeUnknown: true } } : {}) })
    assert.equal(store.unresolvedMutations.size, state === 'unknown' ? 1 : 0)
    const calls = []
    globalThis[stateKey] = { invoke: async (command, args) => {
      if (command === 'list_sessions') return { sessions: [], total: 0, incomplete: false }
      calls.push({ command, args })
      return { instance: { ...work, name: 'Renamed' } }
    } }
    const container = node(`compaction-${state}-rename`)
    const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'rename-session', compactionPending: state === 'pending' }) })
    mounted.mount(container); await settle()
    find(container, item => item.type === 'input').props['onUpdate:modelValue']('Renamed')
    const confirm = find(container, item => item.type === 'button' && text(item) === '确认')
    assert.equal(confirm.props.disabled, false, `${state} compaction leaves rename available`)
    await confirm.props.onClick(); await settle()
    assert.deepEqual(calls.map(call => call.command), ['name_session'], `${state} compaction does not silently drop the rename`)
    mounted.unmount()
  }
  console.log('PASS: rename reaches the Host while compaction is running or its result is unconfirmed')
  for (const scenario of ['event-before-reply', 'reply-before-event', 'different-work', 'different-connection', 'different-host', 'newer-runtime', 'failure']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, name: 'Original work' })
    const store = await createStore(work)
    let resolveReply, rejectReply, requests = 0
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
    globalThis[stateKey] = { store, invoke: (command) => { assert.equal(command, 'reload_session'); requests++; return reply } }
    const resync = []
    const container = node('root')
    const app = renderer.createApp({ render: () => h(SessionManager, {
      work, mode: 'reload-session', compactionPending: false,
      onFinished: () => resync.push(true),
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
    if (scenario === 'different-connection') store.catalog.selectionGeneration = 2
    if (scenario === 'different-host') work.ownerHostEpoch = 'epoch-b'
    if (scenario === 'newer-runtime') work.runtimeGeneration = 6
    await nextTick()
    if (scenario === 'failure') rejectReply(new Error('Reload failed'))
    else resolveReply(result)
    await pending
    await nextTick()
    if (scenario === 'event-before-reply' || scenario === 'reply-before-event') {
      assert.equal(resync.length, 1, `${scenario}: successful Reload reports completion in its initiating surface`)
      assert.ok(find(container, hasClass('reload-summary')), `${scenario}: completion remains visible after the receipt`)
      assert.equal(find(container, hasClass('alu-dialog-error')), undefined, `${scenario}: no false target-switch error`)
    } else {
      assert.equal(resync.length, 0, `${scenario}: do not apply an old or failed result`)
      assert.equal(find(container, hasClass('reload-summary')), undefined)
      if (scenario === 'failure') assert.ok(find(container, hasClass('alu-dialog-error')))
      else assert.equal(find(container, hasClass('alu-dialog-error')), undefined, 'stale result does not publish into the new target')
    }
    app.unmount()
    console.log(`PASS: Reload confirmation / ${scenario}`)
  }

  // The other replacement buttons share Reload's receipt rule. In each case
  // the real native-edge command is held until Follow has published its runtime.
  for (const operation of ['new', 'switch', 'navigate', 'fork', 'clone']) {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
    const store = await createStore(work)
    const nodes = [
      { entryId: 'selected-user', kind: 'message', role: 'user', displayClass: 'content', summary: 'Selected user', hasChildren: true, depth: 0 },
      { entryId: 'current-leaf', parentId: 'selected-user', kind: 'message', role: 'assistant', displayClass: 'content', summary: 'Current reply', depth: 1 },
    ]
    let resolveReply
    const reply = new Promise(resolve => { resolveReply = resolve })
    const calls = [], resync = []
    globalThis[stateKey] = { store, invoke: async (command, args) => {
      if (command === 'list_sessions') return { sessions: [{ token: 'saved', name: 'Saved session', cwd: '/project', current: false }], total: 1, incomplete: false }
      if (command === 'session_tree') return { nodes, leafId: 'current-leaf', instance: { ...work } }
      calls.push({ command, args }); return reply
    } }
    const container = node('root')
    const mounted = renderer.createApp({ render: () => h(SessionManager, {
      work, mode: operation === 'new' ? 'new-session' : operation === 'switch' ? 'sessions' : 'tree', compactionPending: false,
      onFinished: () => resync.push(true),
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
    assert.equal(find(container, hasClass('alu-dialog-error')), undefined)
    mounted.unmount()
    console.log(`PASS: ${operation} / event-before-reply / initiating surface completion`)
  }

  // #318: Resume lists the Work's directory from the Host, one row per Session
  // (title, then time · cost), and keeps reading pages until every Session is shown.
  {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4, cwd: '/project', hostId: 'machine-a' })
    const store = await createStore(work)
    const reads = []
    const page = { total: 2, incomplete: false, connectionId: 'connection-a', selectionGeneration: 1, hostEpoch: 'epoch-a' }
    globalThis[stateKey] = { store, invoke: async (command, args) => {
      assert.equal(command, 'list_sessions')
      reads.push(args)
      return args.cursor === null
        ? { ...page, nextCursor: 'page-2', sessions: [{ token: 'current', name: 'Current work', cwd: '/project', lastActivityAt: '2026-09-29T12:00:00.000Z', costTotal: 1.5, current: true }] }
        : { ...page, sessions: [{ token: 'older', firstUserMessage: '整理发布清单', cwd: '/project', lastActivityAt: '2026-09-28T12:00:00.000Z', current: false }] }
    } }
    const container = node('root')
    const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'sessions', compactionPending: false }) })
    mounted.mount(container); await settle()
    assert.deepEqual(reads.map(args => [args.instanceId, args.machineHostId, args.cwd, args.cursor]), [
      ['work-a', 'machine-a', '/project', null],
      ['work-a', 'machine-a', '/project', 'page-2'],
    ])
    const rows = []
    const collect = item => { if (item.type === 'button' && hasClass('ui-dialog-option')(item)) rows.push(item); item.children.forEach(collect) }
    collect(container)
    assert.equal(rows.length, 2, 'the second page is appended without another click')
    assert.match(text(rows[0]), /Current work.*当前.*9月29日.*\$1\.50/u)
    assert.equal(rows[0].props.disabled, true, 'the current Session cannot be resumed again')
    assert.match(text(rows[1]), /整理发布清单.*9月28日.*-\$/u, 'an unnamed Session shows its first message; no recorded cost shows -$')
    assert.equal(rows[1].props.disabled, false)
    mounted.unmount()
  }
  console.log('PASS: Resume shows Host-listed Sessions page by page with title, time and cost')

  {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
    const store = await createStore(work)
    let rejectReply, operationId
    globalThis[stateKey] = { store, invoke: (command, args) => command === 'list_sessions'
      ? Promise.resolve({ sessions: [{ token: 'saved', name: 'saved', cwd: '/project', current: false }], total: 1, incomplete: false })
      : new Promise((_resolve, reject) => { rejectReply = reject; operationId = args.operationId }) }
    const container = node('root')
    const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'sessions', compactionPending: false }) })
    mounted.mount(container); await settle()
    const pending = find(container, hasClass('ui-dialog-option')).props.onClick()
    await settle(); work.id = 'work-b'; await settle()
    rejectReply({ code: 'project_trust_required', details: { challengeId: 'old-challenge', operationId } })
    await pending; await settle()
    assert.equal(find(container, hasClass('session-trust')), undefined, 'old trust challenge is never shown for another Work')
    mounted.unmount()
  }
  console.log('PASS: late Session trust continuation is fenced')

  {
    const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
    const store = await createStore(work)
    store.setCurrentDraft('original before trust')
    const attempts = []
    globalThis[stateKey] = { store, invoke: async (command, args) => {
      if (command === 'list_sessions') return { sessions: [{ token: 'saved', name: 'Saved', cwd: '/project', current: false }], total: 1, incomplete: false }
      assert.equal(command, 'switch_session')
      attempts.push(args)
      if (attempts.length === 1) throw { code: 'project_trust_required', details: { operationId: args.operationId, challengeId: 'trust-original' } }
      return { cancelled: false, instance: { ...work, runtimeGeneration: 5 } }
    } }
    const container = node('root')
    const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'sessions', compactionPending: false }) })
    mounted.mount(container); await settle()
    await find(container, hasClass('ui-dialog-option')).props.onClick(); await settle()
    store.setCurrentDraft('edited during trust')
    const confirmTrust = find(container, item => item.type === 'button' && text(item) === '仅本次信任')
    assert.ok(confirmTrust)
    await confirmTrust.props.onClick(); await settle()
    assert.equal(attempts.length, 2)
    assert.equal(attempts[1].operationId, attempts[0].operationId)
    assert.deepEqual(attempts[1].operationEditor, attempts[0].operationEditor, 'trust continuation carries the original frozen capture, not the later editor')
    assert.equal(attempts[1].operationEditor.text, 'original before trust')
    assert.equal(store.currentDraft, 'edited during trust', 'the initiating promise does not claim a draft')
    mounted.unmount()
  }
  console.log('PASS: Session trust continuation retains its original editor capture while local editing continues')

  const work = reactive({ id: 'work-a', ownerHostEpoch: 'epoch-a', runtimeGeneration: 4 })
  const store = await createStore(work)
  const templates = { system: '系统全文\n' + '长内容'.repeat(1000), summarize: '首次摘要\n', update: '已有摘要更新\n', turnPrefix: '跨轮次片段\n' }
  let resolveTemplates, rejectTemplates
  const compactCalls = [], submitted = []
  globalThis[stateKey] = { store, invoke: (command, args) => {
    assert.equal(command, 'compaction_prompts')
    compactCalls.push(args)
    return new Promise((resolve, reject) => { resolveTemplates = resolve; rejectTemplates = reject })
  } }
  const container = node('root')
  const mounted = renderer.createApp({ render: () => h(SessionManager, { work, mode: 'compact-session', compactionPending: false, onCompact: value => submitted.push(value) }) })
  mounted.mount(container)
  await settle()
  const button = label => find(container, item => item.type === 'button' && text(item).includes(label))
  const click = async label => { const target = button(label); assert.ok(target, label); assert.ok(!target.props.disabled); await target.props.onClick(); await settle() }
  assert.equal(compactCalls.length, 0, 'the optional reader is not a prerequisite for compression')
  const editor = find(container, item => item.type === 'textarea')
  editor.props['onUpdate:modelValue']('保留未完成事项')
  await settle()
  await click('查看默认压缩提示')
  assert.equal(compactCalls.length, 1)
  assert.deepEqual(compactCalls[0], { connectionId: 'connection-a', selectionGeneration: 1, instanceId: 'work-a', expectedHostEpoch: 'epoch-a', expectedRuntimeGeneration: 4 })
  resolveTemplates(templates)
  await settle()
  for (const [label, key] of [['首次摘要', 'summarize'], ['更新摘要', 'update'], ['系统说明', 'system'], ['分段摘要', 'turnPrefix']]) {
    await click(label)
    await click('原文')
    const source = find(container, item => item.type === 'textarea' && item.props.readonly !== undefined)
    assert.equal(source.props.value, templates[key], 'each default remains complete and read-only')
    await click('复制全文')
    assert.equal(copied, templates[key], 'copy preserves the selected full template')
  }
  assert.deepEqual(submitted, [], 'reading and copying never start compaction')
  await click('返回压缩')
  assert.equal(find(container, item => item.type === 'textarea').value, '保留未完成事项')
  await click('开始压缩')
  assert.deepEqual(submitted, ['保留未完成事项'], 'the supplement survives the reader and remains separate from its defaults')
  work.id = 'work-b'
  await settle()
  await click('查看默认压缩提示')
  const oldResolve = resolveTemplates
  work.id = 'work-c'
  await settle()
  oldResolve(templates)
  await settle()
  assert.equal(find(container, hasClass('markdown-document')), undefined, 'late templates cannot publish into another Work')
  await click('查看默认压缩提示')
  rejectTemplates({ code: 'capability_missing' })
  await settle()
  assert.ok(find(container, hasClass('compaction-reader-error')))
  await click('返回压缩')
  assert.ok(!button('开始压缩').props.disabled, 'an unavailable optional reader does not prevent the existing compaction action')
  mounted.unmount()
  await settle()
  console.log('PASS: optional compaction reader / complete copy / preserved supplement / error return / late Work fencing')
} finally {
  delete globalThis[stateKey]
  delete globalThis.window
  if (previousDocument === undefined) delete globalThis.Document; else globalThis.Document = previousDocument
  if (previousShadowRoot === undefined) delete globalThis.ShadowRoot; else globalThis.ShadowRoot = previousShadowRoot
  await rm(directory, { recursive: true, force: true })
}
