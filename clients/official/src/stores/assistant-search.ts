import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { excerpt } from '../lib/assistant'
import { useConversationReading } from '../lib/assistantReading'
import { getAssistantEpisode, listAssistantTimeline, searchAssistant, updateAssistantEpisode } from '../lib/bridge'
import { currentConnectionCall } from '../lib/hostResult'
import { useNextPage } from '../lib/nextPage'
import { onceAfterLostReply } from '../lib/operationBinding'
import type { AssistantEpisode, AssistantEpisodeEdit, AssistantSearchHit, AssistantTimelineFilter } from '../lib/types'
import { errorCode, userErrorMessage } from '../lib/userError'
import { useAppStore } from './app'

const SEARCH_PAGE = 20
const TIMELINE_PAGE = 20

/** What one search asks for: words, a time range, or both. */
interface SearchShown { connectionId: string; query?: string; from?: string; to?: string }
/** The timeline lines listed: those in use, or those forgotten. */
type LineView = 'active' | 'forgotten'
/** One change asked of a timeline line. */
type LineChange = 'text' | 'forgotten' | 'active'
interface LineOutcome { state: 'done' | 'failed'; message: string }

const LINE_CHANGE_NAMES: Record<LineChange, string> = { text: '改写', forgotten: '忘掉', active: '恢复' }
const LINE_CHANGED: Record<LineChange, string> = {
  text: '已改写。新开的助手会话按改后的读。',
  forgotten: '已忘掉：不再列出、不再载入，它覆盖的原话还在。可以在「已忘掉的」里恢复。',
  active: '已恢复。',
}

/**
 * Searching the conversations the assistant took part in (card #295): what was said, the
 * timeline lines of the same words and time, changing a line, and one conversation read around
 * a hit or a line. The results belong to the connection they were read from; a rewrite being
 * typed is kept per connection and line, so searching again or closing the page keeps it.
 */
export const useAssistantSearchStore = defineStore('assistant-search', () => {
  const app = useAppStore()

  // ── Searching her conversations and her timeline ──
  const search = reactive({
    query: '', from: '', to: '',
    /** The search the results show; reading more continues it, not the fields being edited. */
    shown: null as null | SearchShown,
    hits: [] as AssistantSearchHit[],
    nextCursor: undefined as string | undefined,
    loading: false,
    error: '',
  })
  /** The timeline lines of the same words and time, newest first, above what was said. */
  const timeline = reactive({
    view: 'active' as LineView,
    episodes: [] as AssistantEpisode[],
    nextCursor: undefined as string | undefined,
    /** Read on their own: other lines were asked for, or those read with a search were no longer the latest. */
    loading: false,
    error: '',
  })
  const moreHits = useNextPage('没有读到更多结果。请重试。')
  const moreLines = useNextPage('没有读到更多时间线。请重试。')
  let searchRound = 0
  /**
   * The lines have turns of their own, apart from the searches': one begins when other lines
   * are asked for, when a first page is taken, when a line is changed here or read on its own,
   * and when the connection is left. Lines read in an earlier turn are not taken: they may be
   * older than what is listed.
   */
  let linesTurn = 0

  /** Local calendar days, from the start of `from` through the end of `to`. */
  function range(from: string, to: string) {
    const day = (value: string, next: boolean) => {
      const [year, month, date] = value.split('-').map(Number)
      return new Date(year!, month! - 1, date! + (next ? 1 : 0)).toISOString()
    }
    return { ...(from ? { from: day(from, false) } : {}), ...(to ? { to: day(to, true) } : {}) }
  }

  function lineFilter(shown: SearchShown, view: LineView): AssistantTimelineFilter {
    return {
      ...(shown.query ? { query: shown.query } : {}), ...(shown.from ? { from: shown.from } : {}), ...(shown.to ? { to: shown.to } : {}),
      ...(view === 'forgotten' ? { state: view } : {}),
    }
  }
  /** The first lines of a search. A failure is an answer too: the search stands without them. */
  function firstLines(shown: SearchShown, view: LineView) {
    return currentConnectionCall(app, (ctx) => listAssistantTimeline(lineFilter(shown, view), undefined, TIMELINE_PAGE, ctx)).then(
      (list) => ({ ...list, error: '' }),
      (cause: unknown) => ({ episodes: [] as AssistantEpisode[], nextCursor: undefined, error: userErrorMessage(cause, '暂时读不到这段时间的时间线。请稍后重试。') }),
    )
  }
  /**
   * Replaces the lines listed. An editor left open on a line that goes, with nothing typed and
   * no save on its way, goes with it.
   */
  function listLines(connectionId: string, lines: AssistantEpisode[] = [], nextCursor?: string) {
    for (const line of timeline.episodes) {
      const key = lineKey(connectionId, line.id)
      if (!lines.some((item) => item.id === line.id) && !pending.has(key) && rewrites.get(key)?.trim() === line.text) rewrites.delete(key)
    }
    outcomes.clear()
    moreLines.startOver()
    Object.assign(timeline, { episodes: lines, nextCursor })
  }
  /** A line just read: a change to it whose reply was lost is no longer waiting to be asked again. */
  function linesRead(connectionId: string, lines: AssistantEpisode[]) {
    for (const line of lines) once.known([connectionId, 'line', line.id])
  }
  /** Takes the first lines read for the search shown. */
  function showLines(shown: SearchShown, read: Awaited<ReturnType<typeof firstLines>>) {
    linesTurn++
    listLines(shown.connectionId, read.episodes, read.nextCursor)
    linesRead(shown.connectionId, read.episodes)
    Object.assign(timeline, { loading: false, error: read.error })
  }

  /** Words, a time range, or both; a range alone lists that time's conversations, newest first. */
  const canSearch = computed(() => !!(search.query.trim() || search.from || search.to))
  async function runSearch() {
    const query = search.query.trim() || undefined
    const context = app.connectionContext
    if (!canSearch.value || !context) return
    const round = ++searchRound
    const turn = linesTurn
    const shown: SearchShown = { connectionId: context.connectionId, ...(query ? { query } : {}), ...range(search.from, search.to) }
    search.loading = true
    search.error = ''
    // A page of hits still on its way belongs to the search being replaced.
    moreHits.startOver()
    dropNotices(context.connectionId)
    closeContext()
    try {
      const [page, lines] = await Promise.all([
        currentConnectionCall(app, (ctx) => searchAssistant(shown.query, shown, undefined, SEARCH_PAGE, ctx)),
        firstLines(shown, timeline.view),
      ])
      if (round !== searchRound) return
      Object.assign(search, { shown, hits: page.hits, nextCursor: page.nextCursor })
      // Its lines were read in an earlier turn (other lines were asked for, or a line was changed, since): they are read again for it.
      if (turn === linesTurn) showLines(shown, lines)
      else void readLines()
    } catch (cause) {
      if (round === searchRound) search.error = userErrorMessage(cause, '这次没有搜成。请稍后重试。')
    } finally {
      if (round === searchRound) search.loading = false
    }
  }

  /** Reads the lines of the search shown on their own: those in use or those forgotten, as the block is set. */
  async function readLines() {
    const turn = ++linesTurn
    const shown = search.shown
    // Before the first results there is nothing to read them for; a search on its way reads them when it is answered.
    if (!shown) return
    listLines(shown.connectionId)
    Object.assign(timeline, { error: '', loading: true })
    const read = await firstLines(shown, timeline.view)
    if (turn === linesTurn) showLines(shown, read)
  }
  /** Forgotten lines are listed for the same words and time, so they can be found and restored. */
  function showLineView(view: LineView) {
    if (view === timeline.view) return
    timeline.view = view
    dropNotices(app.activeConnectionId ?? '')
    void readLines()
  }

  async function timelineMore() {
    const shown = search.shown
    const cursor = timeline.nextCursor
    if (!shown || !cursor || search.loading || timeline.loading || shown.connectionId !== app.activeConnectionId) return
    const filter = lineFilter(shown, timeline.view)
    await moreLines.read(() => currentConnectionCall(app, (ctx) => listAssistantTimeline(filter, cursor, TIMELINE_PAGE, ctx)), (list) => {
      timeline.episodes = [...timeline.episodes, ...list.episodes]
      timeline.nextCursor = list.nextCursor
      linesRead(shown.connectionId, list.episodes)
    })
  }

  async function searchMore() {
    const shown = search.shown
    const cursor = search.nextCursor
    if (!shown || !cursor || search.loading || shown.connectionId !== app.activeConnectionId) return
    await moreHits.read(() => currentConnectionCall(app, (ctx) => searchAssistant(shown.query, shown, cursor, SEARCH_PAGE, ctx)), (page) => {
      search.hits = [...search.hits, ...page.hits]
      search.nextCursor = page.nextCursor
    })
  }

  // ── Changing a timeline line: rewrite, forget, restore ──
  const lineKey = (connectionId: string, id: string) => JSON.stringify([connectionId, id])
  /** Rewrites being typed, per connection and line. They outlive a new search. */
  const rewrites = reactive(new Map<string, string>())
  /** Changes on their way, per connection and line: each line takes one at a time, and it stays with its Host while another is shown. */
  const pending = reactive(new Set<string>())
  /** What became of the last change to each line listed. */
  const outcomes = reactive(new Map<string, LineOutcome>())
  /**
   * Changes answered when their line was not among those listed: newer results had left it out
   * or were on their way, or another Host was shown. Told above the results of their own Host.
   */
  const notices = ref<Array<LineOutcome & { connectionId: string }>>([])
  const once = onceAfterLostReply()

  const rewriteOf = (id: string) => rewrites.get(lineKey(app.activeConnectionId ?? '', id))
  const linePending = (id: string) => pending.has(lineKey(app.activeConnectionId ?? '', id))
  const lineOutcome = (id: string) => outcomes.get(id)
  const lineNotices = computed(() => notices.value.filter((notice) => notice.connectionId === app.activeConnectionId))
  /** A new search, or other lines asked for: what was told above the earlier results has been seen. */
  function dropNotices(connectionId: string) {
    notices.value = notices.value.filter((notice) => notice.connectionId !== connectionId)
  }

  /** This connection's rewrites that would change their line, or whose line is not listed. */
  const drafts = computed(() => {
    const connectionId = app.activeConnectionId ?? ''
    return [...rewrites].flatMap(([key, text]) => {
      const [connection, id] = JSON.parse(key) as [string, string]
      const line = timeline.episodes.find((item) => item.id === id)
      return connection === connectionId && text.trim() !== line?.text ? [{ key, listed: !!line }] : []
    })
  })
  /** A rewrite typed here and not saved: her page and the sidebar say so. */
  const hasDrafts = computed(() => drafts.value.length > 0)
  /** Rewrites whose lines the results no longer list. */
  const unlistedRewrites = computed(() => drafts.value.filter((draft) => !draft.listed).map((draft) => draft.key))
  function dropUnlistedRewrites() {
    for (const key of unlistedRewrites.value) rewrites.delete(key)
  }

  function startLineEdit(line: AssistantEpisode) {
    const key = lineKey(app.activeConnectionId ?? '', line.id)
    if (!rewrites.has(key)) rewrites.set(key, line.text)
    outcomes.delete(line.id)
  }
  function editLine(id: string, text: string) {
    const key = lineKey(app.activeConnectionId ?? '', id)
    if (rewrites.has(key)) rewrites.set(key, text)
  }
  function cancelLineEdit(id: string) {
    const key = lineKey(app.activeConnectionId ?? '', id)
    if (!pending.has(key)) rewrites.delete(key)
  }
  function saveLineEdit(line: AssistantEpisode) {
    const text = rewriteOf(line.id)?.trim()
    // Left as the line reads now, there is nothing to save.
    if (!text || text === line.text) return cancelLineEdit(line.id)
    return changeLine(line, 'text', { text })
  }

  /**
   * A line as a change or a single read just gave it takes the place of the one listed. Lines
   * read before that may still carry the older one, so a new turn begins: reads on their way
   * are not taken, and lines being read on their own are asked for again.
   */
  function lineIsNow(connectionId: string, line: AssistantEpisode) {
    if (connectionId !== app.activeConnectionId) return
    const index = timeline.episodes.findIndex((item) => item.id === line.id)
    if (index >= 0 && line.revision >= timeline.episodes[index]!.revision) timeline.episodes.splice(index, 1, line)
    linesTurn++
    moreLines.startOver()
    if (timeline.loading) void readLines()
  }

  /**
   * Changes a line from the version listed. One changed meanwhile is refused; that line alone is
   * then read again and a rewrite being typed stays. The same change sent again after its reply
   * was lost is made once. What became of it is told on its line if that is listed by then,
   * else above the results of its own Host.
   */
  async function changeLine(line: AssistantEpisode, kind: LineChange, edit: AssistantEpisodeEdit) {
    const context = app.connectionContext ? { ...app.connectionContext } : null
    if (!context) return
    const key = lineKey(context.connectionId, line.id)
    if (pending.has(key)) return
    pending.add(key)
    outcomes.delete(line.id)
    let outcome: LineOutcome
    try {
      const changed = await once([context.connectionId, 'line', line.id], [line.revision, edit],
        (operationId) => updateAssistantEpisode(line.id, line.revision, edit, operationId, context))
      // The text that was sent is saved; what was typed after it was sent is a rewrite of the saved line.
      if (edit.text !== undefined && rewrites.get(key)?.trim() === edit.text) rewrites.delete(key)
      lineIsNow(context.connectionId, changed)
      outcome = { state: 'done', message: LINE_CHANGED[kind] }
    } catch (cause) {
      let message = userErrorMessage(cause, '没有改成。请稍后重试。')
      if (errorCode(cause) === 'assistant_episode_changed') {
        const kept = kind === 'text' ? '你写的还在，' : ''
        try {
          const now = await getAssistantEpisode(line.id, context)
          linesRead(context.connectionId, [now])
          lineIsNow(context.connectionId, now)
          message = `这一行刚被改过（可能是她自己或后台改的），这次没有改动。它现在的内容已经读到，${kept}看过可以再${kind === 'text' ? '保存' : '点一次'}。`
        } catch {
          message = `这一行刚被改过（可能是她自己或后台改的），这次没有改动。${kept}暂时读不到它现在的内容，请稍后再试一次。`
        }
      }
      outcome = { state: 'failed', message }
    }
    pending.delete(key)
    const listed = context.connectionId === app.activeConnectionId && !search.loading && !timeline.loading && timeline.episodes.some((item) => item.id === line.id)
    if (listed) outcomes.set(line.id, outcome)
    else notices.value.push({
      connectionId: context.connectionId, state: outcome.state,
      message: outcome.state === 'done' ? `「${excerpt(line.text)}」${outcome.message}` : `「${excerpt(line.text)}」的${LINE_CHANGE_NAMES[kind]}没有完成：${outcome.message}`,
    })
  }
  const forgetLine = (line: AssistantEpisode) => changeLine(line, 'forgotten', { state: 'forgotten' })
  const restoreLine = (line: AssistantEpisode) => changeLine(line, 'active', { state: 'active' })

  // ── One conversation around a hit ──
  const hitReading = useConversationReading(app, { failure: '暂时读不到这段对话。请重试。' })
  const reading = hitReading.state
  const closeContext = hitReading.close
  const readMore = hitReading.readMore
  function openContext(hit: AssistantSearchHit) {
    return hitReading.open({ sessionId: hit.session.sessionId, entryId: hit.entryId, session: hit.session })
  }
  /** The words a timeline line sums up, from the first it covers. */
  function openLine(line: AssistantEpisode) {
    return hitReading.open({ sessionId: line.session.sessionId, entryId: line.entryId, session: line.session })
  }

  // A search or open conversation belongs to the connection it was read from. What is kept per
  // connection stays with it: rewrites being typed, changes on their way and what is yet to be told of them.
  watch(() => app.activeConnectionId, (_now, before) => {
    searchRound++
    linesTurn++
    moreHits.startOver()
    listLines(before ?? '')
    Object.assign(search, { shown: null, hits: [], nextCursor: undefined, loading: false, error: '' })
    Object.assign(timeline, { loading: false, error: '' })
    closeContext()
  })

  return {
    search, canSearch, runSearch, searchMore, moreHits: moreHits.state,
    timeline, showLineView, timelineMore, moreLines: moreLines.state, openLine,
    linePending, lineOutcome, lineNotices, rewriteOf, hasDrafts, unlistedRewrites, dropUnlistedRewrites, startLineEdit, editLine, cancelLineEdit, saveLineEdit, forgetLine, restoreLine,
    reading, openContext, readMore, closeContext,
  }
})
