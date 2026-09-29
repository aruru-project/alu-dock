// Card 271: real Vue buttons and TS bridge; only native IPC is a fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, reactive, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(root, '.system-check-'))
const stateKey = '__aluSystemCheck'
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, checked: false,
  focus() {}, select() {}, addEventListener(name, handler) { this[name] = handler }, removeEventListener() {},
  querySelectorAll() { return [] },
})
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

const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await nextTick() }
let copied = ''
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value } } } })
globalThis.window = { clearTimeout, setTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  __TAURI_INTERNALS__: { invoke: (command, args) => globalThis[stateKey].invoke(command, args) } }
const project = { id: 'project', name: '项目 SYSTEM', kind: 'project-system', path: '/project/SYSTEM.md', workerConfig: { systemPrompt: { kind: 'native', path: '/project/SYSTEM.md' } } }
const template = { id: 'chosen', name: '选择的模板', kind: 'dock-template', path: '/home/.aludock/systems/chosen.json', workerConfig: { systemPrompt: { kind: 'dock-template', path: '/home/.aludock/systems/chosen.json' }, opaque: { keep: [1, '原样'] } } }
const original = '\uFEFF{"identity":"逐字复制中文"}\n'
try {
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `export { default } from '../src/components/NewWorkDialog.vue'; export { useAppStore } from '../src/stores/app';`)
  await build({ root, configFile: false, logLevel: 'silent',
    build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'component.mjs' },
      rolldownOptions: { external: ['vue', 'pinia'] },
    },
    plugins: [vue()],
  })
  const { default: NewWorkDialog, useAppStore } = await import(join(directory, 'component.mjs'))
  async function createStore() {
    setActivePinia(createPinia())
    const store = useAppStore()
    globalThis[stateKey] = { invoke: async command => {
      if (command === 'get_host_catalog') return { revision: 1, selectionGeneration: 1, hosts: [], activeTarget: { kind: 'host', hostId: 'connection-a' } }
      if (command === 'bootstrap') return { connectionId: 'connection-a', selectionGeneration: 1, host: { hostEpoch: 'epoch-a' }, works: [], total: 0 }
      throw new Error(`Unexpected native setup call: ${command}`)
    } }
    await store.load()
    store.rememberCreatedWorkspace('target', '/project', 'linux')
    return store
  }

  // A missing optional Host feature must not block the existing creation contract.
  for (const scenario of ['legacy', 'legacy-trust', 'legacy-unknown', 'partial-unsupported', 'catalog-failure', 'catalog-empty', 'other-capability-missing', 'refresh-unsupported', 'late-unsupported', 'once', 'read-failure', 'save-trust', 'save-default-changed', 'save-failure', 'save-create-failure', 'default', 'bad-default', 'late-directory', 'late-machine', 'late-connection', 'late-close', 'save-unknown', 'save-create-unknown', 'body-back', 'body-close', 'body-connection']) {
    const store = await createStore()
    const calls = [], created = [], unknown = []
    const props = reactive({ machines: [{ hostId: 'target', name: '目标机器', kind: 'main', available: true, platform: 'linux', homePath: '/home', workspaceRoots: ['/'] }], machinesLoading: false, outcomeUnknown: false })
    let lateResolve, lateReject
    let currentDefault = scenario === 'default' ? template : undefined
    globalThis[stateKey] = { store, invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'list_workspace') return { path: args.path, revision: 'w', entries: [], total: 0, truncated: false }
      if (command === 'system_catalog') {
        if (scenario.startsWith('legacy') || (scenario === 'partial-unsupported' && args.cursor) || (scenario === 'refresh-unsupported' && calls.filter(call => call.command === command).length > 2)) {
          throw { code: 'capability_missing', message: 'Required capabilities are unavailable', details: { missing: ['system.templates.v1'] } }
        }
        if (scenario === 'other-capability-missing') throw { code: 'capability_missing', details: { missing: ['core.v2', 'system.templates.v1'] } }
        if (scenario === 'catalog-failure') throw { code: 'protocol_error', message: 'fixture failed read' }
        if (scenario === 'catalog-empty') return { cwd: args.cwd, candidates: [], total: 0, revision: 'empty', warnings: [] }
        if (scenario.startsWith('late-')) return new Promise((resolve, reject) => { lateResolve = resolve; lateReject = reject })
        return args.cursor
          ? { cwd: args.cwd, candidates: [template], total: 2, revision: 'r', warnings: [] }
          : { cwd: args.cwd, candidates: [project], total: 2, revision: 'r', warnings: scenario === 'bad-default' ? ['默认文件损坏，请重新选择。'] : [], nextCursor: { revision: 'r', offset: 1 }, ...(currentDefault ? { defaultSelection: currentDefault } : {}) }
      }
      if (command === 'system_content' && scenario === 'read-failure') throw { code: 'resource_unavailable', message: '文件已删除，请重新选择。' }
      if (command === 'system_content' && scenario.startsWith('body-')) return new Promise(resolve => { lateResolve = resolve })
      if (command === 'system_content') return { text: original, revision: 'body' }
      if (command === 'set_system_default') {
        assert.equal(args.id, 'chosen', 'The explicit save targets the user-selected A, not the other Client default B')
        if (scenario === 'save-failure') throw { code: 'system_default_unavailable', message: '无法保存，请检查目录权限。' }
        if (scenario === 'save-unknown') throw { code: 'effect_unknown', outcomeUnknown: true, operationId: 'save-1', message: '保存结果不确定。' }
        currentDefault = template
        return { selection: template }
      }
      if (command === 'create_work') {
        if ((scenario === 'save-trust' || scenario === 'legacy-trust') && !args.trustChallengeId) throw { code: 'project_trust_required', details: { operationId: 'create-1', challengeId: 'trust-1' } }
        if (scenario === 'save-create-unknown' || scenario === 'legacy-unknown') throw { code: 'effect_unknown', outcomeUnknown: true, operationId: 'create-1', message: '创建结果不确定。' }
        if (scenario === 'save-create-failure' || (scenario === 'save-default-changed' && calls.filter(call => call.command === 'create_work').length === 1)) throw { code: 'worker_start_failed', message: '文件无法读取，请检查后重试。' }
        return { id: 'created-work' }
      }
      throw new Error(`Unexpected IPC ${command}`)
    } }
    const container = node('root')
    const app = renderer.createApp({ render: () => h(NewWorkDialog, { ...props, onCreated: work => created.push(work), onUnknown: cause => { unknown.push(cause); props.outcomeUnknown = true }, onClose: () => app.unmount() }) })
    app.mount(container)
    const button = label => find(container, item => item.type === 'button' && (text(item).includes(label) || item.props['aria-label'] === label))
    const click = async label => { const target = button(label); assert.ok(target, `${scenario}: button ${label} exists`); assert.ok(!target.props.disabled, `${scenario}: ${label} enabled`); target.props.onClick(); await settle() }
    if (scenario === 'once') {
      await click('选择其他目录')
      await click('使用这个目录')
    } else await click('project')
    assert.equal(calls.find(c => c.command === 'system_catalog').args.targetHostId, 'target')
    if (scenario.startsWith('late-')) {
      if (scenario === 'late-directory') { await click('返回新建 Work'); await click('选择其他目录') }
      if (scenario === 'late-machine') props.machines = [{ ...props.machines[0], hostId: 'new-target' }]
      if (scenario === 'late-connection' || scenario === 'late-unsupported') store.catalog.selectionGeneration++
      if (scenario === 'late-close') await click('关闭')
      await settle()
      if (scenario === 'late-unsupported') lateReject({ code: 'capability_missing', details: { missing: ['system.templates.v1'] } })
      else lateResolve({ cwd: '/project', candidates: [template], total: 1, revision: 'r', warnings: [], defaultSelection: template })
      await settle()
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0, 'Old discovery cannot create in a changed or closed dialog')
      if (scenario !== 'late-close') app.unmount()
      continue
    }
    if (scenario.startsWith('legacy')) {
      assert.equal(calls.filter(c => c.command === 'create_work').length, 1, 'new Client uses ordinary creation when old Host lacks system selection')
      assert.equal(calls.find(c => c.command === 'create_work').args.workerConfig, null)
      assert.equal(calls.filter(c => c.command === 'set_system_default').length, 0)
      assert.ok(!text(container).includes('没有可用的 system'), 'unsupported feature is not an empty file list')
      if (scenario === 'legacy-trust') {
        await click('仅本次信任')
        const attempts = calls.filter(c => c.command === 'create_work')
        assert.equal(attempts.length, 2)
        assert.equal(attempts[1].args.operationId, 'create-1')
        assert.equal(attempts[1].args.trustChallengeId, 'trust-1')
        assert.ok(attempts.every(call => call.args.workerConfig == null))
      }
      if (scenario === 'legacy-unknown') {
        assert.equal(created.length, 0); assert.equal(unknown.length, 1)
        await settle()
        assert.equal(calls.filter(c => c.command === 'create_work').length, 1, 'unknown creation is never automatically replayed')
      } else assert.equal(created.length, 1)
      app.unmount(); continue
    }
    if (['partial-unsupported', 'catalog-failure', 'catalog-empty', 'other-capability-missing'].includes(scenario)) {
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0, 'only absence of the optional system capability allows ordinary creation')
      assert.equal(text(container).includes('没有可用的 system'), scenario === 'catalog-empty', 'empty state requires a successful empty catalog')
      app.unmount(); continue
    }
    if (scenario === 'default') {
      assert.equal(calls.find(c => c.command === 'create_work').args.workerConfig, null, 'Only Host creation resolves an implicit default')
      assert.equal(created.length, 1)
      assert.equal(calls.filter(c => c.command === 'set_system_default').length, 0)
      app.unmount(); continue
    }
    assert.equal(created.length, 0, 'Even a project SYSTEM is not a directory default')
    assert.ok(button('项目 SYSTEM')); assert.ok(button('选择的模板'))
    const checkbox = find(container, item => item.type === 'input' && item.props.type === 'checkbox')
    assert.equal(checkbox.checked, false)
    await click('选择的模板')
    await click('阅读 选择的模板')
    if (scenario.startsWith('body-')) {
      assert.equal(find(container, hasClass('new-work-back')), undefined, 'Reader owns the only back action')
      if (scenario === 'body-back') await click('返回 system 选择')
      if (scenario === 'body-close') await click('关闭')
      if (scenario === 'body-connection') store.catalog.selectionGeneration++
      await settle()
      lateResolve({ text: 'STALE BODY', revision: 'old' })
      await settle()
      assert.ok(!text(container).includes('STALE BODY'))
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0)
      if (scenario !== 'body-close') app.unmount()
      continue
    }
    if (scenario === 'read-failure') {
      assert.ok(button('确认并创建'), 'Unreadable preview returns to selection')
      assert.ok(text(container).includes('文件已删除'))
      assert.equal(button('选择的模板').props['aria-pressed'], true)
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0)
      app.unmount(); continue
    }
    const source = find(container, item => item.type === 'textarea')
    assert.equal(source.props.value, original, 'JSON preview opens raw original, fully read including BOM')
    await click('复制全文'); assert.equal(copied, original)
    assert.equal(calls.filter(c => c.command === 'create_work').length, 0, 'Reading cannot create Work')
    await click('返回 system 选择')
    assert.equal(button('选择的模板').props['aria-pressed'], true)
    if (scenario === 'refresh-unsupported') {
      await click('重新读取')
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0, 'refresh of an explicit selection cannot silently create with Host defaults')
      assert.ok(!text(container).includes('没有可用的 system'))
      app.unmount(); continue
    }
    if (scenario === 'once') {
      await click('重新读取')
      assert.equal(button('选择的模板').props['aria-pressed'], true, 'Refreshing keeps an available explicit choice')
    }
    if (scenario.startsWith('save-')) {
      const input = find(container, item => item.type === 'input' && item.props.type === 'checkbox')
      input.checked = true; input.change(); await settle()
    }
    await click('确认并创建')
    if (scenario === 'save-unknown') {
      // #326: an unconfirmed result is reported without locking the next explicit choice.
      assert.equal(unknown.length, 1); assert.equal(button('确认并创建').props.disabled, false)
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0)
    } else if (scenario === 'save-failure') {
      assert.equal(calls.filter(c => c.command === 'create_work').length, 0)
      assert.ok(text(container).includes('取消勾选'))
      // Card 271 blind review: surface the Host's action, not only a generic failure.
      assert.ok(text(container).includes('检查目录权限'), 'The user can see how to fix saving the default')
      const input = find(container, item => item.type === 'input' && item.props.type === 'checkbox')
      input.checked = false; input.change(); await settle()
      await click('确认并创建'); assert.equal(created.length, 1)
    } else if (scenario === 'save-create-unknown') {
      assert.equal(unknown.length, 1)
      assert.equal(button('确认并创建').props.disabled, false)
      assert.ok(text(container).includes('Work 是否创建成功尚不确定'))
      assert.ok(!text(container).includes('Work 尚未创建'))
      assert.ok(!text(container).includes('再确认创建'))
      assert.equal(calls.filter(c => c.command === 'create_work').length, 1)
    } else if (scenario === 'save-create-failure') {
      assert.ok(text(container).includes('目录默认已保存'))
      assert.ok(text(container).includes('Work 尚未创建'))
      assert.equal(created.length, 0)
      assert.equal(calls.filter(c => c.command === 'create_work').length, 1, 'Creation failure is not automatically replayed')
      await click('重新读取')
      assert.equal(calls.filter(c => c.command === 'create_work').length, 1, 'Reading the refreshed list cannot retry creation through its newly saved default')
      assert.equal(button('选择的模板').props['aria-pressed'], true)
      await click('确认并创建')
      assert.equal(calls.filter(c => c.command === 'create_work').length, 2, 'Retrying still requires explicit confirmation')
    } else if (scenario === 'save-default-changed') {
      // Card 271 blind review: another Client changes A to B after our save.
      currentDefault = project
      await click('重新读取')
      assert.equal(button('选择的模板').props['aria-pressed'], true)
      assert.equal(find(container, item => item.type === 'input' && item.props.type === 'checkbox').checked, true)
      assert.equal(created.length, 0, 'Refresh still cannot create Work')
      await click('确认并创建')
      assert.equal(currentDefault.id, 'chosen', 'An explicit save restores A as the next Work default, not just this Work source')
      assert.equal(created.length, 1)
    } else if (scenario === 'save-trust') {
      await click('仅本次信任')
      const attempts = calls.filter(c => c.command === 'create_work')
      assert.equal(attempts[1].args.operationId, 'create-1')
      assert.equal(attempts[1].args.trustChallengeId, 'trust-1')
      assert.deepEqual(attempts.map(c => c.args.workerConfig), [template.workerConfig, template.workerConfig])
      assert.equal(created.length, 1)
    } else assert.equal(created.length, 1)
    const creates = calls.filter(c => c.command === 'create_work')
    for (const call of creates) {
      assert.deepEqual(call.args.workerConfig, template.workerConfig, 'Active choice, not first candidate, reaches real bridge unchanged')
      assert.equal(call.args.targetHostId, 'target')
      assert.equal(call.args.connectionId, 'connection-a')
    }
    const saves = scenario === 'save-create-failure' || scenario === 'save-default-changed' ? 2 : scenario.startsWith('save-') ? 1 : 0
    assert.equal(calls.filter(c => c.command === 'set_system_default').length, saves, 'Trust continuation saves once; a new explicit confirmation saves its requested default again')
    app.unmount()
  }
  console.log('PASS: directory/recent → ordered selection → raw whole-file preview/copy → retained choice → once/save/failures/trust; stale discovery fenced; actual TS IPC payloads')

  // A closed browser shares the real Work prop with the shell. Content-only
  // snapshots must not enqueue native file cleanup on that hidden surface.
  await build({ root, configFile: false, logLevel: 'silent', plugins: [vue()],
    build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry: join(root, 'src/components/WorkspaceBrowser.vue'), formats: ['es'], fileName: () => 'workspace.mjs' }, rolldownOptions: { external: ['vue'] } } })
  const { default: WorkspaceBrowser } = await import(join(directory, 'workspace.mjs'))
  window.__TAURI_INTERNALS__.transformCallback = () => 1
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  const cleanup = []
  globalThis[stateKey] = { invoke: async (command) => {
    if (command === 'clear_workspace_file_state') cleanup.push(command)
    else assert.ok(command.startsWith('plugin:event|'), `unexpected native call: ${command}`)
    return 1
  } }
  const browserProps = reactive({ open: false, work: { id: 'work', lifecycle: 'active', runtimeGeneration: 1, cwd: '/project' }, context: { connectionId: 'host', selectionGeneration: 1 }, hostEpoch: 'epoch' })
  const browserApp = renderer.createApp({ render: () => h(WorkspaceBrowser, browserProps) })
  browserApp.mount(node('root'))
  await settle()
  const initialCleanup = cleanup.length
  browserProps.work = { ...browserProps.work, updatedAt: 'new-output' }
  await settle()
  assert.equal(cleanup.length, initialCleanup, 'closed Work prop reevaluation creates no native cleanup')
  browserProps.work = { ...browserProps.work, runtimeGeneration: 2 }
  await settle()
  assert.equal(cleanup.length, initialCleanup + 1, 'real resource identity change still cleans up')
  browserApp.unmount()
  await settle()
  console.log('PASS: closed WorkspaceBrowser / output prop isolation / native cleanup on real identity change')
} finally {
  delete globalThis[stateKey]
  await rm(directory, { recursive: true, force: true })
}
