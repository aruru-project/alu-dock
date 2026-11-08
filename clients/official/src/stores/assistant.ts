import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { useConversationReading } from '../lib/assistantReading'
import {
  getAssistantDocument, getAssistantInfo, getAssistantPreview, listAssistantTimeline, searchAssistant, setAssistantDocument, updateAssistantEpisode,
} from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { replyLost } from '../lib/operationBinding'
import type {
  AssistantDocument, AssistantDocumentName, AssistantEpisode, AssistantEpisodeEdit, AssistantInfo, AssistantPreview, AssistantSearchHit, ConnectionContext,
} from '../lib/types'
import { userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'

/** One document being edited: the version the editor started from, the user's unsaved text, and its save. */
export interface AssistantDocumentEditor {
  /** The version the draft is edited from; a save names its revision. */
  base: AssistantDocument | null
  /** Unsaved text; null when the editor shows `base` unchanged. */
  draft: string | null
  /** A version saved elsewhere after the draft began, kept until the user chooses between them. */
  latest: AssistantDocument | null
  loading: boolean
  loadError: string
  save: { state: 'pending' | 'saved' | 'changed' | 'failed' | 'unknown'; message: string } | null
}

interface InfoEntry {
  /** `unavailable`: Main has the assistant, but her service is not running right now. */
  state: 'loading' | 'ready' | 'unsupported' | 'unavailable' | 'failed'
  info?: AssistantInfo
  /** Read again while the earlier answer stays shown. */
  refreshing?: boolean
  /** That read failed; `info` is still the earlier answer. */
  refreshError?: string
}

const SEARCH_PAGE = 20
const TIMELINE_PAGE = 20
const LOST = '连接中断，没收到结果。请稍后再试。'

function errorCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code || '') : ''
}

/**
 * The personal assistant on Main (card #295): whether this connection offers her, her persona
 * and notes being edited, what a new session of hers loads, and searching her conversations.
 * Drafts live here, per connection and document, so closing the page or switching sections
 * keeps them; a save also outlives the page.
 */
export const useAssistantStore = defineStore('assistant', () => {
  const app = useAppStore()
  const infos = ref(new Map<string, InfoEntry>())
  const current = computed(() => infos.value.get(app.activeConnectionId ?? ''))
  /** Main offers the assistant: the sidebar entry and the New Work shortcut show. */
  const available = computed(() => current.value?.state === 'ready' || current.value?.state === 'unavailable')
  const info = computed(() => current.value?.info)
  let infoEpoch = 0

  /** Also how her page reads how her memories are being made, which changes as she works. */
  async function loadInfo() {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context) return
    const epoch = ++infoEpoch
    const previous = infos.value.get(context.connectionId)
    const ready = previous?.state === 'ready'
    infos.value.set(context.connectionId, { state: ready ? 'ready' : 'loading', info: previous?.info, refreshing: ready })
    try {
      const answer = await currentConnectionCall(app, getAssistantInfo)
      if (epoch === infoEpoch) infos.value.set(context.connectionId, { state: 'ready', info: answer })
    } catch (cause) {
      if (epoch !== infoEpoch) return
      const code = errorCode(cause)
      // An older Main has no assistant: nothing about her shows. Any other failure is read again later;
      // one after she was found keeps her page and entry, with what was read before.
      const state = code === 'capability_missing' ? 'unsupported' : code === 'assistant_unavailable' ? 'unavailable' : ready ? 'ready' : 'failed'
      infos.value.set(context.connectionId, {
        state, info: state === 'failed' || state === 'ready' ? previous?.info : undefined,
        ...(state === 'ready' ? { refreshError: userErrorMessage(cause, '暂时读不到助手现在的状态。请稍后重试。') } : {}),
      })
    }
  }
  watch(() => [app.connectionContext?.connectionId, app.connectionContext?.selectionGeneration], () => { void loadInfo() }, { immediate: true })
  // Opening the Work list asks again when the last answer was not a clear yes or no.
  watch(() => app.workDrawerOpen, (open) => {
    const state = current.value?.state
    if (open && state !== 'ready' && state !== 'unsupported' && state !== 'loading') void loadInfo()
  })

  // ── Persona and notes ──
  const editors = reactive(new Map<string, AssistantDocumentEditor>())
  const editorKey = (connectionId: string, document: AssistantDocumentName) => JSON.stringify([connectionId, document])
  function editorFor(connectionId: string, document: AssistantDocumentName): AssistantDocumentEditor {
    const key = editorKey(connectionId, document)
    if (!editors.has(key)) editors.set(key, { base: null, draft: null, latest: null, loading: false, loadError: '', save: null })
    return editors.get(key)!
  }
  const untouched: Readonly<AssistantDocumentEditor> = Object.freeze({ base: null, draft: null, latest: null, loading: false, loadError: '', save: null })
  /** The current connection's editor of this document, for display; reading never creates one. */
  function editor(document: AssistantDocumentName): Readonly<AssistantDocumentEditor> {
    return editors.get(editorKey(app.activeConnectionId ?? '', document)) ?? untouched
  }
  /** Unsaved text in either document on this connection; the sidebar says so. */
  const hasDrafts = computed(() => (['persona', 'notes'] as const).some((document) => {
    const entry = editors.get(editorKey(app.activeConnectionId ?? '', document))
    return !!entry && entry.draft !== null
  }))

  /** Reads the Host's version. An unchanged editor shows it; a draft keeps its base and learns of a newer version. */
  async function loadDocument(document: AssistantDocumentName) {
    const context = app.connectionContext
    if (!context) return
    const entry = editorFor(context.connectionId, document)
    if (entry.loading || entry.save?.state === 'pending') return
    entry.loading = true
    entry.loadError = ''
    try {
      accept(entry, await currentConnectionCall(app, (ctx) => getAssistantDocument(document, ctx)))
    } catch (cause) {
      entry.loadError = userErrorMessage(cause, document === 'persona' ? '暂时读不到人设。请稍后重试。' : '暂时读不到手写设定。请稍后重试。')
    } finally {
      entry.loading = false
    }
  }

  function accept(entry: AssistantDocumentEditor, read: AssistantDocument) {
    if (entry.draft === null || !entry.base) {
      entry.base = read
      entry.draft = null
      entry.latest = null
    } else if (read.text === entry.draft) {
      // The draft is already what the Host has (an unconfirmed save did go through, or someone wrote the same).
      entry.base = read
      entry.draft = null
      entry.latest = null
      entry.save = { state: 'saved', message: '现在的内容和你的草稿一样，不用再保存。' }
    } else if (read.revision !== entry.base.revision) {
      entry.latest = read
    } else {
      entry.latest = null
      // Still the version the draft started from: a save whose reply was lost did not go through.
      if (entry.save?.state === 'unknown') entry.save = { state: 'failed', message: '读到的还是原来的版本，上次的保存没有存上。草稿还在，可以再点保存。' }
    }
  }

  function editDocument(document: AssistantDocumentName, text: string) {
    const entry = editorFor(app.activeConnectionId ?? '', document)
    entry.draft = entry.base && text === entry.base.text ? null : text
    if (entry.save?.state === 'saved') entry.save = null
  }

  /** Drops the draft; with a newer version read, the editor shows that one. */
  function discardDocument(document: AssistantDocumentName) {
    const entry = editorFor(app.activeConnectionId ?? '', document)
    if (entry.save?.state === 'pending') return
    if (entry.latest) entry.base = entry.latest
    entry.latest = null
    entry.draft = null
    entry.save = null
  }

  /** The user chose to save the draft over the version saved elsewhere. */
  function keepDraftOverLatest(document: AssistantDocumentName) {
    const entry = editorFor(app.activeConnectionId ?? '', document)
    if (!entry.latest || entry.save?.state === 'pending') return
    entry.base = entry.latest
    entry.latest = null
    entry.save = null
  }

  async function saveDocument(document: AssistantDocumentName) {
    if (!app.connectionContext) return
    const context: ConnectionContext = { ...app.connectionContext }
    const entry = editorFor(context.connectionId, document)
    if (entry.save?.state === 'pending' || !entry.base || entry.draft === null) return
    const text = entry.draft
    const afterLostReply = entry.save?.state === 'unknown'
    entry.save = { state: 'pending', message: '正在保存，关闭这一页不会取消保存。' }
    try {
      // The result belongs to the connection the save went to, even if the page has switched since.
      const saved = await setAssistantDocument(document, text, entry.base.revision, context)
      entry.base = saved
      entry.latest = null
      if (entry.draft === text || entry.draft === saved.text) entry.draft = null
      entry.save = { state: 'saved', message: '已保存。新开的助手会话会读到它。' }
    } catch (cause) {
      const code = errorCode(cause)
      if (code === 'assistant_document_changed') {
        entry.save = { state: 'changed', message: afterLostReply
          ? '内容已经不是你开始改时的版本，可能上次没收到结果的那次保存其实存上了。草稿还在，读取最新内容就能看出来。'
          : '这份内容在别处被改过（比如助手自己改了，或在另一台设备上改了），这次没有保存。你的草稿还在，可以读取最新内容再决定。' }
      } else if (replyLost(cause)) {
        entry.save = { state: 'unknown', message: '连接中断，没收到保存结果。草稿还在：可以读取最新内容看看有没有存上，或者再点保存。' }
      } else {
        const message = userErrorMessage(cause, '没有保存成功。请稍后重试。')
        entry.save = { state: 'failed', message: code === 'assistant_document_too_large' ? message : `${message}草稿还在。` }
      }
    }
  }

  // ── What a new session of hers loads ──
  const previews = ref(new Map<string, { loading: boolean; error: string; result?: AssistantPreview }>())
  const preview = computed(() => previews.value.get(app.activeConnectionId ?? ''))
  async function loadPreview() {
    const context = app.connectionContext
    if (!context) return
    const previous = previews.value.get(context.connectionId)
    if (previous?.loading) return
    previews.value.set(context.connectionId, { loading: true, error: '', result: previous?.result })
    try {
      const result = await currentConnectionCall(app, getAssistantPreview)
      previews.value.set(context.connectionId, { loading: false, error: '', result })
    } catch (cause) {
      previews.value.set(context.connectionId, { loading: false, error: userErrorMessage(cause, '暂时读不到她会读到的内容。请稍后重试。'), result: previous?.result })
    }
  }

  // ── Searching her conversations and her timeline ──
  const search = reactive({
    query: '', from: '', to: '',
    /** The search the list shows; reading more continues it, not the fields being edited. */
    shown: null as null | { connectionId: string; query?: string; from?: string; to?: string },
    hits: [] as AssistantSearchHit[],
    nextCursor: undefined as string | undefined,
    loading: false,
    loadingMore: false,
    error: '',
    moreError: '',
    /** The timeline lines of the same words and time, newest first, above what was said. */
    episodes: [] as AssistantEpisode[],
    episodesCursor: undefined as string | undefined,
    loadingMoreEpisodes: false,
    /** A Main before the timeline has none to show; nothing is said about it. */
    timelineSupported: true,
    timelineError: '',
  })
  let searchEpoch = 0

  /** Local calendar days, from the start of `from` through the end of `to`. */
  function range(from: string, to: string) {
    const day = (value: string, next: boolean) => {
      const [year, month, date] = value.split('-').map(Number)
      return new Date(year!, month! - 1, date! + (next ? 1 : 0)).toISOString()
    }
    return { ...(from ? { from: day(from, false) } : {}), ...(to ? { to: day(to, true) } : {}) }
  }

  /** Words, a time range, or both; a range alone lists that time's conversations, newest first. */
  const canSearch = computed(() => !!(search.query.trim() || search.from || search.to))
  async function runSearch() {
    const query = search.query.trim() || undefined
    const context = app.connectionContext
    if (!canSearch.value || !context) return
    const epoch = ++searchEpoch
    const shown = { connectionId: context.connectionId, ...(query ? { query } : {}), ...range(search.from, search.to) }
    search.loading = true
    search.error = ''
    search.moreError = ''
    closeContext()
    try {
      const [page, timeline] = await Promise.all([
        currentConnectionCall(app, (ctx) => searchAssistant(shown.query, shown, undefined, SEARCH_PAGE, ctx)),
        currentConnectionCall(app, (ctx) => listAssistantTimeline(timelineFilter(shown), undefined, TIMELINE_PAGE, ctx)).then((list) => ({ list }), (cause: unknown) => ({ cause })),
      ])
      if (epoch !== searchEpoch) return
      search.shown = shown
      search.hits = page.hits
      search.nextCursor = page.nextCursor
      lineEdit.id = ''
      if ('list' in timeline) {
        search.timelineSupported = true
        search.timelineError = ''
        search.episodes = timeline.list.episodes
        search.episodesCursor = timeline.list.nextCursor
      } else {
        // An older Main does not know the timeline; the search itself still stands.
        search.timelineSupported = errorCode(timeline.cause) !== 'unknown_request'
        search.timelineError = search.timelineSupported ? userErrorMessage(timeline.cause, '暂时读不到这段时间的时间线。请稍后重试。') : ''
        search.episodes = []
        search.episodesCursor = undefined
      }
    } catch (cause) {
      if (epoch === searchEpoch) search.error = userErrorMessage(cause, '这次没有搜成。请稍后重试。')
    } finally {
      if (epoch === searchEpoch) search.loading = false
    }
  }

  function timelineFilter(shown: NonNullable<typeof search.shown>) {
    return { ...(shown.query ? { query: shown.query } : {}), ...(shown.from ? { from: shown.from } : {}), ...(shown.to ? { to: shown.to } : {}) }
  }

  async function timelineMore() {
    const shown = search.shown
    const cursor = search.episodesCursor
    if (!shown || !cursor || search.loadingMoreEpisodes || search.loading || shown.connectionId !== app.activeConnectionId) return
    const epoch = searchEpoch
    search.loadingMoreEpisodes = true
    search.timelineError = ''
    try {
      const list = await currentConnectionCall(app, (ctx) => listAssistantTimeline(timelineFilter(shown), cursor, TIMELINE_PAGE, ctx))
      if (epoch !== searchEpoch) return
      search.episodes = [...search.episodes, ...list.episodes]
      search.episodesCursor = list.nextCursor
    } catch (cause) {
      if (epoch === searchEpoch) search.timelineError = userErrorMessage(cause, '没有读到更多时间线。请重试。')
    } finally {
      if (epoch === searchEpoch) search.loadingMoreEpisodes = false
    }
  }

  // ── Changing a timeline line: rewrite, forget, restore ──
  /** The line being rewritten in place, and the outcome of the last change to any line. */
  const lineEdit = reactive({
    id: '',
    text: '',
    pending: '' as string,
    outcome: null as null | { id: string; state: 'done' | 'failed'; message: string },
  })
  function startLineEdit(line: AssistantEpisode) {
    if (lineEdit.pending) return
    lineEdit.id = line.id
    lineEdit.text = line.text
    lineEdit.outcome = null
  }
  function cancelLineEdit() {
    if (!lineEdit.pending) lineEdit.id = ''
  }
  function saveLineEdit() {
    const line = search.episodes.find((item) => item.id === lineEdit.id)
    const text = lineEdit.text.trim()
    if (!line || !text || text === line.text) { lineEdit.id = ''; return }
    return changeLine(line, { text })
  }
  /** Changes a line from the version shown; one changed meanwhile is refused, and the search read again shows it. */
  async function changeLine(line: AssistantEpisode, edit: AssistantEpisodeEdit) {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context || lineEdit.pending) return
    const epoch = searchEpoch
    lineEdit.pending = line.id
    lineEdit.outcome = null
    try {
      const changed = await updateAssistantEpisode(line.id, line.revision, edit, crypto.randomUUID(), context)
      if (epoch !== searchEpoch) return
      search.episodes = search.episodes.map((item) => (item.id === changed.id ? changed : item))
      if (lineEdit.id === line.id) lineEdit.id = ''
      lineEdit.outcome = { id: line.id, state: 'done', message: edit.text !== undefined ? '已改写。新开的助手会话按改后的读。' : edit.state === 'forgotten' ? '已忘掉这一行：不再列出、不再载入，它覆盖的原话还在。' : '已恢复这一行。' }
    } catch (cause) {
      if (epoch !== searchEpoch) return
      lineEdit.outcome = { id: line.id, state: 'failed', message: replyLost(cause) ? LOST : userErrorMessage(cause, '没有改成。请稍后重试。') }
    } finally {
      if (epoch === searchEpoch) lineEdit.pending = ''
    }
  }
  const forgetLine = (line: AssistantEpisode) => changeLine(line, { state: 'forgotten' })
  const restoreLine = (line: AssistantEpisode) => changeLine(line, { state: 'active' })

  async function searchMore() {
    const shown = search.shown
    const cursor = search.nextCursor
    if (!shown || !cursor || search.loadingMore || search.loading || shown.connectionId !== app.activeConnectionId) return
    const epoch = searchEpoch
    search.loadingMore = true
    search.moreError = ''
    try {
      const page = await currentConnectionCall(app, (ctx) => searchAssistant(shown.query, shown, cursor, SEARCH_PAGE, ctx))
      if (epoch !== searchEpoch) return
      search.hits = [...search.hits, ...page.hits]
      search.nextCursor = page.nextCursor
    } catch (cause) {
      if (epoch === searchEpoch) search.moreError = userErrorMessage(cause, '没有读到更多结果。请重试。')
    } finally {
      if (epoch === searchEpoch) search.loadingMore = false
    }
  }

  // ── One conversation around a hit ──
  const hitReading = useConversationReading(app, { failure: '暂时读不到这段对话。请重试。' })
  const reading = hitReading.state
  const closeContext = hitReading.close
  const readMore = hitReading.readMore
  function openContext(hit: AssistantSearchHit) {
    return hitReading.open({ sessionId: hit.session.sessionId, entryId: hit.entryId, session: hit.session })
  }

  // A search or open conversation belongs to the connection it was read from.
  watch(() => app.activeConnectionId, () => {
    searchEpoch++
    Object.assign(search, { shown: null, hits: [], nextCursor: undefined, loading: false, loadingMore: false, error: '', moreError: '', episodes: [], episodesCursor: undefined, loadingMoreEpisodes: false, timelineSupported: true, timelineError: '' })
    Object.assign(lineEdit, { id: '', text: '', pending: '', outcome: null })
    closeContext()
  })

  return {
    infos, available, info, current, loadInfo,
    editor, hasDrafts, loadDocument, editDocument, discardDocument, keepDraftOverLatest, saveDocument,
    preview, loadPreview,
    search, canSearch, runSearch, searchMore, timelineMore,
    lineEdit, startLineEdit, cancelLineEdit, saveLineEdit, forgetLine, restoreLine,
    reading, openContext, readMore, closeContext,
  }
})
