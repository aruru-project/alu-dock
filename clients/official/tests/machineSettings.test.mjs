// Card 339: Host 设置 hides models per machine. Real Vue page, stores and TS bridge; only native IPC is a fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, reactive, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(root, '.machine-settings-check-'))
const stateKey = '__aluMachineSettingsCheck'
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, value: '',
  focus() {}, select() {}, addEventListener(name, handler) { this[name] = handler }, removeEventListener() {},
  querySelectorAll() { return [] }, querySelector() { return null },
})
const detach = (item) => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1) }
const insert = (item, parent, anchor) => {
  detach(item); item.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
}
const renderer = createRenderer({
  createElement: (tag) => node(tag), createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text), insert, remove: detach,
  setText: (item, text) => { item.text = text },
  setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  parentNode: (item) => item.parent,
  nextSibling: (item) => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
  setScopeId() {},
  insertStaticContent: (text, parent, anchor) => { const item = node('#static', text); insert(item, parent, anchor); return [item, item] },
})
const find = (item, predicate) => predicate(item) ? item : item.children.map((child) => find(child, predicate)).find(Boolean)
const findAll = (item, predicate) => [...(predicate(item) ? [item] : []), ...item.children.flatMap((child) => findAll(child, predicate))]
const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await nextTick() }
globalThis.document = { title: '', activeElement: null, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { clearTimeout, setTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 0),
  history: { pushState() {}, go() {} }, addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ overflowY: 'visible' }),
  __TAURI_INTERNALS__: { invoke: (command, args) => globalThis[stateKey].invoke(command, args) } }
globalThis.HTMLElement = class {}

const catalog = ['azure-openai-responses', 'openai', 'openai-codex'].flatMap(provider => [
  { provider, id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true },
  { provider, id: 'gpt-4.1', name: 'GPT-4.1', reasoning: false },
])
const machines = [
  { hostId: 'main', name: '工作站', kind: 'main', available: true, platform: 'linux' },
  { hostId: 'laptop', name: '笔记本', kind: 'subhost', available: true, platform: 'windows' },
]

try {
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `export { default } from '../src/components/MachineSettings.vue'; export { useAppStore } from '../src/stores/app'; export { useSurfacesStore } from '../src/stores/surfaces';`)
  await build({ root, configFile: false, logLevel: 'silent',
    build: { outDir: directory, emptyOutDir: false, minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'component.mjs' },
      rolldownOptions: { external: ['vue', 'pinia'] },
    },
    plugins: [vue()],
  })
  const { default: MachineSettings, useAppStore, useSurfacesStore } = await import(join(directory, 'component.mjs'))

  async function open(scenario) {
    setActivePinia(createPinia())
    const app = useAppStore()
    globalThis[stateKey] = { invoke: async command => {
      if (command === 'get_host_catalog') return { revision: 1, selectionGeneration: 1, hosts: [], activeTarget: { kind: 'host', hostId: 'connection-a' } }
      if (command === 'bootstrap') return { connectionId: 'connection-a', selectionGeneration: 1, host: { hostEpoch: 'epoch-a' }, works: [], total: 0 }
      throw new Error(`Unexpected native setup call: ${command}`)
    } }
    await app.load()
    const surfaces = useSurfacesStore()
    const calls = [], dirty = []
    let finishSave
    const saved = { laptop: [{ provider: 'azure-openai-responses', id: 'gpt-4.1' }, { provider: 'retired', id: 'old-model' }], main: [] }
    globalThis[stateKey] = { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'model_visibility') {
        if (scenario === 'old-subhost') throw { code: 'capability_missing', message: 'Required capabilities are unavailable', details: { missing: ['model.visibility.v1'] } }
        return { models: catalog, total: catalog.length, truncated: false, hidden: scenario === 'broken-file' ? [] : saved[args.targetHostId],
          ...(scenario === 'broken-file' ? { fileProblem: 'model-visibility.json 不是有效的 JSON' } : {}) }
      }
      if (command === 'set_model_visibility') {
        if (scenario === 'save-unknown') throw { code: 'effect_unknown', outcomeUnknown: true, message: 'fixture' }
        if (scenario === 'slow-save') await new Promise(resolve => { finishSave = resolve })
        saved[args.targetHostId] = args.hidden
        return { hidden: args.hidden }
      }
      throw new Error(`Unexpected IPC ${command}`)
    } }
    const props = reactive({ machines, machinesLoading: false, initialHostId: 'laptop' })
    surfaces.openMachineSettings('laptop')
    const container = node('root')
    // Same wiring as PageDialogs: the page reports unsaved edits, the surfaces store guards closing.
    const view = renderer.createApp({ render: () => h(MachineSettings, { ...props, onDirty: value => { dirty.push(value); surfaces.machineSettingsDirty = value }, onBusy: value => { surfaces.machineSettingsBusy = value }, onClose: () => surfaces.closeModal() }) })
    view.mount(container); await settle()
    const button = label => find(container, item => item.type === 'button' && (text(item).includes(label) || item.props.title === label || item.props['aria-label'] === label))
    const click = async label => { const target = button(label); assert.ok(target, `${scenario}: button ${label} exists`); assert.ok(!target.props.disabled, `${scenario}: ${label} is enabled`); target.props.onClick(); await settle() }
    const filter = async (label, value) => { const input = find(container, item => item.type === 'input' && item.props['aria-label'] === label); input.value = value; input.input({ target: input }); await settle() }
    const column = label => find(container, item => item.type === 'section' && item.props['aria-label'] === label)
    const rows = label => findAll(column(label), item => item.type === 'button' && String(item.props.class).includes('model-row')).map(text)
    return { view, container, surfaces, calls, dirty, saved, click, button, filter, rows, finishSave: () => finishSave() }
  }

  {
    const page = await open('normal')
    assert.equal(page.calls[0].args.targetHostId, 'laptop', 'opened from a Work on the laptop, the page edits the laptop')
    assert.equal(page.rows('显示中的模型').length, 5)
    assert.deepEqual(page.rows('已隐藏的模型').map(row => row.includes('当前不可用')), [false, true], 'a hidden model the machine cannot select is kept and marked')

    // Hide every Azure model at once, then bring one back.
    await page.filter('过滤显示中的模型', 'azure')
    await page.click('隐藏筛选出的 1 个')
    assert.ok(text(page.container).includes('已改动 1 项'))
    await page.filter('过滤显示中的模型', '')
    await page.click('隐藏 openai/gpt-4.1')
    await page.click('恢复显示 openai/gpt-4.1')
    assert.equal(page.dirty.at(-1), true)
    await page.click('保存')
    const save = page.calls.find(call => call.command === 'set_model_visibility')
    assert.equal(save.args.targetHostId, 'laptop')
    assert.deepEqual(new Set(save.args.hidden.map(model => `${model.provider}/${model.id}`)), new Set(['azure-openai-responses/gpt-4.1', 'retired/old-model', 'azure-openai-responses/gpt-5.6']))
    assert.ok(text(page.container).includes('已保存'))
    assert.equal(page.dirty.at(-1), false)

    // Switching machines with unsaved edits asks first; each machine keeps its own list.
    await page.click('隐藏 openai/gpt-5.6')
    const chooseMain = async () => {
      find(page.container, item => item.type === 'button' && item.props['aria-label'] === '选择机器').props.onClick(); await settle()
      await page.click('工作站 · Main')
    }
    await chooseMain()
    assert.ok(page.surfaces.confirmDialog, 'unsaved edits are not dropped silently')
    page.surfaces.settleConfirm(false); await settle()
    assert.ok(text(page.container).includes('笔记本 · SubHost'), 'declining stays on the laptop')
    assert.ok(page.rows('已隐藏的模型').some(row => row.includes('openai/gpt-5.6')), 'declining keeps the unsaved edit')
    await chooseMain()
    page.surfaces.settleConfirm(true); await settle()
    assert.equal(page.calls.at(-1).args.targetHostId, 'main')
    assert.equal(page.rows('已隐藏的模型').length, 0, 'Main has its own, empty list')
    page.view.unmount()
  }

  // Closing with unsaved edits asks first; Esc/close cannot silently drop them.
  {
    const page = await open('normal')
    await page.click('隐藏 openai/gpt-5.6')
    await page.click('关闭')
    assert.ok(page.surfaces.confirmDialog, 'closing unsaved edits asks first')
    page.surfaces.settleConfirm(false); await settle()
    assert.equal(page.surfaces.machineSettingsOpen, true, 'keeping the edits keeps the page open')
    await page.click('关闭')
    page.surfaces.settleConfirm(true); await settle()
    assert.equal(page.surfaces.machineSettingsOpen, false)
    page.view.unmount()
  }

  // A save already sent changes the Host either way: closing waits for it instead of claiming the edits are lost.
  {
    const page = await open('slow-save')
    await page.click('隐藏 openai/gpt-5.6')
    await page.click('保存')
    page.button('关闭').props.onClick(); await settle()
    assert.equal(page.surfaces.confirmDialog, null, 'no "discard" question while the save is on its way')
    assert.equal(page.surfaces.machineSettingsOpen, true, 'the page stays until the save answers')
    page.finishSave(); await settle()
    assert.ok(text(page.container).includes('已保存'))
    await page.click('关闭')
    assert.equal(page.surfaces.confirmDialog, null)
    assert.equal(page.surfaces.machineSettingsOpen, false)
    page.view.unmount()
  }

  // A machine still on an older Alu Dock says so instead of showing an empty list.
  {
    const page = await open('old-subhost')
    assert.ok(text(page.container).includes('请更新对应机器上的 Dock'))
    page.view.unmount()
  }

  // A broken hand-edited file is explained and can be repaired by saving without other edits.
  {
    const page = await open('broken-file')
    assert.ok(text(page.container).includes('model-visibility.json 不是有效的 JSON'))
    await page.click('保存')
    assert.deepEqual(page.calls.find(call => call.command === 'set_model_visibility').args.hidden, [])
    page.view.unmount()
  }

  // An unconfirmed save keeps the edits and says saving again is safe.
  {
    const page = await open('save-unknown')
    await page.click('隐藏 openai/gpt-5.6')
    await page.click('保存')
    assert.ok(text(page.container).includes('再点一次保存不会出问题'))
    assert.ok(text(page.container).includes('已隐藏') && page.rows('已隐藏的模型').some(row => row.includes('openai/gpt-5.6')), 'the unsaved edit is still shown')
    page.view.unmount()
  }
  console.log('PASS: Host 设置 model visibility page')
} finally {
  delete globalThis[stateKey]
  await rm(directory, { recursive: true, force: true })
}
