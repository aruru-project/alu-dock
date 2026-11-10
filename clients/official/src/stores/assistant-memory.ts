import { defineStore } from 'pinia'
import { computed, reactive, watch } from 'vue'
import { excerpt, memoryResidentLabel, memoryTopicLabel } from '../lib/assistant'
import { useConversationReading } from '../lib/assistantReading'
import {
  addAssistantMemory, getAssistantMemory, getAssistantSettings, listAssistantMemories, reorganizeAssistant, setAssistantSettings, updateAssistantMemory,
} from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { modelKey } from '../lib/modelLists'
import { useNextPage } from '../lib/nextPage'
import { onceAfterLostReply } from '../lib/operationBinding'
import type {
  AssistantMemory, AssistantMemoryChange, AssistantMemoryEdit, AssistantMemoryFilter, AssistantMemorySource,
  AssistantMemoryTopic, AssistantSettings, ModelRef,
} from '../lib/types'
import { errorCode, userErrorMessage } from '../lib/userError'
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
// Main's own wording for a request it cannot read names fields; the length is checked before sending.
const NOT_TAKEN = 'Main 没有收下这次的内容，什么都没有改。请稍后重试。'

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
    error: '',
    /** What became of a memory written here. */
    notice: '',
    /** A change that failed after its memory's page was left. */
    failure: '',
  })
  let listEpoch = 0
  const more = useNextPage('没有读到更多记忆。请重试。')

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
    more.startOver()
    list.loading = true
    list.error = ''
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
    if (!shown || !cursor || list.loading || shown.connectionId !== app.activeConnectionId) return
    await more.read(() => currentConnectionCall(app, (ctx) => listAssistantMemories(shown.filter, cursor, PAGE, ctx)), (page) => {
      list.memories = [...list.memories, ...page.memories]
      list.nextCursor = page.nextCursor
    })
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
    const connectionId = app.activeConnectionId
    const epoch = ++detailEpoch
    detail.loading = true
    detail.error = ''
    try {
      const read = await currentConnectionCall(app, (ctx) => getAssistantMemory(id, ctx))
      if (epoch !== detailEpoch || detail.id !== id) return
      once.known([connectionId, 'memory', id])
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
    if (kind === 'resident' && memory.resident === before.resident) return `已定下：${memoryResidentLabel(memory.resident)}。后台整理不会再改这一项。`
    if (kind === 'resident') return memory.resident
      ? `已改成${memoryResidentLabel(true)}：新开的助手会话会读到它，后台整理不会再改这一项。`
      : `已改成${memoryResidentLabel(false)}：新开的助手会话不再带上它，后台整理不会再改这一项。`
    if (kind === 'retired') return '已作废：她不再用这条，记录还留着，可以恢复。'
    // What deleting does is said once, under the buttons.
    if (kind === 'forgotten') return '已删除。可以在这里或「已删除」里恢复。'
    return before.state === 'forgotten' ? '已恢复：她又会用这条了，说出它的原话和一起收起的时间线行也都回来了。' : '已恢复：她又会用这条了。'
  }

  /** Changes the open memory from the version shown; one changed meanwhile is refused and read again. */
  async function changeMemory(kind: MemoryChangeKind, edit: AssistantMemoryEdit) {
    const memory = detail.memory
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!memory || !context || detail.change?.state === 'pending' || (edit.text !== undefined && tooLong(edit.text))) return
    const here = () => context.connectionId === app.activeConnectionId && detail.id === memory.id
    detail.change = { kind, state: 'pending', message: '正在保存…' }
    try {
      const changed = await once([context.connectionId, 'memory', memory.id], [memory.revision, edit],
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
      // Main's own words for a merged memory speak of forgetting; the page calls it deleting.
      const message = code === 'invalid_request' ? NOT_TAKEN
        : code === 'assistant_memory_merged' ? `这条记忆已经合并进${memory.supersededBy ? ` #${memory.supersededBy}` : '另一条在用的记忆'}，只删除它，同样的事还留在那一条里，所以这次没有删除。要删掉这件事，请到合并后的那一条去删除或改写。`
          : userErrorMessage(cause, '没有改成。请稍后重试。')
      if (!here()) {
        // Its page was left meanwhile; the list says it once.
        list.failure = `「${excerpt(memory.text)}」的${CHANGE_NAMES[kind]}没有完成：${message}`
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
      const added = await once([context.connectionId, 'new memory'], memory, (operationId) => addAssistantMemory(memory, operationId, context))
      Object.assign(entry, blankDraft())
      if (context.connectionId !== app.activeConnectionId) return
      const shown = list.shown
      // It is the newest memory, so it heads a list it belongs to.
      const fits = !!shown && !shown.filter.query && !shown.filter.state && (shown.view === 'recent' || shown.filter.topic === added.topic)
      if (fits && !list.memories.some((item) => item.id === added.id)) list.memories.unshift(added)
      list.notice = fits ? '已记下。' : `已记下，在「最近记住的」和「${memoryTopicLabel(added.topic)}」里能看到。`
    } catch (cause) {
      const message = errorCode(cause) === 'invalid_request' ? NOT_TAKEN : userErrorMessage(cause, '没有保存成功。请稍后重试。')
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
  /**
   * Every request about the settings — a read, a choice, a start-over — takes the next number.
   * What an answer says the settings are is taken only from the latest request sent: an earlier
   * one answered late does not put back what a later one has settled.
   */
  let settingsAsked = 0
  /**
   * The choice and the start-over whose progress the page shows, by their numbers. An answer
   * tells its outcome there unless a later one has taken its place: "being saved" and "starting
   * over" are ended only by the request they stand for.
   */
  let choiceShown = 0
  let startOverShown = 0
  /**
   * Choices and start-overs on their way, per connection. Both set the model: two at once leave
   * it unknown which Main did last, whatever order their answers come in. So does an answer
   * that came after something later was asked. Once all are answered, the settings are read again.
   */
  const settingModel = new Map<string, { onTheirWay: number; unsure: boolean }>()
  function settingBegins(connectionId: string) {
    const entry = settingModel.get(connectionId) ?? { onTheirWay: 0, unsure: false }
    settingModel.set(connectionId, entry)
    entry.unsure ||= entry.onTheirWay > 0
    entry.onTheirWay++
  }
  function settingEnds(connectionId: string, answeredLate: boolean) {
    const entry = settingModel.get(connectionId)
    if (!entry) return
    entry.unsure ||= answeredLate
    if (--entry.onTheirWay) return
    settingModel.delete(connectionId)
    if (entry.unsure && connectionId === app.activeConnectionId) void loadSettings(true)
  }
  const sameModel = (one: ModelRef | null | undefined, other: ModelRef | null | undefined) => (one ? modelKey(one) : '') === (other ? modelKey(other) : '')

  /** The model that makes memories and starting over with it are one subject: starting over sets the model too. */
  const makingMemories = (connectionId: string) => [connectionId, 'making memories']

  /**
   * Reads what Main has. `check` is the read after requests that set the model crossed: the
   * outcome shown stays, unless Main turns out to hold another model than the one reported saved.
   */
  async function loadSettings(check = false) {
    const connectionId = app.connectionContext?.connectionId
    // A choice or a start-over on its way settles the settings itself; a read sent now could be answered from before it.
    if (!connectionId || settings.save?.state === 'pending' || restart.state === 'pending') return
    const asked = ++settingsAsked
    settings.loading = true
    settings.error = ''
    try {
      const read = await currentConnectionCall(app, getAssistantSettings)
      if (asked !== settingsAsked) return
      // A choice or a start-over whose reply was lost is no longer waiting to be asked again.
      once.known(makingMemories(connectionId))
      settings.current = read
      // What Main has now replaces the outcome of an earlier save.
      if (!check) settings.save = null
      else if (settings.save?.state === 'saved' && !sameModel(settings.save.model, read.extractionModel)) {
        settings.save = { state: 'failed', model: read.extractionModel ?? null, message: 'Main 上现在的模型和刚才保存的不一样（同时还有别的改动，比如从头整理）。现在显示的是 Main 上的设置，要换可以再选一次。' }
      }
    } catch (cause) {
      if (asked === settingsAsked) settings.error = userErrorMessage(cause, '暂时读不到助手设置。请稍后重试。')
    } finally {
      if (asked === settingsAsked) settings.loading = false
    }
  }

  /** Saves the choice at once; `null` stops making memories. How it then stands is read again. */
  async function chooseModel(model: ModelRef | null) {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context || settings.save?.state === 'pending') return
    // A read still on its way is older than this choice.
    const asked = choiceShown = ++settingsAsked
    settings.loading = false
    settings.save = { state: 'pending', model, message: '正在保存…' }
    if (restart.state !== 'pending') Object.assign(restart, { state: 'idle', message: '' })
    settingBegins(context.connectionId)
    try {
      const saved = await once(makingMemories(context.connectionId), ['model', model], (operationId) => setAssistantSettings(model, operationId, context))
      // The settings shown went with the connection they were read from.
      if (context.connectionId !== app.activeConnectionId) return
      if (asked === settingsAsked) settings.current = saved
      if (asked === choiceShown) settings.save = { state: 'saved', model, message: saved.extractionModel
        ? '已保存。她会用这个模型从对话里记下值得记住的事。'
        : '已停止整理。她不会再从对话里自动记东西，已经记下的都还在。' }
    } catch (cause) {
      if (context.connectionId !== app.activeConnectionId) return
      if (asked === choiceShown) settings.save = { state: 'failed', model, message: userErrorMessage(cause, '没有保存成功，设置没有变。请稍后重试。') }
    } finally {
      settingEnds(context.connectionId, asked !== settingsAsked)
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
    // A read of the settings still on its way is older than this start-over, as for a choice.
    const asked = startOverShown = ++settingsAsked
    settings.loading = false
    Object.assign(restart, { state: 'pending', message: '正在开始从头整理…' })
    settingBegins(context.connectionId)
    try {
      const result = await once(makingMemories(context.connectionId), ['start over', model], (operationId) => reorganizeAssistant(model, operationId, context))
      if (context.connectionId !== app.activeConnectionId) return
      // Starting over sets the model too; answered after a later choice, it is told but does not put its model back.
      if (asked === settingsAsked) settings.current = { extractionModel: result.extractionModel }
      if (asked === startOverShown) Object.assign(restart, {
        state: 'done',
        message: `已开始从头整理：后台整理出的 ${result.retiredMemories} 条记忆挪进了「已作废」，它写的 ${result.removedLines} 行时间线清掉了。她正在把所有对话从头读一遍，读完之前，新开的会话里记忆不全。`,
      })
      if (list.shown) void loadMemories()
    } catch (cause) {
      if (context.connectionId !== app.activeConnectionId) return
      if (asked === startOverShown) Object.assign(restart, { state: 'failed', message: userErrorMessage(cause, '没能开始从头整理，记忆和时间线都没有动。请稍后重试。') })
    } finally {
      settingEnds(context.connectionId, asked !== settingsAsked)
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
    settingsAsked++
    more.startOver()
    Object.assign(list, { shown: null, memories: [], nextCursor: undefined, loading: false, error: '', notice: '', failure: '' })
    closeMemory()
    Object.assign(settings, { current: null, loading: false, error: '', save: null })
    Object.assign(restart, { state: 'idle', message: '' })
  })

  return {
    extraction, memoryLimit,
    list, more: more.state, loadMemories, moreMemories, showView, showTopic,
    detail, rewrite, hasRewrite, openMemory, closeMemory, readMemory, startRewrite, editRewrite, cancelRewrite, changeMemory,
    source: sourceReading.state, openSource, readSourceMore: sourceReading.readMore, closeSource: sourceReading.close,
    draft, hasDrafts, startWriting, editDraft, dropDraft, writeMemory,
    settings, loadSettings, chooseModel, models, loadModels,
    restart, askRestart, cancelRestart, startOver,
  }
})
