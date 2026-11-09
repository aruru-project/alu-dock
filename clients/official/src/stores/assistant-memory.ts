import { defineStore } from 'pinia'
import { computed, reactive, watch } from 'vue'
import { memoryTopicLabel } from '../lib/assistant'
import { useConversationReading } from '../lib/assistantReading'
import {
  addAssistantMemory, getAssistantMemory, getAssistantSettings, listAssistantMemories, reorganizeAssistant, setAssistantSettings, updateAssistantMemory,
} from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { onceAfterLostReply, replyLost } from '../lib/operationBinding'
import type {
  AssistantMemory, AssistantMemoryChange, AssistantMemoryEdit, AssistantMemoryFilter, AssistantMemorySource,
  AssistantMemoryTopic, AssistantSettings, ModelRef,
} from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'
import { useAssistantStore } from './assistant'
import { useModelCatalogStore } from './model-catalog'

/** What the memory list shows: the newest first, one topic, or those set aside. */
export type MemoryView = 'recent' | 'topics' | 'retired' | 'forgotten'
/** One change asked for from a memory's page. */
export type MemoryChangeKind = 'text' | 'topic' | 'resident' | 'retired' | 'forgotten' | 'active'

/** A memory the owner is writing, kept until it is saved or dropped. */
export interface MemoryDraft {
  open: boolean
  topic: AssistantMemoryTopic
  text: string
  resident: boolean
  save: null | { state: 'pending' | 'failed'; message: string }
}

const PAGE = 30
const LOST = '连接中断，没收到结果。请稍后再试。'
// Main's own wording for a request it cannot read names fields; the length is checked before sending.
const NOT_TAKEN = 'Main 没有收下这次的内容，什么都没有改。请稍后重试。'

function errorCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
}
/** A newer revision of the same memory; revisions only go up. */
function newer(memory: AssistantMemory, than: AssistantMemory | null | undefined) {
  return !than || memory.revision >= than.revision
}

/**
 * Her memories on Main (card #295): the list being browsed, the memory open, changes to it, one
 * the owner is writing, where a memory was said, and the model that makes memories. Lists and
 * the open memory belong to the connection they were read from; what the owner is typing is
 * kept per connection, so closing the page or switching sections keeps it.
 */
export const useAssistantMemoryStore = defineStore('assistant-memory', () => {
  const app = useAppStore()
  const assistant = useAssistantStore()
  const catalog = useModelCatalogStore()
  const extraction = computed(() => assistant.info?.extraction)
  /** How long one memory may be, as Main says; 0 until it is known. */
  const memoryLimit = computed(() => assistant.info?.maxMemoryChars ?? 0)
  /** What is saved is the text without the spaces around it, counted as Main counts it. */
  const tooLong = (text: string) => memoryLimit.value > 0 && text.trim().length > memoryLimit.value

  const once = onceAfterLostReply()

  // ── The list ──
  const list = reactive({
    view: 'recent' as MemoryView,
    topic: 'owner' as AssistantMemoryTopic,
    /** Words in the search box; the list follows them once submitted. */
    query: '',
    /** What the list shows; reading more continues it. */
    shown: null as null | { connectionId: string; view: MemoryView; filter: AssistantMemoryFilter },
    memories: [] as AssistantMemory[],
    nextCursor: undefined as string | undefined,
    loading: false,
    loadingMore: false,
    error: '',
    moreError: '',
    /** What became of a memory written here. */
    notice: '',
    /** A change that failed after its memory's page was left. */
    failure: '',
  })
  let listEpoch = 0

  function filterFor(view: MemoryView, topic: AssistantMemoryTopic, query: string): AssistantMemoryFilter {
    const words = query.trim()
    return {
      ...(words ? { query: words } : {}),
      ...(view === 'topics' ? { topic } : {}),
      ...(view === 'retired' || view === 'forgotten' ? { state: view } : {}),
    }
  }

  /** Reads the first page of what the list is set to; the same list stays shown while it is read again. */
  async function loadMemories() {
    const context = app.connectionContext
    if (!context) return
    const epoch = ++listEpoch
    const shown = { connectionId: context.connectionId, view: list.view, filter: filterFor(list.view, list.topic, list.query) }
    if (JSON.stringify(shown) !== JSON.stringify(list.shown)) Object.assign(list, { shown: null, memories: [], nextCursor: undefined })
    list.loading = true
    list.error = ''
    list.moreError = ''
    try {
      const page = await currentConnectionCall(app, (ctx) => listAssistantMemories(shown.filter, undefined, PAGE, ctx))
      if (epoch !== listEpoch) return
      Object.assign(list, { shown, memories: page.memories, nextCursor: page.nextCursor })
    } catch (cause) {
      if (epoch === listEpoch) list.error = userErrorMessage(cause, '暂时读不到她的记忆。请稍后重试。')
    } finally {
      if (epoch === listEpoch) list.loading = false
    }
  }

  async function moreMemories() {
    const shown = list.shown
    const cursor = list.nextCursor
    if (!shown || !cursor || list.loading || list.loadingMore || shown.connectionId !== app.activeConnectionId) return
    const epoch = listEpoch
    list.loadingMore = true
    list.moreError = ''
    try {
      const page = await currentConnectionCall(app, (ctx) => listAssistantMemories(shown.filter, cursor, PAGE, ctx))
      if (epoch !== listEpoch) return
      list.memories = [...list.memories, ...page.memories]
      list.nextCursor = page.nextCursor
    } catch (cause) {
      if (epoch === listEpoch) list.moreError = userErrorMessage(cause, '没有读到更多记忆。请重试。')
    } finally {
      if (epoch === listEpoch) list.loadingMore = false
    }
  }

  function showView(view: MemoryView) {
    list.view = view
    list.notice = ''
    list.failure = ''
    closeMemory()
    void loadMemories()
  }

  function showTopic(topic: AssistantMemoryTopic) {
    list.topic = topic
    list.notice = ''
    void loadMemories()
  }

  /** A memory read or changed here replaces the one the list shows, unless the list's is newer. */
  function replaceInList(memory: AssistantMemory) {
    const index = list.memories.findIndex((item) => item.id === memory.id)
    if (index >= 0 && newer(memory, list.memories[index])) list.memories.splice(index, 1, memory)
  }

  // ── One memory ──
  const detail = reactive({
    /** The memory shown, known by its number before it is read. */
    id: null as string | null,
    memory: null as AssistantMemory | null,
    /** Its latest changes, newest first. */
    history: [] as AssistantMemoryChange[],
    loading: false,
    error: '',
    change: null as null | {
      kind: MemoryChangeKind
      state: 'pending' | 'done' | 'failed'
      message: string
      /** Deleting was refused because what it says lives on in the memory it was merged into. */
      mergedInto?: string
    },
  })
  let detailEpoch = 0
  /** Rewrites being typed, per connection and memory. */
  const rewrites = reactive(new Map<string, string>())
  const rewriteKey = (connectionId: string, id: string) => JSON.stringify([connectionId, id])
  const rewrite = computed(() => detail.id ? rewrites.get(rewriteKey(app.activeConnectionId ?? '', detail.id)) ?? null : null)

  const sourceReading = useConversationReading(app, { failure: '暂时读不到这段原话。请重试。', notFound: '这段原话已经找不到了。' })

  /** Opens a memory from the list, or one known only by its number, such as the one another was merged into. */
  function openMemory(memory: AssistantMemory | string) {
    const id = typeof memory === 'string' ? memory : memory.id
    list.failure = ''
    sourceReading.close()
    Object.assign(detail, { id, memory: typeof memory === 'string' ? null : memory, history: [], error: '', change: null })
    void readMemory(id)
  }

  function closeMemory() {
    detailEpoch++
    sourceReading.close()
    // A rewrite left as it started is no draft.
    if (detail.memory && rewrite.value === detail.memory.text) cancelRewrite()
    Object.assign(detail, { id: null, memory: null, history: [], loading: false, error: '', change: null })
  }

  async function readMemory(id: string) {
    const epoch = ++detailEpoch
    detail.loading = true
    detail.error = ''
    try {
      const read = await currentConnectionCall(app, (ctx) => getAssistantMemory(id, ctx))
      if (epoch !== detailEpoch || detail.id !== id) return
      if (newer(read.memory, detail.memory)) {
        detail.memory = read.memory
        detail.history = read.history
      }
      replaceInList(read.memory)
    } catch (cause) {
      if (epoch === detailEpoch && detail.id === id) detail.error = userErrorMessage(cause, '暂时读不到这条记忆的改动记录。请重试。')
    } finally {
      if (epoch === detailEpoch) detail.loading = false
    }
  }

  function startRewrite() {
    if (detail.memory) rewrites.set(rewriteKey(app.activeConnectionId ?? '', detail.memory.id), detail.memory.text)
  }
  function editRewrite(text: string) {
    if (detail.id) rewrites.set(rewriteKey(app.activeConnectionId ?? '', detail.id), text)
  }
  function cancelRewrite() {
    if (detail.id) rewrites.delete(rewriteKey(app.activeConnectionId ?? '', detail.id))
  }
  /** A rewrite of this memory waits unsaved; the list marks it so it can be found again. */
  function hasRewrite(id: string) {
    return rewrites.has(rewriteKey(app.activeConnectionId ?? '', id))
  }

  const CHANGE_NAMES: Record<MemoryChangeKind, string> = { text: '改写', topic: '换分类', resident: '改用法', retired: '作废', forgotten: '删除', active: '恢复' }

  /** `before` is the memory as it was shown when the change was asked for. */
  function doneMessage(kind: MemoryChangeKind, memory: AssistantMemory, before: AssistantMemory) {
    if (kind === 'text') return '已改写。'
    if (kind === 'topic') return `已移到「${memoryTopicLabel(memory.topic)}」。`
    // Choosing counts even when it stays the same: the background no longer changes it.
    if (kind === 'resident' && memory.resident === before.resident) return `已定下：${memory.resident ? '每次都带上' : '她查的时候才用'}。后台整理不会再改这一项。`
    if (kind === 'resident') return memory.resident
      ? '已改成每次都带上：新开的助手会话会读到它，后台整理不会再改这一项。'
      : '已改成她查的时候才用：新开的助手会话不再带上它，后台整理不会再改这一项。'
    if (kind === 'retired') return '已作废：她不再用这条，记录还留着，可以恢复。'
    if (kind === 'forgotten') return '已删除：她会忘掉这条，不再载入，原话也搜不到。可以在「已删除」里恢复。'
    return '已恢复：她又会用这条了。'
  }

  /** Changes the open memory from the version shown; one changed meanwhile is refused and read again. */
  async function changeMemory(kind: MemoryChangeKind, edit: AssistantMemoryEdit) {
    const memory = detail.memory
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!memory || !context || detail.change?.state === 'pending' || (edit.text !== undefined && tooLong(edit.text))) return
    const here = () => context.connectionId === app.activeConnectionId && detail.id === memory.id
    detail.change = { kind, state: 'pending', message: '正在保存…' }
    try {
      const changed = await once([context.connectionId, 'update', memory.id, memory.revision, edit],
        (operationId) => updateAssistantMemory(memory.id, memory.revision, edit, operationId, context))
      if (kind === 'text') rewrites.delete(rewriteKey(context.connectionId, memory.id))
      if (context.connectionId !== app.activeConnectionId) return
      replaceInList(changed)
      if (!here()) return
      if (newer(changed, detail.memory)) detail.memory = changed
      detail.change = { kind, state: 'done', message: doneMessage(kind, changed, memory) }
      void readMemory(memory.id)
    } catch (cause) {
      if (context.connectionId !== app.activeConnectionId) return
      const code = errorCode(cause)
      const message = replyLost(cause) ? LOST
        : code === 'invalid_request' ? NOT_TAKEN
          : userErrorMessage(cause, '没有改成。请稍后重试。')
      if (!here()) {
        // Its page was left meanwhile; the list says it once.
        const characters = Array.from(memory.text)
        const excerpt = characters.length > 16 ? `${characters.slice(0, 16).join('')}…` : memory.text
        list.failure = `「${excerpt}」的${CHANGE_NAMES[kind]}没有完成：${message}`
        return
      }
      detail.change = { kind, state: 'failed', message, ...(code === 'assistant_memory_merged' && memory.supersededBy ? { mergedInto: memory.supersededBy } : {}) }
      // Changed first by her or the background: show what it is now; a rewrite being typed stays.
      if (code === 'assistant_memory_changed') void readMemory(memory.id)
    }
  }

  function openSource(source: AssistantMemorySource) {
    void sourceReading.open({ sessionId: source.sessionId, entryId: source.entryId })
  }

  // ── A memory the owner writes ──
  const drafts = reactive(new Map<string, MemoryDraft>())
  const blankDraft = (): MemoryDraft => ({ open: false, topic: 'owner', text: '', resident: false, save: null })
  function draftFor(connectionId: string) {
    if (!drafts.has(connectionId)) drafts.set(connectionId, blankDraft())
    return drafts.get(connectionId)!
  }
  /** The current connection's draft, for display; reading never creates one. */
  const draft = computed(() => drafts.get(app.activeConnectionId ?? '') ?? null)
  /** Text typed here and not saved, on this connection: her page and the sidebar say so. */
  const hasDrafts = computed(() => {
    const connectionId = app.activeConnectionId ?? ''
    return !!draft.value?.text.trim() || [...rewrites.keys()].some((key) => (JSON.parse(key) as string[])[0] === connectionId)
  })

  function startWriting() {
    const entry = draftFor(app.activeConnectionId ?? '')
    if (!entry.open && !entry.text && list.view === 'topics') entry.topic = list.topic
    entry.open = true
    list.notice = ''
  }
  function editDraft(change: Partial<Pick<MemoryDraft, 'topic' | 'text' | 'resident'>>) {
    const entry = draftFor(app.activeConnectionId ?? '')
    if (entry.save?.state !== 'pending') Object.assign(entry, change)
  }
  function dropDraft() {
    const entry = draftFor(app.activeConnectionId ?? '')
    if (entry.save?.state !== 'pending') Object.assign(entry, blankDraft())
  }

  async function writeMemory() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context) return
    const entry = draftFor(context.connectionId)
    const memory = { topic: entry.topic, text: entry.text.trim(), resident: entry.resident }
    if (!memory.text || tooLong(memory.text) || entry.save?.state === 'pending') return
    entry.save = { state: 'pending', message: '正在保存…' }
    try {
      const added = await once([context.connectionId, 'add', memory], (operationId) => addAssistantMemory(memory, operationId, context))
      Object.assign(entry, blankDraft())
      if (context.connectionId !== app.activeConnectionId) return
      const shown = list.shown
      // It is the newest memory, so it heads a list it belongs to.
      const fits = !!shown && !shown.filter.query && !shown.filter.state && (shown.view === 'recent' || shown.filter.topic === added.topic)
      if (fits && !list.memories.some((item) => item.id === added.id)) list.memories.unshift(added)
      list.notice = fits ? '已记下。' : `已记下，在「最近记住的」和「${memoryTopicLabel(added.topic)}」里能看到。`
    } catch (cause) {
      const message = replyLost(cause) ? LOST : errorCode(cause) === 'invalid_request' ? NOT_TAKEN : userErrorMessage(cause, '没有保存成功。请稍后重试。')
      entry.save = { state: 'failed', message: `${message}写的内容还在。` }
    }
  }

  // ── The model that makes her memories ──
  const settings = reactive({
    /** What Main has chosen, as last read or saved here. */
    current: null as AssistantSettings | null,
    loading: false,
    error: '',
    save: null as null | { state: 'pending' | 'saved' | 'failed'; model: ModelRef | null; message: string },
  })
  let settingsEpoch = 0

  async function loadSettings() {
    if (!app.connectionContext || settings.save?.state === 'pending') return
    const epoch = ++settingsEpoch
    settings.loading = true
    settings.error = ''
    try {
      const read = await currentConnectionCall(app, getAssistantSettings)
      if (epoch !== settingsEpoch) return
      // What Main has now replaces the outcome of an earlier save.
      settings.current = read
      settings.save = null
    } catch (cause) {
      if (epoch === settingsEpoch) settings.error = userErrorMessage(cause, '暂时读不到助手设置。请稍后重试。')
    } finally {
      if (epoch === settingsEpoch) settings.loading = false
    }
  }

  /** Saves the choice at once; `null` stops making memories. How it then stands is read again. */
  async function chooseModel(model: ModelRef | null) {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context || settings.save?.state === 'pending') return
    // A read still on its way is older than this choice.
    const epoch = ++settingsEpoch
    settings.loading = false
    settings.save = { state: 'pending', model, message: '正在保存…' }
    if (restart.state !== 'pending') Object.assign(restart, { state: 'idle', message: '' })
    try {
      const saved = await once([context.connectionId, 'settings', model], (operationId) => setAssistantSettings(model, operationId, context))
      if (epoch !== settingsEpoch) return
      settings.current = saved
      settings.save = { state: 'saved', model, message: saved.extractionModel
        ? '已保存。她会用这个模型从对话里记下值得记住的事。'
        : '已停止整理。她不会再从对话里自动记东西，已经记下的都还在。' }
    } catch (cause) {
      if (epoch !== settingsEpoch) return
      settings.save = { state: 'failed', model, message: replyLost(cause) ? LOST : userErrorMessage(cause, '没有保存成功，设置没有变。请稍后重试。') }
    }
    void assistant.loadInfo()
  }

  // ── Starting over with the chosen model ──
  const restart = reactive({
    /** `confirming` while the owner reads what starting over does. */
    state: 'idle' as 'idle' | 'confirming' | 'pending' | 'done' | 'failed',
    message: '',
  })
  function askRestart() {
    if (settings.current?.extractionModel && restart.state !== 'pending') Object.assign(restart, { state: 'confirming', message: '' })
  }
  function cancelRestart() {
    if (restart.state === 'confirming') Object.assign(restart, { state: 'idle', message: '' })
  }
  /** What the background made is set aside and every conversation is read again with the chosen model. */
  async function startOver() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    const chosen = settings.current?.extractionModel
    if (!context || !chosen || restart.state === 'pending') return
    const model = { provider: chosen.provider, id: chosen.id }
    Object.assign(restart, { state: 'pending', message: '正在开始从头整理…' })
    try {
      const result = await once([context.connectionId, 'reorganize', model], (operationId) => reorganizeAssistant(model, operationId, context))
      if (context.connectionId !== app.activeConnectionId) return
      settings.current = { extractionModel: result.extractionModel }
      Object.assign(restart, {
        state: 'done',
        message: `已开始从头整理：后台整理出的 ${result.retiredMemories} 条记忆挪进了「已作废」，它写的 ${result.removedLines} 行时间线清掉了。她正在把所有对话从头读一遍，读完之前，新开的会话里记忆不全。`,
      })
      if (list.shown) void loadMemories()
    } catch (cause) {
      if (context.connectionId !== app.activeConnectionId) return
      Object.assign(restart, { state: 'failed', message: replyLost(cause) ? LOST : userErrorMessage(cause, '没能开始从头整理，记忆和时间线都没有动。请稍后重试。') })
    }
    void assistant.loadInfo()
  }

  /** Main's models, the same list a new Work on Main offers; read once and kept, refreshed on request. */
  const models = computed(() => catalog.forTarget(app.activeConnectionId ?? '', undefined))
  async function loadModels(fresh = false) {
    if (fresh && models.value?.state === 'loading') return
    try {
      await currentConnectionCall(app, (context) => catalog.read(context, undefined, fresh))
    } catch {
      // The section shows the outcome from the shared catalog.
    }
  }

  // Lists, the open memory and the settings belong to the connection they were read from.
  watch(() => app.activeConnectionId, () => {
    listEpoch++
    settingsEpoch++
    Object.assign(list, { shown: null, memories: [], nextCursor: undefined, loading: false, loadingMore: false, error: '', moreError: '', notice: '', failure: '' })
    closeMemory()
    Object.assign(settings, { current: null, loading: false, error: '', save: null })
    Object.assign(restart, { state: 'idle', message: '' })
  })

  return {
    extraction, memoryLimit,
    list, loadMemories, moreMemories, showView, showTopic,
    detail, rewrite, hasRewrite, openMemory, closeMemory, readMemory, startRewrite, editRewrite, cancelRewrite, changeMemory,
    source: sourceReading.state, openSource, readSourceMore: sourceReading.readMore, closeSource: sourceReading.close,
    draft, hasDrafts, startWriting, editDraft, dropDraft, writeMemory,
    settings, loadSettings, chooseModel, models, loadModels,
    restart, askRestart, cancelRestart, startOver,
  }
})
