// Card 308: real Vue controls/TS bridge; native IPC and the browser-only Markdown
// rendering leaf are fixtures. Markdown source/reading controls remain real.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, reactive, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(root, '.directory-check-'))
const node = (type, value = '') => ({ type, text: value, props: {}, children: [], parent: null,
  focus() {}, select() {}, getRootNode() { return null }, addEventListener(name, handler) { this[name] = handler }, removeEventListener() {}, querySelectorAll() { return [] },
})
// v-model clears the filter box when entering a directory; it asks where the input lives first.
globalThis.Document = class Document {}
globalThis.ShadowRoot = class ShadowRoot {}
const detach = item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1) }
const insert = (item, parent, anchor) => {
  detach(item); item.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
}
const renderer = createRenderer({
  createElement: tag => node(tag), createText: value => node('#text', value), createComment: value => node('#comment', value),
  insert, remove: detach, setText: (item, value) => { item.text = value },
  setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value }, parentNode: item => item.parent,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null, setScopeId() {},
  insertStaticContent: (value, parent, anchor) => { const item = node('#static', value); insert(item, parent, anchor); return [item, item] },
})
const find = (item, predicate) => predicate(item) ? item : item.children.map(child => find(child, predicate)).find(Boolean)
const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await nextTick() }
let mobile = false
let copiedDiagnostic = ''
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  clipboard: { writeText: async value => { copiedDiagnostic = value } },
} })
let invoke = () => { throw new Error('No native fixture') }
globalThis.document = { addEventListener() {}, removeEventListener() {} }
globalThis.window = { clearTimeout, setTimeout, addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }),
  __TAURI_INTERNALS__: { invoke: (command, args) => invoke(command, args), transformCallback: () => 1 },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
}
const main = { hostId: 'main', name: 'Linux', kind: 'main', available: true, platform: 'linux', homePath: '/home/alu', workspaceRoots: ['/'] }
const windows = { hostId: 'windows', name: 'Windows', kind: 'subhost', available: true, platform: 'windows', homePath: 'C:\\Users\\alu', workspaceRoots: ['C:\\', 'D:\\'] }
const dir = (name, kind = 'directory') => ({ name, kind, hidden: name.startsWith('.') })
const page = (path, entries, parent, extra = {}) => ({ path, entries, parent, revision: 'r', total: entries.length, truncated: false, ...extra })

try {
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `export { default as NewWorkDialog } from '../src/components/NewWorkDialog.vue'; export { default as WorkspaceBrowser } from '../src/components/WorkspaceBrowser.vue'; export { useAppStore } from '../src/stores/app';`)
  await build({ root, configFile: false, logLevel: 'silent', plugins: [{
    name: 'browser-markdown-leaf', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/MarkdownContent.vue')) return '\0markdown-leaf' },
    load(id) { if (id === '\0markdown-leaf') return "import { h } from 'vue'; export default { props: ['source'], render() { return h('div', this.source) } };" },
  }, vue()], build: {
    outDir: directory, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'components.mjs' },
    rolldownOptions: { external: ['vue', 'pinia'] },
  } })
  const { NewWorkDialog, WorkspaceBrowser, useAppStore } = await import(join(directory, 'components.mjs'))

  function mount(Component, props, events = {}) {
    const container = node('root')
    const app = renderer.createApp({ render: () => h(Component, { ...props, ...events }) })
    app.mount(container)
    const button = label => find(container, item => item.type === 'button' && (item.props['aria-label'] === label || text(item).includes(label)))
    const click = async label => {
      const target = button(label)
      assert.ok(target, `button ${label} exists`)
      assert.ok(!target.props.disabled, `${label} is enabled`)
      target.props.onClick(); await settle()
    }
    return { container, button, click, unmount: () => app.unmount() }
  }

  async function newWork(machines, readPage) {
    setActivePinia(createPinia())
    const store = useAppStore()
    invoke = async command => {
      if (command === 'get_host_catalog') return { revision: 1, selectionGeneration: 1, hosts: [], activeTarget: { kind: 'host', hostId: 'connection' } }
      if (command === 'bootstrap') return { connectionId: 'connection', selectionGeneration: 1, host: { hostEpoch: 'epoch' }, works: [], total: 0 }
      throw new Error(`Unexpected setup ${command}`)
    }
    await store.load()
    const calls = []
    invoke = async (command, args) => {
      calls.push({ command, args })
      if (command === 'list_workspace') return readPage(args)
      if (command === 'model_visibility') return { models: [], total: 0, truncated: false, hidden: [] }
      if (command === 'system_catalog') throw { code: 'capability_missing', details: { missing: ['system.templates.v1'] } }
      if (command === 'create_work') return { id: 'new-work', hostId: args.targetHostId, cwd: args.cwd }
      throw new Error(`Unexpected IPC ${command}`)
    }
    const created = []
    const props = reactive({ machines, machinesLoading: false, outcomeUnknown: false })
    const ui = mount(NewWorkDialog, props, { onCreated: work => created.push(work) })
    await ui.click('选择其他目录')
    return { ...ui, calls, created, store }
  }

  // Card 361: the picker shows one level at a time on the desktop too. The filter narrows only
  // the level being viewed and clears on entering; Enter on a path goes there directly.
  let failMore = true
  let failProjectsRefresh = false
  const desktop = await newWork([main], args => {
    if (args.path === '/home/alu') {
      if (args.cursor && failMore) { failMore = false; throw { code: 'client_error', details: { reason: 'fixture-page-decoding-failed' } } }
      return args.cursor ? page(args.path, [dir('last')], '/home') : page(args.path, [dir('projects'), dir('.hidden'), dir('link', 'symlink')], '/home', { total: 4, truncated: true, nextCursor: { revision: 'r', offset: 3 } })
    }
    if (args.path === '/home/alu/projects') {
      if (failProjectsRefresh) { failProjectsRefresh = false; throw { code: 'protocol_error', details: { reason: 'fixture-directory-decoding-failed' } } }
      return page(args.path, [dir('app'), dir('archive')], '/home/alu')
    }
    // Host normalizes a directory link back to Home; the picker must show the normalized target.
    if (args.path === '/home/alu/link') return page('/home/alu', [dir('projects'), dir('link', 'symlink')], '/home')
    if (args.path.endsWith('/missing')) throw { code: 'workspace_not_found', message: '这个目录不存在。请检查路径后重试。' }
    return page(args.path, [], '/home/alu/projects')
  })
  assert.ok(!desktop.button('.hidden'))
  await desktop.click('显示隐藏目录'); assert.ok(desktop.button('.hidden'))
  await desktop.click('加载更多'); assert.ok(desktop.button('projects'))
  // Card 308 final review: directory reads must retain the existing diagnostic-copy action.
  await desktop.click('复制诊断信息')
  assert.ok(copiedDiagnostic.includes('fixture-page-decoding-failed'))
  assert.ok(copiedDiagnostic.includes('list_workspace') && copiedDiagnostic.includes('/home/alu'))
  await desktop.click('重试')
  assert.ok(!desktop.button('诊断信息已复制'), 'successful retry retires the previous error actions')
  await desktop.click('加载更多')
  assert.ok(desktop.button('projects')); assert.ok(desktop.button('last'))
  await desktop.click('link')
  const confirmation = find(desktop.container, item => item.type === 'footer' && String(item.props.class).includes('directory-confirm'))
  assert.equal(text(confirmation.children.find(item => item.type === 'span')), '/home/alu', 'link selection displays the Host-normalized directory')
  await desktop.click('使用这个目录')
  assert.equal(desktop.calls.findLast(call => call.command === 'create_work').args.cwd, '/home/alu', 'creating through a link uses its normalized target, not the link path')
  await desktop.click('选择其他目录')
  // The user's case: filter for one folder on this level, enter it, and see all of it.
  const search = find(desktop.container, item => item.type === 'input' && item.props['aria-label'] === '筛选目录或输入路径')
  const type = async value => { search.value = value; search.input({ target: search }); await settle() }
  const enter = async () => { search.props.onKeydown({ key: 'Enter', preventDefault() {} }); await settle() }
  await type('proj')
  assert.ok(desktop.button('projects')); assert.ok(!desktop.button('link'), 'the filter narrows only the level being viewed')
  await desktop.click('projects')
  assert.ok(desktop.button('app') && desktop.button('archive'), 'entering a directory shows all of it')
  assert.equal(search.value, '', 'entering a directory clears the filter')
  assert.ok(!desktop.button('link'), 'the previous level is no longer on screen, so nothing jumps')
  await type('ap'); assert.ok(desktop.button('app')); assert.ok(!desktop.button('archive'))
  await type(''); assert.ok(desktop.button('archive'))
  failProjectsRefresh = true
  await desktop.click('刷新目录')
  assert.ok(desktop.button('重试'), 'a failed refresh of this level is shown in place')
  await desktop.click('复制诊断信息')
  assert.ok(copiedDiagnostic.includes('fixture-directory-decoding-failed'))
  assert.ok(copiedDiagnostic.includes('/home/alu/projects'))
  await desktop.click('重试')
  assert.ok(desktop.button('app'))
  // Enter on a path goes there; a path that does not exist reports in place and keeps a way back.
  await type('/home/alu/projects/missing'); await enter()
  assert.ok(text(desktop.container).includes('这个目录不存在'), 'a typed path that does not exist is reported in place')
  await desktop.click('返回上级目录')
  assert.ok(desktop.button('app'), 'back returns to the directory viewed before the typed path')
  await type('~/projects'); await enter()
  assert.ok(desktop.button('app'), '~ means the Machine Home')
  await type('app/'); await enter()
  const target = find(desktop.container, item => item.type === 'footer' && String(item.props.class).includes('directory-confirm'))
  assert.equal(text(target.children.find(item => item.type === 'span')), '/home/alu/projects/app', 'a relative path resolves against the directory being viewed')
  assert.ok(text(desktop.container).includes('这个目录没有可见项目'))
  await desktop.click('使用这个目录')
  const create = desktop.calls.findLast(call => call.command === 'create_work')
  assert.equal(create.args.cwd, '/home/alu/projects/app')
  assert.equal(create.args.targetHostId, 'main')
  assert.equal(desktop.created.at(-1).id, 'new-work')
  desktop.unmount(); await settle()

  // Mobile Windows uses Machine roots, can return after failed reads, and reselect Home.
  mobile = true
  const phone = await newWork([windows], args => {
    if (args.path === 'C:\\Users\\alu') return page(args.path, [dir('repo'), dir('denied'), dir('decode-error')], 'C:\\Users')
    if (args.path === 'C:\\Users\\alu\\repo') return page(args.path, [dir('inside')], 'C:\\Users\\alu')
    if (args.path.endsWith('denied')) throw { code: 'workspace_permission_denied', message: '没有读取权限，请返回其他目录。' }
    if (args.path.endsWith('decode-error')) throw { code: 'protocol_error', details: { reason: 'mobile-directory-decoding-failed' } }
    if (args.path === 'D:\\') return page(args.path, [dir('project')])
    return page(args.path, [], 'D:\\')
  })
  await phone.click('repo'); assert.ok(phone.button('inside'))
  await phone.click('快速前往'); await phone.click('Home')
  assert.ok(phone.button('repo')); assert.ok(!phone.button('inside'), 'choosing Home again changes both list and confirmation target')
  await phone.click('denied'); assert.ok(phone.button('重试'))
  await phone.click('返回上级目录'); assert.ok(phone.button('repo'))
  await phone.click('decode-error'); await phone.click('复制诊断信息')
  assert.ok(copiedDiagnostic.includes('mobile-directory-decoding-failed'))
  assert.ok(copiedDiagnostic.includes('C:\\Users\\alu\\decode-error'))
  await phone.click('返回上级目录')
  assert.ok(!phone.button('诊断信息已复制'), 'leaving a failed directory hides its diagnostic action')
  const phoneSearch = find(phone.container, item => item.type === 'input' && item.props['aria-label'] === '筛选目录或输入路径')
  phoneSearch.value = '~\\repo'; phoneSearch.input({ target: phoneSearch }); await settle()
  phoneSearch.props.onKeydown({ key: 'Enter', preventDefault() {} }); await settle()
  assert.ok(phone.button('inside'), 'a typed ~ path uses the Windows Home and path style')
  await phone.click('快速前往'); await phone.click('D:\\')
  await phone.click('project'); await phone.click('使用这个目录')
  const windowsCreate = phone.calls.find(call => call.command === 'create_work')
  assert.equal(windowsCreate.args.cwd, 'D:\\project')
  assert.equal(windowsCreate.args.targetHostId, 'windows')
  phone.unmount(); await settle()

  // A previous Machine's late directory or decoding error must not replace the new selection.
  for (const outcome of ['page', 'error']) {
    let oldRead, oldFailure
    const switching = await newWork([main, windows], args => args.targetHostId === 'main'
      ? new Promise((resolve, reject) => { oldRead = resolve; oldFailure = reject })
      : page('C:\\Users\\alu', [dir('windows-project')], 'C:\\Users'))
    await switching.click('选择 Machine'); await switching.click('Windows')
    if (outcome === 'page') oldRead(page('/home/alu', [dir('old-machine-project')], '/home'))
    else oldFailure({ code: 'protocol_error', details: { reason: 'old-machine-decoding-failed' } })
    await settle()
    assert.ok(switching.button('windows-project')); assert.ok(!switching.button('old-machine-project'))
    assert.ok(!switching.button('复制诊断信息'), 'old-machine failure stays off the new Machine surface')
    switching.unmount(); await settle()
  }

  // Original workspace: shared directory navigation still reaches the real preview/save controls.
  for (const mobileMode of [false, true]) {
    mobile = mobileMode
    let refreshed = false
    const calls = []
    const file = (path, name) => ({ path, name, kind: 'file', hidden: false, sizeBytes: 25 })
    const folder = (path, name) => ({ path, name, kind: 'directory', hidden: false })
    invoke = async (command, args) => {
      calls.push({ command, args })
      if (command.startsWith('plugin:event|')) return 1
      if (command === 'clear_workspace_file_state') return
      if (command === 'workspace_entries') {
        if (args.path === '.') return page('.', [folder('src', 'src'), { ...folder('.hidden', '.hidden'), hidden: true }])
        if (args.path === 'src') return page('src', [folder('src/lib', 'lib')])
        if (args.path === 'src/lib') return page('src/lib', [file('src/lib/README.md', 'README.md'), file('src/lib/photo.png', 'photo.png'), ...(refreshed ? [file('src/lib/new.txt', 'new.txt')] : [])])
        return page(args.path, [])
      }
      if (command === 'workspace_entry_metadata') return { entry: file(args.path, args.path.split('/').at(-1)), hostEpoch: 'epoch', largeFileConfirmBytes: 1000 }
      if (command === 'read_workspace_file') return { cacheId: args.expectedEntry.path, sizeBytes: 25 }
      if (command === 'workspace_cached_text') return '# Shared browser\n\nOriginal document.'
      if (command === 'workspace_cached_image') return [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')]
      if (command === 'save_workspace_cached_file') return { status: 'saved', label: 'device/README.md' }
      throw new Error(`Unexpected workspace IPC ${command}`)
    }
    const props = reactive({ open: true, work: { id: 'work', lifecycle: 'active', runtimeGeneration: 1, displayName: 'Project' }, context: { connectionId: 'connection', selectionGeneration: 1 }, hostEpoch: 'epoch' })
    const browser = mount(WorkspaceBrowser, props)
    await settle()
    await browser.click('显示隐藏文件'); assert.ok(browser.button('.hidden'))
    await browser.click('src'); await browser.click('lib')
    await browser.click('README.md')
    assert.ok(text(browser.container).includes('Original document.'))
    await browser.click('原文')
    assert.equal(find(browser.container, item => item.type === 'textarea').props.value, '# Shared browser\n\nOriginal document.')
    await browser.click('另存为'); assert.ok(text(browser.container).includes('已保存到 device/README.md'))
    if (mobileMode) await browser.click('返回')
    else await browser.click('src')
    refreshed = true
    await browser.click('刷新目录')
    if (!mobileMode) await browser.click('src')
    assert.ok(browser.button('new.txt'), 'refresh retains expanded descendants under a collapsed ancestor')
    await browser.click('photo.png')
    assert.ok(find(browser.container, item => item.type === 'img' && item.props.alt === 'photo.png'))
    await browser.click('另存为')
    assert.equal(calls.findLast(call => call.command === 'save_workspace_cached_file').args.cacheId, 'src/lib/photo.png')
    if (mobileMode) {
      await browser.click('返回'); await browser.click('返回')
      assert.ok(browser.button('lib'), 'mobile back returns to the parent, not out of the Work')
    }
    assert.ok(calls.filter(call => call.command === 'workspace_entries').every(call => call.args.instanceId === 'work'))
    browser.unmount(); await settle()
  }
  console.log('PASS: one-level directory picker → filter this level, enter clears, typed path goes there; correct Machine/cwd create; hidden/paged retry/link/Home navigation; original Work tree → Markdown/image preview/save')
} finally {
  await rm(directory, { recursive: true, force: true })
}
