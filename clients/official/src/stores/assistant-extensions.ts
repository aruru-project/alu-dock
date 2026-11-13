import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import { getAssistantSettings, listTools, setAssistantSettings } from '../lib/bridge'
import { onceAfterLostReply } from '../lib/operationBinding'
import type { AssistantExtensionSettings, ToolsResult } from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'

interface ExtensionDraft { id: string; module: string; enabled: boolean; configText: string }
interface ExtensionEditor {
  current: AssistantExtensionSettings[] | null
  draft: ExtensionDraft[] | null
  loading: boolean
  error: string
  asked: number
  save: { state: 'pending' | 'saved' | 'failed'; message: string } | null
  tools: ToolsResult | null
  toolsLoading: boolean
  toolsAsked: number
  toolsError: string
}
const draftsOf = (items: AssistantExtensionSettings[]): ExtensionDraft[] => items.map(item => ({
  id: item.id, module: item.module, enabled: item.enabled, configText: JSON.stringify(item.config, null, 2),
}))

/** Only Main saves settings; this store retains the user's editor across closing or switching Host. */
export const useAssistantExtensionsStore = defineStore('assistant-extensions', () => {
  const app = useAppStore()
  const editors = reactive(new Map<string, ExtensionEditor>())
  const once = onceAfterLostReply()
  const subject = (connectionId: string) => [connectionId, 'assistant extensions']
  function forConnection(id: string): ExtensionEditor {
    if (!editors.has(id)) editors.set(id, { current: null, draft: null, loading: false, error: '', asked: 0, save: null, tools: null, toolsLoading: false, toolsAsked: 0, toolsError: '' })
    return editors.get(id)!
  }
  const editor = computed(() => forConnection(app.activeConnectionId ?? ''))
  const values = computed(() => editor.value.draft ?? draftsOf(editor.value.current ?? []))
  const work = computed(() => app.works.find(item => item.assistant))
  function edit(index: number, change: Partial<ExtensionDraft>) {
    const draft = values.value.map(item => ({ ...item }))
    draft[index] = { ...draft[index]!, ...change }
    editor.value.draft = draft
  }
  function add() { editor.value.draft = [...values.value, { id: '', module: '', enabled: true, configText: '{}' }] }
  function remove(index: number) { editor.value.draft = values.value.filter((_, at) => index !== at) }

  async function load() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context) return
    const entry = forConnection(context.connectionId)
    if (entry.save?.state === 'pending') return
    const asked = ++entry.asked
    entry.loading = true
    entry.error = ''
    try {
      const settings = await getAssistantSettings(context)
      if (asked !== entry.asked) return
      entry.current = settings.extensions ?? null
      once.known(subject(context.connectionId))
      if (!settings.extensions) entry.error = '这台 Dock 尚不支持助手扩展设置。请更新 Main 后再编辑。'
    } catch (cause) {
      if (asked === entry.asked) entry.error = userErrorMessage(cause, '暂时读不到扩展设置。请稍后重试。')
    } finally { if (asked === entry.asked) entry.loading = false }
  }

  async function save() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context || editor.value.save?.state === 'pending') return
    const entry = forConnection(context.connectionId)
    const submittedDraft = values.value.map(item => ({ ...item }))
    let submitted: AssistantExtensionSettings[]
    try {
      submitted = submittedDraft.map(item => {
        let config: unknown
        try { config = JSON.parse(item.configText) } catch { throw new Error(`扩展 ${item.id || '（未命名）'} 的配置不是有效 JSON，请修改后保存。`) }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`扩展 ${item.id || '（未命名）'} 的配置请填 JSON 对象，例如 {}。`)
        return { id: item.id.trim(), module: item.module.trim(), enabled: item.enabled, config: config as Record<string, unknown> }
      })
    } catch (cause) { entry.save = { state: 'failed', message: (cause as Error).message }; return }
    ++entry.asked // an earlier read cannot replace this save
    entry.loading = false
    entry.save = { state: 'pending', message: '正在保存…' }
    try {
      const saved = await once(subject(context.connectionId), submitted, operationId => setAssistantSettings({ extensions: submitted }, operationId, context))
      if (!saved.extensions) throw new Error('这台 Dock 尚不支持扩展设置，请更新 Main 后重试。')
      entry.current = saved.extensions
      if (JSON.stringify(entry.draft) === JSON.stringify(submittedDraft)) entry.draft = null
      entry.save = { state: 'saved', message: '已保存到 Main。请在助手空闲时使用对话里的 Reload，扩展启停和配置才会生效；对话会保留。' }
    } catch (cause) { entry.save = { state: 'failed', message: userErrorMessage(cause, '没有保存扩展设置，草稿还在。请稍后重试。') } }
  }

  async function loadTools() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    const instanceId = work.value?.id
    if (!context || !instanceId) return
    const entry = forConnection(context.connectionId)
    const asked = ++entry.toolsAsked
    entry.toolsLoading = true
    entry.toolsError = ''
    try {
      const tools = await listTools(instanceId, context)
      if (asked === entry.toolsAsked) entry.tools = tools
    } catch (cause) {
      if (asked === entry.toolsAsked) entry.toolsError = userErrorMessage(cause, '暂时读不到助手的实际工具。请稍后刷新。')
    } finally { if (asked === entry.toolsAsked) entry.toolsLoading = false }
  }

  return { editor, values, work, edit, add, remove, load, save, loadTools }
})
