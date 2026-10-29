// #301/#302: mount the real App and Pinia stores. Only native IPC and the
// browser-only Markdown leaf are fixtures; no extracted recovery handlers.
import assert from 'node:assert/strict'
import { assertSameReference } from './referenceAssertion.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, nextTick, toRaw } from 'vue'
import { createPinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(process.env.ALUDOCK_TEST_ARTIFACT_DIR ?? root, '.app-check-'))
const filesOnly = process.argv.includes('--files-reading')
const listeners = new Map(), storage = new Map(), calls = []
const consumeFailures = new Set()
const nativeJobs = new Map()
let pickedJobs = [], droppedJobs = [], clipboardFiles = null, failStorage = false, jobsRevision = 0, deferJobSnapshot = false, releaseJobSnapshot, uploadNative
const context = { connectionId: 'host', selectionGeneration: 1 }
const work = { id: 'work', displayName: 'Work', name: 'Old Session', cwd: '/work', lifecycle: 'active', extensionStatus: {}, execution: 'idle', compacting: false,
  ownerHostEpoch: 'epoch', runtimeGeneration: 1, executor: { kind: 'pi', piSessionId: 'old' }, pending: { steering: 0, followUp: 0, total: 0 }, updatedAt: '2026-09-19',
  eventCursor: { hostEpoch: 'epoch', instanceId: 'work', runtimeGeneration: 1, sequence: 10 },
  metrics: { messages: { user: 1, assistant: 1, toolCalls: 0, toolResults: 0, total: 2 }, tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 100, total: 1050 }, cost: 0.1234, context: { tokens: 76000, contextWindow: 200000, percent: 38 } } }
const cursor = { hostEpoch: 'epoch', instanceId: 'work', runtimeGeneration: 1, sequence: 10 }
const bootstrap = { instance: work, cursor, records: [{ recordId: 'old-message', entryId: 'old-message', kind: 'message', source: 'user', visibility: 'conversation', content: [{ type: 'text', text: 'OLD SESSION MESSAGE' }] }],
  activeEvents: [], queue: [], historyRevision: 1, historyTruncated: true, extensionUi: { status: {}, toolsExpanded: false, events: [] } }
bootstrap.records.push({ recordId: 'native-image', entryId: 'native-image', kind: 'message', source: 'user', visibility: 'conversation', contentComplete: false,
  content: [{ type: 'image', mimeType: 'image/png', contentRef: 'opaque-server-image', fileId: 'standard-image-file-id' }] })
const otherWork = { ...work, id: 'other', eventCursor: { ...work.eventCursor, instanceId: 'other' }, name: 'Other Work', executor: { kind: 'pi', piSessionId: 'other-session', model: { provider: 'openai-codex', id: 'gpt-6-sol-20261001' } } }
const capturedBeforeF5 = { connectionId: 'host', workId: 'work', sessionId: 'old', text: 'F5 draft preserved', textRevision: 'before-f5', attachments: [] }
const nativeResults = new Map(['new_session', 'reload_session', 'set_model'].map(kind => [kind, {
  operationId: kind, kind, connectionId: 'host', instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1, sessionId: 'old',
  editor: capturedBeforeF5, state: 'failed', error: { code: 'busy', outcomeUnknown: false, message: `${kind === 'new_session' ? '新建' : kind === 'reload_session' ? 'Reload' : '模型'}未完成，请从原入口重试。` },
}]))
nativeResults.set('other-failure', { ...nativeResults.get('new_session'), operationId: 'other-failure', kind: 'navigate_session', instanceId: 'other', error: { code: 'busy', outcomeUnknown: false, message: '另一项工作的分支切换未完成。请重新选择。' } })
nativeResults.set('create-failure', { ...nativeResults.get('new_session'), operationId: 'create-failure', kind: 'create_work', instanceId: 'global', editor: null, error: { code: 'busy', outcomeUnknown: false, message: '新建工作未完成，请检查目录后重试。' } })
storage.set('aludock.uiState', JSON.stringify({ schemaVersion: 4, activeConnectionId: 'host', connections: { host: {
  selectedWorkId: 'work', drafts: { work: 'F5 draft preserved', other: 'other draft' }, editorRevisions: { work: 'before-f5' }, attachmentRevisions: {}, attachments: {}, recentWorkspaces: {}, detailMode: true,
} } }))
let startPairingNative, cancelPairingNative, downloadNative
let abortNative, compactNative, stopNative, modelNative, dequeueNative, submitNative, respondNative, sharedRespondNative, catalogNative, toolsNative, extensionBinding, allowExtension = false
let binding, failCatalog = false, revision = 0, frames = 0, beforeBatchFrame = 0, immediateAck = false, releaseHistory, saveResult = 'cancelled', restoredImageCount = 0
let savedHosts = ['host', 'spare'], hostCatalogRevision = 1, failHostRemoval = false, failFollowStart = false, failAck = false
let bootstrapNative, hostCatalogNative, deliveryListNative
let machinesFixture = [], modelVisibilityNative, saveModelVisibilityNative
// The fake Host's Work list: extra records it lists, and Works it has retired.
let extraListed = [], holdWorkCatalog, reopenNative
const retiredWorks = new Set()
const hostWorks = () => structuredClone([work, otherWork, ...extraListed].filter(item => !retiredWorks.has(item.id)).map(atHost))
const hostCatalog = () => ({ revision: hostCatalogRevision, selectionGeneration: context.selectionGeneration, activeTarget: { kind: 'host', hostId: context.connectionId },
  hosts: savedHosts.map(hostId => ({ hostId, displayName: hostId === 'host' ? 'Host' : 'Spare', profile: { revision: 1, hostId, displayName: hostId === 'host' ? 'Host' : 'Spare', endpoints: hostId === 'host' ? hostEndpoints : [] } })) })
const hostEndpoints = [
  { id: 'home', label: '家里', kind: 'local', endpoint: { host: '192.168.1.8', port: 33781 }, state: 'verified' },
  { id: 'wan', label: '外网域名', kind: 'remote', endpoint: { host: 'dock.example.com', port: 443 }, state: 'verified' },
]
const emit = (name, payload) => listeners.get(name)?.({ payload })
// Fake Host event journal: the latest position each Work has published in each
// session generation. Reads and events move it forward. A Work placed in a reply
// is stamped when the test writes that reply, so a reply delivered after later
// events keeps its older position, as on a real connection.
const journal = new Map([['work:1', 10], ['other:1', 10]])
const journalAt = (instanceId, generation) => journal.get(`${instanceId}:${generation}`) ?? 1
const publish = cut => { const key = `${cut.instanceId}:${cut.runtimeGeneration}`; if ((journal.get(key) ?? 0) < cut.sequence) journal.set(key, cut.sequence) }
const atHost = item => ({ ...item, eventCursor: { hostEpoch: 'epoch', instanceId: item.id, runtimeGeneration: item.runtimeGeneration, sequence: journalAt(item.id, item.runtimeGeneration) } })
const nextCursor = (instanceId = 'work', generation = 1) => {
  const cut = { hostEpoch: 'epoch', instanceId, runtimeGeneration: generation, sequence: journalAt(instanceId, generation) + 1 }
  publish(cut); return cut
}
// A native read reports its Work at the read's own position, as the Rust core does.
const atRead = update => {
  const cut = update.bootstrap?.cursor
  if (!cut) return update
  publish(cut)
  const stamp = item => ({ ...item, eventCursor: { ...cut } })
  return { ...update, bootstrap: { ...update.bootstrap, instance: stamp(update.bootstrap.instance) }, ...(update.target ? { target: stamp(update.target) } : {}) }
}
const observation = update => {
  for (const event of update.events ?? (update.event ? [update.event] : [])) publish(event)
  emit('aludock://observation', { ...binding, revision: ++revision, update: structuredClone(atRead(update)) })
}
const contentChange = change => observation({ kind: 'content', token: 'native-content', change })
const recordChunk = (record, beforeEntryId) => contentChange({ kind: 'record_chunk', entryId: record.entryId, text: JSON.stringify(record), first: true, complete: true, beforeEntryId })
function contentSnapshot() {
  observation({ kind: 'snapshot', bootstrap: { ...bootstrap, cursor: { ...cursor, sequence: journalAt('work', 1) }, records: [] }, contentToken: 'native-content', canLoadEarlier: true, state: 'connected' })
  for (const record of bootstrap.records) recordChunk(record)
  contentChange({ kind: 'checkpoint_end' })
}
const invoke = async (command, args = {}) => {
  calls.push({ command, args })
  if (command === 'acquire_extension_control') {
    if (!allowExtension) throw { code: 'controller_unavailable' }
    extensionBinding = { ...context, handle: crypto.randomUUID(), instanceId: args.instanceId, hostEpoch: args.expectedHostEpoch, runtimeGeneration: args.expectedRuntimeGeneration }
    return extensionBinding
  }
  if (command === 'set_extension_widget_viewport' || command === 'set_shared_widget_viewport') return
  if (command === 'respond_shared_interaction') return sharedRespondNative(args)
  if (command === 'command_catalog') return catalogNative ? catalogNative() : { commands: [], diagnostics: [], total: 0, truncated: false }
  if (command === 'list_tools') {
    if (toolsNative) return toolsNative()
    throw { code: 'connection_failed', message: '工具暂时没有读到，请重试。' }
  }
  if (command === 'get_resources') return { resources: [{ kind: 'skill', name: 'Available skill' }], diagnostics: [], resourceTotal: 1, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false }
  if (command === 'get_settings') return { settings: [] }
  if (command === 'respond_extension_interaction') return respondNative(args)
  if (command === 'abort_run') return abortNative(args)
  if (command === 'compact_session') return compactNative(args)
  if (command === 'stop_work') return stopNative(args)
  if (command === 'dequeue_messages') return dequeueNative(args)
  if (command === 'submit_message') return submitNative(args)
  if (command === 'start_pairing') return startPairingNative(args)
  if (command === 'cancel_pairing') return cancelPairingNative(args)
  if (command === 'get_client_preferences') return { revision: 1, windowsAwaySupported: false, windowsAwayDelay: 'immediate' }
  if (command === 'desktop_shell_status') return { supported: false, hostReady: true }
  if (command === 'work_catalog') {
    const list = () => { const instances = hostWorks(); return { ...context, hostEpoch: 'epoch', instances, total: instances.length } }
    return holdWorkCatalog ? holdWorkCatalog.then(list) : list()
  }
  if (command === 'reopen_work') return reopenNative(args)
  if (command === 'get_host_catalog') { const cut = hostCatalog(); return hostCatalogNative ? hostCatalogNative(cut) : cut }
  if (command === 'set_active_host') {
    context.connectionId = args.hostId; context.selectionGeneration++; hostCatalogRevision++
    return hostCatalog()
  }
  if (command === 'remove_saved_host') {
    if (failHostRemoval) throw { code: 'io_error', message: '本机存储暂时无法写入，请重试。' }
    savedHosts = savedHosts.filter(hostId => hostId !== args.hostId); hostCatalogRevision++
    return hostCatalog()
  }
  if (command === 'bootstrap') {
    if (failCatalog) throw { code: 'connection_failed', message: 'offline' }
    const works = hostWorks()
    const cut = { ...context, host: { hostEpoch: 'epoch' }, works, total: works.length, maxAttachmentsPerMessage: 32 }
    return bootstrapNative ? bootstrapNative(cut) : cut
  }
  if (command === 'acknowledge_conversation_follow' && failAck) throw { code: 'connection_failed', message: '更新确认没有送达，请重试。' }
  if (command === 'acknowledge_conversation_follow') { assert.equal(args.update, undefined, 'ACK does not echo the content batch'); if (immediateAck) assert.equal(frames, beforeBatchFrame, 'cached data does not wait for a visible frame'); else assert.ok(frames > beforeBatchFrame, 'ACK follows a projector/display frame'); return }
  // A known route is only answered when it changes; this fixture's never does.
  if (command === 'watch_host_route') return args.seenRouteGeneration == null ? { ...context, routeGeneration: 1, activeEndpointId: 'wan' } : new Promise(() => {})
  if (command === 'start_conversation_follow') { if (failFollowStart) throw { code: 'connection_failed', message: '暂时连不上这项工作，请重试。' }; binding = { ...args }; return }
  if (command === 'list_deliverables') return deliveryListNative ? deliveryListNative(args) : args.instanceId === 'work' ? [{ deliveryRef: 'report', name: 'report.pdf', sizeBytes: 10 }] : []
  if (command === 'download_deliverable') return downloadNative(args)
  if (command === 'restored_image_count') return restoredImageCount
  if (command === 'attachment_snapshot') {
    const cut = { revision: ++jobsRevision, jobs: structuredClone([...nativeJobs.values()].filter(job => job.workId === args.workId)) }
    if (deferJobSnapshot) { deferJobSnapshot = false; return new Promise(resolve => { releaseJobSnapshot = () => resolve(cut) }) }
    return cut
  }
  if (command === 'pick_attachments' || command === 'stage_clipboard_image') return structuredClone(command === 'pick_attachments' ? pickedJobs : pickedJobs[0])
  if (command === 'stage_dropped_files') return structuredClone(droppedJobs)
  if (command === 'stage_clipboard_files') return structuredClone(clipboardFiles)
  if (command === 'upload_attachment') {
    if (uploadNative) return uploadNative(args)
    const job = nativeJobs.get(args.token)
    if (job.workId !== args.workId) throw { code: 'resource_unavailable', message: '该附件不属于当前工作，请重新选择。' }
    job.state = 'uploading'; job.revision++; job.progress = { phase: 'uploading', bytesProcessed: 1, totalBytes: 3 }; return }
  if (command === 'remove_attachment') return nativeJobs.delete(args.token)

  if (command === 'pending_operations') return structuredClone([...nativeResults.values()])
  if (command === 'list_machines') return machinesFixture
  if (command === 'model_visibility') return modelVisibilityNative(args)
  if (command === 'set_model_visibility') return saveModelVisibilityNative(args)
  if (command === 'consume_operation') {
    if (consumeFailures.has(args.operationId)) throw { code: 'io_error', message: 'fixture acknowledgement unavailable' }
    nativeResults.delete(args.operationId); return
  }
  if (command === 'consume_operation' || command === 'stop_conversation_follow' || command === 'release_extension_control' || command === 'reselect_host_route') return true
  if (command === 'list_models') return { instance: atHost(work), models: [{ provider: 'fixture', id: 'model', name: 'model' }], availableThinkingLevels: ['off'], total: 1, truncated: false }
  if (command === 'set_model') {
    if (modelNative) return modelNative(args)
    const error = { code: 'busy', outcomeUnknown: false, message: '这次模型设置没有完成，请重试。' }
    const operation = { ...nativeResults.get('set_model'), operationId: args.operationId, editor: args.operationEditor, state: 'failed', error }
    nativeResults.set(operation.operationId, operation); emit('aludock://operation', operation)
    throw error
  }
  if (command === 'system_device_name') return 'test'
  if (command === 'list_commands') return { commands: [], diagnostics: [], instance: atHost(work) }
  if (command === 'published_image') return { handle: 'published-local-handle', mimeType: 'image/png', sizeBytes: 68, sha256: 'local-file-digest' }
  if (command === 'attachment_preview') return { handle: 'imported-local-handle', mimeType: 'image/png', sizeBytes: 68, sha256: 'verified-by-core' }
  if (command === 'conversation_image') return { handle: args.contentRef === 'attached-original' ? 'imported-local-handle' : args.contentRef === 'changed-mime' ? 'different-image-handle' : 'verified-local-handle', mimeType: args.mimeType, sizeBytes: 68, sha256: 'verified-by-core' }
  if (command === 'read_conversation_content') {
    if (args.intent !== 'earlier') return
    contentChange({ kind: 'state', canLoadEarlier: true, loading: true })
    return new Promise(resolve => { releaseHistory = () => {
      recordChunk({ ...bootstrap.records[0], recordId: 'earlier-record', entryId: 'earlier-record', content: [{ type: 'text', text: 'EARLIER NATIVE RECORD' }] }, 'old-message')
      contentChange({ kind: 'state', canLoadEarlier: false, loading: false })
      resolve()
    } })
  }
  if (command === 'save_preview_image') {
    assert.equal(typeof args.handle, 'string')
    assert.equal(typeof args.name, 'string')
    assert.equal(Object.hasOwn(args, 'bytes'), false)
    if (saveResult === 'failed') throw { code: 'io_error', message: '保存位置暂时不可用，请重试。' }
    return saveResult === 'saved' ? { status: 'saved', label: 'test.png' } : { status: 'cancelled' }
  }
  throw new Error(`Unexpected native call: ${command}`)
}
globalThis.__appBoundary = { invoke, listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name) } }
const element = (type, text = '') => ({ get ownerDocument() { return globalThis.document }, type, tagName: type.toUpperCase(), nodeType: type === '#text' ? 3 : 1, text, children: [], parent: null, props: {}, classList: { add() {}, remove() {} }, style: {}, dataset: {}, value: '', selectionStart: 0, selectionEnd: 0,
  scrollHeight: 600, clientHeight: 300, clientWidth: 700, scrollTop: 0, isConnected: true,
  addEventListener(name, fn) { this[`event:${name}`] = fn }, removeEventListener() {},
  focus() { document.activeElement = this }, select() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b },
  getRootNode() { return document }, getBoundingClientRect() { return { top: 0, bottom: 300, left: 0, right: 700, height: 300, width: 700 } },
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }, querySelectorAll(selector) { return this.children.flatMap(child => [...(focusSelector(child, selector) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])]) }, getContext() { return { measureText: () => ({ width: 8 }) } }, contains(item) { return this === item || this.children.some(child => child.contains?.(item)) },
  getAttribute(name) { return this.props[name] }, setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] },
})
// This renderer models only focusable-element lookup, not browser layout/CSS.
const focusSelector = (item, selector) => selector.split(',').some(part => {
  if (part.includes(':disabled') && item.props.disabled) return false
  const tag = part.trim().match(/^(input|textarea|button|select)(?=[:\s]|$)/)?.[1]
  if (tag) return item.type === tag
  if (part.includes('[data-modal-initial]')) return 'data-modal-initial' in item.props
  if (part.includes('[autofocus]')) return 'autofocus' in item.props
  return false
})
const windowEvents = new Map()
// Browser traversal changes position asynchronously; writes made before its
// completion cannot change the destination that Chrome has already selected.
let historyDepth = 0, holdHistoryTraversal = false
const heldHistoryMoves = []
const firePopstate = () => { for (const handler of windowEvents.get('popstate') ?? []) handler({}) }
const traverseHistory = delta => {
  const destination = historyDepth + delta
  const move = () => {
    historyDepth = destination
    if (destination < 0) { window.location.href = 'about:blank'; return }
    firePopstate()
  }
  if (holdHistoryTraversal) heldHistoryMoves.push(move)
  else setTimeout(move, 0)
}
const finishHistoryTraversal = () => { holdHistoryTraversal = false; while (heldHistoryMoves.length) heldHistoryMoves.shift()() }
const systemBack = () => { historyDepth--; firePopstate() }
globalThis.Document = class {}; globalThis.ShadowRoot = class {}; globalThis.HTMLElement = class { static [Symbol.hasInstance](item) { return typeof item?.tagName === 'string' } }; globalThis.Element = class {}; globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
globalThis.document = Object.assign(new Document(), { visibilityState: 'visible', activeElement: null, documentElement: { dataset: {}, style: {} }, body: { offsetHeight: 0 },
  hasFocus: () => true, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: tag => element(tag) })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'test', platform: 'Linux' } })
globalThis.window = { __TAURI_INTERNALS__: {}, location: { search: '', href: 'http://fixture/aludock' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (failStorage) throw new Error('fixture storage unavailable'); storage.set(key, value) }, removeItem: key => storage.delete(key) },
  setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: fn => setTimeout(() => { frames++; fn() }, 0), cancelAnimationFrame: clearTimeout,
  addEventListener(name, handler) { const handlers = windowEvents.get(name) ?? new Set(); handlers.add(handler); windowEvents.set(name, handlers) }, removeEventListener(name, handler) { windowEvents.get(name)?.delete(handler) }, history: { pushState() { historyDepth++ }, back() { this.go(-1) }, go: traverseHistory }, getComputedStyle: () => ({ lineHeight: '20px', transitionDelay: '0s', transitionDuration: '0s', animationDelay: '0s', animationDuration: '0s' }) }
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const teleport = element('body')
const detach = item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1) }
const insert = (item, parent, anchor) => { detach(item); item.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, item) }
const renderer = createRenderer({ querySelector: () => teleport, createElement: type => element(type), createText: text => element('#text', text), createComment: text => element('#comment', text), insert, remove: detach,
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value; if (key === 'value') item.value = value }, parentNode: item => item.parent,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null, setScopeId() {},
  insertStaticContent: (text, parent, anchor) => { const item = element('#static', text); insert(item, parent, anchor); return [item, item] },
})
const find = (item, predicate) => predicate(item) ? item : item.children.map(child => find(child, predicate)).find(Boolean)
// #358: the standalone refresh button is gone; refresh is the connection popover's action and the palette's 刷新状态.
const refreshControl = (view) => find(find(view, item => item.type === 'details' && item.props['aria-label'] === '连接状态'), item => item.type === 'button' && String(item.props.class).includes('alu-status-action'))
const all = (item, predicate) => [...(predicate(item) ? [item] : []), ...item.children.flatMap(child => all(child, predicate))]
const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 2)); await nextTick() }
let mounted
try {
  await writeFile(join(directory, 'entry.ts'), `export { default as App } from '${root}src/App.vue'; export { useAppStore } from '${root}src/stores/app'; export { default as InputRegion } from '${root}src/components/InputRegion.vue'; ${['observation', 'operations'].map(name => `export * from '${root}src/stores/${name}';`).join(' ')}`)
  await build({ root, configFile: false, logLevel: 'silent', build: { outDir: directory, emptyOutDir: false, minify: false,
    lib: { entry: join(directory, 'entry.ts'), formats: ['es'], fileName: () => 'app.mjs' }, rolldownOptions: { external: ['vue', 'pinia'] } },
    plugins: [{ name: 'native-boundary', enforce: 'pre', resolveId(id) {
      if (id === '@tauri-apps/api/core' || id === '@tauri-apps/api/event' || id === '@tauri-apps/api/window') return `\0${id}`
      if (id.endsWith('/MarkdownContent.vue')) return '\0markdown-leaf'
    }, load(id) {
      if (id === '\0@tauri-apps/api/core') return 'export const invoke = (...args) => globalThis.__appBoundary.invoke(...args); export const convertFileSrc = (handle, scheme) => `http://${scheme}.localhost/${handle}`; export class Channel {}'
      if (id === '\0@tauri-apps/api/event') return 'export const listen = (...args) => globalThis.__appBoundary.listen(...args);'
      if (id === '\0@tauri-apps/api/window') return 'export const getCurrentWindow = () => ({ isFocused: async () => true, onFocusChanged: async handler => { globalThis.__appBoundary.focusChanged = handler; return () => { globalThis.__appBoundary.focusChanged = undefined } }, onDragDropEvent: async () => () => {} });'
      if (id === '\0markdown-leaf') return "import { h } from 'vue'; export default { props: ['source'], render() { return h('div', this.source) } };"
    } }, vue()],
  })
  const compiled = await import(join(directory, 'app.mjs'))
  const { App, useAppStore } = compiled
  const pinia = createPinia(), app = useAppStore(pinia), container = element('root')
  mounted = renderer.createApp({ render: () => h(App) }).use(pinia)
  mounted.mount(container)
  await settle()
  app.selectWork('work'); await settle()
  const cacheStat = find(container, item => String(item.props.class ?? '').split(' ').includes('alu-nav-stat-cache'))
  assert.ok(cacheStat, 'the current Work exposes its existing cache metrics in the top bar')
  assert.equal(text(cacheStat).replace(/\s/g, ''), 'c80%', 'the compact cache label uses the same session ratio as the Work TUI')
  // #306: sending targets a Work, not a ready conversation or unrelated control.
  for (const state of ['pending', 'unknown']) {
    emit('aludock://operation', { ...nativeResults.get('set_model'), operationId: 'independent-model', state, editor: null })
    if (state === 'unknown') observation({ kind: 'status', state: 'disconnected' })
    await settle()
    const send = find(container, item => item.props.class === 'alu-send-btn')
    assert.equal(send.props.disabled, false, 'send is available before the first conversation read and during a model change')
    let submitted
    submitNative = async args => { submitted = args; return { receipt: { queued: true, delivery: 'followUp' }, instance: atHost(work) } }
    await find(container, item => item.type === 'form' && item.props.class === 'alu-input-wrap').props.onSubmit({ preventDefault() {} })
    assert.equal(submitted.instanceId, 'work')
    assert.equal(submitted.message, 'F5 draft preserved')
  }
  emit('aludock://operation', { ...nativeResults.get('set_model'), operationId: 'independent-model', state: 'succeeded', editor: null, result: atHost(work) })
  await settle()
  // #326: a manual compaction waiting for its result must not stop the user queueing a message.
  emit('aludock://operation', { ...nativeResults.get('set_model'), operationId: 'independent-compaction', kind: 'compact_session', state: 'pending', editor: null })
  await settle()
  assert.equal(find(container, item => item.props.class === 'alu-send-btn').props.disabled, false, 'a pending compaction leaves send available')
  assert.equal(text(container).includes('正在等待操作结果'), false, 'a pending compaction is not reported as an error')
  emit('aludock://operation', { ...nativeResults.get('set_model'), operationId: 'independent-compaction', kind: 'compact_session', state: 'succeeded', editor: null, result: atHost(work) })
  await settle()
  const initialSends = calls.filter(call => call.command === 'submit_message').length
  const initialAcknowledgements = calls.filter(call => call.command === 'consume_operation').length
  // #306 pre-merge review: looking at Model must not cancel the editor's command lookup.
  let completeEditorCatalog
  catalogNative = () => new Promise(resolve => { completeEditorCatalog = resolve })
  const initialEditor = find(container, item => item.type === 'textarea')
  initialEditor.props['onUpdate:modelValue']('/side'); await settle()
  find(container, item => String(item.props.class ?? '').includes('alu-nav-selector-model')).props.onClick(); await settle()
  find(container, item => item.type === 'button' && item.props['aria-label'] === '关闭').props.onClick(); await settle()
  completeEditorCatalog({ commands: [{ name: 'side-command', referenceId: 'side-command-ref', source: { kind: 'skill' }, contentAvailable: false }], total: 1, truncated: false })
  await settle()
  assert.equal(app.currentDraft, '/side')
  const commandSuggestion = find(container, item => item.props.id === 'cmd-suggest-0')
  assert.ok(commandSuggestion && text(commandSuggestion).includes('side-command'), 'command completion returns after viewing Model without editing the prefix again')
  commandSuggestion.props.onClick(); await settle()
  assert.equal(app.currentDraft, '/side-command ')
  initialEditor.props['onUpdate:modelValue']('F5 draft preserved'); catalogNative = undefined
  contentSnapshot(); await settle()
  // User report: after a long absence, fresh idle facts must stop the cached
  // running turn without requiring a replayed run.settled or a content reload.
  const runningTurns = () => all(container, item => typeof item.props.class === 'string' && item.props.class.split(' ').includes('alu-turn-summary') && item.props.class.split(' ').includes('is-running'))
  const activityVisible = () => runningTurns().length > 0
  const cachedRunning = { ...bootstrap, instance: { ...work, execution: 'running' }, records: [], activeEvents: [], cursor: { ...cursor, sequence: 20 } }
  observation({ kind: 'snapshot', bootstrap: cachedRunning, contentToken: 'resume-activity', state: 'connected' })
  for (const record of bootstrap.records) observation({ kind: 'content', token: 'resume-activity', change: { kind: 'record_chunk', entryId: record.entryId, text: JSON.stringify(record), first: true, complete: true } })
  observation({ kind: 'content', token: 'resume-activity', change: { kind: 'checkpoint_end' } }); await settle()
  assert.equal(activityVisible(), true)
  const retainedReply = find(container, item => item.props['data-conversation-id'] === 'old-message')
  const freshIdle = { ...cachedRunning, instance: { ...work, execution: 'idle' }, cursor: { ...cursor, sequence: 30 } }
  observation({ kind: 'facts', bootstrap: freshIdle }); await settle()
  assert.equal(app.selectedWork.execution, 'idle')
  assert.equal(activityVisible(), false, 'fresh idle status stops the reply spinner before any history handoff')
  assertSameReference(find(container, item => item.props['data-conversation-id'] === 'old-message'), retainedReply, 'status correction leaves the displayed messages in place')
  observation({ kind: 'content', token: 'resume-activity', change: { kind: 'checkpoint_begin', bootstrap: freshIdle } })
  for (const record of bootstrap.records) observation({ kind: 'content', token: 'resume-activity', change: { kind: 'record_chunk', entryId: record.entryId, text: JSON.stringify(record), first: true, complete: true } })
  observation({ kind: 'content', token: 'resume-activity', change: { kind: 'checkpoint_end' } }); await settle()
  assert.equal(activityVisible(), false, 'finishing the history handoff does not revive an old running status')
  const freshRunning = { ...freshIdle, instance: { ...work, execution: 'running' }, cursor: { ...cursor, sequence: 40 } }
  observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 1, sequence: 40, occurredAt: 'now', eventType: 'run.started', data: {} } }); await settle()
  assert.equal(activityVisible(), true, 'a new run still shows its activity through the existing event path')
  observation({ kind: 'facts', bootstrap: freshIdle }); await settle()
  assert.equal(app.selectedWork.execution, 'running')
  assert.equal(activityVisible(), true, 'an older idle read cannot overwrite a newer running state')
  const textDelta = { instanceId: 'work', runtimeGeneration: 1, sequence: 41, occurredAt: 'now', eventType: 'message.delta', data: { messageId: 'resumed-answer', block: 'text', delta: 'Visible answer' } }
  observation({ kind: 'event', event: textDelta }); await settle()
  assert.equal(activityVisible(), true, 'the turn stays running while its output streams')
  assert.ok(text(container).includes('Visible answer'), 'streamed output shows inside the running turn')
  // Tauri facts deliberately contain no activeEvents, unlike the content seed.
  observation({ kind: 'facts', bootstrap: { ...freshRunning, cursor: { ...cursor, sequence: 42 }, activeEvents: [] } }); await settle()
  assert.equal(runningTurns().length, 1, 'running facts do not add a second turn to the one already running')
  observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 1, sequence: 43, occurredAt: 'now', eventType: 'run.settled', data: { result: 'succeeded' } } }); await settle()
  assert.equal(activityVisible(), false, 'run.settled closes the running turn')
  // #353: a run watched from its start shows its output speed on the turn summary.
  const speedEvent = (sequence, second, eventType, data = {}) => observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 1, sequence, occurredAt: `2026-09-18T12:00:0${second}.000Z`, eventType, data } })
  speedEvent(44, 0, 'run.started'); speedEvent(45, 1, 'message.delta', { messageId: 'speed-answer', block: 'text', delta: 'Speed answer' })
  speedEvent(46, 3, 'message.completed', { messageId: 'speed-answer', role: 'assistant', content: [{ type: 'text', text: 'Speed answer' }] })
  speedEvent(47, 3, 'session.metrics_changed', { metrics: { ...work.metrics, tokens: { ...work.metrics.tokens, output: 250 } } }); await settle()
  assert.ok(runningTurns().some(turn => text(turn).includes('100 tok/s')), 'the running turn shows 200 new output tokens over 2 seconds of output')
  speedEvent(48, 4, 'run.settled', { result: 'succeeded' }); await settle()
  contentSnapshot(); await settle()
  assert.ok(text(container).includes('OLD SESSION MESSAGE'), 'actual ConversationView displays the original Session')
  assert.ok(find(container, item => item.type === 'img' && item.props.src === 'http://aludock-media.localhost/verified-local-handle'), 'descriptor image displays through a native opaque handle while unrelated history/body loading is held')
  const imageCall = calls.find(call => call.command === 'conversation_image')
  assert.equal(imageCall.args.contentRef, 'opaque-server-image')
  assert.equal(imageCall.args.fileId, 'standard-image-file-id', 'standard image association reaches native without a Vue alias')
  assert.equal(imageCall.args.expectedRuntimeGeneration, 1)
  assert.equal(imageCall.args.onChunk, undefined, 'WebView receives a handle, not a second binary transfer')
  // Existing native-URL save capability: real App controls and TS save bridge.
  // URI/CORS is covered by the responder test, not this renderer/native fixture.
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('image save must not fetch pixels into JS') }
  try {
    find(container, item => item.type === 'button' && item.props['aria-label'] === '预览图片结果').props.onClick(); await settle()
    const save = find(container, item => item.type === 'button' && text(item) === '保存图片')
    assert.ok(save)
    // Master-side review: same-image body completion must not retire an open
    // preview when nativeMedia upgrades the descriptor's resource source.
    recordChunk({ ...bootstrap.records[1], content: [{ ...bootstrap.records[1].content[0],
      nativeMedia: { handle: 'verified-local-handle', mimeType: 'image/png', sizeBytes: 68, sha256: 'verified-by-core' } }] })
    await settle()
    assert.ok(find(container, item => item.props['aria-label'] === '关闭图片预览'), 'same-ref hydration keeps the actual App preview open')
    for (const outcome of ['cancelled', 'saved', 'failed']) {
      saveResult = outcome; await save.props.onClick(); await settle()
      assert.equal(text(container).includes('图片已保存到所选位置。'), outcome === 'saved')
      assert.equal(text(container).includes('图片没有保存完成，请重试。'), outcome === 'failed')
    }
    find(container, item => item.props['aria-label'] === '关闭图片预览').props.onClick(); await settle()
  } finally { globalThis.fetch = oldFetch }
  recordChunk({ recordId: 'published', entryId: 'published', kind: 'message', source: 'tool', visibility: 'conversation', contentComplete: true,
    content: [{ type: 'tool_result', toolCallId: 'image-tool', toolName: 'show_image', text: '', isError: false,
      publishedFile: { presentation: 'image', fileRef: 'published-original', name: 'result.png', mediaType: 'image/png', sizeBytes: 68 } }] }); await settle()
  assert.ok(find(container, item => item.type === 'img' && item.props.src === 'http://aludock-media.localhost/published-local-handle'))
  assert.equal(calls.find(call => call.command === 'published_image').args.onChunk, undefined)
  find(container, item => item.type === 'button' && item.props['aria-label'] === '预览result.png').props.onClick(); await settle()
  saveResult = 'saved'
  await find(container, item => item.type === 'button' && text(item) === '保存图片').props.onClick(); await settle()
  assert.equal(calls.findLast(call => call.command === 'save_preview_image').args.handle, 'published-local-handle')
  assert.equal(calls.findLast(call => call.command === 'save_preview_image').args.name, 'result.png')
  find(container, item => item.props['aria-label'] === '关闭图片预览').props.onClick(); await settle()
  console.log('PASS: actual App published image displays a native handle and saves that handle; ordinary image save cancel/success/failure remains visible without JS bytes')
  if (filesOnly) {
    // Master-side review: a permanent receipt restored from an earlier native
    // run must reach submit_message even though attachment_snapshot has no job.
    nativeJobs.clear()
    const receipt = { fileId: 'permanent-host-file', name: 'saved.txt', mediaType: 'text/plain', sizeBytes: 1, sha256: 'digest', storedAt: 'now',
      localUpload: { ...context, instanceId: 'work', machineHostId: 'host', ownerHostEpoch: 'epoch', runtimeGeneration: 1, jobId: 'previous-run' } }
    assert.equal(app.setCurrentAttachments([receipt]), true)
    let submitted
    submitNative = args => {
      submitted = args
      const result = { instance: atHost(work), receipt: { queued: false, delivery: 'prompt' } }
      emit('aludock://operation', { operationId: args.operationId, kind: 'submit_message', connectionId: args.connectionId, instanceId: args.instanceId,
        hostEpoch: args.expectedHostEpoch, runtimeGeneration: args.expectedRuntimeGeneration, sessionId: 'old', editor: args.operationEditor, state: 'succeeded', result })
      return result
    }
    await settle()
    await find(container, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap')).props.onSubmit({ preventDefault() {} })
    await settle()
    assert.deepEqual(submitted.attachmentFileIds, ['permanent-host-file'])
    assert.equal(app.currentAttachments.length, 0)
    console.log('PASS: actual App submits permanent Host fileId with no current native source job')
  }
  if (!filesOnly) {
  // A native read cut arrives before B, while its content handoff is delayed.
  // Control cursor updates alone must not let the display fold B into pre-cut A.
  const deltaA = { instanceId: 'work', runtimeGeneration: 1, sequence: 51, eventType: 'message.delta', occurredAt: 'now', data: { messageId: 'cut-probe', block: 'text', delta: 'A' } }
  observation({ kind: 'event', event: deltaA }); await settle()
  const cutRead = { ...bootstrap, cursor: { ...cursor, sequence: 51 }, records: [], activeEvents: [structuredClone(deltaA)] }
  observation({ kind: 'facts', bootstrap: cutRead })
  observation({ kind: 'event', event: { ...deltaA, sequence: 52, data: { ...deltaA.data, delta: 'B' } } }); await settle()
  const cutText = () => text(find(container, item => item.props['data-conversation-id'] === 'live-cut-probe'))
  assert.equal(cutText(), 'AB')
  contentChange({ kind: 'checkpoint_begin', bootstrap: cutRead })
  for (const record of bootstrap.records) recordChunk(record)
  contentChange({ kind: 'checkpoint_end' }); await settle()
  assert.equal(cutText(), 'AB', 'actual facts→delta→late handoff keeps all displayed text once')
  // Rebuilt App receives retained native failures, without the original dialog promises.
  const resultEntry = () => { const region = find(container, item => item.props['aria-label'] === '当前 Work 操作结果'); return region && find(region, item => item.type === 'details') }
  assert.equal(app.currentDraft, 'F5 draft preserved')
  assert.equal(app.selectedWorkId, 'work')
  assert.ok(text(resultEntry()).includes('新建 Session没有完成'))
  assert.ok(text(resultEntry()).includes('Reload没有完成'))
  assert.ok(text(resultEntry()).includes('切换模型没有完成'))
  assert.equal(calls.filter(call => call.command === 'consume_operation').length, initialAcknowledgements, 'delivery is not acknowledgement')
  assert.equal(text(container).includes('另一项工作的分支切换未完成'), false)
  // A live initiating panel owns its error UI; the retained entry must not duplicate it.
  find(container, item => String(item.props.class ?? '').includes('alu-nav-selector-model')).props.onClick(); await settle()
  await find(container, item => item.props.id === 'cc-opt-0').props.onClick(); await settle()
  assertSameReference(resultEntry(), undefined, 'do not stack a second error surface on the open operation panel')
  assert.ok(text(container).includes('这次模型设置没有完成'))
  assert.equal(calls.filter(call => call.command === 'consume_operation').length, initialAcknowledgements)
  find(container, item => item.props['aria-label'] === '关闭').props.onClick(); await settle()
  assert.ok(resultEntry())
  app.selectWork('other'); await settle()
  assert.equal(app.currentDraft, 'other draft')
  assert.equal(text(resultEntry()).includes('新建 Session'), false)
  const late = { ...nativeResults.get('reload_session'), operationId: 'late-a' }
  nativeResults.set(late.operationId, late); emit('aludock://operation', late); await settle()
  assert.equal(app.selectedWorkId, 'other', 'a late failure never takes selection back')
  assert.equal(app.currentDraft, 'other draft')
  resultEntry().open = true
  await find(resultEntry(), item => item.type === 'button' && text(item) === '知道了').props.onClick(); await settle()
  assert.equal(nativeResults.has('other-failure'), false)
  assert.equal(nativeResults.has('reload_session'), true, 'another Work result is still unconsumed')
  app.selectWork('work'); await settle()
  contentSnapshot(); await settle()
  assert.equal(app.currentDraft, 'F5 draft preserved')
  assert.ok(text(container).includes('OLD SESSION MESSAGE'))
  resultEntry().open = true
  for (const button of all(resultEntry(), item => item.type === 'button' && text(item) === '知道了')) await button.props.onClick()
  await settle()
  assertSameReference(resultEntry(), undefined)
  assert.equal(nativeResults.size, 1, 'directory failure stays separate from the selected Work')
  find(container, item => item.type === 'button' && String(item.props['aria-label'] ?? '').startsWith('打开工作列表，有')).props.onClick(); await settle()
  const workList = find(container, item => item.type === 'aside' && item.props['aria-label'] === '工作列表')
  assert.deepEqual(all(workList, item => item.props.class === 'alu-instance-model').map(text), ['未选择模型', 'openai-codex/gpt-6-sol-20261001'],
    'each Work in the list shows its whole provider/model without opening it')
  const listResult = find(workList, item => item.type === 'details' && item.props['aria-label'] === '操作结果')
  assert.ok(text(listResult).includes('新建 Work没有完成')); listResult.open = true
  await find(listResult, item => item.type === 'button' && text(item) === '知道了').props.onClick(); await settle()
  assert.equal(app.selectedWorkId, 'work', 'directory result acknowledgement does not select a Work')
  assert.equal(nativeResults.size, 0)
  find(workList, item => item.props['aria-label'] === '关闭工作列表').props.onClick(); await settle()
  assert.equal(calls.some(call => ['new_session', 'reload_session', 'navigate_session'].includes(call.command)), false, 'reading/acknowledging results never replays operations')
  for (const scenario of ['send-away', 'send-switch-during-handoff', 'lost-away']) {
    const lost = scenario === 'lost-away'
    const failure = { operationId: scenario, kind: 'submit_message', connectionId: 'host', instanceId: 'work',
      hostEpoch: 'epoch', runtimeGeneration: 1, sessionId: 'old', editor: capturedBeforeF5, state: lost ? 'unknown' : 'failed',
      error: lost ? { code: 'effect_unknown', outcomeUnknown: true, message: 'fixture' } : { code: 'busy', outcomeUnknown: false, message: '这次消息没有发送，请检查后重试。' } }
    if (scenario !== 'send-switch-during-handoff') { app.selectWork('other'); await settle() }
    nativeResults.set(scenario, failure); emit('aludock://operation', failure)
    if (scenario === 'send-switch-during-handoff') app.selectWork('other') // before nextTick/frame handoff
    await settle()
    assert.equal(nativeResults.has(scenario), true, 'an unseen send failure cannot be consumed')
    assert.equal(app.selectedWorkId, 'other'); assert.equal(app.currentDraft, 'other draft')
    assertSameReference(resultEntry(), undefined)
    assert.equal(text(container).includes(lost ? '没收到结果' : '这次消息没有发送'), false, 'do not write the original send error into another Work')
    app.selectWork('work'); await settle(); contentSnapshot(); await settle()
    assert.ok(text(resultEntry()).includes(lost ? '发送消息没收到结果' : '发送消息没有完成')); resultEntry().open = true
    await find(resultEntry(), item => item.type === 'button' && text(item) === '知道了').props.onClick(); await settle()
    assert.equal(nativeResults.has(scenario), false)
    assert.equal(app.currentDraft, 'F5 draft preserved')
  }
  assert.equal(calls.filter(call => call.command === 'submit_message').length, initialSends, 'viewing failure never resends')
  const compact = find(container, item => item.type === 'textarea')
  assert.ok(compact)
  compact.props['onUpdate:modelValue']('continue typing')
  compact.selectionStart = 3; compact.selectionEnd = 8; compact.focus()
  compact.props.onCompositionstart({ type: 'compositionstart', currentTarget: compact })
  const earlierClick = find(container, item => item.type === 'button' && text(item).includes('加载更早记录'))
  earlierClick.props.onClick(); await settle()
  assert.equal(calls.filter(call => call.command === 'read_conversation_content' && call.args.intent === 'earlier').length, 1)
  contentChange({ kind: 'entry_state', entryId: 'slow-record', loading: true })
  recordChunk({ ...bootstrap.records[0], content: [{ type: 'text', text: 'OLD SESSION MESSAGE — COMPLETE BODY' }] })
  await settle()
  assert.ok(text(container).includes('COMPLETE BODY'), 'fast body completion paints while earlier history and another body are held')
  assertSameReference(find(container, item => item.type === 'textarea'), compact)
  assertSameReference(document.activeElement, compact)
  assert.deepEqual([compact.selectionStart, compact.selectionEnd], [3, 8])
  releaseHistory(); await settle()
  assert.ok(text(container).includes('EARLIER NATIVE RECORD'), 'the actual earlier button displays the native increment')
  contentChange({ kind: 'entry_state', entryId: 'slow-record', loading: false, error: '这部分内容暂时无法读取，请重试。' }); await settle()
  await find(container, item => item.type === 'button' && text(item) === '重试读取').props.onClick(); await settle()
  assert.equal(calls.at(-1).command, 'read_conversation_content')
  assert.equal(calls.at(-1).args.intent, 'retry')
  assertSameReference(find(container, item => item.type === 'textarea'), compact)
  failCatalog = true
  observation({ kind: 'status', state: 'disconnected', message: 'offline' })
  const refresh = refreshControl(container)
  await refresh.props.onClick(); await settle()
  const offlineList = find(container, item => item.type === 'aside' && item.props['aria-label'] === '工作列表')
  assert.ok(text(offlineList).includes('工作列表没有刷新'), '#313: a failed refresh is visible in the Work list')
  assert.ok(text(offlineList).includes('Other Work') || all(offlineList, item => item.props.class === 'alu-instance-link').length === 2, 'the list keeps its Works')
  assert.equal(text(offlineList).includes('暂无工作'), false)
  assertSameReference(find(container, item => item.type === 'textarea'), compact)
  assertSameReference(document.activeElement, compact)
  assert.deepEqual([compact.selectionStart, compact.selectionEnd], [3, 8])
  assert.equal(compact.props.disabled, undefined); assert.equal(compact.props.readonly, undefined)
  compact.props['onUpdate:modelValue']('still editing offline'); assert.equal(app.currentDraft, 'still editing offline')
  assert.ok(text(container).includes('OLD SESSION MESSAGE'))
  assertSameReference(find(container, item => String(item.props.class).includes('alu-recovery-notice')), undefined)
  compact.props.onCompositionend({ type: 'compositionend', currentTarget: compact })
  find(container, item => item.props['aria-label'] === '展开编辑').props.onClick(); await settle()
  const expanded = all(container, item => item.type === 'textarea').find(item => item !== compact)
  assert.ok(expanded); expanded.focus(); expanded.selectionStart = 2; expanded.selectionEnd = 6
  expanded.props.onCompositionstart({ type: 'compositionstart', currentTarget: expanded })
  contentChange({ kind: 'entry_state', entryId: 'slow-record', loading: true })
  recordChunk({ ...bootstrap.records[0], content: [{ type: 'text', text: 'OLD SESSION MESSAGE — EXPANDED BODY' }] }); await settle()
  assert.ok(text(container).includes('EXPANDED BODY'))
  assert.ok(all(container, item => item.type === 'textarea').includes(expanded))
  assertSameReference(document.activeElement, expanded); assert.deepEqual([expanded.selectionStart, expanded.selectionEnd], [2, 6])
  observation({ kind: 'facts', bootstrap: { ...bootstrap, records: [], cursor: { ...cursor, sequence: 52 } } }); await settle()
  emit('aludock://observation', { ...binding, revision: 0, update: { kind: 'event', replayToken: 'native-content', event: {
    instanceId: 'work', runtimeGeneration: 1, sequence: 53, eventType: 'message.completed', occurredAt: 'now', data: { messageId: 'native-post-cut', role: 'assistant', content: [{ type: 'text', text: 'NATIVE POST-CUT REPLAY' }] },
  } } }); await settle()
  assert.ok(text(container).includes('NATIVE POST-CUT REPLAY'), 'post-cut seed events are ordered by remote sequence, not discarded by a newer local content revision')
  assert.ok(text(container).includes('OLD SESSION MESSAGE'), 'observation facts do not retire an unproven content prefix')
  observation({ kind: 'status', state: 'connected' }); await refresh.props.onClick(); await settle()
  assert.ok(all(container, item => item.type === 'textarea').includes(expanded))
  assertSameReference(document.activeElement, expanded); assert.deepEqual([expanded.selectionStart, expanded.selectionEnd], [2, 6])
  beforeBatchFrame = frames
  const updates = [
    { revision: ++revision, update: { kind: 'status', state: 'disconnected' } },
    { revision: ++revision, update: { kind: 'status', state: 'connected' } },
  ]
  emit('aludock://observation', { ...binding, revision, deliveryId: 44, update: { kind: 'batch', updates } }); await settle()
  assert.equal(calls.filter(call => call.command === 'acknowledge_conversation_follow' && call.args.deliveryId === 44).length, 1)
  assert.ok(all(container, item => item.type === 'textarea').includes(expanded))
  assert.ok(text(container).includes('OLD SESSION MESSAGE'), 'same-domain batched rebind never clears the current surface')
  emit('aludock://observation', { ...binding, revision: 0, update: { kind: 'binding_error', state: 'content_error', message: 'cannot display content' } }); await settle()
  assert.ok(text(container).includes('对话暂时无法显示'), 'replay errors are visible even below the accepted commit revision')
  const statusEntry = find(container, item => item.type === 'details' && item.props['aria-label'] === '连接状态')
  assert.notEqual(statusEntry.open, true, 'connection/content changes do not auto-open details')
  assert.ok(text(find(statusEntry, item => item.type === 'summary')).includes('正文'), 'intervention has a short visible label, not only a dot')
  statusEntry.open = true // Native details disclosure is a deliberate user action.
  assert.ok(text(statusEntry).includes('重新读取'))
  const readsBeforeAction = calls.filter(call => call.command === 'bootstrap').length
  await find(statusEntry, item => item.type === 'button' && text(item) === '重新读取').props.onClick(); await settle()
  assert.equal(calls.filter(call => call.command === 'bootstrap').length, readsBeforeAction + 1)
  observation({ kind: 'status', state: 'identity_error' }); await settle()
  assert.ok(text(find(statusEntry, item => item.type === 'summary')).includes('身份'))
  assert.ok(find(statusEntry, item => item.type === 'button' && text(item) === '连接与配对'))
  observation({ kind: 'status', state: 'host_changed' }); await settle()
  assert.ok(find(statusEntry, item => item.type === 'button' && text(item) === '刷新状态'))

  assert.ok(text(container).includes('OLD SESSION MESSAGE')); assertSameReference(document.activeElement, expanded)
  observation({ kind: 'status', state: 'connected' }); await settle()
  const captured = app.captureSubmitDraft('host', 'work', [])
  const base = { operationId: 'new-1', kind: 'new_session', ...context, instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1, sessionId: 'old', editor: captured }
  for (const state of ['pending', 'unknown', 'failed']) { emit('aludock://operation', { ...base, operationId: state, state, error: { outcomeUnknown: state === 'unknown' } }); await settle(); assert.ok(text(container).includes('OLD SESSION MESSAGE')) }
  emit('aludock://operation', { ...base, operationId: 'cancelled', state: 'succeeded', result: { instance: atHost(work), cancelled: true } }); await settle()
  assert.ok(text(container).includes('OLD SESSION MESSAGE'))
  // Review regression: a newer header for the same native content must not
  // discard complete rows while the bounded seed waits.
  const oldRow = find(container, item => item.props['data-conversation-id'] === 'old-message')
  const retainedBody = text(oldRow)
  const refreshed = { ...work, name: 'Same Session refreshed' }
  const newerHeader = { ...bootstrap, instance: refreshed, cursor: { ...cursor, sequence: 60 }, records: [] }
  observation({ kind: 'snapshot', target: refreshed, bootstrap: newerHeader, contentToken: 'native-content', canLoadEarlier: false, state: 'connected' })
  await settle()
  assert.ok(text(container).includes(retainedBody), 'newer same-token header keeps the already displayed complete body before any seed')
  assertSameReference(find(container, item => item.props['data-conversation-id'] === 'old-message'), oldRow)
  assert.equal(app.works.find(item => item.id === 'work').name, 'Same Session refreshed', 'newer header control facts still advance')
  assertSameReference(document.activeElement, expanded); assert.deepEqual([expanded.selectionStart, expanded.selectionEnd], [2, 6])
  recordChunk({ ...bootstrap.records[0], recordId: 'earlier-record', entryId: 'earlier-record', content: [{ type: 'text', text: 'EARLIER NATIVE RECORD' }] })
  recordChunk({ ...bootstrap.records[0], content: [{ type: 'text', text: 'OLD SESSION MESSAGE — EXPANDED BODY' }] })
  contentChange({ kind: 'entry_state', entryId: 'old-message', loading: false, error: '这部分内容暂时无法读取，请重试。' })
  recordChunk(bootstrap.records[1])
  recordChunk({ ...bootstrap.records[0], recordId: 'seed-good', entryId: 'seed-good', content: [{ type: 'text', text: 'NEW SEED RECORD' }] })
  contentChange({ kind: 'state', canLoadEarlier: false, loading: false })
  contentChange({ kind: 'checkpoint_end' }); await settle()
  assert.ok(text(container).includes(retainedBody), 'a body-read failure after a retained header cannot erase its complete row')
  assert.ok(text(container).includes('NEW SEED RECORD'))
  assertSameReference(find(container, item => item.type === 'button' && text(item).includes('加载更早记录')), undefined, 'read-to-start remains current after an older truncated checkpoint ends')
  assertSameReference(document.activeElement, expanded); assert.deepEqual([expanded.selectionStart, expanded.selectionEnd], [2, 6])

  observation({ kind: 'snapshot', target: refreshed, bootstrap: { ...newerHeader, cursor: { ...cursor, sequence: 61 } }, contentToken: 'different-native-branch', canLoadEarlier: false, state: 'connected' })
  await settle()
  assert.equal(text(container).includes(retainedBody), false, 'a different native token retires the branch even when runtime and Session IDs match')
  observation({ kind: 'content', token: 'different-native-branch', change: { kind: 'record_chunk', entryId: 'branch-record', first: true, complete: true,
    text: JSON.stringify({ ...bootstrap.records[0], recordId: 'branch-record', entryId: 'branch-record', content: [{ type: 'text', text: 'NEW BRANCH BODY' }] }) } })
  observation({ kind: 'content', token: 'different-native-branch', change: { kind: 'checkpoint_end' } }); await settle()
  assert.ok(text(container).includes('NEW BRANCH BODY'))
  assertSameReference(find(container, item => item.type === 'button' && text(item).includes('加载更早记录')), undefined, 'a fresh native header owns the boundary even without a State before End')
  const replacement = atHost({ ...work, name: 'New Session', runtimeGeneration: 2, executor: { ...work.executor, piSessionId: 'new' } })
  observation({ kind: 'replacement_snapshot', target: replacement }); await settle()
  assert.equal(text(container).includes('OLD SESSION MESSAGE'), false, 'accepted new retires old before any read or Extension cleanup')
  assert.equal(text(container).includes('NEW BRANCH BODY'), false)
  assertSameReference(find(container, item => item.type === 'textarea'), compact)
  expanded.props['onUpdate:modelValue']('later input')
  emit('aludock://operation', { ...base, state: 'succeeded', result: { instance: replacement, cancelled: false } }); await settle()
  assert.equal(app.currentDraft, 'later input', 'event-before-reply cannot consume later input')
  observation({ kind: 'read', bootstrap }); await settle()
  assert.equal(text(container).includes('OLD SESSION MESSAGE'), false, 'late old-session read stays isolated')
  const visibleSendFailure = { ...base, operationId: 'visible-send-failure', kind: 'submit_message', runtimeGeneration: 2, sessionId: 'new', state: 'failed', error: { code: 'busy', outcomeUnknown: false, message: '当前消息没有发送，请检查后重试。' } }
  nativeResults.set(visibleSendFailure.operationId, visibleSendFailure)
  emit('aludock://operation', visibleSendFailure); await settle()
  assert.ok(text(container).includes('当前消息没有发送'))
  assert.equal(nativeResults.has(visibleSendFailure.operationId), false, 'current, still-visible inline failure can acknowledge after a frame')
  assert.equal(app.currentDraft, 'later input')
  // Review of 63b1b31: the sending button's own catch is gone after switching Works and back;
  // a lost reply that then arrives is still reported once, like any failed send.
  const visibleLostSend = { ...visibleSendFailure, operationId: 'visible-lost-send', state: 'unknown', error: { code: 'effect_unknown', outcomeUnknown: true, message: 'fixture' } }
  nativeResults.set(visibleLostSend.operationId, visibleLostSend)
  emit('aludock://operation', visibleLostSend); await settle()
  assert.ok(text(container).includes('连接中断，没收到结果'), 'a lost send reply arriving on its own Work is shown')
  assert.equal(nativeResults.has(visibleLostSend.operationId), false, 'once shown, it is acknowledged like a failed send')
  assert.equal(app.currentDraft, 'later input')
  assert.ok(all(container, item => item.type === 'textarea').includes(expanded))
  // User-reported Queue order: retrieve 1/2/3 before the current draft, together
  // with attachments, in one edit. Both existing event orders use this result.
  const currentWork = JSON.parse(JSON.stringify(app.selectedWork))
  const queueItem = id => ({ queueItemId: id, delivery: 'followUp', text: `text-${id}`, attachments: [], imageCount: 0, acceptedAt: '2026-09-19' })
  const queueAttachment = { fileId: '24077798-dfe5-41e8-9b6c-5216f492c180', name: 'queued.png', mediaType: 'image/png', sizeBytes: 68, sha256: 'a'.repeat(64), storedAt: '2026-09-19T00:00:00Z' }
  const currentAttachment = { ...queueAttachment, fileId: 'fdc6b4d2-4121-40c3-85cf-d82a0040503b', name: 'current.png' }
  let remoteSequence = 100
  for (const ordering of ['receipt-first', 'event-first']) {
    const oldId = `${ordering}-old`, newId = `${ordering}-new`
    const queueWork = { ...currentWork, pending: { steering: 0, followUp: 3, total: 3 }, updatedAt: '2026-09-19' }
    const restored = [{ ...queueItem(oldId), text: 'queued 1', attachments: [queueAttachment] },
      { ...queueItem(`${oldId}-2`), text: 'queued 2' }, { ...queueItem(`${oldId}-3`), text: 'queued 3', imageCount: 1 }]
    const oldIds = restored.map(item => item.queueItemId)
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: queueWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: remoteSequence }, records: [], activeEvents: [], queue: restored }, contentToken: `queue-${ordering}`, state: 'connected' })
    observation({ kind: 'content', token: `queue-${ordering}`, change: { kind: 'checkpoint_end' } })
    compact.props['onUpdate:modelValue']('original editor')
    app.setCurrentAttachments([currentAttachment])
    await settle()
    let resolveQueue, capturedQueue
    dequeueNative = args => { capturedQueue = args; return new Promise(resolve => { resolveQueue = resolve }) }
    const queueButton = find(container, item => item.type === 'button' && item.props.title === '取回 Queue（Alt+↑）')
    assert.ok(queueButton)
    const queueAwait = queueButton.props.onClick()
    await settle()
    assert.equal(capturedQueue.operationEditor, null, 'retrieval does not capture the editor before dispatch')
    if (ordering === 'receipt-first') {
      app.selectWork('other'); await settle()
      assert.equal(find(container, item => item.props.class === 'alu-send-btn').props.disabled, false, 'A retrieving Queue does not block sending to B')
      app.selectWork('work'); await settle()
      observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: queueWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: remoteSequence }, records: [], activeEvents: [], queue: restored }, contentToken: `queue-${ordering}`, state: 'connected' })
      observation({ kind: 'content', token: `queue-${ordering}`, change: { kind: 'checkpoint_end' } })
      await settle()
    }
    const result = { instance: atHost({ ...queueWork, pending: { steering: 0, followUp: 0, total: 0 } }), receipt: { instanceId: 'work', restored } }
    const receipt = { ...base, operationId: capturedQueue.operationId, kind: 'dequeue_messages', runtimeGeneration: 2, sessionId: '', editor: capturedQueue.operationEditor, state: 'succeeded', result }
    const deliverReceipt = () => { restoredImageCount = 1; nativeResults.set(receipt.operationId, receipt); emit('aludock://operation', receipt) }
    const event = (eventType, data) => observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: '2026-09-20T00:00:00Z', eventType, data } })
    if (ordering === 'receipt-first') deliverReceipt()
    else event('queue.cleared', { reason: 'dequeued', queueItemIds: oldIds, steering: 0, followUp: 1, total: 1 })
    event('message.queued', { ...queueItem(newId), images: [] })
    if (ordering === 'receipt-first') event('queue.cleared', { reason: 'dequeued', queueItemIds: oldIds, steering: 0, followUp: 1, total: 1 })
    else {
      compact.props['onUpdate:modelValue']('current editor at success')
      consumeFailures.add(receipt.operationId)
      deliverReceipt()
    }
    event('message.completed', { messageId: ordering, role: 'assistant', content: [{ type: 'text', text: `visible-${ordering}` }] })
    resolveQueue(result); await queueAwait; await settle()
    emit('aludock://operation', receipt); await settle()
    const queuePreview = find(container, item => String(item.props.class).includes('alu-queue-preview'))
    assert.equal(text(queuePreview), `text-${newId}`, 'a receipt never clears later Queue items')
    assert.ok(text(container).includes(`visible-${ordering}`), 'Queue result acceptance never advances past an undisplayed conversation event')
    const expectedDraft = ordering === 'receipt-first' ? 'queued 1\n\nqueued 2\n\nqueued 3\n\noriginal editor' : 'queued 1\n\nqueued 2\n\nqueued 3\n\ncurrent editor at success'
    assert.equal(app.currentDraft, expectedDraft, 'retrieved order precedes the editor contents at success')
    assert.deepEqual(app.currentAttachments.map(item => item.fileId), [currentAttachment.fileId, queueAttachment.fileId])
    assert.ok(text(container).includes('queued.png') && text(container).includes('current.png'))
    assert.ok(text(container).includes('已取回 1 个附件'))
    assertSameReference(find(container, item => item.type === 'button' && text(item) === '追加到编辑器'), undefined, 'retrieval completes without a second editing action')
    if (ordering === 'event-first') {
      assert.equal(nativeResults.has(receipt.operationId), true)
      const retry = find(container, item => item.type === 'button' && text(item) === '重试关闭')
      assert.ok(retry, 'existing acknowledgement retry does not repeat retrieval or insertion')
      const dequeues = calls.filter(call => call.command === 'dequeue_messages').length
      emit('aludock://operation', receipt); await settle()
      consumeFailures.delete(receipt.operationId)
      await retry.props.onClick(); await settle()
      assert.equal(nativeResults.has(receipt.operationId), false)
      assert.equal(calls.filter(call => call.command === 'consume_operation' && call.args.operationId === receipt.operationId).length, 2)
      assert.equal(calls.filter(call => call.command === 'dequeue_messages').length, dequeues)
      assert.equal(app.currentDraft, expectedDraft)
    }
    app.setCurrentAttachments([])
    restoredImageCount = 0
    remoteSequence += 10
  }
  // A click/await result is not the draft claimant. The operation event is, even
  // if the originating view moves to another Work while native execution runs.
  for (const operationId of ['unknown', 'pending']) emit('aludock://operation', { ...base, operationId, state: 'succeeded', result: { instance: atHost(currentWork), cancelled: true } })
  await settle()
  // User report: expanded send succeeds before the native draft-clear event, but the dialog stays open.
  const expandedEditor = () => find(container, item => item.type === 'textarea' && item.props.class === 'ui-dialog-composer-editor')
  for (const outcome of ['receipt-first', 'event-first', 'failed', 'edited']) {
    if (!expandedEditor()) { find(container, item => item.props['aria-label'] === '展开编辑').props.onClick(); await settle() }
    expandedEditor().props['onUpdate:modelValue']('expanded original')
    await settle()
    let submitted, resolveExpanded, rejectExpanded
    submitNative = args => { submitted = args; return new Promise((resolve, reject) => { resolveExpanded = resolve; rejectExpanded = reject }) }
    const footer = find(container, item => String(item.props.class ?? '').includes('ui-dialog-composer-footer'))
    const sendingExpanded = find(footer, item => item.type === 'button' && text(item) === '发送').props.onClick()
    await settle()
    const result = { receipt: { queued: true, delivery: 'followUp' }, instance: atHost(currentWork) }
    const operation = { ...base, operationId: submitted.operationId, kind: 'submit_message', runtimeGeneration: 2, sessionId: 'new', editor: submitted.operationEditor, state: 'succeeded', result }
    if (outcome === 'edited') expandedEditor().props['onUpdate:modelValue']('next unsent message')
    if (outcome === 'event-first') { nativeResults.set(operation.operationId, operation); emit('aludock://operation', operation); await settle() }
    if (outcome === 'failed') rejectExpanded({ code: 'busy', message: '消息未发送，请重试。' })
    else resolveExpanded(result)
    await sendingExpanded; await settle()
    assert.equal(!!expandedEditor(), outcome === 'failed' || outcome === 'edited', 'successful expanded send closes promptly, but failure or later input keeps the editor open')
    if (outcome === 'receipt-first') assert.equal(app.currentDraft, 'expanded original', 'closing the surface does not take over native draft cleanup')
    if (outcome !== 'failed' && outcome !== 'event-first') { nativeResults.set(operation.operationId, operation); emit('aludock://operation', operation); await settle() }
    assert.equal(app.currentDraft, outcome === 'edited' ? 'next unsent message' : outcome === 'failed' ? 'expanded original' : '')
    if (expandedEditor()) {
      const dialog = find(container, item => String(item.props.class ?? '').includes('ui-dialog-box-composer'))
      find(dialog, item => item.props['aria-label'] === '关闭').props.onClick(); await settle()
    }
  }
  compact.props['onUpdate:modelValue']('send original')
  let resolveSend, capturedSend
  submitNative = args => { capturedSend = args; return new Promise(resolve => { resolveSend = resolve }) }
  const sendForm = find(container, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap'))
  const sending = sendForm.props.onSubmit({ preventDefault() {} })
  await settle()
  assert.equal(capturedSend.operationEditor.text, capturedSend.message)
  assert.equal(capturedSend.expectedRuntimeGeneration, 2)
  compact.props['onUpdate:modelValue']('send changed later')
  app.selectWork('other'); await settle()
  assert.equal(find(container, item => item.props.class === 'alu-send-btn').props.disabled, false, 'A pending send does not block sending to B')
  submitNative = async args => {
    assert.equal(args.instanceId, 'other')
    assert.equal(args.message, 'other draft')
    throw { code: 'busy', message: 'B 的消息未发送，请重试。' }
  }
  await find(container, item => item.type === 'form' && item.props.class === 'alu-input-wrap').props.onSubmit({ preventDefault() {} })
  const sendResult = { receipt: { queued: false, delivery: 'prompt' }, instance: atHost(currentWork) }
  const sentOperation = { ...base, operationId: capturedSend.operationId, kind: 'submit_message', runtimeGeneration: 2, sessionId: 'new', editor: capturedSend.operationEditor, state: 'succeeded', result: sendResult }
  consumeFailures.add(sentOperation.operationId); nativeResults.set(sentOperation.operationId, sentOperation)
  emit('aludock://operation', sentOperation); resolveSend(sendResult); await sending; await settle()
  assert.equal(app.selectedWorkId, 'other'); assert.equal(app.currentDraft, 'other draft')
  app.selectWork('work'); await settle()
  assert.equal(app.currentDraft, 'send changed later', 'late native send cannot clear a later revision in the original editor')
  assert.ok(text(container).includes('操作已完成，本机保存或确认尚未完成'), 'automatic success acknowledgement failure is visible on the original Work without implying an unknown operation outcome')
  assertSameReference(find(container, item => item.type === 'button' && text(item) === '追加到编辑器'), undefined, 'a send result has no returned text to append')
  compact.props['onUpdate:modelValue']('edited after automatic claim')
  const sendCount = calls.filter(call => call.command === 'submit_message').length
  emit('aludock://operation', sentOperation); await settle()
  consumeFailures.delete(sentOperation.operationId)
  await find(container, item => item.type === 'button' && text(item) === '重试关闭').props.onClick(); await settle()
  assert.equal(app.currentDraft, 'edited after automatic claim')
  assert.equal(nativeResults.has(sentOperation.operationId), false)
  assert.equal(calls.filter(call => call.command === 'consume_operation' && call.args.operationId === sentOperation.operationId).length, 2)
  assert.equal(calls.filter(call => call.command === 'submit_message').length, sendCount)
  // A Model reply the Host wrote while the Work was idle arrives after the run that
  // started next, in the same millisecond. Event order, not time, decides, so the
  // late reply cannot put the Work back to idle and hide Abort for that run.
  {
    const moment = '2026-10-08T00:00:00.000Z'
    const idleWork = { ...JSON.parse(JSON.stringify(app.selectedWork)), execution: 'idle', updatedAt: moment }
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: idleWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: ++remoteSequence }, records: [], activeEvents: [], queue: [] }, contentToken: 'late-model-reply', state: 'connected' })
    observation({ kind: 'content', token: 'late-model-reply', change: { kind: 'checkpoint_end' } }); await settle()
    const modelReply = atHost(idleWork)
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: moment, eventType: 'run.started', data: {} } }); await settle()
    emit('aludock://operation', { ...base, operationId: 'late-model-reply', kind: 'set_model', runtimeGeneration: 2, sessionId: 'new', editor: null, state: 'succeeded', result: modelReply }); await settle()
    assert.equal(app.selectedWork.execution, 'running', 'the late reply does not put the running Work back to idle')
    const abort = find(container, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run'))
    assert.equal(abort !== undefined && abort.props.disabled === false, true, 'Abort stays available for the running Work')
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: moment, eventType: 'run.settled', data: { result: 'succeeded' } } }); await settle()
    remoteSequence += 10
  }
  console.log('PASS: a late reply in the same millisecond keeps the running Work and its Abort control')
  // User report 2026-10-29: after starting a compaction, leaving and coming back showed
  // '压缩上下文没收到结果' twice and asked to acknowledge it, although the conversation
  // already said the compaction was done. Whether it compacted is the conversation's to say.
  {
    const startCompaction = async () => {
      find(container, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
      const palette = find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心')
      await find(palette, item => item.type === 'button' && String(item.props.class).includes('cmd-palette-item') && text(item).includes('Compact Context')).props.onClick(); await settle()
      await find(container, item => item.type === 'button' && text(item) === '开始压缩').props.onClick(); await settle()
    }
    // The core reports the result first, then the call rejects, as the native layer does.
    const answer = (args, state, error) => {
      const operation = { ...base, operationId: args.operationId, kind: 'compact_session', runtimeGeneration: 2, sessionId: '', editor: null, state, error }
      nativeResults.set(operation.operationId, operation); emit('aludock://operation', operation)
      throw error
    }
    let lostId
    compactNative = args => { lostId = args.operationId; return answer(args, 'unknown', { code: 'effect_unknown', outcomeUnknown: true, message: '操作中断，没收到结果。' }) }
    await startCompaction()
    assert.equal(text(container).includes('没收到结果'), false, 'a lost compaction reply is told nowhere')
    assert.equal(nativeResults.has(lostId), false, 'nothing is left waiting for 知道了')
    const refused = '这次压缩没有开始，请稍后重试。'
    compactNative = args => answer(args, 'failed', { code: 'busy', outcomeUnknown: false, message: refused })
    await startCompaction()
    assert.equal(text(container).split(refused).length - 1, 1, 'a refused compaction is said once, above the composer')
    assert.equal(text(container).includes('压缩上下文没有完成'), false, 'with no Work result entry repeating it')
    compactNative = undefined
    // A later compaction in the conversation replaces that line.
    for (const eventType of ['compaction.started', 'compaction.completed']) {
      observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: 'now', eventType, data: { reason: 'manual', aborted: false, willRetry: false } } })
    }
    await settle()
    remoteSequence += 10
  }
  console.log('PASS: a lost compaction reply is not told; a refused compaction is told once')
  // #326: Abort takes the waiting Queue back in the same native call and inserts it like retrieval.
  // #357: the abort control only exists while the Work is running.
  {
    assert.equal(app.selectedWork.execution === 'running', false)
    assertSameReference(find(container, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run')), undefined, 'an idle Work shows no abort control')
    const abortWork = { ...JSON.parse(JSON.stringify(app.selectedWork)), execution: 'running', pending: { steering: 0, followUp: 2, total: 2 } }
    const restored = [{ ...queueItem('abort-1'), text: 'queued a' }, { ...queueItem('abort-2'), text: 'queued b' }]
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: abortWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: remoteSequence }, records: [], activeEvents: [], queue: restored }, contentToken: 'abort-queue', state: 'connected' })
    observation({ kind: 'content', token: 'abort-queue', change: { kind: 'checkpoint_end' } })
    compact.props['onUpdate:modelValue']('editor at abort')
    // A lost compaction reply leaves no refresh-to-confirm action, and Abort stays usable.
    const unconfirmedCompaction = { ...base, operationId: 'unconfirmed-compaction', kind: 'compact_session', runtimeGeneration: 2, sessionId: '', editor: null, state: 'unknown', error: { message: '压缩结果尚未确认。', outcomeUnknown: true } }
    emit('aludock://operation', unconfirmedCompaction)
    await settle()
    assertSameReference(find(container, item => item.type === 'button' && /刷新.*确认/.test(text(item))), undefined, 'no refresh-to-confirm action')
    const abortButton = find(container, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run'))
    assert.equal(abortButton.props.disabled, false, 'a lost reply elsewhere does not disable Abort')
    const dequeues = calls.filter(call => call.command === 'dequeue_messages').length
    let resolveAbort, abortArgs
    abortNative = args => { abortArgs = args; return new Promise(resolve => { resolveAbort = resolve }) }
    const pendingAbort = abortButton.props.onClick(); await settle()
    assert.equal(abortArgs.operationEditor, null, 'Abort does not capture the editor before dispatch')
    // The Host publishes what Abort did on the Work's live events, then replies.
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: 'now', eventType: 'queue.cleared',
      data: { reason: 'dequeued', queueItemIds: restored.map(item => item.queueItemId), steering: 0, followUp: 2, total: 2 } } })
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: ++remoteSequence, occurredAt: 'now', eventType: 'run.settled', data: { result: 'aborted' } } })
    const result = { instance: atHost({ ...abortWork, execution: 'idle', pending: { steering: 0, followUp: 0, total: 0 } }), receipt: { instanceId: 'work', restored, inFlight: [] } }
    const receipt = { ...base, operationId: abortArgs.operationId, kind: 'abort_run', runtimeGeneration: 2, sessionId: '', editor: null, state: 'succeeded', result }
    nativeResults.set(receipt.operationId, receipt); emit('aludock://operation', receipt)
    resolveAbort(result); await pendingAbort; await settle()
    assert.equal(app.currentDraft, 'queued a\n\nqueued b\n\neditor at abort', 'returned messages precede the editor text')
    assert.equal(calls.filter(call => call.command === 'dequeue_messages').length, dequeues, 'Abort needs no separate Queue retrieval')
    assertSameReference(find(container, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run')), undefined, 'the abort control leaves with the run')
    assert.ok(text(container).includes('已中止，2 条排队消息已放回输入框'))
    emit('aludock://operation', { ...unconfirmedCompaction, state: 'succeeded', error: undefined, result: { instance: result.instance } })
    compact.props['onUpdate:modelValue']('later input')
    remoteSequence += 10
    await settle()
  }
  console.log('PASS: Queue insertion and automatic send success / failed confirmation / retry acknowledgement only / Abort returns the Queue in one call')
  // A lost New Work or Stop reply leaves no standing notice in the Work list or the command center.
  {
    const bootstraps = () => calls.filter(call => call.command === 'bootstrap').length
    emit('aludock://operation', { ...base, operationId: 'unconfirmed-create', kind: 'create_work', instanceId: 'global', runtimeGeneration: 0, sessionId: '', editor: null, state: 'unknown', error: { message: '新建结果尚未确认。', outcomeUnknown: true } })
    emit('aludock://operation', { ...base, operationId: 'unconfirmed-stop', kind: 'stop_work', runtimeGeneration: 2, sessionId: '', editor: null, state: 'unknown', error: { message: '停止结果尚未确认。', outcomeUnknown: true } })
    await settle()
    const workList = find(container, item => item.type === 'aside' && item.props['aria-label'] === '工作列表')
    assert.equal(/确认|不要重复/.test(text(workList)), false, 'the Work list keeps no unconfirmed notice')
    find(container, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
    const controlDialog = find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心')
    assertSameReference(find(controlDialog, item => item.type === 'button' && /刷新.*确认/.test(text(item))), undefined, 'the command center has no refresh-to-confirm action')
    controlDialog.parent.props.onKeydown({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} }); await settle()
    assertSameReference(find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心'), undefined)
    // #358: without a toolbar refresh button, the palette's 刷新状态 is the refresh entry and closes the palette.
    find(container, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
    const beforePaletteRefresh = bootstraps()
    const paletteDialog = find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心')
    await find(paletteDialog, item => item.type === 'button' && String(item.props.class).includes('cmd-palette-item') && text(item).includes('刷新状态')).props.onClick(); await settle()
    assert.equal(bootstraps(), beforePaletteRefresh + 1, 'the palette entry refreshes the Work list and current Work')
    assertSameReference(find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心'), undefined, 'the palette closes after refresh')
    assertSameReference(find(container, item => item.type === 'button' && item.props.title === '刷新'), undefined, 'no standalone refresh button remains')
  }
  // Review P2: action feedback belongs to its initiating Work, including a
  // failure delivered after selection changes. Native failures stay retained.
  for (const timing of ['failed-before-switch', 'failed-after-switch']) {
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: { ...JSON.parse(JSON.stringify(app.selectedWork)), execution: 'running', pending: { steering: 0, followUp: 0, total: 0 } }, cursor: { ...cursor, runtimeGeneration: 2, sequence: 180 }, records: [], activeEvents: [], queue: [] }, contentToken: `abort-${timing}`, state: 'connected' })
    await settle()
    let rejectAbort, abortArgs
    abortNative = args => { abortArgs = args; return new Promise((_resolve, reject) => { rejectAbort = reject }) }
    const abort = find(container, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run'))
    assert.equal(abort.props.disabled, false)
    const pendingAbort = abort.props.onClick(); await settle()
    if (timing === 'failed-after-switch') { app.selectWork('other'); await settle() }
    const failure = { code: 'busy', message: 'A 的中止未完成，请重试。' }
    const failedOperation = { ...base, operationId: abortArgs.operationId, kind: 'abort_run', runtimeGeneration: 2, sessionId: 'new', editor: abortArgs.operationEditor, state: 'failed', error: failure }
    nativeResults.set(failedOperation.operationId, failedOperation); emit('aludock://operation', failedOperation)
    rejectAbort(failure); await pendingAbort; await settle()
    const composerError = () => find(container, item => String(item.props.class).includes('alu-composer-error'))
    if (timing === 'failed-before-switch') {
      assert.ok(text(composerError()).includes('A 的中止未完成'))
      app.selectWork('other'); await settle()
    }
    assert.equal(Boolean(composerError() && text(composerError()).includes('A 的中止未完成')), false, `${timing}: A action feedback must not enter B's input`)
    assert.equal(nativeResults.has(failedOperation.operationId), true, 'hiding old surface feedback never acknowledges its native result')
    app.selectWork('work'); await settle()
  }
  console.log('PASS: Work action feedback / failure before and after changing Work / native result remains unconsumed')
  // #316: a late download failure stays with the Work whose file panel started it.
  let rejectDownload
  downloadNative = () => new Promise((_resolve, reject) => { rejectDownload = reject })
  const deliveryTray = () => find(container, item => item.props['aria-labelledby'] === 'delivery-tray-title')
  find(container, item => item.props['aria-label'] === '打开文件列表').props.onClick(); await settle()
  find(deliveryTray(), item => item.props['aria-label'] === '下载 report.pdf').props.onClick(); await settle()
  app.selectWork('other'); await settle()
  rejectDownload({ code: 'io_error', message: '保存位置暂时不可用，请重试。' }); await settle()
  assert.equal(text(deliveryTray()).includes('没有下载完成'), false, "A's late failure does not appear in B's file panel")
  app.selectWork('work'); await settle()
  assert.ok(text(deliveryTray()).includes('“report.pdf”没有下载完成。'), 'returning to A shows which file failed')
  // 2026-09-30 review: a retained download failure must not hide a later file-list failure.
  deliveryListNative = async () => { throw { code: 'deliverable_list_failed', message: '暂时无法读取文件列表，请重试。' } }
  find(deliveryTray(), item => item.props['aria-label'] === '刷新当前 Work 的文件').props.onClick(); await settle()
  assert.ok(text(deliveryTray()).includes('暂时无法读取文件列表'), 'the failed list refresh is visible beside the retained download failure')
  assert.ok(text(deliveryTray()).includes('“report.pdf”没有下载完成。'), 'reading the list does not erase the original file failure')
  deliveryListNative = undefined
  find(deliveryTray(), item => item.props['aria-label'] === '关闭文件列表' && item.type === 'button' && !String(item.props.class ?? '').includes('scrim')).props.onClick(); await settle()
  // #316: leaving a running Work for a stopped one releases the old observation; the Work itself keeps running.
  const followedBeforeLeaving = { ...binding }
  const stopsBeforeLeaving = calls.filter(call => call.command === 'stop_work' || call.command === 'abort_run').length
  const hostDiagnostic = 'Previous runtime owner release was not confirmed; this instance cannot be reopened'
  extraListed = [{ ...otherWork, id: 'stopped-work', lifecycle: 'stopped', execution: 'idle', ownerHostEpoch: undefined, lastError: hostDiagnostic }]
  await app.refreshWorksQuietly(); await settle()
  app.selectWork('stopped-work'); await settle()
  // #313: the Host's engineering wording stays behind “查看详情” and can be copied; the sentence shown first is ours.
  {
    const stateCard = find(container, item => item.props.class === 'alu-work-state-card')
    assert.ok(text(find(stateCard, item => item.props.class === 'alu-work-state-message')).includes('这是一个已经结束的历史 Work'), 'the stopped Work page leads with our own sentence')
    const details = find(stateCard, item => item.type === 'details')
    assert.ok(details, 'the Host diagnostic has a “查看详情” fold')
    assert.equal(text(find(details, item => item.type === 'summary')), '查看详情')
    assert.equal(text(find(details, item => item.type === 'pre')), hostDiagnostic, 'the Host diagnostic is only inside the details')
    assert.equal(text(stateCard).split(hostDiagnostic).length - 1, 1, 'the diagnostic is not repeated outside the details')
    let copied = ''
    navigator.clipboard = { writeText: async value => { copied = value } }
    await find(details, item => item.type === 'button').props.onClick(); await settle()
    assert.equal(copied, hostDiagnostic, 'copying the diagnostic copies the original Host wording')
    assert.equal(text(find(details, item => item.type === 'button')), '诊断信息已复制')
    delete navigator.clipboard
  }
  assert.ok(calls.some(call => call.command === 'stop_conversation_follow' && call.args.instanceId === 'work' && call.args.subscriptionId === followedBeforeLeaving.subscriptionId), 'the running Work is no longer followed from a stopped Work page')
  assert.equal(calls.filter(call => call.command === 'stop_work' || call.command === 'abort_run').length, stopsBeforeLeaving, 'leaving does not stop or abort the Work')
  app.selectWork('work'); await settle()
  assert.equal(binding.instanceId, 'work')
  assert.notEqual(binding.subscriptionId, followedBeforeLeaving.subscriptionId, 'returning follows the Work again')
  extraListed = []; await app.refreshWorksQuietly(); await settle()
  // #313: when updates for the current Work cannot start or stop arriving, the page says so; nothing claims to retry.
  {
    const followNotice = () => find(container, item => item.props.class === 'alu-follow-failed')
    const statusDetails = () => text(find(container, item => item.type === 'details' && item.props['aria-label'] === '连接状态'))
    const liveWork = JSON.parse(JSON.stringify(app.selectedWork))
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: liveWork, cursor: { ...cursor, runtimeGeneration: liveWork.runtimeGeneration, sequence: 900 }, records: [], activeEvents: [], queue: [] }, contentToken: 'follow-failure', state: 'connected' })
    const record = { ...bootstrap.records[0], recordId: 'follow-record', entryId: 'follow-record', content: [{ type: 'text', text: 'FOLLOWED MESSAGE' }] }
    observation({ kind: 'content', token: 'follow-failure', change: { kind: 'record_chunk', entryId: record.entryId, text: JSON.stringify(record), first: true, complete: true } })
    observation({ kind: 'content', token: 'follow-failure', change: { kind: 'checkpoint_end' } }); await settle()
    assert.ok(text(container).includes('FOLLOWED MESSAGE'))
    failFollowStart = true
    await refreshControl(container).props.onClick(); await settle()
    failFollowStart = false
    assert.ok(text(container).includes('FOLLOWED MESSAGE'), 'the conversation stays on screen')
    assert.ok(followNotice() && text(followNotice()).includes('暂时连不上这项工作'), 'a failed start is shown over the existing conversation')
    assert.ok(statusDetails().includes('客户端不会自动重试'), 'the status no longer says it reconnects by itself')
    assert.equal(statusDetails().includes('客户端会自动重连'), false)
    const followsBefore = calls.filter(call => call.command === 'start_conversation_follow').length
    find(followNotice(), item => item.type === 'button').props.onClick(); await settle()
    assert.equal(calls.filter(call => call.command === 'start_conversation_follow').length, followsBefore + 1, 'reconnect starts following again')
    observation({ kind: 'status', state: 'connected' }); await settle()
    assertSameReference(followNotice(), undefined)
    failAck = true
    emit('aludock://observation', { ...binding, revision: ++revision, deliveryId: 1, update: { kind: 'status', state: 'connected' } }); await settle()
    failAck = false
    assert.ok(followNotice() && text(followNotice()).includes('更新确认没有送达'), 'a failed acknowledgement, after which no updates arrive, is shown')
    find(followNotice(), item => item.type === 'button').props.onClick(); await settle()
    observation({ kind: 'status', state: 'connected' }); await settle()
    assertSameReference(followNotice(), undefined)
  }
  // #313: a slow Model change says what it is doing while the choices are disabled.
  {
    let finishModel
    modelNative = () => new Promise(resolve => { finishModel = resolve })
    find(container, item => String(item.props.class ?? '').includes('alu-nav-selector-model')).props.onClick(); await settle()
    const modelDialog = find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '选择 Model')
    find(modelDialog, item => item.type === 'button' && text(item).includes('fixture/model')).props.onClick(); await settle()
    assert.ok(text(modelDialog).includes('正在切换 Model 到 fixture/model'), 'the pending change is named')
    finishModel(JSON.parse(JSON.stringify(app.selectedWork))); await settle()
    modelNative = undefined
    assertSameReference(find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '选择 Model'), undefined)
  }
  // #339: the real App/PageDialogs wiring owns leaving; submitted saves survive the editor.
  {
    const originalWork = JSON.parse(JSON.stringify(app.selectedWork))
    const originalContext = { ...context }
    app.applyWorkSnapshot({ ...originalWork, hostId: 'laptop' })
    machinesFixture = [
      { hostId: 'main', name: '工作站', kind: 'main', available: true },
      { hostId: 'laptop', name: '笔记本', kind: 'subhost', available: true },
    ]
    const models = [
      { provider: 'azure', id: 'one', name: 'Model One' },
      { provider: 'azure', id: 'two', name: 'Model Two' },
      { provider: 'openai', id: 'three', name: 'Model Three' },
    ]
    let hidden = [{ provider: 'retired', id: 'old' }]
    modelVisibilityNative = async args => ({ models, total: 3, truncated: false, hidden: args.targetHostId === 'laptop' ? hidden : [] })
    const dialog = () => find(container, item => item.props['aria-labelledby'] === 'machine-settings-title')
    const results = () => find(container, item => item.props['aria-label'] === 'Host 设置保存结果')
    const button = (root, label) => find(root, item => item.type === 'button' && (item.props['aria-label'] === label || item.props.title === label || text(item).includes(label)))
    const click = async (root, label) => {
      const target = button(root, label); assert.ok(target, `button exists: ${label}`)
      assert.equal(!!target.props.disabled, false, `${label} is available`)
      target.props.onClick(); await settle()
    }
    const openSettings = async () => { await click(container, 'Host 设置'); assert.ok(dialog()) }
    const escapeSettings = async () => {
      for (const handler of windowEvents.get('keydown') ?? []) handler({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} })
      await settle()
    }
    const chooseMachine = async label => { await click(dialog(), '选择机器'); await click(dialog(), label) }
    const rowCount = label => all(find(dialog(), item => item.props['aria-label'] === label), item => item.type === 'button' && String(item.props.class).includes('model-row')).length
    // Opening through the real model selector also transfers keyboard focus.
    find(container, item => String(item.props.class ?? '').includes('alu-nav-selector-model')).props.onClick(); await settle()
    await click(container, '管理隐藏的模型')
    assert.equal(calls.filter(call => call.command === 'model_visibility').at(-1).args.targetHostId, 'laptop')
    assertSameReference(document.activeElement, button(dialog(), '关闭'))
    assert.ok(text(dialog()).includes('当前不可用'))
    const filter = find(dialog(), item => item.props['aria-label'] === '过滤显示中的模型')
    filter.value = 'azure'; filter['event:input']({ target: filter }); await settle()
    await click(dialog(), '隐藏筛选出的 2 个')
    assert.ok(text(dialog()).includes('已改动 2 项'))
    await escapeSettings()
    assert.ok(text(container).includes('放弃未保存的修改？'), 'real PageDialogs forwards dirty state')
    await click(container, '取消')
    await chooseMachine('工作站 · Main')
    assert.ok(text(container).includes('切换机器？'))
    await click(container, '取消')
    let finishSave, rejectSave
    saveModelVisibilityNative = args => new Promise((resolve, reject) => {
      finishSave = () => { hidden = args.hidden; resolve({ hidden: args.hidden }) }
      rejectSave = reject
    })
    await click(dialog(), '保存')
    assert.ok(text(dialog()).includes('关闭设置不会取消保存'))
    await click(dialog(), '关闭')
    assertSameReference(dialog(), undefined, 'closing unmounts the real editor during a save')
    assert.ok(text(results()).includes('笔记本') && text(results()).includes('正在保存'))
    await openSettings()
    assert.equal(button(dialog(), '正在保存…').props.disabled, true, 'reopening cannot submit the same pending save twice')
    await chooseMachine('工作站 · Main')
    assert.equal(rowCount('已隐藏的模型'), 0)
    finishSave(); await settle()
    assert.equal(rowCount('已隐藏的模型'), 0, 'the laptop response does not overwrite Main')
    assert.ok(text(results()).includes('笔记本') && text(results()).includes('已保存'), 'other machine results remain visible inside the open editor')
    await escapeSettings()
    assert.ok(text(results()).includes('已保存'), 'the original machine reports success after leaving')
    await click(results(), '知道了')

    // Back closes pending saves too. Failed and unknown submissions keep their draft across reopening.
    for (const outcome of ['failed', 'unknown']) {
      await openSettings()
      await click(dialog(), '隐藏 openai/three')
      await click(dialog(), '保存')
      if (outcome === 'failed') { systemBack(); await settle() } else await escapeSettings()
      assertSameReference(dialog(), undefined)
      rejectSave(outcome === 'unknown'
        ? { code: 'effect_unknown', outcomeUnknown: true, message: 'fixture' }
        : { code: 'io_error', message: '保存没有完成，请重试。' })
      await settle()
      assert.ok(text(results()).includes(outcome === 'unknown' ? '没收到保存结果' : '改动已保留'), text(results()))
      assert.equal(find(results(), item => item.props.role === 'alert') !== undefined, outcome === 'failed', 'unknown is not presented as failure')
      const saveCount = calls.filter(call => call.command === 'set_model_visibility').length
      if (outcome === 'unknown') {
        const normalRead = modelVisibilityNative
        let rejectRead
        modelVisibilityNative = () => new Promise((_, reject) => { rejectRead = reject })
        await openSettings(); await click(dialog(), '关闭')
        assertSameReference(dialog(), undefined, 'a pending read does not invent unsaved edits')
        rejectRead({ code: 'connection_failed' }); await settle()
        modelVisibilityNative = async () => { throw { code: 'connection_failed' } }
        await openSettings(); await click(dialog(), '关闭')
        assertSameReference(dialog(), undefined, 'a failed read does not invent unsaved edits')
        modelVisibilityNative = normalRead
      }
      await openSettings()
      assert.equal(rowCount('已隐藏的模型'), 4, 'reopening restores the submitted draft, not only the Host baseline')
      const footer = text(find(dialog(), item => item.type === 'footer'))
      assert.ok(footer.includes('可以再点保存'), 'the editor offers an action available right here')
      assert.equal(footer.includes('可打开 Host 设置'), false)
      assert.equal(calls.filter(call => call.command === 'set_model_visibility').length, saveCount, 'reopening never automatically retries')
      if (outcome === 'failed') {
        await click(dialog(), '恢复显示 openai/three')
        await click(dialog(), '关闭'); await openSettings()
        assert.equal(rowCount('已隐藏的模型'), 3, 'manually reverting the failed edit does not resurrect its old draft')
      } else {
        await click(dialog(), '恢复显示 openai/three')
        await click(dialog(), '关闭')
        assert.ok(text(container).includes('放弃未保存的修改？'), 'edits after an unknown save still need confirmation even at the old baseline')
        await click(container, '取消')
        assert.equal(button(dialog(), '保存').props.disabled, false)
        await click(dialog(), '放弃改动')
      }
      await click(dialog(), '关闭')
    }

    // Review: a fresh matching read settles the desired settings, not the old request outcome.
    await openSettings(); await click(dialog(), '隐藏 openai/three'); await click(dialog(), '保存'); await click(dialog(), '关闭')
    hidden = [...calls.filter(call => call.command === 'set_model_visibility').at(-1).args.hidden].reverse()
    rejectSave({ code: 'effect_unknown', outcomeUnknown: true }); await settle()
    const savesBeforeMatchingRead = calls.filter(call => call.command === 'set_model_visibility').length
    await openSettings()
    assert.ok(text(dialog()).includes('当前设置已与你提交的列表一致'))
    assert.equal(text(dialog()).includes('没收到保存结果'), false)
    assert.equal(text(dialog()).includes('已保存'), false, 'reading current settings does not fabricate a successful save receipt')
    assert.equal(button(dialog(), '保存').props.disabled, true)
    assert.equal(calls.filter(call => call.command === 'set_model_visibility').length, savesBeforeMatchingRead)
    await click(dialog(), '关闭')
    assertSameReference(results(), undefined, 'a matching current read retires the obsolete unknown reminder')
    await openSettings(); await click(dialog(), '恢复显示 openai/three'); await click(dialog(), '关闭')
    assert.ok(text(container).includes('放弃未保存的修改？'), 'later edits still need leave confirmation')
    await click(container, '取消'); await click(dialog(), '保存')
    finishSave(); await settle()
    assert.ok(text(dialog()).includes('已保存'))
    await click(dialog(), '关闭')
    assertSameReference(results(), undefined, 'success already shown in its editor does not demand another acknowledgement outside')

    // An old connection's real success is not relabelled as a failure after switching Hosts.
    const previousCatalogFailure = failCatalog
    failCatalog = false
    await openSettings(); await click(dialog(), '隐藏 openai/three'); await click(dialog(), '保存'); await click(dialog(), '关闭')
    await app.switchHost('spare'); await settle()
    finishSave(); await settle()
    assert.ok(text(results()).includes('Host · 笔记本') && text(results()).includes('已保存'))
    assert.equal(text(results()).includes('没有保存成功'), false)
    await click(results(), '知道了')
    await app.switchHost('host'); await settle(); app.selectWork('work'); app.applyWorkSnapshot({ ...app.selectedWork, hostId: 'laptop' }); await settle()

    // Existing user-facing cases stay on the same real entry, not a second hand-wired page.
    modelVisibilityNative = async () => { throw { code: 'capability_missing', details: { missing: ['model.visibility.v1'] } } }
    await openSettings()
    assert.ok(text(dialog()).includes('请更新对应机器上的 Dock'))
    await click(dialog(), '关闭')
    const brokenFile = { models, total: 3, truncated: false, hidden: [], fileProblem: '文件不是有效的 JSON' }
    modelVisibilityNative = async () => brokenFile
    let finishRepair, finishOldRead
    saveModelVisibilityNative = args => new Promise(resolve => { finishRepair = () => resolve({ hidden: args.hidden }) })
    await openSettings(); await click(dialog(), '保存')
    assert.deepEqual(calls.filter(call => call.command === 'set_model_visibility').at(-1).args.hidden, [])
    await click(dialog(), '关闭')
    modelVisibilityNative = () => new Promise(resolve => { finishOldRead = () => resolve(brokenFile) })
    await openSettings()
    finishRepair(); await settle(); finishOldRead(); await settle()
    assert.equal(text(dialog()).includes('文件不是有效的 JSON'), false, 'an older read cannot undo the confirmed repair')
    await click(dialog(), '关闭')
    assertSameReference(results(), undefined, 'the repaired settings result was already shown in the editor')
    machinesFixture = []; app.applyWorkSnapshot(originalWork); failCatalog = previousCatalogFailure
    Object.assign(context, originalContext)
    app.catalog = { ...app.catalog, selectionGeneration: originalContext.selectionGeneration }
    await settle()
    console.log('PASS: Host settings real App wiring / pending close, Esc and Back / scoped late results / failed draft recovery')
  }
  // Normal command/model dialogs cover an Extension answer; they must not
  // destroy it, and dismissal gives that answer priority over the old trigger.
  allowExtension = true
  app.selectWork('other'); await settle(); app.selectWork('work'); await settle()
  const focusWork = { ...currentWork, activeInteraction: { id: 'focus-question', method: 'input' } }
  observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: focusWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: 1000 }, records: [], activeEvents: [], queue: [], extensionUi: { status: {}, toolsExpanded: false, events: [], activeInteraction: focusWork.activeInteraction } }, contentToken: 'focus-test', state: 'connected' })
  observation({ kind: 'content', token: 'focus-test', change: { kind: 'checkpoint_end' } })
  await settle()
  assert.ok(extensionBinding)
  emit('aludock://extension-controller-event', { ...extensionBinding, event: { eventType: 'interaction.requested', data: { interactionId: 'focus-question', method: 'input', issuedAt: '2026-09-19', title: 'Keep this answer' } } })
  await settle()
  const answer = find(teleport, item => item.type === 'input')
  assert.ok(answer)
  answer.props['onUpdate:modelValue']('unfinished extension answer'); await settle(); answer.focus()
  // #315: Escape that only dismisses input-method candidates keeps the question and its answer.
  const answersBeforeComposingEscape = calls.filter(call => call.command === 'respond_extension_interaction').length
  find(teleport, item => item.type === 'section' && item.props.role === 'dialog').props.onKeydown({ key: 'Escape', isComposing: true, preventDefault() {}, stopPropagation() {} }); await settle()
  assert.equal(calls.filter(call => call.command === 'respond_extension_interaction').length, answersBeforeComposingEscape, 'composing Escape does not cancel the question')
  assertSameReference(find(teleport, item => item.type === 'input'), answer)
  assert.equal(answer.value, 'unfinished extension answer')
  const commandsButton = find(container, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心'))
  commandsButton.props.onClick(); await settle()
  assertSameReference(find(teleport, item => item.type === 'input'), answer)
  assert.equal(answer.value, 'unfinished extension answer')
  const commandDialog = find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心')
  assert.ok(commandDialog)
  const escape = () => ({ key: 'Escape', isComposing: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} })
  compact.props.onCompositionstart({ type: 'compositionstart', currentTarget: compact })
  const composingEscape = escape()
  for (const handler of windowEvents.get('keydown') ?? []) handler(composingEscape)
  await settle()
  assert.ok(find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心'), 'page capture Escape respects the active IME composition')
  const commandOverlay = commandDialog.parent
  commandOverlay.props.onKeydown(escape()); await settle()
  assert.ok(find(container, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心'), 'modal ancestor Escape also respects composition')
  compact.props.onCompositionend({ type: 'compositionend', currentTarget: compact })
  find(commandDialog, item => item.type === 'button' && item.props['aria-label'] === '关闭').props.onClick(); await settle()
  assertSameReference(find(teleport, item => item.type === 'input'), answer)
  assert.equal(answer.value, 'unfinished extension answer')
  assertSameReference(toRaw(document.activeElement), answer, 'Extension answer wins focus after a normal modal closes')
  // Work-state events must not apply an unrelated snapshot to the Extension's
  // local answer or reset the conversation's tool-expansion choices.
  observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: 1001, occurredAt: '2026-09-20', eventType: 'session.metrics_changed', data: { metrics: { cost: 1 } } } })
  await settle()
  assertSameReference(find(teleport, item => item.type === 'input'), answer)
  assert.equal(answer.value, 'unfinished extension answer')
  observation({ kind: 'status', state: 'identity_error' }); await settle()
  const connectionStatus = find(container, item => item.type === 'details' && item.props['aria-label'] === '连接状态')
  connectionStatus.open = true
  await find(connectionStatus, item => item.type === 'button' && text(item) === '连接与配对').props.onClick(); await settle()
  const hostDialog = find(container, item => item.props.role === 'dialog' && item.props['aria-labelledby'] === 'host-settings-title')
  // #328: settings names the saved address the connection is using; kinds come from the addresses.
  assert.ok(text(hostDialog).includes('正在使用「外网域名」'), 'the header names the address in use')
  assert.ok(text(hostDialog).includes('广域网 · 正在使用') && text(hostDialog).includes('局域网 · 身份已验证'), 'only the address in use is marked')
  // The Host list names each Host and how many addresses it has. The address in use is only in the
  // details, so the current Host is never shown beside its LAN address while the details say 外网域名.
  const hostRow = name => all(hostDialog, item => item.type === 'article' && String(item.props.class ?? '').split(' ').includes('host-choice')).find(row => text(row).startsWith(name))
  assert.equal(text(hostRow('Host')), 'Host2 个地址当前', 'the current Host lists how many addresses it has')
  assert.ok(text(hostRow('Spare')).includes('没有可用的地址'), 'a Host without a verified address says so')
  const removeHost = find(hostDialog, item => item.props['aria-label'] === '从此设备删除 Host')
  removeHost.focus()
  const removal = removeHost.props.onClick(); await settle()
  const confirmation = find(container, item => item.props.role === 'dialog' && String(item.props['aria-label']).startsWith('从此设备删除'))
  assert.ok(confirmation)
  find(confirmation, item => item.type === 'button' && text(item) === '取消').props.onClick(); await removal; await settle()
  assertSameReference(toRaw(document.activeElement), removeHost, 'cancelling the covering confirmation restores the underlying surface trigger')
  assert.ok(find(container, item => item.props.role === 'dialog' && item.props['aria-labelledby'] === 'host-settings-title'))
  // #315: Android Back closes one layer at a time: the confirmation, then the panel under it.
  const historyWithSettings = historyDepth
  const backRemoval = removeHost.props.onClick(); await settle()
  assert.equal(historyDepth, historyWithSettings + 1, 'the confirmation over Host settings has its own Back entry')
  systemBack(); await backRemoval; await settle()
  assertSameReference(find(container, item => item.props.role === 'dialog' && String(item.props['aria-label']).startsWith('从此设备删除')), undefined, 'first Back closes the confirmation')
  assert.ok(find(container, item => item.props.role === 'dialog' && item.props['aria-labelledby'] === 'host-settings-title'), 'Host settings stays open after the first Back')
  assert.equal(historyDepth, historyWithSettings, 'Host settings still owns a Back entry')
  // #316: removing another saved Host leaves the current Work, its question and its answer in place.
  const bootstrapsBeforeRemoval = calls.filter(call => call.command === 'bootstrap').length
  const releasesBeforeRemoval = calls.filter(call => call.command === 'release_extension_control').length
  const removeSpare = async () => {
    const removing = find(hostDialog, item => item.props['aria-label'] === '从此设备删除 Spare').props.onClick(); await settle()
    find(container, item => item.type === 'button' && text(item) === '确认').props.onClick(); await removing; await settle()
  }
  failHostRemoval = true
  await removeSpare()
  assert.ok(text(hostDialog).includes('“Spare”没有删除。'), 'a failed removal is reported next to the Host list')
  assert.ok(find(hostDialog, item => item.props['aria-label'] === '从此设备删除 Spare'), 'the Host stays listed after a failed removal')
  failHostRemoval = false
  await removeSpare()
  assertSameReference(find(hostDialog, item => item.props['aria-label'] === '从此设备删除 Spare'), undefined, 'the removed Host leaves the list')
  assert.equal(text(hostDialog).includes('没有删除'), false)
  assert.equal(app.selectedWorkId, 'work', 'the current Work stays selected')
  assertSameReference(find(teleport, item => item.type === 'input'), answer, 'the open question stays on screen')
  assert.equal(answer.value, 'unfinished extension answer')
  assert.equal(calls.filter(call => call.command === 'release_extension_control').length, releasesBeforeRemoval, 'the question is not released')
  assert.equal(calls.filter(call => call.command === 'bootstrap').length, bootstrapsBeforeRemoval, 'the current Host is not reloaded')
  // #321: the actual connection form starts one live authorization. Native
  // start/cancel acknowledgements may lag, but old events never own a new form.
  find(hostDialog, item => item.type === 'button' && text(item) === '连接 Host').props.onClick(); await settle()
  const pairingForm = find(hostDialog, item => item.type === 'form' && String(item.props.class).includes('host-pairing-card'))
  const pairingInputs = all(pairingForm, item => item.type === 'input')
  pairingInputs[0].props['onUpdate:modelValue']('127.0.0.1')
  pairingInputs[1].props['onUpdate:modelValue'](4444)
  pairingInputs[2].props['onUpdate:modelValue']('This device')
  let releaseStart, releaseCancel, attemptA, attemptB
  startPairingNative = args => {
    attemptA = args.requestId
    emit('aludock://pairing-status', { requestId: attemptA, stage: 'waiting_for_host', pin: '1111', message: '请在电脑上输入配对码' })
    return new Promise(resolve => { releaseStart = resolve })
  }
  cancelPairingNative = args => {
    emit('aludock://pairing-status', { requestId: args.requestId, stage: 'cancelled', message: '配对已取消；需要连接时请重新开始。' })
    return new Promise(resolve => { releaseCancel = resolve })
  }
  const starting = pairingForm.props.onSubmit({ preventDefault() {} }); await settle()
  assert.ok(text(pairingForm).includes('1111'), 'progress can precede the start acknowledgement')
  const cancelling = find(pairingForm, item => item.type === 'button' && text(item) === '停止等待').props.onClick(); await settle()
  assert.ok(text(pairingForm).includes('正在取消配对'))
  releaseStart(); await starting; await settle()
  assert.ok(text(pairingForm).includes('配对已取消'))
  assert.equal(text(hostDialog).includes('可恢复配对'), false)
  assert.equal(all(hostDialog, item => item.type === 'button' && ['恢复', '丢弃'].includes(text(item))).length, 0)
  startPairingNative = args => {
    attemptB = args.requestId
    emit('aludock://pairing-status', { requestId: attemptB, stage: 'waiting_for_host', pin: '2222', message: '新的配对码' })
  }
  await pairingForm.props.onSubmit({ preventDefault() {} }); await settle()
  assert.notEqual(attemptB, attemptA)
  emit('aludock://pairing-status', { requestId: attemptA, stage: 'failed', error: { message: 'OLD FAILURE' } })
  releaseCancel(true); await cancelling; await settle()
  assert.ok(text(pairingForm).includes('2222'))
  assert.equal(text(pairingForm).includes('OLD FAILURE'), false)
  emit('aludock://pairing-status', { requestId: attemptB, stage: 'failed', error: { message: '配对未完成，请重新开始。' } }); await settle()
  assert.ok(text(pairingForm).includes('配对未完成'))
  const previous = attemptB
  await pairingForm.props.onSubmit({ preventDefault() {} }); await settle()
  assert.notEqual(attemptB, previous, 'retry is a fresh explicit attempt')
  cancelPairingNative = args => {
    emit('aludock://pairing-status', { requestId: args.requestId, stage: 'cancelled', message: '配对已取消。' })
    return true
  }
  await find(pairingForm, item => item.props['aria-label'] === '收起配对表单').props.onClick(); await settle()
  assertSameReference(find(hostDialog, item => item.type === 'form' && String(item.props.class).includes('host-pairing-card')), undefined)
  assert.equal(app.activeConnectionId, 'host', 'cancel/retry does not replace the saved selection')
  console.log('PASS: actual Host form start/cancel/fresh retry/exit; no recovery UI; late progress and cancel cannot alter the next attempt')
  find(hostDialog, item => item.type === 'button' && item.props['aria-label'] === '关闭').props.onClick(); await settle()
  assert.equal(historyDepth, historyWithSettings - 1, 'closing the panel by hand consumes exactly its own Back entry')
  assertSameReference(toRaw(document.activeElement), answer)
  assert.equal(answer.value, 'unfinished extension answer')
  // #306: static commands render before a refreshed catalog; resource/tool reads are independent.
  observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 2, sequence: 1002, occurredAt: 'now', eventType: 'resources.reloaded', data: {} } }); await settle()
  let resolveCatalog, rejectTools
  catalogNative = () => new Promise(resolve => { resolveCatalog = resolve })
  toolsNative = () => new Promise((_resolve, reject) => { rejectTools = reject })
  commandsButton.props.onClick(); await settle()
  assert.ok(find(container, item => item.type === 'button' && text(item).includes('Stop Work')), 'Stop is visible while commands are being read')
  resolveCatalog({ commands: [{ name: 'available', referenceId: 'available-command', source: { kind: 'skill' }, contentAvailable: false }], total: 1, truncated: false }); await settle()
  assert.ok(text(container).includes('/available'), 'ready commands do not wait for other panels')
  find(container, item => item.type === 'button' && text(item).includes('Project Status')).props.onClick(); await settle()
  assert.ok(text(container).includes('Available skill'), 'loaded resources appear while tools are still being read')
  assert.equal(text(container).includes('当前没有启用工具'), false, 'unread tools are not an empty list')
  rejectTools({ code: 'connection_failed', message: '工具暂时没有读到，请重试。' }); await settle()
  assert.ok(text(container).includes('Available skill'))
  assert.ok(find(container, item => item.type === 'button' && text(item) === '重试读取工具'))
  toolsNative = () => ({ instance: atHost(focusWork), tools: [], total: 0, truncated: false })
  catalogNative = undefined
  await find(container, item => item.type === 'button' && text(item) === '重试读取工具').props.onClick(); await settle()
  assert.ok(text(container).includes('当前没有启用工具'))
  toolsNative = undefined
  find(container, item => item.type === 'button' && item.props['aria-label'] === '关闭').props.onClick(); await settle()
  // #306: an old answer receipt must leave the next question's answer usable.
  for (const outcome of ['success', 'failure', 'unknown']) {
    const ask = id => emit('aludock://extension-controller-event', { ...extensionBinding, event: { eventType: 'interaction.requested', data: { interactionId: id, method: 'input', issuedAt: 'now', title: id } } })
    ask(`old-${outcome}`); await settle()
    let resolveReply, rejectReply
    respondNative = () => new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
    find(teleport, item => item.type === 'input').props['onUpdate:modelValue']('old answer')
    const replying = find(teleport, item => item.type === 'button' && text(item) === '提交').props.onClick()
    await settle(); ask(`new-${outcome}`); await settle()
    const nextAnswer = find(teleport, item => item.type === 'input')
    nextAnswer.props['onUpdate:modelValue']('new answer'); await settle()
    if (outcome === 'success') resolveReply({ interactionId: `old-${outcome}`, state: 'resolved' })
    else rejectReply({ code: 'connection_failed', outcomeUnknown: outcome === 'unknown' })
    await replying; await settle()
    assert.equal(nextAnswer.value, 'new answer')
    const nextSubmit = find(teleport, item => item.type === 'button' && text(item) === '提交')
    assert.equal(nextSubmit.props.disabled, false, `${outcome}: the next question remains usable`)
    let submittedAnswer
    respondNative = async args => { submittedAnswer = args; return { interactionId: args.interactionId, state: 'resolved' } }
    await nextSubmit.props.onClick(); await settle()
    assert.equal(submittedAnswer?.interactionId, `new-${outcome}`)
    assert.equal(submittedAnswer.value, 'new answer')
    assert.equal(calls.filter(call => call.command === 'respond_extension_interaction' && call.args.interactionId === `new-${outcome}`).length, 1)
    assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined, 'successful answering closes the interaction, not just the submit promise')
  }
  // #306 pre-merge review: background detach/reacquire keeps the same question, not the old connection object.
  for (const outcome of ['success', 'failure', 'unknown']) {
    const id = `resumed-${outcome}`
    const question = { interactionId: id, method: 'input', issuedAt: 'now', title: id }
    const ask = () => emit('aludock://extension-controller-event', { ...extensionBinding, event: { eventType: 'interaction.requested', data: question } })
    ask(); await settle()
    const replyInput = find(teleport, item => item.type === 'input')
    replyInput.props['onUpdate:modelValue']('answer survives background'); await settle()
    let resolveReply, rejectReply
    respondNative = () => new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
    const replying = find(teleport, item => item.type === 'button' && text(item) === '提交').props.onClick(); await settle()
    const oldHandle = extensionBinding.handle
    globalThis.__appBoundary.focusChanged({ payload: false }); await settle()
    assert.ok(calls.some(call => call.command === 'release_extension_control' && call.args.handle === oldHandle))
    globalThis.__appBoundary.focusChanged({ payload: true }); await settle()
    const resumedWork = { ...currentWork, activeInteraction: { id, method: 'input' } }
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: resumedWork, cursor: { ...cursor, runtimeGeneration: 2, sequence: 1020 }, records: [], activeEvents: [], queue: [], extensionUi: { status: {}, toolsExpanded: false, events: [], activeInteraction: resumedWork.activeInteraction } }, contentToken: 'resumed-interaction', state: 'connected' })
    await settle(); ask(); await settle()
    assert.notEqual(extensionBinding.handle, oldHandle)
    assert.equal(replyInput.value, 'answer survives background')
    assert.equal(replyInput.props.disabled, true, 'reacquiring alone does not permit resending a pending answer')
    if (outcome === 'success') resolveReply({ interactionId: id, state: 'resolved' })
    else rejectReply({ code: outcome === 'failure' ? 'interaction_wrong_lease' : 'connection_failed', outcomeUnknown: outcome === 'unknown' })
    await replying; await settle()
    assert.equal(calls.filter(call => call.command === 'respond_extension_interaction' && call.args.interactionId === id).length, 1, 'recovery does not replay the answer')
    if (outcome === 'success') {
      assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined, 'the same question closes when its original answer succeeded')
      continue
    }
    if (outcome === 'unknown') {
      // A lost reply reads like any failure: one plain sentence, and the still-open question can be answered again.
      assert.ok(text(teleport).includes('连接中断，没收到结果'), text(teleport))
      assertSameReference(find(teleport, item => item.type === 'button' && /刷新.*确认/.test(text(item))), undefined)
      // Review of 63b1b31: the connection then drops and the Host sends the same question again.
      emit('aludock://extension-controller-status', { ...extensionBinding, state: 'disconnected' })
      await settle()
      assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined)
      ask(); await settle()
      assert.equal(find(teleport, item => item.type === 'input')?.value, 'answer survives background', 'the typed answer stays with its question')
    }
    const submitAgain = find(teleport, item => item.type === 'button' && text(item) === '提交')
    assert.ok(submitAgain && !submitAgain.props.disabled, 'the same question can be answered after its old reply failed')
    let submittedAnswer
    respondNative = async args => { submittedAnswer = args; return { interactionId: args.interactionId, state: 'resolved' } }
    await submitAgain.props.onClick(); await settle()
    assert.equal(submittedAnswer?.interactionId, id)
    assert.equal(submittedAnswer.value, 'answer survives background')
    assert.equal(submittedAnswer.handle, extensionBinding.handle)
    assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined)
  }
  console.log('PASS: Model preserves command completion; same-question foreground recovery handles failure/lost reply without replay; successful answers close their dialogs')
  console.log('PASS: ready command/resource sections and independent Extension answers; late success/failure/unknown stays with the original question')
  console.log('PASS: normal command modal / same Extension answer node and value / both Escape layers honor composition / Extension focus priority')
  console.log('PASS: real input Queue and send entrypoints / event-before-receipt and receipt-before-event / later Queue IDs / display events / double-claim / late edited send')
  console.log('PASS: retained failures require scoped visible acknowledgement; footer intervention details are opt-in; actual App/ConversationView/store→native boundary keeps compact and expanded editors through offline refresh; new retires old before read; late receipt/read isolation')
  // 2026-10-13: a web console tab held the operator connection, so this client never showed a
  // kanban plugin's confirmation. With shared questions the question comes with the Work's updates.
  {
    const acquires = () => calls.filter(call => call.command === 'acquire_extension_control').length
    const heldHandle = extensionBinding.handle
    const acquiredBefore = acquires()
    const sharedWork = { ...currentWork, runtimeGeneration: 3, activeInteraction: { id: 'shared-question', method: 'confirm' } }
    const question = { interactionId: 'shared-question', method: 'confirm', title: '删除检查项？', message: '这一项会从卡片上移除。', issuedAt: '2026-10-13T00:00:00.000Z' }
    const at = (sequence, eventType, data) => ({ instanceId: 'work', runtimeGeneration: 3, sequence, occurredAt: 'now', eventType, data })
    observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: sharedWork, cursor: { ...cursor, runtimeGeneration: 3, sequence: 2000 }, records: [], activeEvents: [], queue: [],
      extensionUi: { status: {}, toolsExpanded: false, activeInteraction: sharedWork.activeInteraction, sharedQuestions: true, events: [{ ...at(1999, 'interaction.requested', question) }] } }, contentToken: 'shared-questions', state: 'connected' })
    observation({ kind: 'content', token: 'shared-questions', change: { kind: 'checkpoint_end' } })
    await settle()
    assert.ok(text(teleport).includes('这一项会从卡片上移除。'), 'the question already open when the Work was read is shown')
    assert.equal(acquires(), acquiredBefore, 'this window does not take the question over from other windows')
    assert.ok(calls.some(call => call.command === 'release_extension_control' && call.args.handle === heldHandle), 'an operator connection held from before is let go')
    let answered
    sharedRespondNative = async args => { answered = args; return { interactionId: args.interactionId, state: 'resolved' } }
    await find(teleport, item => item.type === 'button' && text(item) === '确认').props.onClick(); await settle()
    assert.deepEqual([answered?.instanceId, answered?.interactionId, answered?.confirmed, Object.hasOwn(answered ?? {}, 'handle')], ['work', 'shared-question', true, false])
    assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined, 'answering closes the question')
    // The next question is answered in another window first: the Host's broadcast closes it here.
    observation({ kind: 'event', event: at(2001, 'interaction.resolved', { interactionId: 'shared-question', method: 'confirm' }) })
    observation({ kind: 'event', event: at(2002, 'interaction.requested', { ...question, interactionId: 'answered-elsewhere', title: '另一台设备上的问题' }) })
    await settle()
    assert.ok(text(teleport).includes('另一台设备上的问题'), 'a new question arrives with the live updates')
    observation({ kind: 'event', event: at(2003, 'interaction.resolved', { interactionId: 'answered-elsewhere', method: 'confirm' }) })
    await settle()
    assertSameReference(find(teleport, item => item.props.role === 'dialog'), undefined, 'a question answered elsewhere closes here')
    assert.equal(calls.some(call => call.command === 'respond_shared_interaction' && call.args.interactionId === 'answered-elsewhere'), false)
    // The extension's title and editor text in one update both apply; neither is applied again
    // when cached updates are shown after F5.
    observation({ kind: 'event', events: [at(2004, 'extension.title_set', { title: '扩展设置的标题' }), at(2005, 'extension.editor_text_set', { text: '扩展填入的草稿' })] }); await settle()
    assert.equal(app.currentDraft, '扩展填入的草稿')
    assert.equal(document.title, '扩展设置的标题', 'a title arriving with editor text is not lost')
    compact.props['onUpdate:modelValue']('之后自己改过的草稿'); await settle()
    observation({ kind: 'event', replayToken: 'shared-questions', event: at(2006, 'extension.editor_text_set', { text: '旧的扩展草稿' }) }); await settle()
    assert.equal(app.currentDraft, '之后自己改过的草稿', 'a replayed editor text does not overwrite what the person typed')
    assert.equal(acquires(), acquiredBefore)
    console.log('PASS: shared questions open from the Work read and live updates, answer without taking the operator connection, close when answered elsewhere; replayed editor text keeps the draft')
  }
  // Mount the input region without App/Layout or a conversation view. It reads
  // the real stores and typed native interface, which are enough to edit and submit.
  mounted.unmount(); await settle(); allowExtension = false
  // 2026-09-30 review: switching Hosts must not inherit an old refresh's disabled controls,
  // and a delayed list read must not bring back a Host whose deletion already succeeded.
  {
    const previousCatalog = { context: { ...context }, savedHosts, revision: hostCatalogRevision, failCatalog }
    const previousHistory = { depth: historyDepth, url: window.location.href }
    historyDepth = 0; window.location.href = 'http://fixture/aludock'
    savedHosts = ['host', 'spare']; hostCatalogRevision = 1; failCatalog = false
    Object.assign(context, { connectionId: 'host', selectionGeneration: 1 })
    const switchPinia = createPinia(), switchApp = useAppStore(switchPinia), switchView = element('switch-host-app')
    mounted = renderer.createApp({ render: () => h(App) }).use(switchPinia)
    mounted.mount(switchView); await settle(); switchApp.selectWork('work'); await settle()
    const refreshButton = () => refreshControl(switchView)
    const openHosts = async () => {
      observation({ kind: 'status', state: 'identity_error' }); await settle()
      const details = find(switchView, item => item.type === 'details' && item.props['aria-label'] === '连接状态')
      find(details, item => item.type === 'button' && text(item) === '连接与配对').props.onClick(); await settle()
    }
    try {
      let finishA, finishB
      bootstrapNative = cut => { bootstrapNative = undefined; return new Promise(resolve => { finishA = () => resolve(cut) }) }
      const refreshA = refreshButton().props.onClick(); await settle()
      await openHosts()
      // 2026-09-30 Chrome: the new Work drawer appeared before the old settings
      // panel's history.go completed; selecting its Work then left for about:blank.
      holdHistoryTraversal = true
      await find(switchView, item => item.type === 'button' && item.props.class === 'host-choice-main' && text(item).includes('Spare')).props.onClick(); await settle()
      finishHistoryTraversal(); await settle()
      find(switchView, item => item.type === 'button' && item.props.class === 'alu-instance-link').props.onClick(); await settle()
      assert.equal(window.location.href, 'http://fixture/aludock', 'selecting the new Host Work stays in the App after the old panel closes')
      assert.equal(switchApp.selectedWorkId, 'work')
      assert.equal(switchApp.activeConnectionId, 'spare')
      assert.equal(refreshButton().props.disabled, false, "Host B's refresh is available while Host A is still waiting")
      bootstrapNative = cut => { bootstrapNative = undefined; return new Promise(resolve => { finishB = () => resolve(cut) }) }
      const refreshB = refreshButton().props.onClick(); await settle()
      assert.equal(typeof finishB, 'function', "Host B's refresh reaches its own request")
      assert.equal(refreshButton().props.disabled, true, 'the current refresh prevents duplicate clicks')
      finishA(); await refreshA; await settle()
      assert.equal(refreshButton().props.disabled, true, "Host A finishing does not clear Host B's pending feedback")
      finishB(); await refreshB; await settle()
      assert.equal(refreshButton().props.disabled, false, "Host B's own completion clears its pending feedback")

      let finishCatalogRead
      hostCatalogNative = cut => { hostCatalogNative = undefined; return new Promise(resolve => { finishCatalogRead = () => resolve(cut) }) }
      const lateRefresh = refreshButton().props.onClick(); await settle()
      await openHosts()
      const deleting = find(switchView, item => item.props['aria-label'] === '从此设备删除 Host').props.onClick(); await settle()
      find(switchView, item => item.type === 'button' && text(item) === '确认').props.onClick(); await deleting; await settle()
      const deletedHostButton = () => find(switchView, item => item.props['aria-label'] === '从此设备删除 Host')
      assertSameReference(deletedHostButton(), undefined, 'the deleted Host leaves the settings list')
      const editor = find(switchView, item => item.type === 'textarea')
      editor.props['onUpdate:modelValue']('keep editing on Host B')
      finishCatalogRead(); await lateRefresh; await settle()
      assertSameReference(deletedHostButton(), undefined, 'the late old list does not bring the deleted Host back')
      assert.equal(switchApp.activeConnectionId, 'spare')
      assert.equal(switchApp.selectedWorkId, 'work')
      assert.equal(switchApp.currentDraft, 'keep editing on Host B')
      assertSameReference(find(switchView, item => item.type === 'textarea'), editor, 'accepting the current list preserves the editor')
    } finally {
      mounted.unmount(); await settle()
      holdHistoryTraversal = false; heldHistoryMoves.length = 0
      historyDepth = previousHistory.depth; window.location.href = previousHistory.url
      Object.assign(context, previousCatalog.context); savedHosts = previousCatalog.savedHosts
      hostCatalogRevision = previousCatalog.revision; failCatalog = previousCatalog.failCatalog
      bootstrapNative = undefined; hostCatalogNative = undefined
    }
  }
  console.log('PASS: new Host refresh stays available / each refresh owns its feedback / delayed list cannot undo deletion or editing')
  const standalonePinia = createPinia()
  const standaloneStore = useAppStore(standalonePinia)
  const standaloneContainer = element('standalone-input')
  mounted = renderer.createApp({ render: () => h(compiled.InputRegion) }).use(standalonePinia)
  mounted.mount(standaloneContainer)
  const standaloneObservation = compiled.useObservationStore(standalonePinia), standaloneOperations = compiled.useOperationsStore(standalonePinia)
  await standaloneObservation.listenFocus(); await standaloneObservation.listenNative(); await standaloneOperations.listenNative()
  failCatalog = false
  await standaloneStore.load(); await standaloneOperations.initialize(); await settle()
  contentSnapshot(); await settle()
  const standaloneEditor = find(standaloneContainer, item => item.type === 'textarea')
  assert.ok(standaloneEditor)
  standaloneEditor.props['onUpdate:modelValue']('independently mounted input')
  let standaloneCapture
  submitNative = args => {
    standaloneCapture = args
    const result = { instance: atHost(work), receipt: { queued: false, delivery: 'prompt' } }
    emit('aludock://operation', { operationId: args.operationId, kind: 'submit_message', connectionId: args.connectionId, instanceId: args.instanceId,
      hostEpoch: args.expectedHostEpoch, runtimeGeneration: args.expectedRuntimeGeneration, sessionId: 'old', editor: args.operationEditor, state: 'succeeded', result })
    return result
  }
  standaloneEditor.props.onKeydown({ key: 'Enter', currentTarget: standaloneEditor, preventDefault() {} })
  await settle()
  assert.equal(standaloneCapture.message, 'independently mounted input')
  assert.equal(standaloneCapture.operationEditor.text, standaloneCapture.message)
  assert.equal(standaloneStore.currentDraft, '')
  assertSameReference(find(standaloneContainer, item => item.type === 'textarea'), standaloneEditor)
  console.log('PASS: independently mounted input / real editor owner and native API / Enter sends / operation claims the frozen draft')

  // #301/#302 upload retention: real App/Pinia/controls, native IPC fixture only.
  mounted.unmount(); await settle()
  storage.clear(); nativeResults.clear(); consumeFailures.clear()
  let uploadApp, uploadContainer
  async function rebuildUploadView() {
    mounted?.unmount(); await settle()
    const pinia = createPinia()
    uploadApp = useAppStore(pinia); uploadContainer = element('upload-app')
    mounted = renderer.createApp({ render: () => h(App) }).use(pinia)
    mounted.mount(uploadContainer); await settle()
    uploadApp.selectWork('work'); await settle(); contentSnapshot(); await settle()
  }
  const job = token => ({ token, name: `${token}.txt`, sizeBytes: 3, mediaType: 'text/plain', connectionId: 'host', workId: 'work',
    revision: 1, state: 'selected', target: { machineHostId: 'host', ownerHostEpoch: 'epoch', runtimeGeneration: 1 } })
  const uploaded = token => ({ attachment: { fileId: `file-${token}`, name: `${token}.txt`, sizeBytes: 3, mediaType: 'text/plain', sha256: 'a'.repeat(64), storedAt: 'now' }, status: 'stored' })
  const publishJob = async (token, update) => {
    Object.assign(nativeJobs.get(token), update)
    emit('aludock://attachment-progress', structuredClone(nativeJobs.get(token))); await settle()
  }
  const uploadEditor = () => find(uploadContainer, item => item.type === 'textarea')
  const uploadButton = label => find(uploadContainer, item => item.type === 'button' && text(item) === label)
  const chooseJob = async token => {
    nativeJobs.set(token, job(token)); pickedJobs = [nativeJobs.get(token)]
    await find(uploadContainer, item => item.type === 'button' && item.props.title === '添加附件').props.onClick(); await settle()
  }
  await rebuildUploadView()
  // Switching Work: show a complete cached view once, while asking for a fresh
  // Host read. Keep this at the actual App/store/IPC entrance, not a second reader.
  uploadApp.selectWork('other'); await settle()
  assert.equal(calls.findLast(call => call.command === 'start_conversation_follow').args.refresh, true)
  const otherBootstrap = { ...bootstrap, instance: otherWork, cursor: { ...cursor, instanceId: 'other' }, records: [] }
  observation({ kind: 'snapshot', bootstrap: otherBootstrap, contentToken: 'native-content', canLoadEarlier: true, state: 'connected' })
  const cacheRow = (id, value) => ({ ...bootstrap.records[0], recordId: id, entryId: id, content: [{ type: 'text', text: value }] })
  beforeBatchFrame = frames; immediateAck = true
  emit('aludock://observation', { ...binding, revision: ++revision, deliveryId: 701, update: { kind: 'batch', updates: [
    { revision, update: { kind: 'content', token: 'native-content', change: { kind: 'record_chunk', entryId: 'cached-process', first: true, complete: true, text: JSON.stringify(cacheRow('cached-process', 'CACHED PROCESS')) } } },
  ] } }); await settle()
  assert.equal(text(uploadContainer).includes('CACHED PROCESS'), false, 'do not paint intermediate cached history while opening another Work')
  immediateAck = false
  recordChunk(cacheRow('cached-result', 'CACHED RESULT')); contentChange({ kind: 'checkpoint_end' }); await settle()
  assert.ok(text(uploadContainer).includes('CACHED RESULT'), 'the cached view appears without waiting for Host refresh')
  const editorDuringRefresh = uploadEditor()
  editorDuringRefresh.props['onUpdate:modelValue']('keep this draft')
  const fresh = { ...otherBootstrap, cursor: { ...otherBootstrap.cursor, sequence: 20 } }
  observation({ kind: 'facts', bootstrap: fresh })
  contentChange({ kind: 'checkpoint_begin', bootstrap: fresh })
  recordChunk(cacheRow('host-result', 'LATEST HOST RESULT')); await settle()
  assert.ok(text(uploadContainer).includes('CACHED RESULT'), 'existing content remains readable during the asynchronous refresh')
  assert.equal(text(uploadContainer).includes('LATEST HOST RESULT'), false)
  contentChange({ kind: 'checkpoint_end' }); await settle()
  assert.ok(text(uploadContainer).includes('LATEST HOST RESULT'))
  assertSameReference(uploadEditor(), editorDuringRefresh)
  assert.equal(uploadApp.currentDraft, 'keep this draft')
  uploadApp.selectWork('work'); await settle(); contentSnapshot(); await settle()
  console.log('PASS: Work switch displays cached content once / requests latest asynchronously / applies refresh once / editor preserved')
  // #301/#302: native preview handles use the existing actual attachment card,
  // magnification/save controls and projection. Vue must not override a standard
  // image's native decision merely because an editor fileId preview exists.
  const photo = { ...job('photo'), name: 'photo.png', mediaType: 'image/png', sizeBytes: 68 }
  nativeJobs.set('photo', photo); pickedJobs = [photo]
  await find(uploadContainer, item => item.type === 'button' && item.props.title === '添加附件').props.onClick(); await settle()
  const importedUrl = 'http://aludock-media.localhost/imported-local-handle'
  assert.ok(find(uploadContainer, item => item.type === 'img' && item.props.src === importedUrl), 'attachment preview displays the native handle, not a Blob')
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('image save must not fetch pixels into JS') }
  try {
    find(uploadContainer, item => item.type === 'button' && item.props['aria-label'] === '预览图片附件 photo.png').props.onClick(); await settle()
    for (const outcome of ['cancelled', 'saved']) {
      saveResult = outcome
      await find(uploadContainer, item => item.type === 'button' && text(item) === '保存图片').props.onClick(); await settle()
      assert.equal(text(uploadContainer).includes('图片已保存到所选位置。'), outcome === 'saved')
    }
    find(uploadContainer, item => item.props['aria-label'] === '关闭图片预览').props.onClick(); await settle()
  } finally { globalThis.fetch = previousFetch }
  await publishJob('photo', { state: 'succeeded', revision: 4, result: { status: 'stored', attachment: { ...uploaded('photo').attachment, name: 'photo.png', mediaType: 'image/png', sizeBytes: 68 } } })
  for (const [contentRef, mimeType, expectedHandle] of [['attached-original', 'image/png', 'imported-local-handle'], ['changed-mime', 'image/jpeg', 'different-image-handle']]) {
    const before = calls.length
    recordChunk({ recordId: contentRef, entryId: contentRef, kind: 'message', source: 'user', visibility: 'conversation', contentComplete: true,
      content: [{ type: 'image', mimeType, contentRef, fileId: 'file-photo' }] }); await settle()
    assert.ok(calls.slice(before).some(call => call.command === 'conversation_image' && call.args.fileId === 'file-photo' && call.args.contentRef === contentRef && call.args.mimeType === mimeType), 'an editor preview cannot bypass the native image request')
    assert.ok(find(uploadContainer, item => item.type === 'img' && item.props.src === 'http://aludock-media.localhost/' + expectedHandle))
  }
  await rebuildUploadView()
  assert.ok(find(uploadContainer, item => item.type === 'img' && item.props.src === importedUrl), 'view reconstruction restores preview via the retained native job/handle')
  await find(uploadContainer, item => item.type === 'button' && item.props['aria-label'] === '移除附件 photo.png').props.onClick(); await settle()
  nativeJobs.clear(); await rebuildUploadView()
  console.log('PASS: imported native attachment handle / actual preview-save controls / standard image.fileId reaches native despite editor preview / MIME reinterpretation is not overridden / preview rebind')
  // Attachment review P1/P2: actual picker/paste returns, then its A query or
  // admission waits while the editor leaves A. Unaccepted imports are discarded.
  const beginAttachmentSelection = mode => mode === 'pick'
    ? find(uploadContainer, item => item.type === 'button' && item.props.title === '添加附件').props.onClick()
    : uploadEditor().props.onPaste({ preventDefault() {}, clipboardData: { items: [{ kind: 'file', type: 'image/png',
      getAsFile: () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'paste.png', { type: 'image/png' }) }] } })
  for (const [mode, departure] of [['pick', 'B'], ['paste', 'B'], ['pick', 'A/B/A'], ['paste', 'session']]) {
    const token = `held-${mode}-${departure}`
    nativeJobs.set(token, mode === 'paste' ? { ...job(token), name: token + '.png', mediaType: 'image/png', sizeBytes: 8 } : job(token)); pickedJobs = [nativeJobs.get(token)]
    const uploadsBefore = calls.filter(call => call.command === 'upload_attachment').length
    const removalsBefore = calls.filter(call => call.command === 'remove_attachment').length
    deferJobSnapshot = true; releaseJobSnapshot = undefined
    const choosing = beginAttachmentSelection(mode); await settle()
    assert.equal(typeof releaseJobSnapshot, 'function')
    if (departure === 'session') uploadApp.selectedWork.executor.piSessionId = 'replacement-session'
    else {
      uploadApp.selectWork('other')
      // No render tick between these visits: epoch invalidation must be synchronous.
      if (departure === 'A/B/A') uploadApp.selectWork('work')
    }
    await settle()
    if (departure === 'B') {
      uploadEditor().props['onUpdate:modelValue']('B can send while A is choosing files'); await settle()
      assert.equal(find(uploadContainer, item => item.props.class === 'alu-send-btn').props.disabled, false)
    }
    const untouchedDraft = uploadApp.currentDraft
    releaseJobSnapshot(); await choosing; await settle()
    assert.equal(uploadApp.currentPendingAttachments.length, 0)
    assert.equal(uploadApp.currentDraft, untouchedDraft)
    const pending = JSON.parse(storage.get('aludock.uiState')).connections.host.pendingAttachments
    assert.equal(pending.other?.length ?? 0, 0, 'A source must not be persisted as a B selection')
    assert.equal(pending.work?.length ?? 0, 0, 'returning to A does not revive the old handoff')
    assert.equal(calls.filter(call => call.command === 'upload_attachment').length, uploadsBefore)
    assert.equal(calls.filter(call => call.command === 'remove_attachment').length, removalsBefore + 1)
    assert.equal(nativeJobs.has(token), false)
    assert.equal(text(uploadContainer).includes('该附件不属于当前工作'), false)
    uploadApp.selectWork('work'); await settle()
    assert.equal(text(uploadContainer).includes(token), false, 'leaving before selection acceptance does not create a second attachment tray')
    nativeJobs.clear(); await rebuildUploadView()
  }
  for (const roundTrip of [false, true]) {
    const token = `late-reject-${roundTrip}`
    nativeJobs.set(token, job(token)); pickedJobs = [nativeJobs.get(token)]
    let rejectAdmission
    uploadNative = args => { assert.equal(args.workId, 'work'); return new Promise((_resolve, reject) => { rejectAdmission = reject }) }
    await beginAttachmentSelection('pick'); await settle()
    assert.equal(typeof rejectAdmission, 'function')
    assert.equal(uploadApp.currentPendingAttachments[0].jobId, token)
    uploadApp.selectWork('other')
    if (roundTrip) uploadApp.selectWork('work')
    await settle()
    const before = JSON.stringify(uploadApp.currentPendingAttachments)
    const errorText = 'A 的附件接纳失败，请在 A 重新选择。'
    rejectAdmission({ code: 'resource_unavailable', message: errorText }); await settle()
    assert.equal(text(uploadContainer).includes(errorText), false, 'old admission feedback cannot enter B or a newly rebound A view')
    assert.equal(JSON.stringify(uploadApp.currentPendingAttachments), before)
    assert.equal(calls.some(call => call.command === 'upload_attachment' && call.args.token === token && call.args.workId === 'other'), false)
    assert.equal(nativeJobs.has(token), true)
    const pending = JSON.parse(storage.get('aludock.uiState')).connections.host.pendingAttachments
    assert.equal(pending.work[0].jobId, token)
    assert.equal(pending.other?.length ?? 0, 0)
    uploadApp.selectWork('work'); await settle()
    uploadApp.setPendingAttachments([]); nativeJobs.clear(); uploadNative = undefined
    await rebuildUploadView()
  }
  console.log('PASS: picker/paste held query and late upload rejection stay with original Work; A/B/A cannot revive handoff or feedback; unaccepted imports discarded')
  // #650: dropping files on the window, or pasting files copied in a file
  // manager, adds them like picked files. Native holds the paths; the page only
  // names the drop.
  {
    const dropHint = () => find(teleport, item => item.props.class === 'alu-file-drop')
    const uploadedTokens = () => calls.filter(call => call.command === 'upload_attachment').map(call => call.args.token)
    emit('aludock://file-drag', { state: 'over' }); await settle()
    assert.ok(text(dropHint() ?? element('none')).includes('松开添加附件'), 'dragging files over the window says they can be dropped')
    emit('aludock://file-drag', { state: 'left' }); await settle()
    assert.equal(dropHint(), undefined, 'the hint goes away when the drag leaves the window')
    const art = { ...job('art'), name: '角色立绘.gif', mediaType: 'image/gif' }, scene = { ...job('scene'), name: 'scene.psd', mediaType: 'image/vnd.adobe.photoshop' }
    nativeJobs.set('art', art); nativeJobs.set('scene', scene); droppedJobs = [art, scene]
    emit('aludock://file-drag', { state: 'over' }); await settle()
    emit('aludock://file-drag', { state: 'dropped', dropId: 7 }); await settle()
    assert.equal(dropHint(), undefined)
    const dropped = calls.findLast(call => call.command === 'stage_dropped_files')?.args
    assert.equal(dropped?.workId, 'work'); assert.equal(dropped?.dropId, 7)
    for (const name of ['角色立绘.gif', 'scene.psd']) assert.ok(text(uploadContainer).includes(name), `dropped ${name} is in the attachment tray`)
    assert.deepEqual(uploadedTokens().slice(-2).sort(), ['art', 'scene'], 'dropped files start uploading like picked files')
    uploadApp.setPendingAttachments([]); nativeJobs.clear(); await rebuildUploadView()

    // Explorer's Ctrl+C on a sound and a picture: both come in under their own
    // names, the picture as a file rather than as pasted image data.
    const sound = { ...job('sound'), name: 'theme.ogg', mediaType: 'audio/ogg' }, picture = { ...job('picture'), name: '立绘.png', mediaType: 'image/png' }
    nativeJobs.set('sound', sound); nativeJobs.set('picture', picture); clipboardFiles = [sound, picture]
    const imagePastesBefore = calls.filter(call => call.command === 'stage_clipboard_image').length
    let prevented = false
    await uploadEditor().props.onPaste({ preventDefault() { prevented = true }, clipboardData: { items: [
      { kind: 'file', type: '', getAsFile: () => new File([new Uint8Array([79, 103, 103, 83])], 'theme.ogg') },
      { kind: 'file', type: 'image/png', getAsFile: () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], '立绘.png', { type: 'image/png' }) },
    ] } }); await settle()
    assert.ok(prevented, 'the copied files are not pasted into the text')
    for (const name of ['theme.ogg', '立绘.png']) assert.ok(text(uploadContainer).includes(name), `pasted ${name} is in the attachment tray`)
    assert.equal(calls.filter(call => call.command === 'stage_clipboard_image').length, imagePastesBefore, 'a copied picture keeps its file, not a re-encoded paste')
    assert.deepEqual(uploadedTokens().slice(-2).sort(), ['picture', 'sound'])
    clipboardFiles = null; uploadApp.setPendingAttachments([]); nativeJobs.clear(); await rebuildUploadView()
  }
  console.log('PASS: dropped files and files copied in a file manager become attachments under their own names')
  // Upload-state review P1: storage failure blocked unrelated control buttons.
  // These actions freeze the real target, but never claim or clear this editor.
  const countCalls = command => calls.filter(call => call.command === command).length
  const assertControlTarget = command => {
    const args = calls.findLast(call => call.command === command)?.args
    assert.ok(args, `${command} must reach native even when draft storage is full`)
    assert.deepEqual({ connectionId: args.connectionId, selectionGeneration: args.selectionGeneration, instanceId: args.instanceId,
      expectedHostEpoch: args.expectedHostEpoch, expectedRuntimeGeneration: args.expectedRuntimeGeneration, operationEditor: args.operationEditor },
    { connectionId: 'host', selectionGeneration: 1, instanceId: 'work', expectedHostEpoch: 'epoch', expectedRuntimeGeneration: 1, operationEditor: null })
  }
  const controlResult = (kind, args, result) => {
    const operation = { operationId: args.operationId, kind, connectionId: 'host', instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1,
      sessionId: '', editor: null, state: 'succeeded', result }
    nativeResults.set(operation.operationId, operation); emit('aludock://operation', operation)
    return result
  }
  // What the Host does on Stop: publish the final state on the Work's live
  // events and retire it from its list, then reply.
  const hostStop = args => {
    const sequence = journalAt('work', 1)
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 1, sequence: sequence + 1, occurredAt: 'now', eventType: 'instance.stopped', data: { cleanupErrors: [] } } })
    observation({ kind: 'event', event: { instanceId: 'work', runtimeGeneration: 1, sequence: sequence + 2, occurredAt: 'now', eventType: 'instance.state_changed',
      data: { lifecycle: 'stopped', execution: 'unavailable', compacting: false, pending: { steering: 0, followUp: 0, total: 0 } } } })
    retiredWorks.add('work')
    return controlResult('stop_work', args, { receipt: { operationId: args.operationId, alreadyStopped: false }, instance: atHost({ ...work, lifecycle: 'stopped', execution: 'unavailable', ownerHostEpoch: undefined }) })
  }
  uploadEditor().props['onUpdate:modelValue']('draft must survive control buttons')
  uploadApp.flushLocalState()
  const persistedEditor = storage.get('aludock.uiState')
  observation({ kind: 'snapshot', bootstrap: { ...bootstrap, instance: { ...work, execution: 'running' }, cursor: nextCursor() }, contentToken: 'storage-controls', state: 'connected' }); await settle()
  failStorage = true
  abortNative = args => controlResult('abort_run', args, { receipt: { instanceId: 'work', restored: [], inFlight: [] }, instance: atHost(work) })
  const abortsBefore = countCalls('abort_run')
  await find(uploadContainer, item => item.type === 'button' && String(item.props.class).includes('alu-stop-run')).props.onClick(); await settle()
  assert.equal(countCalls('abort_run'), abortsBefore + 1)
  assertControlTarget('abort_run')
  assert.equal(uploadApp.currentDraft, 'draft must survive control buttons')
  contentSnapshot(); await settle()
  modelNative = args => controlResult('set_model', args, atHost(work))
  find(uploadContainer, item => String(item.props.class ?? '').includes('alu-nav-selector-model')).props.onClick(); await settle()
  const modelsBefore = countCalls('set_model')
  await find(uploadContainer, item => item.props.id === 'cc-opt-0').props.onClick(); await settle()
  assert.equal(countCalls('set_model'), modelsBefore + 1)
  assertControlTarget('set_model')
  assert.equal(uploadApp.currentDraft, 'draft must survive control buttons')
  const unsavedSendsBefore = countCalls('submit_message')
  await find(uploadContainer, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap')).props.onSubmit({ preventDefault() {} }); await settle()
  assert.equal(countCalls('submit_message'), unsavedSendsBefore, 'ordinary message sending keeps its strong storage gate')
  find(uploadContainer, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
  stopNative = hostStop
  const stopsBefore = countCalls('stop_work')
  find(uploadContainer, item => item.type === 'button' && text(item).includes('Stop Work')).props.onClick(); await settle()
  const stopConfirm = find(uploadContainer, item => item.props.role === 'dialog' && item.props['aria-label'] === '停止当前工作？')
  find(stopConfirm, item => item.type === 'button' && text(item) === '确认').props.onClick(); await settle()
  assert.equal(countCalls('stop_work'), stopsBefore + 1)
  assertControlTarget('stop_work')
  assert.equal(uploadApp.works.some(item => item.id === 'work'), false, 'the stopped Work leaves with the list the Host returns')
  assert.equal(storage.get('aludock.uiState'), persistedEditor)
  // The local /stop shortcut must not reintroduce the same editor-storage gate.
  // That scenario starts from a fresh Host where this Work is running.
  retiredWorks.delete('work')
  await rebuildUploadView()
  uploadEditor().props['onUpdate:modelValue']('/stop')
  const shortcut = find(uploadContainer, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap')).props.onSubmit({ preventDefault() {} })
  await settle()
  const shortcutConfirm = find(uploadContainer, item => item.props.role === 'dialog' && item.props['aria-label'] === '停止当前工作？')
  assert.ok(shortcutConfirm)
  find(shortcutConfirm, item => item.type === 'button' && text(item) === '确认').props.onClick(); await shortcut; await settle()
  assert.equal(countCalls('stop_work'), stopsBefore + 2, 'if optional command-text cleanup cannot be saved, Stop still runs')
  assertControlTarget('stop_work')
  assert.equal(uploadApp.works.some(item => item.id === 'work'), false)
  failStorage = false; modelNative = undefined
  retiredWorks.delete('work')
  await rebuildUploadView()
  console.log('PASS: full storage permits target-only controls and Queue retrieval; ordinary send keeps durable capture')
  const uploadsBefore = calls.filter(call => call.command === 'upload_attachment').length
  await chooseJob('first')
  uploadEditor().props['onUpdate:modelValue']('keep typing while uploading'); await settle()
  const selectUploadingWork = async index => {
    find(uploadContainer, item => item.type === 'button' && String(item.props['aria-label']).startsWith('打开工作列表')).props.onClick(); await settle()
    const link = all(uploadContainer, item => item.type === 'button' && item.props.class === 'alu-instance-link')[index]
    assert.ok(!link.props.disabled, 'an upload does not disable Work navigation')
    link.props.onClick(); await settle()
  }
  await selectUploadingWork(1)
  assert.equal(uploadApp.selectedWorkId, 'other')
  assert.equal(text(uploadContainer).includes('first.txt'), false)
  await selectUploadingWork(0)
  assert.equal(uploadApp.currentPendingAttachments[0].jobId, 'first')
  assert.ok(text(uploadContainer).includes('first.txt'))
  await rebuildUploadView()
  assert.equal(calls.filter(call => call.command === 'upload_attachment').length, uploadsBefore + 1, 'Work A/B/A and rebuilt App read retained progress; neither replays upload')
  assert.equal(uploadApp.currentDraft, 'keep typing while uploading')
  // #306: Stop is a separate intent, not an attachment lifecycle transition.
  find(uploadContainer, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
  find(uploadContainer, item => item.type === 'button' && text(item).includes('Stop Work')).props.onClick(); await settle()
  const uploadingStop = find(uploadContainer, item => item.props.role === 'dialog' && item.props['aria-label'] === '停止当前工作？')
  assert.ok(uploadingStop, 'Stop confirmation is available during upload')
  find(uploadingStop, item => item.type === 'button' && text(item) === '确认').props.onClick(); await settle()
  assert.equal(countCalls('stop_work'), stopsBefore + 3)
  assert.equal(calls.findLast(call => call.command === 'stop_work').args.instanceId, 'work')
  assert.equal(nativeJobs.get('first').state, 'uploading')
  assert.equal(nativeJobs.get('first').workId, 'work')
  // The checks below start again from a Host where this Work is running.
  retiredWorks.delete('work')
  await rebuildUploadView()
  failStorage = true
  await publishJob('first', { state: 'succeeded', revision: 3, result: uploaded('first') })
  assert.equal(uploadApp.currentPendingAttachments.length, 1)
  assert.equal(uploadApp.currentAttachments.length, 0, 'receipt remains native when pending→uploaded JSON cannot be saved')
  failStorage = false
  await find(uploadContainer, item => item.props['aria-label'] === '重试处理 first.txt').props.onClick(); await settle()
  assert.equal(uploadApp.currentAttachments[0].fileId, 'file-first')
  assert.equal(uploadApp.currentPendingAttachments.length, 0)
  assert.equal(calls.filter(call => call.command === 'upload_attachment').length, uploadsBefore + 1, 'retry only saves the retained receipt')
  assert.equal(uploadApp.currentDraft, 'keep typing while uploading', 'text edits do not revoke attachment selection')
  failStorage = true
  await find(uploadContainer, item => item.props['aria-label'] === '移除附件 first.txt').props.onClick(); await settle()
  assert.equal(uploadApp.currentAttachments.length, 1, 'failed removal does not publish a false accepted editor')
  failStorage = false
  deferJobSnapshot = true
  emit('aludock://attachment-progress', nativeJobs.get('first')); await settle()
  await find(uploadContainer, item => item.props['aria-label'] === '移除附件 first.txt').props.onClick(); await settle()
  releaseJobSnapshot(); await settle()
  assert.equal(text(uploadContainer).includes('first.txt'), false, 'an older full snapshot cannot restore an already removed native job')
  // Duplicate old notifications cannot reconstruct a deleted selection.
  nativeJobs.set('first', { ...job('first'), state: 'succeeded', revision: 3, result: uploaded('first') })
  emit('aludock://attachment-progress', nativeJobs.get('first')); await settle()
  assert.equal(uploadApp.currentAttachments.length, 0)
  await chooseJob('second')
  await publishJob('second', { state: 'succeeded', revision: 3, result: uploaded('second') })
  context.selectionGeneration++
  await rebuildUploadView()
  assert.equal(uploadApp.currentAttachments[0].localUpload.selectionGeneration, 1, 'the original receipt is preserved across a new IPC binding')
  assert.equal(uploadApp.connectionContext.selectionGeneration, 2)
  nativeJobs.delete('second') // A permanent Host receipt needs no process-local upload job to send.
  const sendsBefore = calls.filter(call => call.command === 'submit_message').length
  // A full local capture must succeed before native receives any send.
  failStorage = true
  await find(uploadContainer, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap')).props.onSubmit({ preventDefault() {} }); await settle()
  assert.equal(calls.filter(call => call.command === 'submit_message').length, sendsBefore)
  failStorage = false
  submitNative = args => {
    const result = { instance: atHost(work), receipt: { queued: true, delivery: 'followUp' } }
    const operation = { operationId: args.operationId, kind: 'submit_message', connectionId: 'host', instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1,
      sessionId: 'old', editor: args.operationEditor, state: 'succeeded', result }
    failStorage = true; nativeResults.set(operation.operationId, JSON.parse(JSON.stringify(operation))); emit('aludock://operation', operation)
    return result
  }
  await find(uploadContainer, item => item.type === 'form' && String(item.props.class).includes('alu-input-wrap')).props.onSubmit({ preventDefault() {} }); await settle()
  assert.equal(nativeResults.size, 1, 'known send receipt is not consumed when local cleanup fails')
  assert.equal(uploadApp.currentAttachments.length, 1)
  await rebuildUploadView()
  assert.equal(nativeResults.size, 1)
  assert.equal(uploadApp.currentAttachments.length, 1)
  failStorage = false
  await uploadButton('重试关闭').props.onClick(); await settle()
  assert.equal(nativeResults.size, 0)
  assert.equal(uploadApp.currentAttachments.length, 0)
  nativeJobs.set('second', { ...job('second'), state: 'succeeded', revision: 3, result: uploaded('second') })
  await publishJob('second', { revision: 3 })
  assert.equal(uploadApp.currentAttachments.length, 0, 'sent attachments do not return from repeated upload snapshots')
  assert.equal(calls.filter(call => call.command === 'submit_message').length, sendsBefore + 1, 'F5 and acknowledgement retry do not resend')
  // Android incident: sent uploads and unselected native jobs must not create an
  // accumulating, undeletable second tray above the editor, including after F5.
  assert.equal(text(uploadContainer).includes('second.txt'), false)
  nativeJobs.clear(); nativeJobs.set('orphan', job('orphan'))
  await rebuildUploadView()
  assert.equal(uploadApp.currentPendingAttachments.length, 0)
  assert.equal(text(uploadContainer).includes('保留的附件'), false)
  assert.equal(text(uploadContainer).includes('orphan.txt'), false)
  await chooseJob('orphan')
  assert.equal(uploadApp.currentPendingAttachments[0].jobId, 'orphan')
  uploadApp.applyWorkSnapshot(atHost({ ...work, runtimeGeneration: 2, executor: { kind: 'pi', piSessionId: 'changed-session' } })); await settle()
  await publishJob('orphan', { state: 'succeeded', revision: 3, result: uploaded('orphan') })
  assert.equal(uploadApp.currentAttachments.length, 0, 'real Session replacement revokes the old pending selection')
  console.log('PASS: App upload query/progress + A/B/A + reconstructed frontend + later typing + no unsolicited upload-history tray + deletion/queued-send duplicate snapshots + local save failures')

  // Review of the late-reply fix: Stop's final events arrive first; a Model reply
  // the Host wrote while the Work was still running arrives afterwards, both
  // before and after the Host's list drops the Work. It may not bring the Work back.
  {
    storage.clear(); nativeResults.clear(); consumeFailures.clear()
    mounted?.unmount(); await settle()
    const stopPinia = createPinia(), stopApp = useAppStore(stopPinia), stopView = element('stop-app')
    mounted = renderer.createApp({ render: () => h(App) }).use(stopPinia)
    mounted.mount(stopView); await settle()
    stopApp.selectWork('work'); await settle(); contentSnapshot(); await settle()
    const modelReply = { operationId: 'model-before-stop', kind: 'set_model', connectionId: 'host', instanceId: 'work', hostEpoch: 'epoch', runtimeGeneration: 1,
      sessionId: '', editor: null, state: 'succeeded', result: atHost(work) }
    let finishStop
    stopNative = args => new Promise(resolve => { const result = hostStop(args); finishStop = () => resolve(result) })
    find(stopView, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle()
    find(stopView, item => item.type === 'button' && text(item).includes('Stop Work')).props.onClick(); await settle()
    find(find(stopView, item => item.props.role === 'dialog' && item.props['aria-label'] === '停止当前工作？'), item => item.type === 'button' && text(item) === '确认').props.onClick(); await settle()
    emit('aludock://operation', { ...modelReply }); await settle()
    assert.equal(stopApp.works.find(item => item.id === 'work')?.lifecycle, 'stopped', 'a reply written before Stop does not make the stopped Work active again')
    assertSameReference(find(stopView, item => item.props['aria-label'] === '消息编辑器'), undefined, 'the stopped Work offers no editor')
    finishStop(); await settle()
    assert.equal(stopApp.works.some(item => item.id === 'work'), false, 'the stopped Work leaves with the list the Host returns')
    emit('aludock://operation', { ...modelReply, operationId: 'model-before-stop-replayed' }); await settle()
    assert.equal(stopApp.works.some(item => item.id === 'work'), false, 'a late reply cannot put a Work the Host no longer lists back into the list')
    stopNative = undefined; retiredWorks.delete('work')
  }
  console.log('PASS: Stop events first, older reply later: the Work stays stopped and, once the Host drops it, stays out of the list')

  // Continue: the Host's answer makes the lost Work active and followed at once,
  // without waiting for the next list read.
  {
    const lost = { ...otherWork, id: 'lost-work', eventCursor: { ...otherWork.eventCursor, instanceId: 'lost-work' }, lifecycle: 'host_lost', execution: 'unavailable', reopenable: true, ownerHostEpoch: undefined }
    extraListed = [lost]
    storage.clear(); nativeResults.clear(); consumeFailures.clear()
    mounted?.unmount(); await settle()
    const continuePinia = createPinia(), continueApp = useAppStore(continuePinia), continueView = element('continue-app')
    mounted = renderer.createApp({ render: () => h(App) }).use(continuePinia)
    mounted.mount(continueView); await settle()
    continueApp.selectWork('lost-work'); await settle()
    const continued = atHost({ ...lost, lifecycle: 'active', execution: 'idle', reopenable: false, ownerHostEpoch: 'epoch', runtimeGeneration: 2 })
    reopenNative = () => { extraListed = [continued]; return continued }
    let releaseList
    holdWorkCatalog = new Promise(resolve => { releaseList = resolve })
    await find(continueView, item => item.type === 'button' && item.props.class === 'alu-work-state-primary').props.onClick(); await settle()
    assert.equal(continueApp.selectedWork?.lifecycle, 'active', 'the continued Work is active before the list is read again')
    assert.ok(find(continueView, item => item.props['aria-label'] === '消息编辑器'), 'its editor is available at once')
    assert.equal(calls.findLast(call => call.command === 'start_conversation_follow')?.args.instanceId, 'lost-work', 'following starts for the continued Work')
    releaseList(); holdWorkCatalog = undefined; await settle()
    extraListed = []; reopenNative = undefined
  }
  console.log('PASS: Continue opens the Work from the Host answer without waiting for the list')

  // #359: quick buttons in the input card. Real App, Pinia, palette and editor; only native IPC is a fixture.
  {
    storage.clear(); nativeResults.clear(); consumeFailures.clear(); nativeJobs.clear(); pickedJobs = []
    let quickApp, quickView
    const mountQuickView = async () => {
      mounted?.unmount(); await settle()
      const pinia = createPinia()
      quickApp = useAppStore(pinia); quickView = element('quick-buttons-app')
      mounted = renderer.createApp({ render: () => h(App) }).use(pinia)
      mounted.mount(quickView); await settle()
      quickApp.selectWork('work'); await settle(); contentSnapshot(); await settle()
    }
    const row = () => find(quickView, item => item.props.class === 'alu-quick-buttons')
    const rowNames = () => row() ? all(row(), item => item.type === 'button').map(text) : []
    const quickButton = name => all(row(), item => item.type === 'button').find(item => text(item) === name)
    const editor = () => find(quickView, item => item.type === 'textarea' && item.props.placeholder === '输入消息…')
    const openPalette = async () => { find(quickView, item => item.type === 'button' && String(item.props.title).startsWith('打开命令中心')).props.onClick(); await settle() }
    const closeDialog = async () => { find(quickView, item => item.type === 'button' && item.props['aria-label'] === '关闭').props.onClick(); await settle() }
    const openManager = async () => {
      await openPalette()
      find(quickView, item => item.type === 'button' && String(item.props.class).includes('cmd-palette-item') && text(item).includes('管理快捷按钮')).props.onClick(); await settle()
    }
    const form = () => find(quickView, item => item.type === 'form' && String(item.props.class).includes('quick-button-form'))
    const formText = () => find(form(), item => item.type === 'textarea')
    const sends = () => calls.filter(call => call.command === 'submit_message').length

    catalogNative = () => ({ commands: [{ name: 'codex-fast', referenceId: 'codex-fast-ref', source: { kind: 'extension' }, contentAvailable: false }], total: 1, truncated: false })
    await mountQuickView()
    assert.deepEqual(rowNames(), ['恢复', 'Tree'], 'a device without saved buttons starts with 恢复 and Tree')
    editor().props['onUpdate:modelValue']('half-typed draft')
    await quickButton('恢复').props.onClick(); await settle()
    assert.ok(find(quickView, item => item.props.role === 'dialog' && item.props['aria-label'] === '恢复 Session'), '恢复 is /resume sent at once, which opens the saved Sessions')
    await closeDialog()

    // Pinning a command opens the form with room for an argument; saving adds it to the row.
    await openPalette()
    find(quickView, item => item.type === 'button' && item.props['aria-label'] === '把 /codex-fast 做成快捷按钮').props.onClick(); await settle()
    assert.equal(formText().value, '/codex-fast ', 'the pinned command waits for its argument')
    formText().props['onUpdate:modelValue']('/codex-fast all')
    await form().props.onSubmit({ preventDefault() {} }); await settle()
    assert.deepEqual(rowNames(), ['恢复', 'Tree', 'codex-fast'])
    await closeDialog()

    // 立即发送 sends only the button's text: the half-typed draft, its attachments and retrieved images stay.
    let quickSend
    submitNative = async args => { quickSend = args; return { receipt: { queued: false, delivery: 'prompt' }, instance: atHost(work) } }
    assert.equal(quickButton('codex-fast').props.disabled, false)
    await quickButton('codex-fast').props.onClick(); await settle()
    assert.equal(quickSend?.message, '/codex-fast all', 'the button sends its whole line, argument included')
    assert.equal(quickSend.operationEditor, null, 'the send claims no editor, so its success cannot clear the draft')
    assert.deepEqual([quickSend.attachmentFileIds, quickSend.textOnly], [[], true], 'attachments and retrieved images stay with the editor')
    assert.equal(quickApp.currentDraft, 'half-typed draft')

    // A lost quick-send reply is reported once, like any send, and does not lock the buttons.
    // Native records the send under the Session the request names (an editor send names it in its capture).
    let unconfirmedSend
    const lost = { code: 'connection_failed', message: '连接中断，无法确认是否已发送。', outcomeUnknown: true }
    submitNative = args => {
      unconfirmedSend = args
      emit('aludock://operation', { operationId: args.operationId, kind: 'submit_message', connectionId: args.connectionId, instanceId: args.instanceId,
        hostEpoch: args.expectedHostEpoch, runtimeGeneration: args.expectedRuntimeGeneration, sessionId: args.sessionId, editor: args.operationEditor, state: 'unknown', error: lost })
      return Promise.reject({ ...lost, operationId: args.operationId })
    }
    await quickButton('codex-fast').props.onClick(); await settle()
    assert.equal(unconfirmedSend.sessionId, 'old', 'the quick send names the Session it belongs to')
    assert.ok(text(quickView).includes('连接中断，没收到结果'), 'the lost quick send is reported like any send')
    assert.equal(quickButton('codex-fast').props.disabled, false, 'the quick button stays usable; the conversation shows whether it ran')
    assert.equal(quickApp.nativeOperations.has(unconfirmedSend.operationId), false, 'nothing of the lost send is kept')
    assert.equal(quickApp.currentDraft, 'half-typed draft')

    // Review of 63b1b31: send on A, switch to B and back, then the reply is lost.
    // The button's own catch is fenced off by the switch; the result still says so once.
    let rejectRoundTrip, roundTripArgs
    submitNative = args => {
      roundTripArgs = args
      emit('aludock://operation', { operationId: args.operationId, kind: 'submit_message', connectionId: args.connectionId, instanceId: args.instanceId,
        hostEpoch: args.expectedHostEpoch, runtimeGeneration: args.expectedRuntimeGeneration, sessionId: args.sessionId, editor: args.operationEditor, state: 'pending' })
      return new Promise((_resolve, reject) => { rejectRoundTrip = reject })
    }
    const roundTripSend = quickButton('codex-fast').props.onClick(); await settle()
    quickApp.selectWork('other'); await settle()
    quickApp.selectWork('work'); await settle()
    emit('aludock://operation', { operationId: roundTripArgs.operationId, kind: 'submit_message', connectionId: roundTripArgs.connectionId, instanceId: roundTripArgs.instanceId,
      hostEpoch: roundTripArgs.expectedHostEpoch, runtimeGeneration: roundTripArgs.expectedRuntimeGeneration, sessionId: roundTripArgs.sessionId, editor: roundTripArgs.operationEditor, state: 'unknown', error: lost })
    rejectRoundTrip({ ...lost, operationId: roundTripArgs.operationId }); await roundTripSend; await settle()
    assert.ok(text(quickView).includes('连接中断，没收到结果'), 'the lost send is told once after A/B/A')
    assert.equal(quickApp.nativeOperations.has(roundTripArgs.operationId), false, 'once shown, it is acknowledged')

    // Restarting the client keeps this device's buttons.
    await mountQuickView()
    assert.deepEqual(rowNames(), ['恢复', 'Tree', 'codex-fast'], 'a restarted client keeps the buttons')

    // 填入 puts its text in front of the draft, like a palette command, and sends nothing.
    editor().props['onUpdate:modelValue']('half-typed draft')
    await openManager()
    find(quickView, item => item.type === 'button' && text(item).includes('新建快捷按钮')).props.onClick(); await settle()
    find(form(), item => item.type === 'input' && item.props.placeholder === '留空则用文本').props['onUpdate:modelValue']('审查')
    formText().props['onUpdate:modelValue']('请审查这次改动：')
    find(form(), item => item.type === 'input' && item.props.value === 'insert').props['onUpdate:modelValue']('insert')
    await form().props.onSubmit({ preventDefault() {} }); await settle()
    await closeDialog()
    const sendsBeforeInsert = sends()
    await quickButton('审查').props.onClick(); await settle()
    assert.equal(quickApp.currentDraft, '请审查这次改动：half-typed draft')
    assert.equal(sends(), sendsBeforeInsert, '填入 does not send')

    // More buttons than the row holds: the rest run from the palette, and moving one up brings it into the row.
    storage.set('aludock.quickButtons', JSON.stringify(Array.from({ length: 7 }, (_, index) => ({ id: `seed-${index}`, name: `第${index + 1}`, text: `overflow check ${index + 1}`, mode: 'send' }))))
    await mountQuickView()
    assert.deepEqual(rowNames(), ['第1', '第2', '第3', '第4', '第5', '第6'], 'the row holds the first six')
    let paletteSend
    submitNative = async args => { paletteSend = args; return { receipt: { queued: true, delivery: 'followUp' }, instance: atHost(work) } }
    await openPalette()
    await find(quickView, item => item.type === 'button' && String(item.props.class).includes('cmd-palette-quick') && text(item).includes('第7')).props.onClick(); await settle()
    assert.equal(paletteSend?.message, 'overflow check 7', 'a button without room in the row runs from the palette')
    assertSameReference(find(quickView, item => item.props.role === 'dialog' && item.props['aria-label'] === '命令中心'), undefined, 'the palette closes once the button is sent')
    await openManager()
    await find(quickView, item => item.props['aria-label'] === '调整「第7」的位置').props.onKeydown({ key: 'ArrowUp', preventDefault() {} }); await settle()
    assert.deepEqual(rowNames(), ['第1', '第2', '第3', '第4', '第5', '第7'], 'the order decides which buttons fit in the row')
    await closeDialog()
    catalogNative = undefined
    console.log('PASS: quick buttons: defaults run local controls; pinned command takes an argument; send keeps draft/attachments; restart keeps buttons; insert fills without sending; overflow runs from palette; order decides the row')
  }

  }
} finally {
  mounted?.unmount(); await settle(); await rm(directory, { recursive: true, force: true })
}
