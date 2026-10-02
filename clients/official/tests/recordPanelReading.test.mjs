// Card #347: a system prompt or model-context replacement panel reads its text only
// once the reader opens it. Mount the real ConversationView/ConversationRow and watch
// what the view asks for, instead of trusting the projection alone.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRenderer, h, nextTick, reactive } from 'vue'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(process.env.ALUDOCK_TEST_ARTIFACT_DIR ?? root, '.record-panel-'))

const element = (type, text = '') => ({ type, tagName: type.toUpperCase(), nodeType: type === '#text' ? 3 : 1, text, children: [], parent: null, props: {}, classList: { add() {}, remove() {} }, style: {}, dataset: {},
  addEventListener() {}, removeEventListener() {}, getBoundingClientRect() { return { top: 0, bottom: 300, left: 0, right: 700, height: 300, width: 700 } },
  getAttribute(name) { return this.props[name] }, setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] },
})
globalThis.HTMLElement = class { static [Symbol.hasInstance](item) { return typeof item?.tagName === 'string' } }
globalThis.document = { visibilityState: 'visible', activeElement: null, documentElement: { dataset: {}, style: {} }, body: { offsetHeight: 0 }, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: tag => element(tag) }
globalThis.window = { location: { search: '', href: 'http://fixture/aludock' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ lineHeight: '20px' }) }
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
// Every observed row counts as on screen: the only thing deciding a read is the panel state.
globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback } observe(target) { this.callback([{ target, isIntersecting: true }]) } unobserve(target) { this.callback([{ target, isIntersecting: false }]) } disconnect() {} }

const detach = item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1) }
const insert = (item, parent, anchor) => { detach(item); item.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, item) }
const renderer = createRenderer({ createElement: type => element(type), createText: text => element('#text', text), createComment: text => element('#comment', text), insert, remove: detach,
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value }, parentNode: item => item.parent,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null, setScopeId() {},
  insertStaticContent: (text, parent, anchor) => { const item = element('#static', text); insert(item, parent, anchor); return [item, item] },
})
const find = (item, predicate) => predicate(item) ? item : item.children.map(child => find(child, predicate)).find(Boolean)
const text = item => item.text + item.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 2)); await nextTick() }

let mounted
try {
  await writeFile(join(directory, 'entry.ts'), `export { default as ConversationView } from '${root}src/components/ConversationView.vue'; export { projectRecordGroups } from '${root}src/lib/conversation';`)
  await build({ root, configFile: false, logLevel: 'silent', build: { outDir: directory, emptyOutDir: false, minify: false,
    lib: { entry: join(directory, 'entry.ts'), formats: ['es'], fileName: () => 'view.mjs' }, rolldownOptions: { external: ['vue', 'pinia'] } },
    plugins: [{ name: 'browser-leaf', enforce: 'pre', resolveId(id) { if (id.endsWith('/MarkdownContent.vue')) return '\0markdown-leaf' }, load(id) {
      if (id === '\0markdown-leaf') return "import { h } from 'vue'; export default { props: ['source'], render() { return h('div', this.source) } };"
    } }, vue()],
  })
  const { ConversationView, projectRecordGroups } = await import(join(directory, 'view.mjs'))

  const record = (recordId, source, content, extra = {}) => ({ recordId, entryId: recordId, kind: 'message', source, visibility: 'conversation', content, ...extra })
  const items = projectRecordGroups([
    record('s1', 'system', [], { visibility: 'metadata', systemPrompt: { sections: ['preamble'], removedSections: [], toolsAdded: ['read'], toolsRemoved: [], blocks: [{ kind: 'section', name: 'preamble' }, { kind: 'tool', name: 'read' }] } }),
    record('c1', 'system', [{ type: 'text', text: '先前对话的摘要' }], { kind: 'compaction_summary' }),
    record('e1', 'runtime', [], { kind: 'custom', visibility: 'metadata', contextEdit: 'replace', targetEntryId: 'u0' }),
  ])
  const interests = []
  const retries = []
  const state = reactive({ loading: new Set(), errors: {} })
  const container = element('root')
  mounted = renderer.createApp({ render: () => h(ConversationView, {
    items, switching: false, streamingParts: new Set(), historyLoading: false, historyHydrating: false, historyTruncated: false, historyError: null, awayFromBottom: false,
    attachmentPreviews: {}, toolOpen: () => false, imageResource: () => ({ state: 'idle' }), holdReadingPosition: change => change(), restoringAnchorId: () => undefined,
    recordState: entryId => ({ loading: state.loading.has(entryId), error: state.errors[entryId] }),
    onReadInterest: ids => interests.push([...ids]), onRetryRecord: id => retries.push(id),
  }) })
  mounted.mount(container)
  await settle()

  const panel = id => find(container, item => item.type === 'details' && item.props['data-conversation-id'] === `record:${id}`)
  assert.ok(panel('s1') && panel('e1') && panel('c1'), 'the system prompt, replacement and summary panels are on screen')
  assert.deepEqual(interests.at(-1), ['c1'], 'on screen and folded: the summary is read as before, the system prompt and the replacement are not')
  assert.match(text(panel('s1')), /这条记录改了什么/, 'folded or not, the panel already says what the record changed')

  panel('s1').props.onToggle({ target: { open: true } })
  await settle()
  assert.deepEqual(interests.at(-1), ['s1', 'c1'], 'opening the system prompt panel asks for its text')
  state.loading = new Set(['s1'])
  await settle()
  assert.match(text(panel('s1')), /正在读取这条记录的全文/, 'the open panel says the text is being read')
  state.loading = new Set()
  state.errors = { s1: '这部分内容暂时无法读取，请重试。' }
  await settle()
  const retry = find(panel('s1'), item => item.type === 'button')
  assert.ok(retry && /重试/.test(text(retry)), 'a failed read shows the failure with a retry in the panel')
  retry.props.onClick()
  assert.deepEqual(retries, ['s1'], 'retry asks for this record again')

  panel('e1').props.onToggle({ target: { open: true } })
  await settle()
  assert.deepEqual(interests.at(-1), ['s1', 'c1', 'e1'], 'opening the replacement panel asks for its text')
  panel('s1').props.onToggle({ target: { open: false } })
  await settle()
  assert.deepEqual(interests.at(-1), ['c1', 'e1'], 'closing a panel withdraws the request')
  console.log('record panel reading tests passed')
} finally {
  mounted?.unmount()
  await rm(directory, { recursive: true, force: true })
}
